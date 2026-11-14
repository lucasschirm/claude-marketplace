// The wire → canonical mapping, and the canonical → transcript mapping.
//
// Two decisions live here and each one exists because of a concrete failure:
//
// 1. `stopReason` is carried instead of dropped. The old extension resolved `session/prompt` and
//    reported "The session X is done" whatever the reason was, so a turn that stopped at
//    `max_tokens` — or was refused, or cancelled — read exactly like a completed one.
// 2. `agent_thought_chunk` is mapped instead of ignored. It used to be dropped, which was invisible
//    while nothing could ask for reasoning effort; once `thinking` is a tool parameter, the caller
//    needs evidence it did something.
//
// The transcript keeps the event type names the previous extension wrote (`assistant_message`,
// `tool_call`, `usage_update`, `error`) so a session logged before this refactor still reads back.

import type { AcpUpdateFrame, DelegateEvent, StopReason } from "./types.ts";

/** Reason strings an agent may answer with, normalized. Unknown stays unknown — see the type. */
export function normalizeStopReason(value: unknown): StopReason {
	if (typeof value !== "string") {
		return "unknown";
	}
	switch (value) {
		case "end_turn":
		case "max_tokens":
		case "max_turn_requests":
		case "refusal":
		case "cancelled":
		case "error":
			return value;
		default:
			return "unknown";
	}
}

/** A completion sentence per reason. "is done" is reserved for a turn that actually finished. */
export function stopReasonPhrase(reason: StopReason): string {
	switch (reason) {
		case "end_turn":
			return "is done";
		case "max_tokens":
			return "ended early: it hit its token limit and its work is incomplete";
		case "max_turn_requests":
			return "ended early: it hit its per-turn request limit and its work is incomplete";
		case "refusal":
			return "refused the request under its usage policy";
		case "cancelled":
			return "was cancelled";
		case "error":
			return "ended with an error";
		case "unknown":
			return "ended (the agent gave no reason — treat the result as unverified)";
	}
}

/** `content` of a message/chunk: a string, a block, or an array of either. */
export function extractChunkText(content: unknown): string {
	if (content == null) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map((p: any) => extractChunkText(p?.text ?? p)).join("");
	}
	const obj = content as Record<string, unknown>;
	if (typeof obj.text === "string") {
		return obj.text;
	}
	return "";
}

/**
 * The tool's title/description, best effort, capped: it lands in tool output and the TUI.
 *
 * ACP puts the human title on the `tool_call` itself, and that is what a conformant agent (Claude)
 * sends. Devin instead hides it inside `content[].content`, so both shapes are read, in that order —
 * reading only the nested one loses every title from a spec-following agent.
 */
export function extractToolTitle(u: Record<string, any>): string | undefined {
	if (typeof u.title === "string" && u.title) {
		return u.title.slice(0, 120);
	}
	const parts = Array.isArray(u.content) ? u.content : [];
	for (const p of parts) {
		const t = p?.content?.text;
		if (typeof t === "string") {
			return t.slice(0, 120);
		}
		const d = p?.content?.description;
		if (typeof d === "string") {
			return d.slice(0, 120);
		}
		const title = p?.content?.title;
		if (typeof title === "string") {
			return title.slice(0, 120);
		}
	}
	return undefined;
}

/** The advertised values of one config option: `{value,name}` objects, or bare strings on older builds. */
function optionValues(options: unknown): string[] {
	if (!Array.isArray(options)) {
		return [];
	}
	const out: string[] = [];
	for (const o of options) {
		if (typeof o === "string") {
			out.push(o);
		} else if (o && typeof (o as { value?: unknown }).value === "string") {
			out.push((o as { value: string }).value);
		}
	}
	return out;
}

/**
 * The default mapping: what a spec-conformant ACP agent sends. A driver overrides it when its agent
 * deviates, and a driver that only renames a config-option id does not need to touch this at all.
 *
 * Unknown `sessionUpdate` kinds map to `ignored` with the kind named, so a new upstream update type
 * shows up in the transcript instead of vanishing — the difference between "the agent sent nothing"
 * and "we understood nothing", which is the question a stalled session actually asks.
 */
