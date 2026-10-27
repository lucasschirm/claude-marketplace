// The verdict that gates deleting a worktree.
//
// Run: node --test test/test-worktree-safety.ts
//
// `checkWorktreeSafety` decides whether a Devin worktree gets removed, and until now nothing tested it:
// its doc comment says "fails closed on any ambiguity or execution failure" while the GitHub lookup did
// `catch {}`, so a gh that could not answer looked exactly like "this branch has no PR" and the verdict
// fell through to `safe: true`. Destructive decisions need their failure mode pinned, especially the one
// that is only visible when the external command misbehaves.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { checkWorktreeSafety } from "../extensions/lib/orca-client.ts";
import { cleanupTmpDirs, tmpDir, tmpGitRepo } from "./helpers/git-repo.ts";

const ORIG_PATH = process.env.PATH ?? "";

beforeEach(() => {
	process.env.PATH = ORIG_PATH;
});
afterEach(() => {
	process.env.PATH = ORIG_PATH;
	cleanupTmpDirs();
});

function fakeGh(stdout: string, code = 0, stderr = ""): void {
	const bin = tmpDir("safety-gh-");
	fs.writeFileSync(
		path.join(bin, "gh"),
		[
			"#!/bin/sh",
			`printf '%s' ${JSON.stringify(stdout)}`,
			...(stderr ? [`printf '%s' ${JSON.stringify(stderr)} >&2`] : []),
			`exit ${code}`,
		].join("\n"),
		{ mode: 0o755 },
	);
	process.env.PATH = `${bin}:${ORIG_PATH}`;
}

