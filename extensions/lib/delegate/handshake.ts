// The two handshakes a session's transport makes before its first turn.
//
//   `session/new`  mints a conversation in the process that is about to run the prompt.
//   `resumeHandshake`  brings a **recorded** conversation back into a process that never saw it.
//
// They live together because the answer is the same shape and the reader must be the same code: an
// adapter restores a session with what `session/new` answered (modes, models, configOptions) precisely
// so a client that had controls gets them back, and a second, slightly different parser is how a
// session ends up configured against a vocabulary it built wrong. `seedOptions` is the one writer of
// that catalogue for both paths, and it runs after `attach()` installs the map.
//
// The resume path exists because `capabilities().resume` is a promise the engine has to implement, not
// just declare: pi loses a *process* across a restart or a crash between turns, and the agent keeps the
// conversation. The two agents that claim it differ, which is why the hook is optional:
//
//   * Devin keeps its sessions server-side, so a fresh `devin acp` answers the recorded id on the next
//     `session/prompt`; asking it for a handshake would be a `method not found` on every follow-up.
//   * `agy-acp` keeps its own on-disk store (#56), refuses an id its registry did not create, and is
//     brought back by `session/resume` — that honest refusal is why the driver said `resume: false`.
//
// `session/resume` and not `session/load`: the two differ only in whether the stored transcript is
// replayed as `session/update` frames, and our event log is the file `delegate_status` reads — so a load
// would append a second copy of every message on every follow-up. `resume` registers and sends nothing.

import { absolutePathOr, isStorageSafeId } from "./storage.ts";
import type { DelegateRuntime } from "./runtime.ts";
import type { DelegateTransport } from "./transport.ts";
import { THINKING_LEVELS, type AgentDriver, type ThinkingLevel } from "./types.ts";

/** How long either handshake may take before the start is considered failed. */
const SETUP_TIMEOUT_MS = 60_000;

/**
 * An agent's answer to either handshake. Its shape is the agent's business, so every read here is
 * defensive and one named type carries that, rather than `any` annotating each parameter in turn.
 */
type WireAnswer = { [key: string]: any };

/** The value list of one select-style config option, in whatever shape this agent sent it. */
function optionValues(option: WireAnswer): string[] {
	const raw = option?.options ?? option?.values ?? [];
	const list = Array.isArray(raw) ? raw : [];
	return list
		.map((o) => (typeof o === "string" ? o : (o?.value ?? o?.id)))
		.filter((v: unknown): v is string => typeof v === "string" && v.length > 0);
}

/**
 * What an agent advertises about a session, from either handshake's answer: every select-style config
 * option with its value list (`mode`, `model`, `effort`, …) under its option id, plus the pre-config-option
 * `modes`/`models` shape.
 *
 * This is the only place that vocabulary is available. The adapter answers `session/new` and
 * `session/resume` with it and sends a `config_option_update` **only when something changes**, so a
 * reader that waited for the notification had a permanently empty picture of a session it was about to
 * configure — every "this model offers no such effort" pre-check was dead code, and every refusal
 * message that wanted to list the valid values had none to list.
 */
export function advertisedOptions(input: WireAnswer | null | undefined): Record<string, string[]> {
	// An agent may answer `null`, and this reads the answer of a program we do not own.
	const res: WireAnswer = input ?? {};
	const options: Record<string, string[]> = {};
	const advertised: WireAnswer[] = Array.isArray(res.configOptions) ? res.configOptions : [];
	for (const opt of advertised) {
		const id = typeof opt?.id === "string" ? opt.id : "";
		if (id) {
			options[id] = optionValues(opt);
		}
	}
	const modes: WireAnswer[] = Array.isArray(res.modes?.availableModes) ? res.modes.availableModes : [];
	if (modes.length && !options.mode) {
		options.mode = modes.map((m) => m?.id).filter((v: unknown): v is string => typeof v === "string");
	}
	const models: WireAnswer[] = Array.isArray(res.models?.availableModels) ? res.models.availableModels : [];
	if (models.length && !options.model) {
		options.model = models.map((m) => m?.id).filter((v: unknown): v is string => typeof v === "string");
	}
	return options;
}

/** Put a handshake's vocabulary into the per-session catalogue `configureSession` and the driver read. */
export function seedOptions(rt: DelegateRuntime, sessionId: string, options: Record<string, string[]>): void {
	const catalogue = rt.configOptions.get(sessionId);
	if (!catalogue) {
		return;
	}
	for (const [id, values] of Object.entries(options)) {
		catalogue.set(id, values);
	}
}

export interface NewSession {
	sessionId: string;
	options: Record<string, string[]>;
}

/** Create the conversation, and refuse an id that could not be one of our storage path segments. */
export async function createSession(client: DelegateTransport, label: string, cwd: string): Promise<NewSession> {
	const res = (await client.request("session/new", { cwd, mcpServers: [] }, SETUP_TIMEOUT_MS)) as WireAnswer | undefined;
	const sessionId = res?.sessionId;
	if (typeof sessionId !== "string" || !sessionId) {
		throw new Error(`${label} answered session/new without a sessionId`);
	}
	// The id is the agent's, the directory is ours. It builds paths we write to and names records that
	// later code deletes, so an id like `../../elsewhere` is not a curiosity — it is the extension
	// writing outside the tree it owns. Refusing here costs one session; accepting it costs the boundary.
	if (!isStorageSafeId(sessionId)) {
		throw new Error(
			`${label} returned the session id ${JSON.stringify(sessionId)}, which cannot be a storage path segment; refusing to register it`,
		);
	}
	return { sessionId, options: advertisedOptions(res) };
}

