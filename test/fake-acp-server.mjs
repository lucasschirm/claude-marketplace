#!/usr/bin/env node
// Fake `devin acp` server for devin-delegate lifecycle tests.
//
// Driven by env vars (set by the test extension before each spawn):
//   FAKE_DELAY_MS      ms to wait before answering session/prompt (default 70000)
//   FAKE_EXIT_EARLY_MS if >0, process exits this early with FAKE_EXIT_CODE
//   FAKE_EXIT_CODE     exit code for early exit (default 42)
//   FAKE_MARKER_DIR    dir where behavior markers are written
//   FAKE_NEW_DELAY_MS  ms to wait before answering session/new (default 0): widens the window in
//                      which a started session is not yet registered by the extension
//   FAKE_PERMISSION    "1": the turn asks session/request_permission (the real payload shape) and
//                      ends as soon as the client answers, reporting the chosen option
//   FAKE_UNKNOWN_REQUEST "1": after session/new, send a request the client does not implement
//
// It mimics real `devin acp` behavior that matters to the extension:
//  - streams session/update events (agent_message_chunk, tool_call, usage_update)
//  - answers session/prompt only after the delay (long turns are normal)
//  - set_config_option(model) with a value outside the advertised vocab fails
//    and ANY set_config_option(model) call is recorded to a marker file
//    with -32602 (like the real server does for e.g. swe-2-max)
//  - sends requests of its own (session/request_permission) and blocks the turn until they are
//    answered, exactly like real devin acp in any mode but bypass
//
// Markers (in FAKE_MARKER_DIR): `turn-<pid>` exists from session/new until the turn ends, so a test
// can count how many sessions are in flight at once; `set_mode-<modeId>` records each set_mode;
// `response-<requestId>` holds the client's answer to a request this server sent.
import readline from "node:readline";
import * as fs from "node:fs";

const delay = parseInt(process.env.FAKE_DELAY_MS || "70000", 10);
const exitEarly = parseInt(process.env.FAKE_EXIT_EARLY_MS || "0", 10);
const exitCode = parseInt(process.env.FAKE_EXIT_CODE || "42", 10);
const markerDir = process.env.FAKE_MARKER_DIR || "";
const newDelay = parseInt(process.env.FAKE_NEW_DELAY_MS || "0", 10);
const askPermission = process.env.FAKE_PERMISSION === "1";
const sendUnknownRequest = process.env.FAKE_UNKNOWN_REQUEST === "1";

function send(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function update(sessionId, u) {
	send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
}

function marker(name, content = String(process.pid)) {
	if (!markerDir) return;
	try {
		fs.mkdirSync(markerDir, { recursive: true });
		fs.writeFileSync(`${markerDir}/${name}`, content);
	} catch {}
}

function clearMarker(name) {
	if (!markerDir) return;
	try {
		fs.rmSync(`${markerDir}/${name}`, { force: true });
	} catch {}
}

const turnMarker = `turn-${process.pid}`;
process.on("exit", () => clearMarker(turnMarker));

// Advertised ACP config vocab (mirrors real devin acp; note: no swe-2-max). Real devin sends each
// option as an object ({ value, name, description }), not a bare string.
const MODEL_VOCAB = ["swe-2-high", "swe-1-7-lightning-medium"];
const MODE_VOCAB = ["accept-edits", "smart", "ask", "plan", "bypass"];
const asOptions = (values) => values.map((value) => ({ value, name: value }));

let sessionId = null;
let pendingPromptId = null;

// Requests this server sent, waiting for the client's response: id -> handler(response)
const outgoing = new Map();
function requestClient(id, method, params, onResponse) {
	outgoing.set(id, onResponse);
	send({ jsonrpc: "2.0", id, method, params });
}

// The payload real devin acp sent in the incident this reproduces (2026-10-22, mode accept-edits).
function permissionParams() {
	return {
		sessionId,
		toolCall: {
			toolCallId: "call_fake#1",
			_meta: { "cognition.ai/editableCommand": "rg -l table-access-policy backend/test/help/" },
		},
		options: [
			{ optionId: "allow_once", name: "Allow", kind: "allow_once" },
			{ optionId: "allow_session", name: "Yes, allow `rg` commands (this session)", kind: "allow_always" },
			{ optionId: "allow_always", name: "Yes, always allow `rg` commands in `fake`", kind: "allow_always" },
			{ optionId: "switch_bypass", name: "Yes, switch to bypass mode", kind: "allow_always" },
			{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
		],
	};
}

function finishTurn(promptId, text) {
	if (pendingPromptId !== promptId) return; // turn was cancelled
	update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
	send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "end_turn" } });
	pendingPromptId = null;
	clearMarker(turnMarker);
}

