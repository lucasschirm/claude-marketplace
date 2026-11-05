// Per-session locks (issue #56): `<state>/agy-acp/sessions/<conversation_id>/lock`.
//
// Two `agy-acp` processes pointed at the same conversation is not a theoretical problem. Both would
// append to one `updates.ndjson`, and the history of a session is only replayable if exactly one process
// decided each of its lines - and both would launch `agy --conversation <same id>`, which is a fork of
// one conversation into two divergent histories that agy itself will not detect or repair. So a session
// is opened under a lock, and a second process is refused.
//
// The lock is a file created with `O_EXCL`, which is atomic on a local filesystem and needs no server,
// no pid namespace and no cooperation from whoever held it last. Its body records the holder (pid, host,
// start time) so the refusal can name them instead of saying "busy".
//
// What a stale lock is worth is the whole design question, and the answer here is deliberately narrow:
//
//   - the holder is on this host and its pid no longer exists -> take over (a crash, or a kill -9);
//   - the holder is on this host and still alive -> refuse, however old the lock is (a long-lived
//     agy-acp is the normal case, not a leak, so age alone proves nothing);
//   - the holder is on another host, or the body cannot be read -> take over only past the staleness
//     deadline. A shared filesystem is the only way a foreign host shows up, and this process cannot
//     read that host's process table, so the only evidence left is time.
//
// A takeover is therefore always a judgement about something this process cannot verify, which is why it
// removes the file and re-creates it (one `O_EXCL` race decides the winner) instead of writing the body
// in place, and why the deadline is an hour: long enough that no healthy turn is still holding, short
// enough that a machine that comes back from the dead in the night is not locked out of its own state.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { decodeLock, encodeLock, type LockHolder } from "./records.ts";

export const LOCK_FILE = "lock";

export interface LockOptions {
	/** How old a lock whose holder cannot be checked has to be before it is taken over. */
	staleMs: number;
	now?: () => number;
	/** Process liveness, injectable so the dead-holder rule is testable without killing anything. */
	alive?: (pid: number) => boolean;
}

/** `unavailable` means "the store would not let us have the lock" (create, write or remove failed) rather
 * than "someone else holds it": a client told `session_in_use` for a disk problem waits for a process
 * that will never let go. */
export type LockOutcome =
	| { acquired: true; holder: LockHolder; reason: string }
	| { acquired: false; holder: LockHolder | null; reason: string; unavailable?: boolean };

/** Is a process id alive? EPERM means alive and not ours to signal; ESRCH means gone. */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function lockPath(dir: string): string {
	return path.join(dir, LOCK_FILE);
}

