// Driver tests: AgyProcess (src/agy/process.ts) against the fixture-replaying fake agy.
//
// Covers the acceptance list for the driver sub-issue:
//   probe returns the conversation_id; multi-turn and mid-turn queued input; SIGINT ->
//   interrupted; bad model -> exit 1 with no init; malformed input is fatal; the stderr tail is
//   captured; usage deltas are correct across two turns and across a resume; dispose() leaves no
//   child processes (the process group is listed after dispose); the version check.
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agyArgs, AgyProcess, checkAgyVersion, type AgyDriverEvent, type AgyExitInfo, type AgyProcessOptions } from "../src/agy-driver.ts";

const FAKE = fileURLToPath(new URL("./fake-agy.ts", import.meta.url));
const STREAM_DIR = fileURLToPath(new URL("./fixtures/stream", import.meta.url));

interface Meta {
	args?: string;
	inputLines?: string[];
	exitCode?: string;
}

function fixtureMeta(name: string): Meta {
	return JSON.parse(fs.readFileSync(path.join(STREAM_DIR, `${name}.meta.json`), "utf8")) as Meta;
}

function scenarioNames(): string[] {
	return fs
		.readdirSync(STREAM_DIR)
		.filter((f) => f.endsWith(".stdout.ndjson"))
		.map((f) => f.slice(0, -".stdout.ndjson".length))
		.sort();
}

function fixtureLines(name: string): string[] {
	return fs
		.readFileSync(path.join(STREAM_DIR, `${name}.stdout.ndjson`), "utf8")
		.split("\n")
		.filter((l) => l !== "");
}

/** The prompt text of a recorded input line (string content or a single text block). */
function promptOf(inputLine: string): string {
	const obj = JSON.parse(inputLine) as { message?: { content?: unknown } };
	const c = obj.message?.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c) && c.length > 0) {
		const first = c[0] as { type?: string; text?: string };
		if (first?.type === "text" && typeof first.text === "string") return first.text;
	}
	throw new Error(`cannot extract a prompt from: ${inputLine}`);
}

interface Handle {
	driver: AgyProcess;
	events: AgyDriverEvent[];
	exits: AgyExitInfo[];
}

function startDriver(fixture: string, options: Omit<AgyProcessOptions, "cwd" | "argvPrefix"> & { argvPrefix?: string[] }): Handle {
	const driver = new AgyProcess({
		cwd: process.cwd(),
		env: { ...process.env, FAKE_AGY_FIXTURE: fixture, FAKE_AGY_INIT_DELAY_MS: "5", FAKE_AGY_LINE_GAP_MS: "3" },
		...options,
		argvPrefix: options.argvPrefix ?? [process.execPath, FAKE],
	});
	const events: AgyDriverEvent[] = [];
	const exits: AgyExitInfo[] = [];
	driver.on("event", (e: AgyDriverEvent) => events.push(e));
	driver.on("exit", (e: AgyExitInfo) => exits.push(e));
	return { driver, events, exits };
}

function results(h: Handle): Extract<AgyDriverEvent, { event: "result" }>[] {
	return h.events.filter((e) => e.event === "result") as Extract<AgyDriverEvent, { event: "result" }>[];
}

async function waitFor<T>(what: string, timeoutMs: number, pred: () => T | false): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = pred();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** The pids of every process in the group led by pgid (Linux /proc scan). */
function processGroupMembers(pgid: number): number[] {
	const out: number[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (Number(fields[1]) === pgid) out.push(Number(entry));
		} catch {
			// the process went away while we were scanning - that is what we expect at the end
		}
	}
	return out;
}

/** Drives a fixture's recorded prompts, one per turn, and waits for the matching result. */
async function driveTurns(h: Handle, fixture: string): Promise<void> {
	const prompts = (fixtureMeta(fixture).inputLines ?? []).map((l) => promptOf(l));
	for (const prompt of prompts) {
		h.driver.send(prompt);
		const n = results(h).length + 1;
		await waitFor(`result ${n}`, 5000, () => results(h).length >= n);
	}
}

/** The prompt text of a recorded input line, or null when it carries no extractable prompt. */
function tryPromptOf(inputLine: string): string | null {
	try {
		return promptOf(inputLine);
	} catch {
		return null;
	}
}

