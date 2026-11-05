#!/usr/bin/env node
// Did every commit on this branch go through the commit-time gate?
//   node scripts/check-commit-hygiene.mjs --base <ref> [--head <ref>] [--cutover <sha>]
//
// This is the half of the gate that costs something. .githooks/pre-commit runs `npm run qa:static`
// and .githooks/commit-msg stamps `Quality-Gate: v1 patch=<patch-id> tree=<tree>` onto the message,
// but a hook is a local file: an agent (or a person) can pass --no-verify, set QA_SKIP_HOOKS, or
// never install the hooks at all. None of that is detectable at the moment it happens. What is
// detectable is the commit it leaves behind: no trailer, or a trailer that does not describe it.
//
// A commit passes if EITHER binding in its trailer matches it:
//   - tree: the commit's own tree. Exact for any commit the hook stamped, including an amend, whose
//     patch-id no hook can compute (git reports `git commit --amend -m msg` as source "message",
//     indistinguishable from a normal commit).
//   - patch: a `--stable` patch-id. Survives a rebase or a cherry-pick, which rewrite every tree
//     while leaving the patch alone - without this, every rebased branch would fail here.
// A trailer copied from another commit matches neither, which is the forgery this catches. It is
// not a signature: both values can be computed by hand. It catches the bypass that happens.
//
// Exempt: merge commits (git runs no pre-commit for one), the version-bump bot (it commits inside
// a workflow that installs no hooks - see .github/workflows/plugin-version-bump.yml), anything
// GitHub itself committed (a squash merge is made by the web flow, which has no hooks either), and
// every commit before --base. --cutover narrows that last one further: commits that are not
// descendants of the cutover commit are from before the hooks existed, which is what keeps a
// branch that was already in flight when they landed from being failed retroactively. A cutover
// this checkout does not have (a squash-merged one, say) is reported and ignored - the ranges CI
// checks after the merge contain only post-gate commits anyway.

import { spawnSync } from "node:child_process";

const TIMEOUT_MS = 120_000;
/** A branch's worth of diff does not fit the 1 MiB default, and a truncated diff is a wrong patch-id. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const ZERO_SHA = /^0{40}$/;
/** The identity .github/workflows/plugin-version-bump.yml commits under, and GitHub's own web flow. */
const BOT = new Set(["github-actions[bot]", "41898282+github-actions[bot]@users.noreply.github.com", "GitHub", "noreply@github.com"]);
const TRAILER_RE = /^v1 (?:patch=([0-9a-f]{40}) )?tree=([0-9a-f]{40})$/;
const US = "\u001f";
const RS = "\u001e";
const USAGE = "usage: node scripts/check-commit-hygiene.mjs --base <ref> [--head <ref>] [--cutover <sha>]";

function die(msg) {
	process.stderr.write(`${msg}\n`);
	process.exit(1);
}

/** git, as bytes. A diff is not text, and decoding one as UTF-8 before hashing it turns every byte
 * that is not valid UTF-8 into U+FFFD - the patch-id of the re-encoded result is nobody's patch. The
 * hook has the same rule in scripts/quality-gate-trailer.mjs; the two must agree byte for byte. */
function gitBytes(args, { input, allowFailure = false } = {}) {
	const r = spawnSync("git", args, { input, maxBuffer: MAX_OUTPUT_BYTES, timeout: TIMEOUT_MS });
	if (r.error) {
		die(`commit hygiene: git ${args.join(" ")} could not run (${r.error.message})`);
	}
	if (r.status !== 0) {
		if (allowFailure) {
			return null;
		}
		die(`commit hygiene: git ${args.join(" ")} failed (${(r.stderr ?? "").toString("utf8").trim()})`);
	}
	return r.stdout ?? Buffer.alloc(0);
}

/** The same, for output that is git's own text: a sha, a format string we wrote ourselves. */
function git(args, options) {
	return gitBytes(args, options)?.toString("utf8") ?? null;
}

function parseArgs(argv) {
	const out = { base: "", head: "HEAD", cutover: "" };
	const names = { "--base": "base", "--head": "head", "--cutover": "cutover" };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const eq = arg.indexOf("=");
		const name = eq === -1 ? arg : arg.slice(0, eq);
		const inline = eq === -1 ? null : arg.slice(eq + 1);
		if (name in names) {
			const value = inline ?? argv[++i] ?? "";
			if (value === "") {
				die(`commit hygiene: ${name} needs a value\n${USAGE}`);
			}
			out[names[name]] = value;
			continue;
		}
		if (name === "--help" || name === "-h") {
			process.stdout.write(`${USAGE}\n`);
			process.exit(0);
		}
		die(`commit hygiene: unknown argument '${arg}'\n${USAGE}`);
	}
	if (out.base === "") {
		die(`commit hygiene: --base is required\n${USAGE}`);
	}
	return out;
}

