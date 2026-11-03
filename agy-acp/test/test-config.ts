// Issue #55: mode, model and effort selection.
//
// The units first (the rules, with no process involved), then the same choices driven over the real
// ACP stack against the fake agy. The acceptance criteria they cover:
//
//   - the mode list is what the bridge enforces, `bypass` only when the operator enabled it;
//   - `agy models` is fetched once per process, behind a timeout, and a failure is a supported
//     outcome rather than a broken session/new;
//   - an unknown model is -32602 carrying the available list; a known one reaches the next agy
//     process as --model, with the conversation resumed (--conversation) rather than restarted;
//   - --effort is advertised over ACP (configOptions + session/set_config_option) as the five levels
//     agy documents, with the pair agy itself refuses rejected up front;
//   - --sandbox passes through when configured, and the mode's --mode flag rides on the next spawn.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startAgyAcpServer, type AgyLaunchOptions } from "../src/server.ts";
import { agyArgs } from "../src/agy/args.ts";
import { lifecycleConfigFromEnv } from "../src/config.ts";
import { AGY_EFFORTS, effortConflict, modelEffort, parseModelsTable } from "../src/agy/models.ts";
import { agyModeFlag, offeredModes, SessionSelection } from "../src/config-options.ts";

const FAKE = fileURLToPath(new URL("./fake-agy.ts", import.meta.url));
const MODELS_TSV = fileURLToPath(new URL("./fixtures/models/agy-1.4.2.tsv", import.meta.url));

// ---------------------------------------------------------------- the units

test("agyArgs carries the selection flags, and only the ones that were chosen", () => {
	assert.deepStrictEqual(agyArgs({}), ["--input-format", "stream-json", "--output-format", "stream-json", "-p="]);
	assert.deepStrictEqual(agyArgs({ model: "gemini-3.8-flash", effort: "low", mode: "plan", sandbox: true, skipPermissions: true }), [
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"-p=",
		"--model",
		"gemini-3.8-flash",
		"--effort",
		"low",
		"--mode",
		"plan",
		"--sandbox",
		"--dangerously-skip-permissions",
	]);
});

test("the mode -> --mode mapping: the two agy has, and none for the two it has not", () => {
	// agy 1.4.2 accepts `accept-edits | auto | plan`. `default` is what agy does with no flag, `bypass`
	// is already --dangerously-skip-permissions, and `auto` is account-gated and not ours to ask for.
	assert.strictEqual(agyModeFlag("accept-edits"), "accept-edits");
	assert.strictEqual(agyModeFlag("plan"), "plan");
	assert.strictEqual(agyModeFlag("default"), undefined);
	assert.strictEqual(agyModeFlag("bypass"), undefined);
});

test("bypass is off the menu until the operator puts it there", () => {
	const ids = (allow: boolean) => offeredModes(allow).map((m) => m.id);
	assert.deepStrictEqual(ids(false), ["default", "accept-edits", "plan"]);
	assert.deepStrictEqual(ids(true), ["default", "accept-edits", "plan", "bypass"]);
	const locked = new SessionSelection({ sandbox: false, allowBypass: false });
	assert.throws(() => locked.setMode("bypass"), /unknown mode: bypass[\s\S]*AGY_ACP_ALLOW_BYPASS/);
	assert.strictEqual(locked.mode, "default", "a refused mode leaves the session where it was");
	const open = new SessionSelection({ sandbox: false, allowBypass: true });
	open.setMode("bypass");
	assert.strictEqual(open.mode, "bypass");
	// The environment is the only other way in, and only a literal 1 counts.
	assert.strictEqual(lifecycleConfigFromEnv({}).allowBypass, false);
	assert.strictEqual(lifecycleConfigFromEnv({ AGY_ACP_ALLOW_BYPASS: "1" }).allowBypass, true);
	assert.strictEqual(lifecycleConfigFromEnv({ AGY_ACP_ALLOW_BYPASS: "true" }).allowBypass, false, "yes is not 1");
	assert.strictEqual(lifecycleConfigFromEnv({ AGY_ACP_SANDBOX: "1" }).sandbox, true);
	assert.strictEqual(lifecycleConfigFromEnv({ AGY_ACP_MODEL: " gemini-3.8-flash ", AGY_ACP_EFFORT: "low" }).model, "gemini-3.8-flash");
});

