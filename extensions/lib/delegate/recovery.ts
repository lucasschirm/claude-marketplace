// Bringing the engine back after a pi restart, without lying about what happened.
//
// Recovery answers one question per in-flight session: *did the turn finish while pi was down?* The
// answers come from two different places and neither is sufficient alone — the process table says
// whether anything is still running, the agent's own store says whether it finished — and the honest
// third answer, "unknown", is reported as interrupted rather than as completed.
//
// Two hazards are specific to being an extension:
//  * Boot is a budget, not a suggestion. `session_start` is detached and abortable precisely so these
//    disk reads and subprocess probes happen after pi paints; every await here must respect the signal,
//    because a late result belongs to a session that is already gone (and a late drain would start
//    agents for it).
//  * A record on disk may predate this code. `agent` did not exist before the rename, and a session
//    whose files live under the old root is still a live Devin session — so legacy records are read,
//    never migrated, and default to the only agent that ever existed here.

import { extractCliError } from "./diagnostics.ts";
import { findAgent } from "./registry.ts";
import type { DelegateRuntime } from "./runtime.ts";
import { firstExisting, getStatePath, LEGACY_STORAGE_ROOT, readTextFileWithRetry, sessionFileCandidates, STORAGE_ROOT } from "./storage.ts";
import type { PersistedState, QueuedTask, SessionMeta, SessionStatus } from "./types.ts";
import { drainQueue } from "./queue.ts";

/** Pre-rename records are Devin records; anything else would be inventing history. */
const LEGACY_AGENT = "devin";

/** The statuses this build knows. Anything else is a record from a future writer. */
const STATUSES = new Set<SessionStatus>(["running", "stalled", "idle", "completed", "cancelled", "failed", "interrupted"]);

/**
 * Fill in what a stored record does not carry, and drop what this code cannot act on.
 *
 * Two refusals matter. A record naming a driver that is no longer registered is dropped: there is no
 * transport for it, so keeping it would show a session nobody can query, cancel, or restart. And a
 * status this build has never seen becomes `interrupted`, never `running` — "running" claims a child
 * process this pi does not have a handle on, which is the one lie a recovered session must not tell.
 */
export function normalizeMeta(raw: unknown): SessionMeta | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const m = raw as Partial<SessionMeta> & { agent?: string };
	if (typeof m.sessionId !== "string" || !m.sessionId) {
		return null;
	}
	if (typeof m.prompt !== "string" || !m.prompt) {
		return null;
	}
	const agent = typeof m.agent === "string" && m.agent ? m.agent : LEGACY_AGENT;
	if (!findAgent(agent).ok) {
		return null;
	}
	const status: SessionStatus | undefined = STATUSES.has(m.status as SessionStatus) ? (m.status as SessionStatus) : "interrupted";
	return {
		...(m as SessionMeta),
		agent,
		status,
		mode: typeof m.mode === "string" ? m.mode : "dangerous",
		createWorktree: m.createWorktree === true,
	};
}

/** A queued task as it was written to `state.json`. Needs the runtime only to mint a missing id. */
export function normalizeTask(raw: unknown, rt?: { totalInvoked: number }): QueuedTask | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const t = raw as Partial<QueuedTask>;
	if (typeof t.prompt !== "string" || !t.prompt) {
		return null;
	}
	const agent = typeof t.agent === "string" && t.agent ? t.agent : LEGACY_AGENT;
	if (!findAgent(agent).ok) {
		return null;
	}
	return {
		...(t as QueuedTask),
		agent,
		mode: typeof t.mode === "string" ? t.mode : "dangerous",
		createWorktree: t.createWorktree === true,
		enqueuedAt: typeof t.enqueuedAt === "number" ? t.enqueuedAt : Date.now(),
		// Minted by the caller (`queue.ts`), and preserved: a caller that was told `q-7` must still be
		// able to cancel `q-7` after a restart. A record with no id at all gets the next one.
		queueId: typeof t.queueId === "string" && t.queueId ? t.queueId : `q-${(rt?.totalInvoked ?? 0) + 1}`,
	};
}

