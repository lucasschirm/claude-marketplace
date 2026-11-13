// Run with: node --test test/test-delegate-transport.ts
//
// The transport is the seam every driver hangs off, so these run the real thing against
// `test/fake-acp-server.mjs` — the same script the queue suite puts behind a `devin` and a
// `claude-agent-acp` shim. What is under test is the JSON-RPC plumbing and the process ownership,
// which is the part that used to be called AcpClient and carry Devin's name in its error strings.
import { after, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegateTransport } from "../extensions/lib/delegate/transport.ts";
import { waitFor } from "./helpers/poll.ts";
import { agyLaunchPlan } from "../extensions/lib/delegate/drivers/agy.ts";
import { devinLaunchPlan } from "../extensions/lib/delegate/drivers/devin.ts";
import { isPidAlive } from "../extensions/lib/delegate/process.ts";
import type { LaunchPlan } from "../extensions/lib/delegate/types.ts";

const SERVER = path.join(import.meta.dirname, "fake-acp-server.mjs");

// Every transport this file creates, so a failing assertion cannot leave an agent process behind with
// its stdout pipe open — which is how a test suite hangs instead of reporting.
const launched: DelegateTransport[] = [];
const MISSING_WORKSPACE_RE = /definitely-not-a-workspace/;
after(() => {
	for (const t of launched) {
		try {
			t.dispose();
		} catch {}
	}
});

function makeTransport(plan: LaunchPlan): DelegateTransport {
	const t = new DelegateTransport(process.cwd(), plan);
	launched.push(t);
	return t;
}

function plan(env: Record<string, string> = {}): LaunchPlan {
	return {
		command: process.execPath,
		args: [SERVER],
		env: { FAKE_DELAY_MS: "80", ...env },
		label: "fake acp",
		clientInfo: { name: "delegate-test", version: "1" },
	};
}

/** A started transport plus the session the fake server hands out, for tests that need both. */
async function connected(env: Record<string, string> = {}): Promise<{
	t: DelegateTransport;
	sessionId: string;
	updates: any[];
	cleanup: () => void;
}> {
	const t = makeTransport(plan(env));
	const updates: any[] = [];
	t.setOnUpdate((u) => updates.push(u));
	const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-transport-"));
	await t.start();
	const created = await t.request("session/new", { cwd: process.cwd(), mcpServers: [] });
	return {
		t,
		sessionId: created.sessionId,
		updates,
		cleanup: () => {
			t.dispose();
			fs.rmSync(markerDir, { recursive: true, force: true });
		},
	};
}

test("the handshake keeps what the agent advertised, because that is the honest answer to what it can do", async () => {
	const t = makeTransport(plan({ FAKE_AGENT_NAME: "fake-claude" }));
	const info = await t.start();
	assert.equal((info.agentInfo as any).name, "fake-claude");
	assert.deepEqual(info.protocolVersion, 1);
	// `agentInfo` is readable after the fact so a driver can answer "can this session be resumed?".
	assert.equal((t.agentInfo.agentInfo as any).name, "fake-claude");
	t.dispose();
});

test("the launch plan's env wins over an inherited value of the same key", async () => {
	// The live case: DEVIN_MODEL is set in some shells, and a spawn that merged the other way round
	// would run every delegation on the shell's model.
	process.env.FAKE_AGENT_NAME = "from-the-shell";
	const t = makeTransport(plan({ FAKE_AGENT_NAME: "from-the-plan" }));
	const info = await t.start();
	assert.equal((info.agentInfo as any).name, "from-the-plan");
	assert.equal(t.launchEnv("FAKE_AGENT_NAME"), "from-the-plan");
	delete process.env.FAKE_AGENT_NAME;
	t.dispose();
});

test("a launch plan's argv reaches the child, because that is where a driver's selection lives", async () => {
	// "The model is a spawn flag" (`drivers/devin.ts`) and "the selection travels as flags" (agy) are both
	// claims about argv, and the only witness is the child's own `process.argv` — which the fake reports.
	// A spawn that dropped the args would leave every driver test green.
	const t = makeTransport({ ...plan(), args: [SERVER, "--model", "gemini-3-pro", "--effort", "max"] });
	const info = await t.start();
	assert.deepEqual((info.agentInfo as any).argv, ["--model", "gemini-3-pro", "--effort", "max"]);
	t.dispose();
});

test("the two backends' argv for one selection: same transport, different flags", async () => {
	// The acceptance item is "spawn argv per backend". Same command line, two drivers: the queue, the
	// watchdog and this transport are shared; only argv differs, and this is the line where that shows.
	const agy = agyLaunchPlan({ model: "gemini-3-pro", thinking: "high", mode: "ask" }, process.cwd());
	const devin = devinLaunchPlan({ model: "swe-2-max", thinking: undefined, mode: "dangerous" }, process.cwd());
	assert.notDeepEqual(agy.args, devin.args);

	const t = makeTransport({ ...agy, command: process.execPath, args: [SERVER, ...agy.args] });
	const info = await t.start();
	assert.deepEqual((info.agentInfo as any).argv, ["--model", "gemini-3-pro", "--effort", "high"]);
	t.dispose();
});

test("a turn streams updates as they arrive and resolves with the agent's stopReason", async () => {
	const { t, sessionId, updates, cleanup } = await connected();
	const result = await t.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "go" }] }, 0);
	assert.equal(result.stopReason, "end_turn");
	const kinds = updates.map((u) => u.update?.sessionUpdate);
	assert.ok(kinds.includes("agent_message_chunk"), "chunks of the answer arrive during the turn");
	assert.ok(kinds.includes("tool_call"), "tool progress arrives during the turn");
	assert.ok(kinds.includes("usage_update"), "token usage arrives during the turn");
	cleanup();
});

