// Run with: node --test test/test-gh-health.ts
import { test } from "node:test";
import * as assert from "node:assert";
import { GhHealth, isGhAvailabilityError, isGhAuthError } from "../extensions/lib/gh-health.ts";

function makeFakeClock() {
	let nowMs = 0;
	const timers: Array<{ at: number; fn: () => void; id: number }> = [];
	let nextId = 1;
	const schedule = (ms: number, fn: () => void) => {
		const id = nextId++;
		timers.push({ at: nowMs + ms, fn, id });
		return id;
	};
	const unschedule = (handle: unknown) => {
		const i = timers.findIndex((t) => t.id === handle);
		if (i >= 0) timers.splice(i, 1);
	};
	const advance = (ms: number) => {
		const until = nowMs + ms;
		// Fire all timers that come due, in due-time order
		for (;;) {
			const due = timers
				.filter((t) => t.at <= until)
				.sort((a, b) => a.at - b.at);
			if (due.length === 0) break;
			const t = due[0];
			nowMs = t.at;
			const i = timers.findIndex((x) => x.id === t.id);
			if (i >= 0) timers.splice(i, 1);
			t.fn();
		}
		nowMs = until;
	};
	return { now: () => nowMs, schedule, unschedule, advance, pending: () => timers.length };
}

function makeHealth() {
	const clock = makeFakeClock();
	const hooks: Array<() => void> = [];
	const health = new GhHealth({
		fastIntervalMs: 30_000,
		fastRetries: 5,
		slowIntervalMs: 600_000,
		now: clock.now,
		schedule: clock.schedule,
		unschedule: clock.unschedule,
	});
	health.registerRetryHook(() => hooks.push("fired"));
	return { health, clock, hooks };
}

test("backoff timing: 30 s slots for the first 5 failures, then 10 min", () => {
	const { health, clock, hooks } = makeHealth();
	assert.strictEqual(health.status, "healthy");
	assert.strictEqual(health.nextRetryInMs(), 0);

	// Failures 1–5: next retry after 30 s each
	for (let i = 1; i <= 5; i++) {
		health.recordFailure();
		assert.strictEqual(health.consecutiveFailures, i);
		assert.strictEqual(health.status, "degraded");
		assert.strictEqual(health.nextRetryInMs(), 30_000, `failure ${i} should pace 30 s`);
	}
	// Failure 6+: next retry after 10 min
	for (let i = 6; i <= 8; i++) {
		health.recordFailure();
		assert.strictEqual(health.consecutiveFailures, i);
		assert.strictEqual(health.nextRetryInMs(), 600_000, `failure ${i} should pace 10 min`);
	}

	// The scheduled retry fires once at the slot time
	clock.advance(600_000);
	assert.strictEqual(hooks.length, 1);

	// A success resets the state and clears the pending timer
	health.recordSuccess();
	assert.strictEqual(health.status, "healthy");
	assert.strictEqual(health.nextRetryInMs(), 0);
	assert.strictEqual(clock.pending(), 0);
	health.recordFailure();
	assert.strictEqual(health.nextRetryInMs(), 30_000, "after a reset the pacing restarts at 30 s");
});

test("the retry timer is rescheduled on each failure", () => {
	const { health, clock } = makeHealth();
	health.recordFailure(); // timer at +30 s
	clock.advance(30_000); // fire
	health.recordFailure(); // reschedule at +30 s from now
	assert.strictEqual(clock.pending(), 1);
	health.recordFailure(); // reschedule again; still exactly one timer
	assert.strictEqual(clock.pending(), 1);
});

test("single-flight: one claim per slot, pending work re-fires the hooks on release", () => {
	const { health, clock, hooks } = makeHealth();
	health.recordFailure();
	clock.advance(30_000); // timer fires -> hook
	assert.strictEqual(hooks.length, 1);

	// Simulate a hook claiming the slot and holding it
	assert.strictEqual(health.acquireSlot(), true);
	assert.strictEqual(health.acquireSlot(), false, "a second caller must not claim the same slot");
	health.release();
	assert.strictEqual(hooks.length, 2, "releasing a held slot that is still due re-fires the hooks");

	// The release was record-less: the consumed window ends with the holder's work,
	// so the still-due slot is claimable again (no burned window / permanent stall)
	assert.strictEqual(health.acquireSlot(), true, "record-less release leaves the slot claimable");
	assert.strictEqual(health.acquireSlot(), false, "while held: no double claim");
	health.release();
});

test("a 404-class error never touches the health state", () => {
	assert.strictEqual(isGhAvailabilityError(new Error("Could not resolve to a PullRequest with the number 999")), false);
	assert.strictEqual(isGhAvailabilityError({ stderr: "no pull requests found for branch x" }), false);
	assert.strictEqual(isGhAvailabilityError({ stderr: "gh: Could not resolve to a node with the global id" }), false);
	assert.strictEqual(isGhAvailabilityError({ stderr: "HTTP 404: Not Found" }), false);
});

