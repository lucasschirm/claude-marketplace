// `session/load`, `session/resume` and `session/list` (issue #56).
//
// One validation path, two answers. The ACP spec is emphatic that `load` and `resume` differ only in
// whether the client is handed the conversation's history - `load` replays every `session/update` and
// then behaves as if the session had never gone away; `resume` says "I know about it, give me the
// session" - so the store's checks, the workspace rule, the lock, the adoption and the registration are
// shared here and the only fork is the replay. Splitting the validation into two handlers is how they
// drift, and the drift is invisible until a client loads something `resume` would have refused.
//
// Both answer with what `session/new` answers with (modes, models, configOptions): a client that had
// controls before needs them again, and an agent that answers a load with less than it offers elsewhere
// invites the client to assume the session came back wrong.
//
// The lazy part is the point of the issue: adopting a session starts no `agy`. The resume happens on the
// next prompt, in `AgySession.ensureDriver`, where a session that needs a child already knows how to add
// `--conversation`. A client that loads ten conversations and prompts one of them pays for one child; the
// other nine are a directory, a record and a lock.

import type { AcpSessionInfo, AcpSessionListResult, AcpSessionModeState, AcpSessionModelState, AcpSessionUpdate } from "./acp.ts";
import type { AcpConfigOption } from "./config-options.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";
import type { ListedSession, SessionStore } from "./session-store/store.ts";
import { MAX_PAGE_SIZE } from "./session-store/listing.ts";
import { isSessionId, type StoredUpdate } from "./session-store/records.ts";
import type { SelectionRecord } from "./selection-record.ts";
import * as path from "node:path";
import type { AgySession } from "./session.ts";

/** What a restored session answers: the `session/new` shape, plus what the store kept. */
export interface RestoredResult {
	sessionId: string;
	modes: AcpSessionModeState;
	models: AcpSessionModelState;
	configOptions?: AcpConfigOption[];
	_meta?: Record<string, unknown>;
}

/**
 * The part of a session the answer needs, so the answer never depends on a live child. `configOptions`
 * takes no argument because a session resolves the model list itself (per-process, and it may have
 * failed - see models.ts): the answer must not need anything the session does not already hold.
 */
export interface SelectionView {
	modes(): AcpSessionModeState;
	modelsState(): AcpSessionModelState;
	/** No argument: a session resolves the model list itself, so the answer needs nothing the session
	 * does not already have (the list is per-process and may have failed - see models.ts). */
	configOptions(): AcpConfigOption[];
}

/**
 * The selection states in the shape `session/new` answers with, shared with it on purpose: a session must
 * not answer a load with a different set of controls than it advertised when it was created. A client that
 * had a mode list before has to get one back, or it concludes the restored session is somehow lesser -
 * and usually it is right, because a session that comes back with fewer options is a session whose stored
 * mode was quietly not honoured.
 */
export function advertisedState(session: SelectionView): {
	modes: AcpSessionModeState;
	models: AcpSessionModelState;
	configOptions: AcpConfigOption[];
} {
	return { modes: session.modes(), models: session.modelsState(), configOptions: session.configOptions() };
}

/** A stored selection plus the workspace it belongs to: everything a restored session is built from. */
export interface RestorableSelection extends SelectionRecord {
	cwd: string;
}

export interface RestoreDeps {
	store: SessionStore;
	/** Put the restored session on this connection; false means the connection closed during the load. */
	registryAdd: (sessionId: string, session: AgySession) => boolean;
	/**
	 * One `session/update` to this connection, answering with whether the frame went out: a replay has to
	 * know when the transport stopped taking frames, or it would push a whole transcript into a connection
	 * that had already gone and then report a replay that never happened.
	 */
	send: (sessionId: string, update: AcpSessionUpdate) => boolean;
	log: (line: string) => void;
	/** A session object for a stored record: the operator's launch config, the record's workspace. */
	build: (restored: RestorableSelection) => AgySession;
}

/** Map a store refusal onto the JSON-RPC answer the issue fixes. */
function rpcFailure(method: string, sessionId: string, failure: { kind: string; reason: string; recorded?: string }): RpcError {
	switch (failure.kind) {
		case "unknown":
			// ACP's "resource not found": not a conversation this agent has a record of. The reason says
			// where the record would have been, because "unknown" alone sends an operator to agy's own
			// storage - the one place agy-acp does not look.
			return new RpcError(RESOURCE_NOT_FOUND, failure.reason, { reason: "session_not_found", sessionId });
		case "cwd-mismatch":
			// Invalid params: the request asked for a conversation in a workspace that is not the one it
			// belongs to. The recorded path is in the message because the fix is to open the other project,
			// and guessing which is how a conversation ends up looking lost.
			return new RpcError(INVALID_PARAMS, failure.reason, { reason: "cwd_mismatch", sessionId, recordedCwd: failure.recorded });
		case "locked":
			return new RpcError(INTERNAL_ERROR, `${method}: ${failure.reason}`, { reason: "session_in_use", sessionId });
		case "open-in-process":
			return new RpcError(INVALID_PARAMS, `${method}: ${failure.reason}`, { reason: "session_open", sessionId });
		default:
			return new RpcError(INTERNAL_ERROR, `${method}: ${failure.reason}`, { reason: "store_unavailable", sessionId });
	}
}

