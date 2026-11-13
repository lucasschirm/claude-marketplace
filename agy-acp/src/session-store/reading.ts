// Reading a stored session back.
//
// `records.ts` is the grammar and `files.ts` is the filesystem; this is the two of them together, and
// the rules here are the ones a client's error message depends on:
//
//   - **a record that is not there and a record that cannot be read are different answers.** A missing
//     `meta.json` is null - an unknown session, `-32002`. An unreadable one is a failure with a reason:
//     the operator has a file to look at, and "we have never heard of this conversation" would send
//     them looking in the wrong place. `SessionStore` collapses the two for the client (both are an
//     unknown session, because there is no session to open) and keeps the distinction in the log.
//   - **the file names the session it is in.** A record copied into another session's directory is that
//     other session's history under a false name, so the id inside has to match the directory.
//   - **a torn line costs one update, not the transcript.** Lines that do not decode are counted and
//     skipped; the count travels to the client as `_meta.restored.droppedUpdates` so the replay never
//     claims to be complete when it is not.

import * as path from "node:path";
import { META_FILE, readFileOrNull, readUpdateLines } from "./files.ts";
import { decodeMeta, decodeUpdateLine, isSessionId, type StoredSessionMeta, type StoredUpdate } from "./records.ts";

/** What `meta.json` said: nothing (no session), a usable record, or a reason it is not usable. */
export type StoredMetaRead = null | { ok: true; value: StoredSessionMeta } | { ok: false; reason: string };

const reasonOf = (err: unknown): string => (err as Error)?.message ?? String(err);

/**
 * The record of one session, or null when there is no such session. An id that cannot be a directory
 * name is null as well: there is nowhere it could be stored, and answering with a path error would
 * imply the store had looked somewhere.
 */
export async function readStoredMeta(dir: string, sessionId: string, log: (line: string) => void): Promise<StoredMetaRead> {
	if (!isSessionId(sessionId)) {
		return null;
	}
	let text: string | null;
	try {
		text = await readFileOrNull(path.join(dir, META_FILE));
	} catch (err) {
		log(`session store: reading the record of ${sessionId} failed: ${reasonOf(err)}`);
		return { ok: false, reason: reasonOf(err) };
	}
	if (text === null) {
		return null;
	}
	const decoded = decodeMeta(text);
	if (!decoded.ok) {
		log(`session ${sessionId}: its meta.json is unusable (${decoded.reason})`);
		return { ok: false, reason: decoded.reason };
	}
	// The file names the session it is in: a record copied into another directory is not that session.
	if (decoded.value.sessionId !== sessionId) {
		return { ok: false, reason: `its record names ${decoded.value.sessionId}` };
	}
	return decoded;
}

/**
 * The recorded transcript, oldest first, inside the caller's byte budget. A log that cannot be read at
 * all is "no history" with a log line - a session whose transcript is unreadable is still a session the
 * client can continue, which beats refusing it.
 */
export async function readStoredUpdates(
	dir: string,
	rotations: number,
	capBytes: number,
	log: (line: string) => void,
): Promise<{ replay: StoredUpdate[]; droppedLines: number; truncated: boolean }> {
	let read: { lines: string[]; truncated: boolean };
	try {
		read = await readUpdateLines(dir, rotations, capBytes);
	} catch (err) {
		log(`session store: the update log of ${dir} could not be read (${reasonOf(err)}) - loading without history`);
		return { replay: [], droppedLines: 0, truncated: false };
	}
	const replay: StoredUpdate[] = [];
	let dropped = 0;
	for (const line of read.lines) {
		if (line.trim() === "") {
			continue;
		}
		const decoded = decodeUpdateLine(line);
		if (decoded.ok) {
			replay.push(decoded.value);
		} else {
			dropped++;
		}
	}
	if (dropped > 0) {
		log(`session store: ${dropped} stored update(s) were unreadable and are not replayed (${dir})`);
	}
	return { replay, droppedLines: dropped, truncated: read.truncated };
}
