// End-to-end tests of the permission bridge (issue #53 acceptance): the real agy-acp stack
// (server + session + gate + bridge server + the real hook binary) driving the fake agy with
// FAKE_AGY_RUN_HOOKS=1, which runs the configured PreToolUse hook the way real agy does.
// Covered: the ask-and-allow flow (the stream's ACTIVE creates the tool call, the hook's ask
// is its in_progress continuation with the permission metadata), a client rejection (our reason,
// the model's recorded reaction), a client-silence deadline denial, plan-mode local denial,
// accept-edits auto-allow, default-mode write asks, allow-always recording, a bridge-reference
// denial (client never asked), rewritten-args detection, and the bridge dir cleanup on dispose.
// Issue #59: a subagent's run_command asks under the parent invoke_subagent call and its progress
// rides there, an unreported conversation id is denied, and plan mode denies a subagent's write.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startAgyAcpServer, type AgyAcpServer, type AgyLaunchOptions } from "../src/server.ts";

const FAKE = fileURLToPath(new URL("./fake-agy.ts", import.meta.url));
const LOGS: Array<string> = [];

/** The pids of live processes running the fake (a /proc scan; empty when /proc is unavailable). */
function fakeAgyPids(): number[] {
	if (!fs.existsSync("/proc")) return [];
	const out: number[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
			if (cmdline.includes("fake-agy.ts")) out.push(Number(entry));
		} catch {
			// the process went away while we were scanning - that is what we expect at the end
		}
	}
	return out;
}

/** The fake pids that are children of this test process (node --test runs files in parallel,
 * so other suites' fakes must not be mistaken for ours). */
function ownFakePids(): number[] {
	const out: number[] = [];
	for (const pid of fakeAgyPids()) {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			// pid (comm) state ppid ... - comm can contain spaces, so split after the last ") "
			const ppid = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1];
			if (ppid === String(process.pid)) out.push(pid);
		} catch {
			// the process went away
		}
	}
	return out;
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

interface PermissionRequest {
	id: number;
	params: Record<string, unknown>;
}

