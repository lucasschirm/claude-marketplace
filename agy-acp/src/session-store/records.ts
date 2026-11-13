// The records of agy-acp's own session store (issue #56): their shape, their limits, and the
// validation that turns bytes read back off disk into something the server may act on.
//
// Everything here is deliberately dumb: no filesystem, no session, no agy. Two properties matter.
//
// **The store is untrusted input.** It lives in `$XDG_STATE_HOME`, which the operator (or another
// process running as them, or an editor, or a backup restore) can edit. So nothing read here is
// trusted: a record that is not exactly the shape below is *not* repaired and *not* partially
// accepted, it is reported as unusable with a reason, and the caller decides what that means
// (`session/load` treats an unusable `meta.json` as "agy-acp does not know this conversation",
// which is the same answer as no file at all). This is also the only place `JSON.parse` appears in
// the store, which is why the quality gate's inbound-parse allowlist names this file.
//
// **A record must never be a way out of its directory.** `sessionId` is a path component, so the
// shape that may become one is checked before anything opens it (`isSessionId`), and `cwd` is
// checked to be an absolute path that is not a `..` walk. Neither is a security boundary by itself -
// the process's own permissions are - but a state file must not be able to point the server at a
// workspace it was never asked to open.

import type { AcpSessionUpdate } from "../acp.ts";

/** The layout version written into every `meta.json`. A mismatch is unusable, never migrated. */
export const STORE_RECORD_VERSION = 1;
/** A conversation id that may become a directory name. agy's are UUIDs; the shape is wider so a
 * future agy may change the alphabet, but never the one thing that matters: no separator, no `..`,
 * nothing that could escape `<state>/sessions/`. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The title is the first prompt, shortened. Long enough to recognise a session in a list, short
 * enough that a `session/list` page is not mostly one pasted file. */
export const MAX_TITLE_CHARS = 200;
/** One stored update line may not exceed this. A `tool_call_update` carries up to
 * `MAX_TOOL_TEXT_CHARS` of tool output, so a normal line is a few KiB; this is the ceiling for the
 * pathological one (a huge `rawInput`, a rewritten-args diff, a resource block). */
export const MAX_UPDATE_LINE_BYTES = 64 * 1024;
/** A `session/list` page, when the operator did not choose one. */
export const DEFAULT_SESSION_PAGE_SIZE = 50;
/** A lock whose holder cannot be checked, and which is older than this, is taken over. */
export const DEFAULT_STALE_LOCK_MS = 60 * 60 * 1000;

/** What `<state>/sessions/<id>/meta.json` holds (issue #56: cwd, mode, model, effort, the two
 * times, and the title the first prompt gave it). */
export interface StoredSessionMeta {
	version: number;
	sessionId: string;
	cwd: string;
	mode: string;
	model: string;
	effort: string;
	title: string;
	/** Prompts this conversation has run, across every agy-acp process that held it. */
	turns: number;
	createdAtMs: number;
	updatedAtMs: number;
}

/** One line of `updates.ndjson`: the update we sent, and when we sent it. */
export interface StoredUpdate {
	atMs: number;
	update: AcpSessionUpdate;
}

/** One line of `lock`: who holds this session, so a second process can say no with a name. */
export interface LockHolder {
	pid: number;
	host: string;
	startedAtMs: number;
}

export type Decoded<T> = { ok: true; value: T } | { ok: false; reason: string };

function bad(reason: string): Decoded<never> {
	return { ok: false, reason };
}

