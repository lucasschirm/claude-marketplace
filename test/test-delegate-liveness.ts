// Run with: node --test test/test-delegate-liveness.ts
//
// Waiting is not stalling. An adapter that goes quiet while a hook blocks (see `drivers/agy.ts`) sends a
// heartbeat saying so, and the engine has to treat three things distinctly: a turn that is producing
// output, a turn that is waiting on an answer, and a turn nobody is home for.
import { test } from "node:test";
import assert from "node:assert";
import { defaultMapUpdate, eventToLogEntries } from "../extensions/lib/delegate/events.ts";
import { isStalledNow } from "../extensions/lib/delegate/liveness.ts";
import { attach } from "../extensions/lib/delegate/session.ts";
import { fakeTransport, makeStub, metaFor } from "./helpers/delegate-stub.ts";

/** A beat exactly as `agy-acp/src/heartbeat.ts` emits it. */
function heartbeat(over: Record<string, unknown> = {}) {
	return {
		sessionId: "s1",
		update: {
			sessionUpdate: "heartbeat",
			_meta: {
				heartbeat: { seq: 3, atMs: 1_700_000_000_000, turnMs: 45_000, state: "waiting_permission", pendingPermissions: 1, ...over },
			},
		},
	};
}

// --- the mapping ---

test("a heartbeat maps to a liveness event that names what the session is waiting on", () => {
	const [event] = defaultMapUpdate(heartbeat());
	assert.strictEqual(event?.kind, "liveness");
	if (event?.kind === "liveness") {
		assert.strictEqual(event.state, "waiting_permission");
		assert.strictEqual(event.pendingPermissions, 1);
		assert.strictEqual(event.turnMs, 45_000);
		assert.strictEqual(event.seq, 3);
	}
});

test("a beat writes no transcript line", () => {
	// A beat every 15 seconds for a two-hour turn would be 480 lines of "still here" per session, in the
	// file a human reads to find out what the agent did.
	const [event] = defaultMapUpdate(heartbeat());
	assert.ok(event);
	assert.deepStrictEqual(eventToLogEntries(event), []);
});

test("a beat with no payload is still liveness, and says nothing more", () => {
	// The update kind is the contract; `_meta` is a bonus. A driver must not throw over a missing field,
	// because a mapper that throws costs the caller its whole transcript (see session.ts's fallback).
	const [event] = defaultMapUpdate({ sessionId: "s1", update: { sessionUpdate: "heartbeat" } });
	assert.strictEqual(event?.kind, "liveness");
	if (event?.kind === "liveness") {
		assert.strictEqual(event.state, undefined);
		assert.strictEqual(event.pendingPermissions, undefined);
	}
});

test("an unknown update kind still says which kind it was", () => {
	const [event] = defaultMapUpdate({ sessionId: "s1", update: { sessionUpdate: "quantum_progress" } });
	assert.deepStrictEqual(event, { kind: "ignored", reason: "quantum_progress" });
});

// --- the verdict ---

// Matcher patterns at module scope (biome's useTopLevelRegex counts a literal recompiled per call).
const APPEARS_STALLED_RE = /appears stalled/;

const HOUR = 60 * 60_000;
const STALL = 10 * 60_000;

test("silence past the limit is a stall", () => {
	assert.strictEqual(isStalledNow({ status: "running", pendingPermissions: 0, lastActivityMs: 0, stallMs: STALL, nowMs: HOUR }), true);
	assert.strictEqual(
		isStalledNow({ status: "running", pendingPermissions: 0, lastActivityMs: HOUR - STALL - 1, stallMs: STALL, nowMs: HOUR }),
		true,
	);
});

test("a turn waiting on a permission answer is never stalled, however long it waits", () => {
	// The acceptance case, and the reason the pending check comes before the clock: the permission timeout
	// settles a wait like this, with a deny and a reason the agent can act on. Reporting it stalled too
	// would put two clocks on one wait and call a designed behavior a fault.
	assert.strictEqual(isStalledNow({ status: "running", pendingPermissions: 1, lastActivityMs: 0, stallMs: STALL, nowMs: HOUR * 6 }), false);
});

test("a beat that arrived is activity, and resets the clock", () => {
	// What a heartbeat does in `attach`: the frame itself is what moves `lastMessageTime`, so an articulate
	// agent's beat has the same effect on the verdict as a message would.
	assert.strictEqual(
		isStalledNow({ status: "running", pendingPermissions: 0, lastActivityMs: HOUR - 1000, stallMs: STALL, nowMs: HOUR }),
		false,
	);
});

