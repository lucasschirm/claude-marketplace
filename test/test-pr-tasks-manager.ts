// Run with: node --test test/test-pr-tasks-manager.ts
import { test } from "node:test";
import * as assert from "node:assert";
import { PRTasksManager, formatTaskDetail, isListedDeadThread, sameReplyBody } from "../extensions/lib/pr-tasks-manager.ts";
import {
	isStaleNodeError,
	describeGhError,
	withLatestComments,
	applyCodeSuggestion,
	extractCodeSuggestion,
	type GitHubReviewThreadNode,
} from "../extensions/lib/github-review-threads.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface ThreadOpts {
	id: string;
	dbId?: number;
	path?: string;
	line?: number;
	body?: string;
	author?: string;
	isResolved?: boolean;
	createdAt?: string;
	replies?: Array<{ id: string; body: string; author?: string }>;
}

// Blocks a task the way pr_task_blocked does: the block reply is posted (recorded) first
function block(m: PRTasksManager, id: string): void {
	m.addReply(id, { id: "PRRC_block", body: "Need input", author: "bot", createdAt: "2026-10-08T18:00:00Z" });
	m.markBlocked(id, "Need input");
}

function thread(opts: ThreadOpts): GitHubReviewThreadNode {
	const replies = (opts.replies || []).map((r, idx) => ({
		id: r.id,
		databaseId: 9000 + idx,
		body: r.body,
		createdAt: "2026-10-08T18:00:00Z",
		author: { login: r.author || "reviewer_dan" },
	}));
	return {
		id: opts.id,
		isResolved: Boolean(opts.isResolved),
		isOutdated: false,
		path: opts.path || "src/a.ts",
		line: opts.line ?? 10,
		originalLine: opts.line ?? 10,
		startLine: null,
		originalStartLine: null,
		comments: {
			nodes: [
				{
					id: `C_${opts.id}`,
					databaseId: opts.dbId,
					body: opts.body ?? "Please fix this",
					createdAt: opts.createdAt ?? "2026-10-08T17:00:00Z",
					author: { login: opts.author || "reviewer_alice" },
				},
				...replies,
			],
		},
	};
}

test("re-links a task when its thread node ID changes but the root comment is the same", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 })]);

	const { newTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_new", dbId: 100 })]);

	assert.strictEqual(newTasks.length, 0);
	assert.strictEqual(m.getAllTasks().length, 1);
	const task = m.findTask("100");
	assert.strictEqual(task?.threadId, "PRRT_new");
	assert.strictEqual(task?.status, "UNRESOLVED");
	assert.strictEqual(m.findTask("PRRT_new"), task);
	assert.strictEqual(m.findTask("PRRT_old"), undefined);
});

test("re-linked thread that is already resolved upstream resolves the task", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 })]);

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_new", dbId: 100, isResolved: true })]);

	assert.strictEqual(m.findTask("100")?.status, "RESOLVED");
	assert.strictEqual(m.getUnresolvedTasks().length, 0);
});

test("re-links a re-posted comment (new root ID) by file, author, and body; the old ID stays an alias", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100, line: 10 })]);

	const { newTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_new", dbId: 200, line: 14, isResolved: true }),
	]);

	assert.strictEqual(newTasks.length, 0);
	assert.strictEqual(m.getAllTasks().length, 1);
	const task = m.findTask("100");
	assert.strictEqual(task?.threadId, "PRRT_new");
	assert.strictEqual(task?.conversationId, "200");
	assert.deepStrictEqual(task?.aliasIds, ["100"]);
	assert.strictEqual(m.findTask("200"), task);
	assert.strictEqual(task?.status, "RESOLVED");
});

test("a re-post with an edited body is a new task; the old one goes STALE", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100, line: 10, body: "Fix it" })]);

	const { newTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_new", dbId: 200, line: 10, body: "Fix it, please" }),
	]);

	assert.deepStrictEqual(newTasks.map((t) => t.conversationId), ["200"]);
	assert.strictEqual(m.findTask("100")?.status, "STALE");
	assert.strictEqual(m.findTask("200")?.status, "UNRESOLVED");
});

test("ambiguous replacements are not merged: the old task goes STALE and the new threads are tracked", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100, line: 10 })]);

	const { newTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_a", dbId: 200, line: 20 }),
		thread({ id: "PRRT_b", dbId: 300, line: 30 }),
	]);

	assert.strictEqual(newTasks.length, 2);
	assert.strictEqual(m.findTask("100")?.status, "STALE");
	assert.strictEqual(m.findTask("200")?.status, "UNRESOLVED");
	assert.strictEqual(m.findTask("300")?.status, "UNRESOLVED");
});

test("two orphans matching one new thread are not merged", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_x", dbId: 100, line: 10 }),
		thread({ id: "PRRT_y", dbId: 101, line: 12 }),
	]);

	const { newTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_new", dbId: 200, line: 40 })]);

	assert.strictEqual(newTasks.length, 1);
	assert.strictEqual(m.findTask("100")?.status, "STALE");
	assert.strictEqual(m.findTask("101")?.status, "STALE");
});

