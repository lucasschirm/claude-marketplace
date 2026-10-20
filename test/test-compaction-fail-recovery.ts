// Run with: node --test test/test-compaction-fail-recovery.ts
import { test } from "node:test";
import * as assert from "node:assert";
import {
	DEFAULTS,
	DEFAULT_COMPACT_INSTRUCTIONS,
	buildCompressionPlaceholder,
	contentChars,
	estimateContextTokens,
	estimateMessageTokens,
	findOriginalToolResult,
	isCompressedContent,
	isRecoverableCompactionFailure,
	lastUserPromptText,
	planCompression,
	resolveCompactionInstructions,
	resolveRecoverySettings,
	resolveReserveTokens,
	type ToolResultInput,
} from "../extensions/compaction-fail-recovery.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function toolResult(entryId: string, chars: number, order: number, toolName = "bash"): ToolResultInput {
	return {
		entryId,
		order,
		toolName,
		blocks: [{ type: "text", text: "x".repeat(chars) }],
	};
}

const TOKEN_BUDGET = { totalTokens: 100_000, targetTokens: 90_000, keepRecent: 5 };

test("planCompression: nothing to do when the context already fits", () => {
	const plan = planCompression({ totalTokens: 50_000, targetTokens: 90_000, keepRecent: 5 }, [
		toolResult("a", 40_000, 0),
	]);
	assert.strictEqual(plan.alreadyFits, true);
	assert.strictEqual(plan.selected.length, 0);
});

test("planCompression: compresses largest first, oldest first on ties", () => {
	const results = [
		toolResult("old-small", 2_000, 0),
		toolResult("old-big", 30_000, 1),
		toolResult("old-big-tie", 30_000, 2),
		toolResult("mid", 10_000, 3),
	];
	// 30k chars = 7.5k tokens; need ~10k freed, so the two 30k results (oldest of the tie
	// first) are exactly enough.
	const plan = planCompression({ totalTokens: 20_000, targetTokens: 10_000, keepRecent: 0 }, results);
	assert.deepStrictEqual(
		plan.selected.map((s) => s.entryId),
		["old-big", "old-big-tie"],
	);
});

test("planCompression: keeps the most recent N tool results untouched", () => {
	const results = [
		toolResult("t0", 5_000, 0),
		toolResult("t1", 5_000, 1),
		toolResult("t2", 5_000, 2),
		toolResult("t3", 5_000, 3),
		toolResult("t4", 5_000, 4),
		toolResult("t5", 5_000, 5),
		toolResult("t6", 5_000, 6),
	];
	const plan = planCompression({ totalTokens: 100_000, targetTokens: 10_000, keepRecent: 5 }, results);
	assert.deepStrictEqual(
		plan.selected.map((s) => s.entryId),
		["t0", "t1"],
		"only the two oldest candidates may be compressed",
	);
});

test("planCompression: keepRecent 0 does not preserve anything (slice(-0) trap)", () => {
	const results = [toolResult("t0", 5_000, 0), toolResult("t1", 5_000, 1)];
	const plan = planCompression({ totalTokens: 100_000, targetTokens: 10_000, keepRecent: 0 }, results);
	assert.strictEqual(plan.selected.length, 2, "with keepRecent=0 every candidate is compressible");
});

test("planCompression: stops as soon as the context fits", () => {
	// One 30k-char result frees ~7.5k tokens; 90k -> 55k target needs 35k -> ~5 results.
	const results = Array.from({ length: 8 }, (_, i) => toolResult(`t${i}`, 30_000, i));
	const plan = planCompression({ totalTokens: 90_000, targetTokens: 55_000, keepRecent: 0 }, results);
	const freed = plan.selected.reduce((sum, s) => sum + s.approxTokensFreed, 0);
	assert.ok(freed >= 35_000, `freed ${freed} must cover the 35k gap`);
	assert.ok(90_000 - freed <= 55_000 + 1, "must not over-compress past the target by a full candidate");
});

