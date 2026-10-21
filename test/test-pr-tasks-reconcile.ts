import ext from "../extensions/pr-tasks.ts";
import { PRTasksManager } from "../extensions/lib/pr-tasks-manager.ts";
import { isStaleNodeError, type GitHubReviewThreadNode } from "../extensions/lib/github-review-threads.ts";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Regression tests for issue #26: tracker state must be reconciled with GitHub,
// stale thread node IDs repaired, and the open-tasks nudge must not loop.

function fail(msg: string, extra?: unknown): never {
	console.error(`FAILED: ${msg}`, extra ?? "");
	process.exit(1);
}

function assert(cond: unknown, msg: string, extra?: unknown): void {
	if (!cond) fail(msg, extra);
}

function thread(
	id: string,
	rootDbId: number,
	opts: {
		isResolved?: boolean;
		path?: string;
		line?: number;
		body?: string;
		author?: string;
		replies?: Array<{ id: string; databaseId: number; body: string; author: string }>;
	} = {},
): GitHubReviewThreadNode {
	return {
		id,
		isResolved: Boolean(opts.isResolved),
		isOutdated: false,
		path: opts.path ?? "src/app.ts",
		line: opts.line ?? 10,
		originalLine: opts.line ?? 10,
		startLine: null,
		originalStartLine: null,
		comments: {
			nodes: [
				{
					id: `PRRC_${rootDbId}`,
					databaseId: rootDbId,
					body: opts.body ?? `Please fix ${rootDbId}`,
					createdAt: "2026-10-10T10:00:00Z",
					author: { login: opts.author ?? "reviewer" },
				},
				...(opts.replies ?? []).map((r) => ({
					id: r.id,
					databaseId: r.databaseId,
					body: r.body,
					createdAt: "2026-10-10T11:00:00Z",
					author: { login: r.author },
				})),
			],
		},
	};
}

