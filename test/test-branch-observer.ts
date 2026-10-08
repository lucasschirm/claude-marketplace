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

  let activeToolList: string[] = [];

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
    registerFlag(name: string, opts: any) {
      flags[name] = opts;
      return pi.registerFlag(name, opts);
    },
    getFlag(name: string) {
      return flags[name]?.default || pi.getFlag(name);
    },
    getActiveTools() {
      return [...activeToolList];
    },
    setActiveTools(t: string[]) {
      activeToolList = [...t];
    },
    sendUserMessage(msg: string, opts: any) {
      sentMessages.push(msg);
      return pi.sendUserMessage?.(msg, opts);
    },
  };

  // Set short delivery delay for fast testing
  process.env.PI_OBSERVE_PR_DELIVERY_DELAY = "1000";

  // Create temporary test environment
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-branch-test-"));
  process.env.GH_STATE_DIR = tmpDir;
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
  elif [ "$branch_or_pr" = "303" ]; then
    if [ -f "$GH_STATE_DIR/303_merged" ]; then
      echo '{"number": 303, "state": "MERGED", "isDraft": false, "comments": [], "statusCheckRollup": []}'
    else
      echo '{"number": 303, "state": "OPEN", "isDraft": false, "comments": [], "statusCheckRollup": []}'
    fi
    exit 0
  elif [ "$branch_or_pr" = "999" ]; then
    echo "Could not resolve to a PullRequest with the number 999" >&2
    exit 1
  elif [ "$branch_or_pr" = "888" ]; then
    echo "graphql error: token expired or unauthorized" >&2
    exit 1
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
      // Test 5: Error discrimination in observe_pr (non-existent vs auth error)
      console.log("Test 5: Testing error handling discrimination in observe_pr...");
      const res404 = await observeTool.execute("call-4", { pr_number: 999 }, undefined, undefined, mockCtx);
      const text404 = res404.content[0].text;
      console.log("observe_pr 404 result:", text404);
      if (!text404.includes("PR 999 don't exist. Not possible to observe")) {
        throw new Error(`Expected 404 message for PR 999, got: ${text404}`);
      }

      const resAuth = await observeTool.execute("call-5", { pr_number: 888 }, undefined, undefined, mockCtx);
      const textAuth = resAuth.content[0].text;
      console.log("observe_pr auth error result:", textAuth);
      if (!textAuth.includes("Error inspecting PR 888:") || !textAuth.includes("unauthorized")) {
        throw new Error(`Expected auth error message for PR 888, got: ${textAuth}`);
      }
      console.log("✓ Test 5 Passed: Error handling correctly distinguishes PR existence from auth/system errors.");

      // Test 6: Unknown subcommand warning in /pr_observer
      console.log("Test 6: Testing unknown subcommand in /pr_observer...");
      let warnMessage = "";
      await prCmd.handler("unknown_cmd", {
        ...mockCtx,
        ui: {
          ...mockUI,
          notify(msg: string, type?: string) { warnMessage = msg; }
        }
      });
      console.log("Unknown subcommand notification:", warnMessage);
      if (!warnMessage.includes("Unknown subcommand 'unknown_cmd'")) {
        throw new Error(`Expected warning for unknown subcommand, got: ${warnMessage}`);
      }
      console.log("✓ Test 6 Passed: Unrecognized subcommand reported warning without accidental toggle.");

      // Test 7: Initial prompt augmentation when automatic tracking is enabled
      console.log("Test 7: Testing initial prompt augmentation in before_agent_start...");
      const startHandlers = eventHandlers["before_agent_start"] || [];
      const testEvent1: any = {
        type: "before_agent_start",
        prompt: "Start task",
        systemPrompt: "Base system prompt.",
        systemPromptOptions: {
          sections: {},
          promptGuidelines: [],
        },
      };
      let resPrompt1: any;
      for (const h of startHandlers) {
        resPrompt1 = await h(testEvent1, mockCtx);
      }
      console.log("Section content:", testEvent1.systemPromptOptions.sections.pr_auto_tracking);
      console.log("Result systemPrompt:", resPrompt1?.systemPrompt);
      if (!testEvent1.systemPromptOptions.sections.pr_auto_tracking?.includes("Automatic PR tracking is enabled")) {
        throw new Error("Expected pr_auto_tracking section in systemPromptOptions");
      }
      if (!testEvent1.systemPromptOptions.sections.pr_auto_tracking?.includes("# Rules")) {
        throw new Error("Expected # Rules section in pr_auto_tracking");
      }
      if (!resPrompt1?.systemPrompt?.includes("Automatic PR tracking is enabled")) {
        throw new Error("Expected auto-tracking message in returned systemPrompt");
      }
      if (!resPrompt1?.systemPrompt?.includes("# Rules")) {
        throw new Error("Expected # Rules section in returned systemPrompt");
      }
      console.log("✓ Test 7 Passed: Initial prompt receives automatic PR tracking notice when enabled.");

      // Test 8: Prompt augmentation when automatic tracking is disabled
      console.log("Test 8: Testing prompt behavior when disabled via /pr_observer disable...");
      await prCmd.handler("disable", mockCtx);
      const testEvent2: any = {
        type: "before_agent_start",
        prompt: "Start task",
        systemPrompt: "Base system prompt.",
        systemPromptOptions: {
          sections: { pr_auto_tracking: "existing" },
          promptGuidelines: [],
        },
      };
      let resPrompt2: any;
      for (const h of startHandlers) {
        resPrompt2 = await h(testEvent2, mockCtx);
      }
      if (testEvent2.systemPromptOptions.sections.pr_auto_tracking) {
        throw new Error("Expected pr_auto_tracking section to be removed when disabled");
      }
      if (resPrompt2?.systemPrompt?.includes("Automatic PR tracking is enabled")) {
        throw new Error("Expected no auto-tracking message in systemPrompt when disabled");
      }
      console.log("✓ Test 8 Passed: Auto-tracking notice not injected when tool is disabled.");

      // Test 9: Re-enabling restores prompt augmentation
      console.log("Test 9: Testing prompt behavior when re-enabled via /pr_observer enable...");
      await prCmd.handler("enable", mockCtx);
      const testEvent3: any = {
        type: "before_agent_start",
        prompt: "Start task",
        systemPrompt: "Base system prompt.",
        systemPromptOptions: {
          sections: {},
          promptGuidelines: [],
        },
      };
      let resPrompt3: any;
      for (const h of startHandlers) {
        resPrompt3 = await h(testEvent3, mockCtx);
      }
      if (!testEvent3.systemPromptOptions.sections.pr_auto_tracking?.includes("Automatic PR tracking is enabled")) {
        throw new Error("Expected pr_auto_tracking section after re-enabling");
      }
      if (!resPrompt3?.systemPrompt?.includes("Automatic PR tracking is enabled")) {
        throw new Error("Expected auto-tracking message in returned systemPrompt after re-enabling");
      }
      console.log("✓ Test 9 Passed: Auto-tracking notice restored after re-enabling.");

      // Test 10: Merged PR tracking & notification
      console.log("Test 10: Testing merged PR tracking & notification...");
      const resStart303 = await observeTool.execute("call-6", { pr_number: 303 }, undefined, undefined, mockCtx);
      const textStart303 = resStart303.content[0].text;
      console.log("observe_pr start 303:", textStart303);
      if (!textStart303.includes("Starting observing 303.")) {
        throw new Error(`Expected start observing 303, got: ${textStart303}`);
      }

      // Simulate PR 303 being merged on GitHub
      fs.writeFileSync(path.join(tmpDir, "303_merged"), "merged");

      // Trigger turn_end event
      for (const h of eventHandlers["turn_end"] || []) {
        await h({ type: "turn_end" }, mockCtx);
      }
      await new Promise((r) => setTimeout(r, 200));

      const expectedMergeMsg = "Stoping observing the pr 303. The PR was merged. You will no longer receive updates about this PR.";
      if (!sentMessages.includes(expectedMergeMsg)) {
        throw new Error(`Expected merge message "${expectedMergeMsg}", sent: ${JSON.stringify(sentMessages)}`);
      }
      console.log("✓ Test 10 Passed: PR merge detected, agent received notification, and observation stopped.");

      console.log("✓ All branch observer tests passed successfully!");
      // Clean up tmpDir
      fs.rmSync(tmpDir, { recursive: true, force: true });
      process.env.PATH = originalPath;
      delete process.env.GH_STATE_DIR;
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
