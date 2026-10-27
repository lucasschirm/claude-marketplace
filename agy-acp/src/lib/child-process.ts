// The only place in agy-acp that spawns a process. The quality gate (scripts/check-quality.mjs)
// forbids exec/spawn everywhere else, so every child process in the server goes through here with an
// explicit, reviewed set of options:
//
//   - its own process group (POSIX `detached`), so the whole tree - agy plus the tool subprocesses it
//     spawns - can be signalled at once with process.kill(-pid, sig);
//   - an explicit env, never an implicit inherit;
//   - a named timeout, so "how long may this run" is always a decision written down at the call site
//     (0 = no Node-enforced ceiling, which is what a long-lived session child gets: its lifetime is
//     managed by the owner's dispose, not by a wall clock).

import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessGroupSpawnOptions {
	/** argv[0] - the program to run. */
	command: string;
	/** argv[1..n] - its arguments. */
	args?: string[];
	/** Working directory. */
	cwd?: string;
	/** The exact environment the child sees. Always passed explicitly. */
	env?: NodeJS.ProcessEnv;
	/** Max lifetime in milliseconds; 0 (the default) means no Node-level kill - the caller owns it. */
	timeoutMs?: number;
}

/** Spawns `command` in a new process group; the child's pid is the group id. */
export function spawnProcessGroup(options: ProcessGroupSpawnOptions): ChildProcess {
	const child = spawn(options.command, options.args ?? [], {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		// POSIX: the child becomes the leader of its own process group (and session).
		detached: true,
		// Named at the call site per the gate; 0 leaves the lifetime to the owner.
		timeout: options.timeoutMs ?? 0,
	});
	return child;
}