function managerTests(): void {
	const open = (m: PRTasksManager, pr: number) => m.getAllTasks(pr).filter((t) => t.status === "UNRESOLVED" || t.status === "BLOCKED");

	console.log("=== Manager: node ID rotation reconciles instead of duplicating ===");
	{
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(4957, [thread("PRRT_old", 4238375566)]);
		const res = m.syncFromGitHubThreads(4957, [
			thread("PRRT_new", 4238375566, {
				isResolved: true,
				replies: [{ id: "PRRC_fix", databaseId: 1, body: "Fixed — done", author: "dev" }],
			}),
		]);
		const all = m.getAllTasks(4957);
		assert(all.length === 1, "rotated node ID must not create a duplicate task", all);
		assert(all[0].threadId === "PRRT_new", "stored thread ID must be repaired", all[0]);
		assert(all[0].status === "RESOLVED", "upstream-resolved thread must resolve the task", all[0]);
		assert(all[0].replies.length === 1, "reply count must be refreshed", all[0]);
		assert(res.newTasks.length === 0 && res.staleTasks.length === 0, "no new or stale task reported", res);
		assert(m.findTask("PRRT_new") === all[0] && m.findTask("4238375566") === all[0], "findTask by new ID and conversation ID");
	}
	console.log("✓ rotation repaired");

	console.log("=== Manager: re-posted thread matched by path + author + message ===");
	{
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(1, [thread("PRRT_a", 500, { body: "Rename this" })]);
		const res = m.syncFromGitHubThreads(1, [thread("PRRT_b", 501, { body: "Rename this", isResolved: true })]);
		const all = m.getAllTasks(1);
		assert(all.length === 1, "re-posted thread must not duplicate the task", all);
		// The task follows the re-post's conversation ID and still answers to the original one
		assert(all[0].threadId === "PRRT_b" && m.findTask("500") === all[0] && m.findTask("501") === all[0], "re-linked, old ID kept", all[0]);
		assert(all[0].status === "RESOLVED", "re-posted resolved thread resolves the task", all[0]);
		assert(res.staleTasks.length === 0, "matched task must not be stale", res);
		// Subsequent syncs keep matching through the repaired thread ID.
		m.syncFromGitHubThreads(1, [thread("PRRT_b", 501, { body: "Rename this", isResolved: true })]);
		assert(m.getAllTasks(1).length === 1, "still a single task after another sync");
	}
	console.log("✓ re-posted thread matched");

	console.log("=== Manager: ambiguous fingerprint creates a new task ===");
	{
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(2, [thread("PRRT_x", 600, { body: "nit" }), thread("PRRT_y", 601, { body: "nit" })]);
		m.syncFromGitHubThreads(2, [thread("PRRT_z", 602, { body: "nit" })]);
		assert(m.getAllTasks(2).length === 3, "ambiguous re-post must not be merged into an arbitrary task", m.getAllTasks(2));
	}
	console.log("✓ ambiguous fingerprint left alone");

	console.log("=== Manager: a re-post of a resolved comment is a new open task ===");
	{
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(5, [thread("PRRT_r1", 900, { body: "lint: unused var", isResolved: true })]);
		const res = m.syncFromGitHubThreads(5, [thread("PRRT_r2", 901, { body: "lint: unused var" })]);
		assert(res.newTasks.length === 1 && res.newTasks[0].status === "UNRESOLVED", "re-post must be tracked as a new open task", res);
		assert(open(m, 5).length === 1 && m.findTask("900")!.status === "RESOLVED", "resolved task untouched", m.getAllTasks(5));
	}
	console.log("✓ re-post of resolved comment tracked");

	console.log("=== Manager: a thread listed without comments is not stale ===");
	{
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(6, [thread("PRRT_e", 950)]);
		const empty = { ...thread("PRRT_e", 950), comments: { nodes: [] } };
		const res = m.syncFromGitHubThreads(6, [empty]);
		assert(res.staleTasks.length === 0 && m.findTask("950")!.status === "UNRESOLVED", "listed thread must stay open", res);
	}
	console.log("✓ comment-less thread kept");

	console.log("=== Manager: syncs are scoped to their repository ===");
	{
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(7, [thread("PRRT_A", 1100)], undefined, { repo: "o/a", cwd: "/a" });
		m.syncFromGitHubThreads(7, [thread("PRRT_B", 1200)], undefined, { repo: "o/b", cwd: "/b" });
		const res = m.syncFromGitHubThreads(7, [thread("PRRT_A", 1100)], undefined, { repo: "o/a", cwd: "/a" });
		assert(res.staleTasks.length === 0, "another repo's PR with the same number must not be marked stale", res);
		assert(open(m, 7).length === 2, "both repos' tasks stay open", m.getAllTasks(7));
		const prs = m
			.getPRsToSync()
			.map((p) => `${p.cwd}|${p.prNumber}`)
			.sort();
		assert(JSON.stringify(prs) === JSON.stringify(["/a|7", "/b|7"]), "open-task PRs keep their own folder", prs);
	}
	console.log("✓ repo scoping");

	console.log("=== Manager: replies posted before blocking do not unblock ===");
	{
		const m = new PRTasksManager();
		const early = [{ id: "PRRC_e1", databaseId: 1301, body: "earlier discussion", author: "reviewer" }];
		m.syncFromGitHubThreads(8, [thread("PRRT_bl", 1300, { replies: early })]);
		// As pr_task_blocked does: the agent has seen the replies, then its block reply is recorded
		const task = m.findTask("1300")!;
		m.markShown(task, task.replies);
		m.addReply(task, { id: "PRRC_block", databaseId: 1302, body: "need info", author: "bot", createdAt: "2026-10-10T12:00:00Z" });
		m.markBlocked(task, "need info");
		// The blocking reply is not listed yet: earlier replies must not unblock.
		let res = m.syncFromGitHubThreads(8, [thread("PRRT_bl", 1300, { replies: early })]);
		assert(res.unblockedTasks.length === 0 && m.findTask("1300")!.status === "BLOCKED", "pre-block reply ignored", res);
		const withBlock = [...early, { id: "PRRC_block", databaseId: 1302, body: "need info", author: "bot" }];
		res = m.syncFromGitHubThreads(8, [thread("PRRT_bl", 1300, { replies: withBlock })]);
		assert(res.unblockedTasks.length === 0, "the blocking reply itself does not unblock", res);
		const answered = [...withBlock, { id: "PRRC_ans", databaseId: 1303, body: "here you go", author: "reviewer" }];
		res = m.syncFromGitHubThreads(8, [thread("PRRT_bl", 1300, { replies: answered })]);
		assert(res.unblockedTasks.length === 1 && res.unblockedTasks[0].latestReply.id === "PRRC_ans", "a later reply unblocks", res);
	}
	console.log("✓ blocked tasks unblock only on new replies");

	console.log("=== Manager: vanished threads become STALE, reported on the transition only ===");
	{
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(3, [thread("PRRT_1", 701), thread("PRRT_2", 702, { isResolved: true }), thread("PRRT_3", 703)]);
		m.markBlocked("703", "need info");
		// (a partial or failed fetch never reaches the manager: fetchReviewThreads throws instead)
		let res = m.syncFromGitHubThreads(3, []);
		assert(res.staleTasks.length === 2, "open + blocked tasks missing from the thread list become stale", res);
		assert(m.findTask("702")!.status === "RESOLVED", "resolved task stays resolved");
		assert(open(m, 3).length === 0 && m.getUnresolvedTasks(3).length === 0, "stale tasks are not open");
		assert(m.getCounts(3).stale === 2, "stale count", m.getCounts(3));
		res = m.syncFromGitHubThreads(3, []);
		assert(res.staleTasks.length === 0, "stale tasks are reported only on the transition", res);
		m.syncFromGitHubThreads(3, [thread("PRRT_1", 701), thread("PRRT_3", 703)]);
		assert(m.findTask("701")!.status === "UNRESOLVED", "a reappearing unresolved thread is open again");
		assert(m.findTask("703")!.status === "BLOCKED", "a reappearing blocked thread keeps its block");
	}
	console.log("✓ stale detection");

	console.log("=== Manager: a thread ID GitHub rejected keeps the task STALE until it is repaired ===");
	{
		const m = new PRTasksManager();
		m.syncFromGitHubThreads(4, [thread("PRRT_q", 801)]);
		m.markStale("801", "rejected", { deadThread: true });
		m.syncFromGitHubThreads(4, [thread("PRRT_q", 801)]);
		assert(m.findTask("801")!.status === "STALE", "re-listing the same rejected ID must not reopen the task");
		m.syncFromGitHubThreads(4, [thread("PRRT_q2", 801)]);
		const task = m.findTask("801")!;
		assert(task.status === "UNRESOLVED" && task.threadId === "PRRT_q2", "a repaired ID reopens the task", task);
	}
	console.log("✓ rejected thread IDs");

	console.log("=== isStaleNodeError ===");
	{
		const err = Object.assign(new Error("Command failed: gh api graphql"), {
			stderr: "gh: Could not resolve to a node with the global id of 'PRRT_kwDOQ-gG986rFycR'",
		});
		assert(isStaleNodeError(err), "detects stderr form");
		assert(isStaleNodeError(new Error("Could not resolve to a node with the global id of 'X'")), "detects message form");
		assert(!isStaleNodeError(new Error("HTTP 502")), "ignores unrelated errors");
		assert(!isStaleNodeError(undefined), "handles undefined");
	}
	console.log("✓ error detection");
}

