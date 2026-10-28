// Tests for the permission bridge plumbing (issue #53 acceptance): the per-session bridge dir
// (0700), the socket path length (<= 107 bytes, with a shortened name), the hooks.json shape,
// the token + conversation-id guard, the maxHoldMs net, stop/teardown, stale-dir cleanup, and
// the bridge hook's behaviour under every failure mode (it must fail closed: one JSON line,
// always a deny, always exit 0). Also: the gate's policy decisions, in-memory allow-always
// grants, the unknown-option-id denial, abortPending, setMode, and the rewritten-args
// detection, driven through the real bridge socket.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGY_ACP_VERSION } from "../src/server.ts";
import { BridgeServer, createBridgeLayout, bridgeRuntimeDirs } from "../src/bridge-server.ts";
import { cleanupStaleBridges } from "../src/bridge-cleanup.ts";
import { PermissionGate } from "../src/permission-gate.ts";
import { PLAN_DENY_REASON } from "../src/permission.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "..", "src", "bridge-hook.ts");

const readJson = (p: string): Record<string, unknown> => JSON.parse(fs.readFileSync(p, "utf8"));

/** A unix socket that applies one behaviour to the next connection. */
function listenOnce(behavior: (conn: net.Socket) => void): Promise<{ dir: string; path: string; close: () => Promise<void> }> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-sock-"));
	const sockPath = path.join(dir, "s.sock");
	const server = net.createServer(behavior);
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(sockPath, () => {
			resolve({
				dir,
				path: sockPath,
				close: () =>
					new Promise((r) => {
						try {
							server.close();
						} catch {
							// already closed
						}
						fs.rm(sockPath, () => {});
						setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => r()), 50);
					}),
			});
		});
	});
}

/** One request line to a socket; the reply line (or the closed-without-reply flag). */
const askSocket = (sockPath: string, req: Record<string, unknown>): Promise<{ line: string; closed: boolean }> =>
	new Promise((resolve) => {
		const conn = net.createConnection(sockPath);
		let out = "";
		let finished = false;
		const finish = (closed: boolean) => {
			if (finished) return;
			finished = true;
			conn.destroy();
			resolve({ line: out.trim(), closed });
		};
		conn.on("data", (d: Buffer) => (out += d.toString("utf8")));
		conn.on("error", () => finish(true));
		conn.on("close", () => finish(true));
		conn.write(`${JSON.stringify(req)}\n`);
		setTimeout(() => finish(false), 3000);
	});

/** A bounded wait: resolves when pred() is true or throws after ms (an unbounded spin is a suite hang). */
const waitUntil = async (pred: () => boolean, ms: number, what: string): Promise<void> => {
	const deadline = Date.now() + ms;
	for (;;) {
		if (pred()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
		await new Promise((r) => setTimeout(r, 5));
	}
};

/** Run the hook with a payload; its whole exit behaviour is one JSON line + exit 0. */
function runHook(env: Record<string, string>, stdin: string, signalAfterMs?: number): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [HOOK], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf8");
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout });
		});
		if (signalAfterMs !== undefined) setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
		child.stdin.write(stdin);
		child.stdin.end();
	});
}

const PAYLOAD = JSON.stringify({ conversationId: "conv-1", stepIdx: 1, toolCall: { name: "run_command", args: { CommandLine: "ls" } } });

test("the layout fits the unix socket path limit (shortening the name, or falling to the next runtime dir)", () => {
	const mk = (runtimeDirs: string[]) => createBridgeLayout({ runtimeDirs, node: process.execPath, hookFile: HOOK, hookTimeoutSec: 30 });
	for (const root of [os.tmpdir(), path.join(os.tmpdir(), "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k")]) {
		const l = mk([root]);
		assert.ok(
			Buffer.byteLength(l.socketPath, "utf8") <= 107,
			`socket path ${l.socketPath} is ${Buffer.byteLength(l.socketPath, "utf8")} bytes (root ${root})`,
		);
		assert.match(l.hookName, /^agy-acp-[0-9a-f]{8,16}$/);
		assert.ok(l.dir.startsWith(`${root}${path.sep}`), "the dir is under its root");
	}
	// A root whose path alone exceeds the limit: the name shortening cannot save it, so the
	// layout falls back to the next runtime dir.
	const longRoot = path.join(os.tmpdir(), `${"a".repeat(150)}`);
	const l2 = mk([longRoot, os.tmpdir()]);
	assert.ok(!l2.dir.startsWith(`${longRoot}${path.sep}`), "it fell back to the next runtime dir");
	assert.ok(Buffer.byteLength(l2.socketPath, "utf8") <= 107);
});

test("a layout with no fitting root throws (nothing to fall back to)", () => {
	const longRoot = path.join(os.tmpdir(), `${"a".repeat(150)}`);
	assert.throws(
		() => createBridgeLayout({ runtimeDirs: [longRoot], node: "x".repeat(200), hookFile: "y".repeat(200), hookTimeoutSec: 30 }),
		/<= 107/,
	);
});

