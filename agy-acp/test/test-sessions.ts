// Component tests for the session layer: the full ACP stack - JSON-RPC over stdio streams, the
// session registry, the real AgyProcess driver - run in-process against the fixture-replaying
// fake agy (and the crash fake) under test/.
//
// Acceptance coverage for issue #52:
//   - session/new: cwd validation, the probe, the modes/models stubs, mcpServers reported via
//     _meta (never silently dropped), startup failure as an error with the stderr tail;
//   - session/prompt: text / resource-link / embedded-text flattening, image and audio rejected
//     with -32602, one turn at a time (-32002 turn in progress);
//   - the update mapping (snapshots of the full session/update sequence per fixture scenario);
//   - turn endings: end_turn with the usage delta in _meta; headless auto-deny surfaced (never a
//     silent end_turn); result ERROR and a child crash mid-turn as JSON-RPC errors - an error is
//     never reported as end_turn, asserted across all reachable error fixtures;
//   - respawn: a needsRespawn session relaunches agy with --conversation <id> on the next prompt;
//     a respawn that starts a fresh conversation (a different init id) is refused, not accepted
//     with negative usage deltas;
//   - session lifecycle: a session/new in flight when the connection closes is disposed, not
//     registered (no leaked child); the version gate runs with the launch env; connection close
//     disposes the sessions: no fake agy survives.
//   - prompt flattening: the resource-link name is carried; a blob resource is rejected (-32602),
//     never silently dropped;
//   - a subagent tool's terminal state (which arrives as step_type "subagent") settles the tracked
//     tool call as completed, not failed.
import * as assert from "node:assert";
import * as fs from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startAgyAcpServer, type AgyAcpServer, type AgyLaunchOptions } from "../src/server.ts";
import { flattenPrompt } from "../src/prompt.ts";

const FAKE = fileURLToPath(new URL("./fake-agy.ts", import.meta.url));
const FAKE_CRASH = fileURLToPath(new URL("./fake-agy-crash.ts", import.meta.url));
const STREAM_DIR = fileURLToPath(new URL("./fixtures/stream", import.meta.url));
const SNAPSHOT_DIR = fileURLToPath(new URL("./fixtures/acp-updates", import.meta.url));
const SNAPSHOT_UPDATE = process.env.AGY_ACP_SNAPSHOT_UPDATE === "1";
const CRASH_CONVERSATION_ID = "0c5b1f3e-1111-2222-3333-444455556666";

interface Frame {
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface Harness {
	server: AgyAcpServer;
	logs: string[];
	request: (method: string, params: unknown) => Promise<Frame>;
	notes: () => Frame[];
	close: () => void;
}

/** The in-process ACP server: PassThrough stdio, one JSON-RPC connection, the fake as agy. */
function startHarness(launch: AgyLaunchOptions): Harness {
	const input = new PassThrough();
	const output = new PassThrough();
	const logs: string[] = [];
	const server = startAgyAcpServer({ input, output, log: (l) => logs.push(l), agy: launch });
	const pending = new Map<number, (frame: Frame) => void>();
	const notes: Frame[] = [];
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
				const resolve = pending.get(frame.id);
				if (resolve) {
					pending.delete(frame.id);
					resolve(frame);
				}
			} else if (frame.method) {
				notes.push(frame);
			}
		}
	});
	let nextId = 1;
	return {
		server,
		logs,
		notes: () => notes,
		close: () => input.end(),
		request: (method, params) =>
			new Promise<Frame>((resolve, reject) => {
				const id = nextId++;
				const timer = setTimeout(() => reject(new Error(`request ${method} timed out`)), 20000);
				timer.unref();
				pending.set(id, (frame) => {
					clearTimeout(timer);
					resolve(frame);
				});
				input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			}),
	};
}

async function waitFor<T>(what: string, timeoutMs: number, pred: () => T | false): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = pred();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
}

function fixtureMeta(fixture: string): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(`${STREAM_DIR}/${fixture}.meta.json`, "utf8")) as Record<string, unknown>;
}

/** The prompt text of a recorded input line (string content or a single text block). */
function promptOf(inputLine: string): string {
	const obj = JSON.parse(inputLine) as { message?: { content?: unknown } };
	const c = obj.message?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c) && c.length > 0) {
		const first = c[0] as { type?: string; text?: string };
		if (first?.type === "text" && typeof first.text === "string") return first.text;
	}
	throw new Error(`cannot extract a prompt from: ${inputLine}`);
}

