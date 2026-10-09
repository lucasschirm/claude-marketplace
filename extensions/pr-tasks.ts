import type { ExtensionAPI, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	fetchReviewThreads,
	replyToReviewThread,
	resolveReviewThread,
	applyCodeSuggestion,
	type GitHubReviewThreadNode,
} from "./lib/github-review-threads.ts";
import {
	PRTasksManager,
	formatTaskSummary,
	formatTaskDetail,
	formatLoopMessage,
	type PRTask,
} from "./lib/pr-tasks-manager.ts";

const execFileAsync = promisify(execFile);
const GLOBAL_GUARD_KEY = "__PI_PR_TASKS_EXTENSION_ACTIVE__";

class PRTasksDashboardComponent {
	private theme: any;
	private manager: PRTasksManager;
	private onClose: () => void;

	constructor(theme: any, manager: PRTasksManager, onClose: () => void) {
		this.theme = theme;
		this.manager = manager;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.onClose();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;
		const tasks = this.manager.getAllTasks();
		const counts = this.manager.getCounts();

		lines.push("");
		const title = th.fg("accent", " PR Review Conversation Tasks ");
		const headerLine =
			th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 36)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		const statusSummary = `  Total: ${counts.total}  |  ${th.fg("warning", `Open: ${counts.open}`)}  |  ${th.fg(
			"error",
			`Blocked: ${counts.blocked}`,
		)}  |  ${th.fg("success", `Resolved: ${counts.resolved}`)}`;
		lines.push(truncateToWidth(statusSummary, width));
		lines.push("");

		if (tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No PR conversation tasks tracked.")}`, width));
		} else {
			for (const task of tasks) {
				let statusColor = "warning";
				if (task.status === "RESOLVED") statusColor = "success";
				if (task.status === "BLOCKED") statusColor = "error";

				const statusBadge = th.fg(statusColor as any, `[${task.status}]`);
				const taskHeader = `  ${statusBadge} Task #${task.conversationId} (${task.file}@${task.line})`;
				lines.push(truncateToWidth(taskHeader, width));

				const snippet = task.message.split("\n")[0] || "";
				lines.push(truncateToWidth(`    ${th.fg("muted", snippet)}`, width));
				lines.push(
					truncateToWidth(
						`    Author: ${task.author} | Replies: ${task.replies.length} | Suggestion: ${
							task.hasSuggestion ? "Yes" : "No"
						}`,
						width,
					),
				);
				lines.push("");
			}
		}

		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape or 'q' to close")}`, width));
		lines.push("");

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	if ((globalThis as any)[GLOBAL_GUARD_KEY]) {
		return;
	}
	(globalThis as any)[GLOBAL_GUARD_KEY] = true;

	const manager = new PRTasksManager();
	let lastUIContext: ExtensionUIContext | undefined;
	let lastCwd: string = process.cwd();
	let isSyncing = false;
	let lastSettleNudgeTime = 0;

	function updateStatusUI(ui?: ExtensionUIContext) {
		const targetUI = ui || lastUIContext;
		if (!targetUI) return;

		const counts = manager.getCounts();
		if (counts.total > 0) {
			targetUI.setStatus(
				"pr_tasks",
				`PR Tasks: ${counts.open} open / ${counts.blocked} blocked / ${counts.resolved} resolved`,
			);
		} else {
			targetUI.setStatus("pr_tasks", undefined);
		}
	}

	function sendAgentMessage(content: string) {
		try {
			pi.sendUserMessage(content, { deliverAs: "steer" });
		} catch (err) {
			console.error("[pr_tasks] Failed to send message to agent:", err);
		}
	}

	function getObservedPRNumbers(): number[] {
		const observedMap = (globalThis as any).__PI_OBSERVED_PRS__;
		if (observedMap && typeof observedMap.keys === "function") {
			return Array.from(observedMap.keys());
		}
		return [];
	}

