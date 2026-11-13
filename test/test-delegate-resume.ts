// Run with: node --test test/test-delegate-resume.ts
//
// What happens when `delegate_message` reaches a session whose agent process is gone.
//
// `capabilities().resume` is a promise the engine has to keep rather than a label: pi loses a *process*
// across a restart or a crash between turns, and the caller expects the context they had been writing
// into to still be there. The two agents that claim it differ in how it is reached — Devin keeps its
// sessions server-side and accepts a recorded id on the next prompt, `agy-acp` keeps its own store and
// refuses an id its registry did not create — so the driver carries an optional handshake and
// `reattachSession` makes it before anything is prompted.
//
// The last two tests run that against a real child: `test/fake-acp-server.mjs` with `FAKE_STORE_DIR`
// keeps its conversations on disk and refuses `session/prompt` for one this process did not create,
// which makes the ordering an observed fact (read off `<store>/<id>.calls`) instead of a mock's opinion.
import { after, test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegateTransport } from "../extensions/lib/delegate/transport.ts";
import { agyDriver } from "../extensions/lib/delegate/drivers/agy.ts";
import { devinDriver } from "../extensions/lib/delegate/drivers/devin.ts";
import { spawnSession, startTurn } from "../extensions/lib/delegate/session.ts";
import { followUp } from "../extensions/lib/delegate/queue.ts";
import { getEventsLogPath } from "../extensions/lib/delegate/storage.ts";
import { normalizeMeta } from "../extensions/lib/delegate/recovery.ts";
import { makeStub, metaFor } from "./helpers/delegate-stub.ts";
import { waitFor } from "./helpers/poll.ts";
import type { DelegateRuntime } from "../extensions/lib/delegate/runtime.ts";
import type { SessionMeta } from "../extensions/lib/delegate/types.ts";

type RpcParams = Record<string, unknown>;

interface Call {
	method: string;
	params: RpcParams;
}

/** The restore's answer, as far as one test needs to look into it. */
interface LoggedRestore {
	data: { notes: string[]; droppedUpdates?: number };
}

// The matchers are module constants: biome counts a literal recompiled per call as debt, and four of
// these live inside a `waitFor` body that runs several times per test.
const RESUMED_EVENT_RE = /session_resumed/;
const BELONGS_TO_RE = /belongs to \/work\/other/;
const DIFFERENT_ID_RE = /different session id/;
const NOT_IN_STORE_RE = /not a conversation this store has/;
const NO_SESSION_ID_RE = /without a session id/;

/** A transport that records the RPCs the engine made, so ordering is asserted rather than inferred. */
function stubTransport(opts: { resume?: { result?: unknown; error?: Error; delayMs?: number } } = {}) {
	const calls: Call[] = [];
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	let disposed = 0;
	const transport = {
		pid: 4242,
		start: async () => {},
		setLogFilePath: () => {},
		setOnUpdate: () => {},
		setOnExit: () => {},
		setOnRequest: () => {},
		logEvent: (type: string, data: Record<string, unknown>) => {
			events.push({ type, data });
		},
		appendAssistantMessage: () => {},
		appendUserMessage: () => {},
		respond: () => {},
		request: async (method: string, params: RpcParams) => {
			calls.push({ method, params });
			if (method === "session/resume") {
				if (opts.resume?.delayMs) {
					await new Promise((done) => setTimeout(done, opts.resume.delayMs));
				}
				if (opts.resume?.error) {
					throw opts.resume.error;
				}
				return opts.resume?.result ?? { sessionId: params.sessionId };
			}
			return { stopReason: "end_turn" };
		},
		dispose: () => {
			disposed++;
		},
	};
	return { transport: transport as unknown as DelegateTransport, calls, events, disposed: () => disposed };
}

/** A settled session with no live connection, which is the state a follow-up arrives on. */
function deadSession(rt: DelegateRuntime, agent: string, sessionId = "conv-1"): SessionMeta {
	const meta = metaFor(sessionId, { agent, status: "completed", worktreePath: "/work/checkout", mode: "accept-edits" });
	rt.sessions.set(sessionId, meta);
	return meta;
}

