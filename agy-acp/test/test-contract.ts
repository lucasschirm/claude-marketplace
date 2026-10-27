// Contract tests for the agy stream-json types (src/agy/contract.ts):
//   - every recorded fixture parses, and no fixture line is an unknown event type;
//   - every field in field-inventory.json is reachable through the types: the accessors below are
//     written against the typed events, so `tsc --noEmit` proves reachability at compile time, and
//     the runtime comparison proves the typed view carries the recorded value verbatim;
//   - unknown fields and unknown event types are kept but not fatal.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAgyLine, type AgyEvent, type AgyInitEvent, type AgyResultEvent, type AgyStepUpdateEvent } from "../src/agy-driver.ts";

const STREAM_DIR = fileURLToPath(new URL("./fixtures/stream", import.meta.url));

function scenarioNames(): string[] {
	return fs
		.readdirSync(STREAM_DIR)
		.filter((f) => f.endsWith(".stdout.ndjson"))
		.map((f) => f.slice(0, -".stdout.ndjson".length))
		.sort();
}

function scenarioLines(name: string): string[] {
	return fs
		.readFileSync(path.join(STREAM_DIR, `${name}.stdout.ndjson`), "utf8")
		.split("\n")
		.filter((l) => l !== "");
}

function asInit(e: AgyEvent): AgyInitEvent {
	assert.strictEqual(e.event, "init");
	return e;
}

function asStep(e: AgyEvent): AgyStepUpdateEvent {
	assert.strictEqual(e.event, "step_update");
	return e;
}

function asResult(e: AgyEvent): AgyResultEvent {
	assert.strictEqual(e.event, "result");
	return e;
}

// One accessor per field in field-inventory.json, keyed "<event>:<path>". Each one touches the
// field through its typed path - that is the "reachable through the types" proof.
const FIELD_ACCESSORS: Record<string, (e: AgyEvent) => unknown> = {
	"init:event": (e) => asInit(e).event,
	"init:conversation_id": (e) => asInit(e).conversation_id,
	"init:init.model": (e) => asInit(e).init.model,
	"init:init.cwd": (e) => asInit(e).init.cwd,
	"init:init.tools": (e) => asInit(e).init.tools,
	"init:init.permission_mode": (e) => asInit(e).init.permission_mode,

	"step_update:event": (e) => asStep(e).event,
	"step_update:step_update.conversation_id": (e) => asStep(e).step_update.conversation_id,
	"step_update:step_update.step_index": (e) => asStep(e).step_update.step_index,
	"step_update:step_update.state": (e) => asStep(e).step_update.state,
	"step_update:step_update.step_type": (e) => asStep(e).step_update.step_type,
	"step_update:step_update.text_delta": (e) => asStep(e).step_update.text_delta,
	"step_update:step_update.duration_seconds": (e) => asStep(e).step_update.duration_seconds,
	"step_update:step_update.usage.input_tokens": (e) => asStep(e).step_update.usage?.input_tokens,
	"step_update:step_update.usage.output_tokens": (e) => asStep(e).step_update.usage?.output_tokens,
	"step_update:step_update.usage.thinking_tokens": (e) => asStep(e).step_update.usage?.thinking_tokens,
	"step_update:step_update.usage.cache_read_tokens": (e) => asStep(e).step_update.usage?.cache_read_tokens,
	"step_update:step_update.usage.total_tokens": (e) => asStep(e).step_update.usage?.total_tokens,
	"step_update:step_update.tool_name": (e) => asStep(e).step_update.tool_name,
	"step_update:step_update.tool_info.name": (e) => asStep(e).step_update.tool_info?.name,
	"step_update:step_update.tool_info.parameters.CommandLine": (e) => asStep(e).step_update.tool_info?.parameters.CommandLine,
	"step_update:step_update.tool_info.parameters.Path": (e) => asStep(e).step_update.tool_info?.parameters.Path,
	"step_update:step_update.tool_info.parameters.query": (e) => asStep(e).step_update.tool_info?.parameters.query,
	"step_update:step_update.tool_info.parameters.Role": (e) => asStep(e).step_update.tool_info?.parameters.Role,
	"step_update:step_update.tool_info.parameters.TypeName": (e) => asStep(e).step_update.tool_info?.parameters.TypeName,
	"step_update:step_update.tool_info.output": (e) => asStep(e).step_update.tool_info?.output,
	"step_update:step_update.tool_info.error.type": (e) => asStep(e).step_update.tool_info?.error?.type,
	"step_update:step_update.tool_info.error.message": (e) => asStep(e).step_update.tool_info?.error?.message,
	"step_update:step_update.subagent_info.subagents": (e) => asStep(e).step_update.subagent_info?.subagents,
	"step_update:step_update.subagent_info.subagents[].type_name": (e) => asStep(e).step_update.subagent_info?.subagents[0]?.type_name,
	"step_update:step_update.subagent_info.subagents[].role": (e) => asStep(e).step_update.subagent_info?.subagents[0]?.role,
	"step_update:step_update.subagent_info.subagents[].initial_prompt": (e) =>
		asStep(e).step_update.subagent_info?.subagents[0]?.initial_prompt,
	"step_update:step_update.subagent_info.subagents[].conversation_id": (e) =>
		asStep(e).step_update.subagent_info?.subagents[0]?.conversation_id,
	"step_update:step_update.subagent_info.subagents[].log_uri": (e) => asStep(e).step_update.subagent_info?.subagents[0]?.log_uri,
	"step_update:step_update.subagent_info.subagents[].workspace_uris": (e) =>
		asStep(e).step_update.subagent_info?.subagents[0]?.workspace_uris,

	"result:event": (e) => asResult(e).event,
	"result:result.conversation_id": (e) => asResult(e).result.conversation_id,
	"result:result.status": (e) => asResult(e).result.status,
	"result:result.response": (e) => asResult(e).result.response,
	"result:result.error": (e) => asResult(e).result.error,
	"result:result.duration_seconds": (e) => asResult(e).result.duration_seconds,
	"result:result.num_turns": (e) => asResult(e).result.num_turns,
	"result:result.usage.input_tokens": (e) => asResult(e).result.usage.input_tokens,
	"result:result.usage.output_tokens": (e) => asResult(e).result.usage.output_tokens,
	"result:result.usage.thinking_tokens": (e) => asResult(e).result.usage.thinking_tokens,
	"result:result.usage.cache_read_tokens": (e) => asResult(e).result.usage.cache_read_tokens,
	"result:result.usage.total_tokens": (e) => asResult(e).result.usage.total_tokens,
	"result:result.denied_actions": (e) => asResult(e).result.denied_actions,
	"result:result.denied_actions[].action": (e) => asResult(e).result.denied_actions?.[0]?.action,
	"result:result.denied_actions[].display_name": (e) => asResult(e).result.denied_actions?.[0]?.display_name,
};

