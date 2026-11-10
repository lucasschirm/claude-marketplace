// Run with: node --test test/test-delegate-runtime.ts
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fakeClient, makeStub, metaFor } from "./helpers/delegate-stub.ts";
import { getEventsLogPath, getMetaPath, getStatePath } from "../extensions/lib/delegate/storage.ts";
import { must } from "./helpers/must.ts";

/** A pending-permission timer that will not hold the test process open for its whole lifetime. */
function idleTimer(): NodeJS.Timeout {
	const t = setTimeout(() => {}, 60_000);
	t.unref();
	return t;
}

test("toolDetails carries the counters a follow-up turn would re-query", () => {
	const { rt, restoreHome } = makeStub();
	try {
		rt.sessions.set("s-1", metaFor("s-1"));
		rt.queue.push({ queueId: "q-1", agent: "devin", prompt: "p", mode: "dangerous", createWorktree: false, enqueuedAt: 1 });
		const details = rt.toolDetails("delegate_status", { result: "overview" });
		assert.strictEqual(details.tool, "delegate_status");
		assert.strictEqual(details.sessions, 1);
		assert.strictEqual(details.queuedTasks, 1);
		assert.strictEqual(details.inFlight, 1, "a running session counts as in flight");
		assert.strictEqual(details.maxInFlight, rt.maxRuns);
		assert.strictEqual(details.maxInFlightTotal, rt.maxRunsTotal);
		assert.strictEqual(details.result, "overview", "per-call facts ride along");
	} finally {
		restoreHome();
	}
});

test("the status line shows what is blocked, not just what is running", () => {
	const { rt, statuses, restoreHome } = makeStub();
	try {
		rt.updateStatusUI();
		assert.deepStrictEqual(
			statuses.at(-1) ?? ["", "unset"],
			["delegate_task_test", undefined],
			"with nothing to show the status line is cleared",
		);

		rt.sessions.set("s-1", metaFor("s-1", { agent: "claude", status: "stalled" }));
		rt.pendingPermissions.set("s-2", [
			{ requestId: 1, command: "rm -rf /", options: [], requestedAt: 0, timer: setTimeout(() => {}, 10_000) },
		]);
		rt.updateStatusUI();
		const [, text] = must(statuses.at(-1), "a status line");
		assert.match(text ?? "", /Delegate 1\/3/, `in flight of total: ${text}`);
		// A stalled session holds its slot, so a separate "running" figure read 0 while two frozen
		// sessions blocked the whole queue (the 0/6/0 report).
		assert.match(text ?? "", /1 stalled/);
		assert.match(text ?? "", /1 awaiting permission/);
		assert.match(text ?? "", /claude 1\/2/, `per-agent counts appear: ${text}`);
		for (const p of rt.pendingPermissions.values()) {
			for (const r of p) {
				clearTimeout(r.timer);
			}
		}
	} finally {
		restoreHome();
	}
});

test("diagnostics are stripped of ANSI, flattened, and capped", () => {
	const { rt, notifications, restoreHome } = makeStub();
	try {
		rt.logWarn(`\x1b[31mdanger\x1b[0m\n\t${"x".repeat(900)}`);
		const [text, level] = must(notifications.at(-1), "a notify call");
		assert.ok(!text.includes("\x1b"), "no escape sequences reach the TUI");
		assert.ok(!text.includes("\n"), "no newline reaches the TUI");
		assert.strictEqual(level, "warning");
		assert.ok(text.length <= 500, `capped at 500 characters, got ${text.length}`);
		rt.logError("boom");
		assert.strictEqual(notifications.at(-1)?.[1], "error");
	} finally {
		restoreHome();
	}
});

