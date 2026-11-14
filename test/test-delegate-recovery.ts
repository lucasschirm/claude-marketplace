// Run with: node --test test/test-delegate-recovery.ts
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { makeStub } from "./helpers/delegate-stub.ts";
import { getMetaPath, getStatePath } from "../extensions/lib/delegate/storage.ts";
import { normalizeMeta, normalizeTask, recoverState } from "../extensions/lib/delegate/recovery.ts";
import { claudeDriver } from "../extensions/lib/delegate/drivers/claude.ts";
import { must } from "./helpers/must.ts";

/**
 * Take away the capacity a recovered queue would otherwise use.
 *
 * `recoverState` drains the queue, and on a machine where `devin` is on PATH a test that restores a
 * queued task would launch a real agent session with the test's prompt. With the per-agent limit at
 * zero nothing can be admitted, so the drain reports "blocked" and stops — which is also the only way
 * to assert what recovery left *queued* rather than what a live agent happened to do with it.
 */
function noCapacity(rt: { maxRuns: number; maxRunsTotal: number }): void {
	rt.maxRuns = 0;
	rt.maxRunsTotal = 0;
}

/** Lay out a persisted session on disk the way `persist.ts` writes it. */
function writeState(home: string, root: string, piSessionId: string, state: unknown, metas: Record<string, unknown>): void {
	const dir = path.join(home, ".pi", "agent", root, piSessionId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
	for (const [sessionId, meta] of Object.entries(metas)) {
		const sdir = path.join(dir, sessionId);
		fs.mkdirSync(sdir, { recursive: true });
		fs.writeFileSync(path.join(sdir, "meta.json"), JSON.stringify(meta));
	}
}

test("a record from before the rename recovers as Devin", () => {
	// Renaming the tool family must not orphan a session that was running when the rename landed. Old
	// records have no `agent` field at all, and the one agent that ever existed is the answer.
	const meta = must(normalizeMeta({ sessionId: "s-1", prompt: "p", status: "completed" }), "recovers");
	assert.strictEqual(meta.agent, "devin");
	// An unknown agent means a driver was removed, not that this one will do.
	assert.strictEqual(normalizeMeta({ sessionId: "s-2", prompt: "p", agent: "codex" }), null);
});

test("an unusable record is dropped instead of poisoning the load", () => {
	assert.strictEqual(normalizeMeta({ sessionId: "", prompt: "p" }), null);
	assert.strictEqual(normalizeMeta({ sessionId: "s", prompt: "" }), null);
	assert.strictEqual(normalizeMeta(null), null);
	assert.strictEqual(normalizeMeta("nope"), null);
	// A status that never existed falls back to interrupted rather than to running, which would claim a
	// process this Pi has no handle on.
	const meta = must(normalizeMeta({ sessionId: "s", prompt: "p", status: "quantum" }), "recovers");
	assert.strictEqual(meta.status, "interrupted");
});

test("a queued task recovers with its agent and gets a lookup id back", () => {
	// The id a caller was told has to survive the restart, or `delegate_cancel(q-…)` reports a task that
	// is still about to run as gone. A record with no id gets the next one rather than an empty string.
	const task = must(normalizeTask({ prompt: "p", agent: "claude", model: "sonnet", thinking: "high" }, { totalInvoked: 6 }), "recovers");
	assert.strictEqual(task.queueId, "q-7");
	assert.strictEqual(task.agent, "claude");
	assert.strictEqual(task.model, "sonnet");
	assert.strictEqual(task.thinking, "high");
	assert.strictEqual(task.mode, "dangerous", "an omitted mode keeps the family default");
	assert.strictEqual(normalizeTask({ queueId: "q-3", prompt: "p" })?.queueId, "q-3", "a recorded id is kept verbatim");
	assert.strictEqual(normalizeTask({ agent: "codex", prompt: "p" }), null);
});

test("state and metadata are restored, and interrupted sessions are labelled", async () => {
	const { rt, home, statuses, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{
			version: 2,
			sessionIds: ["s-old"],
			queue: [{ agent: "devin", prompt: "queued before the restart", mode: "dangerous", createWorktree: false, enqueuedAt: 5 }],
			totalCompleted: 7,
			totalFailed: 2,
			maxRunsTotal: 5,
			sessionDirs: { "s-old": "pi-test" },
		},
		{
			"s-old": { sessionId: "s-old", prompt: "was running", status: "running", pid: 999_999, cwd: "/tmp", worktreePath: "/wt" },
		},
	);
	try {
		const kills: number[] = [];
		rt.killProcessGroup = (pid: number) => {
			kills.push(pid);
		};
		const r = await recoverState(rt, "pi-test");
		assert.strictEqual(r.recovered, 1, JSON.stringify(r));
		// The store read is deliberately not awaited (a sqlite probe must not hold boot open), so the
		// final status lands after the pass reports. `flush` is the seam the scope exposes for exactly
		// this: wait for quiescence instead of sleeping a guessed number of milliseconds.
		await rt.stateWrites.drain(5_000);
		const session = must(rt.sessions.get("s-old"), "the session is restored");
		assert.strictEqual(session.agent, "devin");
		assert.strictEqual(session.status, "interrupted");
		// The record has to explain itself: "interrupted" alone tells the caller nothing about whether
		// the agent's work landed or died mid-write.
		assert.match(session.error ?? "", /interrupted/i, JSON.stringify(session.error));
		assert.strictEqual(rt.queue.length, 1);
		assert.match(must(rt.queue[0], "queued task").queueId, /^q-\d+$/);
		assert.strictEqual(rt.totalCompleted, 7);
		assert.strictEqual(rt.maxRunsTotal, 5, "the previous run's flag is honoured so slots match history");
		// A dead pid is not killed (there is nothing to kill), and the status line is refreshed so the
		// restored session is visible without the user asking.
		assert.ok(
			statuses.some(([, text]) => text && /Delegate \d/.test(text)),
			`the status line is refreshed after recovery: ${JSON.stringify(statuses)}`,
		);
		assert.deepStrictEqual(kills, [], "nothing is killed for a pid that is already gone");
	} finally {
		restoreHome();
	}
});

test("state written under the pre-rename root is still found", async () => {
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"devin_delegate",
		"pi-test",
		{ sessionIds: ["s-legacy"], queue: [], totalCompleted: 1 },
		{
			"s-legacy": { sessionId: "s-legacy", prompt: "old session", status: "completed" },
		},
	);
	try {
		const r = await recoverState(rt, "pi-test");
		assert.strictEqual(r.recovered, 1, "the legacy root is read, not migrated");
		assert.strictEqual(rt.sessions.get("s-legacy")?.agent, "devin");
	} finally {
		restoreHome();
	}
});

