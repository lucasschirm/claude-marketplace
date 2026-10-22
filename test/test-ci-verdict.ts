// Run with: node --test test/test-ci-verdict.ts
import { test } from "node:test";
import * as assert from "node:assert";
import { bookkeepingAtHead, evaluateCiVerdict } from "../extensions/lib/ci-verdict.ts";

const green = [
	{ bucket: "pass", state: "SUCCESS" },
	{ bucket: "skipping", state: "SKIPPED" },
];

test("a failed gh pr checks call is never a pass", () => {
	// The regression this guards: gh exits non-zero (HTTP 502, rate limit, timeout) after some run
	// had already completed, and the observer announced "All CI passed" from the fallback branch.
	assert.strictEqual(evaluateCiVerdict({ checks: [], ghFailed: true }), "unknown");
	assert.strictEqual(evaluateCiVerdict({ checks: green, ghFailed: true }), "unknown");
	assert.strictEqual(evaluateCiVerdict({ checks: undefined, ghFailed: true }), "unknown");
});

test("a payload that is not a check list is never a pass", () => {
	assert.strictEqual(evaluateCiVerdict({ checks: null, ghFailed: false }), "unknown");
	assert.strictEqual(evaluateCiVerdict({ checks: {}, ghFailed: false }), "unknown");
	assert.strictEqual(evaluateCiVerdict({ checks: "not json", ghFailed: false }), "unknown");
});

test("an empty check list falls back to head-scoped bookkeeping only", () => {
	// `gh pr checks` answers [] when the PR reports no check runs; a run watched to completion with
	// nothing failed is then the only evidence - and it is evidence about ITS commit. A push while the
	// observer keeps watching must not let the old green pass over the new head.
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: false, headSha: "aaa", bookkeeping: { completed: 1, failed: 0 } }),
		"passed",
	);
	// A caller that hands over unscoped counts and no head gets nothing.
	assert.strictEqual(evaluateCiVerdict({ checks: [], ghFailed: false, bookkeeping: { completed: 3, failed: 0 } }), "unknown");
	assert.strictEqual(evaluateCiVerdict({ checks: [], ghFailed: false, headSha: "", bookkeeping: { completed: 3, failed: 0 } }), "unknown");
	// Nothing completed for the head, or something failed for it: not a pass.
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: false, headSha: "aaa", bookkeeping: { completed: 0, failed: 0 } }),
		"unknown",
	);
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: false, headSha: "aaa", bookkeeping: { completed: 2, failed: 1 } }),
		"unknown",
	);
	// ...and never while the checks call itself failed: the original false green.
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: true, headSha: "aaa", bookkeeping: { completed: 3, failed: 0 } }),
		"unknown",
	);
});

test("bookkeeping only counts the runs recorded for the commit being polled", () => {
	// A green run on aaa is not evidence about bbb: the observer keeps watching across pushes, and the
	// push may never have been built.
	assert.deepStrictEqual(bookkeepingAtHead("bbb", [{ sha: "aaa" }]), undefined);
	assert.deepStrictEqual(bookkeepingAtHead("bbb", [{ sha: "aaa" }, { sha: "bbb" }]), { completed: 1, failed: 0 });
	// The other direction, which is what the first version of this got wrong: completedRuns accumulates
	// across pushes, so a red run on an older commit must not strand a legitimately green head for the
	// rest of the observation.
	assert.deepStrictEqual(bookkeepingAtHead("bbb", [{ sha: "aaa", failed: true }, { sha: "bbb" }]), { completed: 1, failed: 0 });
	assert.deepStrictEqual(bookkeepingAtHead("bbb", [{ sha: "bbb", failed: true }, { sha: "bbb" }]), { completed: 1, failed: 1 });
	// A run with no recorded commit (restored from a state file written before commits were tracked) is
	// not evidence about anything.
	assert.deepStrictEqual(bookkeepingAtHead("aaa", [{ sha: undefined }]), undefined);
	assert.deepStrictEqual(bookkeepingAtHead("aaa", [{ sha: "aaa" }, { sha: "" }]), { completed: 1, failed: 0 });
	// Unknown head: nothing is attributable, so nothing may be announced.
	assert.deepStrictEqual(bookkeepingAtHead(undefined, [{ sha: "aaa" }]), undefined);
	assert.deepStrictEqual(bookkeepingAtHead("", [{ sha: "aaa" }]), undefined);
	// No runs at all.
	assert.deepStrictEqual(bookkeepingAtHead("aaa", []), undefined);
	// Junk entries are ignored rather than thrown over.
	assert.deepStrictEqual(bookkeepingAtHead("aaa", [undefined as any, null as any, { sha: "aaa" }]), { completed: 1, failed: 0 });
});

test("a run recorded for an older commit neither passes nor strands the head", () => {
	const history = [{ sha: "aaa" }, { sha: "bbb" }];
	const head = "bbb";
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: false, headSha: head, bookkeeping: bookkeepingAtHead(head, history) }),
		"passed",
	);
	const stranded = [{ sha: "aaa", failed: true }, { sha: "bbb" }];
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: false, headSha: head, bookkeeping: bookkeepingAtHead(head, stranded) }),
		"passed",
	);
	// Same history, one commit older: the aaa green is not about it.
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: false, headSha: "ccc", bookkeeping: bookkeepingAtHead("ccc", history) }),
		"unknown",
	);
});

test("every check green and a successful call is a pass", () => {
	assert.strictEqual(evaluateCiVerdict({ checks: green, ghFailed: false }), "passed");
	assert.strictEqual(evaluateCiVerdict({ checks: [{ bucket: "pass", conclusion: "SUCCESS" }], ghFailed: false }), "passed");
});

test("a failed or cancelled check is reported as failed", () => {
	assert.strictEqual(evaluateCiVerdict({ checks: [...green, { bucket: "fail", state: "FAILURE" }], ghFailed: false }), "failed");
	assert.strictEqual(evaluateCiVerdict({ checks: [{ state: "CANCELLED" }], ghFailed: false }), "failed");
	assert.strictEqual(evaluateCiVerdict({ checks: [{ state: "ACTION_REQUIRED" }], ghFailed: false }), "failed");
});

test("anything still in flight is unknown, not passed", () => {
	assert.strictEqual(evaluateCiVerdict({ checks: [...green, { bucket: "pending", state: "PENDING" }], ghFailed: false }), "unknown");
	assert.strictEqual(evaluateCiVerdict({ checks: [{ state: "IN_PROGRESS" }], ghFailed: false }), "unknown");
});

test("rows in an unrecognised shape are unknown, and rows may be any JSON value", () => {
	assert.strictEqual(evaluateCiVerdict({ checks: [{ bucket: "weird", state: "MYSTERY" }], ghFailed: false }), "unknown");
	// A malformed row must not throw out of the poll loop.
	assert.strictEqual(evaluateCiVerdict({ checks: [null, 7, "x", { bucket: "pass" }], ghFailed: false }), "unknown");
});
