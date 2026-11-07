// The ACP child process: spawn it however a driver says, correlate JSON-RPC requests with their
// responses, and stream every line to the session's event log.
//
// This file used to be `lib/acp-client.ts` and to know that the agent was Devin: the binary, the
// `--model` flag, the `DEVIN_MODEL` environment variable, the string "devin acp" in three error
// messages and the `pi-devin-delegate` client name. All five are now fields of the `LaunchPlan` a
// driver hands in, which is the only change. What did *not* change is the part that matters:
//
// ACP is bidirectional. An agent sends requests *to* the client (`session/request_permission` in any
// mode but bypass) and blocks its turn until they are answered, so every incoming request is
// answered: by the handler set with setOnRequest, or with a method-not-found error. Leaving one
// unanswered froze every delegated session at its first permission prompt (2026-10-22).
//
// `session/prompt` is answered when the whole agent turn ends — minutes to hours — so it is sent with
// `timeoutMs = 0` and never with a wall-clock deadline (see docs/devin-delegate-reliability-plan.md).

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { LaunchPlan } from "./types.ts";

/** JSON-RPC ids: ours are numbers, an agent's own requests typically use string UUIDs. */
export type AcpId = number | string;

/** A request the agent sent to us. */
/*
 * How long after `exit` to wait for the stdio pipes before reporting the exit anyway.
 *
 * A grandchild that inherited the pipes can hold `close` open indefinitely; the session must still
 * settle. Two seconds is longer than any real flush and short enough that a wedged child is reported
 * before a human notices.
 */
const EXIT_GRACE_MS = 2_000;

export interface AcpIncomingRequest {
	id: AcpId;
	method: string;
	params?: unknown;
}

interface AcpMessage {
	jsonrpc: "2.0";
	id?: AcpId;
	method?: string;
	params?: any;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

export class DelegateTransport {
	private child: ChildProcess | null = null;
	private nextRpcId = 1;
	private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout | null }>();
	private logStream: fs.WriteStream | null = null;
	private rl: readline.Interface | null = null;
	private onUpdateCallback?: (update: any) => void;
	private onExitCallback?: (code: number | null, signal: string | null) => void;
	private onRequestCallback?: (req: AcpIncomingRequest) => boolean;
	private isDisposed = false;
	/** True once the child's stdio closed — after the last line it wrote was read. */
	private streamsClosed = false;
	private exitInfo: { code: number | null; signal: string | null } | null = null;

	private cwd: string;
	private plan: LaunchPlan;

	constructor(cwd: string, plan: LaunchPlan) {
		this.cwd = cwd;
		this.plan = plan;
	}

	/** The agent's answer to `initialize`, kept so a driver can read what it negotiated. */
	agentInfo: Record<string, unknown> = {};

	setLogFilePath(logFilePath: string): void {
		if (this.logStream) {
			this.logStream.end();
		}
		fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
		this.logStream = fs.createWriteStream(logFilePath, { flags: "a" });
	}

	async start(): Promise<Record<string, unknown>> {
		const isPosix = process.platform !== "win32";
		this.child = spawn(this.plan.command, this.plan.args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: isPosix,
			// The plan wins over an inherited value of the same key: see the note on LaunchPlan.env.
			env: { ...process.env, ...this.plan.env },
		});

		this.child.on("error", (err) => {
			this.logEvent("error", { message: err.message });
			for (const req of this.pendingRequests.values()) {
				if (req.timer) {
					clearTimeout(req.timer);
				}
				req.reject(err);
			}
			this.pendingRequests.clear();
			if (!this.isDisposed && this.onExitCallback) {
				this.onExitCallback(1, null);
			}
		});

		// Swallow async stream errors on stdin (EPIPE when writing to a dying process);
		// an unhandled 'error' event would crash the host pi process.
		if (this.child.stdin) {
			this.child.stdin.on("error", () => {});
		}

		// stdio is piped at spawn, so stdout is there; a `!` would turn a spawn that did not pipe into a
		// TypeError raised inside readline, rather than a failure start() can report to its caller.
		if (!this.child.stdout) {
			throw new Error(`${this.plan.label} has no stdout - its protocol stream cannot be read`);
		}
		this.rl = readline.createInterface({
			input: this.child.stdout,
			crlfDelay: Infinity,
		});