	async function detectCurrentBranchPR(cwd: string): Promise<number | undefined> {
		try {
			const { stdout } = await execFileAsync("gh", ["pr", "view", "--json", "number"], { cwd });
			const parsed = JSON.parse(stdout);
			if (parsed?.number) return parsed.number;
		} catch {}
		return undefined;
	}

	async function getTargetPRNumbers(cwd: string, explicitPr?: number): Promise<number[]> {
		if (explicitPr !== undefined) return [explicitPr];
		const observed = getObservedPRNumbers();
		if (observed.length > 0) return observed;

		const detected = await detectCurrentBranchPR(cwd);
		if (detected) return [detected];
		return [];
	}

	async function syncPR(prNumber: number, cwd: string): Promise<void> {
		try {
			const threads = await fetchReviewThreads(prNumber, cwd);
			const { newTasks, unblockedTasks } = manager.syncFromGitHubThreads(prNumber, threads);

			// Check for unblocked tasks that received user replies
			for (const { task, latestReply } of unblockedTasks) {
				const unblockMsg = `The task ${task.conversationId} you blocked received a reply from the user. use the **pr_task_detail** if you need more details about the task. ${latestReply.body}`;
				sendAgentMessage(unblockMsg);
			}

			updateStatusUI();
		} catch (err) {
			console.error(`[pr_tasks] Failed to sync review threads for PR ${prNumber}:`, err);
		}
	}

	async function syncAllPRs(cwd: string, explicitPr?: number): Promise<void> {
		if (isSyncing) return;
		isSyncing = true;
		try {
			const prs = await getTargetPRNumbers(cwd, explicitPr);
			for (const pr of prs) {
				await syncPR(pr, cwd);
			}
		} finally {
			isSyncing = false;
		}
	}

	// Register integration hook for observe-pr
	(globalThis as any).__PI_ON_PR_POLL__ = async (prNumber: number, cwd: string) => {
		await syncPR(prNumber, cwd);
	};

	pi.on("session_start", async (_evt, ctx) => {
		lastUIContext = ctx.ui;
		lastCwd = ctx.cwd || process.cwd();
		await syncAllPRs(lastCwd);
		updateStatusUI(ctx.ui);
	});

	pi.on("turn_end", async (_evt, ctx) => {
		if (ctx?.cwd) lastCwd = ctx.cwd;
		if (ctx?.ui) lastUIContext = ctx.ui;
		await syncAllPRs(lastCwd);
		updateStatusUI(ctx?.ui);
	});

	// Loop enforcement: prevent agent from settling while unresolved tasks remain
	pi.on("agent_before_settle", async (_evt, ctx) => {
		if (ctx?.cwd) lastCwd = ctx.cwd;
		if (ctx?.ui) lastUIContext = ctx.ui;

		await syncAllPRs(lastCwd);
		updateStatusUI(ctx?.ui);

		const unresolvedTasks = manager.getUnresolvedTasks();
		if (unresolvedTasks.length > 0) {
			// Throttle loop messages to prevent runaway loops if identical tick
			const now = Date.now();
			if (now - lastSettleNudgeTime < 1000) {
				return;
			}
			lastSettleNudgeTime = now;

			const totalTasks = manager.getAllTasks().length;
			const loopMessage = formatLoopMessage(unresolvedTasks, totalTasks);
			try {
				pi.sendUserMessage(loopMessage, { deliverAs: "followUp" });
			} catch (err) {
				console.error("[pr_tasks] Failed to send settle loop message:", err);
			}
			return { continue: true };
		}
	});

	const PROMPT_GUIDELINES =
		"PR review conversations are tracked as tasks. Unresolved reviewer conversations must be resolved before completing your work.\n" +
		"- Use `pr_tasks_list` to view open conversation tasks.\n" +
		"- Use `pr_task_detail` to inspect the full conversation, replies, and code suggestions.\n" +
		"- Use `pr_task_resolve` to reply and resolve the conversation once addressed (use `accept_suggestion: true` if applying reviewer's code suggestion).\n" +
		"- Use `pr_task_blocked` if you require human clarification before you can resolve the conversation.\n" +
		"- Do not stop your run with unresolved tasks unless they are marked as blocked.";

