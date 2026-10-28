// The session table of the ACP server (extracted from server.ts, which is where the methods live).
//
// `disposeAll()` runs when the connection closes, so no child outlives the server, and it is what an
// exit path awaits before the process leaves. Two races are why this is a type of its own:
//
//   - a `session/new` whose `start()` completes after `disposeAll()` ran (the probe takes seconds on a
//     real agy) would register a session nothing ever disposes, so a late add disposes it instead and
//     the dispose is tracked, so `disposeAll()` waits for it;
//   - two callers - the client hanging up, then a signal while that is still running - must not each
//     pass over the map the first one cleared, or the second resolves (and the process exits) while
//     the first pass's kill ladders are still running. Hence single-flight.

import type { AgySession } from "./session.ts";

export class SessionRegistry {
	private readonly sessions = new Map<string, AgySession>();
	private readonly log: (line: string) => void;
	private closed = false;
	private disposing: Promise<void> | null = null;
	private readonly pendingDisposes: Promise<void>[] = [];

	constructor(log: (line: string) => void) {
		this.log = log;
	}

	add(sessionId: string, session: AgySession): void {
		if (this.closed) {
			this.log(`session ${sessionId} started after the connection closed - disposing it`);
			this.pendingDisposes.push(
				session.dispose().catch((err: Error) => {
					this.log(`session ${sessionId} dispose failed: ${err.message}`);
				}),
			);
			return;
		}
		this.sessions.set(sessionId, session);
	}

	get(sessionId: string): AgySession | undefined {
		return this.sessions.get(sessionId);
	}

	/** The dispose of every session, joined by a second caller rather than repeated (see the header). */
	disposeAll(): Promise<void> {
		this.disposing ??= this.disposeOnce().finally(() => (this.disposing = null));
		return this.disposing;
	}

	private async disposeOnce(): Promise<void> {
		this.closed = true;
		const entries = [...this.sessions.values()];
		this.sessions.clear();
		for (const session of entries) {
			this.log(`disposing session ${session.id}`);
			try {
				await session.dispose();
			} catch (err) {
				this.log(`session ${session.id} dispose failed: ${(err as Error).message}`);
			}
		}
		// A late add can land while the sessions above are being awaited, so drain until quiet.
		while (this.pendingDisposes.length > 0) await Promise.all(this.pendingDisposes.splice(0));
	}
}
