// Run with: node --test test/test-pr-observer-hooks.ts
//
// The pr-observer plugin's lifecycle hooks (plugins/pr-observer/scripts): the Stop watcher
// (check-settle.mjs), the PostToolUse change notifier (notify-changes.mjs) and the SessionStart
// state init (session-init.mjs). Each script is spawned the way the host runs it - a fake `gh`
// first on PATH, the event payload on stdin - and every failure path must fail OPEN (exit 0,
// nothing blocked) with a line in the hook log.
//
// Coverage map:
//   stop hook   no PR / merged / draft / landable -> allow; conflict / BEHIND / failing CI ->
//               block with the reason; CI running -> chunked watch with heartbeat re-arms, the
//               shared budget allows in the end; mid-watch transitions (merged, PR changed,
//               conflict, CI failed) block or allow; transient poll failures keep watching;
//               corrupt state restarts the clock; an unwritable state dir still emits the block;
//               broken gh / garbage output fail open, logged; re-entries carry stop_hook_active.
//   notify hook baseline silent; every transition injects; no-change silent; min-interval gate;
//               unreadable checks is not "running again" news; PR gone / changed; broken gh.
//   session-init state file created; corrupt state replaced; week-old state swept, recent kept.
//   all hooks   no stdin payload, malformed stdin JSON.
import { test, after } from "node:test";
import * as assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(REPO, "plugins", "pr-observer");
const SCRIPTS = path.join(PLUGIN, "scripts");

const closeFns: Array<() => void> = [];
after(() => {
	for (const close of closeFns.splice(0)) close();
});

interface Fixture {
	dir: string;
	stateDir: string;
	ghState: string;
	env: Record<string, string>;
}

/**
 * A throwaway repo + fake gh + state dir. Marker files `<ghState>.<name>` flip the PR's state;
 * the counter markers (flakyview, switchpr, mergewatch) change the answer after N `pr view`
 * calls, so a transition can happen mid-watch rather than before the hook starts.
 */
function fixture(name: string): Fixture {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pr-hooks-${name}-`));
	const stateDir = path.join(dir, "state");
	const ghState = path.join(dir, "ghstate");
	fs.mkdirSync(stateDir);
	fs.mkdirSync(path.join(dir, "bin"));
	fs.writeFileSync(
		path.join(dir, "bin", "gh"),
		`#!/usr/bin/env bash
STATE="${ghState}"
# A counter that increments on every pr view call (for mid-watch transitions).
bump() { n=$(cat "$STATE.$1" 2>/dev/null || echo 0); echo $((n+1)) > "$STATE.$1"; echo "$n"; }
MERGEABLE='"mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN"'
if [ -f "$STATE.conflict" ]; then MERGEABLE='"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"'; fi
if [ -f "$STATE.behind" ]; then MERGEABLE='"mergeable": "MERGEABLE", "mergeStateStatus": "BEHIND"'; fi
DRAFT=false
if [ -f "$STATE.draft" ]; then DRAFT=true; fi
NUM=7
STATE_FIELD='"state": "OPEN"'
if [ -f "$STATE.merged" ]; then STATE_FIELD='"state": "MERGED"'; fi
if [ -f "$STATE.switchpr" ]; then
  n=$(bump switchcount); if [ "$n" -ge 2 ]; then NUM=8; fi
fi
if [ -f "$STATE.switchpr1" ]; then
  n=$(bump switch1count); if [ "$n" -ge 1 ]; then NUM=8; fi
fi
if [ -f "$STATE.conflictafter" ]; then
  n=$(bump conflictcount); if [ "$n" -ge 2 ]; then MERGEABLE='"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"'; fi
fi
if [ -f "$STATE.mergewatch" ]; then
  n=$(bump mergewatchcount); if [ "$n" -ge 2 ]; then STATE_FIELD='"state": "MERGED"'; fi
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -f "$STATE.flakyview" ]; then
    n=$(bump flakycount); if [ "$n" = "1" ]; then echo "gh: boom" >&2; exit 1; fi
  fi
  if [ -f "$STATE.garbageview" ]; then
    echo "<html>not json</html>"
    exit 0
  fi
  if [ -f "$STATE.nopr" ]; then
    echo "no pull requests found for branch feat" >&2
    exit 1
  fi
  echo '{"number": '"$NUM"', '"$STATE_FIELD"', "isDraft": '"$DRAFT"', '"$MERGEABLE"'}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  if [ -f "$STATE.cifailafter" ]; then
    n=$(bump cifailcount); if [ "$n" -ge 1 ]; then
      echo '[{"name":"build","bucket":"fail","state":"FAILURE"}]'
      exit 1
    fi
  fi
  if [ -f "$STATE.cibroken" ]; then
    exit 1
  fi
  if [ -f "$STATE.cifail" ]; then
    echo '[{"name":"build","bucket":"fail","state":"FAILURE"},{"name":"lint","bucket":"pass","state":"SUCCESS"}]'
    exit 1
  fi
  if [ -f "$STATE.cipending" ]; then
    echo '[{"name":"build","bucket":"pending","state":"PENDING"}]'
    exit 0
  fi
  echo '[{"name":"build","bucket":"pass","state":"SUCCESS"}]'
  exit 0
