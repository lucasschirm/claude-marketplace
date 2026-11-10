// The runtime: everything a delegation engine owns that is not the wire and not the tool surface.
//
// It used to be ~1 600 lines of closure inside the extension file, sharing about fifteen mutable
// variables with the tools, the session layer and the TUI. Those variables are now fields of this one
// object, which is what lets the session, queue, transcript and tool modules be files instead of
// inner functions — and what makes the state a thing you can read, reset and test.
//
// Three of its behaviors are load-bearing and were each learned the hard way:
//  * a slot is reserved before the first `await` (see slots.ts);
//  * the stall watchdog measures ACP *silence*, not wall-clock time, and a turn waiting on a permission
//    answer is never stalled (the permission timeout settles that case);
//  * diagnostics never `console.*` in TUI mode: raw writes corrupt the alternate screen.

import type { ExtensionAPI, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DelegateTransport } from "./transport.ts";
import { commandForCaller } from "./permissions.ts";
import { extractCliError, stripAnsi } from "./diagnostics.ts";
import { logError as fileLogError, logWarn as fileLogWarn } from "../extension-log.ts";
import { commandExists, createTaskScope, WriteQueue } from "../nonblocking.ts";
import { findAgent } from "./registry.ts";
import { driverCli, isPidAlive, killProcessGroup } from "./process.ts";
import { AgentSlots } from "./slots.ts";
import { appendEvent, persistMeta, persistState as persistStateFile } from "./persist.ts";
import type { AgentDriver, DriverHealth, LaunchPlan, QueuedTask, SessionMeta } from "./types.ts";
import { pickPermissionOption, type PermissionDecision, type PermissionRequest } from "./permissions.ts";

/** Boot is the tight budget here: recovering state must never be what makes `pi` feel frozen. */
export const BOOT_BUDGET_MS = Number.parseInt(process.env.PI_EXT_BOOT_BUDGET_MS ?? "", 10) || 5_000;

export const DEFAULT_MAX_RUNS_PER_AGENT = 2;
export const DEFAULT_MAX_RUNS_TOTAL = 3;

/** How much streamed text accumulates before it becomes a transcript line. */
const FLUSH_THRESHOLD_CHARS = 2000;

export class DelegateRuntime {
	readonly sessions = new Map<string, SessionMeta>();
	readonly activeClients = new Map<string, DelegateTransport>();
	readonly queue: QueuedTask[] = [];
	/** Advertised ACP config-option vocabularies, captured from `config_option_update`. */
	readonly configOptions = new Map<string, Map<string, string[]>>();
	/** Where each session's files were last written (mirrors state.json's sessionDirs). */
	readonly sessionDirs = new Map<string, string>();
	readonly stallTimers = new Map<string, NodeJS.Timeout>();
	readonly pendingPermissions = new Map<string, Array<PermissionRequest & { timer: NodeJS.Timeout }>>();
	readonly assistantBuffers = new Map<string, string>();
	readonly thoughtBuffers = new Map<string, string>();
	/** Debounced metadata saves, one per session. */
	readonly pendingMetaSaves = new Map<string, { timer: NodeJS.Timeout }>();

	maxRuns = DEFAULT_MAX_RUNS_PER_AGENT;
	maxRunsTotal = DEFAULT_MAX_RUNS_TOTAL;
	totalInvoked = 0;
	totalCompleted = 0;
	baseDir = process.cwd();
	currentPiSessionId = "default";
	/** When false (default), shell calls to a guarded agent CLI are blocked (see registry.guardedClis). */
	allowGuardedBash = false;
	/** Recovery is detached; every mutating tool path awaits this first. */
	recoveryDone: Promise<void> = Promise.resolve();

	private ui: ExtensionUIContext | undefined;
	readonly stateWrites: WriteQueue;
	readonly tasks: ReturnType<typeof createTaskScope>;
	readonly slots: AgentSlots;

	readonly pi: ExtensionAPI;
	readonly extensionName: string;

	// Explicit assignment, not parameter properties: this tree is run by node with
	// `--experimental-strip-types`, which erases types and cannot implement them.
	constructor(pi: ExtensionAPI, extensionName = "delegate_task") {
		this.pi = pi;
		this.extensionName = extensionName;
		this.stateWrites = new WriteQueue((msg) => this.logError(msg));
		this.tasks = createTaskScope(extensionName, { onError: (msg) => this.logError(msg) });
		this.slots = new AgentSlots(
			() => [...this.sessions.values()].filter((s) => s.status === "running" || s.status === "stalled"),
			() => this.maxRuns,
			() => this.maxRunsTotal,
		);
	}

