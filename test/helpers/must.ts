// Shared helper for the suites that look something up they have already arranged to exist.
import assert from "node:assert";

/**
 * Narrows a lookup the test has set up, and names what was missing when the setup did not run.
 *
 * `registeredTools.get("devin_delegate")!` says the same thing to the compiler and nothing at all to
 * whoever reads the failure: a `!` that turns out to be wrong surfaces as "Cannot read properties of
 * undefined", several frames away from the registration that never happened. This reports the name
 * instead, at the line that wanted the value.
 */
export function must<T>(value: T | undefined | null, what: string): T {
	assert.ok(value !== undefined && value !== null, `${what} is missing`);
	return value;
}
