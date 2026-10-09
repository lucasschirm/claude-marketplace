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

if (args[0] === "api" && args[1] === "graphql") {
  const queryArg = args.find(a => a.startsWith("query=")) || "";

  if (queryArg.includes("resolveReviewThread")) {
    fs.writeFileSync(path.join(stateDir, "thread_resolved"), "1");
    console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } }));
    process.exit(0);
  }

  if (queryArg.includes("addPullRequestReviewThreadReply")) {
    fs.writeFileSync(path.join(stateDir, "reply_added"), "1");
    console.log(JSON.stringify({
      data: {
        addPullRequestReviewThreadReply: {
          comment: {
            id: "PRRC_reply_1",
            databaseId: 999,
            body: "Reply test",
            createdAt: "2026-10-08T18:00:00Z",
            author: { login: "testbot" }
          }
        }
      }
    }));
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
                  isResolved: false,
                  isOutdated: false,
                  path: "src/sample.ts",
                  line: 3,
                  originalLine: 3,
                  startLine: 3,
                  originalStartLine: 3,
                  comments: {
                    nodes: thread2Comments
                  }
                }
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

	// Trigger turn_end to sync
	const turnEndHandlers = eventHandlers["turn_end"] || [];
	for (const handler of turnEndHandlers) {
		await handler({ type: "turn_end" }, toolCtx);
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

	console.log("\n=== All PR Tasks Tests Passed Successfully! ===");
	process.exit(0);
}
