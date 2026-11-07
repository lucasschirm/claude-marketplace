// Did the delegated session open a pull request?
//
// The answer goes into the completion notice, which is the only reason the delegating agent learns a
// PR exists without going and looking. Three outcomes matter and only two of them are quiet:
// "no PR for this branch" is ordinary and moves to the next candidate, "gh could not answer" is the
// reason a session ends up looking for a PR in the wrong folder, so it gets a line.

import { failureText, READ_TIMEOUT_MS } from "../exec.ts";
import { headRef, prForBranch, prForCurrentBranch } from "../git-repo.ts";
import type { DelegateRuntime } from "./runtime.ts";

/** The PR number this session's branch has, if one can be found at all. */
export async function detectPullRequest(rt: DelegateRuntime, cwd: string, branch?: string): Promise<number | undefined> {
	if (!(await rt.commandExists("gh"))) {
		return undefined;
	}

	// The branch actually checked out in `cwd` first (it may differ from the provisioned one after a
	// rebase or a manual checkout), then the branch we created.
	const candidates: string[] = [];
	const head = await headRef(cwd, { timeoutMs: READ_TIMEOUT_MS });
	if (head.ok && head.value) {
		candidates.push(head.value);
	}
	if (branch && !candidates.includes(branch)) {
		candidates.push(branch);
	}

	for (const b of candidates) {
		const res = await prForBranch(b, cwd, { timeoutMs: READ_TIMEOUT_MS });
		if (res.found) {
			return res.pr.number;
		}
		if (res.reason === "error") {
			rt.logWarn(`PR lookup for branch ${b} failed: ${failureText(res.failure)}`);
		}
	}

	// Fallback: ask from inside the directory, which works when the branch name is not what we named it.
	const current = await prForCurrentBranch(cwd, { timeoutMs: READ_TIMEOUT_MS });
	if (current.found) {
		return current.pr.number;
	}
	if (current.reason === "error") {
		rt.logWarn(`PR lookup for ${cwd} failed: ${failureText(current.failure)}`);
	}

	return undefined;
}
