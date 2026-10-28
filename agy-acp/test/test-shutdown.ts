// The exit path: `createShutdown` and the session table it awaits.
//
// These are the two properties the exit path owns - nothing left behind, and nothing hanging - and
// the reason they get their own file is that neither is observable through a happy-path session:
// they only appear when a child will not die. So the cleanup here is a stub that misbehaves on
// purpose (never resolves, throws, finishes late), and the assertions are about what the process
// does next: which exit code, in what order, and how long it took to get there.
//
// The registry tests are here rather than with the sessions because single-flight only matters to
// this path: it exists so that a second trigger (a signal during the hang-up's dispose) cannot
// resolve early and let the process exit while kill ladders are still running.
import * as assert from "node:assert";
import { test } from "node:test";
import type { AgySession } from "../src/session.ts";
import { SessionRegistry } from "../src/session-registry.ts";
import { createShutdown, EXIT_CLEAN, EXIT_FORCED } from "../src/shutdown.ts";

/** The recorder: what happened, in the order it happened, with the exit and the flush observed. */
function recorder(options: { timeoutMs?: number; cleanup?: () => Promise<void> } = {}) {
	const events: string[] = [];
	const logs: string[] = [];
	const observed = { code: null as number | null };
	const shutdown = createShutdown({
		log: (line) => {
			logs.push(line);
		},
		timeoutMs: options.timeoutMs ?? 5_000,
		cleanup: options.cleanup ?? (async () => {}),
		flush: async () => {
			events.push("flush");
		},
		exit: (exitCode: number) => {
			observed.code = exitCode;
			events.push("exit");
		},
	});
	return { events, logs, shutdown, observed };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("a cleanup that finishes exits 0, and only after the protocol channel was flushed", async () => {
	const h = recorder();
	await h.shutdown.begin("stdin end");
	assert.strictEqual(h.observed.code, EXIT_CLEAN, "a clean cleanup exits clean");
	assert.deepStrictEqual(
		h.events.filter((e) => e === "flush" || e === "exit"),
		["flush", "exit"],
		"flushed before leaving",
	);
});

test("a cleanup that never resolves does NOT hold the process: the deadline forces the exit", async () => {
	// The scenario the deadline exists for: a child that will not die, so the dispose never returns.
	// Before this was raced rather than watched, the process sat here forever - a hang-up that has to
	// be SIGKILLed by hand, which is the failure the exit path promises not to produce.
	const h = recorder({ timeoutMs: 150, cleanup: () => new Promise<void>(() => {}) });
	const started = Date.now();
	await h.shutdown.begin("SIGTERM");
	assert.strictEqual(h.observed.code, EXIT_FORCED, "a forced exit is not a clean one");
	assert.ok(Date.now() - started < 2000, `exited on the deadline, not whenever (took ${Date.now() - started} ms)`);
	assert.ok(
		h.logs.some((l) => /cleanup still unfinished at 150 ms/.test(l) && /orphan/.test(l) && /next start sweeps the dirs/.test(l)),
		`the log says what is being left behind: ${h.logs.join(" | ")}`,
	);
});

test("a cleanup that throws exits 1, with the failure on the way out and the channel still flushed", async () => {
	const events: string[] = [];
	const logs: string[] = [];
	const shutdown = createShutdown({
		log: (line) => {
			logs.push(line);
		},
		cleanup: async () => {
			throw new Error("dispose exploded");
		},
		flush: async () => {
			events.push("flush");
		},
		exit: (code: number) => {
			events.push(`exit:${code}`);
		},
		timeoutMs: 5000,
	});
	await shutdown.begin("SIGHUP");
	assert.deepStrictEqual(events, ["flush", "exit:1"]);
	assert.ok(
		logs.some((l) => /cleanup failed: dispose exploded/.test(l)),
		`the reason is logged: ${logs.join(" | ")}`,
	);
});

test("timeoutMs=0 means the cleanup alone decides when we leave, and is not forced", async () => {
	const events: string[] = [];
	const shutdown = createShutdown({
		log: () => {},
		timeoutMs: 0,
		cleanup: async () => {
			await sleep(60);
		},
		flush: async () => {},
		exit: (code: number) => {
			events.push(`exit:${code}`);
		},
	});
	await shutdown.begin("stdin end");
	assert.deepStrictEqual(events, ["exit:0"], "a slow-but-finished cleanup is a clean exit");
});

test("a second trigger joins the shutdown in flight instead of racing it", async () => {
	let cleanups = 0;
	let exits = 0;
	let release: () => void = () => {};
	const shutdown = createShutdown({
		log: () => {},
		timeoutMs: 0,
		cleanup: async () => {
			cleanups++;
			await new Promise<void>((resolve) => (release = resolve));
		},
		flush: async () => {},
		exit: () => {
			exits++;
		},
	});
	const first = shutdown.begin("stdin end");
	const second = shutdown.begin("SIGTERM");
	release();
	await Promise.all([first, second]);
	assert.strictEqual(cleanups, 1, "the cleanup runs once");
	assert.strictEqual(exits, 1, "the process leaves once");
});

test("a signal during the shutdown skips the remaining politeness", async () => {
	const events: string[] = [];
	const logs: string[] = [];
	const shutdown = createShutdown({
		log: (line) => {
			logs.push(line);
		},
		// No deadline: the only thing that can end this run is the second signal.
		timeoutMs: 0,
		cleanup: () => new Promise<void>(() => {}),
		flush: async () => {
			events.push("flush");
		},
		exit: (code: number) => {
			events.push(`exit:${code}`);
		},
	});
	// SIGUSR2 stands in for SIGTERM: the same code path, and it cannot disturb the test runner.
	const listenersBefore = process.listenerCount("SIGUSR2"); // the runner may have its own
	const uninstall = shutdown.installSignals(["SIGUSR2"]);
	assert.strictEqual(process.listenerCount("SIGUSR2"), listenersBefore + 1, "the handler is installed");
	const running = shutdown.begin("stdin end");
	await sleep(10);
	process.kill(process.pid, "SIGUSR2"); // the client is done waiting
	await sleep(20);
	assert.deepStrictEqual(events, ["exit:1"], "the second signal exits immediately, without flushing a wedged channel");
	assert.ok(
		logs.some((l) => /SIGUSR2 during the shutdown/.test(l)),
		`and says so: ${logs.join(" | ")}`,
	);
	uninstall();
	assert.strictEqual(process.listenerCount("SIGUSR2"), listenersBefore, "the uninstall removes what it installed");
	// The first run is still parked on the cleanup; nothing else to await.
	void running;
});

// ---------------------------------------------------------------- the session table

/** A session stub whose dispose the test controls, recording when it starts and ends. */
function stubSession(id: string, events: string[], gate: Promise<void>): AgySession {
	return {
		id,
		dispose: async () => {
			events.push(`${id}:start`);
			await gate;
			events.push(`${id}:end`);
		},
	} as unknown as AgySession;
}

test("a second disposeAll joins the one in flight instead of resolving on the empty table", async () => {
	// The Major this fixes: EOF starts the dispose, a signal arrives while it is still killing the
	// first child, and the signal's own disposeAll used to look at an already-cleared map and return
	// - so the exit path concluded that everything was disposed while the kill ladders were running.
	const events: string[] = [];
	let release: () => void = () => {};
	const registry = new SessionRegistry(() => {});
	registry.add("s1", stubSession("s1", events, new Promise<void>((resolve) => (release = resolve))));
	const first = registry.disposeAll();
	const second = registry.disposeAll();
	let secondResolved = false;
	void second.then(() => {
		secondResolved = true;
		events.push("second:resolved");
	});
	await sleep(20);
	assert.ok(!secondResolved, "the second caller waits for the dispose that is actually running");
	release();
	await Promise.all([first, second]);
	assert.ok(secondResolved, "and resolves when it really is over");
	assert.deepStrictEqual(events, ["s1:start", "s1:end", "second:resolved"]);
});

test("a session that registers while the dispose is running is still awaited", async () => {
	const events: string[] = [];
	const registry = new SessionRegistry(() => {});
	let release: () => void = () => {};
	registry.add("slow", stubSession("slow", events, new Promise<void>((resolve) => (release = resolve))));
	const disposing = registry.disposeAll();
	// The late add from a session/new whose probe finished after the connection closed.
	registry.add("late", stubSession("late", events, Promise.resolve()));
	release();
	await disposing;
	assert.ok(events.includes("late:end"), `the late session's dispose was awaited, not fired: ${events.join(" | ")}`);
});