export default async function (pi: any) {
	managerTests();

	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const sentMessages: string[] = [];
	const eventHandlers: Record<string, Function[]> = {};
	const notifications: Array<{ msg: string; type?: string }> = [];
	const statusUpdates: Record<string, string | undefined> = {};

	const mockUI = {
		setStatus(key: string, text: string | undefined) {
			statusUpdates[key] = text;
		},
		notify(msg: string, type?: string) {
			notifications.push({ msg, type });
		},
	};

	const mockPi = {
		...pi,
		on(event: string, handler: any) {
			(eventHandlers[event] ||= []).push(handler);
			return pi.on(event, handler);
		},
		registerTool(t: any) {
			tools[t.name] = t;
			return pi.registerTool(t);
		},
		registerCommand(name: string, opts: any) {
			commands[name] = opts;
			return pi.registerCommand(name, opts);
		},
		sendUserMessage(msg: string) {
			sentMessages.push(msg);
		},
	};

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-tasks-reconcile-"));
	const binDir = path.join(tmpDir, "bin");
	fs.mkdirSync(binDir);
	execSync("git init -b main", { cwd: tmpDir, stdio: "ignore" });
	const statePath = path.join(tmpDir, "state.json");
	const callsPath = path.join(tmpDir, "calls.log");

	// state.json: { prs: { [pr]: threads[] }, invalidIds: string[], afterFailure?: { [pr]: threads[] },
	//               failFetch?: number[] }
	// Recorded gh calls live in an append-only log, because a refresh syncs several PRs at once:
	// two mock processes read-modifying-writing one JSON file would corrupt each other (real gh has
	// no shared mutable state, so this is purely a harness concern). Small O_APPEND writes are one
	// syscall, so appends interleave safely; state.json itself is replaced atomically.
	// Mutations on IDs in invalidIds fail like GitHub does for a stale node ID;
	// the first such failure swaps in `afterFailure` (GitHub now reports the new ID).
	const mockGh = `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = ${JSON.stringify(statePath)};
const callsPath = ${JSON.stringify(callsPath)};
const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
const logCall = (c) => fs.appendFileSync(callsPath, c + "\\n");
const callCount = () => fs.readFileSync(callsPath, "utf-8").split("\\n").filter(Boolean).length;
const save = () => {
  const tmp = statePath + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, statePath);
};
const args = process.argv.slice(2);
const arg = (name) => { const a = args.find((x) => x.startsWith(name + "=")); return a ? a.slice(name.length + 1) : undefined; };

if (args[0] === "repo" && args[1] === "view") {
  const foreign = fs.realpathSync(process.cwd()).includes("pi-pr-tasks-foreign-");
  console.log(JSON.stringify({ name: foreign ? "foreign" : "pep", owner: { login: "owner" } }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ number: 101 }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "graphql") {
  const query = arg("query") || "";
  const threadId = arg("threadId");
  if (query.includes("addPullRequestReviewThreadReply") || query.includes("resolveReviewThread")) {
    const kind = query.includes("resolveReviewThread") ? "resolve" : "reply";
    logCall(kind + ":" + threadId);
    if (state.invalidIds.includes(threadId)) {
      if (state.afterFailure) { Object.assign(state.prs, state.afterFailure); delete state.afterFailure; }
      save();
      console.error("gh: Could not resolve to a node with the global id of '" + threadId + "'");
      process.exit(1);
    }
    save();
    if (kind === "resolve") {
      console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } }));
    } else {
      console.log(JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: {
        id: "PRRC_posted_" + callCount(), databaseId: 90000 + callCount(),
        body: arg("body"), createdAt: "2026-10-11T00:00:00Z", author: { login: "bot" } } } } }));
    }
    process.exit(0);
  }
  if (query.includes("reviewThreads")) {
    const pr = Number(arg("pr"));
    logCall("fetch:" + pr);
    logCall("fetchcwd:" + pr + "@" + fs.realpathSync(process.cwd()));
    save();
    if ((state.failFetch || []).includes(pr)) {
      console.log(JSON.stringify({ data: { repository: { pullRequest: null } } }));
      process.exit(0);
    }
    const nodes = state.prs[String(pr)] || [];
    console.log(JSON.stringify({ data: { repository: { pullRequest: { id: "PR_" + pr,
      reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } }));
    process.exit(0);
  }
}
process.exit(0);
`;
	fs.writeFileSync(path.join(binDir, "gh"), mockGh, { mode: 0o755 });
	process.env.PATH = `${binDir}:${process.env.PATH}`;

	const writeState = (s: any) => {
		const tmp = `${statePath}.writer.tmp`;
		fs.writeFileSync(tmp, JSON.stringify({ invalidIds: [], ...s }));
		fs.renameSync(tmp, statePath);
		// A new scenario starts its call recording from scratch (as the old in-state list did).
		fs.writeFileSync(callsPath, "");
	};
	const readState = () => {
		const s = JSON.parse(fs.readFileSync(statePath, "utf-8"));
		try {
			s.calls = fs.readFileSync(callsPath, "utf-8").split("\n").filter(Boolean);
		} catch {
			s.calls = [];
		}
		return s;
	};
	const callsOf = (prefix: string) => readState().calls.filter((c: string) => c.startsWith(prefix));

	ext(mockPi);
	const ctx: any = { cwd: tmpDir, ui: mockUI };
	// Syncs are scheduled on the lifecycle boundaries instead of awaited there (Pi must not stall),
	// so a test that just changed the mock GitHub state waits for quiescence before an awaited tool
	// call reads the result — the same ordering a real boundary produces.
	const flush = async () => {
		const settled = (globalThis as any).__PI_PR_TASKS_FLUSH__;
		if (settled && !(await settled(20_000))) throw new Error("background refreshes did not settle in time");
	};
	const hasListedTask = async (id: number) => (await list({ show_all: true })).includes(`**Conversation Id**: ${id} `);
	const list = async (params: any) => {
		await flush();
		return (await tools["pr_tasks_list"].execute("l", params, undefined, undefined, ctx)).content[0].text as string;
	};
	const settle = async () => {
		let result: any;
		for (const h of eventHandlers["agent_before_settle"] || []) {
			const r = await h({ type: "agent_before_settle" }, ctx);
			if (r) result = r;
		}
		return result;
	};

	// Scenario 1: the issue reproduction. Merged PR 4957 (not observed, not the
	// current branch PR 101) had its threads re-issued with new node IDs and
	// resolved upstream with a "Fixed —" reply.
	console.log("\n=== Scenario 1: rotated + upstream-resolved threads on an unobserved PR ===");
	writeState({
		prs: {
			"101": [],
			"4957": [thread("PRRT_FycR", 4238375566, { line: 5 }), thread("PRRT_Fycg", 4238375585, { line: 9 })],
		},
	});
	let text = await list({ pr_number: 4957 });
	assert(text.includes("Showing 2 tasks of 2"), "initial tasks tracked", text);
	const fixed = (id: string) => [{ id: `PRRC_fix_${id}`, databaseId: Number(id) + 1, body: "Fixed — applied", author: "dev" }];
	writeState({
		prs: {
			"101": [],
			"4957": [
				thread("PRRT_Fy5x", 4238375566, { line: 5, isResolved: true, replies: fixed("4238375566") }),
				thread("PRRT_Fy50", 4238375585, { line: 9, isResolved: true, replies: fixed("4238375585") }),
			],
		},
	});
	sentMessages.length = 0;
	// No pr_number: PR 4957 is neither observed nor the branch PR, yet it still
	// has open tasks, so it must be re-synced.
	text = await list({});
	assert(callsOf("fetch:4957").length > 0, "PR with open tasks must be re-synced even when unobserved", readState().calls);
	assert(text.startsWith("Showing 0 tasks of 2"), "no open tasks remain after reconciliation", text);
	text = await list({ pr_number: 4957, show_all: true });
	assert(
		(text.match(/\*\*Status\*\*: RESOLVED/g) || []).length === 2 && (text.match(/\*\*Replies\*\*: 1/g) || []).length === 2,
		"both tasks resolved with refreshed reply counts",
		text,
	);
	assert(text.includes("Showing 2 tasks of 2"), "no duplicate tasks after node ID rotation", text);
	assert(!(await settle())?.continue, "settle must not be blocked by reconciled tasks");
	assert(sentMessages.length === 0, "no nudge for reconciled tasks", sentMessages);
	console.log("✓ Scenario 1 passed");

	// Scenario 2: resolve with a stored ID that has gone stale between the
	// pre-check sync and the mutation: the mutation fails, the PR is re-synced,
	// the ID repaired, and the mutation retried on the live ID.
	console.log("\n=== Scenario 2: pr_task_resolve repairs a stale thread ID and retries ===");
	writeState({ prs: { "101": [], "200": [thread("PRRT_s2_old", 2001)] } });
	await list({ pr_number: 200 });
	writeState({
		prs: { "101": [], "200": [thread("PRRT_s2_old", 2001)] },
		invalidIds: ["PRRT_s2_old"],
		afterFailure: { "200": [thread("PRRT_s2_new", 2001)] },
	});
	let res = await tools["pr_task_resolve"].execute("r", { conversation_id: "2001", message: "Done" }, undefined, undefined, ctx);
	assert(!res.isError && res.content[0].text.includes("resolved successfully"), "resolve succeeds after repair", res.content[0].text);
	assert(
		JSON.stringify(callsOf("reply")) === JSON.stringify(["reply:PRRT_s2_old", "reply:PRRT_s2_new"]),
		"reply retried on the repaired ID",
		readState().calls,
	);
	assert(JSON.stringify(callsOf("resolve")) === JSON.stringify(["resolve:PRRT_s2_new"]), "resolved on the repaired ID", readState().calls);
	console.log("✓ Scenario 2 passed");

	// Scenario 3: the source-of-truth check — a thread already resolved upstream
	// is closed without posting anything.
	console.log("\n=== Scenario 3: resolve/blocked on an upstream-resolved thread post nothing ===");
	writeState({ prs: { "101": [], "300": [thread("PRRT_s3", 3001), thread("PRRT_s3b", 3002)] } });
	await list({ pr_number: 300 });
	writeState({
		prs: { "101": [], "300": [thread("PRRT_s3_live", 3001, { isResolved: true }), thread("PRRT_s3b_live", 3002, { isResolved: true })] },
		invalidIds: ["PRRT_s3", "PRRT_s3b"],
	});
	res = await tools["pr_task_resolve"].execute("r", { conversation_id: "3001", message: "Done" }, undefined, undefined, ctx);
	assert(!res.isError && res.content[0].text.includes("is already resolved"), "resolve reports upstream resolution", res.content[0].text);
	res = await tools["pr_task_blocked"].execute("b", { conversation_id: "3002", reason: "?" }, undefined, undefined, ctx);
	assert(!res.isError && res.content[0].text.includes("is already resolved"), "blocked reports upstream resolution", res.content[0].text);
	assert(callsOf("reply").length === 0 && callsOf("resolve").length === 0, "no mutation sent", readState().calls);
	console.log("✓ Scenario 3 passed");

	// Scenario 4: an ID that never resolves (GitHub keeps listing the broken
	// node) is retried once on a re-sync, then the task is marked STALE instead
	// of looping. It is never cleared while GitHub still lists that thread; once
	// the thread is gone, resolving it clears it without posting.
	console.log("\n=== Scenario 4: permanently unresolvable ID becomes STALE ===");
	writeState({ prs: { "101": [], "400": [thread("PRRT_broken", 4001)] }, invalidIds: ["PRRT_broken"] });
	await list({ pr_number: 400 });
	res = await tools["pr_task_blocked"].execute("b", { conversation_id: "4001", reason: "Need input" }, undefined, undefined, ctx);
	assert(!res.isError && res.content[0].text.includes("now marked as STALE"), "unresolvable ID marks the task stale", res.content[0].text);
	const s4calls = readState().calls.filter((c: string) => !c.startsWith("fetchcwd:"));
	assert(s4calls.indexOf("fetch:400", s4calls.indexOf("reply:PRRT_broken")) !== -1, "the PR was re-synced before giving up", s4calls);
	text = await list({ pr_number: 400, show_all: true });
	assert(text.includes("**Status**: STALE"), "task listed as STALE", text);
	sentMessages.length = 0;
	assert(!(await settle())?.continue && sentMessages.length === 0, "stale task does not drive the nudge", sentMessages);
	res = await tools["pr_task_resolve"].execute("r", { conversation_id: "4001", message: "Done" }, undefined, undefined, ctx);
	assert(
		!res.isError && res.content[0].text.includes("now marked as STALE"),
		"a still-listed rejected thread is retried, not cleared",
		res.content[0].text,
	);
	assert(callsOf("reply:PRRT_broken").length === 2, "resolve retried the listed thread", readState().calls);
	writeState({ prs: { "101": [], "400": [] } });
	res = await tools["pr_task_resolve"].execute("r", { conversation_id: "4001", message: "Done" }, undefined, undefined, ctx);
	assert(
		!res.isError && res.content[0].text.includes("no review thread on GitHub anymore"),
		"resolving a vanished stale task succeeds locally",
		res.content[0].text,
	);
	assert(callsOf("reply").length === 0, "nothing posted for the vanished thread", readState().calls);
	console.log("✓ Scenario 4 passed");

	// Scenario 5: a thread deleted upstream is marked STALE on the next sync,
	// reported once, and a failed fetch never marks anything stale.
	console.log("\n=== Scenario 5: vanished threads reported once; failed fetch changes nothing ===");
	writeState({ prs: { "101": [], "500": [thread("PRRT_s5", 5001)] } });
	await list({ pr_number: 500 });
	writeState({ prs: { "101": [], "500": [thread("PRRT_s5", 5001)] }, failFetch: [500] });
	await list({ pr_number: 500 });
	text = await list({ pr_number: 500 });
	assert(text.includes("**Status**: UNRESOLVED"), "failed fetch must not mark tasks stale", text);
	sentMessages.length = 0;
	writeState({ prs: { "101": [], "500": [] } });
	await list({ pr_number: 500 });
	await list({ pr_number: 500 });
	const staleNotices = sentMessages.filter((m) => m.includes("marked STALE"));
	assert(staleNotices.length === 1 && staleNotices[0].includes("5001"), "stale state reported exactly once", sentMessages);
	assert(statusUpdates["pr_tasks"]?.includes("stale"), "status bar shows stale count", statusUpdates);
	console.log("✓ Scenario 5 passed");

	// Scenario 6: the settle nudge stops after MAX_IDENTICAL_NUDGES identical
	// deliveries and resumes when the tasks change.
	console.log("\n=== Scenario 6: nudge loop is capped ===");
	writeState({ prs: { "101": [thread("PRRT_s6", 6001)] } });
	await list({ pr_number: 101 });
	const realNow = Date.now;
	let fakeNow = realNow();
	Date.now = () => (fakeNow += 5000); // step past the 1s throttle
	try {
		sentMessages.length = 0;
		notifications.length = 0;
		const outcomes: boolean[] = [];
		for (let i = 0; i < 5; i++) outcomes.push(Boolean((await settle())?.continue));
		assert(JSON.stringify(outcomes) === JSON.stringify([true, true, true, false, false]), "nudge capped after 3", outcomes);
		assert(sentMessages.filter((m) => m.includes("You still have 1 of open tasks")).length === 3, "3 nudges delivered", sentMessages);
		assert(notifications.filter((n) => n.msg.includes("no longer blocking")).length === 1, "cap notice shown once", notifications);

		writeState({
			prs: { "101": [thread("PRRT_s6", 6001, { replies: [{ id: "PRRC_r", databaseId: 6100, body: "any update?", author: "reviewer" }] })] },
		});
		// settle() decides from cached state (an awaited sync here would stall the agent finishing
		// its turn), so the change becomes visible once a refresh landed — an awaited tool sync is
		// the deterministic way to model that boundary.
		await list({ pr_number: 101 });
		assert((await settle())?.continue, "a change in the open tasks resumes the nudge");

		// Exhaust the cap again, then check what re-arms it.
		for (let i = 0; i < 3; i++) await settle();
		assert(!(await settle())?.continue, "capped again");
		const input = async (source: string) => {
			for (const h of eventHandlers["input"] || []) await h({ type: "input", text: "x", source }, ctx);
		};
		await input("extension");
		assert(!(await settle())?.continue, "extension input (the nudge itself) must not re-arm the cap");
		await input("interactive");
		assert((await settle())?.continue, "a new user prompt re-arms the nudge");
	} finally {
		Date.now = realNow;
	}
	console.log("✓ Scenario 6 passed");

	// Scenario 7: observed PRs sync from observe-pr's folder; a task whose
	// folder was removed (e.g. a deleted worktree) falls back to the current one.
	console.log("\n=== Scenario 7: per-PR folders, with fallback for removed folders ===");
	const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-tasks-other-"));
	const goneDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-tasks-gone-"));
	const real = (p: string) => fs.realpathSync(p);
	writeState({ prs: { "101": [], "700": [thread("PRRT_s7", 7001)], "701": [thread("PRRT_s7b", 7101)] } });
	(globalThis as any).__PI_OBSERVED_PRS__ = new Map<number, any>([
		[700, { cwd: otherDir }],
		[701, { cwd: goneDir }],
	]);
	try {
		await list({});
		assert(
			callsOf(`fetchcwd:700@`).includes(`fetchcwd:700@${real(otherDir)}`),
			"observed PR synced from its own folder",
			readState().calls,
		);
		assert(
			callsOf(`fetchcwd:701@`).includes(`fetchcwd:701@${real(goneDir)}`),
			"second observed PR synced from its folder",
			readState().calls,
		);
		// PR 701 stops being observed and its folder is removed; its open task must
		// still be reconciled, now from the current folder.
		(globalThis as any).__PI_OBSERVED_PRS__ = new Map<number, any>([[700, { cwd: otherDir }]]);
		fs.rmSync(goneDir, { recursive: true, force: true });
		writeState({
			prs: { "101": [], "700": [thread("PRRT_s7", 7001)], "701": [thread("PRRT_s7b", 7101, { isResolved: true })] },
		});
		await list({});
		assert(
			JSON.stringify(callsOf("fetchcwd:701@")) === JSON.stringify([`fetchcwd:701@${real(tmpDir)}`]),
			"removed folder falls back to the current one",
			readState().calls,
		);
		assert((await list({ pr_number: 701, show_all: true })).includes("**Status**: RESOLVED"), "task reconciled after fallback");
	} finally {
		delete (globalThis as any).__PI_OBSERVED_PRS__;
	}
	console.log("✓ Scenario 7 passed");

	// Scenario 8: a task from another repository whose folder was removed must
	// not fall back to the current folder, which would sync (and nudge about)
	// the current repo's unrelated PR with the same number.
	console.log("\n=== Scenario 8: removed folder of another repo is not replaced by the current repo ===");
	const foreignDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-tasks-foreign-"));
	const s8Body = "Use the helper\n```suggestion\nhelper();\n```";
	writeState({ prs: { "101": [], "800": [thread("PRRT_s8", 8001, { body: s8Body })] } });
	(globalThis as any).__PI_OBSERVED_PRS__ = new Map<number, any>([[800, { cwd: foreignDir }]]);
	try {
		await list({});
		assert(callsOf("fetchcwd:800@").includes(`fetchcwd:800@${real(foreignDir)}`), "foreign PR synced from its folder", readState().calls);
		(globalThis as any).__PI_OBSERVED_PRS__ = new Map<number, any>();
		fs.rmSync(foreignDir, { recursive: true, force: true });
		// The current repo has its own, unrelated PR #800.
		writeState({ prs: { "101": [], "800": [thread("PRRT_local800", 8501)] } });
		await list({});
		assert(callsOf("fetch:800").length === 0, "the current repo's PR #800 must not be synced in its place", readState().calls);
		assert(!(await hasListedTask(8501)), "no task created for the unrelated PR");
		const res = await tools["pr_task_resolve"].execute(
			"r",
			{ conversation_id: "8001", message: "Done", accept_suggestion: true },
			undefined,
			undefined,
			ctx,
		);
		assert(
			res.isError && res.content[0].text.includes("no local checkout of owner/foreign is available"),
			"a suggestion is never applied to another repo's checkout",
			res.content[0].text,
		);
		assert(callsOf("reply").length === 0, "nothing posted when the suggestion cannot be applied", readState().calls);
		assert(callsOf("fetch:800").length === 0, "the pre-check refresh is skipped too", readState().calls);
	} finally {
		delete (globalThis as any).__PI_OBSERVED_PRS__;
	}
	console.log("✓ Scenario 8 passed");

	// Scenario 9: an observed PR whose folder was removed has no known repository,
	// so it must not be synced from the current folder (which may be another repo).
	console.log("\n=== Scenario 9: removed folder of an observed PR is not replaced by the current folder ===");
	const removedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-tasks-removed-"));
	fs.rmSync(removedDir, { recursive: true, force: true });
	writeState({ prs: { "101": [], "900": [thread("PRRT_s9", 9001)] } });
	(globalThis as any).__PI_OBSERVED_PRS__ = new Map<number, any>([[900, { cwd: removedDir }]]);
	try {
		await list({});
		assert(
			callsOf("fetch:900").length === 0,
			"an observed PR with a removed folder must not be synced from the current one",
			readState().calls,
		);
		assert(!(await hasListedTask(9001)), "no task created from the current folder's PR #900");
	} finally {
		delete (globalThis as any).__PI_OBSERVED_PRS__;
	}
	console.log("✓ Scenario 9 passed");

	console.log("\n=== All PR Tasks Reconciliation Tests Passed Successfully! ===");
	process.exit(0);
}
