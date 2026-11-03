// Environment-derived configuration. Every knob has a documented default, so the server runs
// with no configuration at all; the values exist because a long unattended delegate run needs
// the timings to be a decision the operator can change without a code change.
//
//	AGY_ACP_COMMAND              the agy binary to launch (default "agy"); a wrapper script works
//	AGY_ACP_CANCEL_ESCALATE_MS   SIGINT -> process-group SIGTERM window (default 5000; 0 escalates at once)
//	AGY_ACP_HEARTBEAT_MS         heartbeat interval while a turn runs (default 15000; 0 disables)
//	AGY_ACP_SHUTDOWN_TIMEOUT_MS  hard deadline for the exit path (default 10000)
//	AGY_ACP_MODEL                the model each session starts on (a client may change it per session)
//	AGY_ACP_EFFORT               the --effort level each session starts on (low|medium|high|xhigh|max)
//	AGY_ACP_SANDBOX              1 = launch every agy with --sandbox (agy's own terminal restrictions)
//	AGY_ACP_ALLOW_BYPASS         1 = offer the `bypass` mode (it allows every tool call the bridge sees)
//	AGY_ACP_MODELS_TIMEOUT_MS    how long `agy models` may take once per process (default 30000)
//
// The timings and the selection are per-session values, so a client can also set them in the launch
// options; the environment is the server-wide default, an explicit option wins.
//
// `AGY_ACP_SANDBOX` and `AGY_ACP_ALLOW_BYPASS` are operator-only on purpose: one restricts what a
// command may do, the other stops the bridge asking at all. Neither is something a connected client
// should be able to decide for a machine it does not own.

import { DEFAULT_MODELS_TIMEOUT_MS } from "./agy/models.ts";

/** The window between SIGINT and the process-group escalation. */
export const DEFAULT_CANCEL_ESCALATE_MS = 5_000;
/** How often a running turn says "still here". */
export const DEFAULT_HEARTBEAT_MS = 15_000;
/** The most the exit path may take before the process exits anyway. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * A non-negative integer from the environment. `0` is a value, not a typo: it is how the heartbeat and
 * the escalate window are documented to switch themselves off. Anything else - unset, blank, `0x5`,
 * `-3`, `NaN`, or a number too large to count milliseconds - is the fallback.
 */
export function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	// Only a decimal literal counts: Number("0x10") and Number("1e3") would silently widen a window.
	if (!/^\d+$/.test(raw.trim())) return fallback;
	const value = Number(raw.trim());
	return Number.isSafeInteger(value) ? value : fallback;
}

/** Is a `1`-means-on switch set? Anything else (unset, `0`, `yes`) is off: silence is the default. */
export function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
	return env[name]?.trim() === "1";
}

/**
 * A duration with no off state: unset, nonsense and a value no command could satisfy in time all mean
 * the default. `envInt` is wrong for these - it gives 0 meaning where 0 disables a timer (the heartbeat),
 * but a 0 ms budget for `agy models` would declare it timed out before anything could answer.
 */
export function envPositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const value = envInt(env, name, fallback);
	return value > 0 ? value : fallback;
}

export interface LifecycleConfig {
	/** The agy binary the sessions launch (undefined = "agy", or the launch option's own value). */
	command?: string;
	cancelEscalateMs: number;
	heartbeatMs: number;
	shutdownTimeoutMs: number;
	/** The model each session starts on (undefined = agy's own default). */
	model?: string;
	/** The effort each session starts on (undefined = the model's own default). */
	effort?: string;
	/** `AGY_ACP_SANDBOX`: launch every child with `--sandbox`. */
	sandbox: boolean;
	/** `AGY_ACP_ALLOW_BYPASS`: offer the `bypass` mode. */
	allowBypass: boolean;
	/** How long `agy models` may take, once per process. */
	modelsTimeoutMs: number;
}

/** A string knob: unset, blank and whitespace all mean "not set", so `AGY_ACP_MODEL=" "` is off. */
function trimmed(value: string | undefined): string | undefined {
	const out = value?.trim();
	return out === undefined || out === "" ? undefined : out;
}

/** The lifecycle knobs as this process's environment sets them. */
export function lifecycleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LifecycleConfig {
	return {
		command: trimmed(env.AGY_ACP_COMMAND),
		cancelEscalateMs: envInt(env, "AGY_ACP_CANCEL_ESCALATE_MS", DEFAULT_CANCEL_ESCALATE_MS),
		heartbeatMs: envInt(env, "AGY_ACP_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
		shutdownTimeoutMs: envInt(env, "AGY_ACP_SHUTDOWN_TIMEOUT_MS", DEFAULT_SHUTDOWN_TIMEOUT_MS),
		// The selection knobs (issue #55). The models timeout's default lives with the command that
		// pays it (agy/models.ts), not here.
		modelsTimeoutMs: envPositiveInt(env, "AGY_ACP_MODELS_TIMEOUT_MS", DEFAULT_MODELS_TIMEOUT_MS),
		model: trimmed(env.AGY_ACP_MODEL),
		effort: trimmed(env.AGY_ACP_EFFORT),
		sandbox: envFlag(env, "AGY_ACP_SANDBOX"),
		allowBypass: envFlag(env, "AGY_ACP_ALLOW_BYPASS"),
	};
}