function isUserLine(inputLine: string): boolean {
	try {
		return (JSON.parse(inputLine) as { event?: string }).event === "user";
	} catch {
		return false;
	}
}

function conversationIdOf(fixture: string): string | null {
	const init = fixtureLines(fixture).find((l) => l.startsWith('{"event":"init"'));
	const m = init?.match(/"conversation_id":"([^"]*)"/);
	return m ? m[1] : null;
}

function driverOptsFor(fixture: string): AgyProcessOptions {
	const meta = fixtureMeta(fixture);
	const args = (meta.args ?? "").split(/\s+/).filter(Boolean);
	const opts: AgyProcessOptions = { cwd: process.cwd(), model: "gemini-3.8-flash-low" };
	let i = 0;
	while (i < args.length) {
		const t = args[i];
		i++;
		if (t === "--model") {
			opts.model = args[i];
			i++;
		} else if (t === "--effort") {
			opts.effort = args[i];
			i++;
		} else if (t === "--conversation") {
			opts.conversation = args[i];
			i++;
		} else if (t === "--add-dir") {
			if (!opts.addDirs) opts.addDirs = [];
			opts.addDirs.push(args[i]);
			i++;
		} else if (t === "--dangerously-skip-permissions") opts.skipPermissions = true;
	}
	return opts;
}

/**
 * Every recorded scenario replays end-to-end through the driver: the probe gets the recorded
 * conversation id, each recorded (or placeholder, for the bridge scenarios that record no input
 * lines) user line advances a turn, SIGINT is delivered where the record ends interrupted, and
 * the exit code matches the record. The fake's flag validation means a drifted argv fails here.
 */
test("every fixture replays end-to-end through the driver", async () => {
	for (const fixture of scenarioNames()) await replayFixture(fixture);
});

/** Replay one recorded scenario through a real driver and check the recorded outcome. */
async function replayFixture(fixture: string): Promise<void> {
	const meta = fixtureMeta(fixture);
	const lines = fixtureLines(fixture);
	const nResults = lines.filter((l) => l.startsWith('{"event":"result"')).length;
	const hasInit = lines.some((l) => l.startsWith('{"event":"init"'));
	const interruptsEndTheRecord = lines[lines.length - 1]?.includes('"error":"interrupted"') ?? false;
	const inputLines = meta.inputLines ?? [];
	const sends: (string | undefined)[] = inputLines.length > 0 ? inputLines : Array.from({ length: nResults });
	const h = startDriver(fixture, driverOptsFor(fixture));
	try {
		if (hasInit) {
			assert.strictEqual(await h.driver.probe(2500), conversationIdOf(fixture), fixture);
		}
		for (const line of sends) {
			if (h.driver.exitInfo) break; // the record finished before needing more input
			sendRecordedLine(h, line);
			if (interruptsEndTheRecord && results(h).length < nResults) h.driver.interrupt();
			const expected = results(h).length + 1;
			// A non-user event (e.g. a recorded assistant line) cannot settle a turn; its fixture
			// has no result for this send, and the exit arrives when dispose() closes stdin.
			if (expected <= nResults) {
				await waitFor(`${fixture}: turn to settle`, 2500, () => h.driver.exitInfo !== null || results(h).length >= expected);
			}
		}
		await waitFor(`${fixture}: all results`, 5000, () => h.driver.exitInfo !== null || results(h).length >= nResults);
		const exit = await h.driver.dispose();
		assert.strictEqual(exit.code, Number(meta.exitCode ?? "0"), `${fixture}: exit code`);
	} finally {
		await h.driver.dispose();
	}
}

