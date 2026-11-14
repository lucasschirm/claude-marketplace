// The Claude driver: `@agentclientprotocol/claude-agent-acp`, the adapter that drives Claude Code
// through the Claude Agent SDK over stdio.
//
// Installed on this machine at /usr/lib/node_modules/@agentclientprotocol/claude-agent-acp (v0.100.0),
// bin `claude-agent-acp`. Everything asserted below was read from that tree; a claim that was not is
// marked UNVERIFIED in docs/delegate-task-drivers-plan.md §10.
//
// Claude is the reason the driver seam exists rather than a cosmetic layer. Its selection channels are
// the inverse of Devin's:
//
//   | model      | Devin: spawn flag only; set_config_option(model) → -32602 | Claude: NO flag; config option |
//   | thinking   | Devin: inside the model id                                | Claude: `effort` option, per-model |
//   | modes      | `bypass`, `accept-edits` (kebab)                          | `bypassPermissions`, `acceptEdits` (camelCase) |
//
// Order matters here and nowhere else in this directory: `effort` is derived from the model
// (`buildEffortConfigOption(modelInfos, currentModelId, …)`), so setting effort before model sets a
// value the next model change overwrites.

import { commandExists } from "../../nonblocking.ts";
import { runJson } from "../../exec.ts";
import { defaultMapUpdate } from "../events.ts";
import { makeModeResolver, modeCatalogue, permissionOptionId, type PermissionDecision, type PermissionOption } from "../permissions.ts";
import type { AgentDriver, Catalogue, DriverCapabilities, DriverHealth, LaunchPlan, Selection, SelectionContext } from "../types.ts";

/** The adapter's own config-option ids (`session-config-ids.d.ts`, `session-model.d.ts`, `acp-agent.d.ts`). */
const CONFIG = { model: "model", effort: "effort" } as const;

/**
 * The model a Claude delegation uses when the caller did not name one. `default` would be the honest
 * wire value, but it means "whatever this machine's CLI is configured with", which is how a delegated
 * task silently ends up on the operator's most expensive model. `sonnet` is verified present in the
 * advertised vocabulary of the installed adapter; an install that allowlists other models keeps its own
 * configuration rather than hearing a warning on every delegation (see `applySelection`).
 */
export const CLAUDE_MODEL_DEFAULT = "sonnet";

/**
 * The effort values this adapter advertises for the `effort` config option: `default, low, medium, high,
 * xhigh, max`. Verified against the installed adapter's `session/new` answer, because the alternative is
 * guessing which of the tool's seven canonical levels a given vendor happens to accept.
 */
const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** Canonical mode → the mode id Claude's `session/set_mode` parses (`session-mode.js parseMode`). */
const CLAUDE_MODE_ALIASES: Record<string, string> = {
	dangerous: "bypassPermissions",
	smart: "auto",
	auto: "auto",
	"accept-edits": "acceptEdits",
	plan: "plan",
	ask: "default",
	manual: "default",
};

/**
 * `bypassPermissions` is offered only when the adapter would offer it:
 * `ALLOW_BYPASS = !IS_ROOT || !!IS_SANDBOX` (`permissions/modes.js:3`). When it is unavailable the
 * adapter does not reject the request — it **clamps to `default` and logs** — which is precisely the
 * silent-degradation class this repo already fixed once for `auto`. So we refuse it here, naming the
 * reason, instead of reporting a session as bypassing that is asking about every tool.
 */
function bypassAvailable(): boolean {
	const uid =
		(process as { getuid?: () => number; geteuid?: () => number }).geteuid?.() ?? (process as { getuid?: () => number }).getuid?.();
	const isRoot = uid === 0;
	// `!!IS_SANDBOX`, not `!== undefined`: that is the test the adapter makes, and an empty `IS_SANDBOX=""`
	// would otherwise have this driver offer `bypassPermissions` for the adapter to clamp to `default` — the
	// exact silent degradation the check exists to refuse.
	return !isRoot || Boolean(process.env.IS_SANDBOX);
}

/** Cached so a burst of delegations does not spawn a CLI per call. */
const PREFLIGHT_TTL_MS = 60_000;
let healthCache: { at: number; health: DriverHealth } | undefined;

interface CliAuthStatus {
	loggedIn?: boolean;
	authMethod?: string;
	apiProvider?: string;
	subscriptionType?: string;
}

