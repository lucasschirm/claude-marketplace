// Run with: node --test test/test-review-thread-paths.ts
import { after, test } from "node:test";
import * as assert from "node:assert";
import { applyCodeSuggestion, isInsideDir, resolveRepoFilePath } from "../extensions/lib/github-review-threads.ts";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { cleanupTmpDirs, tmpDir, tmpGitRepo } from "./helpers/git-repo.ts";

const tmpRepo = () => tmpGitRepo("pr-task-path-");

const git = (args: string[], opts?: { cwd: string }) => execFileSync("git", args, { cwd: opts?.cwd, stdio: "ignore" });

// Nothing may be left behind in tmpdir: the unit suites run in parallel in CI.
after(cleanupTmpDirs);

test("isInsideDir contains by path relation, not by string prefix", () => {
	assert.strictEqual(isInsideDir("/repo", "/repo/src/a.ts"), true);
	assert.strictEqual(isInsideDir("/repo", "/repo"), false, "the root itself is not 'inside'");
	assert.strictEqual(isInsideDir("/repo", "/repo-evil/a.ts"), false, "/repo-evil must not look nested");
	assert.strictEqual(isInsideDir("/repo", "/other/a.ts"), false);
	assert.strictEqual(isInsideDir("/repo", "/repo/../outside.ts"), false);
});

test("resolveRepoFilePath keeps repository-relative paths inside the repo", async () => {
	const repo = tmpRepo();
	const resolved = await resolveRepoFilePath(repo, "src/a.ts");
	assert.strictEqual(resolved, path.join(repo, "src/a.ts"));
	await assert.rejects(() => resolveRepoFilePath(repo, "../../etc/passwd"), /outside the repository/);
	await assert.rejects(() => resolveRepoFilePath(repo, "/tmp/abs.txt"), /repository-relative/);
	await assert.rejects(() => resolveRepoFilePath(repo, ""), /empty/);
	await assert.rejects(() => resolveRepoFilePath(repo, "src/a\0.ts"), /NUL/);
});

test("applyCodeSuggestion refuses a path that escapes the repository without writing it", async () => {
	const repo = tmpRepo();
	const outside = tmpDir("pr-task-outside-");
	const victim = path.join(outside, "victim.txt");
	fs.writeFileSync(victim, "keep me\n", "utf-8");

	await assert.rejects(() => applyCodeSuggestion(victim, 1, 1, "overwritten\n", repo), /repository-relative/);
	assert.strictEqual(fs.readFileSync(victim, "utf-8"), "keep me\n", "the escape must fail before any write");
});

test("applyCodeSuggestion refuses line numbers that are not a usable range", async () => {
	const repo = tmpRepo();
	fs.writeFileSync(path.join(repo, "a.ts"), "one\ntwo\nthree\n", "utf-8");

	// GitHub gives a comment on a deleted line no line number at all; `undefined` used to slip
	// through the range check (`undefined > lines.length` is false) and insert instead of replace.
	await assert.rejects(() => applyCodeSuggestion("a.ts", 1, undefined, "x\n", repo), /not a usable line range/);
	await assert.rejects(() => applyCodeSuggestion("a.ts", undefined, 2, "x\n", repo), /not a usable line range/);
	await assert.rejects(() => applyCodeSuggestion("a.ts", 3, 1, "x\n", repo), /not a usable line range/);
	await assert.rejects(() => applyCodeSuggestion("a.ts", 1.5, 2, "x\n", repo), /not a usable line range/);
	await assert.rejects(() => applyCodeSuggestion("a.ts", 1, 99, "x\n", repo), /not in the file/);

	// Nothing above may have touched the file.
	assert.strictEqual(fs.readFileSync(path.join(repo, "a.ts"), "utf-8"), "one\ntwo\nthree\n");
});