/** Feed one recorded (or placeholder) input line to the driver in the shape the record used. */
function sendRecordedLine(h: Handle, line: string | undefined): void {
	if (typeof line === "string" && isUserLine(line)) {
		const prompt = tryPromptOf(line);
		if (prompt !== null) h.driver.send(prompt);
		else h.driver.sendRaw(line); // e.g. {"event":"user"} with no message: the exact recorded line
	} else if (typeof line === "string") {
		h.driver.sendRaw(line); // a recorded control input (malformed or unknown event)
	} else {
		h.driver.send("(agy-acp replay: placeholder turn)"); // bridge scenarios record no input lines
	}
}
test("probe() returns the conversation_id without a model turn", async () => {
	const h = startDriver("input-event-bogus", { model: "gemini-3.8-flash-low" });
	try {
		const id = await h.driver.probe(3000);
		assert.strictEqual(id, "e39db77a-ee74-4789-aa31-12ce92698c54", "the id from the recorded init");
		const init = h.events.find((e) => e.event === "init");
		assert.ok(init, "the driver emitted the init event");
		if (init && init.event === "init") {
			assert.strictEqual(init.conversation_id, id);
			assert.strictEqual(init.init.model, "gemini-3.8-flash-low");
		}
		const exit = await h.driver.dispose();
		assert.strictEqual(exit.code, 0, "the fixture's recorded exit code");
	} finally {
		await h.driver.dispose();
	}
});

test("multi-turn: three recorded turns, per-turn usage deltas, exit 0", async () => {
	const h = startDriver("simple-multiturn-textblocks", { model: "gemini-3.8-flash-low" });
	try {
		const id = await h.driver.probe(3000);
		assert.strictEqual(id, "082c098f-2c40-438a-a000-6e0f83f234da");
		await driveTurns(h, "simple-multiturn-textblocks");
		const rs = results(h);
		assert.strictEqual(rs.length, 3);
		assert.deepStrictEqual(
			rs.map((r) => r.result.response),
			["PONG\n", "OK\n", "ZEBRA\n"],
		);
		// Deltas: each turn reports num_turns 1; cumulative counters keep climbing.
		assert.deepStrictEqual(
			rs.map((r) => r.result.num_turns),
			[1, 1, 1],
		);
		assert.deepStrictEqual(
			rs.map((r) => r.result.cumulative.num_turns),
			[1, 2, 3],
		);
		const last = rs[rs.length - 1];
		assert.strictEqual(last.result.cumulative.usage.total_tokens, 21958);
		const sumInput = rs.reduce((acc, r) => acc + r.result.usage.input_tokens, 0);
		assert.strictEqual(sumInput, last.result.cumulative.usage.input_tokens, "deltas sum to the cumulative");
		const exit = await h.driver.dispose();
		assert.strictEqual(exit.code, 0);
	} finally {
		await h.driver.dispose();
	}
});

test("mid-turn input is queued by agy and becomes the next turn", async () => {
	const h = startDriver("midturn-message-queued", { model: "gemini-3.8-flash-low", skipPermissions: true });
	try {
		await h.driver.probe(3000);
		const [p1, p2] = fixtureMeta("midturn-message-queued").inputLines?.map((l) => promptOf(l)) ?? [];
		h.driver.send(p1);
		await waitFor("the first turn's tool to go ACTIVE", 5000, () =>
			h.events.some((e) => e.event === "step_update" && e.step_update.step_type === "tool" && e.step_update.state === "ACTIVE"),
		);
		h.driver.send(p2); // mid-turn: real agy queues it as the next turn
		await waitFor("both results", 5000, () => results(h).length >= 2);
		const rs = results(h);
		assert.ok(rs[0].result.response.includes("DONE1"), "first turn's response");
		assert.ok(rs[1].result.response.includes("MIDTURN"), "queued prompt reached the second turn");
		assert.strictEqual(rs[0].result.status, "SUCCESS");
		const exit = await h.driver.dispose();
		assert.strictEqual(exit.code, 0);
	} finally {
		await h.driver.dispose();
	}
});

