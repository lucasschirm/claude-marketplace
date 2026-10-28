// The bounded drain of the protocol channel. agy-acp's stdout is JSON-RPC frames, and this file
// writes none of them: its single write is zero-length, which is Node's "call me once everything
// before it has reached the pipe". It exists because the exit path ends in `process.exit()`, and a
// buffered response that has not flushed when the process ends is a prompt the client waits on
// forever - the frame was "sent" as far as the sender was concerned.
//
// Being its own file is the point. The quality gate (`agyStdoutFramesOnly` in
// scripts/check-quality.mjs) allows `process.stdout.write` in the transport, and grants it here for
// this one call rather than opening the shutdown path to stdout writes of any kind.

/** The most the drain may take; it runs inside the shutdown deadline's tail. */
export const FLUSH_TIMEOUT_MS = 1_000;

/** Lets buffered protocol frames reach the pipe before the exit. Bounded: a wedged stdout must not hold the process open. */
export function flushStdout(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		timer.unref();
		if (!process.stdout.writable) {
			finish();
			return;
		}
		try {
			// A zero-length write is the standard "call me once everything before it is out".
			process.stdout.write("", () => finish());
		} catch {
			// a dead stdout has nothing to flush
			finish();
		}
	});
}
