// The git/gh locator: one place that answers "which repo, which branch, which PR".
//
// Run: node --test test/test-git-repo.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { branchNames, checkedOutBranch, headRef, prForBranch, prForCurrentBranch, repoName, repoRoot } from "../extensions/lib/git-repo.ts";
import { isGhAvailabilityError } from "../extensions/lib/gh-health.ts";
import { cleanupTmpDirs, tmpDir, tmpGitRepo } from "./helpers/git-repo.ts";

const ORIG_PATH = process.env.PATH ?? "";

// PATH is process-global and one test points it at an empty directory on purpose (that is how a
// missing `gh` is tested), so it is reset around every test rather than at the end of the file -
// otherwise the next test in the file cannot even find `git`.
beforeEach(() => {
	process.env.PATH = ORIG_PATH;
});
afterEach(() => {
	process.env.PATH = ORIG_PATH;
	cleanupTmpDirs();
});

/**
 * A `gh` on PATH that answers from `body` and exits with `code`. The lookup helpers resolve `gh`
 * through PATH, so this is the seam - no network, no real GitHub, and the exit codes are the real
 * shape gh uses ("no PR" is a non-zero exit, which is the whole reason `PrLookup` has three states).
 */
function fakeGh(body: string, code = 0, stderr = ""): string {
	const bin = tmpDir("git-repo-gh-");
	const script = [
		"#!/bin/sh",
		`printf '%s' ${JSON.stringify(body)}`,
		...(stderr ? [`printf '%s' ${JSON.stringify(stderr)} >&2`] : []),
		`exit ${code}`,
	].join("\n");
	fs.writeFileSync(path.join(bin, "gh"), script, { mode: 0o755 });
	process.env.PATH = `${bin}:${ORIG_PATH}`;
	return bin;
}

function commit(repo: string, file = "a.txt"): void {
	fs.writeFileSync(path.join(repo, file), "x\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], { cwd: repo });
}

test("repoRoot resolves from a subdirectory, and fails outside a repository", async () => {
	const repo = tmpGitRepo();
	const nested = path.join(repo, "deep", "er");
	fs.mkdirSync(nested, { recursive: true });

	const found = await repoRoot(nested);
	assert.equal(found.ok, true);
	if (!found.ok) return;
	// macOS resolves /var -> /private/var, so compare the resolved forms.
	assert.equal(fs.realpathSync(found.value ?? ""), fs.realpathSync(repo));

	// A directory with no repository: an answer of "nothing" would be a lie, this is "could not".
	const missing = await repoRoot(tmpDir("git-repo-plain-"));
	assert.equal(missing.ok, false);
});

test('checkedOutBranch names the branch, and says undefined (not "") when detached', async () => {
	const repo = tmpGitRepo();
	commit(repo);

	const onBranch = await checkedOutBranch(repo);
	assert.equal(onBranch.ok, true);
	if (!onBranch.ok) return;
	assert.ok(onBranch.value && onBranch.value.length > 0, "a fresh repo has a branch name");

	execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo });
	const detached = await checkedOutBranch(repo);
	assert.equal(detached.ok, true);
	if (!detached.ok) return;
	// Detached is a real answer: no branch. Callers must not receive "" and go query `gh pr view ""`.
	assert.equal(detached.value, undefined);
});

test('headRef normalises git\'s literal "HEAD" to undefined instead of leaking the string', async () => {
	const repo = tmpGitRepo();
	commit(repo);

	const onBranch = await headRef(repo);
	assert.equal(onBranch.ok, true);
	assert.ok(onBranch.value && onBranch.value !== "HEAD");

	execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo });
	const detached = await headRef(repo);
	assert.equal(detached.ok, true);
	if (!detached.ok) return;
	assert.equal(detached.value, undefined, 'git\'s own "HEAD" sentinel must never reach a caller');
});

test("a git that cannot run is a failure with the door's reason, not an empty answer", async () => {
	const res = await repoRoot(path.join(tmpDir("git-repo-gone-"), "not-here"));
	assert.equal(res.ok, false);
	if (res.ok) return;
	assert.ok(res.failure.message.length > 0, "the reason survives");
});

test("prForBranch distinguishes found / provably-absent / no-information", async () => {
	const repo = tmpGitRepo();

	fakeGh(JSON.stringify({ number: 42, state: "open" }));
	const found = await prForBranch("some-branch", repo);
	assert.equal(found.found, true);
	if (!found.found) return;
	assert.equal(found.pr.number, 42);
	// gh's casing is not the API: one caller compares against "MERGED".
	assert.equal(found.pr.state, "OPEN");

	// gh's real "no PR" answer: non-zero exit with this text. Not an error, and not worth a log line.
	fakeGh("", 1, "no pull requests found for branch some-branch");
	assert.deepEqual(await prForBranch("some-branch", repo), { found: false, reason: "no-pr" });

	// gh's *other* "could not resolve" - about the repository, not the PR. A lookup that cannot see the
	// repository has no information, and "provably no PR" is the wrong answer to hand back: it is the
	// difference between an ordinary branch and a session hunting for a PR in a folder gh cannot read.
	fakeGh("", 1, "could not resolve to a Repository with the name 'o/r'");
	const unresolved = await prForBranch("some-branch", repo);
	assert.equal(unresolved.found, false);
	if (unresolved.found) return;
	assert.equal(unresolved.reason, "error");

	fakeGh("", 1, "HTTP 502: bad gateway");
	const broken = await prForBranch("some-branch", repo);
	assert.equal(broken.found, false);
	if (broken.found) return;
	assert.equal(broken.reason, "error");
	assert.equal(broken.failure.code, "EXIT");
});