test("`agy models` stdout parses to ids and names, and junk is not a model", () => {
	const models = parseModelsTable(fs.readFileSync(MODELS_TSV, "utf8"));
	assert.strictEqual(models.length, 13, "the 13 models the recorded listing carries");
	assert.deepStrictEqual(models[0], { modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" });
	assert.deepStrictEqual(models.at(-1), { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" });
	// The spinner, blanks and a name with no id are output a model list can contain; none of them is a
	// model, and a listing that yields nothing must read as "no listing" (the caller falls back).
	assert.deepStrictEqual(parseModelsTable("\nFetching available models...\nnospace\nsolo-id\t\n"), []);
	// The id is the first field; everything after it is the name, spaces included.
	assert.deepStrictEqual(parseModelsTable("a-b\tOne two"), [{ modelId: "a-b", name: "One two" }]);
});

test("the effort pair agy is known to refuse is refused here, with its words", () => {
	// Recorded against agy 1.4.2: `--model gemini-3.8-flash-low --effort high` dies at startup with
	// "--model gemini-3.8-flash-low conflicts with --effort=high". Catching that here is what stops a
	// selection from breaking every later turn with an error the client cannot act on.
	assert.match(effortConflict("gemini-3.8-flash-low", "high") ?? "", /carries low effort/);
	assert.strictEqual(effortConflict("gemini-3.8-flash-low", "low"), null, "the same effort is not a conflict");
	assert.strictEqual(effortConflict("gemini-3.8-flash", "max"), null, "no suffix: agy is the authority on what it supports");
	assert.strictEqual(effortConflict("default", "max"), null, "no model chosen: --effort goes on its own");
	assert.strictEqual(modelEffort("gemini-3.8-flash"), undefined);
	assert.strictEqual(modelEffort("gpt-oss-120b-medium"), "medium");
});

test("a selection validates what a client can send, and says what it meant instead", () => {
	const models = parseModelsTable(fs.readFileSync(MODELS_TSV, "utf8"));
	const sel = new SessionSelection({ model: "gemini-3.8-flash-low", sandbox: false, allowBypass: false });
	// Unknown model: refused, and the message carries the ids that are not unknown (the sentinel too).
	assert.throws(
		() => sel.setModel("gemini-nonexistent-xyz", models),
		(err: Error) => {
			assert.match(err.message, /unknown model: gemini-nonexistent-xyz/);
			assert.match(err.message, /available: default, gemini-4-argon-medium/);
			assert.match(err.message, /gpt-oss-120b-medium/);
			return true;
		},
	);
	assert.strictEqual(sel.model, "gemini-3.8-flash-low", "the rejected selection changed nothing");
	// With no list there is no verdict to give: the id goes through and agy judges it at startup.
	sel.setModel("a-custom-model-in-agy-settings", null);
	assert.strictEqual(sel.model, "a-custom-model-in-agy-settings");
	sel.setModel("default", models);
	assert.strictEqual(sel.flags().model, undefined, "the sentinel passes no --model");
	// Effort: agy's five levels, the sentinel, and nothing else.
	assert.throws(() => sel.setEffort("ultra"), /unknown effort: ultra \(available: default, low, medium, high, xhigh, max\)/);
	sel.setModel("gemini-3.8-flash-low", models);
	assert.throws(() => sel.setEffort("high"), /conflicts|--effort/);
	assert.strictEqual(sel.effort, "default", "and the effort stays where it was");
	sel.setModel("default", models);
	sel.setEffort("max");
	assert.deepStrictEqual(sel.flags(), { model: undefined, effort: "max", mode: undefined, sandbox: false });
	assert.strictEqual(AGY_EFFORTS.join(","), "low,medium,high,xhigh,max", "agy --help's list");
});

test("the mode changes the policy now; the model and effort need a new process", () => {
	const sel = new SessionSelection({ model: "gemini-3.8-flash-low", sandbox: false, allowBypass: true });
	const before = sel.relaunchKey();
	sel.setMode("plan");
	assert.strictEqual(sel.relaunchKey(), before, "a mode needs no respawn: the bridge enforces it, and --mode rides on the next spawn");
	assert.strictEqual(sel.flags().mode, "plan", "but the next spawn does carry it");
	sel.setModel("claude-opus-5-5-high", parseModelsTable(fs.readFileSync(MODELS_TSV, "utf8")));
	assert.notStrictEqual(sel.relaunchKey(), before, "a model does: its --model was fixed when the child was exec'd");
});

test("the selectors agy-acp advertises are ACP-shaped", () => {
	const sel = new SessionSelection({ model: "gemini-3.8-flash-low", effort: "low", sandbox: false, allowBypass: false });
	sel.setReportedModel("gemini-3.8-flash-low");
	const [model, effort] = sel.configOptions(parseModelsTable(fs.readFileSync(MODELS_TSV, "utf8")));
	assert.deepStrictEqual([model.id, model.category, model.type, model.currentValue], ["model", "model", "select", "gemini-3.8-flash-low"]);
	assert.deepStrictEqual(model.options[0], {
		value: "default",
		name: "agy default",
		description: "No --model flag: whatever agy chooses when given none",
	});
	assert.strictEqual(model.options.find((o) => o.value === "claude-sonnet-5-5-high")?.name, "Claude Sonnet 5.5 (High)");
	assert.deepStrictEqual(
		[effort.id, effort.category, effort.currentValue],
		["effort", "thought_level", "low"],
		"agy's --effort, on ACP's thought_level category",
	);
	// A model agy reported but did not list (a custom model in its settings) is still selectable, and
	// still named, because it is what the session is actually running.
	const odd = new SessionSelection({ sandbox: false, allowBypass: false });
	odd.setReportedModel("my-custom-model");
	const [oddModel] = odd.configOptions(null);
	assert.strictEqual(oddModel.currentValue, "my-custom-model");
	assert.ok(
		oddModel.options.some((o) => o.value === "my-custom-model"),
		"advertising a model the client cannot pick is a trap",
	);
});

// ---------------------------------------------------------------- over the wire, with the fake

interface Frame {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** The in-process server, the fake as agy, and every frame it sent unrequested. */
function startHarness(fixture: string, extraEnv?: Record<string, string>, extraLaunch?: Partial<AgyLaunchOptions>) {
	const input = new PassThrough();
	const output = new PassThrough();
	const logs: string[] = [];
	const notes: Frame[] = [];
	const server = startAgyAcpServer({
		input,
		output,
		log: (l) => logs.push(l),
		agy: {
			argvPrefix: [process.execPath, FAKE],
			env: {
				...process.env,
				FAKE_AGY_FIXTURE: fixture,
				FAKE_AGY_INIT_DELAY_MS: "5",
				FAKE_AGY_LINE_GAP_MS: "3",
				FAKE_AGY_CHUNK_GAP_MS: "1",
				...(extraEnv ?? {}),
			},
			probeTimeoutMs: 4000,
			graceMs: 500,
			termMs: 300,
			// The recorded argv names a model; the fake compares it unless a test says otherwise.
			model: "gemini-3.8-flash-low",
			...(extraLaunch ?? {}),
		},
	});
	const pending = new Map<number, (f: Frame) => void>();
	let buffer = "";
	output.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const i = buffer.indexOf("\n");
			if (i < 0) break;
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (line.trim() === "") continue;
			const frame = JSON.parse(line) as Frame;
			if (frame.id !== undefined) {
				const done = pending.get(frame.id);
				if (done) {
					pending.delete(frame.id);
					done(frame);
				}
			} else if (frame.method) notes.push(frame);
		}
	});
	let nextId = 1;
	return {
		server,
		logs,
		/** The session/update notifications, in order, each tagged with the session it was sent on. */
		updates: () =>
			notes
				.filter((n) => n.method === "session/update")
				.map((n): Record<string, unknown> => ({ sessionId: n.params?.sessionId, ...(n.params?.update as Record<string, unknown>) })),
		/** The session ids that received an update, in order. */
		updateSessions: () => notes.filter((n) => n.method === "session/update").map((n) => n.params?.sessionId as string),
		close: () => input.end(),
		request: (method: string, params: unknown) =>
			new Promise<Frame>((resolve) => {
				const id = nextId++;
				const timer = setTimeout(() => resolve({ error: { code: 0, message: `request ${method} timed out` } }), 20000);
				timer.unref();
				pending.set(id, (frame) => {
					clearTimeout(timer);
					resolve(frame);
				});
				input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			}),
	};
}

/** The launches the fake recorded: one argv per agy process the session started. */
function recordedLaunches(logFile: string): string[][] {
	if (!fs.existsSync(logFile)) return [];
	return fs
		.readFileSync(logFile, "utf8")
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => (JSON.parse(l) as { argv: string[] }).argv);
}

function promptParams(sessionId: string, text: string): Record<string, unknown> {
	return { sessionId, prompt: [{ type: "text", text }] };
}

async function newSession(h: ReturnType<typeof startHarness>): Promise<string> {
	const frame = await h.request("session/new", { cwd: process.cwd(), mcpServers: [] });
	const sid = (frame.result as { sessionId?: string })?.sessionId;
	assert.strictEqual(typeof sid, "string", `session/new: ${JSON.stringify(frame.error ?? frame.result)}`);
	return sid as string;
}

/** A temp dir for the argv log, removed with the test. */
function argvLog(): { file: string; cleanup: () => void } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-argv-"));
	const file = path.join(dir, "argv.jsonl");
	// An existing file would carry the previous test's launches; the fake appends.
	fs.writeFileSync(file, "");
	return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** The prompts a fixture recorded, in order: fake-agy compares them and dies on a mismatch. */
function recordedPrompts(fixture: string): string[] {
	const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(FAKE), "fixtures", "stream", `${fixture}.meta.json`), "utf8")) as {
		inputLines?: string[];
	};
	return (meta.inputLines ?? []).map((line) => {
		const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
		return typeof content === "string" ? content : ((content as Array<{ text?: string }>)?.[0]?.text ?? "");
	});
}