/** A revision resolved to a commit sha, or null when this checkout does not have it. */
const commitSha = (rev) => git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFailure: true })?.trim() ?? null;

const { base, head, cutover } = parseArgs(process.argv.slice(2));
if (ZERO_SHA.test(base)) {
	// A brand new branch, or a first push: there is no earlier state to compare against.
	process.stdout.write("commit hygiene: no base revision (a new branch), nothing to check\n");
	process.exit(0);
}
const baseSha = commitSha(base);
const headSha = commitSha(head);
if (baseSha === null) {
	die(`commit hygiene: base '${base}' is not in this checkout - a shallow clone cannot be checked (use fetch-depth: 0)`);
}
if (headSha === null) {
	die(`commit hygiene: head '${head}' is not a commit in this checkout`);
}

const range = `${baseSha}..${headSha}`;
// The commits the cutover puts in scope: everything after it. A commit in the range but not here is
// an ancestor of the cutover, i.e. from before the hooks existed.
let gated = null;
let cutoverNote = "";
if (cutover !== "") {
	const cutoverSha = commitSha(cutover);
	if (cutoverSha === null) {
		cutoverNote = `commit hygiene: cutover ${cutover.slice(0, 7)} is not in this checkout, so the whole range is checked\n`;
	} else {
		gated = new Set(
			git(["rev-list", "--no-merges", `${cutoverSha}..${headSha}`])
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== ""),
		);
		gated.add(cutoverSha);
	}
}
if (cutoverNote !== "") {
	process.stdout.write(cutoverNote);
}
const format = ["%H", "%h", "%T", "%an", "%ae", "%cn", "%ce", "%s", "%(trailers:key=Quality-Gate,valueonly)"].join(US) + RS;
const commits = git(["log", "--no-merges", `--format=${format}`, range])
	.split(RS)
	.map((record) => record.trim())
	.filter((record) => record !== "")
	.map((record) => {
		const [sha, short, tree, name, email, committer, committerEmail, subject, trailer] = record.split(US);
		return { sha, short, tree, name, email, committer, committerEmail, subject, trailer: (trailer ?? "").trim() };
	});

// One pass for every patch-id in the range: `git patch-id` reads a diff stream and reports the
// commit each patch belongs to, so this is one process rather than two per commit.
const patchIds = new Map();
const stream = gitBytes(["log", "--no-merges", "-p", "--no-color", "--format=commit %H", range]);
if (stream.length > 0) {
	for (const line of git(["patch-id", "--stable"], { input: stream }).split("\n")) {
		const [id, sha] = line.trim().split(/\s+/);
		if (id && sha) {
			patchIds.set(sha, id);
		}
	}
}

const offenders = [];
let exempt = 0;
for (const commit of commits) {
	if (BOT.has(commit.email) || BOT.has(commit.name) || BOT.has(commit.committerEmail) || BOT.has(commit.committer)) {
		exempt += 1;
		continue;
	}
	if (gated !== null && !gated.has(commit.sha)) {
		// From before the hooks existed: in the range, but not a descendant of the cutover commit.
		exempt += 1;
		continue;
	}
	if (commit.trailer === "") {
		offenders.push([commit, "no Quality-Gate trailer: this commit did not go through the pre-commit gate"]);
		continue;
	}
	const bindings = TRAILER_RE.exec(commit.trailer);
	if (bindings === null) {
		offenders.push([commit, `the Quality-Gate trailer is unreadable: '${commit.trailer}'`]);
		continue;
	}
	const [, patch, tree] = bindings;
	if (tree === commit.tree || (patch !== undefined && patch === patchIds.get(commit.sha))) {
		continue;
	}
	offenders.push([commit, "the Quality-Gate trailer describes another commit: neither its patch-id nor its tree matches"]);
}

const scope = `${commits.length} commit${commits.length === 1 ? "" : "s"} in ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`;
const skipped = exempt === 0 ? "" : ` (${exempt} exempt)`;
if (offenders.length === 0) {
	process.stdout.write(`commit hygiene: ${scope} - every commit went through the gate${skipped}\n`);
	process.exit(0);
}
const lines = [`commit hygiene: ${offenders.length} of ${scope} did not go through the commit-time gate${skipped}`, ""];
for (const [commit, reason] of offenders) {
	lines.push(`  ${commit.short} ${commit.subject} - ${reason}`);
}
lines.push(
	"",
	"Every commit needs a Quality-Gate trailer its own content backs. Either:",
	"  - install the hooks and re-make the commits:",
	"      npm run hooks:install",
	`      git rebase --exec 'git commit --amend --no-edit' ${baseSha.slice(0, 7)}`,
	"  - or, for the last commit only: npm run hooks:install && git commit --amend --no-edit",
	"",
	"(QA_SKIP_HOOKS=1 commits without the gate on purpose. This check is what notices.)",
);
process.stderr.write(`${lines.join("\n")}\n`);
process.exit(1);
