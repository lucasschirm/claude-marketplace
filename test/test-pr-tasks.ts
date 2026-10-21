import "./gh-fail-env.ts";
import ext from "../extensions/pr-tasks.ts";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default async function (pi: any) {
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
	const sentMessages: string[] = [];
	const eventHandlers: Record<string, Function[]> = {};
	const statusUpdates: Record<string, string | undefined> = {};
	const notifications: Array<{ msg: string; type?: string }> = [];

	let activeToolList: string[] = [];

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
			if (!eventHandlers[event]) eventHandlers[event] = [];
			eventHandlers[event].push(handler);
			return pi.on(event, handler);
		},
		registerTool(t: any) {
			tools[t.name] = t;
			if (!activeToolList.includes(t.name)) activeToolList.push(t.name);
			return pi.registerTool(t);
		},
		registerCommand(name: string, opts: any) {
			commands[name] = opts;
			return pi.registerCommand(name, opts);
		},
		getActiveTools() {
			return [...activeToolList];
		},
		setActiveTools(t: string[]) {
			activeToolList = [...t];
		},
		sendUserMessage(msg: string, _opts: any) {
			sentMessages.push(msg);
		},
	};

	// Create test environment
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-tasks-test-"));
	const binDir = path.join(tmpDir, "bin");
	fs.mkdirSync(binDir);

	// Initialize git repo
	execSync("git init -b main", { cwd: tmpDir });
	execSync("git config user.name 'Test Runner'", { cwd: tmpDir });
	execSync("git config user.email 'test@example.com'", { cwd: tmpDir });

	// Create a sample file in tmpDir to test code suggestion
	const testFilePath = path.join(tmpDir, "src", "sample.ts");
	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
	fs.writeFileSync(
		testFilePath,
		`line 1
line 2: bad code
line 3
`,
	);

	// Setup mock gh state
	const stateDir = path.join(tmpDir, "state");
	fs.mkdirSync(stateDir);

	const mockGhScript = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const stateDir = ${JSON.stringify(stateDir)};
const args = process.argv.slice(2);

if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ name: "claude-marketplace", owner: { login: "testowner" } }));
  process.exit(0);
}

if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ number: 101, state: "OPEN", isDraft: false }));
  process.exit(0);
}

function readJson(name, fallback) {
  const file = path.join(stateDir, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : fallback;
}

// Threads in reopened.json were un-resolved by the reviewer after being resolved
function writeReopened(ids) {
  fs.writeFileSync(path.join(stateDir, "reopened.json"), JSON.stringify(ids));
}

// Extra threads: extra_threads_seq.json (one list per fetch, last one sticky) or extra_threads.json
function currentExtraThreads() {
  const seq = readJson("extra_threads_seq.json", null);
  if (seq) {
    const head = seq.length > 1 ? seq.shift() : seq[0];
    fs.writeFileSync(path.join(stateDir, "extra_threads_seq.json"), JSON.stringify(seq));
    return head;
  }
  return readJson("extra_threads.json", []);
}

if (args[0] === "api" && args[1] === "graphql") {
  const queryArg = args.find(a => a.startsWith("query=")) || "";
  const threadId = (args.find(a => a.startsWith("threadId=")) || "").slice("threadId=".length);

  // A typed -F field would make gh read a body starting with "@" as a file path
  const bodyIdx = args.findIndex(a => a.startsWith("body="));
  if (bodyIdx > 0 && args[bodyIdx - 1] !== "-f") {
    console.error("mock gh: reply body must be passed as a raw -f field");
    process.exit(1);
  }

  // Thread node IDs listed in dead_ids.json no longer resolve (e.g. replaced after a PR merge)
  if (threadId && readJson("dead_ids.json", []).includes(threadId)) {
    console.log(JSON.stringify({ data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id of '" + threadId + "'" }] }));
    console.error("gh: Could not resolve to a node with the global id of '" + threadId + "'");
    process.exit(1);
  }

  // A long thread's newest comments (latest_comments.json: thread ID -> comments)
  if (queryArg.includes("node(id: $threadId)") && !queryArg.includes("mutation")) {
    console.log(JSON.stringify({ data: { node: { comments: { nodes: readJson("latest_comments.json", {})[threadId] || [] } } } }));
    process.exit(0);
  }

  if (queryArg.includes("resolveReviewThread") && readJson("dead_resolve_ids.json", []).includes(threadId)) {
    console.error("gh: Could not resolve to a node with the global id of '" + threadId + "'");
    process.exit(1);
  }

  if (queryArg.includes("resolveReviewThread") && fs.existsSync(path.join(stateDir, "resolve_fails"))) {
    console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: false } } } }));
    process.exit(0);
  }

  // A slow resolve, so a test can sync while it is in flight
  const resolveDelay = readJson("resolve_delay_ms.json", 0);
  if (queryArg.includes("resolveReviewThread") && resolveDelay) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, resolveDelay);
  }

  if (queryArg.includes("resolveReviewThread")) {
    fs.writeFileSync(path.join(stateDir, "thread_resolved"), "1");
    fs.appendFileSync(path.join(stateDir, "resolved_ids.log"), threadId + "\\n");
    writeReopened(readJson("reopened.json", []).filter(id => id !== threadId));
    console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } }));
    process.exit(0);
  }

  if (queryArg.includes("addPullRequestReviewThreadReply") && fs.existsSync(path.join(stateDir, "reply_fails"))) {
    console.error("gh: HTTP 502 Bad Gateway");
    process.exit(1);
  }

  if (queryArg.includes("addPullRequestReviewThreadReply")) {
    fs.writeFileSync(path.join(stateDir, "reply_added"), "1");
    fs.appendFileSync(path.join(stateDir, "replies.log"), threadId + "\\n");
    // Posted replies show up in later thread listings (extra threads only)
    const body = (args.find(a => a.startsWith("body=")) || "").slice("body=".length);
    const posted = readJson("posted_replies.json", []);
    const replyId = "PRRC_reply_" + (posted.length + 1);
    posted.push({ threadId, id: replyId, body });
    fs.writeFileSync(path.join(stateDir, "posted_replies.json"), JSON.stringify(posted));
    console.log(JSON.stringify({
      data: {
        addPullRequestReviewThreadReply: {
          comment: {
            id: replyId,
            databaseId: 999,
            body,
            createdAt: "2026-10-08T18:00:00Z",
            author: { login: "testbot" }
          }
        }
      }
    }));
    process.exit(0);
  }

  if (queryArg.includes("reviewThreads") && fs.existsSync(path.join(stateDir, "threads_fail"))) {
    console.error("gh: HTTP 502 Bad Gateway");
    process.exit(1);
  }

  // Other PRs (pr != 101) list only the threads in threads_pr_<n>.json
  const prArg = (args.find(a => a.startsWith("pr=")) || "").slice("pr=".length);
  if (queryArg.includes("reviewThreads") && prArg && prArg !== "101") {
    const nodes = readJson("threads_pr_" + prArg + ".json", []);
    console.log(JSON.stringify({ data: { repository: { pullRequest: { id: "PR_" + prArg, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } }));
    process.exit(0);
  }

  if (queryArg.includes("reviewThreads")) {
    const isResolved = fs.existsSync(path.join(stateDir, "thread_resolved"));
    const userReplied = fs.existsSync(path.join(stateDir, "user_replied_to_blocked"));

    const thread2Comments = [
      {
        id: "PRRC_2",
        databaseId: 1002,
        body: "Why did we write this?",
        createdAt: "2026-10-08T17:10:00Z",
        author: { login: "reviewer_bob" }
      }
    ];

    if (userReplied) {
      thread2Comments.push({
        id: "PRRC_user_reply",
        databaseId: 888,
        body: "Here is clarification for the blocker!",
        createdAt: "2026-10-08T18:05:00Z",
        author: { login: "reviewer_dan" }
      });
    }

    const resolvedIds = fs.existsSync(path.join(stateDir, "resolved_ids.log"))
      ? fs.readFileSync(path.join(stateDir, "resolved_ids.log"), "utf-8").split("\\n")
      : [];
    const posted = readJson("posted_replies.json", []);
    const reopened = readJson("reopened.json", []);
    const resolvedNow = id => resolvedIds.includes(id) && !reopened.includes(id);
    const extraThreads = currentExtraThreads().map(t => ({
      ...t,
      isResolved: t.isResolved || resolvedNow(t.id),
      comments: {
        totalCount: t.comments.totalCount,
        nodes: [
          ...t.comments.nodes,
          ...posted.filter(r => r.threadId === t.id).map(r => ({ id: r.id, databaseId: 999, body: r.body, createdAt: "2026-10-09T11:00:00Z", author: { login: "testbot" } })),
        ],
      },
    }));

    const payload = {
      data: {
        repository: {
          pullRequest: {
            id: "PR_101",
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PRRT_1",
                  isResolved: isResolved,
                  isOutdated: false,
                  path: "src/sample.ts",
                  line: 2,
                  originalLine: 2,
                  startLine: 2,
                  originalStartLine: 2,
                  comments: {
                    nodes: [
                      {
                        id: "PRRC_1",
                        databaseId: 1001,
                        body: "Please fix this line\\n\`\`\`suggestion\\nline 2: fixed code\\n\`\`\`",
                        createdAt: "2026-10-08T17:00:00Z",
                        author: { login: "reviewer_alice" }
                      }
                    ]
                  }
                },
                {
                  id: "PRRT_2",
                  isResolved: resolvedNow("PRRT_2"),
                  isOutdated: false,
                  path: "src/sample.ts",
                  line: 3,
                  originalLine: 3,
                  startLine: 3,
                  originalStartLine: 3,
                  comments: {
                    nodes: thread2Comments
                  }
                },
                ...extraThreads
              ]
            }
          }
        }
      }
    };

    console.log(JSON.stringify(payload));
    process.exit(0);
  }
}

