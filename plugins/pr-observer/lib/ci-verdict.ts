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
	 * What this observer saw with its own run watchers: runs that completed and runs that failed.
	 * Only consulted when GitHub reported *no* check runs (`gh pr checks` answers `[]`), where it is
	 * the remaining evidence - never when the call itself failed.
	 */
	bookkeeping?: { completed: number; failed: number };
}

/**
 * `"passed"` only when every reported check passed and the checks call itself succeeded.
 * Anything in flight, an unusable payload, or a failed call is `"unknown"` - never a pass.
 */
export function evaluateCiVerdict({ checks, ghFailed, bookkeeping }: CiVerdictInput): CiVerdict {
	if (ghFailed) return "unknown";
	if (!Array.isArray(checks)) return "unknown";

	if (checks.length === 0) {
		// GitHub reported no check runs at all. The observer's own run bookkeeping is then the only
		// evidence: a run it watched to completion, with nothing failed, is a pass. This branch is
		// unreachable when the call failed - that is the false green this file exists to prevent.
		return bookkeeping && bookkeeping.completed > 0 && bookkeeping.failed === 0 ? "passed" : "unknown";
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
	if (
		checks.every(
			(row) => PASSED_BUCKETS.includes(bucketOf(row)) || PASSED_STATES.includes(stateOf(row).toUpperCase()),
		)
	) {
		return "passed";
	}
	// Rows in a shape we do not understand: say nothing rather than guess.
	return "unknown";
}