fi
exit 0
`,
		{ mode: 0o755 },
	);
	return {
		dir,
		stateDir,
		ghState,
		env: {
			PATH: `${path.join(dir, "bin")}:${process.env.PATH ?? ""}`,
			PR_OBSERVER_HOOK_STATE_DIR: stateDir,
			DEVIN_PROJECT_DIR: dir,
			DEVIN_PLUGIN_ROOT: PLUGIN,
		},
	};
}

interface HookResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runHook(script: string, stdin: object | string, env: Record<string, string>, timeoutMs = 30_000): Promise<HookResult> {
	return new Promise((resolve) => {
		const child: ChildProcess = spawn("node", [path.join(SCRIPTS, script)], {
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(typeof stdin === "string" ? stdin : JSON.stringify(stdin));
		// A hook that never answers must not hang the suite: kill and report.
		const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", () => clearTimeout(killer));
	});
}

function readLog(fx: Fixture): string {
	try {
		return fs.readFileSync(path.join(fx.stateDir, "hooks.log"), "utf8");
	} catch {
		return "";
	}
}

/** The session's state file, found by prefix (the key carries a hash the test does not recompute). */
function readStateFile(fx: Fixture, sessionPrefix: string): any {
	try {
		const file = fs.readdirSync(fx.stateDir).find((f) => f.startsWith(`state-${sessionPrefix}`) && f.endsWith(".json"));
		return file ? JSON.parse(fs.readFileSync(path.join(fx.stateDir, file), "utf8")) : undefined;
	} catch {
		return undefined;
	}
}

const WATCH_ENV = (fx: Fixture, maxWatchMs = "600000"): Record<string, string> => ({
	...fx.env,
	PR_OBSERVER_HOOK_POLL_MS: "60",
	PR_OBSERVER_HOOK_CHUNK_MS: "250",
	PR_OBSERVER_HOOK_MAX_WATCH_MS: maxWatchMs,
});

// ------------------------------------------------------------------ session-init

test("session-init records the baseline state", async () => {
	const fx = fixture("init");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const res = await runHook("session-init.mjs", { session_id: "sess-init" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "");
	const state = readStateFile(fx, "sess-init-");
	assert.ok(state, "a state file must exist");
	assert.ok(state.createdAt, "the state file carries the creation time");
	assert.equal(state.lastCheckAt, 0);
	assert.ok(readLog(fx).includes("session watch state initialized"));
});

test("session-init replaces a corrupt state file", async () => {
	const fx = fixture("initcorrupt");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const key = stateKeyFor(fx, "sess-corrupt");
	fs.writeFileSync(path.join(fx.stateDir, key), "{not json");
	const res = await runHook("session-init.mjs", { session_id: "sess-corrupt" }, fx.env);
	assert.equal(res.code, 0);
	const state = readStateFile(fx, "sess-corrupt-");
	assert.ok(state?.createdAt, "the corrupt file was replaced with a valid one");
});

test("session-init sweeps week-old state files and keeps recent ones", async () => {
	const fx = fixture("sweep");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const oldFile = path.join(fx.stateDir, "state-old-aaa.json");
	const recentFile = path.join(fx.stateDir, "state-recent-bbb.json");
	const logFile = path.join(fx.stateDir, "hooks.log");
	fs.writeFileSync(oldFile, "{}");
	fs.writeFileSync(recentFile, "{}");
	fs.writeFileSync(logFile, "");
	const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
	fs.utimesSync(oldFile, weekAgo, weekAgo);
	const res = await runHook("session-init.mjs", { session_id: "sess-sweep" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(fs.existsSync(oldFile), false, "the week-old state file is swept");
	assert.equal(fs.existsSync(recentFile), true, "the recent state file is kept");
	assert.equal(fs.existsSync(logFile), true, "the log is never swept");
});

// ------------------------------------------------------------------ stop hook: allow paths

test("stop hook: no PR, merged PR, draft PR, and a landable PR all allow the stop", async () => {
	const fx = fixture("allow");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));

	fs.writeFileSync(`${fx.ghState}.nopr`, "1");
	let res = await runHook("check-settle.mjs", { session_id: "s-allow" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "no PR: nothing blocked");
	assert.ok(readLog(fx).includes("no open non-draft PR"));
	fs.rmSync(`${fx.ghState}.nopr`);

	fs.writeFileSync(`${fx.ghState}.merged`, "1");
	res = await runHook("check-settle.mjs", { session_id: "s-allow" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "merged PR: nothing blocked");
	fs.rmSync(`${fx.ghState}.merged`);

	fs.writeFileSync(`${fx.ghState}.draft`, "1");
	res = await runHook("check-settle.mjs", { session_id: "s-allow" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "draft PR: nothing blocked");
	fs.rmSync(`${fx.ghState}.draft`);

	res = await runHook("check-settle.mjs", { session_id: "s-allow" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "landable PR (CI passed + mergeable): nothing blocked");
});

// ------------------------------------------------------------------ stop hook: block paths

test("stop hook: conflict, BEHIND and failing CI block with the reason naming the PR", async () => {
	const fx = fixture("block");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));

	fs.writeFileSync(`${fx.ghState}.conflict`, "1");
	let res = await runHook("check-settle.mjs", { session_id: "s-block" }, fx.env);
	assert.equal(res.code, 0);
	let out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block");
	assert.match(out.reason, /PR #7 .*conflicts/);

	fs.rmSync(`${fx.ghState}.conflict`);
	fs.writeFileSync(`${fx.ghState}.behind`, "1");
	res = await runHook("check-settle.mjs", { session_id: "s-block" }, fx.env);
	out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block");
	assert.match(out.reason, /moved ahead/);
	assert.match(out.reason, /mergeStateStatus: BEHIND/, "the agent-facing string uses gh's real field name");

	fs.rmSync(`${fx.ghState}.behind`);
	fs.writeFileSync(`${fx.ghState}.cifail`, "1");
	res = await runHook("check-settle.mjs", { session_id: "s-block" }, fx.env);
	out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block");
	assert.match(out.reason, /CI failed for PR #7/);
	assert.match(out.reason, /build/, "the failing check's name is in the reason");
});

// ------------------------------------------------------------------ stop hook: the watch loop

test("stop hook: CI running holds the stop, re-arms with a heartbeat, and allows it once CI passes", async () => {
	const fx = fixture("watch");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = WATCH_ENV(fx);

	// First stop: CI pending -> the chunk runs out -> heartbeat block, and the watch clock is persisted.
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-watch" }, env);
	assert.equal(res.code, 0);
	const out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block");
	assert.match(out.reason, /still running/);
	assert.match(out.reason, /End your turn again/);
	const state = readStateFile(fx, "s-watch-");
	assert.ok(state?.watchStartedAt, "the watch start is persisted for the re-arms");
	assert.equal(state.reArms, 1);
	// (notify-changes keys its PR-gone/PR-changed news on this: the snapshot must carry the number)
	assert.equal(state.lastSnapshot?.prNumber, 7, "the persisted snapshot carries the PR number");

	// Re-entry with stop_hook_active (the way the host marks a re-armed stop), CI now passed: allowed.
	fs.rmSync(`${fx.ghState}.cipending`);
	const res2 = await runHook("check-settle.mjs", { session_id: "s-watch", stop_hook_active: true }, env);
	assert.equal(res2.code, 0);
	assert.equal(res2.stdout, "", "CI passed: the stop goes through");
});

test("stop hook: the shared watch budget eventually allows the stop", async () => {
	const fx = fixture("budget");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = WATCH_ENV(fx, "200");
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-budget" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "the exhausted watch budget must allow the stop, not block forever");
	assert.ok(readLog(fx).includes("watch budget exhausted"));
});

test("stop hook: a watch whose budget was spent in earlier re-arms allows the stop immediately", async () => {
	const fx = fixture("budgetcarry");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	// Pre-seed the state the way an earlier re-arm left it: the watch started 5 hours ago.
	const key = stateKeyFor(fx, "s-carry");
	fs.writeFileSync(path.join(fx.stateDir, key), JSON.stringify({ watchStartedAt: Date.now() - 5 * 60 * 60 * 1000, reArms: 3 }));
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-carry" }, WATCH_ENV(fx));
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "the carried budget must allow the stop without another chunk of waiting");
	assert.ok(readLog(fx).includes("watch budget exhausted"));
});

test("stop hook: the PR merges while CI is being watched -> the stop is allowed", async () => {
	const fx = fixture("mergewatch");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	fs.writeFileSync(`${fx.ghState}.mergewatch`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-mw" }, WATCH_ENV(fx));
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "merged mid-watch: the stop goes through");
	assert.ok(readLog(fx).includes("closed or merged while watching"));
});

test("stop hook: the branch's PR changes mid-watch -> blocked with the change as news", async () => {
	const fx = fixture("switchpr");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	fs.writeFileSync(`${fx.ghState}.switchpr`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-sw" }, WATCH_ENV(fx));
	assert.equal(res.code, 0);
	const out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block");
	assert.match(out.reason, /changed from #7 to #8/);
});

test("stop hook: a conflict appearing mid-watch blocks with the news", async () => {
	const fx = fixture("midconflict");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	// The conflict appears after the watch started: the counter marker flips the answer on the
	// second `pr view` call (the first is the hook's initial snapshot), not on a wall clock that
	// races the hook's startup.
	fs.writeFileSync(`${fx.ghState}.conflictafter`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-mc" }, WATCH_ENV(fx));
	assert.equal(res.code, 0);
	const out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block");
	assert.match(out.reason, /began conflicting/);
});

test("stop hook: CI failing mid-watch blocks with the news", async () => {
	const fx = fixture("midfail");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	fs.writeFileSync(`${fx.ghState}.cifailafter`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-mf" }, WATCH_ENV(fx));
	assert.equal(res.code, 0);
	const out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block");
	assert.match(out.reason, /failed for PR #7 while it was being watched/);
});

test("stop hook: a transient poll failure keeps the watch going", async () => {
	const fx = fixture("flaky");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	fs.writeFileSync(`${fx.ghState}.flakyview`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-flaky" }, WATCH_ENV(fx));
	assert.equal(res.code, 0);
	const out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block", "one failed poll must not end the watch: the heartbeat still comes");
	assert.match(out.reason, /still running/);
	assert.ok(readLog(fx).includes("poll read failed; continuing the watch"));
});

// ------------------------------------------------------------------ stop hook: failure paths

test("stop hook: a broken gh fails open with the failure logged", async () => {
	const fx = fixture("broken");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.writeFileSync(path.join(fx.dir, "bin", "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
	const res = await runHook("check-settle.mjs", { session_id: "s-broken" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "a broken gh must not block the stop");
	assert.match(readLog(fx), /could not read the PR; allowing the stop/);
});

test("stop hook: garbage gh output fails open with the failure logged", async () => {
	const fx = fixture("garbage");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.writeFileSync(`${fx.ghState}.garbageview`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-garbage" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "unparseable gh output must not block the stop");
	assert.match(readLog(fx), /could not read the PR; allowing the stop/);
});

test("stop hook: pr view ok but the checks call broken -> allowed (CI unreadable is fail-open)", async () => {
	const fx = fixture("checksbroken");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.writeFileSync(`${fx.ghState}.cibroken`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-cb" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "an unreadable checks call must not hold the stop");
	assert.ok(readLog(fx).includes("landable (or CI is unreadable)"));
});

test("stop hook: a corrupt state file restarts the watch clock instead of failing", async () => {
	const fx = fixture("corruptstate");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const key = stateKeyFor(fx, "s-corrupt");
	fs.writeFileSync(path.join(fx.stateDir, key), "{corrupt json");
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-corrupt" }, WATCH_ENV(fx));
	assert.equal(res.code, 0);
	const out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block");
	assert.match(out.reason, /still running/, "the watch ran with a fresh clock");
	const state = readStateFile(fx, "s-corrupt-");
	assert.ok(state?.watchStartedAt, "the corrupt file was replaced by a valid one");
});

test("stop hook: an unwritable state dir must not prevent the block from being emitted", async () => {
	const fx = fixture("unwritable");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	fs.chmodSync(fx.dir, 0o500); // read+execute only: creating the state dir fails
	try {
		const res = await runHook("check-settle.mjs", { session_id: "s-unwritable" }, WATCH_ENV(fx));
		assert.equal(res.code, 0);
		const out = JSON.parse(res.stdout);
		assert.equal(out.decision, "block", "the heartbeat is still delivered with nowhere to persist");
		assert.match(out.reason, /still running/);
	} finally {
		fs.chmodSync(fx.dir, 0o700);
	}
});

// ------------------------------------------------------------------ notify hook

test("notify hook: baseline is silent, transitions inject, no-change stays silent", async () => {
	const fx = fixture("notify");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = { ...fx.env, PR_OBSERVER_HOOK_MIN_NOTIFY_MS: "0" };

	let res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "the baseline is not news");

	fs.writeFileSync(`${fx.ghState}.conflict`, "1");
	res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	let out = JSON.parse(res.stdout);
	assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
	assert.match(out.hookSpecificOutput.additionalContext, /now conflicts/);

	res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "no transition: nothing injected");

	fs.rmSync(`${fx.ghState}.conflict`);
	res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	out = JSON.parse(res.stdout);
	assert.match(out.hookSpecificOutput.additionalContext, /mergeable again/);

	fs.writeFileSync(`${fx.ghState}.cifail`, "1");
	res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	out = JSON.parse(res.stdout);
	assert.match(out.hookSpecificOutput.additionalContext, /CI for PR #7 failed/);

	// CI passes: the other direction is news too.
	fs.rmSync(`${fx.ghState}.cifail`);
	res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	out = JSON.parse(res.stdout);
	assert.match(out.hookSpecificOutput.additionalContext, /All CI passed/);
});

test("notify hook: an unreadable checks call is not reported as 'CI running again'", async () => {
	const fx = fixture("ciunreadable");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = { ...fx.env, PR_OBSERVER_HOOK_MIN_NOTIFY_MS: "0" };

	let res = await runHook("notify-changes.mjs", { session_id: "s-cu", tool_name: "exec" }, env);
	assert.equal(res.stdout, "");

	fs.writeFileSync(`${fx.ghState}.cibroken`, "1");
	res = await runHook("notify-changes.mjs", { session_id: "s-cu", tool_name: "exec" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "an unreadable checks call must not inject 'CI is running again'");
	const state = readStateFile(fx, "s-cu-");
	assert.equal(state?.lastSnapshot?.ciUnreadable, true);

	fs.rmSync(`${fx.ghState}.cibroken`);
	fs.writeFileSync(`${fx.ghState}.cifail`, "1");
	res = await runHook("notify-changes.mjs", { session_id: "s-cu", tool_name: "exec" }, env);
	const out = JSON.parse(res.stdout);
	assert.match(out.hookSpecificOutput.additionalContext, /CI for PR #7 failed/);
});

test("notify hook: the PR merging mid-session is injected as 'no longer open'", async () => {
	const fx = fixture("notifygone");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = { ...fx.env, PR_OBSERVER_HOOK_MIN_NOTIFY_MS: "0" };

	let res = await runHook("notify-changes.mjs", { session_id: "s-ng", tool_name: "exec" }, env);
	assert.equal(res.stdout, "", "baseline");

	fs.writeFileSync(`${fx.ghState}.merged`, "1");
	res = await runHook("notify-changes.mjs", { session_id: "s-ng", tool_name: "exec" }, env);
	const out = JSON.parse(res.stdout);
	assert.match(out.hookSpecificOutput.additionalContext, /no longer open/);
	assert.match(out.hookSpecificOutput.additionalContext, /merged/);
});

test("notify hook: the branch's PR changing rebaselines silently", async () => {
	const fx = fixture("notifyswitch");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = { ...fx.env, PR_OBSERVER_HOOK_MIN_NOTIFY_MS: "0" };

	// The marker exists from the start: the baseline call is bump #1 (still #7), the next call is
	// bump #2 (#8) - the transition.
	fs.writeFileSync(`${fx.ghState}.switchpr1`, "1");
	let res = await runHook("notify-changes.mjs", { session_id: "s-ns", tool_name: "exec" }, env);
	assert.equal(res.stdout, "", "baseline on #7");

	res = await runHook("notify-changes.mjs", { session_id: "s-ns", tool_name: "exec" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "a changed PR is a new baseline, not news");
	assert.ok(readLog(fx).includes("the branch's PR changed; rebaselining"));
});

test("notify hook: the min-interval gate skips the check between tool calls", async () => {
	const fx = fixture("gate");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = { ...fx.env, PR_OBSERVER_HOOK_MIN_NOTIFY_MS: "60000" };

	let res = await runHook("notify-changes.mjs", { session_id: "s-gate", tool_name: "exec" }, env);
	assert.equal(res.stdout, "");
	fs.writeFileSync(`${fx.ghState}.conflict`, "1");
	res = await runHook("notify-changes.mjs", { session_id: "s-gate", tool_name: "exec" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "the gate must skip, not inject");
	assert.ok(readLog(fx).includes("skipped: checked too recently"));
});

test("notify hook: a broken gh fails open with the failure logged", async () => {
	const fx = fixture("notifybroken");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = { ...fx.env, PR_OBSERVER_HOOK_MIN_NOTIFY_MS: "0" };
	fs.writeFileSync(path.join(fx.dir, "bin", "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
	const res = await runHook("notify-changes.mjs", { session_id: "s-nb", tool_name: "exec" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "a broken gh must inject nothing");
	assert.match(readLog(fx), /could not read the PR; injecting nothing/);
});

test("notify hook: an unwritable state dir must not crash the hook", async () => {
	const fx = fixture("notifyunwritable");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	fs.chmodSync(fx.dir, 0o500);
	try {
		const res = await runHook(
			"notify-changes.mjs",
			{ session_id: "s-nu", tool_name: "exec" },
			{ ...fx.env, PR_OBSERVER_HOOK_MIN_NOTIFY_MS: "0" },
		);
		assert.equal(res.code, 0);
		assert.equal(res.stdout, "");
	} finally {
		fs.chmodSync(fx.dir, 0o700);
	}
});

// ------------------------------------------------------------------ defensive stdin

test("hooks run with no stdin payload at all", async () => {
	const fx = fixture("nostdin");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	for (const script of ["check-settle.mjs", "notify-changes.mjs", "session-init.mjs"]) {
		const res = await runHook(script, {}, fx.env);
		assert.equal(res.code, 0, `${script} survives an empty payload`);
	}
});

test("hooks survive malformed stdin JSON", async () => {
	const fx = fixture("badjson");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	for (const script of ["check-settle.mjs", "notify-changes.mjs", "session-init.mjs"]) {
		const res = await runHook(script, "{not json at all", fx.env);
		assert.equal(res.code, 0, `${script} survives malformed JSON`);
	}
});

/** Recomputes the state file name the way hook-lib's stateKey does (sha1 of session+cwd). */
function stateKeyFor(fx: Fixture, sessionId: string): string {
	return `state-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}-${cryptoHash(`${sessionId}\n${fx.dir}`)}.json`;
}

function cryptoHash(input: string): string {
	// (mirror of hook-lib's key: sha1, first 12 hex chars)
	return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}
