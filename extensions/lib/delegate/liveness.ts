// The stall verdict: when is a quiet session stalled, and when is it merely waiting?
//
// The watchdog measures ACP *silence*, not wall-clock time, and silence has several causes that look
// identical from the outside:
//
//  * the agent is thinking, or running a long command — quiet, and fine;
//  * the agent asked permission to run something and is blocked until the caller answers — quiet, and
//    *not* a problem: the permission timeout is what settles that case, on purpose, with a deny and a
//    reason the agent can act on. Marking it stalled too would put two clocks on one wait and report a
//    session as broken while it does exactly what it was designed to do;
//  * the agent is gone — which is not the watchdog's business either: `setOnExit` reports an interrupted
//    turn the moment the process is reaped;
//  * nothing has arrived for `stallMs` with no ask outstanding — the one case worth a message.
//
// A heartbeat is the fourth cause made visible: an adapter that emits one (see `drivers/agy.ts`) turns
// "waiting on a permission" into a frame, and any frame restarts the clock in `attach`. So the verdict
// below reads the same two facts an adapter's beat carries — outstanding asks, and time since activity —
// whether or not the agent is articulate about them.
//
// It is a function of facts rather than a block inside a `setInterval` because every clause of it is a
// decision a test can hold still: the runtime's timer runs once a minute, and a decision you cannot call
// is a decision you cannot prove.

import type { SessionStatus } from "./types.ts";

export interface StallFacts {
	/** Only a running turn can go stale; an idle or finished one has nothing to stall. */
	status: SessionStatus;
	/** Permission asks we are holding an answer for on this session's behalf. */
	pendingPermissions: number;
	/** When the last ACP frame arrived; 0 means nothing ever has. */
	lastActivityMs: number;
	/** How long silence counts as stalled. */
	stallMs: number;
	/** Injectable clock, so a test does not sleep. */
	nowMs?: number;
}

/** True when the session should be reported as stalled — a question for a human, never an auto-fail. */
export function isStalledNow(facts: StallFacts): boolean {
	if (facts.status !== "running") {
		return false;
	}
	// Waiting on the caller is not stalling. This clause is the whole difference between a session that
	// is blocked and one that is broken, and it is checked before the clock for that reason.
	if (facts.pendingPermissions > 0) {
		return false;
	}
	return (facts.nowMs ?? Date.now()) - (facts.lastActivityMs || 0) > facts.stallMs;
}
