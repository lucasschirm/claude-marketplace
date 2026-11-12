#!/usr/bin/env node
// agy-acp live smoke test (issue #60).
//
// Opt-in, and never run in CI: this script runs a fixed list of ten scenarios against the REAL
// `agy` binary, with `gemini-3.8-flash-low` and a hard cap of 15 model turns. It drives the real
// package code, not a copy of it: the production permission gate (a real bridge dir, a real
// hooks.json, a real socket, a real bridge-hook.ts) under a driver that mirrors AgyProcess (the
// probe, the close-stdin/grace/SIGTERM/term/SIGKILL dispose ladder, the budgeted stderr tail) and
// additionally taps the RAW stdout lines - the exact lines a recorded fixture is made of, which is
// what makes a --record refresh exact. The cancel scenario runs the production cancel ladder
// (cancelAgy) on that driver; the client-disconnect scenario runs the real server
// (`node agy-acp/src/main.ts`) over a real JSON-RPC connection and closes the client's stdin
// mid-turn.
//
// The run writes a dated report plus the new fixtures into `agy-acp/reports/smoke-<date>/`, then
// confirms that no processes are left and the user configuration is unchanged (a sha256 of every
// `~/.gemini/**/settings.json` and `hooks.json`, taken before and after). The field inventory of
// the live run is diffed against the committed `test/fixtures/stream/field-inventory.json`; with
// `--record`, the live fixtures are written into `test/fixtures/stream/` (committed names, other
// committed fixtures untouched) and the committed inventory is recomputed from the directory.
//
//   node agy-acp/scripts/smoke-live.ts            # smoke run: report, fixtures, inventory diff
//   node agy-acp/scripts/smoke-live.ts --record  # + record the fixtures into test/fixtures/stream/
//   node agy-acp/scripts/smoke-live.ts --agy /path/to/agy
//
// A version the fixtures were not recorded against (see TESTED_AGY_VERSIONS) is a warning in the
// report, not a refusal - the point of the run is to notice the drift, and a refusal would notice
// it too late.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FrameDecoder, DEFAULT_MAX_FRAME_BYTES } from "../src/framing.ts";
import { parseAgyLine, cumulativeOf, ZERO_CUMULATIVE } from "../src/agy/contract.ts";
import type { AgyCumulative, AgyEvent, AgyInitEvent, AgyResultEvent, AgyStepUpdateEvent } from "../src/agy/contract.ts";
import { AGY_PROBE_EVENT, agyArgs } from "../src/agy/args.ts";
import { spawnProcessGroup } from "../src/lib/child-process.ts";
import { checkAgyVersion, TESTED_AGY_VERSIONS, type AgyProcess } from "../src/agy-driver.ts";
import { listAgyModels } from "../src/agy/models.ts";
import { PermissionGate, newPermissionToken } from "../src/permission-gate.ts";
import { cancelAgy } from "../src/cancel.ts";
import { agyModeFlag } from "../src/config-options.ts";
import type { AcpSessionUpdate } from "../src/acp.ts";

// ---------------------------------------------------------------- constants

const MODEL = "gemini-3.8-flash-low";
const TURNS_MAX = 15; // the hard cap: a send that would exceed it fails the run
const TURN_DEADLINE_MS = 300_000; // one model turn, low model, real network
const CLIENT_DEADLINE_MS = 280_000; // below the turn deadline: a hung ask dies first, with its reason
const HOOK_DEADLINE_MS = 300_000; // the hook's own timer, above the client deadline
const HOOK_TIMEOUT_SEC = 720; // agy's timer, above the hook deadline
const PROBE_TIMEOUT_MS = 60_000; // real agy takes up to ~9 s to start; a new version may take more
const CANCEL_ESCALATE_MS = 5_000; // the production SIGINT -> process-group window
const CANCEL_EXIT_TIMEOUT_MS = 90_000; // SIGINT, the 5 s window, the ladder, the sweep
const SERVER_EXIT_TIMEOUT_MS = 45_000; // the server's 10 s exit deadline plus a generous margin
const GRACE_MS = 3_000; // the dispose ladder's windows, mirrored from AgyProcess
const TERM_MS = 1_000;
const STDERR_TAIL_BYTES = 64 * 1024; // mirrored from the driver
const BAD_MODEL_ID = "gemini-nonexistent-xyz"; // the committed bad-model-id fixture's id
const SLEEP_MARKER = "sleep 30"; // the tool command the cancel and disconnect scenarios run

const PROMPT_PONG = "Reply with exactly: PONG";
const PROMPT_REMEMBER_ZEBRA = "Remember the word ZEBRA. Reply with exactly: OK";
const PROMPT_RECALL_ZEBRA = "What word did I ask you to remember? Reply with just the word.";
const PROMPT_TOOL_ALLOW = "Run the shell command: touch smoke-tool-allow.txt  then reply OK.";
const PROMPT_TOOL_DENY = "Run the shell command: touch smoke-tool-deny.txt  then reply OK.";
const PROMPT_PLAN_DENY = "Run the shell command: touch smoke-plan-deny.txt  then reply OK.";
const PROMPT_ALLOW_ALWAYS = "Run the shell command: echo SMOKE_ALLOW_ALWAYS  then reply OK.";
const PROMPT_SLEEP = "Run the shell command: sleep 30  and wait for it, then reply DONE.";
const PROMPT_REMEMBER_BANANA = "Remember the word BANANA. Reply with exactly: OK";
const PROMPT_RECALL_BANANA = "What word did I ask you to remember? Reply with just the word.";

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url)); // agy-acp/
const FIXTURES_DIR = path.join(REPO_DIR, "test", "fixtures", "stream");
const MAIN_TS = path.join(REPO_DIR, "src", "main.ts");

const say = (line: string): void => {
	try {
		process.stdout.write(`${line}\n`);
	} catch {
		// a dead console is not a reason the run's verdict changes
	}
};

// ---------------------------------------------------------------- small utilities

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Is this pid still there? (EPERM means it exists; ESRCH means it is gone.) */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Live pids whose cwd is inside `root` - a stray of this run lives under its own roots (a tool
 * command runs in the session's cwd; a leftover `agy` in the private root), and a polling loop
 * elsewhere that merely mentions a marker does not. The cmdline marker match decides the label's
 * detail, not the flag. A /proc scan, and empty where /proc is not (the pid checks carry the
 * verdict then).
 */
function strayProcesses(markers: string[], root: string): string[] {
	if (!fs.existsSync("/proc")) return [];
	const out: string[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		const hit = strayOf(entry, markers, root);
		if (hit !== null) out.push(hit);
	}
	return out;
}

function strayOf(entry: string, markers: string[], root: string): string | null {
	if (!/^\d+$/.test(entry)) return null;
	const pid = Number(entry);
	if (pid === process.pid) return null;
	let cmdline = "";
	let dir = "";
	try {
		cmdline = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ");
	} catch {
		// the process went away mid-scan, which is the outcome we are waiting for anyway
	}
	try {
		dir = fs.readlinkSync(`/proc/${entry}/cwd`);
	} catch {
		// a kernel thread, or gone
	}
	const inTree = dir === root || dir.startsWith(`${root}/`);
	if (!inTree) return null;
	const byCmdline = markers.some((m) => cmdline.includes(m));
	return `pid ${pid}${byCmdline ? ` (${cmdline.slice(0, 140)})` : ` (cwd ${dir})`}`;
}

/** Waits (polling) until no stray processes of `root` are left, or `timeoutMs` passes. */
async function waitNoStrays(markers: string[], root: string, timeoutMs: number): Promise<string[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const strays = strayProcesses(markers, root);
		if (strays.length === 0 || Date.now() > deadline) return strays;
		await sleep(500);
	}
}

/** The sha256 of every `settings.json` / `hooks.json` under `~/.gemini` (the user configuration). */
function configChecksums(): Map<string, string> {
	const map = new Map<string, string>();
	const root = path.join(os.homedir(), ".gemini");
	const walk = (dir: string, depth: number): void => {
		if (depth > 8) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(p, depth + 1);
			} else if (entry.isFile() && (entry.name === "settings.json" || entry.name === "hooks.json")) {
				try {
					map.set(path.relative(root, p), createHash("sha256").update(fs.readFileSync(p)).digest("hex"));
				} catch {
					// unreadable now, unreadable then: not a change
				}
			}
		}
	};
	walk(root, 0);
	return map;
}

function diffChecksums(before: Map<string, string>, after: Map<string, string>): string[] {
	const out: string[] = [];
	for (const [key, hash] of after) {
		const old = before.get(key);
		if (old === undefined) out.push(`${key}: appeared`);
		else if (old !== hash) out.push(`${key}: changed`);
	}
	for (const key of before.keys()) {
		if (!after.has(key)) out.push(`${key}: missing`);
	}
	return out;
}

/**
 * The run's private root and the session scratch become `<SPIKE>`, the home becomes `<HOME>`,
 * the way the committed fixtures are written (the bridge dir lives under the private root, so
 * both roots collapse to the same placeholder).
 */
function normalize(s: string, privateTmp: string, scratch: string, home: string): string {
	let out = s;
	if (privateTmp !== "") out = out.split(privateTmp).join("<SPIKE>");
	if (scratch !== "") out = out.split(scratch).join("<SPIKE>");
	if (home !== "") out = out.split(home).join("<HOME>");
	return out;
}

// ---------------------------------------------------------------- the turn budget

class TurnBudget {
	private usedCount = 0;
	get used(): number {
		return this.usedCount;
	}
	/** Charges one model turn; a send that would exceed the cap fails the run. */
	charge(): void {
		this.usedCount += 1;
		if (this.usedCount > TURNS_MAX) {
			throw new Error(`turn budget exceeded: ${this.usedCount} > ${TURNS_MAX} - the run stops before spending more`);
		}
	}
}

// ---------------------------------------------------------------- the recorder hook

/**
 * The recorder hook's source, written into the scratch workspace. It appends the PreToolUse hook's
 * stdin payload verbatim to the file named by SMOKE_HOOK_LOG (capped, like the real hook's own
 * reader) and answers a no-op allow: under skip-permissions a hook cannot approve - the real
 * bridge hook is the only gate - and it never denies, so the chain runs on and the real decision
 * stands whatever the order of the two hooks is.
 */
