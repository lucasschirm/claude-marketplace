#!/usr/bin/env node
/**
 * Devin CLI PostToolUse hook: the mid-turn change notifier.
 *
 * Fires after every tool call. At most once per NOTIFY_MIN_INTERVAL_MS it reads the current
 * branch's PR (mergeability + CI) and diffs it against the last snapshot recorded in the session's
 * state file; a transition is injected into the agent's context via `additionalContext`:
 *
 *   - a conflict appearing (or the base moving ahead) while the agent works,
 *   - CI turning from running to failed (or to passed),
 *   - the branch's PR changing.
 *
 * Never blocks anything: the only output is additionalContext, and every failure is logged and
 * fails open (hook-lib). The first call of a session records the baseline silently - only
 * transitions after that are news.
 */
import * as path from "node:path";
import { NOTIFY_MIN_INTERVAL_MS, loadEngine, logLine, readPrSnapshot, readState, readStdinJson, stateKey, writeHookOutput, writeState } from "./hook-lib.mjs";

const SCRIPT = "notify-changes";

try {
	const input = await readStdinJson();
	const sessionId = input.session_id ?? "unknown";
	const pluginRoot = process.env.DEVIN_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");
	const cwd = process.env.DEVIN_PROJECT_DIR || process.cwd();
	const key = stateKey(sessionId, cwd);

	const engine = await loadEngine(pluginRoot);
	if (!engine.vendored) {
		logLine(SCRIPT, sessionId, "warn", "vendored engine failed to load; using the inline fallback classifier", engine.err?.message ?? String(engine.err));
	}

	const state = readState(key);
	const now = Date.now();
	const lastCheckAt = Number.isFinite(state.lastCheckAt) ? state.lastCheckAt : 0;
	if (now - lastCheckAt < NOTIFY_MIN_INTERVAL_MS) {
		logLine(SCRIPT, sessionId, "info", "skipped: checked too recently", `lastCheckAgoMs=${now - lastCheckAt}`);
		process.exit(0);
	}

	const snap = await readPrSnapshot(engine, cwd);
	if (snap.error) {
		logLine(SCRIPT, sessionId, "error", "could not read the PR; injecting nothing", snap.error);
		// (lastCheckAt is not advanced: the next tool call retries sooner rather than later)
		process.exit(0);
	}

	const previous = state.lastSnapshot;
	const persist = (snapshot) => {
		if (!writeState(key, { ...state, lastCheckAt: now, lastSnapshot: snapshot })) {
			logLine(SCRIPT, sessionId, "warn", "could not persist the snapshot; transitions may repeat");
		}
	};

	if (snap.none) {
		// No open non-draft PR: nothing to watch. A previous snapshot (the PR was merged/closed
		// mid-session) is itself news worth one line.
		if (previous && previous.prNumber !== undefined) {
			logLine(SCRIPT, sessionId, "info", "PR no longer open; reporting the transition", `state=${snap.state ?? "gone"}`);
			persist({ prNumber: previous.prNumber, gone: true, at: new Date().toISOString() });
			writeHookOutput({
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					additionalContext: `PR #${previous.prNumber} is no longer open (${snap.state ? `state: ${snap.state.toLowerCase()}` : "gone from GitHub"}). Nothing to observe on this branch anymore.`,
				},
			});
			process.exit(0);
		}
		persist({ prNumber: undefined, at: new Date().toISOString() });
		logLine(SCRIPT, sessionId, "info", "no open non-draft PR on this branch; nothing to watch");
		process.exit(0);
	}

	const snapshot = {
		prNumber: snap.prNumber,
		mergeState: snap.mergeState,
		ciVerdict: snap.ci.verdict,
		at: new Date().toISOString(),
	};

	if (!previous || previous.prNumber !== snap.prNumber) {
		// First sight of this PR (or the branch's PR changed): baseline, not news.
		if (previous && previous.prNumber !== undefined) {
			logLine(SCRIPT, sessionId, "info", "the branch's PR changed; rebaselining", `from=${previous.prNumber} to=${snap.prNumber}`);
		} else {
			logLine(SCRIPT, sessionId, "info", "baseline recorded", `pr=${snap.prNumber} mergeState=${snap.mergeState} ci=${snapshot.ciVerdict}`);
		}
		persist(snapshot);
		process.exit(0);
	}

	const news = [];
	if (previous.mergeState !== snapshot.mergeState) {
		if (snapshot.mergeState === "conflicting") news.push(`PR #${snap.prNumber} now conflicts with its base branch (mergeable: CONFLICTING); rebase or merge the base into it before it can land.`);
		else if (snapshot.mergeState === "behind") news.push(`The base branch of PR #${snap.prNumber} has moved ahead (mergeableState: BEHIND); rebase or merge the base into it before it can land.`);
		else if (previous.mergeState === "conflicting" || previous.mergeState === "behind") news.push(`PR #${snap.prNumber} is mergeable again (the conflict or BEHIND state cleared).`);
	}
	if (previous.ciVerdict !== snapshot.ciVerdict) {
		if (snapshot.ciVerdict === "failed") news.push(`CI for PR #${snap.prNumber} failed; investigate the failing checks.`);
		else if (snapshot.ciVerdict === "passed") news.push(`All CI passed for PR #${snap.prNumber}.`);
		else if (previous.ciVerdict === "passed" || previous.ciVerdict === "failed") news.push(`CI for PR #${snap.prNumber} is running again (a new push or re-run).`);
	}

	persist(snapshot);
	if (news.length === 0) {
		logLine(SCRIPT, sessionId, "info", "no transitions since the last check", `pr=${snap.prNumber}`);
		process.exit(0);
	}
	logLine(SCRIPT, sessionId, "info", "injecting transition news", news.join(" | "));
	writeHookOutput({
		hookSpecificOutput: {
			hookEventName: "PostToolUse",
			additionalContext: news.join(" "),
		},
	});
	process.exit(0);
} catch (err) {
	logLine(SCRIPT, "unknown", "error", "notify hook failed; injecting nothing", err?.stack ?? String(err));
	process.exit(0);
}
