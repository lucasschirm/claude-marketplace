// The per-session permission-bridge directory and Unix socket the PreToolUse hook dials.
//
// The directory is created under $XDG_RUNTIME_DIR/agy-acp/ (0700, falling back to os.tmpdir())
// with a random per-session name, holds `.agents/hooks.json` (one PreToolUse hook under an
// unguessable per-session name) and a 0600 socket. The socket path must be <= 107 bytes
// (sun_path), so the name is shortened until it fits. Nothing here ever writes user-level agy
// configuration (~/.gemini): hooks.json lives in the per-session dir only.
// The hook request protocol is one JSON line in, one JSON line out:
//   in:  { token, conversationId, stepIdx, toolCall: { name, args } }
//   out: { decision: "allow" | "deny", reason? }
// A bad token or conversation id closes the connection without a reply; the hook's fail-closed
// behaviour (close -> deny) is what makes that a safe failure.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";

/** The Unix socket path limit (sun_path). */
export const SOCKET_PATH_MAX_BYTES = 107;
/** A bridge dir older than this is a leftover of a crashed run and is removed at startup. */
export const STALE_BRIDGE_MS = 60 * 60 * 1000;
/** The name hex lengths tried in order when the socket path does not fit. */
export const NAME_HEX_LENGTHS = [16, 12, 8];
export const BRIDGE_DIR_NAME_RE = /^agy-acp-[0-9a-f]{8,16}$/;
export interface BridgeRequest {
	token: string;
	conversationId: string;
	stepIdx: number;
	toolCall: { name: string; args: Record<string, unknown> };
}
export interface BridgeReply {
	decision: "allow" | "deny";
	reason?: string;
}

export interface BridgeServerOptions {
	log: (line: string) => void;
	/** The per-session token the hook must present. */
	token: string;
	/** The node binary and hook file the command in hooks.json invokes (defaults: this package). */
	node?: string;
	hookFile?: string;
	/** The hook timeout (seconds) written into hooks.json - the top of the deadline ladder. */
	hookTimeoutSec: number;
	/** The server-side hold ceiling per connection: a net above the hook's own deadline. */
	maxHoldMs: number;
	/** The conversation id a request must carry (null before the probe). */
	conversationId: () => string | null;
	handle: (req: BridgeRequest) => Promise<BridgeReply>;
	/** The hook went away (connection lost) before its request was answered. */
	onConnectionLost: (key: string) => void;
}

export class BridgeServer {
	dir = "";
	socketPath = "";
	hookName = "";
	private readonly opts: BridgeServerOptions;
	private server: Server | null = null;
	private readonly connections = new Set<Socket>();
	private disposed = false;
	constructor(opts: BridgeServerOptions) {
		this.opts = opts;
	}

	/** Creates the dir (0700), hooks.json and the listening socket (0600). Throws on failure: the
	 * caller must not start agy then - an ungated session must never launch. */
	async start(): Promise<void> {
		const layout = createBridgeLayout({
			node: this.opts.node ?? process.execPath,
			hookFile: this.opts.hookFile ?? defaultHookFile(),
			hookTimeoutSec: this.opts.hookTimeoutSec,
		});
		({ dir: this.dir, socketPath: this.socketPath, hookName: this.hookName } = layout);
		try {
			// 0700 for the parent too: a sibling user must not be able to drop a hooks.json into it.
			await fs.promises.mkdir(path.dirname(layout.dir), { recursive: true, mode: 0o700 });
			for (const d of [layout.dir, path.join(layout.dir, ".agents")]) await fs.promises.mkdir(d, { mode: 0o700 });
			await fs.promises.writeFile(path.join(layout.dir, ".agents", "hooks.json"), layout.hooksJson, { mode: 0o600 });
			await fs.promises.chmod(layout.dir, 0o700);
			const server = createNetServer((conn) => {
				this.connections.add(conn);
				conn.on("close", () => this.connections.delete(conn));
				this.handleConnection(conn);
			});
			server.on("error", (err) => this.opts.log(`bridge socket error: ${err.message}`));
			this.server = server;
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(this.socketPath, () => {
					server.removeListener("error", reject);
					resolve();
				});
			});
			await fs.promises.chmod(this.socketPath, 0o600);
		} catch (err) {
			// A partial start (the listener is up but e.g. the socket chmod failed) must not leak a
			// live listener or a half-written dir: close it, then propagate.
			await this.stop();
			throw err;
		}
	}

	/** Closes the socket and removes the dir. Idempotent. */
	async stop(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const server = this.server;
		this.server = null;
		for (const conn of this.connections) conn.destroy();
		this.connections.clear();
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		try {
			await fs.promises.rm(this.dir, { recursive: true, force: true });
		} catch (err) {
			this.opts.log(`bridge cleanup failed: ${(err as Error).message}`);
		}
	}

	/** One hook connection: one request line in, one reply line out, then closed. */
	private handleConnection(conn: Socket): void {
		let lostKey = ""; // conversation-scoped pending-ask key, set after auth
		let answered = false;
		const hold = setTimeout(() => {
			this.opts.log(`bridge: connection held beyond ${this.opts.maxHoldMs} ms - closing`);
			conn.destroy();
		}, this.opts.maxHoldMs).unref();
		conn.on("close", () => {
			clearTimeout(hold);
			if (!answered && lostKey !== "") {
				try {
					this.opts.onConnectionLost(lostKey);
				} catch (err) {
					this.opts.log(`bridge: connection-lost handler failed: ${(err as Error).message}`);
				}
			}
		});
		conn.on("error", () => {}); // a broken hook connection is the hook's own fail-closed to handle
		let buf = "",
			handled = false;
		conn.on("data", (d: Buffer) => {
			if (handled) return;
			buf += d.toString("utf8");
			const i = buf.indexOf("\n");
			if (i < 0) return;
			handled = true;
			const line = buf.slice(0, i);
			const req = normalizeBridgeRequest(line);
			if (req === null) {
				this.opts.log("bridge: malformed request line - closing");
				conn.destroy();
				return;
			}
			// The token (per-session, 256-bit) is the real boundary; the conversation check is
			// defence in depth. A subagent's internal tool call may carry its own (sub) conversation
			// id: same agy process, same token, and the call still goes through policy + the client.
			if (req.token !== this.opts.token) {
				this.opts.log(`bridge: token mismatch (step ${req.stepIdx}) - closing`);
				conn.destroy();
				return;
			}
			const expected = this.opts.conversationId();
			if (expected === null || (req.conversationId !== expected && req.conversationId === "")) {
				this.opts.log(
					`bridge: conversation mismatch (got ${req.conversationId || "(none)"}, want ${expected ?? "(not probed)"}) - closing`,
				);
				conn.destroy();
				return;
			}
			// after auth: an unauthenticated close must not abort a legitimate pending ask
			lostKey = `${req.conversationId}:${req.stepIdx}`;
			void this.opts.handle(req).then(
				(reply) => {
					answered = true;
					try {
						conn.end(`${JSON.stringify(reply)}\n`);
					} catch {
						// a dead connection cannot be revived; the reply is lost and the hook fails closed
					}
				},
				(err: Error) => {
					this.opts.log(`bridge: handler failed: ${err.message}`);
					conn.destroy();
				},
			);
		});
	}
}

