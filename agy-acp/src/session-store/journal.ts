// One session's writer: the update log and the `meta.json` that describes it (issue #56).
//
// `AgySession` owns one of these and calls it at four moments - an update went out, a prompt started,
// the selection changed, the turn ended - and none of those calls may fail the session. Recording is
// bookkeeping: the client has already been served. So every failure here is *logged and remembered*
// (`degraded`), never thrown, and the first failure says what happened while the rest stay quiet -
// a store on a full disk would otherwise produce one log line per token.
//
// Ordering is the property that makes a replay useful, and it has two parts:
//
//   - **the updates land in the order they were sent.** One promise chain, appended to by every
//     write, is what serialises them. `fs.appendFile` per update would not do it: two of those in
//     flight have no promised order, and a transcript whose tool result precedes its tool call is
//     worse than no transcript.
//   - **everything a turn sent is durable before that turn's answer means "saved".** `endTurn()`
//     drains the chain, fsyncs, rotates if the file outgrew its budget, and only then replaces
//     `meta.json` (atomically). The session awaits it, so `session/prompt` returning is the point at
//     which the history survives a restart of agy-acp.
//
// A machine crash can still cost the tail of the turn in flight - the fsync is at turn end, not per
// line, which is the trade the issue asks for. A crash *between* turns costs nothing.

import { META_FILE, UPDATE_ROTATIONS, UpdateLog, writePrivateFileAtomic } from "./files.ts";
import { encodeMeta, encodeUpdateLine, titleFromPrompt, type StoredSessionMeta } from "./records.ts";
import type { AcpSessionUpdate } from "../acp.ts";
import type { SelectionRecord, SessionRecorder } from "../selection-record.ts";

/** How long `endTurn()` may take before the prompt is answered anyway (a wedged disk is not a hang). */
export const DEFAULT_FLUSH_DEADLINE_MS = 15_000;

export interface JournalOptions {
	dir: string;
	/** The record this journal writes. The journal owns the copy it holds; the session changes it only
	 * through the methods below, which is what keeps `updatedAtMs` honest. */
	meta: StoredSessionMeta;
	log: (line: string) => void;
	maxBytes: number;
	/** Rotated generations to keep (the store's budget; the default is the same one). */
	rotations?: number;
	now?: () => number;
	/** The turn-end fsync budget. */
	flushDeadlineMs?: number;
}

export class SessionJournal implements SessionRecorder {
	readonly dir: string;
	private readonly metaValue: StoredSessionMeta;
	private readonly log: (line: string) => void;
	private readonly updates: UpdateLog;
	private readonly flushDeadlineMs: number;
	private readonly now: () => number;
	private queue: Promise<void> = Promise.resolve();
	private failure: string | null = null;
	/** Writes skipped since `failure` was set - the log says so once, then every hundredth. */
	private lost = 0;
	private closed = false;

	constructor(options: JournalOptions) {
		this.dir = options.dir;
		this.metaValue = { ...options.meta };
		this.log = options.log;
		this.now = options.now ?? (() => Date.now());
		this.flushDeadlineMs = options.flushDeadlineMs ?? DEFAULT_FLUSH_DEADLINE_MS;
		this.updates = new UpdateLog({ dir: options.dir, maxBytes: options.maxBytes, rotations: options.rotations ?? UPDATE_ROTATIONS });
	}

	/** The record as it stands (what a `session/load` answer or a `session/list` entry reports). */
	get meta(): StoredSessionMeta {
		return { ...this.metaValue };
	}

	/** The first store failure, or null. Reported in `_meta` so a client is not told a lie. */
	get degraded(): string | null {
		return this.failure;
	}

	/**
	 * Record one update we sent. Heartbeats are not history: they describe a turn that is running
	 * somewhere, and replaying one would tell a client to watch a live turn that ended.
	 */
	record(update: AcpSessionUpdate): void {
		if (this.closed || update.sessionUpdate === "heartbeat" || this.failure !== null) return;
		const at = this.now();
		this.enqueue("append an update", () => this.updates.append(encodeUpdateLine(at, update)));
	}