test("a resolved task is never re-linked to a new matching thread", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100, isResolved: true })]);

	const { newTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_new", dbId: 200 })]);

	assert.strictEqual(newTasks.length, 1);
	assert.strictEqual(m.findTask("100")?.status, "RESOLVED");
	assert.strictEqual(m.findTask("100")?.threadId, "PRRT_old");
	assert.strictEqual(m.findTask("200")?.status, "UNRESOLVED");
});

test("a vanished thread marks open and blocked tasks STALE, excluded from unresolved and open tasks", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_1", dbId: 100, path: "src/a.ts" }),
		thread({ id: "PRRT_2", dbId: 101, path: "src/b.ts" }),
	]);
	block(m, "101");

	m.syncFromGitHubThreads(1, []);

	assert.strictEqual(m.findTask("100")?.status, "STALE");
	assert.strictEqual(m.findTask("101")?.status, "STALE");
	assert.strictEqual(m.findTask("101")?.blockedReason, "Need input");
	assert.strictEqual(m.getUnresolvedTasks().length, 0);
	assert.strictEqual(m.getVisibleTasks().length, 2);
	assert.deepStrictEqual(m.getCounts(), { open: 0, blocked: 0, resolved: 0, stale: 2, total: 2 });
	assert.match(formatTaskDetail(m.findTask("100")!), /\*\*Stale Reason\*\*: Review thread PRRT_1 no longer exists on PR #1/);
});

test("a STALE task recovers when its thread reappears", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	m.syncFromGitHubThreads(1, []);
	assert.strictEqual(m.findTask("100")?.status, "STALE");

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);

	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
	assert.strictEqual(m.findTask("100")?.staleReason, undefined);
});

test("syncing one PR never marks another PR's tasks STALE", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	m.syncFromGitHubThreads(2, [thread({ id: "PRRT_2", dbId: 200 })]);

	m.syncFromGitHubThreads(2, []);

	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
	assert.strictEqual(m.findTask("200")?.status, "STALE");
});

test("isStaleNodeError recognizes GitHub's unresolvable node ID errors only", () => {
	const ghError = Object.assign(new Error("Command failed: gh api graphql"), {
		stderr: "gh: Could not resolve to a node with the global id of 'PRRT_kwDOQ-abc'",
	});
	assert.strictEqual(isStaleNodeError(ghError), true);
	assert.strictEqual(
		isStaleNodeError(new Error('Failed to add reply to review thread: {"errors":[{"type":"NOT_FOUND"}]}')),
		false,
	);
	assert.strictEqual(isStaleNodeError(new Error("gh: HTTP 502 Bad Gateway")), false);
	assert.strictEqual(isStaleNodeError(undefined), false);
});

test("a task GitHub rejected as a dead node stays STALE while the list still shows that node", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_dead", dbId: 100 })]);
	m.markStale("100", "Review thread PRRT_dead no longer resolves on GitHub.", { deadThread: true });

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_dead", dbId: 100 })]);
	assert.strictEqual(m.findTask("100")?.status, "STALE");

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_live", dbId: 100 })]);
	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
	assert.strictEqual(m.findTask("100")?.threadId, "PRRT_live");
});

test("a dead node listed beside its replacement re-links to the replacement without a duplicate", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_dead", dbId: 100 })]);
	m.markStale("100", "rejected", { deadThread: true });

	const { newTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_dead", dbId: 100 }),
		thread({ id: "PRRT_live", dbId: 100 }),
	]);

	assert.strictEqual(newTasks.length, 0);
	assert.strictEqual(m.getAllTasks().length, 1);
	assert.strictEqual(m.findTask("100")?.threadId, "PRRT_live");
	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
});

test("a sync refreshes the line range, body, and suggestion from the current node", () => {
	const m = new PRTasksManager();
	const old = thread({ id: "PRRT_old", dbId: 100, line: 12, body: "Use this\n```suggestion\nold\n```" });
	old.startLine = 10;
	m.syncFromGitHubThreads(1, [old]);

	const rotated = thread({ id: "PRRT_new", dbId: 100, line: 16, body: "Use this\n```suggestion\nnew\n```" });
	rotated.startLine = 14;
	m.syncFromGitHubThreads(1, [rotated]);

	const task = m.findTask("100");
	assert.strictEqual(task?.threadId, "PRRT_new");
	assert.strictEqual(task?.startLine, 14);
	assert.strictEqual(task?.line, 16);
	assert.strictEqual(task?.suggestion, "new\n");
	assert.strictEqual(task?.message, "Use this\n```suggestion\nnew\n```");
});

test("a BLOCKED task that briefly goes STALE comes back BLOCKED", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	block(m, "100");
	m.syncFromGitHubThreads(1, []);
	assert.strictEqual(m.findTask("100")?.status, "STALE");

	const { unblockedTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_1", dbId: 100, replies: [{ id: "PRRC_block", body: "Need input", author: "bot" }] }),
	]);

	assert.strictEqual(m.findTask("100")?.status, "BLOCKED");
	assert.strictEqual(unblockedTasks.length, 0);
});

test("replies the agent saw before blocking do not unblock the task; a later reply does", () => {
	const m = new PRTasksManager();
	const before = [{ id: "PRRC_early", body: "also this" }];
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, replies: before })]);
	m.markShown("100", m.findTask("100")!.replies);
	block(m, "100");

	const blockReply = { id: "PRRC_block", body: "Need input", author: "bot" };
	let res = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, replies: [...before, blockReply] })]);
	assert.strictEqual(res.unblockedTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.status, "BLOCKED");

	res = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_1", dbId: 100, replies: [...before, blockReply, { id: "PRRC_answer", body: "Here you go" }] }),
	]);
	assert.strictEqual(res.unblockedTasks[0]?.latestReply.id, "PRRC_answer");
	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
});

