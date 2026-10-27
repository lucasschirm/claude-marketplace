#!/usr/bin/env node
// A fake `agy` for the driver tests: CI never calls a model.
//
//   FAKE_AGY_FIXTURE=<scenario> node fake-agy.ts <agy flags...>
//
// For the named scenario in test/fixtures/stream it:
//   - validates the flags against the recorded invocation (so a drifted argv is caught);
//   - validates the stdin lines against the recorded input: a user line must be semantically the
//     recorded prompt (string content and a single text block are equivalent - the driver sends
//     blocks, the spike recorded strings), a control line must be byte-identical;
//   - replays the recorded stdout with scaled timing: staggered events, each line written in two
//     chunks so the driver's line assembly is exercised for real;
//   - honours SIGINT the way `interrupted-sigint` does (recorded interrupted result, then the
//     recorded exit code);
//   - exits with the recorded exit code.
//
// `--version` prints the fixture's agy version (FAKE_AGY_VERSION overrides it, for the
// untested/strict version-gate tests).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const STREAM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "stream");

interface FakeMeta {
	agyVersion?: string;
	args?: string;
	inputLines?: string[];
	exitCode?: string;
	stderr?: string;
}

const argv = process.argv.slice(2);

function die(message: string, code: number): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

function loadMeta(fixtureName: string | undefined): FakeMeta | null {
	if (!fixtureName) return null;
	try {
		return JSON.parse(fs.readFileSync(path.join(STREAM_DIR, `${fixtureName}.meta.json`), "utf8")) as FakeMeta;
	} catch {
		return null;
	}
}

if (argv[0] === "--version") {
	const fixture = loadMeta(process.env.FAKE_AGY_FIXTURE);
	const version = process.env.FAKE_AGY_VERSION ?? fixture?.agyVersion ?? "1.4.2";
	process.stdout.write(`${version}\n`);
	process.exit(0);
}

const name = process.env.FAKE_AGY_FIXTURE;
if (!name) die("FAKE_AGY_FIXTURE must name a scenario in test/fixtures/stream", 2);
const loaded = loadMeta(name);
if (!loaded) die(`fake-agy: no fixture meta for scenario '${name}'`, 2);
const meta: FakeMeta = loaded;
const lines = fs
	.readFileSync(path.join(STREAM_DIR, `${name}.stdout.ndjson`), "utf8")
	.split("\n")
	.filter((l) => l !== "");
const exitCode = Number(meta.exitCode ?? "0");
const inputLines: string[] = meta.inputLines ?? [];
const initDelayMs = Number(process.env.FAKE_AGY_INIT_DELAY_MS ?? 20);
const lineGapMs = Number(process.env.FAKE_AGY_LINE_GAP_MS ?? 8);
const chunkGapMs = Number(process.env.FAKE_AGY_CHUNK_GAP_MS ?? 2);

checkArgs();

// ------------------------------------------------------------------ replay state

let nextLine = 0; // next recorded line to emit
let started = false; // the first stdin line has been processed (init needs it)
let done = false; // every recorded line emitted
let settled = false;
let stderrWritten = false;
let awaitingUser = false; // paused at a turn boundary, waiting for the line that starts the turn
let waitingForSignal = false; // paused at the recorded interrupted result, waiting for SIGINT
let queuedUserLines = 0; // user lines that arrived mid-turn
let userLinesConsumed = 0;
const hasInitLine = lines.some((l) => lineEvent(l) === "init");

/// A process parked at a turn boundary stays alive while stdin is open (real agy waits for
// input there; an open pipe is not enough once the parent closes it, so hold a live timer
// until the "end" handler settles it). A mid-turn turn survives EOF the same way.
let keepAlive: ReturnType<typeof setInterval> | null = null;
function startWaiting(): void {
	if (!keepAlive) keepAlive = setInterval(() => {}, 1000);
}
function stopWaiting(): void {
	if (keepAlive) {
		clearInterval(keepAlive);
		keepAlive = null;
	}
}