test("a suggestion may not target the git directory", async () => {
	const repo = tmpRepo();
	// Unreachable through the GitHub API, but a hook or config write is code execution, not a bad edit.
	await assert.rejects(() => applyCodeSuggestion(".git/hooks/pre-commit", 1, 1, "#!/bin/sh\n", repo), /targets the git directory/);
	assert.strictEqual(fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit")), false);
});

test("a suggestion inside the repo is still applied", async () => {
	const repo = tmpRepo();
	fs.writeFileSync(path.join(repo, "b.ts"), "one\ntwo\nthree\n", "utf-8");
	await applyCodeSuggestion("b.ts", 2, 2, "TWO", repo);
	assert.strictEqual(fs.readFileSync(path.join(repo, "b.ts"), "utf-8"), "one\nTWO\nthree\n");
});

// fs.symlinkSync needs privileges a non-admin Windows runner does not grant.
const skipSymlinks = process.platform === "win32" ? { skip: "needs symlinks" } : {};

test("a symlinked target cannot carry the write outside the repository", skipSymlinks, async () => {
	const repo = tmpRepo();
	const outside = tmpDir("pr-task-outside2-");
	const victim = path.join(outside, "victim.txt");
	fs.writeFileSync(victim, "keep me\n", "utf-8");
	fs.symlinkSync(victim, path.join(repo, "link.txt"));

	await assert.rejects(() => applyCodeSuggestion("link.txt", 1, 1, "overwritten\n", repo), /outside the repository/);
	assert.strictEqual(fs.readFileSync(victim, "utf-8"), "keep me\n");
});

// A root that IS git metadata defeats the `.git` segment test: relative to `<repo>/.git`, the path `config`
// contains no `.git` segment. `repoRoot()` cannot produce such a root today - `git rev-parse --show-toplevel`
// was measured to fail with "must be run in a work tree" inside `.git`, a bare repo and a worktree gitdir -
// so these pin the guarantee at the layer that is exported, and pin the safety property end to end: nothing
// is written into git metadata whatever error the caller meets on the way.
// Real git-created roots, because identity is read from the layout: a hand-made directory called `repo.git` is
// not a repository and must not be what proves the guard.
function gitMetadataRoots(): Array<[string, () => { root: string; target: string }]> {
	return [
		[
			"a bare clone",
			() => {
				const dir = path.join(tmpDir("pr-task-bare-"), "repo.git");
				git(["init", "--bare", dir]);
				return { root: dir, target: "config" };
			},
		],
		[
			"a bare clone's hooks dir",
			() => {
				const dir = path.join(tmpDir("pr-task-bare-"), "repo.git");
				git(["init", "--bare", dir]);
				fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
				return { root: dir, target: path.join("hooks", "pre-push") };
			},
		],
		[
			// The case the suffix heuristic missed entirely: `git init --bare work` has no `.git` in the name.
			"a bare clone with no .git suffix",
			() => {
				const dir = path.join(tmpDir("pr-task-bare-"), "mirror-work");
				git(["init", "--bare", dir]);
				return { root: dir, target: "config" };
			},
		],
		[
			"the .git directory itself",
			() => {
				const repo = tmpRepo();
				return { root: path.join(repo, ".git"), target: "config" };
			},
		],
		[
			"a linked worktree's gitdir",
			() => {
				// Both the repo and the worktree live under one tmp root: `git worktree add` refuses an existing
				// path, so putting the sibling in /tmp itself would make the second run of this suite fail.
				const base = tmpDir("pr-task-wt-");
				const repo = path.join(base, "repo");
				fs.mkdirSync(repo, { recursive: true });
				git(["init", "-q", repo]);
				fs.writeFileSync(path.join(repo, "a.ts"), "one\n", "utf-8");
				git(["-C", repo, "add", "a.ts"]);
				git(["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-qm", "seed"]);
				const feature = path.join(base, "feature-worktree");
				git(["-C", repo, "worktree", "add", "-b", "feature", feature]);
				const meta = fs
					.readFileSync(path.join(feature, ".git"), "utf-8")
					.trim()
					.replace(/^gitdir:\s*/, "");
				return { root: meta, target: "HEAD" };
			},
		],
		[
			"a --separate-git-dir directory",
			() => {
				const base = tmpDir("pr-task-sepgit-");
				const work = path.join(base, "work");
				const gitDir = path.join(base, "elsewhere-metadata");
				fs.mkdirSync(work, { recursive: true });
				git(["init", "--separate-git-dir", gitDir, work]);
				return { root: gitDir, target: "config" };
			},
		],
	];
}

for (const [label, make] of gitMetadataRoots()) {
	test(`resolveRepoFilePath refuses ${label}`, async () => {
		const { root, target } = make();
		const victim = path.join(root, target);
		fs.mkdirSync(path.dirname(victim), { recursive: true });
		fs.writeFileSync(victim, "keep me\n", "utf-8");
		await assert.rejects(() => resolveRepoFilePath(root, target), /git metadata directory/);
		assert.strictEqual(fs.readFileSync(victim, "utf-8"), "keep me\n");
	});
}

test("a symlinked root that points at git metadata is refused by layout, not by name", async () => {
	const base = tmpDir("pr-task-linkroot-");
	const repo = path.join(base, "repo");
	fs.mkdirSync(repo, { recursive: true });
	git(["init", repo]);
	const linkRoot = path.join(base, "looks-like-a-worktree");
	fs.symlinkSync(path.join(repo, ".git"), linkRoot, "dir");
	await assert.rejects(() => resolveRepoFilePath(linkRoot, "config"), /git metadata directory/);
});

test("a working tree that merely has a .git-looking name is not metadata", async () => {
	// The suffix heuristic this replaced refused `<somewhere>/release.git` even when it was an ordinary
	// checkout. Refusing to edit a legitimate repository is a bug too - it just fails quietly, by disabling
	// the tool for that user.
	const base = tmpDir("pr-task-named-");
	const repo = path.join(base, "release.git");
	fs.mkdirSync(repo, { recursive: true });
	git(["init", repo]);
	fs.writeFileSync(path.join(repo, "a.ts"), "one\n", "utf-8");
	assert.strictEqual(await resolveRepoFilePath(repo, "a.ts"), path.join(repo, "a.ts"));
});

test("a tracked symlink may not be used to write into .git", async () => {
	// The R5-6 reproducer. `.git` is inside the root, so containment is satisfied by construction; only a
	// re-check of the resolved target against the canonical metadata directory stops this.
	const repo = tmpRepo();
	const marker = path.join(repo, ".git", "r5-marker");
	fs.writeFileSync(marker, "before\n", "utf-8");
	const link = path.join(repo, "tracked-link");
	if (process.platform === "win32") return; // symlinks need elevation on Windows
	fs.symlinkSync(".git/r5-marker", link, "file");
	git(["add", "tracked-link"], { cwd: repo });
	await assert.rejects(() => applyCodeSuggestion("tracked-link", 1, 1, "after\n", repo), /git directory/);
	assert.strictEqual(fs.readFileSync(marker, "utf-8"), "before\n", "the metadata file must be untouched");
});

test("a symlink to an ordinary file in the tree still works", async () => {
	const repo = tmpRepo();
	if (process.platform === "win32") return;
	fs.writeFileSync(path.join(repo, "real.txt"), "one\ntwo\n", "utf-8");
	fs.symlinkSync("real.txt", path.join(repo, "alias.txt"));
	await applyCodeSuggestion("alias.txt", 2, 2, "TWO\n", repo);
	assert.strictEqual(fs.readFileSync(path.join(repo, "real.txt"), "utf-8"), "one\nTWO\n");
});
test("applyCodeSuggestion never writes into a bare repository, whatever it fails on", async () => {
	const base = tmpDir("pr-task-bare-");
	const bare = path.join(base, "repo.git");
	fs.mkdirSync(bare, { recursive: true });
	execFileSync("git", ["init", "--bare", bare], { stdio: "ignore" });
	const config = path.join(bare, "config");
	const before = fs.readFileSync(config, "utf-8");
	// Either the metadata guard or git's own refusal may fire first; the invariant is that no write happens.
	await assert.rejects(
		() => applyCodeSuggestion("config", 1, 1, "[core]\n\tbare = false\n", bare),
		/git metadata directory|not a git repository|work tree/,
	);
	assert.strictEqual(fs.readFileSync(config, "utf-8"), before);
});

test("a .git directory nested in a real working tree is refused from both sides", async () => {
	const repo = tmpRepo();
	const nested = path.join(repo, "vendor", ".git");
	fs.mkdirSync(nested, { recursive: true });
	fs.writeFileSync(path.join(nested, "config"), "[core]\n", "utf-8");
	// as the root: the metadata guard; as a path inside a normal root: the segment test
	await assert.rejects(() => resolveRepoFilePath(nested, "config"), /git metadata directory/);
	await assert.rejects(() => resolveRepoFilePath(repo, "vendor/.git/config"), /targets the git directory/);
});