test("a BLOCKED task re-linked to a re-posted comment is reopened, without a fake user-reply notice", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 })]);
	block(m, "100");

	const res = m.syncFromGitHubThreads(1, [
		thread({
			id: "PRRT_new",
			dbId: 200,
			createdAt: "2026-10-09T09:00:00Z",
			replies: [{ id: "PRRC_block_copy", body: "Need input", author: "bot" }],
		}),
	]);

	assert.strictEqual(res.unblockedTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
	assert.strictEqual(m.findTask("100")?.blockedReason, undefined);
	assert.strictEqual(m.findTask("100")?.threadId, "PRRT_new");
});

test("a re-post never re-links to an already STALE task: it is tracked as a new task", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })]);
	m.markStale("100", "rejected", { deadThread: true });

	const { newTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_A", dbId: 100 }),
		thread({ id: "PRRT_B", dbId: 200 }),
	]);

	assert.deepStrictEqual(newTasks.map((t) => t.threadId), ["PRRT_B"]);
	assert.strictEqual(m.findTask("100")?.status, "STALE");
	assert.strictEqual(m.findTask("200")?.status, "UNRESOLVED");
});

test("a thread listed without comments keeps its task from going STALE", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	const empty = thread({ id: "PRRT_1", dbId: 100 });
	empty.comments.nodes = [];

	m.syncFromGitHubThreads(1, [empty]);

	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
});

test("a re-issued thread keeps a user reply posted after blocking as new (matched by author and body)", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 })]);
	m.addReply("100", { id: "PRRC_block", body: "Need input", author: "bot", createdAt: "2026-10-08T18:00:00Z" });
	block(m, "100");

	const { unblockedTasks } = m.syncFromGitHubThreads(1, [
		thread({
			id: "PRRT_new",
			dbId: 100,
			replies: [
				{ id: "PRRC_block_v2", body: "Need input", author: "bot" },
				{ id: "PRRC_answer_v2", body: "Here you go" },
			],
		}),
	]);

	assert.strictEqual(unblockedTasks[0]?.latestReply.id, "PRRC_answer_v2");
});

test("a node for an aliased root comment is matched to its task instead of creating a duplicate", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 })]);
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_new", dbId: 200 })]);

	const { newTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_new", dbId: 200 }), thread({ id: "PRRT_old", dbId: 100 })]);

	assert.strictEqual(newTasks.length, 0);
	assert.strictEqual(m.getAllTasks().length, 1);
});

test("re-keying keeps the task order", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 }), thread({ id: "PRRT_2", dbId: 101, path: "src/b.ts" })]);

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1b", dbId: 100 }), thread({ id: "PRRT_2", dbId: 101, path: "src/b.ts" })]);

	assert.deepStrictEqual(m.getAllTasks().map((t) => t.threadId), ["PRRT_1b", "PRRT_2"]);
});

test("isResolvedUpstream tracks GitHub's state separately from a local resolve", () => {
	const m = new PRTasksManager({ reopenGraceMs: 0 });
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	m.markResolved("100");

	assert.strictEqual(m.findTask("100")?.status, "RESOLVED");
	assert.strictEqual(m.findTask("100")?.isResolvedUpstream, false);
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, isResolved: true })]);
	assert.strictEqual(m.findTask("100")?.isResolvedUpstream, true);
});

test("a same-root node ID change keeps a reply posted after blocking, which unblocks the task", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 })]);
	block(m, "100");

	const replies = [
		{ id: "PRRC_block", body: "Need input", author: "bot" },
		{ id: "PRRC_answer", body: "Here you go" },
	];
	const { unblockedTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_new", dbId: 100, replies })]);

	assert.strictEqual(unblockedTasks[0]?.latestReply.id, "PRRC_answer");
	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
});

test("a dead-node STALE task recovers on new activity or resolves upstream", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_d", dbId: 100 }), thread({ id: "PRRT_e", dbId: 101, path: "src/e.ts" })]);
	m.markStale("100", "rejected", { deadThread: true });
	m.markStale("101", "rejected", { deadThread: true });

	m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_d", dbId: 100, replies: [{ id: "PRRC_new", body: "still relevant" }] }),
		thread({ id: "PRRT_e", dbId: 101, path: "src/e.ts", isResolved: true }),
	]);

	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
	assert.strictEqual(m.findTask("101")?.status, "RESOLVED");
});

test("isStaleNodeError ignores the command line in execFile errors, which embeds the reply body", () => {
	const err = Object.assign(new Error("Command failed: gh api graphql -F body=Could not resolve to a node with the global id"), {
		stderr: "gh: HTTP 502 Bad Gateway",
		stdout: "",
	});
	assert.strictEqual(isStaleNodeError(err), false);
});