test("answering a permission request uses the driver's own option policy", () => {
	const { rt, restoreHome } = makeStub();
	try {
		const client = fakeClient();
		rt.activeClients.set("s-1", client as never);
		rt.sessions.set("s-1", metaFor("s-1", { agent: "devin" }));
		rt.pendingPermissions.set("s-1", [
			{
				requestId: "req-1",
				command: "rm -rf build",
				options: [
					{ optionId: "allow_once", name: "Allow", kind: "allow_once" },
					{ optionId: "allow_always", name: "Always", kind: "allow_always" },
					{ optionId: "switch_bypass", name: "Switch to bypass", kind: "allow_always" },
					{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
				],
				requestedAt: 0,
				timer: idleTimer(),
			},
		]);
		const answered = must(rt.answerPermission("s-1", "allow", "agent"), "the request was pending");
		assert.strictEqual(answered.optionId, "allow_once", "never a widening option on the caller's behalf");
		assert.deepStrictEqual(client.responses, [{ id: "req-1", result: { outcome: { outcome: "selected", optionId: "allow_once" } } }]);
		assert.strictEqual(rt.pendingPermissions.size, 0, "answering clears the request");
		assert.ok(
			client.events.some((e) => e.type === "permission_answer"),
			"the answer is in the transcript",
		);
	} finally {
		restoreHome();
	}
});

test("Claude has no session-scoped option, so allow_session answers once and says so elsewhere", () => {
	const { rt, restoreHome } = makeStub();
	try {
		const client = fakeClient();
		rt.activeClients.set("c-1", client as never);
		rt.sessions.set("c-1", metaFor("c-1", { agent: "claude" }));
		rt.pendingPermissions.set("c-1", [
			{
				requestId: 7,
				command: "npm test",
				options: [
					{ optionId: "allow_once", name: "Allow", kind: "allow_once" },
					{ optionId: "allow_always", name: "Always", kind: "allow_always" },
				],
				requestedAt: 0,
				timer: idleTimer(),
			},
		]);
		const answered = must(rt.answerPermission("c-1", "allow_session", "agent"), "pending");
		assert.strictEqual(answered.optionId, "allow_once");
		assert.ok(!client.responses.some((r) => JSON.stringify(r).includes("allow_always")), "a durable rule is never chosen");
	} finally {
		restoreHome();
	}
});

test("answering an unknown request id reports rather than answering the wrong one", () => {
	const { rt, restoreHome } = makeStub();
	try {
		rt.pendingPermissions.set("s-1", [{ requestId: "a", command: "x", options: [], requestedAt: 0, timer: idleTimer() }]);
		assert.strictEqual(rt.answerPermission("s-1", "allow", "agent", "b"), null);
		assert.strictEqual(rt.pendingPermissions.size, 1, "the real request is still pending");
	} finally {
		restoreHome();
	}
});

test("an unanswered request auto-rejects on its own timer", async () => {
	// The timeout is minutes in the flag, so the test asks for 0.001 minutes (60 ms) rather than waiting
	// out the five-minute default.
	const { rt, sent, restoreHome } = makeStub({ "delegate-permission-timeout": "0.001" });
	try {
		const client = fakeClient();
		rt.activeClients.set("s-1", client as never);
		rt.sessions.set("s-1", metaFor("s-1"));
		// The same timeout the runtime would arm: exercise the decision it makes, not the timer itself.
		const answered = rt.answerPermission("s-1", "reject", "timeout", undefined);
		assert.strictEqual(answered, null, "nothing pending yet");
		rt.pendingPermissions.set("s-1", [
			{
				requestId: "r",
				command: "curl evil",
				options: [{ optionId: "reject_once", name: "No", kind: "reject_once" }],
				requestedAt: 0,
				timer: idleTimer(),
			},
		]);
		const timedOut = must(rt.answerPermission("s-1", "reject", "timeout"), "the timeout path rejects");
		assert.strictEqual(timedOut.optionId, "reject_once");
		// An unanswered request is a decision the caller did not make, so it is reported. Silence here is
		// how the original incident turned into "did the extension go quiet, or did I never answer?".
		const notice = must(sent.at(-1), "the auto-reject notice");
		assert.match(notice, /got no answer in \d+ minute\(s\) and was rejected automatically/);
		assert.match(notice, /curl evil/, "the command the agent asked for is named in the notice");
	} finally {
		restoreHome();
	}
});

test("ending a turn drops its pending permission requests", async () => {
	const { rt, restoreHome } = makeStub();
	try {
		let fired = false;
		rt.pendingPermissions.set("s-1", [
			{
				requestId: 1,
				command: "x",
				options: [],
				requestedAt: 0,
				timer: (() => {
					const t = setTimeout(() => (fired = true), 30);
					t.unref();
					return t;
				})(),
			},
		]);
		rt.stopStallWatchdog("s-1");
		assert.strictEqual(rt.pendingPermissions.size, 0);
		// The auto-reject timer is cleared, so it cannot fire for a request that no longer exists.
		await new Promise((r) => setTimeout(r, 60));
		assert.strictEqual(fired, false);
	} finally {
		restoreHome();
	}
});

test("a kill refuses a pid that is not the agent it claims to be", () => {
	// PID reuse: the recorded pid of a session that died long ago can belong to anything by the time a
	// restart gets around to cleaning it up. On Linux the cmdline settles it; elsewhere it is
	// unverifiable and the kill proceeds as it always did.
	//
	// The victim is a `sleep` we own, so that a regression here cannot kill the test runner.
	const { rt, notifications, restoreHome } = makeStub();
	const child = spawn("sleep", ["30"], { stdio: "ignore" });
	try {
		if (process.platform !== "linux") {
			return;
		}
		rt.killProcessGroup(child.pid, "devin");
		assert.ok(
			notifications.some(([text]) => text.includes("refusing to kill pid")),
			`the pid-reuse guard must report itself: ${JSON.stringify(notifications)}`,
		);
		assert.strictEqual(rt.isPidAlive(child.pid), true, "the unrelated process survived");
	} finally {
		child.kill("SIGKILL");
		restoreHome();
	}
});

test("state and metadata persist under the new root, and drain on demand", async () => {
	const { rt, home, restoreHome } = makeStub();
	try {
		rt.sessions.set("s-1", metaFor("s-1", { agent: "claude", model: "sonnet" }));
		rt.totalCompleted = 4;
		rt.persistState();
		rt.persistSessionMeta(must(rt.sessions.get("s-1"), "the session exists"), true);
		await rt.stateWrites.drain(2_000);

		const state = JSON.parse(fs.readFileSync(getStatePath("pi-test"), "utf-8"));
		assert.deepStrictEqual(state.sessionIds, ["s-1"]);
		assert.strictEqual(state.totalCompleted, 4);
		assert.strictEqual(state.sessionDirs["s-1"], "pi-test");
		assert.strictEqual(state.maxRunsTotal, rt.maxRunsTotal);

		const meta = JSON.parse(fs.readFileSync(getMetaPath("pi-test", "s-1"), "utf-8"));
		assert.strictEqual(meta.agent, "claude");
		assert.ok(getEventsLogPath("pi-test", "s-1").startsWith(home), "everything is inside the temp home");
	} finally {
		restoreHome();
	}
});

test("appendEvent writes one JSONL line per event", () => {
	const { rt, restoreHome } = makeStub();
	try {
		const meta = metaFor("s-1");
		rt.appendEventLog(meta, "assistant_message", { text: "first" });
		rt.appendEventLog(meta, "assistant_message", { text: "second", backfilled: true });
		const lines = fs.readFileSync(getEventsLogPath("pi-test", "s-1"), "utf-8").trim().split("\n");
		assert.strictEqual(lines.length, 2);
		assert.strictEqual(JSON.parse(lines[1]).data.backfilled, true);
		assert.ok(JSON.parse(lines[0]).timestamp, "every line is timestamped");
	} finally {
		restoreHome();
	}
});

test("shutdown releases every piece of per-session state", () => {
	const { rt, restoreHome } = makeStub();
	try {
		rt.sessions.set("s-1", metaFor("s-1"));
		rt.queue.push({ queueId: "q-1", agent: "devin", prompt: "p", mode: "dangerous", createWorktree: false, enqueuedAt: 1 });
		rt.assistantBuffers.set("s-1", "partial");
		rt.totalCompleted = 2;
		rt.shutdown();
		assert.strictEqual(rt.sessions.size, 0);
		assert.strictEqual(rt.queue.length, 0);
		assert.strictEqual(rt.assistantBuffers.size, 0);
		assert.strictEqual(rt.totalCompleted, 0);
		assert.strictEqual(rt.currentPiSessionId, "default");
	} finally {
		restoreHome();
	}
});

test("the chunk that crosses the flush threshold is the chunk that must survive", () => {
	// The buffer used to be tested before it was stored, so the flushing branch wrote what the map still held
	// and discarded the chunk that tripped the threshold — 2 000 characters apart, mid-sentence, in whichever
	// stream talked fastest. Nothing downstream could tell: the transcript simply lacked words.
	const stub = makeStub();
	const rt = stub.rt;
	try {
		const meta = metaFor("s-flush");
		const file = getEventsLogPath(rt.currentPiSessionId, meta.sessionId);
		rt.appendStreamChunk(meta, "assistant", "a".repeat(1990));
		rt.appendStreamChunk(meta, "assistant", "TAIL-OF-SENTENCE");
		assert.match(fs.readFileSync(file, "utf-8"), /TAIL-OF-SENTENCE/, "the chunk that flushed was dropped");
		// Flushed text must not be written again by the next flush, or the transcript repeats itself forever.
		rt.appendStreamChunk(meta, "assistant", "next");
		rt.flushBuffers(meta);
		const logged = fs.readFileSync(file, "utf-8");
		assert.strictEqual(logged.split("a".repeat(1990)).length - 1, 1, "the flushed text is written exactly once");
		assert.match(logged, /next/);
	} finally {
		stub.restoreHome();
	}
});
