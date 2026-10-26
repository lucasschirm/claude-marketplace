// Run with: node --test agy-acp/test/test-jsonrpc.ts
import * as assert from "node:assert";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, JsonRpcConnection, PARSE_ERROR, RpcError } from "../src/jsonrpc.ts";

interface Peer {
	conn: JsonRpcConnection;
	input: PassThrough;
	output: PassThrough;
	logs: string[];
	closes: string[];
	/** Parse every complete line the server has written so far. */
	frames: () => Array<Record<string, unknown>>;
	/** Raw stdout bytes so far (for "nothing was written" assertions). */
	raw: () => string;
}

function makePeer(maxFrameBytes = 1024): Peer {
	const input = new PassThrough();
	const output = new PassThrough();
	const logs: string[] = [];
	const closes: string[] = [];
	const conn = new JsonRpcConnection({ input, output, log: (l) => logs.push(l), maxFrameBytes });
	conn.onClose((reason) => closes.push(reason));
	const buffered: Buffer[] = [];
	output.on("data", (chunk: Buffer) => buffered.push(chunk));
	return {
		conn,
		input,
		output,
		logs,
		closes,
		frames: () =>
			Buffer.concat(buffered)
				.toString("utf8")
				.split("\n")
				.filter((l) => l.trim() !== "")
				.map((l) => JSON.parse(l) as Record<string, unknown>),
		raw: () => Buffer.concat(buffered).toString("utf8"),
	};
}

