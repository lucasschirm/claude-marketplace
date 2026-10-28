// Environment-derived configuration. Every knob has a documented default, so the server runs
// with no configuration at all; the values exist because a long unattended delegate run needs
// the timings to be a decision the operator can change without a code change.
//
//	AGY_ACP_COMMAND              the agy binary to launch (default "agy"); a wrapper script works
//	AGY_ACP_CANCEL_ESCALATE_MS   SIGINT -> process-group SIGTERM window (default 5000; 0 escalates at once)
//	AGY_ACP_HEARTBEAT_MS         heartbeat interval while a turn runs (default 15000; 0 disables)
//	AGY_ACP_SHUTDOWN_TIMEOUT_MS  hard deadline for the exit path (default 10000)
//
// `AGY_ACP_CANCEL_ESCALATE_MS` and `AGY_ACP_HEARTBEAT_MS` are per-session timings, so a client
// can also set them in the launch options; the environment is the server-wide default.

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

export interface LifecycleConfig {
	/** The agy binary the sessions launch (undefined = "agy", or the launch option's own value). */
	command?: string;
	cancelEscalateMs: number;
	heartbeatMs: number;
	shutdownTimeoutMs: number;
}

/** The lifecycle knobs as this process's environment sets them. */
export function lifecycleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LifecycleConfig {
	const command = env.AGY_ACP_COMMAND?.trim();
	return {
		command: command === undefined || command === "" ? undefined : command,
		cancelEscalateMs: envInt(env, "AGY_ACP_CANCEL_ESCALATE_MS", DEFAULT_CANCEL_ESCALATE_MS),
		heartbeatMs: envInt(env, "AGY_ACP_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS),
		shutdownTimeoutMs: envInt(env, "AGY_ACP_SHUTDOWN_TIMEOUT_MS", DEFAULT_SHUTDOWN_TIMEOUT_MS),
	};
}
