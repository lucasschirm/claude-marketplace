// Turn settling: how a `result` ends a session/prompt.
//
// The guarantee the session layer is named for: an error is never reported as end_turn.
// A `result` ERROR is a -32603 error; a headless auto-deny is an end_turn, but the denied
// actions go out as a notice before the response and ride in _meta.deniedActions; a tool
// step still ACTIVE when the turn ends is reported failed (no tool runs forever). A child
// exit without a `result` is handled by the session (which marks it needsRespawn) with the
// same failActiveTools + error pattern.

import type { AcpPromptResult, AcpSessionUpdate } from "./acp.ts";
import { INTERNAL_ERROR, RpcError } from "./errors.ts";
import type { AgyDriverEvent, AgyProcess } from "./agy-driver.ts";
import { agentMessageChunk, deniedActionsNotice, toolCallFailed, usageUpdate } from "./update-map.ts";

/** The in-flight turn the session tracks; `settled` guards against double settlement. */
export interface PendingTurn {
	resolve: (result: AcpPromptResult) => void;
	reject: (error: Error) => void;
	settled: boolean;
}

/** The turn state the settle machinery reads; the session is a structural implementation. */
export interface TurnSettleHost {
	pending: PendingTurn | null;
	/** Sub-issue 54 (cancel) will set this; until it lands it is never true. */
	cancelRequested: boolean;
	activeTools: Set<string>;
	emit(update: AcpSessionUpdate): void;
}

/** A turn host that can also provide the live child (respawning when needed). */
export interface RunTurnHost extends TurnSettleHost {
	ensureDriver(): Promise<AgyProcess>;
}

/** One user turn: send the text to the live child and wait for its `result`. */
export async function runTurn(host: RunTurnHost, text: string): Promise<AcpPromptResult> {
	const driver = await host.ensureDriver();
	const promise = new Promise<AcpPromptResult>((resolve, reject) => (host.pending = { resolve, reject, settled: false }));
	host.activeTools.clear();
	try {
		driver.send(text);
	} catch (err) {
		const pending = host.pending;
		if (pending && !pending.settled) {
			pending.settled = true;
			host.pending = null;
			pending.reject(new RpcError(INTERNAL_ERROR, `cannot send to agy: ${(err as Error).message}`));
		}
	}
	return promise;
}

/** Fail every tool still ACTIVE: a client must never show a tool running forever. */
export function failActiveTools(host: TurnSettleHost, message: string): void {
	for (const id of host.activeTools) host.emit(toolCallFailed(id, message));
	host.activeTools.clear();
}

/** The `result`-driven end of a turn (see the file header for the mapping). */
export function settleTurn(host: TurnSettleHost, e: Extract<AgyDriverEvent, { event: "result" }>, driver: AgyProcess): void {
	const pending = host.pending;
	if (!pending) return;
	pending.settled = true;
	host.pending = null;
	failActiveTools(host, "the turn ended before the tool reported a terminal state");
	const denied = e.result.denied_actions;
	// The driver already turned agy's cumulative counters into per-turn deltas (no double counting across turns).
	if (e.result.status === "SUCCESS") {
		host.emit(usageUpdate(e.result.usage, e.result.num_turns, e.result.duration_seconds));
		const meta: NonNullable<AcpPromptResult["_meta"]> = {
			usage: e.result.usage,
			numTurns: e.result.num_turns,
			durationSeconds: e.result.duration_seconds,
		};
		if (denied && denied.length > 0) {
			// The notice goes out before the response: a headless auto-deny is never a silent end_turn.
			host.emit(agentMessageChunk(deniedActionsNotice(denied)));
			meta.deniedActions = denied;
		}
		pending.resolve({ stopReason: "end_turn", _meta: meta });
	} else if (host.cancelRequested && (e.result.error === "interrupted" || e.result.error === "cancelled")) {
		// Sub-issue 54: an interruption we caused is a cancellation, not an error.
		pending.resolve({ stopReason: "cancelled" });
	} else {
		pending.reject(
			new RpcError(INTERNAL_ERROR, `agy turn failed: ${e.result.error ?? "unknown error"}`, {
				agyError: e.result.error ?? "unknown error",
				stderrTail: driver.stderrTail,
			}),
		);
	}
}
