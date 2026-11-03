// How agy-acp launches an `agy`, and the two things it asks that binary once per process.
//
// This is the launch surface, kept apart from the ACP method dispatch (server.ts): the options a
// session spawns with, the environment underneath them, and the per-process probes whose answer every
// session inherits - `agy --version` (a version agy-acp has never seen may not speak the stream it
// replays) and `agy models` (the list a client picks from, issue #55). Both run once and cache, and a
// failed answer is cached too: neither check may be hammered on every session/new.

import { checkAgyVersion, type AgyVersionStatus } from "./agy-driver.ts";
import { DEFAULT_MODELS_TIMEOUT_MS, makeModelCatalog, type ModelCatalog } from "./agy/models.ts";
import { lifecycleConfigFromEnv } from "./config.ts";

export interface AgyLaunchOptions {
	/** The agy binary (default "agy"). */
	command?: string;
	/** argv prefix in place of the command (tests point this at the fake). */
	argvPrefix?: string[];
	/** The exact environment the child sees (default the server's process.env). */
	env?: NodeJS.ProcessEnv;
	/** The model every session starts on (a client may change it: session/set_config_option). */
	model?: string;
	/** The reasoning effort every session starts on (agy's own level; see agy/models.ts). */
	effort?: string;
	/** `agy --sandbox` for every child: defence in depth under the bridge, never instead of it. */
	sandbox?: boolean;
	/**
	 * Offer the `bypass` mode (AGY_ACP_ALLOW_BYPASS=1). Off by default: bypass lets every tool call
	 * through the bridge, so it is the operator's decision, not a client's.
	 */
	allowBypass?: boolean;
	/** How long `agy models` may take once per process before the list is written off (default 30 s). */
	modelsTimeoutMs?: number;
	/** Kept for API compatibility; the session forces it: the bridge hook is the only gate. */
	skipPermissions?: boolean;
	addDirs?: string[];
	/** The client deadline for session/request_permission (default 10 min; below the hook deadline). */
	clientDeadlineMs?: number;
	/** The hook's own deadline (AGY_ACP_HOOK_DEADLINE_MS); above the client deadline, below the hook timeout. */
	hookDeadlineMs?: number;
	/** The hooks.json timeout (seconds) agy enforces on the hook; above the hook deadline. */
	hookTimeoutSec?: number;
	probeTimeoutMs?: number;
	graceMs?: number;
	termMs?: number;
	/** The SIGINT -> process-group escalation window of session/cancel (default 5 s, env-configurable). */
	cancelEscalateMs?: number;
	/** The heartbeat interval of a running turn (default 15 s, 0 disables; env-configurable). */
	heartbeatMs?: number;
}

/**
 * The launch options with the environment's values underneath them, and nothing else: the server
 * reads its configuration exactly once, so a `process.env` edit made later cannot reach a session
 * through one path and not through another (the version gate and the model list both take the result).
 */
export function withEnvDefaults(overrides?: AgyLaunchOptions): AgyLaunchOptions {
	const env = lifecycleConfigFromEnv();
	const launch = overrides ?? {};
	const out: AgyLaunchOptions = { ...launch };
	out.command = launch.command ?? env.command;
	out.cancelEscalateMs = launch.cancelEscalateMs ?? env.cancelEscalateMs;
	out.heartbeatMs = launch.heartbeatMs ?? env.heartbeatMs;
	// The selection defaults (issue #55): the environment is the server-wide answer, an explicit option
	// is the caller's, and a client can still change either one per session.
	out.model = launch.model ?? env.model;
	out.effort = launch.effort ?? env.effort;
	out.sandbox = launch.sandbox ?? env.sandbox;
	out.allowBypass = launch.allowBypass ?? env.allowBypass;
	out.modelsTimeoutMs = launch.modelsTimeoutMs ?? env.modelsTimeoutMs;
	// `argvPrefix: []` is not "the command, with no prefix": the driver would exec an empty argv, while
	// the two probes below would happily check `$PATH`'s agy and report a version and a model list for a
	// binary no session ever runs. Resolve an empty prefix to "unset" once, here, so the gates and the
	// sessions can only ever point at the same binary.
	if (out.argvPrefix !== undefined && out.argvPrefix.length === 0) out.argvPrefix = undefined;
	return out;
}

/** The argv the sessions will run: the configured prefix, or the command on its own. */
function launchArgv(launch: AgyLaunchOptions): string[] {
	return launch.argvPrefix ?? [launch.command ?? "agy"];
}

/** The version gate: run once before the first session/new, cached (a failed check may retry). */
export function makeVersionGate(launch: AgyLaunchOptions): () => Promise<AgyVersionStatus> {
	let cached: Promise<AgyVersionStatus> | null = null;
	return () => {
		if (!cached) {
			cached = checkAgyVersion([...launchArgv(launch), "--version"], undefined, launch.env ?? process.env).catch((err: Error) => {
				cached = null; // a transient spawn failure is not a verdict about the version
				throw err;
			});
		}
		return cached;
	};
}

/**
 * The `agy models` list, once per process (issue #55). Like the version gate it asks the binary the
 * sessions launch - same argv prefix, same env - and a failure is cached too: a server whose `agy
 * models` needs credentials must not pay for it (or hammer it) on every session/new.
 */
export function makeModelGate(launch: AgyLaunchOptions, log: (line: string) => void): ModelCatalog {
	// A budget of 0 (or less) is not a listing that fails fast, it is a listing that cannot succeed:
	// the watchdog would fire before the command could answer. The default is the floor.
	const timeoutMs = launch.modelsTimeoutMs !== undefined && launch.modelsTimeoutMs > 0 ? launch.modelsTimeoutMs : DEFAULT_MODELS_TIMEOUT_MS;
	return makeModelCatalog(launchArgv(launch), launch.env ?? process.env, timeoutMs, log);
}

/** The flags `main.ts` accepts with a value, and the option each one fills. */
const VALUE_FLAGS: Record<string, "model" | "effort"> = { "--model": "model", "--effort": "effort" };
/** The flags it accepts as bare switches. */
const SWITCH_FLAGS: Record<string, "sandbox" | "allowBypass"> = { "--sandbox": "sandbox", "--allow-bypass": "allowBypass" };

/**
 * The launch options the command line asks for (`--model x`, `--model=x`, `--sandbox`), or undefined
 * when the arguments are not that shape - which the caller answers with its usage text. A switch
 * written as `--sandbox=1` leaves `1` behind as a bare token, and that is refused: the operator meant
 * something, and silently ignoring it is worse than saying no.
 */
export function parseLaunchArgs(args: string[]): AgyLaunchOptions | undefined {
	// `--model=x` and `--model x` are the same shape from here on, so the loop only walks tokens.
	const tokens = args.flatMap((a) =>
		a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a],
	);
	const out: AgyLaunchOptions = {};
	for (let i = 0; i < tokens.length; i++) {
		const name = tokens[i];
		if (name === "--help" || name === "-h" || name === "--version" || name === "-v") continue;
		const valued = VALUE_FLAGS[name];
		if (valued !== undefined) {
			const value = tokens[++i];
			if (typeof value !== "string" || value === "" || value.startsWith("-")) return undefined;
			out[valued] = value;
		} else if (SWITCH_FLAGS[name] !== undefined) {
			out[SWITCH_FLAGS[name]] = true;
		} else {
			return undefined; // a token that is not a flag we know, or the leftover of a bare switch
		}
	}
	return out;
}