/** A text content block (what session/prompt takes). */
function textBlock(t: string): Record<string, unknown> {
	return { type: "text", text: t };
}

/** The launch options a fixture's recorded argv implies (model, effort, add-dir, skip-permissions). */
function launchOptionsForFixture(fixture: string): AgyLaunchOptions {
	const meta = fixtureMeta(fixture);
	const opts: AgyLaunchOptions = {
		argvPrefix: [process.execPath, FAKE],
		env: {
			...process.env,
			FAKE_AGY_FIXTURE: fixture,
			FAKE_AGY_INIT_DELAY_MS: "5",
			FAKE_AGY_LINE_GAP_MS: "3",
			FAKE_AGY_CHUNK_GAP_MS: "1",
		},
		probeTimeoutMs: 4000,
		graceMs: 500,
		termMs: 300,
	};
	const args = String(meta.args ?? "")
		.split(/\s+/)
		.filter(Boolean);
	let i = 1; // drop the leading "agy"
	while (i < args.length) {
		const t = args[i];
		i++;
		if (t === "--model") {
			opts.model = args[i];
			i++;
		} else if (t === "--effort") {
			opts.effort = args[i];
			i++;
		} else if (t === "--add-dir") {
			if (!opts.addDirs) opts.addDirs = [];
			opts.addDirs.push(args[i]);
			i++;
		} else if (t === "--dangerously-skip-permissions") {
			opts.skipPermissions = true;
		}
	}
	return opts;
}

/** The prompts a fixture scenario drives: the recorded user lines, or one placeholder (bridge). */
function promptsForFixture(fixture: string): string[] {
	const inputLines = fixtureMeta(fixture).inputLines as string[] | undefined;
	if (!inputLines || inputLines.length === 0) return ["(agy-acp replay: placeholder turn)"];
	return inputLines.map(promptOf);
}

async function newSession(h: Harness, cwd: string, mcpServers?: unknown[]): Promise<Frame> {
	return h.request("session/new", mcpServers !== undefined ? { cwd, mcpServers } : { cwd });
}

function sessionUpdates(h: Harness): Record<string, unknown>[] {
	return h
		.notes()
		.filter((n) => n.method === "session/update")
		.map((n) => (n.params?.update ?? {}) as Record<string, unknown>);
}

function assertErrorFrame(frame: Frame, code: number, what: string): void {
	assert.ok(frame.error, `${what}: expected an error frame, got ${JSON.stringify(frame.result ?? frame.error)}`);
	assert.strictEqual(frame.error?.code, code, `${what}: error code`);
}

// ---------------------------------------------------------------- session/new

test("session/new validates cwd and mcpServers before spawning agy", async () => {
	const h = startHarness(launchOptionsForFixture("input-event-bogus"));
	try {
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ cwd: "relative/path" }, /absolute/],
			[{ cwd: "/definitely/not/here" }, /does not exist/],
			[{ cwd: FAKE }, /not a directory/],
			[{ cwd: process.cwd(), mcpServers: "nope" }, /array/],
		];
		for (const [params, expected] of cases) {
			const frame = await h.request("session/new", params);
			assertErrorFrame(frame, -32602, `session/new ${JSON.stringify(params)}`);
			assert.match(frame.error?.message ?? "", expected, `session/new ${JSON.stringify(params)}`);
		}
		const noCwd = await h.request("session/new", { mcpServers: [] });
		assertErrorFrame(noCwd, -32602, "session/new without cwd");
	} finally {
		h.close();
	}
});

