import {
	type GitHubReviewThreadNode,
	type GitHubCommentNode,
	extractCodeSuggestion,
} from "./github-review-threads.ts";

// STALE: the tracked review thread no longer exists on GitHub (replaced or deleted, e.g. after a
// PR merge), so the task can't be replied to or resolved and must not keep nudging the agent.
export type TaskStatus = "UNRESOLVED" | "BLOCKED" | "RESOLVED" | "STALE";

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
	aliasIds?: string[]; // earlier conversation IDs, kept when the task is re-linked to a re-posted comment
	prNumber: number;
	file: string;
	startLine?: number;
	line: number;
	originalLine?: number;
	originalStartLine?: number;
	isOutdated: boolean;
	isBaseSide?: boolean; // the comment is on the base (LEFT, e.g. deleted) side of the diff
	isFileLevel?: boolean; // the comment is on the file, not on lines (its line is a placeholder)
	isResolvedUpstream: boolean; // GitHub's isResolved as of the last sync (status may also be RESOLVED locally)
	status: TaskStatus;
	blockedReason?: string;
	blockedAt?: string;
	// Reply ID lists; when GitHub replaces a thread and re-issues comment IDs, they are carried over
	// to the new IDs by author + body (see replySignature).
	blockBaseline?: string[]; // replies the agent had seen when it blocked; any other reply unblocks
	seenReplies?: string[]; // replies the agent has been shown (pr_task_detail, notifications) or wrote
	seenMessage?: string; // the root comment text (with any suggestion) the agent was last shown
	staleReason?: string;
	// Thread IDs GitHub rejected as unresolvable: such a node is the task's last choice in a sync, and
	// a STALE task stays STALE while it is still listed without new activity
	deadThreadIds?: string[];
	appliedSuggestion?: string; // the suggestion text already applied to the local file, which is never applied again
	resolveReply?: { author: string }; // a resolve posted its reply but resolving the thread failed (a same-message retry only resolves; kept until resolved)
	resolvedAt?: number; // manager tick of the last local resolve; older thread lists can't reopen the task
	resolvedAtMs?: number; // wall-clock time of the last local resolve (see reopenGraceMs)
	pendingReplyBodies?: string[]; // bodies of agent replies being posted, so a sync that lists one first doesn't treat it as a user reply
	ownReplies?: PRTaskReply[]; // replies the agent posted, kept so their IDs carry over even if a thread list missed them
	isListed?: boolean; // whether the last applied thread list showed the task's thread
	// The root comment was deleted and a former reply (replies[0]) now leads the thread: its
	// conversation IDs, which still identify this task (also through a later thread replacement)
	leadingReplyRoots?: string[];
	author: string;
	createdAt: string;
	message: string;
	hasSuggestion: boolean;
	suggestion?: string;
	replies: PRTaskReply[];
}

export interface SyncResult {
	newTasks: PRTask[];
	unblockedTasks: Array<{ task: PRTask; latestReply: PRTaskReply }>;
	repostedTasks: PRTask[]; // BLOCKED tasks reopened because the reviewer re-posted the comment
}

export interface TaskCounts {
	open: number;
	blocked: number;
	resolved: number;
	stale: number;
	total: number;
}

export class PRTasksManager {
	// A list rather than a map keyed by threadId: thread node IDs change when GitHub replaces a thread
	private tasks: PRTask[] = [];
	private clock = 0;
	private lastSync = new Map<number, number>(); // PR number -> fetch tick of the newest applied thread list
	private agentLogin?: string; // the GitHub login the agent's replies are posted as, once one was recorded
	// Right after a local resolve, GitHub's reads can still show the thread open: such a list
	// doesn't reopen the task (a real re-open is picked up by a later sync)
	private reopenGraceMs: number;

	constructor({ reopenGraceMs = 10_000 } = {}) {
		this.reopenGraceMs = reopenGraceMs;
	}

	public clear(): void {
		this.tasks = [];
		this.lastSync.clear();
	}

	public getAllTasks(prNumber?: number): PRTask[] {
		const all = [...this.tasks];
		if (prNumber !== undefined) {
			return all.filter((t) => t.prNumber === prNumber);
		}
		return all;
	}