/** A committed, clean repository - the shape a finished worktree has. */
function cleanRepo(): string {
	const repo = tmpGitRepo("safety-repo-");
	fs.writeFileSync(path.join(repo, "a.txt"), "x\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], { cwd: repo });
	return repo;
}

test("a path that is not there is safe to delete, and says so", async () => {
	const missing = path.join(tmpDir("safety-missing-"), "never-created");
	const res = await checkWorktreeSafety(missing);
	assert.equal(res.safe, true);
	assert.match(res.reason, /does not exist/i);
});

test("uncommitted changes are never safe, whatever GitHub says", async () => {
	const repo = cleanRepo();
	fs.writeFileSync(path.join(repo, "dirty.txt"), "wip\n");
	fakeGh(JSON.stringify({ number: 1, state: "MERGED" }));

	const res = await checkWorktreeSafety(repo, "some-branch");
	assert.equal(res.safe, false);
	assert.equal(res.uncommitted, true);
});

test("a merged PR is safe; an open one is not", async () => {
	const repo = cleanRepo();

	fakeGh(JSON.stringify({ number: 7, state: "MERGED" }));
	const merged = await checkWorktreeSafety(repo, "some-branch");
	assert.equal(merged.safe, true);
	assert.equal(merged.prNumber, 7);
	assert.equal(merged.prState, "MERGED");

	fakeGh(JSON.stringify({ number: 7, state: "OPEN" }));
	const open = await checkWorktreeSafety(repo, "some-branch");
	assert.equal(open.safe, false);
	assert.equal(open.prState, "OPEN");
});

test("a gh that cannot answer is NOT 'no PR': the verdict fails closed", async () => {
	const repo = cleanRepo();

	// The regression this file exists for. Before, `catch {}` swallowed this and the function fell
	// through to the unpushed checks and out to `safe: true` - a worktree deleted because gh was down.
	fakeGh("", 1, "HTTP 502: bad gateway");
	const broken = await checkWorktreeSafety(repo, "some-branch");
	assert.equal(broken.safe, false);
	assert.match(broken.reason, /could not check the pr/i);

	// Same for a reply that is not the promised shape: ambiguity is not evidence of safety.
	fakeGh("<html>proxy error</html>");
	const notJson = await checkWorktreeSafety(repo, "some-branch");
	assert.equal(notJson.safe, false);
	assert.match(notJson.reason, /could not check the pr/i);

	// And a missing gh entirely: "I could not look" must not become "there is nothing to look at". The
	// bin holds a `git` symlink so this tests a missing gh, not a missing PATH - otherwise the git
	// status step fails first and the assertion below would pass for the wrong reason.
	const ghless = tmpDir("safety-no-gh-bin-");
	fs.symlinkSync(execFileSync("which", ["git"]).toString().trim(), path.join(ghless, "git"));
	process.env.PATH = ghless;
	const noGh = await checkWorktreeSafety(repo, "some-branch");
	assert.equal(noGh.safe, false);
	assert.match(noGh.reason, /could not check the pr/i);
});

test("a branch with genuinely no PR still answers on its git evidence", async () => {
	const repo = cleanRepo();
	fakeGh("", 1, "no pull requests found for branch some-branch");

	// No PR is an answer, not an outage: the decision is then made from git (clean, nothing ahead of
	// any base), which is what it always was.
	const res = await checkWorktreeSafety(repo, "some-branch");
	assert.equal(res.safe, true, "clean tree, no PR, nothing unpushed: safe on evidence, not on silence");
	assert.doesNotMatch(res.reason, /could not check the pr/i);
});

test("commits that exist only on this branch are never safe", async () => {
	const repo = cleanRepo();
	// Branch off the committed base, then add a commit that exists nowhere else. The candidate-base
	// comparison (origin/main, origin/master, main, master) is the last line of defence, and on a repo
	// with no remote at all it is the only one - so it has to be the thing that stops the deletion.
	const base = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).toString().trim();
	execFileSync("git", ["checkout", "-q", "-b", "work"], { cwd: repo });
	fs.writeFileSync(path.join(repo, "b.txt"), "y\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "only-here"], { cwd: repo });
	fakeGh("", 1, "no pull requests found");

	const res = await checkWorktreeSafety(repo, "work");
	assert.equal(res.safe, false, "work that exists only here must not be deletable on a gh lookup that said nothing");
	assert.match(res.reason, new RegExp(`ahead of ${base}|unpushed`, "i"));
	assert.equal(res.unpushed, true);
});

/**
 * A `git` on PATH whose behaviour is scripted, so a hang and a "that comparison is unavailable" error
 * can be produced on purpose. Prepends to the *current* PATH: these tests script `git` and `gh`
 * together, and resetting to the original PATH would silently restore the real gh.
 */
function fakeGit(script: string): void {
	const bin = tmpDir("safety-git-");
	fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

test("a comparison that times out fails closed; it is not read as 'nothing ahead'", async () => {
	const repo = cleanRepo();
	fakeGh("", 1, "no pull requests found");
	// status answers "clean", then the upstream comparison hangs.
	fakeGit(['if [ "$1" = "status" ]; then exit 0; fi', 'if [ "$1" = "log" ]; then sleep 5; exit 0; fi', "exit 1"].join("\n"));

	const res = await checkWorktreeSafety(repo, "work", undefined, { timeoutMs: 250 });
	assert.equal(res.safe, false);
	// The old code read a failed comparison as empty output, i.e. "nothing ahead", and fell through to a
	// safe verdict: a check that never completed manufactured evidence of absence.
	assert.match(res.reason, /could not compare against upstream/i);
});

test("git's 'no upstream' is a missing comparison, and the last resort still fails closed", async () => {
	const repo = cleanRepo();
	fakeGh("", 1, "no pull requests found");
	// Clean tree; every comparison answers "that revision does not exist here", including the bases.
	fakeGit(
		[
			'if [ "$1" = "status" ]; then exit 0; fi',
			'if [ "$1" = "log" ]; then echo "fatal: no upstream configured for branch" >&2; exit 128; fi',
			'if [ "$1" = "rev-parse" ]; then exit 1; fi',
			"exit 1",
		].join("\n"),
	);

	const res = await checkWorktreeSafety(repo, "work");
	// Not the same as a timeout: these are "unavailable", so the search runs to the end and the verdict
	// is the documented last-resort refusal rather than a comparison-specific one.
	assert.equal(res.safe, false);
	assert.match(res.reason, /could not verify .*unpushed/i);
});