const failure = (res: Awaited<ReturnType<typeof followUp>>) => {
	assert.strictEqual(res.ok, false, `expected the follow-up to be refused, got: ${JSON.stringify(res)}`);
	return res as { ok: false; code: string; error: string };
};

test("an agy follow-up resumes the conversation before it prompts the recorded id", async () => {
	const { rt, restoreHome } = makeStub();
	const stub = stubTransport();
	rt.makeTransport = () => stub.transport;
	try {
		const res = await followUp(rt, deadSession(rt, "agy"), "next question");
		assert.deepStrictEqual(res, { ok: true });
		assert.deepStrictEqual(
			stub.calls.map((c) => c.method),
			["session/resume", "session/prompt"],
			"the recorded id means nothing to a process that did not mint it until the handshake asks",
		);
		assert.deepStrictEqual(stub.calls[0].params, { sessionId: "conv-1", cwd: "/work/checkout" });
	} finally {
		restoreHome();
	}
});

test("a resume asks in the workspace the conversation started in, not the one pi is sitting in now", async () => {
	const { rt, restoreHome } = makeStub();
	const stub = stubTransport();
	rt.makeTransport = () => stub.transport;
	try {
		const meta = deadSession(rt, "agy");
		meta.sessionCwd = "/work/where-it-started";
		rt.baseDir = "/work/somewhere-else";
		await followUp(rt, meta, "next");
		assert.strictEqual(stub.calls[0].params.cwd, "/work/where-it-started", "agy-acp never moves a conversation between workspaces");
		// And the older record, which has no `sessionCwd`, still resolves to the folder it was started in.
		const legacy = deadSession(rt, "agy", "conv-old");
		legacy.worktreePath = "/work/old-checkout";
		const older = stubTransport();
		rt.makeTransport = () => older.transport;
		await followUp(rt, legacy, "next");
		assert.strictEqual(older.calls[0].params.cwd, "/work/old-checkout");
	} finally {
		restoreHome();
	}
});

test("that workspace survives the record on disk, and a planted one does not", () => {
	// A restart reads `meta.json` back through `normalizeMeta`, so the field has to live in that record and
	// not merely on the in-memory one. A whitelisting reader there would drop it in silence, and every
	// resume after a restart would ask for the conversation in the wrong folder — a `session/resume`
	// refused with a workspace-mismatch message, which reads like the agent lost the conversation.
	const persisted = JSON.parse(JSON.stringify(metaFor("conv-1", { agent: "agy", sessionCwd: "/work/where-it-started" })));
	assert.strictEqual(normalizeMeta(persisted)?.sessionCwd, "/work/where-it-started");
	// And the record is read with the same trust as a planted state file after a crash, while this value
	// becomes a spawn cwd: a relative directory is dropped rather than resolved against whichever directory
	// pi happens to run in, so the session falls back to the runtime's base instead of walking.
	const planted = JSON.parse(JSON.stringify(metaFor("conv-1", { agent: "agy", sessionCwd: "../../elsewhere" })));
	assert.strictEqual(normalizeMeta(planted)?.sessionCwd, undefined);
	assert.strictEqual(normalizeMeta(metaFor("conv-1", { agent: "agy", worktreePath: "~/inside-a-string" }))?.worktreePath, undefined);
});

test("Devin is prompted with no handshake, because asking it would be a method not found", async () => {
	assert.strictEqual(devinDriver.resumeHandshake, undefined);
	assert.strictEqual(agyDriver.resumeHandshake !== undefined, true);
	const { rt, restoreHome } = makeStub();
	const stub = stubTransport();
	rt.makeTransport = () => stub.transport;
	try {
		assert.deepStrictEqual(await followUp(rt, deadSession(rt, "devin"), "next"), { ok: true });
		assert.deepStrictEqual(
			stub.calls.map((c) => c.method),
			["session/prompt"],
		);
	} finally {
		restoreHome();
	}
});

