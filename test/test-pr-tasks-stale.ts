import ext from "../extensions/pr-tasks.ts";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Covers pr-tasks' stale-context safety (the failure class observe-pr had): when pi
// invalidates the extension context (a session replacement whose teardown skipped
// session_shutdown), the extension's in-flight sync continuations and settle-loop
// message must (a) never write to the console, (b) never surface as TUI extension
// errors, (c) never produce unhandled rejections, (d) self-tear-down on the first
// stale pi call, and (e) record the failure in the file log (PI_EXTENSION_LOG_DIR).
//
// Also covers the sibling failure shapes: a clean session_shutdown replacement
// (must NOT trigger the stale teardown - no false positive) and a non-stale
// internal error (must be file-logged, never console-logged).
export default function (pi: any) {
  const handlers: Record<string, Function[]> = {};
  const tools: Record<string, any> = {};
  const sent: string[] = [];
  const sentAttempts = { count: 0 };
  const statusUpdates: Record<string, string | undefined> = {};
  const notifications: Array<{ msg: string; type?: string }> = [];
  let stale = false;

  const staleError = () =>
    new Error(
      "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
    );

  const mockUI = {
    setStatus(key: string, text: string | undefined) {
      statusUpdates[key] = text;
    },
    notify(msg: string, type?: string) {
      notifications.push({ msg, type });
    },
  };

  const mockPi = {
    on(event: string, handler: Function) {
      (handlers[event] ??= []).push(handler);
    },
    registerTool(t: any) {
      tools[t.name] = t;
    },
    registerCommand() {},
    registerFlag() {},
    getFlag: () => undefined,
    getActiveTools() {
      if (stale) throw staleError();
      return ["pr_tasks_list", "pr_task_detail", "pr_task_resolve", "pr_task_blocked"];
    },
    setActiveTools() {},
    sendUserMessage(msg: string, _opts: any) {
      sentAttempts.count++;
      if (stale) throw staleError(); // like real pi: assertActive throws before the action
      sent.push(msg);
    },
    appendEntry() {
      if (stale) throw staleError();
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pr-tasks-stale-test-"));
  const binDir = path.join(tmpDir, "bin");
  const logDir = path.join(tmpDir, "logs");
  fs.mkdirSync(binDir);
  process.env.PI_EXTENSION_LOG_DIR = logDir;
  execSync("git init -b main", { cwd: tmpDir });
  execSync("git config user.name 'Test Runner'", { cwd: tmpDir });
  execSync("git config user.email 'test@example.com'", { cwd: tmpDir });
  fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "src", "sample.ts"), "line 1\nline 2: bad code\nline 3\n");

  // `gh repo view`: fixed coordinates. `gh pr view --json number`: the branch PR,
  // delayed 400 ms so the test can flip the context stale mid-sync; fails (per-PR-class
  // error) while the stale_gh file exists, so a post-teardown re-sync finds no target.
  // `gh api graphql ... reviewThreads`: one unresolved thread (conversation 1001).
  const stateDir = path.join(tmpDir, "state");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const stateDir = ${JSON.stringify(stateDir)};
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") {
  console.log(JSON.stringify({ name: "claude-marketplace", owner: { login: "testowner" } }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  if (fs.existsSync(path.join(stateDir, "stale_gh"))) {
    console.error("gh: no pull requests found for branch 'main'");
    process.exit(1);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  console.log(JSON.stringify({ number: 101, state: "OPEN" }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "graphql") {
  const queryArg = (args.find(a => a.startsWith("query=")) || "");
  if (queryArg.includes("reviewThreads")) {
    console.log(JSON.stringify({ data: { repository: { pullRequest: { id: "PR_101", reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
      {
        id: "PRRT_1",
        isResolved: false,
        isOutdated: false,
        path: "src/sample.ts",
        line: 2,
        originalLine: 2,
        startLine: 2,
        originalStartLine: 2,
        comments: {
          nodes: [
            { id: "PRRC_1", databaseId: 1001, body: "Please fix this line", createdAt: "2026-10-08T17:00:00Z", author: { login: "reviewer_alice" } }
          ]
        }
      }
    ] } } } } }));
    process.exit(0);
  }
}
process.exit(0);
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;

  const consoleErrors: unknown[][] = [];
  const rejections: unknown[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => consoleErrors.push(args);
  const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);

  ext(mockPi as any);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };
  const makeCtx = () => {
    // A stale ctx throws from its getters, exactly like the runner's createContext()
    // (every getter asserts active first).
    const real = { cwd: tmpDir, ui: mockUI, hasUI: false };
    return new Proxy(real, {
      get(target: any, prop: string) {
        if (stale && (prop === "ui" || prop === "cwd")) throw staleError();
        return target[prop];
      },
    });
  };
  const plainCtx = { cwd: tmpDir, ui: mockUI, hasUI: false };
  const toolCtx = { cwd: tmpDir, ui: mockUI };
  const logFile = path.join(logDir, "pr-tasks.jsonl");
  const readLogEntries = (): any[] => {
    try {
      return fs
        .readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const listText = async () => {
    const res = await tools.pr_tasks_list.execute("t0", {}, undefined, undefined, toolCtx);
    return res.content[0].text;
  };

  pi.on("session_start", async () => {
    try {
      const s1 = handlers.session_start[0];

      // ---- S1: the context is invalidated WITHOUT a session_shutdown while the
      // session_start sync is in flight (the reported failure class: a
      // ChildProcess continuation resuming into a dead context). The handler's
      // continuation then hits the stale ctx and must self-tear-down.
      const s1Done = s1({ type: "session_start", reason: "new" }, makeCtx()); // sync in flight (400 ms gh delay)
      await sleep(150);
      fs.writeFileSync(path.join(stateDir, "stale_gh"), "1"); // post-teardown re-syncs find no target
      stale = true; // mid-sync
      await s1Done; // the continuation hits the stale ctx getter
      await sleep(600); // the in-flight gh settles
      assert(!sent.some((m: string) => m.includes("1001")), "S1: no agent message may be delivered through a dead context");
      assert(sentAttempts.count === 0, `S1: no agent-message attempts after the stale flip, got ${sentAttempts.count}`);
      assert(notifications.length === 0, `S1: no TUI notifications, got ${JSON.stringify(notifications)}`);
      assert(consoleErrors.length === 0, `S1: console.error must stay silent, got ${consoleErrors.length} call(s)`);
      assert(rejections.length === 0, `S1: no unhandled rejections, got ${JSON.stringify(rejections)}`);
      const s1Entries = readLogEntries();
      assert(
        s1Entries.some((e) => e.what === "extension context invalidated; tearing down pr-tasks background work" && e.message?.includes("session_start")),
        "S1: the stale teardown must be file-logged with the triggering caller",
      );
      assert(!(await listText()).includes("1001"), "S1: the self-teardown must clear the in-flight sync's tasks");
      assert((globalThis as any).__PI_PR_TASKS_EXTENSION_ACTIVE__ === undefined, "S1: the registration guard key must be released");
      console.log("✓ S1 Passed: stale mid-sync is silent, self-tears-down, and is file-logged.");

      // ---- S2: a stale pi call from a handler that started while live (the
      // settle-loop sendUserMessage path) tears down on the first stale call.
      const s1Shutdown = handlers.session_shutdown[0];
      s1Shutdown({ type: "session_shutdown" }); // clean shutdown of the S1 instance
      fs.rmSync(path.join(stateDir, "stale_gh")); // the fresh instance's sync sees the PR again
      ext(mockPi as any); // the shutdown deleted the guard key: fresh instance
      const s2 = handlers.session_start[1];
      const s2Shutdown = handlers.session_shutdown[1];
      const s2Settle = handlers.agent_before_settle[1];
      stale = false;
      await s2({ type: "session_start", reason: "new" }, makeCtx());
      await sleep(300);
      assert((await listText()).includes("1001"), "S2: the fresh instance must sync one unresolved task");
      stale = true;
      const settleResult = await s2Settle({ type: "agent_before_settle" }, plainCtx); // the nudge hits the stale pi
      assert(settleResult?.continue === true, `S2: the settle handler must still block while tasks are open, got ${JSON.stringify(settleResult)}`);
      assert(!sent.some((m: string) => m.includes("1001")), "S2: the nudge must not be delivered through a dead context");
      assert(consoleErrors.length === 0, `S2: console.error must stay silent, got ${consoleErrors.length} call(s)`);
      assert(rejections.length === 0, `S2: no unhandled rejections, got ${JSON.stringify(rejections)}`);
      const s2Entries = readLogEntries();
      assert(
        s2Entries.some((e) => e.what === "extension context invalidated; tearing down pr-tasks background work" && e.message?.includes("settle_loop")),
        "S2: the settle-loop stale teardown must be file-logged with the triggering caller",
      );
      console.log("✓ S2 Passed: a stale settle-loop send tears down once and is file-logged.");

      // ---- S3: a clean session_shutdown replacement (no stale flip) must NOT
      // trigger the stale teardown - no false positive, nothing printed.
      s2Shutdown({ type: "session_shutdown" });
      ext(mockPi as any);
      const s3 = handlers.session_start[2];
      const s3TurnEnd = handlers.turn_end[2];
      const s3Shutdown = handlers.session_shutdown[2];
      stale = false;
      const entriesBeforeS3 = readLogEntries().length;
      await s3({ type: "session_start", reason: "new" }, makeCtx());
      await sleep(300);
      await s3TurnEnd({ type: "turn_end" }, makeCtx());
      s3Shutdown({ type: "session_shutdown" });
      await sleep(300);
      assert(
        !readLogEntries().slice(entriesBeforeS3).some((e) => e.what === "extension context invalidated; tearing down pr-tasks background work"),
        "S3: a clean session_shutdown replacement must not trigger the stale teardown",
      );
      assert(consoleErrors.length === 0, `S3: console.error must stay silent, got ${consoleErrors.length} call(s)`);
      assert(rejections.length === 0, `S3: no unhandled rejections, got ${JSON.stringify(rejections)}`);
      console.log("✓ S3 Passed: clean session_shutdown replacement is silent with no false stale teardown.");

      // ---- S4: a non-stale internal error (a dead UI) is file-logged once, never
      // console-logged, and does not surface as a TUI extension error.
      s3Shutdown({ type: "session_shutdown" });
      ext(mockPi as any);
      const s4 = handlers.session_start[3];
      const s4TurnEnd = handlers.turn_end[3];
      stale = false;
      const entriesBeforeS4 = readLogEntries().length;
      await s4({ type: "session_start", reason: "new" }, { cwd: tmpDir, ui: { setStatus() { throw new Error("ENOSPC: no space left on device"); }, notify() {} }, hasUI: false });
      await sleep(300);
      await s4TurnEnd({ type: "turn_end" }, { cwd: tmpDir, ui: { setStatus() { throw new Error("ENOSPC: no space left on device"); }, notify() {} }, hasUI: false });
      const s4Entries = readLogEntries().slice(entriesBeforeS4);
      assert(
        s4Entries.filter((e) => e.what?.includes("Failed to update status UI")).length >= 1,
        "S4: the dead-UI failure must be file-logged",
      );
      assert(consoleErrors.length === 0, `S4: console.error must stay silent, got ${consoleErrors.length} call(s)`);
      assert(rejections.length === 0, `S4: no unhandled rejections, got ${JSON.stringify(rejections)}`);
      console.log("✓ S4 Passed: non-stale internal errors are file-logged and stay silent.");

      process.env.PATH = originalPath;
      console.error = originalConsoleError;
      process.off("unhandledRejection", onUnhandledRejection);
      process.exit(0);
    } catch (err) {
      process.env.PATH = originalPath;
      console.error = originalConsoleError;
      process.off("unhandledRejection", onUnhandledRejection);
      originalConsoleError("✖ pr-tasks stale-context test failed:", err);
      process.exit(1);
    }
  });
}