test("session/new advertises the model list, once per process, and the selectors carry it", async () => {
	const { file, cleanup } = argvLog();
	const h = startHarness("input-event-init", { FAKE_AGY_ARGV_LOG: file });
	try {
		const first = await newSession(h);
		const frame = await h.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const result = frame.result as {
			models: { currentModelId: string; availableModels: string[] };
			configOptions: Array<{ id: string; currentValue: string; options: Array<{ value: string; name: string }> }>;
		};
		assert.ok(first, "two sessions, one process");
		assert.strictEqual(result.models.currentModelId, "gemini-3.8-flash-low", "the model agy's init reported");
		assert.ok(result.models.availableModels.includes("claude-opus-5-5-high"), "agy's whole list, not only the running model");
		const model = result.configOptions.find((o) => o.id === "model");
		assert.ok(model, "the model selector");
		assert.strictEqual(model.options.find((o) => o.value === "gemini-3.8-flash-low")?.name, "Gemini 3.8 Flash (Low)");
		// Once per process: two sessions/new and their two agy children, and exactly one `agy models`.
		const listing = recordedLaunches(file).filter((argv) => argv[0] === "models");
		assert.strictEqual(listing.length, 1, `agy models ran ${listing.length} times for two sessions`);
	} finally {
		h.close();
		cleanup();
	}
});

