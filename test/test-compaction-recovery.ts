// Run in CI as: pi -ne -e test/test-compaction-recovery.ts --offline -p "test"
//
// Runs inside the real Pi runtime (like the other extension suites). The unit
// suite (test-compaction-fail-recovery.ts) already covers the recovery logic
// against the real SessionManager; this suite adds what only the real runtime
// can prove: the extension loads and registers cleanly (typebox schemas,
// extension-log import, registerTool / registerFlag / registerCommand /
// session_compact_failed), and the recovery flow works with a live
// SessionManager projection.
import extension,
	{ DEFAULT_COMPACT_INSTRUCTIONS,
		isCompressedContent,
	} from "../extensions/compaction-fail-recovery.ts";
import { logPath } from "../extensions/lib/extension-log.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";

export default function (pi: any) {
	const assert = (cond: unknown, msg: string) => {
		if (!cond) throw new Error(msg);
	};

	pi.on("session_start", async () => {
		const notifications: string[] = [];
		const sent: string[] = [];
		let compactOptions: { customInstructions?: string; onComplete?: () => void } | undefined;
		try {
			// 1. The factory completes against the real pi runtime: the ctx_memory tool,
			// the --keep-recent-tool-results flag, /compact-recovery and the
			// session_compact_failed handler all register without errors.
			extension(pi);
			console.log("✓ registration: the extension loads in the real pi runtime");

			// 2. Recovery flow against the real SessionManager (a mock pi captures the
			// handler; the ctx mirrors the runtime shape).
			const handlers: Record<string, Function> = {};
			const mockPi = {
				on: (event: string, handler: Function) => {
					handlers[event] = handler;
				},
				registerTool() {},
				registerFlag() {},
				registerCommand() {},
				getSettings: () => ({}),
				getFlag: () => undefined,
				sendUserMessage: (text: string) => {
					sent.push(text);
				},
			};
			extension(mockPi as any);
			assert(typeof handlers.session_compact_failed === "function", "session_compact_failed handler must be registered");

			const sm = SessionManager.inMemory("/tmp");
			sm.newSession();
			sm.appendMessage({ role: "user", content: "do the big task" } as never);
			for (let i = 0; i < 8; i++) {
				sm.appendMessage({
					role: "toolResult",
					toolCallId: `call_${i}`,
					toolName: "bash",
					content: [{ type: "text", text: `output line ${i}\n`.repeat(300) }],
					isError: false,
					timestamp: Date.now(),
				} as never);
			}
			const ctx = {
				ui: { notify: (m: string) => notifications.push(m) },
				sessionManager: sm,
				model: { provider: "anthropic", id: "claude-sonnet", contextWindow: 200_000 },
				compact: (options?: { customInstructions?: string; onComplete?: () => void }) => {
					compactOptions = options;
				},
			};

			// The overflow recovery failure: the provider measured a context overflow
			// even though the chars/4 estimate is far below the window threshold.
			await handlers.session_compact_failed(
				{
					reason: "overflow",
					errorMessage:
						"Context overflow recovery failed: Summarization failed: generation hit the token cap and the summary is incomplete",
					aborted: false,
					willRetry: false,
					fromExtension: false,
				},
				ctx,
			);

			// The replacement lands as content blocks in the projection, so extract the
			// text from both shapes before checking the marker.
			const contentText = (c: unknown) =>
				typeof c === "string"
					? c
					: Array.isArray(c)
						? c.map((b: { text?: unknown }) => (typeof b.text === "string" ? b.text : "")).join("")
					: "";
			const isPlaceholder = (m: { role?: string; content?: unknown }) =>
				isCompressedContent(m.content as string) &&
				contentText(m.content).includes("ctx_memory") &&
				contentText(m.content).includes("passing the id");
			const projection = sm.buildSessionProjection();
			const placeholders = projection.messages.filter(
				(m: { role?: string; content?: unknown }) => m.role === "toolResult" && isCompressedContent(m.content as string),
			);
			assert(placeholders.length === 3, `the 3 oldest candidates must be compressed (last 5 kept), got ${placeholders.length}`);
			assert(
				placeholders.every(isPlaceholder),
				"placeholders must point at ctx_memory with the entry id",
			);
			assert(compactOptions, "pi's compaction must be re-run after the compression");
			assert(
				compactOptions?.customInstructions === DEFAULT_COMPACT_INSTRUCTIONS,
				"the recovery must append the token-cap-aware custom instructions to the compaction prompt",
			);

			// The runtime runs the compaction once idle; on success the prompt is resent.
			compactOptions?.onComplete?.();
			assert(sent.length === 1 && sent[0] === "do the big task", `the overflowed prompt must be resent, got ${JSON.stringify(sent)}`);
			assert(notifications.some((n) => n.includes("compressed 3 tool call responses")), "the user must be told what was compressed");

			console.log("✓ recovery flow: compress -> re-compact with custom instructions -> resend prompt");
			console.log("✓ All compaction-recovery runtime tests passed successfully!");
			process.exit(0);
		} catch (err) {
			console.error("Test failed:", err);
			console.error("notifications:", JSON.stringify(notifications));
			try {
				console.error("log tail:", fs.readFileSync(logPath("compaction-recovery"), "utf8").split("\n").slice(-5).join("\n"));
			} catch {}
			process.exit(1);
		}
	});
}
