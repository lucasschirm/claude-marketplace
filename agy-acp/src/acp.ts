// The Agent Client Protocol (ACP) wire surface agy-acp speaks: the session methods this sub-issue
// implements (session/new, session/prompt), the session/update notifications the agy stream is
// mapped into, and the server-defined error code the session layer uses.
//
// The base shapes follow ACP v1 (agentclientprotocol.com). Two parts are agy-acp's own extension
// and documented in the README: the `usage_update` session update (a per-turn usage delta, which
// the repo's own Pi delegate already consumes from `devin acp`) and the `failed` tool-call status
// (agy's tool `ERROR` state has no counterpart in the base status set).

/** Server-defined error (the -32000..-32099 server range): a session/prompt while a turn runs. */
export const TURN_IN_PROGRESS = -32002;

// ---------------------------------------------------------------- content blocks (prompt input)

export interface AcpTextBlock {
	type: "text";
	text: string;
}
export interface AcpImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}
export interface AcpAudioBlock {
	type: "audio";
	data: string;
	mimeType: string;
}
export interface AcpResourceLinkBlock {
	type: "resource_link";
	uri: string;
	name?: string;
	title?: string;
	mimeType?: string;
}
export interface AcpResourceBlock {
	type: "resource";
	resource: {
		uri: string;
		text?: string;
		mimeType?: string;
	};
}
export type AcpContentBlock = AcpTextBlock | AcpImageBlock | AcpAudioBlock | AcpResourceLinkBlock | AcpResourceBlock;

// ---------------------------------------------------------------- session/new

/** An ACP MCP server descriptor (stdio, http or sdk); accepted and reported, never executed. */
export interface AcpMcpServer {
	type?: string;
	name?: string;
	command?: string;
	args?: string[];
	env?: string[];
	url?: string;
	headers?: string[];
	[key: string]: unknown;
}
export interface AcpSessionNewParams {
	cwd: string;
	mcpServers?: AcpMcpServer[];
}
export interface AcpSessionMode {
	id: string;
	name: string;
	description?: string;
}
export interface AcpSessionModeState {
	currentModeId: string;
	availableModes: AcpSessionMode[];
}
export interface AcpSessionModelState {
	currentModelId: string;
	availableModels: string[];
}
export interface AcpSessionNewResult {
	sessionId: string;
	modes: AcpSessionModeState;
	models: AcpSessionModelState;
	_meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------- session/prompt

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export interface AcpPromptResult {
	stopReason: AcpStopReason;
	/** Per-turn usage delta, and the denied actions when agy auto-denied tool calls. */
	_meta?: {
		usage: AcpUsage;
		numTurns: number;
		durationSeconds: number;
		deniedActions?: AcpDeniedAction[];
		[other: string]: unknown;
	};
}

// ---------------------------------------------------------------- session/update notifications

export interface AcpUsage {
	input_tokens: number;
	output_tokens: number;
	thinking_tokens: number;
	cache_read_tokens: number;
	total_tokens: number;
}
export interface AcpDeniedAction {
	action: string;
	display_name: string;
}
export interface AcpAgentMessageChunk {
	sessionUpdate: "agent_message_chunk";
	content: AcpContentBlock;
}
export type AcpToolKind = "execute" | "edit" | "read" | "search" | "fetch" | "think" | "other";
/** The base ACP statuses plus `failed`, agy-acp's extension for agy's tool `ERROR` state. */
export type AcpToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export type AcpToolCallContent =
	| { type: "content"; content: AcpContentBlock }
	| { type: "diff"; path: string; oldText?: string; newText?: string };
export interface AcpToolCallLocation {
	path: string;
	line?: number;
}
export interface AcpToolCall {
	sessionUpdate: "tool_call";
	toolCallId: string;
	title: string;
	kind: AcpToolKind;
	status: AcpToolCallStatus;
	content?: AcpToolCallContent[];
	locations?: AcpToolCallLocation[];
	rawInput?: unknown;
	/** agy-acp extension: the pending permission state and rewritten-args detection. */
	_meta?: Record<string, unknown>;
}
export interface AcpToolCallUpdate {
	sessionUpdate: "tool_call_update";
	toolCallId: string;
	title?: string;
	status?: AcpToolCallStatus;
	content?: AcpToolCallContent[];
	locations?: AcpToolCallLocation[];
	rawInput?: unknown;
	/** agy-acp extension: the pending permission state and rewritten-args detection. */
	_meta?: Record<string, unknown>;
}
/** agy-acp extension: the per-turn usage delta (the driver converts the cumulative counters). */
export interface AcpUsageUpdate {
	sessionUpdate: "usage_update";
	usage: AcpUsage;
	numTurns: number;
	durationSeconds: number;
}
export type AcpSessionUpdate = AcpAgentMessageChunk | AcpToolCall | AcpToolCallUpdate | AcpUsageUpdate;
export interface AcpSessionUpdateParams {
	sessionId: string;
	update: AcpSessionUpdate;
}