/** Walk the raw JSON by an inventory path; `field[]` descends into the array's first element. */
function rawAt(raw: unknown, p: string): unknown {
	let cur: unknown = raw;
	for (const seg of p.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		if (seg.endsWith("[]")) {
			const arr = (cur as Record<string, unknown>)[seg.slice(0, -2)];
			if (!Array.isArray(arr) || arr.length === 0) return undefined;
			cur = arr[0];
		} else {
			cur = (cur as Record<string, unknown>)[seg];
		}
	}
	return cur;
}

test("every fixture line parses, and no fixture line is an unknown event type", () => {
	const names = scenarioNames();
	assert.strictEqual(names.length, 34, "the spike recorded 34 stream scenarios");
	let lineCount = 0;
	for (const name of names) {
		for (const line of scenarioLines(name)) {
			lineCount++;
			const parsed = parseAgyLine(line);
			assert.strictEqual(parsed.kind, "event", `${name}: unknown event type in: ${line.slice(0, 120)}`);
		}
	}
	assert.ok(lineCount >= 300, `expected a healthy fixture set, parsed ${lineCount} lines`);
});

test("unknown event types and malformed lines are kept, not fatal", () => {
	const unknownEvent = parseAgyLine('{"event":"totally_new","x":1}');
	assert.deepStrictEqual(unknownEvent, { kind: "unknown", event: "totally_new", raw: { event: "totally_new", x: 1 } });
	assert.strictEqual(parseAgyLine("not json at all").kind, "unknown");
	assert.strictEqual(parseAgyLine("[1,2,3]").kind, "unknown");
	assert.strictEqual(parseAgyLine('{"no_event_field":1}').kind, "unknown");
	// Unknown FIELDS on a known event are ignored by the typed view, not fatal.
	const extra = parseAgyLine(
		'{"event":"init","conversation_id":"c","brand_new_field":42,"init":{"model":"m","cwd":"/w","tools":[],"permission_mode":"request-review","brand_new":true}}',
	);
	assert.strictEqual(extra.kind, "event");
	if (extra.kind === "event") assert.strictEqual((extra.event as AgyInitEvent).init.model, "m");
});

test("every field in the field inventory is reachable through the types, with its recorded value", () => {
	const inventory = JSON.parse(fs.readFileSync(path.join(STREAM_DIR, "field-inventory.json"), "utf8")) as Record<
		string,
		Record<string, unknown>
	>;
	const seen = new Set<string>();
	for (const name of scenarioNames()) {
		for (const line of scenarioLines(name)) {
			const raw: unknown = JSON.parse(line);
			if (raw === null || typeof raw !== "object" || typeof (raw as Record<string, unknown>).event !== "string") continue;
			const parsed = parseAgyLine(line);
			if (parsed.kind !== "event") continue;
			const event = String((raw as Record<string, unknown>).event);
			const fields = inventory[event];
			if (!fields) continue;
			for (const fieldPath of Object.keys(fields)) checkField(name, raw, parsed.event, event, fieldPath, seen);
		}
	}
	const missing = Object.keys(FIELD_ACCESSORS).filter((k) => !seen.has(k));
	assert.deepStrictEqual(missing, [], `inventory fields never observed in any fixture: ${missing.join(", ")}`);
});

function checkField(name: string, raw: unknown, event: AgyEvent, kind: string, fieldPath: string, seen: Set<string>): void {
	const rawValue = rawAt(raw, fieldPath);
	if (rawValue === undefined) return;
	const key = `${kind}:${fieldPath}`;
	const accessor = FIELD_ACCESSORS[key];
	assert.ok(accessor, `no typed accessor for inventory field ${key}`);
	assert.deepStrictEqual(accessor(event), rawValue, `${name}: typed view diverges from raw at ${key}`);
	seen.add(key);
}
