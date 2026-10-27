// The agy stream → ACP session/update mapping: builders for the notifications a turn emits.
//
// The mappings this sub-issue owns:
//   - `agent_response` text_delta  → agent_message_chunk
//   - tool step ACTIVE            → tool_call (status "pending", stable toolCallId, kind, title,
//     rawInput, locations for file tools)
//   - tool step DONE             → tool_call_update "completed" (the output, truncated with a marker)
//   - tool step ERROR            → tool_call_update "failed" (the tool's error message)
//   - system_message             → a logged agent_message_chunk notice
//   - per-turn usage delta       → usage_update (agy-acp extension)
//
// Subagent steps have no mapping of their own: their gating and attribution land in sub-issue 59.
// The one exception is settling: a tool step's terminal state may arrive with the step's own
// type (an invoke_subagent DONE comes in as step_type "subagent"), so a tracked toolCallId
// settles regardless of the type it arrives under.

import type {
	AcpAgentMessageChunk,
	AcpToolCall,
	AcpToolCallLocation,
	AcpToolCallUpdate,
	AcpToolKind,
	AcpUsage,
	AcpUsageUpdate,
} from "./acp.ts";
import type { AgyDeniedAction } from "./agy-driver.ts";

/** Max characters of a tool output or error message carried to the client before truncation. */
export const MAX_TOOL_TEXT_CHARS = 8192;

/**
 * The stable toolCallId: the conversation id plus the step index. agy's step index is per
 * conversation - the recorded resumed process continues the original process's numbering
 * (resumed-conversation: 6, 7, 8 after the original 0..5) - so the id is unique for the whole
 * session, across turns and across a respawn.
 */
export function toolCallIdOf(conversationId: string, stepIndex: number): string {
	return `${conversationId}:${stepIndex}`;
}

/** agy's tool names (the recorded surface, spike 1.4.2) to ACP tool kinds; unknown names are "other". */
const KIND_BY_TOOL: Record<string, AcpToolKind> = {
	run_command: "execute",
	run_workflow: "execute",
	send_command_input: "execute",
	notebook_execution: "execute",
	view_file: "read",
	read_file: "read",
	list_dir: "read",
	read_resource: "read",
	read_browser_page: "read",
	browser_get_dom: "read",
	browser_get_network_request: "read",
	list_resources: "read",
	list_permissions: "read",
	list_browser_pages: "read",
	list_plugin_accounts: "read",
	command_status: "read",
	write_file: "edit",
	write_to_file: "edit",
	edit_file: "edit",
	replace_file_content: "edit",
	multi_replace_file_content: "edit",
	sed_file: "edit",
	notebook_edit: "edit",
	grep_search: "search",
	find_by_name: "search",
	search_web: "search",
	search_marketplace: "search",
	read_url_content: "fetch",
};

export function toolKindOf(toolName: string): AcpToolKind {
	return KIND_BY_TOOL[toolName] ?? "other";
}

/** The parameter names a title is built from, in preference order (the recorded parameter surface). */
const TITLE_PARAM_CANDIDATES = ["CommandLine", "Path", "query", "Uri", "URL", "Role", "Name", "Content", "Prompt"];

/** `run_command: cat a.txt` - the tool name plus the first key parameter that is a string. */
export function toolTitleOf(toolName: string, parameters: Record<string, unknown>): string {
	for (const key of TITLE_PARAM_CANDIDATES) {
		const value = parameters[key];
		if (typeof value === "string" && value !== "") return truncate(`${toolName}: ${value}`, 200);
	}
	return toolName;
}

/** File tools (a `Path` parameter) carry the file location. */
export function toolLocationsOf(parameters: Record<string, unknown>): AcpToolCallLocation[] | undefined {
	const path = parameters.Path;
	return typeof path === "string" && path !== "" ? [{ path }] : undefined;
}

/** Truncates at a whole code point and says what was lost; the marker carries the original length. */
export function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	let cut = text.slice(0, maxChars);
	const tail = cut.codePointAt(cut.length - 1);
	if (tail !== undefined && tail >= 0xd800 && tail <= 0xdfff) cut = cut.slice(0, -1); // a split surrogate pair
	return `${cut}\n… [truncated, ${text.length} characters total]`;
}

export function agentMessageChunk(text: string): AcpAgentMessageChunk {
	return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

export function toolCallStarted(
	toolCallId: string,
	title: string,
	kind: AcpToolKind,
	rawInput: Record<string, unknown> | undefined,
	locations: AcpToolCallLocation[] | undefined,
): AcpToolCall {
	const update: AcpToolCall = { sessionUpdate: "tool_call", toolCallId, title, kind, status: "pending" };
	if (rawInput !== undefined) update.rawInput = rawInput;
	if (locations !== undefined) update.locations = locations;
	return update;
}

export function toolCallCompleted(toolCallId: string, output: string | undefined): AcpToolCallUpdate {
	const update: AcpToolCallUpdate = { sessionUpdate: "tool_call_update", toolCallId, status: "completed" };
	if (output !== undefined) update.content = [{ type: "content", content: { type: "text", text: truncate(output, MAX_TOOL_TEXT_CHARS) } }];
	return update;
}

export function toolCallFailed(toolCallId: string, message: string): AcpToolCallUpdate {
	return {
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: "failed",
		content: [{ type: "content", content: { type: "text", text: truncate(message, MAX_TOOL_TEXT_CHARS) } }],
	};
}

export function usageUpdate(usage: AcpUsage, numTurns: number, durationSeconds: number): AcpUsageUpdate {
	return { sessionUpdate: "usage_update", usage: { ...usage }, numTurns, durationSeconds };
}

/**
 * The auto-deny notice: one chunk listing every denied action. It goes out before the turn's
 * response, so a headless auto-deny is never a silent end_turn.
 */
export function deniedActionsNotice(denied: AgyDeniedAction[]): string {
	return `[agy auto-denied ${denied.length} action(s) in headless mode: ${denied.map((d) => d.display_name || d.action).join(", ")}]`;
}

/** Recorded system_message steps carry no text; the notice is the fallback. */
export function systemMessageText(textDelta: string | undefined): string {
	return textDelta !== undefined ? textDelta : "[system message]";
}
