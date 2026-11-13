// Subagents reported by agy on the parent stream (issue #59).
//
// A subagent's own tool calls fire `PreToolUse` with the SUBAGENT's conversation id, and a subagent's
// steps never appear in the parent's stream. agy names a subagent only in
// `step_update.subagent_info.subagents[]`, on the terminal step of the spawning call - after the
// subagent has already worked. So the mapping (subagent conversation id -> the parent tool call that
// spawned it) is filled from two sources: `subagent_info` when it arrives, and the gate's provisional
// attribution of an unreported conversation while exactly one spawning call is in flight.
//
// This module keeps that map and builds the two client-facing views of it: the permission ask,
// attributed to the parent tool call and saying a subagent is asking, and the progress update that
// gives the subagent's tool calls a place in the parent's stream.

import type { AcpToolCallUpdate, AcpToolKind } from "./acp.ts";
import type { AgySubagentEntry } from "./agy-driver.ts";
import { toolCallIdOf, toolKindOf, toolTitleOf, truncate } from "./update-map.ts";

/** The tools that start a subagent conversation (a subagent's own tool calls arrive under another id). */
export const SUBAGENT_SPAWN_TOOLS: ReadonlySet<string> = new Set(["invoke_subagent", "browser_subagent"]);

export interface SubagentRecord {
	conversationId: string;
	/** The spawning tool call in the parent conversation (`invoke_subagent`), used as the ask's toolCallId. */
	parentToolCallId: string;
	/** agy's role name for it when known (`File Creator`), from the spawn's args or `subagent_info`. */
	role: string;
	typeName: string;
}

export interface SubagentSeed {
	conversationId: string;
	role: string;
	typeName: string;
}

export interface SubagentAskTarget {
	toolCallId: string;
	title: string;
	kind: AcpToolKind;
	/** The `_meta` block that says a subagent is asking, and which of its calls this is. */
	meta: Record<string, unknown>;
}

/** `subagent "File Creator"`: the role agy named it by, or its type, or a short id. */
export function subagentLabel(record: SubagentRecord): string {
	const name = record.role || record.typeName || record.conversationId.slice(0, 8);
	return `subagent "${name}"`;
}

export class Subagents {
	private readonly byConversation = new Map<string, SubagentRecord>();

	/** The mapping for one conversation (a later `subagent_info` refines a provisional record in place). */
	remember(parentToolCallId: string, seed: SubagentSeed): SubagentRecord {
		const record: SubagentRecord = {
			conversationId: seed.conversationId,
			parentToolCallId,
			role: seed.role,
			typeName: seed.typeName,
		};
		this.byConversation.set(record.conversationId, record);
		return record;
	}

	/** Records every entry of a `subagent_info` block; returns the ones that were usable. */
	record(parentToolCallId: string, entries: AgySubagentEntry[]): SubagentRecord[] {
		const out: SubagentRecord[] = [];
		for (const entry of entries) {
			if (entry.conversation_id === "") {
				continue;
			}
			out.push(
				this.remember(parentToolCallId, {
					conversationId: entry.conversation_id,
					role: entry.role,
					typeName: entry.type_name,
				}),
			);
		}
		return out;
	}

	get(conversationId: string): SubagentRecord | undefined {
		return this.byConversation.get(conversationId);
	}

	has(conversationId: string): boolean {
		return this.byConversation.has(conversationId);
	}

	clear(): void {
		this.byConversation.clear();
	}
}

/**
 * The client ask for a subagent's tool call: it references the parent spawning call - the subagent's
 * own step index means nothing in the parent conversation - and says a subagent is asking, in the
 * title and in `_meta.subagent`, which also carries the subagent's own tool-call id so a client can
 * follow it without that id ever colliding with a parent step.
 */
export function subagentAskTarget(record: SubagentRecord, name: string, args: Record<string, unknown>, stepIdx: number): SubagentAskTarget {
	return {
		toolCallId: record.parentToolCallId,
		title: `${subagentLabel(record)}: ${toolTitleOf(name, args)}`,
		kind: toolKindOf(name),
		meta: {
			subagent: {
				conversationId: record.conversationId,
				stepIdx,
				toolCallId: toolCallIdOf(record.conversationId, stepIdx),
				role: record.role,
				typeName: record.typeName,
			},
		},
	};
}

/**
 * Subagent progress as a `tool_call_update` on the parent call. Without it a client watching the
 * `invoke_subagent` call sees nothing between its start and its end. It is content only - the parent
 * call's status belongs to the stream - and carries `_meta.subagent` so it can be told apart from the
 * parent's own updates.
 */
export function subagentProgress(record: SubagentRecord, name: string, args: Record<string, unknown>, stepIdx: number): AcpToolCallUpdate {
	return {
		sessionUpdate: "tool_call_update",
		toolCallId: record.parentToolCallId,
		content: [
			{
				type: "content",
				content: { type: "text", text: truncate(`${subagentLabel(record)} is running ${toolTitleOf(name, args)}`, 400) },
			},
		],
		_meta: {
			subagent: {
				conversationId: record.conversationId,
				stepIdx,
				toolCallId: toolCallIdOf(record.conversationId, stepIdx),
			},
		},
	};
}
