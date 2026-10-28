// The heartbeat of a running turn (issue #54).
//
// agy goes silent while a `PreToolUse` hook blocks or a long command runs, and silence is
// ambiguous: a client with a stall watchdog (this repo's delegate) cannot tell "the agent is
// waiting" from "the agent is gone". So while a turn is in flight the session emits a periodic
// session/update that carries `_meta` and nothing else - a client that does not know the update
// ignores it, a client that does never has to parse content to prove liveness.
//
// The interval is a knob (`AGY_ACP_HEARTBEAT_MS`, 0 disables). The beat is cheap by construction:
// one small notification per interval, no stream read, no child interaction, and an unref'd timer
// so a heartbeat can never be the reason a process is still alive.

import type { AcpHeartbeatUpdate } from "./acp.ts";

/** What the beat reports about the turn beyond the clock. */
export interface HeartbeatState {
	/** How many of this turn's permission requests are still unanswered. */
	pendingPermissions: () => number;
}

export class TurnHeartbeat {
	private readonly emit: (update: AcpHeartbeatUpdate) => void;
	private readonly state: HeartbeatState;
	private timer: NodeJS.Timeout | null = null;
	private seq = 0;
	private startedAt = 0;

	constructor(emit: (update: AcpHeartbeatUpdate) => void, state: HeartbeatState) {
		this.emit = emit;
		this.state = state;
	}

	/** Arms the beat for one turn; `intervalMs` <= 0 disables it. Idempotent, so a retry is safe. */
	start(intervalMs: number): void {
		this.stop();
		this.seq = 0;
		this.startedAt = Date.now();
		if (intervalMs <= 0) return;
		const timer = setInterval(() => this.beat(), intervalMs);
		timer.unref();
		this.timer = timer;
	}

	/** Stops the beat. Called when the turn settles, and again on dispose. */
	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private beat(): void {
		this.seq += 1;
		const atMs = Date.now();
		const pendingPermissions = this.state.pendingPermissions();
		this.emit({
			sessionUpdate: "heartbeat",
			_meta: {
				heartbeat: {
					seq: this.seq,
					atMs,
					turnMs: atMs - this.startedAt,
					// The distinction a watchdog acts on: waiting on a human is not a stall.
					state: pendingPermissions > 0 ? "waiting_permission" : "running",
					pendingPermissions,
				},
			},
		});
	}
}