test("corrupt state does not throw and does not lose the metadata that did parse", async () => {
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	const dir = path.join(home, ".pi", "agent", "delegate_task", "pi-test");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "state.json"), "{ this is not json");
	writeState(
		home,
		"delegate_task",
		"pi-test-2",
		{ sessionIds: ["s-a"] },
		{
			"s-a": { sessionId: "s-a", prompt: "ok", status: "completed" },
		},
	);
	try {
		assert.deepStrictEqual(await recoverState(rt, "pi-test"), { recovered: 0, orphanProcessesKilled: 0, backfilled: 0 });
		assert.strictEqual(rt.sessions.size, 0, "nothing is invented from a corrupt file");
		assert.strictEqual((await recoverState(rt, "pi-test-2")).recovered, 1, "the good session still loads");
	} finally {
		restoreHome();
	}
});

test("a session whose process is still alive is killed, and the driver's CLI names it", async () => {
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{ sessionIds: ["s-orphan"] },
		{
			"s-orphan": { sessionId: "s-orphan", agent: "claude", prompt: "p", status: "running", pid: process.pid },
		},
	);
	const kills: Array<{ pid: number; cli?: string }> = [];
	rt.killProcessGroup = (pid: number, cli?: string) => {
		kills.push({ pid, cli });
	};
	try {
		const r = await recoverState(rt, "pi-test");
		assert.strictEqual(r.orphanProcessesKilled, 1);
		assert.deepStrictEqual(kills, [{ pid: process.pid, cli: "claude" }], "the agent recorded on the session decides the guard");
		assert.strictEqual(rt.sessions.get("s-orphan")?.status, "interrupted");
	} finally {
		restoreHome();
	}
});