test("a stopReason the agent reports is passed through untouched, not normalized here", async () => {
	const { t, sessionId, cleanup } = await connected({ FAKE_STOP_REASON: "max_tokens" });
	const result = await t.request("session/prompt", { sessionId, prompt: [] }, 0);
	assert.equal(result.stopReason, "max_tokens");
	cleanup();
});

test("an error response rejects the caller with the agent's own message", async () => {
	const t = makeTransport(plan());
	await t.start();
	// Outside the advertised vocabulary: the fake server refuses this exactly as real devin acp does.
	await assert.rejects(
		() => t.request("session/set_config_option", { sessionId: "s", configId: "model", value: "swe-9-ultra" }, 5000),
		/Invalid value: swe-9-ultra/,
	);
	t.dispose();
});

test("a request nobody answers gets method-not-found, because the agent is blocked until it does", async () => {
	const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-unknown-"));
	const t = makeTransport(plan({ FAKE_UNKNOWN_REQUEST: "1", FAKE_MARKER_DIR: markerDir }));
	t.setOnUpdate(() => {});
	await t.start();
	await t.request("session/new", { cwd: process.cwd(), mcpServers: [] }, 5000);
	// The server sent `fs/read_text_file` and recorded the client's reply; no handler was installed, so
	// the transport must answer rather than let the agent wait forever.
	const reply = await waitFor(() => {
		try {
			return fs.readFileSync(path.join(markerDir, "response-unknown-1"), "utf-8");
		} catch {
			return null;
		}
	});
	assert.match(reply, /-32601/);
	assert.match(reply, /Method not found/);
	t.dispose();
	fs.rmSync(markerDir, { recursive: true, force: true });
});

test("an incoming request the client takes is answered with the client's decision", async () => {
	const t = makeTransport(plan({ FAKE_PERMISSION: "1" }));
	const seen: any[] = [];
	t.setOnRequest((req) => {
		if (req.method !== "session/request_permission") {
			return false;
		}
		seen.push(req);
		t.respond(req.id, { outcome: { outcome: "selected", optionId: "allow_once" } });
		return true;
	});
	await t.start();
	const created = await t.request("session/new", { cwd: process.cwd(), mcpServers: [] }, 5000);
	const result = await t.request("session/prompt", { sessionId: created.sessionId, prompt: [] }, 5000);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].params.toolCall._meta["cognition.ai/editableCommand"].length > 0, true);
	assert.match(result.stopReason, /end_turn/);
	t.dispose();
});

test("a request that outlives its timeout rejects naming the method", async () => {
	const t = makeTransport(plan());
	await t.start();
	// The fake server ignores this method entirely — the client waiting forever is the failure mode.
	await assert.rejects(
		() => t.request("fs/read_text_file", { sessionId: "s", path: "/x" }, 120),
		/timed out after 120ms \(fs\/read_text_file\)/,
	);
	t.dispose();
});

test("dispose settles an open turn and closes the process, and nothing resolves afterwards", async () => {
	const t = makeTransport(plan({ FAKE_DELAY_MS: "60000" }));
	await t.start();
	const created = await t.request("session/new", { cwd: process.cwd(), mcpServers: [] }, 5000);
	const turn = t.request("session/prompt", { sessionId: created.sessionId, prompt: [] }, 0);
	await new Promise((r) => setTimeout(r, 80));
	const pid = t.pid as number;
	t.dispose();
	await assert.rejects(() => turn, /disposed|exited/);
	// The group is really gone: a dispose that left the agent running would be a leak the user pays for.
	await waitFor(() => (isPidAlive(pid) ? null : true));
	await assert.rejects(() => t.request("session/new", { cwd: ".", mcpServers: [] }, 1000), /transport is disposed/);
});

test("the wire log records the traffic, because 'what did the agent actually send' must be answerable", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-wire-"));
	const logFile = path.join(dir, "acp.log");
	const t = makeTransport(plan());
	t.setLogFilePath(logFile);
	await t.start();
	await t.request("session/new", { cwd: process.cwd(), mcpServers: [] }, 5000);
	// Polled, not slept: the wire log is a write stream, and a fixed pause is a race that the rest of the
	// suite wins or loses depending on how loaded the machine is.
	const log = await waitFor(() => {
		const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8") : "";
		return text.includes("config_option_update") ? text : null;
	});
	assert.match(log, /"type":"stdout"/);
	assert.match(log, /config_option_update/);
	t.dispose();
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a spawn of a command that does not exist fails the start, not the next tool call", async () => {
	const t = makeTransport({
		command: "definitely-not-an-agent-binary",
		args: [],
		env: {},
		label: "ghost acp",
		clientInfo: { name: "t", version: "1" },
	});
	await assert.rejects(() => t.start(), /ghost acp|ENOENT|not running/);
	t.dispose();
});

test("a spawn that failed because the workspace is gone names the workspace", async () => {
	// Node blames the command whichever of the two went missing, and a reattach follows a conversation to the
	// folder it was created in — where folders get deleted. Without the path in the text the operator goes
	// hunting for a missing binary, and `agy-acp --help` tells them it is there.
	const t = new DelegateTransport("/definitely-not-a-workspace", plan());
	launched.push(t);
	await assert.rejects(() => t.start(), MISSING_WORKSPACE_RE);
	t.dispose();
});