/** The shipped hook file: the one next to this source. */
export function defaultHookFile(): string {
	return fileURLToPath(new URL("./bridge-hook.ts", import.meta.url));
}

/** Tolerates the wire shape: one JSON object with the four known fields. */
function normalizeBridgeRequest(line: string): BridgeRequest | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.token !== "string" || typeof o.conversationId !== "string") return null;
	if (typeof o.stepIdx !== "number" || !Number.isInteger(o.stepIdx)) return null;
	const t = o.toolCall;
	if (typeof t !== "object" || t === null) return null;
	const o2 = t as Record<string, unknown>;
	const args = typeof o2.args === "object" && o2.args !== null ? (o2.args as Record<string, unknown>) : {};
	return {
		token: o.token,
		conversationId: o.conversationId,
		stepIdx: o.stepIdx,
		toolCall: { name: typeof o2.name === "string" ? o2.name : "", args },
	};
}

export interface BridgeLayoutOptions {
	/** The runtime dirs to try in order; the first with a fitting socket path wins. */
	runtimeDirs?: string[];
	node: string;
	hookFile: string;
	hookTimeoutSec: number;
	/** Injection point for the per-session random (tests). */
	hex?: (n: number) => string;
}

/** The dir + socket layout, chosen so the socket path is <= 107 bytes: the name hex is
 * shortened (16 -> 12 -> 8) before moving to the next runtime dir. */
export function createBridgeLayout(opts: BridgeLayoutOptions): { dir: string; socketPath: string; hookName: string; hooksJson: string } {
	const hex =
		opts.hex ??
		((n: number) =>
			randomBytes(Math.ceil(n / 2))
				.toString("hex")
				.slice(0, n));
	const dirs = opts.runtimeDirs ?? bridgeRuntimeDirs();
	for (const root of dirs) {
		for (const n of NAME_HEX_LENGTHS) {
			const hookName = `agy-acp-${hex(n)}`;
			const dir = path.join(root, hookName);
			const socketPath = path.join(dir, "socket");
			if (Buffer.byteLength(socketPath, "utf8") > SOCKET_PATH_MAX_BYTES) continue;
			const hooksJson = JSON.stringify(
				{
					[hookName]: {
						PreToolUse: [
							{
								matcher: "*",
								hooks: [
									{
										type: "command",
										// Shell-safe quoting: the node binary and hook file are our own paths, but a
										// path with spaces must not split the agy `sh -c` invocation.
										command: `exec ${shellQuote(opts.node)} ${shellQuote(opts.hookFile)}`,
										timeout: opts.hookTimeoutSec,
									},
								],
							},
						],
					},
				},
				null,
				2,
			);
			return { dir, socketPath, hookName, hooksJson };
		}
	}
	throw new Error(`no bridge dir gives a socket path <= ${SOCKET_PATH_MAX_BYTES} bytes`);
}

/** Single-quote shell quoting (the agy hook runs under `sh -c`). */
function shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The runtime dirs in order: $XDG_RUNTIME_DIR/agy-acp (when set) first, then os.tmpdir(). */
export function bridgeRuntimeDirs(): string[] {
	const out: string[] = [];
	const xdg = process.env.XDG_RUNTIME_DIR;
	if (xdg && xdg.trim() !== "") out.push(path.join(xdg, "agy-acp"));
	out.push(os.tmpdir());
	return out;
}
