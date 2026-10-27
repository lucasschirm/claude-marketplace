// The agy-acp server assembly: the JSON-RPC transport, the initialize handshake, the session
// methods (session/new, session/prompt) and the session registry.
//
// main.ts is a thin wrapper over startAgyAcpServer(); the tests run the same assembly in-process
// (PassThrough stdio) with the agy launch pointed at the fixture-replaying fake.

import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";
import { INVALID_PARAMS, INTERNAL_ERROR, RpcError } from "./errors.ts";
import { JsonRpcConnection } from "./jsonrpc.ts";
import { checkAgyVersion, type AgyVersionStatus } from "./agy-driver.ts";
import { AgySession } from "./session.ts";

// Keep in sync with agy-acp/package.json (test-package.ts asserts it).
export const AGY_ACP_VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;

export interface AgyLaunchOptions {
	/** The agy binary (default "agy"). */
	command?: string;
	/** argv prefix in place of the command (tests point this at the fake). */
	argvPrefix?: string[];
	/** The exact environment the child sees (default the server's process.env). */
	env?: NodeJS.ProcessEnv;
	// Launch options forwarded to the driver; per-session model/effort selection lands in sub-issue 6.
	model?: string;
	effort?: string;
	skipPermissions?: boolean;
	addDirs?: string[];
	probeTimeoutMs?: number;
	graceMs?: number;
	termMs?: number;
}

export interface AgyAcpServerOptions {
	input: Readable;
	output: Writable;
	log?: (line: string) => void;
	agy?: AgyLaunchOptions;
}

export interface AgyAcpServer {
	/** Disposes every live session; the connection close does this on its own. */
	disposeSessions: () => Promise<void>;
}

/** The version gate: run once before the first session/new, cached (a failed check may retry). */
function makeVersionGate(launch: AgyLaunchOptions): () => Promise<AgyVersionStatus> {
	let cached: Promise<AgyVersionStatus> | null = null;
	return () => {
		if (!cached) {
			const argv = [...(launch.argvPrefix ?? [launch.command ?? "agy"]), "--version"];
			cached = checkAgyVersion(argv).catch((err: Error) => {
				cached = null; // a transient spawn failure is not a verdict about the version
				throw err;
			});
		}
		return cached;
	};
}

function handleInitialize(params: unknown): unknown {
	const requested = typeof params === "object" && params !== null ? (params as Record<string, unknown>).protocolVersion : undefined;
	// ACP negotiation: a client asking for a newer version gets the latest we support (the spec's
	// MUST - the client decides). A version we cannot honour at all is rejected with -32602.
	if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 1) {
		throw new RpcError(INVALID_PARAMS, `unsupported protocolVersion ${JSON.stringify(requested)} - agy-acp speaks ${PROTOCOL_VERSION}`);
	}
	return {
		protocolVersion: PROTOCOL_VERSION,
		agentCapabilities: {
			loadSession: false,
			promptCapabilities: { audio: false, embeddedContext: true, image: false },
		},
		authMethods: [],
		agentInfo: { name: "agy-acp", version: AGY_ACP_VERSION },
	};
}

