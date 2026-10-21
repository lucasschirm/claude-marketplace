/**
 * compaction-fail-recovery.ts
 *
 * Recovers from failed compaction — specifically the error:
 *
 *   Context overflow recovery failed: Summarization failed: generation hit the token cap
 *   and the summary is incomplete
 *
 * When compaction fails, this extension compresses the tool call responses that are still
 * in context so that the retried prompt (or the next compaction) fits. Compression keeps
 * the tool call itself and replaces only the response content with a pointer to the
 * original, which stays unchanged in the session JSONL:
 *
 *   [ctx-memory-compressed] This tool call response was compressed. To have access to
 *   the original content use the tool ctx_memory passing the id <entryId>.
 *
 * - Candidates are the tool result messages currently projected into model context.
 *   They are compressed largest first (oldest first on ties). A failed compaction is
 *   itself proof the context is too large - pi's chars/4 estimate can be far below
 *   the provider's real token count, so recovery compresses every candidate instead
 *   of gating on the estimate.
 * - The last N tool call responses (default 5, configurable) are never compressed.
 *
 * Recovery flow (for every recoverable compaction failure):
 * 1. Compress the largest old tool call responses (append-only context edits).
 * 2. Re-run pi's compaction (`ctx.compact()`), DEFERRED to a macrotask: a failed
 *    re-run emits session_compact_failed from inside compact()'s catch block, and a
 *    synchronous nested compact() gets its abort controller cleared by the outer
 *    compact()'s finally (its failure path then crashes and the TUI sticks on a
 *    compaction that never finishes). It decides what stays verbatim and summarizes
 *    the rest, with custom instructions appended (see configuration). If the
 *    summarization hits the token cap again, the next failure event compresses what
 *    remains and re-runs - bounded by `maxRecoveryRounds` (default 2), after which
 *    recovery stops and suggests raising compaction.reserveTokens or a bigger-context
 *    model.
 * 3. Overflow recovery: the failed run is aborted by the compaction; when the
 *    compaction succeeds, the prompt that overflowed is resent automatically - only
 *    while the session is still idle, so it never aborts a run the user already
 *    started or duplicates a prompt the user already retried.
 *
 * The `ctx_memory` tool retrieves the original content of a compressed response by its
 * session entry id. It reads the session JSONL through the session manager: context
 * edits are append-only overrides, so the raw entry — and therefore the original
 * content — is never modified.
 *
 * Configuration — pi settings file (global ~/.pi/agent/settings.json or project
 * .pi/settings.json):
 *
 *   {
 *     "compactionRecovery": {
 *       "enabled": true,
 *       "keepRecentToolResults": 5,
 *       "maxResultChars": 100000,
 *       "maxRecoveryRounds": 2
 *     }
 *   }
 *
 *   `keepRecentToolResults` — how many of the most recent tool call responses are never
 *   compressed. Also available as the CLI flag `pi --keep-recent-tool-results 8` and as
 *   the argument of `/compact-recovery 8` (argument wins, then flag, then settings).
 *   `maxResultChars` — cap for text returned by `ctx_memory`.
 *   `maxRecoveryRounds` — maximum automatic recovery rounds per session (each round
 *   compresses the remaining candidates and re-runs compaction; the budget resets per
 *   session).
 *   `compactionInstructions` — custom instructions appended to the compaction prompt when
 *   the recovery re-runs compaction. Default: a token-cap-aware summary directive (the
 *   previous summary hit the output cap, so this one must stay small).
 *
 * Debugging: run with `PI_EXTENSION_DEBUG=1` (or `PI_COMPACTION_RECOVERY_DEBUG=1`) to
 * trace the recovery flow in `~/.pi/agent/logs/compaction-recovery.jsonl`: each
 * compaction failure, what was compressed, the compaction retry and the prompt resend.
 */
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { logDebug, logError, logWarn } from "./lib/extension-log.ts";

const LOG_SCOPE = "compaction-recovery";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const DEFAULTS = {
	keepRecentToolResults: 5,
	minCompressChars: 1000,
	maxResultChars: 100_000,
	/**
	 * Maximum automatic recovery rounds per session. Each round compresses the
	 * remaining candidates and re-runs compaction; the cap stops the loop when
	 * the context is too large for the summarization to ever fit.
	 */
	maxRecoveryRounds: 2,
} as const;

