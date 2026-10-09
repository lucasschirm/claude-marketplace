import {
	type GitHubReviewThreadNode,
	type GitHubCommentNode,
	extractCodeSuggestion,
} from "./github-review-threads.ts";

export type TaskStatus = "UNRESOLVED" | "BLOCKED" | "RESOLVED";

export interface PRTaskReply {
	id: string;
	databaseId?: number;
	body: string;
	author: string;
	createdAt: string;
}

export interface PRTask {
	threadId: string;
	databaseId?: number;
	conversationId: string;
	prNumber: number;
	file: string;
	startLine?: number;
	line: number;
	originalLine?: number;
	originalStartLine?: number;
	isOutdated: boolean;
	status: TaskStatus;
	blockedReason?: string;
	blockedAt?: string;
	lastReplyIdAtBlock?: string;
	author: string;
	createdAt: string;
	message: string;
	hasSuggestion: boolean;
	suggestion?: string;
	replies: PRTaskReply[];
}

export interface TaskCounts {
	open: number;
	blocked: number;
	resolved: number;
	total: number;
}

export class PRTasksManager {
	private tasks = new Map<string, PRTask>(); // key is threadId

	public clear(): void {
		this.tasks.clear();
	}

	public getAllTasks(prNumber?: number): PRTask[] {
		const all = Array.from(this.tasks.values());
		if (prNumber !== undefined) {
			return all.filter((t) => t.prNumber === prNumber);
		}
		return all;
	}

	public getUnresolvedTasks(prNumber?: number): PRTask[] {
		return this.getAllTasks(prNumber).filter((t) => t.status === "UNRESOLVED");
	}

	public getOpenTasks(prNumber?: number): PRTask[] {
		// Open tasks include UNRESOLVED and BLOCKED
		return this.getAllTasks(prNumber).filter((t) => t.status === "UNRESOLVED" || t.status === "BLOCKED");
	}

