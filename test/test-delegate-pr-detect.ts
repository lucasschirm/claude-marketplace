// Run with: node --test test/test-delegate-pr-detect.ts
//
// The PR number in a completion notice is the only reason the delegating agent learns a PR exists
// without going looking, and the notice is assembled once. So the ways `gh` can fail to answer are the
// interesting cases: no PR, an error, and no `gh` at all.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeStub, type Stub } from "./helpers/delegate-stub.ts";
import { detectPullRequest } from "../extensions/lib/delegate/pr-detect.ts";
import type { DelegateRuntime } from "../extensions/lib/delegate/runtime.ts";

/** A committed repo on `feature/x`. */
function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join("/tmp", "delegate-pr-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "-b", "feature/x");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "a.ts"), "1\n");
	git("add", "a.ts");
	git("commit", "-m", "initial");
	return dir;
}

interface Case {
	rt: DelegateRuntime;
	stub: Stub;
	repo: string;
	warnings: string[];
	/** The `gh` invocations so far, one line each. */
	calls(): string[];
}

/**
 * Run one case with a `gh` on PATH that behaves like one of four `gh`s:
 * "pr" answers for the branch, "current" answers only the branchless lookup, "none" honestly finds
 * nothing, "error" cannot answer at all.
 */
async function withGh(mode: string, ghInstalled: boolean, run: (c: Case) => Promise<void>): Promise<void> {
	const stub = makeStub();
	const repo = makeRepo();
	const bin = fs.mkdtempSync(path.join("/tmp", "delegate-gh-"));
	const script = path.join(bin, "gh");
	// gh's honest "there is no PR here" is also a non-zero exit, and the words are the only thing that
	// separates it from gh being broken (`isNoPullRequestFailure`), so the fake has to get them right.
	const quiet = `echo "no Pull Requests found for branch feature/x" >&2; exit 1`;
	const branchAnswer =
		mode === "pr"
			? `echo '{"number":42,"state":"OPEN"}'`
			: mode === "error"
				? `echo "gh: HTTP 500 from api.github.com" >&2; exit 1`
				: quiet;
	const currentAnswer =
		mode === "current"
			? `echo '{"number":43,"state":"OPEN"}'`
			: mode === "error"
				? `echo "gh: HTTP 500 from api.github.com" >&2; exit 1`
				: quiet;
	fs.writeFileSync(
		script,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
case "$*" in
  *"pr view --json"*) ${currentAnswer} ;;
  *"pr view"*) ${branchAnswer} ;;
  *) exit 0 ;;
esac
`,
	);
	fs.chmodSync(script, 0o755);
	const log = path.join(bin, "calls.log");
	const savedPath = process.env.PATH;
	const savedLog = process.env.FAKE_GH_LOG;
	process.env.PATH = ghInstalled ? `${bin}:${savedPath}` : savedPath.replace(bin, "");
	process.env.FAKE_GH_LOG = log;
	const warnings: string[] = [];
	stub.rt.commandExists = async (cmd: string) => ghInstalled && cmd === "gh";
	stub.rt.logWarn = (message: string) => warnings.push(message);
	try {
		await run({
			rt: stub.rt,
			stub,
			repo,
			warnings,
			calls: () => {
				try {
					return fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean);
				} catch {
					return [];
				}
			},
		});
	} finally {
		process.env.PATH = savedPath;
		if (savedLog === undefined) {
			delete process.env.FAKE_GH_LOG;
		} else {
			process.env.FAKE_GH_LOG = savedLog;
		}
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(bin, { recursive: true, force: true });
	}
}

test("without gh there is nothing to ask, and no reason to warn", () =>
	withGh("pr", false, async ({ rt, warnings, calls }) => {
		assert.equal(await rt.commandExists("gh"), false);
		assert.equal(await detectPullRequest(rt, "/nonexistent-path", "feature/x"), undefined);
		assert.deepEqual(warnings, []);
		assert.deepEqual(calls(), [], "gh was never invoked, so it never got the chance to fail");
	}));

test("a PR for the checked-out branch is reported by number", () =>
	withGh("pr", true, async ({ rt, repo, warnings, calls }) => {
		assert.equal(await detectPullRequest(rt, repo, "feature/x"), 42);
		assert.ok(
			calls().some((c) => c.includes("feature/x")),
			"the branch we provisioned was asked about",
		);
		assert.deepEqual(warnings, [], "an answer needs no commentary");
	}));

test("a branch name that no longer matches still finds the PR from inside the folder", () =>
	withGh("current", true, async ({ rt, repo }) => {
		// The named lookups miss; the branchless one answers. This is the rebase / manual checkout case.
		assert.equal(await detectPullRequest(rt, repo, "feature/renamed-away"), 43);
	}));

test("honestly no PR is quiet", () =>
	withGh("none", true, async ({ rt, repo, warnings }) => {
		assert.equal(await detectPullRequest(rt, repo, "feature/x"), undefined);
		assert.deepEqual(warnings, [], "'no PR for this branch' is an ordinary outcome");
	}));

test("a gh that cannot answer says so instead of looking like a missing PR", () =>
	withGh("error", true, async ({ rt, repo, warnings }) => {
		assert.equal(await detectPullRequest(rt, repo, "feature/x"), undefined);
		assert.match(warnings.join("\n"), /PR lookup/);
	}));