test("the agent's own reply on a BLOCKED task does not unblock it", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	block(m, "100");
	m.addReply("100", { id: "PRRC_own", body: "Done", author: "bot", createdAt: "2026-10-08T19:00:00Z" });

	const { unblockedTasks } = m.syncFromGitHubThreads(1, [
		thread({
			id: "PRRT_1",
			dbId: 100,
			replies: [
				{ id: "PRRC_block", body: "Need input", author: "bot" },
				{ id: "PRRC_own", body: "Done", author: "bot" },
			],
		}),
	]);

	assert.strictEqual(unblockedTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.status, "BLOCKED");
});

test("describeGhError falls back to the message when gh produced no output", () => {
	const err = Object.assign(new Error("spawn gh ENOENT"), { stderr: "", stdout: "" });
	assert.strictEqual(describeGhError(err), "spawn gh ENOENT");
});

test("two nodes for the same root comment on a first sync create a single task", () => {
	const m = new PRTasksManager();
	const { newTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 }), thread({ id: "PRRT_new", dbId: 100 })]);

	assert.strictEqual(newTasks.length, 1);
	assert.strictEqual(m.getAllTasks().length, 1);
});

test("after markDeadThread, a re-sync listing the dead node first still moves the task to the live node", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 })]);
	m.markDeadThread("100");

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 }), thread({ id: "PRRT_new", dbId: 100 })]);

	assert.strictEqual(m.findTask("100")?.threadId, "PRRT_new");
	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
	assert.strictEqual(m.getAllTasks().length, 1);
});

test("a reappearing original thread does not pull a re-linked task away from its re-post", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_2", dbId: 200 })]);

	const { newTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 }), thread({ id: "PRRT_2", dbId: 200 })]);

	assert.strictEqual(newTasks.length, 0);
	assert.strictEqual(m.findTask("200")?.threadId, "PRRT_2");
});

test("an outdated multi-line thread keeps its original line range", () => {
	const m = new PRTasksManager();
	const outdated = thread({ id: "PRRT_1", dbId: 100 });
	Object.assign(outdated, { isOutdated: true, line: null, startLine: null, originalLine: 15, originalStartLine: 10 });

	m.syncFromGitHubThreads(1, [outdated]);

	assert.strictEqual(m.findTask("100")?.startLine, 10);
	assert.strictEqual(m.findTask("100")?.line, 15);
});

test("a reply the agent was never shown is reported as unseen and does not join the block baseline", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, replies: [{ id: "PRRC_answer", body: "Use B" }] })]);

	assert.deepStrictEqual(m.getUnseenReplies("100").map((r) => r.id), ["PRRC_answer"]);
	block(m, "100");
	const { unblockedTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_1", dbId: 100, replies: [{ id: "PRRC_answer", body: "Use B" }, { id: "PRRC_block", body: "Need input", author: "bot" }] }),
	]);
	assert.strictEqual(unblockedTasks[0]?.latestReply.id, "PRRC_answer");
});

test("markShown records the comment (and so the suggestion) the agent saw", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, body: "x\n```suggestion\nA\n```" })]);
	assert.strictEqual(m.findTask("100")?.seenMessage, undefined);

	m.markShown("100");
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, body: "x\n```suggestion\nB\n```" })]);

	assert.strictEqual(m.findTask("100")?.seenMessage, "x\n```suggestion\nA\n```");
	assert.strictEqual(m.findTask("100")?.suggestion, "B\n");
});

test("a reviewer's repeated identical reply still unblocks a BLOCKED task", () => {
	const m = new PRTasksManager();
	const ok = { id: "PRRC_ok1", body: "ok" };
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, replies: [ok] })]);
	m.markShown("100", m.findTask("100")!.replies);
	block(m, "100");

	const { unblockedTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_1", dbId: 100, replies: [ok, { id: "PRRC_block", body: "Need input", author: "bot" }, { id: "PRRC_ok2", body: "ok" }] }),
	]);

	assert.strictEqual(unblockedTasks[0]?.latestReply.id, "PRRC_ok2");
});

test("a re-opened thread brings its task back, including a STALE task resolved locally", () => {
	const m = new PRTasksManager({ reopenGraceMs: 0 });
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, isResolved: true }), thread({ id: "PRRT_2", dbId: 101, path: "src/b.ts" })]);
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, isResolved: true })]);
	m.markResolved("101"); // the agent cleared the STALE task

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 }), thread({ id: "PRRT_2", dbId: 101, path: "src/b.ts" })]);

	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
	assert.strictEqual(m.findTask("101")?.status, "UNRESOLVED");
});

test("a thread listed without comments brings back a STALE task", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	m.syncFromGitHubThreads(1, []);
	assert.strictEqual(m.findTask("100")?.status, "STALE");

	m.syncFromGitHubThreads(1, [{ ...thread({ id: "PRRT_1", dbId: 100 }), comments: { nodes: [] } }]);
	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
});

test("a rejected thread ID stays rejected after the task changes status, whatever the list order", () => {
	for (const order of ["dead-first", "live-first"]) {
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(1, [thread({ id: "PRRT_old", dbId: 100 })]);
		m.markDeadThread("100");
		m.syncFromGitHubThreads(1, [thread({ id: "PRRT_new", dbId: 100 })]);
		block(m, "100");

		const nodes = [thread({ id: "PRRT_old", dbId: 100 }), thread({ id: "PRRT_new", dbId: 100 })];
		const { newTasks } = m.syncFromGitHubThreads(1, order === "dead-first" ? nodes : nodes.reverse());

		assert.strictEqual(newTasks.length, 0, order);
		assert.strictEqual(m.findTask("100")?.threadId, "PRRT_new", order);
		assert.strictEqual(m.findTask("100")?.status, "BLOCKED", order);
	}
});

