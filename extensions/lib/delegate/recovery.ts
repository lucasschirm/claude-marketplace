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
import {
	absolutePathOr,
	firstExisting,
	getStatePath,
	isStorageSafeId,
	LEGACY_STORAGE_ROOT,
	readTextFileWithRetry,
	sessionFileCandidates,
	STORAGE_ROOT,
} from "./storage.ts";
import type { PersistedState, QueuedTask, SessionMeta, SessionStatus } from "./types.ts";
import { drainQueue } from "./queue.ts";
import { clearSuperseded } from "./session.ts";

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
	// The id names a directory. A state or meta file is read with the same trust as a fresh one after a crash,
	// so the check that guards a live `session/new` answer has to guard the record on disk too — otherwise the
	// one file an attacker-adjacent process can plant (`~/.pi/agent/delegate_task/<pi session>/state.json`)
	// decides where the next read, write and cleanup go.
	if (typeof m.sessionId !== "string" || !isStorageSafeId(m.sessionId)) {
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
		// Both are used as a spawn cwd and `sessionCwd` additionally as a `session/resume` param, so they get
		// the suspicion the id gets: a record naming a relative path is dropped instead of resolved against
		// whichever directory pi runs in, and the session falls back to the runtime's base.
		sessionCwd: absolutePathOr(m.sessionCwd),
		supersededBy: supersededPointerOf(m.supersededBy),
		worktreePath: absolutePathOr(m.worktreePath),
		// A pid is a claim that ends in `kill(-pid)`, so it is checked before anything reads it: `0` would
		// signal pi's own process group and `1` would broadcast to the user's, and neither is stopped by the
		// recycle guard (there is no `/proc/0/cmdline` to compare against). See `isKillablePid`.
		pid: pidOr(m.pid),
	};
}

/** A recorded pid, or nothing. `process.pid` is excluded: a record must never describe the reader. */
function pidOr(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 1 && value !== process.pid ? value : undefined;
}

/** A recorded counter, or 0. A JSON value is not a number: `"3"`, `true`, `1.5` and `1e999` are all storable. */
function countOr(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_QUEUE_ID ? value : 0;
}

/**
 * A slot ceiling as read from disk: an integer within range, or nothing. `maxRunsTotal` is the one value
 * where a permissive read is worse than ignoring the file — `"3"`, `true` and `1.5` are all storable JSON and
 * all compare greater than zero, and `1e999` is `Infinity`, which makes the total ceiling stop binding
 * entirely so only the per-agent limit is left holding the line.
 */
function isPositiveLimit(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_QUEUE_ID;
}

/** The restart pointer as read back: an object naming a session, a queue entry, both, or neither. */
function supersededPointerOf(value: unknown): SessionMeta["supersededBy"] {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	const sessionId = typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : undefined;
	const queueId = typeof raw.queueId === "string" && raw.queueId ? raw.queueId : undefined;
	// Only the keys that are set. A round-tripped pointer has to compare equal to the one that was written,
	// and `{ sessionId: undefined, queueId: "q-7" }` does not strictly equal `{ queueId: "q-7" }`.
	const pointer: { sessionId?: string; queueId?: string } = {};
	if (sessionId) {
		pointer.sessionId = sessionId;
	}
	if (queueId) {
		pointer.queueId = queueId;
	}
	return pointer.sessionId || pointer.queueId ? pointer : undefined;
}

