// The stream-json contract of `agy -p --input-format stream-json --output-format stream-json`,
// typed from the spike field inventory (test/fixtures/stream/field-inventory.json, agy 1.4.2).
//
// Two rules shape everything here:
//
//   - unknown fields are kept on the raw record and ignored by the typed view, so a new agy field
//     must not fail a parse - the fixtures are the known surface, the contract is tolerant beyond it;
//   - known fields are copied verbatim, leniently: a missing or mistyped value degrades to a typed
//     default instead of throwing, because a contract drift that crashes the driver strands the
//     session.

/** Token usage; every counter agy reports. */
export interface AgyUsage {
	input_tokens: number;
	output_tokens: number;
	thinking_tokens: number;
	cache_read_tokens: number;
	total_tokens: number;
}

/** First output event, emitted after the first stdin line - which is what the probe exploits. */
export interface AgyInitEvent {
	event: "init";
	conversation_id: string;
	init: {
		model: string;
		cwd: string;
		tools: string[];
		permission_mode: string;
	};
}

export type AgyStepType = "user_input" | "agent_response" | "tool" | "subagent" | "system_message";
export type AgyStepState = "ACTIVE" | "DONE" | "ERROR";

export interface AgyToolError {
	type: string;
	message: string;
}

/** Present on `tool` steps; `parameters` is tool-specific (CommandLine, Path, query, …). */
export interface AgyToolInfo {
	name: string;
	parameters: Record<string, unknown>;
	output?: string;
	error?: AgyToolError;
}

/** Present on `subagent` steps, one entry per spawned subagent. */
export interface AgySubagentEntry {
	type_name: string;
	role: string;
	initial_prompt: string;
	conversation_id: string;
	log_uri: string;
	workspace_uris: string[];
}

export interface AgyStepUpdateEvent {
	event: "step_update";
	step_update: {
		conversation_id: string;
		step_index: number;
		state: AgyStepState;
		step_type: AgyStepType;
		/** Text chunk on `agent_response` steps. */
		text_delta?: string;
		/** Step duration, present on terminal (`DONE`/`ERROR`) steps. */
		duration_seconds?: number;
		/** Cumulative usage, present on terminal `agent_response` steps. */
		usage?: AgyUsage;
		/** Tool steps: the tool name, plus details. */
		tool_name?: string;
		tool_info?: AgyToolInfo;
		/** Subagent steps. */
		subagent_info?: { subagents: AgySubagentEntry[] };
	};
}

export type AgyResultStatus = "SUCCESS" | "ERROR";

export interface AgyDeniedAction {
	action: string;
	display_name: string;
}

/** One per turn. `usage`, `num_turns` and `duration_seconds` are cumulative per process and per
 * resumed conversation - the driver converts them to per-turn deltas before emitting. */
export interface AgyResultEvent {
	event: "result";
	result: {
		conversation_id: string;
		status: AgyResultStatus;
		response: string;
		/** Set when `status` is `ERROR` (e.g. `interrupted`, a failed decode, a bad model). */
		error?: string;
		/** Non-empty when agy auto-denied tool calls (headless) - must be surfaced to the client. */
		denied_actions?: AgyDeniedAction[];
		num_turns: number;
		duration_seconds: number;
		usage: AgyUsage;
	};
}

export type AgyEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

/** A decoded stdout line: one of the three known events, or an unknown event kept but ignored. */
export type ParsedAgyLine = { kind: "event"; event: AgyEvent } | { kind: "unknown"; event: string; raw: unknown };

/** Cumulative counters as a process last reported them, carried over across a `--conversation` resume. */
export interface AgyCumulative {
	usage: AgyUsage;
	num_turns: number;
	duration_seconds: number;
}

export const ZERO_CUMULATIVE: AgyCumulative = {
	usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
	num_turns: 0,
	duration_seconds: 0,
};

