// Run with: node --test test/test-exec.ts
import { after, test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { failureText, MUTATION_TIMEOUT_MS, READ_TIMEOUT_MS, runJson, runText, spawnLongLived } from "../extensions/lib/exec.ts";
import { type Schema, schemaErrors } from "../extensions/lib/exec-payload.ts";

const NODE = process.execPath;
/** Keeps a child alive past any timeout in these tests without a literal that breaks type stripping. */
const HANG = "setTimeout(() => {}, 30_000);";
const created: string[] = [];

after(() => {
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpdir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	created.push(dir);
	// macOS reports /tmp as a symlink: compare the resolved path, not the one handed back.
	return fs.realpathSync(dir);
}

/** A child that prints `body` and exits with `code`. */
function echoScript(body: string, code = 0): string {
	return `process.stdout.write(${JSON.stringify(body)}); process.exit(${code});`;
}

test("a JSON payload comes back as data", async () => {
	const res = await runJson<{ ok: boolean }>(NODE, ["-e", echoScript('{"ok":true}')]);
	assert.strictEqual(res.ok, true);
	if (res.ok) assert.strictEqual(res.data.ok, true);
});

test("unparseable output is a failure, never an empty success", async () => {
	const res = await runJson<{ workers?: unknown[] }>(NODE, ["-e", echoScript("Error: backend unreachable")]);
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "BAD_JSON");
	// The whole bug this door closes: a caller that used to see `undefined` and report "no workers".
	assert.strictEqual(res.data, undefined);
	assert.match(String(res.stdout), /backend unreachable/);
});

const WORKERS_SCHEMA: Schema = {
	type: "object",
	required: ["workers"],
	properties: { workers: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } },
};

test("a payload in the wrong shape names the path, not the payload", async () => {
	const schema = WORKERS_SCHEMA;
	const res = await runJson(NODE, ["-e", echoScript('{"workers":[{"id":null},{"id":"ok"},{"id":42}]}')], { schema });
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "BAD_SCHEMA");
	assert.match(String(res.message), /\/workers\/0\/id/);
	assert.match(String(res.message), /\/workers\/2\/id/);
	// Command output reaches tool results and sometimes a transcript: the values stay out of the message.
	assert.doesNotMatch(String(res.message), /"workers"/);
});

test("a payload that satisfies the schema is untouched data", async () => {
	const schema = WORKERS_SCHEMA;
	const res = await runJson<{ workers: Array<{ id: string }> }>(NODE, ["-e", echoScript('{"workers":[{"id":"a"}]}')], {
		schema,
	});
	assert.strictEqual(res.ok, true);
	if (res.ok) assert.strictEqual(res.data.workers[0].id, "a");
});

test("a call that never answers returns inside its timeout", async () => {
	const started = Date.now();
	const res = await runText(NODE, ["-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 200 });
	const elapsed = Date.now() - started;
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "TIMEOUT");
	assert.ok(elapsed < 5_000, `waited ${elapsed}ms for a timeout of 200ms`);
});

test("a missing binary is its own cause", async () => {
	const res = await runText("definitely-not-a-real-command-xyz", []);
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "NOT_FOUND");
});

test("a missing working directory is reported, not swallowed", async () => {
	const res = await runText(NODE, ["-e", echoScript('"ok"')], { cwd: "/nonexistent/nowhere-at-all" });
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "NOT_FOUND");
});

test("output over maxBuffer says the reader gave up", async () => {
	const res = await runText(NODE, ["-e", "process.stdout.write('x'.repeat(200_000))"], { maxBuffer: 1000 });
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "MAX_BUFFER");
	// The command succeeded; the reader gave up. Node discards what it had read, so the message has to say
	// what to do instead of looking like a crash.
	assert.match(res.message, /raise the limit/);
});

test("a non-zero exit carries its code and its own stderr", async () => {
	const res = await runJson(NODE, ["-e", "console.error('boom'); process.exit(3);"]);
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "EXIT");
	assert.strictEqual(res.exitCode, 3);
	assert.match(String(res.stderr), /boom/);
	// stderr is the useful half of a CLI failure, so it is what the message says.
	assert.match(res.message, /boom/);
});

