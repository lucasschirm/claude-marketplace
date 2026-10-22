// Devin permission modes and the session/request_permission round-trip.
//
// In every ACP mode but `bypass`, Devin asks the client before running a tool it is not allowed to
// run on its own, then blocks the turn until it gets an answer. These helpers turn that request into
// something the delegating agent can read and answer, and turn the agent's decision back into the
// ACP response. They are pure: devin-delegate.ts owns the timers, the clients and the notices.

/** Modes Devin's ACP server accepts (its config_option_update vocabulary, devin 2026-10). */
export const ACP_MODES = ["bypass", "smart", "accept-edits", "plan", "ask"] as const;

/** Tool-facing names that are not ACP mode ids. */
const MODE_ALIASES: Record<string, string> = {
	// The tool's historical default: approves every tool call.
	dangerous: "bypass",
	// Not an ACP mode: Devin accepted set_mode("auto") and silently stayed in accept-edits, which asks
	// before every shell command. "smart" is the mode that approves what the model judges safe.
	auto: "smart",
};

/** Every value the `mode` parameter accepts, for tool descriptions and error messages. */
export const MODE_NAMES = ["dangerous", ...Object.keys(MODE_ALIASES).filter((m) => m !== "dangerous"), ...ACP_MODES];

export type ModeResolution = { ok: true; acpMode: string } | { ok: false; error: string };

/** Map a tool-facing mode to the ACP mode id, refusing values Devin would silently ignore. */
export function resolveAcpMode(mode: string): ModeResolution {
	const key = mode.trim().toLowerCase();
	const acpMode = MODE_ALIASES[key] ?? key;
	if ((ACP_MODES as readonly string[]).includes(acpMode)) return { ok: true, acpMode };
	return { ok: false, error: `Unknown mode '${mode}'. Valid modes: ${MODE_NAMES.join(", ")}.` };
}

/** The value strings of one config option; Devin sends `{ value, name }` objects, older builds bare strings. */
export function optionValues(options: unknown): string[] {
	if (!Array.isArray(options)) return [];
	const out: string[] = [];
	for (const o of options) {
		if (typeof o === "string") out.push(o);
		else if (o && typeof (o as { value?: unknown }).value === "string") out.push((o as { value: string }).value);
	}
	return out;
}

export interface PermissionOption {
	optionId: string;
	name: string;
	kind: string;
}

export interface PermissionRequest {
	/** The JSON-RPC id the answer must carry (a string UUID from Devin). */
	requestId: number | string;
	toolCallId?: string;
	/** What Devin wants to run, as shown to the agent. */
	command: string;
	options: PermissionOption[];
	requestedAt: number;
}

/** The parts of a session/request_permission payload this module reads; every field may be missing. */
interface RawPermissionParams {
	toolCall?: {
		toolCallId?: string;
		title?: string;
		kind?: string;
		rawInput?: unknown;
		_meta?: Record<string, unknown>;
	};
	options?: unknown;
}

interface RawPermissionOption {
	optionId?: unknown;
	name?: unknown;
	kind?: unknown;
}

/** Read a session/request_permission payload; tolerant of missing fields so a request is never dropped. */
export function parsePermissionRequest(requestId: number | string, rawParams: unknown, now = Date.now()): PermissionRequest {
	const params = (rawParams ?? {}) as RawPermissionParams;
	const toolCall = params.toolCall ?? {};
	const command =
		toolCall._meta?.["cognition.ai/editableCommand"] ??
		toolCall.title ??
		(toolCall.rawInput !== undefined ? JSON.stringify(toolCall.rawInput) : undefined) ??
		toolCall.kind ??
		"(unknown tool call)";
	const rawOptions: RawPermissionOption[] = Array.isArray(params.options) ? params.options : [];
	const options: PermissionOption[] = rawOptions
		.filter((o) => typeof o?.optionId === "string")
		.map((o) => ({ optionId: o.optionId as string, name: String(o.name ?? o.optionId), kind: String(o.kind ?? "") }));
	return { requestId, toolCallId: toolCall.toolCallId, command: String(command), options, requestedAt: now };
}

/** Longest command text shown to the agent; the rest is cut and its length reported. */
const COMMAND_PREVIEW_MAX = 500;

// Characters JSON.stringify leaves raw that can still break a line or reorder what is displayed.
const INVISIBLE_OR_LINE_BREAKING = /[\u0085\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g;

/**
 * The command as data for the agent. It comes from the Devin session, which reads untrusted repository
 * content, and lands in a message asking the agent to approve it, so it is JSON-quoted (newlines,
 * quotes and control characters escaped: it cannot break out into the surrounding prose) and capped.
 */
export function quoteCommand(command: string): string {
	const shown =
		command.length > COMMAND_PREVIEW_MAX
			? `${command.slice(0, COMMAND_PREVIEW_MAX)}... [${command.length - COMMAND_PREVIEW_MAX} more characters]`
			: command;
	return JSON.stringify(shown).replace(INVISIBLE_OR_LINE_BREAKING, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** What the agent may answer. `allow_session` also approves the same command for the rest of the session. */
export const PERMISSION_DECISIONS = ["allow", "allow_session", "reject"] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

/**
 * The option that carries out `decision`, or undefined when Devin offered none (the answer is then
 * "cancelled", which Devin treats as a rejection). Never picks an option that widens permissions
 * beyond the session (always-allow for the project or globally, or switching to bypass).
 */
export function pickPermissionOption(options: PermissionOption[], decision: PermissionDecision): string | undefined {
	const byId = (id: string) => options.find((o) => o.optionId === id)?.optionId;
	const byKind = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
	if (decision === "reject") return byId("reject_once") ?? byKind("reject_once") ?? byKind("reject_always");
	if (decision === "allow_session") return byId("allow_session") ?? byId("allow_once") ?? byKind("allow_once");
	return byId("allow_once") ?? byKind("allow_once");
}

/** The ACP result for a session/request_permission request. */
export function permissionOutcome(optionId: string | undefined): {
	outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
} {
	return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
}