const RECORDER_HOOK_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const MAX_PAYLOAD_BYTES = 1048576;
let input = "";
let capped = false;
process.stdin.on("data", (d) => {
	if (Buffer.byteLength(input) + d.length > MAX_PAYLOAD_BYTES) {
		capped = true;
		return;
	}
	input += d.toString("utf8");
});
process.stdin.on("end", () => {
	const out = process.env.SMOKE_HOOK_LOG ?? "";
	if (out !== "") {
		try {
			fs.appendFileSync(out, input + "\\n");
		} catch {
			// a dead recorder is a lost record, never a changed decision
		}
	}
	const line = JSON.stringify({ decision: "allow", reason: capped ? "agy-acp smoke recorder (payload capped)" : "agy-acp smoke recorder" });
	process.stdout.write(line, () => process.exit(0));
});
`;

interface HookRecorder {
	payloadFile: string;
}

/** Installs the recorder hook in the scratch workspace (agy walks up from the cwd and finds it). */
function installRecorderHook(scratch: string): HookRecorder {
	const payloadFile = path.join(scratch, "hook-payloads.jsonl");
	fs.writeFileSync(path.join(scratch, "recorder-hook.cjs"), RECORDER_HOOK_SOURCE);
	const hooksJson = JSON.stringify(
		{
			"agy-acp-smoke-recorder": {
				PreToolUse: [
					{
						matcher: "*",
						hooks: [
							{
								type: "command",
								command: `exec ${process.execPath} ${path.join(scratch, "recorder-hook.cjs")}`,
								timeout: 30,
							},
						],
					},
				],
			},
		},
		null,
		2,
	);
	fs.mkdirSync(path.join(scratch, ".agents"), { recursive: true });
	fs.writeFileSync(path.join(scratch, ".agents", "hooks.json"), hooksJson);
	return { payloadFile };
}

/** The recorded hook payloads, normalised the way the fixtures do. */
function readHookPayloads(recorder: HookRecorder, privateTmp: string, scratch: string, home: string): string[] {
	let raw = "";
	try {
		raw = fs.readFileSync(recorder.payloadFile, "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => normalize(l, privateTmp, scratch, home));
}

// ---------------------------------------------------------------- the driver

interface AgyExitInfo {
	code: number | null;
	signal: string | null;
	stderrTail: string;
}

interface TimelineEntry {
	atMs: number;
	text: string;
}

interface SmokeAgyOptions {
	argv0: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	probeTimeoutMs?: number;
	graceMs?: number;
	termMs?: number;
	log: (line: string) => void;
}

/**
 * One `agy` child in its own process group: the same lifecycle AgyProcess has (a probe that
 * resolves on the init's conversation id, a bounded stderr tail, the close-stdin/grace/SIGTERM/
 * term/SIGKILL dispose ladder, one "exit" after stdio is drained), plus a tap on the RAW stdout
 * lines - the exact lines of the stream, which is what a recorded fixture is.
 */
class SmokeAgy {
	private readonly child: ChildProcess;
	private readonly log: (line: string) => void;
	private readonly probeTimeoutMs: number;
	private readonly graceMs: number;
	private readonly termMs: number;
	private readonly startMs = Date.now();
	private stderrBuf = "";
	private exitedFlag = false;
	private exitInfoValue: AgyExitInfo | null = null;
	private spawnErrorValue: Error | null = null;
	private pendingProbe: { resolve: (id: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;
	private probePromiseValue: Promise<string> | null = null;
	private disposePromiseValue: Promise<AgyExitInfo> | null = null;
	private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	readonly argv: string[];
	readonly cwd: string;
	readonly rawLines: string[] = [];
	readonly timeline: TimelineEntry[] = [];
	/** The user lines sent (the probe event is not one: recorded fixtures list the user lines only). */
	readonly inputLines: string[] = [];
	readonly events: AgyEvent[] = [];

	constructor(options: SmokeAgyOptions) {
		this.log = options.log;
		this.argv = [...options.args];
		this.cwd = options.cwd;
		this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
		this.graceMs = options.graceMs ?? GRACE_MS;
		this.termMs = options.termMs ?? TERM_MS;
		this.child = spawnProcessGroup({
			command: options.argv0,
			args: options.args,
			cwd: options.cwd,
			env: options.env,
		});
		this.timeline.push({ atMs: 0, text: `args: agy ${options.args.join(" ")}` });
		this.timeline.push({ atMs: 0, text: `cwd: ${options.cwd}` });
		const decoder = new FrameDecoder(
			DEFAULT_MAX_FRAME_BYTES,
			(line) => this.handleLine(line),
			(reason) => this.log(`undecodable stdout frame: ${reason}`),
			() => {
				// the same condition the driver treats as fatal: a runaway line kills the child
				this.log(`stdout line exceeds ${DEFAULT_MAX_FRAME_BYTES} bytes - killing the child`);
				this.signalGroup("SIGKILL");
			},
		);
		const { stdout, stderr, stdin } = this.child;
		if (!stdout || !stderr || !stdin) {
			throw new Error("agy's stdio is not piped - cannot drive it");
		}
		stdout.on("data", (d: Buffer) => decoder.push(d));
		stderr.on("data", (d: Buffer) => this.appendStderr(d.toString("utf8")));
		for (const stream of [stdout, stderr, stdin]) {
			stream.on("error", (err: Error) => this.log(`stdio error: ${err.message}`));
		}
		this.child.on("error", (err: Error) => this.onSpawnError(err));
		// "close" (not "exit"): stdio is drained before the terminal state.
		this.child.on("close", (code, signal) => this.onExit(code, signal));
	}

	/** The raw pid (the process group id: the child runs in its own group). */
	get pid(): number | undefined {
		return this.child.pid;
	}
	get exited(): boolean {
		return this.exitedFlag;
	}
	get exitInfo(): AgyExitInfo | null {
		return this.exitInfoValue;
	}
	get spawnError(): Error | null {
		return this.spawnErrorValue;
	}
	get stderrTail(): string {
		return this.stderrBuf;
	}

	on(event: string, fn: (...args: unknown[]) => void): this {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(fn);
		return this;
	}
	once(event: string, fn: (...args: unknown[]) => void): this {
		const wrapper = (...args: unknown[]): void => {
			this.off(event, wrapper);
			fn(...args);
		};
		return this.on(event, wrapper);
	}
	off(event: string, fn: (...args: unknown[]) => void): this {
		this.listeners.get(event)?.delete(fn);
		return this;
	}
	private emit(event: string, ...args: unknown[]): void {
		// a listener that throws must not take the driver down
		for (const fn of this.listeners.get(event) ?? []) {
			try {
				fn(...args);
			} catch {
				// the driver's own logs carry the stream; a broken listener is the listener's problem
			}
		}
	}

	private timelineEntry(text: string): void {
		this.timeline.push({ atMs: Date.now() - this.startMs, text });
	}

	private appendStderr(chunk: string): void {
		this.stderrBuf += chunk;
		if (Buffer.byteLength(this.stderrBuf) > STDERR_TAIL_BYTES) {
			// the tail is what matters (a failure is at the end of what agy said)
			this.stderrBuf = this.stderrBuf.slice(-STDERR_TAIL_BYTES);
		}
	}

	private handleLine(line: string): void {
		this.rawLines.push(line);
		const parsed = parseAgyLine(line);
		if (parsed.kind === "unknown") {
			this.timelineEntry(`ignoring unknown agy event ${parsed.event === "" ? "(unparseable line)" : parsed.event}`);
			return;
		}
		this.recordEvent(parsed.event, line);
	}

	private recordEvent(event: AgyEvent, line: string): void {
		this.events.push(event);
		this.emit("event", event);
		if (event.event === "init") {
			this.timelineEntry("init");
			this.resolveProbeOnInit(event);
			return;
		}
		if (event.event === "step_update") {
			const s = event.step_update;
			this.timelineEntry(`step_update ${s.step_type}/${s.state}${s.tool_name !== undefined ? ` ${s.tool_name}` : ""}`);
			return;
		}
		// result: the raw event stays raw here (the fixture is the raw line; the session keeps the
		// cumulative state itself, the way the driver does).
		this.timelineEntry(`result ${line.length > 200 ? `${line.slice(0, 200)}…` : line}`);
	}

	private resolveProbeOnInit(event: AgyInitEvent): void {
		const pending = this.pendingProbe;
		if (event.conversation_id !== "") {
			if (pending) {
				this.pendingProbe = null;
				clearTimeout(pending.timer);
				pending.resolve(event.conversation_id);
			}
		} else if (pending) {
			// the drifted-init case: the child is still alive, so the probe can be retried
			this.rejectPendingProbe("init carried no conversation_id");
		}
	}

	/** One user turn, using the string content shape the recorded successful inputs prove. */
	send(text: string): void {
		if (this.exitedFlag) {
			throw new Error("agy has exited; its stdin is closed");
		}
		const line = JSON.stringify({ event: "user", message: { content: text } });
		this.inputLines.push(line);
		this.timelineEntry(`>> ${line.length > 120 ? `${line.slice(0, 120)}…` : line}`);
		const stdin = this.child.stdin;
		if (!stdin) {
			throw new Error("agy's stdin is not a pipe");
		}
		if (!stdin.write(`${line}\n`)) {
			this.log("stdin backpressure - continuing (stream lines are small)");
		}
	}

	/** Resolves with the init conversation id via a probe event agy ignores; a timeout allows a retry. */
	probe(timeoutMs?: number): Promise<string> {
		if (this.probePromiseValue) {
			return this.probePromiseValue;
		}
		if (this.exitedFlag) {
			return Promise.reject(new Error(`agy has exited (code=${this.exitInfoValue?.code ?? "unknown"}); cannot probe`));
		}
		const stdin = this.child.stdin;
		if (!stdin) {
			throw new Error("agy's stdin is not a pipe");
		}
		stdin.write(`${JSON.stringify({ event: AGY_PROBE_EVENT })}\n`);
		const ms = timeoutMs ?? this.probeTimeoutMs;
		const promise = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pendingProbe?.timer === timer) {
					// a timeout allows a retry
					this.pendingProbe = null;
					this.probePromiseValue = null;
				}
				reject(new Error(`agy did not send init within ${ms} ms; stderr tail: ${this.stderrTail}`));
			}, ms);
			timer.unref();
			this.pendingProbe = { resolve, reject, timer };
		});
		this.probePromiseValue = promise;
		return promise;
	}

	private rejectPendingProbe(message: string): void {
		const pending = this.pendingProbe;
		if (!pending) {
			return;
		}
		this.pendingProbe = null;
		this.probePromiseValue = null;
		clearTimeout(pending.timer);
		pending.reject(new Error(message));
	}

	/** SIGINT the child - the mechanism agy implements for canceling its own turn. */
	interrupt(): void {
		const pid = this.child.pid;
		if (pid !== undefined) {
			try {
				process.kill(pid, "SIGINT");
			} catch (err) {
				this.log(`interrupt failed: ${(err as Error).message}`);
			}
		}
	}

	/** Kills the whole group (a simulated crash, or a forced end): SIGKILL, no ladder. */
	killGroup(): void {
		const pid = this.child.pid;
		if (pid !== undefined) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch (err) {
				this.log(`killing the process group failed: ${(err as Error).message}`);
			}
		}
	}

	/** Shuts the child down: close stdin, graceMs, SIGTERM, termMs, SIGKILL. Idempotent. */
	dispose(): Promise<AgyExitInfo> {
		if (this.disposePromiseValue) {
			return this.disposePromiseValue;
		}
		this.disposePromiseValue = new Promise<AgyExitInfo>((resolve) => {
			// the ladder mirrors the driver's exactly: close stdin, graceMs, SIGTERM the group,
			// termMs, SIGKILL - nothing outlives it, and a child already gone settles at once.
			const finish = () => resolve(this.exitInfoValue ?? { code: null, signal: null, stderrTail: this.stderrTail });
			const afterKill = () => this.waitThen(1_000, finish, finish);
			const afterTerm = () =>
				this.waitThen(
					this.termMs,
					() => {
						this.signalGroup("SIGKILL");
						afterKill();
					},
					finish,
				);
			const stdin = this.child.stdin;
			if (stdin && !stdin.destroyed) {
				try {
					stdin.end();
				} catch (err) {
					this.log(`closing stdin failed: ${(err as Error).message}`);
				}
			}
			this.waitThen(
				this.graceMs,
				() => {
					this.signalGroup("SIGTERM");
					afterTerm();
				},
				finish,
			);
		});
		return this.disposePromiseValue;
	}

	private waitThen(ms: number, onTimeout: () => void, onExit: () => void): void {
		if (this.exitedFlag) {
			setImmediate(onExit);
			return;
		}
		let done = false;
		const settle = (fn: () => void) => {
			if (done) {
				return;
			}
			done = true;
			clearTimeout(timer);
			this.off("exit", onExitEvent);
			fn();
		};
		const onExitEvent = () => settle(onExit);
		this.once("exit", onExitEvent);
		const timer = setTimeout(() => settle(onTimeout), ms);
		timer.unref();
	}

	private signalGroup(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (pid === undefined) {
			return;
		}
		try {
			process.kill(-pid, signal);
		} catch (err) {
			// ESRCH: the group is already gone.
			this.log(`signalling process group -${pid} ${signal} failed: ${(err as Error).message}`);
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exitedFlag) {
			return;
		}
		this.exitedFlag = true;
		this.exitInfoValue = { code, signal: signal ?? null, stderrTail: this.stderrBuf };
		this.timelineEntry(`exit code=${code ?? "null"} sig=${signal ?? "null"}`);
		this.rejectPendingProbe(
			`agy exited before init (code=${code ?? "none"} signal=${signal ?? "none"}); stderr: ${this.stderrBuf.slice(0, 400)}`,
		);
		this.log(`agy exited code=${code ?? "none"} signal=${signal ?? "none"}`);
		this.emit("exit", this.exitInfoValue);
	}

	private onSpawnError(err: Error): void {
		this.spawnErrorValue = err;
		this.log(`spawn error: ${err.message}`);
		if (!this.exitedFlag) {
			this.exitedFlag = true;
			this.exitInfoValue = { code: null, signal: null, stderrTail: err.message };
			this.emit("exit", this.exitInfoValue);
		}
		this.rejectPendingProbe(`agy failed to start: ${err.message}`);
	}
}

// ---------------------------------------------------------------- the session

interface RecordedAsk {
	toolCallId: string;
	title: string;
	kind: string;
	rawInput: Record<string, unknown>;
}

interface ToolStep {
	stepIndex: number;
	name: string;
	state: string;
	output?: string;
	errorMessage?: string;
}

interface SessionOptions {
	name: string;
	cwd: string;
	agy: string;
	/** The model every launch of this session runs with. */
	model: string;
	/** The starting permission mode (a mid-scenario change respawns with the flag, like the session layer). */
	mode: string;
	/** The client's answer to a permission ask: the optionId, or null to reject. */
	decide: (ask: RecordedAsk) => Promise<string | null>;
	log: (line: string) => void;
	budget: TurnBudget;
}

/**
 * One smoke "session": the production PermissionGate (real bridge) plus a SmokeAgy per launch, with
 * the session layer's invariants mirrored by hand - one turn at a time (the gate's "no turn in
 * flight" refusal relies on it), a `--conversation` respawn when the child is gone (the probe must
 * come back with the same id, the session's own refusal), and the cumulative counters carried
 * across the respawn.
 */
class SmokeSession {
	readonly gate: PermissionGate;
	readonly name: string;
	readonly cwd: string;
	readonly processes: SmokeAgy[] = [];
	readonly asks: RecordedAsk[] = [];
	readonly updates: AcpSessionUpdate[] = [];
	/** The gate's own log lines (the authoritative record of its denials - agy's surfacing of the
	 * reason to the model is agy's business, the gate's decision is not). */
	readonly gateLogLines: string[] = [];
	readonly toolSteps: ToolStep[] = [];
	driver: SmokeAgy | null = null;
	conversationId = "";
	cumulative: AgyCumulative = { ...ZERO_CUMULATIVE, usage: { ...ZERO_CUMULATIVE.usage } };
	currentTurn: Promise<unknown> | null = null;
	turnCount = 0;
	private readonly agy: string;
	private readonly model: string;
	private readonly log: (line: string) => void;
	private readonly budget: TurnBudget;
	private readonly decide: (ask: RecordedAsk) => Promise<string | null>;
	private mode: string;
	private cancelledFlag = false;
	private token: string;

	constructor(options: SessionOptions) {
		this.name = options.name;
		this.cwd = options.cwd;
		this.agy = options.agy;
		this.model = options.model;
		this.mode = options.mode;
		this.log = options.log;
		this.budget = options.budget;
		this.decide = options.decide;
		this.token = newPermissionToken();
		const gateLog = (line: string): void => {
			this.gateLogLines.push(line);
			options.log(line);
		};
		this.gate = new PermissionGate({
			log: gateLog,
			notify: (update) => this.updates.push(update),
			request: (_method, params, _timeoutMs) => this.onAsk(params),
			cwd: options.cwd,
			clientDeadlineMs: CLIENT_DEADLINE_MS,
			hookDeadlineMs: HOOK_DEADLINE_MS,
			hookTimeoutSec: HOOK_TIMEOUT_SEC,
			token: this.token,
			conversationId: () => (this.conversationId === "" ? null : this.conversationId),
			currentTurn: () => this.currentTurn,
			turnCount: () => this.turnCount,
		});
		// the production session's own wiring (session.ts): a non-default mode is set on the gate
		// before the first turn - without this the plan-deny scenario would ask instead of denying
		if (this.mode !== "default") this.gate.setMode(this.mode);
	}

	async start(): Promise<void> {
		await this.gate.start();
		const driver = this.spawnDriver(false);
		try {
			this.conversationId = await driver.probe();
		} catch (err) {
			this.driver = null;
			await this.gate.dispose();
			await driver.dispose();
			throw err;
		}
	}

	/** The child for one launch (the first start or a `--conversation` respawn). */
	private spawnDriver(resume: boolean): SmokeAgy {
		const driver = new SmokeAgy({
			argv0: this.agy,
			args: agyArgs({
				model: this.model,
				mode: agyModeFlag(this.mode),
				addDirs: [this.gate.dir],
				skipPermissions: true,
				conversation: resume ? this.conversationId : undefined,
			}),
			cwd: this.cwd,
			env: {
				...process.env,
				AGY_ACP_SOCK: this.gate.socketPath,
				AGY_ACP_TOKEN: this.token,
				AGY_ACP_HOOK_DEADLINE_MS: String(HOOK_DEADLINE_MS),
				// the recorder hook appends the PreToolUse stdin it sees (the bridge hook is the gate)
				SMOKE_HOOK_LOG: path.join(this.cwd, "hook-payloads.jsonl"),
			},
			probeTimeoutMs: PROBE_TIMEOUT_MS,
			log: (line) => this.log(`[${this.name}] ${line}`),
		});
		driver.on("event", (e) => {
			const event = e as AgyEvent;
			if (event.event === "step_update") {
				this.onStreamEvent(event);
			}
		});
		this.processes.push(driver);
		this.driver = driver;
		return driver;
	}

	/** The stream's ACTIVE for a tool step: the args the hook will be asked about (mirrors the session). */
	private onStreamEvent(event: AgyStepUpdateEvent): void {
		const s = event.step_update;
		if (s.state === "ACTIVE" && s.tool_name !== undefined) {
			this.gate.onStreamActive(s.step_index, s.tool_name, s.tool_info?.parameters);
		}
		if (s.tool_name !== undefined) {
			const existing = this.toolSteps.find((t) => t.stepIndex === s.step_index);
			if (existing) {
				existing.state = s.state;
				if (s.tool_info?.output !== undefined) existing.output = s.tool_info.output;
				if (s.tool_info?.error?.message !== undefined) existing.errorMessage = s.tool_info.error.message;
			} else {
				this.toolSteps.push({
					stepIndex: s.step_index,
					name: s.tool_name,
					state: s.state,
					output: s.tool_info?.output,
					errorMessage: s.tool_info?.error?.message,
				});
			}
		}
	}

	/** The live child, respawning when needed (the session layer's own rule, mirrored). */
	private async ensureDriver(): Promise<SmokeAgy> {
		const current = this.driver;
		if (current && !current.exited) {
			return current;
		}
		if (current) {
			await current.dispose();
		}
		this.driver = null;
		const driver = this.spawnDriver(true);
		let probed: string;
		try {
			probed = await driver.probe();
		} catch (err) {
			await driver.dispose();
			throw err;
		}
		// A child that reports a conversation other than ours would silently rebind the session; the
		// session refuses it, and the next prompt retries the resume. This does the same.
		if (probed !== this.conversationId) {
			await driver.dispose();
			throw new Error(`agy started a new conversation (${probed}) instead of resuming ${this.conversationId}`);
		}
		return driver;
	}

	/**
	 * One prompt: the budget charges it, the gate's "no turn in flight" check sees it, the turn ends
	 * on the turn's `result` - or on the child's exit, which is an error the way the session says
	 * (a cancel is the exception: it settles the turn `cancelled`, like the session does at once).
	 */
	async turn(text: string): Promise<AgyResultEvent> {
		if (this.currentTurn) {
			throw new Error("turn in progress");
		}
		this.budget.charge();
		this.turnCount += 1;
		const driver = await this.ensureDriver();
		this.cancelledFlag = false;
		const resultPromise = new Promise<AgyResultEvent>((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`turn deadline (${TURN_DEADLINE_MS} ms) - the run moves on and the child is disposed`));
			}, TURN_DEADLINE_MS);
			timer.unref();
			const onEvent = (e: unknown): void => {
				const ev = e as AgyEvent;
				if (ev.event === "result") {
					cleanup();
					this.cumulative = cumulativeOf(ev.result);
					resolve(ev);
				}
			};
			const onExit = (info: unknown): void => {
				const i = info as AgyExitInfo;
				cleanup();
				if (this.cancelledFlag) {
					reject(new Error("cancelled"));
				} else {
					reject(new Error(`agy exited without a result (code=${i.code ?? "none"} signal=${i.signal ?? "none"})`));
				}
			};
			const cleanup = () => {
				clearTimeout(timer);
				driver.off("event", onEvent);
				driver.off("exit", onExit);
			};
			driver.on("event", onEvent);
			driver.on("exit", onExit);
		});
		// safety net: if send throws below, the turn already failed and the promise is never
		// awaited - its deadline timer (or a late driver exit) must not then crash the process
		// as an unhandled rejection
		resultPromise.catch(() => {
			/* handled here by construction: see the comment above */
		});
		this.currentTurn = resultPromise;
		try {
			driver.send(text);
			return await resultPromise;
		} finally {
			this.currentTurn = null;
			this.gate.onTurnEnd();
		}
	}

	/**
	 * Cancel, the session's own order: the asks are denied with the cancel reason (the hook is
	 * released, the dialog closes), the turn's bookkeeping ends, then the production cancel ladder
	 * makes agy stop.
	 */
	async cancel(): Promise<void> {
		const driver = this.driver;
		this.cancelledFlag = true;
		this.gate.abortPending("the client cancelled the turn", "cancelled");
		this.gate.onTurnEnd();
		if (driver && driver.pid !== undefined) {
			// cancelAgy's structural contract, honoured exactly: it reads pid, interrupt(), exited,
			// dispose() and once("exit"), all of which this driver mirrors from AgyProcess.
			cancelAgy(driver as unknown as AgyProcess, CANCEL_ESCALATE_MS, (line) => this.log(`[${this.name}] ${line}`));
		}
		if (driver) {
			await this.waitForExit(driver, CANCEL_EXIT_TIMEOUT_MS);
		}
	}

	/** Waits for the driver's exit (or timeout) - a cancel must not outlive the scenario. */
	private async waitForExit(driver: SmokeAgy, timeoutMs: number): Promise<void> {
		if (driver.exited) {
			return;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				driver.off("exit", onExit);
				// a cancel that cannot settle runs the driver's own ladder: nothing outlives it
				void driver.dispose();
				resolve();
			}, timeoutMs);
			timer.unref();
			const onExit = (): void => {
				clearTimeout(timer);
				resolve();
			};
			driver.once("exit", onExit);
		});
	}

	setMode(mode: string): void {
		this.gate.setMode(mode);
		this.mode = mode;
	}

	/** Simulates a crash between turns: the group dies, the next prompt pays the respawn. */
	killChild(): void {
		this.driver?.killGroup();
	}

	async dispose(): Promise<void> {
		const driver = this.driver;
		this.driver = null;
		this.currentTurn = null;
		this.gate.abortPending("the smoke session was disposed", "ended");
		this.gate.onTurnEnd();
		if (driver) {
			await driver.dispose();
		}
		await this.gate.dispose();
	}

	private async onAsk(params: Record<string, unknown>): Promise<unknown> {
		const toolCall = typeof params.toolCall === "object" && params.toolCall !== null ? (params.toolCall as Record<string, unknown>) : {};
		const ask: RecordedAsk = {
			toolCallId: typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : "",
			title: typeof toolCall.title === "string" ? toolCall.title : "",
			kind: typeof toolCall.kind === "string" ? toolCall.kind : "",
			rawInput: typeof toolCall.rawInput === "object" && toolCall.rawInput !== null ? (toolCall.rawInput as Record<string, unknown>) : {},
		};
		this.asks.push(ask);
		this.log(`[${this.name}] permission ask: ${ask.title.slice(0, 120)}`);
		const optionId = await this.decide(ask);
		if (optionId === null) {
			return { outcome: { outcome: "selected", optionId: "reject_once" } };
		}
		return { outcome: { outcome: "selected", optionId } };
	}
}

// ---------------------------------------------------------------- the ACP client (client-disconnect)

interface AcpClientOptions {
	child: ChildProcess;
	log: (line: string) => void;
	onNotification: (method: string, params: unknown) => void;
	onRequest: (method: string, params: unknown) => Promise<unknown>;
}

/** A minimal JSON-RPC 2.0 client: newline-delimited frames, one correlation table, one reader. */
class AcpClient {
	private readonly child: ChildProcess;
	private readonly log: (line: string) => void;
	private readonly onNotification: (method: string, params: unknown) => void;
	private readonly onRequest: (method: string, params: unknown) => Promise<unknown>;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private closed = false;

	constructor(options: AcpClientOptions) {
		this.child = options.child;
		this.log = options.log;
		this.onNotification = options.onNotification;
		this.onRequest = options.onRequest;
		const decoder = new FrameDecoder(
			DEFAULT_MAX_FRAME_BYTES,
			(line) => this.handleLine(line),
			(reason) => this.log(`undecodable frame: ${reason}`),
			(bytes) => this.log(`frame exceeds ${bytes} bytes - dropping`),
		);
		this.child.stdout?.on("data", (d: Buffer) => decoder.push(d));
		this.child.stderr?.on("data", (d: Buffer) => {
			const text = d.toString("utf8").trimEnd();
			if (text !== "") this.log(`server: ${text.slice(0, 200)}`);
		});
		this.child.on("error", (err: Error) => this.log(`server spawn error: ${err.message}`));
		this.child.on("exit", () => {
			for (const { reject, timer } of this.pending.values()) {
				clearTimeout(timer);
				reject(new Error("the server exited"));
			}
			this.pending.clear();
		});
	}

	private handleLine(line: string): void {
		let frame: unknown;
		try {
			frame = JSON.parse(line);
		} catch {
			this.log(`unparseable frame: ${line.slice(0, 120)}`);
			return;
		}
		const f = frame as Record<string, unknown>;
		if (typeof f.id === "number" && (f.result !== undefined || f.error !== undefined)) {
			const p = this.pending.get(f.id);
			if (!p) return;
			this.pending.delete(f.id);
			clearTimeout(p.timer);
			if (f.error !== undefined) {
				const e = f.error as Record<string, unknown>;
				p.reject(new Error(`rpc error ${e.code}: ${e.message}`));
			} else {
				p.resolve(f.result);
			}
			return;
		}
		if (typeof f.method === "string" && typeof f.id === "number") {
			// an incoming request: answer it (the permission ask is the one this run sends)
			const id = f.id;
			void this.onRequest(f.method, f.params)
				.then((result) => this.writeFrame({ jsonrpc: "2.0", id, result }))
				.catch((err: Error) => this.writeFrame({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } }));
			return;
		}
		if (typeof f.method === "string") {
			try {
				this.onNotification(f.method, f.params);
			} catch (err) {
				this.log(`notification handler failed: ${(err as Error).message}`);
			}
		}
	}

	request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (this.closed) {
			return Promise.reject(new Error("the connection is closed"));
		}
		const id = this.nextId;
		this.nextId += 1;
		const promise = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs} ms`));
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, { resolve, reject, timer });
		});
		void this.writeFrame({ jsonrpc: "2.0", id, method, params });
		return promise;
	}

	closeInput(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.child.stdin?.end();
		} catch (err) {
			this.log(`closing the client's stdin failed: ${(err as Error).message}`);
		}
	}

	waitExit(timeoutMs: number): Promise<{ code: number | null; signal: string | null }> {
		return new Promise((resolve) => {
			if (this.child.exitCode !== null || this.child.signalCode !== null) {
				resolve({ code: this.child.exitCode, signal: this.child.signalCode ?? null });
				return;
			}
			const timer = setTimeout(() => {
				this.child.kill("SIGKILL");
			}, timeoutMs);
			timer.unref();
			this.child.on("exit", (code, signal) => {
				clearTimeout(timer);
				resolve({ code, signal: signal ?? null });
			});
		});
	}

	private writeFrame(frame: Record<string, unknown>): Promise<void> {
		return new Promise((resolve) => {
			const data = `${JSON.stringify(frame)}\n`;
			const stdin = this.child.stdin;
			if (!stdin || stdin.destroyed) {
				resolve();
				return;
			}
			if (stdin.write(data, (err) => (err ? this.log(`frame write failed: ${err.message}`) : undefined))) {
				resolve();
			} else {
				stdin.once("drain", () => resolve());
			}
		});
	}
}

