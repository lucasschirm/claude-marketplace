// The per-session permission gate: owns the bridge dir and socket, applies the policy engine
// to each hook request, asks the client (session/request_permission), and holds the in-session
// allow-always grants. The stream's ACTIVE (which precedes the PreToolUse hook) creates the
// tool call from the stream's parameters; when the hook arrives, its args are the ones that
// get displayed (an in_progress update), evaluated and asked on - a difference is a rewrite.
//
// Deadline ladder, lowest to highest: the client deadline (default 10 min, a deny with reason)
// < AGY_ACP_HOOK_DEADLINE_MS (the hook's own timer) < the hooks.json timeout (agy's timer).
// While a request is pending, the tool_call carries _meta.permission so a client watchdog can
// see the state. On a cancel, a child exit or a dispose every pending request is denied - with the
// cancel reason on a cancel - and the client's ask is settled (see pending-asks.ts). A request that
// arrives with no turn in flight is refused outright (see `currentTurn`): between a cancel and the
// child's death, or from a hook that outlived an agy that died mid-turn, there is no prompt left to
// carry the answer, so it would be a dialog nobody can close.
//
// Rewritten args: a repo hook may overwrite the args before our hook runs (the hook chain is
// ordered by file path). We evaluate and display the args the hook received; when the stream's
// ACTIVE shows different tool_info.parameters, that is detected (logged, _meta.argsRewritten).
// Remaining risk, documented in the README: our hook may not sort last, so a hook after ours
// can still rewrite the args we evaluated.
//
// Subagents (issue #59): their tool calls arrive under the subagent's conversation id while their
// steps are not in the parent's stream. agy reports the id only on the spawning call's terminal step,
// after the subagent worked, so while exactly one subagent-spawning call is in flight an unreported
// conversation is attributed to it provisionally; `subagent_info` confirms it later. An ask or a
// progress update for a subagent rides on the parent tool call (see subagents.ts).

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { AcpSessionUpdate } from "./acp.ts";
import { BridgeServer, type BridgeReply } from "./bridge-server.ts";
import {
	AGY_ACP_MODE_IDS,
	cancelledReason,
	decidePolicy,
	deadlineReason,
	grantKeyOf,
	parsePermissionOutcome,
	permissionOptions,
	rejectReason,
	sessionEndedReason,
} from "./permission.ts";
import { PendingAsks, type AskAbort, type AskOutcome, type PendingAsk } from "./pending-asks.ts";
import { StreamCalls } from "./stream-calls.ts";
import { SUBAGENT_SPAWN_TOOLS, Subagents, subagentAskTarget, subagentProgress, type SubagentRecord } from "./subagents.ts";
import { toolCallIdOf, toolKindOf, toolTitleOf } from "./update-map.ts";
import type { AgySubagentEntry } from "./agy-driver.ts";

export interface PermissionGateOptions {
	log: (line: string) => void;
	/** Emits one session/update notification for this session. */
	notify: (update: AcpSessionUpdate) => void;
	/** Sends one request to the client and resolves with its result (the session adds the sessionId). */
	request: (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
	/** The session cwd (the workspace root). */
	cwd: string;
	/** The client deadline: below the hook deadline, which is below the hook timeout. */
	clientDeadlineMs: number;
	hookDeadlineMs: number;
	hookTimeoutSec: number;
	/** The per-session token; a null conversation id before the probe rejects every request. */
	token: string;
	conversationId: () => string | null;
	/**
	 * The `session/prompt` in flight, or null. A hook is a question about the turn that is running, so
	 * when none is there is nothing left to carry the answer: the request is denied rather than turned
	 * into a dialog nobody can close (and that a client would have to wait out). Derived, deliberately
	 * - a flag the session has to remember to clear is a lockout waiting to happen.
	 */
	currentTurn: () => Promise<unknown> | null;
	/**
	 * How many prompts this session has started, counted whether or not any of them reached a hook.
	 * That is what retires a cancel: the gate only ever looks at the session when a hook arrives, so a
	 * later turn that never asks would otherwise leave an old cancel reading as the newest thing that
	 * happened, and a stray hook would be told its turn was cancelled when it was not.
	 */
	turnCount: () => number;
}

export class PermissionGate {
	private readonly opts: PermissionGateOptions;
	private readonly bridge: BridgeServer;
	private mode = "default";
	private readonly grants = new Set<string>();
	private readonly stream: StreamCalls;
	private readonly asks: PendingAsks;
	private readonly subagents = new Subagents();
	/** The subagent-spawning calls of this turn that have not reached a terminal state yet. */
	private readonly subagentHosts = new Map<string, { toolCallId: string; role: string; typeName: string }>();
	private disposedFlag = false;
	private resolvedRoots: string[] | null = null;
	private cancelledAtTurn = -1; // the prompt count when a session/cancel ran; -1 = never