// Exit must never race the stream: a plain process.exit() drops chunks still queued on the
// stdout pipe, and the event loop cannot drain by itself because the (parent-held) stdin socket
// stays an active handle. So the exit waits until every scheduled line has been fully written
// (the write callback fires once the bytes are in the kernel pipe) before it exits.
//
// Only one line may be in flight at a time: two concurrent lines would interleave their chunks
// on the pipe (line A head, line B head, A tail, B tail) and corrupt both frames. Later lines
// wait in a queue behind the one being written.
let writing = false;
const writeQueue: Array<() => void> = [];
const exitWaiters: Array<() => void> = [];
function outstandingCount(): number {
	return writeQueue.length + (writing ? 1 : 0);
}
function scheduleExit(code: number): void {
	if (outstandingCount() > 0) exitWaiters.push(() => maybeExit(code));
	else maybeExit(code);
}
function maybeExit(code: number): void {
	if (outstandingCount() === 0) process.exit(code);
}
function lineWritten(): void {
	if (writeQueue.length > 0) {
		writeQueue.shift()?.();
		return;
	}
	writing = false;
	if (exitWaiters.length > 0) {
		const waiters = exitWaiters.splice(0);
		for (const w of waiters) w();
	}
}
const conversationId = (() => {
	const i = lines.findIndex((l) => l.includes('"event":"init"'));
	const m = i >= 0 ? lines[i].match(/"conversation_id":"([^"]*)"/) : null;
	return m ? m[1] : "";
})();

function writeStderr(): void {
	if (stderrWritten || !meta.stderr) return;
	stderrWritten = true;
	process.stderr.write(meta.stderr);
}

function settle(): void {
	if (settled) return;
	settled = true;
	writeStderr(); // the recorded stderr belongs to the session; it lands as the process goes
	stopWaiting();
	scheduleExit(exitCode);
}

function finishReplay(): void {
	done = true;
	if (!hasInitLine) {
		// Startup failure: the process leaves with the recorded code without waiting for input.
		settle();
		return;
	}
	if (stdinClosed) {
		// EOF mid-turn (the survival path): real agy finishes the turn and then exits.
		settle();
		return;
	}
	// Real agy sits at the turn boundary after the final line and exits when stdin closes.
	awaitingUser = true;
	startWaiting();
}

function emitLine(line: string, then?: () => void): void {
	if (settled) return; // the record is finished; late callbacks must not extend the stream
	const job = () => {
		writing = true;
		// Split the encoded bytes (not UTF-16 units), so a multi-byte character never straddles the cut.
		const buf = Buffer.from(line, "utf8");
		const half = Math.max(1, Math.floor(buf.length / 2));
		setTimeout(() => {
			process.stdout.write(buf.subarray(0, half));
			setTimeout(() => {
				// The frame terminator rides the last chunk, so it is the driver's line assembly -
				// not the fake - that joins the two halves. The continuation may queue the next
				// line; the write callback then starts it (or exits, if the replay is over).
				process.stdout.write(Buffer.concat([buf.subarray(half), Buffer.from("\n")]), () => {
					then?.();
					lineWritten();
				});
			}, chunkGapMs);
		}, lineGapMs);
	};
	if (writing || writeQueue.length > 0) writeQueue.push(job);
	else job();
}

function lineEvent(line: string): string {
	try {
		const obj: unknown = JSON.parse(line);
		return typeof obj === "object" && obj !== null && !Array.isArray(obj) && typeof (obj as Record<string, unknown>).event === "string"
			? ((obj as Record<string, unknown>).event as string)
			: "";
	} catch {
		return "";
	}
}

function isInterruptedResult(line: string): boolean {
	return lineEvent(line) === "result" && line.includes('"error":"interrupted"');
}

/** Emit one recorded line; its callback drives the continuation, so frames never interleave. */
function advance(): void {
	if (nextLine >= lines.length) {
		finishReplay();
		return;
	}
	const line = lines[nextLine];
	if (isInterruptedResult(line) && nextLine === lines.length - 1) {
		waitingForSignal = true;
		startWaiting();
		return;
	}
	const isResult = lineEvent(line) === "result";
	nextLine++;
	emitLine(line, () => {
		if (nextLine >= lines.length) {
			finishReplay();
			return;
		}
		if (isResult) {
			// A result closes the turn: continue only when the next user line is already queued,
			// otherwise pause until one arrives - or exit at once if stdin is already closed.
			if (queuedUserLines > 0) {
				queuedUserLines--;
				advance();
			} else if (stdinClosed) {
				settle();
			} else {
				awaitingUser = true;
				startWaiting();
			}
			return;
		}
		advance();
	});
}

// ------------------------------------------------------------------ stdin handling

