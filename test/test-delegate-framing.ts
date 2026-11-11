// Run with: node --test test/test-delegate-framing.ts
//
// The frame decoder, and the transport that now reads through it.
//
// The regression this exists for: `node:readline` treats U+2028 and U+2029 as line terminators, and an
// ACP frame may carry either inside a JSON string — an agent quoting a line of a file is the ordinary
// case, and `JSON.stringify` leaves both unescaped. One such character split a frame in half, both halves
// failed `JSON.parse`, and a session went silent in the middle of a sentence with nothing in the log but
// two dropped lines.
import { after, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegateTransport } from "../extensions/lib/delegate/transport.ts";
import { FrameDecoder, MAX_FRAME_BYTES } from "../extensions/lib/delegate/framing.ts";
import { waitFor } from "./helpers/poll.ts";
import type { LaunchPlan } from "../extensions/lib/delegate/types.ts";

// The matcher patterns live at module scope: biome's useTopLevelRegex rule counts a literal
// recompiled per call, and every one of these runs inside a test body.
const EXCEEDED_64_BYTES_WITHOUT_A_NEWLINE_RE = /exceeded 64 bytes without a newline/;
const NOT_VALID_UTF_8_RE = /not valid UTF-8/;
const FRAMING_PROBLEM_RE = /framing_problem/;

const AGENT = path.join(import.meta.dirname, "helpers", "fake-framing-agent.mjs");

const launched: DelegateTransport[] = [];
after(() => {
	for (const t of launched) {
		try {
			t.dispose();
		} catch {}
	}
});

/** A decoder with its two sinks recorded, so a test reads what the reader saw. */
function rig(maxBytes = MAX_FRAME_BYTES) {
	const lines: string[] = [];
	const problems: string[] = [];
	const decoder = new FrameDecoder(maxBytes, { onLine: (l) => lines.push(l), onProblem: (r) => problems.push(r) });
	return { decoder, lines, problems };
}

// --- the bug, pinned ---

test("the reader this replaced did split such a frame", async () => {
	// Not a test of the new code: a pin on the old behavior, so nobody "simplifies" the decoder back to
	// `readline` and reintroduces a session that goes silent mid-sentence. `Readable.from` writes the frame
	// as one chunk, so any split here is the line reader's doing.
	const readline = await import("node:readline");
	const { Readable } = await import("node:stream");
	const frame = `${JSON.stringify({ text: "a\u2028b" })}\n`;
	const lines = await new Promise<string[]>((resolve) => {
		const seen: string[] = [];
		const rl = readline.createInterface({ input: Readable.from([frame]), crlfDelay: Infinity });
		rl.on("line", (l) => seen.push(l));
		rl.on("close", () => resolve(seen));
	});
	assert.strictEqual(lines.length, 2, `readline produced ${lines.length} lines from one frame`);
	// And both halves fail to parse — which is the whole failure mode, logged twice as "non-json output".
	for (const l of lines) {
		assert.throws(() => JSON.parse(l));
	}
});

// --- the decoder itself ---

test("a frame carrying U+2028 or U+2029 arrives whole", () => {
	const { decoder, lines, problems } = rig();
	const payload = JSON.stringify({ text: "one\u2028two\u2029three" });
	assert.ok(payload.includes("\u2028") && payload.includes("\u2029"), "JSON.stringify leaves the separators raw");
	decoder.push(Buffer.from(`${payload}\n`, "utf8"));
	assert.strictEqual(problems.length, 0);
	assert.deepStrictEqual(lines, [payload]);
	assert.strictEqual(JSON.parse(lines[0]).text, "one\u2028two\u2029three");
});

test("separators survive being split across reads, because they are bytes until the frame ends", () => {
	const { decoder, lines } = rig();
	const bytes = Buffer.from(`${JSON.stringify({ t: "a\u2028b" })}\n`, "utf8");
	// The separator is 3 bytes (e2 80 a8); cut inside it, twice.
	const at = bytes.indexOf(0xe2) + 1;
	decoder.push(bytes.subarray(0, at));
	decoder.push(bytes.subarray(at, bytes.length - 1));
	decoder.push(bytes.subarray(bytes.length - 1));
	assert.strictEqual(lines.length, 1);
	assert.strictEqual(JSON.parse(lines[0]).t, "a\u2028b");
});

