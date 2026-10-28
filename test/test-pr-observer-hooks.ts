// Run with: node --test test/test-pr-observer-hooks.ts
//
// The pr-observer plugin's lifecycle hooks (plugins/pr-observer/scripts): the Stop watcher
// (check-settle.mjs), the PostToolUse change notifier (notify-changes.mjs) and the SessionStart
// state init (session-init.mjs). Each script is spawned the way the host runs it - a fake `gh`
// first on PATH, the event payload on stdin - and every failure path must fail OPEN (exit 0,
// nothing blocked) with a line in the hook log.
import { test, after } from "node:test";
import * as assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

/** A throwaway repo + fake gh + state dir; marker files under ghState flip the PR's state. */
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
MERGEABLE='"mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN"'
if [ -f "$STATE.conflict" ]; then MERGEABLE='"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"'; fi
if [ -f "$STATE.behind" ]; then MERGEABLE='"mergeable": "MERGEABLE", "mergeStateStatus": "BEHIND"'; fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ -f "$STATE.nopr" ]; then
    echo "no pull requests found for branch feat" >&2
    exit 1
  fi
  if [ -f "$STATE.merged" ]; then
    echo '{"number": 7, "state": "MERGED", "isDraft": false, '"$MERGEABLE"'}'
  else
    echo '{"number": 7, "state": "OPEN", "isDraft": false, '"$MERGEABLE"'}'
  fi
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
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

function runHook(script: string, stdin: object, env: Record<string, string>, timeoutMs = 30_000): Promise<HookResult> {
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
		child.stdin.end(JSON.stringify(stdin));
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

test("session-init records the baseline state and sweeps nothing on a fresh dir", async () => {
	const fx = fixture("init");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const res = await runHook("session-init.mjs", { session_id: "sess-init" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "");
	const state = readStateFile(fx, "sess-init-");
	assert.ok(state, "a state file must exist");
	assert.ok(state.createdAt, "the state file carries the creation time");
	assert.ok(readLog(fx).includes("session watch state initialized"));
});

test("stop hook: no PR, merged PR, and a landable PR all allow the stop", async () => {
	const fx = fixture("allow");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));

	// No PR on the branch.
	fs.writeFileSync(`${fx.ghState}.nopr`, "1");
	let res = await runHook("check-settle.mjs", { session_id: "s-allow" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "no PR: nothing blocked");
	fs.rmSync(`${fx.ghState}.nopr`);

	// Merged PR.
	fs.writeFileSync(`${fx.ghState}.merged`, "1");
	res = await runHook("check-settle.mjs", { session_id: "s-allow" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "merged PR: nothing blocked");
	fs.rmSync(`${fx.ghState}.merged`);

	// Green CI + mergeable.
	res = await runHook("check-settle.mjs", { session_id: "s-allow" }, fx.env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "landable PR: nothing blocked");
});

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

	fs.rmSync(`${fx.ghState}.behind`);
	fs.writeFileSync(`${fx.ghState}.cifail`, "1");
	res = await runHook("check-settle.mjs", { session_id: "s-block" }, fx.env);
	out = JSON.parse(res.stdout);
	assert.equal(out.decision, "block");
	assert.match(out.reason, /CI failed for PR #7/);
	assert.match(out.reason, /build/, "the failing check's name is in the reason");
});

test("stop hook: CI running holds the stop, re-arms with a heartbeat, and allows it once CI passes", async () => {
	const fx = fixture("watch");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = {
		...fx.env,
		PR_OBSERVER_HOOK_POLL_MS: "60",
		PR_OBSERVER_HOOK_CHUNK_MS: "250",
		PR_OBSERVER_HOOK_MAX_WATCH_MS: "600000",
	};

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

	// CI passes: the next stop is allowed.
	fs.rmSync(`${fx.ghState}.cipending`);
	const res2 = await runHook("check-settle.mjs", { session_id: "s-watch" }, env);
	assert.equal(res2.code, 0);
	assert.equal(res2.stdout, "", "CI passed: the stop goes through");
});

test("stop hook: the shared watch budget eventually allows the stop", async () => {
	const fx = fixture("budget");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = {
		...fx.env,
		PR_OBSERVER_HOOK_POLL_MS: "60",
		PR_OBSERVER_HOOK_CHUNK_MS: "250",
		// (below the chunk: the watch deadline, not the chunk end, must be what ends the loop)
		PR_OBSERVER_HOOK_MAX_WATCH_MS: "200",
	};
	fs.writeFileSync(`${fx.ghState}.cipending`, "1");
	const res = await runHook("check-settle.mjs", { session_id: "s-budget" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "the exhausted watch budget must allow the stop, not block forever");
	assert.ok(readLog(fx).includes("watch budget exhausted"));
});

test("stop hook: a broken gh fails open with the failure logged", async () => {
	const fx = fixture("broken");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = { ...fx.env, PATH: `${path.join(fx.dir, "bin")}:${process.env.PATH ?? ""}` };
	// Replace the fake gh with one that always exits 1 with no output.
	fs.writeFileSync(path.join(fx.dir, "bin", "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
	const res = await runHook("check-settle.mjs", { session_id: "s-broken" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "a broken gh must not block the stop");
	assert.match(readLog(fx), /could not read the PR; allowing the stop/);
});

test("notify hook: baseline is silent, transitions inject, no-change stays silent", async () => {
	const fx = fixture("notify");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = { ...fx.env, PR_OBSERVER_HOOK_MIN_NOTIFY_MS: "0" };

	// Baseline: green + mergeable, no output.
	let res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "the baseline is not news");

	// Conflict appears: injected.
	fs.writeFileSync(`${fx.ghState}.conflict`, "1");
	res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	assert.equal(res.code, 0);
	let out = JSON.parse(res.stdout);
	assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
	assert.match(out.hookSpecificOutput.additionalContext, /now conflicts/);

	// No change: silent.
	res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	assert.equal(res.code, 0);
	assert.equal(res.stdout, "", "no transition: nothing injected");

	// Conflict clears: injected as 'mergeable again'.
	fs.rmSync(`${fx.ghState}.conflict`);
	res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	out = JSON.parse(res.stdout);
	assert.match(out.hookSpecificOutput.additionalContext, /mergeable again/);

	// CI fails: injected.
	fs.writeFileSync(`${fx.ghState}.cifail`, "1");
	res = await runHook("notify-changes.mjs", { session_id: "s-notify", tool_name: "exec" }, env);
	out = JSON.parse(res.stdout);
	assert.match(out.hookSpecificOutput.additionalContext, /CI for PR #7 failed/);
});

test("notify hook: the min-interval gate skips the check between tool calls", async () => {
	const fx = fixture("gate");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const env = { ...fx.env, PR_OBSERVER_HOOK_MIN_NOTIFY_MS: "60000" };

	// First call: baseline recorded.
	let res = await runHook("notify-changes.mjs", { session_id: "s-gate", tool_name: "exec" }, env);
	assert.equal(res.stdout, "");
	// Second call right after: skipped by the gate even though the state changed underneath.
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

test("hooks run with no stdin payload at all (defensive: the host may send nothing)", async () => {
	const fx = fixture("nostdin");
	closeFns.push(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
	const res = await runHook("check-settle.mjs", {}, fx.env);
	assert.equal(res.code, 0);
	// (green + mergeable in the fixture: the stop is allowed either way)
	assert.equal(res.stdout, "");
});
