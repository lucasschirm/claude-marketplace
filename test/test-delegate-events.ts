// Run with: node --test test/test-delegate-events.ts
import { test } from "node:test";
import assert from "node:assert";
import {
	defaultMapUpdate,
	eventToLogEntries,
	extractChunkText,
	normalizeStopReason,
	stopReasonPhrase,
} from "../extensions/lib/delegate/events.ts";
import type { AcpUpdateFrame, DelegateEvent } from "../extensions/lib/delegate/types.ts";

const frame = (update: Record<string, unknown>): AcpUpdateFrame => ({ sessionId: "s-1", update });
const only = (update: Record<string, unknown>): DelegateEvent => {
	const events = defaultMapUpdate(frame(update));
	assert.strictEqual(events.length, 1, `expected exactly one event from ${JSON.stringify(update)}`);
	return events[0];
};

// --- the two gaps the canonical taxonomy closes ---

test("a thought chunk is mapped instead of dropped", () => {
	// The old extension ignored `agent_thought_chunk`. That was invisible while nothing could ask for
	// reasoning effort; once `thinking` is a parameter, the caller needs evidence it did something.
	assert.deepStrictEqual(only({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking the schema" } }), {
		kind: "thought.delta",
		text: "checking the schema",
	});
});

test("an unknown sessionUpdate is reported as ignored, naming the kind", () => {
	// The difference between "the agent sent nothing" and "we understood nothing" is what a stalled
	// session actually asks about, so a new upstream update type must surface, not vanish.
	const event = only({ sessionUpdate: "plan_review_verdict", payload: {} });
	assert.strictEqual(event.kind, "ignored");
	assert.strictEqual(event.kind === "ignored" ? event.reason : undefined, "plan_review_verdict");
	assert.strictEqual(eventToLogEntries(event).length, 0, "an ignored event is not history");
});

test("a frame with no sessionUpdate names itself as unnamed rather than silently vanishing", () => {
	const event = only({ somethingElse: true });
	assert.strictEqual(event.kind, "ignored");
	assert.strictEqual(event.kind === "ignored" ? event.reason : "", "unnamed sessionUpdate");
});

// --- the updates both agents send ---

test("assistant messages and chunks map to completed and delta", () => {
	assert.deepStrictEqual(only({ sessionUpdate: "agent_message", content: "done" }), { kind: "assistant.completed", text: "done" });
	assert.deepStrictEqual(only({ sessionUpdate: "agent_message_chunk", content: { text: "hel" } }), {
		kind: "assistant.delta",
		text: "hel",
	});
	// An empty chunk is not an event: the buffer would flush a blank line into the transcript.
	assert.deepStrictEqual(defaultMapUpdate(frame({ sessionUpdate: "agent_message_chunk", content: "" })), []);
});

test("chunk content of every shape the wire uses becomes text", () => {
	assert.strictEqual(extractChunkText("plain"), "plain");
	assert.strictEqual(extractChunkText({ type: "text", text: "block" }), "block");
	assert.strictEqual(extractChunkText([{ text: "a" }, { text: "b" }, "c"]), "abc");
	assert.strictEqual(extractChunkText(undefined), "");
	assert.strictEqual(extractChunkText({ type: "resource" }), "", "a block with no text contributes nothing");
});

test("tool calls carry their title and status", () => {
	const started = only({ sessionUpdate: "tool_call", toolCallId: "t1", title: "run tests" });
	assert.deepStrictEqual(started, { kind: "tool.started", toolCallId: "t1", title: "run tests" });
	// Devin puts the description inside content[].content instead of on the frame.
	const nested = only({ sessionUpdate: "tool_call", toolCallId: "t2", content: [{ content: { description: "edit src/a.ts" } }] });
	assert.strictEqual(nested.kind === "tool.started" ? nested.title : undefined, "edit src/a.ts");
	const updated = only({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
	assert.strictEqual(updated.kind, "tool.updated");
	assert.strictEqual(updated.kind === "tool.updated" ? updated.status : "", "completed");
});

test("a plan update counts entries and completed entries", () => {
	const event = only({
		sessionUpdate: "plan",
		entries: [{ status: "completed" }, { status: "in_progress" }, { status: "completed" }],
	});
	assert.strictEqual(event.kind, "plan.updated");
	assert.deepStrictEqual(event.kind === "plan.updated" ? { entries: event.entries, done: event.done } : null, { entries: 3, done: 2 });
});

test("usage reads both the nested and the flat token spelling", () => {
	const nested = only({
		sessionUpdate: "usage_update",
		used: 30,
		size: 200,
		usage: { totalTokens: 100, inputTokens: 60, outputTokens: 40 },
	});
	assert.deepStrictEqual(nested.kind === "usage.updated" ? nested.tokens : null, { total: 100, input: 60, output: 40 });
	const flat = only({ sessionUpdate: "usage_update", totalTokens: 7 });
	assert.strictEqual(flat.kind === "usage.updated" ? flat.tokens.total : undefined, 7);
	assert.strictEqual(flat.kind === "usage.updated" ? flat.tokens.input : undefined, undefined, "a missing counter stays missing, not zero");
});

test("config options become a selection vocabulary keyed by id", () => {
	const event = only({
		sessionUpdate: "config_option_update",
		configOptions: [
			{ id: "model", options: [{ value: "sonnet" }, { value: "opus" }] },
			{ id: "effort", options: ["low", "high"] },
			{ id: "no-options" },
		],
	});
	assert.deepStrictEqual(event.kind === "selection.updated" ? event.options : null, { model: ["sonnet", "opus"], effort: ["low", "high"] });
});

test("an empty config_option_update is ignored rather than wiping the vocabulary", () => {
	const event = only({ sessionUpdate: "config_option_update", configOptions: [] });
	assert.strictEqual(event.kind, "ignored");
});

test("a mode change is reported with the agent's own mode id", () => {
	assert.deepStrictEqual(only({ sessionUpdate: "current_mode_update", currentModeId: "plan" }), { kind: "mode.changed", modeId: "plan" });
});

// --- stop reasons ---

test("normalizeStopReason keeps the ACP reasons and never invents end_turn", () => {
	for (const r of ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled", "error"] as const) {
		assert.strictEqual(normalizeStopReason(r), r);
	}
	// An agent may answer with a reason nobody has seen. Inventing `end_turn` would report a truncation
	// as a success, which is the exact bug this refactor exists to close.
	assert.strictEqual(normalizeStopReason("stopped_by_firewall"), "unknown");
	assert.strictEqual(normalizeStopReason(undefined), "unknown");
	assert.strictEqual(normalizeStopReason(42), "unknown");
});

test("only end_turn is reported as done", () => {
	assert.strictEqual(stopReasonPhrase("end_turn"), "is done");
	assert.match(stopReasonPhrase("max_tokens"), /incomplete/);
	assert.match(stopReasonPhrase("max_turn_requests"), /incomplete/);
	assert.match(stopReasonPhrase("refusal"), /refused/);
	assert.match(stopReasonPhrase("cancelled"), /cancelled/);
	assert.match(stopReasonPhrase("unknown"), /unverified/);
	// Exhaustiveness: a new StopReason without a phrase fails to compile here, because the switch in
	// events.ts has no default and returns undefined.
	const all: Array<"end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error" | "unknown"> = [
		"end_turn",
		"max_tokens",
		"max_turn_requests",
		"refusal",
		"cancelled",
		"error",
		"unknown",
	];
	for (const reason of all) {
		assert.ok(stopReasonPhrase(reason).length > 0, reason);
	}
});

// --- transcript mapping ---

test("transcript line names keep the pre-refactor spellings", () => {
	// A session logged before this refactor still has to read back: the event type names are the format.
	assert.deepStrictEqual(eventToLogEntries({ kind: "assistant.completed", text: "hi" }), [
		{ type: "assistant_message", data: { text: "hi" } },
	]);
	assert.deepStrictEqual(eventToLogEntries({ kind: "tool.started", toolCallId: "t", title: "x" }), [
		{ type: "tool_call", data: { toolCallId: "t", title: "x" } },
	]);
	assert.deepStrictEqual(eventToLogEntries({ kind: "turn.failed", error: "boom" }), [{ type: "error", data: { message: "boom" } }]);
});

test("streaming deltas are not written as transcript lines", () => {
	// The engine buffers chunks and writes one line per flush; a line per chunk is a line per keystroke
	// of the agent's output and an fs write with it.
	assert.deepStrictEqual(eventToLogEntries({ kind: "assistant.delta", text: "chunk" }), []);
	assert.deepStrictEqual(eventToLogEntries({ kind: "thought.delta", text: "hmm" }), []);
	assert.deepStrictEqual(eventToLogEntries({ kind: "selection.updated", options: { model: ["a"] } }), []);
});