test("the vocabulary the restore answers with is the one the session configures against", async () => {
	const { rt, restoreHome } = makeStub();
	const stub = stubTransport({
		resume: { result: { sessionId: "conv-1", configOptions: [{ id: "model", options: ["gemini-3", "gemini-3-flash"] }] } },
	});
	rt.makeTransport = () => stub.transport;
	try {
		await followUp(rt, deadSession(rt, "agy"), "next");
		// `attach` installs an empty map and the handshake fills it: a session that came back with fewer
		// options than it advertised is a session whose stored selection was quietly not honoured.
		assert.deepStrictEqual(rt.configOptions.get("conv-1")?.get("model"), ["gemini-3", "gemini-3-flash"]);
	} finally {
		restoreHome();
	}
});

test("a refused resume is reported in the adapter's words, prompts nothing, and gives the slot back", async () => {
	const { rt, restoreHome } = makeStub();
	const stub = stubTransport({ resume: { error: new Error("session conv-1 belongs to /work/other, not /work/checkout") } });
	rt.makeTransport = () => stub.transport;
	try {
		const res = failure(await followUp(rt, deadSession(rt, "agy"), "next"));
		assert.strictEqual(res.code, "REATTACH_FAILED");
		assert.match(res.error, BELONGS_TO_RE, "the recorded workspace is the fix, so it is in the message");
		assert.ok(!stub.calls.some((c) => c.method === "session/prompt"), "nothing is prompted into a conversation nothing restored");
		assert.strictEqual(stub.disposed(), 1, "the process spawned for the attempt is not left running");
		assert.strictEqual(rt.slots.inFlight("agy"), 0, "the slot the follow-up reserved is back");
	} finally {
		restoreHome();
	}
});

test("an answer naming a different session is a refusal, not a prompt into someone else's context", async () => {
	const { rt, restoreHome } = makeStub();
	const stub = stubTransport({ resume: { result: { sessionId: "conv-someone-else" } } });
	rt.makeTransport = () => stub.transport;
	try {
		const res = failure(await followUp(rt, deadSession(rt, "agy"), "next"));
		assert.strictEqual(res.code, "REATTACH_FAILED");
		assert.match(res.error, DIFFERENT_ID_RE);
		assert.ok(!stub.calls.some((c) => c.method === "session/prompt"));
		assert.strictEqual(stub.disposed(), 1);
	} finally {
		restoreHome();
	}
});

test("what the agent corrected on the way in is recorded and said out loud", async () => {
	const { rt, notifications, restoreHome } = makeStub();
	const note = "stored mode 'plan' is not offered by this install; started in 'default'";
	const stub = stubTransport({
		resume: {
			result: {
				sessionId: "conv-1",
				modes: { currentModeId: "default" },
				configOptions: [
					{ id: "model", currentValue: "gemini-3-flash" },
					{ id: "effort", currentValue: "high" },
				],
				_meta: { restored: { cwd: "/work/checkout", notes: [note], droppedUpdates: 3 } },
			},
		},
	});
	rt.makeTransport = () => stub.transport;
	try {
		const meta = deadSession(rt, "agy");
		await followUp(rt, meta, "next");
		// The note is the agent's words; `meta.mode` is what `delegate_status` reports. A conversation that
		// came back in `default` and went on being reported as `accept-edits` is the lie `mode.changed` was
		// written to stop — and a restore emits no such update, so the answer's own id has to be read.
		assert.strictEqual(meta.mode, "default", "a mode the adapter corrected must not stay as requested");
		// The same staleness in the other two controls: the answer names what the conversation came back as,
		// and `delegate_status` reports `meta`. A restart then asks for the pair the agent already refused.
		assert.strictEqual(meta.model, "gemini-3-flash");
		assert.strictEqual(meta.thinking, "high");
		// The record had no `sessionCwd` and was resumed by the fallback expression; the store just named the
		// workspace it vouches for, so the next restart does not have to guess and hit a mismatch.
		assert.strictEqual(meta.sessionCwd, "/work/checkout");
		const resumed = stub.events.find((e) => e.type === "session_resumed") as LoggedRestore | undefined;
		assert.ok(resumed, "the session's own log says the conversation was restored, not restarted");
		assert.deepStrictEqual(resumed.data.notes, [note]);
		// Only `session/load` can fill this field, and the engine deliberately does not load; the pin says the
		// reader keeps reporting it if a future adapter answers a resume with one.
		assert.strictEqual(resumed.data.droppedUpdates, 3);
		assert.ok(
			notifications.some((n) => n[0].includes("resumed")),
			"a session that is not in the mode its record claims is an operator's problem, not a footnote",
		);
	} finally {
		restoreHome();
	}
});