test("a model list that cannot be had is a supported state, not a broken session", async () => {
	const h = startHarness("input-event-init", { FAKE_AGY_MODELS_FAIL: "1" });
	try {
		const sid = await newSession(h);
		const frame = await h.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const result = frame.result as {
			models: { currentModelId: string; availableModels: string[] };
			_meta?: { models?: { listed?: boolean } };
		};
		assert.ok(sid, "the first session came up despite the failed listing");
		assert.strictEqual(result._meta?.models?.listed, false, "reported rather than hidden");
		assert.deepStrictEqual(result.models.availableModels, ["gemini-3.8-flash-low"], "what agy reports per session is all we claim");
		assert.ok(
			h.logs.some((l) => l.includes("agy models failed")),
			`the failure is logged once: ${JSON.stringify(h.logs)}`,
		);
	} finally {
		h.close();
	}
});

test("a model list that never answers is given up on, and session/new still answers", async () => {
	const h = startHarness("input-event-init", { FAKE_AGY_MODELS_DELAY_MS: "10000" }, { modelsTimeoutMs: 300 });
	try {
		const frame = await h.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const result = frame.result as { _meta?: { models?: { listed?: boolean } } };
		assert.strictEqual(result._meta?.models?.listed, false, "the timeout is a failed listing, not a hung session/new");
		assert.ok(
			h.logs.some((l) => l.includes("timed out after 300 ms")),
			`the timeout says so: ${JSON.stringify(h.logs)}`,
		);
	} finally {
		h.close();
	}
});