test("a fresh bridge: 0700 dir, the exact hooks.json shape, a 0600 socket, stop removes it", async () => {
	const logs: string[] = [];
	const server = new BridgeServer({
		log: (l) => logs.push(l),
		token: "tok-1",
		node: process.execPath,
		hookFile: HOOK,
		hookTimeoutSec: 60,
		maxHoldMs: 5000,
		conversationId: () => "conv-1",
		handle: async () => ({ decision: "allow" }),
		onConnectionLost: () => {},
	});
	await server.start();
	const agentsDir = path.join(server.dir, ".agents");
	const mode7 = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8).padStart(3, "0");
	try {
		assert.strictEqual(`0${mode7(server.dir)}`, "0700", "the bridge dir is 0700");
		assert.strictEqual(`0${mode7(agentsDir)}`, "0700", ".agents is 0700");
		assert.match(server.hookName, /^agy-acp-[0-9a-f]{8,16}$/);
		const hooks = readJson(path.join(agentsDir, "hooks.json"));
		const entry = Object.entries(hooks);
		assert.strictEqual(entry.length, 1, "exactly one hook entry");
		assert.strictEqual(entry[0][0], server.hookName, "the entry is under the unguessable per-session name");
		const pre = (entry[0][1] as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>;
		assert.strictEqual(pre.length, 1);
		assert.strictEqual(pre[0].matcher, "*", "the hook runs for every tool");
		const hook = (pre[0].hooks as Array<Record<string, unknown>>)[0];
		assert.strictEqual(hook.type, "command");
		assert.strictEqual(hook.timeout, 60, "the documented timeout");
		assert.ok(String(hook.command).startsWith(`exec '${process.execPath}'`), `the command execs node: ${String(hook.command)}`);
		assert.ok(String(hook.command).endsWith(`'${HOOK}'`), "the command names the hook file (both paths shell-quoted)");
		assert.strictEqual(`0${mode7(server.socketPath)}`, "0600", "the socket is 0600");
	} finally {
		await server.stop();
	}
	assert.ok(!fs.existsSync(server.dir), "stop removes the dir");
});

test("a round trip: token + conversation-id in, one JSON line out, then the connection closes", async () => {
	const logs: string[] = [];
	const server = new BridgeServer({
		log: (l) => logs.push(l),
		token: "tok-1",
		node: process.execPath,
		hookFile: HOOK,
		hookTimeoutSec: 60,
		maxHoldMs: 5000,
		conversationId: () => "conv-1",
		handle: async () => ({ decision: "allow" }),
		onConnectionLost: () => {},
	});
	await server.start();
	try {
		const { line, closed } = await askSocket(server.socketPath, {
			token: "tok-1",
			conversationId: "conv-1",
			stepIdx: 1,
			toolCall: { name: "run_command", args: { CommandLine: "ls" } },
		});
		assert.strictEqual(line, JSON.stringify({ decision: "allow" }), "one JSON line, and only that");
		assert.ok(closed, "the connection closes after the reply");
	} finally {
		await server.stop();
	}
});

test("a wrong token or an empty conversation-id closes the connection with no reply (the hook fails closed)", async () => {
	for (const [token, conv] of [
		["wrong", "conv-1"],
		["tok-1", ""],
	] as const) {
		const logs: string[] = [];
		const server = new BridgeServer({
			log: (l) => logs.push(l),
			token: "tok-1",
			node: process.execPath,
			hookFile: HOOK,
			hookTimeoutSec: 60,
			maxHoldMs: 5000,
			conversationId: () => "conv-1",
			handle: async () => ({ decision: "allow" }),
			onConnectionLost: () => {},
		});
		await server.start();
		try {
			const { line, closed } = await askSocket(server.socketPath, {
				token,
				conversationId: conv,
				stepIdx: 1,
				toolCall: { name: "run_command", args: {} },
			});
			assert.strictEqual(line, "", `${token}/${conv}: no reply data`);
			assert.ok(closed, "the connection is closed");
			assert.match(logs.join("\n"), /token mismatch|conversation mismatch/, "the mismatch was logged");
		} finally {
			await server.stop();
		}
	}
});

test("a subagent's own conversation id is accepted (same token; the call still goes through policy + the client)", async () => {
	const handled: string[] = [];
	const server = new BridgeServer({
		log: () => {},
		token: "tok-1",
		node: process.execPath,
		hookFile: HOOK,
		hookTimeoutSec: 60,
		maxHoldMs: 5000,
		conversationId: () => "conv-1",
		handle: async (req) => {
			handled.push(req.conversationId);
			return { decision: "allow" };
		},
		onConnectionLost: () => {},
	});
	await server.start();
	try {
		const { line } = await askSocket(server.socketPath, {
			token: "tok-1",
			conversationId: "conv-1-sub",
			stepIdx: 3,
			toolCall: { name: "run_command", args: {} },
		});
		assert.strictEqual(line, JSON.stringify({ decision: "allow" }), "the sub conversation is served, not closed");
		assert.deepStrictEqual(handled, ["conv-1-sub"], "the request reached the handler");
	} finally {
		await server.stop();
	}
});