function isoMs(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** May this id be a directory name under `<state>/sessions/`? Path traversal is the whole test. */
export function isSessionId(value: unknown): value is string {
	return typeof value === "string" && SESSION_ID_RE.test(value) && !value.includes("..");
}

/** An absolute workspace path that is not a `..` walk (the value a `meta.json` may claim). */
export function isRecordedCwd(value: unknown): value is string {
	return typeof value === "string" && value.startsWith("/") && !value.split("/").includes("..");
}

export function encodeMeta(meta: StoredSessionMeta): string {
	return `${JSON.stringify(meta)}\n`;
}

/** A `meta.json` is only usable when every field is what it claims to be (see the file header). */
export function decodeMeta(text: string): Decoded<StoredSessionMeta> {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return bad(`not JSON (${(err as Error).message})`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return bad("not a JSON object");
	}
	const o = raw as Record<string, unknown>;
	if (o.version !== STORE_RECORD_VERSION) {
		return bad(`unsupported version ${JSON.stringify(o.version)}`);
	}
	if (!isSessionId(o.sessionId)) {
		return bad(`sessionId ${JSON.stringify(o.sessionId)} is not usable as a directory name`);
	}
	if (!isRecordedCwd(o.cwd)) {
		return bad(`cwd ${JSON.stringify(o.cwd)} is not an absolute path`);
	}
	for (const field of ["mode", "model", "effort"] as const) {
		if (typeof o[field] !== "string" || o[field] === "") {
			return bad(`${field} must be a non-empty string`);
		}
	}
	if (typeof o.title !== "string") {
		return bad("title must be a string");
	}
	const turns = isoMs(o.turns);
	if (turns === null || !Number.isInteger(turns)) {
		return bad("turns must be a non-negative integer");
	}
	const createdAtMs = isoMs(o.createdAtMs);
	const updatedAtMs = isoMs(o.updatedAtMs);
	if (createdAtMs === null) {
		return bad("createdAtMs must be a non-negative number");
	}
	if (updatedAtMs === null) {
		return bad("updatedAtMs must be a non-negative number");
	}
	return {
		ok: true,
		value: {
			version: STORE_RECORD_VERSION,
			sessionId: o.sessionId,
			cwd: o.cwd,
			mode: o.mode as string,
			model: o.model as string,
			effort: o.effort as string,
			title: o.title,
			turns,
			createdAtMs,
			updatedAtMs,
		},
	};
}

/** The title a prompt gives a session: its first line, whitespace collapsed. */
export function titleFromPrompt(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	if (line.length <= MAX_TITLE_CHARS) {
		return line;
	}
	let cut = line.slice(0, MAX_TITLE_CHARS - 1);
	const tail = cut.codePointAt(cut.length - 1);
	if (tail !== undefined && tail >= 0xd800 && tail <= 0xdfff) {
		cut = cut.slice(0, -1); // never split a pair
	}
	return `${cut}…`;
}

/**
 * Shrink an update so storing it cannot crowd out the rest of the conversation.
 *
 * The identity of an update (what it was, which tool, what state it reached) is always kept; only
 * the payloads go, and they go with a note saying so and how big the original was. A client
 * replaying history then sees the shape of what happened rather than a gap it cannot explain.
 */
function boundForStorage(update: AcpSessionUpdate): AcpSessionUpdate {
	const line = JSON.stringify(update);
	if (Buffer.byteLength(line, "utf8") <= MAX_UPDATE_LINE_BYTES) {
		return update;
	}
	const kept = { ...update } as Record<string, unknown>;
	delete kept.content; // the tool output and the tool's parameters are the payload; the shape is not
	delete kept.rawInput;
	const meta = kept._meta;
	const note = `agy-acp dropped this update's payload: ${Buffer.byteLength(line, "utf8")} bytes, over the ${MAX_UPDATE_LINE_BYTES}-byte store line limit`;
	kept._meta = {
		...(typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {}),
		storeTruncated: note,
	};
	// The shape is the update's own minus two fields, so the cast is a rest-spread the compiler cannot
	// follow rather than a claim about unknown JSON; the value came from an `AcpSessionUpdate`.
	return kept as unknown as AcpSessionUpdate;
}

export function encodeUpdateLine(atMs: number, update: AcpSessionUpdate): string {
	return `${JSON.stringify({ atMs, update: boundForStorage(update) } satisfies StoredUpdate)}\n`;
}

/** One `updates.ndjson` line. A torn last line (a crash mid-append) is unusable, and so is anything
 * whose `update` is not an object with a `sessionUpdate` - which is what the reader reports, per line. */
export function decodeUpdateLine(line: string): Decoded<StoredUpdate> {
	if (line.trim() === "") {
		return bad("empty line");
	}
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch (err) {
		return bad(`not JSON (${(err as Error).message})`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return bad("not a JSON object");
	}
	const o = raw as Record<string, unknown>;
	const update = o.update;
	if (typeof update !== "object" || update === null || Array.isArray(update)) {
		return bad("update is not a JSON object");
	}
	if (typeof (update as Record<string, unknown>).sessionUpdate !== "string") {
		return bad("update carries no sessionUpdate");
	}
	const atMs = isoMs(o.atMs) ?? 0;
	return { ok: true, value: { atMs, update: update as AcpSessionUpdate } };
}

export function encodeLock(holder: LockHolder): string {
	return `${JSON.stringify(holder)}\n`;
}

export function decodeLock(text: string): Decoded<LockHolder> {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return bad(`not JSON (${(err as Error).message})`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return bad("not a JSON object");
	}
	const o = raw as Record<string, unknown>;
	const pid = isoMs(o.pid);
	if (pid === null || !Number.isInteger(pid) || pid <= 0) {
		return bad("pid is not a process id");
	}
	if (typeof o.host !== "string") {
		return bad("host is not a string");
	}
	const startedAtMs = isoMs(o.startedAtMs);
	if (startedAtMs === null) {
		return bad("startedAtMs is not a number");
	}
	return { ok: true, value: { pid, host: o.host, startedAtMs } };
}
