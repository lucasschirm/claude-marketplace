/**
 * Reading what a command printed: parsing its JSON, lifting the reason out of an error body, and the
 * shapes a payload is allowed to have (the checker behind `runJson`'s `schema` option).
 *
 * This sits next to `lib/exec.ts` rather than inside it because the door guards every subprocess in the
 * repo and has to stay small enough to audit in one sitting. Neither file takes a package import, for
 * the reason given below - which is what lets `exec.ts` be vendored into a plugin unchanged.
 *
 * Deliberately a small declarative type of our own rather than `typebox`. The door gets vendored into
 * `plugins/pr-observer/lib/` (see `scripts/sync-plugin-libs.mjs`), and a plugin is copied into a host's
 * own cache where nothing outside the plugin directory resolves - `typebox` is a dependency of Pi, not
 * of an installed plugin. An import of it here would reproduce exactly how #46's pr-observer died on
 * import before answering the handshake, so the vendored import graph stays node-builtins-only.
 *
 * Being a TypeScript union also means a misspelt keyword (`minLenght`) fails `npm run typecheck` rather
 * than becoming a schema that accepts everything - which is the failure mode that matters more here than
 * expressiveness. Unknown keys in a *payload* are accepted on purpose: APIs add fields on a release
 * schedule, and an exact-keys schema would turn a routine CLI upgrade into an outage of false alarms.
 */

/** A failure's `message` is written for a human to read once; past this it is a dump. */
const MESSAGE_CHARS = 4096;

export type SchemaType = "string" | "number" | "boolean" | "null" | "array" | "object";

export type Schema =
	| { type: "string"; enum?: readonly string[] }
	| { type: "number" }
	| { type: "boolean" }
	| { type: "null" }
	| { type: "array"; items: Schema }
	| { type: "object"; required?: readonly string[]; properties?: Record<string, Schema> }
	| { anyOf: readonly Schema[] };

type ScalarSchema = Extract<Schema, { type: "string" | "number" | "boolean" | "null" }>;
type ObjectSchema = Extract<Schema, { type: "object" }>;
type BranchSchema = Exclude<Schema, { anyOf: readonly unknown[] }>;

const DECLARED_KEYS: Record<SchemaType, readonly string[]> = {
	string: ["type", "enum"],
	number: ["type"],
	boolean: ["type"],
	null: ["type"],
	array: ["type", "items"],
	object: ["type", "required", "properties"],
};

/**
 * Every way in which `value` fails `schema`, as `"/workers/0/id: must be a string"`.
 *
 * An empty array is the whole contract: `runJson` turns a non-empty list into `BAD_SCHEMA` naming these
 * paths, which is how a CLI renaming a field becomes a report instead of a silent empty list.
 */
export function schemaErrors(schema: Schema, value: unknown, at = ""): string[] {
	if ("anyOf" in schema) {
		if (schema.anyOf.some((branch) => schemaErrors(branch, value, at).length === 0)) return [];
		return [`${shown(at)}: matches none of the ${String(schema.anyOf.length)} accepted shapes`];
	}
	assertSupportedKeywords(schema, at);
	// `{ type: "null" }` is how a schema says null is allowed. Every other type rejects it, because a CLI
	// answering `null` where a list was expected is precisely the bug a schema is written to catch.
	if (value === null && schema.type !== "null") return [`${shown(at)}: must be ${describeType(schema.type)}, got null`];
	if (schema.type === "array") return arrayIssues(schema.items, value, at);
	if (schema.type === "object") return objectIssues(schema, value, at);
	return scalarIssues(schema, value, at);
}

function scalarIssues(schema: ScalarSchema, value: unknown, at: string): string[] {
	if (schema.type === "null") return value === null ? [] : [typeFail(at, "null", value)];
	if (typeof value !== schema.type) return [typeFail(at, schema.type, value)];
	if ("enum" in schema && schema.enum && !schema.enum.includes(value as string)) {
		return [`${shown(at)}: "${value}" is not one of ${schema.enum.join("|")}`];
	}
	return [];
}

function arrayIssues(items: Schema, value: unknown, at: string): string[] {
	if (!Array.isArray(value)) return [typeFail(at, "array", value)];
	return value.flatMap((item, index) => schemaErrors(items, item, `${at}/${String(index)}`));
}

function objectIssues(schema: ObjectSchema, value: unknown, at: string): string[] {
	if (typeof value !== "object" || Array.isArray(value)) return [typeFail(at, "object", value)];
	const record = value as Record<string, unknown>;
	const missing = (schema.required ?? [])
		.filter((key) => record[key] === undefined)
		.map((key) => `${shown(at)}: missing required "${key}"`);
	// A property the payload omits entirely is only a violation if `required` names it; absent and unknown
	// keys are both left alone, so a CLI adding a field cannot break a caller.
	const nested = Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
		record[key] === undefined ? [] : schemaErrors(child, record[key], `${at}/${key}`),
	);
	return [...missing, ...nested];
}

/**
 * Runtime insurance for a schema assembled at runtime: a keyword nobody implements must not read as a
 * passing check. For the literal schemas this repo writes, the union above rejects it at compile time.
 */
function assertSupportedKeywords(schema: BranchSchema, at: string): void {
	for (const key of Object.keys(schema)) {
		if (!DECLARED_KEYS[schema.type]?.includes(key)) {
			throw new Error(`unsupported schema keyword "${key}" in ${shown(at)}`);
		}
	}
}

function typeFail(at: string, type: SchemaType, value: unknown): string {
	return `${shown(at)}: must be ${describeType(type)}, got ${kindOf(value)}`;
}

function shown(at: string): string {
	return at || "/";
}

function kindOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}

/** "must be a string", "must be an array", "must be null" - phrased once instead of per branch. */
function describeType(type: SchemaType): string {
	if (type === "array") return "an array";
	if (type === "null") return "null";
	if (type === "object") return "an object";
	return `a ${type}`;
}

/**
 * Parse text that arrived from outside, or `undefined`.
 *
 * Parsing a command's output belongs behind the door (`jsonParseLocation`), including when the text
 * reaches a caller on someone else's error object: `describeGhError` reads `err.stdout` and would
 * otherwise keep a `JSON.parse` of command output in a file that has no business knowing the format.
 */
export function parseJsonSafe(text: string | undefined | null): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** The `errors[]` text of a CLI that answers with a JSON envelope, if its body has any. */
export function jsonErrorMessages(stdout: unknown): string | undefined {
	const body = parseJsonSafe(typeof stdout === "string" ? stdout : undefined) as { errors?: unknown } | undefined;
	const errors = body?.errors;
	if (!Array.isArray(errors) || errors.length === 0) return undefined;
	const messages = errors
		.map((entry) => {
			const e = entry as { message?: unknown; type?: unknown };
			if (typeof e?.message === "string" && e.message) return e.message;
			if (typeof e?.type === "string" && e.type) return e.type;
			return "unknown error";
		})
		.join("; ");
	return messages || undefined;
}

export function capMessage(text: string): string {
	return text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}…` : text;
}