test("a thread list fetched before a local resolve does not reopen the task; a later one does", () => {
	const m = new PRTasksManager({ reopenGraceMs: 0 });
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);

	const before = m.beginFetch();
	m.markResolved("100", { upstream: true });
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })], before);
	assert.strictEqual(m.findTask("100")?.status, "RESOLVED");
	assert.strictEqual(m.findTask("100")?.isResolvedUpstream, true);

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })], m.beginFetch());
	assert.strictEqual(m.findTask("100")?.status, "UNRESOLVED");
});

test("an agent reply a sync lists before the reply call returns does not unblock the task", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	block(m, "100");

	const done = m.expectOwnReply("100", "Still need input");
	const replies = [
		{ id: "PRRC_block", body: "Need input", author: "bot" },
		{ id: "PRRC_again", body: "Still need input", author: "bot" },
	];
	const { unblockedTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, replies })]);
	done();
	m.addReply("100", { id: "PRRC_again", body: "Still need input", author: "bot", createdAt: "2026-10-08T18:00:00Z" });

	assert.strictEqual(unblockedTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.status, "BLOCKED");
	assert.strictEqual(m.findTask("100")?.replies.filter((r) => r.id === "PRRC_again").length, 1);
});

test("an applied suggestion is remembered across resolve and re-open, so it is never applied twice", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	const task = m.findTask("100")!;
	task.appliedSuggestion = "const x = 1;";

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, isResolved: true })]);
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	assert.strictEqual(task.status, "UNRESOLVED");
	assert.strictEqual(task.appliedSuggestion, "const x = 1;");
});

test("a commentless dead node never pins a task when a live replacement for its root is listed", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_T1", dbId: 100 })]);
	m.markDeadThread("100");

	m.syncFromGitHubThreads(1, [{ ...thread({ id: "PRRT_T1", dbId: 100 }), comments: { nodes: [] } }, thread({ id: "PRRT_T2", dbId: 100 })]);
	assert.strictEqual(m.findTask("100")?.threadId, "PRRT_T2");
});

test("a thread GitHub accepts again is no longer dead, and its STALE task is restored", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_T1", dbId: 100 })]);
	block(m, "100");
	m.markStale("100", "rejected", { deadThread: true });

	m.threadAccepted("100", "PRRT_T1");
	assert.strictEqual(m.findTask("100")?.status, "BLOCKED");
	assert.deepStrictEqual(m.findTask("100")?.deadThreadIds, []);
});

test("a resolve's posted reply is remembered through a STALE spell, so a later retry doesn't post it again", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })]);
	const task = m.findTask("100")!;
	task.resolveReply = { author: "bot" };

	m.markStale(task, "rejected", { deadThread: true });
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_B", dbId: 100 })]);
	assert.strictEqual(task.status, "UNRESOLVED");
	assert.deepStrictEqual(task.resolveReply, { author: "bot" });

	m.markResolved(task, { upstream: true });
	assert.strictEqual(task.resolveReply, undefined);
});

test("a thread list fetched before the last applied one is ignored", () => {
	const m = new PRTasksManager();
	const older = m.beginFetch();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, isResolved: true })], m.beginFetch());

	const { newTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 }), thread({ id: "PRRT_2", dbId: 200 })], older);
	assert.strictEqual(newTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.status, "RESOLVED");
	assert.strictEqual(m.findTask("200"), undefined);
});

test("a STALE task on a rejected thread is only worth retrying while GitHub still lists that thread", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })]);
	m.markStale("100", "rejected", { deadThread: true });

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })]);
	assert.strictEqual(isListedDeadThread(m.findTask("100")!), true);

	m.syncFromGitHubThreads(1, []);
	assert.strictEqual(m.findTask("100")?.status, "STALE");
	assert.strictEqual(isListedDeadThread(m.findTask("100")!), false);
});

test("a resolved thread listed without comments records GitHub's resolve", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	m.syncFromGitHubThreads(1, [{ ...thread({ id: "PRRT_1", dbId: 100, isResolved: true }), comments: { nodes: [] } }]);

	assert.strictEqual(m.findTask("100")?.status, "RESOLVED");
	assert.strictEqual(m.findTask("100")?.isResolvedUpstream, true);
	assert.strictEqual(m.findTask("100")?.message, "Please fix this");
});

test("reply bodies compare equal across line-ending and surrounding-whitespace differences", () => {
	assert.strictEqual(sameReplyBody("Done\r\n\r\nApplied suggested changes. ", "Done\n\nApplied suggested changes."), true);
	assert.strictEqual(sameReplyBody("Done", "Done!"), false);
});

test("a BLOCKED task reopened by a re-post is reported, so the agent learns its block was dropped", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })]);
	block(m, "100");

	const { repostedTasks, unblockedTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_B", dbId: 200, createdAt: "2026-10-09T09:00:00Z" }),
	]);
	assert.deepStrictEqual(repostedTasks.map((t) => t.conversationId), ["200"]);
	assert.strictEqual(unblockedTasks.length, 0);
});

