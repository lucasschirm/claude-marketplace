// Permission modes and the `session/request_permission` round-trip, with the agent vocabulary taken out.
//
// An agent in any mode but its "asks about nothing" mode queries the client before running a tool and
// blocks its turn until the answer arrives. This module turns that request into something the
// delegating agent can read and answer, and the decision back into an ACP response. It is pure: the
// runtime owns the timers, the transports and the notices.
//
// What changed from `lib/devin-permissions.ts`: the mode list. Devin's wire modes (`bypass`,
// `accept-edits`) and Claude's (`bypassPermissions`, `acceptEdits`) are different spellings of the
// same intent, and a single hardcoded table would have to be wrong for one of them. So the canonical
// vocabulary lives here and each driver supplies its own alias table — see `makeModeResolver`.

import type { Catalogue } from "./types.ts";

/** The mode names the tools accept. Nothing below this line knows what an agent calls them. */
export const CANONICAL_MODES = ["dangerous", "smart", "accept-edits", "plan", "ask"] as const;
export type CanonicalMode = (typeof CANONICAL_MODES)[number];

export type ModeResolution = { ok: true; modeId: string } | { ok: false; error: string };

/**
 * A mode resolver from one driver's alias table.
 *
 * Rejecting an unknown mode is not pedantry: Devin accepted `set_mode("auto")` and silently stayed in
 * `accept-edits`, which asks before every shell command — a session that reported running in one mode
 * while running in another. An agent must be refused, not quietly reinterpreted.
 */
export function makeModeResolver(aliases: Record<string, string>, advertised?: readonly string[]): (mode: string) => ModeResolution {
	// Wire ids are matched case-insensitively too, and the value from the table is what gets returned:
	// Claude spells its modes `bypassPermissions` / `acceptEdits`, and a caller who types
	// `bypasspermissions` means that mode rather than an unknown one. Answering with the table's own
	// spelling is what keeps `session/set_mode` from failing on a capital letter.
	const wireIds = new Map<string, string>();
	for (const [canonical, wire] of Object.entries(aliases)) {
		wireIds.set(canonical.toLowerCase(), wire);
		wireIds.set(wire.toLowerCase(), wire);
	}
	const resolve = (mode: string): ModeResolution => {
		const key = (mode ?? "").trim().toLowerCase();
		const modeId = wireIds.get(key);
		if (modeId) {
			return { ok: true, modeId };
		}
		return { ok: false, error: `Unknown mode '${mode}'. Valid modes: ${Object.keys(aliases).sort().join(", ")}.` };
	};
	// `advertised` is what the running agent actually offered (from config_option_update). It narrows
	// nothing at the type level but lets the error name the agent's real vocabulary when we know it.
	if (advertised?.length) {
		return (mode) => {
			const res = resolve(mode);
			if (res.ok && !advertised.includes(res.modeId)) {
				return {
					ok: false,
					error: `Mode '${mode}' maps to '${res.modeId}', which this agent does not offer (it offers: ${advertised.join(", ")}).`,
				};
			}
			return res;
		};
	}
	return resolve;
}

/** The catalogue a tool description is generated from: canonical names, driver default. */
export function modeCatalogue(defaultMode: string): Catalogue {
	return { default: defaultMode, values: CANONICAL_MODES, onUnknown: "reject" };
}

export interface PermissionOption {
	optionId: string;
	name: string;
	kind: string;
}

export interface PermissionRequest {
	/** The JSON-RPC id the answer must carry (usually a string UUID from the agent). */
	requestId: number | string;
	toolCallId?: string;
	/** What the agent wants to run, as shown to the delegating agent. */
	command: string;
	options: PermissionOption[];
	requestedAt: number;
}

/** The parts of a `session/request_permission` payload this module reads; every field may be missing. */
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

/**
 * The command the agent wants to run, out of whichever field it used.
 *
 * Devin puts it in `_meta["cognition.ai/editableCommand"]`; an agent without that extension puts a
 * sentence in `title`. Any `_meta` key ending in `editableCommand` is accepted so a vendor-prefixed
 * spelling from another agent (`acme/editableCommand`) works without a code change.
 */
function editableCommandOf(meta: Record<string, unknown> | undefined): string | undefined {
	if (!meta) {
		return undefined;
	}
	const direct = meta["cognition.ai/editableCommand"];
	if (typeof direct === "string") {
		return direct;
	}
	for (const [key, value] of Object.entries(meta)) {
		if (key.endsWith("editableCommand") && typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

/** Read a `session/request_permission` payload; tolerant of missing fields so a request is never dropped. */
export function parsePermissionRequest(requestId: number | string, rawParams: unknown, now = Date.now()): PermissionRequest {
	const params = (rawParams ?? {}) as RawPermissionParams;
	const toolCall = params.toolCall ?? {};
	const command =
		editableCommandOf(toolCall._meta) ??
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
 * The command as data for the agent. It comes from a delegated session, which reads untrusted
 * repository content, and lands in a message asking the agent to approve it, so it is JSON-quoted
 * (newlines, quotes and control characters escaped: it cannot break out into the surrounding prose)
 * and capped.
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
 * The option that carries out `decision`, or undefined when the agent offered none (the answer is then
 * "cancelled", which an agent treats as a rejection).
 *
 * It never picks an option that widens permissions beyond this approval: `allow_always`, a
 * project/global "always allow", or "switch to bypass" are all skipped, for every agent. A driver may
 * override it (Claude has no session-scoped tier, so `allow_session` degrades to one approval) but the
 * override must not reach for a widening option either.
 */
export function pickPermissionOption(options: PermissionOption[], decision: PermissionDecision): string | undefined {
	const byId = (id: string) => options.find((o) => o.optionId === id)?.optionId;
	const byKind = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
	if (decision === "reject") {
		return byId("reject_once") ?? byKind("reject_once") ?? byKind("reject_always");
	}
	if (decision === "allow_session") {
		return byId("allow_session") ?? byId("allow_once") ?? byKind("allow_once");
	}
	return byId("allow_once") ?? byKind("allow_once");
}

/** The ACP result for a `session/request_permission` request. */
export function permissionOutcome(optionId: string | undefined): {
	outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
} {
	return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
}

/** Advertised option values: `{value,name}` objects, or bare strings on older builds. */
export function optionValues(options: unknown): string[] {
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