test("an unknown model is -32602 carrying the available list, and changes nothing", async () => {
	const { file, cleanup } = argvLog();
	const h = startHarness("simple-multiturn-textblocks", { FAKE_AGY_ARGV_LOG: file });
	const prompts = recordedPrompts("simple-multiturn-textblocks");
	try {
		const sid = await newSession(h);
		const frame = await h.request("session/set_model", { sessionId: sid, modelId: "gemini-nonexistent-xyz" });
		assert.strictEqual(frame.error?.code, -32602, `expected -32602, got ${JSON.stringify(frame)}`);
		assert.match(frame.error?.message ?? "", /unknown model: gemini-nonexistent-xyz/);
		assert.match(frame.error?.message ?? "", /gpt-oss-120b-medium/, "the message lists what agy offers");
		const data = frame.error?.data as { availableModels?: string[] };
		assert.ok(data?.availableModels?.includes("claude-opus-5-5-low"), "and the data carries it machine-readably");
		assert.deepStrictEqual(
			h.updates().filter((u) => u.sessionUpdate === "config_option_update"),
			[],
			"a refused selection pushes nothing to the other listeners",
		);
		const turn = await h.request("session/prompt", promptParams(sid, prompts[0]));
		assert.strictEqual((turn.result as { stopReason?: string })?.stopReason, "end_turn", "the turn runs on the child that was up");
		// The proof it changed nothing: the only launch still carries the model the session started on.
		const launches = recordedLaunches(file).filter((argv) => argv[0] !== "models");
		assert.strictEqual(launches.length, 1, "no respawn for a selection that was refused");
		assert.ok(launches[0].includes("gemini-3.8-flash-low"), JSON.stringify(launches[0]));
	} finally {
		h.close();
		cleanup();
	}
});

