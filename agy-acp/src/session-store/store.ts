// agy-acp's own session store (issue #56): the record of which conversations exist, in which
// workspace, with what selection, and what we sent while they ran.
//
// The store is *ours*. That is the point, and it is a constraint, not a shortcut: nothing here reads
// agy's SQLite, its OAuth tokens, its `~/.gemini` contents or a hook payload's `transcriptPath`. A
// conversation that exists in agy but not here is unknown to `agy-acp` - `session/load` answers
// `-32002` for it - because the alternative is a second source of truth whose format agy may change
// in any release and whose files we agreed not to open.
//
//	<state>/agy-acp/sessions/<conversation_id>/
//	  meta.json           the record (cwd, mode, model, effort, title, turns, the two times)
//	  updates.ndjson      every session/update we emitted, oldest first, rotated by size
//	  updates.ndjson.1    the generation behind it (see files.ts)
//	  lock                who holds this session, so a second agy-acp says no instead of mixing logs
//
// The two failures a client is promised are the two the issue fixes: an unknown id is a *resource not
// found*, and a workspace that does not match the record is *invalid params*. Everything else the
// store can fail at - a read-only state directory, a corrupt record, a session another process holds -
// is reported as its own reason, because "unknown session" would send an operator looking for their
// history in the wrong place.

import * as path from "node:path";
import { ensurePrivateDir, UPDATE_ROTATIONS } from "./files.ts";
import { HoldTable } from "./hold.ts";
import { readStoredMeta, readStoredUpdates, type StoredMetaRead } from "./reading.ts";
import { DEFAULT_STALE_LOCK_MS, isSessionId, type StoredSessionMeta, type StoredUpdate, STORE_RECORD_VERSION } from "./records.ts";
import { readLockHolder } from "./lock.ts";
import { SessionJournal, writeMetaFile } from "./journal.ts";
import { listStoredSessions, type ListOptions, type ListResult } from "./listing.ts";
import { sameWorkspace, sessionsDir, type StoreRoot } from "./paths.ts";

/** The replay read budget: 4 MiB of stored updates is more history than a client can put on screen. */
export const DEFAULT_REPLAY_BUDGET_BYTES = 4 * 1024 * 1024;
/** The live update log's budget before it rotates (see files.ts). */
export const DEFAULT_SESSION_LOG_BYTES = 2 * 1024 * 1024;
export interface SessionStoreOptions {
	log: (line: string) => void;
	root: StoreRoot;
	maxBytes?: number;
	rotations?: number;
	staleLockMs?: number;
	replayBudgetBytes?: number;
	now?: () => number;
	/** The host name a lock is written with (a test asserts another host's lock is never called dead). */
	hostname?: () => string;
}

/** Why a session could not be opened. The caller maps `kind` onto a JSON-RPC code. */
export type OpenFailure =
	| { kind: "unknown"; reason: string }
	| { kind: "cwd-mismatch"; reason: string; recorded: string }
	| { kind: "locked"; reason: string }
	| { kind: "open-in-process"; reason: string }
	| { kind: "io"; reason: string };

export interface OpenedSession {
	meta: StoredSessionMeta;
	journal: SessionJournal;
	/** The stored updates, oldest first (`session/load` only; `session/resume` asks for none). */
	replay: StoredUpdate[];
	/** Stored lines that could not be decoded - counted, never fatal. */
	droppedLines: number;
	/** The replay budget was reached, so older history was left behind. */
	truncated: boolean;
}

export interface NewSessionSeed {
	sessionId: string;
	cwd: string;
	mode: string;
	model: string;
	effort: string;
}

// The listing types are the listing module's; re-exported because a caller of `store.list()` should not
// have to know which file the store's half lives in.
export type { ListedSession, ListOptions, ListResult } from "./listing.ts";

function reasonOf(err: unknown): string {
	return (err as Error)?.message ?? String(err);
}

export class SessionStore {
	private readonly log: (line: string) => void;
	readonly root: string;
	readonly rootSource: string;
	private readonly sessions: string;
	private readonly maxBytes: number;
	private readonly rotations: number;
	private readonly holds: HoldTable;
	private readonly replayBudget: number;
	private readonly now: () => number;

	private ready: Promise<void> | null = null;

