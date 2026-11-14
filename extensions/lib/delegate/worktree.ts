// Provisioning and releasing the git worktree a delegated session runs in.
//
// Two paths, and the order between them is not negotiable: orca first (it owns the workspace registry
// and knows about parents/children), `git worktree add` as the fallback when orca is absent or refuses.
// The orca reply has to be read even on a non-zero exit — orca answers `{"ok": false, …}` on stdout and
// exits 1 — and "exited non-zero with a body that does not say `ok: true`" is not a claim that a folder
// exists. That distinction is a review finding on `3801bb3`, where an envelope saying nothing handed
// back a directory that was never created.
//
// Everything here goes through the exec door (`lib/exec.ts`) with a stated budget: `git worktree add`
// on a large repository legitimately takes minutes, and before the door a git blocked on a locked index
// held provisioning open forever.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { failureText, MUTATION_TIMEOUT_MS, READ_TIMEOUT_MS, runJson, runText } from "../exec.ts";
import type { Schema } from "../exec-payload.ts";
import { branchNames, headRef, repoName } from "../git-repo.ts";
import { checkWorktreeSafety, removeOrcaWorktree } from "../orca-client.ts";
import { stripAnsi } from "./diagnostics.ts";
import type { DelegateRuntime } from "./runtime.ts";
import type { SessionMeta } from "./types.ts";

/** `git worktree add` is heavier than a request: checking out a large repository takes minutes. */
export const WORKTREE_ADD_TIMEOUT_MS = 10 * 60_000;

/** orca answers every `worktree create` with `{ok, result?, error?}` on stdout — including when it failed. */
const ORCA_WORKTREE_REPLY: Schema = {
	type: "object",
	properties: {
		ok: { type: "boolean" },
		result: { anyOf: [{ type: "null" }, { type: "object" }] },
		error: { anyOf: [{ type: "null" }, { type: "string" }, { type: "object" }] },
	},
};

interface OrcaWorktreeReply {
	ok?: boolean;
	result?: { worktree?: { path?: string; id?: string; parentWorktreeId?: string } };
	error?: string | { message?: string };
}

export interface Worktree {
	worktreePath: string;
	worktreeBranch: string;
	worktreeId?: string;
	parentWorktreeId?: string;
}

async function gitBranch(cwd: string): Promise<string> {
	const res = await headRef(cwd, { timeoutMs: READ_TIMEOUT_MS });
	return (res.ok && res.value) || "main";
}

/** Next free `-dtN` index above `baseBranch`. */
async function nextWorktreeIndex(rt: DelegateRuntime, cwd: string, baseBranch: string): Promise<number> {
	const listed = await branchNames(cwd, `${baseBranch}-dt*`, { timeoutMs: READ_TIMEOUT_MS });
	if (listed.ok) {
		const indices: number[] = [];
		const escapedBase = baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const reg = new RegExp(`^${escapedBase}-dt(\\d+)$`);
		for (const line of listed.value) {
			const match = line.match(reg);
			if (match) {
				indices.push(Number.parseInt(match[1], 10));
			}
		}
		return indices.length > 0 ? Math.max(...indices) + 1 : 1;
	}
	// "I cannot see the branches" is answered as "start at 1", which is what it always was. Worth
	// knowing it is a guess, because two provisionings that both guess 1 collide on the branch name —
	// hence a listing that reports a reason instead of an empty list, which would look identical here.
	rt.logWarn(`Could not list ${baseBranch}-dt* branches (${failureText(listed.failure)}); guessing worktree index 1`);
	return 1;
}

/**
 * Create `<base>-dt<N>` under `~/orca/workspaces/<repo>/<branch>` and say where it landed.
 *
 * The loop skips an existing folder rather than reusing it: a timed-out `git worktree add` can leave a
 * half-written directory and a taken branch name, and the next index is a clean start where retrying
 * into the same half-state is not.
 */