test("planCompression: skips already-compressed and too-small results", () => {
	const results = [
		toolResult("already", 20_000, 0),
		toolResult("tiny", 100, 1),
		toolResult("ok", 20_000, 2),
	];
	results[0].blocks = [{ type: "text", text: buildCompressionPlaceholder("already", "bash", 20_000) }];
	const plan = planCompression({ totalTokens: 100_000, targetTokens: 10_000, keepRecent: 0, minChars: 1_000 }, results);
	assert.deepStrictEqual(plan.selected.map((s) => s.entryId), ["ok"]);
});

test("planCompression: placeholders carry the entry id and the marker", () => {
	const plan = planCompression({ ...TOKEN_BUDGET, keepRecent: 0 }, [toolResult("entry-123", 40_000, 0)]);
	const placeholder = plan.selected[0]?.placeholder;
	assert.ok(placeholder, "a selection was expected");
	assert.ok(isCompressedContent(placeholder), "placeholder must carry the compression marker");
	assert.ok((placeholder as string).includes("entry-123"), "placeholder must name the original response id");
	assert.ok((placeholder as string).includes("ctx_memory"), "placeholder must name the retrieval tool");
	assert.ok((placeholder as string).includes("40000"), "placeholder must report the original size");
});

test("estimate helpers mirror the chars/4 heuristic", () => {
	assert.strictEqual(contentChars("abcd"), 4);
	assert.strictEqual(contentChars([{ type: "text", text: "abcd" }, { type: "image" }]), 4 + 4_800);
	assert.strictEqual(estimateMessageTokens({ role: "toolResult", content: "x".repeat(800) }), 200);
	assert.strictEqual(estimateMessageTokens({ role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(400) }] }), 100);
	assert.strictEqual(
		estimateMessageTokens({ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] }),
		Math.ceil(("bash".length + JSON.stringify({ command: "ls" }).length) / 4),
	);
	assert.strictEqual(estimateMessageTokens({ role: "bashExecution", command: "ls", output: "a".repeat(398) }), 100);

	// System counts once even when several system patch messages exist.
	const sys = (extra: number) => ({
		role: "system" as const,
		content: "y".repeat(extra),
		sections: { extra: "z".repeat(extra) },
	});
	const tokens = estimateContextTokens([sys(400), { role: "user", content: "w".repeat(400) }, sys(400)]);
	assert.strictEqual(tokens, 200 + 100 + 0, "only the first system message contributes");
});

test("isRecoverableCompactionFailure matches the overflow recovery error", () => {
	const overflowError = {
		reason: "overflow" as const,
		errorMessage:
			"Context overflow recovery failed: Summarization failed: generation hit the token cap and the summary is incomplete",
		aborted: false,
	};
	assert.ok(isRecoverableCompactionFailure(overflowError), "the user-reported error must be recoverable");

	assert.ok(
		isRecoverableCompactionFailure({
			reason: "threshold",
			errorMessage: "Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete",
			aborted: false,
		}),
		"threshold failures with the token cap signature are recoverable",
	);
	assert.ok(
		isRecoverableCompactionFailure({
			reason: "manual",
			errorMessage: "Compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete",
			aborted: false,
		}),
		"manual failures with the token cap signature are recoverable",
	);
	assert.ok(!isRecoverableCompactionFailure({ reason: "manual", errorMessage: "Compaction failed: boom", aborted: false }));
	assert.ok(!isRecoverableCompactionFailure({ ...overflowError, aborted: true }), "aborted compactions are not recoverable");
});