test("a replacement thread re-issuing the root comment ID (same creation time) keeps a BLOCKED task blocked", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })]);
	block(m, "100");

	const res = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_B", dbId: 200, replies: [{ id: "PRRC_block_copy", body: "Need input", author: "bot" }] }),
	]);
	const task = m.findTask("200");
	assert.strictEqual(task?.status, "BLOCKED");
	assert.strictEqual(task?.blockedReason, "Need input");
	assert.strictEqual(task?.threadId, "PRRT_B");
	assert.strictEqual(res.repostedTasks.length, 0);
	assert.strictEqual(res.unblockedTasks.length, 0);
});

test("a deleted root comment on the same thread keeps the original request instead of adopting the first reply", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [
		thread({
			id: "PRRT_A",
			dbId: 100,
			body: "```suggestion\nfixed();\n```",
			replies: [{ id: "PRRC_bot", body: "Looking into it", author: "bot" }],
		}),
	]);
	assert.strictEqual(m.findTask("100")?.hasSuggestion, true);

	// GitHub now lists the agent's reply first
	const node = thread({ id: "PRRT_A", dbId: 9000, body: "Looking into it", author: "bot", createdAt: "2026-10-08T18:00:00Z" });
	node.comments.nodes[0].id = "PRRC_bot";
	m.syncFromGitHubThreads(1, [node]);

	const task = m.findTask("100");
	assert.ok(task);
	assert.strictEqual(task.conversationId, "100");
	assert.strictEqual(task.author, "reviewer_alice");
	assert.strictEqual(task.message, "```suggestion\nfixed();\n```");
	assert.strictEqual(task.hasSuggestion, false); // withdrawn with the comment
	assert.deepStrictEqual(task.replies.map((r) => r.id), ["PRRC_bot"]);
	assert.strictEqual(task.status, "UNRESOLVED");
});

test("the agent's own block reply keeps counting as seen across a thread replacement, even if a list dropped it", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })]);
	const stale = m.beginFetch(); // a poll fetching before the block reply exists
	block(m, "100");
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })], stale);
	assert.strictEqual(m.findTask("100")?.replies.length, 0);

	const { unblockedTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_B", dbId: 100, replies: [{ id: "PRRC_block_v2", body: "Need input", author: "bot" }] }),
	]);
	assert.strictEqual(unblockedTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.status, "BLOCKED");
});

test("overlapping agent replies on one task are each recognized as the agent's", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	block(m, "100");
	const doneA = m.expectOwnReply("100", "First");
	m.expectOwnReply("100", "Second");
	doneA();

	const replies = [
		{ id: "PRRC_block", body: "Need input", author: "bot" },
		{ id: "PRRC_second", body: "Second", author: "bot" },
	];
	const { unblockedTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, replies })]);
	assert.strictEqual(unblockedTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.status, "BLOCKED");
});

test("describeGhError shortens huge gh output", () => {
	const err = Object.assign(new Error("Command failed"), { stderr: "x".repeat(10000), stdout: "" });
	assert.ok(describeGhError(err).length < 2100);
	assert.ok(describeGhError(err).endsWith("(truncated)"));
});

test("a reappearing earlier root comment keeps the task's state: no re-post reset or notice", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_X", dbId: 100 })]);
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_Y", dbId: 200 })]); // re-post: re-linked to 200, alias 100
	block(m, "200");
	m.syncFromGitHubThreads(1, []); // the re-post vanishes: STALE, blocked state kept

	const { repostedTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_X", dbId: 100 })]);
	assert.strictEqual(repostedTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.status, "BLOCKED");
	assert.strictEqual(m.findTask("100")?.blockedReason, "Need input");
});

test("describeGhError reports Node errors and stopped processes instead of partial output", () => {
	const overflow = Object.assign(new Error("stdout maxBuffer length exceeded"), {
		code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
		stdout: '{"data":{"repository"',
		stderr: "",
	});
	assert.strictEqual(describeGhError(overflow), "stdout maxBuffer length exceeded");
	const killed = Object.assign(new Error("Command failed: gh api graphql -f body=secret"), {
		code: null,
		killed: true,
		signal: "SIGTERM",
		stdout: "partial",
		stderr: "",
	});
	assert.strictEqual(describeGhError(killed), "gh was stopped (SIGTERM), e.g. by its timeout");
	assert.match(describeGhError(Object.assign(killed, { mayHaveApplied: true })), /may already be on GitHub$/);
});

test("a thread with more than 100 comments keeps its root comment and its newest replies", () => {
	const node = thread({ id: "PRRT_1", dbId: 100, replies: [{ id: "PRRC_1", body: "old" }] });
	const merged = withLatestComments(node, [node.comments.nodes[1], { ...node.comments.nodes[1], id: "PRRC_newest", body: "new" }]);
	assert.deepStrictEqual(merged.comments.nodes.map((c) => c.id), ["C_PRRT_1", "PRRC_1", "PRRC_newest"]);
});

test("a changed root comment on the same thread node is not taken for a re-post", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	block(m, "100");

	const { repostedTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 101, body: "Need input" })]);
	assert.strictEqual(repostedTasks.length, 0);
	assert.strictEqual(m.findTask("101")?.status, "BLOCKED");
});