let stdinBuf = "";
let stdinClosed = false;
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => {
	// Real agy, sitting at a turn boundary, exits with its code when stdin closes; a mid-turn
	// turn survives EOF until the turn ends (see the result branch in advance()). The
	// waitingForSignal state survives EOF too: the record delivered SIGINT there, so the fake
	// keeps waiting for it (the group-teardown test pins that dispose must then escalate).
	stdinClosed = true;
	if (settled || waitingForSignal) return;
	if (started && !awaitingUser && !done) return;
	stopWaiting();
	settle();
});
process.stdin.on("data", (d: string) => {
	stdinBuf += d;
	for (;;) {
		const i = stdinBuf.indexOf("\n");
		if (i < 0) break;
		handleLine(stdinBuf.slice(0, i));
		stdinBuf = stdinBuf.slice(i + 1);
	}
});

function expectedInput(): string | undefined {
	return inputLines[userLinesConsumed];
}

function handleLine(line: string): void {
	if (settled || waitingForSignal) return; // an interrupted turn ignores late input
	const event = lineEvent(line);
	if (event === "") {
		const expected = expectedInput();
		if (expected === line) {
			// The recorded failure input (not JSON, or missing the event field): replay the
			// recorded fallout and leave with the recorded code.
			userLinesConsumed++;
			failPath();
			return;
		}
		die(`fake-agy: unparseable stdin line (real agy would die too): ${line.slice(0, 120)}`, 1);
	}
	if (event === "user") {
		handleUserLine(line);
		return;
	}
	// A non-user event: the probe, or a recorded unknown input event (spike: ignored with a
	// stderr warning). A recorded one is consumed; any other is accepted and ignored.
	if (expectedInput() === line) userLinesConsumed++;
	if (!started) {
		started = true;
		emitInitThen(afterFirstLine);
	}
}

function handleUserLine(line: string): void {
	const expected = expectedInput();
	if (expected !== undefined) {
		if (!sameUserLine(line, expected)) die(`fake-agy: user input does not match recorded input line #${userLinesConsumed + 1}`, 1);
		userLinesConsumed++;
	} else if (!hasUsableUserContent(line)) {
		die("fake-agy: user message without usable text content", 1);
	}
	if (!started) {
		// A direct run without a probe: the user line itself is the first line.
		started = true;
		emitInitThen(advance);
		return;
	}
	if (awaitingUser) {
		awaitingUser = false;
		advance();
		return;
	}
	if (nextLine >= lines.length) {
		process.stderr.write("fake-agy: user line after the fixture finished; ignoring\n");
		return;
	}
	// Mid-turn: real agy queues it as the next turn.
	queuedUserLines++;
}

/** The recorded input that starts the pending turn is malformed: emit init if needed, then the fallout. */
function failPath(): void {
	if (!started) {
		started = true;
		emitInitThen(emitRest);
		return;
	}
	emitRest();
}

function emitRest(): void {
	while (nextLine < lines.length) {
		const line = lines[nextLine];
		nextLine++;
		emitLine(line);
	}
	settle();
}

/** After the first line: continue into the first turn if more is recorded, else wait for the user line. */
function afterFirstLine(): void {
	if (nextLine < lines.length) {
		if (!hasInitLine) {
			// Startup failure (no init in the record): the error result comes without any input.
			advance();
			return;
		}
		if (queuedUserLines > 0) {
			queuedUserLines--;
			advance();
		} else {
			awaitingUser = true;
			startWaiting();
		}
	} else {
		finishReplay();
	}
}

function emitInitThen(then: () => void): void {
	if (nextLine < lines.length && lineEvent(lines[nextLine]) === "init") {
		const line = lines[nextLine];
		nextLine++;
		emitLine(line, then);
		return;
	}
	setTimeout(then, initDelayMs);
}

// ------------------------------------------------------------------ user-line equivalence

function normalizedContent(content: unknown): string[] | null {
	if (typeof content === "string") return [content];
	if (Array.isArray(content)) {
		const out: string[] = [];
		for (const block of content) {
			if (typeof block === "string") out.push(block);
			else if (
				block &&
				typeof block === "object" &&
				(block as Record<string, unknown>).type === "text" &&
				typeof (block as Record<string, unknown>).text === "string"
			)
				out.push((block as Record<string, unknown>).text as string);
			else return null;
		}
		return out;
	}
	return null;
}

