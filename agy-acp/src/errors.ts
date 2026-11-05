// JSON-RPC 2.0 error vocabulary for agy-acp, shared by the transport and its method handlers.
//
// Handlers throw RpcError to choose the response code; the transport maps anything else to
// INTERNAL_ERROR. Splitting this from jsonrpc.ts keeps the handler-facing surface importable
// without dragging in the stream machinery.

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * ACP's "resource not found" (the code the spec gives a session id this agent does not know), used by
 * `session/load` and `session/resume`, where the client handed us an id we cannot find.
 *
 * It is the same number as `TURN_IN_PROGRESS` in acp.ts, which is a fact worth stating rather than
 * glossing: that code was picked in sub-issue 2, before this one fixed -32002 as ACP's own "unknown
 * session". Both are inside the JSON-RPC server range, both messages name which of the two happened,
 * and a not-found carries `data.reason = "session_not_found"` for a client that maps codes rather
 * than reading prose. Moving either one is a protocol change for clients already built against the
 * documented behaviour, so neither moved here; the collision is recorded in the README and in
 * lucasschirm/claude-marketplace#56.
 */
export const RESOURCE_NOT_FOUND = -32002;

/** A JSON-RPC error a method handler can throw to choose the response code. */
export class RpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.data = data;
	}
}
