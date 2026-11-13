// Who holds a conversation.
//
// Two facts have to be kept straight at once, and keeping them in one small place is the whole point:
//
//   - **across processes**, a conversation belongs to whoever holds the `lock` file. That is
//     `lock.ts`'s `O_EXCL` file with the holder's pid and host in it; it survives this process dying,
//     which is exactly when it has to be readable.
//   - **inside this process**, several things may legitimately hold the same conversation - a loaded
//     session and the listing that reports it as in use, or a session that is being disposed while
//     another call still names it. They are one holder to the outside world, so the lock is taken
//     once and refcounted here.
//
// A holder owns a `SessionJournal` (the writer) and is closed by the last release, which is what makes
// "the lock is gone" and "the transcript is flushed" the same moment.

import * as os from "node:os";
import { acquireLock, pidAlive, releaseLock, readLockHolder } from "./lock.ts";
import { sweepTempFiles } from "./files.ts";
import type { SessionJournal } from "./journal.ts";

export interface Held {
	/** The writer for this conversation, once the caller has built one. */
	journal: SessionJournal | null;
	/** How many places in this process are holding it. */
	refs: number;
}

/** The answer to `HoldTable.acquire`: the holder, or why this process does not have it. */
export type HoldOutcome =
	| { held: Held; contested: false; unavailable?: boolean; reason: string }
	| { held: null; contested: boolean; unavailable?: boolean; reason: string };

export interface HoldTableOptions {
	log: (line: string) => void;
	/** How old a lock on another host has to be before it is treated as abandoned. */
	staleMs: number;
	now?: () => number;
	hostname?: () => string;
}

export class HoldTable {
	private readonly log: (line: string) => void;
	private readonly staleMs: number;
	private readonly now: () => number;
	private readonly hostname: () => string;
	private readonly entries = new Map<string, Held>();
	/** Directories a call in this process is taking right now, before the entry exists. */
	private readonly pending = new Set<string>();

	constructor(options: HoldTableOptions) {
		this.log = options.log;
		this.staleMs = options.staleMs;
		this.now = options.now ?? (() => Date.now());
		this.hostname = options.hostname ?? (() => os.hostname());
	}

	has(dir: string): boolean {
		return this.entries.has(dir);
	}

	/**
	 * Take a conversation for this process, or share the one it already holds. `held: null` means another
	 * process holds it, and the caller refuses rather than waits (a client that wants a conversation
	 * another agy-acp is writing to needs to be told, not queued).
	 *
	 * `contested` is the third case: a call in this same process is taking it right now. That is the
	 * session being open here twice, and it is the caller's mapping to make - as "another process" it
	 * would name this process's own live pid and never age out.
	 */
	async acquire(dir: string): Promise<HoldOutcome> {
		const existing = this.entries.get(dir);
		if (existing !== undefined) {
			return { held: existing, contested: false, reason: "already held by this agy-acp process" };
		}
		if (this.pending.has(dir)) {
			return { held: null, contested: true, reason: "another call in this process is taking it" };
		}
		this.pending.add(dir);
		try {
			const outcome = await acquireLock(dir, { staleMs: this.staleMs, now: this.now });
			if (!outcome.acquired) {
				this.log(`session store: ${outcome.reason}`);
				// `unavailable` is reported only when the lock call knows it; the union keeps it absent
				// otherwise, which is what `exactOptionalPropertyTypes` asks of a pass-through.
				return {
					held: null,
					contested: false,
					...(outcome.unavailable === undefined ? {} : { unavailable: outcome.unavailable }),
					reason: outcome.reason,
				};
			}
			// A temp file left by a crash is nobody's state; the atomic writer would overwrite it anyway.
			await sweepTempFiles(dir);
			const held: Held = { journal: null, refs: 0 };
			this.entries.set(dir, held);
			return { held, contested: false, reason: "locked for this agy-acp process" };
		} finally {
			// The entry, not the claim, is what outlives this call; a failure leaves nothing behind.
			this.pending.delete(dir);
		}
	}

	/**
	 * Give up one writer; the last one closes the transcript and removes the lock, in that order -
	 * a lock that is gone must never precede a transcript that is still buffered.
	 */
	async release(dir: string): Promise<void> {
		const held = this.entries.get(dir);
		if (held === undefined) {
			return;
		}
		held.refs -= 1;
		if (held.refs > 0) {
			return;
		}
		this.entries.delete(dir);
		try {
			await held.journal?.close();
		} catch (err) {
			this.log(`session store: closing the writer of ${dir} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		const failed = await releaseLock(dir);
		if (failed) {
			this.log(`session store: ${failed} (${dir})`);
		}
	}

	/**
	 * Is a live process holding this conversation? A lock on another host is believed (a shared
	 * filesystem is the only way that happens, and its process table is not ours to read); an
	 * unreadable one is not, because a lock that names nobody protects nothing.
	 */
	async isLive(dir: string): Promise<boolean> {
		const seen = await readLockHolder(dir);
		if (seen.holder === null) {
			return false;
		}
		if (seen.holder.host !== this.hostname()) {
			return true;
		}
		return pidAlive(seen.holder.pid);
	}
}
