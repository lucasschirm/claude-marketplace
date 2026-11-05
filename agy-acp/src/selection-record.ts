// Two small contracts between the session, the selection and the session store (issue #56).
//
// They live in a file of their own because all three modules need them and none of them should have to
// import another session's machinery to name them: `session.ts` must not import the store (which would
// put a filesystem behind every unit test of a turn), and the store must not import the session.
//
// `SelectionRecord` is deliberately the *launch* triple - mode, model, effort, with `default` meaning
// "pass no flag" - and not what agy's `init` reported running. A record that said "gemini-3.8-flash-low"
// because agy volunteered it would do one of two worse things on a restart: launch a flag the operator
// never set, or conflict with a stored effort and refuse to load at all. What a stored session must come
// back doing is what it was told to do; what agy says it is doing arrives again with the first resumed
// turn, exactly as it did the first time.

import type { AcpSessionUpdate } from "./acp.ts";

/** The three client-visible selections, in the shape the store keeps and a load puts back. */
export interface SelectionRecord {
	mode: string;
	model: string;
	effort: string;
}

/**
 * The per-session recorder `AgySession` writes through.
 *
 * The store's journal implements it; a session with no recorder (a unit test, or a server whose store
 * could not be opened) records nothing and behaves the same way, which is the point of the port: the
 * session's turn logic may not care whether anything is being kept.
 *
 * None of it may throw. A recording failure is reported through `degraded` and the log; a transcript
 * that could not be written is a worse outcome for the *next* session, not for the turn in flight.
 */
export interface SessionRecorder {
	/**
	 * One `session/update` we sent. The recorder decides what is history: a heartbeat describes a turn
	 * that is running, and replaying one would tell a client an old turn is still in flight, so it is
	 * dropped here rather than by whoever noticed it first.
	 */
	record(update: AcpSessionUpdate): void;
	/** A prompt started: the first one gives the conversation its title. */
	notePrompt(promptText: string): void;
	/** The selection moved, so the record has to move with it. */
	setSelection(selection: SelectionRecord): void;
	/** The turn ended: fsync what was recorded, rotate if it outgrew its budget, replace the record. */
	endTurn(): Promise<void>;
	/** Stop recording for good (the session is going away). */
	close(): Promise<void>;
	/** The first write failure, or null while the transcript is complete. */
	readonly degraded: string | null;
}
