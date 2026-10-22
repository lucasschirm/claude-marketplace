// Client side of Devin's Agent Client Protocol (ACP) server: spawns `devin acp`, correlates
// JSON-RPC requests with their responses, and streams every line to the session's event log.
//
// ACP is bidirectional. Devin also sends requests *to* the client (session/request_permission in
// any mode but bypass) and blocks the turn until they are answered, so every incoming request is
// answered: by the handler set with setOnRequest, or with a method-not-found error. Leaving one
// unanswered froze every delegated session at its first permission prompt (2026-10-22).
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

/** JSON-RPC ids: ours are numbers, Devin's own requests use string UUIDs. */
export type AcpId = number | string;

/** A request Devin sent to the client. */
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

export class AcpClient {
	private child: ChildProcess | null = null;
	private nextRpcId = 1;
	private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout | null }>();
	private logStream: fs.WriteStream | null = null;
	private rl: readline.Interface | null = null;
	private onUpdateCallback?: (update: any) => void;
	private onExitCallback?: (code: number | null, signal: string | null) => void;
	private onRequestCallback?: (req: AcpIncomingRequest) => boolean;
	private isDisposed = false;

	private cwd: string;
	private model: string;

	constructor(cwd: string, model: string) {
		this.cwd = cwd;
		this.model = model;
	}

	setLogFilePath(logFilePath: string): void {
		if (this.logStream) {
			this.logStream.end();
		}
		fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
		this.logStream = fs.createWriteStream(logFilePath, { flags: "a" });
	}

	async start(): Promise<void> {
		const args = ["acp"];
		if (this.model) {
			args.push("--model", this.model);
		}

		// Spawn process in a new process group for clean tree termination
		const isPosix = process.platform !== "win32";
		this.child = spawn("devin", args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: isPosix,
			env: {
				...process.env,
				DEVIN_MODEL: this.model,
			},
		});

		this.child.on("error", (err) => {
			this.logEvent("error", { message: err.message });
			for (const req of this.pendingRequests.values()) {
				if (req.timer) clearTimeout(req.timer);
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

		this.rl = readline.createInterface({
			input: this.child.stdout!,
			crlfDelay: Infinity,
		});

		this.rl.on("line", (line) => {
			if (!line.trim()) return;
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

		this.child.on("exit", (code, signal) => {
			if (!this.isDisposed && this.onExitCallback) {
				this.onExitCallback(code, signal);
			}
			for (const req of this.pendingRequests.values()) {
				if (req.timer) clearTimeout(req.timer);
				req.reject(new Error(`devin acp exited with code ${code}`));
			}
			this.pendingRequests.clear();
		});

		// Handshake: initialize
		await this.request("initialize", {
			clientInfo: { name: "pi-devin-delegate", version: "1.0" },
			protocolVersion: 1,
		});
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

	/** Answer a request Devin sent (see setOnRequest). */
	respond(id: AcpId, result: unknown): void {
		this.write({ jsonrpc: "2.0", id, result });
	}

	respondError(id: AcpId, code: number, message: string): void {
		this.write({ jsonrpc: "2.0", id, error: { code, message } });
	}

	private write(msg: AcpMessage): void {
		const stdin = this.child?.stdin;
		if (!stdin || this.child?.killed) return;
		try {
			stdin.write(`${JSON.stringify(msg)}\n`);
		} catch {
			// A dying process: the exit handler settles the session.
		}
	}

	request(method: string, params: any, timeoutMs = 60000): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.child || !this.child.stdin || this.child.killed) {
				return reject(new Error("devin acp process is not running"));
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
						reject(new Error(`devin acp RPC request timed out after ${timeoutMs}ms (${method})`));
					}
				}, timeoutMs);
			}

			this.pendingRequests.set(id, { resolve, reject, timer });
			try {
				this.child.stdin.write(JSON.stringify(req) + "\n");
			} catch (err) {
				// Synchronous write failure (e.g. destroyed stdin): don't leave a zombie
				// pending entry — reject immediately.
				this.pendingRequests.delete(id);
				if (timer) clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	notify(method: string, params: any): void {
		if (!this.child || !this.child.stdin || this.child.killed) return;
		const msg: AcpMessage = { jsonrpc: "2.0", method, params };
		this.child.stdin.write(JSON.stringify(msg) + "\n");
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
			// Devin blocks until it gets an answer: never leave a request without one.
			if (!taken) this.respondError(msg.id, -32601, `Method not found: ${msg.method}`);
			return;
		}
		if (typeof msg.id === "number" && this.pendingRequests.has(msg.id)) {
			const { resolve, reject, timer } = this.pendingRequests.get(msg.id)!;
			if (timer) clearTimeout(timer);
			this.pendingRequests.delete(msg.id);
			if (msg.error) {
				reject(new Error(msg.error.message || `RPC error ${msg.error.code}`));
			} else {
				resolve(msg.result);
			}
			return;
		}

		if (msg.method === "session/update" && msg.params) {
			if (this.onUpdateCallback) {
				this.onUpdateCallback(msg.params);
			}
		}
	}

	logEvent(type: string, data: any): void {
		if (!this.logStream) return;
		const entry = {
			timestamp: new Date().toISOString(),
			type,
			data,
		};
		try {
			this.logStream.write(JSON.stringify(entry) + "\n");
		} catch {}
	}

	appendAssistantMessage(text: string): void {
		this.logEvent("assistant_message", { text });
	}

	appendUserMessage(text: string): void {
		this.logEvent("user_message", { text });
	}

	dispose(): void {
		this.isDisposed = true;
		for (const req of this.pendingRequests.values()) {
			if (req.timer) clearTimeout(req.timer);
			req.reject(new Error("AcpClient disposed"));
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
