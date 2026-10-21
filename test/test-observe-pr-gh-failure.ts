// Run with: pi -ne -e test/test-observe-pr-gh-failure.ts --offline -p "test"
//
// Regression suite for the GitHub-availability failure handling in observe-pr:
//  T1  a `gh run watch` death on a network error must NOT be reported as a CI failure
//  T2  a failed `gh pr checks` must NOT produce a false "All CI passed" message
//  T3  failures are silent (no console output, no agent error messages) and gh calls
//      are paced (>=1s between `pr view` calls, fast 1.5 s cadence, then slow 8 s cadence)
//  T4  after recovery polling/run-watching resumes and pending observe_pr calls auto-start
import "./gh-fail-env.ts";
import ext from "../extensions/observe-pr.ts";
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
	const commands: Record<string, any> = {};
	const sentMessages: string[] = [];
	const eventHandlers: Record<string, Function[]> = {};
	const notifications: Array<{ msg: string; type?: string }> = [];

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
			// 2 s poll interval for a fast test
			opts.default = "2";
			return pi.registerFlag(name, opts);
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

	// (PI_GH_HEALTH_* is set via ./gh-fail-env.ts at module load time: scaled-down
	// backoff — fast 1.5 s x 5, then slow 8 s)
	process.env.PI_OBSERVE_PR_DELIVERY_DELAY = "1000";

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gh-fail-test-"));
	const binDir = path.join(tmpDir, "bin");
	fs.mkdirSync(binDir);

	execSync("git init -b branch-alpha", { cwd: tmpDir });
	execSync("git config user.name 'Test Runner'", { cwd: tmpDir });
	execSync("git config user.email 'test@example.com'", { cwd: tmpDir });
	process.env.GH_STATE_DIR = tmpDir;

	const mockGhScript = `#!/usr/bin/env bash
echo "$(date +%s%3N) $*" >> "$GH_STATE_DIR/gh-calls.log"
offline() { [ -f "$GH_STATE_DIR/offline" ]; }
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  target="$3"
  if offline; then
    echo "gh: failed to connect: dial tcp 140.107.20.17:443: i/o timeout" >&2
    exit 1
  fi
  if [ "$target" = "branch-alpha" ] || [ "$target" = "101" ]; then
    if [ -f "$GH_STATE_DIR/comments_changed" ]; then
      echo '{"number": 101, "state": "OPEN", "isDraft": false, "comments": [{"id": "node1", "databaseId": 55, "url": "https://github.com/testowner/repo/pull/101#issuecomment-55", "updatedAt": "2026-10-19T12:00:01Z", "body": "updated"}], "statusCheckRollup": [{"detailsUrl": "https://github.com/testowner/repo/actions/runs/777"}]}'
    else
      echo '{"number": 101, "state": "OPEN", "isDraft": false, "comments": [{"id": "node1", "databaseId": 55, "url": "https://github.com/testowner/repo/pull/101#issuecomment-55", "updatedAt": "2026-10-19T12:00:00Z", "body": "hello"}], "statusCheckRollup": [{"detailsUrl": "https://github.com/testowner/repo/actions/runs/777"}]}'
    fi
    exit 0
  elif [ "$target" = "202" ]; then
    echo '{"number": 202, "state": "OPEN", "isDraft": false, "comments": [], "statusCheckRollup": []}'
    exit 0
  else
    echo "Could not resolve to a PullRequest with the number $target" >&2
    exit 1
  fi
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  if [ "$3" = "--watch" ]; then
    # (check offline/ci_fail every second: the test can flip state mid-watch)
    for i in 1 2 3 4 5; do
      if offline; then
        echo "gh: failed to connect: i/o timeout" >&2
        exit 1
      fi
      if [ -f "$GH_STATE_DIR/ci_fail" ]; then
        echo "GH: 1 of 2 checks failed for the PR" >&2
        exit 1
      fi
      sleep 1
    done
    exit 0
  fi
  if offline; then
    echo "gh: failed to connect: i/o timeout" >&2
    exit 1
  fi
  echo "[]"
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "watch" ]; then
  if offline; then
    echo "gh: failed to connect: i/o timeout" >&2
    exit 1
  fi
  sleep 2
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "view" ]; then
  if offline; then
    echo "gh: failed to connect: i/o timeout" >&2
    exit 1
  fi
  echo '{"conclusion": "success"}'
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
		notify(msg: string, type?: string) {
			notifications.push({ msg, type });
		},
	};
	const mockCtx = { cwd: tmpDir, ui: mockUI, mode: "cli", hasUI: false };

	function sleep(ms: number) {
		return new Promise((r) => setTimeout(r, ms));
	}

	async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (pred()) return;
			await sleep(200);
		}
		throw new Error(`Timed out waiting for: ${what}`);
	}

	function assert(cond: boolean, msg: string) {
		if (!cond) throw new Error(msg);
	}

	pi.on("session_start", async () => {
		try {
			console.log("=== Testing observe-pr GitHub-failure handling ===");
			// Let the -p "test" turn release the startup announcement suppression
			await sleep(3000);

			// The real session_start ran with the pi process cwd; trigger the branch check
			// from the test repo (where the mock gh can resolve branch-alpha)
			for (const h of eventHandlers["turn_end"] || []) {
				await h({ type: "turn_end" }, mockCtx);
			}

			// PR 101 on branch-alpha should be auto-detected and observed
			await waitFor(() => ((globalThis as any).__PI_OBSERVED_PRS__?.size ?? 0) >= 1, 10000, "PR 101 auto-detected");
			console.log("✓ PR 101 auto-detected and observed");

			// Run 777 (from statusCheckRollup) should be watched
			await waitFor(() => ((globalThis as any).__PI_OBSERVED_PRS__?.get(101)?.activeRuns.size ?? 0) >= 1, 10000, "run 777 being watched");
			console.log("✓ Run 777 is being watched");

			// T4-prep + outage start: an explicit observe_pr call that races the outage
			fs.writeFileSync(path.join(tmpDir, "offline"), "1");
			console.log("— GitHub outage started");
			const observeTool = tools["observe_pr"];
			const toolRes = await observeTool.execute("call-1", { pr_number: 202 }, undefined, undefined, mockCtx);
			const toolText = toolRes.content[0].text;
			console.log("observe_pr(202) during outage:", toolText);
			assert(toolText.includes("GitHub is temporarily unreachable"), `T4: expected concise unreachable status, got: ${toolText}`);
			console.log("✓ T4-prep: observe_pr during outage returns a concise status (no raw stderr)");

			// Wait out the backoff schedule (fast 5 x 1.5 s, then slow 8 s)
			await sleep(24000);

			// T1: no false CI-failure message for run 777
			const falseFailures = sentMessages.filter((m) => m.includes("failed for the pr"));
			assert(falseFailures.length === 0, `T1: false CI-failure messages sent: ${JSON.stringify(falseFailures)}`);
			console.log("✓ T1: no false CI-failure messages during the outage");

			// T2: no false "All CI passed" while GitHub is unreachable
			const falsePassed = sentMessages.filter((m) => m.includes("All CI passed"));
			assert(falsePassed.length === 0, `T2: false 'All CI passed' messages sent: ${JSON.stringify(falsePassed)}`);
			console.log("✓ T2: no false 'All CI passed' message during the outage");

			// T3: silence — no console output, no internal-error notifications
			const noisyConsole = [...consoleErrors, ...consoleWarns].filter(
				(c) => c.includes("observe_pr") || c.includes("timeout") || c.includes("failed to connect"),
			);
			assert(noisyConsole.length === 0, `T3: console output leaked: ${JSON.stringify(noisyConsole)}`);
			const noisyNotifications = notifications.filter((n) => n.msg.includes("observe_pr"));
			assert(noisyNotifications.length === 0, `T3: internal error notifications leaked: ${JSON.stringify(noisyNotifications)}`);
			console.log("✓ T3: failures stayed silent (no console output, no TUI notifications)");

			// T3: pacing — `pr view` attempts from the first failure onward (earlier calls
			// are the normal 2 s cadence / an explicit tool call, not retries)
			const allLines = fs
				.readFileSync(path.join(tmpDir, "gh-calls.log"), "utf8")
				.split("\n")
				.filter((l) => l.includes(" pr view "));
			const outageStartTs = Number.parseInt(allLines.find((l) => l.includes("pr view 202"))?.slice(0, 13) ?? "0", 10);
			const pvTs = allLines.map((l) => Number.parseInt(l.slice(0, l.indexOf(" ")), 10)).filter((ts) => ts >= outageStartTs);
			assert(pvTs.length >= 5, `T3: expected >= 5 paced 'pr view' attempts, got ${pvTs.length}`);
			const gaps: number[] = [];
			for (let i = 1; i < pvTs.length; i++) gaps.push(pvTs[i] - pvTs[i - 1]);
			const minGap = Math.min(...gaps);
			assert(minGap >= 800, `T3: calls were not paced (min gap ${minGap} ms < 800 ms)`);
			const fastGaps = gaps.filter((g) => g >= 800 && g < 4000);
			// (>= 2: slots can be claimed by non-`pr view` ops too — the pacing proof
			// is the min-gap + the slow-tier gap, the fast-gap count is a sanity check)
			assert(fastGaps.length >= 2, `T3: expected at least 2 fast-cadence gaps (1.5 s), got ${fastGaps.length}`);
			const maxGap = Math.max(...gaps);
			assert(maxGap >= 5000, `T3: expected a slow-cadence gap (8 s) after 5 fast failures, max gap was ${maxGap} ms`);
			console.log(
				`✓ T3: gh calls paced — ${pvTs.length} attempts, min gap ${minGap} ms, ${fastGaps.length} fast gaps, max gap ${maxGap} ms`,
			);

			// T4: recovery — outage ends, the pending observe_pr(202) must auto-start
			fs.rmSync(path.join(tmpDir, "offline"));
			fs.writeFileSync(path.join(tmpDir, "comments_changed"), "1");
			console.log("— GitHub recovered; waiting for polling to resume —");

			await waitFor(
				() => sentMessages.some((m) => m.includes("Comment 55 added or updated to the PR 101")),
				25000,
				"comment update after recovery",
			);
			console.log("✓ T4: polling resumed after recovery (comment update delivered)");

			await waitFor(
				() => sentMessages.some((m) => m.includes("All CI passed for the PR 101")),
				25000,
				"All CI passed after run 777 re-watched to success",
			);
			console.log("✓ T4: run 777 re-watched after recovery and 'All CI passed' reported once");
			assert(
				sentMessages.filter((m) => m.includes("All CI passed for the PR 101")).length === 1,
				"T4: 'All CI passed' must be reported exactly once",
			);

			await waitFor(() => ((globalThis as any).__PI_OBSERVED_PRS__?.size ?? 0) >= 2, 25000, "PR 202 auto-start after recovery");
			console.log("✓ T4: pending observe_pr(202) auto-started after recovery");

			// T5: a CI-failure exit of `gh pr checks --watch` (exit 1, no availability
			// error) must NOT be recorded as a GitHub failure and must NOT respawn at
			// 1 s — the restart follows the normal 2 s interval
			fs.writeFileSync(path.join(tmpDir, "ci_fail"), "1");
			const ciFailTs = Date.now();
			await sleep(15000);
			const watchSpawns = fs
				.readFileSync(path.join(tmpDir, "gh-calls.log"), "utf8")
				.split("\n")
				.filter((l) => l.includes(" pr checks 101 ") && l.includes(" --watch ")) // (PR 101 only: the other observed PR's watcher interleaves)
				.map((l) => Number.parseInt(l.slice(0, l.indexOf(" ")), 10))
				.filter((ts) => ts >= ciFailTs - 2000);
			assert(watchSpawns.length >= 2, `T5: expected the checks watcher to keep cycling, got ${watchSpawns.length} spawns`);
			const wGaps: number[] = [];
			for (let i = 1; i < watchSpawns.length; i++) wGaps.push(watchSpawns[i] - watchSpawns[i - 1]);
			const wMinGap = Math.min(...wGaps);
			assert(
				wMinGap >= 1500,
				`T5: the checks watcher respawned at ~1 s (min gap ${wMinGap} ms) — a CI-failure exit was misclassified as a GitHub failure`,
			);
			const falsePassed2 = sentMessages.filter((m) => m.includes("All CI passed") && m.includes("101"));
			assert(falsePassed2.length === 1, `T5: a failing CI must not produce 'All CI passed' (saw ${falsePassed2.length})`);
			console.log(
				`✓ T5: a CI-failure exit of the checks watcher is not a GitHub failure (respawn min gap ${wMinGap} ms = the 2 s interval)`,
			);

			// Final silence check (recovery path must also be quiet)
			const noisyAfter = [...consoleErrors, ...consoleWarns].filter((c) => c.includes("observe_pr"));
			assert(noisyAfter.length === 0, `T3/T4: console output leaked after recovery: ${JSON.stringify(noisyAfter)}`);
			console.log("✓ All observe-pr GitHub-failure tests passed!");

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