// ---------------------------------------------------------------- the field inventory

type InventoryEntry = string[] | string;
type Inventory = Record<string, Record<string, InventoryEntry>>;

/** Is this string the shape of an id, a path or a free-text value (record its type, not the value)? */
function isIdLike(s: string): boolean {
	if (s.length === 0 || s.length > 24) return true;
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true; // dates
	if (/^[0-9a-f]{8,}$/i.test(s) && s.length >= 8) return true; // hex ids
	if (s.startsWith("/") || s.startsWith("~")) return true; // paths
	if (s.startsWith("<")) return true; // the run's own placeholders (<SPIKE>, <HOME>): recording them would churn the inventory on every refresh
	if (s.includes("://")) return true; // urls
	if (/\s/.test(s)) return true; // free text
	if (/^[0-9.]+$/.test(s)) return true; // numbers in strings
	return false;
}

/**
 * The inventory scheme (the committed file's, made explicit): per event type, per dotted path, a
 * type marker ("string" / "number" / "boolean"), short stable string literals ("string:ACTIVE"),
 * and "array" for arrays - with object elements expanded one level under a "[]" segment, the way
 * the committed inventory expands `subagents`. Primitive array elements record nothing beyond
 * "array" (the committed file keeps `init.tools` at "array"); the free-text paths the committed
 * file keeps generic get no literals either.
 */
