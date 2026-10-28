// How a session launches its `agy`: one place for the argv and the env, shared by the first
// start and by every `--conversation` respawn (issue #54 made respawns a routine part of a long
// run, so the two paths must not be able to drift apart).
//
// The env is explicit, never inherited: the configured env plus the bridge trio the PreToolUse
// hook dials with (socket path, per-session token, its own deadline). `--add-dir` carries the
// bridge dir and `--dangerously-skip-permissions` is forced - the bridge hook is the only gate,
// and a hook cannot override headless auto-deny, so the two are a pair. A launch without a bridge
// must never happen (the session starts the bridge before it gets here for that reason).

import { AgyProcess, type AgyCumulative } from "./agy-driver.ts";
import type { SessionLaunchConfig } from "./session.ts";

export interface SessionSpawnOptions {
	config: SessionLaunchConfig;
	/** This session's bridge: its socket (the hook's address) and its dir (an extra `--add-dir`). */
	bridge: { socketPath: string; dir: string };
	hookToken: string;
	hookDeadlineMs: number;
	/** Resume this conversation in the new process (a respawn after a cancel or a child exit). */
	resume: boolean;
	conversationId: string;
	/** The cumulative counters the previous process of this conversation left, so usage deltas continue. */
	previous: AgyCumulative;
}

export function spawnSessionAgy(options: SessionSpawnOptions): AgyProcess {
	const a = options.config;
	return new AgyProcess({
		cwd: a.cwd,
		env: {
			...(a.env ?? process.env),
			AGY_ACP_SOCK: options.bridge.socketPath,
			AGY_ACP_TOKEN: options.hookToken,
			AGY_ACP_HOOK_DEADLINE_MS: String(options.hookDeadlineMs),
		},
		command: a.command,
		argvPrefix: a.argvPrefix,
		model: a.model,
		effort: a.effort,
		addDirs: [...(a.addDirs ?? []), options.bridge.dir],
		skipPermissions: true,
		conversation: options.resume ? options.conversationId : undefined,
		previous: options.previous,
		probeTimeoutMs: a.probeTimeoutMs,
		graceMs: a.graceMs,
		termMs: a.termMs,
		log: a.log,
	});
}