function answerSessionNew(msg) {
	sessionId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
	update(sessionId, {
		sessionUpdate: "config_option_update",
		configOptions: [
			{ id: "mode", name: "Mode", options: asOptions(MODE_VOCAB) },
			{ id: "model", name: "Model", options: asOptions(MODEL_VOCAB) },
			{ id: "thought_level", name: "Thought", options: asOptions(["medium", "high", "max"]) },
		],
	});
	if (sendUnknownRequest) requestClient("unknown-1", "fs/read_text_file", { sessionId, path: "/etc/hostname" }, () => {});
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	// A response to a request this server sent (it has an id and no method).
	if (msg.id !== undefined && !msg.method && outgoing.has(msg.id)) {
		const onResponse = outgoing.get(msg.id);
		outgoing.delete(msg.id);
		marker(`response-${msg.id}`, JSON.stringify(msg));
		onResponse(msg);
		return;
	}
	if (msg.id === undefined || !msg.method) return;
	const m = msg.method;

	if (m === "initialize") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake-devin", version: "0.0.0" } },
		});
	} else if (m === "session/new") {
		marker(turnMarker);
		setTimeout(() => answerSessionNew(msg), newDelay);
	} else if (m === "session/set_mode") {
		marker(`set_mode-${msg.params?.modeId}`);
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	} else if (m === "session/set_config_option") {
		// Record ANY set_config_option call (T5 asserts the extension never calls it
		// for the model) and mimic real devin acp: model values outside the
		// advertised vocab fail with -32602.
		if (msg.params?.configId === "model") {
			marker("set_config_option_model");
		}
		if (msg.params?.configId === "model" && !MODEL_VOCAB.includes(msg.params.value)) {
			send({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32602, message: `Invalid value: ${msg.params.value}` },
			});
		} else {
			send({ jsonrpc: "2.0", id: msg.id, result: {} });
		}
	} else if (m === "session/prompt") {
		const promptId = msg.id;
		pendingPromptId = promptId;
		marker(turnMarker);
		// Stream progress events immediately (as real devin does mid-turn)
		update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it: " } });
		update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t-1", title: "bash: echo hi", status: "in_progress" });
		update(sessionId, {
			sessionUpdate: "usage_update",
			used: 1000,
			size: 100000,
			usage: { totalTokens: 1000, inputTokens: 900, outputTokens: 100 },
		});
		if (exitEarly > 0) {
			setTimeout(() => {
				process.stderr.write("fake devin dying\n");
				process.exit(exitCode);
			}, exitEarly);
		}
		if (askPermission) {
			// Real devin goes silent here until the client answers: no updates, no turn end.
			requestClient(`perm-${promptId}`, "session/request_permission", permissionParams(), (res) => {
				const outcome = res.result?.outcome;
				const chosen = outcome?.outcome === "selected" ? outcome.optionId : (outcome?.outcome ?? "invalid");
				finishTurn(promptId, `Permission outcome: ${chosen}.`);
			});
			return;
		}
		setTimeout(() => finishTurn(promptId, "Final answer from fake devin."), delay);
	} else if (m === "session/cancel") {
		// Client kills the process group after this; answer the prompt with an error.
		if (pendingPromptId !== null) {
			send({ jsonrpc: "2.0", id: pendingPromptId, error: { code: -32800, message: "Turn cancelled" } });
			pendingPromptId = null;
		}
		clearMarker(turnMarker);
	}
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
