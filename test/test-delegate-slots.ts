// Run with: node --test test/test-delegate-slots.ts
import { test } from "node:test";
import assert from "node:assert";
import { AgentSlots } from "../extensions/lib/delegate/slots.ts";
import { must } from "./helpers/must.ts";

interface Live {
	agent: string;
}

/**
 * A slots instance over a mutable "registered sessions" list.
 *
 * The limits are passed as getters because that is how the engine passes them (`() => rt.maxRuns`): a
 * `/delegate limit 5` has to take effect on the next reservation, not on the next construction.
 */
function make(live: Live[], perAgent: () => number = () => 2, total: () => number = () => 3) {
	return new AgentSlots(() => live, perAgent, total);
}

test("a reservation counts before the session registers", () => {
	// The bug this proves: a session only appears in the session table once its agent's server has
	// answered session/new, seconds after the decision to start it. Counting the table alone let every
	// start decided inside that window through — peak 8 sessions against a limit of 2 (2026-10-22).
	const live: Live[] = [];
	const slots = make(live);
	const a = slots.tryReserve("devin");
	const b = slots.tryReserve("devin");
	assert.ok(a && b, "two slots under a per-agent limit of 2");
	assert.strictEqual(slots.tryReserve("devin"), null, "a third start must wait although nothing has registered yet");
	assert.strictEqual(slots.inFlight(), 2);

	// The first session registers, then its reservation is handed over: still 2 in flight, not 3.
	live.push({ agent: "devin" });
	a();
	assert.strictEqual(slots.inFlight(), 2);
	assert.strictEqual(slots.tryReserve("devin"), null);

	// A failed start releases its reservation, freeing the slot for the next task.
	b();
	assert.strictEqual(slots.inFlight(), 1);
	assert.ok(slots.tryReserve("devin"), "the freed slot can be taken");
});

test("a release is idempotent and follows a changed limit", () => {
	const live: Live[] = [];
	let perAgent = 1;
	const slots = make(
		live,
		() => perAgent,
		() => 5,
	);
	const r = must(slots.tryReserve("devin"), "a reserved slot");
	r();
	r();
	assert.strictEqual(slots.inFlight(), 0, "a double release must not free a slot it never held");
	slots.tryReserve("devin");
	assert.strictEqual(slots.tryReserve("devin"), null);
	perAgent = 3;
	assert.ok(slots.tryReserve("devin"), "raising the limit admits more");
});

test("one agent at its limit cannot starve another", () => {
	// The reason there are two ceilings: "three sessions" is not the right limit when they belong to
	// different agents, and a Devin-saturated queue must not block a Claude task.
	const live: Live[] = [{ agent: "devin" }, { agent: "devin" }];
	const slots = make(
		live,
		() => 2,
		() => 3,
	);
	assert.strictEqual(slots.tryReserve("devin"), null, "devin is at its own limit");
	const claude = slots.tryReserve("claude");
	assert.ok(claude, "claude has capacity of its own");
	assert.strictEqual(slots.inFlight("devin"), 2);
	assert.strictEqual(slots.inFlight("claude"), 1);
	assert.strictEqual(slots.inFlight(), 3);
});

test("the total ceiling binds even when every agent has per-agent capacity", () => {
	const live: Live[] = [{ agent: "devin" }, { agent: "claude" }, { agent: "other" }];
	const slots = make(
		live,
		() => 2,
		() => 3,
	);
	assert.strictEqual(slots.tryReserve("devin"), null, "each agent has room but the total is full");
	assert.strictEqual(slots.tryReserve("claude"), null);
});

test("reservations for different agents are tracked separately", () => {
	const live: Live[] = [];
	const slots = make(
		live,
		() => 1,
		() => 3,
	);
	const d = must(slots.tryReserve("devin"), "devin slot");
	const c = must(slots.tryReserve("claude"), "claude slot");
	assert.strictEqual(slots.inFlight("devin"), 1);
	assert.strictEqual(slots.inFlight("claude"), 1);
	assert.strictEqual(slots.tryReserve("devin"), null);
	d();
	c();
	assert.strictEqual(slots.inFlight(), 0, "every reservation came back");
});
