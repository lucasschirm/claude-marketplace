// The Antigravity driver: `agy-acp`, the ACP server in this repository (`agy-acp/`) that drives
// Google's `agy` CLI through its headless `--input-format stream-json` mode and its `PreToolUse` hook.
//
// Everything asserted here was read from that package (its `main.ts` usage text, `launch.ts`,
// `selection-methods.ts`, `permission.ts`, `config-options.ts`, `agy/version.ts`), not from a vendor
// document. Where the two trees must agree on a number, a test says so (see `AGY_TESTED_VERSION`).
//
// The interesting part is what this driver does *not* share with the other two:
//
//   | selection | Devin: `--model` spawn flag (set_config_option answers -32602) |
//   |           | Claude: config option only, no flag                              |
//   |           | agy: BOTH — and the flag is the one we use                        |
//
// `agy-acp` validates a launch-time selection at `session/new` (`assertStartSelection`) against the
// list `agy models` reported, so a model that does not exist is refused before a turn exists, with the
// ids that do named. The selector route (`session/set_config_option`) refuses the same id *after* the
// session was created and the child was spawned. A refusal that costs nothing is worth more than a
// warning that costs a session, and `LaunchPlan.args` is what a queue entry, `ps`, and a post-mortem
// all show — an env var shows none of that.
//
// The flag also beats an inherited `AGY_ACP_MODEL`: `withEnvDefaults` takes `launch.model ?? env.model`,
// so naming nothing here would let whatever the operator's shell exports decide every delegation — the
// same trap `DEVIN_MODEL` sets, arrived at from the other side.

import { commandExists } from "../../nonblocking.ts";
import { failureText, runText } from "../../exec.ts";
import { defaultMapUpdate } from "../events.ts";
import { makeModeResolver, modeCatalogue, permissionOptionId, type PermissionDecision, type PermissionOption } from "../permissions.ts";
import type { AgentDriver, Catalogue, DriverCapabilities, DriverHealth, LaunchPlan, Selection } from "../types.ts";

/** The adapter binary. It is a package of its own (`agy-acp/package.json`, `bin: agy-acp`). */
const ADAPTER = "agy-acp";

/** agy's own `--effort` levels (`agy-acp/src/agy/models.ts: AGY_EFFORTS`), mirrored because the trees ship
 *  separately — and compared with the adapter's table by `test/test-delegate-agy.ts`, so a level agy gained
 *  is a failing test here rather than a level this driver refuses forever. `off` and `minimal` are not among
 *  them, so asking for one is refused at admission rather than costing a spawn and a warning. */
const AGY_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/**
 * The agy version this driver was written against, mirroring `agy-acp/src/agy/version.ts`.
 *
 * It is duplicated rather than imported because the trees ship separately — `extensions/` is installed
 * into pi without `agy-acp/` beside it — and `test/test-delegate-agy.ts` asserts the two agree, which is
 * what makes the duplication safe: a version gate that drifts silently is a gate that stopped working.
 */
export const AGY_TESTED_VERSION = "1.4.2";

/** Canonical mode → the mode id `agy-acp` advertises (`permission.ts: AGY_ACP_MODE_IDS`, asserted against
 *  every entry here by `test/test-delegate-agy.ts` — a renamed id would fail `session/set_mode`).
 *
 * `agy` has no agent-judged tier, so `smart` maps to `default` — **stricter** than what was asked, which
 * is the only direction a mapping may go. `agy-acp` answers `current_mode_update` with the mode it is
 * really in, so the session record never claims a mode the bridge is not enforcing. */
const AGY_MODE_ALIASES: Record<string, string> = {
	dangerous: "bypass",
	// `auto` is the alias the other two drivers accept for their agent-judged tier, and agy has no such
	// tier — so it lands on `default`, the same **stricter** direction as `smart` above. Refusing it would
	// make one agent reject a mode string the tool advertises and the others honour.
	auto: "default",
	smart: "default",
	"accept-edits": "accept-edits",
	plan: "plan",
	ask: "default",
	manual: "default",
};

/** The mode a session starts in when the caller did not name one: `accept-edits`.
 *
 * Not `dangerous`, the tool's historical default, because `bypass` is the operator's to enable (see
 * `bypassOffered`) and a default that is refused out of the box is not a default. Edits inside the
 * workspace are what a delegated coding task was asked to do, so they proceed; shell commands and
 * anything outside the workspace still ask, which is the half of `dangerous` an unattended run actually
 * needs to skip. A caller who wants prompts for every write asks for `ask`; one who has set the operator
 * knob asks for `dangerous`.
 *
 * The cost of that default, said here rather than found in a profile: `agy-acp` starts every session in
 * `default`, and the mode is part of what makes its child stale (`config-options.ts: relaunchKey`, pinned
 * in `agy-acp/test/test-config.ts` as "a mode needs a new child: the flag cannot come off"), so a
 * delegation that names no mode starts `agy` twice — the eager start, then the respawn that
 * `session/set_mode accept-edits` obliges on the first prompt, with the flag this time. Behaviour is right
 * from the first tool call either way, because the bridge enforces the mode and the flag only has to agree.
 * A mode resolving to `default` (`ask`, `auto`, `smart`) pays one start. Nothing cheaper exists from this
 * side: the adapter takes `--model` and `--effort` at launch and no mode, so the mode cannot be passed
 * where it is chosen — closing this costs a flag in `agy-acp`, which is a different sub-issue. */
