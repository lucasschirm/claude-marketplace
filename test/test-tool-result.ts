// Run with: node --test test/test-tool-result.ts
import { test } from "node:test";
import * as assert from "node:assert";
import { capList, err, ok, parseEnvKeys, DETAILS_LIST_CAP } from "../extensions/lib/tool-result.ts";

test("ok() returns model-facing text plus the structured details pi requires", () => {
	const res = ok("done", { tool: "demo", prNumber: 12 });
	assert.strictEqual(res.content.length, 1);
	// Field-wise: a whole-object compare would pass for any object with these fields.
	assert.strictEqual(res.content[0]?.type, "text");
	assert.strictEqual((res.content[0] as { text?: string }).text, "done");
	assert.deepStrictEqual(res.details, { tool: "demo", prNumber: 12 });
	assert.strictEqual(res.isError, undefined, "a success must not be flagged as an error");
});

test("err() marks the result as an error and carries a machine-readable code", () => {
	const res = err("nope", "NOT_FOUND", { conversationId: "1021" });
	assert.strictEqual(res.isError, true);
	assert.strictEqual((res.details as { code?: string }).code, "NOT_FOUND");
	assert.strictEqual((res.details as { conversationId?: string }).conversationId, "1021");
});

test("capList bounds an id list under the caller's own key and reports the cut", () => {
	const many = Array.from({ length: DETAILS_LIST_CAP + 5 }, (_, i) => `id-${i}`);
	const capped = capList("taskIds", many) as { taskIds: string[]; taskIdsTruncated: boolean };
	assert.strictEqual(capped.taskIds.length, DETAILS_LIST_CAP);
	assert.strictEqual(capped.taskIdsTruncated, true);

	const few = capList("taskIds", ["a"]) as { taskIds: string[]; taskIdsTruncated: boolean };
	assert.deepStrictEqual(few.taskIds, ["a"]);
	assert.strictEqual(few.taskIdsTruncated, false, "an empty or short list must not look truncated");
});

test("parseEnvKeys reports variable names and never their values", () => {
	const out = [
		"DB_HOST=localhost",
		"export DB_PORT=3306", // the .env form a shell would source
		"# a comment",
		"DB_PASSWORD=s3cr3t",
		"",
		"BAD LINE",
	].join("\n");
	const keys = parseEnvKeys(out);
	assert.deepStrictEqual(keys, ["DB_HOST", "DB_PORT", "DB_PASSWORD"]);
	assert.ok(!JSON.stringify(keys).includes("s3cr3t"), "values must never reach details");
});
