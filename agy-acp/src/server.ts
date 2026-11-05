// The agy-acp server assembly: the JSON-RPC transport, the initialize handshake, the session
// methods (session/new, session/prompt) and the session registry.
//
// main.ts is a thin wrapper over startAgyAcpServer(); the tests run the same assembly in-process
// (PassThrough stdio) with the agy launch pointed at the fixture-replaying fake.

import type { Readable, Writable } from "node:stream";
import { INVALID_PARAMS, RpcError } from "./errors.ts";
import { JsonRpcConnection } from "./jsonrpc.ts";
import { registerSelectionMethods, sessionParams } from "./selection-methods.ts";
import { makeModelGate, makeVersionGate, withEnvDefaults, type AgyLaunchOptions } from "./launch.ts";
import { createSessionOpener } from "./session-open.ts";
import { createSessionRestore } from "./session-restore.ts";
import { resolveStoreRoot } from "./session-store/paths.ts";
import { SessionStore } from "./session-store/store.ts";
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
	/**
	 * The session store (issue #56). By default it is resolved from the environment (`AGY_ACP_STATE_DIR`,
	 * `$XDG_STATE_HOME`, `$HOME/.local/state`) and built here, because the store belongs to the agent,
	 * not to a connection. A host that wants a directory of its own - a test, or a wrapper that keeps the
	 * state beside a profile - passes one.
	 */
	store?: SessionStore;
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
			// Session persistence (issue #56): the history is agy-acp's own, so all three lifecycle
			// methods are answered from it. `session/close` is deliberately absent - the registry already
			// disposes a session when its connection dies, and advertising close would promise a way to
			// end a session that leaves the conversation running in agy.
			loadSession: true,
			sessionCapabilities: { list: {}, resume: {} },
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
	const store =
		options.store ??
		(() => {
			const root = resolveStoreRoot();
			// Where the sessions live is the first thing an operator looks for when one will not load, and
			// the answer is not always the directory they expected.
			log(`session store: ${root.root} (${root.source})`);
			return new SessionStore({ log, root });
		})();

	// session/new, and the one place a session is built (the store record, the launch, the registry).
	const opener = createSessionOpener({ log, launch, models, store, registry, connection, checkVersion });

	connection.registerMethod("initialize", handleInitialize);
	connection.registerMethod("session/new", (params) => opener.handleNew(params));
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

	function handleSessionPrompt(params: unknown): unknown {
		const { session, fields } = sessionParams("session/prompt", params, registry);
		return session.prompt(fields.prompt);
	}

	// session/load, session/resume, session/list (issue #56). Everything about them - the store's rules,
	// the workspace check, the replay - is in session-restore.ts; this is the connection's half of it.
	const restore = createSessionRestore({
		store,
		registryAdd: (sessionId, session) => registry.add(sessionId, session),
		// `notify` answers with whether the frame went out, and that answer is the reason this is a `send`
		// rather than a call: a replay has to know when the connection stopped taking frames, or it would
		// push a whole transcript into a transport that had already gone and report a replay that never
		// happened.
		send: (sessionId, update) => connection.notify("session/update", { sessionId, update }),
		log,
		// The record's cwd, not the client's: they name the same workspace (the store checked), but only one
		// of them is the path the conversation started in, and that is the one agy should be launched in.
		build: (record) => opener.build(record.cwd, record),
	});
	connection.registerMethod("session/load", (params) => restore.load(params));
	connection.registerMethod("session/resume", (params) => restore.resume(params));
	connection.registerMethod("session/list", (params) => restore.list(params));

	// session/set_mode, session/set_model, session/set_config_option - one subject, one module.
	registerSelectionMethods(connection, registry);

	return { disposeSessions: () => registry.disposeAll() };
}
