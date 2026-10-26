// JSON-RPC 2.0 transport for agy-acp: newline-delimited frames over stdio.
//
// Framing splits on "\n" only. node:readline is never used because it also splits on U+2028/U+2029,
// and a frame carrying either inside a string would be torn in half. Input is buffered as raw bytes,
// so a multi-byte UTF-8 character split across two chunks is decoded only once its frame is complete.
// A line longer than maxFrameBytes closes the connection with a logged error, so a runaway peer is
// bounded instead of buffered forever.
//
// stdout carries protocol frames and nothing else: every diagnostic goes through the `log` callback
// (stderr, or the file named by AGY_ACP_LOG).

import type { Readable, Writable } from "node:stream";
import { INTERNAL_ERROR, PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, RpcError } from "./errors.ts";
import { DEFAULT_MAX_FRAME_BYTES, FrameDecoder } from "./framing.ts";

export { DEFAULT_MAX_FRAME_BYTES } from "./framing.ts";
export * from "./errors.ts";

type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
type NotificationHandler = (method: string, params: unknown) => void;

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout | null;
}

interface ConnectionOptions {
	input: Readable;
	output: Writable;
	log?: (line: string) => void;
	maxFrameBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One JSON-RPC peer: correlates our outgoing numeric-id requests with their responses, dispatches
 * incoming requests to registered handlers, and forwards notifications. Every incoming request is
 * answered — a peer left waiting is a hung session, so unknown methods get -32601 and a thrown
 * handler error becomes -32603 (or the code an RpcError carries).
 */
export class JsonRpcConnection {
	private readonly handlers = new Map<string, RequestHandler>();
	private readonly pending = new Map<number, PendingRequest>();
	private readonly decoder: FrameDecoder;
	private readonly input: Readable;
	private readonly output: Writable;
	private readonly log: (line: string) => void;
	private notificationHandler: NotificationHandler | null = null;
	private closeCallback: ((reason: string) => void) | null = null;
	private nextId = 1;
	// `inputEnded` is half-close: the peer's write side is gone, so nothing more can arrive and our
	// outgoing requests can never be answered - but a request already inside a handler still gets its
	// response written (the peer may keep reading). `closed` is the hard close: nothing more is sent.
	private inputEnded = false;
	private closed = false;
	private notified = false;

	constructor(options: ConnectionOptions) {
		this.input = options.input;
		this.output = options.output;
		const rawLog = options.log ?? (() => {});
		this.log = (line) => {
			try {
				rawLog(line);
			} catch {
				// a logger that throws must not take the transport down with it
			}
		};
		this.decoder = new FrameDecoder(
			options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
			(line) => this.handleLine(line),
			(reason) => this.sendError(null, PARSE_ERROR, `Parse error: ${reason}`),
			(bytes) => {
				this.log(`oversized frame (${bytes} bytes, limit ${options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES}) - closing connection`);
				this.close("oversized frame");
			},
		);
		this.input.on("data", (chunk: Buffer) => this.decoder.push(chunk));
		this.input.on("end", () => this.onInputEnded("peer closed input"));
		this.input.on("close", () => this.onInputEnded("input closed"));
		this.input.on("error", (err) => {
			this.log(`input error: ${err.message}`);
			this.close("input error");
		});
		// A dead client mid-write surfaces here (EPIPE) as an async event - send()'s try/catch cannot
		// see it, and an unhandled 'error' event would take the process down with it.
		this.output.on("error", (err) => {
			this.log(`output error: ${err.message}`);
			this.close("output error");
		});
	}

	/** A method this peer answers. Handlers throw RpcError to choose the error code. */
	registerMethod(name: string, handler: RequestHandler): void {
		this.handlers.set(name, handler);
	}

	onNotification(cb: NotificationHandler): void {
		this.notificationHandler = cb;
	}

	onClose(cb: (reason: string) => void): void {
		this.closeCallback = cb;
	}

