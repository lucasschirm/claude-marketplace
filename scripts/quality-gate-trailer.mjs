#!/usr/bin/env node
// The commit-time quality gate, in one place so the three hooks in .githooks/ stay trivial:
//   node scripts/quality-gate-trailer.mjs pre-commit
//   node scripts/quality-gate-trailer.mjs commit-msg <msg-file>
//   node scripts/quality-gate-trailer.mjs pre-push
//
// pre-commit runs `npm run qa:static` (typecheck, lint, format, invariants, manifests - about five
// seconds) and, on success, drops a sentinel file in the git dir named after the staged tree.
// commit-msg stamps the trailer onto the message, but only if that sentinel is there, and removes
// it. The sentinel is the whole point: a hook that stamped whenever it ran would stamp exactly the
// commits it was meant to catch, because `git commit --no-verify` skips pre-commit and
// prepare-commit-msg does run (verified). A bypassed commit comes out unstamped, and
// scripts/check-commit-hygiene.mjs in CI is what notices.
//
// The trailer binds the commit two ways - `Quality-Gate: v1 patch=<patch-id> tree=<tree>` - and the
// hygiene check in CI accepts a commit whose EITHER binding matches it. Two, because neither alone
// covers what happens to a commit between the hook and CI:
//
//   - `tree` is the staged tree, which is exactly the tree the commit gets. It needs no guess about
//     the parent, and that matters: with `git commit --amend -m msg` git reports the message source
//     as "message", identically to a normal commit, and nothing else in the arguments or the
//     environment distinguishes an amend (verified by probe) - so the patch-id a hook computes for
//     an amend is the amendment's delta, not the commit's patch. The tree is right either way.
//   - `patch` is a `--stable` patch-id, which survives a rebase; a tree id does not. Rebasing a
//     branch rewrites every tree, and a trailer that broke on every rebase would be worse than no
//     trailer at all, because the only way to make CI green again would be to re-stamp by hand.
//
// A commit that is BOTH amended with -m and then rebased satisfies neither binding and CI says so;
// `git commit --amend --no-edit` re-stamps it (that form does report the "commit" source, so the
// patch-id comes out exact). The trailer is evidence, not a signature: anything it contains can be
// computed by hand by someone determined to forge one. What it catches is the bypass that actually
// happens - `--no-verify`, or a trailer line copied from another commit.
//
// The sentinel is keyed on the staged tree for the same reason: it is the one name both hooks can
// compute without knowing the parent.
//
// Known window: a `git commit` killed between pre-commit and prepare-commit-msg leaves a sentinel
// behind, and a later --no-verify commit of that same tree would be stamped. The claim it makes
// (the static gate passed on this content) was still true when the gate ran, and the two hooks run
// back to back, so this is not worth a clock.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** A repo-sized diff does not fit the 1 MiB default, and a truncated diff would be a wrong patch-id. */
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
/** git's hash of the empty tree: the base a root commit's diff is taken against. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const TRAILER = "Quality-Gate";
const VERSION = "v1";

const say = (msg) => process.stderr.write(`${msg}\n`);
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: MAX_DIFF_BYTES });
/** git, as bytes. A diff is not text: a latin-1 source file or a binary git diffs as text puts bytes in
 * it that are not valid UTF-8, and decoding those into U+FFFD before hashing produces a patch-id that
 * is nobody's patch - not the commit's, and not what `git diff | git patch-id` says it is. */
const gitBytes = (args) => execFileSync("git", args, { maxBuffer: MAX_DIFF_BYTES });
/** git, for questions whose answer may be "no": a non-zero exit becomes null rather than a throw. */
function gitAsk(args) {
	try {
		return git(args).trim();
	} catch {
		return null;
	}
}

/** A revision, or null when it does not exist (no HEAD yet, or a root commit's parent). */
const revOrNull = (rev) => gitAsk(["rev-parse", "--verify", "--quiet", rev]);

function die(msg) {
	say(msg);
	process.exit(1);
}

/** Is the gate switched off for this invocation? One name, checked one way, in one place. */
function skipping() {
	const value = process.env.QA_SKIP_HOOKS ?? "";
	return value !== "" && value !== "0" && value !== "false";
}

/** Where the sentinel for a given staged tree lives. In a linked worktree this is that worktree's
 * own git dir, so two worktrees committing at once cannot read each other's gate. */
function sentinelFor(tree) {
	const gitDir = gitAsk(["rev-parse", "--absolute-git-dir"]);
	if (gitDir === null) {
		die("quality gate: not inside a git repository");
	}
	return path.join(gitDir, `quality-gate-${tree}`);
}

/** The tree the commit will have. `git commit -a` and `git commit <path>` hand the hook a temporary
 * index through GIT_INDEX_FILE, which this inherits - so this is the partial index, as it should be. */
function stagedTree() {
	const tree = gitAsk(["write-tree"]);
	if (tree === null) {
		die("quality gate: the index could not be written (git write-tree failed)");
	}
	return tree;
}