/** The in-process ACP server with the fake (hooks on); permission requests are collected and answered by the test. */
async function startHarness(
	fixture: string,
	extraEnv?: Record<string, string>,
	extraLaunch?: Partial<AgyLaunchOptions>,
): Promise<{
	server: AgyAcpServer;
	request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
	updates: Array<Record<string, unknown>>;
	permissionRequests: PermissionRequest[];
	answerPermission: (index: number, optionId: string) => void;
	close: () => void;
}> {
	const input = new PassThrough();
	const output = new PassThrough();
	const updates: Array<Record<string, unknown>> = [];
	const permissionRequests: PermissionRequest[] = [];
	const pendingIds = new Map<number, (frame: Record<string, unknown>) => void>();
	let buffer = "";
	let nextId = 1;

	const launch: AgyLaunchOptions = {
		argvPrefix: [process.execPath, FAKE],
		env: {
			...process.env,
			FAKE_AGY_FIXTURE: fixture,
			FAKE_AGY_INIT_DELAY_MS: "5",
			FAKE_AGY_LINE_GAP_MS: "3",
			FAKE_AGY_CHUNK_GAP_MS: "1",
			FAKE_AGY_RUN_HOOKS: "1",
			...(extraEnv ?? {}),
		},
		clientDeadlineMs: 3000,
		hookDeadlineMs: 60000,
		hookTimeoutSec: 30,
		probeTimeoutMs: 4000,
		graceMs: 500,
		termMs: 300,
		...(extraLaunch ?? {}),
	};
	// The recorded argv implies the model/effort/add-dir the driver must pass back (the fake checks them).
	const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(FAKE), "fixtures", "stream", `${fixture}.meta.json`), "utf8")) as {
		args?: string;
	};
	const args = String(meta.args ?? "")
		.split(/\s+/)
		.filter(Boolean);
	let i = 1; // drop the leading "agy"
	while (i < args.length) {
		const t = args[i];
		i++;
		if (t === "--model") {
			launch.model = args[i];
			i++;
		} else if (t === "--effort") {
			launch.effort = args[i];
			i++;
		} else if (t === "--add-dir") {
			if (!launch.addDirs) launch.addDirs = [];
			launch.addDirs.push(args[i]);
			i++;
		}
	}

	const server = startAgyAcpServer({ input, output, log: (m) => LOGS.push(m), agy: launch });

	/** One server frame: collect permission requests, resolve our requests, keep the updates.
	 * Extracted (not an inline closure) to stay under the cognitive-complexity budget. */
	const dispatchFrame = (frame: Record<string, unknown>): void => {
		if (frame.id !== undefined && frame.method !== undefined) {
			// A request from the server (session/request_permission): collect; the test decides the answer.
			permissionRequests.push({ id: frame.id as number, params: (frame.params ?? {}) as Record<string, unknown> });
		} else if (frame.id !== undefined) {
			// A response (id, no method): resolves (or rejects) one of our requests.
			const done = pendingIds.get(frame.id as number);
			if (done) {
				pendingIds.delete(frame.id as number);
				done(frame);
			}
		} else if (frame.method === "session/update") {
			updates.push((frame.params as Record<string, unknown>).update as Record<string, unknown>);
		}
	};

	output.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		for (;;) {
			const i = buffer.indexOf("\n");
			if (i < 0) break;
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (line.trim() === "") continue;
			dispatchFrame(JSON.parse(line) as Record<string, unknown>);
		}
	});

	const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => {
				pendingIds.delete(id);
				reject(new Error(`request ${method} timed out`));
			}, 20000);
			timer.unref();
			pendingIds.set(id, (frame: Record<string, unknown>) => {
				clearTimeout(timer);
				if (frame.error) {
					const e = frame.error as { code?: number; message?: string };
					reject(new Error(`JSON-RPC ${e.code}: ${e.message}`));
				} else {
					resolve((frame.result ?? {}) as Record<string, unknown>);
				}
			});
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});

	return {
		server,
		request,
		updates,
		permissionRequests,
		answerPermission: (index: number, optionId: string) => {
			const pr = permissionRequests[index];
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id: pr.id, result: { outcome: { outcome: "selected", optionId } } })}\n`);
		},
		close: () => input.end(),
	};
}

async function newSession(h: Awaited<ReturnType<typeof startHarness>>): Promise<string> {
	const r = await h.request("session/new", { cwd: process.cwd(), mcpServers: [] });
	assert.strictEqual(typeof r.sessionId, "string", `session/new: ${JSON.stringify(r)}`);
	return r.sessionId as string;
}

/** The prompts a fixture scenario drives: the recorded user lines (the fake checks them). */
function promptsForFixture(fixture: string): string[] {
	const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(FAKE), "fixtures", "stream", `${fixture}.meta.json`), "utf8")) as {
		inputLines?: string[];
	};
	if (!meta.inputLines || meta.inputLines.length === 0) return ["(agy-acp replay: placeholder turn)"];
	return meta.inputLines.map((l) => {
		const obj = JSON.parse(l) as { message?: { content?: unknown } };
		const c = obj.message?.content;
		if (typeof c === "string") return c;
		if (Array.isArray(c)) {
			for (const part of c) {
				if (
					typeof part === "object" &&
					part !== null &&
					(part as { type?: string }).type === "text" &&
					typeof (part as { text?: string }).text === "string"
				)
					return (part as { text: string }).text;
			}
		}
		throw new Error(`no usable text in recorded input line: ${l.slice(0, 120)}`);
	});
}

const toolUpdates = (h: Awaited<ReturnType<typeof startHarness>>) =>
	h.updates.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update");

/** Answer permission requests as they arrive (the fake is serial: one hook at a time, so a
 * client that waits for all n before answering any would deadlock the turn), up to n. */
async function answerAsTheyArrive(h: Awaited<ReturnType<typeof startHarness>>, n: number, optionId = "allow_once"): Promise<void> {
	let answered = 0;
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting to answer ${n} permission requests (answered ${answered})`)), 20000);
		timer.unref();
		const tick = () => {
			while (answered < n && h.permissionRequests.length > answered) {
				h.answerPermission(answered, optionId);
				answered++;
			}
			if (answered >= n) {
				clearTimeout(timer);
				resolve();
			} else {
				setTimeout(tick, 2);
			}
		};
		tick();
	});
}

