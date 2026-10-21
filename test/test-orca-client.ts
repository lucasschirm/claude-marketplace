// Run with: node --test test/test-orca-client.ts
import { after, test } from "node:test";
import * as assert from "node:assert";
import { execOrca } from "../extensions/lib/orca-client.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const originalOrcaCmd = process.env.ORCA_CLI_COMMAND;
const created: string[] = [];

after(() => {
	// Never leave a fake `orca` resolvable: later suites in this process would exec it.
	if (originalOrcaCmd === undefined) delete process.env.ORCA_CLI_COMMAND;
	else process.env.ORCA_CLI_COMMAND = originalOrcaCmd;
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake `orca` CLI: `ORCA_CLI_COMMAND` is already honoured by resolveOrcaCmd(), so pointing it at a
 * script makes execOrca() testable without a live Orca backend. Lives in tmpdir, never in the repo.
 */
function fakeOrca(body: string, exitCode = 0): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-fake-"));
	created.push(dir);
	const file = path.join(dir, "orca");
	fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(body)}\nexit ${exitCode}\n`, { mode: 0o755 });
	process.env.ORCA_CLI_COMMAND = file;
	return dir;
}

const skipOnWindows = process.platform === "win32" ? { skip: "sh fixture" } : {};

test("output that is not JSON is a failure, not an empty success", skipOnWindows, async () => {
	fakeOrca("Error: orchestration backend unreachable");
	const res = await execOrca(["orchestration", "worker-list"]);
	assert.strictEqual(res.ok, false);
	assert.strictEqual(res.error?.code, "BAD_JSON");
	assert.match(String(res.error?.message), /not JSON/);
	// The raw text is kept (bounded) so the caller can show what the CLI actually said.
	assert.match(String((res.error?.details as { raw?: string })?.raw), /backend unreachable/);
});

test("expectText commands may return a non-JSON body as success", skipOnWindows, async () => {
	fakeOrca("  last lines of the worker terminal  ");
	const res = await execOrca(["orchestration", "worker-read", "--dispatch", "ctx_1"], { expectText: true });
	assert.strictEqual(res.ok, true);
	assert.strictEqual(res.result, "last lines of the worker terminal");
});

test("a valid envelope is parsed", skipOnWindows, async () => {
	fakeOrca('{"ok":true,"result":{"workers":[{"dispatchId":"ctx_1"}]}}');
	const res = await execOrca<{ workers: Array<{ dispatchId: string }> }>(["orchestration", "worker-list"]);
	assert.strictEqual(res.ok, true);
	assert.strictEqual(res.result?.workers?.[0]?.dispatchId, "ctx_1");
});

test("a failing exit without usable output stays EXEC_ERROR", skipOnWindows, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orca-fake-"));
	created.push(dir);
	const file = path.join(dir, "orca");
	fs.writeFileSync(file, '#!/bin/sh\necho "boom" >&2\nexit 3\n', { mode: 0o755 });
	process.env.ORCA_CLI_COMMAND = file;
	const res = await execOrca(["orchestration", "worker-list"]);
	assert.strictEqual(res.ok, false);
	assert.strictEqual(res.error?.code, "EXEC_ERROR");
	assert.match(String(res.error?.message), /boom/);
});