const NO_LITERAL_SEGMENTS = new Set(["response", "text_delta", "initial_prompt", "error", "name", "reason"]);

function lastSegment(path: string): string {
	const bare = path.replace(/\[\]$/, "");
	const i = bare.lastIndexOf(".");
	return i < 0 ? bare : bare.slice(i + 1);
}

function addValueToInventory(table: Record<string, InventoryEntry>, path: string, value: unknown): void {
	if (Array.isArray(value)) {
		addArrayToInventory(table, path, value);
		return;
	}
	if (typeof value === "string") {
		addStringToInventory(table, path, value);
		return;
	}
	if (typeof value === "object" && value !== null) {
		addObjectToInventory(table, path, value as Record<string, unknown>);
		return;
	}
	if (typeof value === "number") {
		addEntry(table, path, "number");
		return;
	}
	if (typeof value === "boolean") {
		addEntry(table, path, "boolean");
		return;
	}
	// null and undefined: a type the committed scheme does not name - record nothing.
}

function addStringToInventory(table: Record<string, InventoryEntry>, path: string, value: string): void {
	addEntry(table, path, "string");
	if (!isIdLike(value) && !NO_LITERAL_SEGMENTS.has(lastSegment(path))) {
		addEntry(table, path, `string:${value}`);
	}
}

function addArrayToInventory(table: Record<string, InventoryEntry>, path: string, value: unknown[]): void {
	addEntry(table, path, "array");
	for (const element of value) {
		if (typeof element === "object" && element !== null && !Array.isArray(element)) {
			for (const [k, v] of Object.entries(element as Record<string, unknown>)) {
				if (!/^[A-Za-z_][\w-]*$/.test(k)) continue;
				// the element's key stays in the path (subagents[].type_name): dropping it would
				// merge the fields under one bare "[]" path - the committed scheme (and
				// test-contract's accessors) do not have that shape
				addValueToInventory(table, `${path}[].${k}`, v);
			}
		}
		// primitive elements: the committed scheme records "array" and nothing else
	}
}

function addObjectToInventory(table: Record<string, InventoryEntry>, path: string, value: Record<string, unknown>): void {
	for (const [k, v] of Object.entries(value)) {
		if (!/^[A-Za-z_][\w-]*$/.test(k)) continue;
		addValueToInventory(table, path === "" ? k : `${path}.${k}`, v);
	}
}

function addEntry(table: Record<string, InventoryEntry>, path: string, marker: string): void {
	const existing = table[path];
	const arr: string[] = typeof existing === "string" ? [existing] : existing !== undefined ? existing : [];
	table[path] = arr;
	if (!arr.includes(marker)) arr.push(marker);
}

/** One decoded event's inventory (its event type plus the dotted paths below it). */
function addEventToInventory(inv: Inventory, event: AgyEvent): void {
	const name = event.event;
	let table = inv[name];
	if (!table) {
		table = {};
		inv[name] = table;
	}
	addValueToInventory(table, "", event);
}

/** All events of the live run, one inventory (the diff's live side). */
function computeLiveInventory(events: AgyEvent[]): Inventory {
	const inv: Inventory = {};
	for (const e of events) {
		addEventToInventory(inv, e);
	}
	return inv;
}

/** One file's inventory (the --record recomputation over the whole fixture directory). */
function computeFileInventory(file: string): Inventory {
	const inv: Inventory = {};
	let raw = "";
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return inv;
	}
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		const parsed = parseAgyLine(line);
		if (parsed.kind === "event") {
			addEventToInventory(inv, parsed.event);
		}
	}
	return inv;
}

/** Unions file inventories into one (the file list is sorted; inside, the union keeps
 * first-seen order - the committed file's convention, which stabiliseInventory preserves). */
function unionInventories(files: string[]): Inventory {
	const inv: Inventory = {};
	for (const file of files) mergeOneFile(inv, file);
	return stabiliseInventory(inv);
}

function mergeOneFile(inv: Inventory, file: string): void {
	const one = computeFileInventory(file);
	for (const [event, table] of Object.entries(one)) {
		let target = inv[event];
		if (!target) {
			target = {};
			inv[event] = target;
		}
		for (const [p, v] of Object.entries(table)) {
			for (const marker of typeof v === "string" ? [v] : v) {
				addEntry(target, p, marker);
			}
		}
	}
}

/**
 * Canonical, in the committed files' written form: events, paths and markers in first-seen order
 * (the committed files are not sorted), deduplicated; a lone "array" marker stays a bare string
 * (the committed scheme's one bare string); a "string" type marker the literals already imply is
 * dropped (the committed scheme's curation); every other marker is an array element.
 */
function stabiliseInventory(inv: Inventory): Inventory {
	const out: Inventory = {};
	for (const event of Object.keys(inv)) {
		const table: Record<string, InventoryEntry> = {};
		const source = inv[event] ?? {};
		for (const p of Object.keys(source)) {
			const v = source[p];
			if (v === undefined) {
				table[p] = "string";
				continue;
			}
			let markers = [...new Set(Array.isArray(v) ? v : [v])];
			if (markers.includes("string") && markers.some((m) => m.startsWith("string:"))) {
				markers = markers.filter((m) => m !== "string");
			}
			table[p] = markers.length === 1 && markers[0] === "array" ? "array" : markers;
		}
		out[event] = table;
	}
	return out;
}

/**
 * The committed files' written form, which is also their biome-stable form. Biome's hard rule
 * is a line cutoff: a 140-column array line (key prefix included, tab width one column) always
 * expands, a 139-column one stays inline, and below the cutoff it keeps whichever layout the
 * author wrote - so a recorded file is biome-stable when every line it inlines is under 140
 * columns (byte-identity with the previous file is not guaranteed for an array that fits both
 * ways, and that is fine: `npm run format:check` accepts either).
 */
