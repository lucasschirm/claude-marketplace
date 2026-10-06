import ext from "../extensions/observe-pr.ts";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function(pi: any) {
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const flags: Record<string, any> = {};
  const sentMessages: string[] = [];
  const eventHandlers: Record<string, Function[]> = {};

  const mockPi = {
    ...pi,
    on(event: string, handler: any) {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(handler);
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
    registerFlag(name: string, opts: any) {
      flags[name] = opts;
      return pi.registerFlag(name, opts);
    },
    getFlag(name: string) {
      return flags[name]?.default || pi.getFlag(name);
    },
    getActiveTools() {
      return Object.keys(tools);
    },
    setActiveTools(t: string[]) {},
    sendUserMessage(msg: string, opts: any) {
      sentMessages.push(msg);
      return pi.sendUserMessage?.(msg, opts);
    },
  };

  // Set short delivery delay for fast testing
  process.env.PI_OBSERVE_PR_DELIVERY_DELAY = "1000";

  // Create temporary test environment
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-branch-test-"));
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir);

  // Initialize git repo with branch 'branch-alpha'
  execSync("git init -b branch-alpha", { cwd: tmpDir });
  execSync("git config user.name 'Test Runner'", { cwd: tmpDir });
  execSync("git config user.email 'test@example.com'", { cwd: tmpDir });

  // Create mock 'gh' binary in binDir
  const mockGhScript = `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  branch_or_pr="$3"
  if [ "$branch_or_pr" = "branch-alpha" ] || [ "$branch_or_pr" = "101" ]; then
    echo '{"number": 101, "state": "OPEN", "isDraft": false, "comments": [], "statusCheckRollup": []}'
    exit 0
  elif [ "$branch_or_pr" = "branch-beta" ] || [ "$branch_or_pr" = "202" ]; then
    echo '{"number": 202, "state": "OPEN", "isDraft": false, "comments": [], "statusCheckRollup": []}'
    exit 0
  else
    echo "no pull requests found for branch $branch_or_pr" >&2
    exit 1
  fi
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  echo "[]"
  exit 0
fi
exit 0
`;
  const ghPath = path.join(binDir, "gh");
  fs.writeFileSync(ghPath, mockGhScript, { mode: 0o755 });

  // Put binDir at start of PATH
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;

  ext(mockPi);

  const mockUI = {
    setStatus(name: string, status?: string) {},
    notify(msg: string, type?: string) {},
  };

  const mockCtx = {
    cwd: tmpDir,
    ui: mockUI,
    mode: "cli",
    hasUI: false,
  };

  pi.on("session_start", async () => {
    try {
      console.log("=== Testing Branch Watcher & PR Auto-Observation ===");

      const observeTool = tools["observe_pr"];
      if (!observeTool) throw new Error("observe_pr tool not registered");

      // 1. Trigger branch check for initial branch 'branch-alpha' via turn_end with mockCtx
      for (const h of eventHandlers["turn_end"] || []) {
        await h({ type: "turn_end" }, mockCtx);
      }
      await new Promise((r) => setTimeout(r, 200));

      // Branch watcher should have detected PR #101 on 'branch-alpha'
      // Announcement timer is 1000ms. Call observe_pr before the 1000ms timer fires!
      console.log("Test 1: Calling observe_pr before auto-announcement is delivered...");
      const res1 = await observeTool.execute("call-1", { pr_number: 101 }, undefined, undefined, mockCtx);
      const text1 = res1.content[0].text;
      console.log("observe_pr result 1:", text1);

      if (!text1.includes("Starting observing 101.")) {
        throw new Error(`Expected usual start message for 101, got: ${text1}`);
      }

      // Wait 1.5s (longer than 1000ms) to ensure the pending announcement was cancelled and NOT sent
      await new Promise((r) => setTimeout(r, 1500));
      if (sentMessages.some((m) => m.includes("The PR 101 recently created is now being observed"))) {
        throw new Error("Pending announcement for 101 was NOT cancelled!");
      }
      console.log("✓ Test 1 Passed: Announcement was cancelled, agent received usual start message, PR remained observed.");

      // Test 2: Calling observe_pr again on 101 should stop observing it
      console.log("Test 2: Calling observe_pr again to stop observing 101...");
      const res2 = await observeTool.execute("call-2", { pr_number: 101 }, undefined, undefined, mockCtx);
      const text2 = res2.content[0].text;
      console.log("observe_pr result 2:", text2);
      if (!text2.includes("Stoping observing the PR 101.")) {
        throw new Error(`Expected stop message for 101, got: ${text2}`);
      }
      console.log("✓ Test 2 Passed: Second call stopped observation.");

      // Test 3: Change branch to 'branch-beta' and verify multi-branch tracking + auto-announcement delivery
      console.log("Test 3: Switching branch to branch-beta and testing auto-announcement delivery...");
      execSync("git checkout -b branch-beta", { cwd: tmpDir });

      // Trigger turn_end event with new branch
      for (const h of eventHandlers["turn_end"] || []) {
        await h({ type: "turn_end" }, mockCtx);
      }
      await new Promise((r) => setTimeout(r, 200));

      // Verify dashboard contains both branch-alpha and branch-beta
      console.log("Checking dashboard status...");
      const prCmd = commands["pr_observer"];
      let notifiedText = "";
      await prCmd.handler("list", {
        ...mockCtx,
        ui: {
          ...mockUI,
          notify(msg: string) { notifiedText = msg; }
        }
      });
      console.log("Dashboard list output:", notifiedText);
      if (!notifiedText.includes("branch-alpha") || !notifiedText.includes("branch-beta")) {
        throw new Error(`Expected both branch-alpha and branch-beta in tracked branches, got: ${notifiedText}`);
      }
      console.log("✓ Both branches tracked successfully across branch changes.");

      // Wait 1.5s for PR #202 announcement to be delivered to agent
      await new Promise((r) => setTimeout(r, 1500));
      const expectedAutoMsg = "The PR 202 recently created is now being observed and you will get all updates for the PR. Calling the \"observe_pr\" tool will stop the tracking for the PR and automatic updates";
      if (!sentMessages.includes(expectedAutoMsg)) {
        throw new Error(`Expected announcement message "${expectedAutoMsg}", sentMessages: ${JSON.stringify(sentMessages)}`);
      }
      console.log("✓ Auto-announcement delivered successfully for PR #202.");

      // Test 4: Calling observe_pr after announcement was delivered should stop observing PR #202
      console.log("Test 4: Calling observe_pr after announcement was delivered...");
      const res3 = await observeTool.execute("call-3", { pr_number: 202 }, undefined, undefined, mockCtx);
      const text3 = res3.content[0].text;
      console.log("observe_pr result 3:", text3);
      if (!text3.includes("Stoping observing the PR 202.")) {
        throw new Error(`Expected stop message for 202, got: ${text3}`);
      }
      console.log("✓ Test 4 Passed: Calling observe_pr after delivered announcement stopped observation.");

      console.log("✓ All branch observer tests passed successfully!");
      // Clean up tmpDir
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