export function startAgyAcpServer(options: AgyAcpServerOptions): AgyAcpServer {
	const log = options.log ?? (() => {});
	const launch = options.agy ?? {};
	const connection = new JsonRpcConnection({ input: options.input, output: options.output, log });
	const registry = new SessionRegistry(log);
	const checkVersion = makeVersionGate(launch);

	connection.registerMethod("initialize", handleInitialize);
	connection.registerMethod("session/new", (params) => handleSessionNew(params));
	connection.registerMethod("session/prompt", (params) => handleSessionPrompt(params));
	connection.onNotification((method) => log(`ignored notification: ${method}`));
	connection.onClose((reason) => {
		log(`connection closed: ${reason}`);
		void registry.disposeAll();
	});

	/** The session/new params: an object with an absolute cwd and an optional mcpServers array. */
	function parseSessionNew(params: unknown): { cwd: string; mcpServers: unknown[] | undefined } {
		if (typeof params !== "object" || params === null) throw new RpcError(INVALID_PARAMS, "session/new params must be an object");
		const p = params as Record<string, unknown>;
		const cwd = p.cwd;
		if (typeof cwd !== "string") throw new RpcError(INVALID_PARAMS, "cwd must be a string");
		if (!path.isAbsolute(cwd)) throw new RpcError(INVALID_PARAMS, `cwd must be an absolute path: ${cwd}`);
		const mcpServers = p.mcpServers;
		if (mcpServers !== undefined && (!Array.isArray(mcpServers) || mcpServers.some((s) => typeof s !== "object" || s === null))) {
			throw new RpcError(INVALID_PARAMS, "mcpServers must be an array of server descriptors");
		}
		return { cwd, mcpServers: mcpServers as unknown[] | undefined };
	}

	async function handleSessionNew(params: unknown): Promise<Record<string, unknown>> {
		const { cwd, mcpServers } = parseSessionNew(params);
		let isDirectory = false;
		try {
			isDirectory = (await fs.promises.stat(cwd)).isDirectory();
		} catch {
			throw new RpcError(INVALID_PARAMS, `cwd does not exist: ${cwd}`);
		}
		if (!isDirectory) throw new RpcError(INVALID_PARAMS, `cwd is not a directory: ${cwd}`);
		const status = await checkVersion();
		if (status.strictRefusal) {
			throw new RpcError(INTERNAL_ERROR, status.warning ?? "the agy version is refused by AGY_ACP_STRICT_VERSION", {
				agyVersion: status.version,
			});
		}
		if (status.warning) log(`agy version warning: ${status.warning}`);
		const session = new AgySession({
			cwd,
			...launch,
			log,
			notify: (sessionId, update) => connection.notify("session/update", { sessionId, update }),
		});
		const sessionId = await session.start(); // a failure disposes the child and throws the RpcError
		registry.add(sessionId, session);
		// Modes and models are stubs until sub-issue 6 (modes, model and effort selection): the
		// session runs in agy's default headless mode, and the model is whatever agy launched.
		const result: Record<string, unknown> = {
			sessionId,
			modes: {
				currentModeId: "default",
				availableModes: [{ id: "default", name: "Default", description: "agy headless mode; selection lands in sub-issue 6" }],
			},
			models: { currentModelId: session.initModel, availableModels: session.initModel ? [session.initModel] : [] },
		};
		if (mcpServers) {
			// The recorded agy 1.4.2 flag surface has no per-session MCP configuration flag, so the
			// servers are accepted, reported as unsupported and echoed back - never silently dropped.
			// (agy's built-in tool list carries call_mcp_tool, so it may manage MCP servers
			// out-of-band; whether per-session configuration exists needs investigating.)
			log(`session ${sessionId}: ${mcpServers.length} mcpServers requested - unsupported by agy, reported via _meta`);
			result._meta = { mcpServers: { supported: false, requested: mcpServers } };
		}
		if (status.warning) {
			result._meta = {
				...(result._meta as Record<string, unknown> | undefined),
				agyVersion: { version: status.version, tested: status.tested, warning: status.warning },
			};
		}
		return result;
	}

	function handleSessionPrompt(params: unknown): unknown {
		if (typeof params !== "object" || params === null) throw new RpcError(INVALID_PARAMS, "session/prompt params must be an object");
		const p = params as Record<string, unknown>;
		if (typeof p.sessionId !== "string") throw new RpcError(INVALID_PARAMS, "sessionId must be a string");
		const session = registry.get(p.sessionId);
		if (!session) throw new RpcError(INVALID_PARAMS, `unknown sessionId: ${p.sessionId}`);
		return session.prompt(p.prompt);
	}

	return { disposeSessions: () => registry.disposeAll() };
}

/** The session table; disposeAll() runs when the connection closes, so no child outlives the server. */
export class SessionRegistry {
	private readonly sessions = new Map<string, AgySession>();
	private readonly log: (line: string) => void;

	constructor(log: (line: string) => void) {
		this.log = log;
	}

	add(sessionId: string, session: AgySession): void {
		this.sessions.set(sessionId, session);
	}

	get(sessionId: string): AgySession | undefined {
		return this.sessions.get(sessionId);
	}

	async disposeAll(): Promise<void> {
		const entries = [...this.sessions.values()];
		this.sessions.clear();
		for (const session of entries) {
			this.log(`disposing session ${session.id}`);
			try {
				await session.dispose();
			} catch (err) {
				this.log(`session ${session.id} dispose failed: ${(err as Error).message}`);
			}
		}
	}
}