	constructor(opts: PermissionGateOptions) {
		this.opts = opts;
		this.asks = new PendingAsks({ log: opts.log, notify: opts.notify });
		this.stream = new StreamCalls({
			log: opts.log,
			notify: opts.notify,
			conversationId: opts.conversationId,
			clientDeadlineMs: opts.clientDeadlineMs,
		});
		this.bridge = new BridgeServer({
			log: this.opts.log,
			token: opts.token,
			hookTimeoutSec: opts.hookTimeoutSec,
			// A net above the hook's own deadline: a stuck handler must never outlive the hook.
			maxHoldMs: opts.hookDeadlineMs + 60_000,
			conversationId: opts.conversationId,
			// The session's own id is checked by the bridge; a subagent's is accepted when we know it.
			acceptsConversation: (conversationId) => this.subagents.has(conversationId) || this.subagentHosts.size === 1,
			handle: (req) => this.handleHookRequest(req),
			onConnectionLost: (conversationId, stepIdx) => this.onConnectionLost(conversationId, stepIdx),
		});
	}

	get dir(): string {
		return this.bridge.dir;
	}
	get socketPath(): string {
		return this.bridge.socketPath;
	}

	/** Creates the bridge dir and socket; a failure must abort the session start. */
	async start(): Promise<void> {
		await this.bridge.start();
	}

	/**
	 * The resolved (realpath) workspace roots: the session cwd, resolved once. A session's cwd is fixed at session/new so
	 * this cannot go stale, and it used to be a synchronous realpathSync on the path every hook request takes - inside the
	 * async handler that answers agy while a tool call waits.
	 */
	get workspaceRoots(): string[] {
		if (this.resolvedRoots === null) {
			try {
				this.resolvedRoots = [fs.realpathSync(this.opts.cwd)];
			} catch {
				// An unresolvable cwd is reported by session/new; the policy falls back to the raw path.
				this.resolvedRoots = [this.opts.cwd];
			}
		}
		return this.resolvedRoots;
	}

	setMode(modeId: string): void {
		if (!AGY_ACP_MODE_IDS.includes(modeId)) {
			throw new Error(`unknown mode: ${modeId}`);
		}
		if (this.mode !== modeId) {
			this.opts.log(`permission mode: ${this.mode} -> ${modeId}`);
		}
		this.mode = modeId;
	}