test("session/new probes agy and returns the id, the stubs, and the mcpServers report", async () => {
	const h = startHarness(launchOptionsForFixture("input-event-bogus"));
	try {
		const servers = [{ type: "stdio", name: "fake-mcp", command: "mcp-server" }];
		const frame = await newSession(h, process.cwd(), servers);
		const result = frame.result as Record<string, unknown>;
		assert.strictEqual(result.sessionId, "e39db77a-ee74-4789-aa31-12ce92698c54", "the probed conversation id");
		const modes = result.modes as Record<string, unknown>;
		assert.strictEqual(modes.currentModeId, "default");
		assert.ok(Array.isArray(modes.availableModes) && (modes.availableModes as unknown[]).length >= 1);
		const models = result.models as Record<string, unknown>;
		assert.strictEqual(models.currentModelId, "gemini-3.8-flash-low", "the model agy's init reported");
		assert.deepStrictEqual(models.availableModels, ["gemini-3.8-flash-low"]);
		const meta = result._meta as Record<string, unknown>;
		const reported = meta.mcpServers as Record<string, unknown>;
		assert.strictEqual(reported.supported, false, "mcpServers are reported as unsupported");
		assert.deepStrictEqual(reported.requested, servers, "and never silently dropped (echoed back)");
		assert.ok(
			h.logs.every((l) => !l.includes("differs from")),
			"the first probe defines the id: no spurious init-id drift log on a fresh session",
		);
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("a session/new in flight when the connection closes does not leak its child", async () => {
	// The probe is the window: with a slow fake init (lineGap 400 ms), the child is alive and
	// the probe in flight long before session/new resolves. A connection close in that window
	// used to dispose an empty registry, and the late registry entry registered a session nothing
	// ever disposes (its child would outlive the server). The late add must dispose the session
	// instead, and a concurrent disposeAll must wait for that dispose.
	const before = new Set(fakeAgyPids());
	const launch = launchOptionsForFixture("input-event-bogus");
	launch.env = { ...launch.env, FAKE_AGY_LINE_GAP_MS: "400" };
	const h = startHarness(launch);
	const creating = h.request("session/new", { cwd: process.cwd() });
	await waitFor("the fake agy child to spawn", 10000, () => fakeAgyPids().some((p) => !before.has(p)));
	h.close(); // the connection closes while the probe is still in flight (init arrives at ~400 ms)
	await h.server.disposeSessions();
	const frame = await creating; // session/new still answers; its session is disposed, not registered
	assert.ok(frame.result, `session/new answered: ${JSON.stringify(frame.error ?? frame.result)}`);
	assert.ok(
		h.logs.some((l) => l.includes("started after the connection closed")),
		"the late add took the dispose path",
	);
	await waitFor("the late session's child to die", 10000, () => fakeAgyPids().every((p) => before.has(p)));
});

test("the version gate checks the binary the sessions will spawn (the launch env)", async () => {
	// The launch env is the exact environment the children see; the gate must run in it too.
	// FAKE_AGY_VERSION is only visible to the fake's --version through this env (the server
	// process itself does not set it), so the reported version proves the env made it through.
	const launch = launchOptionsForFixture("input-event-bogus");
	launch.env = { FAKE_AGY_FIXTURE: "input-event-bogus", FAKE_AGY_VERSION: "1.4.3" };
	const h = startHarness(launch);
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const meta = result._meta as Record<string, unknown>;
		const version = meta.agyVersion as Record<string, unknown>;
		assert.strictEqual(version.version, "1.4.3", "the gate ran with the launch env, not the server's");
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("session/new fails with -32603 and the stderr tail when agy cannot start", async () => {
	const h = startHarness(launchOptionsForFixture("bad-model-id"));
	try {
		const frame = await newSession(h, process.cwd());
		assertErrorFrame(frame, -32603, "session/new with a bad model");
		assert.match(frame.error?.message ?? "", /could not start agy/);
		const data = frame.error?.data as Record<string, unknown>;
		assert.match(String(data.stderrTail ?? ""), /invalid model selection/, "the stderr tail is in the error data");
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

// ---------------------------------------------------------------- turns

test("simple and multi-turn: end_turn per turn, the usage delta in _meta and as usage_update", async () => {
	const fixture = "simple-multiturn-textblocks";
	const h = startHarness(launchOptionsForFixture(fixture));
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const sessionId = result.sessionId;
		const prompts = promptsForFixture(fixture);
		assert.strictEqual(prompts.length, 3, "three recorded turns");
		const expectInput = [7242, 7317, 7394]; // per-turn deltas, as the driver emits them (agy reports cumulative counters)
		const expectTotal = [7244, 7318, 7396];
		const expectText = ["PONG", "OK", "ZEBRA"];
		for (let i = 0; i < prompts.length; i++) {
			// Every turn goes in as a text block object (turn one proves the flattening end-to-end;
			// the fake accepts a string content and a single text block as equivalent).
			const block = [{ type: "text", text: prompts[i] }];
			const before = sessionUpdates(h).length;
			const frame = await h.request("session/prompt", { sessionId, prompt: block });
			assert.strictEqual(frame.error, undefined, `turn ${i + 1}: no error, got ${JSON.stringify(frame.error)}`);
			const result = frame.result as Record<string, unknown>;
			assert.strictEqual(result.stopReason, "end_turn", `turn ${i + 1}`);
			const meta = result._meta as Record<string, unknown>;
			const usage = meta.usage as Record<string, number>;
			assert.strictEqual(usage.input_tokens, expectInput[i], `turn ${i + 1}: input delta`);
			assert.strictEqual(usage.total_tokens, expectTotal[i], `turn ${i + 1}: total delta`);
			assert.strictEqual(meta.numTurns, 1, `turn ${i + 1}: one turn`);
			const updates = sessionUpdates(h).slice(before);
			const usageUpdate = updates.find((u) => u.sessionUpdate === "usage_update");
			assert.ok(usageUpdate, `turn ${i + 1}: a usage_update went out`);
			const u = (usageUpdate as Record<string, unknown>).usage as Record<string, number>;
			assert.strictEqual(u.input_tokens, expectInput[i], `turn ${i + 1}: usage_update input delta`);
			const chunkText = updates
				.filter((u) => u.sessionUpdate === "agent_message_chunk")
				.map((u) => (u.content as Record<string, unknown>).text)
				.join("");
			assert.ok(chunkText.includes(expectText[i]), `turn ${i + 1}: the streamed text carries ${expectText[i]}`);
		}
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("tool allowed: tool_call pending to completed with the output", async () => {
	const fixture = "tool-allowed-skip-permissions";
	const h = startHarness(launchOptionsForFixture(fixture));
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const frame = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(promptsForFixture(fixture)[0])] });
		assert.strictEqual(frame.error, undefined, JSON.stringify(frame.error));
		assert.strictEqual((frame.result as Record<string, unknown>).stopReason, "end_turn");
		const updates = sessionUpdates(h);
		const toolCall = updates.find((u) => u.sessionUpdate === "tool_call");
		const toolDone = updates.find((u) => u.sessionUpdate === "tool_call_update" && (u as Record<string, unknown>).status === "completed");
		assert.ok(toolCall, "a tool_call went out");
		assert.ok(toolDone, "the tool_call_update (completed) went out");
		assert.strictEqual(toolCall.status, "pending");
		assert.strictEqual(toolCall.kind, "execute", "run_command maps to the execute kind");
		assert.match(String(toolCall.title), /^run_command: /, "the title carries the tool name and key param");
		const rawInput = toolCall.rawInput as Record<string, unknown>;
		assert.match(String(rawInput.CommandLine), /touch t8\.txt/, "rawInput is the tool's parameters");
		assert.strictEqual(toolDone.toolCallId, toolCall.toolCallId, "the update targets the same tool");
		const content = toolDone.content as Array<Record<string, Record<string, unknown>>>;
		assert.match(String(content[0].content.text), /Command exited with code 0/, "the output is the tool_call_update content");
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("headless auto-deny: the denied actions are surfaced, never a silent end_turn", async () => {
	for (const fixture of ["tool-headless-autodenied-state-done", "tool-headless-autodenied-state-error"]) {
		const h = startHarness(launchOptionsForFixture(fixture));
		try {
			const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
			const frame = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(promptsForFixture(fixture)[0])] });
			assert.strictEqual(frame.error, undefined, `${fixture}: ${JSON.stringify(frame.error)}`);
			const r = frame.result as Record<string, unknown>;
			assert.strictEqual(r.stopReason, "end_turn", fixture);
			const meta = r._meta as Record<string, unknown>;
			const denied = meta.deniedActions as Array<Record<string, string>>;
			assert.ok(Array.isArray(denied) && denied.length === 1, `${fixture}: _meta.deniedActions is surfaced`);
			assert.deepStrictEqual(denied, [{ action: "command", display_name: "RunCommand" }], fixture);
			const updates = sessionUpdates(h);
			const notice = updates
				.filter((u) => u.sessionUpdate === "agent_message_chunk")
				.map((u) => String((u.content as Record<string, unknown>).text))
				.find((t) => t.includes("auto-denied"));
			assert.ok(notice, `${fixture}: the denied-actions notice went out`);
			assert.match(notice, /RunCommand/);
			if (fixture === "tool-headless-autodenied-state-error") {
				const failed = updates.find((u) => u.sessionUpdate === "tool_call_update" && (u as Record<string, unknown>).status === "failed");
				assert.ok(failed, "the tool step ERROR maps to a failed tool_call_update");
				const content = failed.content as Array<Record<string, Record<string, unknown>>>;
				assert.match(String(content[0].content.text), /permission check failed/, "the tool's error message is the content");
			}
		} finally {
			h.close();
			await h.server.disposeSessions();
		}
	}
});

test("subagent tool step: the invoke_subagent DONE (step_type subagent) settles the tool call", async () => {
	// The recorded terminal update of an invoke_subagent arrives as step_type "subagent"; settling
	// is tracking-based, so the tracked tool call completes instead of being reported failed.
	const fixture = "subagent-tool-call";
	const h = startHarness(launchOptionsForFixture(fixture));
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const frame = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(promptsForFixture(fixture)[0])] });
		assert.strictEqual(frame.error, undefined, JSON.stringify(frame.error));
		assert.strictEqual((frame.result as Record<string, unknown>).stopReason, "end_turn");
		const updates = sessionUpdates(h);
		const toolCall = updates.find((u) => u.sessionUpdate === "tool_call");
		assert.ok(toolCall, "the invoke_subagent tool_call went out");
		assert.match(String(toolCall.title), /^invoke_subagent: /, "the title carries the Role parameter");
		const settled = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === toolCall.toolCallId);
		assert.strictEqual(settled.length, 1, "exactly one terminal update for the tool");
		assert.strictEqual(settled[0].status, "completed", "the subagent DONE settles the tool call");
		assert.ok(!updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed"), "no failed tool_call_update");
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("a tool step in a state outside the observed set stays tracked and is failed at turn end", async () => {
	// A newer agy state (not ACTIVE/DONE/ERROR) must not drop the tool from tracking without a
	// terminal update: the turn end fails it, so a client never shows it running forever.
	const fixture = "tool-allowed-skip-permissions";
	const launch = launchOptionsForFixture(fixture);
	launch.env = { ...launch.env, FAKE_AGY_STATE_OVERRIDE: "CANCELED" };
	const h = startHarness(launch);
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const frame = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(promptsForFixture(fixture)[0])] });
		assert.strictEqual(frame.error, undefined, JSON.stringify(frame.error));
		assert.strictEqual((frame.result as Record<string, unknown>).stopReason, "end_turn");
		const updates = sessionUpdates(h);
		const toolCall = updates.find((u) => u.sessionUpdate === "tool_call");
		assert.ok(toolCall, "the tool_call went out (the ACTIVE is unchanged by the override)");
		const settled = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === toolCall?.toolCallId);
		assert.strictEqual(settled.length, 1, "exactly one terminal update for the tool");
		assert.strictEqual(settled[0].status, "failed", "the turn end failed the tool (not a silent drop)");
		assert.match(
			String((settled[0].content as Array<Record<string, Record<string, unknown>>>)[0]?.content?.text ?? ""),
			/turn ended/,
			"the turn-end reason is the content",
		);
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("a result ERROR returns a JSON-RPC error with agyError and stderrTail", async () => {
	const fixture = "slash-command-rejected";
	const h = startHarness(launchOptionsForFixture(fixture));
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const frame = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(promptsForFixture(fixture)[0])] });
		assertErrorFrame(frame, -32603, "the error turn");
		assert.match(frame.error?.message ?? "", /agy turn failed/);
		const data = frame.error?.data as Record<string, unknown>;
		assert.match(String(data.agyError ?? ""), /\/hooks is answered by the CLI itself/, "agyError is agy's error text");
		assert.ok(typeof data.stderrTail === "string", "stderrTail rides along");
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("a child crash mid-turn is a JSON-RPC error; the next prompt respawns with --conversation", async () => {
	const h = startHarness({
		argvPrefix: [process.execPath, FAKE_CRASH],
		probeTimeoutMs: 4000,
		graceMs: 500,
		termMs: 300,
	});
	try {
		const frame = await newSession(h, process.cwd());
		const result = frame.result as Record<string, unknown>;
		assert.strictEqual(result.sessionId, CRASH_CONVERSATION_ID, "the probed conversation id");
		const first = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock("make it crash")] });
		assertErrorFrame(first, -32603, "the crashed turn");
		assert.match(first.error?.message ?? "", /exited without a result/);
		const data = first.error?.data as Record<string, unknown>;
		assert.match(String(data.agyError ?? ""), /exit code=137/, "the crash exit code is in agyError");
		assert.match(String(data.stderrTail ?? ""), /simulated crash/, "the stderr tail is carried");
		// The next prompt must respawn agy with --conversation <id>: the crash fake accepts the
		// relaunch only with the exact recorded value, so a success proves the argv.
		const second = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock("come back")] });
		assert.strictEqual(second.error, undefined, JSON.stringify(second.error));
		const r = second.result as Record<string, unknown>;
		assert.strictEqual(r.stopReason, "end_turn");
		const meta = r._meta as Record<string, unknown>;
		const usage = meta.usage as Record<string, number>;
		assert.strictEqual(usage.total_tokens, 550, "the resumed turn's usage delta");
		assert.strictEqual(meta.numTurns as number, 1);
		const updates = sessionUpdates(h);
		const resumed = updates
			.filter((u) => u.sessionUpdate === "agent_message_chunk")
			.map((u) => String((u.content as Record<string, unknown>).text))
			.find((t) => t.includes("RESUMED"));
		assert.ok(resumed, "the resumed turn streamed its text");
		assert.ok(
			h.logs.some((l) => l.includes("respawning agy with --conversation")),
			"the respawn was logged",
		);
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("a respawn that cannot find the conversation is refused, not accepted with a fresh one", async () => {
	// The relaunch's init reports a different conversation id: agy could not resume and started a
	// fresh conversation, whose counters restart near zero. Accepting it would produce negative
	// usage deltas (the driver was seeded with the last cumulative state), so the resume is
	// refused with -32603 and needsRespawn survives, so the next prompt retries.
	const h = startHarness({
		argvPrefix: [process.execPath, FAKE_CRASH],
		probeTimeoutMs: 4000,
		graceMs: 500,
		termMs: 300,
		env: { FAKE_AGY_RESUME_MISMATCH: "1" },
	});
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const first = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock("make it crash")] });
		assertErrorFrame(first, -32603, "the crashed turn");
		const second = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock("come back")] });
		assertErrorFrame(second, -32603, "the refused resume");
		assert.match(second.error?.message ?? "", /instead of resuming/, "the fresh conversation id is named");
		const third = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock("come back")] });
		assertErrorFrame(third, -32603, "the retry refuses again");
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("a concurrent prompt is rejected with -32002 turn in progress", async () => {
	const fixture = "midturn-message-queued"; // two recorded turns; turn one is long enough to overlap
	const launch = launchOptionsForFixture(fixture);
	launch.env = { ...launch.env, FAKE_AGY_LINE_GAP_MS: "15", FAKE_AGY_CHUNK_GAP_MS: "5" };
	const h = startHarness(launch);
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const [firstPrompt, nextPrompt] = promptsForFixture(fixture);
		const first = h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(firstPrompt)] });
		await waitFor("the turn to start streaming", 10000, () => sessionUpdates(h).some((u) => u.sessionUpdate === "tool_call"));
		const concurrent = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(firstPrompt)] });
		assertErrorFrame(concurrent, -32002, "the concurrent prompt");
		assert.match(concurrent.error?.message ?? "", /turn in progress/);
		const done = await first;
		assert.strictEqual(done.error, undefined, JSON.stringify(done.error));
		assert.strictEqual((done.result as Record<string, unknown>).stopReason, "end_turn");
		// The rejected prompt must not have started a turn: the session takes the next prompt.
		const third = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(nextPrompt)] });
		assert.strictEqual(third.error, undefined, JSON.stringify(third.error));
		assert.strictEqual((third.result as Record<string, unknown>).stopReason, "end_turn");
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("prompt validation: image, audio, unknown, empty and unknown-session are -32602", async () => {
	const h = startHarness(launchOptionsForFixture("input-event-bogus"));
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const sessionId = result.sessionId;
		const cases: Array<[unknown, RegExp]> = [
			[[{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], /image/],
			[[{ type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" }], /audio/],
			[[{ type: "resource", resource: { uri: "file:///x", blob: "aGVsbG8=" } }], /no embedded text/],
			[[{ type: "vibrate" }], /unsupported content block type/],
			["a bare string", /array/],
			[[], /must not be empty/],
		];
		for (const [prompt, expected] of cases) {
			const frame = await h.request("session/prompt", { sessionId, prompt });
			assertErrorFrame(frame, -32602, `prompt ${JSON.stringify(prompt)}`);
			assert.match(frame.error?.message ?? "", expected);
		}
		const unknownSession = await h.request("session/prompt", { sessionId: "nope", prompt: ["hi"] });
		assertErrorFrame(unknownSession, -32602, "the unknown session");
		assert.match(unknownSession.error?.message ?? "", /unknown sessionId/);
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
});

test("flattenPrompt flattens text, resource-link and embedded-text blocks", () => {
	assert.strictEqual(flattenPrompt([{ type: "text", text: "Hello" }]), "Hello");
	assert.strictEqual(
		flattenPrompt([
			{ type: "text", text: "Hello" },
			{ type: "resource_link", uri: "https://example.com", name: "My Doc" },
			{ type: "resource", resource: { uri: "file:///x", text: "embedded" } },
		]),
		"Hello\nMy Doc\nhttps://example.com\nembedded",
	);
	assert.strictEqual(flattenPrompt([{ type: "resource_link", uri: "https://example.com" }]), "https://example.com");
	assert.throws(() => flattenPrompt([{ type: "image", data: "x", mimeType: "image/png" }]), /image/);
	assert.throws(() => flattenPrompt([{ type: "resource", resource: { uri: "file:///x", blob: "x" } }]), /no embedded text/);
	assert.throws(() => flattenPrompt([[]]), /unsupported content block type/);
	assert.throws(() => flattenPrompt([{ type: "text", text: "  " }]), /no text/);
});

// ---------------------------------------------------------------- snapshots

const SNAPSHOT_FIXTURES = [
	"simple-multiturn-textblocks",
	"midturn-message-queued",
	"subagent-tool-call",
	"tool-allowed-skip-permissions",
	"tool-coverage-write-edit-read-search",
	"tool-headless-autodenied-state-done",
	"tool-headless-autodenied-state-error",
	"tool-hook-denied",
	"tool-hook-failure-modes",
	"tool-hook-decision-values",
	"tool-hook-overwrite-args",
	"bridge-allow-deny-150s-hold",
	"bridge-self-deadline",
	"bridge-silent-timeout-and-server-closed",
	"slash-command-rejected",
];

interface TurnRecord {
	prompt: string;
	updates: unknown[];
	response: { stopReason: string } | { error: { code: number; message: string } };
}

/** Drives one fixture scenario and returns (and, when asked, records) its update-sequence snapshot. */
async function snapshotFixture(fixture: string): Promise<void> {
	const h = startHarness(launchOptionsForFixture(fixture));
	let record: { fixture: string; turns: TurnRecord[] } | null = null;
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const sessionId = result.sessionId;
		const turns: TurnRecord[] = [];
		let mark = 0;
		for (const prompt of promptsForFixture(fixture)) {
			const frame = await h.request("session/prompt", { sessionId, prompt: [textBlock(prompt)] });
			const updates = sessionUpdates(h).slice(mark);
			mark = sessionUpdates(h).length;
			turns.push({
				prompt,
				updates,
				response: frame.error
					? { error: { code: frame.error.code, message: frame.error.message } }
					: { stopReason: String((frame.result as Record<string, unknown>).stopReason) },
			});
		}
		record = { fixture, turns };
		const file = `${SNAPSHOT_DIR}/${fixture}.json`;
		if (SNAPSHOT_UPDATE) {
			fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
			fs.writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
			return;
		}
		const expected = JSON.parse(fs.readFileSync(file, "utf8")) as { fixture: string; turns: TurnRecord[] };
		assert.deepStrictEqual(record, expected, `${fixture}: the session/update sequence drifted from the snapshot`);
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
}

test("the full session/update sequence per fixture scenario (snapshots)", async () => {
	for (const fixture of SNAPSHOT_FIXTURES) await snapshotFixture(fixture);
});

// ---------------------------------------------------------------- errors are never end_turn

/** The fixtures a session can reach that end in an error: a recorded user turn whose result is ERROR. */
function reachableErrorFixtures(): string[] {
	const out: string[] = [];
	for (const name of fs.readdirSync(STREAM_DIR)) {
		if (!name.endsWith(".stdout.ndjson")) continue;
		const fixture = name.slice(0, -".stdout.ndjson".length);
		const meta = fixtureMeta(fixture);
		const lines = fs
			.readFileSync(`${STREAM_DIR}/${name}`, "utf8")
			.split("\n")
			.filter((l) => l !== "");
		const hasInit = lines.some((l) => l.startsWith('{"event":"init"'));
		const hasErrorResult = lines.some((l) => l.startsWith('{"event":"result"') && l.includes('"status":"ERROR"'));
		const inputLines = meta.inputLines as string[] | undefined;
		if (!hasInit || !hasErrorResult || !inputLines || inputLines.length === 0) continue;
		// A recorded interrupted result as the final line is held by the fake for a SIGINT (sub-issue 54);
		// such a turn cannot finish from session/prompt alone, so it is not reachable here.
		if (lines[lines.length - 1].includes('"error":"interrupted"')) continue;
		// Reachable means: the recorded input is a well-formed user turn that flattens to text
		// (what session/prompt can send - an image-block turn is rejected before it reaches agy).
		let reachable = false;
		try {
			const obj = JSON.parse(inputLines[0]) as { event?: string };
			const prompt = promptOf(inputLines[0]);
			reachable = obj.event === "user" && prompt.trim() !== "";
		} catch {
			reachable = false;
		}
		if (reachable) out.push(fixture);
	}
	return out;
}

test("an error is never reported as end_turn (all reachable error fixtures + the crash)", async () => {
	const fixtures = reachableErrorFixtures();
	assert.ok(fixtures.includes("slash-command-rejected"), "the recorded turn-level error fixture is reachable");
	for (const fixture of fixtures) {
		const h = startHarness(launchOptionsForFixture(fixture));
		try {
			const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
			const frame = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(promptsForFixture(fixture)[0])] });
			assertErrorFrame(frame, -32603, fixture);
			assert.strictEqual(frame.result, undefined, `${fixture}: an error frame carries no result - certainly no end_turn`);
		} finally {
			h.close();
			await h.server.disposeSessions();
		}
	}
	// The crash: a child exit without a result is an error too.
	const hc = startHarness({ argvPrefix: [process.execPath, FAKE_CRASH], probeTimeoutMs: 4000, graceMs: 500, termMs: 300 });
	try {
		const { result } = (await newSession(hc, process.cwd())) as { result: Record<string, unknown> };
		const frame = await hc.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock("crash")] });
		assertErrorFrame(frame, -32603, "the crash");
		assert.strictEqual(frame.result, undefined, "the crash must never be reported as end_turn");
	} finally {
		hc.close();
		await hc.server.disposeSessions();
	}
	// And a headless auto-deny end_turn is never *silent*: it carries the denied actions.
	const hd = startHarness(launchOptionsForFixture("tool-headless-autodenied-state-done"));
	try {
		const { result } = (await newSession(hd, process.cwd())) as { result: Record<string, unknown> };
		const frame = await hd.request("session/prompt", {
			sessionId: result.sessionId,
			prompt: [textBlock(promptsForFixture("tool-headless-autodenied-state-done")[0])],
		});
		assert.strictEqual(frame.error, undefined, JSON.stringify(frame.error));
		const meta = (frame.result as Record<string, unknown>)._meta as Record<string, unknown>;
		assert.ok(
			Array.isArray(meta.deniedActions) && (meta.deniedActions as unknown[]).length > 0,
			"an auto-denied end_turn carries the denied actions",
		);
	} finally {
		hd.close();
		await hd.server.disposeSessions();
	}
});

