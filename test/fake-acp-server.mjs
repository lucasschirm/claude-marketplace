#!/usr/bin/env node
// Fake `devin acp` server for devin-delegate lifecycle tests.
//
// Driven by env vars (set by the test extension before each spawn):
//   FAKE_DELAY_MS      ms to wait before answering session/prompt (default 70000)
//   FAKE_EXIT_EARLY_MS if >0, process exits this early with FAKE_EXIT_CODE
//   FAKE_EXIT_CODE     exit code for early exit (default 42)
//   FAKE_MARKER_DIR    dir where behavior markers are written
//
// It mimics real `devin acp` behavior that matters to the extension:
//  - streams session/update events (agent_message_chunk, tool_call, usage_update)
//  - answers session/prompt only after the delay (long turns are normal)
//  - set_config_option(model) with a value outside the advertised vocab fails
//    with -32602 (like the real server does for e.g. swe-2-max)
import readline from "node:readline";
import * as fs from "node:fs";

const delay = parseInt(process.env.FAKE_DELAY_MS || "70000", 10);
const exitEarly = parseInt(process.env.FAKE_EXIT_EARLY_MS || "0", 10);
const exitCode = parseInt(process.env.FAKE_EXIT_CODE || "42", 10);
const markerDir = process.env.FAKE_MARKER_DIR || "";

function send(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function update(sessionId, u) {
	send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
}

function marker(name) {
	if (!markerDir) return;
	try {
		fs.mkdirSync(markerDir, { recursive: true });
		fs.writeFileSync(`${markerDir}/${name}`, String(process.pid));
	} catch {}
}

// Advertised ACP config vocab (mirrors real devin acp; note: no swe-2-max)
const MODEL_VOCAB = ["swe-2-high", "swe-1-7-lightning-medium"];

let sessionId = null;
let pendingPromptId = null;

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
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
		sessionId = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
		update(sessionId, {
			sessionUpdate: "config_option_update",
			configOptions: [
				{ id: "mode", name: "Mode", options: ["accept-edits", "smart", "ask", "plan", "bypass"] },
				{ id: "model", name: "Model", options: MODEL_VOCAB },
				{ id: "thought_level", name: "Thought", options: ["medium", "high", "max"] },
			],
		});
	} else if (m === "session/set_mode") {
		send({ jsonrpc: "2.0", id: msg.id, result: {} });
	} else if (m === "session/set_config_option") {
		// Mimic real devin acp: model values outside the advertised vocab fail.
		if (msg.params?.configId === "model" && !MODEL_VOCAB.includes(msg.params.value)) {
			marker("set_config_option_model");
			send({
				jsonrpc: "2.0",
				id: msg.id,
				error: { code: -32602, message: `Invalid value: ${msg.params.value}` },
			});
		} else {
			send({ jsonrpc: "2.0", id: msg.id, result: {} });
		}
	} else if (m === "session/prompt") {
		pendingPromptId = msg.id;
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
		setTimeout(() => {
			if (pendingPromptId === null) return; // turn was cancelled
			update(sessionId, {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "Final answer from fake devin." },
			});
			send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
			pendingPromptId = null;
		}, delay);
	} else if (m === "session/cancel") {
		// Client kills the process group after this; answer the prompt with an error.
		if (pendingPromptId !== null) {
			send({ jsonrpc: "2.0", id: pendingPromptId, error: { code: -32800, message: "Turn cancelled" } });
			pendingPromptId = null;
		}
	}
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
