// The per-session permission gate: owns the bridge dir and socket, applies the policy engine
// to each hook request, asks the client (session/request_permission), and holds the in-session
// allow-always grants. The stream's ACTIVE (which precedes the PreToolUse hook) creates the
// tool call from the stream's parameters; when the hook arrives, its args are the ones that
// get displayed (an in_progress update), evaluated and asked on - a difference is a rewrite.
//
// Deadline ladder, lowest to highest: the client deadline (default 10 min, a deny with reason)
// < AGY_ACP_HOOK_DEADLINE_MS (the hook's own timer) < the hooks.json timeout (agy's timer).
// While a request is pending, the tool_call carries _meta.permission so a client watchdog can
// see the state. On cancel or a child exit, every pending request is denied.
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
	argsDifferFrom,
	decidePolicy,
	deadlineReason,
	grantKeyOf,
	parsePermissionOutcome,
	permissionOptions,
	rejectReason,
	sessionEndedReason,
} from "./permission.ts";
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
}

interface StreamCallRecord {
	name: string;
	parameters: Record<string, unknown> | undefined;
}

interface PendingAsk {
	abort: () => void;
}

export class PermissionGate {
	private readonly opts: PermissionGateOptions;
	private readonly bridge: BridgeServer;
	private mode = "default";
	private readonly grants = new Set<string>();
	private readonly streamCalls = new Map<number, StreamCallRecord>();
	private readonly pending = new Map<string, PendingAsk>();
	private disposedFlag = false;

	constructor(opts: PermissionGateOptions) {
		this.opts = opts;
		this.bridge = new BridgeServer({
			log: this.opts.log,
			token: opts.token,
			hookTimeoutSec: opts.hookTimeoutSec,
			// A net above the hook's own deadline: a stuck handler must never outlive the hook.
			maxHoldMs: opts.hookDeadlineMs + 60_000,
			conversationId: opts.conversationId,
			handle: (req) => this.handleHookRequest(req),
			onConnectionLost: (key) => this.onConnectionLost(key),
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
			this.reportHookArgs(req, false); // rewritten-args detection applies to auto-allowed calls too
			return { decision: "allow" };
		}
		const key = grantKeyOf(name, args, this.opts.cwd);
		if (this.grants.has(key)) {
			this.opts.log(`permission: ${name} covered by an allow-always grant (${key})`);
			this.reportHookArgs(req, false);
			return { decision: "allow" };
		}
		// Ask the client (subagent calls too: the per-session token is the boundary). reportHookArgs
		// is conversation-guarded - our stream records describe main-conversation steps only.
		this.reportHookArgs(req, true); // in_progress update: the hook's args + the pending metadata
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
			default:
				return { decision: "deny", reason: rejectReason() };
		}
	}

	/** The client's answer for one call; aborted pending asks resolve as a reject. */
	private askClient(
		stepIdx: number,
		name: string,
		args: Record<string, unknown>,
		conversationId: string,
	): Promise<"allow" | "allow-always" | "deadline" | "reject"> {
		let resolveAbort: () => void = () => {};
		const abortP = new Promise<void>((r) => (resolveAbort = r));
		// Keyed per conversation: a subagent's step index may equal a main one, and a stray
		// abort must not kill the other conversation's ask.
		const key = `${conversationId}:${stepIdx}`;
		this.pending.set(key, { abort: () => resolveAbort() });
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
		return Promise.race([clientP, abortP.then(() => "reject" as const)]).finally(() => {
			this.pending.delete(key);
		});
	}

	/** The hook went away before its answer: stop asking the client for it. */
	private onConnectionLost(key: string): void {
		const pending = this.pending.get(key);
		if (pending) {
			this.opts.log(`permission: hook connection lost (${key}) - aborting the client ask`);
			pending.abort();
		}
	}

	/** A turn ended (result, or a mid-turn child exit): the recorded stream steps were for it. */
	onTurnEnd(): void {
		if (this.streamCalls.size > 0) this.streamCalls.clear();
	}

	/** The stream's ACTIVE for a tool step: record its parameters - the hook that follows runs
	 * on them, so a difference between the two is a rewrite (reported when the hook arrives). */
	onStreamActive(stepIdx: number, name: string, parameters: Record<string, unknown> | undefined): void {
		this.streamCalls.set(stepIdx, { name, parameters });
	}

	/** One hook request vs the recorded stream parameters: a difference is a rewrite (the tool
	 * runs with the hook's args). For an ask the in_progress update also carries the pending
	 * permission metadata; the client sees the hook's args in its request. */
	private reportHookArgs(
		req: { stepIdx: number; conversationId: string; toolCall: { name: string; args: Record<string, unknown> } },
		asking: boolean,
	): void {
		// A subagent step (a different conversation id): its tool call is not in our stream, and its
		// low-restarting step index would otherwise collide with a recorded main step (spurious update).
		if (req.conversationId !== (this.opts.conversationId() ?? "")) return;
		const rec = this.streamCalls.get(req.stepIdx);
		if (!rec) return; // a step that never went ACTIVE in our stream
		const id = toolCallIdOf(this.opts.conversationId() ?? "", req.stepIdx);
		const rewritten = argsDifferFrom(rec.parameters, req.toolCall.args);
		if (!asking && !rewritten) return;
		if (rewritten) {
			this.opts.log(
				`permission: args rewritten before our hook saw them (step ${req.stepIdx}, ${req.toolCall.name}): the tool runs with the args the hook evaluated`,
			);
		}
		const meta: Record<string, unknown> = {};
		if (asking) meta.permission = { state: "pending", deadlineMs: this.opts.clientDeadlineMs, sinceMs: Date.now() };
		if (rewritten) meta.argsRewritten = true;
		this.opts.notify({
			sessionUpdate: "tool_call_update",
			toolCallId: id,
			status: "in_progress",
			rawInput: req.toolCall.args,
			...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
		});
	}

	/** Deny every pending request (cancel, a child exit, dispose). */
	abortPending(why: string): void {
		if (this.pending.size === 0) return;
		this.opts.log(`permission: denying ${this.pending.size} pending request(s) (${why})`);
		for (const p of this.pending.values()) p.abort();
		this.pending.clear();
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