function serialiseCommittedForm(value: unknown, indent: number): string {
	const pad = "\t".repeat(indent);
	const inner = "\t".repeat(indent + 1);
	const inner2 = "\t".repeat(indent + 2);
	const serialiseArray = (arr: unknown[]): string => {
		if (arr.length === 0) return "[]";
		// an element that is itself an object serialises multi-line (objects always expand),
		// so such an array never sits on one line - biome re-expands the "[{" hybrid, so
		// expanding is its only stable layout
		const hasObjectElement = arr.some((x) => typeof x === "object" && x !== null);
		if (!hasObjectElement) {
			const inline = `[${arr.map((v) => serialiseCommittedForm(v, indent + 1)).join(", ")}]`;
			// biome's hard cutoff: a 140-column array line (key prefix included, tab width one
			// column) always expands, a 139-column one stays inline, and below the cutoff it
			// keeps whichever layout the author wrote - so a recorded file is biome-stable
			// when every line it inlines is under 140 columns (byte-identity with the previous
			// file is not guaranteed for an array that fits both ways, and that is fine:
			// `npm run format:check` accepts either)
			if (pad.length + inline.length < 140) return inline;
		}
		return `[\n${arr.map((v) => `${inner}${serialiseCommittedForm(v, indent + 1)}`).join(",\n")}\n${pad}]`;
	};
	if (Array.isArray(value)) {
		return serialiseArray(value);
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) return "{}";
		const lines = entries.map(([k, v]) => {
			const keyPart = `${inner}"${k}": `;
			if (Array.isArray(v)) {
				if (v.length === 0) return `${keyPart}[]`;
				const hasObjectElement = v.some((x) => typeof x === "object" && x !== null);
				if (!hasObjectElement) {
					const inline = `[${v.map((x) => serialiseCommittedForm(x, indent + 2)).join(", ")}]`;
					if (keyPart.length + inline.length < 140) return `${keyPart}${inline}`;
				}
				return `${keyPart}[\n${v.map((x) => `${inner2}${serialiseCommittedForm(x, indent + 2)}`).join(",\n")}\n${inner}]`;
			}
			return `${keyPart}${serialiseCommittedForm(v, indent + 1)}`;
		});
		return `{\n${lines.join(",\n")}\n${pad}}`;
	}
	return JSON.stringify(value);
}

interface NormalisedPath {
	types: Set<string>;
	literals: Set<string>;
}

/** Both sides of a diff into one shape: "string:ACTIVE" is a literal (implying "string"), a bare
 * marker is a type, "array" is a type. */
function normaliseInventory(inv: Inventory): Record<string, Record<string, NormalisedPath>> {
	const out: Record<string, Record<string, NormalisedPath>> = {};
	for (const [event, table] of Object.entries(inv)) {
		out[event] = {};
		for (const [p, v] of Object.entries(table)) {
			out[event][p] = normaliseMarkers(v);
		}
	}
	return out;
}

function isTypeMarker(m: string): boolean {
	return m === "array" || m === "string" || m === "number" || m === "boolean";
}

function normaliseMarkers(v: InventoryEntry): NormalisedPath {
	const np: NormalisedPath = { types: new Set(), literals: new Set() };
	for (const marker of Array.isArray(v) ? v : [v]) {
		if (isTypeMarker(marker)) np.types.add(marker);
		else if (marker.startsWith("string:")) {
			np.types.add("string");
			np.literals.add(marker.slice("string:".length));
		}
	}
	return np;
}

interface InventoryDiff {
	/** Paths the live run has that the committed inventory does not (a new field: the drift). */
	added: Record<string, string[]>;
	/** Paths the committed inventory has that the live run never produced (a removed field). */
	removed: Record<string, string[]>;
	typeChanges: { event: string; path: string; committed: string[]; live: string[] }[];
	literalAdded: { event: string; path: string; value: string }[];
	literalRemoved: { event: string; path: string; value: string }[];
}

/** The field inventory diff: the drift watch's verdict on the stream contract. */
function diffInventory(committed: Inventory, live: Inventory): InventoryDiff {
	const c = normaliseInventory(committed);
	const l = normaliseInventory(live);
	const out: InventoryDiff = { added: {}, removed: {}, typeChanges: [], literalAdded: [], literalRemoved: [] };
	for (const event of [...new Set([...Object.keys(c), ...Object.keys(l)])].sort()) {
		diffEventTable(c[event] ?? {}, l[event] ?? {}, event, out);
	}
	return out;
}

function diffEventTable(ce: Record<string, NormalisedPath>, le: Record<string, NormalisedPath>, event: string, out: InventoryDiff): void {
	for (const p of [...new Set([...Object.keys(ce), ...Object.keys(le)])].sort()) {
		diffPath(ce[p], le[p], event, p, out);
	}
}

function diffPath(a: NormalisedPath | undefined, b: NormalisedPath | undefined, event: string, p: string, out: InventoryDiff): void {
	if (!b) {
		pushPath(out.removed, event, p);
		return;
	}
	if (!a) {
		pushPath(out.added, event, p);
		return;
	}
	// the committed set is the previous run's; the type sets are compared sorted, so a
	// marker-order-only difference is not a type change
	if ([...a.types].sort().join(",") !== [...b.types].sort().join(",")) {
		out.typeChanges.push({ event, path: p, committed: [...a.types].sort(), live: [...b.types].sort() });
	}
	diffLiterals(a, b, event, p, out);
}

function pushPath(table: Record<string, string[]>, event: string, p: string): void {
	if (table[event] === undefined) table[event] = [];
	table[event].push(p);
}

function diffLiterals(a: NormalisedPath, b: NormalisedPath, event: string, p: string, out: InventoryDiff): void {
	for (const v of [...b.literals].sort()) {
		if (!a.literals.has(v)) out.literalAdded.push({ event, path: p, value: v });
	}
	for (const v of [...a.literals].sort()) {
		if (!b.literals.has(v)) out.literalRemoved.push({ event, path: p, value: v });
	}
}

// ---------------------------------------------------------------- fixtures and meta

interface FixtureMeta {
	sourceRun: string;
	agyVersion: string;
	args: string;
	inputLines: string[];
	exitCode: string;
	signal: string;
	stderr: string;
	timeline: string[];
}

/** The meta the committed fixtures carry, for one recorded process (paths normalised). */
function buildMeta(driver: SmokeAgy, sourceRun: string, version: string, privateTmp: string, scratch: string, home: string): FixtureMeta {
	const info = driver.exitInfo ?? { code: null, signal: null, stderrTail: "" };
	const timeline = driver.timeline.map((e) => {
		// the committed metas write the args:/cwd: lines bare (no timestamp), the rest timed
		const timed = e.text.startsWith("args:") || e.text.startsWith("cwd:") ? "" : `${(e.atMs / 1000).toFixed(2)} `;
		return normalize(`${timed}${e.text}`, privateTmp, scratch, home);
	});
	const argsLine = `agy ${driver.argv.length > 0 ? driver.argv.join(" ") : ""}`;
	return {
		sourceRun,
		agyVersion: version,
		// fake-agy's checkRecordedArgs drops the leading "agy" token; driverOptsFor skips it
		// (and the unhandled --input-format/--output-format), so the recorded line must lead with
		// exactly that token for the two to see the same argv.
		args: normalize(argsLine, privateTmp, scratch, home),
		inputLines: driver.inputLines.map((l) => normalize(l, privateTmp, scratch, home)),
		exitCode: String(info.code),
		signal: String(info.signal),
		stderr: normalize(info.stderrTail, privateTmp, scratch, home),
		timeline,
	};
}

interface RecordedFixture {
	/** The record key (the --record name mapping's key). */
	fixtureName: string;
	/** The scenario label (the report groups by scenario). */
	scenario: string;
	driver: SmokeAgy;
}

function writeFixtureFile(
	dir: string,
	name: string,
	driver: SmokeAgy,
	meta: FixtureMeta,
	privateTmp: string,
	scratch: string,
	home: string,
): void {
	fs.mkdirSync(dir, { recursive: true });
	const lines = driver.rawLines.map((l) => normalize(l, privateTmp, scratch, home));
	fs.writeFileSync(path.join(dir, `${name}.stdout.ndjson`), lines.join("\n") + (lines.length > 0 ? "\n" : ""));
	// the committed fixtures' written form (tab indent, arrays inline when they fit)
	fs.writeFileSync(path.join(dir, `${name}.meta.json`), `${serialiseCommittedForm(meta, 0)}\n`);
}

/** The --record name mapping: the live scenario -> the committed fixture it refreshes
 * (`simple-textblock` is a new fixture: no committed fixture covers the single-turn shape). */
const RECORD_NAME_MAP: Record<string, string> = {
	simple: "simple-textblock",
	"multi-turn": "simple-multiturn-textblocks",
	"tool-allow": "tool-allowed-skip-permissions",
	"tool-deny": "tool-hook-denied",
	"plan-deny": "plan-mode-denied",
	"allow-always": "allow-always-grant",
	"cancel-sleep": "interrupted-sigint",
	"resume-after-restart": "resumed-conversation",
	"bad-model": "bad-model-id",
};

function readInventoryFile(): Inventory {
	try {
		const raw = fs.readFileSync(path.join(FIXTURES_DIR, "field-inventory.json"), "utf8");
		return JSON.parse(raw) as Inventory;
	} catch {
		return {};
	}
}

/** --record: write the live fixtures into the committed tree and recompute the committed inventory. */
function recordFixtures(
	fixtures: RecordedFixture[],
	version: string,
	privateTmp: string,
	scratch: string,
	home: string,
): { diff: InventoryDiff; written: string[] } {
	const committedBefore = readInventoryFile();
	const written: string[] = [];
	for (const f of fixtures) {
		const name = RECORD_NAME_MAP[f.fixtureName];
		if (!name) continue;
		const meta = buildMeta(f.driver, `smoke-${f.fixtureName}`, version, privateTmp, scratch, home);
		writeFixtureFile(FIXTURES_DIR, name, f.driver, meta, privateTmp, scratch, home);
		written.push(name);
	}
	const allFiles = fs
		.readdirSync(FIXTURES_DIR)
		.filter((f) => f.endsWith(".stdout.ndjson"))
		.map((f) => path.join(FIXTURES_DIR, f))
		.sort();
	const after = unionInventories(allFiles);
	// the committed fixtures' written form (tab indent, arrays inline when they fit)
	fs.writeFileSync(path.join(FIXTURES_DIR, "field-inventory.json"), `${serialiseCommittedForm(after, 0)}\n`);
	return { diff: diffInventory(committedBefore, after), written };
}

function badModelResultError(driver: SmokeAgy): boolean {
	return driver.events.some((e) => e.event === "result" && (e as AgyResultEvent).result.status === "ERROR");
}

function badModelDriverGone(driver: SmokeAgy | undefined): boolean {
	return driver?.exited === true;
}

/** The committed fixture's shape: the prompt goes in before the failure is known, the probe's
 * error is captured (not fatal), and a still-live child is given a beat for its result event.
 * Returns the probe's error (if the launch refused) and the child (for the checks and the
 * fixture). */
async function badModelProbe(session: SmokeSession): Promise<{ probeError: string | null; driver: SmokeAgy | undefined }> {
	const startP = session.start();
	await sleep(200);
	const earlyDriver = session.processes[0];
	if (earlyDriver !== undefined && !earlyDriver.exited) {
		try {
			earlyDriver.send(PROMPT_PONG);
		} catch {
			// the child is already gone: the fixture records what it got
		}
	}
	let probeError: string | null = null;
	try {
		await startP;
	} catch (err) {
		probeError = (err as Error).message;
	}
	const driver = session.processes[0];
	if (driver !== undefined && !driver.exited) {
		await sleep(3_000); // give the (committed fixture's) result event a beat to arrive
		await driver.dispose();
	}
	return { probeError, driver };
}

