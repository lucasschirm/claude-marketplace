// Admission control for Devin sessions.
//
// A session only appears in the session table once `devin acp` has started and answered
// session/new, seconds after the decision to start it. Counting the table alone let every start
// decided inside that window through: parallel devin_delegate calls all saw 0 in flight, and the
// queue drain (which does not await each start) emptied the whole queue at once. Peak 8 sessions in
// flight against a limit of 2 (2026-10-22). A slot is therefore reserved before the first await and
// released only once the session is registered (or failed to start).

export class SessionSlots {
	private pending = 0;
	private readonly active: () => number;
	private readonly limit: () => number;

	/**
	 * @param active sessions registered and in flight (they hold their slot until their turn ends)
	 * @param limit  the current concurrency limit
	 */
	constructor(active: () => number, limit: () => number) {
		this.active = active;
		this.limit = limit;
	}

	/** Registered sessions plus starts that are still on their way. */
	inFlight(): number {
		return this.active() + this.pending;
	}

	/**
	 * Take a slot if one is free. The returned release is idempotent; call it once the session is
	 * registered (it then holds the slot itself) or its start failed.
	 */
	tryReserve(): (() => void) | null {
		if (this.inFlight() >= this.limit()) return null;
		this.pending++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.pending--;
		};
	}
}