export const AGY_DEFAULT_MODE = "accept-edits";

/**
 * Whether `bypass` exists on this machine: `AGY_ACP_ALLOW_BYPASS=1` (`agy-acp/src/config.ts`).
 *
 * The driver reads the knob and refuses `dangerous` when it is off, rather than setting it. `agy-acp`
 * withholds the mode and says "start agy-acp with AGY_ACP_ALLOW_BYPASS=1 to offer it" — and an
 * unattended delegate that answered its own refusal by enabling the knob that allows every tool call the
 * bridge sees would be shopping its way out of the gate the bridge exists to hold. The operator decides,
 * in the environment, once.
 */
function bypassOffered(): boolean {
	return process.env.AGY_ACP_ALLOW_BYPASS?.trim() === "1";
}

/** The binary the adapter will launch: its own knob, with the same default it uses (`launch.ts`). */
function agyCommand(): string {
	return process.env.AGY_ACP_COMMAND?.trim() || "agy";
}

/** Cached so a burst of delegations does not spawn a CLI per call (the Claude driver's reason). */
const PREFLIGHT_TTL_MS = 60_000;
let healthCache: { at: number; health: DriverHealth } | undefined;

/** Test seam: the health cache is module state, and a test must not inherit another test's verdict. */
export function resetAgyHealthCache(): void {
	healthCache = undefined;
}

const NOT_BLANK = /\S/;
const WHITESPACE = /\s+/;

/** The first token of the first non-empty line, which is what `agy --version` prints (`agy/version.ts`). */
function firstToken(text: string): string | undefined {
	const line = text.split("\n").find((l) => NOT_BLANK.test(l));
	return line?.trim().split(WHITESPACE)[0];
}

/**
 * Install check: the adapter, then the CLI behind it, then the version the stream contract assumes.
 *
 * Three different messages, because the three failures need three different fixes and the caller cannot
 * tell them apart from the outside — a missing adapter is an install step, a missing `agy` is an install
 * step *behind* an adapter that looks fine, and an untested version is a warning that the adapter itself
 * will also print (and refuse if the operator set `AGY_ACP_STRICT_VERSION=1`).
 *
 * A version we cannot read is not a refusal: this is a probe, and a probe that answers nothing has not
 * established that anything is wrong. `agy-acp` will run the same check when the session starts and
 * report its own verdict there.
 */
export async function probeAgyHealth(now = Date.now()): Promise<DriverHealth> {
	if (healthCache && now - healthCache.at < PREFLIGHT_TTL_MS) {
		return healthCache.health;
	}
	let health: DriverHealth;
	const agy = agyCommand();
	if (!(await commandExists(ADAPTER))) {
		health = {
			ok: false,
			error: `the \`${ADAPTER}\` adapter is not on PATH`,
			hint: "install it from this repository (npm install -g ./agy-acp), or pick another agent",
		};
	} else if (!(await commandExists(agy))) {
		health = {
			ok: false,
			error: `${ADAPTER} drives the \`${agy}\` CLI, which is not on PATH`,
			hint: "install it, or point AGY_ACP_COMMAND at the binary the adapter should run",
		};
	} else {
		const res = await runText(agy, ["--version"], { timeoutMs: 15_000 });
		const version = res.ok ? firstToken(res.data) : undefined;
		if (version === undefined) {
			const why = res.ok ? "printed no version" : failureText(res);
			health = { ok: true, note: `could not read \`${agy} --version\` (${why}); starting the session anyway` };
		} else if (version === AGY_TESTED_VERSION) {
			health = { ok: true };
		} else {
			health = {
				ok: true,
				note: `agy ${version} is untested (agy-acp is tested against ${AGY_TESTED_VERSION}); the stream format it replays may differ`,
			};
		}
	}
	healthCache = { at: now, health };
	return health;
}

/**
 * The option that answers a decision, by exact id only.
 *
 * `agy-acp` offers exactly three (`permission.ts: PERMISSION_OPTION_IDS`) and treats only those ids as
 * answers — anything else, including a cancelled request, is a deny with "Do not retry" attached. Its
 * `allow_always` is the session tier it looks like: a grant held in a `Set` inside the per-session gate,
 * keyed by tool and command, never written to disk, gone when the process is. So unlike Claude there is
 * nothing to degrade, and `allow_session` means what the caller read.
 */
export function pickAgyPermissionOption(options: PermissionOption[], decision: PermissionDecision): string | undefined {
	if (decision === "reject") {
		return permissionOptionId(options, "reject_once");
	}
	// Widening on purpose, and only here, because this option's own scope is this session: a driver is
	// allowed to map one exact id onto another when it can say what the target does.
	if (decision === "allow_session") {
		return permissionOptionId(options, "allow_always") ?? permissionOptionId(options, "allow_once");
	}
	return permissionOptionId(options, "allow_once");
}