test("SIGINT cancels the turn: interrupted result, exit 1, stderr tail captured", async () => {
	const h = startDriver("interrupted-sigint", { model: "gemini-3.8-flash-low", skipPermissions: true });
	try {
		await h.driver.probe(3000);
		h.driver.send(promptOf(fixtureMeta("interrupted-sigint").inputLines?.[0] ?? ""));
		await waitFor("the tool to go ACTIVE", 5000, () =>
			h.events.some((e) => e.event === "step_update" && e.step_update.step_type === "tool"),
		);
		h.driver.interrupt();
		const interrupted = await waitFor(
			"the interrupted result",
			5000,
			() => results(h).find((r) => r.result.error === "interrupted") || false,
		);
		assert.strictEqual(interrupted.result.status, "ERROR");
		// Pin the recorded replay (not the synthetic mid-turn result): the record carries the
		// turn's real counters, the synthetic one carries num_turns 0 and zero usage.
		assert.strictEqual(interrupted.result.num_turns, 1);
		assert.ok(interrupted.result.usage.input_tokens > 0);
		assert.ok(interrupted.result.usage.output_tokens > 0);
		// The fake sits at the boundary after the interrupted result, so the exit comes from
		// dispose() closing stdin - the first leg of the shutdown, with the recorded exit code.
		const exit = await h.driver.dispose();
		assert.strictEqual(exit.code, 1);
		assert.match(h.driver.stderrTail, /error: interrupted/);
	} finally {
		await h.driver.dispose();
	}
});

test("bad model: no init, probe times out with stderr context, exit 1", async () => {
	const h = startDriver("bad-model-id", { model: "gemini-nonexistent-xyz", probeTimeoutMs: 400 });
	try {
		let probeError: Error | null = null;
		try {
			await h.driver.probe();
		} catch (err) {
			probeError = err as Error;
		}
		assert.ok(probeError, "the probe must fail");
		assert.match(probeError?.message ?? "", /exited before init|did not send init within/);
		assert.match(probeError?.message ?? "", /invalid model selection/, "the stderr tail is in the probe failure");
		assert.ok(!h.events.some((e) => e.event === "init"), "a bad model never emits init");
		const result = await waitFor("the error result", 5000, () => results(h)[0] || false);
		assert.strictEqual(result.result.status, "ERROR");
		assert.match(result.result.error ?? "", /invalid model selection/);
		const exit = await h.driver.dispose();
		assert.strictEqual(exit.code, 1);
	} finally {
		await h.driver.dispose();
	}
});

test("malformed input is fatal", async () => {
	for (const fixture of ["input-not-json", "input-missing-event"]) {
		const h = startDriver(fixture, { model: "gemini-3.8-flash-low" });
		try {
			await h.driver.probe(3000);
			h.driver.sendRaw(fixtureMeta(fixture).inputLines?.[0] ?? "definitely not json");
			const result = await waitFor("the error result", 5000, () => results(h)[0] || false);
			assert.strictEqual(result.result.status, "ERROR", fixture);
			assert.ok(result.result.error, `${fixture}: the error text is recorded`);
			const exit = await waitFor("exit", 5000, () => (h.exits.length > 0 ? h.exits[0] : false));
			assert.strictEqual(exit.code, 1, fixture);
		} finally {
			await h.driver.dispose();
		}
	}
});

test("usage deltas continue across a --conversation resume", async () => {
	const first = startDriver("simple-multiturn-textblocks", { model: "gemini-3.8-flash-low" });
	let id = "";
	try {
		id = await first.driver.probe(3000);
		await driveTurns(first, "simple-multiturn-textblocks");
		const before = first.driver.cumulative;
		assert.strictEqual(before.num_turns, 3);
		await first.driver.dispose();

		const second = startDriver("resumed-conversation", {
			model: "gemini-3.8-flash-low",
			conversation: id,
			previous: before,
		});
		try {
			assert.strictEqual(await second.driver.probe(3000), id, "the resumed process keeps the conversation id");
			second.driver.send(promptOf(fixtureMeta("resumed-conversation").inputLines?.[0] ?? ""));
			const result = await waitFor("the resumed result", 5000, () => results(second)[0] || false);
			// The resumed process reports cumulative counters (num_turns 4, total 29567); the
			// delta against the previous process is exactly this turn's share.
			assert.strictEqual(result.result.num_turns, 1);
			assert.strictEqual(result.result.cumulative.num_turns, 4);
			assert.strictEqual(result.result.usage.input_tokens, 29560 - before.usage.input_tokens);
			assert.strictEqual(result.result.usage.total_tokens, 29567 - before.usage.total_tokens);
			assert.ok(result.result.duration_seconds > 21 && result.result.duration_seconds < 22, "a ~21 s turn delta");
			assert.strictEqual(result.result.response, "ZEBRA\n");
			const exit = await second.driver.dispose();
			assert.strictEqual(exit.code, 0);
		} finally {
			await second.driver.dispose();
		}
	} finally {
		await first.driver.dispose();
	}
});