test("a model change reaches the NEXT agy process, resuming the conversation", async () => {
	const { file, cleanup } = argvLog();
	const h = startHarness(
		"simple-multiturn-textblocks",
		{
			FAKE_AGY_ARGV_LOG: file,
			// A respawn, and a model other than the recorded one: both are this test's point.
			FAKE_AGY_ALLOW_RESUME: "1",
			FAKE_AGY_MODEL_ALLOW: "gemini-3.8-flash-low,gemini-3.8-flash-high",
		},
		{},
	);
	const prompts = recordedPrompts("simple-multiturn-textblocks");
	try {
		const sid = await newSession(h);
		const turn1 = await h.request("session/prompt", promptParams(sid, prompts[0]));
		assert.strictEqual((turn1.result as { stopReason?: string })?.stopReason, "end_turn", "the running child finishes its turn");

		const set = await h.request("session/set_config_option", { sessionId: sid, configId: "model", value: "gemini-3.8-flash-high" });
		const options = (set.result as { configOptions: Array<{ id: string; currentValue: string }> }).configOptions;
		assert.strictEqual(options.find((o) => o.id === "model")?.currentValue, "gemini-3.8-flash-high", "the response says the new value");
		const pushed = h.updates().filter((u) => u.sessionUpdate === "config_option_update");
		assert.strictEqual(
			(pushed.at(-1)?.configOptions as Array<{ id: string; currentValue: string }>)?.[0]?.currentValue,
			"gemini-3.8-flash-high",
		);

		// Nothing about the live child changed yet - it cannot: --model is an exec-time flag.
		const before = recordedLaunches(file).filter((argv) => argv[0] !== "models");
		assert.strictEqual(before.length, 1, "setting a model does not disturb the child that is up");

		// The respawn replays the fixture from its start, so the prompt is recorded line #1 again.
		const turn2 = await h.request("session/prompt", promptParams(sid, prompts[0]));
		assert.strictEqual((turn2.result as { stopReason?: string })?.stopReason, "end_turn", "the next turn runs on the new child");
		const launches = recordedLaunches(file).filter((argv) => argv[0] !== "models");
		assert.strictEqual(launches.length, 2, `expected a respawn for the next turn: ${JSON.stringify(launches)}`);
		assert.ok(
			launches[1].includes("--model") && launches[1][launches[1].indexOf("--model") + 1] === "gemini-3.8-flash-high",
			"the new model",
		);
		assert.strictEqual(launches[1][launches[1].indexOf("--conversation") + 1], sid, "the conversation resumed rather than restarted");
	} finally {
		h.close();
		cleanup();
	}
});

test("effort reaches the next launch; a mode rides on it without forcing the respawn", async () => {
	const { file, cleanup } = argvLog();
	const h = startHarness(
		"simple-multiturn-textblocks",
		{
			FAKE_AGY_ARGV_LOG: file,
			FAKE_AGY_ALLOW_RESUME: "1",
			FAKE_AGY_MODEL_ALLOW: "gemini-3.8-flash-low,gemini-3.8-flash",
		},
		{ sandbox: true },
	);
	const prompts = recordedPrompts("simple-multiturn-textblocks");
	try {
		const sid = await newSession(h);
		const turn1 = await h.request("session/prompt", promptParams(sid, prompts[0]));
		assert.strictEqual((turn1.result as { stopReason?: string })?.stopReason, "end_turn", "the first turn ran");
		const first = recordedLaunches(file).filter((argv) => argv[0] !== "models")[0];
		assert.ok(first.includes("--sandbox"), "--sandbox passes through when the operator configured it");
		assert.ok(!first.includes("--effort"), "and no flag at all when nothing was chosen");

		await h.request("session/set_mode", { sessionId: sid, modeId: "plan" });
		await h.request("session/set_config_option", { sessionId: sid, configId: "effort", value: "low" });
		const turn2 = await h.request("session/prompt", promptParams(sid, prompts[0]));
		assert.strictEqual((turn2.result as { stopReason?: string })?.stopReason, "end_turn", "the effort changed nothing about the turn");

		const launches = recordedLaunches(file).filter((argv) => argv[0] !== "models");
		const second = launches[1];
		assert.ok(second, "the effort forced the next turn onto a new child");
		assert.strictEqual(second[second.indexOf("--effort") + 1], "low", "--effort reaches agy");
		assert.ok(second.includes("--mode"), "the mode flag rode along on the launch the effort needed");
		assert.strictEqual(second[second.indexOf("--mode") + 1], "plan");
		assert.ok(second.includes("--sandbox"), "and the operator's sandbox is still there");
	} finally {
		h.close();
		cleanup();
	}
});