/** Wait for the microtask queue: handler dispatch and responses settle off the data event. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const requestLine = (id: number | string, method: string, params?: unknown) =>
	`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

test("a frame split across chunks is reassembled", async () => {
	const peer = makePeer();
	peer.conn.registerMethod("echo", (params) => params);
	const wire = Buffer.from(requestLine(1, "echo", { ok: true }), "utf8");
	peer.input.write(wire.subarray(0, 5));
	peer.input.write(wire.subarray(5, wire.length - 3));
	peer.input.write(wire.subarray(wire.length - 3));
	await settle();
	assert.deepStrictEqual(peer.frames(), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
});

test("a multi-byte character split across chunks is not mangled", async () => {
	const peer = makePeer();
	peer.conn.registerMethod("echo", (params) => params);
	const wire = Buffer.from(requestLine(2, "echo", { text: "héllo 😀 wörld" }), "utf8");
	// Split inside the 4-byte emoji (0xF0 0x9F 0x98 0x80) so no chunk boundary lands on a whole char.
	const emojiStart = wire.indexOf(0xf0);
	assert.notStrictEqual(emojiStart, -1, "fixture must contain the emoji");
	peer.input.write(wire.subarray(0, emojiStart + 2));
	peer.input.write(wire.subarray(emojiStart + 2, emojiStart + 3));
	peer.input.write(wire.subarray(emojiStart + 3));
	await settle();
	const frames = peer.frames();
	assert.strictEqual(frames.length, 1);
	assert.strictEqual((frames[0].result as { text: string }).text, "héllo 😀 wörld");
});

test("U+2028 and U+2029 inside a frame do not split it (no readline)", async () => {
	const peer = makePeer();
	peer.conn.registerMethod("echo", (params) => params);
	const text = "before\u2028after\u2029done";
	peer.input.write(requestLine(3, "echo", { text }));
	await settle();
	const frames = peer.frames();
	assert.strictEqual(frames.length, 1, "one frame in, one response out");
	assert.strictEqual((frames[0].result as { text: string }).text, text);
});

test("CRLF line endings are accepted", async () => {
	const peer = makePeer();
	peer.conn.registerMethod("echo", (params) => params);
	peer.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "echo", params: 1 })}\r\n`);
	await settle();
	assert.deepStrictEqual(peer.frames(), [{ jsonrpc: "2.0", id: 4, result: 1 }]);
});

test("an oversized line closes the connection with a logged error", async () => {
	const peer = makePeer(64);
	peer.input.write(Buffer.alloc(65, 0x61)); // 65 'a' bytes, no newline
	await settle();
	assert.deepStrictEqual(peer.closes, ["oversized frame"]);
	assert.ok(
		peer.logs.some((l) => l.includes("oversized frame")),
		"the close must be logged",
	);
	// And the connection stays closed: a valid request after the overflow is not answered.
	peer.conn.registerMethod("echo", (params) => params);
	peer.input.write(requestLine(9, "echo", null));
	await settle();
	assert.strictEqual(peer.raw(), "", "nothing is written after an overflow close");
});

test("an oversized line that arrives complete still closes the connection", async () => {
	const peer = makePeer(64);
	peer.input.write(`${"a".repeat(65)}\n`);
	await settle();
	assert.deepStrictEqual(peer.closes, ["oversized frame"]);
	assert.strictEqual(peer.raw(), "", "no response is written for the oversized frame");
});

test("unknown method gets -32601", async () => {
	const peer = makePeer();
	peer.input.write(requestLine(5, "session/new", { cwd: "/tmp" }));
	await settle();
	assert.deepStrictEqual(peer.frames(), [
		{ jsonrpc: "2.0", id: 5, error: { code: METHOD_NOT_FOUND, message: "Method not found: session/new" } },
	]);
});

test("a notification produces no response", async () => {
	const peer = makePeer();
	const seen: string[] = [];
	peer.conn.onNotification((method) => seen.push(method));
	peer.input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "x" } })}\n`);
	await settle();
	assert.deepStrictEqual(seen, ["session/cancel"]);
	assert.strictEqual(peer.raw(), "", "a notification must never be answered");
});

test("outgoing requests correlate responses by id, out of order", async () => {
	const peer = makePeer();
	const first = peer.conn.request("fs/read_text_file", { path: "/a" });
	const second = peer.conn.request("fs/read_text_file", { path: "/b" });
	// The peer answers the second request first; ids, not order, bind response to request.
	peer.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: "content-b" })}\n`);
	peer.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "content-a" })}\n`);
	assert.strictEqual(await first, "content-a");
	assert.strictEqual(await second, "content-b");
});

test("an error response rejects the matching request only", async () => {
	const peer = makePeer();
	const first = peer.conn.request("m1");
	const second = peer.conn.request("m2");
	peer.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32001, message: "nope" } })}\n`);
	peer.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: "fine" })}\n`);
	await assert.rejects(second, /nope/);
	assert.strictEqual(await first, "fine");
});

test("a frame that is not valid JSON gets -32700 with a null id", async () => {
	const peer = makePeer();
	peer.input.write("{not json\n");
	await settle();
	assert.deepStrictEqual(peer.frames(), [
		{ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error: frame is not valid JSON" } },
	]);
});

test("a non-JSON-RPC object gets -32600", async () => {
	const peer = makePeer();
	peer.input.write(`${JSON.stringify({ hello: "world" })}\n`);
	await settle();
	const frames = peer.frames();
	assert.strictEqual(frames.length, 1);
	assert.strictEqual((frames[0].error as { code: number }).code, -32600);
});

test("a thrown handler error becomes -32603, an RpcError keeps its code", async () => {
	const peer = makePeer();
	peer.conn.registerMethod("boom", () => {
		throw new Error("kaboom");
	});
	peer.conn.registerMethod("bad-params", () => {
		throw new RpcError(INVALID_PARAMS, "params are wrong");
	});
	peer.input.write(requestLine(6, "boom"));
	peer.input.write(requestLine(7, "bad-params"));
	await settle();
	const frames = peer.frames();
	assert.strictEqual((frames[0].error as { code: number }).code, INTERNAL_ERROR);
	assert.strictEqual((frames[0].error as { message: string }).message, "kaboom");
	assert.strictEqual((frames[1].error as { code: number }).code, INVALID_PARAMS);
	assert.strictEqual((frames[1].error as { message: string }).message, "params are wrong");
});

test("a string id on an incoming request is echoed back verbatim", async () => {
	const peer = makePeer();
	peer.conn.registerMethod("echo", () => "pong");
	peer.input.write(requestLine("req-uuid-1", "echo"));
	await settle();
	assert.deepStrictEqual(peer.frames(), [{ jsonrpc: "2.0", id: "req-uuid-1", result: "pong" }]);
});

test("closing input rejects pending requests and reports the close", async () => {
	const peer = makePeer();
	const waiting = peer.conn.request("never-answered");
	peer.input.end();
	await assert.rejects(waiting, /connection closed/);
	await settle();
	assert.deepStrictEqual(peer.closes, ["peer closed input"]);
});

test("a request already being handled is still answered after the peer's EOF", async () => {
	const peer = makePeer();
	// An async handler settles after 'end' has already fired - the answer must still flush.
	peer.conn.registerMethod("slow", async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
		return "late answer";
	});
	peer.input.end(requestLine(1, "slow"));
	await settle();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepStrictEqual(peer.frames(), [{ jsonrpc: "2.0", id: 1, result: "late answer" }]);
	assert.deepStrictEqual(peer.closes, ["peer closed input"]);
});

test("unterminated bytes at EOF are logged, not silently dropped", async () => {
	const peer = makePeer();
	peer.input.end('{"jsonrpc":"2.0","id":1'); // no newline - the frame never completed
	await settle();
	assert.ok(
		peer.logs.some((l) => l.includes("unterminated")),
		`expected a log line, got: ${peer.logs.join(", ")}`,
	);
	assert.strictEqual(peer.raw(), "", "an unterminated frame is not parsed");
});

test("a request times out when no response arrives", async () => {
	const peer = makePeer();
	await assert.rejects(peer.conn.request("never-answered", undefined, 20), /timed out after 20ms/);
});

test("a response for an unknown id is logged and ignored", async () => {
	const peer = makePeer();
	peer.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 999, result: "stray" })}\n`);
	await settle();
	assert.ok(peer.logs.some((l) => l.includes("unknown id 999")));
});

test("a malformed error object still rejects the request", async () => {
	const peer = makePeer();
	const waiting = peer.conn.request("m");
	peer.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: "oops" })}\n`);
	await assert.rejects(waiting);
});

test("stdin EOF semantics: empty lines are skipped, not answered", async () => {
	const peer = makePeer();
	peer.input.write("\n\n   \n\n");
	await settle();
	assert.strictEqual(peer.raw(), "");
});
