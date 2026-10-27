// The per-mode permission policy for the PreToolUse bridge, applied in agy-acp before the client
// is asked. agy runs with --dangerously-skip-permissions, so this is the only gate: a call that
// is neither auto-allowed nor client-approved must be denied here.
//
// Modes (the session/new mode ids, advertised once this sub-issue lands):
//   default      - auto-allow read_file inside the workspace roots; ask for everything else
//   accept-edits - default plus auto-allow write_file / edit_file inside the workspace roots
//   plan         - deny anything that changes state ("plan mode is read-only"); reads as default
//   bypass       - allow everything and log it (unknown tools included)
//
// In every mode - bypass included - a tool call whose args reference the bridge dir or its
// socket is denied: the agent can see the bridge dir in the hook's workspacePaths and must not
// be able to read it. Unknown tools (off the recorded 1.4.2 surface) are never auto-allowed;
// they go to the client, except in bypass, which allows everything by definition.

import * as fs from "node:fs";
import * as path from "node:path";

export interface AcpModeInfo {
	id: string;
	name: string;
	description: string;
}

/** The permission-capable modes the server advertises (session/new, session/set_mode). */
export const AGY_ACP_MODES: AcpModeInfo[] = [
	{
		id: "default",
		name: "Default",
		description: "read_file inside the workspace is auto-allowed; commands, writes, outside reads and unknown tools ask the client",
	},
	{
		id: "accept-edits",
		name: "Accept edits",
		description: "default plus write_file / edit_file inside the workspace are auto-allowed",
	},
	{ id: "plan", name: "Plan", description: "state-changing tools are denied; reads follow the default policy" },
	{ id: "bypass", name: "Bypass", description: "everything is allowed and logged; bridge references are still denied" },
];
export const AGY_ACP_MODE_IDS: readonly string[] = AGY_ACP_MODES.map((m) => m.id);

/**
 * The tool surface recorded against agy 1.4.2 (the union of every `init.tools` list in the
 * stream fixtures and every tool name in the recorded hook payloads). Anything off this list
 * is an unknown tool: it is never auto-allowed, it is asked (or allowed in bypass). A
 * whitespace-separated string (not an array literal): the formatter cannot reflow it, and the
 * set is the same either way.
 */
export const KNOWN_TOOLS: ReadonlySet<string> = new Set(
	(
		"ask_custom_permission ask_permission ask_question browser_click_element browser_drag_pixel_to_pixel " +
		"browser_get_dom browser_get_network_request browser_input browser_list_network_requests " +
		"browser_mouse_down browser_mouse_up browser_move_mouse browser_press_key browser_refresh_page " +
		"browser_resize_window browser_scroll browser_scroll_dom browser_select_option browser_subagent " +
		"call_mcp_tool capture_browser_console_logs capture_browser_screenshot click_browser_pixel " +
		"command_status define_subagent delete_knowledge edit_file execute_browser_javascript " +
		"find_by_name finish generate_image grep_search invoke_subagent list_browser_pages " +
		"list_dir list_permissions list_plugin_accounts list_resources manage_inbox " +
		"manage_subagents manage_task multi_replace_file_content notebook_edit notebook_execution " +
		"open_browser_url read_browser_page read_file read_resource read_url_content " +
		"replace_file_content run_command run_workflow schedule search_marketplace search_web " +
		"sed_file send_command_input send_message view_file wait wait_5_seconds write_file write_to_file"
	)
		.trim()
		.split(/\s+/),
);

/**
 * The tools plan mode denies. Browser mutation tools count: they change the page. The interactive
 * non-mutants (ask_*, wait, finish, send_message) fall through to the ask policy.
 */
const STATE_CHANGING_TOOLS: ReadonlySet<string> = new Set(
	(
		"run_command run_workflow send_command_input notebook_execution notebook_edit " +
		"write_file write_to_file edit_file replace_file_content multi_replace_file_content " +
		"sed_file invoke_subagent define_subagent manage_subagents manage_task manage_inbox " +
		"delete_knowledge schedule generate_image call_mcp_tool open_browser_url browser_subagent " +
		"browser_click_element browser_drag_pixel_to_pixel browser_input browser_mouse_down " +
		"browser_mouse_up browser_move_mouse browser_press_key browser_refresh_page browser_resize_window " +
		"browser_scroll browser_scroll_dom browser_select_option capture_browser_console_logs " +
		"capture_browser_screenshot click_browser_pixel execute_browser_javascript"
	)
		.trim()
		.split(/\s+/),
);