test("an unauthenticated or early-dropped connection does not abort a legitimate pending ask", async () => {
	const lost: string[] = [];
	const server = new BridgeServer({
		log: () => {},
		token: "tok-1",
		node: process.execPath,
		hookFile: HOOK,
		hookTimeoutSec: 60,
		maxHoldMs: 5000,
		conversationId: () => "conv-1",
		handle: () => new Promise(() => {}), // never answers, so the legit ask stays pending
		onConnectionLost: (conversationId, stepIdx) => {
			lost.push(`${conversationId}:${stepIdx}`);
		},
	});
	await server.start();
	try {
		// A legitimate pending ask at conv-1:5 (the handler never answers, so it stays pending).
		const legit = askSocket(server.socketPath, {
			token: "tok-1",
			conversationId: "conv-1",
			stepIdx: 5,
			toolCall: { name: "run_command", args: {} },
		});
		void legit; // resolves on its 3 s timeout; its late close must not run before the assertion below
		// A wrong-token connection (its step index matches the pending ask's).
		const badTok = askSocket(server.socketPath, {
			token: "wrong",
			conversationId: "conv-1",
			stepIdx: 5,
			toolCall: { name: "run_command", args: {} },
		});
		// A connection that is dropped immediately after a malformed line (no recognised fields).
		const early = askSocket(server.socketPath, {});
		await Promise.all([badTok, early]);
		await new Promise((r) => setTimeout(r, 100)); // let the close handlers run
		assert.strictEqual(lost.length, 0, "no onConnectionLost for unauthenticated or dataless connections");
	} finally {
		await server.stop();
	}
});

test("a null conversation id (before the probe) closes the connection with no reply", async () => {
	const server = new BridgeServer({
		log: () => {},
		token: "tok-1",
		node: process.execPath,
		hookFile: HOOK,
		hookTimeoutSec: 60,
		maxHoldMs: 5000,
		conversationId: () => null,
		handle: async () => ({ decision: "allow" }),
		onConnectionLost: () => {},
	});
	await server.start();
	try {
		const { line, closed } = await askSocket(server.socketPath, {
			token: "tok-1",
			conversationId: "conv-1",
			stepIdx: 1,
			toolCall: { name: "run_command", args: {} },
		});
		assert.strictEqual(line, "", "no reply before the probe");
		assert.ok(closed, "the connection is closed");
	} finally {
		await server.stop();
	}
});

test("a failed partial start (the socket chmod) removes the dir and closes the listener", async () => {
	const server = new BridgeServer({
		log: () => {},
		token: "tok-1",
		node: process.execPath,
		hookFile: HOOK,
		hookTimeoutSec: 60,
		maxHoldMs: 5000,
		conversationId: () => null,
		handle: async () => ({ decision: "allow" }),
		onConnectionLost: () => {},
		chmod: async (p: string, mode: number) => {
			if (p.endsWith("socket")) throw new Error("chmod failed (injected)");
			await fs.promises.chmod(p, mode);
		},
	});
	await assert.rejects(server.start(), /chmod failed/);
	assert.ok(!fs.existsSync(server.dir), "the half-written dir was removed");
	assert.ok(!fs.existsSync(server.socketPath), "the socket file was removed");
	await server.stop(); // idempotent after a failed start
});

test("a malformed request line closes the connection with no reply", async () => {
	const server = new BridgeServer({
		log: () => {},
		token: "tok-1",
		node: process.execPath,
		hookFile: HOOK,
		hookTimeoutSec: 60,
		maxHoldMs: 5000,
		conversationId: () => "conv-1",
		handle: async () => ({ decision: "allow" }),
		onConnectionLost: () => {},
	});
	await server.start();
	try {
		const conn = net.createConnection(server.socketPath);
		const got = await new Promise<{ data: string; closed: boolean }>((resolve) => {
			let data = "";
			const finish = (closed: boolean) => {
				conn.destroy();
				resolve({ data, closed });
			};
			conn.on("data", (d: Buffer) => (data += d.toString("utf8")));
			conn.on("error", () => finish(true));
			conn.on("close", () => finish(true));
			conn.write("not a json line\n");
			setTimeout(() => finish(false), 3000);
		});
		assert.strictEqual(got.data, "", "no reply data");
		assert.ok(got.closed, "the connection is closed");
	} finally {
		await server.stop();
	}
});

test("a handler failure destroys the connection with no reply (the hook fails closed)", async () => {
	const server = new BridgeServer({
		log: () => {},
		token: "tok-1",
		node: process.execPath,
		hookFile: HOOK,
		hookTimeoutSec: 60,
		maxHoldMs: 5000,
		conversationId: () => "conv-1",
		handle: async () => {
			throw new Error("handler exploded");
		},
		onConnectionLost: () => {},
	});
	await server.start();
	try {
		const { line, closed } = await askSocket(server.socketPath, {
			token: "tok-1",
			conversationId: "conv-1",
			stepIdx: 9,
			toolCall: { name: "run_command", args: {} },
		});
		assert.strictEqual(line, "", "no reply data on a handler error");
		assert.ok(closed, "the connection is destroyed");
	} finally {
		await server.stop();
	}
});