/** The --record step: a fully green run only - a failed run refuses, so the committed set keeps
 * the last good run. */
function runRecordStep(
	record: boolean,
	allOk: boolean,
	fixtures: RecordedFixture[],
	version: string,
	privateTmp: string,
	scratch: string,
	home: string,
): { diff: InventoryDiff; written: string[] } | { refused: true } | null {
	if (!record) return null;
	if (!allOk) {
		// the refusal must be visible in the report too, not just on the console
		say("\n[--record] refusing to record a failed run: the committed fixtures keep the last green run");
		return { refused: true };
	}
	say("\n[--record] writing the live fixtures into test/fixtures/stream/");
	const result = recordFixtures(fixtures, version, privateTmp, scratch, home);
	say(`  written: ${result.written.join(", ") || "(nothing mapped)"}`);
	return result;
}

// ---------------------------------------------------------------- scenario results

interface ScenarioResult {
	name: string;
	ok: boolean;
	detail: string;
	turns: number;
	durationMs: number;
	checks: string;
}

interface Check {
	passed: boolean;
	label: string;
}

function checkRecord(checks: Check[]): string {
	return checks.map((c) => `${c.passed ? "ok" : "FAIL"}: ${c.label}`).join("; ");
}

// ---------------------------------------------------------------- the run

interface CliArgs {
	record: boolean;
	agyBin: string;
	exitCode: number | null;
	message: string;
}

interface ArgState {
	record: boolean;
	agyBin: string;
}

function parseCliArgs(argv: string[]): CliArgs {
	const state: ArgState = { record: false, agyBin: "agy" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		if (a === "--record") {
			state.record = true;
			continue;
		}
		if (a === "--help" || a === "-h") {
			return {
				record: state.record,
				agyBin: state.agyBin,
				exitCode: 0,
				message:
					"usage: smoke-live.ts [--record] [--agy <path>]\n\n  --record  also write the live fixtures into agy-acp/test/fixtures/stream/ and update the field inventory",
			};
		}
		if (a === "--agy") {
			// consume the path token too, or it would be re-parsed as its own argument
			i += 1;
			const next = argv[i];
			if (next === undefined) {
				return { record: state.record, agyBin: state.agyBin, exitCode: 2, message: "--agy needs a path" };
			}
			state.agyBin = next;
			continue;
		}
		if (a.startsWith("--agy=")) {
			state.agyBin = a.slice("--agy=".length);
			continue;
		}
		return { record: state.record, agyBin: state.agyBin, exitCode: 2, message: `unknown argument: ${a}` };
	}
	return { record: state.record, agyBin: state.agyBin, exitCode: null, message: "" };
}

/**
 * A scenario body's session must be disposed even when the body throws: the child is a real
 * `agy` (launched with --dangerously-skip-permissions), and a live child's stdio keeps the
 * event loop alive, so an undisposed session would wedge the run after the FAIL is printed.
 * Idempotent (the gate's dispose is flag-guarded, the driver's memoised), so a thrown body
 * still disposes exactly once.
 */
function withDispose<T>(session: SmokeSession, fn: () => Promise<T>): Promise<T> {
	return (async () => {
		try {
			return await fn();
		} finally {
			try {
				await session.dispose();
			} catch {
				// best effort: the post-run process check is the backstop
			}
		}
	})();
}

interface Preflight {
	status: Awaited<ReturnType<typeof checkAgyVersion>>;
}

/**
 * Before any model turn: the binary's version (an untested one is a warning, not a refusal - the
 * run's job is to notice the drift, and a refusal would notice it too late) and the model's
 * availability (that one is a refusal, before any turn at all).
 */
async function preflight(agyBin: string): Promise<Preflight | string> {
	const status = await checkAgyVersion([agyBin, "--version"], 30_000, process.env);
	say(`agy ${status.version} (tested: ${TESTED_AGY_VERSIONS.join(", ")})`);
	if (status.warning !== null) say(`warning: ${status.warning}`);
	try {
		const models = await listAgyModels([agyBin], 60_000, process.env);
		if (!models.some((m) => m.modelId === MODEL)) {
			return `refusing before any turn: agy models has no ${MODEL}`;
		}
		return { status };
	} catch (err) {
		return `refusing before any turn: agy models failed: ${(err as Error).message}`;
	}
}

/** The dated, append-only report directory (a second run the same day takes -2, -3, …). */
function allocateReportDir(date: string): string {
	let reportDir = path.join(REPO_DIR, "reports", `smoke-${date}`);
	for (let n = 2; fs.existsSync(reportDir); n++) {
		reportDir = path.join(REPO_DIR, "reports", `smoke-${date}-${n}`);
	}
	return reportDir;
}

// The run's temp roots, tracked so a fatal throw anywhere after their creation can remove
// them: a half-run that leaves a tree in /tmp is exactly the noise the run exists to avoid.
const tempRoots: string[] = [];