/** How one agy session is started: the adapter, with the caller's selection as its launch flags. */
export function agyLaunchPlan(sel: Selection, _cwd: string): LaunchPlan {
	const args: string[] = [];
	// `default` is a value agy-acp understands (its own "agy picks" sentinel), so a caller who types it
	// gets the sentinel rather than a refusal about a model named "default".
	const model = sel.model?.trim();
	if (model) {
		args.push("--model", model);
	}
	if (sel.thinking) {
		args.push("--effort", sel.thinking);
	}
	return {
		command: ADAPTER,
		args,
		// Nothing. Every knob this driver could set in the environment is one the operator owns
		// (`AGY_ACP_MODEL`, `_EFFORT`, `_SANDBOX`, `_ALLOW_BYPASS`, `_LOG`): selection travels as flags,
		// policy as the operator's environment, and the two never meet here.
		env: {},
		label: ADAPTER,
		clientInfo: { name: "pi-delegate-task", version: "1.0" },
		// The adapter reads and writes no file through the client (`bridge-hook.ts` is the gate); the
		// declaration says so rather than leaving it to be discovered. `subagents` is withheld as
		// everywhere: fan-out the queue does not count.
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
	};
}

const agyModeResolver = makeModeResolver(AGY_MODE_ALIASES);

export const agyDriver: AgentDriver = {
	id: "agy",
	title: "Antigravity",
	source: "built-in",

	capabilities(): DriverCapabilities {
		return {
			thinking: true,
			thinkingLevels: () => AGY_EFFORT_LEVELS,
			// `agy-acp` keeps its own session store (#56) and adopts a recorded conversation lazily: no `agy`
			// starts until the next prompt, which pays the resume with `--conversation`. `session/load` would
			// replay the stored transcript into the log `delegate_status` reads, so the handshake below resumes.
			resume: true,
			cancel: true,
			permissions: true,
			// The adapter emits message chunks, tool calls and usage; no `plan` update exists in
			// `update-map.ts`. Promising plans would make the dashboard wait for a list that never arrives.
			plans: false,
			worktree: "host",
			// The CLI an agent would use to do the delegated work from a shell, and the adapter that would
			// run it outside the queue behind a different name. `--help`, `--version` and `models` stay
			// allowed — see bash-guard.ts, and note that `agy` is not the host's own CLI the way `claude` is.
			blocksOwnCli: true,
			// Two guards read this field and want different names. The pid-recycle guard substring-matches
			// `/proc/<pid>/cmdline` before killing a pid recorded a while ago, so `cli` is what the process
			// *is* (`agy-acp`): `agy` is three letters a recycled pid's path can contain — this workspace's
			// own directory does, three times. The bash guard wants every name the work answers to, so the
			// CLI an agent would reach for goes in `extraClis`, and both are blocked.
			cli: ADAPTER,
			extraClis: ["agy"],
		};
	},

	preflight: () => probeAgyHealth(),

	launchPlan: agyLaunchPlan,

	// No `applySelection`, deliberately, and not because there is no in-band channel: `session/set_model`
	// and `session/set_config_option(model|effort)` both exist. The launch flag refuses a bad id earlier
	// and records the choice where a queue entry can show it.

	// The other half of `resume`. A fresh `agy-acp` process knows nothing about the id this engine recorded,
	// and minting a new one would silently drop the context the caller was writing into — so the handshake
	// names the id and the workspace its record holds, which the store refuses to move a conversation from.
	resumeHandshake(sessionId, cwd) {
		return { method: "session/resume", params: { sessionId, cwd } };
	},

	resolveMode(mode) {
		const res = agyModeResolver(mode);
		if (res.ok && res.modeId === "bypass" && !bypassOffered()) {
			return {
				ok: false,
				error:
					"mode 'dangerous' maps to agy's `bypass`, which agy-acp does not offer unless the operator enables it (AGY_ACP_ALLOW_BYPASS=1). " +
					"It would be refused on the wire. 'accept-edits' lets edits proceed and asks about commands; 'plan' asks about everything.",
			};
		}
		return res;
	},

	models(): Catalogue {
		// Unknown, on purpose and unavoidably: the list is `agy models`, which is account- and
		// entitlement-specific (`agy-acp` reports "no model list" plus agy's own reason when it cannot ask).
		// `agy-acp` refuses an id agy does not offer at `session/new` and names the ones it does, so the
		// check happens — against the install, not against a table someone hardcoded.
		return { default: "default", values: [], onUnknown: "warn" };
	},

	modes(): Catalogue {
		return modeCatalogue(AGY_DEFAULT_MODE);
	},

	defaultMode(): string {
		return AGY_DEFAULT_MODE;
	},

	// Spec-conformant on chunks, tool calls, usage and mode, plus one `_meta` update the default table
	// names (`heartbeat`) so a turn that is waiting reads as waiting.
	mapUpdate: defaultMapUpdate,

	permission() {
		return {
			pickOption: pickAgyPermissionOption,
			// `allow_always` is this session's, in memory: the promise is kept, not degraded.
			degradesAllowSession: false,
		};
	},
};
