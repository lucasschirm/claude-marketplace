import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/**
 * Structured payload every tool result must carry (`AgentToolResult.details` is required by
 * pi-agent-core). Keep it JSON-serialisable: results are persisted into the session JSON, so convert
 * `Set`/`Map` to arrays instead of storing them, and keep secrets, tokens and raw command output out.
 */
export type ToolDetails = Record<string, unknown>;

/** Cap for id lists in `details`, so a large task/worker set cannot bloat the session file. */
export const DETAILS_LIST_CAP = 50;

/**
 * Adds a capped id list to a `details` object under a name the caller chooses (`taskIds`,
 * `dispatchIds`, ...), plus `<key>Truncated`, so a reader can tell a cap from an empty set and never
 * has to guess what a generic `items` array referred to.
 */
export function capList(key: string, ids: string[]): Record<string, unknown> {
	return { [key]: ids.slice(0, DETAILS_LIST_CAP), [`${key}Truncated`]: ids.length > DETAILS_LIST_CAP };
}

/**
 * A successful result. `details` is not sent to the model - `text` is - so put the state a follow-up
 * turn would otherwise re-query (ids, counts, paths) in `details`, and keep stable keys.
 *
 * The generic parameter is what makes the call sites type-checked: the bare `AgentToolResult`
 * defaults `details` to `JsonValue | undefined`, which would accept `details: undefined` again.
 */
export function ok<T extends ToolDetails>(text: string, details: T): AgentToolResult<T> {
	return { content: [{ type: "text", text }], details };
}

/**
 * The variable *names* in `.env`-style output, never their values: names are safe to put in `details`
 * (and to show in a UI) while a password in the same output is not.
 */
export function parseEnvKeys(output: string): string[] {
	return output
		.split("\n")
		.map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
		.filter((key): key is string => Boolean(key));
}

/**
 * A reported failure: the model sees an error result, while `details` still reaches the UI and
 * programmatic callers. `code` is the machine-readable half of the contract (`"GH_FAILED"`,
 * `"NOT_FOUND"`, `"BAD_JSON"`, `"PATH_ESCAPE"`, ...) so callers do not parse prose.
 */
export function err<T extends ToolDetails>(text: string, code: string, details?: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text }],
		isError: true,
		details: { code, ...details } as T & { code: string },
	};
}