test("an answer that does not name a conversation is a refusal, not a hope", async () => {
	const { rt, restoreHome } = makeStub();
	const stub = stubTransport({ resume: { result: {} } });
	rt.makeTransport = () => stub.transport;
	try {
		const res = failure(await followUp(rt, deadSession(rt, "agy"), "next"));
		assert.match(res.error, NO_SESSION_ID_RE);
		assert.strictEqual(
			stub.calls.some((c) => c.method === "session/prompt"),
			false,
			"nothing is prompted into a conversation the agent never confirmed it adopted",
		);
	} finally {
		restoreHome();
	}
});

test("two follow-ups that arrive inside the reattach window share one spawn", async () => {
	const { rt, restoreHome } = makeStub();
	const stub = stubTransport({ resume: { delayMs: 80 } });
	let spawns = 0;
	rt.makeTransport = () => {
		spawns++;
		return stub.transport;
	};
	try {
		const meta = deadSession(rt, "agy");
		// `activeClients` is filled at the end of a reattach, so both callers find no connection. Each still
		// reserves its own slot — the second is not told the agent is busy — but it must wait for the client
		// the first is making rather than spawning a rival that loses the store's lock and reports a refusal
		// reading like a dead conversation, which is what sends callers to `delegate_restart`.
		const results = await Promise.all([followUp(rt, meta, "first"), followUp(rt, meta, "second")]);
		assert.strictEqual(spawns, 1, "the second follow-up reuses the connection being made, it does not spawn another agent");
		assert.strictEqual(stub.calls.filter((c) => c.method === "session/resume").length, 1, "the conversation is adopted once");
		assert.ok(
			!results.some((r) => !r.ok && r.code === "REATTACH_FAILED"),
			`neither caller may be told the conversation could not be continued: ${JSON.stringify(results)}`,
		);
	} finally {
		restoreHome();
	}
});

// ---------------------------------------------------------------- the wire

const SERVER = path.join(import.meta.dirname, "fake-acp-server.mjs");
const spawned: DelegateTransport[] = [];
after(() => {
	for (const t of spawned) {
		try {
			t.dispose();
		} catch {}
	}
});

/** The fake behind the `agy-acp` name, with the agent's own conversation store in `storeDir`. */
function wireRuntime(storeDir: string, notes = ""): ReturnType<typeof makeStub> {
	const stub = makeStub();
	stub.rt.makeTransport = (cwd: string, plan) => {
		const t = new DelegateTransport(cwd, {
			...plan,
			command: process.execPath,
			args: [SERVER],
			env: { ...plan.env, FAKE_AGENT_NAME: "fake-agy", FAKE_DELAY_MS: "30", FAKE_STORE_DIR: storeDir, FAKE_RESUME_NOTES: notes },
		});
		spawned.push(t);
		return t;
	};
	return stub;
}

function callLog(storeDir: string, sessionId: string): string[] | null {
	try {
		return fs
			.readFileSync(path.join(storeDir, `${sessionId}.calls`), "utf8")
			.trim()
			.split("\n");
	} catch {
		return null;
	}
}