	public getUnresolvedTasks(prNumber?: number): PRTask[] {
		return this.getAllTasks(prNumber).filter((t) => t.status === "UNRESOLVED");
	}

	public getVisibleTasks(prNumber?: number): PRTask[] {
		// Open tasks plus STALE ones, so stale conversations stay visible in listings
		return this.getAllTasks(prNumber).filter((t) => t.status !== "RESOLVED");
	}

	public findTask(id: string | number): PRTask | undefined {
		const cleanId = String(id).replace(/^#/, "").trim();
		for (const task of this.tasks) {
			if (
				task.threadId === cleanId ||
				task.conversationId === cleanId ||
				String(task.databaseId) === cleanId ||
				task.aliasIds?.includes(cleanId)
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
		let stale = 0;

		for (const t of tasks) {
			if (t.status === "UNRESOLVED") open++;
			else if (t.status === "BLOCKED") blocked++;
			else if (t.status === "RESOLVED") resolved++;
			else if (t.status === "STALE") stale++;
		}

		return {
			open,
			blocked,
			resolved,
			stale,
			total: tasks.length,
		};
	}

	/**
	 * Returns a tick to pass to `syncFromGitHubThreads` for a thread list fetched from now on. Ticks
	 * order fetches against local changes (and against each other).
	 */
	public beginFetch(): number {
		return ++this.clock;
	}

	/**
	 * Syncs tasks from fresh GitHub review thread nodes (the complete thread list of the PR).
	 * Identifies newly discovered tasks and unblocked tasks that received user replies.
	 * `fetchedAt` is the `beginFetch` tick taken before fetching `nodes` (omit for a list fetched
	 * just now). Syncs can overlap, so a list fetched before the last applied one is ignored.
	 *
	 * Review thread node IDs are not stable (a PR merge or a re-posted comment can replace the
	 * thread node), so a tracked task whose thread ID is missing from `nodes` is re-linked to its
	 * current thread (same root comment, or an unambiguous re-post of it), and marked STALE otherwise.
	 */
	public syncFromGitHubThreads(
		prNumber: number,
		nodes: GitHubReviewThreadNode[],
		fetchedAt = this.beginFetch(),
	): SyncResult {
		const result: SyncResult = { newTasks: [], unblockedTasks: [], repostedTasks: [] };
		if (fetchedAt < (this.lastSync.get(prNumber) ?? 0)) return result;
		this.lastSync.set(prNumber, fetchedAt);
		const prTasks = this.getAllTasks(prNumber);
		const seen = new Set<PRTask>();
		const deadIds = new Set(prTasks.flatMap((t) => t.deadThreadIds || []));
		const isDead = (id: string) => deadIds.has(id);
		const hasRoot = (t: PRTask, conversationId: string) =>
			t.conversationId === conversationId || Boolean(t.aliasIds?.includes(conversationId));
		const claim = (task: PRTask, node: GitHubReviewThreadNode) => {
			seen.add(task);
			this.applyThreadNode(task, node, result, fetchedAt);
		};

		// Nodes for the same root comment are one conversation (e.g. a dead node listed beside its
		// replacement): each is matched once, through one node chosen independently of list order
		const groups = new Map<string, GitHubReviewThreadNode[]>();
		const commentless: GitHubReviewThreadNode[] = [];
		for (const node of nodes) {
			if ((node.comments?.nodes || []).length === 0) {
				commentless.push(node);
				continue;
			}
			const conversationId = getConversationId(node);
			const group = groups.get(conversationId);
			if (group) group.push(node);
			else groups.set(conversationId, [node]);
		}

		const live: Array<{ conversationId: string; ids: string[]; node: GitHubReviewThreadNode }> = [];
		const dead: typeof live = [];
		for (const [conversationId, group] of groups) {
			// Prefer a node GitHub hasn't rejected, then the one a task already uses, then the newest
			const usable = group.filter((n) => !isDead(n.id));
			const pool = usable.length > 0 ? usable : group;
			const node = pool.find((n) => prTasks.some((t) => t.threadId === n.id)) ?? pool[pool.length - 1];
			(usable.length > 0 ? live : dead).push({ conversationId, ids: group.map((n) => n.id), node });
		}

		const unmatched: GitHubReviewThreadNode[] = [];
		const aliasGroups: typeof live = [];
		for (const group of live) {
			const task = prTasks.find(
				(t) => !seen.has(t) && (group.ids.includes(t.threadId) || t.conversationId === group.conversationId),
			);
			if (task) claim(task, group.node);
			else aliasGroups.push(group);
		}

		// Old root comments (aliases of re-linked tasks) only match after every exact match, so a
		// reappearing original thread never pulls a task away from its live re-post
		for (const group of aliasGroups) {
			const task = prTasks.find((t) => !seen.has(t) && t.aliasIds?.includes(group.conversationId));
			if (task) claim(task, group.node);
			// (a root comment whose task already matched another node is a dead duplicate and is skipped)
			else if (!prTasks.some((t) => hasRoot(t, group.conversationId))) unmatched.push(group.node);
		}

		// Re-link re-posted comments (same file, author, and body) to the orphaned task they replaced.
		// Only one-to-one matches with a task that was still open are accepted: a comment matching a
		// resolved or long-stale task is a fresh conversation to track.
		const isOpen = (t: PRTask) => t.status === "UNRESOLVED" || t.status === "BLOCKED";
		// A task whose rejected thread is still listed may well still be there: only a re-post on the
		// same line replaces it (not just a comment with the same text elsewhere in the file)
		// (and a task whose thread is listed without its comments still has that thread)
		const deadListed = (t: PRTask) => dead.some((g) => g.ids.some((id) => t.deadThreadIds?.includes(id)));
		const listedCommentless = (t: PRTask) => commentless.some((n) => n.id === t.threadId);
		const replaces = (node: GitHubReviewThreadNode, t: PRTask) =>
			(isRepostOf(node, t) || (node.path === t.file && continuesReplies(node, t.replies))) &&
			!listedCommentless(t) &&
			(!deadListed(t) || (node.line ?? node.originalLine) === t.line);
		for (const node of [...unmatched]) {
			const tasks = prTasks.filter((t) => !seen.has(t) && isOpen(t) && replaces(node, t));
			if (tasks.length !== 1 || unmatched.filter((n) => replaces(n, tasks[0])).length !== 1) continue;

			unmatched.splice(unmatched.indexOf(node), 1);
			claim(tasks[0], node);
		}

		// Conversations whose every node GitHub rejected match last, so a re-post claims the task first
		for (const group of dead) {
			const task = prTasks.find(
				(t) =>
					!seen.has(t) &&
					(group.ids.includes(t.threadId) ||
						group.ids.some((id) => t.deadThreadIds?.includes(id)) ||
						hasRoot(t, group.conversationId)),
			);
			if (task) claim(task, group.node);
		}

		// A thread listed without its comments still exists: it keeps a task that no node with
		// comments (such as a live replacement for a dead thread) has claimed
		for (const node of commentless) {
			const task = prTasks.find((t) => !seen.has(t) && t.threadId === node.id);
			if (task) claim(task, node);
		}

		for (const node of unmatched) {
			const newTask = createTask(prNumber, node);
			this.tasks.push(newTask);
			result.newTasks.push(newTask);
		}

		for (const orphan of prTasks.filter((t) => !seen.has(t) && isOpen(t))) {
			this.markStale(orphan, `Review thread ${orphan.threadId} no longer exists on PR #${prNumber} (replaced or deleted).`);
		}
		for (const task of prTasks) task.isListed = seen.has(task);

		return result;
	}

	/**
	 * Updates a tracked task from its current GitHub thread node.
	 */
	private applyThreadNode(
		existing: PRTask,
		node: GitHubReviewThreadNode,
		result: SyncResult,
		fetchedAt: number,
	): void {
		const previousReplies = existing.replies;
		const wasResolvedUpstream = existing.isResolvedUpstream;
		// A list fetched before our own resolve can't tell whether the thread was re-opened since
		const predatesResolve =
			existing.status === "RESOLVED" &&
			((existing.resolvedAt ?? 0) > fetchedAt || Date.now() - (existing.resolvedAtMs ?? 0) < this.reopenGraceMs);

		// A node listed without its comments only carries the thread's state
		if ((node.comments?.nodes || []).length > 0) {
			let fields = taskFieldsFromNode(node);
			const threadChanged = existing.threadId !== node.id;
			const conversationId = getConversationId(node);
			// On the same thread node, the root comment was deleted and a reply now comes first: the
			// task is still the original request (whose suggestion, if any, was withdrawn with it)
			// (also on a replacement thread, maybe with re-issued comment IDs: its comments then start with the task's replies)
			const root = node.comments.nodes[0];
			const rootDeleted =
				conversationId !== existing.conversationId &&
				(Boolean(existing.leadingReplyRoots?.includes(conversationId)) ||
					previousReplies.some((r) => r.id === root.id) ||
					continuesReplies(node, previousReplies));
			if (rootDeleted) {
				if (!existing.leadingReplyRoots?.includes(conversationId)) {
					existing.leadingReplyRoots = [...(existing.leadingReplyRoots || []), conversationId];
					existing.aliasIds = [...(existing.aliasIds || []), conversationId];
				}
				fields = {
					...fields,
					databaseId: existing.databaseId,
					author: existing.author,
					createdAt: existing.createdAt,
					message: existing.message,
					hasSuggestion: false,
					suggestion: undefined,
					replies: node.comments.nodes.map(toReply),
				};
			}
			if (threadChanged) {
				existing.threadId = node.id;
				// (the agent's own replies too, in case an older thread list dropped them from `replies`)
				const before = [...previousReplies, ...(existing.ownReplies || []).filter((r) => !previousReplies.some((p) => p.id === r.id))];
				existing.seenReplies = carryReplyIds(existing.seenReplies, before, fields.replies);
				existing.blockBaseline = carryReplyIds(existing.blockBaseline, before, fields.replies);
			}

			// Follow a re-posted root comment, keeping the old conversation ID as an alias. A re-post is
			// effectively a new comment, so it is reopened for the agent rather than inheriting a block
			// (a reappearing earlier root comment is the same conversation and keeps its state).
			if (conversationId !== existing.conversationId && !rootDeleted) {
				// (a replacement thread GitHub created for the same comment, e.g. on a merge, keeps the
				// comment's creation time; a re-post is a comment created later)
				const isRepost =
					threadChanged && !existing.aliasIds?.includes(conversationId) && root.createdAt !== existing.createdAt;
				existing.aliasIds = [...(existing.aliasIds || []).filter((id) => id !== conversationId), existing.conversationId];
				existing.conversationId = conversationId;
				// (only open tasks are re-linked to a re-post)
				if (isRepost && existing.status === "BLOCKED") {
					if (!node.isResolved) result.repostedTasks.push(existing);
					setStatus(existing, "UNRESOLVED");
				}
			}

			Object.assign(existing, fields);

			// An agent reply still being posted is the agent's, not a user reply
			// (by the agent's login once known, so a user's reply with the same text isn't taken)
			const byAgent = (r: PRTaskReply) => this.agentLogin === undefined || r.author === this.agentLogin;
			for (const pending of existing.pendingReplyBodies || []) {
				const own = existing.replies
					.filter((r) => byAgent(r) && sameReplyBody(r.body, pending) && !existing.seenReplies?.includes(r.id))
					.pop();
				if (own) this.recordOwnReply(existing, own);
			}
		}
		// (a list showing the thread resolved is always believed)
		existing.isResolvedUpstream = predatesResolve && !node.isResolved ? wasResolvedUpstream : Boolean(node.isResolved);

		if (node.isResolved) {
			if (existing.status !== "RESOLVED") setStatus(existing, "RESOLVED");
		} else if (existing.status === "RESOLVED" && !predatesResolve) {
			// The reviewer re-opened the thread, or a task resolved locally (a cleared STALE one)
			// has an open thread again
			setStatus(existing, "UNRESOLVED");
		} else if (existing.status === "STALE") {
			// A node GitHub rejected stays STALE while it is still listed, unless it shows new activity
			const seenReplies = existing.seenReplies || [];
			const hasNewActivity = existing.replies.some(
				(r) => !previousReplies.some((p) => p.id === r.id) && !seenReplies.includes(r.id),
			);
			if (!existing.deadThreadIds?.includes(node.id) || hasNewActivity) {
				// The thread is reachable again: restore the state it had before going stale
				setStatus(existing, existing.blockedReason ? "BLOCKED" : "UNRESOLVED");
			}
		}

		if (existing.status === "BLOCKED") {
			// Unblock on a reply the agent hadn't seen when it blocked
			const known = existing.blockBaseline || [];
			const newReplies = existing.replies.filter((r) => !known.includes(r.id));

			if (newReplies.length > 0) {
				const latestReply = newReplies[newReplies.length - 1];
				// (the reply stays unseen: the notification reaches the agent later, maybe after other calls)
				setStatus(existing, "UNRESOLVED");
				result.unblockedTasks.push({ task: existing, latestReply });
			}
		}
	}

	/**
	 * Marks a task RESOLVED; `upstream` records that GitHub confirmed it, so a later re-open by the
	 * reviewer brings the task back.
	 */
	public markResolved(id: TaskRef, { upstream = false } = {}): PRTask | undefined {
		const task = this.lookup(id);
		if (task) {
			setStatus(task, "RESOLVED");
			task.resolvedAt = ++this.clock;
			task.resolvedAtMs = Date.now();
			if (upstream) task.isResolvedUpstream = true;
		}
		return task;
	}

	/**
	 * Records that GitHub rejected the task's current thread ID, so syncs prefer any other node for
	 * the same conversation (or a re-post) over that one.
	 */
	public markDeadThread(id: TaskRef): PRTask | undefined {
		const task = this.lookup(id);
		if (task && !task.deadThreadIds?.includes(task.threadId)) {
			task.deadThreadIds = [...(task.deadThreadIds || []), task.threadId];
		}
		return task;
	}

	/**
	 * Records that GitHub accepted an operation on the given thread ID: it is not dead after all
	 * (an earlier rejection was transient), so a task STALE on it is restored.
	 */
	public threadAccepted(id: TaskRef, threadId: string): PRTask | undefined {
		const task = this.lookup(id);
		if (task) {
			task.deadThreadIds = task.deadThreadIds?.filter((t) => t !== threadId);
			if (task.status === "STALE" && task.threadId === threadId) {
				setStatus(task, task.blockedReason ? "BLOCKED" : "UNRESOLVED");
			}
		}
		return task;
	}

	/**
	 * Marks a task STALE, keeping any blocked state to restore if the thread comes back. Pass
	 * `deadThread` when GitHub itself rejected the task's thread ID (see markDeadThread), so a thread
	 * list that still shows the dead node doesn't reopen the task (until it is resolved or gets a new reply).
	 */
	public markStale(id: TaskRef, reason: string, { deadThread = false } = {}): PRTask | undefined {
		const task = this.lookup(id);
		if (task) {
			if (deadThread) this.markDeadThread(task);
			setStatus(task, "STALE");
			task.staleReason = reason;
		}
		return task;
	}

	/**
	 * Marks a task BLOCKED. Only replies the agent has seen (or written, like the block reply
	 * itself) form the baseline, so any other reply unblocks it.
	 */
	public markBlocked(id: TaskRef, reason: string): PRTask | undefined {
		const task = this.lookup(id);
		if (task) {
			setStatus(task, "BLOCKED");
			task.blockedReason = reason;
			task.blockedAt = new Date().toISOString();
			task.blockBaseline = [...(task.seenReplies || [])];
		}
		return task;
	}

	/**
	 * Records a reply the agent posted, so it never counts as a user reply that unblocks the task.
	 */
	public addReply(id: TaskRef, reply: PRTaskReply): PRTask | undefined {
		const task = this.lookup(id);
		if (task) {
			// (a sync may already have listed it)
			if (!task.replies.some((r) => r.id === reply.id)) task.replies.push(reply);
			task.ownReplies = [...(task.ownReplies || []), reply];
			this.agentLogin = reply.author;
			this.recordOwnReply(task, reply);
		}
		return task;
	}

	/**
	 * Records the body of an agent reply about to be posted (see PRTask.pendingReplyBodies), and
	 * returns a function that forgets it once the call has returned.
	 */
	public expectOwnReply(id: TaskRef, body: string): () => void {
		const task = this.lookup(id);
		if (!task) return () => {};
		task.pendingReplyBodies = [...(task.pendingReplyBodies || []), body];
		return () => {
			// (one entry per call: equal bodies of overlapping calls are interchangeable)
			const pending = task.pendingReplyBodies || [];
			const idx = pending.indexOf(body);
			if (idx !== -1) task.pendingReplyBodies = [...pending.slice(0, idx), ...pending.slice(idx + 1)];
		};
	}

	/**
	 * Records what the agent has been shown: the root comment (and its suggestion) always, and
	 * the given replies.
	 */
	public markShown(id: TaskRef, replies: PRTaskReply[] = []): PRTask | undefined {
		const task = this.lookup(id);
		if (task) {
			task.seenMessage = task.message;
			this.markRepliesSeen(task, replies);
		}
		return task;
	}

	/**
	 * Records that the agent has been shown the given replies (and nothing else of the task).
	 */
	public markRepliesShown(id: TaskRef, replies: PRTaskReply[]): PRTask | undefined {
		const task = this.lookup(id);
		if (task) this.markRepliesSeen(task, replies);
		return task;
	}

	/**
	 * Replies on the task the agent has not been shown yet (the agent's own count as seen).
	 */
	public getUnseenReplies(id: TaskRef): PRTaskReply[] {
		const task = this.lookup(id);
		const seen = task?.seenReplies || [];
		return task ? task.replies.filter((r) => !seen.includes(r.id)) : [];
	}

	private recordOwnReply(task: PRTask, reply: PRTaskReply): void {
		this.markRepliesSeen(task, [reply]);
		if (task.blockBaseline && !task.blockBaseline.includes(reply.id)) task.blockBaseline.push(reply.id);
	}

	private markRepliesSeen(task: PRTask, replies: PRTaskReply[]): void {
		const seen = new Set(task.seenReplies || []);
		for (const r of replies) seen.add(r.id);
		task.seenReplies = [...seen];
	}

	private lookup(id: TaskRef): PRTask | undefined {
		return typeof id === "object" ? id : this.findTask(id);
	}
}

type TaskRef = PRTask | string | number;

/**
 * True when a STALE task's thread is one GitHub rejected but still listed in the last sync: acting
 * on it is worth a real attempt, since the thread may exist (or be replaced by then).
 */
export function isListedDeadThread(task: PRTask): boolean {
	return Boolean(task.isListed && task.deadThreadIds?.includes(task.threadId));
}

/**
 * Compares reply bodies the way GitHub may store them (line endings and surrounding whitespace normalized).
 */
export function sameReplyBody(a: string, b: string): boolean {
	return normalizeBody(a) === normalizeBody(b);
}

function normalizeBody(body: string): string {
	return body.replace(/\r\n/g, "\n").trim();
}

/**
 * Identifies a reply by author and body, which stays the same when GitHub re-issues comment IDs.
 */
export function replySignature(reply: Pick<PRTaskReply, "author" | "body">): string {
	return `${reply.author}\n${normalizeBody(reply.body)}`;
}

/**
 * Carries a list of reply IDs over to a replaced thread: IDs that still exist are kept, and the
 * rest are mapped one-to-one onto new replies with the same author and body.
 */
function carryReplyIds(ids: string[] | undefined, before: PRTaskReply[], after: PRTaskReply[]): string[] | undefined {
	if (!ids) return ids;
	const kept = after.filter((r) => ids.includes(r.id)).map((r) => r.id);
	const unclaimed = after.filter((r) => !ids.includes(r.id));
	for (const old of before.filter((r) => ids.includes(r.id) && !after.some((a) => a.id === r.id))) {
		const match = unclaimed.findIndex((r) => replySignature(r) === replySignature(old));
		if (match !== -1) kept.push(unclaimed.splice(match, 1)[0].id);
	}
	return kept;
}

/**
 * Moves a task to a new status, clearing the state tied to the previous one. STALE keeps the
 * blocked state so it can be restored when the thread comes back.
 */
function setStatus(task: PRTask, status: TaskStatus): void {
	if (status !== "BLOCKED" && status !== "STALE") {
		task.blockedReason = undefined;
		task.blockBaseline = undefined;
	}
	if (status !== "STALE") task.staleReason = undefined;
	if (status === "RESOLVED") task.resolveReply = undefined;
	task.status = status;
}

function getConversationId(node: GitHubReviewThreadNode): string {
	const rootDbId = node.comments?.nodes?.[0]?.databaseId;
	return rootDbId ? String(rootDbId) : node.id;
}

function toReplies(node: GitHubReviewThreadNode): PRTaskReply[] {
	return (node.comments?.nodes || []).slice(1).map(toReply);
}

export function toReply(comment: GitHubCommentNode): PRTaskReply {
	return {
		id: comment.id,
		databaseId: comment.databaseId,
		body: comment.body || "",
		author: comment.author?.login || "unknown",
		createdAt: comment.createdAt,
	};
}

/**
 * Task fields derived from a thread node, shared by task creation and later syncs.
 */
function taskFieldsFromNode(node: GitHubReviewThreadNode) {
	const rootComment = node.comments.nodes[0];
	const rootBody = rootComment.body || "";
	const { hasSuggestion, suggestion } = extractCodeSuggestion(rootBody);

	// An outdated thread has no current range: fall back to the original one as a whole
	const current = node.line !== null && node.line !== undefined;
	return {
		databaseId: rootComment.databaseId,
		file: node.path,
		startLine: (current ? node.startLine : node.originalStartLine) || undefined,
		line: node.line || node.originalLine || 1,
		originalLine: node.originalLine || undefined,
		originalStartLine: node.originalStartLine || undefined,
		isOutdated: Boolean(node.isOutdated),
		isBaseSide: node.diffSide === "LEFT" || node.startDiffSide === "LEFT",
		isFileLevel: (node.line ?? node.originalLine ?? null) === null,
		author: rootAuthor(node),
		createdAt: rootComment.createdAt,
		message: rootBody,
		hasSuggestion,
		suggestion,
		replies: toReplies(node),
	};
}

function createTask(prNumber: number, node: GitHubReviewThreadNode): PRTask {
	return {
		...taskFieldsFromNode(node),
		threadId: node.id,
		conversationId: getConversationId(node),
		isResolvedUpstream: Boolean(node.isResolved),
		isListed: true,
		prNumber,
		status: node.isResolved ? "RESOLVED" : "UNRESOLVED",
	};
}

/**
 * True when a node looks like a re-post of the task's comment: same file, author, and root body.
 */
function isRepostOf(node: GitHubReviewThreadNode, task: PRTask): boolean {
	return node.path === task.file && rootAuthor(node) === task.author && sameReplyBody(node.comments.nodes[0].body || "", task.message);
}

/**
 * True when a node's comments start with the given replies (by ID, or by author and body), i.e. it
 * is the task's thread with its root comment deleted, so a former reply now leads it.
 */
function continuesReplies(node: GitHubReviewThreadNode, replies: PRTaskReply[]): boolean {
	const comments = node.comments.nodes.map(toReply);
	return (
		replies.length > 0 &&
		comments.length >= replies.length &&
		replies.every((r, i) => r.id === comments[i].id || replySignature(r) === replySignature(comments[i]))
	);
}

function rootAuthor(node: GitHubReviewThreadNode): string {
	return node.comments.nodes[0].author?.login || "unknown";
}

/**
 * Format task location string: e.g. path/to/file.ts@10-15 or path/to/file.ts@10
 */
export function formatTaskFileLocation(task: PRTask): string {
	if (task.isFileLevel) return `${task.file} (whole file)`;
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

	if (task.status === "STALE" && task.staleReason) {
		sections.push(`**Stale Reason**: ${task.staleReason}`);
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