test("resolveRecoverySettings: precedence is argument > flag > settings > default", () => {
	const settings = {
		compactionRecovery: { keepRecentToolResults: 3, maxResultChars: 50_000 },
	};
	assert.strictEqual(resolveRecoverySettings({}).keepRecentToolResults, DEFAULTS.keepRecentToolResults);
	assert.strictEqual(resolveRecoverySettings({ settings }).keepRecentToolResults, 3);
	assert.strictEqual(resolveRecoverySettings({ settings, flag: "8" }).keepRecentToolResults, 8);
	assert.strictEqual(resolveRecoverySettings({ settings, flag: "8", arg: "2" }).keepRecentToolResults, 2);
	assert.strictEqual(resolveRecoverySettings({ settings: { compactionRecovery: { keepRecentToolResults: -1 } } }).keepRecentToolResults, DEFAULTS.keepRecentToolResults, "invalid setting falls back to the default");
	assert.strictEqual(resolveRecoverySettings({ settings: { compactionRecovery: { enabled: false } } }).enabled, false);
	assert.strictEqual(resolveRecoverySettings({ settings: { compactionRecovery: {} } }).enabled, true);
	assert.strictEqual(resolveRecoverySettings({ settings: { compactionRecovery: { maxResultChars: -5 } } }).maxResultChars, DEFAULTS.maxResultChars);
	assert.strictEqual(resolveRecoverySettings({}).maxRecoveryRounds, DEFAULTS.maxRecoveryRounds);
	assert.strictEqual(resolveRecoverySettings({ settings: { compactionRecovery: { maxRecoveryRounds: 3 } } }).maxRecoveryRounds, 3);
	assert.strictEqual(resolveRecoverySettings({ settings: { compactionRecovery: { maxRecoveryRounds: 2.9 } } }).maxRecoveryRounds, 2, "fractional rounds floor to the lower integer");
	assert.strictEqual(resolveRecoverySettings({ settings: { compactionRecovery: { maxRecoveryRounds: 0.5 } } }).maxRecoveryRounds, DEFAULTS.maxRecoveryRounds, "sub-1 fractional falls back");
	assert.strictEqual(resolveRecoverySettings({ settings: { compactionRecovery: { maxRecoveryRounds: 0 } } }).maxRecoveryRounds, DEFAULTS.maxRecoveryRounds);
});

test("resolveReserveTokens follows the pi resolution order", () => {
	assert.strictEqual(resolveReserveTokens(undefined, "p/m"), 16_384);
	assert.strictEqual(resolveReserveTokens({ compaction: { reserveTokens: 8_000 } }, "p/m"), 8_000);
	assert.strictEqual(
		resolveReserveTokens({ compaction: { reserveTokens: 8_000, modelOverrides: { "p/m": { reserveTokens: 12_000 } } } }, "p/m"),
		12_000,
	);
	assert.strictEqual(
		resolveReserveTokens({ compaction: { modelOverrides: { "p/m": { reserveTokens: -1 } } } }, "p/m"),
		16_384,
		"an invalid override falls back",
	);
});

test("findOriginalToolResult reads the raw (pre-compression) entry", () => {
	const original = { type: "text", text: "the original output".repeat(100) };
	const manager = {
		getEntry: (id: string) =>
			id === "a1" ? { type: "message", message: { role: "toolResult", toolName: "bash", content: [original] } } : undefined,
	};
	const found = findOriginalToolResult(manager, "a1");
	assert.strictEqual(found?.toolName, "bash");
	assert.strictEqual((found?.content[0] as { text?: string }).text, original.text);
	assert.strictEqual(findOriginalToolResult(manager, "missing"), undefined);
	assert.strictEqual(findOriginalToolResult({ getEntry: () => ({ type: "compaction" }) }, "a1"), undefined);
});

test("resolveCompactionInstructions: settings override the token-cap-aware default", () => {
	assert.strictEqual(resolveCompactionInstructions({}), DEFAULT_COMPACT_INSTRUCTIONS);
	assert.match(DEFAULT_COMPACT_INSTRUCTIONS, /token cap/);
	assert.match(DEFAULT_COMPACT_INSTRUCTIONS, /tool call id/);
	assert.strictEqual(
		resolveCompactionInstructions({ compactionRecovery: { compactionInstructions: "  Keep only the task goal.  " } }),
		"Keep only the task goal.",
	);
	assert.strictEqual(resolveCompactionInstructions({ compactionRecovery: { compactionInstructions: "   " } }), DEFAULT_COMPACT_INSTRUCTIONS);
	assert.strictEqual(resolveCompactionInstructions({ compactionRecovery: { compactionInstructions: 42 } }), DEFAULT_COMPACT_INSTRUCTIONS);
});