/** Who the lock file says holds the session, and the sentence to say so with. */
export async function readLockHolder(dir: string): Promise<{ holder: LockHolder | null; reason: string }> {
	let text: string;
	try {
		text = await fs.promises.readFile(lockPath(dir), "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// No lock file at all: whatever refused the create is gone again (or this reader lost the race).
		if (code === "ENOENT" || code === "ENOTDIR") return { holder: null, reason: "the lock file is gone" };
		return { holder: null, reason: `the lock file could not be read: ${(err as Error).message}` };
	}
	const decoded = decodeLock(text);
	if (!decoded.ok) return { holder: null, reason: `the lock file is not readable (${decoded.reason})` };
	const holder = decoded.value;
	return { holder, reason: `held by pid ${holder.pid} on host ${holder.host} since ${new Date(holder.startedAtMs).toISOString()}` };
}

/**
 * What to do about a lock that is already there: refuse it, or take it over.
 *
 * Split out of `acquireLock` because this is the whole policy and the rest is file plumbing. Every
 * refusal carries the holder, so the answer to the client names the process that has the session.
 */
async function judgeExistingLock(
	holder: LockHolder,
	options: LockOptions,
	ctx: { now: number; alive: (pid: number) => boolean; host: string; attempt: number },
): Promise<{ action: "refuse"; reason: string } | { action: "takeover" }> {
	const dead = holder.host === ctx.host && !ctx.alive(holder.pid);
	// Age alone is not a reason on this host: a long-lived agy-acp holding a session for a day is the
	// normal case. It is the only reason available for a foreign host, whose pid we cannot check.
	const stale = holder.host !== ctx.host && ctx.now - holder.startedAtMs > options.staleMs;
	if (!dead && !stale) {
		return {
			action: "refuse",
			reason: `another agy-acp process holds this session (${ctx.host === holder.host ? `pid ${holder.pid}` : `host ${holder.host}`})`,
		};
	}
	if (ctx.attempt > 0) {
		// Someone else took the same decision a moment ago and re-created the lock; refusing is the
		// honest answer, and the new holder will be reported by the caller's next read.
		return { action: "refuse", reason: "the stale lock was claimed by someone else first" };
	}
	return { action: "takeover" };
}

/** The verdict for a lock file this process cannot read (corrupt body, or vanished between the `EEXIST`
 * and this read). As good as no holder - a lock that names nobody protects nothing - but only once. */
function judgeUnreadableLock(attempt: number, reason: string): { action: "refuse"; reason: string } | { action: "takeover" } {
	if (attempt > 0) return { action: "refuse", reason: `the lock could not be read twice (${reason})` };
	return { action: "takeover" };
}

/**
 * Write the body of a lock this process just created, and report the holder it names.
 *
 * The body comes after the create, so a reader that finds the file mid-creation sees an unreadable lock
 * and treats it the way `judgeUnreadableLock` says - as something to take over once - rather than as a
 * holder. A failure to write it removes the file: a lock nobody is named in is worse than no lock,
 * because it makes every later process refuse.
 */
async function writeLockBody(dir: string, now: number): Promise<LockOutcome> {
	const holder: LockHolder = { pid: process.pid, host: os.hostname(), startedAtMs: now };
	const file = lockPath(dir);
	try {
		const handle = await fs.promises.open(file, "w", 0o600);
		try {
			await handle.write(encodeLock(holder));
			await handle.sync();
		} finally {
			await handle.close().catch(() => {});
		}
		return { acquired: true, holder, reason: "locked for this agy-acp process" };
	} catch (err) {
		// Best effort: this catch already holds the failure worth reporting, and throwing here would hide it.
		await fs.promises.rm(file, { force: true }).catch(() => {});
		return { acquired: false, holder: null, unavailable: true, reason: `the lock body could not be written: ${(err as Error).message}` };
	}
}

/**
 * Take the lock for one session directory. Never waits: a client that asks for a session another process
 * holds should hear about it now, with the pid and host that hold it, rather than watch a dialog wait.
 *
 * Two attempts, because the first may find a lock worth taking over. The remove and the `O_EXCL` create
 * happen in the same directory, so of two processes that both decide to steal a stale lock, exactly one
 * will find a create that succeeds - and the loser falls back through this loop and refuses.
 */
export async function acquireLock(dir: string, options: LockOptions): Promise<LockOutcome> {
	const now = options.now?.() ?? Date.now();
	const alive = options.alive ?? pidAlive;
	const file = lockPath(dir);
	for (let attempt = 0; attempt < 2; attempt++) {
		const ctx = { now, alive, host: os.hostname(), attempt };
		let handle: fs.promises.FileHandle | null = null;
		try {
			// `O_EXCL` is the mutual exclusion; nothing else here is atomic.
			handle = await fs.promises.open(file, "wx", 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
				return {
					acquired: false,
					holder: null,
					unavailable: true,
					reason: `the lock file could not be created: ${(err as Error).message}`,
				};
			}
			const seen = await readLockHolder(dir);
			const verdict = seen.holder === null ? judgeUnreadableLock(attempt, seen.reason) : await judgeExistingLock(seen.holder, options, ctx);
			if (verdict.action === "refuse") {
				return { acquired: false, holder: seen.holder, reason: verdict.reason };
			}
			// `force` only ignores ENOENT. A lock that cannot be removed - a directory where the lock should
			// be, EPERM on a read-only mount - is a refusal carrying the reason, not an exception that walks
			// past the caller's failure model (and, from `session/new`, past the disposal of its child).
			try {
				await fs.promises.rm(file, { force: true });
			} catch (err) {
				return {
					acquired: false,
					holder: seen.holder,
					unavailable: true,
					reason: `a lock that looks stale could not be removed: ${(err as Error).message}`,
				};
			}
			continue;
		}
		// Won the create. The handle is closed before the body is written: the body is a separate file
		// operation on a file we now own, and holding the descriptor across it buys nothing.
		await handle.close().catch(() => {});
		return await writeLockBody(dir, now);
	}
	return { acquired: false, holder: null, reason: "the lock was taken and lost twice" };
}

/** Give the lock back. Best effort: a lock we cannot remove ages out on the rules above. */
export async function releaseLock(dir: string): Promise<string | null> {
	try {
		await fs.promises.rm(lockPath(dir), { force: true });
		return null;
	} catch (err) {
		return `the lock file could not be removed: ${(err as Error).message}`;
	}
}
