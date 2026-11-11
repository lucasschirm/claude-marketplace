// Run with: node --test test/test-delegate-registry.ts
import { test } from "node:test";
import assert from "node:assert";
import {
	admit,
	agentDescription,
	DEFAULT_AGENT,
	describeAgents,
	findAgent,
	guardedClis,
	listDrivers,
	modelDescription,
	thinkingDescription,
} from "../extensions/lib/delegate/registry.ts";
import { claudeDriver } from "../extensions/lib/delegate/drivers/claude.ts";
import { devinDriver } from "../extensions/lib/delegate/drivers/devin.ts";

const ok = (r: ReturnType<typeof admit>) => {
	assert.strictEqual(r.ok, true, `expected admission to succeed: ${r.ok ? "" : r.error}`);
	if (r.ok) {
		return r;
	}
	throw new Error("unreachable");
};

test("an omitted agent is Devin, for one release", () => {
	const r = ok(admit({ prompt: "x" }));
	assert.strictEqual(r.driver.id, DEFAULT_AGENT);
	assert.strictEqual(r.driver.id, "devin");
});

test("an unknown agent names the ones that exist", () => {
	const r = admit({ agent: "codex", prompt: "x" });
	assert.strictEqual(r.ok, false);
	if (!r.ok) {
		assert.strictEqual(r.code, "UNKNOWN_AGENT");
		for (const id of ["devin", "claude"]) {
			assert.ok(r.error.includes(id), `error lists ${id}`);
		}
	}
});

test("agent lookup is whitespace- and case-tolerant, and blank means the default", () => {
	assert.strictEqual(findAgent(" Claude ").ok, true);
	assert.strictEqual(findAgent("CLAUDE").ok && findAgent("CLAUDE").ok === true, true);
	assert.strictEqual(findAgent("").ok, true);
	assert.strictEqual(findAgent("").ok ? findAgent("").driver.id : "", DEFAULT_AGENT);
	assert.strictEqual(findAgent("null").ok, false);
});

test("thinking is refused for the agent that has no such control, with the alternative named", () => {
	const r = admit({ agent: "devin", thinking: "high", prompt: "x" });
	assert.strictEqual(r.ok, false);
	if (!r.ok) {
		assert.strictEqual(r.code, "THINKING_UNSUPPORTED");
		// Silently dropping it would let the caller believe it had asked for more thinking, so the
		// refusal has to say what to do instead.
		assert.match(r.error, /model/);
	}
	const claude = ok(admit({ agent: "claude", thinking: "high", prompt: "x" }));
	assert.strictEqual(claude.selection.thinking, "high");
});

test("an unknown thinking level is rejected rather than rounded to a neighbor", () => {
	const r = admit({ agent: "claude", thinking: "very-high", prompt: "x" });
	assert.strictEqual(r.ok, false);
	if (!r.ok) {
		assert.strictEqual(r.code, "INVALID_THINKING");
	}
});

test("an unknown model warns and is passed through", () => {
	// Devin resolves fuzzy model names itself and its advertised ACP vocabulary is narrower than what
	// `--model` accepts. A hard refusal here would break delegation the first time upstream gains a model.
	const r = ok(admit({ agent: "devin", model: "swe-3-ultra", prompt: "x" }));
	assert.strictEqual(r.selection.model, "swe-3-ultra");
	assert.strictEqual(r.warnings.length, 1, "exactly one warning");
	assert.match(r.warnings[0], /not in Devin's known model list/);
	// A known model is silent, so a warning always means something.
	assert.strictEqual(ok(admit({ agent: "devin", model: "swe-2-high", prompt: "x" })).warnings.length, 0);
});

test("Claude's model catalogue is empty because nobody can list someone else's install", () => {
	// An empty `values` means validation defers to the wire — never a hardcoded guess about a gateway or
	// an allowlist this repository cannot see.
	const cat = claudeDriver.models();
	assert.deepStrictEqual(cat.values, []);
	assert.strictEqual(ok(admit({ agent: "claude", model: "whatever-the-operator-configured", prompt: "x" })).warnings.length, 0);
});

test("an unmappable mode is refused before a slot is spent", () => {
	const r = admit({ agent: "devin", mode: "yolo", prompt: "x" });
	assert.strictEqual(r.ok, false);
	if (!r.ok) {
		assert.strictEqual(r.code, "INVALID_MODE");
	}
	// An alias the driver knows is kept verbatim, and resolved to the wire id only at session setup.
	assert.strictEqual(ok(admit({ agent: "devin", mode: "auto", prompt: "x" })).selection.mode, "auto");
});

test("the default mode is each driver's own default", () => {
	assert.strictEqual(ok(admit({ agent: "devin", prompt: "x" })).selection.mode, devinDriver.defaultMode());
	assert.strictEqual(ok(admit({ agent: "claude", prompt: "x" })).selection.mode, claudeDriver.defaultMode());
});

test("generated tool text covers every registered driver", () => {
	// The tool descriptions used to be hand-written sentences that hardcoded Devin. These three
	// assertions are what stop that happening again: add a driver, and the text has to mention it.
	const agents = agentDescription();
	for (const d of listDrivers()) {
		assert.ok(agents.includes(d.id), `agent description mentions ${d.id}`);
	}
	assert.ok(agents.includes(`${DEFAULT_AGENT} (default)`), "the default is marked as such");

	const thinking = thinkingDescription();
	assert.ok(thinking.includes("devin"), "thinking text says which agents refuse it");
	assert.ok(thinking.includes("claude"));

	const models = modelDescription();
	assert.ok(models.includes(devinDriver.models().default), "Devin's default model is named in the model text");
	assert.ok(models.includes(claudeDriver.models().default));
});

test("/delegate agents reports where each driver's limits are enforced", () => {
	const lines = describeAgents();
	assert.strictEqual(lines.length, listDrivers().length);
	const devin = lines.find((l) => l.startsWith("devin"));
	assert.ok(devin);
	assert.match(devin, /blocks-devin-cli/);
	assert.match(devin, /no-thinking/);
	const claude = lines.find((l) => l.startsWith("claude"));
	assert.match(claude ?? "", /thinking/);
	assert.match(claude ?? "", /cli-unguarded/);
});

test("only a driver that opts in blocks its own CLI, and a driver may guard an adapter too", () => {
	// `claude` is absent on purpose (it is the operator's own CLI); `agy` guards the adapter as well, because
	// `agy-acp` starts the same work behind a name a guard watching `agy` would never match.
	assert.deepEqual(guardedClis(), ["devin", "agy-acp", "agy"]);
});

test("a driver without an in-band selection channel is not an error", () => {
	// Devin's model is a spawn flag; `session/set_config_option(model)` answers -32602 for ids outside
	// its vocabulary, which is why it has no applySelection at all.
	assert.strictEqual(devinDriver.applySelection, undefined);
	assert.strictEqual(typeof claudeDriver.applySelection, "function");
});
