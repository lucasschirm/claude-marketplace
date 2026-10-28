// The `step_update` → session/update mapping (the part of a turn's stream that is not text).
//
// Extracted from the session (issue #54 grew the session with cancel and heartbeat machinery, and
// a session file has a 300-line budget): the rules themselves are unchanged.
//
//   agent_response text_delta  → agent_message_chunk
//   system_message            → a logged agent_message_chunk notice
//   tool step ACTIVE          → tool_call (recorded in the gate: its parameters are what the
//                               PreToolUse hook that follows is expected to be asked about)
//   tool step DONE / ERROR    → tool_call_update completed / failed
//
// Settling is tracking-based on purpose: a terminal step_update may carry the step's own type (an
// invoke_subagent DONE arrives as step_type "subagent"), so any tracked id settles and untracked
// ones (user_input) are ignored. Subagent *internal* steps stay unmapped (sub-issue 59). A state
// outside the observed set (a newer agy state) keeps the tool tracked: failActiveTools settles it
// at the turn end, so a client never shows a tool running forever.

import type { AcpSessionUpdate } from "./acp.ts";
import type { PermissionGate } from "./permission-gate.ts";
import type { AgyStepUpdateEvent } from "./agy-driver.ts";
import {
	agentMessageChunk,
	systemMessageText,
	toolCallCompleted,
	toolCallFailed,
	toolCallIdOf,
	toolKindOf,
	toolLocationsOf,
	toolCallStarted,
	toolTitleOf,
} from "./update-map.ts";

/** What the mapper may touch on the session: the tracked tools, the update emitter and the gate. */
export interface StepMapHost {
	/** The tool calls this turn has open; a terminal state removes the id it settles. */
	activeTools: Set<string>;
	/** The session's conversation id (the toolCallId is conversation-scoped). */
	conversationId: string;
	log: (line: string) => void;
	emit: (update: AcpSessionUpdate) => void;
	gate: PermissionGate;
}

/** One `step_update` of a running turn, mapped to zero or more session/update notifications. */
export function mapStepToUpdates(host: StepMapHost, s: AgyStepUpdateEvent["step_update"]): void {
	if (s.step_type === "agent_response") {
		if (typeof s.text_delta === "string" && s.text_delta !== "") host.emit(agentMessageChunk(s.text_delta));
		return;
	}
	if (s.step_type === "system_message") {
		host.log(`session ${host.conversationId}: system_message step ${s.step_index} (${s.state})`);
		host.emit(agentMessageChunk(systemMessageText(s.text_delta)));
		return;
	}
	const id = toolCallIdOf(host.conversationId, s.step_index);
	if (s.state === "ACTIVE") mapActiveTool(host, s, id);
	else if (s.state !== "DONE" && s.state !== "ERROR") return;
	else if (host.activeTools.delete(id)) settleTerminalTool(host, s, id);
}

function mapActiveTool(host: StepMapHost, s: AgyStepUpdateEvent["step_update"], id: string): void {
	if (s.step_type !== "tool") return;
	host.activeTools.add(id);
	const name = s.tool_name ?? s.tool_info?.name ?? "tool";
	const parameters = s.tool_info?.parameters;
	// The stream's ACTIVE precedes the PreToolUse hook: the call is created from the stream's
	// parameters; the gate follows with an in_progress update on a rewrite or a pending ask.
	host.gate.onStreamActive(s.step_index, name, parameters);
	const title = toolTitleOf(name, parameters ?? {});
	host.emit(toolCallStarted(id, title, toolKindOf(name), parameters, parameters ? toolLocationsOf(parameters) : undefined));
}

function settleTerminalTool(host: StepMapHost, s: AgyStepUpdateEvent["step_update"], id: string): void {
	if (s.state === "DONE") host.emit(toolCallCompleted(id, s.tool_info?.output));
	else if (s.state === "ERROR") host.emit(toolCallFailed(id, s.tool_info?.error?.message ?? "tool failed"));
}