/**
 * Rebuild engine state for one pi session.
 *
 * Called detached from `session_start`, and the only mutator of the queue and counters at boot: every
 * tool path awaits `recoveryDone` first, which is what lets the queue overwrite below be a restore
 * rather than a discard.
 */
/**
 * What a recovery pass did.
 *
 * `backfilled` is a lower bound when it is read: the store reads are async and deliberately not awaited,
 * so a session may still be resolving when the pass reports. It counts what recovery *found*, which is
 * what a boot notice and a test both want; it is not a settlement count.
 */
export interface RecoveryReport {
	recovered: number;
	orphanProcessesKilled: number;
	backfilled: number;
}

export async function recoverState(rt: DelegateRuntime, piSessionId: string, signal?: AbortSignal): Promise<RecoveryReport> {
	const report: RecoveryReport = { recovered: 0, orphanProcessesKilled: 0, backfilled: 0 };
	rt.currentPiSessionId = piSessionId;
	const raw = await readState(piSessionId);
	if (signal?.aborted) {
		return report;
	}
	if (raw === null) {
		rt.persistState();
		return report;
	}

	let state: PersistedState;
	try {
		state = JSON.parse(raw) as PersistedState;
	} catch (err) {
		// A state file this cannot read is not a reason to lose the queue silently.
		rt.logError(`Could not parse state.json (${extractCliError(err)}); starting empty`);
		return report;
	}

	// An explicit flag outranks a persisted limit; a persisted limit outranks the default. Otherwise a
	// one-off `--delegate-max-runs 5` would become permanent.
	const flagRuns = rt.flag("delegate-max-runs", "devin-max-runs");
	if (flagRuns !== undefined) {
		const parsed = Number.parseInt(flagRuns, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			rt.maxRuns = parsed;
		}
	} else if (state.maxRuns && state.maxRuns > 0) {
		rt.maxRuns = state.maxRuns;
	}
	// The total is never below the per-agent limit, here or at startup. Reading a persisted 3 back over a
	// `--delegate-max-runs 5` would produce a runtime where one agent can hold 5 of 3 slots.
	const flagTotal = rt.flag("delegate-max-runs-total");
	if (flagTotal !== undefined) {
		const parsed = Number.parseInt(flagTotal, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			rt.maxRunsTotal = Math.max(parsed, rt.maxRuns);
		}
	} else if (state.maxRunsTotal && state.maxRunsTotal > 0) {
		rt.maxRunsTotal = Math.max(state.maxRunsTotal, rt.maxRuns);
	}

	rt.totalInvoked = state.totalInvoked || 0;
	rt.totalCompleted = state.totalCompleted || 0;
	for (const [id, dir] of Object.entries(state.sessionDirs ?? {})) {
		rt.sessionDirs.set(id, dir);
	}

	// The queue is restored before any session is read, and the counters before that. The budget for this
	// pass is a few seconds; a pass that ran out of it used to return from the middle of the session loop,
	// leaving the FIFO empty while its tasks were still on disk — and the next `persistState()` from any
	// tool call then wrote that emptiness back. Order is the fix: whatever the budget allows, the queue is
	// already in memory by the time anything can be interrupted.
	if (Array.isArray(state.queue)) {
		rt.queue.length = 0;
		for (const t of state.queue) {
			const task = normalizeTask(t, rt);
			if (task) {
				rt.queue.push(task);
			}
		}
	}
	// An aborted pass has read enough to know what was there and not enough to say what is. Writing the
	// half-loaded view back would delete the sessions it never reached, so a killed recovery leaves the
	// file alone and the next pi reads the same state again.
	if (signal?.aborted) {
		return report;
	}

	if (Array.isArray(state.sessionIds)) {
		for (const sessionId of state.sessionIds) {
			if (signal?.aborted) {
				return report;
			}
			const meta = await readMeta(rt, piSessionId, sessionId, state.sessionDirs?.[sessionId]);
			if (!meta) {
				continue;
			}
			if (meta.status === "running" || meta.status === "stalled") {
				reconcileInFlight(rt, meta, report);
			}
			rt.sessions.set(sessionId, meta);
			report.recovered++;
			// No unconditional re-anchor here. A recovered record is written again when something about it
			// changed — `reconcileInFlight` and the backfill both persist what they mutate — and copying every
			// legacy record into the new root at boot made two copies of a session that had done nothing, with
			// its transcript still in the old one.
		}
	}

	// The loop above may have been cut short; the queue restored above is not a reason to write a partial
	// session list back over the file that still holds the rest.
	if (signal?.aborted) {
		return report;
	}
	rt.persistState();
	rt.updateStatusUI();
	drainQueue(rt);
	return report;
}