test("an effort the model contradicts is refused before it can break a turn", async () => {
	const h = startHarness("simple-multiturn-textblocks");
	try {
		const sid = await newSession(h);
		// The session runs gemini-3.8-flash-low (its id carries the effort). Asking for high is the
		// pair agy refuses at startup, so it must not survive to the next turn as a dead child.
		const frame = await h.request("session/set_config_option", { sessionId: sid, configId: "effort", value: "high" });
		assert.strictEqual(frame.error?.code, -32602, JSON.stringify(frame));
		assert.match(frame.error?.message ?? "", /carries low effort/);
		const unknown = await h.request("session/set_config_option", { sessionId: sid, configId: "effort", value: "ultra" });
		assert.strictEqual(unknown.error?.code, -32602);
		assert.match(unknown.error?.message ?? "", /default, low, medium, high, xhigh, max/);
		const modeAsOption = await h.request("session/set_config_option", { sessionId: sid, configId: "mode", value: "plan" });
		assert.strictEqual(modeAsOption.error?.code, -32602, "a mode has its own ACP method; the selector route says so");
		assert.match(modeAsOption.error?.message ?? "", /session\/set_mode/);
	} finally {
		h.close();
	}
});

test("the selection is per session, not per process", async () => {
	// Two layers, because one fake conversation id cannot hold two live sessions: the units show the
	// state is per selection, the wire shows a new session starts from the operator's launch, not from
	// whatever the previous session of the same process picked.
	const one = new SessionSelection({ sandbox: false, allowBypass: false });
	const other = new SessionSelection({ sandbox: false, allowBypass: false });
	other.setEffort("max");
	one.setMode("plan");
	assert.strictEqual(one.effort, "default", "a selection is not a singleton");
	assert.strictEqual(other.mode, "default");
	const h = startHarness("simple-multiturn-textblocks");
	try {
		const first = await newSession(h);
		const chosen = await h.request("session/set_config_option", { sessionId: first, configId: "model", value: "claude-opus-5-5-high" });
		assert.strictEqual(
			(chosen.result as { configOptions: Array<{ id: string; currentValue: string }> }).configOptions.find((o) => o.id === "model")
				?.currentValue,
			"claude-opus-5-5-high",
		);
		const second = await newSession(h);
		const frame = await h.request("session/set_config_option", { sessionId: second, configId: "effort", value: "default" });
		const fresh = (frame.result as { configOptions: Array<{ id: string; currentValue: string }> }).configOptions;
		// The operator's launch, not the other session's choice: --model came from the launch options, and
		// the selection that consumed it belongs to the first session alone.
		assert.strictEqual(fresh.find((o) => o.id === "model")?.currentValue, "gemini-3.8-flash-low", "the new session never inherited it");
	} finally {
		h.close();
	}
});

test("session/set_model and the model selector are the same action, and both need a live session", async () => {
	const h = startHarness("input-event-init");
	try {
		const sid = await newSession(h);
		const missing = await h.request("session/set_model", { sessionId: "nope", modelId: "default" });
		assert.strictEqual(missing.error?.code, -32602, "unknown session");
		const noModel = await h.request("session/set_model", { sessionId: sid });
		assert.strictEqual(noModel.error?.code, -32602, "modelId is required");
		const wrongType = await h.request("session/set_config_option", { sessionId: sid, configId: "model", value: 7 });
		assert.strictEqual(wrongType.error?.code, -32602, "a selector takes a string");
		const ok = await h.request("session/set_model", { sessionId: sid, modelId: "default" });
		assert.strictEqual(ok.error, undefined, "the sentinel is a valid choice");
		const pushed = h.updates().filter((u) => u.sessionUpdate === "config_option_update");
		assert.ok(pushed.length > 0, "and it is announced, so a second client of the session agrees");
	} finally {
		h.close();
	}
});