/** The tool names a client ask covered (the ACP toolCall carries the name in its title: `<name>: <arg>`). */
const askedToolNames = (h: Awaited<ReturnType<typeof startHarness>>) =>
	h.permissionRequests.map((p) => String((p.params.toolCall as { title?: string }).title ?? "").split(":")[0]);

test("ask then allow: the stream's ACTIVE creates the tool call, the hook's ask is its in_progress continuation (with the permission metadata), then completed", async () => {
	LOGS.length = 0;
	const h = await startHarness("tool-allowed-skip-permissions");
	try {
		const sid = await newSession(h);
		const promptP = h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-allowed-skip-permissions")[0] }],
		});
		await answerAsTheyArrive(h, 1);
		const pr = await promptP;
		assert.strictEqual(pr.stopReason, "end_turn");
		assert.strictEqual(h.permissionRequests.length, 1, "one client ask");
		const p = h.permissionRequests[0].params;
		assert.strictEqual(p.sessionId, sid);
		const options = p.options as Array<Record<string, unknown>>;
		assert.deepStrictEqual(
			options.map((o) => o.kind),
			["allow_once", "allow_always", "reject_once"],
		);
		const tcs = toolUpdates(h);
		const toolCall = tcs.find((u) => u.sessionUpdate === "tool_call");
		assert.ok(toolCall, "a tool_call update");
		assert.strictEqual((toolCall.rawInput as { CommandLine?: string })?.CommandLine, "touch t8.txt", "rawInput is the stream's parameters");
		const inProgress = tcs.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress");
		assert.ok(inProgress, "the hook's ask is an in_progress update, not a second tool_call");
		assert.strictEqual(inProgress?.toolCallId, toolCall.toolCallId, "same toolCallId: one tool call");
		assert.ok(
			(inProgress?._meta as { permission?: unknown } | undefined)?.permission,
			"the in_progress update carries the permission metadata",
		);
		const completed = tcs.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed");
		assert.ok(completed, "the tool call settles completed");
	} finally {
		h.close();
	}
});

test("a client rejection is a denial: the failed update carries our reason, the model's recorded reaction plays", async () => {
	LOGS.length = 0;
	const h = await startHarness("tool-hook-denied");
	try {
		const sid = await newSession(h);
		const promptP = h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-hook-denied")[0] }],
		});
		await answerAsTheyArrive(h, 1, "reject_once");
		const pr = await promptP;
		assert.strictEqual(pr.stopReason, "end_turn");
		const failed = toolUpdates(h).find((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
		assert.ok(failed, "a failed tool_call_update");
		const content = JSON.stringify(failed?.content ?? "");
		assert.match(content, /the user rejected this tool call/, "our rejection reason, verbatim (in the recorded error)");
		const modelChunks = h.updates
			.filter((u) => u.sessionUpdate === "agent_message_chunk")
			.map((u) => (u.content as { type?: string; text?: string } | undefined)?.text ?? "")
			.join("");
		assert.match(modelChunks, /reject|denied|blocked/i, "the model's recorded reaction to the denial plays");
	} finally {
		h.close();
	}
});

test("a client that never answers is a denial at the deadline", async () => {
	LOGS.length = 0;
	const h = await startHarness("tool-hook-denied", undefined, { clientDeadlineMs: 1500 });
	try {
		const sid = await newSession(h);
		const promptP = h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-hook-denied")[0] }],
		});
		await waitFor("the permission ask", 20000, () => h.permissionRequests.length >= 1);
		const pr = await promptP;
		assert.strictEqual(pr.stopReason, "end_turn");
		assert.strictEqual(h.permissionRequests.length, 1, "one ask, never answered");
		const failed = toolUpdates(h).find((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
		assert.ok(failed, "a failed tool_call_update");
		const content = JSON.stringify(failed?.content ?? "");
		assert.match(content, /did not answer this permission request within/i, "the deadline reason");
	} finally {
		h.close();
	}
});

