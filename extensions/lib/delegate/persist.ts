// Writing engine state to disk, and what "persisted" is allowed to mean here.
//
// Two writers, two policies. The state file (`state.json`) is a single document rewritten whole, so its
// writes are serialized through one `WriteQueue` — concurrent rewrites of the same file is how a
// half-written JSON document appears. Per-session metadata (`meta.json`) changes on every ACP update, so
// it is debounced: an immediate write only when a status transition demands it, otherwise one write per
// few seconds of streaming.
//
// Nothing here is synchronous. It used to be, and `session_start` paid for it: Pi awaits that hook, so
// synchronous writes delayed the TUI on the path a user actually waits on. Durability is recovered at the
// boundaries that matter — `session_shutdown` and process exit drain the queue — rather than on every
// keystroke of the agent's output.

import type { DelegateRuntime } from "./runtime.ts";
import { getEventsLogPath, getMetaPath, getStatePath, sessionFileCandidates } from "./storage.ts";
import type { PersistedState, SessionMeta } from "./types.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractCliError } from "./diagnostics.ts";

/**
 * Where this session's transcript is, choosing an existing file over a new one.
 *
 * A session that predates the rename already has an `events.jsonl` under the old root. Creating the new
 * root's file the first time anything is appended to it (a recovery backfill, a post-restart notice)
 * would hide the old transcript from the reader, which returns the first file that exists — so the
 * appended line would be the whole history as far as `delegate_status` was concerned. One transcript per
 * session, in whichever root it started in.
 */
export function eventLogPath(rt: DelegateRuntime, meta: SessionMeta): string {
	const candidates = sessionFileCandidates(rt.currentPiSessionId, meta.sessionId, "events.jsonl", rt.sessionDirs.get(meta.sessionId));
	for (const p of candidates) {
		if (fs.existsSync(p)) {
			return p;
		}
	}
	return getEventsLogPath(rt.currentPiSessionId, meta.sessionId);
}

/** Append one transcript entry. A failure here is a warning, never a thrown error: losing a log line must
 *  not cost the caller its turn. */
export function appendEvent(rt: DelegateRuntime, meta: SessionMeta, type: string, data: unknown): void {
	try {
		const p = eventLogPath(rt, meta);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.appendFileSync(p, `${JSON.stringify({ timestamp: new Date().toISOString(), type, data })}\n`);
	} catch (err) {
		rt.logError(`Failed to append event for ${meta.sessionId}: ${extractCliError(err)}`);
	}
}

/**
 * Rewrite `state.json`.
 *
 * The session *records* are not in here — only their ids and where they live. That split is what keeps
 * this one write cheap enough to do on every queue change, and what makes a corrupted state file lose
 * the queue rather than the history.
 */
export function persistState(rt: DelegateRuntime): void {
	try {
		const state: PersistedState = {
			version: STATE_VERSION,
			maxRuns: rt.maxRuns,
			maxRunsTotal: rt.maxRunsTotal,
			totalInvoked: rt.totalInvoked,
			totalCompleted: rt.totalCompleted,
			queue: rt.queue,
			sessionIds: [...rt.sessions.keys()],
			// A recorded directory is kept, never re-anchored. The directory names where the session's
			// *files* are, and a resumed session's events.jsonl stays where it was written: overwriting the
			// entry with the current pi id made the transcript unreadable through the tools after a resume,
			// because the old pi id was no longer one of the candidates. A session with no recorded directory
			// yet (started in this pi session) gets the current one.
			sessionDirs: Object.fromEntries([...rt.sessions.keys()].map((id) => [id, rt.sessionDirs.get(id) ?? rt.currentPiSessionId])),
		};
		for (const id of rt.sessions.keys()) {
			if (!rt.sessionDirs.has(id)) {
				rt.sessionDirs.set(id, rt.currentPiSessionId);
			}
		}
		void rt.stateWrites.write(getStatePath(rt.currentPiSessionId), JSON.stringify(state, null, 2));
	} catch (err) {
		rt.logError(`Failed to persist state: ${extractCliError(err)}`);
	}
}

/** Bumped only when a reader needs to know which shape it loaded. Recovery tolerates older shapes. */
export const STATE_VERSION = 2;

/** Debounced unless `immediate`. Streaming updates must not thrash the disk; status changes must not lag. */
export function persistMeta(rt: DelegateRuntime, meta: SessionMeta, immediate = false): void {
	const save = (): void => {
		try {
			void rt.stateWrites.write(getMetaPath(rt.currentPiSessionId, meta.sessionId), JSON.stringify(meta, null, 2));
		} catch (err) {
			rt.logError(`Failed to persist meta for ${meta.sessionId}: ${extractCliError(err)}`);
		}
	};
	if (immediate) {
		const pending = rt.pendingMetaSaves.get(meta.sessionId);
		if (pending) {
			clearTimeout(pending.timer);
			rt.pendingMetaSaves.delete(meta.sessionId);
		}
		save();
		return;
	}
	if (!rt.pendingMetaSaves.has(meta.sessionId)) {
		const timer = setTimeout(() => {
			rt.pendingMetaSaves.delete(meta.sessionId);
			save();
		}, 3000);
		timer.unref?.();
		rt.pendingMetaSaves.set(meta.sessionId, { timer });
	}
}
