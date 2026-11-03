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
import { assertStartSelection, registerSelectionMethods, sessionParams } from "./selection-methods.ts";
import { makeModelGate, makeVersionGate, withEnvDefaults, type AgyLaunchOptions } from "./launch.ts";
import { AgySession } from "./session.ts";
import { SessionRegistry } from "./session-registry.ts";

// The launch options are part of this module's public surface (main.ts and the suites import them from
// here); they live in launch.ts, next to the two per-process probes that run against the same argv.
export type { AgyLaunchOptions } from "./launch.ts";

// Keep in sync with agy-acp/package.json (test-package.ts asserts it).
export const AGY_ACP_VERSION = "0.1.0";
export const PROTOCOL_VERSION = 1;

export interface AgyAcpServerOptions {
	input: Readable;
	output: Writable;
	log?: (line: string) => void;
	agy?: AgyLaunchOptions;
	/**
	 * Called once when the connection closes, BEFORE anything is disposed: this is what lets main.ts
	 * turn "the client hung up" into a bounded exit, and the teardown has to happen inside that path
	 * for the exit deadline to bound it. The host is therefore expected to dispose the sessions (via
	 * `disposeSessions`) as part of whatever this starts; without a host handler the server disposes
	 * them itself on close, so no child outlives it either way.
	 */
	onClose?: (reason: string) => void;
}

export interface AgyAcpServer {
	/**
	 * Disposes every live session. The connection close leaves this to the host when there is an
	 * `onClose` handler (the exit path calls it inside the deadline); otherwise the close calls it.
	 */
	disposeSessions: () => Promise<void>;
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
	const launch = withEnvDefaults(options.agy ?? {});
	const connection = new JsonRpcConnection({ input: options.input, output: options.output, log });
	const registry = new SessionRegistry(log);
	const checkVersion = makeVersionGate(launch);
	const models = makeModelGate(launch, log);

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
		// The host is told first, and the teardown is then the host's to run: `onClose` starts the
		// exit path, which is what arms the deadline that bounds disposing the sessions. Disposing
		// here and reporting the close afterwards would put the whole teardown outside that deadline
		// - a session dispose that wedges would hang the process on the trigger the deadline exists
		// for. Without a host (the in-process tests) there is no exit path, so dispose here instead.
		if (!options.onClose) {
			void registry.disposeAll(); // no host to hand this to: nobody else will do it
			return;
		}
		try {
			options.onClose(reason);
		} catch (err) {
			// A host that cannot take the close must not leave children running. Its own exit path is
			// presumably what failed, so dispose here - outside the deadline, but not never.
			log(`connection-closed handler failed: ${(err as Error).message} - disposing the sessions here instead`);
			void registry.disposeAll();
		}
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
		// Before the session exists: its session/new result carries the list, and a client must not be
		// able to pick a model we never advertised. A failure is not fatal - it yields `null`.
		const modelList = await models.list();
		assertStartSelection(launch.model, modelList);
		const session = new AgySession({
			cwd,
			...launch,
			modelCatalog: models,
			log,
			notify: (sessionId, update) => connection.notify("session/update", { sessionId, update }),
			requestPermission: (params, timeoutMs) => connection.request("session/request_permission", { ...params, sessionId }, timeoutMs),
		});
		const sessionId = await session.start(); // a failure disposes the child and throws the RpcError
		registry.add(sessionId, session);
		// The selection, advertised: the modes the bridge enforces (session/set_mode) and the ACP
		// selectors for the model list and the effort levels (session/set_config_option). `models` is
		// the ids-only block agy-acp has published since sub-issue 3; the names are on the selector.
		const result: Record<string, unknown> = {
			sessionId,
			modes: session.modes(),
			models: session.modelsState(),
			configOptions: session.configOptions(),
		};
		// One object, several notes: whatever agy-acp could not do or does not support is reported here
		// rather than left for the client to discover (the model list, the mcpServers, the version).
		const meta: Record<string, unknown> = {};
		if (modelList === null) {
			meta.models = { listed: false, note: "`agy models` failed: the list is only what agy reports per session" };
		}
		if (mcpServers) {
			// The recorded agy 1.4.2 flag surface has no per-session MCP configuration flag, so the
			// servers are accepted, reported as unsupported and echoed back - never silently dropped.
			// (agy's built-in tool list carries call_mcp_tool, so it may manage MCP servers
			// out-of-band; whether per-session configuration exists needs investigating.)
			log(`session ${sessionId}: ${mcpServers.length} mcpServers requested - unsupported by agy, reported via _meta`);
			meta.mcpServers = { supported: false, requested: mcpServers };
		}
		if (status.warning) {
			meta.agyVersion = { version: status.version, tested: status.tested, warning: status.warning };
		}
		if (Object.keys(meta).length > 0) result._meta = meta;
		return result;
	}

	function handleSessionPrompt(params: unknown): unknown {
		const { session, fields } = sessionParams("session/prompt", params, registry);
		return session.prompt(fields.prompt);
	}

	// session/set_mode, session/set_model, session/set_config_option - one subject, one module.
	registerSelectionMethods(connection, registry);

	return { disposeSessions: () => registry.disposeAll() };
}