	/** The title a conversation gets: the first prompt only - later ones do not rename the session. */
	notePrompt(promptText: string): void {
		if (this.closed || this.metaValue.title !== "") return;
		const title = titleFromPrompt(promptText);
		if (title === "") return;
		this.metaValue.title = title;
		this.writeMeta("the title");
	}

	/** The selection a `session/load` must restore, kept current so the store never lags the session. */
	setSelection(selection: SelectionRecord): void {
		if (this.closed) return;
		if (this.metaValue.mode === selection.mode && this.metaValue.model === selection.model && this.metaValue.effort === selection.effort)
			return;
		this.metaValue.mode = selection.mode;
		this.metaValue.model = selection.model;
		this.metaValue.effort = selection.effort;
		this.writeMeta("the selection");
	}

	/**
	 * The turn is over: drain, fsync, rotate if needed, and replace `meta.json`.
	 *
	 * Bounded on purpose. A client whose turn is finished should hear that it is finished even when
	 * the disk cannot promise anything else; the failure lands in the log and in `degraded`.
	 */
	endTurn(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.metaValue.turns += 1;
		this.metaValue.updatedAtMs = this.now();
		this.enqueue("write the turn", async () => {
			await this.updates.sync();
			if (await this.updates.rotateIfNeeded()) this.log(`session ${this.metaValue.sessionId}: the update log passed its budget - rotated`);
			await writeMetaFile(this.dir, this.metaValue);
		});
		return this.bounded("flush the turn");
	}

	/**
	 * Report the first write failure (null when there is none), having just tried one. A `session/load`
	 * answers before its session has written anything, and without this the answer is a promise the store
	 * may not keep: on a read-only or full directory the client would hear "your history is back" while
	 * every write of the session ahead of it failed.
	 *
	 * It writes rather than only drains, because here the queue is usually empty - restoring the selection
	 * the record already carries changes nothing - and an empty queue drained proves nothing. The probe is
	 * the replacement of the record that is already there, which is what a turn boundary does: it proves
	 * the path (temp write, fsync, rename, directory) rather than a permission bit the next write contradicts.
	 */
	async ready(): Promise<string | null> {
		await this.queue;
		if (this.degraded !== null || this.closed) return this.degraded;
		try {
			await writeMetaFile(this.dir, this.metaValue);
		} catch (err) {
			this.report("prove it is writable", err as Error);
		}
		return this.degraded;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.bounded("flush before close");
		await this.updates.close().catch((err: Error) => {
			this.report("close the update log", err);
		});
	}

	private writeMeta(what: string): void {
		this.enqueue(`write ${what}`, () => writeMetaFile(this.dir, this.metaValue));
	}

	/** One serial writer: whatever is appended here happens after everything already queued. */
	private enqueue(what: string, op: () => Promise<void>): void {
		this.queue = this.queue.then(async () => {
			if (this.failure !== null) return; // already degraded: stop producing work we know will fail
			try {
				await op();
			} catch (err) {
				this.report(what, err as Error);
			}
		});
	}

	/** Await the queue, but never for longer than the flush budget. */
	private async bounded(what: string): Promise<void> {
		const pending = this.queue;
		const deadline = new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.log(
					`session ${this.metaValue.sessionId}: ${what} did not finish within ${this.flushDeadlineMs} ms - answering the client anyway`,
				);
				resolve();
			}, this.flushDeadlineMs);
			timer.unref();
		});
		await Promise.race([pending.then(() => undefined), deadline]);
	}

	private report(what: string, err: Error): void {
		if (this.failure === null) {
			this.failure = `${what}: ${err.message}`;
			this.log(`session ${this.metaValue.sessionId}: the session store could not ${this.failure}`);
			return;
		}
		// The first reason is the one that explains the rest; the count says how much was lost.
		this.lost++;
		if (this.lost === 1 || this.lost % 100 === 0) {
			this.log(`session ${this.metaValue.sessionId}: ${this.lost} further store write(s) skipped since: ${this.failure}`);
		}
	}
}

/** The atomic `meta.json` replacement, shared by the journal and by the store's first write. */
export async function writeMetaFile(dir: string, meta: StoredSessionMeta): Promise<void> {
	await writePrivateFileAtomic(dir, META_FILE, encodeMeta(meta));
}