export interface PolicyInput {
	mode: string;
	toolName: string;
	args: Record<string, unknown>;
	/** The session cwd, resolved (realpath) - the workspace root. */
	workspaceRoots: string[];
	/** Relative candidate paths are resolved against this. */
	baseDir: string;
	bridgeDir: string;
	socketPath: string;
}

export type PolicyDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: "ask" };

export const PLAN_DENY_REASON = "plan mode is read-only";

/** The `Path` parameter (file tools), or undefined when the args carry no usable path. */
function pathParam(args: Record<string, unknown>): string | undefined {
	const p = args.Path;
	return typeof p === "string" && p !== "" ? p : undefined;
}

/** A string anywhere in the args that references the bridge dir or socket. */
function bridgeReferenceIn(args: unknown, bridgeDir: string, socketPath: string, found: string[]): void {
	if (typeof args === "string") {
		if ((bridgeDir !== "" && args.includes(bridgeDir)) || (socketPath !== "" && args.includes(socketPath))) {
			found.push(args.length > 80 ? `${args.slice(0, 80)}…` : args);
		}
		return;
	}
	if (Array.isArray(args)) {
		for (const v of args) bridgeReferenceIn(v, bridgeDir, socketPath, found);
		return;
	}
	if (typeof args === "object" && args !== null) {
		for (const v of Object.values(args)) bridgeReferenceIn(v, bridgeDir, socketPath, found);
	}
}

export function bridgeReferenceReason(args: Record<string, unknown>, bridgeDir: string, socketPath: string): string | undefined {
	const found: string[] = [];
	bridgeReferenceIn(args, bridgeDir, socketPath, found);
	if (found.length === 0) return undefined;
	return `denied by agy-acp: the tool call references the permission bridge (${found[0]}). Do not retry this call.`;
}

/**
 * Symlink-safe containment: the candidate is resolved to its deepest existing ancestor (realpath),
 * the non-existing tail is appended as-is, and the result must be inside one of the (already
 * resolved) roots. A symlink that points out of the workspace therefore stays outside.
 */
export function resolveSymlinkSafe(candidate: string, baseDir: string): string {
	const abs = path.isAbsolute(candidate) ? candidate : path.resolve(baseDir, candidate);
	let dir = abs;
	for (;;) {
		try {
			const real = fs.realpathSync(dir);
			const rest = path.relative(dir, abs);
			return rest === "" ? real : path.join(real, rest);
		} catch {
			// this level does not exist; walk up (realpathSync throws on missing paths)
			const parent = path.dirname(dir);
			if (parent === dir) return abs; // nothing exists below the filesystem root
			dir = parent;
		}
	}
}

/** True when the candidate (resolved, symlink-safe) is inside one of the resolved roots. */
export function isPathWithinWorkspace(candidate: string, roots: string[], baseDir: string): boolean {
	const resolved = resolveSymlinkSafe(candidate, baseDir);
	return roots.some((r) => resolved === r || resolved.startsWith(r + path.sep));
}

/** The decision for one tool call, before any client interaction. */
export function decidePolicy(input: PolicyInput): PolicyDecision {
	const bridgeRef = bridgeReferenceReason(input.args, input.bridgeDir, input.socketPath);
	if (bridgeRef !== undefined) return { kind: "deny", reason: bridgeRef };
	const { mode, toolName } = input;
	if (mode === "bypass") return { kind: "allow" }; // logged by the caller
	if (mode === "plan" && KNOWN_TOOLS.has(toolName) && STATE_CHANGING_TOOLS.has(toolName)) {
		return { kind: "deny", reason: PLAN_DENY_REASON };
	}
	// The auto-allow set: reads (default) plus writes (accept-edits), in-workspace only.
	const autoAllowRead = toolName === "read_file";
	const autoAllowWrite = mode === "accept-edits" && (toolName === "write_file" || toolName === "edit_file");
	if (autoAllowRead || autoAllowWrite) {
		const p = pathParam(input.args);
		if (p !== undefined) {
			return isPathWithinWorkspace(p, input.workspaceRoots, input.baseDir) ? { kind: "allow" } : { kind: "ask" };
		}
		return { kind: "ask" }; // a file tool without a Path cannot be verified
	}
	return { kind: "ask" };
}