	/** One hook request: policy first, then grants, then the client. Always answers. */
	private async handleHookRequest(req: {
		conversationId: string;
		stepIdx: number;
		toolCall: { name: string; args: Record<string, unknown> };
	}): Promise<BridgeReply> {
		if (this.disposedFlag) {
			return { decision: "deny", reason: sessionEndedReason() };
		}
		// No turn, no answer to give: the client cancelled it (its prompt is `cancelled` already), or
		// agy exited mid-turn while a hook process of its own was still alive. Either way asking would
		// put a dialog on screen that nothing can close, so the hook is refused with the reason instead.
		const running = this.opts.currentTurn();
		if (this.cancelledAtTurn === this.opts.turnCount()) {
			// Nothing has run since the cancel: this request belongs to the turn that was called off.
			this.opts.log(`permission: ${req.toolCall.name} denied (the turn was cancelled)`);
			return { decision: "deny", reason: cancelledReason() };
		}
		if (!running) {
			this.opts.log(`permission: ${req.toolCall.name} denied (no turn in flight)`);
			return { decision: "deny", reason: sessionEndedReason() };
		}
		const { name, args } = req.toolCall;
		const subagent = this.subagentOf(req.conversationId);
		if (subagent !== undefined) {
			// The subagent's steps are not in the parent's stream: its activity is progress on the call that spawned it.
			this.opts.notify(subagentProgress(subagent, name, args, req.stepIdx));
		}
		const roots = this.workspaceRoots;
		const policy = decidePolicy({
			mode: this.mode,
			toolName: name,
			args,
			workspaceRoots: roots,
			baseDir: this.opts.cwd,
			bridgeDir: this.bridge.dir,
			socketPath: this.bridge.socketPath,
		});
		if (policy.kind === "deny") {
			this.opts.log(`permission: ${name} denied by policy (${policy.reason})`);
			return { decision: "deny", reason: policy.reason };
		}
		if (policy.kind === "allow") {
			this.opts.log(`permission: ${name} auto-allowed (mode ${this.mode})`);
			this.stream.report(req, false); // rewritten-args detection applies to auto-allowed calls too
			return { decision: "allow" };
		}
		const key = grantKeyOf(name, args, this.opts.cwd);
		if (this.grants.has(key)) {
			this.opts.log(`permission: ${name} covered by an allow-always grant (${key})`);
			this.stream.report(req, false);
			return { decision: "allow" };
		}
		// Ask the client (a subagent's call is attributed to the parent, see askClient). StreamCalls.report
		// is conversation-guarded - our stream records describe main-conversation steps only.
		this.stream.report(req, true); // in_progress update: the hook's args + the pending metadata
		const outcome = await this.askClient(req.stepIdx, name, args, req.conversationId, subagent);
		if (this.disposedFlag) {
			return { decision: "deny", reason: sessionEndedReason() }; // a disposed session is not a user reject
		}
		switch (outcome) {
			case "allow":
				return { decision: "allow" };
			case "allow-always":
				this.grants.add(key);
				this.opts.log(`permission: allow-always grant recorded for ${key}`);
				return { decision: "allow" };
			case "deadline":
				return { decision: "deny", reason: deadlineReason(Math.round(this.opts.clientDeadlineMs / 1000)) };
			case "cancelled":
				return { decision: "deny", reason: cancelledReason() };
			case "ended":
				return { decision: "deny", reason: sessionEndedReason() };
			default:
				return { decision: "deny", reason: rejectReason() };
		}
	}

	/** The client's answer for one call; aborted pending asks resolve as the reason they were aborted. */
	private askClient(
		stepIdx: number,
		name: string,
		args: Record<string, unknown>,
		conversationId: string,
		subagent: SubagentRecord | undefined,
	): Promise<AskOutcome> {
		let resolveAbort: (kind: AskAbort) => void = () => {};
		const abortP = new Promise<AskAbort>((r) => {
			resolveAbort = r;
		});
		// A subagent's ask references the parent call that spawned it: the subagent's step index means
		// nothing in the parent conversation, and a client has a tool call there to attach it to.
		const target = subagent === undefined ? undefined : subagentAskTarget(subagent, name, args, stepIdx);
		const toolCallId = target?.toolCallId ?? toolCallIdOf(conversationId, stepIdx);
		const ask: PendingAsk = { abort: (kind) => resolveAbort(kind), conversationId, stepIdx, toolCallId };
		this.asks.set(ask);
		const clientP = this.opts
			.request(
				"session/request_permission",
				{
					toolCall: {
						toolCallId,
						title: target?.title ?? toolTitleOf(name, args),
						kind: target?.kind ?? toolKindOf(name),
						status: "pending",
						rawInput: args,
					},
					options: permissionOptions(),
					_meta: {
						permission: { state: "pending", deadlineMs: this.opts.clientDeadlineMs, sinceMs: Date.now() },
						...(target?.meta ?? {}),
					},
				},
				this.opts.clientDeadlineMs,
			)
			.then(parsePermissionOutcome, (err: Error) => {
				// The transport's timeout (the client deadline) rejects with "timed out"; a
				// closed connection rejects too - both are a deny, only the reason differs.
				this.opts.log(`permission: client request failed: ${err.message}`);
				return /timed out/i.test(err.message) ? "deadline" : "reject";
			});
		// The abort race decides the deny reason; the client's own answer wins whatever arrives first.
		return Promise.race([clientP, abortP]).finally(() => this.asks.release(ask));
	}

	/** The hook went away before its answer: stop asking the client for it. */
	private onConnectionLost(conversationId: string, stepIdx: number): void {
		this.asks.abort(conversationId, stepIdx, "reject", "permission: hook connection lost");
	}

	/** A turn ended (result, or a mid-turn child exit): the recorded steps and subagents were for it. */
	onTurnEnd(): void {
		this.stream.clear();
		this.subagentHosts.clear();
		this.subagents.clear();
	}