test("lastUserPromptText returns the most recent user prompt", () => {
	assert.strictEqual(
		lastUserPromptText([
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "out" }] },
			{ role: "user", content: [{ type: "text", text: "  second prompt  " }, { type: "image" }] },
		]),
		"second prompt",
	);
	assert.strictEqual(lastUserPromptText([{ role: "assistant", content: [] }]), undefined);
	assert.strictEqual(lastUserPromptText([{ role: "user", content: "   " }]), undefined);
	assert.strictEqual(lastUserPromptText([{ role: "user", content: [{ type: "image" }] }]), undefined, "image-only prompts are not resended");
});

test("planCompression: compressAll compresses every candidate regardless of the estimate", () => {
	// The estimate says the context fits, but a real overflow proved otherwise.
	const plan = planCompression(
		{ totalTokens: 100_000, targetTokens: 150_000, keepRecent: 5, compressAll: true },
		Array.from({ length: 8 }, (_, i) => toolResult(`t${i}`, 30_000, i)),
	);
	assert.strictEqual(plan.alreadyFits, false);
	assert.strictEqual(plan.selected.length, 3, "all candidates except the last 5 must be compressed");
	assert.deepStrictEqual(plan.selected.map((s) => s.entryId), ["t0", "t1", "t2"], "largest first, oldest on ties");
});

