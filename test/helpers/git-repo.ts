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
const created: string[] = [];

/** A throwaway directory in tmpdir, registered for cleanupTmpDirs(). */
export function tmpDir(prefix = "pr-task-dir-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	created.push(dir);
	return dir;
}

/**
 * The variables git exports to its hooks that say WHERE a later `git` command operates. In a linked
 * worktree a hook is given `GIT_DIR=<repo>/.git/worktrees/<name>` (absolute), and `git commit` adds
 * `GIT_INDEX_FILE`; both override `git -C <dir>`. A suite that builds throwaway repositories and
 * commits in them would then be committing into the repository whose hook invoked it - which is not
 * hypothetical: it re-pointed this repo's branch once, from `.githooks/pre-push`.
 */
const GIT_REDIRECTING_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_QUARANTINE_PATH",
	"GIT_REFLOG_ACTION",
];

/** `process.env` with those removed: what every git call in a test should run under. */
export function gitSandboxEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
	for (const name of GIT_REDIRECTING_VARS) {
		if (!(name in extra)) {
			delete env[name];
		}
	}
	return env;
}

export function tmpGitRepo(prefix = "pr-task-repo-"): string {
	const dir = tmpDir(prefix);
	cp.execFileSync("git", ["init", "-q", dir], { env: gitSandboxEnv() });
	return dir;
}

/** Remove everything this module created; call from node:test's after() hook. */
export function cleanupTmpDirs(): void {
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}
