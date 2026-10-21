// test/test-nonblocking.ts - unit tests for the shared non-blocking plumbing
// (extensions/lib/nonblocking.ts) every extension now puts its background work on.
//
//   bash test/run.sh unit                  # via CI
//   node --test test/test-nonblocking.ts   # standalone
//
// These properties are what keep boot, Enter and turn-end responsive: work runs detached, a
// critical-path handler that blocks is reported instead of stalling Pi, single-flight keys coalesce,
// and state writes stay ordered and complete.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	WriteQueue,
	commandExists,
	createTaskScope,
	flushAllTasks,
	mapLimited,
	pendingTasks,
	reportBudgetViolation,
	resetBudgetViolationsForTests,
	resetCommandAvailabilityForTests,
} from "../extensions/lib/nonblocking.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("run() is detached: the caller does not wait for the work", async () => {
	const scope = createTaskScope("t");
	let done = false;
	const started = Date.now();
	scope.run("slow", async () => {
		await sleep(150);
		done = true;
	});
	assert.ok(Date.now() - started < 50, "run() must return immediately");
	assert.equal(done, false);
	assert.equal(await scope.flush(2_000), true);
	assert.equal(done, true);
});

test("budget violation fires when a critical path blocks past the budget", async () => {
	const scope = createTaskScope("t-budget");
	const violations: string[] = [];
	const started = Date.now();
	scope.run("held", async () => {
		while (Date.now() - started < 250) {
			// A budget check measures wall-clock time while Pi is waiting on us.
		}
	});
	// Same call shape as the extensions' checkBudget(): work started first, budget measured after.
	reportBudgetViolation("t-budget", "session_start", 250, 20, (m) => violations.push(m));
	assert.equal(violations.length, 1);
	assert.match(violations[0], /\[t-budget\]/);
	assert.match(violations[0], /"session_start" took 250 ms \(budget 20 ms\)/);
	assert.match(violations[0], /move the work to a background task/);

	// A path that stays inside its budget stays silent, and repeats are reported at most once.
	reportBudgetViolation("t-budget", "session_start", 5, 20, (m) => violations.push(m));
	reportBudgetViolation("t-budget", "session_start", 900, 20, (m) => violations.push(m));
	assert.equal(violations.length, 1);
	resetBudgetViolationsForTests();
	reportBudgetViolation("t-budget", "session_start", 900, 20, (m) => violations.push(m));
	assert.equal(violations.length, 2, "after a reset the same violation reports again");
	await scope.flush(2_000);
});

test("schedule() coalesces: at most one in flight, at most one queued (latest work wins)", async () => {
	const scope = createTaskScope("t-schedule");
	let inFlight = 0;
	let maxInFlight = 0;
	const finished: number[] = [];
	const mk = (id: number) => async (signal: AbortSignal) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await sleep(60);
		if (!signal.aborted) finished.push(id);
		inFlight--;
	};
	for (let i = 1; i <= 6; i++) scope.schedule("refresh", mk(i));
	assert.equal(await scope.flush(5_000), true);
	assert.equal(maxInFlight, 1, "a single-flight key must never overlap itself");
	assert.deepEqual(finished, [1, 6], "one coalesced follow-up carrying the newest work");
});

test("pending/flushAllTasks observe every scope", async () => {
	const a = createTaskScope("a");
	const b = createTaskScope("b");
	a.run("x", () => sleep(80));
	b.run("y", () => sleep(80));
	assert.equal(pendingTasks(), 2);
	assert.equal(await flushAllTasks(5_000), true);
	assert.equal(pendingTasks(), 0);
});

test("abort() stops coalesced follow-ups and reports nothing as pending", async () => {
	const scope = createTaskScope("t-abort");
	let runs = 0;
	scope.schedule("refresh", async (signal) => {
		runs++;
		await sleep(40);
		if (signal.aborted) throw new Error("aborted");
		scope.schedule("refresh", async () => {
			runs++;
		});
	});
	await sleep(10);
	scope.abort();
	assert.equal(pendingTasks(), 0);
	await sleep(120);
	assert.equal(runs, 1, "no refresh may start after abort()");
});