test("several frames in one read are delivered in order, and a partial one waits", () => {
	const { decoder, lines } = rig();
	decoder.push(Buffer.from('{"a":1}\n{"b":2}\n{"c"', "utf8"));
	assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}']);
	decoder.push(Buffer.from(":3}\n", "utf8"));
	assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("CRLF is framing, not payload", () => {
	const { decoder, lines } = rig();
	decoder.push(Buffer.from('{"a":1}\r\n{"b":2}\r\n', "utf8"));
	assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("blank lines are skipped and an unterminated tail is delivered on flush", () => {
	const { decoder, lines } = rig();
	decoder.push(Buffer.from('\n\n{"a":1}\n{"tail":true}', "utf8"));
	assert.deepStrictEqual(lines, ['{"a":1}']);
	decoder.flush();
	assert.deepStrictEqual(lines, ['{"a":1}', '{"tail":true}']);
	assert.strictEqual(decoder.pendingBytes, 0);
});

test("a frame over the ceiling ends the stream with a reason instead of with memory pressure", () => {
	// The point of the cap is a peer that never sends a newline: without it this process grows until the OS
	// notices, which is a way for a delegated agent to take the editor down.
	const { decoder, lines, problems } = rig(64);
	decoder.push(Buffer.from("x".repeat(200), "utf8"));
	assert.strictEqual(lines.length, 0);
	assert.strictEqual(problems.length, 1);
	assert.match(problems[0], EXCEEDED_64_BYTES_WITHOUT_A_NEWLINE_RE);
	assert.strictEqual(decoder.pendingBytes, 0, "the bytes the ceiling exists to bound are released");
	// Everything after is dropped: the stream is no longer trustworthy, and a frame boundary we lost cannot
	// be guessed at.
	decoder.push(Buffer.from('{"a":1}\n', "utf8"));
	assert.strictEqual(lines.length, 0);
	assert.strictEqual(problems.length, 1);
});

test("an undecodable frame is reported and the reader keeps reading", () => {
	const { decoder, lines, problems } = rig();
	decoder.push(Buffer.concat([Buffer.from('{"broken":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]));
	decoder.push(Buffer.from('{"ok":true}\n', "utf8"));
	assert.strictEqual(problems.length, 1);
	assert.match(problems[0], NOT_VALID_UTF_8_RE);
	assert.deepStrictEqual(lines, ['{"ok":true}']);
});

// --- the transport, against a child that writes those shapes ---

function framingPlan(mode: string): LaunchPlan {
	return {
		command: process.execPath,
		args: [AGENT],
		env: { FAKE_FRAME_MODE: mode },
		label: "fake framing agent",
		clientInfo: { name: "delegate-test", version: "1" },
	};
}

/**
 * Start the rig agent, collect its updates and what its log recorded, and hand back what arrived.
 *
 * `expectInLog` is what to wait for: the log is a write stream, so reading it immediately is a race the
 * rest of the suite wins or loses depending on how loaded the machine is.
 */
async function run(mode: string, expectInLog?: string): Promise<{ updates: any[]; transcript: string; logDir: string }> {
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-framing-"));
	const logPath = path.join(logDir, "events.jsonl");
	const t = new DelegateTransport(process.cwd(), framingPlan(mode));
	launched.push(t);
	const updates: any[] = [];
	t.setOnUpdate((frame) => updates.push(frame));
	t.setLogFilePath(logPath);
	await t.start();
	await t.request("session/new", { cwd: process.cwd(), mcpServers: [] });
	// The scripted output is written as a side effect of `session/new`, so a short wait settles it; `tail`
	// ends the child by itself, the others keep running until `dispose`.
	const waitMs = expectInLog ? 3000 : 150;
	const readLog = () => {
		const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
		return text.includes(expectInLog ?? "done-marker") ? text : null;
	};
	const settled = await waitFor(readLog, waitMs).catch(() => null);
	const transcript = settled ?? readLog() ?? "";
	t.dispose();
	return { updates, transcript, logDir };
}

const kinds = (updates: any[]) => updates.map((u) => u?.update?.sessionUpdate);

test("end to end: a message containing U+2028 reaches the driver as one update", async () => {
	const { updates, logDir } = await run("separator");
	fs.rmSync(logDir, { recursive: true, force: true });
	assert.ok(kinds(updates).includes("agent_message_chunk"), `the chunk survived framing (got ${kinds(updates).join(", ")})`);
	const text = updates.find((u) => u?.update?.sessionUpdate === "agent_message_chunk")?.update?.content?.text;
	assert.strictEqual(text, "line one\u2028line two\u2029line three");
});

test("end to end: a CRLF-terminated stream is read as frames", async () => {
	const { updates, logDir } = await run("crlf");
	fs.rmSync(logDir, { recursive: true, force: true });
	assert.ok(kinds(updates).includes("done-marker"), `the second frame arrived (got ${kinds(updates).join(", ")})`);
});

test("end to end: a frame cut in the middle of a multi-byte character is decoded once", async () => {
	const { updates, logDir } = await run("split-utf8");
	fs.rmSync(logDir, { recursive: true, force: true });
	const text = updates.find((u) => u?.update?.sessionUpdate === "agent_message_chunk")?.update?.content?.text;
	assert.strictEqual(text, "café");
});

test("end to end: an undecodable frame is reported and costs the session nothing", async () => {
	const { updates, transcript, logDir } = await run("invalid-utf8", "framing_problem");
	fs.rmSync(logDir, { recursive: true, force: true });
	assert.ok(kinds(updates).includes("done-marker"), "the reader kept going after the broken frame");
	assert.match(transcript, FRAMING_PROBLEM_RE);
	assert.match(transcript, NOT_VALID_UTF_8_RE);
});

test("end to end: a final frame without its terminator still arrives before the exit is reported", async () => {
	// The tail case is the ordinary one for a one-turn agent: it answers, writes, and exits, and the
	// newline can be lost with the pipe. Dropping it makes a finished session look interrupted.
	const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-framing-"));
	const t = new DelegateTransport(process.cwd(), framingPlan("tail"));
	launched.push(t);
	const updates: any[] = [];
	let exited: number | null | undefined;
	t.setOnUpdate((frame) => updates.push(frame));
	t.setOnExit((code) => {
		exited = code;
	});
	await t.start();
	await t.request("session/new", { cwd: process.cwd(), mcpServers: [] });
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.ok(kinds(updates).includes("done-marker"), `the unterminated frame arrived (got ${kinds(updates).join(", ")})`);
	assert.notStrictEqual(exited, undefined, "and the exit was reported");
	fs.rmSync(logDir, { recursive: true, force: true });
});