/** The client options session/request_permission carries; only these exact ids are answers. */
export const PERMISSION_OPTION_IDS = ["allow_once", "allow_always", "reject_once"] as const;
export function permissionOptions(): Array<{ optionId: string; kind: string; name: string }> {
	return [
		{ optionId: "allow_once", kind: "allow_once", name: "Allow once" },
		{ optionId: "allow_always", kind: "allow_always", name: "Always allow" },
		{ optionId: "reject_once", kind: "reject_once", name: "Reject" },
	];
}

export type PermissionOutcome = "allow" | "allow-always" | "deadline" | "reject";

/**
 * The client's answer, treated strictly: only the exact option ids are answers. `cancelled`
 * (the non-object outcome), any unknown id, and anything unparseable all mean deny.
 */
export function parsePermissionOutcome(result: unknown): "allow" | "allow-always" | "reject" {
	if (typeof result !== "object" || result === null) return "reject";
	const outcome = (result as Record<string, unknown>).outcome;
	if (typeof outcome !== "object" || outcome === null) return "reject"; // "cancelled" and friends
	const o = outcome as Record<string, unknown>;
	if (o.outcome !== "selected" || typeof o.optionId !== "string") return "reject";
	if (o.optionId === "allow_once") return "allow";
	if (o.optionId === "allow_always") return "allow-always";
	return "reject";
}

/** The "Do not retry" wording matters: without it the model retried 5 times (spike). */
export function rejectReason(): string {
	return "denied by agy-acp: the user rejected this tool call. Do not retry this call.";
}
export function deadlineReason(seconds: number): string {
	return `denied by agy-acp: the user did not answer this permission request within ${seconds}s. Do not retry this call.`;
}
export function sessionEndedReason(): string {
	return "denied by agy-acp: the session ended before this permission request could be answered. Do not retry this call.";
}

// ---------------------------------------------------------------- allow-always grants

/** A run_command grant covers the first 64 (whitespace-normalised) characters of the command. */
export const COMMAND_PREFIX_CHARS = 64;
export function normalizeCommand(command: string): string {
	const n = command.trim().replace(/\s+/g, " ");
	return n.length > COMMAND_PREFIX_CHARS ? n.slice(0, COMMAND_PREFIX_CHARS) : n;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value as Record<string, unknown>).sort()) {
			out[k] = canonicalize((value as Record<string, unknown>)[k]);
		}
		return out;
	}
	return value;
}

/**
 * Rewritten-args detection: the stream's ACTIVE precedes the hook, and the hook's args are the
 * superset that gets executed (agy adds metadata fields such as toolSummary). The args were
 * rewritten when the hook's args differ on any key the stream reported (compared
 * order-insensitively); extra keys on the hook side are metadata, not a rewrite.
 */
export function argsDifferFrom(streamArgs: Record<string, unknown> | undefined, hookArgs: Record<string, unknown>): boolean {
	const s = streamArgs ?? {};
	const h = canonicalize(hookArgs) as Record<string, unknown>;
	for (const k of Object.keys(s)) {
		if (!Object.hasOwn(h, k) || JSON.stringify(canonicalize(s[k])) !== JSON.stringify(h[k])) {
			return true;
		}
	}
	return false;
}

/**
 * The in-memory grant key: tool + command prefix (run_command) or tool + resolved path (file
 * tools), or just the tool name for everything else. Held per session, never written anywhere.
 */
export function grantKeyOf(toolName: string, args: Record<string, unknown>, baseDir: string): string {
	if (toolName === "run_command") {
		const c = typeof args.CommandLine === "string" ? args.CommandLine : "";
		return `run_command:${normalizeCommand(c)}`;
	}
	const p = pathParam(args);
	if (p !== undefined) return `${toolName}:${resolveSymlinkSafe(p, baseDir)}`;
	return toolName;
}