	// ---------------------------------------------------------------- diagnostics

	/**
	 * Whether an agent is usable right now. A field for the same reason as `makeTransport`: the real
	 * preflight spawns the agent's CLI, and a test of the tool layer must not depend on what is installed
	 * on the machine that runs it.
	 */
	preflightAgent: (driver: AgentDriver) => Promise<DriverHealth> = (driver) => driver.preflight();
	/**
	 * How a session's transport is built. A field, not a `new`, so a test can put a scripted agent behind
	 * the tools — the suite that checks "the tool said done" against "the agent said `max_tokens`" needs
	 * to control what the agent says, and spawning a real one for it would not be that test.
	 */
	makeTransport: (cwd: string, plan: LaunchPlan) => DelegateTransport = (cwd, plan) => {
		const transport = new DelegateTransport(cwd, plan);
		// The transcript log is the file this extension writes continuously, and a write stream that errors
		// with nobody listening throws into the host process — the user's editor, not just this session. Route
		// it to the diagnostics that already reach a human and the file log.
		transport.logFailure = (message) => this.logWarn(message);
		return transport;
	};

	setUi(ui?: ExtensionUIContext): void {
		if (ui) {
			this.ui = ui;
		}
	}

	uiContext(): ExtensionUIContext | undefined {
		return this.ui;
	}

	/** The storage anchor must not move on a tool call: see `piSessionId()` and the mismatch warning. */
	warnPiSessionMismatch(ctx: ExtensionToolContext): void {
		const toolPiId = ctx.sessionManager?.getSessionId();
		if (!toolPiId) {
			return;
		}
		if (this.currentPiSessionId === "default") {
			this.currentPiSessionId = toolPiId;
		} else if (toolPiId !== this.currentPiSessionId) {
			this.logWarn(`pi session id mismatch (tool: ${toolPiId}, anchored: ${this.currentPiSessionId}); keeping anchored storage dir`);
		}
	}

	/** ANSI stripped first: a CLI's coloured error passed through as "the message" is the exact display
	 *  bug test/test-devin-tui-safety.ts guards (see its note on the worktree failure path). */
	private safe(message: string): string {
		return stripAnsi(message).replace(/\s+/g, " ").trim().slice(0, 500);
	}

	logWarn(message: string): void {
		const text = this.safe(extractCliError(message) ?? message);
		fileLogWarn(this.extensionName, text);
		const ui = this.ui;
		if (ui?.notify) {
			try {
				ui.notify(text, "warning");
			} catch {}
		}
	}

	logError(message: string): void {
		const text = this.safe(extractCliError(message) ?? message);
		fileLogError(this.extensionName, text);
		const ui = this.ui;
		if (ui?.notify) {
			try {
				ui.notify(text, "error");
			} catch {}
		}
	}

