// Run with: node --test test/test-ci-verdict.ts
import { test } from "node:test";
import * as assert from "node:assert";
import { commonRunSha, evaluateCiVerdict } from "../extensions/lib/ci-verdict.ts";

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

test("an empty check list falls back to run bookkeeping only for the commit it was recorded on", () => {
	// `gh pr checks` answers [] when the PR reports no check runs; a run watched to completion with
	// nothing failed is then the only evidence - and it is evidence about ITS commit. A push while the
	// observer keeps watching must not let the old green pass over the new head.
	assert.strictEqual(
		evaluateCiVerdict({
			checks: [],
			ghFailed: false,
			headSha: "aaa",
			bookkeeping: { completed: 1, failed: 0, sha: "aaa" },
		}),
		"passed",
	);
	assert.strictEqual(
		evaluateCiVerdict({
			checks: [],
			ghFailed: false,
			headSha: "bbb",
			bookkeeping: { completed: 3, failed: 0, sha: "aaa" },
		}),
		"unknown",
	);
	// An empty check list with no head sha to compare against (the first poll has not landed, e.g.
	// right after a resume) stays unknown: the next poll either supplies a match or does not.
	assert.strictEqual(evaluateCiVerdict({ checks: [], ghFailed: false, bookkeeping: { completed: 3, failed: 0, sha: "aaa" } }), "unknown");
	// Undated bookkeeping - a run recorded before commits were tracked, restored from disk.
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: false, headSha: "aaa", bookkeeping: { completed: 1, failed: 0 } }),
		"unknown",
	);
	// No completed run, or a failed one, is still not a pass.
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: false, headSha: "aaa", bookkeeping: { completed: 0, failed: 0, sha: "aaa" } }),
		"unknown",
	);
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: false, headSha: "aaa", bookkeeping: { completed: 2, failed: 1, sha: "aaa" } }),
		"unknown",
	);
	// ...and never while the checks call itself failed: the original false green.
	assert.strictEqual(
		evaluateCiVerdict({ checks: [], ghFailed: true, headSha: "aaa", bookkeeping: { completed: 3, failed: 0, sha: "aaa" } }),
		"unknown",
	);
});

test("bookkeeping trusts a commit only when every completed run agrees on it", () => {
	assert.strictEqual(commonRunSha(["aaa", "aaa"]), "aaa");
	// Two commits among the completed runs: no single commit can be called green.
	assert.strictEqual(commonRunSha(["aaa", "bbb"]), undefined);
	// A run with no recorded commit (restored from an older state) poisons the claim.
	assert.strictEqual(commonRunSha(["aaa", undefined]), undefined);
	assert.strictEqual(commonRunSha(["aaa", ""]), undefined);
	// Nothing completed: nothing to trust.
	assert.strictEqual(commonRunSha([]), undefined);
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