test("a CLI that answers with JSON and exits non-zero is still an answer", async () => {
	const res = await runJson<{ ok: boolean; error: { code: string } }>(
		NODE,
		["-e", echoScript('{"ok":false,"error":{"code":"WORKER_BUSY"}}', 1)],
		{ acceptJsonOnFailure: true },
	);
	assert.strictEqual(res.ok, true);
	if (res.ok) assert.strictEqual(res.data.error.code, "WORKER_BUSY");
});

test("...but a non-zero exit with nothing parseable stays a failure", async () => {
	const res = await runJson(NODE, ["-e", "console.error('segfault-ish'); process.exit(7);"], { acceptJsonOnFailure: true });
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "EXIT");
	assert.strictEqual(res.exitCode, 7);
});

test("runText trims unless asked not to", async () => {
	const trimmed = await runText(NODE, ["-e", echoScript("  hello  \n")]);
	assert.strictEqual(trimmed.ok && trimmed.data, "hello");
	const raw = await runText(NODE, ["-e", echoScript("  hello  \n")], { trim: false });
	assert.strictEqual(raw.ok && raw.data, "  hello  \n");
});

test("env and cwd reach the child", async () => {
	const dir = tmpdir("exec-cwd-");
	const res = await runJson<{ cwd: string; marked: string; inherited: string | null }>(
		NODE,
		[
			"-e",
			`process.stdout.write(JSON.stringify({
				cwd: process.cwd(),
				marked: process.env.ZZ_EXEC_MARK ?? null,
				inherited: process.env.PATH ?? null,
			}))`,
		],
		{ cwd: dir, env: { ZZ_EXEC_MARK: "yes" } },
	);
	assert.strictEqual(res.ok, true);
	if (!res.ok) return;
	assert.strictEqual(res.data.cwd, dir);
	assert.strictEqual(res.data.marked, "yes");
	// Merged over process.env: a CLI that needs PATH must still have it.
	assert.strictEqual(typeof res.data.inherited, "string");
});

test("the measured defaults are the documented ones", () => {
	assert.strictEqual(READ_TIMEOUT_MS, 60_000);
	assert.strictEqual(MUTATION_TIMEOUT_MS, 120_000);
});

// ------------------------------------------------------------------ the shapes

test("a field the schema never mentions is not a violation", () => {
	// APIs add fields on a release schedule; a schema that failed on the day a CLI added `updatedAt`
	// would be a false alarm shipped as a reliability fix.
	const issues = schemaErrors(
		{ type: "object", required: ["id"], properties: { id: { type: "string" } } },
		{
			id: "a",
			updatedAt: "2026-01-01",
			nested: { anything: [1, 2] },
		},
	);
	assert.deepStrictEqual(issues, []);
});

test("a missing field is named by path", () => {
	assert.deepStrictEqual(schemaErrors(WORKERS_SCHEMA, { workers: [{}, { id: "ok" }] }), ['/workers/0: missing required "id"']);
	assert.deepStrictEqual(schemaErrors(WORKERS_SCHEMA, {}), ['/: missing required "workers"']);
});

test("an array of scalars reports the index", () => {
	assert.deepStrictEqual(schemaErrors({ type: "array", items: { type: "number" } }, [1, "two", 3]), ["/1: must be a number, got string"]);
});

test("null is not a string, and an explicit null branch is the way to allow it", () => {
	assert.match(schemaErrors({ type: "string" }, null)[0], /must be a string, got null/);
	assert.deepStrictEqual(schemaErrors({ anyOf: [{ type: "string" }, { type: "null" }] }, null), []);
});

test("an enum names the value it rejected", () => {
	const schema: Schema = { type: "string", enum: ["queued", "running"] };
	assert.deepStrictEqual(schemaErrors(schema, "paused"), ['/: "paused" is not one of queued|running']);
	assert.deepStrictEqual(schemaErrors(schema, "running"), []);
});

test("a keyword the validator does not implement throws instead of accepting everything", () => {
	// The silent failure worth guarding: a hand-written schema with `additionalProperties` (or a typo)
	// that validates every payload looks like a passing check and checks nothing.
	const bogus = { type: "object", additionalProperties: false } as unknown as Schema;
	assert.throws(() => schemaErrors(bogus, { any: "thing" }), /unsupported schema keyword/);
});

