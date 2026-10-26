// Run with: pi -ne -e test/test-observe-pr-branch-scan.ts --offline -p "test"
//
// The branch scan's share of GitHub-failure handling, in its own process because it needs a slot
// topology no other observe-pr suite gives it: **no observed PR and no pending auto-start**, so the scan
// is the first thing to ask for the single ghHealth retry slot. In a normal round
// (`test-observe-pr-gh-failure.ts`) `pollAllObservedPRs` runs before `checkTrackedBranches` and takes the
// slot, so a branch-scan assertion written there cannot run at all - which is a finding on its own
// (#63), and the reason this file exists instead of a T5 appended to that suite.
//
//  T1  a tracked branch with no PR stays silent while gh is reachable
//  T2  a GitHub-availability failure from the scan is silent AND counted as a failure. It must not be
//      read as "the scan succeeded": that flips the shared backoff from degraded back to healthy while
//      gh still cannot connect, and the recovery hooks fire mid-outage. (Regression introduced by the
//      move to the subprocess door; found in independent review of `3c149dc`.)
//  T3  a gh failure that is *not* availability is written to the log - the discrimination has to cut
//      both ways, or "gh is broken" and "this branch has no PR" stay the same silence forever - and an
//      answer from gh, even a bad one, does restore health, because it proves reachability.
import "./gh-fail-env.ts";
import ext from "../extensions/observe-pr.ts";
import { logPath } from "../extensions/lib/extension-log.ts";
import { ghHealth } from "../extensions/lib/gh-health.ts";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BRANCH = "branch-scan";
const LOG_SCOPE = "observe-pr";

export default function (pi: any) {
	const eventHandlers: Record<string, Function[]> = {};
	const activeTools = ["observe_pr"];

	const mockPi = {
		...pi,
		on(event: string, handler: any) {
			(eventHandlers[event] ||= []).push(handler);
			return pi.on(event, handler);
		},
		registerTool(t: any) {
			return pi.registerTool(t);
		},
		registerCommand() {},
		// 60 s: the branch poll timer must not be what drives these rounds, the test does.
		registerFlag(_name: string, opts: any) {
			opts.default = "60";
			return pi.registerFlag(_name, opts);
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(t: string[]) {
			activeTools.length = 0;
			activeTools.push(...t);
		},
		sendUserMessage() {},
	};

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-branch-scan-"));
	process.env.PI_EXTENSION_LOG_DIR = path.join(tmpDir, "logs");
	const binDir = path.join(tmpDir, "bin");
	fs.mkdirSync(binDir);
	execSync(`git init -b ${BRANCH}`, { cwd: tmpDir });
	execSync("git config user.name 'Test Runner'", { cwd: tmpDir });
	execSync("git config user.email 'test@example.com'", { cwd: tmpDir });
	process.env.GH_STATE_DIR = tmpDir;

	const mockGh = `#!/usr/bin/env bash
echo "$(date +%s%3N) $*" >> "$GH_STATE_DIR/gh-calls.log"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -f "$GH_STATE_DIR/boom" ]; then
    echo "gh: an unexpected error occurred while fetching the pull request" >&2
    exit 1
  fi
  if [ -f "$GH_STATE_DIR/offline" ]; then
    echo "gh: failed to connect: dial tcp 140.107.20.17:443: i/o timeout" >&2
    exit 1
  fi
  # What gh really says for a branch without a pull request: a normal answer, not an outage.
  echo "no pull requests found for branch \\"$3\\"" >&2
  exit 1
fi
exit 0
`;
	fs.writeFileSync(path.join(binDir, "gh"), mockGh, { mode: 0o755 });
	process.env.PATH = `${binDir}:${process.env.PATH}`;

	ext(mockPi);

	const mockCtx = { cwd: tmpDir, ui: { setStatus() {}, notify() {} }, mode: "cli", hasUI: false };

	function sleep(ms: number) {
		return new Promise((r) => setTimeout(r, ms));
	}

	async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (pred()) return;
			await sleep(150);
		}
		throw new Error(`Timed out waiting for: ${what}`);
	}

	function assert(cond: boolean, msg: string) {
		if (!cond) throw new Error(msg);
	}

	function countGhCalls(needle: string): number {
		try {
			return fs
				.readFileSync(path.join(tmpDir, "gh-calls.log"), "utf8")
				.split("\n")
				.filter((l) => l.includes(needle)).length;
		} catch {
			return 0;
		}
	}

	/** What the extension wrote to its own log - `console.*` is not where internal failures go. */
	function logLines(needle: string): string[] {
		try {
			return fs
				.readFileSync(logPath(LOG_SCOPE), "utf8")
				.split("\n")
				.filter((l) => l.includes(needle));
		} catch {
			return [];
		}
	}

	async function nudge(): Promise<void> {
		for (const h of eventHandlers["turn_end"] || []) {
			await h({ type: "turn_end" }, mockCtx);
		}
	}

	pi.on("session_start", async () => {
		try {
			console.log("=== Testing branch-scan GitHub-failure handling ===");
			// Let the -p "test" turn release the startup announcement suppression.
			await sleep(2500);

			// T1: tracked and reachable. `gh pr view` answers "no pull requests found" and exits 1; that is
			// the ordinary case for a branch with no PR and must produce neither a log line nor a failure.
			await nudge();
			await waitFor(() => countGhCalls(`pr view ${BRANCH}`) >= 1, 15000, `the branch scan to look up ${BRANCH}`);
			assert(ghHealth.status === "healthy", `T1: a branch with no PR was recorded as a GitHub failure (${ghHealth.consecutiveFailures})`);
			assert(logLines(BRANCH).length === 0, `T1: a branch with no PR was logged: ${JSON.stringify(logLines(BRANCH))}`);
			console.log("✓ T1: a tracked branch with no PR stays silent while gh is reachable");

			// T2: the outage. The scan is the only gh caller in this process, so it gets the slot on the
			// nudge rather than losing it to the poll - see the header.
			fs.writeFileSync(path.join(tmpDir, "offline"), "1");
			const before = countGhCalls(`pr view ${BRANCH}`);
			await nudge();
			await waitFor(() => countGhCalls(`pr view ${BRANCH}`) > before, 15000, "a scan round to reach gh during the outage");
			assert(
				ghHealth.status === "degraded",
				"T2: the branch scan did not report the availability failure - ghHealth is healthy while gh cannot connect, so the backoff resets mid-outage",
			);
			assert(logLines(BRANCH).length === 0, `T2: a GitHub-availability failure was logged: ${JSON.stringify(logLines(BRANCH))}`);
			console.log("✓ T2: an availability failure from the branch scan is silent and counted as a failure");

			// T3: gh answers, and says something wrong. Health comes back (an answer proves reachability)
			// and the reason is written down - the half of the discrimination that keeps "gh is broken" from
			// being indistinguishable from "no PR here".
			fs.rmSync(path.join(tmpDir, "offline"));
			fs.writeFileSync(path.join(tmpDir, "boom"), "1");
			await waitFor(() => logLines(BRANCH).length > 0, 20000, "a non-availability gh failure to reach the log");
			assert(logLines("unexpected error").length > 0, `T3: the wrong thing was logged: ${JSON.stringify(logLines(BRANCH))}`);
			await waitFor(() => ghHealth.status === "healthy", 20000, "an answer from gh to restore health");
			console.log("✓ T3: a non-availability gh failure is logged and an answer from gh restores health");

			console.log("✓ All branch-scan GitHub-failure tests passed!");
			process.exit(0);
		} catch (err: any) {
			console.error("Test failed:", err);
			process.exit(1);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
}