export function defaultMapUpdate(frame: AcpUpdateFrame): DelegateEvent[] {
	const u = frame.update;
	if (!u || typeof u !== "object") {
		return [];
	}
	const kind = String(u.sessionUpdate ?? "");
	switch (kind) {
		case "agent_message": {
			const text = extractChunkText(u.content);
			return text ? [{ kind: "assistant.completed", text }] : [];
		}
		case "agent_message_chunk": {
			const text = extractChunkText(u.content);
			return text ? [{ kind: "assistant.delta", text }] : [];
		}
		case "agent_thought_chunk": {
			const text = extractChunkText(u.content);
			return text ? [{ kind: "thought.delta", text }] : [];
		}
		case "tool_call":
			return [{ kind: "tool.started", toolCallId: str(u.toolCallId), title: extractToolTitle(u) }];
		case "tool_call_update":
			return [{ kind: "tool.updated", toolCallId: str(u.toolCallId), title: extractToolTitle(u), status: str(u.status) }];
		case "plan":
		case "plan_update": {
			const entries = Array.isArray(u.entries) ? u.entries : Array.isArray((u as any).plan) ? (u as any).plan : undefined;
			const done = entries ? entries.filter((e: any) => String(e?.status ?? "") === "completed").length : undefined;
			return [{ kind: "plan.updated", entries: entries?.length, done }];
		}
		case "usage_update": {
			// ACP nests token counts under `usage`, but older servers put them on the frame itself.
			const nested = (u.usage ?? {}) as Record<string, unknown>;
			return [
				{
					kind: "usage.updated",
					used: num(u.used),
					size: num(u.size),
					tokens: {
						total: num(nested.totalTokens ?? u.totalTokens),
						input: num(nested.inputTokens ?? u.inputTokens),
						output: num(nested.outputTokens ?? u.outputTokens),
					},
				},
			];
		}
		case "config_option_update": {
			const options: Record<string, string[]> = {};
			if (Array.isArray(u.configOptions)) {
				for (const co of u.configOptions) {
					if (co?.id && Array.isArray(co.options)) {
						options[String(co.id)] = optionValues(co.options);
					}
				}
			}
			return [
				Object.keys(options).length ? { kind: "selection.updated", options } : { kind: "ignored", reason: "empty config_option_update" },
			];
		}
		case "current_mode_update": {
			const modeId = str(u.currentModeId);
			return modeId ? [{ kind: "mode.changed", modeId }] : [];
		}
		case "available_commands_update":
			return [{ kind: "ignored", reason: "available_commands_update" }];
		case "heartbeat": {
			// An adapter's beat (`agy-acp`, see drivers/agy.ts): the payload is `_meta.heartbeat`. Mapping it
			// keeps a beat every 15 s out of the transcript (see `eventToLogEntries`), which is the whole of
			// what it does today: every frame already restarts the stall clock, and nothing reads the parsed
			// fields — `liveness.ts` decides from the silence alone. A watchdog that treats "waiting on a
			// human" as different from "stalled" would start with these, and does not exist yet.
			const beat = ((u._meta ?? {}) as Record<string, unknown>).heartbeat as Record<string, unknown> | undefined;
			return [
				{
					kind: "liveness",
					state: str(beat?.state),
					pendingPermissions: num(beat?.pendingPermissions),
					turnMs: num(beat?.turnMs),
					seq: num(beat?.seq),
				},
			];
		}
		default:
			return [{ kind: "ignored", reason: kind || "unnamed sessionUpdate" }];
	}
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * One canonical event → the transcript line(s) that record it. Returns nothing for events that are
 * counters, caches or beats rather than history (`selection.updated`, `liveness`, `ignored` of a known
 * kind).
 *
 * `assistant.delta` and `thought.delta` are deliberately absent: the engine buffers chunks and writes
 * one line per flush, which is what keeps a 600-chunk turn from producing 600 lines and 600 fs writes.
 */
export function eventToLogEntries(event: DelegateEvent): Array<{ type: string; data: unknown }> {
	switch (event.kind) {
		case "assistant.completed":
			return [{ type: "assistant_message", data: { text: event.text } }];
		case "tool.started":
			return [{ type: "tool_call", data: { toolCallId: event.toolCallId, title: event.title } }];
		case "tool.updated":
			return [{ type: "tool_call", data: { toolCallId: event.toolCallId, title: event.title, status: event.status } }];
		case "usage.updated":
			return [{ type: "usage_update", data: { used: event.used, size: event.size, tokens: event.tokens } }];
		case "plan.updated":
			return [{ type: "plan_update", data: { entries: event.entries, done: event.done } }];
		case "mode.changed":
			return [{ type: "mode_update", data: { modeId: event.modeId } }];
		default:
			return [];
	}
}
