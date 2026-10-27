// Driver for one headless `agy` process: probe, send, interrupt, dispose (see the
// "The agy process driver" section of the README for the process model the spike established).

import { EventEmitter } from "node:events";
import { spawnProcessGroup } from "../lib/child-process.ts";
import { DEFAULT_MAX_FRAME_BYTES, FrameDecoder } from "../framing.ts";
import { AGY_PROBE_EVENT, agyArgs } from "./args.ts";
import type { AgyProcessOptions } from "./args.ts";
import type { AgyExitInfo, AgyResultEventDelta } from "./events.ts";
import { initialStateOf, type AgyCumulative, cumulativeOf, parseAgyLine, resultDeltas } from "./contract.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const DEFAULT_STDERR_BYTES = 64 * 1024;
const DEFAULT_GRACE_MS = 3_000;
const DEFAULT_TERM_MS = 1_000;

/**
 * One `agy` child. Emits:
 *   - "event" (AgyDriverEvent) for every decoded init / step_update / result line;
 *   - "exit" (AgyExitInfo) exactly once, also on a spawn failure.
 *
 * The child runs in its own process group; nothing outlives `dispose()` (or, on a crash of
 * agy-acp itself, the group dies with the session - that cleanup is the server's job).
 */
export class AgyProcess extends EventEmitter {
	private readonly child: ReturnType<typeof spawnProcessGroup>;
	private readonly log: (line: string) => void;
	private readonly decoder: FrameDecoder;
	private readonly probeTimeoutMs: number;
	private readonly stderrLimit: number;
	private readonly graceMs: number;
	private readonly termMs: number;
	private cumulativeState: AgyCumulative;
	private stderrBuf = "";
	private conversationIdValue: string | null = null;
	private exitedFlag = false;
	private exitInfoValue: AgyExitInfo | null = null;
	private spawnErrorValue: Error | null = null;
	private pendingProbe: { resolve: (id: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;
	private disposePromise: Promise<AgyExitInfo> | null = null;

	constructor(options: AgyProcessOptions) {
		super();
		this.log = options.log ?? (() => {});
		this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
		this.stderrLimit = options.stderrBytes ?? DEFAULT_STDERR_BYTES;
		this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
		this.termMs = options.termMs ?? DEFAULT_TERM_MS;
		this.cumulativeState = initialStateOf(options.previous);
		const argv = [...(options.argvPrefix ?? [options.command ?? "agy"]), ...agyArgs(options)];
		this.child = spawnProcessGroup({
			command: argv[0],
			args: argv.slice(1),
			cwd: options.cwd,
			// A child that cannot start (ENOENT) reports through "exit" with code null - one terminal event either way.
			env: options.env ?? process.env,
		});
		this.decoder = new FrameDecoder(
			options.maxLineBytes ?? DEFAULT_MAX_FRAME_BYTES,
			(line) => this.handleLine(line),
			(reason) => this.log(`undecodable stdout frame: ${reason}`),
			(bytes) => this.log(`stdout line exceeds ${bytes} bytes - stopping the stream`),
		);
		const stdout = this.child.stdout;
		const stderr = this.child.stderr;
		const stdin = this.child.stdin;
		if (!stdout || !stderr || !stdin) throw new Error("agy's stdio is not piped - cannot drive it");
		stdout.on("data", (d: Buffer) => this.decoder.push(d));
		stderr.on("data", (d: Buffer) => this.appendStderr(d.toString("utf8")));
		for (const stream of [stdout, stderr, stdin]) {
			stream.on("error", (err: Error) => this.log(`stdio error: ${err.message}`));
		}
		this.child.on("error", (err: Error) => this.onSpawnError(err));
		this.child.on("exit", (code, signal) => this.onExit(code, signal));
	}

	// ------------------------------------------------------------------ reads

	get pid(): number | undefined {
		return this.child.pid;
	}

	/** The id from `init`, once it has arrived. */
	get conversationId(): string | null {
		return this.conversationIdValue;
	}

	/** The cumulative counters as this process last reported them. */
	get cumulative(): AgyCumulative {
		return this.cumulativeState;
	}

	get stderrTail(): string {
		return this.stderrBuf;
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

	/** One user turn, using the content shape the fixtures prove. */
	send(text: string): void {
		this.sendRaw(JSON.stringify({ event: "user", message: { content: [{ type: "text", text }] } }));
	}

	/** One raw line to agy's stdin; nothing is validated (tests exercise the fatal path this way). */
	sendRaw(line: string): void {
		if (this.exitedFlag) throw new Error("agy has exited; its stdin is closed");
		const stdin = this.child.stdin;
		if (!stdin) throw new Error("agy's stdin is not a pipe");
		if (!stdin.write(`${line}\n`)) this.log("stdin backpressure - continuing (stream lines are small)");
	}

	// ------------------------------------------------------------------ lifecycle

	/**
	 * Sends the probe event and resolves with the `conversation_id` from `init`. Fails with a
	 * timeout that carries the stderr tail when `init` does not arrive (spike: a bad model id
	 * yields no `init` at all).
	 */
	probe(timeoutMs?: number): Promise<string> {
		if (this.conversationIdValue !== null) return Promise.resolve(this.conversationIdValue);
		if (this.exitedFlag) return Promise.reject(new Error(`agy has exited (code=${this.exitInfoValue?.code ?? "unknown"}); cannot probe`));
		const ms = timeoutMs ?? this.probeTimeoutMs;
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pendingProbe?.timer === timer) this.pendingProbe = null;
				reject(new Error(`agy did not send init within ${ms} ms; stderr tail: ${this.stderrTail}`));
			}, ms);
			timer.unref();
			this.pendingProbe = { resolve, reject, timer };
			this.sendRaw(`{"event":"${AGY_PROBE_EVENT}"}`);
		});
	}

	/** Cancels the running turn; agy answers `result{error:"interrupted"}` and exits 1. */
	interrupt(): void {
		const pid = this.child.pid;
		if (pid === undefined) return;
		try {
			process.kill(pid, "SIGINT");
		} catch (err) {
			// ESRCH: already gone - nothing to cancel.
			this.log(`interrupt failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Shuts the child down and waits until the process group is gone: close stdin, give a calm
	 * exit `graceMs`, then SIGTERM the group, wait `termMs`, then SIGKILL it. Idempotent.
	 */
	dispose(): Promise<AgyExitInfo> {
		if (this.disposePromise) return this.disposePromise;
		this.disposePromise = new Promise<AgyExitInfo>((resolve) => {
			const finish = () => resolve(this.exitInfoValue ?? { code: null, signal: null, stderrTail: this.stderrTail });
			const afterKill = () => this.waitThen(1000, finish, finish);
			const afterTerm = () =>
				this.waitThen(
					this.termMs,
					() => {
						this.signalGroup("SIGKILL");
						afterKill();
					},
					finish,
				);
			this.closeStdin();
			this.waitThen(
				this.graceMs,
				() => {
					this.signalGroup("SIGTERM");
					afterTerm();
				},
				finish,
			);
		});
		return this.disposePromise;
	}

	private closeStdin(): void {
		const stdin = this.child.stdin;
		if (!stdin || stdin.destroyed) return;
		try {
			stdin.end();
		} catch (err) {
			// A broken pipe at shutdown is not an error - the child is going away.
			this.log(`closing stdin failed: ${(err as Error).message}`);
		}
	}

	private signalGroup(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (pid === undefined) return;
		try {
			process.kill(-pid, signal);
		} catch (err) {
			// ESRCH: the group is already gone.
			this.log(`signalling process group ${-pid} failed: ${(err as Error).message}`);
		}
	}

	/** Runs `onTimeout` after `ms` if the child is still alive, else `onExit` immediately. */
	private waitThen(ms: number, onTimeout: () => void, onExit: () => void): void {
		if (this.exitedFlag) {
			setImmediate(onExit);
			return;
		}
		let done = false;
		const onExitEvent = () => settle(onExit);
		this.once("exit", onExitEvent);
		const timer = setTimeout(() => settle(onTimeout), ms);
		timer.unref();
		const settle = (fn: () => void) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			this.off("exit", onExitEvent);
			fn();
		};
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exitedFlag) return;
		this.exitedFlag = true;
		this.exitInfoValue = { code, signal, stderrTail: this.stderrTail };
		const pending = this.pendingProbe;
		if (pending) {
			this.pendingProbe = null;
			clearTimeout(pending.timer);
			pending.reject(
				new Error(`agy exited before init (code=${code ?? "none"} signal=${signal ?? "none"}); stderr: ${this.stderrTail.slice(0, 400)}`),
			);
		}
		this.log(`agy exited code=${code} signal=${signal ?? "none"}`);
		this.emit("exit", this.exitInfoValue);
	}

	private onSpawnError(err: Error): void {
		// A spawn failure (ENOENT, EACCES) never fires "exit" - surface it through the same terminal channel.
		this.spawnErrorValue = err;
		this.log(`spawn error: ${err.message}`);
		if (!this.exitedFlag) {
			this.exitedFlag = true;
			this.exitInfoValue = { code: null, signal: null, stderrTail: err.message };
			this.emit("exit", this.exitInfoValue);
		}
	}

	private appendStderr(chunk: string): void {
		this.stderrBuf += chunk;
		if (this.stderrBuf.length > this.stderrLimit) this.stderrBuf = this.stderrBuf.slice(-this.stderrLimit);
	}

	private handleLine(line: string): void {
		const parsed = parseAgyLine(line);
		if (parsed.kind === "unknown") {
			this.log(`ignoring unknown agy event ${JSON.stringify(parsed.event) || "(unparseable line)"}`);
			return;
		}
		const event = parsed.event;
		if (event.event === "init") {
			this.conversationIdValue = event.conversation_id;
			const pending = this.pendingProbe;
			if (pending) {
				this.pendingProbe = null;
				clearTimeout(pending.timer);
				pending.resolve(event.conversation_id);
			}
			this.emit("event", event);
			return;
		}
		if (event.event === "step_update") {
			this.emit("event", event);
			return;
		}
		// result: cumulative counters become per-turn deltas; the raw state is kept for a resume.
		const cumulative = cumulativeOf(event.result);
		const delta = resultDeltas(event.result, this.cumulativeState);
		this.cumulativeState = cumulative;
		this.emit("event", {
			event: "result",
			result: {
				...event.result,
				usage: delta.usage,
				num_turns: delta.num_turns,
				duration_seconds: delta.duration_seconds,
				cumulative,
			},
		} satisfies AgyResultEventDelta);
	}
}
