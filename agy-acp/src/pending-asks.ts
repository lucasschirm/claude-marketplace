// The permission asks a session is waiting on.
//
// One map, one settlement path. Every ask the gate puts here gets answered - by the client, or by
// the reason it never will be (a session/cancel, a child exit, a dispose). Two jobs here go beyond
// a Map: an abort carries *why* (the hook is denied with a reason that matches it), and the client
// whose `session/request_permission` is still on screen is told the ask is over - an ask that
// silently stops existing is a hung prompt with a nicer name.
//
// Keyed per conversation (see askKey): a subagent's step index may equal a main-conversation one,
// and a stray abort must not cancel the other conversation's ask.

import type { AcpSessionUpdate } from "./acp.ts";
import { cancelledReason, sessionEndedReason } from "./permission.ts";
import { toolCallIdOf } from "./update-map.ts";

/**
 * Why an ask stopped waiting without the client answering. `reject` is the hook vanishing (it
 * fails closed on its own, so nobody is told anything); `cancelled` is the client's
 * session/cancel; `ended` is a child exit or a dispose.
 */
export type AskAbort = "reject" | "cancelled" | "ended";

/** What a pending ask resolves to: the client's answer, or one of the ways it never arrives. */
export type AskOutcome = "allow" | "allow-always" | "deadline" | "reject" | "cancelled" | "ended";

/** The identity of one ask, shared with the bridge so a lost connection names the right ask. */
export function askKey(conversationId: string, stepIdx: number): string {
	return `${conversationId}:${stepIdx}`;
}

export interface PendingAsk {
	abort: (kind: AskAbort) => void;
	conversationId: string;
	stepIdx: number;
}

export interface PendingAsksHost {
	log: (line: string) => void;
	/** Emits one session/update for this session (closing the client's dialog). */
	notify: (update: AcpSessionUpdate) => void;
}

export class PendingAsks {
	private readonly host: PendingAsksHost;
	private readonly pending = new Map<string, PendingAsk>();

	constructor(host: PendingAsksHost) {
		this.host = host;
	}

	/** The number of unanswered asks (the heartbeat's `waiting_permission` state). */
	size(): number {
		return this.pending.size;
	}

	set(ask: PendingAsk): void {
		this.pending.set(askKey(ask.conversationId, ask.stepIdx), ask);
	}

	/** Drops the entry only if it is still this ask's - a newer ask for the same key keeps its own. */
	release(ask: PendingAsk): void {
		const key = askKey(ask.conversationId, ask.stepIdx);
		if (this.pending.get(key) === ask) this.pending.delete(key);
	}

	/** One ask by its conversation and step index (the hook connection went away). */
	abort(conversationId: string, stepIdx: number, kind: AskAbort, why: string): boolean {
		const key = askKey(conversationId, stepIdx);
		const ask = this.pending.get(key);
		if (!ask) return false;
		this.pending.delete(key);
		this.host.log(`${why} (${key})`);
		this.settle(ask, kind);
		ask.abort(kind);
		return true;
	}

	/** Deny every pending ask (a cancel, a child exit, a dispose) with the reason that matches `kind`. */
	denyAll(why: string, kind: AskAbort): void {
		if (this.pending.size === 0) return;
		const asks = [...this.pending.values()];
		this.host.log(`permission: denying ${asks.length} pending request(s) (${why})`);
		this.pending.clear();
		for (const ask of asks) {
			this.settle(ask, kind);
			ask.abort(kind);
		}
	}

	/**
	 * The client-side settlement of an ask it is still holding. No `status`: the tool's own state
	 * belongs to the stream (a tool the turn end leaves unfinished is reported failed there) - this
	 * says only that the permission decision will never arrive, with the reason the hook was given.
	 */
	private settle(ask: PendingAsk, kind: AskAbort): void {
		if (kind === "reject") return; // the hook is gone: there is no audience for a reason
		const reason = kind === "cancelled" ? cancelledReason() : sessionEndedReason();
		this.host.notify({
			sessionUpdate: "tool_call_update",
			toolCallId: toolCallIdOf(ask.conversationId, ask.stepIdx),
			_meta: { permission: { state: kind, reason } },
		});
	}
}
