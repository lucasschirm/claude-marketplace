#!/usr/bin/env node
/**
 * Devin CLI Stop hook: the PR watcher.
 *
 * Fires when the agent wants to stop. While the current branch's pull request cannot land, this
 * process holds the stop - it is the "daemon": it polls `gh` until something notable happens, and
 * only then answers.
 *
 *   - PR merged/closed, no PR, draft, or landable (CI passed + mergeable) -> exit 0, the stop goes
 *     through and the session ends.
 *   - Actionable problem (CONFLICTING, BEHIND, failing CI) -> `decision: block` with the reason as
 *     the news; the agent continues its turn with it.
 *   - CI still running -> sleep in bounded chunks. A chunk that ends with no news blocks with a
 *     heartbeat reason ("stop again to keep waiting"), which re-arms the watcher: the agent stops
 *     again, the hook fires again, sleeps again. Each heartbeat costs one cheap model turn; the
 *     sleeping itself costs none.
 *
 * The user is never trapped: Esc / Ctrl+C cancel the agent outright, and the total watch time is
 * capped (WATCH_MAX_MS, carried across re-arms in the state file) after which the stop is allowed.
 *
 * Failures fail open with a log line (hook-lib): a broken watcher must never wedge a session.
 * Review conversations are deliberately out of scope here (the MCP tools and the AGENTS.md rule
 * own them); this hook watches mergeability and CI.
 */
import * as path from "node:path";
import {
	WATCH_CHUNK_MS,
	WATCH_MAX_MS,
	WATCH_POLL_MS,
	loadEngine,
	logLine,
	readPrSnapshot,
	readState,
	readStdinJson,
	sleep,
	stateKey,
	writeHookOutput,
	writeState,
} from "./hook-lib.mjs";

const SCRIPT = "check-settle";