	/**
	 * The stream's ACTIVE for a tool step: the args our hook will be asked about (see stream-calls.ts).
	 * A subagent-spawning call is also remembered: agy runs the subagent before it reports its
	 * conversation id, so while exactly one such call is in flight a hook from an unseen conversation
	 * is that subagent - and once the call settles without the id being reported, it is denied.
	 */
	onStreamActive(stepIdx: number, name: string, parameters: Record<string, unknown> | undefined): void {
		this.stream.noteActive(stepIdx, name, parameters);
		if (SUBAGENT_SPAWN_TOOLS.has(name)) {
			const toolCallId = toolCallIdOf(this.opts.conversationId() ?? "", stepIdx);
			this.subagentHosts.set(toolCallId, {
				toolCallId,
				role: typeof parameters?.Role === "string" ? parameters.Role : "",
				typeName: typeof parameters?.TypeName === "string" ? parameters.TypeName : "",
			});
		}
	}

	/** The stream reported a spawning call's terminal state: its attribution window is over. */
	onStreamSettled(toolCallId: string): void {
		this.subagentHosts.delete(toolCallId);
	}

	/** The subagents agy reported on a spawning call: their mapping is confirmed from now on. */
	onSubagentInfo(parentStepIdx: number, entries: AgySubagentEntry[]): void {
		const parentToolCallId = toolCallIdOf(this.opts.conversationId() ?? "", parentStepIdx);
		for (const record of this.subagents.record(parentToolCallId, entries)) {
			this.opts.log(`subagent ${record.conversationId} (${record.role || record.typeName || "unnamed"}) runs under ${parentToolCallId}`);
		}
	}

	/**
	 * The subagent a request belongs to - reported by agy, or (before agy reports it) the sole
	 * subagent-spawning call in flight. undefined means the conversation is not this session's.
	 */
	private subagentOf(conversationId: string): SubagentRecord | undefined {
		if (conversationId === (this.opts.conversationId() ?? "")) {
			return undefined; // the session's own conversation is never one of its subagents
		}
		const known = this.subagents.get(conversationId);
		if (known !== undefined) {
			return known;
		}
		const open = this.subagentHosts.size === 1 ? [...this.subagentHosts.values()][0] : undefined;
		if (open === undefined) {
			// None open: not this session's. Two open: the parent is ambiguous, so do not guess.
			return undefined;
		}
		this.opts.log(`subagent ${conversationId} is running under ${open.toolCallId} (not reported yet)`);
		return this.subagents.remember(open.toolCallId, { conversationId, role: open.role, typeName: open.typeName });
	}

	/** The number of unanswered permission requests (the heartbeat's `waiting_permission` state). */
	pendingAsks(): number {
		return this.asks.size();
	}

	/**
	 * Deny every pending request (a cancel, a child exit, a dispose) with the reason that matches
	 * the `kind`, and settle each ask for the client that is still holding it.
	 */
	abortPending(why: string, kind: AskAbort = "ended"): void {
		// Remembering *which* turn was cancelled is what makes the next hook's reason the cancel's own
		// words rather than a generic "session ended" - and only for as long as no turn has run since.
		if (kind === "cancelled") {
			this.cancelledAtTurn = this.opts.turnCount();
		}
		this.asks.denyAll(why, kind);
	}

	/** Deny pendings and remove the bridge dir and socket. Idempotent. */
	async dispose(): Promise<void> {
		if (this.disposedFlag) {
			return;
		}
		this.disposedFlag = true;
		this.abortPending("the session was disposed");
		await this.bridge.stop();
	}
}

/** The default deadline ladder: 10 min client < 11 min hook < 12 min timeout (600 s is the
 * largest hook timeout the spike verified agy honours; 720 s is the issue spec default. If a
 * version clamps the hook timeout lower, the degradation is bounded: agy's kill of the hook
 * races the client deadline, and the denial still carries a reason via the client path).
 * Everything is configurable. */
export const DEFAULT_CLIENT_DEADLINE_MS = 600_000;
export const DEFAULT_HOOK_DEADLINE_MS = 660_000;
export const DEFAULT_HOOK_TIMEOUT_SEC = 720;

export function newPermissionToken(): string {
	return randomBytes(32).toString("hex");
}
