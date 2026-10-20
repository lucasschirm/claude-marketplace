import ext from "../extensions/observe-pr.ts";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Covers stale-context safety: when pi invalidates the extension context (a session
// replacement whose teardown skipped session_shutdown), the observer's background work
// must (a) never write to the console (TUI safety), (b) never produce unhandled
// rejections (process safety), (c) self-tear-down on the first stale pi call so the
// surviving timers stop hitting the dead context, and (d) record the failure in the
// file log (PI_EXTENSION_LOG_DIR) instead of swallowing it.
//
// Also covers the two sibling failure shapes: a clean session_shutdown replacement
// (must NOT trigger the stale teardown - no false positive) and a non-stale
// persist failure (must be file-logged once, never console-logged, and must not
// wedge observation).
export default function (pi: any) {
  const handlers: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const calls = { appendEntry: 0, sendUserMessage: 0, getFlag: 0, getActiveTools: 0 };
  let stale = false;
  let appendBroken = false;

  const staleError = () =>
    new Error(
      "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
    );

  const mockPi = {
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
    registerTool(t: any) {
      tools[t.name] = t;
    },
    registerCommand() {},
    registerFlag() {},
    getFlag(name: string) {
      calls.getFlag++;
      if (stale) throw staleError();
      return name === "pr-observer-interval" ? "1" : undefined;
    },
    getActiveTools() {
      calls.getActiveTools++;
      if (stale) throw staleError();
      return ["observe_pr"];
    },
    setActiveTools() {},
    sendUserMessage(_content: string, _opts: any) {
      calls.sendUserMessage++;
      if (stale) throw staleError();
    },
    appendEntry(_customType: string, _data: any) {
      calls.appendEntry++;
      if (stale) throw staleError();
      if (appendBroken) throw new Error("ENOSPC: no space left on device");
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-observe-stale-test-"));
  const binDir = path.join(tmpDir, "bin");
  const logDir = path.join(tmpDir, "logs");
  fs.mkdirSync(binDir);
  process.env.PI_EXTENSION_LOG_DIR = logDir;
  execFileSync("git", ["init", "-q", "-b", "feat"], { cwd: tmpDir });

  // `gh pr view feat`: no PR for the branch (a per-PR-class error, so the branch check
  // ignores it instead of recording a GitHub availability failure).
  // `gh pr view 7`: the poll/tool call - delayed 0.5 s so the test can flip the context
  // stale mid-await, and its comment carries a fresh timestamp on every call, so a poll
  // that survives into the stale window reports a changed comment (the stale pi call).
  // `gh pr checks 7 --watch`: long-lived watcher (3 s). `gh pr checks 7 --json`: a
  // failed bucket so checkAllCIPassed never reaches its persist path.
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ "$3" = "feat" ]; then
    echo "no pull requests found for branch 'feat'" >&2
    exit 1
  fi
  if [ "$3" = "7" ]; then
    sleep 0.5
    echo '{"number":7,"state":"OPEN","isDraft":false,"comments":[{"url":"https://x/pull/7#issuecomment-1","body":"b'$RANDOM'","updatedAt":"t'$RANDOM'"}],"statusCheckRollup":[]}'
    exit 0
  fi
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ] && [ "$3" = "7" ]; then
  if [ "$4" = "--watch" ]; then
    sleep 3
    exit 0
  fi
  echo '[{"bucket":"fail","state":"FAILURE"}]'
  exit 0
fi
exit 0
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
  const makeCtx = () => ({
    cwd: tmpDir,
    ui: { setStatus() {}, notify() {} },
    hasUI: false,
    sessionManager: { getBranch: () => [] },
  });
  const toolCtx = { cwd: tmpDir, ui: { setStatus() {}, notify() {} } };
  const observed = () => (globalThis as any).__PI_OBSERVED_PRS__ as Map<number, any> | undefined;
  const logFile = path.join(logDir, "observe-pr.jsonl");
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

  pi.on("session_start", async () => {
    try {
      handlers.session_start({ type: "session_start", reason: "new" }, makeCtx());
      await sleep(200);

      // ---- S1: the reported failure - the context is invalidated WITHOUT a
      // session_shutdown, mid in-flight gh poll (the ChildProcess callback path).
      await tools.observe_pr.execute("s1", { pr_number: 7 }, undefined, undefined, toolCtx);
      assert(observed()?.has(7), "S1: PR 7 must be observed before the stale flip");
      // The first poll tick fires at ~1.0 s (tick at 1.0 s, gh in flight 1.0-1.5 s);
      // the checks watcher closes at ~1.0 s and re-polls (gh in flight 1.0-1.5 s).
      await sleep(1600);
      stale = true; // mid-await window
      await sleep(1200); // the ghs complete at ~1.5 s; continuations hit the stale pi
      const appendAfter = calls.appendEntry;
      const flagAfter = calls.getFlag;
      await sleep(1500); // more than one poll interval + the watcher restart window
      assert(
        calls.appendEntry === appendAfter && calls.getFlag === flagAfter,
        `S1: no background work may survive the stale teardown (appendEntry ${appendAfter}->${calls.appendEntry}, getFlag ${flagAfter}->${calls.getFlag})`,
      );
      assert(observed()?.size === 0, "S1: self-teardown must clear the observed map");
      assert(consoleErrors.length === 0, `S1: console.error must stay silent, got ${consoleErrors.length} call(s)`);
      assert(rejections.length === 0, `S1: no unhandled rejections, got ${JSON.stringify(rejections)}`);
      const s1Entries = readLogEntries();
      assert(
        s1Entries.some((e) => e.what === "extension context invalidated; tearing down observer background work"),
        "S1: the stale teardown must be file-logged for debugging",
      );
      console.log("✓ S1 Passed: stale mid-poll is silent, self-tears-down, and is file-logged.");

      // ---- S2: a clean session_shutdown replacement (no stale flip) must NOT look
      // stale: straggler continuations hit the cleared-map guards, nothing is torn
      // down through the stale path, and nothing is logged or printed.
      stale = false;
      const entriesBeforeS2 = readLogEntries().length;
      handlers.session_shutdown({ type: "session_shutdown" });
      ext(mockPi as any); // the shutdown deleted the global guard key: fresh instance
      handlers.session_start({ type: "session_start", reason: "new" }, makeCtx());
      await sleep(200);
      await tools.observe_pr.execute("s2", { pr_number: 7 }, undefined, undefined, toolCtx);
      assert(observed()?.has(7), "S2: PR 7 must be observed in the fresh instance");
      handlers.session_shutdown({ type: "session_shutdown" }); // clean teardown, no flip
      await sleep(1500); // killed watcher close + any in-flight poll settle
      assert(
        readLogEntries().every((e, i) => i < entriesBeforeS2 || e.what !== "extension context invalidated; tearing down observer background work"),
        "S2: a clean session_shutdown replacement must not trigger the stale teardown",
      );
      assert(consoleErrors.length === 0, `S2: console.error must stay silent, got ${consoleErrors.length} call(s)`);
      assert(rejections.length === 0, `S2: no unhandled rejections, got ${JSON.stringify(rejections)}`);
      console.log("✓ S2 Passed: clean session_shutdown replacement is silent with no false stale teardown.");

      // ---- S3: a non-stale persist failure (e.g. a full disk) is file-logged once
      // (not per change), never console-logged, and does not wedge observation.
      handlers.session_shutdown({ type: "session_shutdown" });
      ext(mockPi as any);
      appendBroken = true;
      handlers.session_start({ type: "session_start", reason: "new" }, makeCtx());
      await sleep(200);
      await tools.observe_pr.execute("s3", { pr_number: 7 }, undefined, undefined, toolCtx);
      assert(observed()?.has(7), "S3: observation must survive a persist failure");
      await sleep(1300); // one poll tick: a changed comment re-triggers persistState (suppressed)
      await tools.observe_pr.execute("s3-stop", { pr_number: 7 }, undefined, undefined, toolCtx);
      const s3Entries = readLogEntries();
      const persistFailures = s3Entries.filter((e) => e.what === "Failed to persist observer state (further failures suppressed)");
      assert(persistFailures.length === 1, `S3: the persist failure must be file-logged exactly once, got ${persistFailures.length}`);
      assert(consoleErrors.length === 0, `S3: console.error must stay silent, got ${consoleErrors.length} call(s)`);
      assert(rejections.length === 0, `S3: no unhandled rejections, got ${JSON.stringify(rejections)}`);
      console.log("✓ S3 Passed: non-stale persist failures are file-logged once and stay silent.");

      process.env.PATH = originalPath;
      console.error = originalConsoleError;
      process.off("unhandledRejection", onUnhandledRejection);
      process.exit(0);
    } catch (err) {
      process.env.PATH = originalPath;
      console.error = originalConsoleError;
      process.off("unhandledRejection", onUnhandledRejection);
      originalConsoleError("✖ observe-pr stale-context test failed:", err);
      process.exit(1);
    }
  });
}
