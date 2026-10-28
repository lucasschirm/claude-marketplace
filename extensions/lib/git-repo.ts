// One place that asks git and gh where we are.
//
// Four files answered "which repo, which branch, which PR" for themselves (`observe-pr.ts`,
// `pr-tasks.ts`, `devin-delegate.ts`, `lib/orca-client.ts`) and the answers had quietly diverged in
// ways each looked harmless alone:
//
//   - two spellings of "the current branch": `branch --show-current` (empty when detached) and
//     `rev-parse --abbrev-ref HEAD` (the literal string `"HEAD"` when detached). Comparing against
//     that literal is the kind of thing one caller forgot.
//   - one caller passed a timeout, three did not, so a git with a locked index could hold a branch
//     check open forever in three of the four.
//   - only two of the four could tell "this branch has no PR" from "gh could not answer" - which is
//     the difference between an ordinary branch and a session going looking for a PR in the wrong
//     folder while the log stays silent.
//
// So this module keeps three things in one place: the command spelling, the deadline, and the
// three-state answer. What it deliberately does *not* own is health accounting - `ghHealth` slots and
// backoff belong to the caller that has a policy about GitHub, and a lib that recorded health would
// make a caller's outage handling depend on which helper it happened to import.
import * as path from "node:path";
import { type ExecFailure, type ExecResult, READ_TIMEOUT_MS, failureText, runJson, runText } from "./exec.ts";
import type { Schema } from "./exec-payload.ts";
import { isNoPullRequestFailure } from "./gh-health.ts";

/**
 * An answer or the reason there is none. `value: undefined` (declared by the lookups that can honestly
 * answer nothing - a detached HEAD, a repository git cannot name) means the command ran and answered
 * nothing; `ok: false` means it never got that far. Collapsing the two is how "not a repo" starts
 * looking like "repo with no branch", and how a caller ends up querying `gh pr view ""`.
 */
export type Lookup<T> = { ok: true; value: T } | { ok: false; failure: ExecFailure };

export type PrRef = { number: number; state?: string };

/**
 * Three states, because "which PR is this branch" really has three answers and callers branch on all
 * three: found it, provably not there, or no information. `reason: "no-pr"` is a normal Tuesday;
 * `reason: "error"` is the one worth a log line and a health decision.
 */
export type PrLookup =
	| { found: true; pr: PrRef }
	| { found: false; reason: "no-pr" }
	| { found: false; reason: "error"; failure: ExecFailure };

export type LookupOptions = { timeoutMs?: number };

const timeout = (options?: LookupOptions) => options?.timeoutMs ?? READ_TIMEOUT_MS;

/**
 * Shallow on purpose: that `number` is a number and `state` is a string, if present. A payload that
 * is not an object at all (an error page, `null`) is caught, while a routine field added by some
 * future `gh` keeps working.
 */
const PR_REF_SCHEMA: Schema = {
	type: "object",
	properties: {
		number: { anyOf: [{ type: "number" }, { type: "null" }] },
		state: { anyOf: [{ type: "string" }, { type: "null" }] },
	},
};

type PrPayload = { number?: number | null; state?: string | null };

function toPrLookup(res: ExecResult<PrPayload>): PrLookup {
	if (res.ok) {
		const { number, state } = res.data;
		if (typeof number === "number" && number > 0) {
			return { found: true, pr: { number, state: typeof state === "string" ? state.toUpperCase() : undefined } };
		}
		// gh returned an object with no PR in it: that is the "no PR" answer, not a broken gh.
		return { found: false, reason: "no-pr" };
	}
	// `gh` says "no pull requests found" by exiting non-zero, so a non-zero exit is only "no PR" when
	// it says so. `failureText` rather than `stderr` because the reason has to survive being matched.
	if (isNoPullRequestFailure(failureText(res))) return { found: false, reason: "no-pr" };
	return { found: false, reason: "error", failure: res };
}