async function main(): Promise<number> {
	const startedAt = Date.now();
	const parsed = parseCliArgs(process.argv.slice(2));
	if (parsed.exitCode !== null) {
		say(parsed.message);
		return parsed.exitCode;
	}
	const { record, agyBin } = parsed;

	// Never in CI: the run spends model quota and needs a logged-in `agy` - both are decisions a
	// human makes. The suite wiring (test/run.sh) never names this file; this is the backstop.
	if (process.env.CI) {
		say("refusing to run: CI is set (this smoke spends model quota and is a human's decision)");
		return 2;
	}

	say(`agy-acp live smoke (issue #60): model ${MODEL}, hard cap ${TURNS_MAX} turns${record ? ", --record" : ""}`);

	// A private runtime root: the bridge dirs this run creates must not be swept by (or sweep)
	// anything outside the run.
	const privateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-smoke-"));
	tempRoots.push(privateTmp);
	process.env.TMPDIR = privateTmp;
	delete process.env.XDG_RUNTIME_DIR;
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-smoke-work-"));
	tempRoots.push(scratch);
	await fs.promises.chmod(scratch, 0o700);
	const home = os.homedir();

	// Preflight, before any model turn (see above): the version warning is not a refusal. The
	// before-checksum goes first: the preflight's `agy --version`/`agy models` are agy too, and
	// their config writes must fall inside the before/after window.
	const configBefore = configChecksums();
	let pre: Preflight | string;
	try {
		pre = await preflight(agyBin);
	} catch (err) {
		pre = `refusing before any turn: preflight failed: ${(err as Error).message}`;
	}
	if (typeof pre === "string") {
		say(pre);
		await fs.promises.rm(privateTmp, { recursive: true, force: true });
		await fs.promises.rm(scratch, { recursive: true, force: true });
		return 2;
	}
	const { status: versionStatus } = pre;

	const recorder = installRecorderHook(scratch);
	const budget = new TurnBudget();
	const log = (line: string): void => say(`  ${line}`);
	const logFile = path.join(privateTmp, "smoke-live.log");
	const fileLog = (line: string): void => {
		try {
			fs.appendFileSync(logFile, `${line}\n`);
		} catch {
			// diagnostics only
		}
	};
	const bothLog = (line: string): void => {
		log(line);
		fileLog(line);
	};

	const scenarios: ScenarioResult[] = [];
	const trackedPids: number[] = [];
	const recordedFixtures: RecordedFixture[] = [];
	const pushFixture = (name: string, scenario: string, driver: SmokeAgy | null | undefined): void => {
		if (driver !== null && driver !== undefined) {
			recordedFixtures.push({ fixtureName: name, scenario, driver });
		}
	};

	const runScenario = async (name: string, fn: () => Promise<{ ok: boolean; detail: string; checks: Check[] }>): Promise<void> => {
		say(`\n[${name}]`);
		const t0 = Date.now();
		const turnsBefore = budget.used;
		let ok = false;
		let detail = "";
		let checks: Check[] = [];
		try {
			const r = await fn();
			ok = r.ok;
			detail = r.detail;
			checks = r.checks;
		} catch (err) {
			detail = `threw: ${(err as Error).message}`;
			checks = [{ passed: false, label: detail }];
		}
		scenarios.push({
			name,
			ok,
			detail,
			turns: budget.used - turnsBefore,
			durationMs: Date.now() - t0,
			checks: checkRecord(checks),
		});
		say(ok ? `  pass - ${detail}` : `  FAIL - ${detail}`);
	};

	// ---------------------------------------------------------------- scenario bodies

	const expectAskFor = (session: SmokeSession, needle: string): boolean =>
		session.asks.some((a) => a.rawInput.CommandLine !== undefined && String(a.rawInput.CommandLine).includes(needle));

	// 1: simple - one turn, the committed `simple-textblock` shape (new fixture name, the
	// 1.4.2-era fixture covers the multi-turn shape only).
	await runScenario("simple", async () => {
		const session = new SmokeSession({
			name: "si",
			cwd: scratch,
			agy: agyBin,
			model: MODEL,
			mode: "default",
			decide: async () => null, // no tool is expected; an ask is a drift signal
			log: bothLog,
			budget,
		});
		return withDispose(session, async () => {
			await session.start();
			trackedPids.push(session.driver?.pid ?? -1);
			const pong = await session.turn(PROMPT_PONG);
			const c: Check[] = [
				{ passed: pong.result.status === "SUCCESS", label: `turn SUCCESS (got ${pong.result.status})` },
				{ passed: /PONG/i.test(pong.result.response), label: "response contains PONG" },
				{ passed: session.asks.length === 0, label: `no permission asks (got ${session.asks.length})` },
			];
			pushFixture("simple", "simple", session.processes[0]);
			return { ok: c.every((x) => x.passed), detail: "one turn; PONG", checks: c };
		});
	});

	// 2: multi-turn - three turns in one process (the committed fixture's own shape).
	await runScenario("multi-turn", async () => {
		const session = new SmokeSession({
			name: "mt",
			cwd: scratch,
			agy: agyBin,
			model: MODEL,
			mode: "default",
			decide: async () => null, // no tool is expected; an ask is a drift signal
			log: bothLog,
			budget,
		});
		return withDispose(session, async () => {
			await session.start();
			trackedPids.push(session.driver?.pid ?? -1);
			const pong = await session.turn(PROMPT_PONG);
			await session.turn(PROMPT_REMEMBER_ZEBRA);
			const recall = await session.turn(PROMPT_RECALL_ZEBRA);
			const c: Check[] = [
				{ passed: pong.result.status === "SUCCESS", label: `first turn SUCCESS (got ${pong.result.status})` },
				{ passed: /PONG/i.test(pong.result.response), label: "first response contains PONG" },
				{
					passed: /ZEBRA/i.test(recall.result.response),
					label: `recall contains ZEBRA (got ${JSON.stringify(recall.result.response.slice(0, 80))})`,
				},
				{ passed: session.asks.length === 0, label: `no permission asks (got ${session.asks.length})` },
			];
			pushFixture("multi-turn", "multi-turn", session.processes[0]);
			return { ok: c.every((x) => x.passed), detail: "three turns in one process; PONG + ZEBRA recall", checks: c };
		});
	});

	// 3: tool allow - one ask, allow_once, the command ran.
	await runScenario("tool-allow", async () => {
		const session = new SmokeSession({
			name: "ta",
			cwd: scratch,
			agy: agyBin,
			model: MODEL,
			mode: "default",
			decide: async (ask) => (String(ask.rawInput.CommandLine ?? "").includes("smoke-tool-allow") ? "allow_once" : null),
			log: bothLog,
			budget,
		});
		return withDispose(session, async () => {
			await session.start();
			trackedPids.push(session.driver?.pid ?? -1);
			const r = await session.turn(PROMPT_TOOL_ALLOW);
			const fileExists = fs.existsSync(path.join(scratch, "smoke-tool-allow.txt"));
			const toolRan = session.toolSteps.some((t) => t.name === "run_command" && t.state === "DONE");
			const c: Check[] = [
				{ passed: r.result.status === "SUCCESS", label: `turn SUCCESS (got ${r.result.status})` },
				{
					passed: session.asks.length === 1 && expectAskFor(session, "smoke-tool-allow"),
					label: `one ask for the command (got ${session.asks.length})`,
				},
				{ passed: toolRan, label: "run_command step DONE" },
				// the 1.4.2 contract was "the file lands in the session cwd"; agy 1.5.5 runs tool
				// commands in its own project/sandbox directory (observed drift: the file is not
				// visible there at all), so the executable check is that the command ran and exited 0
				{
					passed: fileExists || toolRan,
					label: fileExists
						? "smoke-tool-allow.txt exists in the session cwd (the 1.4.2 layout)"
						: toolRan
							? "the command ran (agy 1.5.5: tool commands run in agy's own project dir; the file is not visible in the session cwd)"
							: "the command did not run (no file, no completed tool step)",
				},
			];
			pushFixture("tool-allow", "tool-allow", session.processes[0]);
			return { ok: c.every((x) => x.passed), detail: "allow_once let the command run", checks: c };
		});
	});

	// 4: tool deny - one ask, reject_once, the command did not run.
	await runScenario("tool-deny", async () => {
		const session = new SmokeSession({
			name: "td",
			cwd: scratch,
			agy: agyBin,
			model: MODEL,
			mode: "default",
			decide: async () => null, // reject everything
			log: bothLog,
			budget,
		});
		return withDispose(session, async () => {
			await session.start();
			trackedPids.push(session.driver?.pid ?? -1);
			const r = await session.turn(PROMPT_TOOL_DENY);
			const fileAbsent = !fs.existsSync(path.join(scratch, "smoke-tool-deny.txt"));
			const denied =
				/denied by agy-acp/i.test(r.result.response) ||
				session.toolSteps.some((t) => t.errorMessage !== undefined && /denied by agy-acp/i.test(t.errorMessage));
			const toolErrored = session.toolSteps.some((t) => t.name === "run_command" && t.state === "ERROR");
			const c: Check[] = [
				{ passed: r.result.status === "SUCCESS", label: `turn settled (agy reports ${r.result.status})` },
				{
					passed: session.asks.length === 1 && expectAskFor(session, "smoke-tool-deny"),
					label: `one ask for the command (got ${session.asks.length})`,
				},
				{ passed: denied, label: "the denial wording reached the model" },
				{ passed: toolErrored, label: "run_command step ERROR" },
				{ passed: fileAbsent, label: "smoke-tool-deny.txt absent" },
			];
			pushFixture("tool-deny", "tool-deny", session.processes[0]);
			return { ok: c.every((x) => x.passed), detail: "reject_once: the command never ran", checks: c };
		});
	});

	// 5: plan deny - the gate denies locally (no ask), the child runs with --mode plan.
	await runScenario("plan-deny", async () => {
		const session = new SmokeSession({
			name: "pd",
			cwd: scratch,
			agy: agyBin,
			model: MODEL,
			mode: "plan",
			decide: async () => null,
			log: bothLog,
			budget,
		});
		return withDispose(session, async () => {
			await session.start();
			trackedPids.push(session.driver?.pid ?? -1);
			const r = await session.turn(PROMPT_PLAN_DENY);
			const fileAbsent = !fs.existsSync(path.join(scratch, "smoke-plan-deny.txt"));
			const gateDeniedPlan = session.gateLogLines.some((l) => /denied by policy/i.test(l) && /plan mode is read-only/i.test(l));
			const planReason =
				gateDeniedPlan ||
				/plan mode is read-only/i.test(r.result.response) ||
				session.toolSteps.some((t) => t.errorMessage !== undefined && /denied by agy-acp/i.test(t.errorMessage));
			const stateChangingRan = session.toolSteps.some((t) => (t.name === "write_file" || t.name === "run_command") && t.state === "DONE");
			const c: Check[] = [
				// plan mode denies state-changing tools ("plan mode is read-only"); reads fall
				// through to the ask policy by design, so the contract is that nothing
				// state-changing runs - not that the turn is ask-free
				{ passed: !stateChangingRan, label: "no state-changing tool completed in plan mode" },
				{ passed: planReason, label: "the plan-mode denial is proven (the gate's policy log or the turn's text)" },
				{ passed: fileAbsent, label: "smoke-plan-deny.txt absent" },
			];
			pushFixture("plan-deny", "plan-deny", session.processes[0]);
			return { ok: c.every((x) => x.passed), detail: "plan mode blocked the state-changing tool", checks: c };
		});
	});

	// 6: allow-always - the first ask grants, the second identical command does not ask.
	await runScenario("allow-always", async () => {
		const session = new SmokeSession({
			name: "aa",
			cwd: scratch,
			agy: agyBin,
			model: MODEL,
			mode: "default",
			decide: async (ask) => (String(ask.rawInput.CommandLine ?? "").includes("SMOKE_ALLOW_ALWAYS") ? "allow_always" : null),
			log: bothLog,
			budget,
		});
		return withDispose(session, async () => {
			await session.start();
			trackedPids.push(session.driver?.pid ?? -1);
			const first = await session.turn(PROMPT_ALLOW_ALWAYS);
			const asksAfterFirst = session.asks.length;
			const second = await session.turn(PROMPT_ALLOW_ALWAYS);
			const secondAsked = session.asks.length > asksAfterFirst;
			const c: Check[] = [
				{ passed: asksAfterFirst === 1, label: `the first turn asked once (got ${asksAfterFirst})` },
				{ passed: !secondAsked, label: "the second identical command did not ask" },
				{ passed: first.result.status === "SUCCESS" && second.result.status === "SUCCESS", label: "both turns SUCCESS" },
				{
					passed:
						/SMOKE_ALLOW_ALWAYS/.test(second.result.response) ||
						session.toolSteps.some((t) => t.output !== undefined && /SMOKE_ALLOW_ALWAYS/.test(t.output)),
					label: "the second run's output is in the turn",
				},
			];
			pushFixture("allow-always", "allow-always", session.processes[0]);
			return { ok: c.every((x) => x.passed), detail: "allow_always held for the second identical call", checks: c };
		});
	});

	// 7: cancel sleep - the production cancel ladder, the tool command must die with the group.
	// Scope note: the post-run /proc scan only sees processes whose cwd is under the run's roots;
	// on agy 1.5.5 the tool command runs in agy's own project dir, outside the scan, so the
	// guarantee there is the ladder's process-group sweep (kill -SIGINT/-SIGTERM/-KILL), which
	// the "no leftover" check corroborates for the processes the scan can see.
	await runScenario("cancel-sleep", async () => {
		const session = new SmokeSession({
			name: "cs",
			cwd: scratch,
			agy: agyBin,
			model: MODEL,
			mode: "default",
			decide: async (ask) => (String(ask.rawInput.CommandLine ?? "").includes("sleep 30") ? "allow_once" : null),
			log: bothLog,
			budget,
		});
		return withDispose(session, async () => {
			await session.start();
			const driver = session.driver;
			if (driver === null) {
				throw new Error("no driver after start");
			}
			trackedPids.push(driver.pid ?? -1);
			// the turn is live by hand (it is settled by the cancel, not by a result): the budget and
			// the gate's "no turn in flight" check both need it
			budget.charge();
			session.turnCount += 1;
			session.currentTurn = new Promise<never>(() => {});
			driver.send(PROMPT_SLEEP);
			// wait for the tool to be ACTIVE (the ask was answered, the command is running)
			let toolActive = false;
			for (let i = 0; i < 120 && !driver.exited; i++) {
				if (session.toolSteps.some((t) => t.name === "run_command" && t.state === "ACTIVE")) {
					toolActive = true;
					break;
				}
				await sleep(1_000);
			}
			await session.cancel();
			// the cancel ladder sweeps the group on its own escalate window; give it the room and then
			// poll - the child may be gone while its tool command still has to die
			const leftover = await waitNoStrays([SLEEP_MARKER], scratch, 15_000);
			const c: Check[] = [
				{ passed: toolActive, label: "the sleep command was running (ACTIVE) before the cancel" },
				{ passed: driver.exited, label: "agy exited on the cancel ladder" },
				{ passed: leftover.length === 0, label: `no leftover sleep process (${leftover.join(", ") || "none"})` },
			];
			pushFixture("cancel-sleep", "cancel-sleep", driver);
			return { ok: c.every((x) => x.passed), detail: "cancel: the turn settled, the group is empty", checks: c };
		});
	});

	// 8: resume after restart - the child crashes between turns; the next prompt respawns with
	// --conversation and must come back with the same id.
	await runScenario("resume-after-restart", async () => {
		const session = new SmokeSession({
			name: "rr",
			cwd: scratch,
			agy: agyBin,
			model: MODEL,
			mode: "default",
			decide: async () => null,
			log: bothLog,
			budget,
		});
		return withDispose(session, async () => {
			await session.start();
			const first = session.driver;
			trackedPids.push(first?.pid ?? -1);
			await session.turn(PROMPT_REMEMBER_BANANA);
			session.killChild(); // the simulated crash
			await sleep(2_000); // let the exit settle
			let respawned: AgyResultEvent;
			try {
				respawned = await session.turn(PROMPT_RECALL_BANANA);
			} catch (err) {
				throw new Error(`the respawn turn failed: ${(err as Error).message}`);
			}
			const respawnedProcess = session.processes[session.processes.length - 1];
			const c: Check[] = [
				{
					passed: /BANANA/i.test(respawned.result.response),
					label: `the resumed conversation remembers BANANA (got ${JSON.stringify(respawned.result.response.slice(0, 80))})`,
				},
				{
					passed: session.processes.length >= 2,
					label: `a second process resumed the conversation (${session.processes.length} processes)`,
				},
				{
					passed: respawnedProcess?.argv.includes("--conversation") ?? false,
					label: "the respawn used --conversation",
				},
			];
			pushFixture("resume-after-restart", "resume-after-restart", respawnedProcess);
			return { ok: c.every((x) => x.passed), detail: "crashed child; the next prompt resumed the conversation", checks: c };
		});
	});

	// 9: bad model - agy refuses the launch (no init; the committed fixture's own error, recorded).
	await runScenario("bad-model", async () => {
		const session = new SmokeSession({
			name: "bm",
			cwd: scratch,
			agy: agyBin,
			model: BAD_MODEL_ID,
			mode: "default",
			decide: async () => null,
			log: bothLog,
			budget,
		});
		return withDispose(session, async () => {
			const { probeError, driver } = await badModelProbe(session);
			const badModelRefused = probeError !== null || (driver !== undefined && (badModelResultError(driver) || badModelDriverGone(driver)));
			const stderrSays = driver !== undefined && /invalid model selection|not recognized/i.test(driver.stderrTail);
			const noInit = driver === undefined || !driver.events.some((e) => e.event === "init");
			const c: Check[] = [
				{ passed: badModelRefused, label: `the launch failed (probe: ${probeError ?? "the child exited without init"})` },
				{ passed: noInit, label: "no init event" },
				{ passed: stderrSays, label: "stderr names the invalid model" },
			];
			pushFixture("bad-model", "bad-model", driver);
			return { ok: c.every((x) => x.passed), detail: "agy refused the unknown model before any turn", checks: c };
		});
	});

	// 10: client disconnect - the real server, a real JSON-RPC connection, the client's stdin
	// closed mid-turn: the server's exit path must dispose everything and exit 0.
	await runScenario("client-disconnect", async () => {
		const server = spawn(process.execPath, [MAIN_TS, "--model", MODEL], {
			cwd: REPO_DIR,
			env: {
				...process.env,
				AGY_ACP_LOG: path.join(privateTmp, "smoke-server.log"),
				// the server's session store must not write into the user's real state dir
				// (~/.local/state/agy-acp): the run's integrity check covers ~/.gemini, and a
				// stray record in the user's state is the mutation the run is supposed to avoid
				AGY_ACP_STATE_DIR: path.join(privateTmp, "state"),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		trackedPids.push(server.pid ?? -1);
		const updates: Record<string, unknown>[] = [];
		const client = new AcpClient({
			child: server,
			log: bothLog,
			onNotification: (_method, params) => {
				const p = params as Record<string, unknown>;
				if (typeof p.update === "object" && p.update !== null) {
					updates.push(p.update as Record<string, unknown>);
				}
			},
			onRequest: (method, _params) => {
				if (method !== "session/request_permission") {
					return Promise.resolve({});
				}
				bothLog("server: permission ask answered allow_once");
				return Promise.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
			},
		});
		try {
			await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 30_000);
			const newResult = (await client.request("session/new", { cwd: scratch }, 180_000)) as Record<string, unknown>;
			const sessionId = String(newResult.sessionId ?? "");
			budget.charge();
			const promptP = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: PROMPT_SLEEP }] }, TURN_DEADLINE_MS);
			promptP.catch(() => undefined); // settled by the shutdown; the exit code is the verdict
			// wait until the tool is running (the ask answered, the command started)
			let toolRunning = false;
			for (let i = 0; i < 120; i++) {
				if (updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "in_progress")) {
					toolRunning = true;
					break;
				}
				if (server.exitCode !== null || server.signalCode !== null) break;
				await sleep(1_000);
			}
			client.closeInput(); // the client hangs up mid-turn
			const exit = await client.waitExit(SERVER_EXIT_TIMEOUT_MS);
			// the server's teardown ladder (SIGINT, escalate, group sweep) has its own window; poll
			// through it before the orphan verdict
			const orphans = await waitNoStrays([SLEEP_MARKER], scratch, 15_000);
			const c: Check[] = [
				{ passed: sessionId !== "", label: `session/new produced a session (${sessionId.slice(0, 8)}…)` },
				{ passed: toolRunning, label: "the sleep tool was running when the client disconnected" },
				{ passed: exit.code === 0, label: `the server exited 0 on the hang-up (got ${exit.code ?? exit.signal})` },
				{ passed: orphans.length === 0, label: `no orphaned processes (${orphans.join(", ") || "none"})` },
			];
			return { ok: c.every((x) => x.passed), detail: "hang-up mid-turn: clean exit, no orphans", checks: c };
		} finally {
			// a scenario failure must not leave the server running: the hang-up is the clean path
			if (server.exitCode === null && server.signalCode === null) {
				client.closeInput();
				await client.waitExit(SERVER_EXIT_TIMEOUT_MS);
			}
		}
	});

	// ---------------------------------------------------------------- post-run checks

	await sleep(2_000); // a settle window: a process that is going to be left will be left now
	const alive = trackedPids.filter((p) => p > 0 && pidAlive(p));
	const strays = await waitNoStrays([SLEEP_MARKER], scratch, 10_000);
	const configAfter = configChecksums();
	const configChanges = diffChecksums(configBefore, configAfter);
	const budgetOk = budget.used <= TURNS_MAX;

	say(`\n[post-run checks]`);
	say(`  processes left: ${alive.length === 0 ? "none" : `pids ${alive.join(", ")}`}`);
	say(`  stray tool processes: ${strays.length === 0 ? "none" : strays.join("; ")}`);
	say(`  user config: ${configChanges.length === 0 ? "unchanged" : configChanges.join("; ")}`);
	say(`  model turns spent: ${budget.used} / ${TURNS_MAX}`);

	const postChecks: Check[] = [
		{ passed: alive.length === 0, label: `no processes left (${alive.length})` },
		{ passed: strays.length === 0, label: `no stray tool processes (${strays.length})` },
		{ passed: configChanges.length === 0, label: "user configuration unchanged" },
		{ passed: budgetOk, label: `turn budget held (${budget.used}/${TURNS_MAX})` },
	];

	const allOk = scenarios.every((s) => s.ok) && postChecks.every((p) => p.passed);

	// ---------------------------------------------------------------- fixtures, inventory, report

	const date = new Date().toISOString().slice(0, 10);
	const reportDir = allocateReportDir(date);
	fs.mkdirSync(path.join(reportDir, "fixtures"), { recursive: true });

	for (const f of recordedFixtures) {
		const meta = buildMeta(f.driver, `smoke-${date}-${f.fixtureName}`, versionStatus.version, privateTmp, scratch, home);
		writeFixtureFile(path.join(reportDir, "fixtures"), f.fixtureName, f.driver, meta, privateTmp, scratch, home);
	}
	const hookPayloads = readHookPayloads(recorder, privateTmp, scratch, home);
	fs.writeFileSync(
		path.join(reportDir, "fixtures", "hook-payloads.jsonl"),
		hookPayloads.join("\n") + (hookPayloads.length > 0 ? "\n" : ""),
	);

	const allEvents: AgyEvent[] = [];
	for (const f of recordedFixtures) {
		allEvents.push(...f.driver.events);
	}
	const liveInventory = computeLiveInventory(allEvents);
	const committedInventory = readInventoryFile();
	const inventoryDiff = diffInventory(committedInventory, liveInventory);
	fs.writeFileSync(path.join(reportDir, "field-inventory.live.json"), `${JSON.stringify(liveInventory, null, "    ")}\n`);
	fs.writeFileSync(path.join(reportDir, "field-inventory.diff.json"), `${JSON.stringify(inventoryDiff, null, "    ")}\n`);

	let recordResult: { diff: InventoryDiff; written: string[] } | { refused: true } | null = null;
	recordResult = runRecordStep(record, allOk, recordedFixtures, versionStatus.version, privateTmp, scratch, home);

	writeReport({
		reportDir,
		version: versionStatus.version,
		versionWarning: versionStatus.warning,
		scenarios,
		postChecks,
		budget,
		startedAt,
		inventoryDiff,
		recordResult,
		hookPayloadCount: hookPayloads.length,
	});

	// cleanup of the run's own roots (the fixtures and the report are already written); the
	// fatal handler removes them again if any throw landed before this point (see tempRoots)
	await fs.promises.rm(privateTmp, { recursive: true, force: true });
	await fs.promises.rm(scratch, { recursive: true, force: true });

	say(`\n${allOk ? "PASS" : "FAIL"} - report: ${path.relative(process.cwd(), reportDir)}`);
	return allOk ? 0 : 1;
}

