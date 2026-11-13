// What a session owes its store (issue #56).
//
// `AgySession` is the only thing that knows when an update was sent, a prompt started, the selection
// moved or a turn ended; the store is the only thing that can write any of that down. This module is the
// seam between them, and it exists so the rules of the seam live in one place:
//
//   - **a session with no recorder behaves exactly as it did without a store.** Every method here is a
//     no-op until something is attached, which is why the turn logic can call it unconditionally.
//   - **nothing here throws.** A transcript that could not be written is a problem for the *next*
//     session, not for the turn in flight; the journal reports the failure to the log and to `degraded`
//     and keeps going, and a failure at teardown must not stop a session from giving its lock back.
//   - **attaching after a dispose releases at once.** A `session/new` whose teardown raced its store
//     write would otherwise leave a lock held by a session that no longer exists, and the conversation
//     would be unreachable until the stale-lock deadline.
//   - **the record says what the session will actually run.** `attach` pushes the current selection into
//     the store rather than trusting what the caller wrote when the record was made, because a restored
//     selection may have been corrected on the way in.

import type { AcpSessionUpdate } from "./acp.ts";
import type { SelectionRecord, SessionRecorder } from "./selection-record.ts";

export class SessionRecording {
	private readonly log: (line: string) => void;
	private recorder: SessionRecorder | null = null;
	private release: (() => Promise<void>) | null = null;
	private disposed = false;

	constructor(log: (line: string) => void) {
		this.log = log;
	}

	/** The first store write failure, or null while the transcript is complete. */
	get degraded(): string | null {
		return this.recorder?.degraded ?? null;
	}

	/**
	 * Start recording. `release` hands the session's store lock back; the journal is closed by
	 * `detach`, which is what makes "the lock is gone" and "the transcript is flushed" one moment.
	 */
	attach(recorder: SessionRecorder, release: () => Promise<void>, current: SelectionRecord): void {
		if (this.disposed) {
			void release();
			return;
		}
		this.recorder = recorder;
		this.release = release;
		recorder.setSelection(current);
	}

	/** One `session/update` we sent (the recorder decides what of it is history). */
	note(update: AcpSessionUpdate): void {
		this.recorder?.record(update);
	}

	/** A prompt started; the first one gives the conversation its title. */
	notePrompt(promptText: string): void {
		this.recorder?.notePrompt(promptText);
	}

	/** The selection moved, so the record has to move with it. */
	noteSelection(selection: SelectionRecord): void {
		this.recorder?.setSelection(selection);
	}

	/** The turn ended: the history is durable before the answer means "saved". */
	async endTurn(): Promise<void> {
		// Bounded inside the recorder, so a wedged disk cannot hang a prompt forever.
		await this.recorder?.endTurn();
	}

	/** Stop recording for good: flush what is pending, then hand the lock back. */
	async detach(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		const release = this.release;
		this.recorder = null;
		this.release = null;
		if (!release) {
			return;
		}
		try {
			await release();
		} catch (err) {
			this.log(`the session store could not be closed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
