// The session/prompt flattening: agy's headless mode accepts text only, so an ACP prompt is
// flattened to one text string. Text, resource-link and embedded-text blocks are supported;
// image, audio and blob resources are explicitly rejected with -32602 (silently dropping them
// would be a lie).

import { INVALID_PARAMS, RpcError } from "./errors.ts";

/** The text one prompt block contributes; every supported block contributes text, everything else is -32602. */
function blockText(b: Record<string, unknown>, i: number): string {
	switch (b.type) {
		case "text":
			if (typeof b.text !== "string") throw new RpcError(INVALID_PARAMS, `prompt block ${i}: a text block needs a text string`);
			return b.text;
		case "resource_link": {
			if (typeof b.uri !== "string") throw new RpcError(INVALID_PARAMS, `prompt block ${i}: a resource_link block needs a uri string`);
			// The name (or title) is the human-meaningful part of the block; it is flattened with the uri.
			const label =
				(typeof b.name === "string" && b.name !== "" ? b.name : null) ?? (typeof b.title === "string" && b.title !== "" ? b.title : null);
			return label !== null ? `${label}\n${b.uri}` : b.uri;
		}
		case "resource": {
			const resource = b.resource;
			if (typeof resource !== "object" || resource === null)
				throw new RpcError(INVALID_PARAMS, `prompt block ${i}: a resource block needs a resource object`);
			const text = (resource as Record<string, unknown>).text;
			// Only embedded text is flammable; a blob resource cannot be flattened, not even away.
			if (typeof text !== "string")
				throw new RpcError(INVALID_PARAMS, `prompt block ${i}: a resource block carries no embedded text (blobs are not supported)`);
			return text;
		}
		case "image":
			throw new RpcError(INVALID_PARAMS, `prompt block ${i}: image blocks are not supported - agy headless accepts text only`);
		case "audio":
			throw new RpcError(INVALID_PARAMS, `prompt block ${i}: audio blocks are not supported - agy headless accepts text only`);
		default:
			throw new RpcError(INVALID_PARAMS, `prompt block ${i}: unsupported content block type ${JSON.stringify(b.type)}`);
	}
}

/** The session/prompt flattening: text, resource-link and embedded-text blocks into one text. */
export function flattenPrompt(blocks: unknown): string {
	if (!Array.isArray(blocks)) throw new RpcError(INVALID_PARAMS, "prompt must be an array of content blocks");
	if (blocks.length === 0) throw new RpcError(INVALID_PARAMS, "prompt must not be empty");
	const parts: string[] = [];
	for (const [i, block] of blocks.entries()) {
		if (typeof block !== "object" || block === null) throw new RpcError(INVALID_PARAMS, `prompt block ${i} must be an object`);
		parts.push(blockText(block as Record<string, unknown>, i));
	}
	const flattened = parts.join("\n");
	if (flattened.trim() === "") throw new RpcError(INVALID_PARAMS, "prompt flattens to no text");
	return flattened;
}
