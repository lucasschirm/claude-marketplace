// extensions/lib/delegate/process.ts
//
// Killing something we recorded a while ago is a different problem from killing something we are
// holding. `transport.ts` owns the child it spawned; this file is for the pids that outlived their
// transport — a pi restart, a recovery sweep, a cancel of a session whose process we never had —
// where the pid is a *claim* about the world, and the world may have reused it.

import fs from "node:fs";
import { findAgent } from "./registry.ts";

/** The CLI a driver wraps, for the pid-recycle guard on a kill. */
export function driverCli(agentId: string): string | undefined {
	const found = findAgent(agentId);
	return found.ok ? found.driver.capabilities().cli : undefined;
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Kill a detached process group directly (used when no live transport exists — e.g. a pi restart left
 * an orphaned server behind).
 *
 * PID-recycle guard: before killing a *recorded* (possibly long-dead) pid, verify on Linux that it is
 * still the agent's process. Returns null when unverifiable (non-Linux, unreadable cmdline), in which
 * case the kill proceeds as it always did. `cli` comes from the driver, so the guard does not assume
 * every agent is called `devin` — which matters most for the agent whose CLI is also the operator's.
 */
export function killProcessGroup(pid: number, cli?: string, warn?: (message: string) => void): void {
	if (cli && looksLikeOtherProcess(pid, cli)) {
		warn?.(`refusing to kill pid ${pid}: not a ${cli} process (possible pid reuse)`);
		return;
	}
	try {
		if (process.platform !== "win32") {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {
				try {
					process.kill(pid, "SIGTERM");
				} catch {}
			}
		} else {
			try {
				process.kill(pid, "SIGTERM");
			} catch {}
		}
		setTimeout(() => {
			try {
				if (process.platform !== "win32") {
					process.kill(-pid, "SIGKILL");
				}
			} catch {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}, 1500).unref();
	} catch {}
}

/** True only when we can read the cmdline and it does NOT mention `cli`. */
function looksLikeOtherProcess(pid: number, cli: string): boolean {
	if (process.platform !== "linux") {
		return false;
	}
	try {
		return !fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").includes(cli);
	} catch {
		return false;
	}
}