		this.rl.on("line", (line) => {
			if (!line.trim()) {
				return;
			}
			this.logEvent("stdout", line);
			try {
				const msg = JSON.parse(line) as AcpMessage;
				this.handleMessage(msg);
			} catch {
				// Non-json output
			}
		});

		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.logEvent("stderr", chunk.toString());
		});

		// The exit report, once, and only after stdout has been drained.
		//
		// `exit` says the process is gone; it does not say the lines it wrote have been read. An agent that
		// answers the prompt and exits immediately — the normal shape of a one-turn ACP run — used to have
		// its final frames arrive after the session was already settled as interrupted, because the exit
		// callback fired on `exit` and the readline queue still held them. `close` fires when the pipes are
		// closed, which is after the last line. The timer is the liveness guarantee: a grandchild that
		// inherited the stdout pipe can keep `close` from ever arriving, and a session that never settles is
		// worse than one that settles from a line or two late.
		let delivered = false;
		const deliver = (code: number | null, signal: string | null): void => {
			if (delivered || this.isDisposed) {
				return;
			}
			delivered = true;
			this.onExitCallback?.(code, signal);
		};
		this.child.on("exit", (code, signal) => {
			for (const req of this.pendingRequests.values()) {
				if (req.timer) {
					clearTimeout(req.timer);
				}
				req.reject(new Error(`${this.plan.label} exited with code ${code}`));
			}
			this.pendingRequests.clear();
			if (this.streamsClosed) {
				deliver(code, signal);
			} else {
				this.exitInfo = { code, signal };
				const grace = setTimeout(() => deliver(code, signal), EXIT_GRACE_MS);
				grace.unref?.();
			}
		});
		this.child.on("close", (code, signal) => {
			this.streamsClosed = true;
			const info = this.exitInfo ?? { code, signal };
			deliver(info.code, info.signal);
		});

		// Handshake: initialize. The result used to be discarded; it is kept (and returned) because the
		// capabilities an agent advertises here are the only honest answer to "can this agent resume?".
		const init = await this.request("initialize", {
			clientInfo: this.plan.clientInfo,
			protocolVersion: this.plan.protocolVersion ?? 1,
			...(this.plan.clientCapabilities ? { clientCapabilities: this.plan.clientCapabilities } : {}),
		});
		this.agentInfo = init && typeof init === "object" ? (init as Record<string, unknown>) : {};
		return this.agentInfo;
	}

	setOnUpdate(cb: (update: any) => void): void {
		this.onUpdateCallback = cb;
	}

	setOnExit(cb: (code: number | null, signal: string | null) => void): void {
		this.onExitCallback = cb;
	}

	/** `cb` returns true when it takes the request (and later calls respond); false gets method-not-found. */
	setOnRequest(cb: (req: AcpIncomingRequest) => boolean): void {
		this.onRequestCallback = cb;
	}

	/** Answer a request the agent sent (see setOnRequest). */
	respond(id: AcpId, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	respondError(id: AcpId, code: number, message: string): void {
		this.write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	private write(msg: AcpMessage): void {
		const stdin = this.child?.stdin;
		if (!stdin || this.child?.killed || this.isDisposed) {
			return;
		}
		try {
			stdin.write(`${JSON.stringify(msg)}\n`);
		} catch {
			// A dying process: the exit handler settles the session.
		}
	}

	request(method: string, params: any, timeoutMs = 60000): Promise<any> {
		return new Promise((resolve, reject) => {
			// A disposed transport fails fast. `dispose()` kills the group with `process.kill`, which does
			// not set `child.killed`, so without this a caller kept its 60s timer and then got a timeout
			// that blamed the agent for a client-side teardown.
			if (this.isDisposed) {
				return reject(new Error(`${this.plan.label} transport is disposed`));
			}
			if (!this.child?.stdin || this.child.killed) {
				return reject(new Error(`${this.plan.label} process is not running`));
			}
			const id = this.nextRpcId++;
			const req: AcpMessage = { jsonrpc: "2.0", id, method, params };

			// timeoutMs <= 0 means "wait for the response indefinitely" — used for
			// long-running session/prompt turns, which complete by the ACP response
			// arriving, never by a wall-clock timer.
			let timer: NodeJS.Timeout | null = null;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					if (this.pendingRequests.has(id)) {
						this.pendingRequests.delete(id);
						reject(new Error(`${this.plan.label} RPC request timed out after ${timeoutMs}ms (${method})`));
					}
				}, timeoutMs);
			}

			this.pendingRequests.set(id, { resolve, reject, timer });
			try {
				this.child.stdin.write(`${JSON.stringify(req)}\n`);
			} catch (err) {
				// Synchronous write failure (e.g. destroyed stdin): don't leave a zombie
				// pending entry — reject immediately.
				this.pendingRequests.delete(id);
				if (timer) {
					clearTimeout(timer);
				}
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** The env the plan asked for, for tests that must prove a spawn carried it. */
	launchEnv(key: string): string | undefined {
		return this.plan.env[key];
	}

	notify(method: string, params: any): void {
		if (!this.child?.stdin || this.child.killed || this.isDisposed) {
			return;
		}
		const msg: AcpMessage = { jsonrpc: "2.0", method, params };
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	private handleMessage(msg: AcpMessage): void {
		if (msg.method && msg.id !== undefined) {
			const req: AcpIncomingRequest = { id: msg.id, method: msg.method, params: msg.params };
			let taken = false;
			try {
				taken = this.onRequestCallback?.(req) ?? false;
			} catch {
				taken = false;
			}
			// The agent blocks until it gets an answer: never leave a request without one.
			if (!taken) {
				this.respondError(msg.id, -32601, `Method not found: ${msg.method}`);
			}
			return;
		}
		if (typeof msg.id === "number") {
			const pending = this.pendingRequests.get(msg.id);
			if (pending) {
				if (pending.timer) {
					clearTimeout(pending.timer);
				}
				this.pendingRequests.delete(msg.id);
				if (msg.error) {
					pending.reject(new Error(msg.error.message || `RPC error ${msg.error.code}`));
				} else {
					pending.resolve(msg.result);
				}
				return;
			}
		}

		if (msg.method === "session/update" && msg.params) {
			if (this.onUpdateCallback) {
				this.onUpdateCallback(msg.params);
			}
			return;
		}

		// Any other notification (`_auth/status_update`, `subagent_update`) is recorded and dropped:
		// it carries no session state the engine owns, and silently discarding it without a line in
		// the log is how "is this a leak?" becomes a day of archaeology.
		if (msg.method) {
			this.logEvent("notification_ignored", { method: msg.method });
		}
	}

	logEvent(type: string, data: any): void {
		if (!this.logStream) {
			return;
		}
		const entry = {
			timestamp: new Date().toISOString(),
			type,
			data,
		};
		try {
			this.logStream.write(`${JSON.stringify(entry)}\n`);
		} catch {}
	}

	appendAssistantMessage(text: string): void {
		this.logEvent("assistant_message", { text });
	}

	appendThoughtMessage(text: string): void {
		this.logEvent("thought_message", { text });
	}

	appendUserMessage(text: string): void {
		this.logEvent("user_message", { text });
	}

	dispose(): void {
		this.isDisposed = true;
		for (const req of this.pendingRequests.values()) {
			if (req.timer) {
				clearTimeout(req.timer);
			}
			req.reject(new Error("DelegateTransport disposed"));
		}
		this.pendingRequests.clear();

		if (this.child && !this.child.killed) {
			try {
				if (process.platform !== "win32" && this.child.pid) {
					// Kill process group
					try {
						process.kill(-this.child.pid, "SIGTERM");
					} catch {
						this.child.kill("SIGTERM");
					}
				} else {
					this.child.kill("SIGTERM");
				}

				const pid = this.child.pid;
				setTimeout(() => {
					try {
						if (pid && process.platform !== "win32") {
							process.kill(-pid, "SIGKILL");
						}
					} catch {}
				}, 1500).unref();
			} catch {}
		}

		// Break the remaining reference chains so a silently-failed kill
		// (detached process group) cannot pin the client — and the session state
		// its callbacks reference — in memory. The child's 'error'/'exit' handlers
		// are kept (both are no-ops once disposed) so delayed child errors keep
		// being swallowed instead of crashing the host pi process.
		this.onUpdateCallback = undefined;
		this.onExitCallback = undefined;
		this.onRequestCallback = undefined;
		try {
			this.rl?.close();
		} catch {}
		this.rl = null;
		if (this.child) {
			this.child.stderr?.removeAllListeners();
			this.child.stdin?.removeAllListeners();
			try {
				this.child.stdin?.destroy();
			} catch {}
		}
		if (this.logStream) {
			try {
				this.logStream.end();
			} catch {}
			this.logStream = null;
		}
	}
}