test("only a running turn can stall", () => {
	for (const status of ["idle", "completed", "cancelled", "failed", "interrupted", "stalled"] as const) {
		assert.strictEqual(isStalledNow({ status, pendingPermissions: 0, lastActivityMs: 0, stallMs: STALL, nowMs: HOUR * 6 }), false, status);
	}
});

// --- the engine, end to end over a fake transport ---

test("a beat through the session layer refreshes the clock, changes the status to nothing, and writes nothing", () => {
	const stub = makeStub();
	const meta = metaFor("s1", { agent: "agy", lastMessageTime: Date.now() - HOUR });
	const client = fakeTransport();
	attach(stub.rt, client as never, meta);

	const before = meta.lastMessageTime;
	client.emitUpdate(heartbeat());

	assert.ok(meta.lastMessageTime > before, "the beat counted as activity");
	assert.strictEqual(meta.status, "running", "and did not change the session's state");
	assert.deepStrictEqual(client.written, [], "a beat is not transcript material");
	stub.restoreHome();
});

test("a stalled session that starts beating again is running again", () => {
	const stub = makeStub();
	const meta = metaFor("s1", { agent: "agy", status: "stalled", lastMessageTime: Date.now() - HOUR });
	const client = fakeTransport();
	attach(stub.rt, client as never, meta);

	client.emitUpdate(heartbeat({ state: "running", pendingPermissions: 0 }));

	assert.strictEqual(meta.status, "running", "the stall was a question, and it was answered");
	// The watchdog that was stopped when it went stale has to be running again, or the next silence is
	// silent forever.
	assert.ok(stub.rt.stallTimers.has("s1"), "the watchdog restarted with it");
	stub.rt.stopStallWatchdog("s1");
	stub.restoreHome();
});

// --- the verdict as the shipped watchdog computes it ---
//
// `stallTick` is the body of the timer `startStallWatchdog` installs, and it asks `isStalledNow` rather
// than deciding inline. These tests are the reason that wiring matters: the acceptance criterion is about
// the timer that runs in a user's session, and a copy of its clauses in a helper would certify only the copy.

/** A pending ask in the shape the runtime holds, with a timer nobody waits on. */
function pendingAsk(): never {
	const request = { requestId: 1, command: "rm -rf build", options: [], requestedAt: 0, timer: setTimeout(() => {}, 60_000) };
	request.timer.unref();
	return request as never;
}

test("the watchdog does not report a session waiting on a permission answer as stalled", () => {
	const { rt, sent, restoreHome } = makeStub();
	try {
		const meta = metaFor("ag-tick-ask", { status: "running", startedAt: 0, lastMessageTime: Date.now() - HOUR });
		rt.pendingPermissions.set("ag-tick-ask", [pendingAsk()]);
		assert.strictEqual(rt.stallTick(meta, STALL), false, "blocked is not broken");
		assert.strictEqual(meta.status, "running");
		assert.deepStrictEqual(sent, [], "and nobody is told about a session that is behaving");

		// The same silence with nothing outstanding is the case the watchdog exists for.
		rt.pendingPermissions.delete("ag-tick-ask");
		assert.strictEqual(rt.stallTick(meta, STALL), true);
		assert.strictEqual(meta.status, "stalled");
		assert.match(sent.join("\n"), APPEARS_STALLED_RE, "a human is told, once");
	} finally {
		restoreHome();
	}
});

test("a beat that arrives keeps the shipped watchdog quiet, and a gap longer than the limit does not", () => {
	const { rt, restoreHome } = makeStub();
	try {
		const meta = metaFor("ag-tick-beat", { status: "running", startedAt: 0, lastMessageTime: Date.now() - STALL - 1000 });
		assert.strictEqual(rt.stallTick(meta, STALL), true);
		// Activity resumed: status back to running, clock reset — which is what `attach` does on any frame,
		// including a heartbeat.
		meta.status = "running";
		meta.lastMessageTime = Date.now();
		assert.strictEqual(rt.stallTick(meta, STALL), false);
	} finally {
		restoreHome();
	}
});

test("a tick on a session that stopped running disarms its own timer", () => {
	const { rt, restoreHome } = makeStub();
	try {
		const meta = metaFor("ag-tick-disarm", { status: "running", lastMessageTime: Date.now() });
		rt.startStallWatchdog(meta);
		assert.ok(rt.stallTimers.has("ag-tick-disarm"), "the watchdog is armed while the turn runs");
		meta.status = "idle";
		assert.strictEqual(rt.stallTick(meta, STALL), false);
		assert.ok(!rt.stallTimers.has("ag-tick-disarm"), "and a turn that ended takes its timer with it");
	} finally {
		restoreHome();
	}
});
