import ext from "../extensions/observe-pr.ts";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Covers observer state restore on resume: an observed PR is re-observed silently (no duplicate
// "now being observed" notice, no re-announcement of known comments/runs), stopped PRs stay
// stopped, a notice pending at shutdown is delivered exactly once across resumes, the
// announced/observed/stopped flags persist at the real change points, and re-watched restored
// runs do not re-notify.
export default function (pi: any) {
  const handlers: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const sent: { content: string; opts: any }[] = [];
  const appended: Array<{ customType: string; data: any }> = [];

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
      return name === "pr-observer-interval" ? "1" : undefined;
    },
    getActiveTools: () => ["observe_pr"],
    setActiveTools() {},
    sendUserMessage(content: string, opts: any) {
      sent.push({ content, opts });
    },
    appendEntry(customType: string, data: any) {
      appended.push({ customType, data });
    },
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-observe-resume-test-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  execFileSync("git", ["init", "-q", "-b", "feat"], { cwd: tmpDir });

  // `gh pr view <branch|7|8>` reports the PR selected via the branch_pr file (default 7);
  // PR 7 always carries one stable comment. If the rollup_42 file exists, the responses also
  // advertise run 42 via statusCheckRollup (used by R5 to exercise real re-discovery).
  // `gh run view`/`gh run watch` fail (exit 1) so the close handler falls back to its
  // exit-code heuristic.
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  rollup="[]"
  if [ -f "${tmpDir}/rollup_42" ]; then
    rollup='[{"detailsUrl":"https://x/actions/runs/42"}]'
  fi
  if [ "$3" = "feat" ] || [ "$3" = "branch" ] || [ "$3" = "feat2" ]; then
    n=$(cat "${tmpDir}/branch_pr" 2>/dev/null || echo 7)
    if [ "$3" = "feat2" ]; then
      echo '{"number":60,"state":"OPEN","isDraft":false,"comments":[],"statusCheckRollup":[]}'
      exit 0
    fi
    if [ "$n" = "8" ]; then
      echo '{"number":8,"state":"OPEN","isDraft":false,"comments":[],"statusCheckRollup":'$rollup'}'
    else
      echo '{"number":7,"state":"OPEN","isDraft":false,"comments":[{"url":"https://x/pull/7#issuecomment-1","body":"b1","updatedAt":"t1"}],"statusCheckRollup":'$rollup'}'
    fi
    exit 0
  fi
  if [ "$3" = "60" ]; then
    echo '{"number":60,"state":"OPEN","isDraft":false,"comments":[],"statusCheckRollup":[]}'
    exit 0
  fi
  if [ "$3" = "8" ]; then
    echo '{"number":8,"state":"OPEN","isDraft":false,"comments":[],"statusCheckRollup":'$rollup'}'
    exit 0
  fi
  echo '{"number":7,"state":"OPEN","isDraft":false,"comments":[{"url":"https://x/pull/7#issuecomment-1","body":"b1","updatedAt":"t1"}],"statusCheckRollup":'$rollup'}'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;

  ext(mockPi as any);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };
  const makeCtx = (branch: any[] = []) => ({
    cwd: tmpDir,
    ui: { setStatus() {}, notify() {} },
    hasUI: false,
    sessionManager: { getBranch: () => branch },
  });
  const stateEntry = (data: any) => ({ type: "custom", customType: "pi_observe_pr_state", data });
  const NOTICE = "The PR 7 is now being observed";
  const observed = () => (globalThis as any).__PI_OBSERVED_PRS__ as Map<number, any> | undefined;
  const setBranchPr = (n: number) => fs.writeFileSync(path.join(tmpDir, "branch_pr"), String(n));
  const lastState = () => appended.filter((a) => a.customType === "pi_observe_pr_state").pop()?.data;

  pi.on("session_start", async () => {
    try {
      // ---- R1: resume with an observed, announced PR: silent re-registration, no notice,
      // no comment spam, no state entry appended by the restore itself.
      appended.length = 0;
      sent.length = 0;
      setBranchPr(7);
      handlers.session_start(
        { type: "session_start", reason: "resume" },
        makeCtx([
          { type: "message", message: { role: "user", content: "old" } },
          stateEntry({
            v: 1,
            observed: [
              {
                prNumber: 7,
                cwd: tmpDir,
                activeRuns: [],
                seenRuns: [],
                failedRuns: [],
                completedRuns: ["111"],
                knownComments: [{ id: "1", number: "1", updatedAt: "t1" }],
                allPassedReported: true,
                announced: true,
              },
            ],
            stopped: [],
          }),
        ]),
      );
      await sleep(1200);
      const res1 = await handlers.input({ text: "hello", source: "interactive" });
      assert(res1.action === "continue", `R1: first message on resume must not carry the notice, got ${res1.action}`);
      assert(
        sent.every((m) => !m.content.includes("now being observed")),
        `R1: no tracking notice on resume, got ${JSON.stringify(sent.map((m) => m.content))}`,
      );
      assert(
        sent.every((m) => !m.content.includes("Comment 1")),
        `R1: restored comment must not be re-announced, got ${JSON.stringify(sent.map((m) => m.content))}`,
      );
      assert(observed()?.has(7), "R1: observed PR must be re-registered");
      assert(observed()?.get(7)?.knownComments?.size === 1, "R1: known comments must be restored");
      assert(observed()?.get(7)?.pollTimer, "R1: poll timer must be running after restore");
      assert(observed()?.get(7)?.checksProcess, "R1: checks process must be re-spawned after restore");
      assert(appended.length === 0, `R1: restore must not append a state entry, got ${appended.length}`);
      console.log("✓ R1 Passed: resume re-observes silently, no duplicate notice or comment spam.");

      // ---- R2: a stopped PR stays stopped across a resume
      appended.length = 0;
      sent.length = 0;
      setBranchPr(8);
      handlers.session_start({ type: "session_start", reason: "resume" }, makeCtx([stateEntry({ v: 1, observed: [], stopped: [8] })]));
      await sleep(1200);
      const res2 = await handlers.input({ text: "hey", source: "interactive" });
      assert(res2.action === "continue", `R2: no notice for a stopped PR, got ${res2.action}`);
      assert(!observed()?.has(8), "R2: stopped PR must not be observed again");
      assert(
        sent.every((m) => !m.content.includes("now being observed")),
        `R2: no tracking notice for a stopped PR, got ${JSON.stringify(sent.map((m) => m.content))}`,
      );
      console.log("✓ R2 Passed: stopped PRs stay stopped across a resume.");

      // ---- R3: a notice pending at shutdown survives a resume and is delivered exactly once
      setBranchPr(7);
      handlers.session_start(
        { type: "session_start", reason: "resume" },
        makeCtx([
          stateEntry({
            v: 1,
            observed: [
              {
                prNumber: 7,
                cwd: tmpDir,
                activeRuns: [],
                seenRuns: [],
                failedRuns: [],
                completedRuns: [],
                knownComments: [{ id: "1", number: "1", updatedAt: "t1" }],
                allPassedReported: false,
                announced: false,
              },
            ],
            stopped: [],
          }),
        ]),
      );
      await sleep(1200);
      const res3 = await handlers.input({ text: "go", source: "interactive" });
      assert(res3.action === "transform" && res3.text.includes(NOTICE), `R3: pending notice must ride the first plain message, got ${res3.action}`);
      handlers.agent_start({ type: "agent_start" });
      const persisted = lastState();
      assert(persisted?.observed?.[0]?.announced === true, "R3: delivery must persist announced=true");
      console.log("✓ R3a Passed: pending notice delivered on resume and persisted.");

      // A second resume with the persisted (now announced) state: no second notice.
      appended.length = 0;
      sent.length = 0;
      handlers.session_start({ type: "session_start", reason: "resume" }, makeCtx([stateEntry(persisted)]));
      await sleep(1200);
      const res4 = await handlers.input({ text: "again", source: "interactive" });
      assert(res4.action === "continue", `R3: notice must be delivered only once across resumes, got ${res4.action}`);
      assert(sent.every((m) => !m.content.includes("now being observed")), "R3: no second notice");
      console.log("✓ R3b Passed: notice delivered once across resumes.");

      // ---- R4: explicit tool stop/start persist the right state
      // (PR 7 is observed from R3's second resume)
      const toolCtx = { cwd: tmpDir, ui: { setStatus() {}, notify() {} } };
      const stopRes = await tools.observe_pr.execute("t1", { pr_number: 7 }, undefined, undefined, toolCtx);
      assert(stopRes.content[0].text.includes("Stoping observing"), `R4: tool on an observed PR must stop it, got ${stopRes.content[0].text}`);
      const stopEntry = lastState();
      assert(stopEntry?.stopped?.includes(7), `R4: stop must persist the stopped PR, got ${JSON.stringify(stopEntry)}`);
      assert(!stopEntry?.observed?.some((o: any) => o.prNumber === 7), "R4: stopped PR must leave observed");
      const startRes = await tools.observe_pr.execute("t2", { pr_number: 7 }, undefined, undefined, toolCtx);
      assert(startRes.content[0].text.includes("Starting observing"), `R4: explicit re-start must start, got ${startRes.content[0].text}`);
      const startEntry = lastState();
      assert(startEntry?.observed?.some((o: any) => o.prNumber === 7 && o.announced === true), `R4: explicit start must persist announced=true, got ${JSON.stringify(startEntry)}`);
      assert(!startEntry?.stopped?.includes(7), "R4: explicit start must clear stopped");
      console.log("✓ R4 Passed: explicit tool start/stop persist correctly.");

      // ---- R5: a run reported failed in a previous process is re-discovered via the
      // statusCheckRollup on resume, re-watched, and must not re-notify. The fixture is a
      // realistic stale snapshot: the failure was recorded (failedRuns) but the run is
      // re-discoverable (seenRuns does not pin it, activeRuns is empty).
      sent.length = 0;
      setBranchPr(7);
      fs.writeFileSync(path.join(tmpDir, "rollup_42"), "1");
      handlers.session_start(
        { type: "session_start", reason: "resume" },
        makeCtx([
          stateEntry({
            v: 1,
            observed: [
              {
                prNumber: 7,
                cwd: tmpDir,
                activeRuns: [],
                seenRuns: [],
                failedRuns: ["42"],
                completedRuns: [],
                knownComments: [],
                allPassedReported: false,
                announced: true,
              },
            ],
            stopped: [],
          }),
        ]),
      );
      await sleep(1500);
      assert(
        observed()?.get(7)?.activeRuns?.has("42") === false && observed()?.get(7)?.seenRuns?.has("42") === true,
        `R5: run 42 must have been re-discovered via the rollup, got ${JSON.stringify({ active: [...observed()?.get(7)?.activeRuns ?? []], seen: [...observed()?.get(7)?.seenRuns ?? []] })}`,
      );
      assert(
        sent.every((m) => !m.content.includes("The CI run 42 failed")),
        `R5: restored failed run must not re-notify, got ${JSON.stringify(sent.map((m) => m.content))}`,
      );
      console.log("✓ R5 Passed: re-watched restored runs do not re-notify.");

      // ---- R6: a notice deferred in AFTER the attached-notice snapshot must survive to the
      // next idle input (agent_start must not wipe deferredAnnouncements wholesale).
      appended.length = 0;
      sent.length = 0;
      process.env.PI_OBSERVE_PR_DELIVERY_DELAY = "400";
      setBranchPr(7);
      ext(mockPi as any);
      handlers.session_start(
        { type: "session_start", reason: "resume" },
        makeCtx([
          stateEntry({
            v: 1,
            observed: [
              {
                prNumber: 7,
                cwd: tmpDir,
                activeRuns: [],
                seenRuns: [],
                failedRuns: ["42"],
                completedRuns: [],
                knownComments: [{ id: "1", number: "1", updatedAt: "t1" }],
                allPassedReported: false,
                announced: false,
              },
            ],
            stopped: [],
          }),
        ]),
      );
      await sleep(1200);
      assert(appended.length === 0, `R6a: restore must not append a state entry, got ${appended.length}`);

      // Detect PR 60 on a second branch: its announcement timer fires inside the
      // attached-notice window (400ms delay, well after the input transform below).
      execFileSync("git", ["checkout", "-q", "-b", "feat2"], { cwd: tmpDir });
      await handlers.turn_end({ type: "turn_end" }, makeCtx());
      assert(observed()?.has(60), "R6b: 60 must be auto-observed on feat2");

      // Idle input while 60's timer is still pending: only 7's (restored, pending)
      // notice is attached, so the snapshot is {7}.
      const res6a = await handlers.input({ text: "go", source: "interactive" });
      assert(
        res6a.text?.includes("The PR 7 is now being observed"),
        `R6c: 7's pending notice must ride the message, got ${JSON.stringify(res6a)}`,
      );
      assert(
        !res6a.text?.includes("The PR 60"),
        `R6c: 60 must not be attached yet (timer pending), got ${res6a.text}`,
      );

      // 60's announcement timer fires while suppressUpdates is true (7's notice is
      // still deferred) -> 60 lands in deferredAnnouncements AFTER the snapshot.
      await sleep(800);

      // Turn start: only the snapshot's PRs are marked delivered; 60 must survive.
      handlers.agent_start();
      assert(observed()?.get(7)?.announced === true, "R6d: 7 must be marked announced");
      assert(
        observed()?.get(60)?.announced === false,
        "R6d: 60 must NOT be marked announced (its notice did not ride the message)",
      );

      // The next idle input carries 60's notice; its turn start marks it delivered.
      const res6b = await handlers.input({ text: "again", source: "interactive" });
      assert(
        res6b.text?.includes("The PR 60 is now being observed"),
        `R6e: 60's notice must survive to the next input, got ${JSON.stringify(res6b)}`,
      );
      handlers.agent_start();
      assert(observed()?.get(60)?.announced === true, "R6f: 60 must be marked announced after delivery");
      console.log("✓ R6 Passed: a notice deferred in after the attached-notice snapshot survives to the next input.");

      console.log("✓ All observe-pr resume tests passed successfully!");
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      process.env.PATH = originalPath;
      process.exit(0);
    } catch (err: any) {
      console.error("Test failed:", err);
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
      process.env.PATH = originalPath;
      process.exit(1);
    }
  });
}
