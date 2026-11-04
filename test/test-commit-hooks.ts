// Does the commit-time gate actually gate?
//
// Run: node --test test/test-commit-hooks.ts
//
// The hooks are the only part of this repo's quality machinery that runs on a developer's machine
// rather than in CI, which means every property they have is a property of a shell script nobody
// watches. The ones that matter are not "it runs the gate" but the edges: --no-verify skips
// pre-commit while prepare-commit-msg still runs (so a bypassed commit must not come out stamped),
// an amend re-parents the patch (so the patch-id a hook can compute is not the commit's), `git
// commit <path>` and `git commit -a` hand the hook a temporary index, a second worktree has its
// own git dir, a merge commit never runs pre-commit at all, and an empty message must still abort
// the commit rather than be filled in by a trailer.
//
// Each case builds a throwaway repo under tmpdir wired to THIS repo's .githooks, with a stub
// `qa:static` the test can make fail: the suite is about the hooks, not about the gate they run.
//
// The trailer binds a commit twice - `patch=<patch-id> tree=<tree>` - and CI accepts either. These
// cases pin which binding is the one that holds where: both for an ordinary commit, the tree for an
// amend (whose patch-id the hook cannot know), neither for a forgery.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, test } from "node:test";
import { cleanupTmpDirs, tmpDir } from "./helpers/git-repo.ts";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
const HOOKS = ["pre-commit", "commit-msg", "pre-push"];

after(() => cleanupTmpDirs());

interface CommitResult {
	code: number;
	stderr: string;
}

interface Repo {
	dir: string;
	git: (...args: string[]) => string;
	/** `git commit ...`, never throwing: the exit code is the point in half of these cases. */
	commit: (args: string[], env?: Record<string, string>, cwd?: string) => CommitResult;
	/** The `Quality-Gate` trailer value of a revision ("" when there is none). */
	trailer: (rev?: string, cwd?: string) => string;
	/** The patch-id of a revision, computed the way CI will: from the commit itself. */
	patchId: (rev?: string, cwd?: string) => string;
	/** The tree a revision records - the other half of what the trailer claims. */
	tree: (rev?: string, cwd?: string) => string;
	/** How many times the stub gate has run (the marker file it appends to). */
	gateRuns: (cwd?: string) => number;
	write: (rel: string, text: string, cwd?: string) => void;
}

const GATE_STUB = `import * as fs from "node:fs";
fs.appendFileSync("gate-ran", "x\\n");
process.exit(fs.existsSync("gate-fails") ? 1 : 0);
`;

