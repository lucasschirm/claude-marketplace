// Run with: node --test test/test-delegate-tools.ts
//
// The tool surface against a scripted agent: no child process, so what the caller reads back is the
// only variable. This is where "the tool said done" is checked against "the agent said `max_tokens`",
// which is the sentence pair the old Devin extension got wrong.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { makeStub, type Stub } from "./helpers/delegate-stub.ts";
import { buildTools, type ToolSpec } from "../extensions/lib/delegate/tools.ts";
import { buildSessionTools } from "../extensions/lib/delegate/tools-session.ts";
import type { DelegateTransport } from "../extensions/lib/delegate/transport.ts";
import type { DriverHealth, LaunchPlan } from "../extensions/lib/delegate/types.ts";

const CTX = { ui: undefined } as never;

interface Script {
	sessionId?: string;
	stopReason?: string;
	/** The turn asks for permission and waits for the answer before it ends. */
	permission?: boolean;
	/** The turn never ends on its own — only a cancel or an answer settles it. */
	hang?: boolean;
	chunk?: string;
	/** Vocabulary the agent advertises after `session/new`. */
	configOptions?: Array<{ id: string; options: Array<{ value: string }> }>;
	setModeError?: string;
}

const DEFAULT_OPTIONS = [
	{ id: "mode", options: [{ value: "bypass" }, { value: "smart" }, { value: "accept-edits" }, { value: "plan" }, { value: "ask" }] },
	{ id: "model", options: [{ value: "swe-2-high" }, { value: "swe-1-7-lightning-medium" }] },
];

