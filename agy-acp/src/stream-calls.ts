// What the stream said about each tool step, and what the hook says about the same step.
//
// `agy` runs the `PreToolUse` hook after the step's `ACTIVE` event, and a hook earlier in the chain
// may have rewritten the arguments (the chain is ordered by file path, and ours is not first). So the
// parameters the stream announced and the parameters our hook received can differ - and when they do,
// the tool that runs uses the *hook's* args, which is information a client cannot get any other way.
// This module owns that comparison and the `tool_call_update` it produces.
//
// It is also where the pending permission metadata rides out (the `in_progress` update that carries
// `_meta.permission`), because that update is the same one: a hook request for a step we saw ACTIVE.
//
// Step indexes are recorded per turn and cleared when it ends: a subagent's steps restart at low
// numbers, and a stale record would otherwise attach another turn's args to a new step's update.

import type { AcpSessionUpdate } from "./acp.ts";
import { argsDifferFrom } from "./permission.ts";
import { toolCallIdOf } from "./update-map.ts";

interface StreamCallRecord {
	name: string;
	parameters: Record<string, unknown> | undefined;
}

export interface StreamCallsHost {
	log: (line: string) => void;
	notify: (update: AcpSessionUpdate) => void;
	/** The main conversation's id (null before the probe): a subagent's steps are not in our stream. */
	conversationId: () => string | null;
	/** The client's answer deadline, carried in the pending metadata. */
	clientDeadlineMs: number;
}

export class StreamCalls {
	private readonly host: StreamCallsHost;
	private readonly byStep = new Map<number, StreamCallRecord>();

	constructor(host: StreamCallsHost) {
		this.host = host;
	}

	/** The stream's `ACTIVE` for a tool step: the args our hook will be asked about. */
	noteActive(stepIdx: number, name: string, parameters: Record<string, unknown> | undefined): void {
		this.byStep.set(stepIdx, { name, parameters });
	}

	/** A turn ended (result, or a mid-turn child exit): the recorded steps were for it. */
	clear(): void {
		this.byStep.clear();
	}

	/**
	 * One hook request against the recorded stream parameters: a difference is a rewrite (the tool runs
	 * with the hook's args). For an ask the `in_progress` update also carries the pending permission
	 * metadata; either way the client sees the args the hook actually evaluated.
	 */
	report(
		req: { stepIdx: number; conversationId: string; toolCall: { name: string; args: Record<string, unknown> } },
		asking: boolean,
	): void {
		// A subagent step (a different conversation id): its tool call is not in our stream, and its
		// low-restarting step index would otherwise collide with a recorded main step (spurious update).
		if (req.conversationId !== (this.host.conversationId() ?? "")) return;
		const rec = this.byStep.get(req.stepIdx);
		if (!rec) return; // a step that never went ACTIVE in our stream
		const rewritten = argsDifferFrom(rec.parameters, req.toolCall.args);
		if (!asking && !rewritten) return;
		if (rewritten) {
			this.host.log(
				`permission: args rewritten before our hook saw them (step ${req.stepIdx}, ${req.toolCall.name}): the tool runs with the args the hook evaluated`,
			);
		}
		const meta: Record<string, unknown> = {};
		if (asking) meta.permission = { state: "pending", deadlineMs: this.host.clientDeadlineMs, sinceMs: Date.now() };
		if (rewritten) meta.argsRewritten = true;
		this.host.notify({
			sessionUpdate: "tool_call_update",
			toolCallId: toolCallIdOf(this.host.conversationId() ?? "", req.stepIdx),
			status: "in_progress",
			rawInput: req.toolCall.args,
			...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
		});
	}
}
