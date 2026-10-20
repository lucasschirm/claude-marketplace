// Run with: node --test test/test-review-thread-paths.ts
import { after, test } from "node:test";
import * as assert from "node:assert";
import { applyCodeSuggestion, isInsideDir, resolveRepoFilePath } from "../extensions/lib/github-review-threads.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupTmpDirs, tmpDir, tmpGitRepo } from "./helpers/git-repo.ts";

const tmpRepo = () => tmpGitRepo("pr-task-path-");

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