test("the agent's own replies never count as unseen; a reply that unblocked the task stays unseen", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	block(m, "100");
	const replies = [
		{ id: "PRRC_block", body: "Need input", author: "bot" },
		{ id: "PRRC_answer", body: "Use B" },
	];
	const { unblockedTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, replies })]);
	assert.strictEqual(unblockedTasks.length, 1);
	assert.deepStrictEqual(m.getUnseenReplies("100").map((r) => r.id), ["PRRC_answer"]);
});

test("a task whose rejected thread is still listed is not re-linked to a same-text comment on another line", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100, line: 10, body: "Same here" })]);
	m.markDeadThread("100");

	const { newTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_A", dbId: 100, line: 10, body: "Same here" }),
		thread({ id: "PRRT_B", dbId: 200, line: 80, body: "Same here" }),
	]);
	assert.strictEqual(m.findTask("100")?.threadId, "PRRT_A");
	assert.deepStrictEqual(newTasks.map((t) => t.threadId), ["PRRT_B"]);
});

test("describeGhError keeps only the error messages of a GraphQL error response", () => {
	const err = Object.assign(new Error("Command failed: gh api graphql"), {
		code: 1,
		stderr: "gh: GraphQL error",
		stdout: JSON.stringify({ data: { repository: { huge: "x".repeat(5000) } }, errors: [{ message: "Field broke" }] }),
	});
	assert.strictEqual(describeGhError(err), "gh: GraphQL error\nField broke");
	const stale = Object.assign(new Error("Command failed"), {
		code: 1,
		stderr: "",
		stdout: JSON.stringify({ errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id of 'X'" }] }),
	});
	assert.strictEqual(isStaleNodeError(stale), true);
});

test("a reply re-issued with CRLF line endings still carries over as the same reply", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })]);
	m.addReply("100", { id: "PRRC_block", body: "Need\ninput", author: "bot", createdAt: "2026-10-08T18:00:00Z" });
	m.markBlocked("100", "Need input");

	const { unblockedTasks } = m.syncFromGitHubThreads(1, [
		thread({ id: "PRRT_B", dbId: 100, replies: [{ id: "PRRC_block_v2", body: "Need\r\ninput ", author: "bot" }] }),
	]);
	assert.strictEqual(unblockedTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.status, "BLOCKED");
});

test("applyCodeSuggestion replaces exactly the range and keeps every other line ending", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-tasks-apply-"));
	const file = path.join(dir, "f.txt");
	const cases: Array<[string, number, number, string, string]> = [
		["a\nb\nc\n", 2, 2, "B\n", "a\nB\nc\n"],
		["a\r\nb\r\nc\r\n", 2, 2, "B\n", "a\r\nB\r\nc\r\n"],
		["a\nb\r\nc\n", 1, 1, "A\n", "A\nb\r\nc\n"],
		["a\nb\nc", 3, 3, "C1\nC2\n", "a\nb\nC1\nC2"],
		["a\nb\nc\nd\n", 2, 3, "X\n", "a\nX\nd\n"],
		["a\nb\nc\n", 2, 3, "", "a\n"],
		["a\nb", 2, 2, "", "a"],
		["a\nb\nc", 2, 3, "", "a"],
	];
	try {
		for (const [input, start, end, suggestion, expected] of cases) {
			fs.writeFileSync(file, input);
			await applyCodeSuggestion(file, start, end, suggestion, dir);
			assert.strictEqual(fs.readFileSync(file, "utf-8"), expected, JSON.stringify([input, start, end]));
		}
		fs.writeFileSync(file, "a\nb");
		await assert.rejects(applyCodeSuggestion(file, 3, 4, "x\n", dir), /not in the file/);
		await assert.rejects(applyCodeSuggestion(file, 0, 1, "x\n", dir), /not in the file/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a pending agent reply is not matched to a user's reply with the same text once the agent's login is known", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	block(m, "100"); // records the agent's login ("bot")
	const done = m.expectOwnReply("100", "Done.");
	const replies = [
		{ id: "PRRC_block", body: "Need input", author: "bot" },
		{ id: "PRRC_user", body: "Done.", author: "reviewer_dan" },
	];
	const { unblockedTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, replies })]);
	done();
	assert.strictEqual(unblockedTasks[0]?.latestReply.id, "PRRC_user");
});

test("a file-level thread is marked so its placeholder line is never used to apply a suggestion", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [{ ...thread({ id: "PRRT_1", dbId: 100 }), line: null, originalLine: null }]);
	assert.strictEqual(m.findTask("100")?.isFileLevel, true);
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_2", dbId: 200 })]);
	assert.strictEqual(m.findTask("200")?.isFileLevel, false);
});

test("a re-post whose body differs only in line endings re-links the task", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100, body: "Fix this\nplease" })]);
	const { newTasks } = m.syncFromGitHubThreads(1, [thread({ id: "PRRT_B", dbId: 200, body: "Fix this\r\nplease\r\n" })]);
	assert.strictEqual(newTasks.length, 0);
	assert.strictEqual(m.findTask("100")?.threadId, "PRRT_B");
});