test("plan mode: the denial is local, the client is never asked", async () => {
	LOGS.length = 0;
	// ALLOW_RESUME: `set_mode` below marks the child stale (its `--mode` flag cannot come off again), so
	// the turn under plan runs on a respawned agy resuming this conversation; ALLOW_SELECTION because that
	// launch carries `--mode plan`, which this recording predates.
	const h = await startHarness("tool-hook-denied", { FAKE_AGY_ALLOW_RESUME: "1", FAKE_AGY_ALLOW_SELECTION: "1" });
	try {
		const sid = await newSession(h);
		await h.request("session/set_mode", { sessionId: sid, modeId: "plan" });
		const modeUpd = h.updates.find((u) => u.sessionUpdate === "current_mode_update");
		assert.ok(modeUpd, "set_mode emits a current_mode_update notification");
		assert.strictEqual((modeUpd as { currentModeId?: string })?.currentModeId, "plan");
		const pr = await h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-hook-denied")[0] }],
		});
		assert.strictEqual(pr.stopReason, "end_turn");
		assert.strictEqual(h.permissionRequests.length, 0, "no client ask in plan mode");
		const failed = toolUpdates(h).find((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
		assert.ok(failed, "a failed tool_call_update");
		const content = JSON.stringify(failed?.content ?? "");
		assert.match(content, /plan mode is read-only/i, "the exact plan-mode reason");
	} finally {
		h.close();
	}
});

test("accept-edits: in-workspace writes and edits are auto-allowed; commands, outside reads, and web still ask", async () => {
	LOGS.length = 0;
	// ALLOW_RESUME / ALLOW_SELECTION: as above - the mode change costs a respawn onto a `--mode
	// accept-edits` child, and the turn answers from that child.
	const h = await startHarness("tool-coverage-write-edit-read-search", {
		FAKE_AGY_ALLOW_RESUME: "1",
		FAKE_AGY_ALLOW_SELECTION: "1",
	});
	try {
		const sid = await newSession(h);
		await h.request("session/set_mode", { sessionId: sid, modeId: "accept-edits" });
		const promptP = h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-coverage-write-edit-read-search")[0] }],
		});
		await answerAsTheyArrive(h, 7);
		const pr = await promptP;
		assert.strictEqual(pr.stopReason, "end_turn");
		const askedTools = askedToolNames(h);
		assert.strictEqual(
			h.permissionRequests.length,
			7,
			`expected 7 asks (5 commands + the outside read + the web search), got ${JSON.stringify(askedTools)}`,
		);
		assert.ok(!askedTools.includes("write_file"), "no ask for the in-workspace write_file");
		assert.ok(!askedTools.includes("edit_file"), "no ask for the in-workspace edit_file");
		assert.ok(askedTools.includes("run_command"), "the commands still ask");
		assert.ok(askedTools.includes("read_file"), "the outside read still asks");
		assert.ok(askedTools.includes("search_web"), "the web search still asks");
		assert.match(LOGS.join("\n"), /write_file auto-allowed \(mode accept-edits\)/, "the auto-allow was logged");
	} finally {
		h.close();
	}
});

test("default mode: an in-workspace write still asks (no silent auto-allow)", async () => {
	const h = await startHarness("tool-coverage-write-edit-read-search");
	try {
		const sid = await newSession(h);
		const promptP = h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-coverage-write-edit-read-search")[0] }],
		});
		await answerAsTheyArrive(h, 9);
		const pr = await promptP;
		assert.strictEqual(pr.stopReason, "end_turn");
		const askedTools = askedToolNames(h);
		assert.strictEqual(h.permissionRequests.length, 9, `expected 9 asks in default mode, got ${JSON.stringify(askedTools)}`);
		assert.ok(askedTools.includes("write_file"), "the in-workspace write asks in default mode");
		assert.ok(askedTools.includes("edit_file"), "the in-workspace edit asks in default mode");
	} finally {
		h.close();
	}
});

test("allow-always: the grant is recorded and logged with its key", async () => {
	LOGS.length = 0;
	const h = await startHarness("tool-allowed-skip-permissions");
	try {
		const sid = await newSession(h);
		const promptP = h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-allowed-skip-permissions")[0] }],
		});
		await answerAsTheyArrive(h, 1, "allow_always");
		const pr = await promptP;
		assert.strictEqual(pr.stopReason, "end_turn");
		assert.match(LOGS.join("\n"), /allow-always grant recorded for run_command:touch/, "the grant is logged with its key");
	} finally {
		h.close();
	}
});