test("maxHoldMs cuts a never-answering ask: the connection dies and onConnectionLost names the conversation-scoped ask", async () => {
	let lost: string | undefined;
	const server = new BridgeServer({
		log: () => {},
		token: "tok-1",
		node: process.execPath,
		hookFile: HOOK,
		hookTimeoutSec: 60,
		maxHoldMs: 300,
		conversationId: () => "conv-1",
		handle: () => new Promise(() => {}),
		onConnectionLost: (conversationId, stepIdx) => {
			lost = `${conversationId}:${stepIdx}`;
		},
	});
	await server.start();
	try {
		const t0 = Date.now();
		await new Promise<void>((resolve) => {
			const conn = net.createConnection(server.socketPath);
			conn.on("close", () => resolve());
			conn.on("error", () => {});
			conn.write(
				`${JSON.stringify({ token: "tok-1", conversationId: "conv-1", stepIdx: 7, toolCall: { name: "run_command", args: {} } })}\n`,
			);
		});
		await new Promise((r) => setTimeout(r, 100)); // let the server-side close handler (onConnectionLost) run
		assert.ok(Date.now() - t0 < 3000, "the hold cut the connection well before the hook deadline");
		assert.strictEqual(lost, "conv-1:7", "onConnectionLost names the conversation-scoped ask");
	} finally {
		await server.stop();
	}
});