	/**
	 * The `details` block every tool result of this extension carries: which tool answered and the
	 * session/queue counters a follow-up turn would otherwise re-query. Per-call facts go in `extra`.
	 */
	toolDetails(tool: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			tool,
			sessions: this.sessions.size,
			queuedTasks: this.queue.length,
			inFlight: this.slots.inFlight(),
			maxInFlight: this.maxRuns,
			maxInFlightTotal: this.maxRunsTotal,
			totalCompleted: this.totalCompleted,
			...extra,
		};
	}

	// ---------------------------------------------------------------- notices

	/** A message into the parent pi session. `steer` lands after the current turn's tool calls. */
	sendAgentMessage(content: string): void {
		try {
			this.pi.sendUserMessage(content, { deliverAs: "steer" });
		} catch (err) {
			this.logError(`Failed to send message to agent: ${extractCliError(err)}`);
		}
	}

	updateStatusUI(ui?: ExtensionUIContext): void {
		const targetUI = ui || this.ui;
		if (!targetUI) {
			return;
		}
		// Wrapped because a status line must never be the thing that throws. Several callers reach it from a
		// `catch` or a `finally` (a rejected turn, a child that exited), where a throw from the host's own
		// renderer would become an unhandled rejection in pi — the extension crashing the host over a label.
		try {
			this.renderStatusUI(targetUI);
		} catch (err: any) {
			this.logError(`Could not update the status line: ${err?.message ?? err}`);
		}
	}

	private renderStatusUI(targetUI: ExtensionUIContext): void {
		let stalledCount = 0;
		let settledCount = 0;
		for (const s of this.sessions.values()) {
			if (s.status === "stalled") {
				stalledCount++;
			} else if (["completed", "idle", "failed", "cancelled", "interrupted"].includes(s.status)) {
				settledCount++;
			}
		}
		const inFlight = this.slots.inFlight();
		const queuedCount = this.queue.length;
		const totalSettled = Math.max(settledCount, this.totalCompleted);

		if (inFlight === 0 && totalSettled === 0 && queuedCount === 0) {
			targetUI.setStatus(this.extensionName, undefined);
			return;
		}

		// Stalled and permission-blocked sessions hold their slot, so they count as in flight: a
		// separate "running" figure read 0 while two frozen sessions blocked the whole queue (0/6/0).
		const notes = [
			this.perAgentCounts(),
			stalledCount > 0 ? `${stalledCount} stalled` : "",
			this.pendingPermissions.size > 0 ? `${this.pendingPermissions.size} awaiting permission` : "",
		];
		const suffix = notes.filter(Boolean).join(", ");
		targetUI.setStatus(
			this.extensionName,
			`Delegate ${inFlight}/${this.maxRunsTotal} · ${queuedCount} queued · ${this.totalCompleted} done${suffix ? ` (${suffix})` : ""}`,
		);
	}

	/**
	 * `devin 2/2, claude 1/1` — which agent is holding the capacity.
	 *
	 * Always shown when something is in flight, including with one agent: the headline figure is the
	 * total ceiling, and the number that decides whether the next delegation starts is the per-agent
	 * one. A status line that hides it makes the user do the arithmetic.
	 */
	private perAgentCounts(): string {
		// Counted from the slots, not from the session map and the queue: the number that decides whether
		// the next delegation starts is *capacity in use*, which includes a reservation whose process has
		// not registered yet and excludes a task still waiting. Adding the queue produced `devin 5/2`,
		// which reads like a violated limit when it is a queue of three behind two running sessions.
		const agents = new Set<string>();
		for (const sess of this.sessions.values()) {
			if (sess.status === "running" || sess.status === "stalled") {
				agents.add(sess.agent);
			}
		}
		for (const q of this.queue) {
			agents.add(q.agent);
		}
		const counts = [...agents].map((agent) => [agent, this.slots.inFlight(agent)] as const).filter(([, n]) => n > 0);
		return counts
			.filter(([, n]) => n > 0)
			.map(([agent, n]) => `${agent} ${n}/${this.maxRuns}`)
			.join(", ");
	}

	// ---------------------------------------------------------------- configuration

	/** Flag lookup that accepts the renamed flag first and the historical `--devin-*` name after. */
	flag(...names: string[]): string | undefined {
		for (const name of names) {
			const value = this.pi.getFlag(name);
			if (value !== undefined && value !== null) {
				return String(value);
			}
		}
		return undefined;
	}

	getPermissionTimeoutMs(): number {
		const raw = this.flag("delegate-permission-timeout", "devin-permission-timeout");
		const n = raw != null ? Number.parseFloat(raw) : Number.NaN;
		return (Number.isFinite(n) && n > 0 ? n : 5) * 60000;
	}

	getStallTimeoutMs(): number {
		const raw = this.flag("delegate-turn-stall", "devin-turn-stall");
		const n = raw != null ? Number.parseInt(raw, 10) : Number.NaN;
		return (!Number.isNaN(n) && n > 0 ? n : 30) * 60000;
	}

	// ---------------------------------------------------------------- processes

	/** Cached per process: a `which` costs a subprocess, and provisioning asks more than once. */
	async commandExists(cmd: string): Promise<boolean> {
		const hit = DelegateRuntime.cliCache.get(cmd);
		if (hit !== undefined) {
			return hit;
		}
		const ok = await commandExists(cmd);
		DelegateRuntime.cliCache.set(cmd, ok);
		return ok;
	}

	private static readonly cliCache = new Map<string, boolean>();

	/** Process hygiene lives in `process.ts`; these stay as methods because callers hold a runtime. */
	driverCli(agentId: string): string | undefined {
		return driverCli(agentId);
	}

	isPidAlive(pid: number): boolean {
		return isPidAlive(pid);
	}

	killProcessGroup(pid: number, cli?: string): void {
		killProcessGroup(pid, cli, (message) => this.logWarn(message));
	}

	// ---------------------------------------------------------------- stall watchdog

	clearStallTimer(sessionId: string): void {
		const t = this.stallTimers.get(sessionId);
		if (t) {
			clearInterval(t);
			this.stallTimers.delete(sessionId);
		}
	}

	/** Every caller ends the turn (completed, failed, cancelled, exited), which ends its pending asks. */
	stopStallWatchdog(sessionId: string): void {
		this.clearStallTimer(sessionId);
		this.dropPendingPermissions(sessionId);
	}

	/**
	 * A turn is stalled only when *no* ACP update arrives for N minutes. The process being alive
	 * distinguishes "possibly thinking/waiting" from "dead" (which onExit handles as interrupted), and a
	 * stalled turn is never auto-failed or killed — a delegate that has gone quiet is a question, not a
	 * corpse.
	 */
	startStallWatchdog(meta: SessionMeta): void {
		this.clearStallTimer(meta.sessionId);
		const stallMs = this.getStallTimeoutMs();
		const timer = setInterval(() => {
			if (meta.status !== "running") {
				this.clearStallTimer(meta.sessionId);
				return;
			}
			// Waiting on the agent, not stalled: the permission timeout settles it.
			if (this.pendingPermissions.get(meta.sessionId)?.length) {
				return;
			}
			const last = meta.lastMessageTime || meta.startedAt || 0;
			if (Date.now() - last > stallMs) {
				meta.status = "stalled";
				this.persistSessionMeta(meta, true);
				this.updateStatusUI();
				this.sendAgentMessage(
					`The session ${meta.sessionId} appears stalled (no ACP activity for ${Math.round(stallMs / 60000)} minutes). Verify with "delegate_status"; if it is stuck, use "delegate_cancel" then "delegate_restart" to recover.`,
				);
			}
		}, 60000);
		timer.unref();
		this.stallTimers.set(meta.sessionId, timer);
	}

	// ---------------------------------------------------------------- pending permissions

	/** The turn ended: its requests can no longer be answered. */
	dropPendingPermissions(sessionId: string): void {
		const list = this.pendingPermissions.get(sessionId);
		if (!list) {
			return;
		}
		const client = this.activeClients.get(sessionId);
		for (const r of list) {
			clearTimeout(r.timer);
			// Answer it before forgetting it. A conformant agent waits for the answer to its own request, so
			// dropping it silently is how a turn that ended on one channel blocks on another forever; only
			// the stall watchdog would notice, and by then the connection is long idle.
			client?.respond(r.requestId, { outcome: { outcome: "cancelled" } });
			client?.logEvent("permission_answer", { requestId: r.requestId, decision: "cancelled", optionId: null, by: "turn-end" });
		}
		this.pendingPermissions.delete(sessionId);
	}

	/** Answer one pending request (the oldest, or `requestId`'s). Returns it, or null when none is pending. */
	answerPermission(
		sessionId: string,
		decision: PermissionDecision,
		by: "agent" | "timeout",
		requestId?: number | string,
	): (PermissionRequest & { optionId?: string }) | null {
		const list = this.pendingPermissions.get(sessionId);
		// Compared as text. The wire id is `number | string` — the JSON-RPC spec allows both, and this tool's
		// parameter is a string — so a numeric id from an agent could never be answered by an explicit
		// `request_id`, and the status line would offer one (`request_id=7`) that always failed.
		const idx = !list ? -1 : requestId === undefined ? 0 : list.findIndex((r) => String(r.requestId) === String(requestId));
		if (!list || idx < 0 || idx >= list.length) {
			return null;
		}
		const [req] = list.splice(idx, 1);
		if (list.length === 0) {
			this.pendingPermissions.delete(sessionId);
		}
		clearTimeout(req.timer);
		const meta = this.sessions.get(sessionId);
		const policy = this.permissionPolicyFor(meta?.agent);
		const optionId = policy.pick(req.options, decision);
		const client = this.activeClients.get(sessionId);
		client?.respond(req.requestId, optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
		client?.logEvent("permission_answer", { requestId: req.requestId, decision, optionId: optionId ?? null, by });
		if (meta) {
			// The turn resumes now: the stall clock restarts from the answer, not the question.
			meta.lastMessageTime = Date.now();
			this.persistSessionMeta(meta, false);
		}
		if (by === "timeout") {
			// The agent has to hear about a rejection it did not make. Without this, a turn that
			// continued after an auto-rejection looked like the extension had gone quiet, and the
			// original incident report was exactly that: nobody could tell whether the request had
			// been answered, so the operator approved things they could not see.
			const minutes = Math.max(1, Math.round(this.getPermissionTimeoutMs() / 60_000));
			this.sendAgentMessage(
				`The permission request of session ${sessionId} ${commandForCaller(req.command)} got no answer in ${minutes} minute(s) and was rejected automatically. The agent continues without it; decide faster or answer with delegate_permission before the timeout.`,
			);
		}
		this.updateStatusUI();
		return { ...req, optionId };
	}

	/**
	 * Resolved per session, because a driver decides which option its agent understands and which
	 * options must never be chosen on the caller's behalf.
	 */
	private permissionPolicyFor(agent?: string) {
		const found = findAgent(agent);
		const policy = found.ok ? found.driver.permission() : undefined;
		return {
			pick: (options: Parameters<typeof pickPermissionOption>[0], decision: PermissionDecision) =>
				policy ? policy.pickOption(options, decision) : pickPermissionOption(options, decision),
		};
	}

	// ---------------------------------------------------------------- transcript buffers

	/** Flush the accumulated streamed chunks into the event log (assistant and thought, separately). */
	/**
	 * Accumulate one streamed chunk, flushing once the buffer is worth a line.
	 *
	 * The store happens **before** the threshold test. The other order — build the new value in a local, test
	 * it, then flush what the *map* still holds — writes the older bytes and loses the chunk that tripped the
	 * threshold: every 2 000 characters, mid-sentence, in whichever stream talked fastest. A progress log that
	 * eats a word twice a kilobyte is not a progress log, and nothing downstream can tell that it happened.
	 */
	appendStreamChunk(meta: SessionMeta, stream: "assistant" | "thought", text: string): void {
		const buffers = stream === "assistant" ? this.assistantBuffers : this.thoughtBuffers;
		const buf = (buffers.get(meta.sessionId) ?? "") + text;
		buffers.set(meta.sessionId, buf);
		if (buf.length >= FLUSH_THRESHOLD_CHARS) {
			this.flushBuffers(meta);
		}
	}

	flushBuffers(meta: SessionMeta): void {
		const client = this.activeClients.get(meta.sessionId);
		const assistant = this.assistantBuffers.get(meta.sessionId);
		if (assistant) {
			this.assistantBuffers.delete(meta.sessionId);
			if (client) {
				client.appendAssistantMessage(assistant);
			} else {
				this.appendEventLog(meta, "assistant_message", { text: assistant });
			}
		}
		const thought = this.thoughtBuffers.get(meta.sessionId);
		if (thought) {
			this.thoughtBuffers.delete(meta.sessionId);
			if (client) {
				client.appendThoughtMessage(thought);
			} else {
				this.appendEventLog(meta, "thought_message", { text: thought });
			}
		}
	}

	appendEventLog(meta: SessionMeta, type: string, data: unknown): void {
		appendEvent(this, meta, type, data);
	}

	persistState(): void {
		persistStateFile(this);
	}

	persistSessionMeta(meta: SessionMeta, immediate = false): void {
		persistMeta(this, meta, immediate);
	}

	cleanupClients(): void {
		for (const client of this.activeClients.values()) {
			client.dispose();
		}
		this.activeClients.clear();
	}

	/**
	 * Release every piece of per-session state. pi reuses one process across `/new`, `/resume` and
	 * `/switch`, and a session's state must not outlive its session: the maps have to be GC-able and the
	 * timers cleared directly (`dispose()` suppresses the child's exit callback, so the indirect stop path
	 * cannot be relied on). On-disk state is untouched — recovery re-anchors it.
	 */
	shutdown(): void {
		for (const t of this.stallTimers.values()) {
			clearInterval(t);
		}
		this.stallTimers.clear();
		for (const p of this.pendingMetaSaves.values()) {
			clearTimeout(p.timer);
		}
		this.pendingMetaSaves.clear();
		for (const list of this.pendingPermissions.values()) {
			for (const r of list) {
				clearTimeout(r.timer);
			}
		}
		this.pendingPermissions.clear();
		this.cleanupClients();
		this.sessions.clear();
		this.queue.length = 0;
		this.configOptions.clear();
		this.sessionDirs.clear();
		this.assistantBuffers.clear();
		this.thoughtBuffers.clear();
		this.totalInvoked = 0;
		this.totalCompleted = 0;
		this.currentPiSessionId = "default";
		// Dropped, not kept. Pi awaits `session_shutdown` and then tears the context down; a delayed
		// diagnostic — a write queue that fails after the drain, a child that reports its exit — would call
		// into a dead context. Falling back to the log instead is the difference between a lost line and an
		// exception inside a rejection handler. It also releases the previous session's UI object, which is
		// exactly the leak this line existed to prevent before the engine moved into a class.
		this.ui = undefined;
	}
}
