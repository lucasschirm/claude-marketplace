// Run with: node --test test/test-mergeability.ts
import { test } from "node:test";
import * as assert from "node:assert";
import { classifyMergeability, mergeabilityAnnouncement } from "../extensions/lib/mergeability.ts";

test("a conflicting PR is classified, from either field", () => {
	assert.strictEqual(classifyMergeability({ mergeable: "CONFLICTING" }), "conflicting");
	assert.strictEqual(classifyMergeability({ mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" }), "conflicting");
	// Both fields, the shape the poll actually asks for.
	assert.strictEqual(classifyMergeability({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }), "conflicting");
});

test("BEHIND is reported, but a conflict is the harder problem and wins", () => {
	assert.strictEqual(classifyMergeability({ mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" }), "behind");
	assert.strictEqual(classifyMergeability({ mergeable: "CONFLICTING", mergeStateStatus: "BEHIND" }), "conflicting");
});

test("a landable PR is mergeable", () => {
	assert.strictEqual(classifyMergeability({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }), "mergeable");
	// A required check failing or a branch protection rule is not a mergeability problem: the PR
	// merges cleanly once CI passes / approvals land, and CI has its own announcer.
	assert.strictEqual(classifyMergeability({ mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE" }), "mergeable");
	assert.strictEqual(classifyMergeability({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }), "mergeable");
	assert.strictEqual(classifyMergeability({ mergeable: "MERGEABLE", mergeStateStatus: "HAS_HOOKS" }), "mergeable");
	assert.strictEqual(classifyMergeability({ mergeable: "MERGEABLE" }), "mergeable");
	assert.strictEqual(classifyMergeability({ mergeStateStatus: "CLEAN" }), "mergeable");
});

test("UNKNOWN and missing fields carry no information (the caller keeps its last-seen state)", () => {
	// GitHub answers UNKNOWN while it recomputes after every push to the head or the base; reading
	// that as a transition would announce a phantom conflict or clear a real one.
	assert.strictEqual(classifyMergeability({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }), undefined);
	assert.strictEqual(classifyMergeability({}), undefined);
	assert.strictEqual(classifyMergeability({ mergeable: null, mergeStateStatus: null }), undefined);
	assert.strictEqual(classifyMergeability(undefined), undefined);
	assert.strictEqual(classifyMergeability(null), undefined);
	// An older gh, or a payload of the wrong shape entirely: still no information.
	assert.strictEqual(classifyMergeability({ mergeable: 3, mergeStateStatus: true } as never), undefined);
	// The REST-style alias is accepted too, though gh never emits it.
	assert.strictEqual(classifyMergeability({ mergeable: "MERGEABLE", mergeableState: "BEHIND" }), "behind");
});

test("the announcements name the state and what to do about it", () => {
	assert.match(mergeabilityAnnouncement(33, "conflicting"), /PR 33 .*conflicts/);
	assert.match(mergeabilityAnnouncement(33, "conflicting"), /Rebase|merge the base/);
	assert.match(mergeabilityAnnouncement(33, "behind"), /PR 33/);
	assert.match(mergeabilityAnnouncement(33, "behind"), /moved ahead/);
});
