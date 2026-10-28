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
import { lifecycleConfigFromEnv } from "./config.ts";
import { checkAgyVersion, type AgyVersionStatus } from "./agy-driver.ts";
import { AgySession } from "./session.ts";
import { SessionRegistry } from "./session-registry.ts";
import { AGY_ACP_MODES } from "./permission.ts";

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
	/** Kept for API compatibility; the session forces it: the bridge hook is the only gate. */
	skipPermissions?: boolean;
	addDirs?: string[];
	/** The client deadline for session/request_permission (default 10 min; below the hook deadline). */
	clientDeadlineMs?: number;
	/** The hook's own deadline (AGY_ACP_HOOK_DEADLINE_MS); above the client deadline, below the hook timeout. */
	hookDeadlineMs?: number;
	/** The hooks.json timeout (seconds) agy enforces on the hook; above the hook deadline. */
	hookTimeoutSec?: number;
	probeTimeoutMs?: number;
	graceMs?: number;
	termMs?: number;
	/** The SIGINT -> process-group escalation window of session/cancel (default 5 s, env-configurable). */
	cancelEscalateMs?: number;
	/** The heartbeat interval of a running turn (default 15 s, 0 disables; env-configurable). */
	heartbeatMs?: number;
}

export interface AgyAcpServerOptions {
	input: Readable;
	output: Writable;
	log?: (line: string) => void;
	agy?: AgyLaunchOptions;
	/** Called once when the connection closes (after the sessions are disposed). This is what lets
	 * main.ts turn "the client hung up" into a bounded exit instead of an idle process. */
	onClose?: (reason: string) => void;
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
			// The gate must check the binary the sessions will spawn: the same argv and the same env.
			cached = checkAgyVersion(argv, undefined, launch.env ?? process.env).catch((err: Error) => {
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

/** The launch options with the environment's defaults underneath them (an explicit option wins). */
function withEnvDefaults(launch: AgyLaunchOptions): AgyLaunchOptions {
	const env = lifecycleConfigFromEnv();
	const out: AgyLaunchOptions = { ...launch };
	out.command = launch.command ?? env.command;
	out.cancelEscalateMs = launch.cancelEscalateMs ?? env.cancelEscalateMs;
	out.heartbeatMs = launch.heartbeatMs ?? env.heartbeatMs;
	return out;
}

export function startAgyAcpServer(options: AgyAcpServerOptions): AgyAcpServer {
	const log = options.log ?? (() => {});
	const launch = withEnvDefaults(options.agy ?? {});
	const connection = new JsonRpcConnection({ input: options.input, output: options.output, log });
	const registry = new SessionRegistry(log);
	const checkVersion = makeVersionGate(launch);

	connection.registerMethod("initialize", handleInitialize);
	connection.registerMethod("session/new", (params) => handleSessionNew(params));
	connection.registerMethod("session/prompt", (params) => handleSessionPrompt(params));
	// Notification ordering (the reason this queues): the connection defers every request handler by
	// a microtask, so a notification handled inline would overtake the request in front of it - a
	// client that writes session/cancel straight after its session/prompt would cancel the turn before
	// that one started, i.e. the wrong one (or none). Queued the same way, frames are handled in the
	// order the client sent them.
	connection.onNotification((method, params) => {
		void Promise.resolve()
			.then(() => handleNotification(method, params))
			.catch((err: Error) => log(`notification "${method}" failed: ${err.message}`));
	});

	function handleNotification(method: string, params: unknown): void {
		if (method === "session/cancel") cancelSession(params);
		else log(`ignored notification: ${method}`);
	}
	connection.onClose((reason) => {
		log(`connection closed: ${reason}`);
		void registry.disposeAll().finally(() => options.onClose?.(reason));
	});

	/**
	 * session/cancel (issue #54). ACP sends it as a notification, so there is no response that
	 * could report a problem: an unknown or already-gone session is logged and dropped, and a
	 * failing cancel is logged too - a cancel nobody could act on must never take the server down.
	 */
	function cancelSession(params: unknown): void {
		const sessionId = typeof params === "object" && params !== null ? (params as Record<string, unknown>).sessionId : undefined;
		if (typeof sessionId !== "string") {
			log("session/cancel without a usable sessionId - ignored");
			return;
		}
		const session = registry.get(sessionId);
		if (!session) {
			log(`session/cancel for unknown sessionId ${sessionId} - ignored`);
			return;
		}
		try {
			session.cancel();
		} catch (err) {
			log(`session ${sessionId}: session/cancel failed: ${(err as Error).message}`);
		}
	}

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
			requestPermission: (params, timeoutMs) => connection.request("session/request_permission", { ...params, sessionId }, timeoutMs),
		});
		const sessionId = await session.start(); // a failure disposes the child and throws the RpcError
		registry.add(sessionId, session);
		// The permission modes are live (session/set_mode); the agy-level mode/model/effort
		// selection lands in sub-issue 6.
		const result: Record<string, unknown> = {
			sessionId,
			modes: { currentModeId: "default", availableModes: AGY_ACP_MODES },
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

	connection.registerMethod("session/set_mode", (params) => {
		if (typeof params !== "object" || params === null) throw new RpcError(INVALID_PARAMS, "session/set_mode params must be an object");
		const p = params as Record<string, unknown>;
		if (typeof p.sessionId !== "string") throw new RpcError(INVALID_PARAMS, "sessionId must be a string");
		if (typeof p.modeId !== "string") throw new RpcError(INVALID_PARAMS, "modeId must be a string");
		const session = registry.get(p.sessionId);
		if (!session) throw new RpcError(INVALID_PARAMS, `unknown sessionId: ${p.sessionId}`);
		session.setMode(p.modeId);
		return {};
	});

	return { disposeSessions: () => registry.disposeAll() };
}
