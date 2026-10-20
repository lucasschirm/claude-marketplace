// Run with: node --test test/test-ci-verdict.ts
import { test } from "node:test";
import * as assert from "node:assert";
import { evaluateCiVerdict } from "../extensions/lib/ci-verdict.ts";

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

test("an empty or unusable payload is never a pass", () => {
	assert.strictEqual(evaluateCiVerdict({ checks: [], ghFailed: false }), "unknown");
	assert.strictEqual(evaluateCiVerdict({ checks: null, ghFailed: false }), "unknown");
	assert.strictEqual(evaluateCiVerdict({ checks: {}, ghFailed: false }), "unknown");
	assert.strictEqual(evaluateCiVerdict({ checks: "not json", ghFailed: false }), "unknown");
});

test("every check green and a successful call is a pass", () => {
	assert.strictEqual(evaluateCiVerdict({ checks: green, ghFailed: false }), "passed");
	assert.strictEqual(
		evaluateCiVerdict({ checks: [{ bucket: "pass", conclusion: "SUCCESS" }], ghFailed: false }),
		"passed",
	);
});

test("a failed or cancelled check is reported as failed", () => {
	assert.strictEqual(
		evaluateCiVerdict({ checks: [...green, { bucket: "fail", state: "FAILURE" }], ghFailed: false }),
		"failed",
	);
	assert.strictEqual(evaluateCiVerdict({ checks: [{ state: "CANCELLED" }], ghFailed: false }), "failed");
	assert.strictEqual(evaluateCiVerdict({ checks: [{ state: "ACTION_REQUIRED" }], ghFailed: false }), "failed");
});

test("anything still in flight is unknown, not passed", () => {
	assert.strictEqual(
		evaluateCiVerdict({ checks: [...green, { bucket: "pending", state: "PENDING" }], ghFailed: false }),
		"unknown",
	);
	assert.strictEqual(evaluateCiVerdict({ checks: [{ state: "IN_PROGRESS" }], ghFailed: false }), "unknown");
});

test("rows in an unrecognised shape are unknown, and rows may be any JSON value", () => {
	assert.strictEqual(evaluateCiVerdict({ checks: [{ bucket: "weird", state: "MYSTERY" }], ghFailed: false }), "unknown");
	// A malformed row must not throw out of the poll loop.
	assert.strictEqual(evaluateCiVerdict({ checks: [null, 7, "x", { bucket: "pass" }], ghFailed: false }), "unknown");
});
