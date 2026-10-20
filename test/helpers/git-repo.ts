// Shared helpers for the suites that touch the filesystem.
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * A throwaway git repository in tmpdir (never inside the repo, so suites stay parallel-safe).
 * `applyCodeSuggestion` resolves every path through `git rev-parse --show-toplevel`, so anything
 * exercising it needs a real repository to resolve against.
 */
export function tmpGitRepo(prefix = "pr-task-repo-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	cp.execFileSync("git", ["init", "-q", dir]);
	return dir;
}
