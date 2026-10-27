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
// The driver's permission bridge: the fake tolerates the bridge's --add-dir (an extra dir
// carrying .agents/hooks.json) and its forced --dangerously-skip-permissions, and with
// FAKE_AGY_RUN_HOOKS=1 it runs the configured PreToolUse hook between each recorded tool step's
// ACTIVE line and its terminal line (sh -c, the hooks.json folder as cwd, a recorded-shape
// payload on stdin, the configured timeout) - a deny replaces the step's terminal line with a
// TOOL_ERROR carrying the hook's reason, the way real agy does.
//
// `--version` prints the fixture's agy version (FAKE_AGY_VERSION overrides it, for the
// untested/strict version-gate tests).

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const STREAM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "stream");
const HOOK_PAYLOADS = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hooks", "hook-stdin-payloads.jsonl");

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
let exitCode = Number(meta.exitCode ?? "0");
const inputLines: string[] = meta.inputLines ?? [];
const initDelayMs = Number(process.env.FAKE_AGY_INIT_DELAY_MS ?? 20);
const lineGapMs = Number(process.env.FAKE_AGY_LINE_GAP_MS ?? 8);
const chunkGapMs = Number(process.env.FAKE_AGY_CHUNK_GAP_MS ?? 2);

/** The driver's per-session bridge dir (an extra --add-dir carrying .agents/hooks.json), if any. */
let bridgeDir: string | null = null;

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
const modelName = (() => {
	const i = lines.findIndex((l) => l.includes('"event":"init"'));
	const m = i >= 0 ? lines[i].match(/"model":"([^"]*)"/) : null;
	return m ? m[1] : "";
})();
const recordedCwd = (() => {
	const i = lines.findIndex((l) => l.includes('"event":"init"'));
	const m = i >= 0 ? lines[i].match(/"cwd":"([^"]*)"/) : null;
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
async function advance(): Promise<void> {
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
	const step = stepOf(line);
	let toEmit = line;
	const stagedDeny = step && step.state !== "ACTIVE" ? stagedDenies.get(step.index) : undefined;
	if (stagedDeny !== undefined && step) {
		toEmit = syntheticDenyLine(step, stagedDeny);
		stagedDenies.delete(step.index);
	}
	const isResult = lineEvent(line) === "result";
	nextLine++;
	// Real agy order: the step's ACTIVE goes out first, then the PreToolUse hook runs (the fake
	// runs the configured hook the same way: sh -c, the hooks.json folder as cwd, the payload on
	// stdin, the configured timeout), and only then the step's terminal line. A deny replaces the
	// recorded terminal line with a TOOL_ERROR carrying the hook's reason, the way real agy does.
	const hookStep = step && step.state === "ACTIVE" ? step : null;
	// The continuation: after a hook (when the line was an ACTIVE) finishes, the next line is
	// queued; a result line closes the turn and pauses for the next user line (or settles).
	const continueAfterLine = async (): Promise<void> => {
		if (nextLine >= lines.length) {
			finishReplay();
			return;
		}
		if (isResult) {
			// A result closes the turn: continue only when the next user line is already queued,
			// otherwise pause until one arrives - or exit at once if stdin is already closed.
			if (queuedUserLines > 0) {
				queuedUserLines--;
				void advance();
			} else if (stdinClosed) {
				settle();
			} else {
				awaitingUser = true;
				startWaiting();
			}
			return;
		}
		void advance();
	};
	emitLine(toEmit, () => {
		void (async () => {
			if (hookStep) {
				const denyReason = await runHookForStep(hookStep);
				if (denyReason !== undefined) stagedDenies.set(hookStep.index, denyReason);
			}
			void continueAfterLine();
		})();
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
		void advance();
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
			void advance();
			return;
		}
		if (queuedUserLines > 0) {
			queuedUserLines--;
			void advance();
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
	// exit on its own with 1 - the only observed interrupt (the record) exited 1.
	const synthetic =
		'{"event":"result","result":{"conversation_id":"' +
		`${conversationId}","status":"ERROR","response":"","error":"interrupted","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}`;
	emitLine(synthetic);
	exitCode = 1;
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
	// record never saw, both drift - except the permission bridge's documented additions (its
	// --add-dir and the forced --dangerously-skip-permissions), tolerated only when the extra
	// add-dir really is a bridge dir (it carries .agents/hooks.json).
	for (const key of got.values.keys())
		if (!want.values.has(key) && key !== "--log-file" && key !== "--add-dir") die(`fake-agy: unexpected flag ${key}`, 2);
	for (const flag of got.flags)
		if (flag !== "-p=" && !want.flags.has(flag) && !(flag === "--dangerously-skip-permissions" && bridgeDir !== null))
			die(`fake-agy: unexpected flag ${flag}`, 2);
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
	if (meta.args) checkRecordedArgs(got);
}

/** The recorded argv (if any) must match what the driver passed, the documented bridge additions
 * aside: the bridge --add-dir (tolerated only when it really is a bridge dir) and the forced
 * --dangerously-skip-permissions that goes with it. */
function checkRecordedArgs(got: FlagSet): void {
	const want = parseArgv((meta.args as string).split(/\s+/).slice(1)); // drop the leading "agy"
	const wantAddDirs = want.values.get("--add-dir") ?? [];
	const gotAddDirs = got.values.get("--add-dir") ?? [];
	// The recorded add-dirs must all be present (in order); the only tolerated extra is the bridge dir.
	if (JSON.stringify(wantAddDirs) !== JSON.stringify(gotAddDirs.filter((d) => wantAddDirs.includes(d))))
		die(`fake-agy: --add-dir recorded values drifted: expected ${JSON.stringify(wantAddDirs)}, got ${JSON.stringify(gotAddDirs)}`, 2);
	const extra = gotAddDirs.filter((d) => !wantAddDirs.includes(d));
	const bridge = extra.find((d) => fs.existsSync(path.join(d, ".agents", "hooks.json")));
	if (extra.length > 0 && bridge === undefined)
		die(`fake-agy: extra --add-dir ${extra.join(", ")} is not a bridge dir (no .agents/hooks.json)`, 2);
	bridgeDir = bridge ?? null;
	for (const [key, values] of want.values) {
		if (key === "--log-file" || key === "--add-dir") continue; // --log-file is not passed; --add-dir handled above
		const gotValues = got.values.get(key) ?? [];
		if (JSON.stringify(values) !== JSON.stringify(gotValues))
			die(`fake-agy: ${key} mismatch: expected ${JSON.stringify(values)}, got ${JSON.stringify(gotValues)}`, 2);
	}
	for (const flag of want.flags) {
		if (flag !== "-p=" && !got.flags.has(flag)) die(`fake-agy: expected flag ${flag}`, 2);
	}
	assertNoDrift(got, want);
}

// ------------------------------------------------------------------ hook bridge

// With FAKE_AGY_RUN_HOOKS=1 and a bridge dir present, the fake runs the configured PreToolUse
// hook between each recorded tool step's ACTIVE line and its terminal line, the way real agy
// does: `sh -c <command>` with the
// hooks.json folder as cwd, agy's env plus ANTIGRAVITY_CONVERSATION_ID, the hook payload on
// stdin, and the configured timeout. The payload is the shape of a recorded one from
// hook-stdin-payloads.jsonl (first unused template with a matching tool name), with the
// identity fields (conversationId, stepIdx, modelName) set to this scenario's and the Path
// argument remapped from the recorded workspace root to the fake's cwd, so in-workspace
// checks are real. A hook deny replaces the step's recorded terminal line with a TOOL_ERROR
// carrying the hook's reason (real agy: "tool call denied by pre-tool hook: <reason>").
// agy's documented hook output handling is emulated: allow/deny JSON, empty stdout = allow
// (fail-open), everything else = fail-closed deny.

interface StepInfo {
	index: number;
	name: string;
	state: string;
	params: Record<string, unknown>;
}

const stagedDenies = new Map<number, string>();

function stepOf(line: string): StepInfo | null {
	try {
		const o: unknown = JSON.parse(line);
		const su = typeof o === "object" && o !== null ? (o as Record<string, unknown>).step_update : undefined;
		if (typeof su !== "object" || su === null) return null;
		const s = su as Record<string, unknown>;
		if (s.step_type !== "tool") return null;
		const info = typeof s.tool_info === "object" && s.tool_info !== null ? (s.tool_info as Record<string, unknown>) : {};
		const params = typeof info.parameters === "object" && info.parameters !== null ? (info.parameters as Record<string, unknown>) : {};
		return {
			index: typeof s.step_index === "number" ? s.step_index : -1,
			name: typeof s.tool_name === "string" ? s.tool_name : typeof info.name === "string" ? (info.name as string) : "",
			state: typeof s.state === "string" ? s.state : "",
			params,
		};
	} catch {
		return null;
	}
}

const hookTemplates: Array<{ name: string; payload: Record<string, unknown> }> = (() => {
	try {
		const out: Array<{ name: string; payload: Record<string, unknown> }> = [];
		for (const line of fs
			.readFileSync(HOOK_PAYLOADS, "utf8")
			.split("\n")
			.filter((l) => l !== "")) {
			const o = JSON.parse(line) as { event?: string; stdin?: { toolCall?: { name?: string } } };
			if (o.event === "PreToolUse" && o.stdin && typeof o.stdin === "object" && o.stdin.toolCall?.name) {
				out.push({ name: o.stdin.toolCall.name, payload: { ...(o.stdin as Record<string, unknown>) } });
			}
		}
		return out;
	} catch {
		return [];
	}
})();
const usedTemplates = new Set<number>();

interface HookConfig {
	command: string;
	timeoutSec: number;
}

type HooksFile = Record<
	string,
	{ PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }> }
>;

function pickHook(name: string): HookConfig | null {
	if (!bridgeDir) return null;
	try {
		const hooks = JSON.parse(fs.readFileSync(path.join(bridgeDir, ".agents", "hooks.json"), "utf8")) as HooksFile;
		return firstCommandHook(hooks, name);
	} catch {
		// a missing or malformed hooks.json means no hook to run
		return null;
	}
}

/** The first command hook whose matcher allows the tool name (`*` matches everything). */
function firstCommandHook(hooks: HooksFile, name: string): HookConfig | null {
	for (const entry of Object.values(hooks)) {
		for (const pre of entry?.PreToolUse ?? []) {
			const matcher = pre.matcher ?? "*";
			if (matcher !== "*" && matcher !== name) continue;
			for (const h of pre.hooks ?? []) {
				if (h.type === "command" && h.command) return { command: h.command, timeoutSec: h.timeout ?? 30 };
			}
		}
	}
	return null;
}

/** One hook payload: a recorded template (shape + fields) with this scenario's identity. */
function buildPayload(step: StepInfo): string {
	let idx = hookTemplates.findIndex((t, i) => !usedTemplates.has(i) && t.name === step.name);
	if (idx < 0) idx = hookTemplates.findIndex((_t, i) => !usedTemplates.has(i));
	if (idx >= 0) usedTemplates.add(idx);
	const base: Record<string, unknown> =
		idx >= 0 ? { ...hookTemplates[idx].payload } : { conversationId: "", stepIdx: 0, modelName: "", workspacePaths: [] as string[] };
	base.conversationId = conversationId;
	base.stepIdx = step.index;
	if (modelName !== "") base.modelName = modelName;
	// The hook payload's toolCall is the step's own args (what agy is about to run); the template
	// only stands in for the envelope's shape (workspacePaths, etc.).
	const args: Record<string, unknown> = { ...step.params };
	const p = args.Path;
	if (typeof p === "string" && p !== "") {
		// The recorded workspace root (the template's, or the recorded init cwd) stands in for
		// the fake's own cwd: strip it and re-root the path so in-workspace checks are real.
		const ws = base.workspacePaths;
		const prefix =
			(Array.isArray(ws) && typeof ws[0] === "string" && ws[0] !== "" && p.startsWith(ws[0]) ? ws[0] : undefined) ??
			(recordedCwd !== "" && p.startsWith(recordedCwd) ? recordedCwd : undefined);
		if (prefix !== undefined) args.Path = path.join(process.cwd(), p.slice(prefix.length));
	}
	if (process.env.FAKE_AGY_BRIDGE_REF === "1" && typeof args.CommandLine === "string" && bridgeDir) {
		args.CommandLine = `${args.CommandLine} ${bridgeDir}`;
	}
	// FAKE_AGY_REWRITE_ARGS=1 simulates agy rewriting the tool's args between the hook and the
	// stream (the hook sees the rewritten args; the stream shows the originals) - the detection
	// surface for the gate's _meta.argsRewritten.
	if (process.env.FAKE_AGY_REWRITE_ARGS === "1" && typeof args.CommandLine === "string") {
		args.CommandLine = `${args.CommandLine} --rewritten`;
	}
	base.toolCall = { name: step.name, args };
	return JSON.stringify(base);
}
function runHookCommand(
	command: string,
	timeoutSec: number,
	stdinLine: string,
	cwd: string,
): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolve) => {
		const child = spawn("sh", ["-c", command], { cwd, env: { ...process.env, ANTIGRAVITY_CONVERSATION_ID: conversationId } });
		let out = "";
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout: out });
		};
		const timer = setTimeout(
			() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// the hook is already gone
				}
				finish(null);
			},
			Math.min(timeoutSec, 120) * 1000 + 10_000,
		);
		timer.unref();
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString("utf8");
		});
		child.on("error", () => finish(127));
		child.on("close", (code) => finish(code));
		// The payload is one line; agy closes the pipe after writing it - the hook reads until end.
		child.stdin.write(`${stdinLine}\n`);
		child.stdin.end();
	});
}

