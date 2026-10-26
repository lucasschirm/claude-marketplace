// Run with: node --test agy-acp/test/test-main.ts
import * as assert from "node:assert";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGY_ACP_VERSION } from "../src/main.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Spawn `node src/main.ts`, feed it `input` on stdin, close stdin, and wait for exit. */
function run(args: string[], input?: string): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [MAIN, ...args], { stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		if (input !== undefined) child.stdin.write(input);
		child.stdin.end();
	});
}

const line = (msg: Record<string, unknown>) => `${JSON.stringify(msg)}\n`;

const initialize = (id: number, protocolVersion: unknown) =>
	line({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion, clientInfo: { name: "test", version: "0" } } });

test("initialize over stdio is answered, and stdin EOF exits 0", async () => {
	const res = await run([], initialize(1, 1));
	assert.strictEqual(res.code, 0, `stderr: ${res.stderr}`);
	const frames = res.stdout
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	assert.strictEqual(frames.length, 1, "stdout carries exactly the one protocol frame");
	const result = frames[0].result as Record<string, unknown>;
	assert.strictEqual(result.protocolVersion, 1);
	const caps = result.agentCapabilities as Record<string, unknown>;
	assert.strictEqual(caps.loadSession, false, "loadSession stays false until the resume sub-issue lands");
	const prompts = caps.promptCapabilities as Record<string, unknown>;
	assert.strictEqual(prompts.image, false);
	assert.strictEqual(prompts.audio, false);
	assert.deepStrictEqual(result.authMethods, []);
	assert.deepStrictEqual(result.agentInfo, { name: "agy-acp", version: AGY_ACP_VERSION });
});

test("an unsupported protocol version is rejected cleanly", async () => {
	for (const [i, version] of [99, 0, "latest", undefined].entries()) {
		const res = await run([], initialize(i + 1, version));
		assert.strictEqual(res.code, 0);
		const frame = JSON.parse(res.stdout.trim()) as { id: number; error: { code: number; message: string } };
		assert.strictEqual(frame.id, i + 1);
		assert.strictEqual(frame.error.code, -32602, `protocolVersion ${String(version)} must be invalid params`);
		assert.match(frame.error.message, /protocolVersion/);
	}
});

test("methods that are not implemented yet get -32601, not silence", async () => {
	const res = await run([], line({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }));
	assert.strictEqual(res.code, 0);
	const frame = JSON.parse(res.stdout.trim()) as { error: { code: number } };
	assert.strictEqual(frame.error.code, -32601);
});

test("--version prints the version and exits", async () => {
	const res = await run(["--version"]);
	assert.strictEqual(res.code, 0);
	assert.strictEqual(res.stdout.trim(), `agy-acp ${AGY_ACP_VERSION}`);
});

test("--help prints usage and exits", async () => {
	const res = await run(["--help"]);
	assert.strictEqual(res.code, 0);
	assert.match(res.stdout, /Usage:/);
});

test("an unknown argument exits non-zero without touching stdout", async () => {
	const res = await run(["--bogus"]);
	assert.strictEqual(res.code, 2);
	assert.strictEqual(res.stdout, "", "an error path must not write the protocol channel");
});