test("right after a local resolve, a list still showing the thread open does not reopen it", () => {
	const m = new PRTasksManager({ reopenGraceMs: 60_000 });
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	m.markResolved("100", { upstream: true });

	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]); // a lagging read
	assert.strictEqual(m.findTask("100")?.status, "RESOLVED");
	assert.strictEqual(m.findTask("100")?.isResolvedUpstream, true);
});

test("a re-post never takes over a task whose thread is listed without its comments", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_X", dbId: 100 })]);
	const { newTasks } = m.syncFromGitHubThreads(1, [
		{ ...thread({ id: "PRRT_X", dbId: 100 }), comments: { nodes: [] } },
		thread({ id: "PRRT_Z", dbId: 200 }),
	]);
	assert.strictEqual(m.findTask("100")?.threadId, "PRRT_X");
	assert.deepStrictEqual(newTasks.map((t) => t.threadId), ["PRRT_Z"]);
});

test("within the reopen grace window, a list showing the thread resolved is still recorded", () => {
	const m = new PRTasksManager({ reopenGraceMs: 60_000 });
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100 })]);
	m.markResolved("100"); // cleared locally
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, isResolved: true })]);
	assert.strictEqual(m.findTask("100")?.isResolvedUpstream, true);
});

test("showing only replies never marks the suggestion or comment as seen", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [thread({ id: "PRRT_1", dbId: 100, body: "Use\n```suggestion\nB\n```", replies: [{ id: "PRRC_1", body: "hm" }] })]);
	const task = m.findTask("100")!;
	m.markRepliesShown(task, task.replies);
	assert.strictEqual(task.seenMessage, undefined);
	assert.deepStrictEqual(m.getUnseenReplies(task), []);
	m.markShown(task);
	assert.strictEqual(task.seenMessage, task.message);
});

test("a file-level thread is shown as the whole file, not line 1", () => {
	const m = new PRTasksManager();
	m.syncFromGitHubThreads(1, [{ ...thread({ id: "PRRT_1", dbId: 100, path: "src/a.ts" }), line: null, originalLine: null }]);
	assert.match(formatTaskDetail(m.findTask("100")!), /\*\*File\*\*: src\/a\.ts \(whole file\)/);
});

test("a suggestion fenced with more backticks keeps the ``` lines inside it", () => {
	const body = "Use this:\n````suggestion\nconst doc = `\n```js\nx();\n```\n`;\n````\nThanks";
	assert.deepStrictEqual(extractCodeSuggestion(body), {
		hasSuggestion: true,
		suggestion: "const doc = `\n```js\nx();\n```\n`;\n",
	});
	assert.deepStrictEqual(extractCodeSuggestion("```suggestion\nfoo\n```"), { hasSuggestion: true, suggestion: "foo\n" });
	assert.deepStrictEqual(extractCodeSuggestion("```suggestion```"), { hasSuggestion: true, suggestion: "" });
	assert.deepStrictEqual(extractCodeSuggestion("no suggestion"), { hasSuggestion: false });
	// (a closing fence is a line of its own)
	assert.deepStrictEqual(extractCodeSuggestion('```suggestion\nconst s = "```";\n```'), {
		hasSuggestion: true,
		suggestion: 'const s = "```";\n',
	});
	assert.deepStrictEqual(extractCodeSuggestion("```suggestion\r\nfoo\r\n  ```  \r\nbye"), { hasSuggestion: true, suggestion: "foo\r\n" });
	assert.deepStrictEqual(extractCodeSuggestion("```suggestion\n```"), { hasSuggestion: true, suggestion: "" });
});

test("a task whose root comment was deleted still follows its thread through a replacement", () => {
	for (const variant of ["replaced", "re-issued IDs", "dead node listed", "deleted and replaced at once", "deleted and replaced at once, re-issued IDs"]) {
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(1, [thread({ id: "PRRT_A", dbId: 100 })]);
		block(m, "100");
		const leading = (id: string, dbId: number, commentId: string) => {
			const node = thread({ id, dbId, body: "Need input", author: "bot", createdAt: "2026-10-08T18:00:00Z" });
			node.comments.nodes[0].id = commentId;
			return node;
		};
		// the root comment is deleted (seen by a sync, unless both happen between two syncs)
		if (!variant.startsWith("deleted and replaced")) m.syncFromGitHubThreads(1, [leading("PRRT_A", 9000, "PRRC_block")]);

		const replacement =
			variant.endsWith("re-issued IDs") ? leading("PRRT_B", 9500, "PRRC_block_new") : leading("PRRT_B", 9000, "PRRC_block");
		const nodes = [replacement];
		if (variant === "dead node listed") {
			m.markStale("100", "rejected", { deadThread: true });
			nodes.unshift(leading("PRRT_A", 9000, "PRRC_block"));
		}
		const res = m.syncFromGitHubThreads(1, nodes);

		const tasks = m.getAllTasks(1);
		assert.strictEqual(tasks.length, 1, variant);
		assert.strictEqual(tasks[0].conversationId, "100", variant);
		assert.strictEqual(tasks[0].threadId, "PRRT_B", variant);
		assert.strictEqual(tasks[0].message, "Please fix this", variant);
		assert.strictEqual(tasks[0].author, "reviewer_alice", variant);
		assert.strictEqual(tasks[0].status, "BLOCKED", variant);
		assert.strictEqual(res.repostedTasks.length + res.unblockedTasks.length + res.newTasks.length, 0, variant);
	}
});
