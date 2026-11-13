/**
 * Poll until a reader returns something, and hand it back.
 *
 * The one shared version, because "wait for a file a stream writes" and "wait for a child process to
 * really be gone" are everywhere in these suites, and each private copy was a slightly different timeout
 * with a slightly different idea of what a null answer means. Throws after `timeoutMs` rather than
 * returning null: a test that timed out is a failure, not a value.
 */
export async function waitFor<T>(read: () => T | null | undefined, timeoutMs = 5000, intervalMs = 25): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== null && value !== undefined) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`timed out after ${timeoutMs}ms waiting for ${read.name || "a condition"}`);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}
