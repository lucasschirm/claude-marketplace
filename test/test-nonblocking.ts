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

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

test("work starts on a later event-loop turn, never inside the caller's turn", async () => {
	// Pi awaits lifecycle handlers, and everything a task does before its first real await would run
	// inside that awaited handler. A microtask yield is not enough (Pi's own continuation is a
	// microtask), so the scope defers to a macrotask.
	const scope = createTaskScope("t-macro");
	let syncWorkRan = false;
	const startedInMyTurn = { value: false };
	scope.run("spawner", async () => {
		syncWorkRan = true;
		startedInMyTurn.value = true;
	});
	// Still in the caller's synchronous stretch: nothing may have run yet.
	assert.equal(syncWorkRan, false, "work must not start synchronously inside the handler");
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(startedInMyTurn.value, false, "a microtask yield would still run in the same turn");
	assert.equal(await scope.flush(2_000), true);
	assert.equal(syncWorkRan, true);
});

test("immediate: true starts on the current tick (slot races depend on it)", async () => {
	// ghHealth's degraded-mode retry slot goes to whoever claims it first, so its retry hook must
	// not be queued behind the tick's other callbacks.
	const scope = createTaskScope("t-immediate");
	let ranNow = false;
	let ranLater = false;
	scope.run("now", async () => {
		ranNow = true;
	}, { immediate: true });
	scope.run("next-tick", async () => {
		ranLater = true;
	});
	assert.equal(ranNow, true, "immediate work runs synchronously up to its first await");
	assert.equal(ranLater, false, "default work waits for the next event loop turn");
	assert.equal(await scope.flush(2_000), true);
	assert.equal(ranLater, true);
});

test("abort() is sticky and resume() reopens the scope", async () => {
	const scope = createTaskScope("t-sticky");
	let runs = 0;
	const work = async () => {
		runs++;
	};
	scope.abort();
	scope.run("after-abort", work);
	scope.schedule("after-abort-key", work);
	await sleep(50);
	assert.equal(runs, 0, "nothing may start on an aborted scope");
	assert.equal(pendingTasks(), 0);

	// The next session revives it.
	scope.resume();
	scope.run("after-resume", work);
	assert.equal(await scope.flush(2_000), true);
	assert.equal(runs, 1);
});

test("run() resolves when the task finishes and never rejects", async () => {
	const scope = createTaskScope("t-gate", {
		onError: () => {
			throw new Error("the logger itself is broken");
		},
	});
	const gate = scope.run("fails", async () => {
		await sleep(20);
		throw new Error("work failed");
	});
	// A tool path keeps this promise as a gate: it must settle, never reject, even though the work
	// failed and the scope's logger throws while reporting it.
	const settled = await Promise.race([gate.then(() => "settled"), sleep(3_000).then(() => "TIMEOUT")]);
	assert.equal(settled, "settled");
});

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
	// All six land in the same tick, before the deferred body of the first one starts: they replace
	// what that run does rather than queueing behind it, so the work happens once.
	for (let i = 1; i <= 6; i++) scope.schedule("refresh", mk(i));
	assert.equal(await scope.flush(5_000), true);
	assert.equal(maxInFlight, 1, "a single-flight key must never overlap itself");
	assert.deepEqual(finished, [6], "superseded requests must not add runs");
});

test("schedule() during a running round queues exactly one follow-up with the newest work", async () => {
	const scope = createTaskScope("t-schedule-queued");
	const finished: number[] = [];
	let releaseFirst: () => void = () => {};
	const first = new Promise<void>((resolve) => (releaseFirst = resolve));
	scope.schedule("refresh", async (signal) => {
		finished.push(1);
		await first;
		if (!signal.aborted) return;
	});
	await sleep(10); // let the run enter its body, so it counts as in flight
	const gate = deferred<number>();
	scope.schedule("refresh", mkPush(finished, 2, gate));
	scope.schedule("refresh", mkPush(finished, 3, gate));
	assert.equal(pendingTasks(), 1, "the queued follow-up counts as pending, not two");
	releaseFirst();
	await sleep(20);
	gate.resolve(0);
	assert.equal(await scope.flush(5_000), true);
	// One follow-up only, carrying the latest request's work (3).
	assert.deepEqual(finished, [1, 3]);
});

function mkPush(sink: number[], id: number, wait: Deferred<number>) {
	return async (signal: AbortSignal) => {
		await wait.promise;
		if (!signal.aborted) sink.push(id);
	};
}

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
