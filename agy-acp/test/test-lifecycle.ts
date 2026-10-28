// Issue #54: cancelling a turn, and the process lifecycle of a long unattended run.
//
// Every test here ends by looking at the process tree, because "the cancel returned" is not the
// acceptance criterion - a cancel that leaves agy, or the tool command it was running, alive is the
// failure this issue was filed for. Covered:
//
//   - session/cancel mid tool call: the prompt answers `cancelled`, the tool is reported failed, the
//     child dies, and a process it left in its process group is swept with it;
//   - session/cancel with a permission request on screen: the ask is denied with the cancel reason
//     (the hook is released, the client's dialog is closed) and the prompt answers `cancelled`;
//   - session/cancel of an agy that ignores SIGINT: the prompt still answers `cancelled` at once,
//     and the escalation ladder is what finally kills the group;
//   - the client hanging up (stdin EOF) and a SIGTERM to agy-acp itself: every child dies, every
//     bridge dir goes, and the process exits - and the hang-up is reported to the host *before*
//     anything is disposed, since the exit deadline is armed by that report (a host handler that
//     throws still gets its children disposed);
//   - a child that dies between turns: the session survives and the next prompt respawns with
//     `--conversation <id>`, and a cancel that lands during that respawn is answered too - the turn
//     the client called off is never launched into;
//   - the heartbeat: `_meta`-only session/updates that distinguish "waiting on a decision" from
//     "running", on a configurable interval, silent when the turn is over or the knob is 0.
import * as assert from "node:assert";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startAgyAcpServer, type AgyAcpServer, type AgyLaunchOptions } from "../src/server.ts";
import { BRIDGE_DIR_NAME_RE } from "../src/bridge-server.ts";

const FAKE = fileURLToPath(new URL("./fake-agy.ts", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

// Bridge dirs live in os.tmpdir(), and every agy-acp sweeps that root when it starts. This file
// starts real ones, so without a private TMPDIR they would remove - and log removing - dirs that
// belong to the suites running in parallel with this one.
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-lifecycle-root-"));
delete process.env.XDG_RUNTIME_DIR; // one root, the private one
process.on("exit", () => fs.rmSync(process.env.TMPDIR as string, { recursive: true, force: true }));

// ---------------------------------------------------------------- the process tree

/** Is this pid still there? (EPERM means it exists; ESRCH means it is gone.) */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Live pids whose cmdline contains `marker`. A /proc scan, and empty where /proc is not - which is
 * why the tests that need it assert `ownFakePids()` only after checking it can see anything.
 */
function pidsMatching(marker: string, childrenOf?: number): number[] {
	if (!fs.existsSync("/proc")) return [];
	const out: number[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === process.pid) continue;
		try {
			if (!fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) continue;
			if (childrenOf === undefined) {
				out.push(pid);
				continue;
			}
			// pid (comm) state ppid ... - comm may contain spaces, so split after the last ") ".
			const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
			if (stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1] === String(childrenOf)) out.push(pid);
		} catch {
			// the process went away mid-scan, which is the outcome we are waiting for anyway
		}
	}
	return out;
}

async function waitFor(what: string, timeoutMs: number, pred: () => boolean): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (pred()) return;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