test("bridgeRuntimeDirs and cleanupStaleBridges: stale dirs go, fresh and unrelated stay", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-cleanup-"));
	const runtime = path.join(root, "agy-acp");
	fs.mkdirSync(runtime);
	const old = path.join(runtime, "agy-acp-deadbeefdeadbeef");
	const fresh = path.join(runtime, "agy-acp-cafebabecafebabe");
	const unrelated = path.join(runtime, "not-a-bridge");
	for (const d of [old, fresh, unrelated]) fs.mkdirSync(d);
	const past = Date.now() / 1000 - 7200;
	fs.utimesSync(old, past, past);
	const saved = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
	const logs: string[] = [];
	try {
		const dirs = bridgeRuntimeDirs();
		assert.deepStrictEqual(dirs, [runtime, os.tmpdir()], "the runtime dir first, os.tmpdir() the fallback");
		await cleanupStaleBridges((l) => logs.push(l), Date.now());
		assert.ok(!fs.existsSync(old), "the 2h-old bridge dir is removed");
		assert.ok(fs.existsSync(fresh), "a fresh bridge dir stays");
		assert.ok(fs.existsSync(unrelated), "an unrelated dir stays");
		assert.match(logs.join("\n"), /removed stale/, "the removal was logged");
	} finally {
		if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = saved;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("cleanupStaleBridges: a 2h-old dir whose socket still answers is live, not stale", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-cleanup-live-"));
	const runtime = path.join(root, "agy-acp");
	fs.mkdirSync(runtime);
	const live = path.join(runtime, `agy-acp-${"ab".repeat(8)}`);
	fs.mkdirSync(live);
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path.join(live, "socket"), resolve);
	});
	const past = Date.now() / 1000 - 7200;
	fs.utimesSync(live, past, past); // old mtime, but the socket is serving
	const saved = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
	const logs: string[] = [];
	try {
		await cleanupStaleBridges((l) => logs.push(l), Date.now());
		assert.ok(fs.existsSync(live), "the live dir (old mtime, answering socket) stays");
		// Scoped to this test's own root: the sweep also walks os.tmpdir(), where another suite - or an
		// interrupted run - may leave a stale dir for it to remove. That is the sweep doing its job.
		assert.ok(!logs.some((l) => l.includes(root)), `the live dir must not be reported as stale: ${logs.join(" | ")}`);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fs.utimesSync(live, past, past); // the socket is dead now
		await cleanupStaleBridges((l) => logs.push(l), Date.now());
		assert.ok(!fs.existsSync(live), "after the socket dies, the same old dir is removed");
		assert.match(logs.join("\n"), new RegExp(`removed stale .*${path.basename(live)}`), "the removal was logged");
	} finally {
		// Closed here rather than inline: an assertion that throws must not leave a listening server
		// behind, or the process outlives its own tests.
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
		else process.env.XDG_RUNTIME_DIR = saved;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("the hook is fail-closed in every failure mode: one JSON deny line, exit 0", async () => {
	const payload = `${PAYLOAD}\n`;
	// No socket env at all.
	let r = await runHook({ AGY_ACP_SOCK: "", AGY_ACP_TOKEN: "tok-1" }, payload);
	assert.strictEqual(r.code, 0, "no socket: exit 0");
	assert.match(r.stdout, /"decision":"deny"/, "no socket: a JSON deny line");
	assert.match(r.stdout, /Do not retry this call/, "no socket: the no-retry wording");
	// A socket path that does not exist.
	r = await runHook({ AGY_ACP_SOCK: "/nonexistent/agy-acp.sock", AGY_ACP_TOKEN: "tok-1" }, payload);
	assert.strictEqual(r.code, 0);
	assert.match(r.stdout, /"decision":"deny"/);
	// A server that closes on a wrong token.
	{
		const s = await listenOnce((c) => {
			c.once("data", () => c.destroy());
		});
		r = await runHook({ AGY_ACP_SOCK: s.path, AGY_ACP_TOKEN: "wrong" }, payload);
		assert.strictEqual(r.code, 0);
		assert.match(r.stdout, /"decision":"deny"/);
		assert.match(r.stdout, /Do not retry this call/);
		await s.close();
	}
	// A server that replies with garbage / an unknown decision.
	for (const garbage of ["not json at all", JSON.stringify({ decision: "maybe" })]) {
		const s = await listenOnce((c) => {
			c.once("data", () => c.write(`${garbage}\n`));
		});
		r = await runHook({ AGY_ACP_SOCK: s.path, AGY_ACP_TOKEN: "tok-1" }, payload);
		assert.strictEqual(r.code, 0, `${garbage}: exit 0`);
		assert.match(r.stdout, /"decision":"deny"/, `${garbage}: deny`);
		await s.close();
	}
	// A server that sends a real deny: the reason passes through verbatim.
	{
		const s = await listenOnce((c) => {
			c.once("data", () => c.write(`${JSON.stringify({ decision: "deny", reason: "the user rejected this tool call: because no" })}\n`));
		});
		r = await runHook({ AGY_ACP_SOCK: s.path, AGY_ACP_TOKEN: "tok-1" }, payload);
		assert.strictEqual(r.code, 0);
		assert.match(r.stdout, /the user rejected this tool call: because no/, "the denial reason is verbatim");
		await s.close();
	}
	// A server that allows.
	{
		const s = await listenOnce((c) => {
			c.once("data", () => c.write(`${JSON.stringify({ decision: "allow" })}\n`));
		});
		r = await runHook({ AGY_ACP_SOCK: s.path, AGY_ACP_TOKEN: "tok-1" }, payload);
		assert.strictEqual(r.code, 0);
		assert.match(r.stdout, /"decision":"allow"/, "an allow reply");
		await s.close();
	}
	// A server that never replies: the hook's own deadline fires.
	{
		const s = await listenOnce(() => {});
		const t0 = Date.now();
		r = await runHook({ AGY_ACP_SOCK: s.path, AGY_ACP_TOKEN: "tok-1", AGY_ACP_HOOK_DEADLINE_MS: "400" }, payload);
		assert.ok(Date.now() - t0 < 10000, "the deadline fired");
		assert.strictEqual(r.code, 0);
		assert.match(r.stdout, /"decision":"deny"/);
		assert.match(r.stdout, /no answer from the permission bridge within/, "the deadline reason");
		assert.match(r.stdout, /Do not retry this call/, "the deadline denial carries the no-retry wording");
		await s.close();
	}
	// SIGTERM: a blocked hook still ends with a deny.
	{
		const s = await listenOnce(() => {});
		r = await runHook({ AGY_ACP_SOCK: s.path, AGY_ACP_TOKEN: "tok-1", AGY_ACP_HOOK_DEADLINE_MS: "30000" }, payload, 500);
		assert.strictEqual(r.code, 0);
		assert.match(r.stdout, /"decision":"deny"/);
		await s.close();
	}
	// An empty stdin (no payload): still one JSON line, a deny.
	r = await runHook({ AGY_ACP_SOCK: "", AGY_ACP_TOKEN: "tok-1" }, "");
	assert.strictEqual(r.code, 0);
	assert.match(r.stdout, /"decision":"deny"/);
});

test("the hook source is the single-writer design (exactly one stdout write, exactly one exit call)", () => {
	const src = fs.readFileSync(HOOK, "utf8");
	assert.strictEqual(src.split("process.stdout.write(").length - 1, 1, "exactly one process.stdout.write call");
	assert.strictEqual(src.split("process.exit(").length - 1, 1, "exactly one process.exit call");
});

// ------------------------------------------------------------------ the gate

interface GateHarness {
	gate: PermissionGate;
	requests: Array<true>;
	updates: Array<Record<string, unknown>>;
	logs: string[];
	ask: (
		stepIdx: number,
		name: string,
		args: Record<string, unknown>,
		conversationId?: string,
	) => Promise<{ decision: string; reason?: string }>;
}

async function startGateHarness(opts: {
	cwd: string;
	clientDeadlineMs?: number;
	outcome?: () => unknown;
	requestImpl?: (m: string, p: Record<string, unknown>, ms: number) => Promise<unknown>;
}): Promise<GateHarness> {
	const requests: Array<true> = [];
	const updates: Array<Record<string, unknown>> = [];
	const logs: string[] = [];
	const impl = opts.requestImpl;
	const gate = new PermissionGate({
		log: (l) => {
			logs.push(l);
		},
		notify: (u) => {
			updates.push(u as unknown as Record<string, unknown>);
		},
		request: impl
			? (m, p, ms) => impl(m, p, ms)
			: async (_m, _p, _ms) => {
					requests.push(true);
					return opts.outcome ? opts.outcome() : { outcome: { outcome: "selected", optionId: "allow_once" } };
				},
		cwd: opts.cwd,
		clientDeadlineMs: opts.clientDeadlineMs ?? 3000,
		hookDeadlineMs: 60000,
		hookTimeoutSec: 30,
		token: "tok-1",
		conversationId: () => "conv-1",
	});
	await gate.start();
	const ask = async (stepIdx: number, name: string, args: Record<string, unknown>, conversationId = "conv-1") => {
		const { line } = await askSocket(gate.socketPath, { token: "tok-1", conversationId, stepIdx, toolCall: { name, args } });
		if (line === "") throw new Error(`no reply for step ${stepIdx} (the connection was closed)`);
		return JSON.parse(line) as { decision: string; reason?: string };
	};
	return { gate, requests, updates, logs, ask };
}

test("the gate: allow-always grants are in-memory, per key (the matching rules, live)", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-gate-")));
	try {
		let next: string = "allow_always";
		const h = await startGateHarness({
			cwd: workspace,
			outcome: () => {
				const map: Record<string, string> = {
					allow_always: "allow_always",
					allow_once: "allow_once",
					reject_once: "reject_once",
					maybe: "maybe",
				};
				return { outcome: { outcome: "selected", optionId: map[next] } };
			},
		});
		// run_command: allow-always on the first ask; the normalised match then skips the client.
		assert.deepStrictEqual(await h.ask(1, "run_command", { CommandLine: "git status" }), { decision: "allow" });
		assert.strictEqual(h.requests.length, 1);
		assert.deepStrictEqual(
			await h.ask(2, "run_command", { CommandLine: "git  status" }),
			{ decision: "allow" },
			"the whitespace-normalised form is grant-covered",
		);
		assert.strictEqual(h.requests.length, 1, "no second client ask");
		next = "allow_once";
		assert.deepStrictEqual(
			await h.ask(3, "run_command", { CommandLine: "git status --ignored" }),
			{ decision: "allow" },
			"a different command asks again",
		);
		assert.strictEqual(h.requests.length, 2, "a different command is a new ask");
		// file tools: a grant for one path does not cover another.
		const fileA = path.join(workspace, "a.txt");
		const fileB = path.join(workspace, "b.txt");
		fs.writeFileSync(fileA, "x");
		fs.writeFileSync(fileB, "y");
		next = "allow_always";
		assert.deepStrictEqual(await h.ask(4, "write_file", { Path: fileA }), { decision: "allow" });
		assert.strictEqual(h.requests.length, 3);
		assert.deepStrictEqual(await h.ask(5, "write_file", { Path: fileB }), { decision: "allow" });
		assert.strictEqual(h.requests.length, 4, "a different path is a new ask");
		assert.deepStrictEqual(await h.ask(6, "write_file", { Path: fileA }), { decision: "allow" });
		assert.strictEqual(h.requests.length, 4, "the granted path is still granted (in-memory, session-scoped)");
		// an unknown option id is a denial (on a new key, so no grant covers it).
		next = "maybe";
		const denied = await h.ask(7, "run_command", { CommandLine: "git checkout -b x" });
		assert.strictEqual(denied.decision, "deny", "an unknown option id is a denial");
		assert.match(denied.reason ?? "", /Do not retry this call/, "the denial does not invite a retry");
		assert.strictEqual(h.requests.length, 5, "one client ask for it");
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: an empty conversation-id is refused at the socket (never a client ask)", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-conv-")));
	try {
		const h = await startGateHarness({ cwd: workspace });
		const { line } = await askSocket(h.gate.socketPath, {
			token: "tok-1",
			conversationId: "",
			stepIdx: 1,
			toolCall: { name: "run_command", args: { CommandLine: "ls" } },
		});
		assert.strictEqual(line, "", "no reply: the connection is closed");
		assert.strictEqual(h.requests.length, 0, "no client ask");
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: a wrong token is refused at the socket (never a client ask)", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-tok-")));
	try {
		const h = await startGateHarness({ cwd: workspace });
		const { line } = await askSocket(h.gate.socketPath, {
			token: "other",
			conversationId: "conv-1",
			stepIdx: 1,
			toolCall: { name: "run_command", args: { CommandLine: "ls" } },
		});
		assert.strictEqual(line, "", "no reply: the connection is closed");
		assert.strictEqual(h.requests.length, 0, "no client ask");
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: abortPending turns a pending ask into a rejection and the reply still reaches the hook", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-abort-")));
	try {
		const never = new Promise(() => {});
		const h = await startGateHarness({ cwd: workspace, outcome: () => never });
		const p = h.ask(1, "run_command", { CommandLine: "ls" });
		await new Promise((r) => setTimeout(r, 100));
		h.gate.abortPending("the test cancelled the prompt");
		const reply = await p;
		assert.strictEqual(reply.decision, "deny", "the hook is told the denial");
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: the client deadline is a denial with the deadline reason", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-deadline-")));
	try {
		const h = await startGateHarness({
			cwd: workspace,
			clientDeadlineMs: 500,
			outcome: () =>
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("request session/request_permission timed out")), 500)),
		});
		const t0 = Date.now();
		const reply = await h.ask(1, "run_command", { CommandLine: "ls" });
		assert.ok(Date.now() - t0 < 10000, "the deadline fired");
		assert.strictEqual(reply.decision, "deny");
		assert.match(reply.reason ?? "", /did not answer this permission request within/i, "the deadline reason");
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: setMode changes the decisions (default asks, accept-edits auto-allows, plan denies)", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-mode-")));
	try {
		const file = path.join(workspace, "a.txt");
		fs.writeFileSync(file, "x");
		const h = await startGateHarness({ cwd: workspace });
		// default: the write asks (the client allows it).
		assert.deepStrictEqual(await h.ask(1, "write_file", { Path: file }), { decision: "allow" });
		assert.strictEqual(h.requests.length, 1);
		// accept-edits: the same write is auto-allowed, no client round trip.
		h.gate.setMode("accept-edits");
		assert.deepStrictEqual(await h.ask(2, "write_file", { Path: file }), { decision: "allow" });
		assert.strictEqual(h.requests.length, 1, "no client ask in accept-edits");
		// plan: the write is denied with the exact reason.
		h.gate.setMode("plan");
		const denied = await h.ask(3, "write_file", { Path: file });
		assert.strictEqual(denied.decision, "deny");
		assert.strictEqual(denied.reason, PLAN_DENY_REASON, "the exact plan-mode reason");
		assert.strictEqual(h.requests.length, 1, "no client ask for a plan-mode denial");
		// an unknown mode is refused.
		assert.throws(() => h.gate.setMode("nope"), /unknown mode/);
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: a bridge-dir or socket reference is a denial in every mode, bypass included", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-bref-")));
	try {
		const h = await startGateHarness({ cwd: workspace });
		for (const mode of ["default", "accept-edits", "plan", "bypass"]) {
			h.gate.setMode(mode);
			const direct = await h.ask(1, "read_file", { Path: path.join(h.gate.dir, ".agents", "hooks.json") });
			assert.strictEqual(direct.decision, "deny", `${mode}: a bridge reference is denied`);
			assert.match(direct.reason ?? "", /permission bridge/, `${mode}: the reason names the bridge`);
			const command = await h.ask(2, "run_command", { CommandLine: `cat ${h.gate.socketPath}` });
			assert.strictEqual(command.decision, "deny", `${mode}: a socket reference is denied`);
		}
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: after dispose, a request is a session-ended denial (not a client ask)", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-ended-")));
	try {
		const h = await startGateHarness({ cwd: workspace });
		await h.gate.dispose();
		const reply = await (
			h.gate as unknown as { handleHookRequest: (r: unknown) => Promise<{ decision: string; reason?: string }> }
		).handleHookRequest({
			conversationId: "conv-1",
			stepIdx: 1,
			toolCall: { name: "run_command", args: { CommandLine: "ls" } },
		});
		assert.strictEqual(reply.decision, "deny");
		assert.match(reply.reason ?? "", /session ended/i, "the session-ended reason");
		assert.strictEqual(h.requests.length, 0, "no client ask after dispose");
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: the stream's ACTIVE records the parameters; a hook request reports rewritten args, and an ask carries the pending metadata", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-rewrite-")));
	try {
		const h = await startGateHarness({ cwd: workspace });
		// Step 1: the hook's args equal the stream's, and the call asks the client.
		h.gate.onStreamActive(1, "run_command", { CommandLine: "ls" });
		await h.ask(1, "run_command", { CommandLine: "ls" });
		const u1 = h.updates.find((u) => u.toolCallId === "conv-1:1");
		assert.ok(u1, "the ask emits an in_progress update");
		assert.strictEqual(u1?.status, "in_progress");
		assert.ok((u1?._meta as Record<string, unknown> | undefined)?.permission, "the pending permission metadata is present");
		assert.strictEqual((u1?._meta as Record<string, unknown> | undefined)?.argsRewritten, undefined, "same args: no rewrite flag");
		// Step 3: the hook's args differ from the stream's parameters - a rewrite, flagged, with the hook's args displayed.
		h.gate.onStreamActive(3, "run_command", { CommandLine: "git status" });
		await h.ask(3, "run_command", { CommandLine: "git status --hooks-only" });
		const u3 = h.updates.find((u) => u.toolCallId === "conv-1:3");
		assert.ok(u3);
		assert.strictEqual((u3?._meta as Record<string, unknown> | undefined)?.argsRewritten, true, "the rewrite is flagged");
		assert.deepStrictEqual(u3?.rawInput, { CommandLine: "git status --hooks-only" }, "the hook's args are the displayed ones");
		// Step 9: auto-allowed (an in-workspace read) with equal args: no update at all.
		h.gate.onStreamActive(9, "read_file", { Path: path.join(workspace, "x.txt") });
		const before = h.updates.length;
		await h.ask(9, "read_file", { Path: path.join(workspace, "x.txt") });
		assert.strictEqual(h.updates.length, before, "auto-allowed, equal args: no update");
		// Step 11: auto-allowed, but the args differ: the rewrite is still reported (no permission metadata).
		h.gate.onStreamActive(11, "read_file", { Path: path.join(workspace, "a.txt") });
		await h.ask(11, "read_file", { Path: path.join(workspace, "b.txt") });
		const u11 = h.updates.find((u) => u.toolCallId === "conv-1:11");
		assert.ok(u11, "the rewrite is reported for an auto-allowed call too");
		assert.strictEqual((u11?._meta as Record<string, unknown> | undefined)?.argsRewritten, true);
		assert.strictEqual(
			(u11?._meta as Record<string, unknown> | undefined)?.permission,
			undefined,
			"no pending metadata on an auto-allowed call",
		);
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: a subagent's pending ask (same step index, sub conversation) is aborted in isolation", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-gate-conv-")));
	const asks: Array<{ resolve: (v: unknown) => void }> = [];
	try {
		const h = await startGateHarness({
			cwd: workspace,
			requestImpl: () => new Promise((r) => asks.push({ resolve: r })),
		});
		// A main ask and a subagent ask at the same step index, both policy-asks (run_command).
		const mainP = h.ask(5, "run_command", { CommandLine: "ls" });
		// The subagent ask on a raw connection we control (so its hook side can be dropped).
		const subConn = net.createConnection(h.gate.socketPath);
		const subClosed = new Promise<void>((r) => subConn.on("close", () => r()));
		subConn.write(
			`${JSON.stringify({ token: "tok-1", conversationId: "conv-1-sub", stepIdx: 5, toolCall: { name: "run_command", args: { CommandLine: "ls" } } })}\n`,
		);
		await waitUntil(() => asks.length >= 2, 5000, "two client asks (main + sub) in flight");
		assert.strictEqual(asks.length, 2, "two client asks are in flight (main + sub)");
		// Drop the subagent's hook connection: only the sub's ask aborts.
		subConn.destroy();
		await subClosed;
		await waitUntil(() => h.logs.some((l) => l.includes("hook connection lost")), 5000, "the hook connection lost log");
		assert.ok(
			h.logs.some((l) => /hook connection lost \(conv-1-sub:5\)/.test(l)),
			"the sub key's loss was logged",
		);
		assert.ok(!h.logs.some((l) => /hook connection lost \(conv-1:5\)/.test(l)), "the main key's pending ask is not aborted");
		// The aborted sub ask resolves as a reject (the reply goes to a dead connection, harmlessly);
		// the main ask still answers when the client answers it.
		assert.strictEqual(asks[0] !== undefined, true, "the main ask is still in flight");
		asks[0].resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
		const main = await mainP;
		assert.strictEqual(main?.decision, "allow", "the main ask answered after the sub abort");
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: a subagent's auto-allowed call (a colliding step index) does not touch a main-conversation tool call", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-gate-sub-")));
	try {
		const h = await startGateHarness({ cwd: workspace });
		// The main conversation's step 3 went ACTIVE (the stream recorded its parameters)...
		h.gate.onStreamActive(3, "run_command", { CommandLine: "ls" });
		// ...and a subagent's in-workspace read_file (auto-allowed) lands on the same step index.
		const r = await h.ask(3, "read_file", { Path: path.join(workspace, "a.txt") }, "conv-1-sub");
		assert.strictEqual(r.decision, "allow", "the subagent's in-workspace read is auto-allowed");
		assert.strictEqual(h.updates.length, 0, "no tool_call_update for the main step (no bogus in_progress / argsRewritten)");
		assert.ok(!h.logs.some((l) => l.includes("args rewritten")), "no bogus rewrite log");
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("the gate: onTurnEnd forgets the recorded stream steps (a next-turn index collision is not a rewrite)", async () => {
	const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-gate-turn-")));
	try {
		const h = await startGateHarness({ cwd: workspace });
		h.gate.onStreamActive(2, "run_command", { CommandLine: "ls" });
		h.gate.onTurnEnd();
		const r = await h.ask(2, "run_command", { CommandLine: "pwd" });
		assert.strictEqual(r.decision, "allow", "the turn's ask is answered normally");
		assert.strictEqual(h.requests.length, 1, "one client ask");
		assert.strictEqual(h.updates.length, 0, "no update from a stale record (no bogus argsRewritten)");
		await h.gate.dispose();
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true });
	}
});

test("AGY_ACP_VERSION is a constant", () => {
	assert.match(AGY_ACP_VERSION, /^\d+\.\d+\.\d+$/);
});