/** The state file, from this root or the pre-rename one. */
async function readState(piSessionId: string): Promise<string | null> {
	const found = await firstExisting([getStatePath(piSessionId, STORAGE_ROOT), getStatePath(piSessionId, LEGACY_STORAGE_ROOT)]);
	if (!found) {
		return null;
	}
	try {
		return await readTextFileWithRetry(found);
	} catch {
		// There a moment ago and unreadable now. Reported as "no prior state" rather than a crash, and
		// recovery writes nothing in that case, so the file still holds what it held.
		return null;
	}
}

async function readMeta(rt: DelegateRuntime, piSessionId: string, sessionId: string, recordedDir?: string): Promise<SessionMeta | null> {
	// `firstExisting` rather than reading each candidate: a pre-rename session misses on its new-root path
	// by design, and a miss through `readTextFileWithRetry` sleeps 150 ms. Times dozens of sessions, times
	// a 5 s boot budget, that is how legacy sessions stopped being recovered at all.
	const found = await firstExisting(sessionFileCandidates(piSessionId, sessionId, "meta.json", recordedDir));
	if (!found) {
		return null;
	}
	let raw: string;
	try {
		raw = await readTextFileWithRetry(found);
	} catch (err) {
		rt.logWarn(`Could not read ${found}: ${extractCliError(err)}`);
		return null;
	}
	try {
		return normalizeMeta(JSON.parse(raw));
	} catch (err) {
		rt.logWarn(`Could not read ${found}: ${extractCliError(err)}`);
		return null;
	}
}

/**
 * A session recorded as in flight: is anything left of it?
 *
 * An alive pid is an orphan — pi's side of the ACP connection died with the process, so nothing can
 * read that child's output or stop it politely. It is terminated and the session reported as
 * interrupted. A dead pid may still mean a finished turn, which is what the driver's own store is for.
 */
function reconcileInFlight(rt: DelegateRuntime, meta: SessionMeta, report: RecoveryReport): void {
	if (meta.pid && rt.isPidAlive(meta.pid)) {
		rt.killProcessGroup(meta.pid, rt.driverCli(meta.agent));
		report.orphanProcessesKilled++;
		meta.status = "interrupted";
		meta.finishedAt = Date.now();
		meta.error = "pi session restarted; the agent process was still running (orphaned) and was terminated. Restart with delegate_restart.";
		rt.persistSessionMeta(meta, true);
		return;
	}

	// Async, and deliberately not awaited: a sqlite read must not hold boot open for every other
	// session. The signal check before each mutation is what makes that safe — a result that lands
	// after the budget expired belongs to a session that is no longer here.
	rt.tasks.run(`backfill-${meta.sessionId}`, async (backfillSignal) => {
		const driver = findAgent(meta.agent);
		const text = driver.ok ? await driver.driver.backfill?.(meta.sessionId) : null;
		if (backfillSignal.aborted) {
			return;
		}
		if (text) {
			meta.status = "idle";
			meta.finishedAt = Date.now();
			report.backfilled++;
			rt.totalCompleted++;
			rt.appendEventLog(meta, "assistant_message", { text, backfilled: true });
			meta.dbBackfilled = true;
			rt.sendAgentMessage(
				`The session ${meta.sessionId} completed while pi was down (recovered from ${driver.ok ? driver.driver.title : "the agent"}'s session store). Check it with "delegate_status".`,
			);
		} else {
			meta.status = "interrupted";
			meta.finishedAt = Date.now();
			meta.error = "Process interrupted unexpectedly (pi session restart)";
		}
		rt.persistSessionMeta(meta, true);
		rt.persistState();
		if (backfillSignal.aborted) {
			return;
		}
		rt.updateStatusUI();
		drainQueue(rt);
	});
}
