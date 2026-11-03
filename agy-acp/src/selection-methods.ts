// The session selection methods: `session/set_mode`, `session/set_model`, `session/set_config_option`.
//
// They live apart from the server assembly (server.ts) because they are one surface with one subject -
// the three things a client may change about a live session - and because ACP's shape for them is
// asymmetric in a way worth writing down in one place. Modes are first-class (`session/set_mode`,
// `current_mode_update`); model and effort are config selectors (`session/set_config_option`,
// `config_option_update`), and agy-acp additionally answers `session/set_model`, the name clients
// reach for first, wired to the same action as the `model` selector. A mode is deliberately NOT
// settable through the selector route: two ways to change one thing drift.
//
// Every setter answers with the whole selector set, and the session emits the same set as a
// `config_option_update`, so a client refreshes its controls from the answer and a second client of the
// same session learns of the change without polling.

import { INVALID_PARAMS, INTERNAL_ERROR, RpcError } from "./errors.ts";
import type { JsonRpcConnection } from "./jsonrpc.ts";
import { AGY_DEFAULT_CHOICE } from "./config-options.ts";
import type { AgyModel } from "./agy/models.ts";
import type { AgySession } from "./session.ts";
import type { SessionRegistry } from "./session-registry.ts";

/** The part every session-scoped method needs: the params object and a session that exists. */
export function sessionParams(
	method: string,
	params: unknown,
	registry: SessionRegistry,
): { session: AgySession; fields: Record<string, unknown> } {
	if (typeof params !== "object" || params === null) throw new RpcError(INVALID_PARAMS, `${method} params must be an object`);
	const p = params as Record<string, unknown>;
	if (typeof p.sessionId !== "string") throw new RpcError(INVALID_PARAMS, "sessionId must be a string");
	const session = registry.get(p.sessionId);
	if (!session) throw new RpcError(INVALID_PARAMS, `unknown sessionId: ${p.sessionId}`);
	return { session, fields: p };
}

/**
 * The starting selection, checked against the list before the first session exists: it is the operator's
 * (`AGY_ACP_MODEL` / `AGY_ACP_EFFORT` and their flags), and a typo there would otherwise reach every
 * session as a child that will not start, naming neither the knob nor the values that would have worked.
 * The effort and the model/effort pair are checked when the selection is built (config-options.ts);
 * the id needs the catalogue, so it is checked here, where the caller has just read it. A failed listing
 * (`null`) checks nothing, exactly as it does for a client's pick: agy is the authority on its own ids.
 */
export function assertStartSelection(model: string | undefined, listed: AgyModel[] | null): void {
	if (listed === null || model === undefined || model === AGY_DEFAULT_CHOICE) return;
	if (listed.some((m) => m.modelId === model)) return;
	const available = listed.map((m) => m.modelId).join(", ");
	throw new RpcError(
		INTERNAL_ERROR,
		`the model this server was launched with is not one agy offers: ${model} (AGY_ACP_MODEL or --model; available: ${available})`,
	);
}

export function registerSelectionMethods(connection: JsonRpcConnection, registry: SessionRegistry): void {
	/** session/set_mode: the permission mode, changed now (the agy flag follows on the next respawn). */
	connection.registerMethod("session/set_mode", (params) => {
		const { session, fields } = sessionParams("session/set_mode", params, registry);
		if (typeof fields.modeId !== "string") throw new RpcError(INVALID_PARAMS, "modeId must be a string");
		session.setMode(fields.modeId);
		return {};
	});

	/**
	 * session/set_model - agy-acp's own name for it, because ACP v1 has no model method: the canonical
	 * way is session/set_config_option with the `model` selector. Both are wired to one action, so a
	 * client that knows the flag and a client that only speaks selectors get the same session.
	 */
	connection.registerMethod("session/set_model", async (params) => {
		const { session, fields } = sessionParams("session/set_model", params, registry);
		if (typeof fields.modelId !== "string") throw new RpcError(INVALID_PARAMS, "modelId must be a string");
		await session.setModel(fields.modelId);
		return { configOptions: session.configOptions() };
	});

	/**
	 * session/set_config_option (ACP): `{configId, value}`. A change that a running child cannot honour
	 * is not an error - it marks the child stale and the next turn runs on a new one (session.ts).
	 */
	connection.registerMethod("session/set_config_option", async (params) => {
		const { session, fields } = sessionParams("session/set_config_option", params, registry);
		if (typeof fields.configId !== "string") throw new RpcError(INVALID_PARAMS, "configId must be a string");
		const value = fields.value;
		if (fields.configId === "model") {
			if (typeof value !== "string") throw new RpcError(INVALID_PARAMS, "the model option takes a string value");
			await session.setModel(value);
		} else if (fields.configId === "effort") {
			if (typeof value !== "string") throw new RpcError(INVALID_PARAMS, "the effort option takes a string value");
			session.setEffort(value);
		} else {
			// A mode is a selector too, but it has a first-class ACP surface of its own (session/set_mode),
			// and one source of truth beats two that can drift. Say so rather than pretending to accept it.
			throw new RpcError(
				INVALID_PARAMS,
				`unknown config option: ${fields.configId} (model and effort are settable here; a mode is set with session/set_mode)`,
			);
		}
		return { configOptions: session.configOptions() };
	});
}
