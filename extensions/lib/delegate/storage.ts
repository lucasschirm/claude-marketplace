// Where a delegation's files live, and the one rule that makes a rename survivable.
//
// The root moved from `~/.pi/agent/devin_delegate/` to `~/.pi/agent/delegate_task/` with the tool
// family. A live `devin acp` session outlives a pi restart, so a session that was running when the
// upgrade landed must still be readable afterwards — hence the read-only legacy root, consulted when
// the new path has no such file. There is deliberately no migration: moving files under a running
// session is how a recovery story turns into a data loss story.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const STORAGE_ROOT = "delegate_task";
/** Read-only since the rename. Sessions that predate it keep their files here. */
export const LEGACY_STORAGE_ROOT = "devin_delegate";

/**
 * Whether an id may be used as one path segment under `~/.pi/agent/<root>/`.
 *
 * Session ids come off the wire: they are what the agent's server chose, and they name directories we
 * create, read and delete. An id of `../../evil` would put a `meta.json` — or a `rm -rf`'d worktree record —
 * outside the tree this extension owns, and a recovered state file is read with the same trust as a fresh
 * one. Rejected: separators, anything a shell or a path would expand, dot segments, and control characters
 * (which also make a status line lie about where it ends).
 */
export function isStorageSafeId(id: string): boolean {
	return (
		typeof id === "string" && id.length > 0 && id.length <= 200 && !/[\p{C}\\/]/u.test(id) && !id.includes("..") && !id.startsWith(".")
	);
}

export function getStorageDir(piSessionId: string, root: string = STORAGE_ROOT): string {
	return path.join(os.homedir(), ".pi", "agent", root, piSessionId);
}

export function getSessionDir(piSessionId: string, sessionId: string, root: string = STORAGE_ROOT): string {
	return path.join(getStorageDir(piSessionId, root), sessionId);
}

export function getEventsLogPath(piSessionId: string, sessionId: string, root: string = STORAGE_ROOT): string {
	return path.join(getSessionDir(piSessionId, sessionId, root), "events.jsonl");
}

export function getMetaPath(piSessionId: string, sessionId: string, root: string = STORAGE_ROOT): string {
	return path.join(getSessionDir(piSessionId, sessionId, root), "meta.json");
}

export function getStatePath(piSessionId: string, root: string = STORAGE_ROOT): string {
	return path.join(getStorageDir(piSessionId, root), "state.json");
}

/**
 * Every place a session's file could be: the current root, the root it was recorded under, and the
 * pre-rename root. Recovery and the transcript reader both need the same ordered guess, and "which
 * directory is this session in" is exactly the question that was answered wrong once before.
 */
export function sessionFileCandidates(
	piSessionId: string,
	sessionId: string,
	fileName: "meta.json" | "events.jsonl",
	recordedDir?: string,
): string[] {
	const out: string[] = [];
	const push = (root: string, pid = piSessionId) => {
		const p = path.join(getStorageDir(pid, root), sessionId, fileName);
		if (!out.includes(p)) {
			out.push(p);
		}
	};
	push(STORAGE_ROOT);
	if (recordedDir && recordedDir !== piSessionId) {
		push(STORAGE_ROOT, recordedDir);
	}
	push(LEGACY_STORAGE_ROOT);
	if (recordedDir && recordedDir !== piSessionId) {
		push(LEGACY_STORAGE_ROOT, recordedDir);
	}
	return out;
}

/**
 * The first path that is actually there, without paying for the ones that are not.
 *
 * Candidate lists exist because a file may live under either root, and reading them by trying to open
 * each one meant every pre-rename session cost the full ENOENT retry delay of `readTextFileWithRetry`
 * before falling through to its real location. Recovery loads dozens of sessions inside one 5 s budget,
 * and the misses, not the reads, are what blew it: 40 legacy sessions took 5.1 s and the budget killed
 * the pass halfway through. `access` costs one syscall and no sleep.
 */
export async function firstExisting(paths: readonly string[]): Promise<string | null> {
	for (const p of paths) {
		try {
			await fsp.access(p);
			return p;
		} catch {
			/* the next candidate */
		}
	}
	return null;
}

/**
 * Tolerate transient ENOENT (observed on shared volumes: directories flapping between visible and
 * ENOENT within seconds) by retrying once after a short delay. The delay is an ordinary timer: the
 * Atomics.wait version this replaces froze the event loop — and with it the TUI — for 150 ms per
 * retried file, right in the middle of session_start.
 *
 * Only ever call it on a path you have already decided should exist (`firstExisting`, or a file this
 * process just wrote). On a candidate list it turns a normal miss into a 150 ms pause.
 */
export async function readTextFileWithRetry(p: string): Promise<string> {
	try {
		return await fsp.readFile(p, "utf-8");
	} catch (err: any) {
		if (err?.code !== "ENOENT") {
			throw err;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
		return fsp.readFile(p, "utf-8");
	}
}