/** The patch-id of the staged change against `base`, or "" when there is nothing to describe. */
function patchId(base) {
	const diff = gitBytes(["diff", "--cached", "--no-color", base]);
	if (diff.length === 0) {
		return "";
	}
	const out = execFileSync("git", ["patch-id", "--stable"], { input: diff, maxBuffer: MAX_DIFF_BYTES });
	return out.toString("utf8").trim().split(/\s+/)[0] ?? "";
}

/**
 * The variables git exports to a hook that say WHERE a later `git` command operates. A hook in a
 * linked worktree is given `GIT_DIR=<repo>/.git/worktrees/<name>` (absolute, verified), and `git
 * commit` adds `GIT_INDEX_FILE`; both override a `git -C <dir>` run underneath. The gate runs other
 * people's code - the test suite builds throwaway repositories and commits in them - so passing
 * these on means those commits land in the repository being guarded. They did once, from pre-push:
 * this repo's branch had to be restored from its reflog. This hook's OWN git calls still use them,
 * which is how `git commit -a` and `git commit <path>` are seen correctly; only the child loses them.
 * test/helpers/git-repo.ts has the same list for the suites' own sake.
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

/** `npm run <script>`, inheriting stdio so the developer sees the gate's own output, not a summary. */
function runGate(script) {
	const env = { ...process.env };
	for (const name of GIT_REDIRECTING_VARS) {
		delete env[name];
	}
	try {
		execFileSync("npm", ["run", "--silent", script], { env, stdio: "inherit" });
		return 0;
	} catch (err) {
		return typeof err?.status === "number" && err.status !== 0 ? err.status : 1;
	}
}

/** A gate that cannot run must not be reported as a gate that passed. */
function requireToolchain() {
	if (!fs.existsSync(path.join(process.cwd(), "node_modules", ".bin", "tsc"))) {
		die("quality gate: node_modules is incomplete, so the gate cannot run - run 'npm install' first");
	}
}

function preCommit() {
	if (skipping()) {
		say("quality gate: skipped (QA_SKIP_HOOKS is set); this commit will carry no Quality-Gate trailer and CI checks for one");
		return 0;
	}
	requireToolchain();
	const code = runGate("qa:static");
	if (code !== 0) {
		say("\nquality gate: failed, so nothing was committed. Fix the above, or commit with QA_SKIP_HOOKS=1 and expect CI to reject it.");
		return code;
	}
	fs.writeFileSync(sentinelFor(stagedTree()), `${process.pid}\n`);
	return 0;
}

/** Is there a message under the comments? git aborts a commit without one, and a trailer must not
 * be what keeps that commit alive: `git stripspace` is git's own answer to the question. */
function hasMessage(msgFile) {
	const body = execFileSync("git", ["stripspace", "--strip-comments"], { encoding: "utf8", input: fs.readFileSync(msgFile, "utf8") });
	return body.trim() !== "";
}

function commitMsg(args) {
	const [msgFile] = args;
	if (!msgFile) {
		die("quality gate: commit-msg was called without a message file");
	}
	const tree = stagedTree();
	const sentinel = sentinelFor(tree);
	if (!fs.existsSync(sentinel)) {
		// The gate did not run for this commit: --no-verify, QA_SKIP_HOOKS, or a merge (git runs no
		// pre-commit for one). Stamping here is exactly the mistake the sentinel exists to prevent.
		return 0;
	}
	if (!hasMessage(msgFile)) {
		// git is about to abort for an empty message. Leave it empty: the sentinel stays consumed,
		// and the next attempt runs the gate again.
		fs.rmSync(sentinel, { force: true });
		return 0;
	}
	// Single use: one gate run vouches for one commit.
	fs.rmSync(sentinel, { force: true });
	const id = patchId(revOrNull("HEAD") ?? EMPTY_TREE);
	// An empty commit has no patch to name, and its tree is its parent's. The trailer says so rather
	// than being left off: CI wants one on every non-merge commit, and an empty commit is honest.
	const value = id === "" ? `tree=${tree}` : `patch=${id} tree=${tree}`;
	git(["interpret-trailers", "--in-place", "--if-exists", "replace", "--trailer", `${TRAILER}: ${VERSION} ${value}`, msgFile]);
	return 0;
}

function prePush() {
	if (skipping()) {
		say("quality gate: tests skipped (QA_SKIP_HOOKS is set); CI runs them anyway");
		return 0;
	}
	requireToolchain();
	const code = runGate("test:unit");
	if (code !== 0) {
		say("\nquality gate: the tests failed, so nothing was pushed. Fix them, or push with QA_SKIP_HOOKS=1 and expect CI to fail.");
	}
	return code;
}

const mode = process.argv[2] ?? "";
const rest = process.argv.slice(3);
if (mode === "pre-commit") {
	process.exit(preCommit());
}
if (mode === "commit-msg") {
	process.exit(commitMsg(rest));
}
if (mode === "pre-push") {
	process.exit(prePush());
}
die(`quality gate: unknown mode '${mode}' (expected pre-commit, commit-msg or pre-push)`);