	/** An outgoing request; numeric ids are ours and can never collide with a peer's string ids. */
	request(method: string, params?: unknown, timeoutMs = 0): Promise<unknown> {
		if (this.closed || this.inputEnded) return Promise.reject(new Error("connection is closed"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | null = null;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					if (this.pending.delete(id)) reject(new Error(`request "${method}" timed out after ${timeoutMs}ms`));
				}, timeoutMs);
				timer.unref();
			}
			this.pending.set(id, { resolve, reject, timer });
			if (!this.send({ jsonrpc: "2.0", id, method, params })) {
				this.pending.delete(id);
				if (timer) clearTimeout(timer);
				reject(
					this.closed ? new Error("connection is closed") : new RpcError(INTERNAL_ERROR, `request "${method}" could not be serialized`),
				);
			}
		});
	}

	notify(method: string, params?: unknown): void {
		if (!this.send({ jsonrpc: "2.0", method, params }) && !this.closed) {
			this.log(`notification "${method}" dropped: params are not JSON-serializable`);
		}
	}

	close(reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.inputEnded = true;
		this.input.removeAllListeners("data");
		if (typeof this.input.pause === "function") this.input.pause();
		this.rejectPending(reason);
		this.notifyClosed(reason);
	}

	/** The peer's write side ended or closed: stop reading, fail our requests, keep answering theirs. */
	private onInputEnded(reason: string): void {
		if (this.inputEnded || this.closed) return;
		this.inputEnded = true;
		this.input.removeAllListeners("data");
		if (typeof this.input.pause === "function") this.input.pause();
		const leftover = this.decoder.pendingBytes;
		if (leftover > 0) this.log(`peer ended with ${leftover} unterminated byte(s) buffered - discarding them`);
		this.rejectPending(reason);
		this.notifyClosed(reason);
	}

	private rejectPending(reason: string): void {
		for (const pending of this.pending.values()) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error(`connection closed (${reason})`));
		}
		this.pending.clear();
	}

	private notifyClosed(reason: string): void {
		if (this.notified) return;
		this.notified = true;
		try {
			this.closeCallback?.(reason);
		} catch (err) {
			this.log(`close callback failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Returns false when nothing was written: closed connection, or the message cannot serialize. */
	private send(msg: Record<string, unknown>): boolean {
		if (this.closed) return false;
		let frame: string;
		try {
			frame = `${JSON.stringify(msg)}\n`;
		} catch {
			return false;
		}
		try {
			this.output.write(frame);
		} catch (err) {
			this.log(`write failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return true;
	}

	private sendResult(id: unknown, result: unknown): void {
		// A result that cannot serialize must not silence the request: fall back to an error response
		// so the peer is never left waiting for an answer that cannot exist.
		if (!this.send({ jsonrpc: "2.0", id: id ?? null, result: result ?? null }) && !this.closed) {
			this.log(`result for id ${JSON.stringify(id)} is not JSON-serializable - answering with an internal error`);
			this.sendError(id, INTERNAL_ERROR, "Internal error: result is not JSON-serializable");
		}
	}

	private sendError(id: unknown, code: number, message: string, data?: unknown): void {
		const error: Record<string, unknown> = { code, message };
		if (data !== undefined) error.data = data;
		// If `data` is what cannot serialize, the error still goes out - just without it.
		if (!this.send({ jsonrpc: "2.0", id: id ?? null, error }) && data !== undefined && !this.closed) {
			this.send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
		}
	}

	private handleLine(line: string): void {
		if (line.trim() === "") return;
		let msg: unknown;
		try {
			msg = JSON.parse(line);
		} catch {
			this.sendError(null, PARSE_ERROR, "Parse error: frame is not valid JSON");
			return;
		}
		if (!isRecord(msg)) {
			this.sendError(null, INVALID_REQUEST, "Invalid Request: expected a JSON-RPC 2.0 object");
			return;
		}
		if (msg.jsonrpc !== "2.0") {
			this.sendError("id" in msg ? msg.id : null, INVALID_REQUEST, "Invalid Request: expected a JSON-RPC 2.0 object");
			return;
		}
		if (typeof msg.method === "string") {
			if ("id" in msg) this.answer(msg.id, msg.method, msg.params);
			else this.dispatchNotification(msg.method, msg.params);
			return;
		}
		if ("id" in msg && ("result" in msg || "error" in msg)) {
			this.settle(msg);
			return;
		}
		this.sendError("id" in msg ? msg.id : null, INVALID_REQUEST, "Invalid Request");
	}

	private dispatchNotification(method: string, params: unknown): void {
		try {
			this.notificationHandler?.(method, params);
		} catch (err) {
			this.log(`notification handler for "${method}" failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Every incoming request is answered; a handler that throws still produces a response. */
	private answer(id: unknown, method: string, params: unknown): void {
		const handler = this.handlers.get(method);
		if (!handler) {
			this.sendError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
			return;
		}
		Promise.resolve()
			.then(() => handler(params))
			.then((result) => this.sendResult(id, result))
			.catch((err: unknown) => {
				if (err instanceof RpcError) {
					this.sendError(id, err.code, err.message, err.data);
				} else {
					this.log(`handler for "${method}" failed: ${err instanceof Error ? err.message : String(err)}`);
					this.sendError(id, INTERNAL_ERROR, err instanceof Error ? err.message : "Internal error");
				}
			});
	}

	private settle(msg: Record<string, unknown>): void {
		const id = msg.id;
		if (typeof id !== "number") {
			this.log(`ignoring response with non-numeric id ${JSON.stringify(id)}`);
			return;
		}
		const pending = this.pending.get(id);
		if (!pending) {
			this.log(`ignoring response for unknown id ${id}`);
			return;
		}
		this.pending.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		if ("error" in msg) {
			const err = msg.error;
			// A malformed error object still fails the request - resolving it would hand the caller
			// `undefined` dressed as success.
			const code = isRecord(err) && typeof err.code === "number" ? err.code : INTERNAL_ERROR;
			const message = isRecord(err) && typeof err.message === "string" ? err.message : `error ${String(isRecord(err) ? err.code : err)}`;
			pending.reject(new RpcError(code, message, isRecord(err) ? err.data : undefined));
		} else {
			pending.resolve(msg.result);
		}
	}
}
