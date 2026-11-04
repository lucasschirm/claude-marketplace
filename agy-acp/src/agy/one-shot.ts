// One bounded `agy <subcommand>` run - the shape `--version` (the drift gate) and `models` (the
// catalogue) both need, and both carried their own copy of until this file existed. The copies had
// already started to drift in their comments, which is how a copy announces it is about to drift in
// its behaviour.
//
// Every property of those copies is load-bearing and kept here:
//   - spawnProcessGroup with a NAMED timeoutMs: the spawn gate in scripts/check-quality.mjs
//     (execLocation, execTimeout) requires the bound to be visible at the call site;
//   - "close", not "exit": stdout is fully delivered before the terminal state;
//   - one `settled` latch: a spawn error, the watchdog and the close can all arrive;
//   - a watchdog that SIGKILLs the process GROUP (-pid), because the spawn timeout SIGTERMs the
//     child's pid once and a binary that ignores SIGTERM must not hold a session/new hostage.
//
// It resolves with the terminal state instead of rejecting: what counts as a failure is the caller's
// judgement (`models` exiting 0 with no rows is a failure, a non-zero `--version` is too), and both
// callers have error texts of their own that their tests assert on.

import type { AgyArgv } from "./args.ts";
import { spawnProcessGroup } from "../lib/child-process.ts";

export interface OneShotResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	/** True when the watchdog had to kill the group: the caller reports a timeout, not an exit. */
	timedOut: boolean;
	/** The failure to start (ENOENT, EACCES), or null when the child ran at all. */
	spawnError: Error | null;
}

/** Runs `argv` in `env`, bounded by `timeoutMs`, in its own process group. Settles exactly once. */
export function runAgyOneShot(argv: AgyArgv, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<OneShotResult> {
	return new Promise((resolve) => {
		const child = spawnProcessGroup({
			command: argv[0],
			args: argv.slice(1),
			env,
			// Named at the call site per the spawn gate; what the bound is for is the caller's business.
			timeoutMs,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let spawnError: Error | null = null;
		let settled = false;
		const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(watchdog);
			resolve({ code, signal, stdout, stderr, timedOut, spawnError });
		};
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString("utf8");
		});
		const watchdog = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// the group is already gone
				}
			}
		}, timeoutMs);
		watchdog.unref();
		child.on("error", (err: Error) => {
			spawnError = err;
			settle(null, null);
		});
		// "close" (not "exit"): stdout is fully delivered before the terminal state.
		child.on("close", (code, signal) => settle(code, signal));
	});
}