	constructor(options: SessionStoreOptions) {
		this.log = options.log;
		this.root = options.root.root;
		this.rootSource = options.root.source;
		this.sessions = sessionsDir(this.root);
		this.maxBytes = options.maxBytes ?? DEFAULT_SESSION_LOG_BYTES;
		this.rotations = options.rotations ?? UPDATE_ROTATIONS;
		this.replayBudget = options.replayBudgetBytes ?? DEFAULT_REPLAY_BUDGET_BYTES;
		this.now = options.now ?? (() => Date.now());
		this.holds = new HoldTable({
			log: this.log,
			staleMs: options.staleLockMs ?? DEFAULT_STALE_LOCK_MS,
			now: this.now,
			...(options.hostname ? { hostname: options.hostname } : {}),
		});
	}

	/** The answer for an id this store has no record of, in the client's words (naming where it looked). */
	unknownReason(sessionId: string): string {
		return unknownReason(sessionId, this.root, this.rootSource);
	}

	sessionDir(sessionId: string): string {
		return path.join(this.sessions, sessionId);
	}

	/** The state dirs, made once per process with the modes the issue fixes (0700 all the way). */
	private async ensureRoot(): Promise<{ ok: true } | { ok: false; reason: string }> {
		this.ready ??= (async () => {
			await ensurePrivateDir(this.root);
			await ensurePrivateDir(this.sessions);
		})();
		try {
			await this.ready;
			return { ok: true };
		} catch (err) {
			// Cleared so a later call may succeed: a mount that was not up yet is not a verdict.
			this.ready = null;
			return { ok: false, reason: `${reasonOf(err)} (store root ${this.root} from ${this.rootSource})` };
		}
	}

	/**
	 * session/new: open a fresh run of a conversation. The record is written before the caller learns
	 * the id, so "the client has this session" implies "this session can be loaded later".
	 */
	async create(seed: NewSessionSeed): Promise<{ ok: true; opened: OpenedSession } | { ok: false; reason: string }> {
		if (!isSessionId(seed.sessionId)) {
			return { ok: false, reason: `agy reported a conversation id that cannot be stored: ${JSON.stringify(seed.sessionId)}` };
		}
		const root = await this.ensureRoot();
		if (!root.ok) {
			return { ok: false, reason: root.reason };
		}
		const dir = this.sessionDir(seed.sessionId);
		try {
			await ensurePrivateDir(dir);
		} catch (err) {
			return { ok: false, reason: `the session directory could not be created (${reasonOf(err)})` };
		}
		const taken = await this.holds.acquire(dir);
		if (taken.held === null) {
			return { ok: false, reason: `${seed.sessionId}: ${taken.reason}` };
		}
		const held = taken.held;
		const at = this.now();
		const meta: StoredSessionMeta = {
			version: STORE_RECORD_VERSION,
			sessionId: seed.sessionId,
			cwd: seed.cwd,
			mode: seed.mode,
			model: seed.model,
			effort: seed.effort,
			title: "",
			turns: 0,
			// A second session/new over one id is a new run of the same conversation, so the age of the
			// record survives it; only the run changes.
			createdAtMs: held.journal?.meta.createdAtMs ?? at,
			updatedAtMs: at,
		};
		try {
			await writeMetaFile(dir, meta);
		} catch (err) {
			await this.release(dir);
			return { ok: false, reason: `the session record could not be written (${reasonOf(err)})` };
		}
		// A second `session/new` over one id (agy reporting a conversation it already reported) is a new run
		// of the same conversation: the old writer closes, the log it was appending to stays where it is,
		// and the history continues rather than being written by two handles at once.
		if (held.journal) {
			await held.journal.close().catch(() => {});
		}
		const journal = new SessionJournal({ dir, meta, log: this.log, maxBytes: this.maxBytes, rotations: this.rotations, now: this.now });
		held.journal = journal;
		held.refs += 1;
		return { ok: true, opened: { meta: journal.meta, journal, replay: [], droppedLines: 0, truncated: false } };
	}

