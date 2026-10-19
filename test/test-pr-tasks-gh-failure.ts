// Run with: pi -ne -e test/test-pr-tasks-gh-failure.ts --offline -p "test"
//
// Regression suite for the GitHub-availability failure handling in pr-tasks:
//  T1  background sync failures are silent (no console output, no TUI notifications)
//  T2  gh calls are paced by the shared backoff (>=1s apart, fast 1.5 s cadence,
//      then slow 8 s cadence) — no serial 60 s waits, no pile-on
//  T3  the settle nudge still protects the agent on cached (stale) task state
//  T4  mutations fail fast with a concise message (no raw stderr, nothing posted)
//  T5  after recovery the background sync resumes and a retried mutation succeeds
import "./gh-fail-env.ts";
import ext from "../extensions/pr-tasks.ts";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const consoleErrors: string[] = [];
const consoleWarns: string[] = [];
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
console.error = (...args: unknown[]) => {
	consoleErrors.push(args.join(" "));
};
console.warn = (...args: unknown[]) => {
	consoleWarns.push(args.join(" "));
};

export default function (pi: any) {
	const tools: Record<string, any> = {};
	const sentMessages: string[] = [];
	const eventHandlers: Record<string, Function[]> = {};
	const notifications: Array<{ msg: string; type?: string }> = [];

	let activeToolList: string[] = [];

	const mockUI = {
		setStatus(_key: string, _text: string | undefined) {},
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

	process.env.PI_PR_TASKS_REOPEN_GRACE_MS = "0";

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-tasks-ghfail-"));
	const binDir = path.join(tmpDir, "bin");
	const stateDir = path.join(tmpDir, "state");
	fs.mkdirSync(binDir);
	fs.mkdirSync(stateDir);

	execSync("git init -b main", { cwd: tmpDir });
	execSync("git config user.name 'Test Runner'", { cwd: tmpDir });
	execSync("git config user.email 'test@example.com'", { cwd: tmpDir });
	const testFilePath = path.join(tmpDir, "src", "sample.ts");
	fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
	fs.writeFileSync(testFilePath, "line 1\nline 2: bad code\nline 3\n");

	const mockGhScript = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const stateDir = ${JSON.stringify(stateDir)};
const args = process.argv.slice(2);
fs.appendFileSync(path.join(stateDir, "gh-calls.log"), Date.now() + " " + args.slice(0, 2).join(" ") + "\\n");

if (fs.existsSync(path.join(stateDir, "offline"))) {
  console.error("gh: failed to connect: dial tcp 140.107.20.17:443: i/o timeout");
  process.exit(1);
}

if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ name: "claude-marketplace", owner: { login: "testowner" } }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({ number: 101 }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "graphql") {
  const queryArg = (args.find(a => a.startsWith("query=")) || "");
  if (queryArg.includes("addPullRequestReviewThreadReply")) {
    fs.writeFileSync(path.join(stateDir, "reply_added"), "1");
    const body = (args.find(a => a.startsWith("body=")) || "").slice("body=".length);
    console.log(JSON.stringify({
      data: {
        addPullRequestReviewThreadReply: {
          comment: {
            id: "PRRC_reply_1",
            databaseId: 999,
            body,
            createdAt: "2026-10-19T18:00:00Z",
            author: { login: "testbot" }
          }
        }
      }
    }));
    process.exit(0);
  }
  if (queryArg.includes("resolveReviewThread")) {
    fs.writeFileSync(path.join(stateDir, "thread_resolved"), "1");
    const threadId = (args.find(a => a.startsWith("threadId=")) || "").slice("threadId=".length);
    console.log(JSON.stringify({ data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } } }));
    process.exit(0);
  }
  if (queryArg.includes("reviewThreads")) {
    console.log(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            id: "PR_101",
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "PRRT_1",
                  isResolved: fs.existsSync(path.join(stateDir, "thread_resolved")),
                  isOutdated: false,
                  path: "src/sample.ts",
                  line: 2,
                  originalLine: 2,
                  startLine: 2,
                  originalStartLine: 2,
                  diffSide: "RIGHT",
                  startDiffSide: "RIGHT",
                  comments: {
                    totalCount: 1,
                    nodes: [
                      {
                        id: "PRRC_1",
                        databaseId: 1001,
                        body: "Please fix this line",
                        createdAt: "2026-10-08T17:00:00Z",
                        author: { login: "reviewer_alice" }
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      }
    }));
    process.exit(0);
  }
}
process.exit(0);
`;
	const ghPath = path.join(binDir, "gh");
	fs.writeFileSync(ghPath, mockGhScript, { mode: 0o755 });
	const originalPath = process.env.PATH;
	process.env.PATH = `${binDir}:${originalPath}`;

	ext(mockPi);

	const mockCtx = { cwd: tmpDir, ui: mockUI };

	function sleep(ms: number) {
		return new Promise((r) => setTimeout(r, ms));
	}

	function assert(cond: boolean, msg: string) {
		if (!cond) throw new Error(msg);
	}

	function readCallTimestamps(): number[] {
		const file = path.join(stateDir, "gh-calls.log");
		if (!fs.existsSync(file)) return [];
		return fs
			.readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => Number.parseInt(l.slice(0, l.indexOf(" ")), 10));
	}

	pi.on("session_start", async () => {
		try {
			console.log("=== Testing pr-tasks GitHub-failure handling ===");
			// Let the -p "test" turn run its session_start sync (online)
			await sleep(4000);

			// Initial sync (online) must have tracked the task
			const list1 = await tools["pr_tasks_list"].execute("call-1", {}, undefined, undefined, mockCtx);
			const list1Text = list1.content[0].text;
			console.log("Initial list:", list1Text.split("\n")[0]);
			assert(list1Text.includes("1001"), `Initial sync should have tracked conversation 1001: ${list1Text}`);
			console.log("✓ Initial (online) sync tracked conversation 1001");

			// Start the outage, then a settle attempt (its sync hits the outage)
			fs.writeFileSync(path.join(stateDir, "offline"), "1");
			const outageStart = Date.now();
			console.log("— GitHub outage started");
			const settleStart = Date.now();
			for (const h of eventHandlers["agent_before_settle"] || []) {
				await h({ type: "agent_before_settle" }, mockCtx);
			}
			const settleDuration = Date.now() - settleStart;
			assert(settleDuration < 10000, `Settle must not stall on the outage (took ${settleDuration} ms)`);
			console.log(`✓ Settle completed fast during the outage (${settleDuration} ms)`);

			// T3: the settle nudge still protects the agent on cached state
			await sleep(1500);
			assert(
				sentMessages.some((m) => m.includes("You still have 1 of open tasks")),
				`Expected the settle nudge for the cached unresolved task, got: ${JSON.stringify(sentMessages)}`,
			);
			console.log("✓ T3: settle nudge still delivered on cached task state during the outage");

			// Wait out the backoff schedule (fast 5 x 1.5 s, then slow 8 s)
			await sleep(19000);

			// T1: silence — no console output, no internal-error notifications
			const noisyConsole = [...consoleErrors, ...consoleWarns].filter(
				(c) => c.includes("pr_tasks") || c.includes("timeout") || c.includes("failed to connect"),
			);
			assert(noisyConsole.length === 0, `T1: console output leaked: ${JSON.stringify(noisyConsole)}`);
			const noisyNotifications = notifications.filter((n) => n.msg.includes("pr_tasks"));
			assert(noisyNotifications.length === 0, `T1: internal error notifications leaked: ${JSON.stringify(noisyNotifications)}`);
			console.log("✓ T1: sync failures stayed silent (no console output, no TUI notifications)");

			// T2: pacing — gh calls from the outage start onward
			const allTs = readCallTimestamps();
			const windowTs = allTs.filter((ts) => ts >= outageStart);
			assert(windowTs.length >= 5, `T2: expected >= 5 paced attempts during the outage, got ${windowTs.length}`);
			const gaps: number[] = [];
			for (let i = 1; i < windowTs.length; i++) gaps.push(windowTs[i] - windowTs[i - 1]);
			const minGap = Math.min(...gaps);
			assert(minGap >= 800, `T2: calls were not paced (min gap ${minGap} ms < 800 ms)`);
			const fastGaps = gaps.filter((g) => g >= 800 && g < 4000);
			assert(fastGaps.length >= 3, `T2: expected at least 3 fast-cadence gaps (1.5 s), got ${fastGaps.length}`);
			const maxGap = Math.max(...gaps);
			assert(maxGap >= 5000, `T2: expected a slow-cadence gap (8 s) after 5 fast failures, max gap was ${maxGap} ms`);
			console.log(`✓ T2: gh calls paced — ${windowTs.length} attempts, min gap ${minGap} ms, ${fastGaps.length} fast gaps, max gap ${maxGap} ms`);

			// T4: a mutation during the outage fails fast and concise
			const resolve1 = await tools["pr_task_resolve"].execute("call-2", { conversation_id: "1001", message: "done" }, undefined, undefined, mockCtx);
			const resolve1Text = resolve1.content[0].text;
			console.log("resolve during outage:", resolve1Text);
			assert(resolve1Text.includes("temporarily unreachable"), `T4: expected concise unreachable error, got: ${resolve1Text}`);
			assert(!resolve1Text.includes("i/o timeout") && !resolve1Text.includes("dial tcp"), `T4: raw gh error leaked: ${resolve1Text}`);
			assert(!fs.existsSync(path.join(stateDir, "reply_added")), "T4: no reply must have been posted during the outage");
			console.log("✓ T4: mutation failed fast with a concise message (no raw stderr, nothing posted)");

			// T4: the list reports it could not be refreshed while degraded
			const list2 = await tools["pr_tasks_list"].execute("call-3", {}, undefined, undefined, mockCtx);
			assert(list2.content[0].text.includes("could not be refreshed"), `T4: list should note the outage: ${list2.content[0].text}`);
			console.log("✓ T4: pr_tasks_list reports the refresh outage");

			// T5: recovery — the background sync resumes and a retried mutation succeeds
			fs.rmSync(path.join(stateDir, "offline"));
			console.log("— GitHub recovered; waiting for the next sync slot —");
			await sleep(10000);

			const resolve2 = await tools["pr_task_resolve"].execute("call-4", { conversation_id: "1001", message: "done" }, undefined, undefined, mockCtx);
			const resolve2Text = resolve2.content[0].text;
			console.log("resolve after recovery:", resolve2Text);
			assert(resolve2Text.includes("resolved successfully"), `T5: expected the retried resolve to succeed, got: ${resolve2Text}`);
			assert(fs.existsSync(path.join(stateDir, "reply_added")), "T5: the reply should have been posted on the retried resolve");
			console.log("✓ T5: retried mutation succeeded after recovery (reply posted, thread resolved)");

			// T1 (final): the recovery path must also be quiet
			const noisyAfter = [...consoleErrors, ...consoleWarns].filter((c) => c.includes("pr_tasks"));
			assert(noisyAfter.length === 0, `T1/T5: console output leaked: ${JSON.stringify(noisyAfter)}`);
			console.log("✓ All pr-tasks GitHub-failure tests passed!");

			fs.rmSync(tmpDir, { recursive: true, force: true });
			process.env.PATH = originalPath;
			process.exit(0);
		} catch (err: any) {
			console.log("Test failed:", err);
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {}
			process.env.PATH = originalPath;
			process.exit(1);
		}
	});
}