test("availability errors are classified (network, timeout, rate limit, auth)", () => {
	assert.strictEqual(isGhAvailabilityError({ killed: true }), true, "stopped by our own timeout");
	assert.strictEqual(isGhAvailabilityError({ signal: "SIGTERM" }), true);
	assert.strictEqual(isGhAvailabilityError({ code: "ETIMEDOUT" }), true);
	assert.strictEqual(isGhAvailabilityError({ code: "ECONNREFUSED" }), true);
	assert.strictEqual(isGhAvailabilityError({ code: "ECONNRESET" }), true);
	assert.strictEqual(
		isGhAvailabilityError({ stderr: "gh: failed to connect: dial tcp 140.107.20.17:443: i/o timeout" }),
		true,
	);
	assert.strictEqual(isGhAvailabilityError({ stderr: "gh: HTTP 429: You have exceeded a secondary rate limit" }), true);
	assert.strictEqual(isGhAvailabilityError({ stderr: "gh: HTTP 503 Service Unavailable" }), true);
	assert.strictEqual(isGhAvailabilityError({ stderr: "gh: token expired or unauthorized" }), true);
	assert.strictEqual(isGhAvailabilityError("connection reset by peer"), true, "raw strings are checked too");
});

test("reset() clears the pending retry", () => {
	const { health, clock } = makeHealth();
	health.recordFailure();
	assert.strictEqual(clock.pending(), 1);
	health.reset();
	assert.strictEqual(clock.pending(), 0);
	assert.strictEqual(health.status, "healthy");
	assert.strictEqual(health.consecutiveFailures, 0);
});

test("auth errors are classified (and are also availability errors)", () => {
	assert.strictEqual(isGhAuthError({ stderr: "graphql error: token expired or unauthorized" }), true);
	assert.strictEqual(isGhAuthError({ stderr: "gh: authentication failed" }), true);
	assert.strictEqual(isGhAuthError({ stderr: "gh: bad credentials" }), true);
	assert.strictEqual(isGhAuthError(new Error("Command failed: gh api ...\nHTTP 401: Unauthorized")), true);
	assert.strictEqual(isGhAvailabilityError({ stderr: "graphql error: token expired or unauthorized" }), true, "auth failures pace the background retries too");
	assert.strictEqual(isGhAuthError({ stderr: "failed to connect: dial tcp 1.2.3.4:443: i/o timeout" }), false, "a plain network failure is not an auth error");
	assert.strictEqual(isGhAuthError({ stderr: "Could not resolve to a PullRequest with the number 999" }), false);
	assert.strictEqual(isGhAuthError("HTTP 502 Bad Gateway"), false);
});

test("a holder that records nothing does not burn the slot (no permanent stall)", () => {
	const { health, clock } = makeHealth();
	health.recordFailure(); // degraded, slot due at +30 s
	clock.advance(30_000);
	assert.strictEqual(health.acquireSlot(), true);
	// the caller makes a 404-class (or no) call: records neither success nor failure
	health.release();
	// the slot is due with no timer pending: a new caller must be able to claim it
	// (the old code burned the window here and stalled all gated work permanently)
	assert.strictEqual(health.acquireSlot(), true, "no stall: the slot stays claimable after a record-less release");
	health.release();
});

test("a release while the slot became due re-fires the hooks (pendingWhileBusy)", () => {
	const { health, clock, hooks } = makeHealth();
	health.recordFailure();
	clock.advance(30_000); // timer fires -> hook #1
	assert.strictEqual(hooks.length, 1);
	assert.strictEqual(health.acquireSlot(), true);
	clock.advance(30_000); // a next slot became due while the holder is still running
	assert.strictEqual(health.acquireSlot(), false, "in flight: no claim");
	health.release(); // records nothing
	assert.strictEqual(hooks.length, 2, "the pending slot re-fires the hooks on release");
});

test("common gh network error strings are classified", () => {
	assert.strictEqual(isGhAvailabilityError({ stderr: 'Get "https://api.github.com/...": context deadline exceeded' }), true, "Go HTTP client timeout");
	assert.strictEqual(isGhAvailabilityError({ stderr: "streaming response: unexpected EOF" }), true, "dropped mid-response");
	assert.strictEqual(isGhAvailabilityError({ code: "ENOENT" }), true, "missing gh binary paces (no 1 Hz respawn loop)");
	assert.strictEqual(isGhAvailabilityError(new Error("spawn gh ENOENT")), true);
	assert.strictEqual(isGhAvailabilityError({ stderr: "To auth to GitHub with gh, run: gh auth login" }), true, "not-logged-in paces the background");
	assert.strictEqual(isGhAuthError({ stderr: "To auth to GitHub with gh, run: gh auth login" }), true, "not-logged-in surfaces on explicit calls");
});

test("a 403 rate limit is availability, not an auth error", () => {
	const err = { stderr: "gh: HTTP 403: You have exceeded a secondary rate limit" };
	assert.strictEqual(isGhAuthError(err), false, "a self-resolving rate limit must not take the auth path (which skips the auto-start)");
	assert.strictEqual(isGhAvailabilityError(err), true, "but it still paces the background retries");
	assert.strictEqual(isGhAuthError({ stderr: "HTTP 429: Too Many Requests" }), false);
});