	public findTask(id: string | number): PRTask | undefined {
		const cleanId = String(id).replace(/^#/, "").trim();
		for (const task of this.tasks.values()) {
			if (
				task.threadId === cleanId ||
				task.conversationId === cleanId ||
				String(task.databaseId) === cleanId
			) {
				return task;
			}
		}
		return undefined;
	}

	public getCounts(prNumber?: number): TaskCounts {
		const tasks = this.getAllTasks(prNumber);
		let open = 0;
		let blocked = 0;
		let resolved = 0;

		for (const t of tasks) {
			if (t.status === "UNRESOLVED") open++;
			else if (t.status === "BLOCKED") blocked++;
			else if (t.status === "RESOLVED") resolved++;
		}

		return {
			open,
			blocked,
			resolved,
			total: tasks.length,
		};
	}

	/**
	 * Syncs tasks from fresh GitHub review thread nodes.
	 * Identifies newly discovered tasks and unblocked tasks that received user replies.
	 */
	public syncFromGitHubThreads(
		prNumber: number,
		nodes: GitHubReviewThreadNode[],
	): {
		newTasks: PRTask[];
		unblockedTasks: Array<{ task: PRTask; latestReply: PRTaskReply }>;
	} {
		const newTasks: PRTask[] = [];
		const unblockedTasks: Array<{ task: PRTask; latestReply: PRTaskReply }> = [];

		for (const node of nodes) {
			const comments = node.comments?.nodes || [];
			if (comments.length === 0) continue;

			const rootComment = comments[0];
			const rootDbId = rootComment.databaseId;
			const conversationId = rootDbId ? String(rootDbId) : node.id;
			const rootAuthor = rootComment.author?.login || "unknown";
			const rootCreatedAt = rootComment.createdAt;
			const rootBody = rootComment.body || "";

			const replies: PRTaskReply[] = comments.slice(1).map((c) => ({
				id: c.id,
				databaseId: c.databaseId,
				body: c.body || "",
				author: c.author?.login || "unknown",
				createdAt: c.createdAt,
			}));

			const { hasSuggestion, suggestion } = extractCodeSuggestion(rootBody);

			const existing = this.tasks.get(node.id);

			if (!existing) {
				const status: TaskStatus = node.isResolved ? "RESOLVED" : "UNRESOLVED";
				const newTask: PRTask = {
					threadId: node.id,
					databaseId: rootDbId,
					conversationId,
					prNumber,
					file: node.path,
					startLine: node.startLine || undefined,
					line: node.line || node.originalLine || 1,
					originalLine: node.originalLine || undefined,
					originalStartLine: node.originalStartLine || undefined,
					isOutdated: Boolean(node.isOutdated),
					status,
					author: rootAuthor,
					createdAt: rootCreatedAt,
					message: rootBody,
					hasSuggestion,
					suggestion,
					replies,
				};
				this.tasks.set(node.id, newTask);
				newTasks.push(newTask);
			} else {
				// Update existing task fields
				existing.file = node.path;
				existing.line = node.line || node.originalLine || existing.line;
				existing.isOutdated = Boolean(node.isOutdated);
				existing.replies = replies;

				if (node.isResolved) {
					existing.status = "RESOLVED";
				} else if (existing.status === "BLOCKED") {
					// Check if a new reply was posted since blocking
					const lastBlockReplyId = existing.lastReplyIdAtBlock;
					const newReplies = lastBlockReplyId
						? replies.filter(
								(r) =>
									r.id !== lastBlockReplyId &&
									String(r.databaseId) !== lastBlockReplyId,
						  )
						: replies;

					// Find latest reply not by the bot/blocker itself
					if (newReplies.length > 0) {
						const latestReply = newReplies[newReplies.length - 1];
						existing.status = "UNRESOLVED";
						existing.blockedReason = undefined;
						existing.lastReplyIdAtBlock = undefined;
						unblockedTasks.push({ task: existing, latestReply });
					}
				}
			}
		}

		return { newTasks, unblockedTasks };
	}

	public markResolved(id: string | number): PRTask | undefined {
		const task = this.findTask(id);
		if (task) {
			task.status = "RESOLVED";
			task.blockedReason = undefined;
			task.lastReplyIdAtBlock = undefined;
		}
		return task;
	}

	public markBlocked(
		id: string | number,
		reason: string,
		blockReplyId?: string,
	): PRTask | undefined {
		const task = this.findTask(id);
		if (task) {
			task.status = "BLOCKED";
			task.blockedReason = reason;
			task.blockedAt = new Date().toISOString();
			task.lastReplyIdAtBlock = blockReplyId;
		}
		return task;
	}

	public addReply(id: string | number, reply: PRTaskReply): PRTask | undefined {
		const task = this.findTask(id);
		if (task) {
			task.replies.push(reply);
		}
		return task;
	}
}

/**
 * Format task location string: e.g. path/to/file.ts@10-15 or path/to/file.ts@10
 */
export function formatTaskFileLocation(task: PRTask): string {
	if (task.startLine && task.startLine !== task.line) {
		return `${task.file}@${task.startLine}-${task.line}`;
	}
	return `${task.file}@${task.line}`;
}

/**
 * Formats a list of tasks strictly following the Task Summary template:
 *
 * **Conversation Id**: <conversation-id> (<posted-date> by <posted-user>)
 * **Conversation message**: <conversation-message>
 * **File**: <file>@<line/lines> 
 * **Status**: <conversation-state>
 * **Replies**: <number-of-replies>
 * ------
 * **Conversation Id**:...
 * ...
 *
 * -----
 *
 * Showing <count> tasks of <total-tasks>
 */
export function formatTaskSummary(tasks: PRTask[], totalTasks: number): string {
	if (tasks.length === 0) {
		return `Showing 0 tasks of ${totalTasks}`;
	}

	const taskBlocks: string[] = [];

	for (const task of tasks) {
		const dateStr = task.createdAt || "unknown";
		const lines = [
			`**Conversation Id**: ${task.conversationId} (${dateStr} by ${task.author})`,
			`**Conversation message**: ${task.message}`,
			`**File**: ${formatTaskFileLocation(task)}`,
			`**Status**: ${task.status}`,
			`**Replies**: ${task.replies.length}`,
		];
		taskBlocks.push(lines.join("\n"));
	}

	const body = taskBlocks.join("\n------\n");
	return `${body}\n\n-----\n\nShowing ${tasks.length} tasks of ${totalTasks}`;
}

/**
 * Formats a single task strictly following the Task Detail template:
 *
 * **Conversation ID**: <conversation-id> (<posted-date> by <posted-user>)
 * **Conversation message**: <conversation-message>
 * **File**: <file>@<line/lines> 
 * **Status**: <conversation state>
 * **Replies**: <number-of-replies>
 *
 * **Reply 1**: <reply-message> by <posted-user> at <posted-date>
 * **Reply 2**: ....
 */
export function formatTaskDetail(task: PRTask): string {
	const dateStr = task.createdAt || "unknown";
	const headerLines = [
		`**Conversation ID**: ${task.conversationId} (${dateStr} by ${task.author})`,
		`**Conversation message**: ${task.message}`,
		`**File**: ${formatTaskFileLocation(task)}`,
		`**Status**: ${task.status}`,
		`**Replies**: ${task.replies.length}`,
	];

	const sections: string[] = [headerLines.join("\n")];

	if (task.replies.length > 0) {
		const replyLines = task.replies.map(
			(r, idx) => `**Reply ${idx + 1}**: ${r.body} by ${r.author} at ${r.createdAt}`,
		);
		sections.push(replyLines.join("\n"));
	}

	if (task.hasSuggestion && task.suggestion !== undefined) {
		sections.push(`**Code Suggestion**:\n\`\`\`\n${task.suggestion}\n\`\`\``);
	}

	if (task.status === "BLOCKED" && task.blockedReason) {
		sections.push(`**Blocked Reason**: ${task.blockedReason}`);
	}

	return sections.join("\n\n");
}

/**
 * Formats loop nudge message sent to agent when it tries to stop with open tasks.
 */
export function formatLoopMessage(openTasks: PRTask[], totalTasks: number): string {
	const taskListFormatted = formatTaskSummary(openTasks, totalTasks);
	return (
		`You still have ${openTasks.length} of open tasks. You can resolve them using the **pr_task_resolve** tool or if you don't have all required information to solve the conversation you can use the **pr_task_blocked** to mark the conversation as blocked.\n\n` +
		`${taskListFormatted}`
	);
}