try {
	const input = await readStdinJson();
	const sessionId = input.session_id ?? "unknown";
	const pluginRoot = process.env.DEVIN_PLUGIN_ROOT || path.resolve(import.meta.dirname, "..");
	const cwd = process.env.DEVIN_PROJECT_DIR || process.cwd();
	const key = stateKey(sessionId, cwd);

	logLine(SCRIPT, sessionId, "info", "stop hook fired", `stop_hook_active=${Boolean(input.stop_hook_active)} cwd=${cwd}`);

	const engine = await loadEngine(pluginRoot);
	if (!engine.vendored) {
		logLine(SCRIPT, sessionId, "warn", "vendored engine failed to load; using the inline fallback classifier", engine.err?.message ?? String(engine.err));
	}

	const snap = await readPrSnapshot(engine, cwd);
	if (snap.error) {
		logLine(SCRIPT, sessionId, "error", "could not read the PR; allowing the stop", snap.error);
		process.exit(0);
	}
	if (snap.none) {
		logLine(SCRIPT, sessionId, "info", "no open non-draft PR on this branch; allowing the stop", snap.state ? `state=${snap.state}` : undefined);
		process.exit(0);
	}

	const prNumber = snap.prNumber;
	const block = (reason) => {
		logLine(SCRIPT, sessionId, "info", "blocking the stop", reason);
		writeHookOutput({ decision: "block", reason });
		process.exit(0);
	};

	// Actionable states first: a conflict is work the agent can do right now, whatever CI is doing.
	if (snap.mergeState === "conflicting") {
		block(
			`PR #${prNumber} conflicts with its base branch (mergeable: CONFLICTING). Rebase or merge the base into the PR branch and resolve the conflicts before it can land. ` +
				"To end the session anyway, press Esc to cancel.",
		);
	}
	if (snap.mergeState === "behind") {
		block(
			`The base branch of PR #${prNumber} has moved ahead (mergeableState: BEHIND). Rebase or merge the base into the PR branch before it can land. ` +
				"To end the session anyway, press Esc to cancel.",
		);
	}
	if (snap.ci.verdict === "failed") {
		const names = snap.ci.failedNames.slice(0, 5).join(", ");
		block(
			`CI failed for PR #${prNumber}${names ? ` (failing: ${names})` : ""}. Investigate and fix the failure before stopping. ` +
				"To end the session anyway, press Esc to cancel.",
		);
	}

	// No CI configured, or an unreadable checks call: nothing to wait for - fail open.
	if (snap.ci.verdict !== "unknown" || snap.ci.ghFailed || snap.ci.pendingCount === 0) {
		logLine(SCRIPT, sessionId, "info", "PR is landable (or CI is unreadable); allowing the stop", `verdict=${snap.ci.verdict} mergeState=${snap.mergeState}`);
		process.exit(0);
	}

	// CI is running: hold the stop and watch. The clock is shared across re-arms via the state file.
	const state = readState(key);
	const now = Date.now();
	const watchStartedAt = Number.isFinite(state.watchStartedAt) ? state.watchStartedAt : now;
	if (now - watchStartedAt >= WATCH_MAX_MS) {
		logLine(SCRIPT, sessionId, "info", "watch budget exhausted; allowing the stop", `watchedMs=${now - watchStartedAt}`);
		process.exit(0);
	}

	const chunkDeadline = now + WATCH_CHUNK_MS;
	const watchDeadline = watchStartedAt + WATCH_MAX_MS;
	let waitedMs = now - watchStartedAt;
	logLine(SCRIPT, sessionId, "info", "CI running; watching", `pr=${prNumber} chunkMs=${WATCH_CHUNK_MS} pollMs=${WATCH_POLL_MS}`);

	for (;;) {
		await sleep(Math.min(WATCH_POLL_MS, Math.max(chunkDeadline - Date.now(), 0)));
		if (Date.now() >= chunkDeadline || Date.now() >= watchDeadline) break;

		const next = await readPrSnapshot(engine, cwd);
		if (next.error) {
			// A transiently broken read must not end the watch; the next poll retries.
			logLine(SCRIPT, sessionId, "warn", "poll read failed; continuing the watch", next.error);
			continue;
		}
		if (next.none) {
			logLine(SCRIPT, sessionId, "info", "PR closed or merged while watching; allowing the stop", next.state ? `state=${next.state}` : undefined);
			process.exit(0);
		}
		waitedMs = Date.now() - watchStartedAt;
		if (next.prNumber !== prNumber) {
			// The branch's PR was retargeted/closed and a different one opened: report it rather
			// than watching the old number forever.
			block(`The branch's pull request changed from #${prNumber} to #${next.prNumber} while CI was being watched. Re-run observe_pr to pick it up.`);
		}
		if (next.mergeState === "conflicting") {
			block(`PR #${prNumber} began conflicting with its base branch while CI ran (mergeable: CONFLICTING). Rebase or merge the base into the PR branch. To end the session anyway, press Esc to cancel.`);
		}
		if (next.mergeState === "behind") {
			block(`The base branch of PR #${prNumber} moved ahead while CI ran (mergeableState: BEHIND). Rebase or merge the base into the PR branch. To end the session anyway, press Esc to cancel.`);
		}
		if (next.ci.verdict === "failed") {
			const names = next.ci.failedNames.slice(0, 5).join(", ");
			block(`CI failed for PR #${prNumber} while it was being watched${names ? ` (failing: ${names})` : ""}. Investigate and fix the failure before stopping. To end the session anyway, press Esc to cancel.`);
		}
		if (next.ci.verdict === "passed" && next.mergeState !== "conflicting" && next.mergeState !== "behind") {
			logLine(SCRIPT, sessionId, "info", "CI passed while watching; allowing the stop", `pr=${prNumber} waitedMs=${waitedMs}`);
			process.exit(0);
		}
		// (still pending: keep sleeping until the chunk or the watch budget runs out)
	}

	const persisted = writeState(key, {
		...state,
		prNumber,
		watchStartedAt,
		reArms: (Number.isFinite(state.reArms) ? state.reArms : 0) + 1,
		lastSnapshot: { mergeState: snap.mergeState, ciVerdict: snap.ci.verdict, at: new Date().toISOString() },
	});
	if (!persisted) logLine(SCRIPT, sessionId, "warn", "could not persist the watch state; the next re-arm restarts the watch clock");

	const minutes = Math.round(waitedMs / 60_000);
	const budgetMinutes = Math.round(WATCH_MAX_MS / 60_000);
	if (Date.now() >= watchDeadline) {
		logLine(SCRIPT, sessionId, "info", "watch budget exhausted at chunk end; allowing the stop", `waitedMs=${waitedMs}`);
		process.exit(0);
	}
	block(
		`CI for PR #${prNumber} is still running (${minutes} of at most ${budgetMinutes} min waited). End your turn again to keep waiting - do not start other work; the watcher will wake you when CI finishes, fails, or the PR conflicts. ` +
			"To end the session anyway, press Esc to cancel.",
	);
} catch (err) {
	logLine(SCRIPT, "unknown", "error", "stop hook failed; allowing the stop", err?.stack ?? String(err));
	process.exit(0);
}
