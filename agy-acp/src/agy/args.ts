// How the driver launches `agy`: the probe event, the launch options, and the flag vector.
//
// The flag vector is the documented headless mode (`agy -p --input-format stream-json
// --output-format stream-json` plus the conversation controls), fixed by the spike against
// agy 1.4.2. The fake agy validates the driver's argv against the recorded invocations.

import type { AgyCumulative } from "./contract.ts";

/** The event name a probe sends: agy ignores unknown events (stderr warning) but emits `init`. */
export const AGY_PROBE_EVENT = "agy-acp-probe";

export interface AgyProcessOptions {
	cwd: string;
	/** The exact environment the child sees. The caller owns it; it is never inherited implicitly. */
	env?: NodeJS.ProcessEnv;
	/** The program to run (default "agy"). */
	command?: string;
	/** argv prefix in place of the `agy` command (tests point this at the fake). */
	argvPrefix?: string[];
	model?: string;
	effort?: string;
	/** Resume this conversation in the new process (`--conversation`). */
	conversation?: string;
	addDirs?: string[];
	skipPermissions?: boolean;
	/** Max ms to wait for `init` after the probe (default 30 s - real agy takes up to ~9 s). */
	probeTimeoutMs?: number;
	/** Max bytes of stderr kept for diagnostics (default 64 KiB). */
	stderrBytes?: number;
	/** Max single stdout line in bytes (default 8 MiB); longer lines end the stream. */
	maxLineBytes?: number;
	/** Cumulative counters a previous process of the same conversation left behind. */
	previous?: AgyCumulative;
	/** Max ms to wait for a calm exit after closing stdin before signalling the group (default 3 s). */
	graceMs?: number;
	/** Max ms to wait after SIGTERM before SIGKILL (default 1 s). */
	termMs?: number;
	log?: (line: string) => void;
}

/** The flag vector the driver builds; exposed so tests and the fake can compare against it. */
export function agyArgs(options: Pick<AgyProcessOptions, "model" | "effort" | "conversation" | "addDirs" | "skipPermissions">): string[] {
	const args = ["--input-format", "stream-json", "--output-format", "stream-json", "-p="];
	if (options.model) args.push("--model", options.model);
	if (options.effort) args.push("--effort", options.effort);
	if (options.conversation) args.push("--conversation", options.conversation);
	for (const dir of options.addDirs ?? []) args.push("--add-dir", dir);
	if (options.skipPermissions) args.push("--dangerously-skip-permissions");
	return args;
}