/** agy's documented hook output handling: the decision, or a fail-closed deny reason. */
function judgeHookOutput(code: number | null, stdout: string): string | undefined {
	if (code !== 0) return `fake-agy: the pre-tool hook failed (exit ${code ?? "killed"}; fail-closed)`;
	if (stdout.trim() === "") return undefined; // fail-open: empty stdout = allow
	let o: unknown;
	try {
		o = JSON.parse(stdout);
	} catch {
		return "fake-agy: the pre-tool hook output is not JSON (fail-closed)";
	}
	const a = typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {};
	if (a.decision === "allow") return undefined;
	if (a.decision === "deny") {
		const r = a.reason;
		return typeof r === "string" && r !== "" ? r : "the pre-tool hook denied the call";
	}
	return "fake-agy: the pre-tool hook output has an unknown decision (fail-closed)";
}

function syntheticDenyLine(step: StepInfo, reason: string): string {
	return JSON.stringify({
		event: "step_update",
		step_update: {
			conversation_id: conversationId,
			step_index: step.index,
			state: "ERROR",
			step_type: "tool",
			tool_name: step.name,
			duration_seconds: 0.1,
			tool_info: {
				name: step.name,
				parameters: step.params,
				error: { type: "TOOL_ERROR", message: `tool call denied by pre-tool hook: ${reason}` },
			},
		},
	});
}

/** Run the configured hook for one tool step; the deny reason to stage, or undefined (allow). */
async function runHookForStep(step: StepInfo): Promise<string | undefined> {
	if (process.env.FAKE_AGY_RUN_HOOKS !== "1") return undefined;
	const hook = pickHook(step.name);
	if (!hook) return undefined;
	const cwd = bridgeDir ? path.join(bridgeDir, ".agents") : process.cwd();
	const { code, stdout } = await runHookCommand(hook.command, hook.timeoutSec, buildPayload(step), cwd);
	return judgeHookOutput(code, stdout);
}
