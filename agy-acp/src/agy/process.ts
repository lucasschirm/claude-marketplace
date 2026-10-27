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

/** One `agy` child in its own process group: emits "event" per decoded line, and "exit"
 * (AgyExitInfo) exactly once - after stdio is drained, also on a spawn failure. */
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
	private stderrDecoder = new TextDecoder();
	private conversationIdValue: string | null = null;
	private exitedFlag = false;
	private exitInfoValue: AgyExitInfo | null = null;
	private spawnErrorValue: Error | null = null;
	private pendingProbe: { resolve: (id: string) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | null = null;
	private probePromise: Promise<string> | null = null;
	private disposePromise: Promise<AgyExitInfo> | null = null;

	constructor(options: AgyProcessOptions) {
		super();
		const userLog = options.log ?? (() => {});
		// A logger that throws must not take the driver down (jsonrpc.ts wraps the same callback).
		this.log = (line: string) => {
			try {
				userLog(line);
			} catch {
				// the logger's own failure is not the driver's to surface
			}
		};
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
			// ENOENT reports through "close" with code null - one terminal event either way.
			env: options.env ?? process.env,
		});
		this.decoder = new FrameDecoder(
			options.maxLineBytes ?? DEFAULT_MAX_FRAME_BYTES,
			(line) => this.handleLine(line),
			(reason) => this.log(`undecodable stdout frame: ${reason}`),
			(bytes) => {
				// A stalled stream would hang the turn forever - kill the child (jsonrpc.ts treats the same condition as fatal).
				this.log(`stdout line exceeds ${bytes} bytes - killing the child`);
				this.signalGroup("SIGKILL");
			},
		);
		const { stdout, stderr, stdin } = this.child;
		if (!stdout || !stderr || !stdin) throw new Error("agy's stdio is not piped - cannot drive it");
		stdout.on("data", (d: Buffer) => this.decoder.push(d));
		stderr.on("data", (d: Buffer) => this.appendStderr(this.stderrDecoder.decode(d, { stream: true })));
		for (const stream of [stdout, stderr, stdin]) {
			stream.on("error", (err: Error) => this.log(`stdio error: ${err.message}`));
		}
		this.child.on("error", (err: Error) => this.onSpawnError(err));
		// "close" (not "exit"): stdio is drained before the terminal state.
		this.child.on("close", (code, signal) => this.onExit(code, signal));
	}

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
	/** One user turn, using the string content shape the recorded successful inputs prove. */
	send(text: string): void {
		this.sendRaw(JSON.stringify({ event: "user", message: { content: text } }));
	}

	/** One raw line to agy's stdin; nothing is validated (tests exercise the fatal path this way). */
	sendRaw(line: string): void {
		if (this.exitedFlag) throw new Error("agy has exited; its stdin is closed");
		const stdin = this.child.stdin;
		if (!stdin) throw new Error("agy's stdin is not a pipe");
		if (!stdin.write(`${line}\n`)) this.log("stdin backpressure - continuing (stream lines are small)");
	}

	/** Resolves with the init conversation_id via a probe event agy ignores; a timeout carries
	 * the stderr tail and allows a retry. */
	probe(timeoutMs?: number): Promise<string> {
		if (this.conversationIdValue !== null) return Promise.resolve(this.conversationIdValue);
		if (this.exitedFlag) return Promise.reject(new Error(`agy has exited (code=${this.exitInfoValue?.code ?? "unknown"}); cannot probe`));
		if (this.probePromise) return this.probePromise;
		this.sendRaw(`{"event":"${AGY_PROBE_EVENT}"}`);
		const ms = timeoutMs ?? this.probeTimeoutMs;
		const promise = new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pendingProbe?.timer === timer) this.pendingProbe = this.probePromise = null; // a timeout allows a retry
				reject(new Error(`agy did not send init within ${ms} ms; stderr tail: ${this.stderrTail}`));
			}, ms);
			timer.unref();
			this.pendingProbe = { resolve, reject, timer };
		});
		this.probePromise = promise;
		return promise;
	}

	interrupt(): void {
		const pid = this.child.pid;
		if (pid !== undefined)
			try {
				process.kill(pid, "SIGINT");
			} catch (err) {
				// ESRCH: already gone - nothing to cancel.
				this.log(`interrupt failed: ${(err as Error).message}`);
			}
	}

	/** Shuts the child down: close stdin, graceMs, SIGTERM, termMs, SIGKILL. Idempotent. */
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
			const stdin = this.child.stdin;
			if (stdin && !stdin.destroyed)
				try {
					stdin.end();
				} catch (err) {
					// A broken pipe at shutdown is not an error - the child is going away.
					this.log(`closing stdin failed: ${(err as Error).message}`);
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
		return this.disposePromise;
	}

	private signalGroup(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (pid !== undefined)
			try {
				process.kill(-pid, signal);
			} catch (err) {
				// ESRCH: the group is already gone.
				this.log(`signalling process group ${-pid} failed: ${(err as Error).message}`);
			}
	}

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
		this.appendStderr(this.stderrDecoder.decode()); // flush any trailing partial sequence
		this.exitInfoValue = { code, signal, stderrTail: this.stderrTail };
		const detail = `agy exited before init (code=${code ?? "none"} signal=${signal ?? "none"}); stderr: ${this.stderrTail.slice(0, 400)}`;
		this.rejectPendingProbe(detail);
		this.log(`agy exited code=${code} signal=${signal ?? "none"}`);
		this.emit("exit", this.exitInfoValue);
	}

	private rejectPendingProbe(message: string): void {
		const pending = this.pendingProbe;
		if (!pending) return;
		this.pendingProbe = null;
		clearTimeout(pending.timer);
		pending.reject(new Error(message));
	}

	private onSpawnError(err: Error): void {
		// A spawn failure (ENOENT, EACCES) carries no exit code - one terminal event either way.
		this.spawnErrorValue = err;
		this.log(`spawn error: ${err.message}`);
		if (!this.exitedFlag) {
			this.exitedFlag = true;
			this.exitInfoValue = { code: null, signal: null, stderrTail: err.message };
			this.emit("exit", this.exitInfoValue);
		}
		this.rejectPendingProbe(`agy failed to start: ${err.message}`);
	}

	private appendStderr(chunk: string): void {
		this.stderrBuf += chunk;
		// The budget is in bytes; trim one whole code point at a time so a multi-byte character
		// (including astral, two UTF-16 units) never straddles the cut.
		while (Buffer.byteLength(this.stderrBuf, "utf8") > this.stderrLimit && this.stderrBuf.length > 0) {
			const cp = this.stderrBuf.codePointAt(0) ?? 0;
			this.stderrBuf = this.stderrBuf.slice(cp > 0xffff ? 2 : 1);
		}
	}

	private handleLine(line: string): void {
		const parsed = parseAgyLine(line);
		if (parsed.kind === "unknown") {
			this.log(`ignoring unknown agy event ${parsed.event === "" ? "(unparseable line)" : parsed.event}`);
			return;
		}
		const event = parsed.event;
		if (event.event === "init") {
			const pending = this.pendingProbe;
			if (event.conversation_id !== "") {
				this.conversationIdValue = event.conversation_id;
				if (pending) {
					this.pendingProbe = null;
					clearTimeout(pending.timer);
					pending.resolve(event.conversation_id);
				}
			} else if (pending) {
				// A drifted init without a usable id fails the probe instead of resolving with "".
				this.rejectPendingProbe("init carried no conversation_id");
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