test("recovery is safe to run twice on the same runtime", async () => {
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{ sessionIds: ["s-1"], queue: [{ prompt: "p" }] },
		{
			"s-1": { sessionId: "s-1", prompt: "p", status: "completed" },
		},
	);
	try {
		await recoverState(rt, "pi-test");
		const second = await recoverState(rt, "pi-test");
		assert.strictEqual(second.recovered, 1);
		assert.strictEqual(rt.sessions.size, 1, "no duplicate session");
		assert.strictEqual(rt.queue.length, 1, "no duplicate queue entry");
	} finally {
		restoreHome();
	}
});

test("a session file written by a newer version is read field by field, not rejected", async () => {
	// Recovery is the one place where forward compatibility pays: refusing a record because it gained a
	// field would lose a live session.
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{ sessionIds: ["s-1"], someNewCounter: 9 },
		{
			"s-1": { sessionId: "s-1", prompt: "p", status: "completed", someNewField: { nested: true } },
		},
	);
	try {
		assert.strictEqual((await recoverState(rt, "pi-test")).recovered, 1);
		assert.strictEqual(must(rt.sessions.get("s-1"), "session").status, "completed");
	} finally {
		restoreHome();
	}
});

test("an interrupted session does not read another agent's store", async () => {
	// Backfill is per driver: running Devin's SQLite query for a Claude session would report "completed"
	// from someone else's transcript.
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{ sessionIds: ["s-claude"] },
		{
			"s-claude": { sessionId: "s-claude", agent: "claude", prompt: "p", status: "running", pid: 999_998 },
		},
	);
	try {
		const r = await recoverState(rt, "pi-test");
		await rt.stateWrites.drain(5_000);
		assert.strictEqual(r.backfilled, 0);
		assert.strictEqual(rt.sessions.get("s-claude")?.status, "interrupted");
		// The stronger fact: the Claude driver has no store reader at all, so there is no code path that
		// could report someone else's transcript as this session's result.
		assert.strictEqual(claudeDriver.backfill, undefined);
		assert.ok(!fs.existsSync(path.join(home, ".devin-xdg-data")), "no attempt to read Devin's store for another agent");
	} finally {
		restoreHome();
	}
});

test("recovery writes the state it produced back to disk", async () => {
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{ sessionIds: ["s-1"], queue: [{ prompt: "still queued" }] },
		{
			"s-1": { sessionId: "s-1", prompt: "p", status: "running", pid: 999_997 },
		},
	);
	try {
		await recoverState(rt, "pi-test");
		await rt.stateWrites.drain(2_000);
		const state = JSON.parse(fs.readFileSync(getStatePath("pi-test"), "utf-8"));
		assert.deepStrictEqual(state.sessionIds, ["s-1"]);
		assert.strictEqual(state.queue.length, 1);
		assert.ok(fs.existsSync(getMetaPath("pi-test", "s-1")));
	} finally {
		restoreHome();
	}
});

test("a successor that came back takes the conversation its parent still claims", async () => {
	// `markSuperseded` runs after `delegate()` returns, so a pi that died mid-restart can leave the restarted
	// session on disk while its parent never learned. Both records would then be addressable and both would
	// name the worktree the restart reused — the hazard the pointer exists to prevent. `parentSessionId` is
	// written only by `delegate_restart`, so the child is the evidence recovery needs to rebuild the pointer.
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{ sessionIds: ["old-1", "new-1"], queue: [] },
		{
			"old-1": { sessionId: "old-1", prompt: "p", status: "completed" },
			"new-1": { sessionId: "new-1", prompt: "p", status: "completed", parentSessionId: "old-1" },
		},
	);
	try {
		await recoverState(rt, "pi-test");
		assert.deepStrictEqual(rt.sessions.get("old-1")?.supersededBy, { sessionId: "new-1" });
		// In memory is not enough: a pointer that never reaches the file means the next pi reopens the race.
		await rt.stateWrites.drain(5_000);
		const onDisk = JSON.parse(fs.readFileSync(path.join(dirOf(home, "pi-test", "old-1"), "meta.json"), "utf8"));
		assert.deepStrictEqual(onDisk.supersededBy, { sessionId: "new-1" });
		// The successor is nobody's pointer target and stays addressable on its own.
		assert.strictEqual(rt.sessions.get("new-1")?.supersededBy, undefined);
	} finally {
		restoreHome();
	}
});