/** `git rev-parse --show-toplevel`, resolved to the repository root. */
export async function repoRoot(cwd: string, options?: LookupOptions): Promise<Lookup<string | undefined>> {
	const res = await runText("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: timeout(options) });
	return res.ok ? { ok: true, value: res.data || undefined } : { ok: false, failure: res };
}

/**
 * The checked-out branch, or `undefined` on a detached HEAD.
 *
 * Detached is not a failure and not the empty string the old call sites used to pass downstream: a
 * worktree left detached by a checkout of a SHA has no branch to look a PR up for, and saying so with
 * a type is what stops `gh pr view ""` from becoming the probe.
 */
export async function checkedOutBranch(cwd: string, options?: LookupOptions): Promise<Lookup<string | undefined>> {
	const res = await runText("git", ["branch", "--show-current"], { cwd, timeoutMs: timeout(options) });
	return res.ok ? { ok: true, value: res.data || undefined } : { ok: false, failure: res };
}

/**
 * `git rev-parse --abbrev-ref HEAD` - names a branch where `branch --show-current` goes quiet, which
 * is what a worktree lineage needs (it forks branch names off whatever HEAD points at). The literal
 * `"HEAD"` git returns when detached is normalised away here rather than being every caller's
 * string comparison to remember.
 */
export async function headRef(cwd: string, options?: LookupOptions): Promise<Lookup<string | undefined>> {
	const res = await runText("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: timeout(options) });
	if (!res.ok) return { ok: false, failure: res };
	return { ok: true, value: res.data && res.data !== "HEAD" ? res.data : undefined };
}

/** The PR for one branch. */
export async function prForBranch(branch: string, cwd: string, options?: LookupOptions): Promise<PrLookup> {
	const res = await runJson<PrPayload>("gh", ["pr", "view", branch, "--json", "number,state"], {
		cwd,
		timeoutMs: timeout(options),
		schema: PR_REF_SCHEMA,
	});
	return toPrLookup(res);
}

/** The PR for whatever branch this folder has checked out (no branch selector). */
export async function prForCurrentBranch(cwd: string, options?: LookupOptions): Promise<PrLookup> {
	const res = await runJson<PrPayload>("gh", ["pr", "view", "--json", "number,state"], {
		cwd,
		timeoutMs: timeout(options),
		schema: PR_REF_SCHEMA,
	});
	return toPrLookup(res);
}

/**
 * The repository's name as a worktree lineage would use it: the directory holding the shared git dir
 * (so a linked worktree reports the main repository, not its own folder), falling back to the
 * worktree root and then to the folder we were given.
 */
export async function repoName(cwd: string, options?: LookupOptions): Promise<string> {
	const commonDir = await runText("git", ["rev-parse", "--git-common-dir"], { cwd, timeoutMs: timeout(options) });
	if (commonDir.ok && commonDir.data) {
		const gitDir = path.isAbsolute(commonDir.data) ? commonDir.data : path.resolve(cwd, commonDir.data);
		const name = path.basename(path.dirname(gitDir));
		if (name) return name;
	}
	const toplevel = await repoRoot(cwd, options);
	if (toplevel.ok && toplevel.value) return path.basename(toplevel.value);
	return path.basename(cwd);
}

/**
 * Branch names matching a `git branch --list` pattern, with the worktree markers (`*`, `+`) stripped.
 *
 * The failure is reported rather than turned into an empty list: a caller that cannot see the branches
 * has to say it is guessing, because two provisionings that both guess "index 1" collide on the same
 * branch name, and an empty list looks exactly like "no worktrees yet".
 */
export async function branchNames(cwd: string, pattern: string, options?: LookupOptions): Promise<Lookup<string[]>> {
	const res = await runText("git", ["branch", "--list", pattern], { cwd, timeoutMs: timeout(options) });
	if (!res.ok) return { ok: false, failure: res };
	return {
		ok: true,
		value: res.data
			.split("\n")
			.map((line) => line.trim().replace(/^[*+]\s*/, ""))
			.filter(Boolean),
	};
}