test("a bridge-dir reference is denied in default mode and the client is never asked", async () => {
	LOGS.length = 0;
	const h = await startHarness("tool-allowed-skip-permissions", { FAKE_AGY_BRIDGE_REF: "1" });
	try {
		const sid = await newSession(h);
		const pr = await h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-allowed-skip-permissions")[0] }],
		});
		assert.strictEqual(pr.stopReason, "end_turn");
		assert.strictEqual(h.permissionRequests.length, 0, "no client ask for a bridge reference");
		const failed = toolUpdates(h).find((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
		assert.ok(failed, "a failed tool_call_update");
		const content = JSON.stringify(failed?.content ?? "");
		assert.match(content, /permission bridge/, "the denial names the bridge reference");
	} finally {
		h.close();
	}
});

test("rewritten args: the hook's args are displayed and _meta.argsRewritten marks the in_progress update", async () => {
	LOGS.length = 0;
	const h = await startHarness("tool-allowed-skip-permissions", { FAKE_AGY_REWRITE_ARGS: "1" });
	try {
		const sid = await newSession(h);
		const promptP = h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-allowed-skip-permissions")[0] }],
		});
		await answerAsTheyArrive(h, 1);
		const pr = await promptP;
		assert.strictEqual(pr.stopReason, "end_turn");
		assert.strictEqual(h.permissionRequests.length, 1);
		const p = h.permissionRequests[0].params;
		assert.strictEqual(
			(p.toolCall as { rawInput?: { CommandLine?: string } }).rawInput?.CommandLine,
			"touch t8.txt --rewritten",
			"the client sees the hook's (rewritten) args",
		);
		const tcs = toolUpdates(h);
		const toolCall = tcs.find((u) => u.sessionUpdate === "tool_call");
		assert.ok(toolCall, "a tool_call update");
		assert.strictEqual(
			(toolCall.rawInput as { CommandLine?: string })?.CommandLine,
			"touch t8.txt",
			"the tool_call displays the stream's parameters",
		);
		const inProgress = tcs.find((u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress");
		assert.strictEqual(
			(inProgress?.rawInput as { CommandLine?: string } | undefined)?.CommandLine,
			"touch t8.txt --rewritten",
			"the in_progress update displays the hook's (rewritten) args",
		);
		assert.strictEqual(
			(inProgress?._meta as { argsRewritten?: boolean } | undefined)?.argsRewritten,
			true,
			"the in_progress update marks the rewrite",
		);
		assert.match(LOGS.join("\n"), /args rewritten/i, "the rewrite was logged");
	} finally {
		h.close();
	}
});

