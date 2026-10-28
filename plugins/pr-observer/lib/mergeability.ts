/**
 * Whether an open PR can land as things stand, read from the `mergeable`/`mergeableState` fields of
 * `gh pr view`. Extracted from the observer for the same reason as ci-verdict: the classification is
 * pure and is tested directly, and the caller only has to decide what a transition means.
 */
export type MergeabilityState = "conflicting" | "behind" | "mergeable";

/** The parsed `mergeable`/`mergeStateStatus` of `gh pr view --json mergeable,mergeStateStatus`. */
export interface MergeabilityPayload {
	mergeable?: string | null;
	/** gh's field name. `mergeableState` is accepted as an alias (REST-style naming) but gh never emits it. */
	mergeStateStatus?: string | null;
	mergeableState?: string | null;
}

/**
 * One of three states, or `undefined` when the payload carries no information.
 *
 * `undefined` is a real answer, not a gap: GitHub reports `mergeable: UNKNOWN` while it recomputes
 * (after every push to the head or the base), and an older `gh` may not return the fields at all.
 * The caller keeps its last-seen state across an `undefined` instead of treating it as a transition.
 */
export function classifyMergeability(payload: MergeabilityPayload | undefined | null): MergeabilityState | undefined {
	const mergeable = String(payload?.mergeable ?? "").toUpperCase();
	const state = String(payload?.mergeStateStatus ?? payload?.mergeableState ?? "").toUpperCase();
	// DIRTY is the mergeableState of a conflicting PR, so it is checked before BEHIND: a PR whose
	// base moved and whose merge now conflicts is reported as the conflict, the harder problem.
	if (mergeable === "CONFLICTING" || state === "DIRTY") return "conflicting";
	if (state === "BEHIND") return "behind";
	if (mergeable === "MERGEABLE" || state === "CLEAN" || state === "UNSTABLE" || state === "BLOCKED" || state === "HAS_HOOKS") {
		return "mergeable";
	}
	return undefined;
}

/** What the agent is told when the PR enters a state in which it cannot land as-is. */
export function mergeabilityAnnouncement(prNumber: number, state: Exclude<MergeabilityState, "mergeable">): string {
	if (state === "conflicting") {
		return (
			`The PR ${prNumber} now conflicts with its base branch (mergeable: CONFLICTING). ` +
			"Rebase or merge the base into the PR branch and resolve the conflicts before it can land; CI will need to run again afterwards."
		);
	}
	return (
		`The base branch of the PR ${prNumber} has moved ahead (mergeStateStatus: BEHIND). ` +
		"Rebase or merge the base into the PR branch before it can land."
	);
}