test("dispose() leaves no child processes: the process group is empty", async () => {
	const h = startDriver("interrupted-sigint", { model: "gemini-3.8-flash-low", skipPermissions: true, graceMs: 300, termMs: 200 });
	const pid = h.driver.pid;
	try {
		assert.ok(pid, "the child has a pid (and, in its own group, a pgid)");
		await h.driver.probe(3000);
		h.driver.send(promptOf(fixtureMeta("interrupted-sigint").inputLines?.[0] ?? ""));
		await waitFor("the tool to go ACTIVE", 5000, () =>
			h.events.some((e) => e.event === "step_update" && e.step_update.step_type === "tool"),
		);
		// The fake is mid-turn (waiting for SIGINT): closing stdin does not stop it, like real
		// agy - so dispose has to escalate to signalling the group.
		const exit = await h.driver.dispose();
		assert.strictEqual(exit.signal, "SIGTERM");
		// List the process group: nothing of it may be left.
		assert.deepStrictEqual(processGroupMembers(pid), [], "no process may survive in the group");
		assert.throws(
			() => process.kill(-pid, 0),
			(err: NodeJS.ErrnoException) => err.code === "ESRCH",
			"the group itself must be gone",
		);
	} finally {
		await h.driver.dispose();
	}
});

test("a spawn failure is a terminal event, and send() after exit throws", async () => {
	const h = startDriver("input-event-bogus", { model: "gemini-3.8-flash-low", argvPrefix: ["/nonexistent/agy-missing"] });
	try {
		const exit = await waitFor("exit", 3000, () => (h.exits.length > 0 ? h.exits[0] : false));
		assert.strictEqual(exit.code, null);
		assert.ok(h.driver.spawnError, "the spawn error is surfaced");
		await assert.rejects(h.driver.probe(500), /exited/);
	} finally {
		await h.driver.dispose();
	}
	const h2 = startDriver("input-event-bogus", { model: "gemini-3.8-flash-low" });
	try {
		await h2.driver.probe(3000);
		await h2.driver.dispose();
		assert.throws(() => h2.driver.send("after exit"), /exited/);
	} finally {
		await h2.driver.dispose();
	}
});

test("agyArgs builds the documented flag vector", () => {
	assert.deepStrictEqual(agyArgs({ model: "m", effort: "high", conversation: "c", addDirs: ["a", "b"], skipPermissions: true }), [
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"-p=",
		"--model",
		"m",
		"--effort",
		"high",
		"--conversation",
		"c",
		"--add-dir",
		"a",
		"--add-dir",
		"b",
		"--dangerously-skip-permissions",
	]);
	assert.deepStrictEqual(agyArgs({}), ["--input-format", "stream-json", "--output-format", "stream-json", "-p="]);
});

test("version check: tested, untested, and strict refusal", async () => {
	const tested = await checkAgyVersion([process.execPath, FAKE, "--version"], 5000);
	assert.strictEqual(tested.version, "1.4.2");
	assert.strictEqual(tested.tested, true);
	assert.strictEqual(tested.warning, null);
	assert.strictEqual(tested.strictRefusal, false);

	process.env.FAKE_AGY_VERSION = "9.9.9";
	try {
		const untested = await checkAgyVersion([process.execPath, FAKE, "--version"], 5000);
		assert.strictEqual(untested.tested, false);
		assert.match(untested.warning ?? "", /untested/);
		assert.strictEqual(untested.strictRefusal, false);

		process.env.AGY_ACP_STRICT_VERSION = "1";
		try {
			const refused = await checkAgyVersion([process.execPath, FAKE, "--version"], 5000);
			assert.strictEqual(refused.strictRefusal, true);
		} finally {
			delete process.env.AGY_ACP_STRICT_VERSION;
		}
	} finally {
		delete process.env.FAKE_AGY_VERSION;
	}
});