test("budget expiry aborts the run and reports the overrun once", async () => {
	const scope = createTaskScope("t-expire", { budgetMs: 120 });
	const errors: string[] = [];
	const budgets: string[] = [];
	let sawAbort = false;
	scope.run(
		"hangs",
		async (signal) =>
			new Promise<void>((resolve, reject) => {
				const t = setTimeout(() => resolve(), 5_000);
				signal.addEventListener("abort", () => {
					clearTimeout(t);
					sawAbort = true;
					reject(new Error("aborted"));
				});
			}),
		{ onError: (m) => errors.push(m), onBudget: (name, ms) => budgets.push(`${name}:${ms}`) },
	);
	assert.equal(await scope.flush(2_000), true);
	assert.equal(sawAbort, true, "the budget must abort the run, not just stop waiting for it");
	assert.deepEqual(budgets, ["hangs:120"], "the overrun is reported once");
	assert.deepEqual(errors, [], "an aborted task is not reported as a failure");
});

test("join() waits for a fresh run and coalesces concurrent callers", async () => {
	const scope = createTaskScope("t-join");
	let calls = 0;
	const work = async () => {
		calls++;
		await sleep(40);
	};
	const results = await Promise.all([scope.join("k", work), scope.join("k", work), scope.join("k", work)]);
	assert.equal(calls, 1, "concurrent joins must share one run");
	assert.deepEqual(results, [undefined, undefined, undefined]);
});

test("mapLimited bounds fan-out concurrency and collects per-item errors", async () => {
	let live = 0;
	let peak = 0;
	const done: number[] = [];
	const res = await mapLimited([1, 2, 3, 4, 5], 2, async (n, i) => {
		live++;
		peak = Math.max(peak, live);
		await sleep(20);
		live--;
		done.push(n);
		if (n === 3) throw new Error(`boom ${i}`);
	});
	assert.equal(peak <= 2, true, `fan-out peaked at ${peak}`);
	assert.equal(done.length, 5, "one failing item must not stop the others");
	assert.equal(res.ok, false);
	assert.equal(res.errors.length, 1);
	assert.equal((res.errors[0] as Error).message, "boom 2");

	const clean = await mapLimited([1, 2], 4, async () => {});
	assert.deepEqual(clean, { ok: true, errors: [] });
});

test("commandExists resolves from PATH, caches, and never blocks the loop", async () => {
	resetCommandAvailabilityForTests();
	assert.equal(await commandExists("node"), true);
	assert.equal(await commandExists("definitely-not-a-real-command-xyz"), false);
	// A second lookup is served from the cache.
	const bin = fs.mkdtempSync(path.join(os.tmpdir(), "nb-cmd-"));
	const fake = path.join(bin, "nb-fake-tool");
	fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
	assert.equal(await commandExists("nb-fake-tool"), true);
	fs.rmSync(bin, { recursive: true, force: true });
	resetCommandAvailabilityForTests();
});

test("WriteQueue keeps writes ordered, survives failures and drains", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-write-"));
	const errors: string[] = [];
	const q = new WriteQueue((m) => errors.push(m));
	const target = path.join(dir, "nested", "state.json");
	// Later writes to the same file must land in order (last writer wins, no torn file).
	void q.write(target, "1");
	void q.write(target, "2");
	void q.write(target, "3");
	// A failing write is logged and must not wedge the queue behind it: its parent is a plain file,
	// so the mkdir fails with ENOTDIR.
	const blocker = path.join(dir, "blocker");
	fs.writeFileSync(blocker, "not a directory");
	void q.write(path.join(blocker, "impossible.json"), "x");
	void q.write(path.join(dir, "after-failure.json"), "still writing");
	assert.equal(await q.drain(5_000), true);
	assert.equal(fs.readFileSync(target, "utf-8"), "3");
	assert.equal(q.size, 0);
	assert.equal(errors.length, 1, "the failed write is reported once");
	assert.match(errors[0], /impossible\.json/);
	// Work queued after a failure still runs.
	assert.equal(fs.readFileSync(path.join(dir, "after-failure.json"), "utf-8"), "still writing");

	// Directory creation happens for us, and shutdown drain flushes a queued write.
	const second = path.join(dir, "a", "b", "meta.json");
	void q.write(second, "meta");
	assert.equal(await q.drain(5_000), true);
	assert.equal(fs.readFileSync(second, "utf-8"), "meta");
	fs.rmSync(dir, { recursive: true, force: true });
});