test("a restart pointer naming nothing is dropped, and one naming a queued restart is kept", async () => {
	// A refusal is a promise the caller can act on. Pointing them at a queue entry that no longer exists (the
	// entry was popped, then pi died before the successor's record was written) or at a session whose record
	// could not be read strands the conversation permanently — and every worktree path skips a superseded
	// record, so its folder becomes unreclaimable too. A `{queueId}` entry still in the queue is different:
	// that restart is waiting for a slot, which is exactly what the pointer means.
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{
			sessionIds: ["gone-queue", "gone-session", "still-queued", "half-alive", "plain"],
			queue: [{ prompt: "p", agent: "devin", queueId: "q-7" }],
		},
		{
			"gone-queue": { sessionId: "gone-queue", prompt: "p", status: "completed", supersededBy: { queueId: "q-1" } },
			"gone-session": { sessionId: "gone-session", prompt: "p", status: "completed", supersededBy: { sessionId: "never-restored" } },
			"still-queued": { sessionId: "still-queued", prompt: "p", status: "completed", supersededBy: { queueId: "q-7" } },
			"half-alive": {
				sessionId: "half-alive",
				prompt: "p",
				status: "completed",
				supersededBy: { sessionId: "never-restored", queueId: "q-7" },
			},
			plain: { sessionId: "plain", prompt: "p", status: "completed" },
		},
	);
	try {
		await recoverState(rt, "pi-test");
		assert.strictEqual(rt.sessions.get("gone-queue")?.supersededBy, undefined, "a queue entry that is gone cannot be where the work went");
		assert.strictEqual(
			rt.sessions.get("gone-session")?.supersededBy,
			undefined,
			"a successor that did not load cannot be addressed either",
		);
		assert.deepStrictEqual(
			rt.sessions.get("still-queued")?.supersededBy,
			{ queueId: "q-7" },
			"a restart still waiting for a slot stays pointed",
		);
		// Both halves, one dead: the queued half is somewhere a caller can still go, so the pointer as a
		// whole survives — clearing is for a pointer with nowhere to send anybody.
		assert.deepStrictEqual(
			rt.sessions.get("half-alive")?.supersededBy,
			{ sessionId: "never-restored", queueId: "q-7" },
			"a live queue half keeps a pointer whose session half is gone",
		);
		assert.strictEqual(rt.sessions.get("plain")?.supersededBy, undefined, "recovery invents pointers for nobody");
		await rt.stateWrites.drain(5_000);
		const onDisk = JSON.parse(fs.readFileSync(path.join(dirOf(home, "pi-test", "gone-queue"), "meta.json"), "utf8"));
		assert.strictEqual(onDisk.supersededBy, undefined, "the dropped pointer has to be dropped on disk too");
	} finally {
		restoreHome();
	}
});

/** A lookup id has to survive `delegate_cancel(q-N)`, restored or minted. */
const QUEUE_ID_RE = /^q-\d+$/;

/** Where a recovered session's `meta.json` lives. */
function dirOf(home: string, piSessionId: string, sessionId: string): string {
	return path.join(home, ".pi", "agent", "delegate_task", piSessionId, sessionId);
}