	/**
	 * session/load and session/resume: one validation path (the record must exist, the workspace must
	 * match, the session must not belong to another process), and only `load` asks for the history.
	 */
	async open(
		sessionId: string,
		cwd: string,
		withReplay: boolean,
	): Promise<{ ok: true; opened: OpenedSession } | { ok: false; failure: OpenFailure }> {
		const existing = await this.readMeta(sessionId);
		if (existing === null) {
			return { ok: false, failure: { kind: "unknown", reason: unknownReason(sessionId, this.root, this.rootSource) } };
		}
		if (!existing.ok) {
			return {
				ok: false,
				failure: { kind: "unknown", reason: `the record of ${sessionId} is not one agy-acp can use (${existing.reason})` },
			};
		}
		const meta = existing.value;
		if (!sameWorkspace(meta.cwd, cwd)) {
			return {
				ok: false,
				failure: {
					kind: "cwd-mismatch",
					recorded: meta.cwd,
					reason: `session ${sessionId} belongs to ${meta.cwd}, not ${cwd} - agy-acp never moves a conversation to another workspace`,
				},
			};
		}
		const dir = this.sessionDir(sessionId);
		if (this.holds.has(dir)) {
			return { ok: false, failure: { kind: "open-in-process", reason: `session ${sessionId} is already open in this agy-acp process` } };
		}
		const root = await this.ensureRoot();
		if (!root.ok) {
			return { ok: false, failure: { kind: "io", reason: root.reason } };
		}
		const taken = await this.holds.acquire(dir);
		if (taken.held === null) {
			if (taken.contested) {
				// A second `session/load` for one conversation in this process - a client that races itself,
				// or two connections on the same row. It is the session open here twice, refused as such:
				// "another process" would name our own live pid and never age out.
				return { ok: false, failure: { kind: "open-in-process", reason: `session ${sessionId} is already open in this agy-acp process` } };
			}
			// Nobody holds it; the state directory refused us. "In use" would point at another process and a
			// lock worth waiting for.
			if (taken.unavailable) {
				return { ok: false, failure: { kind: "io", reason: taken.reason } };
			}
			const seen = await readLockHolder(dir);
			return { ok: false, failure: { kind: "locked", reason: `session ${sessionId} is held by another agy-acp process (${seen.reason})` } };
		}
		const held = taken.held;
		const journal = new SessionJournal({ dir, meta, log: this.log, maxBytes: this.maxBytes, rotations: this.rotations, now: this.now });
		held.journal = journal;
		held.refs += 1;
		if (!withReplay) {
			return { ok: true, opened: { meta, journal, replay: [], droppedLines: 0, truncated: false } };
		}
		const stored = await this.readUpdates(dir);
		return { ok: true, opened: { meta, journal, ...stored } };
	}

	/** The record for one id: `null` for no file, `{ok:false}` for a file that is not a record. */
	async readMeta(sessionId: string): Promise<StoredMetaRead> {
		return readStoredMeta(this.sessionDir(sessionId), sessionId, this.log);
	}
	/** Every stored update, oldest first, with unusable lines counted rather than fatal. */
	private async readUpdates(dir: string): Promise<{ replay: StoredUpdate[]; droppedLines: number; truncated: boolean }> {
		return readStoredUpdates(dir, this.rotations, this.replayBudget, this.log);
	}
	/**
	 * Give up one writer on a session; the last one closes it and removes the lock.
	 * Accepts a session id or the directory (the session only ever knows its id).
	 */
	async release(sessionIdOrDir: string): Promise<void> {
		await this.holds.release(sessionIdOrDir.includes(path.sep) ? sessionIdOrDir : this.sessionDir(sessionIdOrDir));
	}

	/**
	 * session/list, delegated to listing.ts: this store, filtered by workspace, newest first, one page.
	 * The store only supplies the reads; the ordering, the page and the cursor are that module's business.
	 */
	list(options: ListOptions): Promise<ListResult> {
		return listStoredSessions(
			{
				sessionsDir: this.sessions,
				readMeta: (id) => this.readMeta(id),
				lockIsLive: (id) => this.holds.isLive(this.sessionDir(id)),
				log: this.log,
			},
			options,
		);
	}

	/**
	 * Is a live process holding this session? A lock on another host is believed (a shared filesystem
	 * is the only way that happens, and its process table is not ours to read); an unreadable one is
	 * not, because a lock that names nobody protects nothing.
	 */
}

function unknownReason(sessionId: string, root: string, source: string): string {
	return `unknown sessionId: ${sessionId} - agy-acp knows only the conversations in its own store (${root}, from ${source}); it does not read agy's private storage`;
}