test("a JSON error body is lifted into the message of a failing exit", async () => {
	// `gh api graphql` answers with {"errors":[...]} on stdout and a non-zero exit. The reason is in the
	// body, and stdout is excerpted before a caller sees it - so the door lifts the messages now.
	const body = JSON.stringify({ errors: [{ message: "Could not resolve to a node with the global id of 'PRRT_x'" }] });
	const res = await runJson(NODE, ["-e", echoScript(body, 1)]);
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "EXIT");
	assert.match(res.message, /Could not resolve to a node/);
});

// ------------------------------------------------------------------ the session door

interface Stall {
	silentMs: number;
	openTools: string[];
}

/**
 * A child that says nothing at all: the shape a stalled `devin acp` session has. Thresholds are shrunk
 * to milliseconds so the suite does not wait 90 s for a policy it is not testing the number of.
 */
function silentSession(opts: { idleNoToolMs: number; idleWithToolMs: number; onStall: (info: Stall) => void }) {
	return spawnLongLived(NODE, ["-e", "setInterval(() => {}, 50)"], opts);
}

function waitFor(pred: () => boolean, ms = 4_000): Promise<void> {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (pred()) resolve();
			else if (Date.now() - started > ms) reject(new Error("condition not reached within budget"));
			else setTimeout(tick, 20);
		};
		tick();
	});
}

test("silence with no tool open is a notice, and never a kill", async () => {
	const stalls: Stall[] = [];
	const handle = silentSession({ idleNoToolMs: 150, idleWithToolMs: 60_000, onStall: (s) => stalls.push(s) });
	try {
		await waitFor(() => stalls.length > 0);
		assert.deepStrictEqual(stalls[0].openTools, []);
		// The distinction that matters: an agent that has gone quiet is still running. Killing it would
		// turn a slow turn into a lost delegation.
		assert.strictEqual(handle.child.exitCode, null);
		assert.strictEqual(handle.child.signalCode, null);
		// One notice per episode, not one per sample.
		const episodes = stalls.length;
		await new Promise((r) => setTimeout(r, 400));
		assert.strictEqual(stalls.length, episodes);
	} finally {
		handle.stop();
	}
});

test("an open tool call raises the allowance until it closes", async () => {
	const stalls: Stall[] = [];
	const handle = silentSession({ idleNoToolMs: 150, idleWithToolMs: 2_000, onStall: (s) => stalls.push(s) });
	try {
		handle.toolOpen("tool-a");
		handle.toolOpen("tool-b");
		// Long past the no-tool threshold, still silent, and nothing reported: the build is running.
		await new Promise((r) => setTimeout(r, 500));
		assert.deepStrictEqual(stalls, []);
		// Closing one tool must not re-arm the short threshold - two are still open.
		handle.toolClosed("tool-a");
		await new Promise((r) => setTimeout(r, 500));
		assert.deepStrictEqual(stalls, []);
		assert.deepStrictEqual(handle.openToolIds(), ["tool-b"]);
		// And when the notice does come it says which tools were open, which is what makes it actionable.
		await waitFor(() => stalls.length > 0, 4_000);
		assert.deepStrictEqual(stalls[0].openTools, ["tool-b"]);
	} finally {
		handle.stop();
	}
});

test("any line of output resets the clock and re-arms the notice", async () => {
	const stalls: Stall[] = [];
	const lines: string[] = [];
	const handle = spawnLongLived(
		NODE,
		["-e", "process.stdout.write('one\\ntwo\\n'); setTimeout(() => process.stdout.write('three\\n'), 300); setInterval(() => {}, 50);"],
		{
			idleNoToolMs: 200,
			idleWithToolMs: 60_000,
			onLine: (line) => lines.push(line),
			onStall: (s) => stalls.push(s),
		},
	);
	try {
		// Newline-delimited framing: a chunk can hold several messages or half of one.
		await waitFor(() => lines.length >= 2);
		assert.deepStrictEqual(lines.slice(0, 2), ["one", "two"]);
		assert.deepStrictEqual(stalls, []);
		await waitFor(() => lines.length === 3);
		assert.deepStrictEqual(lines, ["one", "two", "three"]);
		await waitFor(() => stalls.length > 0);
	} finally {
		handle.stop();
	}
});

