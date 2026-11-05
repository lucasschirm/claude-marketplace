// Where agy-acp's own session store lives, and when two paths are the same workspace (issue #56).
//
// The location follows the XDG base-directory spec rather than inventing a knob of its own:
// `$XDG_STATE_HOME/agy-acp/`, falling back to `$HOME/.local/state/agy-acp/` when `XDG_STATE_HOME` is
// unset - which is what "state" means here: a transcript of what happened, kept between runs, not
// configuration and not a cache anything can be thrown away from. `AGY_ACP_STATE_DIR` overrides the
// whole thing for an operator who cannot write to their home directory (CI, a read-only container, a
// tmpfs for a delegate run), and a *relative* override is refused rather than honoured: the server's
// cwd is the client's workspace territory, and a store created by a relative path would land in
// whichever directory a client happened to open.
//
// The workspace comparison is the second half of `session/load`'s validation. A recorded session
// belongs to the directory it was created in, and a client asking to load it somewhere else is either
// a mistake or a different project that happens to know a conversation id; either way the answer is
// `-32602`, never "we'll just use the other directory". Symlinks are resolved for the comparison
// because `/tmp` and `/private/tmp` are the same workspace on macOS and a load that failed over the
// spelling would be a load that fails for no reason a user can act on.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The directory name agy-acp owns inside the state root. */
export const STORE_DIR_NAME = "agy-acp";
/** The directory inside the store that holds one subdirectory per conversation. */
export const SESSIONS_DIR_NAME = "sessions";

export interface StoreRoot {
	root: string;
	/** Human-readable provenance, for the log and for an error that has to be actionable. */
	source: string;
}

function absolute(value: string | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed !== "" && path.isAbsolute(trimmed) ? trimmed : null;
}

/**
 * The store root: `AGY_ACP_STATE_DIR`, then `$XDG_STATE_HOME/agy-acp`, then
 * `$HOME/.local/state/agy-acp`, then `<tmp>/agy-acp` (a process with no home still needs somewhere,
 * and saying which one it chose beats refusing to start).
 */
export function resolveStoreRoot(env: NodeJS.ProcessEnv = process.env): StoreRoot {
	const override = env.AGY_ACP_STATE_DIR;
	if (override !== undefined && override.trim() !== "") {
		const abs = absolute(override);
		if (abs === null) {
			// Set but unusable: fall through to XDG, and say so in the provenance so a log explains
			// why the operator's own setting did nothing.
			const fallback = xdgRoot(env);
			return { ...fallback, source: `${fallback.source} (AGY_ACP_STATE_DIR="${override}" was ignored: not an absolute path)` };
		}
		return { root: abs, source: "AGY_ACP_STATE_DIR" };
	}
	return xdgRoot(env);
}

function xdgRoot(env: NodeJS.ProcessEnv): StoreRoot {
	const xdg = absolute(env.XDG_STATE_HOME);
	if (xdg !== null) return { root: path.join(xdg, STORE_DIR_NAME), source: "$XDG_STATE_HOME/agy-acp" };
	const home = absolute(env.HOME) ?? absolute(os.homedir());
	if (home !== null) {
		return { root: path.join(home, ".local", "state", STORE_DIR_NAME), source: "$HOME/.local/state/agy-acp" };
	}
	return { root: path.join(os.tmpdir(), STORE_DIR_NAME), source: "os.tmpdir()/agy-acp (no XDG_STATE_HOME and no home directory)" };
}

/** `<root>/sessions`: the directory holding one subdirectory per conversation. */
export const sessionsDir = (root: string): string => path.join(root, SESSIONS_DIR_NAME);

/** A recorded or requested workspace, in the spelling two of them can be compared in. */
function normalizeCwd(cwd: string): string {
	return path.resolve(cwd);
}

/** The real directory behind a path, or null when it cannot be resolved (gone, unreadable parent). */
/** `realpath` where the path exists, null where it does not. Memoised on success only: a `session/list`
 * compares up to `MAX_LIST_SCAN` records against one request cwd and both sides repeat, while a directory
 * that appears later has to resolve when it exists rather than stay the null seen before it did. */
const realPaths = new Map<string, string>();

function realPath(cwd: string): string | null {
	const seen = realPaths.get(cwd);
	if (seen !== undefined) return seen;
	try {
		const resolved = fs.realpathSync(cwd);
		realPaths.set(cwd, resolved);
		return resolved;
	} catch {
		return null;
	}
}

/**
 * Do these two workspace paths name the same directory? Equal after `resolve`, or equal after
 * `realpath` when both sides exist. A path that no longer exists can only match by spelling, which is
 * the conservative answer: it cannot turn a mismatch into a match.
 */
export function sameWorkspace(a: string, b: string): boolean {
	const ra = normalizeCwd(a);
	const rb = normalizeCwd(b);
	if (ra === rb) return true;
	const ea = realPath(ra);
	const eb = realPath(rb);
	return ea !== null && eb !== null && ea === eb;
}