/** A throwaway repo wired to this repo's hooks, with one commit already in it. */
function newRepo(prefix = "commit-hooks-"): Repo {
	const dir = tmpDir(prefix);
	const git = (...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "hooks@example.test");
	git("config", "user.name", "Hook Test");
	git("config", "commit.gpgsign", "false");
	fs.mkdirSync(path.join(dir, ".githooks"));
	for (const hook of HOOKS) {
		fs.copyFileSync(path.join(ROOT, ".githooks", hook), path.join(dir, ".githooks", hook));
	}
	fs.mkdirSync(path.join(dir, "scripts"));
	fs.copyFileSync(path.join(ROOT, "scripts", "quality-gate-trailer.mjs"), path.join(dir, "scripts", "quality-gate-trailer.mjs"));
	// The gate the hooks run: a stub, so the suite tests the hooks and not npm run qa:static.
	fs.writeFileSync(path.join(dir, "gate.mjs"), GATE_STUB);
	fs.writeFileSync(
		path.join(dir, "package.json"),
		`${JSON.stringify({ name: "hook-test", private: true, scripts: { "qa:static": "node ./gate.mjs", "test:unit": "node ./gate.mjs" } }, null, 2)}\n`,
	);
	// The hooks refuse to vouch for a commit they cannot verify, so the tsc they look for must exist.
	// It is committed, like everything else here, because a linked worktree checks out the commit.
	fs.mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
	fs.writeFileSync(path.join(dir, "node_modules", ".bin", "tsc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
	fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
	git("add", "-A");
	git("-c", "core.hooksPath=", "commit", "-q", "-m", "base");
	// Relative on purpose: a linked worktree resolves it against its own root (verified by case 6).
	git("config", "core.hooksPath", ".githooks");

	const commit = (args: string[], env: Record<string, string> = {}, cwd = dir): CommitResult => {
		// spawnSync, not execFileSync: what the hooks say on stderr is an assertion in two cases,
		// and a successful execFileSync throws its stderr away.
		const r = spawnSync("git", ["commit", ...args], { cwd, encoding: "utf-8", env: { ...process.env, ...env } });
		return { code: r.status ?? -1, stderr: r.stderr ?? "" };
	};
	const at = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	return {
		dir,
		git,
		commit,
		trailer: (rev = "HEAD", cwd = dir) => at(cwd, "log", "-1", "--format=%(trailers:key=Quality-Gate,valueonly)", rev).trim(),
		patchId: (rev = "HEAD", cwd = dir) => {
			const patch = at(cwd, "diff-tree", "-p", "--root", "--no-color", rev);
			if (patch.trim() === "") {
				return "";
			}
			const out = execFileSync("git", ["patch-id", "--stable"], { cwd, encoding: "utf-8", input: patch });
			return out.trim().split(/\s+/)[0] ?? "";
		},
		tree: (rev = "HEAD", cwd = dir) => at(cwd, "rev-parse", `${rev}^{tree}`).trim(),
		gateRuns: (cwd = dir) => {
			const marker = path.join(cwd, "gate-ran");
			return fs.existsSync(marker) ? fs.readFileSync(marker, "utf-8").trimEnd().split("\n").length : 0;
		},
		write: (rel: string, text: string, cwd = dir) => fs.writeFileSync(path.join(cwd, rel), text),
	};
}

/** The trailer's two bindings. Missing or unparseable values come back as "", which matches nothing. */
function bindings(value: string): { patch: string; tree: string } {
	const m = /^v1 (?:patch=([0-9a-f]{40}) )?tree=([0-9a-f]{40})$/.exec(value);
	return { patch: m?.[1] ?? "", tree: m?.[2] ?? "" };
}

test("a normal commit runs the gate and carries a trailer that matches its own patch", () => {
	const r = newRepo();
	r.write("a.txt", "one\n");
	r.git("add", "a.txt");
	const before = r.gateRuns();
	assert.equal(r.commit(["-m", "change a"]).code, 0, "the commit succeeds");
	assert.equal(r.gateRuns(), before + 1, "the gate ran exactly once");
	assert.deepEqual(bindings(r.trailer()), { patch: r.patchId(), tree: r.tree() }, "both bindings describe this commit");
});

test("git commit --no-verify leaves no trailer: a bypass is visible, never stamped", () => {
	const r = newRepo();
	r.write("a.txt", "two\n");
	r.git("add", "a.txt");
	const before = r.gateRuns();
	// --no-verify skips pre-commit, and prepare-commit-msg would still run: hence the sentinel.
	assert.equal(r.commit(["--no-verify", "-m", "bypassed"]).code, 0);
	assert.equal(r.gateRuns(), before, "the gate did not run");
	assert.equal(r.trailer(), "", "and nothing vouched for it");
});

test("a trailer copied from another commit does not match that commit's patch", () => {
	const r = newRepo();
	r.write("a.txt", "three\n");
	r.git("add", "a.txt");
	r.commit(["-m", "honest"]);
	const stolen = r.trailer();
	r.write("b.txt", "forged\n");
	r.git("add", "b.txt");
	assert.equal(r.commit(["--no-verify", "-m", `forged\n\nQuality-Gate: ${stolen}`]).code, 0);
	assert.equal(r.trailer(), stolen, "the forged trailer is on the commit");
	const b = bindings(r.trailer());
	assert.notEqual(b.patch, r.patchId(), "but neither binding describes this commit - the forgery is detectable");
	assert.notEqual(b.tree, r.tree(), "including the tree, which is the binding an amend relies on");
});

test("git commit --amend leaves exactly one trailer, for the amended patch", () => {
	const r = newRepo();
	r.write("a.txt", "four\n");
	r.git("add", "a.txt");
	r.commit(["-m", "first"]);
	const first = r.trailer();
	r.write("b.txt", "four-b\n");
	r.git("add", "b.txt");
	assert.equal(r.commit(["--amend", "-m", "amended"]).code, 0);
	assert.equal(r.git("log", "-1", "--format=%B").match(/^Quality-Gate:/gm)?.length, 1, "exactly one trailer");
	// An amend re-parents the patch, and `--amend -m` tells the hook nothing about that, so the
	// patch-id it stamps is the amendment's delta. The tree binding is the one that holds here.
	assert.equal(bindings(r.trailer()).tree, r.tree(), "the tree binding describes the amended commit");
	assert.notEqual(r.trailer(), first, "which is not what the first commit's trailer said");
	// `--amend --no-edit` re-stamps a message that already carries a trailer: the replace path.
	r.write("a.txt", "four-again\n");
	r.git("add", "a.txt");
	const second = r.trailer();
	assert.equal(r.commit(["--amend", "--no-edit"]).code, 0);
	assert.equal(r.git("log", "-1", "--format=%B").match(/^Quality-Gate:/gm)?.length, 1, "still exactly one: replaced, not appended");
	assert.notEqual(r.trailer(), second, "and it was updated for the new content");
	assert.equal(bindings(r.trailer()).tree, r.tree(), "again by its tree, which is what an amend can be held to");
});

test("a partial commit (a path, or -a) is vouched for by what it actually committed", () => {
	const r = newRepo();
	r.write("a.txt", "five-a\n");
	r.write("b.txt", "five-b\n");
	// `git commit <path>` and `git commit -a` both hand the hook a temporary index.
	assert.equal(r.commit(["a.txt", "-m", "only a"]).code, 0);
	assert.deepEqual(bindings(r.trailer()), { patch: r.patchId(), tree: r.tree() }, "the path-limited commit's trailer matches it");
	assert.equal(r.commit(["-a", "-m", "the rest"]).code, 0);
	assert.deepEqual(bindings(r.trailer()), { patch: r.patchId(), tree: r.tree() }, "and so does the -a commit's");
});

test("a commit from a linked worktree runs the gate there (the hooks path is relative)", () => {
	const r = newRepo();
	const wt = path.join(r.dir, "..", "wt-second");
	r.git("worktree", "add", "-q", "-b", "second", wt);
	try {
		r.write("a.txt", "six\n", wt);
		execFileSync("git", ["-C", wt, "add", "a.txt"], { encoding: "utf-8" });
		assert.equal(r.commit(["-m", "from the worktree"], {}, wt).code, 0);
		assert.equal(r.gateRuns(wt), 1, "the gate ran in the worktree, not in the main checkout");
		assert.deepEqual(
			bindings(r.trailer("HEAD", wt)),
			{ patch: r.patchId("HEAD", wt), tree: r.tree("HEAD", wt) },
			"and the trailer matches there too",
		);
	} finally {
		fs.rmSync(wt, { recursive: true, force: true });
		r.git("worktree", "prune");
	}
});

test("a merge commit carries no trailer (git runs no pre-commit for one)", () => {
	const r = newRepo();
	r.git("checkout", "-q", "-b", "side");
	r.write("b.txt", "seven\n");
	r.git("add", "b.txt");
	r.commit(["-m", "on the side"]);
	r.git("checkout", "-q", "main");
	r.write("a.txt", "seven-main\n");
	r.git("add", "a.txt");
	r.commit(["-m", "on main"]);
	r.git("merge", "--no-ff", "-q", "-m", "merge side", "side");
	assert.equal(r.git("rev-list", "--parents", "-1", "HEAD").trim().split(/\s+/).length, 3, "it is a merge commit");
	assert.equal(r.trailer(), "", "no trailer: the hygiene check exempts merges by parent count");
});

test("a failing gate blocks the commit", () => {
	const r = newRepo();
	const head = r.git("rev-parse", "HEAD").trim();
	r.write("gate-fails", "");
	r.write("a.txt", "eight\n");
	r.git("add", "a.txt");
	const result = r.commit(["-m", "should not land"]);
	assert.notEqual(result.code, 0, "the commit fails");
	assert.equal(r.git("rev-parse", "HEAD").trim(), head, "and nothing was committed");
});

test("QA_SKIP_HOOKS=1 commits without the gate, says so, and claims nothing", () => {
	const r = newRepo();
	r.write("a.txt", "nine\n");
	r.git("add", "a.txt");
	const before = r.gateRuns();
	const result = r.commit(["-m", "skipped"], { QA_SKIP_HOOKS: "1" });
	assert.equal(result.code, 0, "the commit succeeds");
	assert.match(result.stderr, /QA_SKIP_HOOKS/, "the skip is announced, not silent");
	assert.equal(r.gateRuns(), before, "the gate did not run");
	assert.equal(r.trailer(), "", "and the commit makes no claim");
});

test("a commit that cannot be verified is refused, not vouched for", () => {
	const r = newRepo();
	fs.rmSync(path.join(r.dir, "node_modules"), { recursive: true, force: true });
	r.write("a.txt", "ten\n");
	r.git("add", "a.txt");
	const result = r.commit(["-m", "unverifiable"]);
	assert.notEqual(result.code, 0, "the commit fails");
	assert.match(result.stderr, /npm install/, "and says what to do about it");
});

test("one gate run vouches for one commit: the sentinel is single use", () => {
	const r = newRepo();
	r.write("a.txt", "eleven\n");
	r.git("add", "a.txt");
	r.commit(["-m", "gated"]);
	// Same index, so the same staged tree the gated commit had - and no gate run this time.
	r.git("reset", "--soft", "HEAD~1");
	assert.equal(r.commit(["--no-verify", "-m", "ungated"]).code, 0);
	assert.equal(r.trailer(), "", "a second commit of the same tree is not stamped");
});

test("an empty commit message still aborts: a trailer is not a message", () => {
	const r = newRepo();
	r.write("a.txt", "twelve\n");
	r.git("add", "a.txt");
	const head = r.git("rev-parse", "HEAD").trim();
	// An editor that writes nothing leaves git's template, whose only real content is comments.
	// A trailer added before that point would be the message, and this commit would land.
	const result = r.commit([], { GIT_EDITOR: "true" });
	assert.notEqual(result.code, 0, "git still aborts");
	assert.match(result.stderr, /empty commit message/i, "for the reason it would have given anyway");
	assert.equal(r.git("rev-parse", "HEAD").trim(), head, "and nothing was committed");
});

test("a message typed in an editor keeps its own subject, with the trailer below it", () => {
	const r = newRepo();
	r.write("a.txt", "thirteen\n");
	r.git("add", "a.txt");
	const editor = path.join(r.dir, "fake-editor.sh");
	fs.writeFileSync(editor, '#!/bin/sh\nprintf "typed subject\\n" > "$1"\n', { mode: 0o755 });
	assert.equal(r.commit([], { GIT_EDITOR: editor }).code, 0);
	assert.equal(r.git("log", "-1", "--format=%s").trim(), "typed subject", "the subject is the author's");
	assert.deepEqual(bindings(r.trailer()), { patch: r.patchId(), tree: r.tree() }, "and the trailer is a trailer");
});

// --- the CI half: scripts/check-commit-hygiene.mjs, which is what makes a bypass cost something.

/** The hygiene check, run from this repo against a throwaway repo's history. */
function hygiene(r: Repo, base: string, head = "HEAD", extra: string[] = []): { code: number; out: string } {
	const args = [path.join(ROOT, "scripts", "check-commit-hygiene.mjs"), "--base", base, "--head", head, ...extra];
	const p = spawnSync("node", args, { cwd: r.dir, encoding: "utf-8" });
	return { code: p.status ?? -1, out: `${p.stdout ?? ""}${p.stderr ?? ""}` };
}

test("a branch of gated commits passes the hygiene check", () => {
	const r = newRepo();
	const base = r.git("rev-parse", "HEAD").trim();
	r.write("a.txt", "hygiene-one\n");
	r.git("add", "a.txt");
	r.commit(["-m", "first"]);
	r.write("b.txt", "hygiene-two\n");
	r.git("add", "b.txt");
	r.commit(["-m", "second"]);
	const result = hygiene(r, base);
	assert.equal(result.code, 0, result.out);
});

test("a branch with one bypassed commit fails, naming that commit and no other", () => {
	const r = newRepo();
	const base = r.git("rev-parse", "HEAD").trim();
	r.write("a.txt", "hygiene-three\n");
	r.git("add", "a.txt");
	r.commit(["-m", "gated"]);
	const gated = r.git("rev-parse", "--short", "HEAD").trim();
	r.write("b.txt", "hygiene-four\n");
	r.git("add", "b.txt");
	r.commit(["--no-verify", "-m", "snuck in"]);
	const bypassed = r.git("rev-parse", "--short", "HEAD").trim();
	const result = hygiene(r, base);
	assert.equal(result.code, 1, "the check fails");
	assert.match(result.out, new RegExp(bypassed), "it names the bypassed commit");
	assert.doesNotMatch(result.out, new RegExp(gated), "and not the gated one");
	assert.match(result.out, /hooks:install/, "and says how to get the gate running");
});

test("a rebase does not invalidate a trailer: the patch-id outlives the tree", () => {
	const r = newRepo();
	r.git("checkout", "-q", "-b", "feature");
	r.write("b.txt", "feature work\n");
	r.git("add", "b.txt");
	r.commit(["-m", "feature work"]);
	r.git("checkout", "-q", "main");
	r.write("a.txt", "main moves\n");
	r.git("add", "a.txt");
	r.commit(["-m", "main moves"]);
	const movedBase = r.git("rev-parse", "HEAD").trim();
	// A rebase runs none of these hooks: the commit is rewritten and carries its trailer along.
	r.git("rebase", "-q", "main", "feature");
	const result = hygiene(r, movedBase);
	assert.equal(result.code, 0, result.out);
	assert.notEqual(bindings(r.trailer()).tree, r.tree(), "the tree binding no longer matches: the patch-id is what passed");
});

test("a merge commit is exempt: git runs no pre-commit for one", () => {
	const r = newRepo();
	const base = r.git("rev-parse", "HEAD").trim();
	r.git("checkout", "-q", "-b", "side");
	r.write("b.txt", "side work\n");
	r.git("add", "b.txt");
	r.commit(["-m", "side work"]);
	r.git("checkout", "-q", "main");
	r.git("merge", "--no-ff", "-q", "-m", "merge side", "side");
	assert.equal(r.trailer(), "", "the merge commit carries no trailer");
	const result = hygiene(r, base);
	assert.equal(result.code, 0, result.out);
});

test("the version-bump bot is exempt: it commits in CI, where no hooks are installed", () => {
	const r = newRepo();
	const base = r.git("rev-parse", "HEAD").trim();
	r.write("a.txt", "bumped\n");
	r.git("add", "a.txt");
	const bot = { GIT_AUTHOR_NAME: "github-actions[bot]", GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com" };
	assert.equal(r.commit(["--no-verify", "-m", "chore(plugins): bump versions"], bot).code, 0);
	assert.equal(r.trailer(), "", "the bot's commit has no trailer");
	assert.equal(hygiene(r, base).code, 0, "the bot's commit is exempt");
	// And so is a commit GitHub itself made: a squash merge is committed by the web flow, with the
	// author's name on it and no trailer, and failing main for that would teach people to ignore this.
	r.write("b.txt", "squashed\n");
	r.git("add", "b.txt");
	const web = { GIT_COMMITTER_NAME: "GitHub", GIT_COMMITTER_EMAIL: "noreply@github.com" };
	assert.equal(r.commit(["--no-verify", "-m", "Squashed PR (#12)"], web).code, 0);
	const result = hygiene(r, base);
	assert.equal(result.code, 0, result.out);
});

test("history from before the gate is out of scope: --cutover bounds the check", () => {
	const r = newRepo();
	const base = r.git("rev-parse", "HEAD").trim();
	r.write("a.txt", "from before\n");
	r.git("add", "a.txt");
	r.commit(["--no-verify", "-m", "before the gate existed"]);
	const stranded = r.git("rev-parse", "--short", "HEAD").trim();
	r.write("b.txt", "the gate arrives\n");
	r.git("add", "b.txt");
	r.commit(["-m", "the first gated commit"]);
	const cutover = r.git("rev-parse", "HEAD").trim();
	r.write("a.txt", "after\n");
	r.git("add", "a.txt");
	r.commit(["-m", "after the gate"]);
	const bounded = hygiene(r, base, "HEAD", ["--cutover", cutover]);
	assert.equal(bounded.code, 0, bounded.out);
	const unbounded = hygiene(r, base);
	assert.equal(unbounded.code, 1, "without the cutover the same branch fails");
	assert.match(unbounded.out, new RegExp(stranded), "on the commit that predates the gate");
});

test("a cutover this checkout does not have is ignored, out loud", () => {
	const r = newRepo();
	const base = r.git("rev-parse", "HEAD").trim();
	r.write("a.txt", "gated\n");
	r.git("add", "a.txt");
	r.commit(["-m", "gated"]);
	// A squash merge means the cutover commit never landed: the check must not fail silently open.
	const result = hygiene(r, base, "HEAD", ["--cutover", "0".repeat(39) + "1"]);
	assert.equal(result.code, 0, result.out);
	assert.match(result.out, /cutover/, "it says the cutover was not applied");
});
