// `session/new`, and the one place a session object is built (issue #56).
//
// Starting a session is a sequence with four owners, and the order is the whole design: the workspace
// has to exist before agy is launched in it; agy has to report its `conversation_id` before anything can
// be written down about the conversation; the store has to accept the record before the client is told
// the id (a session that cannot be resumed later is not a session this host should hand out - clients
// restart the server on close, so a restart is the normal life of this process); and only then does the
// session belong to the connection. Each step disposes what it created if a later step fails, so no path
// out of here leaves a child running, a registered session without a writer, or a store lock that no
// client owns.
//
// `build` is exported alongside because `session/load` needs the exact same wiring - the operator's
// launch config, this connection's notify and permission callbacks - with one difference: a restored
// session runs in the workspace its record names, not the one the client asked for, and carries the
// stored selection into its first launch (see session-restore.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgyModel, ModelCatalog } from "./agy/models.ts";
import type { AgyVersionStatus } from "./agy-driver.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, RpcError } from "./errors.ts";
import type { AgyLaunchOptions } from "./launch.ts";
import { assertStartSelection } from "./selection-methods.ts";
import { advertisedState } from "./session-restore.ts";
import { AgySession } from "./session.ts";
import type { SelectionRecord } from "./selection-record.ts";
import type { SessionStore } from "./session-store/store.ts";

export interface SessionOpenerConnection {
	/** One notification; false once the transport is gone. */
	notify(method: string, params: unknown): boolean;
	/** One request to the client. */
	request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
}

export interface SessionOpenerDeps {
	log: (line: string) => void;
	/** The operator's launch configuration, argv and selection included. */
	launch: AgyLaunchOptions;
	/** The model list gate. Its list may have failed; that is reported, never invented. */
	models: ModelCatalog;
	store: SessionStore;
	registry: { add(sessionId: string, session: AgySession): boolean };
	connection: SessionOpenerConnection;
	checkVersion: () => Promise<AgyVersionStatus>;
}

export interface SessionOpener {
	/** A session wired to this connection: new conversation without a record, restored conversation with one. */
	build(cwd: string, restored?: SelectionRecord): AgySession;
	/** `session/new`: validate, launch, record, register, and answer. */
	handleNew(params: unknown): Promise<Record<string, unknown>>;
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

/** `cwd` must exist and be a directory - ACP's own requirement for a session's workspace. */
async function requireWorkspace(cwd: string): Promise<void> {
	let isDirectory = false;
	try {
		isDirectory = (await fs.promises.stat(cwd)).isDirectory();
	} catch {
		throw new RpcError(INVALID_PARAMS, `cwd does not exist: ${cwd}`);
	}
	if (!isDirectory) throw new RpcError(INVALID_PARAMS, `cwd is not a directory: ${cwd}`);
}

/**
 * One object, several notes: whatever agy-acp could not do or does not support is reported here rather
 * than left for the client to discover (the model list, the mcpServers, the version).
 */
function sessionNewNotes(notes: {
	sessionId: string;
	modelList: AgyModel[] | null;
	modelFailure: () => string | null;
	mcpServers: unknown[] | undefined;
	status: AgyVersionStatus;
	log: (line: string) => void;
}): Record<string, unknown> {
	const { sessionId, modelList, modelFailure, mcpServers, status, log } = notes;
	const meta: Record<string, unknown> = {};
	if (modelList === null) {
		// The reason travels with the fact: a client that is told "no model list" and gets agy's own
		// "sign in" in the same field knows what to do, and one that gets the timeout knows the listing
		// was never going to answer. The full text is in the server log either way.
		const reason = modelFailure() ?? "`agy models` gave no reason";
		meta.models = { listed: false, reason, note: `the model list is only what agy reports per session (${reason})` };
	}
	if (mcpServers) {
		// The recorded agy 1.4.2 flag surface has no per-session MCP configuration flag, so the servers
		// are accepted, reported as unsupported and echoed back - never silently dropped. (agy's built-in
		// tool list carries call_mcp_tool, so it may manage MCP servers out-of-band; whether per-session
		// configuration exists needs investigating.)
		log(`session ${sessionId}: ${mcpServers.length} mcpServers requested - unsupported by agy, reported via _meta`);
		meta.mcpServers = { supported: false, requested: mcpServers };
	}
	if (status.warning) meta.agyVersion = { version: status.version, tested: status.tested, warning: status.warning };
	return meta;
}

export function createSessionOpener(deps: SessionOpenerDeps): SessionOpener {
	const { log, launch, store } = deps;

	function build(cwd: string, restored?: SelectionRecord): AgySession {
		return new AgySession({
			cwd,
			...launch,
			...(restored ? { restored } : {}),
			modelCatalog: deps.models,
			log,
			notify: (sessionId, update) => deps.connection.notify("session/update", { sessionId, update }),
			requestPermission: (sessionId, params, timeoutMs) =>
				deps.connection.request("session/request_permission", { ...params, sessionId }, timeoutMs),
		});
	}

	/**
	 * Start a session and give it its place in the store, in that order, and only then hand it to the
	 * registry. The record is written *before* the answer (issue #56): a store that cannot take it is a
	 * refusal rather than a session that will not survive a restart.
	 */
	async function open(cwd: string): Promise<AgySession> {
		const session = build(cwd);
		const sessionId = await session.start(); // a failure disposes the child and throws the RpcError
		const stored = await store.create({ sessionId, cwd, ...session.selection() });
		if (!stored.ok) {
			await session.dispose();
			throw new RpcError(INTERNAL_ERROR, `session ${sessionId} cannot be resumed later: ${stored.reason}`, {
				reason: "store_unavailable",
				store: store.root,
			});
		}
		session.attachRecorder(stored.opened.journal, () => store.release(sessionId));
		if (!deps.registry.add(sessionId, session)) {
			// The connection died while the session was starting. The registry disposes what arrives late
			// (issue #53), and disposing is what hands the store lock back, so the child and the lock are
			// both gone - and the answer, which is also what the transport will do with this result. Failing
			// here instead would change a documented behaviour for a case the client cannot observe.
			log(`session ${sessionId}: started after the connection closed - disposed with it, store record kept`);
		}
		return session;
	}

	async function handleNew(params: unknown): Promise<Record<string, unknown>> {
		const { cwd, mcpServers } = parseSessionNew(params);
		await requireWorkspace(cwd);
		const status = await deps.checkVersion();
		if (status.strictRefusal) {
			throw new RpcError(INTERNAL_ERROR, status.warning ?? "the agy version is refused by AGY_ACP_STRICT_VERSION", {
				agyVersion: status.version,
			});
		}
		if (status.warning) log(`agy version warning: ${status.warning}`);
		// Before the session exists: its session/new result carries the list, and a client must not be able
		// to pick a model we never advertised. A failure is not fatal - it yields `null`.
		const modelList = await deps.models.list();
		assertStartSelection(launch.model, modelList);
		const session = await open(cwd);
		// The selection, advertised: the modes the bridge enforces (session/set_mode) and the ACP selectors
		// for the model list and the effort levels (session/set_config_option). `models` is the ids-only
		// block agy-acp has published since sub-issue 3; the names are on the selector.
		const result: Record<string, unknown> = { sessionId: session.id, ...advertisedState(session) };
		const meta = sessionNewNotes({
			sessionId: session.id,
			modelList,
			modelFailure: () => deps.models.failure(),
			mcpServers,
			status,
			log,
		});
		if (Object.keys(meta).length > 0) result._meta = meta;
		return result;
	}

	return { build, handleNew };
}