test("stop() is the only thing besides its own exit that ends the session", async () => {
	const handle = silentSession({ idleNoToolMs: 100, idleWithToolMs: 60_000, onStall: () => {} });
	const exited = new Promise<void>((resolve) => handle.child.on("exit", () => resolve()));
	handle.stop();
	await exited;
	// Killed by a signal, so `exitCode` stays null and `signalCode` carries it: "the child is gone" is the
	// disjunction, and a check of either half alone would read a live process as a dead one.
	assert.ok(
		handle.child.exitCode !== null || handle.child.signalCode !== null,
		`child still running after stop(): exitCode=${String(handle.child.exitCode)} signalCode=${String(handle.child.signalCode)}`,
	);
	// A second stop must not throw on an already-dead child.
	handle.stop();
});

test("touch() counts as life even when the child says nothing", async () => {
	const stalls: Stall[] = [];
	const handle = silentSession({ idleNoToolMs: 300, idleWithToolMs: 60_000, onStall: (s) => stalls.push(s) });
	try {
		for (let i = 0; i < 12; i++) {
			await new Promise((r) => setTimeout(r, 60));
			handle.touch();
		}
		assert.ok(handle.silentMs() < 300, `silent for ${handle.silentMs()}ms while being touched every 60ms`);
		assert.deepStrictEqual(stalls, []);
	} finally {
		handle.stop();
	}
});

// Two review findings on PR #48, both about `acceptJsonOnFailure` reading more than it was owed. They are
// kept because each is a class: an excerpt used as a payload, and a fragment used as a verdict.

test("a failure envelope larger than the display excerpt still parses", async () => {
	// `stdout` on a failure is excerpted for display, and a body cut at 2048 characters plus an ellipsis
	// does not parse. So an Orca error envelope over 2 KB used to arrive as "the command exited with code
	// 1" with the structured error - the code the caller branches on - silently gone.
	const big = JSON.stringify({ ok: false, error: { code: "WORKER_BUSY", message: "x".repeat(4000) } });
	const res = await runJson<{ ok: boolean; error: { code: string } }>(NODE, ["-e", echoScript(big, 1)], {
		acceptJsonOnFailure: true,
	});
	assert.strictEqual(res.ok, true);
	if (!res.ok) return;
	assert.strictEqual(res.data.error.code, "WORKER_BUSY");
	// The flag is what lets a caller distinguish "the CLI says it worked" from "the CLI was reached".
	assert.strictEqual(res.fromFailureBody, true);
});

test("a child that wrote JSON and then hung is not a success", async () => {
	// A killed call has not answered anything. Parsing the fragment it left behind turned a TIMEOUT into
	// `{ ok: true }`, which is the one outcome a door must never produce.
	const res = await runJson(NODE, ["-e", `process.stdout.write('{"ok":true,"result":1}'); ${HANG}`], {
		timeoutMs: 200,
		acceptJsonOnFailure: true,
	});
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(res.code, "TIMEOUT");
});

test("failureText keeps the door's reason when the child also wrote to stderr", async () => {
	const res = await runText(NODE, ["-e", `process.stderr.write('warning: half a sentence\\n'); ${HANG}`], { timeoutMs: 200 });
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	const text = failureText(res);
	// "exceeded its timeout" is not decoration: `gh-health` matches availability on that sentence, so a
	// stderr-preferred rendering made a timed-out gh call unclassifiable - and a timed-out call is exactly
	// the one a caller must not treat as a per-PR error.
	assert.ok(text.includes("exceeded its timeout"), text);
	assert.ok(text.includes("warning: half a sentence"), text);
});

test("failureText does not say the same thing twice for a plain exit", async () => {
	const res = await runText(NODE, ["-e", "console.error('boom'); process.exit(3);"]);
	assert.strictEqual(res.ok, false);
	if (res.ok) return;
	assert.strictEqual(failureText(res).split("boom").length - 1, 1, failureText(res));
});