export async function createWorktree(rt: DelegateRuntime, cwd: string): Promise<Worktree> {
	const currentBranch = await gitBranch(cwd);
	const baseBranch = currentBranch.replace(/^refs\/heads\//, "");
	let index = await nextWorktreeIndex(rt, cwd, baseBranch);
	const orcaAvailable = await rt.commandExists("orca");
	const repo = await repoName(cwd, { timeoutMs: READ_TIMEOUT_MS });

	while (true) {
		const targetBranch = `${baseBranch}-dt${index}`;
		const targetFolder = worktreeFolder(repo, targetBranch);

		if (fs.existsSync(targetFolder)) {
			index++;
			continue;
		}

		let orcaFailure: string | undefined;
		if (orcaAvailable) {
			const res = await runJson<OrcaWorktreeReply>(
				"orca",
				["worktree", "create", "--name", targetBranch, "--base-branch", baseBranch, "--json"],
				{ cwd, timeoutMs: MUTATION_TIMEOUT_MS, acceptJsonOnFailure: true, schema: ORCA_WORKTREE_REPLY },
			);
			const reply = res.ok ? res.data : undefined;
			// Only `ok: true` means "a worktree exists" once the process exited non-zero. On a zero exit an
			// absent `ok` stays accepted, because that is how this call has always been read; on a non-zero
			// exit it may not be, because before the door any non-zero exit threw and fell through to
			// `git worktree add`. An envelope that says nothing (`{}`, `{"message":"daemon error"}`) is not a
			// claim of success, and accepting it handed back a folder that was never created.
			const fromFailureBody = res.ok === true && res.fromFailureBody === true;
			if (reply && (fromFailureBody ? reply.ok === true : reply.ok !== false)) {
				return {
					worktreePath: reply.result?.worktree?.path || targetFolder,
					worktreeBranch: targetBranch,
					worktreeId: reply.result?.worktree?.id,
					parentWorktreeId: reply.result?.worktree?.parentWorktreeId,
				};
			}
			// Surface what orca actually said — its own `error` when it answered, the door's reason when
			// it did not — rather than a generic "Command failed", before falling back to git.
			// `stripAnsi` on both halves: these strings reach tool output and the TUI.
			orcaFailure = stripAnsi(
				(reply && (typeof reply.error === "string" ? reply.error : reply.error?.message)) ||
					(!res.ok ? failureText(res) : "") ||
					"orca worktree create failed",
			);
			rt.logWarn(`orca worktree create failed for ${targetBranch}, falling back to git: ${orcaFailure}`);
		}

		fs.mkdirSync(worktreeParent(repo), { recursive: true });
		const added = await runText("git", ["worktree", "add", "-b", targetBranch, targetFolder, baseBranch], {
			cwd,
			timeoutMs: WORKTREE_ADD_TIMEOUT_MS,
		});
		if (!added.ok) {
			const gitFailure = stripAnsi(failureText(added));
			throw new Error(orcaFailure ? `orca: ${orcaFailure}; git fallback: ${gitFailure}` : gitFailure);
		}
		return { worktreePath: targetFolder, worktreeBranch: targetBranch };
	}
}

/** `~/orca/workspaces/<repo>` — the layout orca itself uses, so a git-only fallback stays findable. */
function worktreeParent(repo: string): string {
	return path.join(os.homedir(), "orca", "workspaces", repo);
}

function worktreeFolder(repo: string, branch: string): string {
	return path.join(worktreeParent(repo), branch);
}

/**
 * Remove a session's worktree, unless it holds work that is not safe to lose.
 *
 * The safety check is not optional and not cached: an agent may have committed, pushed, opened a PR,
 * or left uncommitted edits, and only the first two are recoverable after `rm -rf`. An unknown answer
 * keeps the folder.
 */
/** Publish a folder as mid-release. Counted: see `DelegateRuntime.releasingWorktrees`. */
export function markWorktreeReleasing(rt: DelegateRuntime, worktreePath: string): void {
	rt.releasingWorktrees.set(worktreePath, (rt.releasingWorktrees.get(worktreePath) ?? 0) + 1);
}

/** Retire one publication; the folder stops being off-limits only when the last one goes. */
export function unmarkWorktreeReleasing(rt: DelegateRuntime, worktreePath: string): void {
	const left = (rt.releasingWorktrees.get(worktreePath) ?? 1) - 1;
	if (left > 0) {
		rt.releasingWorktrees.set(worktreePath, left);
	} else {
		rt.releasingWorktrees.delete(worktreePath);
	}
}

/** Whether this record's folder can take a restarted agent: there, not released, not on its way out. */
export function worktreeIsReusable(rt: DelegateRuntime, meta: SessionMeta): boolean {
	if (!meta.worktreePath) {
		return false;
	}
	return meta.worktreeStatus !== "released" && !rt.releasingWorktrees.has(meta.worktreePath) && fs.existsSync(meta.worktreePath);
}

/**
 * Release a worktree, published as in flight for as long as it takes.
 *
 * The seconds between "asked" and "gone" are the hazard: `worktreeStatus` stays "active" through the safety
 * check and the removal, so `delegate_restart` — whose own documented flow is "cancel it first" — reads the
 * folder as reusable and starts an agent in a directory that is about to be deleted. Only the primitive knows
 * when a release is running, so the primitive says so.
 */
export async function releaseWorktree(
	rt: DelegateRuntime,
	meta: SessionMeta,
	opts: { force?: boolean } = {},
): Promise<{ removed: boolean; note: string }> {
	if (!meta.worktreePath || meta.worktreeStatus === "released") {
		return releaseWorktreeNow(rt, meta, opts);
	}
	markWorktreeReleasing(rt, meta.worktreePath);
	try {
		return await releaseWorktreeNow(rt, meta, opts);
	} finally {
		unmarkWorktreeReleasing(rt, meta.worktreePath);
	}
}

async function releaseWorktreeNow(
	rt: DelegateRuntime,
	meta: SessionMeta,
	opts: { force?: boolean } = {},
): Promise<{ removed: boolean; note: string }> {
	if (!meta.worktreePath) {
		return { removed: false, note: "no worktree" };
	}
	if (meta.worktreeStatus === "released") {
		return { removed: false, note: "already released" };
	}

	if (opts.force !== true) {
		const safety = await checkWorktreeSafety(meta.worktreePath, meta.worktreeBranch, undefined, { timeoutMs: READ_TIMEOUT_MS });
		if (!safety.safe) {
			meta.worktreeStatus = "retained";
			rt.persistSessionMeta(meta, true);
			return { removed: false, note: `kept: ${safety.reason ?? "uncommitted or unpushed work"}` };
		}
	}
	// Forced is the caller asserting the work is disposable. It still goes in the log, because the
	// alternative is an untraceable deletion of somebody's uncommitted branch — and the tool result repeats
	// it, so a folder cannot be forced out of existence without that appearing somewhere a human will read.
	else {
		rt.logWarn(`force-releasing the worktree ${meta.worktreePath} of ${meta.sessionId} without the safety check`);
	}

	// orca addresses a worktree by its id when it has one, and by path otherwise. `force` is safe here
	// only because the check above already established there is nothing to lose.
	const selector = meta.worktreeId || `path:${meta.worktreePath}`;
	const rm = await removeOrcaWorktree(selector, { force: true });
	if (!rm.ok) {
		return { removed: false, note: `could not remove ${meta.worktreePath}: ${stripAnsi(rm.error?.message ?? "orca worktree rm failed")}` };
	}
	meta.worktreeStatus = "released";
	rt.persistSessionMeta(meta, true);
	return { removed: true, note: `removed ${meta.worktreePath}${opts.force === true ? " (forced: the safety check was skipped)" : ""}` };
}
