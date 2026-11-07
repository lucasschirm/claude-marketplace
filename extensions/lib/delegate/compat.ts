// The rename compatibility layer: how the `devin_*` tool names keep working for one minor version.
//
// The tool family changed shape (`devin_delegate` → `delegate_task`), and a rename that only half works
// is worse than a slow one: prompts, skills and notes written against the old name are already in the
// wild, and an agent mid-task cannot be told to re-learn its tools. So every old name stays live for a
// release, and every call through it says so — the note is what makes the eventual removal a decision
// rather than a silent break. `docs/delegate-task-drivers-plan.md` §9 is the policy; this file is the
// mechanism, so the policy has one home and one test file.
//
// Two rules the aliases must not break:
//
// * **An old name means Devin.** `devin_delegate` forces `agent: "devin"`. A caller that used the old
//   name meant Devin; letting the parameter through unchanged would let a rename change what an existing
//   prompt does when a second driver exists.
// * **The note is additive.** The wrapped tool returns the new tool's result with one extra text item,
//   so a caller that parses content[0] today parses the same thing tomorrow.

import type { ToolSpec } from "./tools.ts";

/** Old name → new name. Every entry must name a tool this extension actually registers. */
export const DEPRECATED_ALIASES: Readonly<Record<string, string>> = {
	devin_delegate: "delegate_task",
	devin_status: "delegate_status",
	devin_message: "delegate_message",
	devin_permission: "delegate_permission",
	devin_cancel: "delegate_cancel",
	devin_restart: "delegate_restart",
	devin_clean_worktree: "delegate_clean_worktree",
};

/** The command retired alongside the tools. */
export const DEPRECATED_COMMANDS: Readonly<Record<string, string>> = { "/devin": "/delegate" };

/** The deprecation horizon, stated once here so no message can promise a different one. */
export const ALIAS_NOTE =
	`This tool is renamed: use delegate_task / delegate_status / delegate_message / delegate_permission / ` +
	`delegate_cancel / delegate_restart / delegate_clean_worktree. The devin_* names are kept for one minor ` +
	`version and always mean agent="devin".`;

/** The line an alias prepends to its target's result. */
export function renameNote(alias: string, target: string): string {
	return `[deprecated] ${alias} → ${target}. ${ALIAS_NOTE}`;
}

/**
 * The aliased tool specs, derived from the real ones.
 *
 * An alias whose target does not exist is skipped rather than registered: a `devin_status` that resolves
 * to nothing would answer "unknown tool" to a caller whose only sin is using the name it learned.
 */
export function aliasSpecs(specs: readonly ToolSpec[]): ToolSpec[] {
	const byName = new Map(specs.map((s) => [s.name, s]));
	const out: ToolSpec[] = [];
	for (const [alias, target] of Object.entries(DEPRECATED_ALIASES)) {
		const spec = byName.get(target);
		if (!spec) {
			continue;
		}
		out.push(wrapAlias(alias, target, spec));
	}
	return out;
}

/** One spec behind its retired name: same parameters, forced Devin, rename note on the way out. */
function wrapAlias(alias: string, target: string, spec: ToolSpec): ToolSpec {
	const note = renameNote(alias, target);
	return {
		...spec,
		name: alias,
		label: `Devin ${alias.slice("devin_".length)}`,
		description: `${ALIAS_NOTE} Calls ${target}.`,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await spec.execute(toolCallId, { ...(params ?? {}), agent: "devin" }, signal, onUpdate, ctx);
			return withNote(result, note);
		},
	};
}

/**
 * Append the note as its own content item.
 *
 * Appended, not prepended: a caller written against the old name reads `content[0]` for the answer —
 * the queue suite itself does — and a deprecation notice that displaces the payload would break exactly
 * the callers it exists to ease. Every text item is read by a model, so nothing is lost by putting it
 * last. A result with no content array is returned unmodified rather than reshaped.
 */
export function withNote(result: unknown, note: string): unknown {
	if (!result || typeof result !== "object") {
		return result;
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return result;
	}
	return { ...result, content: [...content, { type: "text", text: note }] };
}
