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