// ---------------------------------------------------------------- the report

interface ReportData {
	reportDir: string;
	version: string;
	versionWarning: string | null;
	scenarios: ScenarioResult[];
	postChecks: Check[];
	budget: TurnBudget;
	startedAt: number;
	inventoryDiff: InventoryDiff;
	recordResult: { diff: InventoryDiff; written: string[] } | { refused: true } | null;
	hookPayloadCount: number;
}

function writeReport(data: ReportData): void {
	const lines: string[] = [];
	lines.push(`# agy-acp live smoke report`);
	lines.push("");
	lines.push(`- date: ${new Date(data.startedAt).toISOString()}`);
	lines.push(`- agy: ${data.version} (tested: ${TESTED_AGY_VERSIONS.join(", ")})`);
	if (data.versionWarning) {
		lines.push(`- version warning: ${data.versionWarning}`);
	}
	lines.push(`- model: ${MODEL}`);
	lines.push(`- model turns: ${data.budget.used} / ${TURNS_MAX}`);
	lines.push(`- duration: ${((Date.now() - data.startedAt) / 1000).toFixed(1)} s`);
	lines.push("");
	lines.push(`## Scenarios`);
	lines.push("");
	for (const s of data.scenarios) {
		lines.push(`- ${s.ok ? "**pass**" : "**FAIL**"} ${s.name} (${s.durationMs} ms, ${s.turns} turns): ${s.detail}`);
		lines.push(`  - ${s.checks}`);
	}
	lines.push("");
	lines.push(`## Post-run checks`);
	lines.push("");
	for (const c of data.postChecks) {
		lines.push(`- ${c.passed ? "ok" : "**FAIL**"}: ${c.label}`);
	}
	lines.push("");
	lines.push(`## Field inventory diff (live vs committed)`);
	lines.push("");
	lines.push(`- added: ${Object.values(data.inventoryDiff.added).flat().length}`);
	lines.push(`- removed: ${Object.values(data.inventoryDiff.removed).flat().length}`);
	lines.push(`- type changes: ${data.inventoryDiff.typeChanges.length}`);
	lines.push(`- literals added: ${data.inventoryDiff.literalAdded.length}`);
	lines.push(`- literals removed: ${data.inventoryDiff.literalRemoved.length}`);
	if (Object.keys(data.inventoryDiff.added).length > 0) {
		lines.push(
			`- added paths: ${Object.entries(data.inventoryDiff.added)
				.map(([e, ps]) => `${e}: ${ps.join(", ")}`)
				.join("; ")}`,
		);
	}
	if (Object.keys(data.inventoryDiff.removed).length > 0) {
		lines.push(
			`- removed paths: ${Object.entries(data.inventoryDiff.removed)
				.map(([e, ps]) => `${e}: ${ps.join(", ")}`)
				.join("; ")}`,
		);
	}
	for (const t of data.inventoryDiff.typeChanges) {
		lines.push(`- type change: ${t.event}.${t.path} ${t.committed.join("|")} -> ${t.live.join("|")}`);
	}
	for (const t of data.inventoryDiff.literalAdded.slice(0, 40)) {
		lines.push(`- literal added: ${t.event}.${t.path}: "${t.value}"`);
	}
	if (data.recordResult !== null && data.recordResult !== undefined) {
		lines.push("");
		lines.push(`## --record`);
		lines.push("");
		if ("refused" in data.recordResult) {
			lines.push("- REFUSED: the run failed, so the committed fixtures keep the last green run");
		} else {
			lines.push(`- written: ${data.recordResult.written.join(", ") || "(nothing mapped)"}`);
			lines.push(
				`- recomputed inventory vs previous: added ${Object.values(data.recordResult.diff.added).flat().length}, removed ${Object.values(data.recordResult.diff.removed).flat().length}`,
			);
		}
	}
	lines.push("");
	lines.push(`## Artifacts`);
	lines.push("");
	lines.push(`- fixtures/ (the run's raw stdout lines + meta, normalised to <SPIKE>/<HOME>, the committed fixtures' placeholders)`);
	lines.push(`- fixtures/hook-payloads.jsonl (${data.hookPayloadCount} hook stdin payloads)`);
	lines.push(`- field-inventory.live.json, field-inventory.diff.json`);
	fs.writeFileSync(path.join(data.reportDir, "report.md"), `${lines.join("\n")}\n`);

	const machine = {
		date: new Date(data.startedAt).toISOString(),
		agyVersion: data.version,
		testedVersions: TESTED_AGY_VERSIONS,
		versionWarning: data.versionWarning,
		model: MODEL,
		turnsSpent: data.budget.used,
		turnsMax: TURNS_MAX,
		durationMs: Date.now() - data.startedAt,
		scenarios: data.scenarios.map((s) => ({
			name: s.name,
			ok: s.ok,
			detail: s.detail,
			turns: s.turns,
			durationMs: s.durationMs,
			checks: s.checks,
		})),
		postRun: data.postChecks.map((c) => ({ ok: c.passed, label: c.label })),
		inventoryDiff: data.inventoryDiff,
		record: data.recordResult,
		hookPayloadCount: data.hookPayloadCount,
	};
	fs.writeFileSync(path.join(data.reportDir, "smoke-report.json"), `${JSON.stringify(machine, null, "    ")}\n`);
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err: Error) => {
		say(`fatal: ${err.stack ?? err.message}`);
		for (const r of tempRoots) {
			try {
				fs.rmSync(r, { recursive: true, force: true });
			} catch {
				// best effort; the fatal line above is what matters
			}
		}
		process.exitCode = 1;
	});