/**
 * One restored session: validate against the store, adopt it, register it, and (for `load` only) replay
 * what we sent while it ran.
 *
 * The order is the contract. The recorder is attached *after* the replay, because a session that recorded
 * its own replay would double its history on every load - a bug that cannot appear on the first restart.
 * And the store is asked to prove it can still write before the client is told the session is back: a
 * record that cannot be updated is a conversation whose history silently stops at this moment, which is
 * worse than a load that fails.
 */
async function restore(
	deps: RestoreDeps,
	method: "session/load" | "session/resume",
	params: unknown,
	withReplay: boolean,
): Promise<RestoredResult> {
	const p = (params ?? {}) as Record<string, unknown>;
	const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
	const cwd = typeof p.cwd === "string" ? p.cwd : "";
	if (sessionId === "" || cwd === "") throw new RpcError(INVALID_PARAMS, `${method} requires a sessionId and a cwd`);
	// A shape the store could never have written is not a session either way - and it must not reach the
	// filesystem as a path, which is the other thing this check is for.
	if (!isSessionId(sessionId)) {
		throw new RpcError(RESOURCE_NOT_FOUND, deps.store.unknownReason(sessionId), { reason: "session_not_found", sessionId });
	}
	const opened = await deps.store.open(sessionId, cwd, withReplay);
	if (!opened.ok) throw rpcFailure(method, sessionId, opened.failure);
	const meta = opened.opened.meta;
	// Opening the store took this conversation's lock, so from here the failure path owes it back, and the
	// recorder is what hands it over (its release runs on dispose). Hence *before* anything can fail: a load
	// that failed with the hold still behind it left the conversation unopenable here until this process
	// exited, and refused elsewhere as held by a pid that was alive all along. The recorder cannot record
	// the replay that follows, because a replay is sent by the transport, not by the session.
	const release = () => deps.store.release(sessionId);
	let session: AgySession | null = null;
	try {
		// The stored selection is the session's starting point; a part of it this process cannot honour is
		// corrected by the session and reported in the answer, never carried in silence.
		session = deps.build({ cwd: meta.cwd, mode: meta.mode, model: meta.model, effort: meta.effort });
		session.attachRecorder(opened.opened.journal, release);
		await session.adopt(sessionId);
		const registered = deps.registryAdd(sessionId, session);
		// The store must accept a write before the client is told the session is back: a record that cannot
		// be updated is a conversation whose history silently stops at this moment, which is worse than a
		// load that fails.
		const degraded = await opened.opened.journal.ready();
		if (degraded !== null) throw new RpcError(INTERNAL_ERROR, `${method}: the session store cannot be written (${degraded})`);
		const notes = session.restoreNotes();
		for (const note of notes) deps.log(`session ${sessionId}: ${note}`);
		if (!registered) {
			// The connection died mid-load. The registry disposes what arrives late (issue #53) and the
			// dispose hands the lock back, so nothing is left holding the conversation; the replay is
			// skipped because there is nothing to replay to, and the answer goes the way of every answer to
			// a closed transport. Same shape as a `session/new` that finishes after its connection.
			deps.log(`session ${sessionId}: ${method} finished after the connection closed - disposed with it`);
		} else if (withReplay) {
			replay(deps, sessionId, opened.opened.replay, opened.opened.truncated);
		}
		const restored: Record<string, unknown> = {
			cwd: meta.cwd,
			title: meta.title,
			updatedAt: new Date(meta.updatedAtMs).toISOString(),
			turns: meta.turns,
		};
		// `notes` is always the array (a client iterates it without guessing); the two warnings appear
		// only when they apply, because a key that is always there teaches nobody to read it.
		restored.notes = notes;
		if (opened.opened.droppedLines > 0) restored.droppedUpdates = opened.opened.droppedLines;
		if (opened.opened.truncated) restored.truncated = true;
		return { sessionId, ...advertisedState(session), _meta: { restored, ...unsupportedExtras(p) } };
	} catch (err) {
		// Whatever was built goes away, lock included: a failed load must not leave a session holding a
		// conversation no client has. A failure before it existed still leaves the lock to give back.
		if (session === null) await release();
		else await session.dispose();
		throw err;
	}
}

/** What the client sent that we cannot honour, in the shape `session/new` uses for it: the lifecycle
 * requests carry `mcpServers` and `additionalDirectories` as well, and a client that reconnects them on
 * every load has to hear they were not configured rather than assume they were. */