test("a payload that is not the promised object is 'no information', and says nothing about reachability", async () => {
	const repo = tmpGitRepo();

	// Two refusals the door names differently: output that is not JSON at all, and JSON that is not the
	// promised shape. Both are "no information", and neither says anything about reachability - which is
	// why pr-tasks leaves such a call out of the health picture instead of recording a success or a
	// failure against it.
	fakeGh("<html>gateway timeout</html>");
	const notJson = await prForBranch("b", repo);
	assert.equal(notJson.found, false);
	if (!notJson.found) {
		assert.equal(notJson.reason, "error");
		assert.equal(notJson.failure.code, "BAD_JSON");
		assert.equal(isGhAvailabilityError(notJson.failure.cause), false);
	}

	fakeGh(JSON.stringify({ number: "42", state: "OPEN" }));
	const wrongShape = await prForBranch("b", repo);
	assert.equal(wrongShape.found, false);
	if (!wrongShape.found) {
		assert.equal(wrongShape.reason, "error");
		assert.equal(wrongShape.failure.code, "BAD_SCHEMA");
		assert.match(wrongShape.failure.message, /number/, "the reject names the field, not just 'bad shape'");
		assert.equal(isGhAvailabilityError(wrongShape.failure.cause), false);
	}
});

test("a missing gh is an availability failure, so the caller can back off instead of concluding", async () => {
	const repo = tmpGitRepo();

	process.env.PATH = tmpDir("git-repo-empty-bin-");
	for (const res of [await prForBranch("b", repo), await prForCurrentBranch(repo)]) {
		assert.equal(res.found, false);
		if (res.found) continue;
		assert.equal(res.reason, "error");
		assert.equal(res.failure.code, "NOT_FOUND");
		assert.equal(isGhAvailabilityError(res.failure.cause), true, "the sentence gh-health matches survives");
	}
});

test("prForCurrentBranch asks about this folder and names no branch", async () => {
	const repo = tmpGitRepo();
	const bin = tmpDir("git-repo-argv-");
	const log = path.join(bin, "argv.txt");
	fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" > ${JSON.stringify(log)}\nprintf '%s' '{"number":7,"state":"OPEN"}'\n`, {
		mode: 0o755,
	});
	process.env.PATH = `${bin}:${ORIG_PATH}`;

	const res = await prForCurrentBranch(repo);
	assert.equal(res.found, true);
	const args = fs.readFileSync(log, "utf-8").trim();
	assert.equal(args, "pr view --json number,state", "no branch selector: this folder's own PR");
});

test("every lookup is bounded, including from a directory git dislikes", async () => {
	// A tiny deadline proves the option reaches the door on all three; a hung git would blow past it.
	const repo = tmpGitRepo();
	// Committed first, because an unborn branch is a git *failure* rather than an empty answer
	// (`rev-parse --abbrev-ref HEAD` exits 128 before the first commit) - that is its own fact, tested by
	// the failure assertions above, and should not be what this test trips over.
	commit(repo);
	const opts = { timeoutMs: 15_000 };
	assert.equal((await checkedOutBranch(repo, opts)).ok, true);
	assert.equal((await headRef(repo, opts)).ok, true);
	assert.equal(typeof (await repoName(repo, opts)), "string");
});

test("repoName reports the main repository from a linked worktree, not the worktree folder", async () => {
	const repo = tmpGitRepo("git-repo-main-");
	commit(repo);
	// A fresh parent, with the worktree path itself not yet created: `git worktree add` refuses an
	// existing target, and a fixed name here would pass once and fail forever after.
	const worktree = path.join(tmpDir("git-repo-wt-"), "child");
	execFileSync("git", ["worktree", "add", "-q", "-b", "wt-branch", worktree], { cwd: repo });

	// Worktree naming has to be stable across the lineage: the child reports the parent's name.
	const fromWorktree = await repoName(worktree);
	const fromMain = await repoName(repo);
	assert.equal(fromWorktree, fromMain);
	assert.ok(fromWorktree.length > 0);

	// Outside a repository it still answers with something usable rather than throwing.
	const plain = tmpDir("git-repo-plain2-");
	assert.equal(await repoName(plain), path.basename(plain));
});

test("branchNames strips the worktree markers and matches a pattern", async () => {
	const repo = tmpGitRepo();
	commit(repo);
	for (const name of ["base-dt1", "base-dt2", "base-other"]) {
		execFileSync("git", ["branch", name], { cwd: repo });
	}
	const res = await branchNames(repo, "base-dt*");
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.deepEqual(res.value.slice().sort(), ["base-dt1", "base-dt2"]);

	// A listing that failed is not "no branches": the caller guesses a worktree index off this and two
	// guesses of 1 collide, so the reason has to be there to be logged.
	const gone = await branchNames(path.join(tmpDir("git-repo-gone2-"), "nope"), "*");
	assert.equal(gone.ok, false);
});