test("a queued restart that outlived its pointer still marks the parent", async () => {
	// `delegate()` persists the queue entry long before a restart's tool call can write a pointer, so a crash
	// in that gap leaves an entry saying "restart old-1" while old-1 still believes the conversation is its
	// own. Reading only the sessions would miss it, and both ids would stay addressable in this pi — the pair
	// sharing one worktree — until some later boot derived the pointer from the child.
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{ sessionIds: ["old-1"], queue: [{ prompt: "again", agent: "devin", queueId: "q-4", parentSessionId: "old-1" }] },
		{ "old-1": { sessionId: "old-1", prompt: "p", status: "completed" } },
	);
	try {
		await recoverState(rt, "pi-test");
		// Pointed at the entry rather than a session: it is still waiting for a slot, which is what the caller
		// needs to be told. And because the entry came back, the clearing pass leaves it alone.
		assert.deepStrictEqual(rt.sessions.get("old-1")?.supersededBy, { queueId: "q-4" });
		await rt.stateWrites.drain(5_000);
		const onDisk = JSON.parse(fs.readFileSync(path.join(dirOf(home, "pi-test", "old-1"), "meta.json"), "utf8"));
		assert.deepStrictEqual(onDisk.supersededBy, { queueId: "q-4" });
	} finally {
		restoreHome();
	}
});

test("restored queue ids stay unique, because a pointer matches one by id", async () => {
	// A pointer says "the restart waiting as q-N". Two entries reading back as q-N — the id-less fallback in
	// `normalizeTask` cannot see its siblings — would make a dead pointer look alive and keep it past recovery.
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{
			sessionIds: [],
			queue: [
				{ prompt: "a", agent: "devin", queueId: "q-1" },
				{ prompt: "b", agent: "devin", queueId: "q-1" },
				{ prompt: "c", agent: "devin" },
			],
		},
		{},
	);
	try {
		await recoverState(rt, "pi-test");
		const ids = rt.queue.map((task) => task.queueId);
		assert.strictEqual(rt.queue.length, 3, "nothing is dropped to make ids unique");
		assert.strictEqual(new Set(ids).size, 3, `queue ids collide: ${JSON.stringify(ids)}`);
		assert.ok(
			ids.every((id) => QUEUE_ID_RE.test(id ?? "")),
			`a restored id is not a lookup id: ${JSON.stringify(ids)}`,
		);
	} finally {
		restoreHome();
	}
});

test("a duplicate restored queue id terminates recovery instead of spinning forever", { timeout: 30_000 }, async () => {
	// The timeout is the assertion. Round 8 built its replacement id from values the `while` loop never
	// changed — an offset over a counter fixed at boot — so a candidate that was already taken repeated
	// forever, inside `recoverState`, which every tool path awaits. `totalInvoked: 5` with two entries named
	// `q-7` is the smallest shape that reaches it, and a half-written `state.json` is the same shape.
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{
			sessionIds: [],
			totalInvoked: 5,
			queue: [
				{ prompt: "a", agent: "devin", queueId: "q-7" },
				{ prompt: "b", agent: "devin", queueId: "q-7" },
			],
		},
		{},
	);
	try {
		await recoverState(rt, "pi-test");
		const ids = rt.queue.map((task) => task.queueId);
		assert.strictEqual(rt.queue.length, 2, "nothing is dropped to make ids unique");
		assert.strictEqual(new Set(ids).size, 2, `queue ids collide: ${JSON.stringify(ids)}`);
	} finally {
		restoreHome();
	}
});

test("the queue-id generator starts above every id restored from disk", async () => {
	// `totalInvoked` is what `delegate()` mints from. A restored `q-9` with the counter still at 2 means the
	// ninth delegation gets `q-9` too — one lookup key, two tasks, and a restart pointer matched by that key.
	const { rt, home, restoreHome } = makeStub();
	noCapacity(rt);
	writeState(
		home,
		"delegate_task",
		"pi-test",
		{ sessionIds: [], totalInvoked: 2, queue: [{ prompt: "a", agent: "devin", queueId: "q-9" }] },
		{},
	);
	try {
		await recoverState(rt, "pi-test");
		assert.strictEqual(rt.queue.length, 1);
		assert.ok(rt.totalInvoked >= 9, `the id generator sits under an id already on disk: ${rt.totalInvoked}`);
	} finally {
		restoreHome();
	}
});