/**
 * `claude auth status --json`.
 *
 * Two traps, both from `dist/auth-status.d.ts`: a logged-out CLI **exits 1 and still prints valid
 * JSON** (so an exit-code-first caller reports "logged out" on every healthy machine), and "cannot
 * determine" is expressed by silence rather than by a payload. Hence `acceptJsonOnFailure` and the
 * explicit `loggedIn === true` test — an absent field is not a refusal.
 */
export async function probeClaudeAuth(now = Date.now()): Promise<DriverHealth> {
	if (healthCache && now - healthCache.at < PREFLIGHT_TTL_MS) {
		return healthCache.health;
	}
	let health: DriverHealth;
	if (!(await commandExists("claude-agent-acp"))) {
		health = {
			ok: false,
			error: "claude-agent-acp is not on PATH",
			hint: "npm install -g @agentclientprotocol/claude-agent-acp",
		};
	} else if (!(await commandExists("claude"))) {
		health = { ok: false, error: "the `claude` CLI is not on PATH; the adapter drives it through the Agent SDK" };
	} else {
		// Only the verdict is cached, never an identity: no email, no token, nothing a details block
		// would persist into the session file.
		const res = await runJson<CliAuthStatus>("claude", ["auth", "status", "--json"], {
			timeoutMs: 15_000,
			acceptJsonOnFailure: true,
		});
		const status = res.ok ? res.data : undefined;
		if (status?.loggedIn === true) {
			health = { ok: true };
		} else if (status) {
			health = { ok: false, error: "claude is not logged in", hint: "run `claude /login`, or set ANTHROPIC_API_KEY" };
		} else {
			// "Cannot determine" is not "logged out": let the run proceed rather than refusing on a
			// probe that answered nothing. The turn will report a real auth failure if there is one.
			health = { ok: true, note: "could not read `claude auth status`; starting the session anyway" };
		}
	}
	healthCache = { at: now, health };
	return health;
}

/** Test seam: the auth cache is module state, and a test must not inherit another test's verdict. */
export function resetClaudeHealthCache(): void {
	healthCache = undefined;
}

/**
 * One approval or one rejection, never a durable rule, and never by `kind`.
 *
 * Claude offers `allow_once`, `allow_always`, `reject_once`, `reject_always`, and the set is built per
 * tool. `allow_always` is a permanent widening (a `Bash(...)` rule written into settings.json), which the
 * delegate policy forbids for every agent, so `allow_session` has nowhere honest to go: it degrades to one
 * approval and the tool says so. The ids here are the only ones matched, for the reason in
 * `pickPermissionOption`: an option's `kind` is a label the adapter chose, and picking by it can land on
 * exactly the option this function exists to refuse.
 */
export function pickClaudePermissionOption(options: PermissionOption[], decision: PermissionDecision): string | undefined {
	if (decision === "reject") {
		return permissionOptionId(options, "reject_once");
	}
	return permissionOptionId(options, "allow_once");
}

