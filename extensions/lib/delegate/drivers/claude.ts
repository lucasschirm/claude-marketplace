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
import { makeModeResolver, modeCatalogue, type PermissionDecision, type PermissionOption } from "../permissions.ts";
import type { AgentDriver, Catalogue, DriverCapabilities, DriverHealth, LaunchPlan, Selection, SelectionContext } from "../types.ts";

/** The adapter's own config-option ids (`session-config-ids.d.ts`, `session-model.d.ts`, `acp-agent.d.ts`). */
const CONFIG = { model: "model", effort: "effort" } as const;

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
	return !isRoot || process.env.IS_SANDBOX !== undefined;
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
 * One approval or one rejection, never a durable rule.
 *
 * Claude offers `allow_once`, `allow_always`, `reject_once`, `reject_always`, and the set is built per
 * tool. `allow_always` is a permanent widening, which the delegate policy forbids for every agent, so
 * `allow_session` has nowhere honest to go: it degrades to one approval and the tool says so.
 */
export function pickClaudePermissionOption(options: PermissionOption[], decision: PermissionDecision): string | undefined {
	const byId = (id: string) => options.find((o) => o.optionId === id)?.optionId;
	const byKind = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
	if (decision === "reject") {
		return byId("reject_once") ?? byKind("reject_once");
	}
	return byId("allow_once") ?? byKind("allow_once");
}

export const claudeDriver: AgentDriver = {
	id: "claude",
	title: "Claude",
	source: "built-in",

	capabilities(): DriverCapabilities {
		return {
			thinking: true,
			// The adapter advertises `loadSession: true` plus session fork/resume/list.
			resume: true,
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
		const model = sel.model?.trim();
		if (model) {
			try {
				await ctx.request("session/set_config_option", { sessionId: ctx.sessionId, configId: CONFIG.model, value: model });
			} catch (err: any) {
				warnings.push(`model '${model}' was refused: ${err?.message ?? String(err)}`);
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
		return { default: "default", values: [], onUnknown: "warn" };
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