test("recovery flow: failed compaction compresses, re-runs compaction, resends the prompt", async () => {
	// Simulates the user scenario: the provider reports a context overflow (258k real
	// tokens), but the chars/4 estimate of the projection is far below the window
	// threshold. The old code gated compression on the estimate and did nothing.
	const sm = SessionManager.inMemory("/tmp");
	sm.newSession();
	sm.appendMessage({ role: "user", content: "do the big task" } as never);
	for (let i = 0; i < 8; i++) {
		sm.appendMessage({
			role: "toolResult",
			toolCallId: `call_${i}`,
			toolName: "bash",
			content: [{ type: "text", text: `output line ${i}\n`.repeat(3_000) }],
			isError: false,
			timestamp: Date.now(),
		} as never);
	}

	type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
	const handlers = new Map<string, Handler>();
	let compactCallCount = 0;
	let compactInstructions: string | undefined;
	let compactOptions: { onComplete?: () => void } | undefined;
	const resent: string[] = [];
	const extension = (await import("../extensions/compaction-fail-recovery.ts")).default;
	extension({
		registerTool: () => {},
		registerFlag: () => {},
		registerCommand: () => {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		getSettings: () => ({}),
		getFlag: () => undefined,
		sendUserMessage: (text: string) => {
			resent.push(text);
		},
	} as never);

	const ctx = {
		ui: { notify: () => {} },
		sessionManager: sm,
		model: { provider: "anthropic", id: "claude-sonnet", contextWindow: 200_000 }, // target 184k; estimate ~113k
		isIdle: () => true,
		compact: (options?: { customInstructions?: string; onComplete?: () => void }) => {
			compactCallCount++;
			compactInstructions = options?.customInstructions;
			compactOptions = options;
		},
	} as never;

	await handlers.get("session_compact_failed")?.(
		{
			reason: "overflow",
			errorMessage: "Context overflow recovery failed: Summarization failed: generation hit the token cap and the summary is incomplete",
			aborted: false,
			willRetry: false,
			fromExtension: false,
		},
		ctx,
	);
	// The recovery compaction is deferred (macrotask) so it can never run inside a
	// previous compact()'s catch block: right after the handler returns it must not
	// have started yet.
	assert.strictEqual(compactCallCount, 0, "ctx.compact() must not be called synchronously inside the handler");
	await new Promise((r) => setTimeout(r, 20)); // let the deferred compaction start

	const projection = sm.buildSessionProjection();
	const placeholders = projection.messages.filter(
		(m) => (m as { role?: string }).role === "toolResult" && isCompressedContent((m as { content: unknown }).content),
	);
	assert.strictEqual(placeholders.length, 3, "the 3 oldest candidates are compressed (last 5 kept)");
	assert.ok(compactOptions, "pi's compaction must be re-run after the compression");
	assert.strictEqual(compactInstructions, DEFAULT_COMPACT_INSTRUCTIONS, "the recovery appends the token-cap-aware instructions to the compaction prompt");

	// The real runtime runs the compaction once idle; on success the handler resends the prompt.
	compactOptions?.onComplete?.();
	assert.deepStrictEqual(resent, ["do the big task"], "the prompt that overflowed is resent after compaction");

	// A second failure (the re-run compaction hit the cap again) has no candidates
	// left (the first pass compressed all of them): it warns and does not loop.
	await handlers.get("session_compact_failed")?.(
		{ reason: "manual", errorMessage: "Compaction failed: Summarization failed: generation hit the token cap", aborted: false },
		ctx,
	);
	await new Promise((r) => setTimeout(r, 20)); // flush (there must be nothing scheduled)
	const projection2 = sm.buildSessionProjection();
	const placeholders2 = projection2.messages.filter(
		(m) => (m as { role?: string }).role === "toolResult" && isCompressedContent((m as { content: unknown }).content),
	);
	assert.strictEqual(placeholders2.length, 3, "no further candidates; the last 5 stay intact");
	assert.strictEqual(compactCallCount, 1, "a second failure must not re-trigger compaction in a loop");
});

test("recovery rounds cap: the loop stops with guidance once maxRecoveryRounds is reached", async () => {
	const sm = SessionManager.inMemory("/tmp");
	sm.newSession();
	sm.appendMessage({ role: "user", content: "task" } as never);
	const addResult = () =>
		sm.appendMessage({
			role: "toolResult",
			toolCallId: `call_${Date.now()}_${Math.random()}`,
			toolName: "bash",
			content: [{ type: "text", text: "x\n".repeat(2_000) }],
			isError: false,
			timestamp: Date.now(),
		} as never);
	for (let i = 0; i < 7; i++) addResult(); // 7 results, keep 5 -> 2 candidates per round

	type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
	const handlers = new Map<string, Handler>();
	let compactCallCount = 0;
	const notifications: string[] = [];
	const extension = (await import("../extensions/compaction-fail-recovery.ts")).default;
	extension({
		registerTool: () => {},
		registerFlag: () => {},
		registerCommand: () => {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		getSettings: () => ({ compactionRecovery: { maxRecoveryRounds: 2 } }),
		getFlag: () => undefined,
		sendUserMessage: () => {},
	} as never);
	const ctx = {
		ui: { notify: (m: string) => notifications.push(m) },
		sessionManager: sm,
		model: { provider: "anthropic", id: "claude", contextWindow: 200_000 },
		isIdle: () => true,
		compact: () => compactCallCount++,
	} as never;
	const fail = (reason: "manual" | "overflow") =>
		handlers.get("session_compact_failed")?.(
			reason === "overflow"
				? { reason, errorMessage: "Context overflow recovery failed: Summarization failed: generation hit the token cap and the summary is incomplete", aborted: false }
				: { reason, errorMessage: "Compaction failed: Summarization failed: generation hit the token cap", aborted: false },
			ctx,
		);
	const flush = () => new Promise((r) => setTimeout(r, 20));

	// Round 1: overflow - compresses the 2 candidates.
	await fail("overflow");
	await flush();
	assert.strictEqual(compactCallCount, 1, "round 1 schedules a recovery compaction");

	// The user keeps working: a new tool result is a new candidate.
	addResult();

	// Round 2: the re-run compaction hit the cap - compresses the new candidate.
	await fail("manual");
	await flush();
	assert.strictEqual(compactCallCount, 2, "round 2 schedules a recovery compaction");

	// Another new candidate, then the next failure: the cap is hit.
	addResult();
	await fail("manual");
	await flush();
	assert.strictEqual(compactCallCount, 2, "round 3 must not schedule another compaction (cap)");
	assert.ok(notifications.some((n) => n.includes("recovery rounds are exhausted")), "the user must be told the rounds are exhausted");
	assert.ok(notifications.some((n) => n.includes("reserveTokens")), "the guidance must name the fix");
});

test("prompt resend is skipped when the session is no longer idle", async () => {
	const sm = SessionManager.inMemory("/tmp");
	sm.newSession();
	sm.appendMessage({ role: "user", content: "do the big task" } as never);
	for (let i = 0; i < 6; i++) {
		sm.appendMessage({
			role: "toolResult",
			toolCallId: `call_${i}`,
			toolName: "bash",
			content: [{ type: "text", text: `output line ${i}\n`.repeat(3_000) }],
			isError: false,
			timestamp: Date.now(),
		} as never);
	}
	type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
	const handlers = new Map<string, Handler>();
	let onComplete: (() => void) | undefined;
	let idle = true;
	const resent: string[] = [];
	const extension = (await import("../extensions/compaction-fail-recovery.ts")).default;
	extension({
		registerTool: () => {},
		registerFlag: () => {},
		registerCommand: () => {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		getSettings: () => ({}),
		getFlag: () => undefined,
		sendUserMessage: (text: string) => {
			resent.push(text);
		},
	} as never);
	const ctx = {
		ui: { notify: () => {} },
		sessionManager: sm,
		model: { provider: "anthropic", id: "claude", contextWindow: 200_000 },
		isIdle: () => idle,
		compact: (options?: { onComplete?: () => void }) => {
			onComplete = options?.onComplete;
		},
	} as never;

	await handlers.get("session_compact_failed")?.(
		{ reason: "overflow", errorMessage: "Context overflow recovery failed: Summarization failed: generation hit the token cap and the summary is incomplete", aborted: false },
		ctx,
	);
	await new Promise((r) => setTimeout(r, 20));
	assert.ok(onComplete);

	// The user already started a new run while the recovery compaction ran:
	// the completion must not resend (it would abort that run / duplicate the prompt).
	idle = false;
	onComplete?.();
	assert.deepStrictEqual(resent, [], "no resend while the session is busy");

	// While idle again, a completion resends normally.
	idle = true;
	onComplete?.();
	assert.deepStrictEqual(resent, ["do the big task"]);
});

test("session manager round trip: context edit compresses, raw entry keeps the original", async () => {
	const sm = SessionManager.inMemory("/tmp");
	sm.newSession();
	const bigText = "tool output line\n".repeat(2_000);
	const resultEntryId = sm.appendMessage({
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "bash",
		content: [{ type: "text", text: bigText }],
		isError: false,
		timestamp: Date.now(),
	});
	const placeholder = buildCompressionPlaceholder(resultEntryId, "bash", bigText.length);
	sm.appendContextEdit(resultEntryId, { content: [{ type: "text", text: placeholder }] });

	// Projected context shows the compressed placeholder...
	const projection = sm.buildSessionProjection();
	const projectedResult = projection.messages.find((m) => (m as { role?: string }).role === "toolResult") as {
		content: { type: string; text?: string }[];
	} | undefined;
	assert.ok(projectedResult, "the tool result must stay in context");
	assert.ok(isCompressedContent(projectedResult?.content ?? []), "the projected content must be the placeholder");
	assert.ok(
		(projectedResult?.content[0]?.text ?? "").includes(resultEntryId),
		"the placeholder must point at the original entry id",
	);

	// ...the raw entry (what ctx_memory resolves) still holds the original.
	const raw = sm.getEntry(resultEntryId) as { message?: { content?: { type: string; text?: string }[] } };
	assert.strictEqual(raw?.message?.content?.[0]?.text, bigText, "the raw JSONL entry must be untouched");
});
