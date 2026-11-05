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

/** What an RpcError carries beyond its code: the `data` the client sees, the `cause` the log keeps. */
export interface RpcErrorOptions extends ErrorOptions {
	/** The JSON-RPC `error.data` member - sent to the peer, so it must be serializable. */
	data?: unknown;
}

/**
 * A JSON-RPC error a method handler can throw to choose the response code.
 *
 * `cause` sits in the second argument, where ErrorOptions belongs: the message is what the client
 * reads, the cause is what the log keeps, and a rethrow without it is where a stack trace stops. It
 * is deliberately not a third positional - biome's `useErrorCause`, and every reader who knows
 * `new Error(msg, { cause })`, can only see it here.
 */
export class RpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	constructor(code: number, message: string, options?: RpcErrorOptions) {
		super(message, options);
		this.name = "RpcError";
		this.code = code;
		this.data = options?.data;
	}
}