/**
 * The controls the answer says the session has now: the two `current*Id` fields, falling back to the
 * `configOptions` values a spec-shaped adapter answers with. `effort` has no top-level field to prefer.
 */
function currentSelection(res: WireAnswer | undefined): { mode?: string; model?: string; effort?: string } {
	const values: Record<string, string> = {};
	for (const opt of Array.isArray(res?.configOptions) ? res.configOptions : []) {
		const id = typeof opt?.id === "string" ? opt.id : "";
		const value = typeof opt?.currentValue === "string" ? opt.currentValue : "";
		if (id && value) {
			values[id] = value;
		}
	}
	const mode = res?.modes?.currentModeId;
	const model = res?.models?.currentModelId;
	return {
		mode: typeof mode === "string" && mode ? mode : values.mode,
		model: typeof model === "string" && model ? model : values.model,
		effort: values.effort ?? values.thinking,
	};
}

/** The answer's effort, in the only two shapes the engine records: a level we offer, or its own default. */
function effortAsLevel(value: string | undefined): ThinkingLevel | "default" | undefined {
	if (!value) {
		return undefined;
	}
	if ((THINKING_LEVELS as readonly string[]).includes(value)) {
		return value as ThinkingLevel;
	}
	// `agy-acp`'s "the model picks" sentinel (`AGY_DEFAULT_CHOICE`). Anything else is an effort this build
	// has no word for, and guessing would put a value in the record that a status line then invents.
	return value === "default" ? "default" : undefined;
}

/** What the store said it could not hand back unchanged. A note is a sentence, so a blank one is nothing. */
function restoredNotes(restored: WireAnswer): string[] {
	return Array.isArray(restored.notes) ? restored.notes.filter((n: unknown): n is string => typeof n === "string" && n.trim() !== "") : [];
}

/** What came back from a restore, in the shape the engine records. */
export interface RestoredSession {
	/** The vocabulary the restored session advertises — the same reader as `session/new`'s, on purpose. */
	options: Record<string, string[]>;
	/** What the agent corrected on the way in (a stored mode or model this process cannot honour). */
	notes: string[];
	/**
	 * The mode the conversation came back in, when the answer names one. A corrected mode is said only here:
	 * a restore emits no `current_mode_update`, so this is how the engine learns it is not in the mode its
	 * caller asked for.
	 */
	currentModeId?: string;
	/** The model and effort it came back with, same reason as `currentModeId`. */
	currentModelId?: string;
	/**
	 * The effort it came back with: one of our levels, or `"default"` when the adapter settled on whatever
	 * the model picks. That sentinel is not a `ThinkingLevel`, and the engine records it as "no preference"
	 * rather than as the level that was refused.
	 */
	currentEffort?: ThinkingLevel | "default";
	/** The workspace the store's own record names, absolute or absent — the engine back-fills it once. */
	cwd?: string;
	/** The stored transcript it could not hand back whole (`load` only, but the field is the agent's). */
	droppedUpdates?: number;
	truncated?: boolean;
}

/**
 * Bring a recorded conversation back into this process, on the driver's own terms.
 *
 * The caller has already spawned the agent and opened its log file; nothing is prompted yet. A failure is
 * the caller's to report (`followUp` answers `REATTACH_FAILED`), in the adapter's own words: of the five
 * kinds its store answers with, three have a different fix each — no such conversation, a conversation
 * belonging to another workspace (whose record names the folder), a conversation another process holds.
 */
export async function restoreSession(
	client: DelegateTransport,
	driver: AgentDriver,
	sessionId: string,
	cwd: string,
): Promise<RestoredSession> {
	const handshake = driver.resumeHandshake?.(sessionId, cwd);
	if (!handshake) {
		// `capabilities().resume` is what gates this call, so reaching here means the two disagree.
		throw new Error(`${driver.title} declares it can continue a session but offers no handshake to do it`);
	}
	const res = (await client.request(handshake.method, handshake.params, SETUP_TIMEOUT_MS)) as WireAnswer | undefined;
	const answered = res?.sessionId;
	if (typeof answered !== "string" || !answered) {
		// An answer that does not name a conversation has not confirmed it adopted one, and the prompt that
		// follows would go out under an id this process only hopes the agent recognizes.
		throw new Error(`${driver.title} answered ${handshake.method} without a session id; refusing to prompt`);
	}
	if (answered !== sessionId) {
		// The engine prompts the id it recorded. Continuing something else would send a follow-up into a
		// different conversation — the caller's words in someone else's context — so this is a refusal.
		throw new Error(
			`${driver.title} answered ${handshake.method} for ${JSON.stringify(sessionId)} with a different session id (${JSON.stringify(answered)}); refusing to prompt it`,
		);
	}
	const meta: WireAnswer = res?._meta ?? {};
	const restored: WireAnswer = meta.restored ?? {};
	// What the session came back *configured as*, which is not always what was asked: the adapter corrects a
	// stored mode, model or effort it cannot honour, and a restore emits no `current_mode_update` and no
	// `set_*` frame, so this answer is the only place the correction is written down.
	const current = currentSelection(res);
	const dropped = typeof restored.droppedUpdates === "number" ? restored.droppedUpdates : undefined;
	return {
		options: advertisedOptions(res),
		notes: restoredNotes(restored),
		cwd: absolutePathOr(restored.cwd),
		currentModeId: current.mode,
		currentModelId: current.model,
		currentEffort: effortAsLevel(current.effort),
		...(dropped !== undefined && dropped > 0 ? { droppedUpdates: dropped } : {}),
		...(restored.truncated === true ? { truncated: true } : {}),
	};
}
