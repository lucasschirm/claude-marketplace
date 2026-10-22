/**
 * The single honest answer to "did CI pass?", kept free of `gh` and of observer state so it can be
 * tested directly (the reason it was extracted: both fallback branches of `checkAllCIPassed` used to
 * announce "All CI passed" when the checks call had failed, which is the most expensive false green
 * an agent can be given).
 */
export type CiVerdict = "passed" | "failed" | "unknown";

const PENDING_STATES = ["PENDING", "IN_PROGRESS", "QUEUED"];
const FAILED_BUCKETS = ["fail", "cancel"];
const FAILED_STATES = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
const PASSED_BUCKETS = ["pass", "skipping"];
const PASSED_STATES = ["SUCCESS", "SKIPPED", "NEUTRAL"];

/** `gh pr checks --json bucket,state` rows are external input: a row may be any JSON value. */
function field(row: unknown, key: string): string {
	if (typeof row !== "object" || row === null) return "";
	const value = (row as Record<string, unknown>)[key];
	return value === undefined || value === null ? "" : String(value);
}

export interface CiVerdictInput {
	/** Parsed output of `gh pr checks --json bucket,state` (possibly `null`, possibly not an array). */
	checks: unknown;
	/** The checks call failed, timed out, or returned unparseable output: nothing is knowable. */
	ghFailed: boolean;
	/**
	 * What this observer saw with its own run watchers, **restricted to `headSha`** - build it with
	 * {@link bookkeepingAtHead}. Only consulted when GitHub reported *no* check runs
	 * (`gh pr checks` answers `[]`), where it is the remaining evidence - never when the call failed.
	 */
	bookkeeping?: CiBookkeeping;
	/**
	 * The commit the PR is at now, as reported by the poll (`gh pr view --json headRefOid`). The
	 * fallback compares it against `bookkeeping.sha`; if either is unknown the answer is "unknown".
	 */
	headSha?: string;
}

/**
 * `"passed"` only when every reported check passed and the checks call itself succeeded.
 * Anything in flight, an unusable payload, or a failed call is `"unknown"` - never a pass.
 */
export function evaluateCiVerdict({ checks, ghFailed, bookkeeping, headSha }: CiVerdictInput): CiVerdict {
	if (ghFailed) return "unknown";
	if (!Array.isArray(checks)) return "unknown";

	if (checks.length === 0) {
		// GitHub reported no check runs at all. The observer's own run bookkeeping is then the only
		// evidence: a run it watched to completion, with nothing failed, is a pass - but only for the
		// commit it ran on. The counts arrive already scoped to the head (bookkeepingAtHead); headSha is
		// required as well, so a caller that forgot to scope cannot pass. An unknown head - the first poll
		// has not landed, e.g. right after a resume - is "unknown", not a pass. This branch is
		// unreachable when the call failed: that is the false green this file exists to prevent.
		const trusted =
			bookkeeping !== undefined && bookkeeping.completed > 0 && bookkeeping.failed === 0 && headSha !== undefined && headSha !== "";
		return trusted ? "passed" : "unknown";
	}

	const stateOf = (row: unknown) => field(row, "state") || field(row, "status") || field(row, "conclusion");

	const bucketOf = (row: unknown) => field(row, "bucket").toLowerCase();

	// In flight first: a pending run is neither a pass nor a failure.
	if (checks.some((row) => bucketOf(row) === "pending" || PENDING_STATES.includes(stateOf(row).toUpperCase()))) {
		return "unknown";
	}
	if (checks.some((row) => FAILED_BUCKETS.includes(bucketOf(row)) || FAILED_STATES.includes(stateOf(row).toUpperCase()))) {
		return "failed";
	}
	if (checks.every((row) => PASSED_BUCKETS.includes(bucketOf(row)) || PASSED_STATES.includes(stateOf(row).toUpperCase()))) {
		return "passed";
	}
	// Rows in a shape we do not understand: say nothing rather than guess.
	return "unknown";
}

/** Counts of what the observer watched, for one commit. */
export interface CiBookkeeping {
	completed: number;
	failed: number;
}

/** One run the observer watched, and what it knew about that run. */
export interface ObservedRun {
	/** The commit the run was for (`gh run view --json headSha`). Unknown when gh did not report it. */
	sha?: string;
	/** The observer watched this run end badly. */
	failed?: boolean;
}

/**
 * The observer's run history restricted to the commit being polled.
 *
 * A run that finished on commit A is evidence about A and about nothing else: it cannot pass a push
 * that has never been built, and - the other direction, which matters just as much - a red run on A
 * must not strand a green head. So every run whose recorded commit is not `headSha` is ignored
 * rather than counted. Requiring all completed runs to share one commit instead would strand a
 * legitimately green PR for the rest of the observation, because `completedRuns` accumulates across
 * pushes.
 *
 * `undefined` (rather than zeros) when nothing is attributable: an unknown head, or runs recorded
 * before commits were tracked and restored from disk. "I do not know which commit that was" must not
 * be able to announce "All CI passed".
 */
export function bookkeepingAtHead(headSha: string | undefined, runs: Iterable<ObservedRun>): CiBookkeeping | undefined {
	if (typeof headSha !== "string" || headSha === "") return undefined;
	let completed = 0;
	let failed = 0;
	let attributed = 0;
	for (const run of runs) {
		if (!run || typeof run.sha !== "string" || run.sha !== headSha) continue;
		attributed++;
		if (run.failed) failed++;
		else completed++;
	}
	return attributed === 0 ? undefined : { completed, failed };
}
