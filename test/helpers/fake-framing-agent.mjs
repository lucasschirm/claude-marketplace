#!/usr/bin/env node
// A miniature ACP agent whose only job is to write stdout in the shapes a framer has to survive.
//
// `test/fake-acp-server.mjs` is a believable agent; this one is a rig for
// `extensions/lib/delegate/framing.ts`. The modes below are the shapes `node:readline` got wrong (it
// splits on U+2028/U+2029 as well as "\n") or that a byte-oriented reader must handle on purpose: a
// multi-byte character split across two writes, CRLF terminators, an undecodable frame followed by a
// good one, and a final frame whose newline was lost when the process exited.
//
// Selected with FAKE_FRAME_MODE (default "separator"). Not a protocol implementation: it answers
// `initialize` and `session/new`, marks the end of its scripted output with a `done-marker` update, and
// exits when stdin closes.
const MODE = process.env.FAKE_FRAME_MODE ?? "separator";

const out = (chunk) => process.stdout.write(chunk);
const frame = (obj) => `${JSON.stringify(obj)}\n`;
const update = (kind, extra) => ({
	jsonrpc: "2.0",
	id: undefined,
	method: "session/update",
	params: { sessionId: "s1", update: { sessionUpdate: kind, ...extra } },
});
const send = (id, result) => out(frame({ jsonrpc: "2.0", id, result }));
const done = () => frame(update("done-marker"));

/** Text as a session really carries it: U+2028 and U+2029 inside a JSON string, unescaped on the wire. */
const SEPARATOR_TEXT = "line one\u2028line two\u2029line three";
const separatorFrame = () => frame(update("agent_message_chunk", { content: { type: "text", text: SEPARATOR_TEXT } }));

function respond(msg) {
	if (msg.method === "initialize") {
		send(msg.id, { protocolVersion: 1, agentInfo: { name: "fake-framing-agent" } });
		return;
	}
	if (msg.method !== "session/new") {
		if (msg.id !== undefined) {
			send(msg.id, {});
		}
		return;
	}
	send(msg.id, { sessionId: "s1" });
	if (MODE === "separator") {
		// Two writes, one frame. A reader that treats U+2028 as a line break delivers the first 40-ish
		// bytes as a "line" (JSON.parse fails, dropped), and the remainder as another.
		const bytes = Buffer.from(separatorFrame(), "utf8");
		const cut = bytes.indexOf(Buffer.from("\u2028", "utf8")) + 1;
		out(bytes.subarray(0, cut));
		out(bytes.subarray(cut));
		out(done());
	} else if (MODE === "split-utf8") {
		// One frame, two writes, cut in the middle of a multi-byte character (`é` is 0xc3 0xa9).
		const bytes = Buffer.from(JSON.stringify(update("agent_message_chunk", { content: { type: "text", text: "caf\u00e9" } })), "utf8");
		const cut = bytes.indexOf(0xc3) + 1;
		out(bytes.subarray(0, cut));
		setTimeout(() => {
			out(Buffer.concat([bytes.subarray(cut), Buffer.from("\n")]));
			out(done());
		}, 20);
	} else if (MODE === "crlf") {
		out(`${separatorFrame().trimEnd()}\r\n${done().trimEnd()}\r\n`);
	} else if (MODE === "invalid-utf8") {
		// 0xff is not a UTF-8 start byte, so this frame cannot be decoded. The reader must say so and keep
		// reading: the frame after it is the one the caller is waiting for.
		out(
			Buffer.concat([
				Buffer.from('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"broken'),
				Buffer.from([0xff, 0xfe]),
				Buffer.from('"}}\n'),
			]),
		);
		out(done());
	} else if (MODE === "tail") {
		// The last frame loses its terminator — what a child that answers and exits can do.
		out(JSON.stringify(update("done-marker")));
		setTimeout(() => process.exit(0), 30);
	} else {
		out(done());
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	for (;;) {
		const at = buffer.indexOf("\n");
		if (at < 0) {
			break;
		}
		const line = buffer.slice(0, at).trim();
		buffer = buffer.slice(at + 1);
		if (!line) {
			continue;
		}
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		respond(msg);
	}
});
process.stdin.on("end", () => process.exit(0));