/** A queued task as it was written to `state.json`. Needs the runtime only to mint a missing id. */
export function normalizeTask(raw: unknown): QueuedTask | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const t = raw as Partial<QueuedTask>;
	if (typeof t.prompt !== "string" || !t.prompt) {
		return null;
	}
	// Same rule as a meta record: an id that cannot be a path segment is dropped, not sanitized. A queued task
	// has no session id yet, but it carries the id of the session it was delegated from, and that one names a
	// directory too once the transcript wants to say whose child this is.
	if (t.parentSessionId !== undefined && (typeof t.parentSessionId !== "string" || !isStorageSafeId(t.parentSessionId))) {
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
		// Preserved verbatim: a caller told `q-7` must still cancel `q-7` after a restart. Empty means no id
		// was recorded, and recovery mints one. This function must not hand one out: reading `totalInvoked`
		// without incrementing it gave two id-less records the same id, and gave recovery's uniqueness pass a
		// candidate it had already accepted — the collision it exists to remove, arriving by a different door.
		queueId: typeof t.queueId === "string" && t.queueId ? t.queueId : "",
		// The worktree fields are the two most dangerous strings a queue record can hold: `worktreePath` becomes
		// the agent's spawn cwd, and a folder is deleted by whatever selector it is handed. A relative path would
		// be resolved against whichever folder pi happens to run in, so it is dropped rather than guessed at — the
		// same rule `normalizeMeta` applies to the same fields. The ids are carried for provenance and for orca's
		// own bookkeeping: no deletion path selects by a stored id any more (`releaseWorktreeNow`, and the two
		// cleanup sites in this file's own queue, all select `path:` of the folder they looked at).
		worktreePath: absolutePathOr(t.worktreePath),
		worktreeBranch: typeof t.worktreeBranch === "string" ? t.worktreeBranch : undefined,
		worktreeId: typeof t.worktreeId === "string" && t.worktreeId ? t.worktreeId : undefined,
		parentWorktreeId: typeof t.parentWorktreeId === "string" && t.parentWorktreeId ? t.parentWorktreeId : undefined,
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
/** A lookup id, as `queue.ts` mints it. */
const QUEUE_ID_RE = /^q-(\d+)$/;

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
	} else if (isPositiveLimit(state.maxRuns)) {
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
	} else if (isPositiveLimit(state.maxRunsTotal)) {
		rt.maxRunsTotal = Math.max(state.maxRunsTotal, rt.maxRuns);
	}

	// A JSON value like every other one here: a non-number would make every mint for this boot `q-NaN`, and
	// a value past the reachable range would stall the generator, so neither counts as a counter at all.
	rt.totalInvoked =
		Number.isSafeInteger(state.totalInvoked) && state.totalInvoked > 0 && state.totalInvoked <= MAX_QUEUE_ID ? state.totalInvoked : 0;
	rt.totalCompleted = countOr(state.totalCompleted);
	for (const [id, recorded] of Object.entries(state.sessionDirs ?? {})) {
		// Both halves become path segments: the id names a session directory, the value is the *pi session id*
		// the record was written under and heads every later candidate list. A non-string throws inside
		// `path.join` partway through the session loop below — after the queue is restored, with the remaining
		// sessions never read and `persistState`/`drainQueue` skipped — and a `..`-bearing one reads or appends
		// outside the tree this extension owns. `normalizeMeta` guards its own fields; nothing guarded the
		// container's, and a hand-edited or half-written `state.json` reaches this line first.
		if (isStorageSafeId(id) && isStorageSafeId(recorded)) {
			rt.sessionDirs.set(id, recorded);
		}
	}

	// The queue is restored before any session is read, and the counters before that. The budget for this
	// pass is a few seconds; a pass that ran out of it used to return from the middle of the session loop,
	// leaving the FIFO empty while its tasks were still on disk — and the next `persistState()` from any
	// tool call then wrote that emptiness back. Order is the fix: whatever the budget allows, the queue is
	// already in memory by the time anything can be interrupted.
	if (Array.isArray(state.queue)) {
		rt.queue.length = 0;
		// Unique by the time anything reads them: a `{queueId}` pointer is matched by id, so two entries sharing
		// one make a dead restart look like it is still waiting, and `delegate_cancel` would free only the first
		// twin. This is the only pass that sees the whole queue, so it is the only place that hands ids out.
		// `totalInvoked` is the id generator, so it has to start above every id already on disk: a restored
		// `q-50` and a future `q-${++totalInvoked}` are the same lookup key, and that key is what a restart
		// pointer is matched by and what `delegate_cancel` takes.
		rt.totalInvoked = Math.max(rt.totalInvoked, highestQueueId(state.queue));
		const restoredIds = new Set<string>();
		for (const t of state.queue) {
			const task = normalizeTask(t);
			if (!task) {
				continue;
			}
			// Unique by one mint, never a retry: the counter has been cleared above every id on disk and only
			// climbs, so the first candidate is already free. A `while` here would have no escape — a
			// synchronous spin inside recovery cannot even be timed out by a test, because the timer needs the
			// event loop the loop is holding, and every tool path awaits this pass.
			if (!task.queueId || restoredIds.has(task.queueId)) {
				task.queueId = `q-${++rt.totalInvoked}`;
			}
			restoredIds.add(task.queueId);
			rt.queue.push(task);
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
			// An id from the list is a directory name before it is anything else, so it is checked the way every
			// other stored id is: `normalizeMeta` cannot vouch for a value that never reaches it.
			if (typeof sessionId !== "string" || !isStorageSafeId(sessionId)) {
				continue;
			}
			// The validated map, never the container: reading `state.sessionDirs` again here would hand the raw
			// value straight to `path.join` inside `sessionFileCandidates`, which is the exact failure the pass
			// above exists to prevent — a non-string throws mid-loop (queue restored, later sessions unread,
			// pointer reconciliation, `persistState` and the drain all skipped, and because recovery is floated
			// the rejection is swallowed and every later tool runs on the partial state), and a `..`-bearing
			// string probes for a plantable `meta.json` outside the storage tree.
			const meta = await readMeta(rt, piSessionId, sessionId, rt.sessionDirs.get(sessionId));
			if (!meta) {
				continue;
			}
			if (meta.status === "running" || meta.status === "stalled") {
				reconcileInFlight(rt, meta, report);
			}
			// Keyed by what the record says, not by the list: the map key is what `persistState` writes back as a
			// session id and what every lookup answers to, so a list entry and a record that disagree would leave
			// a session whose key, `meta.json` and transcript candidates are three different answers — and the
			// next save would write that split forward.
			rt.sessions.set(meta.sessionId, meta);
			if (meta.sessionId !== sessionId) {
				// Carry the recorded root across the rename, or lose it: `persistState` keys `sessionDirs` by
				// session key, so an entry left under the list id is dropped on the next save and the record
				// then resolves under *this* pi session id — where its files are not — and disappears on the
				// second boot.
				const recorded = rt.sessionDirs.get(sessionId);
				if (recorded) {
					rt.sessionDirs.set(meta.sessionId, recorded);
					rt.sessionDirs.delete(sessionId);
				}
			}
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
	reconcileRestartPointers(rt);
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

/**
 * The largest queue-id suffix a generator could actually reach, so a corrupt one cannot freeze it.
 *
 * `q-999999999999999999999` parses to 1e21, where `++` is absorbed and every mint is the same string
 * forever — and the minted `q-1e+21` no longer matches `QUEUE_ID_RE`, so the next boot cannot even see the
 * value that stalled it. A queue a billion deep is corrupt data, not a queue.
 */
const MAX_QUEUE_ID = 1_000_000_000;

/** The highest numeric queue id in a restored queue, so the generator can start above it. */
function highestQueueId(entries: unknown[]): number {
	let highest = 0;
	for (const raw of entries) {
		const id = (raw as { queueId?: unknown } | null)?.queueId;
		const match = typeof id === "string" ? QUEUE_ID_RE.exec(id) : null;
		if (!match) {
			continue;
		}
		const n = Number.parseInt(match[1], 10);
		if (Number.isSafeInteger(n) && n <= MAX_QUEUE_ID) {
			highest = Math.max(highest, n);
		}
	}
	return highest;
}

/**
 * Make the restart pointers agree with what actually came back.
 *
 * A `supersededBy` pointer is a promise about the future, and a pi that died part-way through a restart
 * leaves promises that no longer match the records on disk. Two reconciliations, in this order and for a
 * reason:
 *
 *  - **a successor that came back takes the conversation.** `delegate_restart` is the only writer of
 *    `parentSessionId`, on the session *and* on the queued task carrying it, so either naming a parent *is*
 *    that restart — even when the crash beat the restart's own call to `markSuperseded`. Without the pointer
 *    both records are addressable and both name the folder the restart reused: the hazard it exists to prevent.
 *  - **a pointer naming nothing is handed back.** Absent means no successor with provenance came back. The
 *    crash can land after `drainQueue` popped the entry and before `resolveQueuedRestart` rewrote the pointer,
 *    which leaves a `{queueId}` with nothing queued — and possibly a record on disk that never got its
 *    `parentSessionId`, which no derivation can see. Whatever the history, a pointer to an absent target sends
 *    every caller somewhere they cannot act on, permanently, while each worktree path skips the record; handing
 *    the conversation back makes it messageable again and its folder reclaimable.
 *
 * Deriving first is what makes the second safe: a pointer derived from something that came back is not cleared.
 *
 */
/** Does following this session's restart chain reach `target`? Used to refuse a derived pointer that would
 * close a cycle — a cycle would refuse every conversation inside it, permanently. */
function restartsA(rt: DelegateRuntime, fromSessionId: string, target: string): boolean {
	let current = rt.sessions.get(fromSessionId);
	for (let hops = 0; current && hops < 32; hops++) {
		const next = current.supersededBy?.sessionId;
		if (!next) {
			return false;
		}
		if (next === target) {
			return true;
		}
		current = rt.sessions.get(next);
	}
	return true;
}

function reconcileRestartPointers(rt: DelegateRuntime): void {
	for (const meta of rt.sessions.values()) {
		if (!meta.parentSessionId) {
			continue;
		}
		const parent = rt.sessions.get(meta.parentSessionId);
		// `restartsA` guards the two-node cycle: provenance from disk can say A restarted B and B restarted
		// A, and deriving both pointers leaves every conversation in the loop refused as superseded, with no
		// way out but editing `state.json`. Legit writers only point backwards in creation order.
		if (parent && parent !== meta && !parent.supersededBy && !restartsA(rt, meta.sessionId, parent.sessionId)) {
			parent.supersededBy = { sessionId: meta.sessionId };
			rt.persistSessionMeta(parent, true);
			rt.logWarn(`recovered the restart pointer of ${parent.sessionId}: ${meta.sessionId} came back as its restarted session`);
		}
	}
	for (const task of rt.queue) {
		if (!task.parentSessionId) {
			continue;
		}
		const parent = rt.sessions.get(task.parentSessionId);
		if (parent && !parent.supersededBy) {
			parent.supersededBy = { queueId: task.queueId };
			rt.persistSessionMeta(parent, true);
			rt.logWarn(`recovered the restart pointer of ${parent.sessionId}: ${task.queueId} came back waiting to restart it`);
		}
	}
	const queueIds = new Set(rt.queue.map((t) => t.queueId));
	for (const meta of rt.sessions.values()) {
		const pointer = meta.supersededBy;
		if (!pointer) {
			continue;
		}
		const named = pointer.sessionId ?? `queue entry ${pointer.queueId ?? "?"}`;
		// Either half is enough. The shape allows both keys, and a pointer whose session half is dead but whose
		// queued restart is alive still has somewhere to send a caller.
		const alive =
			(pointer.sessionId !== undefined && rt.sessions.has(pointer.sessionId)) ||
			(pointer.queueId !== undefined && queueIds.has(pointer.queueId));
		if (alive) {
			continue;
		}
		clearSuperseded(rt, meta);
		rt.logWarn(
			`dropped the restart pointer of ${meta.sessionId} (${named}): nothing came back for it, so its conversation is its own again`,
		);
	}
}