/**
 * The agent process going away between turns — what a pi restart or a crash looks like to the engine.
 *
 * `transport.dispose()` is the wrong simulation: it deliberately suppresses the child's exit callback (the
 * engine removes the client itself on every path where it disposes), so the session would keep a live
 * connection and `followUp` would never reach the reattach code. Killing the pid is the unowned death.
 */
function killChild(client: DelegateTransport): void {
	try {
		process.kill(client.pid, "SIGKILL");
	} catch {
		// Already gone, which is the same thing.
	}
}

/** One finished turn against a fresh store, and the transport that ran it. */
async function firstTurn(rt: DelegateRuntime, cwd: string) {
	const { meta, client } = await spawnSession(
		rt,
		agyDriver,
		{ model: undefined, thinking: undefined, mode: "accept-edits" },
		{ prompt: "first", cwd, createWorktree: false },
	);
	const reason = await startTurn(rt, meta, client, "first").done;
	assert.strictEqual(reason, "end_turn");
	return { meta, client };
}

test("on the wire: the restarted process adopts the recorded conversation and answers the follow-up", async () => {
	const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-store-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-cwd-"));
	const note = "stored effort was not available; started on high";
	const { rt, sent, notifications, restoreHome } = wireRuntime(storeDir, note);
	try {
		const { meta, client } = await firstTurn(rt, cwd);
		const sessionId = meta.sessionId;
		killChild(client);
		await waitFor(() => (rt.activeClients.has(sessionId) ? null : true));

		assert.deepStrictEqual(await followUp(rt, meta, "second question"), { ok: true });
		const calls = await waitFor(() => {
			const log = callLog(storeDir, sessionId);
			return log?.filter((l) => l.startsWith("prompt")).length === 2 ? log : null;
		}, 8000);
		// The agent refused the second prompt until the handshake asked — so this order is the proof, read
		// off the child's own log: created, answered, and only after adoption again.
		assert.deepStrictEqual(
			calls.map((l) => l.split(" ")[0]),
			["new", "prompt", "resume", "prompt"],
		);
		assert.notStrictEqual(calls[0].split(" ")[1], calls[3].split(" ")[1], "the second turn really ran in a new process");

		await waitFor(() => (sent.length >= 2 ? true : null), 8000);
		const events = fs.readFileSync(getEventsLogPath("pi-test", sessionId), "utf8");
		assert.match(events, RESUMED_EVENT_RE);
		assert.ok(
			notifications.some((n) => n[0].includes(note)),
			"the correction reaches the operator, not only the log",
		);
	} finally {
		restoreHome();
		fs.rmSync(storeDir, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("on the wire: a conversation the store does not have is a refusal, and nothing is prompted", async () => {
	const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-store-"));
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-cwd-"));
	const { rt, restoreHome } = wireRuntime(storeDir);
	try {
		const { meta, client } = await firstTurn(rt, cwd);
		const sessionId = meta.sessionId;
		killChild(client);
		await waitFor(() => (rt.activeClients.has(sessionId) ? null : true));
		// The store is the only thing that remembers the conversation; without it the honest answer is the
		// adapter's, and the caller's fix is `delegate_restart`, not a prompt into an empty session.
		fs.rmSync(path.join(storeDir, `${sessionId}.created`), { force: true });

		const res = failure(await followUp(rt, meta, "second question"));
		assert.strictEqual(res.code, "REATTACH_FAILED");
		assert.match(res.error, NOT_IN_STORE_RE);
		const calls = await waitFor(() => {
			const log = callLog(storeDir, sessionId);
			return log?.some((l) => l.startsWith("resume-unknown")) ? log : null;
		}, 8000);
		assert.strictEqual(
			calls.filter((l) => l.startsWith("prompt")).length,
			1,
			"only the first turn's prompt: the refused one never reached the agent",
		);
		assert.strictEqual(rt.slots.inFlight("agy"), 0);
	} finally {
		restoreHome();
		fs.rmSync(storeDir, { recursive: true, force: true });
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
