// Run with: node --test test/test-delegate-compat.ts
import { test } from "node:test";
import assert from "node:assert";
import {
	ALIAS_NOTE,
	aliasSpecs,
	DEPRECATED_ALIASES,
	DEPRECATED_COMMANDS,
	renameNote,
	withNote,
} from "../extensions/lib/delegate/compat.ts";
import type { ToolSpec } from "../extensions/lib/delegate/tools.ts";
import { must } from "./helpers/must.ts";

/** The tool an alias wraps: records what reached it, so the wrapper's parameter rewriting is observable. */
function fakeTarget(name: string) {
	const seen: unknown[] = [];
	const spec: ToolSpec = {
		name,
		label: name,
		description: `the real ${name}`,
		parameters: {},
		async execute(_toolCallId, params) {
			seen.push(params);
			return { content: [{ type: "text", text: `${name} answered` }], details: { result: "ok" } };
		},
	};
	return { spec, seen };
}

test("every retired name wraps a real tool", () => {
	// The alias table is a promise that the old name still works. A typo in it, or a rename of a tool
	// whose alias was written first, is exactly what this catches.
	const built = [...aliasSpecs(Object.keys(DEPRECATED_ALIASES).map((current) => fakeTarget(current).spec))];
	assert.strictEqual(built.length, 0, "an alias whose target does not exist is not registered at all");
	const real = aliasSpecs(Object.values(DEPRECATED_ALIASES).map((current) => fakeTarget(current).spec));
	assert.strictEqual(real.length, Object.keys(DEPRECATED_ALIASES).length);
	for (const spec of real) {
		assert.ok(spec.name.startsWith("devin_"), spec.name);
	}
});

test("an old name means Devin even when the parameters ask for another agent", async () => {
	// `agent` is a new parameter, and a caller that wrote `devin_delegate` never set it. Letting an
	// `agent` through the old name would mean the same prompt does something different depending on a
	// default this extension controls — the one way a rename can silently change behavior.
	const { spec, seen } = fakeTarget("delegate_task");
	const alias = must(
		aliasSpecs([spec]).find((s) => s.name === "devin_delegate"),
		"the alias",
	);
	const res: any = await alias.execute("id-1", { prompt: "x", agent: "claude" }, undefined, undefined, {} as never);
	// Refused, not rewritten. A caller that wrote `agent: "claude"` meant Claude; running Devin and reporting a
	// session would be the rename doing the one thing a rename must not do: change what the call means.
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /always means Devin/);
	assert.match(res.content[0].text, /Call delegate_task with agent='claude'/);
	assert.deepStrictEqual(seen, []);
});

test("devin_status's `complete` asks delegate_status for the full transcript", async () => {
	// The parameter was renamed along with the tool. Translate it, or a prompt written against the old name
	// gets three messages where it asked for the whole conversation, and a note that says nothing about it.
	const { spec, seen } = fakeTarget("delegate_status");
	const alias = must(
		aliasSpecs([spec]).find((s) => s.name === "devin_status"),
		"the alias",
	);
	await alias.execute("id-1", { session_id: "s", complete: true }, undefined, undefined, {} as never);
	// `agent` is pinned here the way the old name pinned Devin by construction — `delegate_status` gained an
	// agent filter, and an unpinned `devin_status` would list Claude sessions under a Devin name.
	assert.deepStrictEqual(seen, [{ session_id: "s", full: true, agent: "devin" }]);
});

test("devin_restart does not pin an agent the old tool never had", async () => {
	// `delegate_restart`'s `agent` means "restart on this driver". Forcing devin would take a Claude session
	// and restart it on Devin with Claude's model id — a vendor switch, mid-task, in silence.
	const { spec, seen } = fakeTarget("delegate_restart");
	const alias = must(
		aliasSpecs([spec]).find((s) => s.name === "devin_restart"),
		"the alias",
	);
	await alias.execute("id-1", { session_id: "s" }, undefined, undefined, {} as never);
	assert.deepStrictEqual(seen, [{ session_id: "s" }]);
});

test("the wrapped call passes the signal, context and update callback through unchanged", async () => {
	const { spec } = fakeTarget("delegate_task");
	const alias = must(
		aliasSpecs([spec]).find((s) => s.name === "devin_delegate"),
		"the alias",
	);
	const controller = new AbortController();
	const ctx = { cwd: "/repo" } as never;
	let got: { signal?: AbortSignal; ctx?: unknown } = {};
	spec.execute = async (_id, _params, signal, _onUpdate, c) => {
		got = { signal, ctx: c };
		return { content: [{ type: "text", text: "ok" }] };
	};
	await alias.execute("id-1", { prompt: "x" }, controller.signal, undefined, ctx);
	assert.strictEqual(got.signal, controller.signal, "cancel must still reach the wrapped tool");
	assert.strictEqual(got.ctx, ctx);
});

test("the rename note is appended, so the answer stays where old callers read it", async () => {
	// `content[0]` is what a pre-rename caller (and the queue suite) parses. A notice that displaces the
	// payload would break the callers it exists to ease.
	const { spec } = fakeTarget("delegate_status");
	const alias = must(
		aliasSpecs([spec]).find((s) => s.name === "devin_status"),
		"the alias",
	);
	const res = await alias.execute("id", {}, undefined, undefined, {} as never);
	assert.strictEqual(res.content[0].text, "delegate_status answered");
	assert.match(res.content[res.content.length - 1].text, /\[deprecated\] devin_status → delegate_status/);
});

test("a result with no content array is returned as it came", () => {
	// An unexpected shape from a future pi must not be "fixed" into a text result by a deprecation layer.
	const shape = { structured: { a: 1 } };
	assert.strictEqual(withNote(shape, "note"), shape);
	assert.strictEqual(withNote(undefined, "note"), undefined);
	assert.strictEqual(withNote(null, "note"), null);
});

test("every alias names the same horizon, and the note names the tool to switch to", () => {
	for (const [legacy, current] of Object.entries(DEPRECATED_ALIASES)) {
		const note = renameNote(legacy, current);
		assert.ok(note.startsWith(`[deprecated] ${legacy} → ${current}`), note);
		assert.ok(note.includes("one minor version"), "the removal horizon is stated, not implied");
		assert.ok(note.endsWith(`switch to ${current}.`) || note.includes(current), note);
	}
	assert.match(ALIAS_NOTE, /devin_\* names are kept for one minor version/);
});

test("the retired command list is the command, with its slash", () => {
	assert.deepStrictEqual(Object.keys(DEPRECATED_COMMANDS), ["/devin"]);
	assert.strictEqual(DEPRECATED_COMMANDS["/devin"], "/delegate");
});

test("a missing parameter object does not become undefined-property noise", async () => {
	const { spec, seen } = fakeTarget("delegate_task");
	const alias = must(
		aliasSpecs([spec]).find((s) => s.name === "devin_delegate"),
		"the alias",
	);
	await alias.execute("id", undefined, undefined, undefined, {} as never);
	assert.deepStrictEqual(seen, [{ agent: "devin" }], "the agent is forced even with no parameters at all");
});