const KEEP_RECENT_FLAG = "keep-recent-tool-results";
const DEFAULT_RESERVE_TOKENS = 16384; // mirrors pi's DEFAULT_COMPACTION_SETTINGS
const IMAGE_CHAR_WEIGHT = 4800; // mirrors pi's estimateTokens image weighting
const COMPRESSION_MARKER = "ctx-memory-compressed";

// ---------------------------------------------------------------------------
// Structural message types (pure, unit-testable)
// ---------------------------------------------------------------------------

export interface ContentBlockLike {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	arguments?: unknown;
	mimeType?: string;
}

export interface MessageLike {
	role: string;
	content?: string | ContentBlockLike[];
	sections?: Record<string, string | null>;
	toolsAdded?: unknown[];
	command?: string;
	output?: string;
	summary?: string;
	stopReason?: string;
	toolName?: string;
}

// ---------------------------------------------------------------------------
// Token estimation (mirrors pi's chars/4 heuristic)
// ---------------------------------------------------------------------------

export function contentChars(content: string | readonly ContentBlockLike[]): number {
	if (typeof content === "string") return content.length;
	let chars = 0;
	for (const block of content) {
		if (block.type === "image") {
			chars += IMAGE_CHAR_WEIGHT;
		} else if (typeof block.text === "string") {
			chars += block.text.length;
		}
	}
	return chars;
}