process.exit(0);
`;
	const ghPath = path.join(binDir, "gh");
	fs.writeFileSync(ghPath, mockGhScript, { mode: 0o755 });
	process.env.PATH = `${binDir}:${process.env.PATH}`;

	console.log("=== Testing PR Tasks Extension Initialization ===");
	process.env.PI_PR_TASKS_REOPEN_GRACE_MS = "0"; // Test 17 re-opens a conversation right after resolving it
	ext(mockPi);

	const expectedTools = ["pr_tasks_list", "pr_task_resolve", "pr_task_detail", "pr_task_blocked"];
	for (const t of expectedTools) {
		if (!tools[t]) {
			console.error(`Missing expected tool: ${t}`);
			process.exit(1);
		}
	}
	if (!commands["tasks"]) {
		console.error("Missing expected slash command: tasks");
		process.exit(1);
	}
	console.log("✓ All 4 tools and /tasks slash command registered successfully");

	const toolCtx: any = { cwd: tmpDir, ui: mockUI };

	// Test 1: pr_tasks_list lists initial tasks
	console.log("\n=== Test 1: Testing pr_tasks_list ===");
	const listRes1 = await tools["pr_tasks_list"].execute("call1", {}, undefined, undefined, toolCtx);
	const listText1 = listRes1.content[0].text;
	console.log("pr_tasks_list output:\n", listText1);

	if (!listText1.includes("**Conversation Id**: 1001") || !listText1.includes("**Conversation Id**: 1002")) {
		console.error("Test 1 Failed: List did not contain conversation tasks 1001 and 1002");
		process.exit(1);
	}
	if (!listText1.includes("Showing 2 tasks of 2")) {
		console.error("Test 1 Failed: Task count footer incorrect");
		process.exit(1);
	}
	console.log("✓ Test 1 Passed: Task summary template formatted correctly");

	// Test 2: pr_task_detail
	console.log("\n=== Test 2: Testing pr_task_detail ===");
	const detailRes = await tools["pr_task_detail"].execute(
		"call2",
		{ conversation_id: "1001" },
		undefined,
		undefined,
		toolCtx,
	);
	const detailText = detailRes.content[0].text;
	console.log("pr_task_detail output:\n", detailText);

	if (!detailText.includes("**Conversation ID**: 1001") || !detailText.includes("**File**: src/sample.ts@2")) {
		console.error("Test 2 Failed: Detail text missing required header fields");
		process.exit(1);
	}
	if (!detailText.includes("**Code Suggestion**:")) {
		console.error("Test 2 Failed: Detail text missing code suggestion section");
		process.exit(1);
	}
	console.log("✓ Test 2 Passed: Task detail template formatted correctly with code suggestion");

	// Test 3: pr_task_resolve invalid suggestion acceptance
	console.log("\n=== Test 3: Testing pr_task_resolve invalid suggestion acceptance ===");
	const invalidSuggestionRes = await tools["pr_task_resolve"].execute(
		"call3",
		{ conversation_id: "1002", message: "Trying to accept", accept_suggestion: true },
		undefined,
		undefined,
		toolCtx,
	);
	console.log("Invalid suggestion result:", invalidSuggestionRes.content[0].text);
	if (!invalidSuggestionRes.isError || !invalidSuggestionRes.content[0].text.includes("does not contain any code suggestion")) {
		console.error("Test 3 Failed: Should reject accept_suggestion when task has no suggestion");
		process.exit(1);
	}
	console.log("✓ Test 3 Passed: Correctly returned error when accepting non-existent suggestion");

	// Test 4: pr_task_resolve valid suggestion acceptance and file patching
	console.log("\n=== Test 4: Testing pr_task_resolve valid suggestion acceptance ===");
	const resolveWithSuggestionRes = await tools["pr_task_resolve"].execute(
		"call4",
		{ conversation_id: "1001", message: "Resolved by applying suggestion", accept_suggestion: true },
		undefined,
		undefined,
		toolCtx,
	);
	console.log("Resolve with suggestion result:", resolveWithSuggestionRes.content[0].text);

	// Verify file was patched
	const updatedFile = fs.readFileSync(testFilePath, "utf-8");
	console.log("Updated file content:\n", updatedFile);
	if (!updatedFile.includes("line 2: fixed code")) {
		console.error("Test 4 Failed: File was not patched with suggestion replacement");
		process.exit(1);
	}
	console.log("✓ Test 4 Passed: Code suggestion accepted, applied to file, and resolved");

	// Test 5: pr_task_blocked
	console.log("\n=== Test 5: Testing pr_task_blocked ===");
	const blockedRes = await tools["pr_task_blocked"].execute(
		"call5",
		{ conversation_id: "1002", reason: "Need clarification on architectural purpose of line 3" },
		undefined,
		undefined,
		toolCtx,
	);
	console.log("Blocked result:", blockedRes.content[0].text);
	if (!blockedRes.content[0].text.includes("is now marked as Blocked")) {
		console.error("Test 5 Failed: Expected task to be marked as Blocked");
		process.exit(1);
	}
	console.log("✓ Test 5 Passed: Task successfully marked as Blocked");

	// Verify status bar UI
	console.log("Status bar after block:", statusUpdates["pr_tasks"]);
	if (!statusUpdates["pr_tasks"]?.includes("1 blocked")) {
		console.error("Test 5 Failed: Status bar did not reflect blocked task");
		process.exit(1);
	}

	// Test 6: Settle loop behavior when tasks are blocked vs unresolved
	console.log("\n=== Test 6: Testing settle loop when tasks are blocked ===");
	sentMessages.length = 0;
	// Since 1001 is resolved and 1002 is blocked, there are 0 UNRESOLVED tasks waiting for agent.
	// Therefore agent_before_settle should NOT prevent settling!
	const settleHandlers = eventHandlers["agent_before_settle"] || [];
	for (const handler of settleHandlers) {
		const res = await handler({ type: "agent_before_settle" }, toolCtx);
		if (res?.continue) {
			console.error("Test 6 Failed: Agent should be allowed to settle when remaining tasks are BLOCKED");
			process.exit(1);
		}
	}
	console.log("✓ Test 6 Passed: Agent allowed to settle when tasks are blocked");

	// Test 7: Simulating user reply to blocked conversation -> unblocks task and notifies agent
	console.log("\n=== Test 7: Testing unblocking on user reply ===");
	fs.writeFileSync(path.join(stateDir, "user_replied_to_blocked"), "1");

	// Trigger turn_end to sync. turn_end schedules the refresh instead of awaiting it (an awaited
	// sync here stalls Pi between every turn), so the test waits for the background work to settle.
	const turnEndHandlers = eventHandlers["turn_end"] || [];
	for (const handler of turnEndHandlers) {
		await handler({ type: "turn_end" }, toolCtx);
	}
	if (!(await (globalThis as any).__PI_PR_TASKS_FLUSH__(15_000))) {
		console.error("Test 7 Failed: background sync scheduled by turn_end did not finish");
		process.exit(1);
	}

	console.log("Sent agent messages after sync:", sentMessages);
	const unblockNotification = sentMessages.find((m) =>
		m.includes("The task 1002 you blocked received a reply from the user"),
	);
	if (!unblockNotification) {
		console.error("Test 7 Failed: Agent was not notified of user reply to blocked task");
		process.exit(1);
	}
	console.log("✓ Test 7 Passed: Task unblocked and agent notified:", unblockNotification);

	// Test 8: Settle loop enforcement now that 1002 is UNRESOLVED again
	console.log("\n=== Test 8: Testing settle loop enforcement with open task ===");
	sentMessages.length = 0;
	let continued = false;
	for (const handler of settleHandlers) {
		const res = await handler({ type: "agent_before_settle" }, toolCtx);
		if (res?.continue) {
			continued = true;
		}
	}

	if (!continued) {
		console.error("Test 8 Failed: agent_before_settle should prevent settle when unresolved tasks exist");
		process.exit(1);
	}
	const loopMessage = sentMessages.find((m) =>
		m.includes("You still have 1 of open tasks. You can resolve them using the **pr_task_resolve** tool"),
	);
	if (!loopMessage) {
		console.error("Test 8 Failed: Settle loop message format incorrect or not sent:", sentMessages);
		process.exit(1);
	}
	console.log("✓ Test 8 Passed: Settle loop prevented premature stop and delivered nudge:\n", loopMessage);

	// Test 9: Slash commands /tasks
	console.log("\n=== Test 9: Testing /tasks slash command ===");
	notifications.length = 0;
	const tasksCmd = commands["tasks"];
	await tasksCmd.handler("list", { ...toolCtx, mode: "headless", hasUI: false });
	console.log("/tasks list notification:", notifications[notifications.length - 1]?.msg);
	if (!notifications[notifications.length - 1]?.msg?.includes("**Conversation Id**: 1002")) {
		console.error("Test 9 Failed: /tasks list did not return task summary");
		process.exit(1);
	}

	notifications.length = 0;
	await tasksCmd.handler("detail 1002", { ...toolCtx, mode: "headless", hasUI: false });
	if (!notifications[notifications.length - 1]?.msg?.includes("**Conversation ID**: 1002")) {
		console.error("Test 9 Failed: /tasks detail did not return task detail");
		process.exit(1);
	}

	notifications.length = 0;
	await tasksCmd.handler('resolve 1002 "Resolved via command"', { ...toolCtx, mode: "headless", hasUI: false });
	if (!notifications[notifications.length - 1]?.msg?.includes("resolved successfully")) {
		console.error("Test 9 Failed: /tasks resolve did not report success");
		process.exit(1);
	}
	console.log("✓ Test 9 Passed: Slash commands executed successfully");

	// Helpers for stale review-thread node ID scenarios (issue #24)
	const mkThread = (id: string, dbId: number, file: string, body: string, opts: { isResolved?: boolean; line?: number } = {}) => ({
		id,
		isResolved: Boolean(opts.isResolved),
		isOutdated: false,
		path: file,
		line: opts.line ?? 5,
		originalLine: opts.line ?? 5,
		startLine: null,
		originalStartLine: null,
		comments: {
			nodes: [{ id: `PRRC_${id}`, databaseId: dbId, body, createdAt: "2026-10-09T10:00:00Z", author: { login: "reviewer_eve" } }],
		},
	});
	const writeState = (name: string, value: unknown) => fs.writeFileSync(path.join(stateDir, name), JSON.stringify(value));
	const readLog = (name: string) => {
		const file = path.join(stateDir, name);
		return fs.existsSync(file) ? fs.readFileSync(file, "utf-8").split("\n").filter(Boolean) : [];
	};
	const listTasks = async (showAll = false) => {
		// (a list sync is paced by the shared backoff: wait out a short degraded
		// window — e.g. right after a test's simulated 502 — so new threads get tracked)
		const health = (globalThis as any).__PI_GH_HEALTH__;
		const deadline = Date.now() + 5000;
		while (health?.status === "degraded" && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 200));
		}
		return (await tools["pr_tasks_list"].execute("list", { show_all: showAll }, undefined, undefined, toolCtx)).content[0].text as string;
	};
	const dead: string[] = [];
	const killThread = (id: string) => {
		dead.push(id);
		writeState("dead_ids.json", dead);
	};

	const t10 = mkThread("PRRT_10a", 1010, "src/rename.ts", "Rename this variable");
	const t11 = mkThread("PRRT_11a", 1011, "src/merge.ts", "Handle the null case");
	const t12 = mkThread("PRRT_12", 1012, "src/gone.ts", "Is this still needed?");
	const t13 = mkThread("PRRT_13a", 1013, "src/lag.ts", "Add a test for this");
	const t14 = mkThread("PRRT_14", 1014, "src/dead.ts", "Document this");
	writeState("extra_threads.json", [t10, t11, t12, t13, t14]);
	await listTasks();

	// Test 10: thread node ID rotated for the same root comment -> resolve replies to the current node
	console.log("\n=== Test 10: pr_task_resolve uses the current thread ID after a node ID change ===");
	const t10b = mkThread("PRRT_10b", 1010, "src/rename.ts", "Rename this variable");
	killThread("PRRT_10a");
	writeState("extra_threads.json", [t10b, t11, t12, t13, t14]);
	const res10 = await tools["pr_task_resolve"].execute("call10", { conversation_id: "1010", message: "Renamed" }, undefined, undefined, toolCtx);
	console.log("Result:", res10.content[0].text);
	if (res10.isError || !res10.content[0].text.includes("resolved successfully")) {
		console.error("Test 10 Failed: resolve should succeed against the current thread node");
		process.exit(1);
	}
	if (readLog("replies.log").includes("PRRT_10a") || !readLog("replies.log").includes("PRRT_10b") || !readLog("resolved_ids.log").includes("PRRT_10b")) {
		console.error("Test 10 Failed: reply/resolve did not target the current thread node", readLog("replies.log"));
		process.exit(1);
	}
	const all10 = await listTasks(true);
	if (all10.split("**Conversation Id**: 1010").length !== 2) {
		console.error("Test 10 Failed: node ID change produced a duplicate task:\n", all10);
		process.exit(1);
	}
	console.log("✓ Test 10 Passed: stale node ID re-linked; no duplicate task");

	// Test 11: comment re-posted on merge (new IDs) and already resolved upstream -> resolve without posting
	console.log("\n=== Test 11: pr_task_resolve on a conversation already resolved upstream ===");
	const t11b = mkThread("PRRT_11b", 2011, "src/merge.ts", "Handle the null case", { isResolved: true, line: 9 });
	killThread("PRRT_11a");
	writeState("extra_threads.json", [t10b, t11b, t12, t13, t14]);
	const repliesBefore11 = readLog("replies.log").length;
	const res11 = await tools["pr_task_resolve"].execute("call11", { conversation_id: "1011", message: "Done" }, undefined, undefined, toolCtx);
	console.log("Result:", res11.content[0].text);
	if (res11.isError || !res11.content[0].text.includes("already resolved")) {
		console.error("Test 11 Failed: expected an 'already resolved' success result");
		process.exit(1);
	}
	if (readLog("replies.log").length !== repliesBefore11) {
		console.error("Test 11 Failed: no reply should be posted to an upstream-resolved conversation");
		process.exit(1);
	}
	if (!(await listTasks(true)).includes("**Conversation Id**: 2011 (2026-10-09T10:00:00Z by reviewer_eve)\n**Conversation message**: Handle the null case\n**File**: src/merge.ts@9\n**Status**: RESOLVED")) {
		console.error("Test 11 Failed: task 1011 should be RESOLVED and re-linked to the re-posted thread (as 2011)");
		process.exit(1);
	}
	console.log("✓ Test 11 Passed: upstream resolution detected, nothing posted");

	// Test 12: thread gone entirely -> pr_task_blocked marks the task STALE and it stops nudging
	console.log("\n=== Test 12: pr_task_blocked on a thread that no longer exists ===");
	killThread("PRRT_12");
	writeState("extra_threads.json", [t10b, t11b, t13, t14]);
	const repliesBefore12 = readLog("replies.log").length;
	const res12 = await tools["pr_task_blocked"].execute("call12", { conversation_id: "1012", reason: "Need input" }, undefined, undefined, toolCtx);
	console.log("Result:", res12.content[0].text);
	if (res12.isError || !res12.content[0].text.includes("marked as STALE") || readLog("replies.log").length !== repliesBefore12) {
		console.error("Test 12 Failed: expected the task to be marked STALE without posting");
		process.exit(1);
	}
	if (!(await listTasks()).includes("**Conversation Id**: 1012 (2026-10-09T10:00:00Z by reviewer_eve)\n**Conversation message**: Is this still needed?\n**File**: src/gone.ts@5\n**Status**: STALE")) {
		console.error("Test 12 Failed: stale task should be listed with STALE status");
		process.exit(1);
	}
	if (!statusUpdates["pr_tasks"]?.includes("1 stale")) {
		console.error("Test 12 Failed: status bar should show the stale task:", statusUpdates["pr_tasks"]);
		process.exit(1);
	}
	console.log("✓ Test 12 Passed: vanished thread marked STALE");

	// Test 13: thread list lags behind (still lists the dead node) -> retry after re-sync picks up the new node
	console.log("\n=== Test 13: pr_task_resolve retries with the re-synced thread ID ===");
	const t13b = mkThread("PRRT_13b", 1013, "src/lag.ts", "Add a test for this");
	killThread("PRRT_13a");
	writeState("extra_threads_seq.json", [[t10b, t11b, t13, t14], [t10b, t11b, t13b, t14]]);
	const res13 = await tools["pr_task_resolve"].execute("call13", { conversation_id: "1013", message: "Added" }, undefined, undefined, toolCtx);
	console.log("Result:", res13.content[0].text);
	if (res13.isError || !res13.content[0].text.includes("resolved successfully") || !readLog("resolved_ids.log").includes("PRRT_13b")) {
		console.error("Test 13 Failed: expected the retry to resolve the current thread node");
		process.exit(1);
	}
	fs.rmSync(path.join(stateDir, "extra_threads_seq.json"));
	writeState("extra_threads.json", [t10b, t11b, t13b, t14]);
	console.log("✓ Test 13 Passed: stale ID error triggered a re-sync and a successful retry");

	// Test 14: node never resolves and no replacement exists -> /tasks resolve marks the task STALE
	console.log("\n=== Test 14: /tasks resolve on a node that never resolves ===");
	killThread("PRRT_14");
	notifications.length = 0;
	await tasksCmd.handler('resolve 1014 "Documented"', { ...toolCtx, mode: "headless", hasUI: false });
	const note14 = notifications[notifications.length - 1];
	console.log("Notification:", note14);
	if (note14?.type !== "warning" || !note14.msg.includes("marked as STALE")) {
		console.error("Test 14 Failed: expected a STALE warning");
		process.exit(1);
	}
	console.log("✓ Test 14 Passed: unresolvable thread marked STALE");

	// Test 15: stale tasks never block settling
	console.log("\n=== Test 15: settle loop ignores STALE tasks ===");
	await new Promise((r) => setTimeout(r, 1100)); // outlast the settle nudge throttle, so a nudge would really be sent
	sentMessages.length = 0;
	for (const handler of settleHandlers) {
		const res = await handler({ type: "agent_before_settle" }, toolCtx);
		if (res?.continue || sentMessages.some((m) => m.includes("open tasks"))) {
			console.error("Test 15 Failed: STALE tasks should not trigger the open-tasks nudge", sentMessages);
			process.exit(1);
		}
	}
	console.log("✓ Test 15 Passed: agent allowed to settle with only STALE/RESOLVED tasks");

	// Test 16: the suggestion changes upstream between review and resolve -> nothing is applied
	console.log("\n=== Test 16: pr_task_resolve refuses a suggestion that changed on GitHub ===");
	const suggestionFile = path.join(tmpDir, "src", "suggest.ts");
	fs.writeFileSync(suggestionFile, "a\nb\nc\n");
	const t16 = mkThread("PRRT_16", 1016, "src/suggest.ts", "Use\n```suggestion\nB\n```", { line: 2 });
	writeState("extra_threads.json", [t10b, t11b, t13b, t14, t16]);
	await listTasks();
	writeState("extra_threads.json", [t10b, t11b, t13b, t14, { ...t16, comments: { nodes: [{ ...t16.comments.nodes[0], body: "Use\n```suggestion\nrm -rf\n```" }] } }]);
	const res16 = await tools["pr_task_resolve"].execute("call16", { conversation_id: "1016", message: "Applied", accept_suggestion: true }, undefined, undefined, toolCtx);
	console.log("Result:", res16.content[0].text);
	if (!res16.isError || !res16.content[0].text.includes("changed on GitHub") || fs.readFileSync(suggestionFile, "utf-8") !== "a\nb\nc\n") {
		console.error("Test 16 Failed: a changed suggestion must not be applied");
		process.exit(1);
	}
	console.log("✓ Test 16 Passed: changed suggestion rejected, file untouched");

	// Test 17: the reviewer re-opens a resolved conversation -> it is open again and can be resolved again
	console.log("\n=== Test 17: a conversation re-opened by the reviewer is tracked and resolvable again ===");
	writeState("reopened.json", ["PRRT_2"]);
	if (!(await listTasks()).includes("**Conversation Id**: 1002 (2026-10-08T17:10:00Z by reviewer_bob)\n**Conversation message**: Why did we write this?\n**File**: src/sample.ts@3\n**Status**: UNRESOLVED")) {
		console.error("Test 17 Failed: the re-opened conversation should be UNRESOLVED again");
		process.exit(1);
	}
	await tools["pr_task_detail"].execute("detail17", { conversation_id: "1002" }, undefined, undefined, toolCtx); // the agent reads it again
	const repliesBefore17 = readLog("replies.log").filter((id) => id === "PRRT_2").length;
	const res17 = await tools["pr_task_resolve"].execute("call17", { conversation_id: "1002", message: "Re-resolving" }, undefined, undefined, toolCtx);
	console.log("Result:", res17.content[0].text);
	if (res17.isError || !res17.content[0].text.includes("resolved successfully") || readLog("replies.log").filter((id) => id === "PRRT_2").length !== repliesBefore17 + 1) {
		console.error("Test 17 Failed: a conversation still open on GitHub must be replied to and resolved");
		process.exit(1);
	}
	console.log("✓ Test 17 Passed: upstream-open conversation replied to and resolved");

	// Test 18: resolving fails after the reply was posted -> the retry resolves without a duplicate reply
	console.log("\n=== Test 18: pr_task_resolve retry after a failed resolve posts no duplicate reply ===");
	const t18 = mkThread("PRRT_18", 1018, "src/retry.ts", "Simplify this");
	writeState("extra_threads.json", [t10b, t11b, t13b, t14, t16, t18]);
	fs.writeFileSync(path.join(stateDir, "resolve_fails"), "1");
	const res18a = await tools["pr_task_resolve"].execute("call18a", { conversation_id: "1018", message: "Retry me" }, undefined, undefined, toolCtx);
	console.log("First result:", res18a.content[0].text);
	fs.rmSync(path.join(stateDir, "resolve_fails"));
	const repliesAfter18a = readLog("replies.log").length;
	const res18b = await tools["pr_task_resolve"].execute("call18b", { conversation_id: "1018", message: "Retry me" }, undefined, undefined, toolCtx);
	console.log("Retry result:", res18b.content[0].text);
	if (!res18a.isError || res18b.isError || !res18b.content[0].text.includes("already been posted") || readLog("replies.log").length !== repliesAfter18a) {
		console.error("Test 18 Failed: the retry should only resolve the thread");
		process.exit(1);
	}
	console.log("✓ Test 18 Passed: retry resolved the thread without re-posting");

	// Test 19: after a failed resolve, a call with a different message is a new resolution and is posted
	console.log("\n=== Test 19: a new message after a failed resolve is posted ===");
	const t19 = mkThread("PRRT_19", 1019, "src/new-msg.ts", "Explain this");
	writeState("extra_threads.json", [t10b, t11b, t13b, t14, t16, t18, t19]);
	fs.writeFileSync(path.join(stateDir, "resolve_fails"), "1");
	await tools["pr_task_resolve"].execute("call19a", { conversation_id: "1019", message: "First" }, undefined, undefined, toolCtx);
	fs.rmSync(path.join(stateDir, "resolve_fails"));
	const repliesAfter19a = readLog("replies.log").length;
	const res19 = await tools["pr_task_resolve"].execute("call19b", { conversation_id: "1019", message: "Second, different" }, undefined, undefined, toolCtx);
	console.log("Result:", res19.content[0].text);
	if (res19.isError || readLog("replies.log").length !== repliesAfter19a + 1 || res19.content[0].text.includes("already been posted")) {
		console.error("Test 19 Failed: a different message must be posted");
		process.exit(1);
	}
	console.log("✓ Test 19 Passed: new message posted");

	// Test 20: the thread node is replaced between the reply and the resolve -> the current node is resolved
	console.log("\n=== Test 20: resolve recovers from a node replaced after the reply ===");
	const t20 = mkThread("PRRT_20a", 1020, "src/race.ts", "Fix the race");
	writeState("extra_threads.json", [t10b, t11b, t13b, t14, t16, t18, t19, t20]);
	await listTasks();
	writeState("dead_resolve_ids.json", ["PRRT_20a"]);
	writeState("extra_threads_seq.json", [
		[t10b, t11b, t13b, t14, t16, t18, t19, t20],
		[t10b, t11b, t13b, t14, t16, t18, t19, mkThread("PRRT_20b", 1020, "src/race.ts", "Fix the race")],
	]);
	const res20 = await tools["pr_task_resolve"].execute("call20", { conversation_id: "1020", message: "Fixed" }, undefined, undefined, toolCtx);
	console.log("Result:", res20.content[0].text);
	if (res20.isError || !readLog("resolved_ids.log").includes("PRRT_20b")) {
		console.error("Test 20 Failed: expected the current thread node to be resolved");
		process.exit(1);
	}
	console.log("✓ Test 20 Passed: replaced node resolved after re-sync");

	// Test 21: GitHub can't be checked -> nothing is posted or changed
	console.log("\n=== Test 21: resolve refuses to act when the thread list can't be fetched ===");
	const t21 = mkThread("PRRT_21", 1021, "src/offline.ts", "Check this");
	fs.rmSync(path.join(stateDir, "extra_threads_seq.json"));
	writeState("extra_threads.json", [t10b, t11b, t13b, t14, t16, t18, t19, mkThread("PRRT_20b", 1020, "src/race.ts", "Fix the race"), t21]);
	await listTasks();
	fs.writeFileSync(path.join(stateDir, "threads_fail"), "1");
	const repliesBefore21 = readLog("replies.log").length;
	const res21 = await tools["pr_task_resolve"].execute("call21", { conversation_id: "1021", message: "Checked" }, undefined, undefined, toolCtx);
	fs.rmSync(path.join(stateDir, "threads_fail"));
	console.log("Result:", res21.content[0].text);
	if (
		!res21.isError ||
		!(res21.content[0].text.includes("could not check the conversation on GitHub") || res21.content[0].text.includes("temporarily unreachable")) ||
		readLog("replies.log").length !== repliesBefore21
	) {
		console.error("Test 21 Failed: expected an error and no reply");
		process.exit(1);
	}
	console.log("✓ Test 21 Passed: no action taken without a fresh thread list");

	// Test 22: the reply fails after the suggestion was applied -> the retry does not apply it again
	console.log("\n=== Test 22: a retry after a failed reply does not re-apply the suggestion ===");
	const multiFile = path.join(tmpDir, "src", "multi.ts");
	fs.writeFileSync(multiFile, "one\ntwo\nthree\n");
	const t22 = mkThread("PRRT_22", 1022, "src/multi.ts", "Split\n```suggestion\ntwo-a\ntwo-b\n```", { line: 2 });
	writeState("extra_threads.json", [t10b, t11b, t13b, t14, t16, t18, t19, mkThread("PRRT_20b", 1020, "src/race.ts", "Fix the race"), t21, t22]);
	await listTasks();
	fs.writeFileSync(path.join(stateDir, "reply_fails"), "1");
	const res22a = await tools["pr_task_resolve"].execute("call22a", { conversation_id: "1022", message: "Split it", accept_suggestion: true }, undefined, undefined, toolCtx);
	fs.rmSync(path.join(stateDir, "reply_fails"));
	const res22b = await tools["pr_task_resolve"].execute("call22b", { conversation_id: "1022", message: "Split it", accept_suggestion: true }, undefined, undefined, toolCtx);
	console.log("Results:", res22a.content[0].text, "|", res22b.content[0].text);
	const multi = fs.readFileSync(multiFile, "utf-8");
	if (!res22a.isError || res22b.isError || multi !== "one\ntwo-a\ntwo-b\nthree\n") {
		console.error("Test 22 Failed: the suggestion must be applied exactly once:", JSON.stringify(multi));
		process.exit(1);
	}
	console.log("✓ Test 22 Passed: suggestion applied once across retries");

	// Test 23: a reply the agent hasn't seen arrives before it blocks -> it is not blocked
	console.log("\n=== Test 23: pr_task_blocked declines when there are unseen replies ===");
	const t23 = mkThread("PRRT_23", 1023, "src/question.ts", "Which approach?");
	const base23 = [t10b, t11b, t13b, t14, t16, t18, t19, mkThread("PRRT_20b", 1020, "src/race.ts", "Fix the race"), t21, t22];
	writeState("extra_threads.json", [...base23, t23]);
	await listTasks();
	const answered23 = { ...t23, comments: { nodes: [...t23.comments.nodes, { id: "PRRC_23_answer", databaseId: 2301, body: "Use approach B", createdAt: "2026-10-09T12:00:00Z", author: { login: "reviewer_eve" } }] } };
	writeState("extra_threads.json", [...base23, answered23]);
	const repliesBefore23 = readLog("replies.log").length;
	const res23 = await tools["pr_task_blocked"].execute("call23", { conversation_id: "1023", reason: "Which one?" }, undefined, undefined, toolCtx);
	console.log("Result:", res23.content[0].text);
	if (!res23.isError || !res23.content[0].text.includes("Use approach B") || readLog("replies.log").length !== repliesBefore23) {
		console.error("Test 23 Failed: blocking must be declined and the new reply surfaced");
		process.exit(1);
	}
	console.log("✓ Test 23 Passed: unseen reply surfaced instead of blocking");

	// Test 24: resolving a task that is already STALE clears it locally
	console.log("\n=== Test 24: pr_task_resolve clears an already STALE task ===");
	const res24 = await tools["pr_task_resolve"].execute("call24", { conversation_id: "1012", message: "@alice handled elsewhere" }, undefined, undefined, toolCtx);
	console.log("Result:", res24.content[0].text);
	if (res24.isError || !res24.content[0].text.includes("now marked as resolved") || (await listTasks()).includes("**Conversation Id**: 1012")) {
		console.error("Test 24 Failed: an already STALE task should be marked resolved");
		process.exit(1);
	}
	console.log("✓ Test 24 Passed: stale task cleared");

	// Test 25: an outdated thread's suggestion is never applied by stale line numbers
	console.log("\n=== Test 25: pr_task_resolve refuses an outdated suggestion ===");
	const outdatedFile = path.join(tmpDir, "src", "outdated.ts");
	fs.writeFileSync(outdatedFile, "x\ny\n");
	const t25 = { ...mkThread("PRRT_25", 1025, "src/outdated.ts", "Use\n```suggestion\nz\n```"), isOutdated: true, line: null };
	writeState("extra_threads.json", [...base23, answered23, t25]);
	await listTasks();
	const res25 = await tools["pr_task_resolve"].execute("call25", { conversation_id: "1025", message: "Applied", accept_suggestion: true }, undefined, undefined, toolCtx);
	console.log("Result:", res25.content[0].text);
	if (!res25.isError || !res25.content[0].text.includes("outdated") || fs.readFileSync(outdatedFile, "utf-8") !== "x\ny\n") {
		console.error("Test 25 Failed: an outdated suggestion must not be applied");
		process.exit(1);
	}
	console.log("✓ Test 25 Passed: outdated suggestion refused, file untouched");

	// Test 26: an already STALE task whose rejected thread is still listed is retried, not cleared
	// (GitHub still listing the thread means it may exist)
	console.log("\n=== Test 26: pr_task_resolve retries a listed dead thread and keeps the task STALE ===");
	const res26 = await tools["pr_task_resolve"].execute("call26", { conversation_id: "1014", message: "Documented" }, undefined, undefined, toolCtx);
	console.log("Result:", res26.content[0].text);
	const list26 = await listTasks();
	if (res26.isError || !res26.content[0].text.includes("marked as STALE") || !/Conversation Id\*\*: 1014[^]*?\*\*Status\*\*: STALE/.test(list26)) {
		console.error("Test 26 Failed: a listed dead thread should be retried and the task kept STALE");
		process.exit(1);
	}
	console.log("✓ Test 26 Passed: listed dead thread retried, task kept STALE");

	// Test 27: a suggestion the agent was never shown is not applied, and the agent is told so
	console.log("\n=== Test 27: pr_task_resolve refuses a suggestion the agent was never shown ===");
	const unseenFile = path.join(tmpDir, "src", "unseen.ts");
	fs.writeFileSync(unseenFile, "p\nq\n");
	const t27 = mkThread("PRRT_27", 1027, "src/unseen.ts", "Use\n```suggestion\nQ\n```", { line: 2 });
	writeState("extra_threads.json", [...base23, answered23, t25, t27]);
	const res27 = await tools["pr_task_resolve"].execute("call27", { conversation_id: "1027", message: "Applied", accept_suggestion: true }, undefined, undefined, toolCtx);
	console.log("Result:", res27.content[0].text);
	if (!res27.isError || !res27.content[0].text.includes("haven't been shown") || fs.readFileSync(unseenFile, "utf-8") !== "p\nq\n") {
		console.error("Test 27 Failed: an unseen suggestion must not be applied");
		process.exit(1);
	}
	console.log("✓ Test 27 Passed: unseen suggestion refused, file untouched");

	// Test 28: a reply that unblocks a task during pr_task_blocked's own refresh is shown, not absorbed
	console.log("\n=== Test 28: re-blocking surfaces the reply that just unblocked the task ===");
	const t28 = mkThread("PRRT_28", 1028, "src/ask.ts", "Which config?");
	const base28 = [...base23, answered23, t25, t27];
	writeState("extra_threads.json", [...base28, t28]);
	await listTasks();
	const block28 = await tools["pr_task_blocked"].execute("call28a", { conversation_id: "1028", reason: "Need the config name" }, undefined, undefined, toolCtx);
	if (block28.isError) {
		console.error("Test 28 Failed: initial block failed", block28.content[0].text);
		process.exit(1);
	}
	const answered28 = { ...t28, comments: { nodes: [...t28.comments.nodes, { id: "PRRC_28_answer", databaseId: 2801, body: "Use prod.yaml", createdAt: "2026-10-09T13:00:00Z", author: { login: "reviewer_eve" } }] } };
	writeState("extra_threads.json", [...base28, answered28]);
	const repliesBefore28 = readLog("replies.log").length;
	const res28 = await tools["pr_task_blocked"].execute("call28b", { conversation_id: "1028", reason: "Still need it" }, undefined, undefined, toolCtx);
	console.log("Result:", res28.content[0].text);
	if (!res28.isError || !res28.content[0].text.includes("Use prod.yaml") || readLog("replies.log").length !== repliesBefore28) {
		console.error("Test 28 Failed: the unblocking reply must be surfaced instead of re-blocking");
		process.exit(1);
	}
	console.log("✓ Test 28 Passed: unblocking reply surfaced");

	// Test 29: applying a suggestion keeps the file's CRLF line endings
	console.log("\n=== Test 29: accept_suggestion keeps CRLF line endings ===");
	const crlfFile = path.join(tmpDir, "src", "crlf.ts");
	fs.writeFileSync(crlfFile, "one\r\ntwo\r\nthree\r\n");
	const t29 = mkThread("PRRT_29", 1029, "src/crlf.ts", "Use\n```suggestion\nTWO\n```", { line: 2 });
	writeState("extra_threads.json", [...base28, answered28, t29]);
	await listTasks();
	const res29 = await tools["pr_task_resolve"].execute("call29", { conversation_id: "1029", message: "Applied", accept_suggestion: true }, undefined, undefined, toolCtx);
	console.log("Result:", res29.content[0].text);
	if (res29.isError || fs.readFileSync(crlfFile, "utf-8") !== "one\r\nTWO\r\nthree\r\n") {
		console.error("Test 29 Failed: expected the suggestion applied with CRLF kept", JSON.stringify(fs.readFileSync(crlfFile, "utf-8")));
		process.exit(1);
	}
	console.log("✓ Test 29 Passed: CRLF kept");

	// Test 30: once GitHub stops listing the rejected thread, resolving the STALE task clears it
	console.log("\n=== Test 30: pr_task_resolve clears a dead-thread STALE task once its thread is unlisted ===");
	writeState("extra_threads.json", [...base28, answered28, t29].filter((t) => t.id !== "PRRT_14"));
	const res30 = await tools["pr_task_resolve"].execute("call30", { conversation_id: "1014", message: "Documented" }, undefined, undefined, toolCtx);
	console.log("Result:", res30.content[0].text);
	if (res30.isError || !res30.content[0].text.includes("now marked as resolved") || (await listTasks()).includes("**Conversation Id**: 1014")) {
		console.error("Test 30 Failed: an unlisted dead-thread STALE task should be cleared");
		process.exit(1);
	}
	console.log("✓ Test 30 Passed: unlisted dead-thread STALE task cleared");

	// Test 31: a thread GitHub rejected once but accepts again is used, and its STALE task blocks normally
	console.log("\n=== Test 31: pr_task_blocked on a STALE task whose thread works again ===");
	const t31 = mkThread("PRRT_31", 1031, "src/flaky.ts", "Which timeout?");
	const base31 = [...base28, answered28, t29].filter((t) => t.id !== "PRRT_14");
	writeState("extra_threads.json", [...base31, t31]);
	await listTasks();
	killThread("PRRT_31");
	await tools["pr_task_resolve"].execute("call31a", { conversation_id: "1031", message: "Done" }, undefined, undefined, toolCtx);
	if (!/Conversation Id\*\*: 1031[^]*?\*\*Status\*\*: STALE/.test(await listTasks())) {
		console.error("Test 31 Failed: setup expected the task STALE on its rejected thread");
		process.exit(1);
	}
	dead.splice(dead.indexOf("PRRT_31"), 1);
	writeState("dead_ids.json", dead);
	const res31 = await tools["pr_task_blocked"].execute("call31b", { conversation_id: "1031", reason: "Need the timeout value" }, undefined, undefined, toolCtx);
	console.log("Result:", res31.content[0].text);
	if (res31.isError || !res31.content[0].text.includes("now marked as Blocked") || !/Conversation Id\*\*: 1031[^]*?\*\*Status\*\*: BLOCKED/.test(await listTasks())) {
		console.error("Test 31 Failed: the task should be BLOCKED once its thread accepts the reply");
		process.exit(1);
	}
	console.log("✓ Test 31 Passed: recovered thread used, task blocked");

	// Test 32: parallel resolves of one conversation post a single reply
	console.log("\n=== Test 32: overlapping pr_task_resolve calls post one reply ===");
	const t32 = mkThread("PRRT_32", 1032, "src/par.ts", "Rename it");
	writeState("extra_threads.json", [...base31, t31, t32]);
	await listTasks();
	const repliesBefore32 = readLog("replies.log").length;
	const [r32a, r32b] = await Promise.all([
		tools["pr_task_resolve"].execute("call32a", { conversation_id: "1032", message: "Renamed" }, undefined, undefined, toolCtx),
		tools["pr_task_resolve"].execute("call32b", { conversation_id: "1032", message: "Renamed" }, undefined, undefined, toolCtx),
	]);
	console.log("Results:", r32a.content[0].text, "|", r32b.content[0].text);
	if (readLog("replies.log").length !== repliesBefore32 + 1 || r32a.isError || r32b.isError || !r32b.content[0].text.includes("already resolved")) {
		console.error("Test 32 Failed: expected exactly one reply and the second call to find the conversation resolved");
		process.exit(1);
	}
	console.log("✓ Test 32 Passed: one reply for overlapping resolves");

	// Test 33: accept_suggestion is refused for a STALE task even once its thread is gone
	console.log("\n=== Test 33: accept_suggestion refused for a STALE task ===");
	const t33 = mkThread("PRRT_33", 1033, "src/gone.ts", "Use\n```suggestion\nG\n```");
	writeState("extra_threads.json", [...base31, t31, t32, t33]);
	await listTasks();
	writeState("extra_threads.json", [...base31, t31, t32]);
	await listTasks();
	const res33 = await tools["pr_task_resolve"].execute("call33", { conversation_id: "1033", message: "Applied", accept_suggestion: true }, undefined, undefined, toolCtx);
	console.log("Result:", res33.content[0].text);
	if (!res33.isError || !res33.content[0].text.includes("is STALE") || !(await listTasks()).includes("**Conversation Id**: 1033")) {
		console.error("Test 33 Failed: accept_suggestion on a STALE task must be refused and the task kept");
		process.exit(1);
	}
	console.log("✓ Test 33 Passed: STALE accept refused");

	// Test 34: a thread with more than 100 comments still sees its newest reply (and unblocks on it)
	console.log("\n=== Test 34: a long thread's newest reply unblocks its task ===");
	const t34 = mkThread("PRRT_34", 1034, "src/long.ts", "Which format?");
	writeState("extra_threads.json", [...base31, t31, t32, t34]);
	await listTasks();
	const block34 = await tools["pr_task_blocked"].execute("call34", { conversation_id: "1034", reason: "Need the format" }, undefined, undefined, toolCtx);
	if (block34.isError) {
		console.error("Test 34 Failed: initial block failed", block34.content[0].text);
		process.exit(1);
	}
	const long34 = { ...t34, comments: { totalCount: 150, nodes: t34.comments.nodes } };
	writeState("extra_threads.json", [...base31, t31, t32, long34]);
	writeState("latest_comments.json", { PRRT_34: [{ id: "PRRC_34_answer", databaseId: 3401, body: "Use JSON", createdAt: "2026-10-09T14:00:00Z", author: { login: "reviewer_eve" } }] });
	sentMessages.length = 0;
	await listTasks();
	if (!sentMessages.some((m) => m.includes("Use JSON")) || !/Conversation Id\*\*: 1034[^]*?\*\*Status\*\*: UNRESOLVED/.test(await listTasks())) {
		console.error("Test 34 Failed: the newest reply of a long thread should unblock the task", sentMessages);
		process.exit(1);
	}
	console.log("✓ Test 34 Passed: long thread's newest reply seen");

	// Test 35: /tasks reply on a cleared STALE task whose thread is still gone posts nothing
	console.log("\n=== Test 35: /tasks reply on a cleared STALE task ===");
	notifications.length = 0;
	const repliesBefore35 = readLog("replies.log").length;
	await tasksCmd.handler('reply 1014 "Any update?"', { ...toolCtx, mode: "headless", hasUI: false });
	const note35 = notifications[notifications.length - 1];
	console.log("Notification:", note35);
	if (note35?.type !== "warning" || !note35.msg.includes("no review thread on GitHub anymore") || readLog("replies.log").length !== repliesBefore35) {
		console.error("Test 35 Failed: expected a warning and no reply");
		process.exit(1);
	}
	console.log("✓ Test 35 Passed: nothing posted to a gone thread");

	// Test 36: a suggestion is applied relative to the repository root, even from a subdirectory
	console.log("\n=== Test 36: accept_suggestion from a subdirectory cwd ===");
	const subFile = path.join(tmpDir, "src", "sub.ts");
	fs.writeFileSync(subFile, "s1\ns2\n");
	const t36 = mkThread("PRRT_36", 1036, "src/sub.ts", "Use\n```suggestion\nS2\n```", { line: 2 });
	writeState("extra_threads.json", [...base31, t31, t32, t36]);
	const subCtx = { ...toolCtx, cwd: path.join(tmpDir, "src") };
	await tools["pr_tasks_list"].execute("list36", {}, undefined, undefined, subCtx);
	const res36 = await tools["pr_task_resolve"].execute("call36", { conversation_id: "1036", message: "Applied", accept_suggestion: true }, undefined, undefined, subCtx);
	console.log("Result:", res36.content[0].text);
	if (res36.isError || fs.readFileSync(subFile, "utf-8") !== "s1\nS2\n") {
		console.error("Test 36 Failed: expected the suggestion applied to src/sub.ts", fs.readFileSync(subFile, "utf-8"));
		process.exit(1);
	}
	console.log("✓ Test 36 Passed: applied relative to the repo root");

	// Test 37: /tasks resolve on a BLOCKED task: a sync during the resolve sees the user's reply, but the
	// agent isn't told about a reply on a conversation that ends up resolved
	console.log("\n=== Test 37: no unblock notice for a reply that a /tasks resolve then resolved ===");
	const t37 = mkThread("PRRT_37", 1037, "src/held.ts", "Which name?");
	const base37 = [...base31, t31, t32, t36];
	writeState("extra_threads.json", [...base37, t37]);
	await listTasks();
	const block37 = await tools["pr_task_blocked"].execute("call37", { conversation_id: "1037", reason: "Need the name" }, undefined, undefined, toolCtx);
	if (block37.isError) {
		console.error("Test 37 Failed: initial block failed", block37.content[0].text);
		process.exit(1);
	}
	writeState("resolve_delay_ms.json", 1500);
	sentMessages.length = 0;
	notifications.length = 0;
	const resolving37 = tasksCmd.handler('resolve 1037 "Call it fooBar"', { ...toolCtx, mode: "headless", hasUI: false });
	await new Promise((r) => setTimeout(r, 700)); // the reply is posted; the resolve is in flight
	await (globalThis as any).__PI_ON_PR_POLL__(101, tmpDir);
	await resolving37;
	writeState("resolve_delay_ms.json", 0);
	console.log("Notification:", notifications[notifications.length - 1]);
	if (sentMessages.some((m) => m.includes("1037")) || notifications[notifications.length - 1]?.type !== "info") {
		console.error("Test 37 Failed: expected the resolve to succeed without an unblock notice", sentMessages);
		process.exit(1);
	}
	console.log("✓ Test 37 Passed: held notice dropped for the resolved conversation");

	// Test 38: a reply that arrives just before pr_task_resolve is shown instead of being resolved over
	console.log("\n=== Test 38: pr_task_resolve shows a reply the agent hasn't seen before resolving ===");
	const t38 = mkThread("PRRT_38", 1038, "src/late.ts", "Rename the helper");
	const base38 = [...base37];
	writeState("extra_threads.json", [...base38, t38]);
	await listTasks();
	const answered38 = { ...t38, comments: { nodes: [...t38.comments.nodes, { id: "PRRC_38_late", databaseId: 3801, body: "Actually, keep the old name", createdAt: "2026-10-09T15:00:00Z", author: { login: "reviewer_eve" } }] } };
	writeState("extra_threads.json", [...base38, answered38]);
	const repliesBefore38 = readLog("replies.log").length;
	const res38a = await tools["pr_task_resolve"].execute("call38a", { conversation_id: "1038", message: "Renamed" }, undefined, undefined, toolCtx);
	console.log("First result:", res38a.content[0].text);
	const res38b = await tools["pr_task_resolve"].execute("call38b", { conversation_id: "1038", message: "Kept the old name" }, undefined, undefined, toolCtx);
	console.log("Second result:", res38b.content[0].text);
	if (!res38a.isError || !res38a.content[0].text.includes("keep the old name") || res38b.isError || readLog("replies.log").length !== repliesBefore38 + 1) {
		console.error("Test 38 Failed: the late reply must be shown first, then the resolve goes through");
		process.exit(1);
	}
	console.log("✓ Test 38 Passed: late reply shown before resolving");

	// Test 39: a PR that is no longer observed (e.g. after its merge) is still synced while it has open tasks
	console.log("\n=== Test 39: open tasks of an unobserved PR keep syncing ===");
	const t39 = mkThread("PRRT_39", 1039, "src/merged.ts", "Fix before merge");
	writeState("extra_threads.json", [...base38, answered38, t39]);
	await listTasks();
	const observedBefore = (globalThis as any).__PI_OBSERVED_PRS__;
	(globalThis as any).__PI_OBSERVED_PRS__ = new Map([[999, {}]]); // observe-pr watches another PR now
	writeState("extra_threads.json", [...base38, answered38, { ...t39, isResolved: true }]);
	try {
		for (const handler of settleHandlers) await handler({ type: "agent_before_settle" }, toolCtx);
	} finally {
		(globalThis as any).__PI_OBSERVED_PRS__ = observedBefore;
	}
	if (!/Conversation Id\*\*: 1039[^]*?\*\*Status\*\*: RESOLVED/.test(await tools["pr_tasks_list"].execute("list39", { show_all: true }, undefined, undefined, toolCtx).then((r: any) => r.content[0].text))) {
		console.error("Test 39 Failed: the unobserved PR's task should have synced to RESOLVED");
		process.exit(1);
	}
	console.log("✓ Test 39 Passed: unobserved PR with open tasks synced");

	// Test 40: a resolve retry after the suggestion was applied matches the posted reply with or without accept_suggestion
	console.log("\n=== Test 40: retrying a suggestion resolve without accept_suggestion posts no second reply ===");
	const f40 = path.join(tmpDir, "src", "retry40.ts");
	fs.writeFileSync(f40, "r1\nr2\n");
	const t40 = mkThread("PRRT_40", 1040, "src/retry40.ts", "Use\n```suggestion\nR2\n```", { line: 2 });
	writeState("extra_threads.json", [...base38, answered38, t40]);
	await listTasks();
	fs.writeFileSync(path.join(stateDir, "resolve_fails"), "1");
	const res40a = await tools["pr_task_resolve"].execute("call40a", { conversation_id: "1040", message: "Fixed", accept_suggestion: true }, undefined, undefined, toolCtx);
	fs.rmSync(path.join(stateDir, "resolve_fails"));
	const replies40 = readLog("replies.log").length;
	const res40b = await tools["pr_task_resolve"].execute("call40b", { conversation_id: "1040", message: "Fixed" }, undefined, undefined, toolCtx);
	console.log("Results:", res40a.content[0].text, "|", res40b.content[0].text);
	if (!res40a.isError || res40b.isError || readLog("replies.log").length !== replies40 || fs.readFileSync(f40, "utf-8") !== "r1\nR2\n") {
		console.error("Test 40 Failed: the retry should only resolve");
		process.exit(1);
	}
	console.log("✓ Test 40 Passed: retry matched the posted reply");

	// Test 41: a STALE task of an unobserved PR still recovers when its thread reappears
	console.log("\n=== Test 41: STALE tasks of an unobserved PR keep syncing ===");
	// (PR 202's only task, so nothing else keeps that PR synced)
	const t41 = mkThread("PRRT_41", 1041, "src/back.ts", "Handle the error");
	const list202 = async () =>
		(await tools["pr_tasks_list"].execute("list41", { pr_number: 202 }, undefined, undefined, toolCtx)).content[0].text as string;
	writeState("threads_pr_202.json", [t41]);
	await list202();
	writeState("threads_pr_202.json", []); // the thread vanishes (e.g. mid-merge): STALE
	await list202();
	const observed41 = (globalThis as any).__PI_OBSERVED_PRS__;
	(globalThis as any).__PI_OBSERVED_PRS__ = new Map([[999, {}]]);
	writeState("threads_pr_202.json", [t41]); // and comes back
	let list41 = "";
	try {
		list41 = await listTasks(); // a default sync (the observed PR 999 plus the tracked ones), listing every PR
	} finally {
		(globalThis as any).__PI_OBSERVED_PRS__ = observed41;
	}
	if (!/Conversation Id\*\*: 1041[^]*?\*\*Status\*\*: UNRESOLVED/.test(list41)) {
		console.error("Test 41 Failed: the STALE task should have recovered");
		process.exit(1);
	}
	console.log("✓ Test 41 Passed: STALE task of an unobserved PR recovered");

	// Test 42: a comment edited after the agent read it is shown before resolving
	console.log("\n=== Test 42: pr_task_resolve shows an edited comment before resolving ===");
	const base42 = [...base38, answered38, t40];
	const t42 = mkThread("PRRT_42", 1042, "src/edit.ts", "Rename it to foo");
	writeState("extra_threads.json", [...base42, t42]);
	await listTasks();
	writeState("extra_threads.json", [...base42, { ...t42, comments: { nodes: [{ ...t42.comments.nodes[0], body: "Rename it to bar" }] } }]);
	const replies42 = readLog("replies.log").length;
	const res42a = await tools["pr_task_resolve"].execute("call42a", { conversation_id: "1042", message: "Renamed to foo" }, undefined, undefined, toolCtx);
	console.log("First result:", res42a.content[0].text);
	const res42b = await tools["pr_task_resolve"].execute("call42b", { conversation_id: "1042", message: "Renamed to bar" }, undefined, undefined, toolCtx);
	if (!res42a.isError || !res42a.content[0].text.includes("Rename it to bar") || res42b.isError || readLog("replies.log").length !== replies42 + 1) {
		console.error("Test 42 Failed: the edited comment must be shown first, then the resolve goes through");
		process.exit(1);
	}
	console.log("✓ Test 42 Passed: edited comment shown before resolving");

	// Test 43: a retry after a failed resolve still shows a comment edited since the earlier call
	console.log("\n=== Test 43: a pr_task_resolve retry shows an edited comment first ===");
	const base43 = [...base42, { ...t42, comments: { nodes: [{ ...t42.comments.nodes[0], body: "Rename it to bar" }] } }];
	const t43 = mkThread("PRRT_43", 1043, "src/retry-edit.ts", "Inline this");
	writeState("extra_threads.json", [...base43, t43]);
	await listTasks();
	fs.writeFileSync(path.join(stateDir, "resolve_fails"), "1");
	const res43a = await tools["pr_task_resolve"].execute("call43a", { conversation_id: "1043", message: "Inlined" }, undefined, undefined, toolCtx);
	fs.rmSync(path.join(stateDir, "resolve_fails"));
	writeState("extra_threads.json", [...base43, { ...t43, comments: { nodes: [{ ...t43.comments.nodes[0], body: "Inline this, and drop the helper" }] } }]);
	const replies43 = readLog("replies.log").length;
	const res43b = await tools["pr_task_resolve"].execute("call43b", { conversation_id: "1043", message: "Inlined" }, undefined, undefined, toolCtx);
	console.log("Retry result:", res43b.content[0].text);
	const res43c = await tools["pr_task_resolve"].execute("call43c", { conversation_id: "1043", message: "Inlined" }, undefined, undefined, toolCtx);
	console.log("Third result:", res43c.content[0].text);
	if (
		!res43a.isError ||
		!res43b.isError ||
		!res43b.content[0].text.includes("drop the helper") ||
		res43c.isError ||
		!res43c.content[0].text.includes("already been posted") ||
		readLog("replies.log").length !== replies43
	) {
		console.error("Test 43 Failed: the edited comment must be shown before the retry resolves");
		process.exit(1);
	}
	console.log("✓ Test 43 Passed: retry showed the edited comment first");

	// Test 44: a reply that unblocks a task during pr_task_resolve, and that the refusal shows, isn't notified again
	console.log("\n=== Test 44: no unblock notice for a reply the resolve refusal already showed ===");
	const base44 = [...base43, { ...t43, comments: { nodes: [{ ...t43.comments.nodes[0], body: "Inline this, and drop the helper" }] } }];
	const t44 = mkThread("PRRT_44", 1044, "src/shown.ts", "Which approach?");
	writeState("extra_threads.json", [...base44, t44]);
	await listTasks();
	const block44 = await tools["pr_task_blocked"].execute("call44", { conversation_id: "1044", reason: "Need the approach" }, undefined, undefined, toolCtx);
	if (block44.isError) {
		console.error("Test 44 Failed: initial block failed", block44.content[0].text);
		process.exit(1);
	}
	writeState("extra_threads.json", [
		...base44,
		{
			...t44,
			comments: {
				nodes: [
					...t44.comments.nodes,
					{ id: "PRRC_44_answer", databaseId: 4401, body: "Use the cache", createdAt: "2026-10-09T16:00:00Z", author: { login: "reviewer_eve" } },
				],
			},
		},
	]);
	sentMessages.length = 0;
	const res44 = await tools["pr_task_resolve"].execute("call44b", { conversation_id: "1044", message: "Done" }, undefined, undefined, toolCtx);
	console.log("Result:", res44.content[0].text);
	if (!res44.isError || !res44.content[0].text.includes("Use the cache") || sentMessages.some((m) => m.includes("1044"))) {
		console.error("Test 44 Failed: the reply shown by the refusal must not be notified again", sentMessages);
		process.exit(1);
	}
	console.log("✓ Test 44 Passed: shown reply not notified twice");

	// Test 45: a conversation that opens after the seeding sync must reach the agent on its own.
	// agent_before_settle decides from cached state, so a refresh that lands after the agent settled
	// would otherwise only record the task and stay silent until the next user turn.
	console.log("\n=== Test 45: a newly opened conversation notifies the agent ===");
	const t45 = mkThread("PRRT_45", 1045, "src/late.ts", "Nit: prefer const here");
	writeState("extra_threads.json", [...base44, t44, t45]);
	sentMessages.length = 0;
	await (globalThis as any).__PI_ON_PR_POLL__(101, tmpDir);
	await (globalThis as any).__PI_PR_TASKS_FLUSH__(10_000);
	const newNotice = sentMessages.find((m) => m.includes("New PR review conversation"));
	if (!newNotice || !newNotice.includes("1045")) {
		console.error("Test 45 Failed: a conversation discovered after seeding must notify the agent", sentMessages);
		process.exit(1);
	}
	// The same task is not "new" again: no repeat notice on the next sync.
	sentMessages.length = 0;
	await (globalThis as any).__PI_ON_PR_POLL__(101, tmpDir);
	await (globalThis as any).__PI_PR_TASKS_FLUSH__(10_000);
	if (sentMessages.some((m) => m.includes("New PR review conversation"))) {
		console.error("Test 45 Failed: an already known task must not be announced twice", sentMessages);
		process.exit(1);
	}
	console.log("✓ Test 45 Passed: newly discovered conversation notified once");

	console.log("\n=== All PR Tasks Tests Passed Successfully! ===");
	process.exit(0);
}