// ---------------------------------------------------------------- lifecycle

test("connection close disposes the sessions: no fake agy survives", async () => {
	// A baseline: other test files run in parallel (and orphaned fakes from killed runs can
	// linger), so the assertion is that this test left no new fake behind.
	const before = new Set(fakeAgyPids());
	const fixture = "tool-allowed-skip-permissions";
	const h = startHarness(launchOptionsForFixture(fixture));
	try {
		const { result } = (await newSession(h, process.cwd())) as { result: Record<string, unknown> };
		const frame = await h.request("session/prompt", { sessionId: result.sessionId, prompt: [textBlock(promptsForFixture(fixture)[0])] });
		assert.strictEqual((frame.result as Record<string, unknown>).stopReason, "end_turn");
	} finally {
		h.close();
		await h.server.disposeSessions();
	}
	// The fake sits at the turn boundary with a keep-alive timer; the session dispose must end it.
	await waitFor("the fake agy to be gone", 8000, () => fakeAgyPids().every((p) => before.has(p)));
});

/**
 * The pids of live fake-agy children of *this* test process (a /proc scan; empty when /proc is
 * unavailable). The parent filter is not cosmetic: `node --test` runs suite files in parallel, and an
 * unfiltered scan would count another suite's children as a leak of ours - a wait for "all my fakes
 * are gone" that another suite's timing decides.
 */
function fakeAgyPids(): number[] {
	if (!fs.existsSync("/proc")) return [];
	const out: number[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if (!fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").includes("fake-agy.ts")) continue;
			// pid (comm) state ppid ... - comm may contain spaces, so split after the last ") ".
			const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
			if (stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1] === String(process.pid)) out.push(Number(entry));
		} catch {
			// the process went away while we were scanning - that is what we expect at the end
		}
	}
	return out;
}
