// Admission control for delegated sessions, per agent and in total.
//
// Two facts make this class necessary rather than a counter:
//
// 1. A session only appears in the session table once the agent's ACP server has started and answered
//    `session/new`, seconds after the decision to start it. Counting the table alone let every start
//    decided inside that window through: parallel delegate calls all saw 0 in flight, and the queue
//    drain (which does not await each start) emptied the whole queue at once. Peak 8 sessions against
//    a limit of 2 (2026-10-22). A slot is therefore reserved before the first await and released only
//    once the session is registered (or failed to start).
// 2. With several agents there is no single limit that is right. Two Devin runs plus one Claude run are
//    not "three of the same thing", and one chatty agent must not be able to starve the other. So:
//    `maxRuns` per agent, `maxRunsTotal` overall. A reservation must satisfy both or it takes neither.

export class AgentSlots {
	/** Reservations made but not yet backed by a registered session, by agent. */
	private pending = new Map<string, number>();

	/** Sessions registered and in flight (they hold their slot until their turn ends). */
	private readonly active: () => Array<{ agent: string }>;
	/** Per-agent ceiling. */
	private readonly agentLimit: () => number;
	/** Overall ceiling across every agent. */
	private readonly totalLimit: () => number;

	// Plain field assignment rather than TypeScript parameter properties: node runs this tree with
	// `--experimental-strip-types`, which erases annotations and cannot implement them.
	constructor(active: () => Array<{ agent: string }>, agentLimit: () => number, totalLimit: () => number) {
		this.active = active;
		this.agentLimit = agentLimit;
		this.totalLimit = totalLimit;
	}

	inFlight(agent?: string): number {
		const activeCount = agent ? this.active().filter((s) => s.agent === agent).length : this.active().length;
		let pendingCount = 0;
		for (const [id, n] of this.pending) {
			if (agent && id !== agent) {
				continue;
			}
			pendingCount += n;
		}
		return activeCount + pendingCount;
	}

	private totalPending(): number {
		let n = 0;
		for (const count of this.pending.values()) {
			n += count;
		}
		return n;
	}

	/**
	 * Take a slot for `agent` if both ceilings allow. The returned release is idempotent; call it once
	 * the session is registered (it then holds the slot itself) or its start failed.
	 */
	tryReserve(agent: string): (() => void) | null {
		if (this.inFlight(agent) >= this.agentLimit()) {
			return null;
		}
		if (this.active().length + this.totalPending() >= this.totalLimit()) {
			return null;
		}
		this.pending.set(agent, (this.pending.get(agent) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const n = (this.pending.get(agent) ?? 1) - 1;
			if (n <= 0) {
				this.pending.delete(agent);
			} else {
				this.pending.set(agent, n);
			}
		};
	}
}