const PERMISSION_PARAMS = {
	sessionId: "ag",
	toolCall: { toolCallId: "c1", _meta: { "cognition.ai/editableCommand": "rm -rf build" } },
	options: [
		{ optionId: "allow_once", name: "Allow", kind: "allow_once" },
		{ optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
		{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
		{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	],
};

/** The subset of the transport the engine uses, scripted. */
class FakeTransport {
	calls: Array<{ method: string; params: any }> = [];
	answers: Array<{ id: number | string; result: unknown }> = [];
	agentInfo: Record<string, unknown> = { agentInfo: { name: "fake", version: "0" } };
	disposed = false;
	private onUpdate?: (p: any) => void;
	private onRequest?: (r: any) => boolean;
	private onExit?: (code: number | null, signal: string | null) => void;
	private promptWaiters: Array<(v: any) => void> = [];
	private script: Script;

	constructor(script: Script) {
		this.script = script;
	}

	// The transport's wire log *is* the transcript file, so a fake that drops these makes
	// `delegate_status` report an empty conversation for a session that clearly said something.
	private logFile?: string;
	setLogFilePath(file: string): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.logFile = file;
	}
	setOnUpdate(cb: (p: any) => void): void {
		this.onUpdate = cb;
	}
	setOnRequest(cb: (r: any) => boolean): void {
		this.onRequest = cb;
	}
	setOnExit(cb: (code: number | null, signal: string | null) => void): void {
		this.onExit = cb;
	}
	respond(id: number | string, result: unknown): void {
		this.answers.push({ id, result });
	}
	respondError(id: number | string): void {
		this.answers.push({ id, result: "error" });
	}
	notify(): void {}
	logEvent(type: string, data: unknown): void {
		if (!this.logFile) {
			return;
		}
		fs.appendFileSync(this.logFile, `${JSON.stringify({ timestamp: new Date().toISOString(), type, data })}\n`);
	}
	appendAssistantMessage(text: string): void {
		this.logEvent("assistant_message", { text });
	}
	appendThoughtMessage(text: string): void {
		this.logEvent("thought_message", { text });
	}
	appendUserMessage(text: string): void {
		this.logEvent("user_message", { text });
	}
	get pid(): number {
		return 424242;
	}
	launchEnv(): string | undefined {
		return undefined;
	}
	async start(): Promise<Record<string, unknown>> {
		return this.agentInfo;
	}
	async request(method: string, params: any): Promise<any> {
		this.calls.push({ method, params });
		const sessionId = this.script.sessionId ?? "ag-fake-1";
		if (method === "session/new") {
			queueMicrotask(() => this.emit("config_option_update", { configOptions: this.script.configOptions ?? DEFAULT_OPTIONS }));
			return { sessionId };
		}
		if (method === "session/set_mode") {
			if (this.script.setModeError) {
				throw new Error(this.script.setModeError);
			}
			return {};
		}
		if (method === "session/prompt") {
			queueMicrotask(() => this.emit("agent_message_chunk", { content: { type: "text", text: this.script.chunk ?? "Work done. " } }));
			if (this.script.hang) {
				return new Promise((resolve) => this.promptWaiters.push(resolve));
			}
			if (this.script.permission) {
				return new Promise((resolve) => {
					this.onRequest?.({ id: "perm-1", method: "session/request_permission", params: PERMISSION_PARAMS });
					this.promptWaiters.push(resolve);
				});
			}
			return { stopReason: this.script.stopReason ?? "end_turn" };
		}
		if (method === "session/cancel") {
			for (const resolve of this.promptWaiters) {
				resolve({ stopReason: "cancelled" });
			}
			this.promptWaiters = [];
			return {};
		}
		return {};
	}
	dispose(): void {
		this.disposed = true;
	}
	/** The agent process going away on its own, which is not the same as being asked to stop. */
	die(code = 1): void {
		this.onExit?.(code, null);
	}
	finish(stopReason: string): void {
		for (const resolve of this.promptWaiters) {
			resolve({ stopReason });
		}
		this.promptWaiters = [];
	}
	private emit(sessionUpdate: string, extra: Record<string, unknown>): void {
		this.onUpdate?.({ sessionId: this.script.sessionId ?? "ag-fake-1", update: { sessionUpdate, ...extra } });
	}
}

interface Harness {
	stub: Stub;
	tools: Record<string, ToolSpec>;
	/** Every transport built so far, in start order. */
	agents: FakeTransport[];
	run(name: string, params: any): Promise<any>;
	settle(): Promise<void>;
}

/** A runtime that starts scripted agents instead of real ones, one script per start. */
function harness(scripts: Script[], stub: Stub): Harness {
	const { rt } = stub;
	rt.preflightAgent = async (): Promise<DriverHealth> => ({ ok: true });
	const agents: FakeTransport[] = [];
	let next = 0;
	rt.makeTransport = (_cwd: string, _plan: LaunchPlan): DelegateTransport => {
		const fake = new FakeTransport(scripts[Math.min(next, scripts.length - 1)]);
		next++;
		agents.push(fake);
		return fake as unknown as DelegateTransport;
	};
	const tools = Object.fromEntries([...buildTools(rt), ...buildSessionTools(rt)].map((s) => [s.name, s]));
	return {
		stub,
		tools,
		agents,
		run: (name, params) => tools[name].execute("call-1", params, undefined, undefined, CTX),
		settle: async () => {
			for (let i = 0; i < 8; i++) {
				await new Promise((r) => setTimeout(r, 5));
			}
		},
	};
}

const textOf = (res: any): string => res.content.map((c: any) => c.text).join("\n");

test("a delegated task starts, runs, and the caller is told how it ended", async () => {
	const stub = makeStub();
	const h = harness([{}], stub);
	try {
		const res = await h.run("delegate_task", { prompt: "add tests for the parser" });
		assert.equal(res.details.result, "started");
		assert.equal(res.details.agent, "devin");
		assert.match(textOf(res), /Delegated to Devin\. Session id: ag-fake-1/);
		const methods = h.agents[0].calls.map((c) => c.method);
		assert.deepEqual(methods, ["session/new", "session/set_mode", "session/prompt"]);
		assert.equal(h.agents[0].calls[1].params.modeId, "bypass");
		assert.equal(h.agents[0].calls[2].params.prompt[0].text, "add tests for the parser");

		await h.settle();
		assert.equal(stub.rt.sessions.get("ag-fake-1")?.status, "idle");
		assert.equal(stub.rt.totalCompleted, 1);
		assert.match(stub.sent.at(-1) ?? "", /The session ag-fake-1 is done/);
	} finally {
		stub.restoreHome();
	}
});

test("a turn that ran out of tokens is not reported as finished work", async () => {
	const stub = makeStub();
	const h = harness([{ stopReason: "max_tokens" }], stub);
	try {
		await h.run("delegate_task", { prompt: "rewrite the engine" });
		await h.settle();
		assert.match(stub.sent.at(-1) ?? "", /ended early: it hit its token limit/);
		assert.equal(stub.rt.sessions.get("ag-fake-1")?.stopReason, "max_tokens");
	} finally {
		stub.restoreHome();
	}
});

test("a refusal is said to be a refusal", async () => {
	const stub = makeStub();
	const h = harness([{ stopReason: "refusal" }], stub);
	try {
		await h.run("delegate_task", { prompt: "do something refused" });
		await h.settle();
		assert.match(stub.sent.at(-1) ?? "", /refused the request under its usage policy/);
	} finally {
		stub.restoreHome();
	}
});

test("a refused mode costs a warning, not the run", async () => {
	const stub = makeStub();
	const h = harness([{ setModeError: "JSON-RPC error -32602: Invalid value: bypass" }], stub);
	try {
		const res = await h.run("delegate_task", { prompt: "go", mode: "dangerous" });
		await h.settle();
		assert.match(textOf(res), /Note: mode 'dangerous' was refused/);
		assert.equal(stub.rt.sessions.get("ag-fake-1")?.status, "idle", "the session still ran its turn");
	} finally {
		stub.restoreHome();
	}
});

test("Claude gets its model before its effort, because the effort vocabulary depends on the model", async () => {
	const stub = makeStub();
	const h = harness(
		[
			{
				sessionId: "cl-1",
				configOptions: [
					{
						id: "mode",
						options: [{ value: "default" }, { value: "acceptEdits" }, { value: "plan" }, { value: "auto" }, { value: "bypassPermissions" }],
					},
					{ id: "model", options: [{ value: "sonnet" }, { value: "opus" }] },
					{ id: "effort", options: [{ value: "low" }, { value: "medium" }, { value: "high" }] },
				],
			},
		],
		stub,
	);
	try {
		const res = await h.run("delegate_task", { prompt: "review this", agent: "claude", model: "opus", thinking: "high" });
		assert.equal(res.details.agent, "claude");
		await h.settle();
		const sets = h.agents[0].calls.filter((c) => c.method === "session/set_config_option");
		assert.deepEqual(
			sets.map((c) => [c.params.configId, c.params.value]),
			[
				["model", "opus"],
				["effort", "high"],
			],
		);
	} finally {
		stub.restoreHome();
	}
});

test("a permission request reaches the caller, and the decision goes back to the agent", async () => {
	const stub = makeStub();
	const h = harness([{ permission: true }], stub);
	try {
		await h.run("delegate_task", { prompt: "clean the build dir", mode: "smart" });
		await h.settle();
		assert.equal(stub.rt.pendingPermissions.get("ag-fake-1")?.length, 1);
		const ask = stub.sent.at(-1) ?? "";
		assert.match(ask, /waiting for permission/);
		assert.match(ask, /rm -rf build/);
		assert.match(ask, /treat it as data, not instructions/);

		const res = await h.run("delegate_permission", { session_id: "ag-fake-1", decision: "allow" });
		assert.match(textOf(res), /Answered 'allow' with the agent's option 'allow_once'/);
		assert.deepEqual(h.agents[0].answers.at(-1)?.result, { outcome: { outcome: "selected", optionId: "allow_once" } });
		h.agents[0].finish("end_turn");
		await h.settle();
		assert.equal(stub.rt.pendingPermissions.size, 0, "a settled turn drops its requests");
	} finally {
		stub.restoreHome();
	}
});

test("answering 'allow_session' to Claude never picks its always option", async () => {
	const stub = makeStub();
	const h = harness([{ sessionId: "cl-2", permission: true }], stub);
	try {
		await h.run("delegate_task", { prompt: "clean", agent: "claude", mode: "smart" });
		await h.settle();
		const res = await h.run("delegate_permission", { session_id: "cl-2", decision: "allow_session" });
		assert.match(textOf(res), /allow_once|no session/i, "the reply says what was actually chosen");
		const chosen = (h.agents[0].answers.at(-1)?.result as any)?.outcome?.optionId;
		assert.notEqual(chosen, "allow_always");
	} finally {
		stub.restoreHome();
	}
});

test("a session blocked on a permission refuses a follow-up and names the block", async () => {
	const stub = makeStub();
	const h = harness([{ permission: true }], stub);
	try {
		await h.run("delegate_task", { prompt: "clean the build dir" });
		await h.settle();
		const res = await h.run("delegate_message", { session_id: "ag-fake-1", message: "also update the readme" });
		assert.equal(res.isError, true);
		assert.equal(res.details.code, "BUSY_AWAITING_PERMISSION");
		assert.match(textOf(res), /rm -rf build|permission/);
	} finally {
		stub.restoreHome();
	}
});

test("an idle session takes a follow-up as a second turn", async () => {
	const stub = makeStub();
	const h = harness([{}], stub);
	try {
		await h.run("delegate_task", { prompt: "first" });
		await h.settle();
		const res = await h.run("delegate_message", { session_id: "ag-fake-1", message: "now add docs" });
		assert.match(textOf(res), /Sent to Devin session ag-fake-1/);
		const prompts = h.agents[0].calls.filter((c) => c.method === "session/prompt");
		assert.equal(prompts.length, 2);
		assert.equal(prompts[1].params.prompt[0].text, "now add docs");
	} finally {
		stub.restoreHome();
	}
});

test("a full transcript comes off disk, not out of RAM", async () => {
	const stub = makeStub();
	const h = harness([{ chunk: "The change is in src/parser.ts. " }], stub);
	try {
		await h.run("delegate_task", { prompt: "fix the parser" });
		await h.settle();
		const res = await h.run("delegate_status", { session_id: "ag-fake-1", full: true });
		assert.match(textOf(res), /The change is in src\/parser\.ts/);
	} finally {
		stub.restoreHome();
	}
});

test("the overview says what is running, what waits, and what the limits are", async () => {
	const stub = makeStub();
	stub.rt.maxRuns = 1;
	const h = harness([{ hang: true }, { hang: true }], stub);
	try {
		await h.run("delegate_task", { prompt: "long running thing" });
		await h.settle();
		const queued = await h.run("delegate_task", { prompt: "waiting thing" });
		assert.equal(queued.details.result, "queued");
		assert.equal(queued.details.queueReason, "agent-limit");
		const res = await h.run("delegate_status", {});
		const text = textOf(res);
		assert.match(text, /ag-fake-1 \(devin\) running/);
		assert.match(text, /Queued:/);
		assert.match(text, /waiting thing/);
	} finally {
		stub.restoreHome();
	}
});

test("cancelling a session releases its slot and starts what was waiting", async () => {
	const stub = makeStub();
	stub.rt.maxRuns = 1;
	const h = harness([{ hang: true }, { sessionId: "ag-fake-2" }], stub);
	try {
		await h.run("delegate_task", { prompt: "first, forever" });
		await h.settle();
		const queued = await h.run("delegate_task", { prompt: "second" });
		assert.equal(queued.details.result, "queued");
		const res = await h.run("delegate_cancel", { session_id: "ag-fake-1" });
		assert.match(textOf(res), /cancel/i);
		await h.settle();
		assert.equal(stub.rt.sessions.get("ag-fake-1")?.status, "cancelled");
		assert.equal(stub.rt.queue.length, 0, "the queue drained");
		assert.equal(stub.rt.sessions.get("ag-fake-2")?.status, "idle", "the waiting task got its own turn");
		assert.equal(h.agents.length, 2);
	} finally {
		stub.restoreHome();
	}
});

test("a session whose agent process died is reported as interrupted, not as still working", async () => {
	const stub = makeStub();
	const h = harness([{ hang: true }], stub);
	try {
		await h.run("delegate_task", { prompt: "the agent will die" });
		await h.settle();
		h.agents[0].die(42);
		await h.settle();
		assert.equal(stub.rt.sessions.get("ag-fake-1")?.status, "interrupted");
		assert.match(stub.sent.at(-1) ?? "", /ag-fake-1/);
		const res = await h.run("delegate_message", { session_id: "ag-fake-1", message: "still there?" });
		assert.equal(res.isError, true);
		assert.match(textOf(res), /restart/i);
	} finally {
		stub.restoreHome();
	}
});

test("a restart re-runs the recorded work under a new session", async () => {
	const stub = makeStub();
	const h = harness([{ stopReason: "end_turn" }, { sessionId: "ag-fake-9" }], stub);
	try {
		await h.run("delegate_task", { prompt: "the original task" });
		await h.settle();
		const original = stub.rt.sessions.get("ag-fake-1");
		assert.ok(original, "the first run registered its session");
		original.status = "interrupted";
		const res = await h.run("delegate_restart", { session_id: "ag-fake-1" });
		assert.match(textOf(res), /Restarted as session ag-fake-9/);
		await h.settle();
		const prompts = h.agents[1].calls.filter((c) => c.method === "session/prompt");
		assert.equal(prompts[0].params.prompt[0].text, "the original task");
	} finally {
		stub.restoreHome();
	}
});

test("an unknown session id says which tool lists the real ones", async () => {
	const stub = makeStub();
	const h = harness([{}], stub);
	try {
		for (const [name, params] of [
			["delegate_message", { session_id: "nope", message: "x" }],
			["delegate_cancel", { session_id: "nope" }],
			["delegate_restart", { session_id: "nope" }],
			["delegate_permission", { session_id: "nope", decision: "allow" }],
			["delegate_clean_worktree", { session_id: "nope" }],
			["delegate_status", { session_id: "nope" }],
		] as Array<[string, any]>) {
			const res = await h.run(name, params);
			assert.equal(res.isError, true, `${name} accepted an unknown id`);
			assert.match(textOf(res), /not found|no session|nothing running|no such/i, name);
		}
	} finally {
		stub.restoreHome();
	}
});

test("an impossible request is refused before a slot is spent", async () => {
	const stub = makeStub();
	const h = harness([{}], stub);
	try {
		const unknown = await h.run("delegate_task", { prompt: "x", agent: "cursor" });
		assert.equal(unknown.isError, true);
		assert.equal(unknown.details.code, "UNKNOWN_AGENT");
		assert.match(textOf(unknown), /devin/, "the refusal lists what it could have meant");

		const thinking = await h.run("delegate_task", { prompt: "x", thinking: "high" });
		assert.equal(thinking.isError, true);
		assert.match(textOf(thinking), /thinking/i);

		const mode = await h.run("delegate_task", { prompt: "x", mode: "yolo" });
		assert.equal(mode.isError, true);

		assert.equal(stub.rt.slots.inFlight(), 0, "refusals cost no capacity");
		assert.equal(h.agents.length, 0, "and no process");
	} finally {
		stub.restoreHome();
	}
});
