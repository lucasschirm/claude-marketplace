#!/usr/bin/env node
/**
 * Devin CLI SessionStart hook: initializes the session's watch state.
 *
 * Creates the per-session-per-repo state file the other hooks share (the PostToolUse notifier's
 * baseline and the Stop watcher's watch clock) and sweeps state files older than a week. No
 * background daemon is spawned on purpose: a detached process has no channel to the agent - the
 * Stop hook is the watcher (it holds the stop while CI runs), and the PostToolUse hook injects
 * mid-turn transitions. Everything here is logged and fails open (hook-lib).
 */
import { logLine, readStdinJson, stateKey, sweepOldState, writeState } from "./hook-lib.mjs";

const SCRIPT = "session-init";

try {
	const input = await readStdinJson();
	const sessionId = input.session_id ?? "unknown";
	const cwd = process.env.DEVIN_PROJECT_DIR || process.cwd();
	const key = stateKey(sessionId, cwd);

	sweepOldState();
	const ok = writeState(key, { createdAt: new Date().toISOString(), lastCheckAt: 0 });
	logLine(SCRIPT, sessionId, ok ? "info" : "warn", ok ? "session watch state initialized" : "could not write the session watch state", `cwd=${cwd}`);
	process.exit(0);
} catch (err) {
	logLine(SCRIPT, "unknown", "error", "session-init hook failed", err?.stack ?? String(err));
	process.exit(0);
}
