// `session/list` over the store's directories (issue #56).
//
// Split out of store.ts because listing is the one thing the store does that reads *every* session
// rather than one, and that difference changes what can go wrong: a corrupt record is one session's
// problem when loading and every session's problem when listing, a store with thousands of sessions has
// a scan to bound, and a page has to survive a turn landing between two pages.
//
// The rules, in short: this store only, filtered by workspace, newest first, one page at a time, and
// never fatal over a record it cannot read.

import { listSessionDirs } from "./files.ts";
import { sameWorkspace } from "./paths.ts";
import { DEFAULT_SESSION_PAGE_SIZE, isSessionId, type StoredSessionMeta } from "./records.ts";

/**
 * How many session directories one `session/list` will look at.
 *
 * The bound is on the expensive part - one `meta.json` read per directory - and it is deliberately not
 * "the newest 2000": deciding which are newest means reading the record of every one of them, which is
 * the work the bound exists to limit. When a store is bigger than this the answer says so
 * (`_meta.truncated`, with `scanned`/`scanLimit` for the numbers) instead of pretending to be complete.
 */
export const MAX_LIST_SCAN = 2000;
/** The largest page a client may ask for. */
export const MAX_PAGE_SIZE = 200;

/** One session as `session/list` reports it. */
export interface ListedSession {
	sessionId: string;
	cwd: string;
	title: string;
	updatedAtMs: number;
	turns: number;
	mode: string;
	model: string;
	effort: string;
	/** A live agy-acp process holds this session, so loading it from elsewhere will be refused. */
	inUse: boolean;
}

export type ListResult =
	| {
			ok: true;
			sessions: ListedSession[];
			nextCursor: string | null;
			/** Records that exist but could not be read - counted, because a short list is a claim. */
			unusable: number;
			/** How many session directories were looked at, and the cap that stopped the scan. */
			scanned: number;
			scanLimit: number;
	  }
	| { ok: false; kind: ListFailure; reason: string };
/** A bad cursor is the caller's mistake; anything else is the store's. They are different errors. */
export type ListFailure = "cursor" | "io";

export interface ListingSource {
	/** `<state>/agy-acp/sessions`, the directory whose entries are session ids. */
	sessionsDir: string;
	/** The store's own reader, so a record is validated the same way here as it is when loaded. */
	readMeta: (sessionId: string) => Promise<null | { ok: true; value: StoredSessionMeta } | { ok: false; reason: string }>;
	/** Whether a live process holds it - reported, because "load me" is the next thing a client does. */
	lockIsLive: (sessionId: string) => Promise<boolean>;
	log: (line: string) => void;
}

export interface ListOptions {
	cwd?: string;
	cursor?: string;
	limit?: number;
}

function listed(meta: StoredSessionMeta): ListedSession {
	return { ...meta, inUse: false };
}

/** The entry's own sort key, base64url: opaque to the client, resolvable by us. */
function cursorOf(entry: ListedSession | undefined): string | null {
	if (entry === undefined) return null;
	return Buffer.from(`${entry.updatedAtMs}${CURSOR_SEPARATOR}${entry.sessionId}`, "utf8").toString("base64url");
}

/**
 * Where a cursor points in the sorted list (the entry after the one it names), or -1 for nothing.
 *
 * The cursor names an entry rather than holding an offset, which is what makes a page stable: a session
 * promoted by a new turn between two pages cannot make page two skip or repeat a conversation, because
 * page two starts after the conversation the client last saw, wherever it now sits.
 */
function indexOfCursor(sorted: ListedSession[], cursor: string): number {
	const decoded = Buffer.from(cursor, "base64url").toString("utf8");
	const at = decoded.indexOf(CURSOR_SEPARATOR);
	if (at <= 0) return -1;
	const updatedAtMs = Number(decoded.slice(0, at));
	const sessionId = decoded.slice(at + CURSOR_SEPARATOR.length);
	if (!Number.isFinite(updatedAtMs) || !isSessionId(sessionId)) return -1;
	const index = sorted.findIndex((s) => s.sessionId === sessionId);
	return index < 0 ? -1 : index + 1;
}

const CURSOR_SEPARATOR = ":";

/**
 * One page of the store, newest first.
 *
 * An unusable record is skipped and counted, never fatal: one corrupt file must not hide every session
 * the operator still has. The count travels with the answer, because a listing that quietly shows four
 * sessions when there are five is the kind of lie that costs somebody a conversation.
 */
export async function listStoredSessions(source: ListingSource, options: ListOptions): Promise<ListResult> {
	const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_SESSION_PAGE_SIZE), MAX_PAGE_SIZE);
	let names: string[];
	try {
		names = await listSessionDirs(source.sessionsDir, isSessionId);
	} catch (err) {
		return { ok: false, kind: "io", reason: `the session store could not be listed: ${(err as Error).message}` };
	}
	const scanned = Math.min(names.length, MAX_LIST_SCAN);
	if (names.length > MAX_LIST_SCAN) {
		source.log(`session store: ${names.length} session directories - reading ${MAX_LIST_SCAN} of them, answer is truncated`);
		names = names.slice(0, MAX_LIST_SCAN);
	}
	const found: ListedSession[] = [];
	let unusable = 0;
	for (const name of names) {
		const record = await source.readMeta(name);
		if (record === null) continue; // a directory with no record is not a session, and not damage either
		if (!record.ok) {
			unusable++;
			continue;
		}
		// The same test `session/load` applies, not a cheaper one: `session/list` is how a client finds the
		// id it is about to load, and a session it can list but not load is a bug it cannot work around.
		if (options.cwd !== undefined && !sameWorkspace(record.value.cwd, options.cwd)) continue;
		found.push(listed(record.value));
	}
	if (unusable > 0) source.log(`session store: ${unusable} session record(s) were unusable and are not listed`);
	found.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.sessionId.localeCompare(b.sessionId));
	const start = options.cursor === undefined ? 0 : indexOfCursor(found, options.cursor);
	if (start < 0) {
		return { ok: false, kind: "cursor", reason: `unknown cursor ${JSON.stringify(options.cursor)} - it is not a session this store lists` };
	}
	const page = found.slice(start, start + limit);
	for (const entry of page) entry.inUse = await source.lockIsLive(entry.sessionId);
	return {
		ok: true,
		sessions: page,
		nextCursor: start + page.length < found.length ? cursorOf(page[page.length - 1]) : null,
		unusable,
		scanned,
		scanLimit: MAX_LIST_SCAN,
	};
}