test("dispose removes the session's bridge dir: no stray bridge dirs, no fake agy survives", async () => {
	// Hermetic: node --test runs files in parallel, so the test uses a private XDG_RUNTIME_DIR
	// (bridge dirs land under it) and only counts its own child fakes.
	const xdg = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-xdg-"));
	const savedXdg = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = xdg;
	const h = await startHarness("tool-allowed-skip-permissions");
	const sid = await newSession(h);
	const promptP = h.request("session/prompt", {
		sessionId: sid,
		prompt: [{ type: "text", text: promptsForFixture("tool-allowed-skip-permissions")[0] }],
	});
	await answerAsTheyArrive(h, 1);
	await promptP;
	await h.server.disposeSessions();
	h.close();
	try {
		await waitFor("the fake agy to be gone", 8000, () => ownFakePids().length === 0);
		await new Promise((r) => setTimeout(r, 300));
		const bridgeRoot = path.join(xdg, "agy-acp");
		const stray: string[] = [];
		try {
			for (const e of fs.readdirSync(bridgeRoot)) if (e.startsWith("agy-acp-")) stray.push(`${bridgeRoot}/${e}`);
		} catch {
			// no such dir: exactly what a clean dispose leaves
		}
		assert.deepStrictEqual(stray, [], `no bridge dirs left in the session's runtime dir: ${JSON.stringify(stray)}`);
	} finally {
		if (savedXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = savedXdg;
		fs.rmSync(xdg, { recursive: true, force: true });
	}
});

test("session/new advertises the three default modes; bypass needs the operator's switch", async () => {
	const h = await startHarness("tool-allowed-skip-permissions");
	try {
		const r = await h.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const modes = r.modes as { currentModeId: string; availableModes: Array<{ id: string; name: string }> };
		assert.strictEqual(modes.currentModeId, "default");
		const ids = modes.availableModes.map((m) => m.id).sort();
		assert.deepStrictEqual(ids, ["accept-edits", "default", "plan"], "bypass is not offered unless it is enabled");
		// And it is refused, not silently accepted: an unattended session must not be able to shop its
		// way out of the bridge by asking for the mode that allows everything.
		await assert.rejects(
			h.request("session/set_mode", { sessionId: r.sessionId, modeId: "bypass" }),
			/JSON-RPC -32602: unknown mode: bypass.*AGY_ACP_ALLOW_BYPASS/,
			"refused as invalid params, with the name of the switch that would offer it",
		);
		const stillDefault = h.updates.find((u) => u.sessionUpdate === "current_mode_update");
		assert.strictEqual(stillDefault, undefined, "a refused mode emits no current_mode_update");
	} finally {
		h.close();
	}
	// Enabled, the same request works: the mode is real, only its availability is gated.
	const enabled = await startHarness("tool-allowed-skip-permissions", undefined, { allowBypass: true });
	try {
		const r = await enabled.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		const modes = r.modes as { availableModes: Array<{ id: string }> };
		assert.deepStrictEqual(
			modes.availableModes.map((m) => m.id).sort(),
			["accept-edits", "bypass", "default", "plan"],
			"the fourth mode appears when the operator enables it",
		);
		await enabled.request("session/set_mode", { sessionId: r.sessionId, modeId: "bypass" });
		const upd = enabled.updates.find((u) => u.sessionUpdate === "current_mode_update") as { currentModeId?: string };
		assert.strictEqual(upd?.currentModeId, "bypass");
	} finally {
		enabled.close();
	}
});

// ---------------------------------------------------------------- subagents (issue #59)

/** The subagent the recorded `subagent-tool-call` scenario started (its terminal step's subagent_info). */
const SUBAGENT_CONVERSATION = "b84dcd44-dd9e-4f13-a5dc-26c5e3b897de";

interface HookLogEntry {
	conversationId: string;
	name: string;
	code: number | null;
	stdout: string;
}

/** A private hook log file (the fake appends one line per hook run); removed by the caller's dir. */
function tempHookLog(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-hooklog-")), "hooks.jsonl");
}

function hookLogAt(file: string): HookLogEntry[] {
	if (!fs.existsSync(file)) {
		return [];
	}
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => JSON.parse(l) as HookLogEntry);
}

test("a subagent's run_command asks under the parent invoke_subagent call, and its progress rides there", async () => {
	LOGS.length = 0;
	const log = tempHookLog();
	const h = await startHarness("subagent-tool-call", {
		FAKE_AGY_SUBAGENT_TOOL: JSON.stringify({ name: "run_command", args: { CommandLine: "touch sub1.txt" } }),
		FAKE_AGY_HOOK_LOG: log,
	});
	try {
		const sid = await newSession(h);
		const promptP = h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("subagent-tool-call")[0] }],
		});
		// The parent invoke_subagent call asks too (default mode), then the subagent's own run_command.
		await answerAsTheyArrive(h, 2);
		const pr = await promptP;
		assert.strictEqual(pr.stopReason, "end_turn");
		assert.strictEqual(h.permissionRequests.length, 2, "the parent ask and the subagent's ask");
		const subAsk = h.permissionRequests[1].params;
		const parentId = `${sid}:2`;
		const tc = subAsk.toolCall as { toolCallId?: string; title?: string; rawInput?: { CommandLine?: string } };
		assert.strictEqual(tc.toolCallId, parentId, "the ask references the parent invoke_subagent tool call");
		assert.ok(
			String(tc.title).includes('subagent "File Creator": run_command: touch sub1.txt'),
			`the title says a subagent is asking: ${String(tc.title)}`,
		);
		assert.strictEqual(tc.rawInput?.CommandLine, "touch sub1.txt", "the args are the subagent's own");
		const meta = subAsk._meta as { subagent?: { conversationId?: string; toolCallId?: string } };
		assert.strictEqual(meta.subagent?.conversationId, SUBAGENT_CONVERSATION, "the subagent's id rides in _meta");
		assert.strictEqual(
			meta.subagent?.toolCallId,
			`${SUBAGENT_CONVERSATION}:0`,
			"its own tool call id, which never collides with a parent step",
		);
		const progress = h.updates.filter(
			(u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === parentId && (u._meta as { subagent?: unknown })?.subagent,
		);
		assert.ok(progress.length >= 1, "the subagent's activity is a tool_call_update on the parent call");
		assert.ok(
			JSON.stringify(progress[0].content).includes("is running run_command: touch sub1.txt"),
			`the progress content says what the subagent runs: ${JSON.stringify(progress[0].content)}`,
		);
		assert.ok(
			!h.updates.some((u) => u.sessionUpdate === "tool_call" && String(u.toolCallId).startsWith(SUBAGENT_CONVERSATION)),
			"the subagent's step is never a tool call of its own in the parent stream",
		);
	} finally {
		h.close();
		fs.rmSync(path.dirname(log), { recursive: true, force: true });
	}
});