	pi.on("before_agent_start", (event) => {
		if (event.systemPromptOptions?.promptGuidelines) {
			if (!event.systemPromptOptions.promptGuidelines.includes(PROMPT_GUIDELINES)) {
				event.systemPromptOptions.promptGuidelines.push(PROMPT_GUIDELINES);
			}
		}

		return {
			systemPrompt: event.systemPrompt
				? `${event.systemPrompt}\n\n${PROMPT_GUIDELINES}`
				: PROMPT_GUIDELINES,
		};
	});

	pi.on("session_shutdown", () => {
		delete (globalThis as any)[GLOBAL_GUARD_KEY];
		delete (globalThis as any).__PI_ON_PR_POLL__;
		manager.clear();
	});

	// Tool 1: pr_tasks_list
	pi.registerTool({
		name: "pr_tasks_list",
		label: "List PR Tasks",
		description:
			"Lists PR review conversation tasks. By default lists only open/unresolved tasks. Set show_all to true to include resolved tasks.",
		parameters: Type.Object({
			pr_number: Type.Optional(
				Type.Union([Type.Number(), Type.String()], {
					description: "Optional PR number to filter tasks. If omitted, lists tasks across observed PRs or current branch PR.",
				}),
			),
			show_all: Type.Optional(
				Type.Boolean({
					description:
						"If true, shows all tasks including resolved ones. By default only unresolved/blocked tasks are shown.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			const rawPr = (params as any)?.pr_number ?? (params as any)?.prNumber;
			let prNum: number | undefined;
			if (rawPr !== undefined) {
				const parsed = parseInt(String(rawPr).replace(/^#/, "").trim(), 10);
				if (!isNaN(parsed) && parsed > 0) prNum = parsed;
			}

			await syncAllPRs(ctx.cwd, prNum);
			updateStatusUI(ctx.ui);

			const showAll = Boolean((params as any)?.show_all ?? (params as any)?.showAll);
			const allTasks = manager.getAllTasks(prNum);
			const filteredTasks = showAll ? allTasks : manager.getOpenTasks(prNum);

			const formatted = formatTaskSummary(filteredTasks, allTasks.length);
			return {
				content: [{ type: "text", text: formatted }],
			};
		},
	});

	// Tool 2: pr_task_resolve
	pi.registerTool({
		name: "pr_task_resolve",
		label: "Resolve PR Task",
		description:
			"Resolves a PR review conversation task by sending a reply and marking the thread resolved on GitHub. Optional accept_suggestion applies code suggestion.",
		parameters: Type.Object({
			conversation_id: Type.Union([Type.String(), Type.Number()], {
				description: "The conversation ID / task ID to resolve",
			}),
			message: Type.String({
				description: "Resolution message explaining how the conversation was addressed",
			}),
			accept_suggestion: Type.Optional(
				Type.Boolean({
					description:
						"If true, accepts and applies the code suggestion from the conversation. Returns an error if no suggestion exists.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			const rawId = (params as any)?.conversation_id ?? (params as any)?.conversationId;
			const message = String((params as any)?.message || "").trim();
			const acceptSuggestion = Boolean(
				(params as any)?.accept_suggestion ?? (params as any)?.acceptSuggestion,
			);

			if (!rawId) {
				return {
					content: [{ type: "text", text: "Error: conversation_id is required." }],
					isError: true,
				};
			}

			let task = manager.findTask(rawId);
			if (!task) {
				await syncAllPRs(ctx.cwd);
				task = manager.findTask(rawId);
			}

			if (!task) {
				return {
					content: [{ type: "text", text: `Error: Conversation ${rawId} not found.` }],
					isError: true,
				};
			}

			// Validate code suggestion requirement
			if (acceptSuggestion) {
				if (!task.hasSuggestion || task.suggestion === undefined) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid resolution: Conversation ${task.conversationId} does not contain any code suggestion to accept.`,
							},
						],
						isError: true,
					};
				}

				try {
					await applyCodeSuggestion(
						task.file,
						task.startLine || task.line,
						task.line,
						task.suggestion,
						ctx.cwd,
					);
				} catch (err: any) {
					return {
						content: [
							{
								type: "text",
								text: `Failed to apply code suggestion to ${task.file}: ${err?.message || err}`,
							},
						],
						isError: true,
					};
				}
			}

			// Send reply and resolve thread on GitHub
			try {
				let replyBody = message;
				if (acceptSuggestion && !message.toLowerCase().includes("suggestion")) {
					replyBody = `${message}\n\nApplied suggested changes.`;
				}

				await replyToReviewThread(task.threadId, replyBody, ctx.cwd);
				await resolveReviewThread(task.threadId, ctx.cwd);

				manager.markResolved(task.threadId);
				updateStatusUI(ctx.ui);

				const suggestionNote = acceptSuggestion ? " Applied suggestion to code." : "";
				return {
					content: [
						{
							type: "text",
							text: `Conversation ${task.conversationId} resolved successfully.${suggestionNote}`,
						},
					],
				};
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Error resolving conversation ${task.conversationId}: ${err?.message || err}`,
						},
					],
					isError: true,
				};
			}
		},
	});

	// Tool 3: pr_task_detail
	pi.registerTool({
		name: "pr_task_detail",
		label: "PR Task Detail",
		description: "Retrieves the full detail of a PR conversation task including all replies and suggestions.",
		parameters: Type.Object({
			conversation_id: Type.Union([Type.String(), Type.Number()], {
				description: "The conversation ID / task ID to inspect",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			const rawId = (params as any)?.conversation_id ?? (params as any)?.conversationId;
			let task = manager.findTask(rawId);
			if (!task) {
				await syncAllPRs(ctx.cwd);
				task = manager.findTask(rawId);
			}

			if (!task) {
				return {
					content: [{ type: "text", text: `Error: Conversation ${rawId} not found.` }],
					isError: true,
				};
			}

			const formatted = formatTaskDetail(task);
			return {
				content: [{ type: "text", text: formatted }],
			};
		},
	});

	// Tool 4: pr_task_blocked
	pi.registerTool({
		name: "pr_task_blocked",
		label: "Mark PR Task Blocked",
		description:
			"Marks a PR conversation task as blocked when human intervention is required, posting the reason as a reply.",
		parameters: Type.Object({
			conversation_id: Type.Union([Type.String(), Type.Number()], {
				description: "The conversation ID / task ID to mark as blocked",
			}),
			reason: Type.String({
				description: "Detailed reason why human assistance or clarification is needed",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			const rawId = (params as any)?.conversation_id ?? (params as any)?.conversationId;
			const reason = String((params as any)?.reason || "").trim();

			if (!rawId || !reason) {
				return {
					content: [{ type: "text", text: "Error: conversation_id and reason are required." }],
					isError: true,
				};
			}

			let task = manager.findTask(rawId);
			if (!task) {
				await syncAllPRs(ctx.cwd);
				task = manager.findTask(rawId);
			}

			if (!task) {
				return {
					content: [{ type: "text", text: `Error: Conversation ${rawId} not found.` }],
					isError: true,
				};
			}

			try {
				const replyComment = await replyToReviewThread(task.threadId, reason, ctx.cwd);
				manager.markBlocked(task.threadId, reason, replyComment.id);
				updateStatusUI(ctx.ui);

				return {
					content: [
						{
							type: "text",
							text: `Conversation ${task.conversationId} is now marked as Blocked. When a user replies to this conversation, it will be automatically unblocked.`,
						},
					],
				};
			} catch (err: any) {
				return {
					content: [
						{
							type: "text",
							text: `Error marking conversation ${task.conversationId} as blocked: ${err?.message || err}`,
						},
					],
					isError: true,
				};
			}
		},
	});

	// Slash Command: /tasks
	pi.registerCommand("tasks", {
		description: "PR conversation tasks controls (subcommands: list, detail <id>, resolve <id> <reason>, reply <id> <msg>)",
		handler: async (args, ctx) => {
			lastUIContext = ctx.ui;
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			await syncAllPRs(ctx.cwd);
			updateStatusUI(ctx.ui);

			if (!sub || sub === "list") {
				const showAll = parts[1]?.toLowerCase() === "all";
				if (ctx.mode === "tui" && ctx.hasUI) {
					await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
						return new PRTasksDashboardComponent(theme, manager, () => done());
					});
				} else {
					const allTasks = manager.getAllTasks();
					const tasks = showAll ? allTasks : manager.getOpenTasks();
					const formatted = formatTaskSummary(tasks, allTasks.length);
					ctx.ui.notify(formatted, "info");
				}
				return;
			}

			if (sub === "detail") {
				const taskId = parts[1];
				if (!taskId) {
					ctx.ui.notify("Please specify a task ID: /tasks detail <taskId>", "warning");
					return;
				}
				const task = manager.findTask(taskId);
				if (!task) {
					ctx.ui.notify(`Task #${taskId} not found.`, "warning");
					return;
				}
				ctx.ui.notify(formatTaskDetail(task), "info");
				return;
			}

			if (sub === "resolve") {
				const taskId = parts[1];
				const reasonMatch = trimmed.match(/^resolve\s+\S+\s+(?:"([^"]+)"|'([^']+)'|(.+))$/i);
				const reason = reasonMatch ? (reasonMatch[1] || reasonMatch[2] || reasonMatch[3])?.trim() : "";

				if (!taskId || !reason) {
					ctx.ui.notify('Usage: /tasks resolve <taskId> "<reason>"', "warning");
					return;
				}

				const task = manager.findTask(taskId);
				if (!task) {
					ctx.ui.notify(`Task #${taskId} not found.`, "warning");
					return;
				}

				try {
					await replyToReviewThread(task.threadId, reason, ctx.cwd);
					await resolveReviewThread(task.threadId, ctx.cwd);
					manager.markResolved(task.threadId);
					updateStatusUI(ctx.ui);
					ctx.ui.notify(`Task #${task.conversationId} resolved successfully.`, "info");
				} catch (err: any) {
					ctx.ui.notify(`Failed to resolve task #${taskId}: ${err?.message || err}`, "error");
				}
				return;
			}

			if (sub === "reply") {
				const taskId = parts[1];
				const msgMatch = trimmed.match(/^reply\s+\S+\s+(?:"([^"]+)"|'([^']+)'|(.+))$/i);
				const replyMsg = msgMatch ? (msgMatch[1] || msgMatch[2] || msgMatch[3])?.trim() : "";

				if (!taskId || !replyMsg) {
					ctx.ui.notify('Usage: /tasks reply <taskId> "<message>"', "warning");
					return;
				}

				const task = manager.findTask(taskId);
				if (!task) {
					ctx.ui.notify(`Task #${taskId} not found.`, "warning");
					return;
				}

				try {
					await replyToReviewThread(task.threadId, replyMsg, ctx.cwd);
					await syncAllPRs(ctx.cwd);
					updateStatusUI(ctx.ui);
					ctx.ui.notify(`Reply posted to task #${task.conversationId}.`, "info");
				} catch (err: any) {
					ctx.ui.notify(`Failed to reply to task #${taskId}: ${err?.message || err}`, "error");
				}
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand '${sub}'. Available subcommands: list [all], detail <id>, resolve <id> "<reason>", reply <id> "<message>"`,
				"warning",
			);
		},
	});
}
