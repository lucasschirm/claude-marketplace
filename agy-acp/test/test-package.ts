// Run with: node --test agy-acp/test/test-package.ts
import * as assert from "node:assert";
import * as fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGY_ACP_VERSION } from "../src/main.ts";

const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as Record<string, unknown>;

test("the package has no runtime dependencies", () => {
	assert.ok(!("dependencies" in pkg), "agy-acp runs on Node built-ins only - dependencies must stay absent");
	assert.ok(!("devDependencies" in pkg), "devDependencies belong on the root package, not here");
});

test("the manifest shape the issue requires", () => {
	assert.strictEqual(pkg.name, "agy-acp");
	assert.strictEqual(pkg.type, "module");
	assert.deepStrictEqual(pkg.bin, { "agy-acp": "src/main.ts" });
	assert.strictEqual((pkg.engines as Record<string, unknown>).node, ">=23.6");
});

test("AGY_ACP_VERSION matches package.json", () => {
	assert.strictEqual(AGY_ACP_VERSION, pkg.version, "the version reported by initialize must not drift from the manifest");
});
