// Run with: pi -ne -e test/test-observe-pr-mergeability.ts --offline -p "test"
//
// Regression suite for issue 69: an observed PR that becomes CONFLICTING (or BEHIND) must notify
// the agent - the poll used to ask `gh pr view` for fields that cannot answer that question, so a
// PR could sit on a red merge button with the observer reporting nothing but CI and comments.
//
//  T1  a mergeable PR is observed silently (no mergeability announcement on the first polls)
//  T2  the transition to CONFLICTING is announced
//  T3  the same state is never announced twice in a row
//  T4  clearing the conflict is silent, but a later conflict announces again (gh recomputes
//      mergeability on pushes to the base and the head, so this goes back and forth)
//  T5  BEHIND is announced (the base moved; the PR needs a rebase/merge before it can land)
//  T6  GitHub's transient UNKNOWN (recompute in flight) announces nothing and keeps the state
//  T7  the observe_pr tool result carries mergeable/mergeableState, and a PR that already
//      conflicts when the tool starts it is not announced a second time by the first poll
import "./gh-fast-env.ts";
import ext from "../extensions/observe-pr.ts";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function (pi: any) {
	const tools: Record<string, any> = {};
	const commands: Record<string, any> = {};
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
			return pi.registerFlag(name, opts);
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

	process.env.PI_OBSERVE_PR_DELIVERY_DELAY = "500";

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mergeability-test-"));
	process.env.GH_STATE_DIR = tmpDir;
	const binDir = path.join(tmpDir, "bin");
	fs.mkdirSync(binDir);

	execSync("git init -b branch-alpha", { cwd: tmpDir });
	execSync("git config user.name 'Test Runner'", { cwd: tmpDir });
	execSync("git config user.email 'test@example.com'", { cwd: tmpDir });

	// Mergeability comes from marker files so each transition is a real change the poll observes.
	const mockGhScript = `#!/usr/bin/env bash
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  target="$3"
  if [ "$target" = "branch-alpha" ] || [ "$target" = "101" ]; then
    if [ -f "$GH_STATE_DIR/conflicting" ]; then
      MERGEABLE='"mergeable": "CONFLICTING", "mergeableState": "DIRTY"'
    elif [ -f "$GH_STATE_DIR/behind" ]; then
      MERGEABLE='"mergeable": "MERGEABLE", "mergeableState": "BEHIND"'
    elif [ -f "$GH_STATE_DIR/recompute" ]; then
      MERGEABLE='"mergeable": "UNKNOWN", "mergeableState": "UNKNOWN"'
    else
      MERGEABLE='"mergeable": "MERGEABLE", "mergeableState": "CLEAN"'
    fi
    echo '{"number": 101, "state": "OPEN", "isDraft": false, "comments": [], "statusCheckRollup": [], '"$MERGEABLE"' }'
    exit 0
  elif [ "$target" = "202" ]; then
    echo '{"number": 202, "state": "OPEN", "isDraft": false, "comments": [], "statusCheckRollup": [], "mergeable": "CONFLICTING", "mergeableState": "DIRTY"}'
    exit 0
  else
    echo "no pull requests found" >&2
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

	const originalPath = process.env.PATH;
	process.env.PATH = `${binDir}:${originalPath}`;

	ext(mockPi);

	const mockUI = {
		setStatus(_name: string, _status?: string) {},
		notify(_msg: string, _type?: string) {},
	};
	const mockCtx = { cwd: tmpDir, ui: mockUI, mode: "cli", hasUI: false };

	function sleep(ms: number) {
		return new Promise((r) => setTimeout(r, ms));
	}

	async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (pred()) return;
			await sleep(100);
		}
		throw new Error(`Timed out waiting for: ${what}`);
	}

	function assert(cond: boolean, msg: string) {
		if (!cond) throw new Error(msg);
	}

	const conflictMsgs = () => sentMessages.filter((m) => m.includes("conflicts with its base"));
	const behindMsgs = () => sentMessages.filter((m) => m.includes("moved ahead"));

	// One poll round, driven the way a turn end drives it (deterministic; the interval timer is 60 s).
	async function pollRound() {
		for (const h of eventHandlers["turn_end"] || []) {
			await h({ type: "turn_end" }, mockCtx);
		}
		// The round is scheduled, not awaited: give it time to finish its gh calls.
		await waitFor(() => (globalThis as any).__PI_OBSERVE_PR_FLUSH__ instanceof Function, 5000, "the task-scope flush hook");
		await (globalThis as any).__PI_OBSERVE_PR_FLUSH__(5000);
	}

	pi.on("session_start", async () => {
		try {
			console.log("=== Testing observe-pr mergeability notifications (issue 69) ===");

			// Let the -p "test" turn release the startup announcement suppression (the deferred
			// tracking notice rides that message; it never appears in sentMessages).
			await sleep(3000);

			// Auto-detect PR 101 on branch-alpha: the real session_start ran with the pi process
			// cwd, so the branch check is triggered from the test repo via turn_end.
			await pollRound();
			await waitFor(() => ((globalThis as any).__PI_OBSERVED_PRS__?.size ?? 0) >= 1, 5000, "PR 101 auto-detected");

			// T1: mergeable (CLEAN) - the first polls classify silently.
			await pollRound();
			await pollRound();
			assert(conflictMsgs().length === 0, `T1: a mergeable PR was announced as conflicting: ${JSON.stringify(conflictMsgs())}`);
			assert(behindMsgs().length === 0, "T1: a clean PR was announced as behind");
			console.log("✓ T1: a mergeable PR is observed silently");

			// T2: the base moved and the merge now conflicts.
			fs.writeFileSync(path.join(tmpDir, "conflicting"), "1");
			await pollRound();
			await waitFor(() => conflictMsgs().length === 1, 5000, "the conflict announcement");
			assert(conflictMsgs()[0].includes("PR 101"), `T2: announcement does not name the PR: ${conflictMsgs()[0]}`);
			console.log("✓ T2: the transition to CONFLICTING is announced");

			// T3: the same state, polled again - no duplicate.
			await pollRound();
			assert(conflictMsgs().length === 1, `T3: the conflict was announced twice: ${JSON.stringify(conflictMsgs())}`);
			console.log("✓ T3: the same conflict state is never announced twice in a row");

			// T4: the conflict is resolved (silent), then comes back (announced again).
			fs.rmSync(path.join(tmpDir, "conflicting"));
			await pollRound();
			assert(conflictMsgs().length === 1, "T4: becoming mergeable again was announced");
			fs.writeFileSync(path.join(tmpDir, "conflicting"), "1");
			await pollRound();
			await waitFor(() => conflictMsgs().length === 2, 5000, "the second conflict announcement");
			console.log("✓ T4: clearing is silent, a returning conflict announces again");

			// T5: the base moved without a conflict.
			fs.rmSync(path.join(tmpDir, "conflicting"));
			fs.writeFileSync(path.join(tmpDir, "behind"), "1");
			await pollRound();
			await waitFor(() => behindMsgs().length === 1, 5000, "the BEHIND announcement");
			assert(behindMsgs()[0].includes("PR 101"), `T5: announcement does not name the PR: ${behindMsgs()[0]}`);
			console.log("✓ T5: BEHIND is announced");

			// T6: GitHub recomputing (UNKNOWN) - no information, no announcement, state kept.
			fs.rmSync(path.join(tmpDir, "behind"));
			fs.writeFileSync(path.join(tmpDir, "recompute"), "1");
			await pollRound();
			assert(behindMsgs().length === 1 && conflictMsgs().length === 2, "T6: the UNKNOWN recompute window was announced");
			// And the state survived it: back to CLEAN, then conflicting again announces once more
			// (had UNKNOWN reset the last-seen state, this would still pass - but had it been read
			// as a transition to something, an announcement would have leaked above).
			fs.rmSync(path.join(tmpDir, "recompute"));
			await pollRound();
			assert(conflictMsgs().length === 2 && behindMsgs().length === 1, "T6: returning to CLEAN was announced");
			console.log("✓ T6: the UNKNOWN recompute window announces nothing and keeps the state");

			// T7: the explicit observe_pr tool result carries the mergeability, and a PR that
			// already conflicts when observed is not announced a second time by the first poll.
			const res = await tools["observe_pr"].execute("call-1", { pr_number: 202 }, undefined, undefined, mockCtx);
			assert(res.content[0].text.includes("Starting observing 202."), `T7: unexpected tool text: ${res.content[0].text}`);
			assert(
				res.details.mergeable === "CONFLICTING" && res.details.mergeableState === "DIRTY",
				`T7: tool result lacks mergeability: ${JSON.stringify(res.details)}`,
			);
			await pollRound();
			assert(
				!sentMessages.some((m) => m.includes("PR 202") && (m.includes("conflicts") || m.includes("moved ahead"))),
				"T7: the first poll re-announced the conflict the tool result already reported",
			);
			console.log("✓ T7: the tool result carries mergeable/mergeableState and the conflict is not re-announced");

			console.log("✓ All observe-pr mergeability tests passed!");
			fs.rmSync(tmpDir, { recursive: true, force: true });
			process.env.PATH = originalPath;
			delete process.env.GH_STATE_DIR;
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