test("a hook from a conversation the session never reported is denied, and the client is never asked", async () => {
	LOGS.length = 0;
	const log = tempHookLog();
	const stranger = "0f0f0f0f-0000-4000-8000-000000000000";
	const h = await startHarness("tool-allowed-skip-permissions", {
		FAKE_AGY_STRAY_HOOK: JSON.stringify({ conversationId: stranger, name: "run_command", args: { CommandLine: "touch stray.txt" } }),
		FAKE_AGY_HOOK_LOG: log,
	});
	try {
		const sid = await newSession(h);
		const promptP = h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("tool-allowed-skip-permissions")[0] }],
		});
		await answerAsTheyArrive(h, 1);
		const pr = await promptP;
		assert.strictEqual(pr.stopReason, "end_turn");
		assert.strictEqual(h.permissionRequests.length, 1, "only the main conversation's call asked");
		const stray = hookLogAt(log).find((e) => e.conversationId === stranger);
		assert.ok(stray, "the stray hook ran");
		assert.ok(stray.stdout.includes('"decision":"deny"'), "it was denied");
		assert.ok(stray.stdout.includes("not this session or a subagent it reported"), "the reason names the attribution failure");
		assert.ok(stray.stdout.includes("Do not retry this call"), "the denial does not invite a retry");
	} finally {
		h.close();
		fs.rmSync(path.dirname(log), { recursive: true, force: true });
	}
});

test("plan mode denies a subagent's write locally: the client is never asked, the reason is the plan-mode one", async () => {
	LOGS.length = 0;
	const log = tempHookLog();
	// ALLOW_RESUME / ALLOW_SELECTION: the mode change costs a respawn onto a `--mode plan` child.
	const h = await startHarness("subagent-tool-call", {
		FAKE_AGY_SUBAGENT_TOOL: JSON.stringify({ name: "write_file", args: { Path: "sub1.txt", Content: "x" } }),
		FAKE_AGY_HOOK_LOG: log,
		FAKE_AGY_ALLOW_RESUME: "1",
		FAKE_AGY_ALLOW_SELECTION: "1",
	});
	try {
		const sid = await newSession(h);
		await h.request("session/set_mode", { sessionId: sid, modeId: "plan" });
		const pr = await h.request("session/prompt", {
			sessionId: sid,
			prompt: [{ type: "text", text: promptsForFixture("subagent-tool-call")[0] }],
		});
		assert.strictEqual(pr.stopReason, "end_turn");
		assert.strictEqual(h.permissionRequests.length, 0, "no client ask in plan mode");
		const write = hookLogAt(log).find((e) => e.name === "write_file");
		assert.ok(write, "the subagent's write reached the bridge");
		assert.ok(write.stdout.includes("plan mode is read-only"), "the subagent inherits the session's mode policy");
		assert.ok(write.stdout.includes("Do not retry this call"));
	} finally {
		h.close();
		fs.rmSync(path.dirname(log), { recursive: true, force: true });
	}
});
