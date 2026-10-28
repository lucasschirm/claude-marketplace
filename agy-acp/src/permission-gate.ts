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
// arrives with no turn in flight is refused outright (see `turnInFlight`): between a cancel and the
// child's death, or from a hook that outlived an agy that died mid-turn, there is no prompt left to
// carry the answer, so it would be a dialog nobody can close.
//
// Rewritten args: a repo hook may overwrite the args before our hook runs (the hook chain is
// ordered by file path). We evaluate and display the args the hook received; when the stream's
// ACTIVE shows different tool_info.parameters, that is detected (logged, _meta.argsRewritten).
// Remaining risk, documented in the README: our hook may not sort last, so a hook after ours
// can still rewrite the args we evaluated.

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
import { toolCallIdOf, toolKindOf, toolTitleOf } from "./update-map.ts";

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
	 * - a flag the session has to remember to clear is a lockout waiting to happen. The promise object
	 * identifies the turn, which is how a cancel from an earlier turn stops being reported as the
	 * reason for a later one.
	 */
	currentTurn: () => Promise<unknown> | null;
}

export class PermissionGate {
	private readonly opts: PermissionGateOptions;
	private readonly bridge: BridgeServer;
	private mode = "default";
	private readonly grants = new Set<string>();
	private readonly stream: StreamCalls;
	private readonly asks: PendingAsks;
	private disposedFlag = false;
	private lastTurn: Promise<unknown> | null = null;
	private cancelledTurn: Promise<unknown> | null = null;

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

	/** The resolved (realpath) workspace roots: the session cwd, resolved. */
	private workspaceRoots(): string[] {
		try {
			return [fs.realpathSync(this.opts.cwd)];
		} catch {
			return [this.opts.cwd];
		}
	}

	setMode(modeId: string): void {
		if (!AGY_ACP_MODE_IDS.includes(modeId)) throw new Error(`unknown mode: ${modeId}`);
		if (this.mode !== modeId) this.opts.log(`permission mode: ${this.mode} -> ${modeId}`);
		this.mode = modeId;
	}

	/** One hook request: policy first, then grants, then the client. Always answers. */
	private async handleHookRequest(req: {
		conversationId: string;
		stepIdx: number;
		toolCall: { name: string; args: Record<string, unknown> };
	}): Promise<BridgeReply> {
		if (this.disposedFlag) return { decision: "deny", reason: sessionEndedReason() };
		// No turn, no answer to give: the client cancelled it (its prompt is `cancelled` already), or
		// agy exited mid-turn while a hook process of its own was still alive. Either way asking would
		// put a dialog on screen that nothing can close, so the hook is refused with the reason instead.
		const running = this.opts.currentTurn();
		if (running) this.lastTurn = running; // the newest turn this gate has seen
		if (this.cancelledTurn !== null && this.cancelledTurn === this.lastTurn) {
			// The cancel is the newest turn we know of: this request belongs to a turn already answered.
			this.opts.log(`permission: ${req.toolCall.name} denied (the turn was cancelled)`);
			return { decision: "deny", reason: cancelledReason() };
		}
		if (!running) {
			this.opts.log(`permission: ${req.toolCall.name} denied (no turn in flight)`);
			return { decision: "deny", reason: sessionEndedReason() };
		}
		const { name, args } = req.toolCall;
		const roots = this.workspaceRoots();
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
		// Ask the client (subagent calls too: the per-session token is the boundary). StreamCalls.report
		// is conversation-guarded - our stream records describe main-conversation steps only.
		this.stream.report(req, true); // in_progress update: the hook's args + the pending metadata
		const outcome = await this.askClient(req.stepIdx, name, args, req.conversationId);
		if (this.disposedFlag) return { decision: "deny", reason: sessionEndedReason() }; // a disposed session is not a user reject
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
	private askClient(stepIdx: number, name: string, args: Record<string, unknown>, conversationId: string): Promise<AskOutcome> {
		let resolveAbort: (kind: AskAbort) => void = () => {};
		const abortP = new Promise<AskAbort>((r) => (resolveAbort = r));
		const ask: PendingAsk = { abort: (kind) => resolveAbort(kind), conversationId, stepIdx };
		this.asks.set(ask);
		const clientP = this.opts
			.request(
				"session/request_permission",
				{
					toolCall: {
						// The request's own conversation id: a subagent's step index must not be spliced
						// onto the main conversation's tool call ids.
						toolCallId: toolCallIdOf(conversationId, stepIdx),
						title: toolTitleOf(name, args),
						kind: toolKindOf(name),
						status: "pending",
						rawInput: args,
					},
					options: permissionOptions(),
					_meta: { permission: { state: "pending", deadlineMs: this.opts.clientDeadlineMs, sinceMs: Date.now() } },
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

	/** A turn ended (result, or a mid-turn child exit): the recorded stream steps were for it. */
	onTurnEnd(): void {
		this.stream.clear();
	}

	/** The stream's ACTIVE for a tool step: the args our hook will be asked about (see stream-calls.ts). */
	onStreamActive(stepIdx: number, name: string, parameters: Record<string, unknown> | undefined): void {
		this.stream.noteActive(stepIdx, name, parameters);
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
			this.cancelledTurn = this.opts.currentTurn();
			this.lastTurn = this.cancelledTurn ?? this.lastTurn;
		}
		this.asks.denyAll(why, kind);
	}

	/** Deny pendings and remove the bridge dir and socket. Idempotent. */
	async dispose(): Promise<void> {
		if (this.disposedFlag) return;
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