function readMarkerFile(file: string): string | null {
	try {
		return fs.readFileSync(file, "utf8").trim();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------- the in-process harness

interface Harness {
	server: AgyAcpServer;
	request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
	notify: (method: string, params: Record<string, unknown>) => void;
	updates: Array<Record<string, unknown>>;
	logs: string[];
	permissionRequests: Array<{ id: number; params: Record<string, unknown> }>;
	close: () => Promise<void>;
}

const fixtureMeta = (fixture: string) =>
	JSON.parse(fs.readFileSync(path.join(path.dirname(FAKE), "fixtures", "stream", `${fixture}.meta.json`), "utf8")) as {
		args?: string;
		inputLines?: string[];
	};

/** One recorded input line as the text the client would have typed (the fake checks it). */
function textOfRecordedLine(line: string): string {
	const content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
	if (typeof content === "string") return content;
	const block = (Array.isArray(content) ? content : []).find((p) => (p as { type?: string }).type === "text") as
		| { text?: string }
		| undefined;
	if (block?.text) return block.text;
	throw new Error(`no usable text in the recorded input line: ${line.slice(0, 120)}`);
}

/** The recorded user lines of a fixture, in the order the fake expects them one by one. */
function recordedPrompts(fixture: string): string[] {
	const lines = fixtureMeta(fixture).inputLines ?? [];
	if (lines.length === 0) throw new Error(`fixture ${fixture} records no input line`);
	return lines.map(textOfRecordedLine);
}

const recordedPrompt = (fixture: string): string => recordedPrompts(fixture)[0];

/**
 * The argv the record implies and the launcher has to pass back (the fake checks them): the in-process
 * harness puts these in its launch options, the spawned one in its command wrapper.
 */
function recordedAgyFlags(fixture: string): string[] {
	const args = String(fixtureMeta(fixture).args ?? "")
		.split(/\s+/)
		.filter(Boolean);
	const out: string[] = [];
	for (let i = 1; i < args.length; i++) {
		const t = args[i];
		if (t === "--model" || t === "--effort") out.push(t, args[++i]);
	}
	return out;
}

/** The real server over an in-memory stdio pair, driving the fake agy. */
async function startHarness(
	fixture: string,
	extraEnv: Record<string, string>,
	extraLaunch: Partial<AgyLaunchOptions>,
	// The server's own options beyond input/output/log/agy - currently `onClose`, which changes who
	// owns the teardown (the host's exit path, or the server on close).
	extraServer: Pick<Parameters<typeof startAgyAcpServer>[0], "onClose"> = {},
): Promise<Harness> {
	const input = new PassThrough();
	const output = new PassThrough();
	const updates: Array<Record<string, unknown>> = [];
	const permissionRequests: Array<{ id: number; params: Record<string, unknown> }> = [];
	const logs: string[] = [];
	const pendingIds = new Map<number, (frame: Record<string, unknown>) => void>();
	let buffer = "";
	let nextId = 1;

	const launch: AgyLaunchOptions = {
		argvPrefix: [process.execPath, FAKE],
		env: { ...process.env, FAKE_AGY_FIXTURE: fixture, FAKE_AGY_INIT_DELAY_MS: "5", FAKE_AGY_LINE_GAP_MS: "3", ...extraEnv },
		clientDeadlineMs: 5000,
		hookDeadlineMs: 60000,
		hookTimeoutSec: 30,
		probeTimeoutMs: 4000,
		graceMs: 100,
		termMs: 200,
		cancelEscalateMs: 300,
		heartbeatMs: 0, // the beat is off unless the test asks for it (a busy stream is not the default)
		...extraLaunch,
	};
	// The recorded argv implies the model/effort the driver must pass back (the fake checks them).
	const implied = recordedAgyFlags(fixture);
	const modelAt = implied.indexOf("--model");
	if (modelAt >= 0) launch.model = implied[modelAt + 1];
	const effortAt = implied.indexOf("--effort");
	if (effortAt >= 0) launch.effort = implied[effortAt + 1];

	const server = startAgyAcpServer({ input, output, log: (m) => logs.push(m), agy: launch, ...extraServer });

	const dispatch = (frame: Record<string, unknown>): void => {
		if (frame.id !== undefined && frame.method !== undefined) {
			permissionRequests.push({ id: frame.id as number, params: (frame.params ?? {}) as Record<string, unknown> });
		} else if (frame.id !== undefined) {
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
			if (line.trim() !== "") dispatch(JSON.parse(line) as Record<string, unknown>);
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
			pendingIds.set(id, (frame) => {
				clearTimeout(timer);
				if (frame.error) {
					const e = frame.error as { code?: number; message?: string };
					reject(new Error(`JSON-RPC ${e.code}: ${e.message}`));
				} else resolve((frame.result ?? {}) as Record<string, unknown>);
			});
			input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});

	return {
		server,
		request,
		notify: (method, params) => input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
		updates,
		logs,
		permissionRequests,
		close: async () => {
			input.end();
			await server.disposeSessions();
		},
	};
}

async function newSession(h: Harness): Promise<string> {
	const r = await h.request("session/new", { cwd: process.cwd(), mcpServers: [] });
	assert.strictEqual(typeof r.sessionId, "string", `session/new: ${JSON.stringify(r)}`);
	return r.sessionId as string;
}

const promptOf = (sid: string, text: string) => ({ sessionId: sid, prompt: [{ type: "text", text }] });

/** The tool_call / tool_call_update frames of a session. */
const toolUpdates = (h: Harness) => h.updates.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update");
const textOf = (u: Record<string, unknown> | undefined) => JSON.stringify(u ?? {});
const heartbeats = (h: Harness) => h.updates.filter((u) => u.sessionUpdate === "heartbeat");

// ---------------------------------------------------------------- session/cancel

test("session/cancel during a tool call: the prompt answers cancelled, the tool is failed, nothing is left running", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-cancel-tool-"));
	const childPidFile = path.join(tmp, "group-child.pid");
	const h = await startHarness("interrupted-sigint", { FAKE_AGY_GROUP_CHILD: "30", FAKE_AGY_CHILD_PID_FILE: childPidFile }, {});
	try {
		const sid = await newSession(h);
		const toolCommandPid = await waitFor("the tool command to start", 5000, () => readMarkerFile(childPidFile) !== null).then(() =>
			Number(readMarkerFile(childPidFile)),
		);
		const turn = h.request("session/prompt", promptOf(sid, recordedPrompt("interrupted-sigint")));
		await waitFor("the tool call update", 5000, () => toolUpdates(h).some((u) => u.sessionUpdate === "tool_call"));
		const agyPids = pidsMatching("fake-agy.ts", process.pid);
		assert.ok(agyPids.length > 0, "the fake agy is running while its tool call is");

		h.notify("session/cancel", { sessionId: sid });

		// The answer the client asked for, and asked for now: no waiting for the ladder below.
		assert.deepStrictEqual(await turn, { stopReason: "cancelled" });
		const failed = toolUpdates(h).find((u) => u.status === "failed");
		assert.ok(failed, "the still-active tool call is reported failed");
		assert.match(textOf(failed), /cancelled/, "the failed tool call carries the cancellation as its reason");
		assert.ok(
			h.logs.some((l) => /cancelling the turn \(SIGINT/.test(l)),
			"the SIGINT and its escalation window are logged",
		);

		// The tree: agy itself, and the tool command it left behind in the group. The second one is
		// the point of the sweep - a signal aimed at agy alone never reaches it.
		await waitFor("agy to die", 5000, () => !agyPids.some(alive));
		await waitFor("the tool command in agy's process group to be swept", 5000, () => !alive(toolCommandPid));
		assert.deepStrictEqual(pidsMatching("fake-agy.ts", process.pid), [], "no agy child of this test is left");
		assert.ok(
			h.logs.some((l) => /still has members after agy exited/.test(l)),
			"the sweep of the leftovers is logged",
		);
	} finally {
		await h.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("session/cancel with a permission request on screen: the ask is denied with the cancel reason", async () => {
	const h = await startHarness("tool-allowed-skip-permissions", { FAKE_AGY_RUN_HOOKS: "1" }, { heartbeatMs: 100, cancelEscalateMs: 300 });
	try {
		const sid = await newSession(h);
		const turn = h.request("session/prompt", promptOf(sid, recordedPrompt("tool-allowed-skip-permissions")));
		await waitFor("a permission request", 8000, () => h.permissionRequests.length > 0);
		const agyPids = pidsMatching("fake-agy.ts", process.pid);
		// The distinction a stall watchdog acts on: this turn is not stalled, it is waiting for a human.
		await waitFor("a heartbeat that reports the wait", 3000, () =>
			heartbeats(h).some((u) => (u._meta as { heartbeat?: { state?: string } }).heartbeat?.state === "waiting_permission"),
		);

		h.notify("session/cancel", { sessionId: sid });

		assert.deepStrictEqual(await turn, { stopReason: "cancelled" });
		// The client's dialog is closed by us: an ask that silently stops existing is a hung prompt.
		const settled = h.updates.find((u) => (u._meta as { permission?: { state?: string } } | undefined)?.permission?.state === "cancelled");
		assert.ok(settled, "the pending ask gets a tool_call_update settling the permission metadata");
		assert.match(textOf(settled), /cancelled/, "and it says why");
		// The hook is released with the same reason, so the model reads a cancellation, not a timeout.
		const toolFailures = toolUpdates(h).filter((u) => u.status === "failed");
		assert.ok(toolFailures.length > 0, "the tool call whose ask was cancelled is reported failed");
		assert.ok(
			h.logs.some((l) => /denying 1 pending request/.test(l)),
			"the denial of the pending request is logged",
		);
		await waitFor("the cancelled turn's child to go away", 5000, () => !agyPids.some(alive));
	} finally {
		await h.close();
	}
});

test("session/cancel of an agy that ignores SIGINT: the prompt answers cancelled anyway, the ladder kills the group", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-cancel-stubborn-"));
	const childPidFile = path.join(tmp, "group-child.pid");
	const h = await startHarness(
		"interrupted-sigint",
		{ FAKE_AGY_IGNORE_SIGNALS: "1", FAKE_AGY_GROUP_CHILD: "30", FAKE_AGY_CHILD_PID_FILE: childPidFile },
		{ cancelEscalateMs: 300, graceMs: 100, termMs: 200 },
	);
	try {
		const sid = await newSession(h);
		await waitFor("the tool command to start", 5000, () => readMarkerFile(childPidFile) !== null);
		const turn = h.request("session/prompt", promptOf(sid, recordedPrompt("interrupted-sigint")));
		await waitFor("the tool call update", 5000, () => toolUpdates(h).some((u) => u.sessionUpdate === "tool_call"));
		const agyPids = pidsMatching("fake-agy.ts", process.pid);

		h.notify("session/cancel", { sessionId: sid });

		// The cancellation is not held hostage by a wedged child: the client is answered immediately,
		// while the ladder runs (SIGINT ignored, SIGTERM ignored - only SIGKILL finishes the job).
		assert.deepStrictEqual(await turn, { stopReason: "cancelled" });
		await waitFor("the escalation to run", 5000, () => h.logs.some((l) => /ignored SIGINT for 300 ms/.test(l)));
		await waitFor("the stubborn agy to die", 5000, () => !agyPids.some(alive));
		assert.ok(
			h.logs.some((l) => /teardown ladder on its process group/.test(l)),
			"the escalation names the group ladder",
		);
		// A SIGKILLed agy leaves its tool command to us: the sweep of the group is what takes it.
		await waitFor("the tool command to be swept with it", 6000, () => !alive(Number(readMarkerFile(childPidFile))));
		assert.deepStrictEqual(pidsMatching("fake-agy.ts", process.pid), [], "nothing of this session is left");
	} finally {
		await h.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("session/cancel between turns leaves the healthy child alone", async () => {
	const h = await startHarness("simple-multiturn-textblocks", {}, {});
	try {
		const sid = await newSession(h);
		const [turn1, turn2] = recordedPrompts("simple-multiturn-textblocks");
		const first = await h.request("session/prompt", promptOf(sid, turn1));
		assert.strictEqual(first.stopReason, "end_turn", "a completed turn first");
		const before = pidsMatching("fake-agy.ts", process.pid);
		assert.ok(before.length > 0, "the child is still alive between turns");

		h.notify("session/cancel", { sessionId: sid });
		await new Promise((r) => setTimeout(r, 300));

		// Nothing was hung. Killing a healthy child here would only buy a multi-second resume, so the
		// cancel is a no-op - and it says so, rather than being silently swallowed.
		assert.deepStrictEqual(pidsMatching("fake-agy.ts", process.pid), before, "the idle child is not interrupted");
		assert.ok(
			h.logs.some((l) => /no turn in flight - nothing to cancel/.test(l)),
			"the no-op is logged",
		);
		const second = await h.request("session/prompt", promptOf(sid, turn2));
		assert.strictEqual(second.stopReason, "end_turn", "and the same session keeps working");
	} finally {
		await h.close();
	}
});

// ---------------------------------------------------------------- the child dying on its own

test("a child that dies between turns: the session survives and the next prompt resumes the conversation", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-idle-death-"));
	const resumeFile = path.join(tmp, "resumed-conversation");
	const h = await startHarness(
		"simple-multiturn-textblocks",
		{ FAKE_AGY_IDLE_EXIT_MS: "700", FAKE_AGY_ALLOW_RESUME: "1", FAKE_AGY_RESUME_SEEN_FILE: resumeFile },
		{},
	);
	try {
		const sid = await newSession(h);
		const text = recordedPrompt("simple-multiturn-textblocks");
		const first = await h.request("session/prompt", promptOf(sid, text));
		assert.strictEqual(first.stopReason, "end_turn", "the first turn completes on the child that will die");

		// The child goes away with no turn in flight. Nothing may be reported to the client for that:
		// the session just marks itself for a respawn.
		await waitFor("the idle child to exit", 5000, () => h.logs.some((l) => /agy exited .* the next prompt respawns/.test(l)));
		assert.deepStrictEqual(
			h.updates.filter((u) => u.sessionUpdate === "tool_call" || u.status === "failed"),
			[],
			"no update for a death between turns",
		);

		const second = await h.request("session/prompt", promptOf(sid, text));
		assert.strictEqual(second.stopReason, "end_turn", "the respawned child answers the next prompt");
		// A respawn that starts a new conversation loses the client's context, so it must resume by id.
		assert.strictEqual(readMarkerFile(resumeFile), sid, "the respawn passed --conversation with this session's id");
	} finally {
		await h.close();
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("a cancel that arrives while the child is being respawned still answers cancelled, and starts nothing", async () => {
	const h = await startHarness(
		"simple-multiturn-textblocks",
		{ FAKE_AGY_IDLE_EXIT_MS: "300", FAKE_AGY_INIT_DELAY_MS: "1200", FAKE_AGY_ALLOW_RESUME: "1" },
		{},
	);
	try {
		const sid = await newSession(h);
		const text = recordedPrompt("simple-multiturn-textblocks");
		const first = await h.request("session/prompt", promptOf(sid, text));
		assert.strictEqual(first.stopReason, "end_turn", "a first turn to die at");
		await waitFor("the idle child to exit", 5000, () => h.logs.some((l) => /agy exited .* the next prompt respawns/.test(l)));

		// The respawn's probe takes the fake's 1200 ms init delay, and the frames are handled in the
		// order they arrive: the cancel lands while the turn has a pending prompt and no child yet -
		// the one window in which a cancel could have been swallowed.
		const turn = h.request("session/prompt", promptOf(sid, text));
		const updatesWhenCancelled = h.updates.length;
		h.notify("session/cancel", { sessionId: sid });

		assert.deepStrictEqual(await turn, { stopReason: "cancelled" }, `the cancel is answered even mid-respawn; logs: ${h.logs.join(" | ")}`);
		// Stopped rather than launched into: the respawned child is interrupted and its prompt is never
		// sent, so nothing of that turn reaches the client.
		await waitFor("the respawned child to be interrupted", 5000, () => h.logs.some((l) => /cancelling the turn/.test(l)));
		await waitFor("no child of the cancelled turn to be left", 6000, () => pidsMatching("fake-agy.ts", process.pid).length === 0);
		assert.ok(
			!h.updates.slice(updatesWhenCancelled).some((u) => u.sessionUpdate === "agent_message_chunk"),
			"and nothing of that turn reached the client",
		);
	} finally {
		await h.close();
	}
});

// ---------------------------------------------------------------- the heartbeat

test("the connection close hands the teardown to the host before anything is disposed", async () => {
	// The exit deadline is armed by `onClose`, so a teardown that runs before that call is a teardown
	// the deadline cannot bound - which is the wedge the exit path exists to survive. The order is
	// therefore part of the contract: the host is told while the child is alive, and the child dies
	// because the host's dispose (the exit path's, inside the deadline) asked for it.
	const reasons: string[] = [];
	let aliveAtClose: boolean | null = null;
	const h = await startHarness(
		"simple-multiturn-textblocks",
		{},
		{},
		{
			onClose: (reason) => {
				reasons.push(reason);
				aliveAtClose = pidsMatching("fake-agy.ts", process.pid).length > 0;
			},
		},
	);
	try {
		await newSession(h);
		await waitFor("the session's child to be live", 8000, () => pidsMatching("fake-agy.ts", process.pid).length > 0);
		h.close(); // the client hangs up; no one else is disposing anything here
		await waitFor("the host to be told", 3000, () => reasons.length > 0);
		assert.ok(aliveAtClose, `the close is reported first, child still alive (saw ${aliveAtClose})`);
		await h.server.disposeSessions(); // what the exit path does, inside its deadline
		await waitFor("the child to be gone once the host disposed", 8000, () => pidsMatching("fake-agy.ts", process.pid).length === 0);
	} finally {
		await h.close();
	}
});

test("a host whose close handler throws still has its children disposed", async () => {
	// Handing the teardown over is a transfer of responsibility, not a way to skip it: a host that
	// cannot take the close must not end up with children nobody owns any more.
	const h = await startHarness(
		"simple-multiturn-textblocks",
		{},
		{},
		{
			onClose: () => {
				throw new Error("the host's exit path is itself wedged");
			},
		},
	);
	try {
		await newSession(h);
		const before = pidsMatching("fake-agy.ts", process.pid);
		assert.ok(before.length > 0, "the session's child is running");
		h.close();
		await waitFor("the failing handler to be logged", 3000, () => h.logs.some((l) => /connection-closed handler failed/.test(l)));
		await waitFor("the child to die anyway", 8000, () => !before.some(alive));
	} finally {
		await h.close();
	}
});

test("the heartbeat is a _meta-only session/update while a silent turn runs, and stops with it", async () => {
	const h = await startHarness("interrupted-sigint", {}, { heartbeatMs: 100 });
	try {
		const sid = await newSession(h);
		const turn = h.request("session/prompt", promptOf(sid, recordedPrompt("interrupted-sigint")));
		await waitFor("three heartbeats", 5000, () => heartbeats(h).length >= 3);
		const beats = heartbeats(h);
		const payload = (u: Record<string, unknown>) => (u._meta as { heartbeat: Record<string, unknown> }).heartbeat;
		assert.deepStrictEqual(beats[0] && Object.keys(beats[0]).sort(), ["_meta", "sessionUpdate"], "the beat carries _meta and nothing else");
		assert.ok(
			beats.every((u) => payload(u).state === "running"),
			"a silent turn that is not waiting on anyone reads as running",
		);
		assert.deepStrictEqual(
			beats.map((u) => payload(u).seq),
			[1, 2, 3].slice(0, beats.length),
			"the sequence counts up from 1",
		);
		const ages = beats.map((u) => Number(payload(u).turnMs));
		assert.ok(Number(payload(beats[2]).turnMs) >= 200, "the beat keeps time with the turn");
		assert.ok(
			ages.every((v, i) => i === 0 || v >= ages[i - 1]),
			"and never runs backwards",
		);

		h.notify("session/cancel", { sessionId: sid });
		assert.deepStrictEqual(await turn, { stopReason: "cancelled" });
		const after = heartbeats(h).length;
		await new Promise((r) => setTimeout(r, 350));
		assert.strictEqual(heartbeats(h).length, after, "a settled turn beats no more");
	} finally {
		await h.close();
	}
});

test("heartbeatMs=0 means no beat at all", async () => {
	const h = await startHarness("interrupted-sigint", {}, { heartbeatMs: 0 });
	try {
		const sid = await newSession(h);
		const turn = h.request("session/prompt", promptOf(sid, recordedPrompt("interrupted-sigint")));
		await waitFor("the tool call update", 5000, () => toolUpdates(h).some((u) => u.sessionUpdate === "tool_call"));
		await new Promise((r) => setTimeout(r, 350));
		assert.deepStrictEqual(heartbeats(h), [], "the knob at 0 is a silent stream");
		h.notify("session/cancel", { sessionId: sid });
		assert.deepStrictEqual(await turn, { stopReason: "cancelled" });
	} finally {
		await h.close();
	}
});

// ---------------------------------------------------------------- agy-acp itself going away

/** The bridge dirs a run left in a runtime dir (the session dirs, not the roots themselves). */
function bridgeDirs(root: string): string[] {
	try {
		return fs.readdirSync(root).filter((n) => BRIDGE_DIR_NAME_RE.test(n));
	} catch {
		return [];
	}
}

interface LiveServer {
	marker: string;
	logFile: string;
	lines: string[];
	request: (method: string, params: Record<string, unknown>) => void;
	stdinEnd: () => void;
	kill: (signal: NodeJS.Signals) => void;
	/** Resolves when the process is gone. If it never exits on its own, the test times out. */
	exited: Promise<{ code: number | null; signal: string | null }>;
}

/**
 * A real `agy-acp` process (main.ts) whose `agy` is the fake. `AGY_ACP_COMMAND` is a wrapper that
 * adds a --log-file naming this run, so every fake it spawns is identifiable in /proc: the fake
 * ignores --log-file, and so does its argv check.
 */
function spawnServer(tmp: string, fixture: string, extraEnv: Record<string, string>): LiveServer {
	const marker = `agy-acp-lifecycle-${path.basename(tmp)}`;
	const logFile = path.join(tmp, "agy-acp.log");
	const wrapper = path.join(tmp, "fake-agy-command.sh");
	// The wrapper stands in for a client that configures a model: it adds the flags the fixture's argv
	// implies (the fake refuses a drifted argv), plus a --log-file naming this run - which the fake
	// ignores and whose argv check skips it. That is how these tests find their own children in /proc.
	const extraFlags = [...recordedAgyFlags(fixture), "--log-file", path.join(tmp, `${marker}.agy.log`)]
		.map((a) => JSON.stringify(a))
		.join(" ");
	fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@" ${extraFlags}\n`, {
		mode: 0o755,
	});
	const child = spawn(process.execPath, [MAIN], {
		env: { ...process.env, AGY_ACP_COMMAND: wrapper, AGY_ACP_LOG: logFile, AGY_ACP_SHUTDOWN_TIMEOUT_MS: "6000", ...extraEnv },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const lines: string[] = [];
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		for (;;) {
			const i = buffer.indexOf("\n");
			if (i < 0) break;
			const line = buffer.slice(0, i);
			buffer = buffer.slice(i + 1);
			if (line.trim() !== "") lines.push(line);
		}
	});
	child.stderr.resume(); // diagnostics we do not read must still not be able to fill the pipe
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	let nextId = 1;
	return {
		marker,
		logFile,
		lines,
		request: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })}\n`),
		stdinEnd: () => child.stdin.end(),
		kill: (signal) => child.kill(signal),
		exited,
	};
}

const frameWith = (lines: string[], predicate: (f: Record<string, unknown>) => boolean) =>
	lines.some((l) => {
		try {
			return predicate(JSON.parse(l) as Record<string, unknown>);
		} catch {
			return false;
		}
	});

/** The spawned server's response to request `id`: an error frame is thrown, never waited out. */
async function responseOf(s: LiveServer, id: number): Promise<Record<string, unknown>> {
	await waitFor(`the response to request ${id}`, 20000, () => frameWith(s.lines, (f) => f.id === id));
	const frame = JSON.parse(s.lines.find((l) => frameWith([l], (f) => f.id === id)) ?? "{}") as {
		result?: Record<string, unknown>;
		error?: { code?: number; message?: string };
	};
	if (frame.error) throw new Error(`request ${id} failed: ${frame.error.code} ${frame.error.message}`);
	assert.ok(frame.result, `request ${id} returned neither a result nor an error`);
	return frame.result;
}

/** initialize, session/new and a prompt the fake is still running when the test hangs up. */
async function startATurn(s: LiveServer, fixture: string): Promise<string> {
	s.request("initialize", { protocolVersion: 1, clientInfo: { name: "lifecycle-test", version: "0" }, clientCapabilities: {} });
	await responseOf(s, 1);
	s.request("session/new", { cwd: process.cwd(), mcpServers: [] });
	const sid = String((await responseOf(s, 2)).sessionId);
	s.request("session/prompt", promptOf(sid, recordedPrompt(fixture)));
	await waitFor("the turn to start", 20000, () =>
		frameWith(
			s.lines,
			(f) => f.method === "session/update" && (f.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate === "tool_call",
		),
	);
	return sid;
}

const ENDS_AWAY = [
	{ how: "stdin EOF, the client hanging up", act: (s: LiveServer) => s.stdinEnd() },
	{ how: "a SIGTERM to agy-acp", act: (s: LiveServer) => s.kill("SIGTERM") },
];

for (const end of ENDS_AWAY) {
	test(`agy-acp going away mid turn (${end.how}) disposes its children, its bridge dirs and exits`, async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-exit-"));
		// An XDG_RUNTIME_DIR of our own, so the bridge dirs of this run are the only ones we can see.
		const s = spawnServer(tmp, "interrupted-sigint", {
			XDG_RUNTIME_DIR: path.join(tmp, "xdg"),
			FAKE_AGY_FIXTURE: "interrupted-sigint",
			FAKE_AGY_GROUP_CHILD: "30",
			FAKE_AGY_CHILD_PID_FILE: path.join(tmp, "group-child.pid"),
		});
		try {
			await startATurn(s, "interrupted-sigint");
			const agyPids = pidsMatching(s.marker);
			assert.ok(agyPids.length > 0, "the agy child is running mid turn");
			const toolCommandPid = Number(readMarkerFile(path.join(tmp, "group-child.pid")));
			const bridgeRoot = path.join(tmp, "xdg", "agy-acp");
			assert.ok(bridgeDirs(bridgeRoot).length > 0, "the session's bridge dir is in the runtime dir while it runs");

			end.act(s);

			// Bounded: a client that hung up must not leave a process nobody can reach any more.
			const exit = await s.exited;
			assert.deepStrictEqual(exit, { code: 0, signal: null }, "a clean exit, whichever reason told it to stop");
			await waitFor("every agy child to die", 5000, () => !agyPids.some(alive));
			// The tool command sat in that child's process group. Reaching it is what keeps a hang-up
			// from leaving a shell running a command nobody asked for any more.
			await waitFor("the tool command to be swept with it", 5000, () => !alive(toolCommandPid));
			await waitFor("the bridge dirs to be gone", 5000, () => bridgeDirs(bridgeRoot).length === 0);
			const log = fs.readFileSync(s.logFile, "utf8");
			assert.match(log, /shutdown: .+ - cancelling turns, denying pending requests, disposing children/);
			assert.match(log, /shutdown: cleanup finished in \d+ ms/, "and the cleanup finished inside its deadline");
		} finally {
			s.kill("SIGKILL");
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
}
