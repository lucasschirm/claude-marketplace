import ext from "../extensions/observe-pr.ts";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Covers the startup/resume flow: the "now being observed" notice rides on the user's next plain message,
// PR updates are discarded until that turn starts, and notifications use steer delivery.
export default function (pi: any) {
  const handlers: Record<string, Function> = {};
  const sent: { content: string; opts: any }[] = [];

  const mockPi = {
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
    registerTool() {},
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
  };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-startup-notice-test-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);
  execFileSync("git", ["init", "-q", "-b", "feat"], { cwd: tmpDir });

  // Every `gh pr view` reports PR 7 with one more comment than the previous call.
  const counter = path.join(tmpDir, "counter");
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  n=$(( $(cat "${counter}" 2>/dev/null || echo 0) + 1 )); echo $n > "${counter}"
  c=""; for i in $(seq 1 $n); do c="$c{\\"url\\":\\"https://x/pull/7#issuecomment-$i\\",\\"body\\":\\"b$i\\",\\"createdAt\\":\\"t\\"},"; done
  echo "{\\"number\\":7,\\"state\\":\\"OPEN\\",\\"isDraft\\":false,\\"comments\\":[\${c%,}],\\"statusCheckRollup\\":[]}"
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;

  ext(mockPi as any);

  const ctx = { cwd: tmpDir, ui: { setStatus() {}, notify() {} }, hasUI: false };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };
  const NOTICE = "The PR 7 recently created is now being observed";

  pi.on("session_start", async () => {
    try {
      console.log("=== Testing startup notice deferral ===");

      handlers.session_start({ type: "session_start", reason: "resume" }, ctx);

      // Input arriving before the startup branch check resolves must still get the notice.
      assert((await handlers.input({ text: "/skill:foo", source: "interactive" })).action === "continue", "slash input must pass through unchanged");
      assert((await handlers.input({ text: "q", source: "interactive", streamingBehavior: "steer" })).action === "continue", "queued input must pass through unchanged");
      assert((await handlers.input({ text: "x", source: "extension" })).action === "continue", "extension input must pass through unchanged");
      console.log("✓ Test 1 Passed: slash, queued and extension inputs are left alone.");

      // The slash command above was an idle user turn: it must release suppression (nothing stuck) while the notice stays pending.
      await sleep(2500);
      assert(sent.length === 0, `no standalone message may be sent at startup, got: ${JSON.stringify(sent)}`);
      handlers.agent_start({ type: "agent_start" });
      await sleep(2200);
      console.log("✓ Test 2 Passed: no startup follow-up; a slash-command turn releases suppression.");
      const afterSlash = sent.length;
      assert(afterSlash > 0 && sent.every((m) => m.opts?.deliverAs === "steer"), `updates must flow with deliverAs steer, got: ${JSON.stringify(sent)}`);
      console.log("✓ Test 3 Passed: notifications are delivered with steer.");

      // The notice was never attached, so the next plain message carries it.
      const res = await handlers.input({ text: "hello", source: "interactive" });
      assert(res.action === "transform" && res.text.startsWith("hello\n\n") && res.text.includes(NOTICE), `plain input must carry the notice, got: ${JSON.stringify(res)}`);
      // A failed prompt (no agent_start) must not lose the notice.
      const retry = await handlers.input({ text: "again", source: "interactive" });
      assert(retry.action === "transform" && retry.text.includes(NOTICE), "notice must survive until the turn starts");
      handlers.agent_start({ type: "agent_start" });
      const after = await handlers.input({ text: "later", source: "interactive" });
      assert(after.action === "continue", "notice must be delivered only once");
      console.log("✓ Test 4 Passed: notice rides on the plain message, survives a failed prompt, and is delivered once.");

      console.log("✓ All startup notice tests passed successfully!");
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