function unsupportedExtras(p: Record<string, unknown>): Record<string, unknown> {
	const notes: Record<string, unknown> = {};
	for (const key of ["mcpServers", "additionalDirectories"] as const) {
		const requested = p[key];
		if (Array.isArray(requested) && requested.length > 0) notes[key] = { supported: false, requested };
	}
	return notes;
}

/**
 * Send the stored updates, oldest first, before the answer.
 *
 * A failed send stops the replay rather than the load: the client is missing part of a transcript, which
 * the log says plainly, because a session that exists and answers beats a history that could not be
 * re-sent. Failing the load instead would leave the client with no session at all and a conversation it
 * has no other way back into.
 */
function replay(deps: RestoreDeps, sessionId: string, updates: StoredUpdate[], truncated: boolean): void {
	if (updates.length === 0) {
		if (truncated) deps.log(`session ${sessionId}: the stored transcript was over the read budget and replayed from its end`);
		return;
	}
	let sent = 0;
	for (const stored of updates) {
		if (!deps.send(sessionId, stored.update)) break;
		sent++;
	}
	if (sent < updates.length)
		deps.log(`session ${sessionId}: replay stopped after ${sent}/${updates.length} stored updates - the connection went away`);
	else
		deps.log(
			`session ${sessionId}: replayed ${updates.length} stored update(s)${truncated ? " (the oldest were over the read budget)" : ""}`,
		);
}

/** `session/list` params: the workspace to filter by, the cursor, and (our extension) the page size. */
function listParams(params: unknown): { cwd?: string; cursor?: string; limit?: number } {
	const p = (params ?? {}) as Record<string, unknown>;
	const limit =
		typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.min(Math.max(1, Math.trunc(p.limit)), MAX_PAGE_SIZE) : undefined;
	return {
		cwd: listedCwd(p.cwd),
		cursor: typeof p.cursor === "string" && p.cursor !== "" ? p.cursor : undefined,
		limit,
	};
}

/**
 * The workspace a listing is filtered by. A relative one is refused rather than answered with an empty
 * list: every recorded cwd is absolute, so a relative path would match nothing, and "you have no sessions
 * here" is a much worse answer than "that is not a path".
 */
function listedCwd(cwd: unknown): string | undefined {
	if (cwd === undefined || cwd === null || cwd === "") return undefined;
	if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
		throw new RpcError(INVALID_PARAMS, `session/list: cwd must be an absolute path, got ${JSON.stringify(cwd)}`, {
			reason: "invalid_cwd",
		});
	}
	return path.resolve(cwd);
}

/** One row of `session/list`: ACP's `SessionInfo` fields, the rest of the record in `_meta`. */
function sessionInfo(entry: ListedSession): AcpSessionInfo {
	return {
		sessionId: entry.sessionId,
		cwd: entry.cwd,
		title: entry.title === "" ? null : entry.title,
		updatedAt: new Date(entry.updatedAtMs).toISOString(),
		_meta: { turns: entry.turns, mode: entry.mode, model: entry.model, effort: entry.effort, inUse: entry.inUse },
	};
}

/**
 * `session/list`: this store only, newest first, one page at a time.
 *
 * An unusable record is skipped and counted, never fatal - one corrupt file must not hide every session
 * the operator still has - and the count travels to the client, because a listing that quietly shows four
 * sessions when there are five is the kind of lie that costs somebody a conversation.
 */
export async function listSessions(deps: RestoreDeps, params: unknown): Promise<AcpSessionListResult> {
	const result = await deps.store.list(listParams(params));
	if (!result.ok) {
		// A cursor the store cannot read is the client's error to fix; a store it cannot read is ours.
		throw new RpcError(result.kind === "cursor" ? INVALID_PARAMS : INTERNAL_ERROR, `session/list: ${result.reason}`, {
			reason: result.kind === "cursor" ? "bad_cursor" : "store_unavailable",
		});
	}
	const notes: Record<string, unknown> = {};
	if (result.unusable > 0) notes.unusableRecords = result.unusable;
	if (result.scanned >= result.scanLimit)
		notes.truncated = `the store holds more than ${result.scanLimit} session records; ${result.scanned} were read, so this list is not complete`;
	return {
		sessions: result.sessions.map(sessionInfo),
		nextCursor: result.nextCursor,
		...(Object.keys(notes).length > 0 ? { _meta: notes } : {}),
	};
}

/** The three methods, wired to one connection (the only scope a session belongs to). */
export interface SessionRestore {
	load(params: unknown): Promise<RestoredResult>;
	resume(params: unknown): Promise<RestoredResult>;
	list(params: unknown): Promise<AcpSessionListResult>;
}

export function createSessionRestore(deps: RestoreDeps): SessionRestore {
	return {
		load: (params: unknown) => restore(deps, "session/load", params, true),
		resume: (params: unknown) => restore(deps, "session/resume", params, false),
		list: (params: unknown) => listSessions(deps, params),
	};
}