/** True when two user lines carry the same prompt (string content and one text block are equivalent). */
function sameUserLine(a: string, b: string): boolean {
	if (a === b) return true;
	let pa: { message?: { content?: unknown } };
	let pb: { message?: { content?: unknown } };
	try {
		pa = JSON.parse(a) as { message?: { content?: unknown } };
		pb = JSON.parse(b) as { message?: { content?: unknown } };
	} catch {
		return false;
	}
	const ca = normalizedContent(pa.message?.content);
	const cb = normalizedContent(pb.message?.content);
	return ca !== null && cb !== null && JSON.stringify(ca) === JSON.stringify(cb);
}

function hasUsableUserContent(line: string): boolean {
	try {
		const obj = JSON.parse(line) as { message?: { content?: unknown } };
		return normalizedContent(obj.message?.content) !== null;
	} catch {
		return false;
	}
}

// ------------------------------------------------------------------ signals

process.on("SIGINT", () => {
	if (settled) return;
	if (waitingForSignal) {
		waitingForSignal = false;
		emitLine(lines[lines.length - 1]);
		nextLine = lines.length;
		settle(); // record: agy exits on its own after the interrupted result, before stdin closes
		return;
	}
	if (awaitingUser) {
		// Idle between turns: SIGINT just ends the process (real agy exits 130, no result).
		stopWaiting();
		scheduleExit(130);
		return;
	}
	// Mid-turn (or before the first turn): emit the interrupted result real agy would emit, then
	// exit on its own - the record's exit precedes the parent's stdin close.
	const synthetic =
		'{"event":"result","result":{"conversation_id":"' +
		`${conversationId}","status":"ERROR","response":"","error":"interrupted","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}`;
	emitLine(synthetic);
	settle();
});

// ------------------------------------------------------------------ flag validation

interface FlagSet {
	values: Map<string, string[]>;
	flags: Set<string>;
}

function parseArgv(tokens: string[]): FlagSet {
	const out: FlagSet = { values: new Map(), flags: new Set() };
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "-p=") out.flags.add("-p=");
		else if (t.startsWith("--")) {
			const eq = t.indexOf("=");
			const key = eq >= 0 ? t.slice(0, eq) : t;
			if (eq >= 0) out.values.set(key, [...(out.values.get(key) ?? []), t.slice(eq + 1)]);
			else if (["--input-format", "--output-format", "--model", "--effort", "--conversation", "--add-dir", "--log-file"].includes(key)) {
				i++;
				out.values.set(key, [...(out.values.get(key) ?? []), tokens[i]]);
			} else out.flags.add(key);
		}
	}
	return out;
}

function assertNoDrift(got: FlagSet, want: FlagSet): void {
	// Both directions: a recorded flag that the driver dropped, and a driver-side addition the
	// record never saw, both drift.
	for (const key of got.values.keys()) if (!want.values.has(key) && key !== "--log-file") die(`fake-agy: unexpected flag ${key}`, 2);
	for (const flag of got.flags) if (flag !== "-p=" && !want.flags.has(flag)) die(`fake-agy: unexpected flag ${flag}`, 2);
}

function checkArgs(): void {
	const got = parseArgv(argv);
	for (const [flag, value] of [
		["--input-format", "stream-json"],
		["--output-format", "stream-json"],
	] as Array<[string, string]>) {
		const values = got.values.get(flag) ?? [];
		if (values.length !== 1 || values[0] !== value) die(`fake-agy: expected ${flag} ${value}, got: ${JSON.stringify(values)}`, 2);
	}
	if (!got.flags.has("-p=")) die("fake-agy: expected -p= (headless mode)", 2);
	if (!meta.args) return; // the bridge scenarios record no argv; the basic shape is enough
	const want = parseArgv(meta.args.split(/\s+/).slice(1)); // drop the leading "agy"
	for (const [key, values] of want.values) {
		if (key === "--log-file") continue; // the driver does not pass it
		const gotValues = got.values.get(key) ?? [];
		if (JSON.stringify(values) !== JSON.stringify(gotValues))
			die(`fake-agy: ${key} mismatch: expected ${JSON.stringify(values)}, got ${JSON.stringify(gotValues)}`, 2);
	}
	for (const flag of want.flags) {
		if (flag !== "-p=" && !got.flags.has(flag)) die(`fake-agy: expected flag ${flag}`, 2);
	}
	assertNoDrift(got, want);
}