/** The driver's starting cumulative state: the resumed counters, or zero. */
export function initialStateOf(previous: AgyCumulative | undefined): AgyCumulative {
	return previous
		? { usage: { ...previous.usage }, num_turns: previous.num_turns, duration_seconds: previous.duration_seconds }
		: { usage: { ...ZERO_CUMULATIVE.usage }, num_turns: ZERO_CUMULATIVE.num_turns, duration_seconds: ZERO_CUMULATIVE.duration_seconds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asUsage(value: unknown): AgyUsage {
	const u = isRecord(value) ? value : {};
	return {
		input_tokens: asNumber(u.input_tokens, 0),
		output_tokens: asNumber(u.output_tokens, 0),
		thinking_tokens: asNumber(u.thinking_tokens, 0),
		cache_read_tokens: asNumber(u.cache_read_tokens, 0),
		total_tokens: asNumber(u.total_tokens, 0),
	};
}

function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.every((v) => typeof v === "string") ? (value as string[]) : [];
}

function toInitEvent(raw: Record<string, unknown>): AgyInitEvent {
	const init = isRecord(raw.init) ? raw.init : {};
	return {
		event: "init",
		conversation_id: asString(raw.conversation_id, ""),
		init: {
			model: asString(init.model, ""),
			cwd: asString(init.cwd, ""),
			tools: asStringArray(init.tools),
			permission_mode: asString(init.permission_mode, ""),
		},
	};
}

function toToolInfo(raw: unknown): AgyToolInfo | undefined {
	if (!isRecord(raw)) return undefined;
	const info: AgyToolInfo = {
		name: asString(raw.name, ""),
		parameters: isRecord(raw.parameters) ? (raw.parameters as Record<string, unknown>) : {},
	};
	if (typeof raw.output === "string") info.output = raw.output;
	if (isRecord(raw.error)) info.error = { type: asString(raw.error.type, ""), message: asString(raw.error.message, "") };
	return info;
}

function toSubagentEntry(raw: unknown): AgySubagentEntry {
	const s = isRecord(raw) ? raw : {};
	return {
		type_name: asString(s.type_name, ""),
		role: asString(s.role, ""),
		initial_prompt: asString(s.initial_prompt, ""),
		conversation_id: asString(s.conversation_id, ""),
		log_uri: asString(s.log_uri, ""),
		workspace_uris: asStringArray(s.workspace_uris),
	};
}

function toStepUpdateEvent(raw: Record<string, unknown>): AgyStepUpdateEvent {
	const su = isRecord(raw.step_update) ? raw.step_update : {};
	const step: AgyStepUpdateEvent["step_update"] = {
		conversation_id: asString(su.conversation_id, ""),
		step_index: asNumber(su.step_index, -1),
		// Lenient copy: a value outside the observed set (a new agy state or step type) must not
		// fail the parse, so the typed union is a cast, not a runtime check.
		state: asString(su.state, "") as AgyStepState,
		step_type: asString(su.step_type, "") as AgyStepType,
	};
	if (typeof su.text_delta === "string") step.text_delta = su.text_delta;
	if (su.duration_seconds !== undefined) step.duration_seconds = asNumber(su.duration_seconds, 0);
	if (su.usage !== undefined) step.usage = asUsage(su.usage);
	if (typeof su.tool_name === "string") step.tool_name = su.tool_name;
	step.tool_info = toToolInfo(su.tool_info);
	if (isRecord(su.subagent_info)) {
		const subs = Array.isArray(su.subagent_info.subagents) ? su.subagent_info.subagents : [];
		step.subagent_info = { subagents: subs.map((s) => toSubagentEntry(s)) };
	}
	return { event: "step_update", step_update: step };
}

function toDeniedAction(raw: unknown): AgyDeniedAction {
	const d = isRecord(raw) ? raw : {};
	return { action: asString(d.action, ""), display_name: asString(d.display_name, "") };
}

function toResultEvent(raw: Record<string, unknown>): AgyResultEvent {
	const r = isRecord(raw.result) ? raw.result : {};
	const result: AgyResultEvent["result"] = {
		conversation_id: asString(r.conversation_id, ""),
		status: asString(r.status, "") as AgyResultStatus,
		response: asString(r.response, ""),
		num_turns: asNumber(r.num_turns, 0),
		duration_seconds: asNumber(r.duration_seconds, 0),
		usage: asUsage(r.usage),
	};
	if (typeof r.error === "string") result.error = r.error;
	if (Array.isArray(r.denied_actions)) result.denied_actions = r.denied_actions.map((d) => toDeniedAction(d));
	return { event: "result", result };
}

/**
 * Decodes one line of agy's stream-json stdout. Never throws: a line that is not valid JSON, not an
 * object, or not one of the three known events comes back as `unknown` (kept, ignored), so a drifted
 * agy degrades to a warning instead of a crash.
 */
export function parseAgyLine(line: string): ParsedAgyLine {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return { kind: "unknown", event: "", raw };
	}
	if (!isRecord(raw) || typeof raw.event !== "string") return { kind: "unknown", event: "", raw };
	switch (raw.event) {
		case "init":
			return { kind: "event", event: toInitEvent(raw) };
		case "step_update":
			return { kind: "event", event: toStepUpdateEvent(raw) };
		case "result":
			return { kind: "event", event: toResultEvent(raw) };
		default:
			return { kind: "unknown", event: raw.event, raw };
	}
}

/** The cumulative counters a result reports (the raw values, before delta conversion). */
export function cumulativeOf(result: AgyResultEvent["result"]): AgyCumulative {
	return { usage: { ...result.usage }, num_turns: result.num_turns, duration_seconds: result.duration_seconds };
}

export interface AgyResultDelta {
	usage: AgyUsage;
	num_turns: number;
	duration_seconds: number;
}

/** Per-turn delta of a result against the cumulative counters observed before this turn. */
export function resultDeltas(result: AgyResultEvent["result"], previous: AgyCumulative): AgyResultDelta {
	const u = result.usage;
	const p = previous.usage;
	return {
		usage: {
			input_tokens: u.input_tokens - p.input_tokens,
			output_tokens: u.output_tokens - p.output_tokens,
			thinking_tokens: u.thinking_tokens - p.thinking_tokens,
			cache_read_tokens: u.cache_read_tokens - p.cache_read_tokens,
			total_tokens: u.total_tokens - p.total_tokens,
		},
		num_turns: result.num_turns - previous.num_turns,
		duration_seconds: result.duration_seconds - previous.duration_seconds,
	};
}
