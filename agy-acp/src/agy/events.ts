// The driver-level event vocabulary: what AgyProcess emits, as opposed to the raw stream-json
// contract in contract.ts.
//
// The one deliberate difference from the wire: a `result` as the driver emits it carries
// per-turn deltas (usage / num_turns / duration_seconds are cumulative per process in the wire
// format, and per resumed conversation), with the raw cumulative state preserved under
// `cumulative` for the next process of a `--conversation` resume.

import type { AgyCumulative, AgyInitEvent, AgyResultEvent, AgyStepUpdateEvent, AgyUsage } from "./contract.ts";

export interface AgyExitInfo {
	code: number | null;
	signal: NodeJS.Signals | null;
	/** The tail of agy's stderr (bounded), for diagnostics. */
	stderrTail: string;
}

/** A `result` as the driver emits it: `usage`, `num_turns` and `duration_seconds` are per-turn
 * deltas; the raw cumulative counters ride along under `cumulative` for a respawn. */
export interface AgyResultEventDelta {
	event: "result";
	result: Omit<AgyResultEvent["result"], "usage" | "num_turns" | "duration_seconds"> & {
		usage: AgyUsage;
		num_turns: number;
		duration_seconds: number;
		cumulative: AgyCumulative;
	};
}

export type AgyDriverEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEventDelta;