export const claudeDriver: AgentDriver = {
	id: "claude",
	title: "Claude",
	source: "built-in",

	capabilities(): DriverCapabilities {
		return {
			thinking: true,
			// The adapter advertises `loadSession` (and fork/resume/list), and the engine now has a loader —
			// `resumeHandshake` — but nothing has run it against *this* agent. Declaring `true` on the strength
			// of an advertisement is how `delegate_message` comes to promise the continuation of a conversation
			// nothing brings back; the claim to earn is a `session/resume` that answers.
			resume: false,
			// The effort vocabulary this install advertises, minus `default` (which means "whatever the model
			// picks" — what omitting `thinking` already does). No Claude model here offers `off` or `minimal`, so
			// asking for one is refused at admission instead of costing a spawned session and a warning buried in
			// a tool result.
			thinkingLevels: () => CLAUDE_EFFORT_LEVELS,
			cancel: true,
			permissions: true,
			plans: true,
			worktree: "host",
			// The binary this agent's process *is*, which the pid-reuse guard reads before killing
			// anything. Named here even though `blocksOwnCli` is false: the two are unrelated — see the
			// note in devin.ts about blocking the operator's own CLI in bash.
			cli: "claude",
			blocksOwnCli: false,
		};
	},

	preflight: () => probeClaudeAuth(),

	launchPlan(_sel: Selection, _cwd: string): LaunchPlan {
		return {
			command: "claude-agent-acp",
			// No model, effort or permission flags exist on this binary (`--cli`, `--settings`,
			// `--claudeai`, `--console`, `--hide-claude-auth`, `--version` are the whole surface).
			args: [],
			// v1 is what the transport speaks; `auto` would let a draft v2 negotiate over our head.
			env: { CLAUDE_AGENT_ACP_PROTOCOL: "v1" },
			label: "claude-agent-acp",
			clientInfo: { name: "pi-delegate-task", version: "1.0" },
			// Deliberately minimal. Declaring `subagents` would turn every Agent/Task call into its own
			// child session — unbounded fan-out the queue does not count and the dashboard cannot show.
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
		};
	},

	/**
	 * Model first, then effort: the effort option is built from the resolved model, so the reverse
	 * order sets a value the model change immediately overwrites.
	 *
	 * Failures are warnings, not refusals. A model the adapter rejects (denied by managed policy, or
	 * simply unknown) is worth reporting on the tool result while the session still runs on the
	 * adapter's own default — refusing the whole delegation would turn a naming mistake into a lost run.
	 */
	async applySelection(ctx: SelectionContext, sel: Selection): Promise<string[]> {
		const warnings: string[] = [];
		const wanted = sel.model?.trim();
		const model = wanted ?? CLAUDE_MODEL_DEFAULT;
		const offeredModels = ctx.advertisedOptions()[CONFIG.model] ?? [];
		// Our default is applied best-effort: an install whose allowlist omits `sonnet` keeps the model its
		// own CLI configured instead of hearing a warning on every delegation. A model the caller named is
		// always sent, so a refusal is reported about a choice they made, not one we guessed. An install
		// that advertised no model list at all gets the attempt, because there the default is a request and
		// not a contradiction.
		if (wanted || offeredModels.length === 0 || offeredModels.includes(model)) {
			try {
				await ctx.request("session/set_config_option", { sessionId: ctx.sessionId, configId: CONFIG.model, value: model });
			} catch (err: any) {
				if (wanted) warnings.push(`model '${model}' was refused: ${err?.message ?? String(err)}`);
			}
		}
		if (sel.thinking) {
			const offered = ctx.advertisedOptions()[CONFIG.effort] ?? [];
			if (offered.length && !offered.includes(sel.thinking)) {
				warnings.push(
					`this model offers no '${sel.thinking}' effort (${offered.join(", ")}); the session runs with the effort Claude picks for the model`,
				);
			} else {
				try {
					await ctx.request("session/set_config_option", { sessionId: ctx.sessionId, configId: CONFIG.effort, value: sel.thinking });
				} catch (err: any) {
					warnings.push(`effort '${sel.thinking}' was refused: ${err?.message ?? String(err)}`);
				}
			}
		}
		return warnings;
	},

	resolveMode(mode: string) {
		const res = makeModeResolver(CLAUDE_MODE_ALIASES)(mode);
		if (res.ok && res.modeId === "bypassPermissions" && !bypassAvailable()) {
			return {
				ok: false,
				error:
					"mode 'dangerous' maps to bypassPermissions, which Claude does not offer when running as root without IS_SANDBOX; it would silently fall back to 'default'. Use 'smart' or run outside root.",
			};
		}
		return res;
	},

	models(): Catalogue {
		// `values` is empty on purpose: the adapter lists models per session from the CLI's settings,
		// including whatever allowlist or gateway the operator configured. Anything hardcoded here
		// would be a lie about someone else's install, so validation defers to the wire.
		// The default is not a guess but the tool's own choice: `sonnet` is what a delegation costs by
		// default, and a session that wanted more asks for it.
		return { default: CLAUDE_MODEL_DEFAULT, values: [], onUnknown: "warn" };
	},

	modes(): Catalogue {
		return modeCatalogue("dangerous");
	},

	defaultMode(): string {
		return "dangerous";
	},

	// The adapter is spec-conformant on the update vocabulary: `agent_message_chunk`,
	// `agent_thought_chunk`, `tool_call(_update)`, `plan`, `config_option_update`,
	// `current_mode_update` are all standard, so the default mapping covers it.
	mapUpdate: defaultMapUpdate,

	permission() {
		return {
			pickOption: pickClaudePermissionOption,
			// No session-scoped tier: `allow_always` is durable, so it is not offered as a substitute.
			degradesAllowSession: true,
		};
	},
};
