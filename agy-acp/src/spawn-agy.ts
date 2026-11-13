// How a session launches its `agy`: one place for the argv and the env, shared by the first
// start and by every `--conversation` respawn (issue #54 made respawns a routine part of a long
// run, so the two paths must not be able to drift apart).
//
// The env is explicit at the spawn: lib/child-process.ts never inherits one implicitly, so the inherit is a decision
// taken here - the session's configured env, or this process's when the launch carried none - plus the bridge trio the
// PreToolUse hook dials with (socket path, per-session token, its own deadline). `--add-dir` carries the bridge dir and
// `--dangerously-skip-permissions` is forced - the bridge hook is the only gate, and a hook cannot override headless
// auto-deny, so the two are a pair. A launch without a bridge must never happen; the session starts it before this.

import { AgyProcess, type AgyCumulative } from "./agy-driver.ts";
import type { SessionLaunchConfig } from "./session.ts";
import type { LaunchFlags } from "./config-options.ts";

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
	/**
	 * The selection the child is launched with (issue #55): mode, model, effort, sandbox. They come
	 * from the session rather than the launch options because a client can change them - and the
	 * session is what decides when a change is worth a respawn.
	 */
	flags: LaunchFlags;
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
		model: options.flags.model,
		effort: options.flags.effort,
		mode: options.flags.mode,
		sandbox: options.flags.sandbox,
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