export function estimateMessageTokens(message: MessageLike): number {
	switch (message.role) {
		case "system": {
			let chars = contentChars(message.content ?? "");
			for (const section of Object.values(message.sections ?? {})) {
				if (section) chars += section.length;
			}
			if (message.toolsAdded) chars += JSON.stringify(message.toolsAdded).length;
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			if (typeof message.content === "string") return Math.ceil(message.content.length / 4);
			let chars = 0;
			for (const block of message.content ?? []) {
				if (block.type === "text" && typeof block.text === "string") {
					chars += block.text.length;
				} else if (block.type === "thinking" && typeof block.thinking === "string") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += (block.name ?? "").length + JSON.stringify(block.arguments ?? {}).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "bashExecution":
			return Math.ceil(((message.command ?? "").length + (message.output ?? "").length) / 4);
		case "branchSummary":
		case "compactionSummary":
			return Math.ceil((message.summary ?? "").length / 4);
		default:
			// user, toolResult, custom
			return Math.ceil(contentChars(message.content ?? "") / 4);
	}
}

/**
 * Estimated context tokens. Mirrors pi's fallback estimate: one system contribution
 * (the first system message, standing in for the replayed leading system message)
 * plus every non-system message, chars/4.
 */
export function estimateContextTokens(messages: readonly MessageLike[]): number {
	let tokens = 0;
	let countedSystem = false;
	for (const message of messages) {
		if (message.role === "system") {
			if (!countedSystem) {
				tokens += estimateMessageTokens(message);
				countedSystem = true;
			}
			continue;
		}
		tokens += estimateMessageTokens(message);
	}
	return tokens;
}

// ---------------------------------------------------------------------------
// Compression placeholder
// ---------------------------------------------------------------------------

export function buildCompressionPlaceholder(entryId: string, toolName: string, originalChars: number): string {
	return (
		`[${COMPRESSION_MARKER}] This tool call response was compressed. ` +
		`To have access to the original content use the tool ctx_memory passing the id ${entryId}. ` +
		`Tool: ${toolName} (original: ${originalChars} chars)`
	);
}

export function isCompressedContent(content: string | readonly ContentBlockLike[]): boolean {
	if (typeof content === "string") return content.includes(COMPRESSION_MARKER);
	for (const block of content) {
		if (typeof block.text === "string" && block.text.includes(COMPRESSION_MARKER)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Compression planning (pure)
// ---------------------------------------------------------------------------

export interface ToolResultInput {
	/** Session entry id of the tool result message (what ctx_memory resolves) */
	entryId: string;
	/** Position among projected tool results, chronological (older = smaller) */
	order: number;
	toolName: string;
	blocks: readonly ContentBlockLike[];
}

export interface CompressionBudget {
	/** Estimated tokens of the current context */
	totalTokens: number;
	/** Tokens the context must fit under: contextWindow - reserveTokens */
	targetTokens: number;
	/** Number of most recent tool results that are never compressed */
	keepRecent: number;
	/** Minimum content size (chars) worth compressing */
	minChars?: number;
	/**
	 * Compress every candidate. Used by the recovery flow: a failed compaction is
	 * itself proof the context is too large, while the chars/4 estimate can be far
	 * below the provider's real token count and must not gate the recovery.
	 */
	compressAll?: boolean;
}

export interface CompressionSelection {
	entryId: string;
	toolName: string;
	originalChars: number;
	approxTokensFreed: number;
	placeholder: string;
}

export interface CompressionPlan {
	selected: CompressionSelection[];
	/** True when nothing was compressed because the context already fits */
	alreadyFits: boolean;
	totalTokens: number;
	targetTokens: number;
}

/**
 * Choose which tool results to compress. Compresses largest first (oldest first on
 * ties), skipping the most recent `keepRecent` and anything already compressed, and
 * stops as soon as the estimated context fits under targetTokens.
 */
export function planCompression(budget: CompressionBudget, results: readonly ToolResultInput[]): CompressionPlan {
	if (!budget.compressAll && budget.totalTokens <= budget.targetTokens) {
		return { selected: [], alreadyFits: true, totalTokens: budget.totalTokens, targetTokens: budget.targetTokens };
	}
	const minChars = budget.minChars ?? DEFAULTS.minCompressChars;
	const keep = Math.max(0, Math.floor(budget.keepRecent));
	const preservedIds = new Set(keep > 0 ? results.slice(results.length - keep).map((r) => r.entryId) : []);
	const candidates = results
		.map((r) => ({ r, chars: contentChars(r.blocks) }))
		.filter(({ r, chars }) => !preservedIds.has(r.entryId) && !isCompressedContent(r.blocks) && chars >= minChars)
		.sort((a, b) => (a.chars !== b.chars ? b.chars - a.chars : a.r.order - b.r.order));

	const selected: CompressionSelection[] = [];
	let freed = 0;
	for (const { r, chars } of candidates) {
		if (!budget.compressAll && budget.totalTokens - freed <= budget.targetTokens) break;
		const placeholder = buildCompressionPlaceholder(r.entryId, r.toolName, chars);
		const freedTokens = Math.ceil(chars / 4) - Math.ceil(placeholder.length / 4);
		selected.push({
			entryId: r.entryId,
			toolName: r.toolName,
			originalChars: chars,
			approxTokensFreed: freedTokens,
			placeholder,
		});
		freed += freedTokens;
	}
	return { selected, alreadyFits: false, totalTokens: budget.totalTokens, targetTokens: budget.targetTokens };
}

// ---------------------------------------------------------------------------
// Failure detection and settings (pure)
// ---------------------------------------------------------------------------

/**
 * Matches the compaction failures this extension recovers from: the overflow recovery
 * failure ("Context overflow recovery failed: ...") and any non-aborted compaction
 * failure whose error shows the summarization hit the output token cap.
 */
export function isRecoverableCompactionFailure(event: { reason: string; errorMessage?: string; aborted: boolean }): boolean {
	if (event.aborted) return false;
	if (event.reason === "overflow") return true;
	return /token cap|summary is incomplete/i.test(event.errorMessage ?? "");
}

export interface ResolvedRecoverySettings {
	enabled: boolean;
	keepRecentToolResults: number;
	maxResultChars: number;
	maxRecoveryRounds: number;
}

function parseNonNegInt(value: string | undefined): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = value.trim().match(/^(\d+)$/);
	if (!match) return undefined;
	const n = Number(match[1]);
	return Number.isSafeInteger(n) ? n : undefined;
}

function isNonNegSafeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Resolve the extension settings. Precedence for keepRecentToolResults:
 * command argument > CLI flag > settings file > default (5).
 */
export function resolveRecoverySettings(input: {
	settings?: unknown;
	flag?: string | boolean | undefined;
	arg?: string | undefined;
}): ResolvedRecoverySettings {
	const raw = input.settings as Record<string, unknown> | undefined;
	const block = (raw?.compactionRecovery ?? undefined) as Record<string, unknown> | undefined;
	const enabled = block?.enabled !== false;
	const keep =
		parseNonNegInt(input.arg) ??
		parseNonNegInt(typeof input.flag === "string" ? input.flag : undefined) ??
		(isNonNegSafeInt(block?.keepRecentToolResults) ? (block?.keepRecentToolResults as number) : DEFAULTS.keepRecentToolResults);
	const maxResultChars =
		typeof block?.maxResultChars === "number" && Number.isSafeInteger(block.maxResultChars) && block.maxResultChars > 0
			? block.maxResultChars
			: DEFAULTS.maxResultChars;
	const maxRecoveryRounds =
		typeof block?.maxRecoveryRounds === "number" && Number.isFinite(block.maxRecoveryRounds) && block.maxRecoveryRounds >= 1
			? Math.floor(block.maxRecoveryRounds)
			: DEFAULTS.maxRecoveryRounds;
	return { enabled, keepRecentToolResults: keep, maxResultChars, maxRecoveryRounds };
}

/**
 * Resolve compaction reserveTokens the same way pi does: per-model override first,
 * then the ordinary setting, then the built-in default.
 */
export function resolveReserveTokens(settings: unknown, modelKey: string | undefined): number {
	const raw = settings as Record<string, unknown> | undefined;
	const compaction = raw?.compaction as Record<string, unknown> | undefined;
	if (!compaction) return DEFAULT_RESERVE_TOKENS;
	if (modelKey) {
		const overrides = compaction.modelOverrides as Record<string, unknown> | undefined;
		const override = overrides?.[modelKey] as Record<string, unknown> | undefined;
		if (override && isNonNegSafeInt(override.reserveTokens)) return override.reserveTokens;
	}
	return isNonNegSafeInt(compaction.reserveTokens) ? compaction.reserveTokens : DEFAULT_RESERVE_TOKENS;
}

// ---------------------------------------------------------------------------
// Original content lookup (session JSONL)
// ---------------------------------------------------------------------------

function extractToolResult(entry: unknown): { toolName: string; content: ContentBlockLike[] } | undefined {
	const e = entry as { type?: string; message?: MessageLike };
	if (e?.type !== "message" || e.message?.role !== "toolResult") return undefined;
	const content = e.message.content;
	return {
		toolName: e.message.toolName ?? "unknown",
		content: Array.isArray(content) ? content : [],
	};
}

/**
 * Find the original tool result for an entry id. The session manager is the
 * in-memory view of the session JSONL; context edits are append-only overrides, so
 * the raw entry — and therefore the returned content — is always the pre-compression
 * response.
 */
export function findOriginalToolResult(
	sessionManager: { getEntry: (id: string) => unknown },
	id: string,
): { toolName: string; content: ContentBlockLike[] } | undefined {
	return extractToolResult(sessionManager.getEntry(id));
}

/**
 * Extract the text of the most recent user message (the prompt to resend after a
 * successful recovery compaction). Text-only: images of the original prompt are not
 * resent.
 */
export function lastUserPromptText(messages: readonly MessageLike[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "user") continue;
		const text = typeof message.content === "string" ? message.content : contentCharsTextOnly(message.content);
		return text.trim() || undefined;
	}
	return undefined;
}

function contentCharsTextOnly(content: readonly ContentBlockLike[] | undefined): string {
	if (!content) return "";
	return content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("");
}

// ---------------------------------------------------------------------------
// Pi-side plumbing
// ---------------------------------------------------------------------------

/**
 * Map projected session entries to compression candidates. Projected entries carry
 * the post-edit (model-visible) messages; already-compressed or omitted results are
 * detected through them.
 */
function projectedToolResultInputs(
	projected: readonly {
		sourceEntry: { type: string; id: string; message?: MessageLike };
		messages: MessageLike[];
	}[],
): ToolResultInput[] {
	const out: ToolResultInput[] = [];
	let order = 0;
	for (const pe of projected) {
		const se = pe.sourceEntry;
		if (se.type !== "message") continue;
		const msg = se.message;
		if (!msg || msg.role !== "toolResult" || pe.messages.length === 0) continue;
		const visible = pe.messages[0];
		out.push({
			entryId: se.id,
			order: order++,
			toolName: visible.toolName ?? "unknown",
			blocks: Array.isArray(visible.content) ? visible.content : [],
		});
	}
	return out;
}

/**
 * Compress the largest old tool results of the live session (append-only context
 * edits). Compresses every candidate (largest/oldest first, keeping the most
 * recent N): a failed compaction - or an explicit /compact-recovery - is itself
 * proof the context is too large, and the chars/4 estimate must not gate the
 * recovery. Used by the recovery flow and the /compact-recovery command.
 */
async function runCompressionPass(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	argKeep?: string,
): Promise<{ compressed: number; freedTokens: number; skipped: boolean }> {
	const settings = resolveRecoverySettings({
		settings: pi.getSettings(),
		flag: pi.getFlag(KEEP_RECENT_FLAG),
		arg: argKeep,
	});
	if (!settings.enabled) return { compressed: 0, freedTokens: 0, skipped: true };
	const projection = ctx.sessionManager.buildSessionProjection();
	const inputs = projectedToolResultInputs(projection.entries);
	const plan = planCompression({ totalTokens: 0, targetTokens: 0, keepRecent: settings.keepRecentToolResults, compressAll: true }, inputs);
	logDebug(LOG_SCOPE, "compression-pass", {
		candidates: inputs.length,
		selected: plan.selected.length,
		keepRecent: settings.keepRecentToolResults,
		alreadyFits: plan.alreadyFits,
	});
	if (plan.selected.length === 0) return { compressed: 0, freedTokens: 0, skipped: false };
	// ctx.sessionManager is typed read-only but is the live SessionManager; pi's own
	// recovery omission uses the same direct-append path.
	const sessionManager = ctx.sessionManager as unknown as SessionManager;
	for (const s of plan.selected) {
		sessionManager.appendContextEdit(s.entryId, { content: [{ type: "text", text: s.placeholder }] });
	}
	return {
		compressed: plan.selected.length,
		freedTokens: plan.selected.reduce((sum, s) => sum + s.approxTokensFreed, 0),
		skipped: false,
	};
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

/**
 * The default custom instructions appended to the compaction prompt on a recovery
 * re-run: the previous summary hit the token cap, so this one must stay small.
 * pi replaces its generic "preserve tool call ids" fallback line with custom
 * instructions, so this is self-contained (it re-states that guidance).
 */
export const DEFAULT_COMPACT_INSTRUCTIONS =
	"The previous compaction attempt failed because the summary generation hit the token cap and was incomplete. " +
	"Keep this summary strictly compact: short bullet points only, no paragraphs, at most 60 bullets. " +
	"Preserve: the user's original request and any explicit constraints; decisions made with a one-line rationale; " +
	"file paths and exact commands that were run; the current pending state and next steps. " +
	"The most recent tool call results are kept verbatim in context after the summary - do not re-summarize them. " +
	"When the summary mentions a tool call, preserve the tool call id and reference the full results via the provided tool ids.";

/**
 * Custom instructions appended to the compaction prompt for a recovery re-run.
 * `compactionRecovery.compactionInstructions` wins over the built-in default.
 */
export function resolveCompactionInstructions(settings: unknown): string {
	const raw = (settings as { compactionRecovery?: { compactionInstructions?: unknown } } | undefined)?.compactionRecovery;
	const custom = raw?.compactionInstructions;
	if (typeof custom === "string" && custom.trim().length > 0) return custom.trim();
	return DEFAULT_COMPACT_INSTRUCTIONS;
}

export default function compactionFailRecovery(pi: ExtensionAPI) {
	// The ctx_memory tool is registered below; the recovery flow lives in
	// session_compact_failed (see the header for the full sequence).
	logDebug(LOG_SCOPE, "extension-loaded");

	// Per-session recovery budget. A fresh session gets a fresh budget; reload and
	// resume continue the same conversation, so its budget survives them.
	let recoveryRounds = 0;
	pi.on("session_start", (event) => {
		if (event.reason === "reload" || event.reason === "resume") return;
		recoveryRounds = 0;
		logDebug(LOG_SCOPE, "session-start-reset", { reason: event.reason });
	});

	pi.registerTool({
		name: "ctx_memory",
		label: "Context Memory",
		description:
			"Retrieve the original content of a tool call response that was compressed by the compaction-fail-recovery extension. " +
			"Pass the id shown in the compression placeholder; the original content is read from the session JSONL and is always the pre-compression response.",
		parameters: Type.Object({
			id: Type.String({
				description: "The session entry id of the original tool call response (from the compression placeholder)",
			}),
		}),
		annotations: { readOnlyHint: true },
		promptGuidelines: [
			"If a tool result says it was compressed, call ctx_memory with the given id to read the original content before relying on the shortened view.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			const settings = resolveRecoverySettings({ settings: pi.getSettings() });
			const found = findOriginalToolResult(ctx.sessionManager, params.id);
			if (!found) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								`ctx_memory: no tool call response found for id "${params.id}" in this session. ` +
								`The id must be one shown in a [${COMPRESSION_MARKER}] placeholder of this session.`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
			const text = found.content
				.filter((b) => b.type === "text" && typeof b.text === "string")
				.map((b) => b.text as string)
				.join("\n");
			const images = found.content.filter((b) => b.type === "image");
			let out = text;
			if (images.length > 0) {
				out += `\n\n[${images.length} image block(s) in the original response (${images
					.map((i) => i.mimeType ?? "unknown")
					.join(", ")}); images are not reproduced by ctx_memory.]`;
			}
			const totalChars = out.length;
			if (out.length > settings.maxResultChars) {
				out = `${out.slice(0, settings.maxResultChars)}\n\n[... truncated ${totalChars - settings.maxResultChars} of ${totalChars} total chars; the full original is stored in the session JSONL]`;
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `Original tool call response (id: ${params.id}, tool: ${found.toolName}, ${totalChars} chars):\n\n${out}`,
					},
				],
				details: { id: params.id, toolName: found.toolName, originalChars: totalChars },
			};
		},
	});

	pi.registerFlag(KEEP_RECENT_FLAG, {
		description: "How many of the most recent tool call responses to keep uncompressed when compressing tool results",
		type: "string",
	});

	pi.registerCommand("compact-recovery", {
		description:
			"Compress the largest old tool call responses (keeps the most recent N, default 5), then runs pi's compaction so it decides what stays in context. Optional argument: N.",
		handler: async (args, ctx) => {
			const argKeep = args.trim().match(/^(\d+)$/)?.[1];
			const result = await runCompressionPass(pi, ctx, argKeep);
			if (result.skipped) {
				ctx.ui.notify("compaction-fail-recovery is disabled (compactionRecovery.enabled = false)", "warning");
				return;
			}
			if (result.compressed === 0) {
				ctx.ui.notify("Nothing to compress: the context already fits, or only the most recent tool call responses remain.", "info");
				return;
			}
			ctx.ui.notify(`Compressed ${result.compressed} tool call responses (~${result.freedTokens.toLocaleString()} tokens freed)`, "info");
			// Re-run pi's compaction so it decides what stays in context, with the
			// recovery's token-cap-aware custom instructions.
			ctx.ui.notify("Running compaction so it decides what to keep in context...", "info");
			ctx.compact({ customInstructions: resolveCompactionInstructions(pi.getSettings()) });
		},
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		try {
			const recoverable = isRecoverableCompactionFailure(event);
			logDebug(LOG_SCOPE, "compact_failed", {
				reason: event.reason,
				aborted: event.aborted,
				errorMessage: event.errorMessage,
				recoverable,
			});
			if (!recoverable) return;
			const settings = resolveRecoverySettings({ settings: pi.getSettings(), flag: pi.getFlag(KEEP_RECENT_FLAG) });
			if (!settings.enabled) {
				logDebug(LOG_SCOPE, "skipped-disabled");
				return;
			}
			if (recoveryRounds >= settings.maxRecoveryRounds) {
				logDebug(LOG_SCOPE, "recovery-rounds-exhausted", {
					recoveryRounds,
					maxRecoveryRounds: settings.maxRecoveryRounds,
				});
				logWarn(LOG_SCOPE, "recovery-rounds-exhausted");
				ctx.ui.notify(
					`Compaction keeps hitting the token cap and the ${settings.maxRecoveryRounds} recovery rounds are exhausted. ` +
						"Raise compaction.reserveTokens, use a larger-context model, or start a new session - " +
						"compressed results stay available via ctx_memory.",
					"warning",
				);
				return;
			}
			// For interrupted runs (overflow recovery, mid-run threshold compaction) the
			// prompt that was in flight is resent once the recovery compaction succeeds.
			// A manual /compact failure has no prompt to resend.
			const lastPrompt =
				event.reason === "manual"
					? undefined
					: lastUserPromptText(ctx.sessionManager.buildSessionProjection().messages as unknown as MessageLike[]);
			const result = await runCompressionPass(pi, ctx);
			if (result.skipped) return;
			logDebug(LOG_SCOPE, "compressed", { compressed: result.compressed, freedTokens: result.freedTokens });
			if (result.compressed === 0) {
				logWarn(LOG_SCOPE, "nothing-left-to-compress");
				ctx.ui.notify(
					"Compaction failed and there are no tool call responses left to compress (the most recent ones are always kept). " +
						"Consider a larger-context model, raising compaction.reserveTokens, or starting a new session.",
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`Compaction failed - compressed ${result.compressed} tool call responses (~${result.freedTokens.toLocaleString()} tokens freed), running compaction again...`,
				"info",
			);
			recoveryRounds++;
			// Re-run pi's compaction on the compressed context: it decides what stays
			// verbatim and summarizes the rest. It appends custom instructions: the
			// previous summary hit the cap, so this one must stay small (see
			// resolveCompactionInstructions).
			//
			// DEFERRED (macrotask): never call ctx.compact() inside this handler. A
			// failed re-run emits session_compact_failed from inside compact()'s catch
			// block, and a synchronous nested compact() gets its abort controller
			// cleared by the outer compact()'s finally - its own failure path then
			// crashes with a TypeError before emitting compaction_end /
			// session_compact_failed, leaving the TUI stuck on a compaction that never
			// finishes. A macrotask runs only after the previous compact() has fully
			// unwound (and the interrupted run has settled), so the new compact()
			// starts clean.
			setTimeout(() => {
				try {
					ctx.compact({
						customInstructions: resolveCompactionInstructions(pi.getSettings()),
						onComplete: () => {
							logDebug(LOG_SCOPE, "compact-retried-success", { lastPrompt: Boolean(lastPrompt) });
							if (!lastPrompt) return;
							// Resend only while nothing else has started: a resend now would
							// abort the run the user already started (compact() aborts
							// first), and duplicating a prompt the user already retried
							// is worse than leaving it to them.
							if (!ctx.isIdle()) {
								logDebug(LOG_SCOPE, "resend-skipped-not-idle");
								return;
							}
							ctx.ui.notify("Compaction succeeded - resending the last prompt", "info");
							pi.sendUserMessage(lastPrompt);
						},
						onError: (error) => {
							logError(LOG_SCOPE, "compact-retry-failed", error);
							ctx.ui.notify(
								`Recovery compaction failed: ${error.message}. The session is recoverable - ` +
									"run /compact-recovery to compress more, or start a new session (compressed originals are available via ctx_memory).",
								"warning",
							);
						},
					});
				} catch (error) {
					logError(LOG_SCOPE, "compact-schedule-failed", error);
					ctx.ui.notify(`Recovery compaction could not start: ${error instanceof Error ? error.message : String(error)}`, "warning");
				}
			}, 0);
		} catch (error) {
			logError(LOG_SCOPE, "handler-failed", error);
			ctx.ui.notify(`compaction-fail-recovery: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});
}
