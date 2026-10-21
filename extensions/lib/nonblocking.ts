/**
 * Shared non-blocking execution plumbing for this package's Pi extensions
 * (observe-pr, pr-tasks, orca-orchestration, devin-delegate).
 *
 * Pi *awaits* extension lifecycle handlers, so work awaited inside them delays the
 * host, not just the extension (verified in @earendil-works/pi-coding-agent):
 *
 * | Path                    | Pi source                                        | What a slow handler blocks |
 * |-------------------------|--------------------------------------------------|----------------------------|
 * | `await factory(api)`    | `core/extensions/loader.js`                       | process startup (before the TUI exists) |
 * | `session_start`         | `modes/interactive/interactive-mode.js` (`await rebindCurrentSession()` before `renderInitialMessages()`) | first frame + restored transcript |
 * | `input`                 | `core/extensions/runner.js` (`emitInput`)         | the user's message on Enter |
 * | `agent_before_settle`   | `core/agent-session.js`                           | the agent finishing its turn |
 * | `turn_end`              | `core/extensions/runner.js` (`emit`)              | Pi returning to idle |
 *
 * `emit()` awaits handlers one after another, so every extension's awaited I/O on those
 * events **sums** into the same startup. The rule this module encodes:
 *
 *   Start work on those paths, never await it. Apply the result when it lands (status
 *   line, notify, steer message) — the TUI changes after the run, not before it.
 *
 * Awaiting stays correct on agent-initiated paths (tool handlers): the agent asked for
 * data and Pi is not on a boundary there.
 */

import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/** Where a scope sends failure text. Extensions pass a TUI-safe logger (never raw `console.error`). */
export type TaskLogger = (message: string) => void;

/** A unit of background work. Honour `signal`: it fires on budget expiry and on `abort()`. */
export type TaskWork = (signal: AbortSignal) => Promise<void>;

export interface RunOptions {
	/**
	 * Stop handing work to this task after N ms. Subprocesses already running keep their
	 * own per-call timeout; the budget stops *further* work and the applying of results.
	 */
	budgetMs?: number;
	/** Overrides the scope logger for this task. */
	onError?: TaskLogger;
	/** Called when the budget expires (before the abort), so a caller can log or retry. */
	onBudget?: (name: string, budgetMs: number) => void;
}

interface Running {
	name: string;
	promise: Promise<void>;
	controller: AbortController;
}

interface Slot {
	running?: { promise: Promise<void>; seq: number };
	/** A request arrived while a run was in flight: run exactly one more time afterwards. */
	again: boolean;
	/** Latest request wins: the coalesced follow-up runs the newest caller's work. */
	work?: TaskWork;
	opts?: RunOptions;
}

/** One scope per extension: session-scoped background work that can be aborted as a unit. */
export interface TaskScope {
	/** Fire-and-forget. Never rejects, never blocks the caller. */
	run(name: string, work: TaskWork, opts?: RunOptions): void;
	/**
	 * Detached single-flight: joins the run already in flight for `key` instead of
	 * stacking, and when a request arrives while one is running it schedules exactly one
	 * follow-up, so coalescing never loses the newest refresh.
	 *
	 * `key` is the contract: runs sharing a key must do equivalent work (include any
	 * argument that changes the result in the key).
	 */
	schedule(key: string, work: TaskWork, opts?: RunOptions): void;
	/**
	 * Awaitable single-flight for agent-initiated paths (tools) — the one place where
	 * waiting is correct. It joins a run that started at or after this call (its I/O is
	 * still ahead of us, so the state cannot be older than the request) and otherwise waits
	 * for the coalesced follow-up that carries this call's work.
	 */
	join(key: string, work: TaskWork, opts?: RunOptions): Promise<void>;
	/** Abort everything in flight and drop the single-flight bookkeeping (session_shutdown). */
	abort(): void;
	/** Tests/host hooks: wait for quiescence. Resolves false if `timeoutMs` elapsed first. */
	flush(timeoutMs?: number): Promise<boolean>;
	/** Number of tracked tasks in this scope. */
	pending(): number;
}

const scopes = new Set<TaskScope>();

/** How many background tasks are still running across every scope (tests). */
export function pendingTasks(): number {
	let n = 0;
	for (const s of scopes) n += s.pending();
	return n;
}

/** Tests: wait until no scope has work in flight. Resolves false on timeout. */
export async function flushAllTasks(timeoutMs = 10_000): Promise<boolean> {
	// Monotonic clock: a test that fakes Date.now must not be able to shorten a wait.
	const deadline = performance.now() + timeoutMs;
	while (pendingTasks() > 0) {
		if (performance.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 10));
	}
	return true;
}

/**
 * Create a background-work scope. Everything it returns is safe to call from any
 * lifecycle handler: no path through it can throw into Pi.
 */
export function createTaskScope(label: string, opts: { onError?: TaskLogger; budgetMs?: number } = {}): TaskScope {
	const running = new Set<Running>();
	const slots = new Map<string, Slot>();
	// Monotonic start counter: lets `join` tell "already running" from "started after me".
	let seq = 0;

	const report = (msg: string) => {
		try {
			opts.onError?.(msg);
		} catch {
			// A logger must never be able to break the extension.
		}
	};

	const start = (name: string, work: TaskWork, o?: RunOptions): Running => {
		const controller = new AbortController();
		const budgetMs = o?.budgetMs ?? opts.budgetMs;
		let timer: NodeJS.Timeout | undefined;
		if (budgetMs && budgetMs > 0) {
			timer = setTimeout(() => {
				try {
					o?.onBudget?.(name, budgetMs);
				} catch {}
				try {
					controller.abort(new Error(`${name} exceeded its ${budgetMs} ms budget`));
				} catch {}
			}, budgetMs);
			timer.unref?.();
		}

		const entry: Running = { name, controller, promise: Promise.resolve() };
		running.add(entry);
		entry.promise = (async () => {
			try {
				await work(controller.signal);
			} catch (err) {
				// A task told to stop is not a failure worth surfacing.
				if (controller.signal.aborted) return;
				const text = err instanceof Error ? err.message : String(err);
				(o?.onError ?? report)?.(`[${label}] ${name} failed: ${text}`);
			} finally {
				if (timer) clearTimeout(timer);
				running.delete(entry);
			}
		})();
		return entry;
	};

	/** Start a run for a single-flight slot; a coalesced follow-up uses the newest work. */
	const begin = (slot: Slot, key: string): Running | undefined => {
		const work = slot.work;
		if (!work) return undefined;
		const startedSeq = ++seq;
		const entry = start(
			key,
			(signal) => (slot.work as TaskWork)(signal),
			slot.opts,
		);
		slot.running = { promise: entry.promise, seq: startedSeq };
		void entry.promise.finally(() => {
			// Only clear our own generation: abort() may already have reset this slot.
			if (slot.running?.seq === startedSeq) slot.running = undefined;
			if (slot.again) {
				slot.again = false;
				begin(slot, key);
			}
		});
		return entry;
	};

	const slotFor = (key: string, work: TaskWork, o?: RunOptions): Slot => {
		let slot = slots.get(key);
		if (!slot) {
			slot = { again: false };
			slots.set(key, slot);
		}
		slot.work = work;
		slot.opts = o;
		return slot;
	};

	const scope: TaskScope = {
		run(name, work, o) {
			try {
				start(name, work, o);
			} catch (err) {
				report(`[${label}] ${name} could not start: ${err instanceof Error ? err.message : String(err)}`);
			}
		},

		schedule(key, work, o) {
			const slot = slotFor(key, work, o);
			if (slot.running) {
				slot.again = true;
				return;
			}
			begin(slot, key);
		},

		async join(key, work, o) {
			const slot = slotFor(key, work, o);
			// A run that started at or after this call still has its I/O ahead of us, so joining it
			// is enough; an older run gets a coalesced follow-up carrying this request's work.
			const seen = seq;
			for (let round = 0; round < 3; round++) {
				if (!slot.running) {
					const started = begin(slot, key);
					if (started) await started.promise;
					return;
				}
				if (slot.running.seq >= seen) {
					await slot.running.promise;
					return;
				}
				// In flight but stale for us: its finish starts the follow-up carrying *our*
				// work (latest wins), which this loop joins on the next round.
				slot.again = true;
				await slot.running.promise;
			}
		},

		abort() {
			for (const slot of slots.values()) {
				slot.running = undefined;
				slot.again = false;
			}
			for (const r of Array.from(running)) {
				try {
					r.controller.abort(new Error(`${label} shut down`));
				} catch {}
			}
			running.clear();
		},

		async flush(timeoutMs = 10_000) {
			const deadline = performance.now() + timeoutMs;
			while (running.size > 0) {
				if (performance.now() > deadline) return false;
				await new Promise((r) => setTimeout(r, 10));
			}
			return true;
		},

		pending() {
			return running.size;
		},
	};

	scopes.add(scope);
	return scope;
}

/**
 * Budget violation reporting for the paths Pi awaits. A violation is logged once per
 * (scope, event) so a regression is visible in the TUI without spamming it: nothing here
 * blocks, it only makes "I awaited a network call on a critical path" impossible to miss.
 */
const reportedViolations = new Set<string>();

export function reportBudgetViolation(
	label: string,
	event: string,
	elapsedMs: number,
	budgetMs: number,
	log: TaskLogger,
): void {
	if (elapsedMs <= budgetMs) return;
	const key = `${label}:${event}`;
	if (reportedViolations.has(key)) return;
	reportedViolations.add(key);
	log(
		`[${label}] "${event}" took ${Math.round(elapsedMs)} ms (budget ${budgetMs} ms): this stalls Pi's ${event} boundary — move the work to a background task`,
	);
}

/** Tests: allow violations to be reported again (one process runs many cases). */
export function resetBudgetViolationsForTests(): void {
	reportedViolations.clear();
}

/**
 * Async "is this command on PATH" probe — the replacement for `execFileSync("which", …)`.
 * A `which` spawn on the load path runs before the TUI exists, and inside a live handler it
 * freezes rendering and keystroke echo for its whole duration; this only stats directories.
 *
 * Memoized per (command, PATH) and single-flight. A test that swaps PATH gets a fresh answer.
 */
const availabilityCache = new Map<string, Promise<boolean>>();

function pathCandidates(cmd: string): string[] {
	if (cmd.includes("/") || cmd.includes("\\")) return [cmd];
	const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
	const exts =
		process.platform === "win32"
			? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
			: [""];
	const out: string[] = [];
	for (const dir of dirs) {
		for (const ext of exts) out.push(path.join(dir, cmd + ext));
	}
	return out;
}

async function probeCommand(cmd: string): Promise<boolean> {
	for (const candidate of pathCandidates(cmd)) {
		try {
			const st = await fsp.stat(candidate);
			if (!st.isFile()) continue;
			// X_OK is unreliable on Windows; `which` there effectively answers by existence.
			if (process.platform === "win32") return true;
			try {
				await fsp.access(candidate, fsConstants.X_OK);
				return true;
			} catch {}
		} catch {}
	}
	return false;
}

export function commandExists(cmd: string): Promise<boolean> {
	const key = `${cmd} ${process.env.PATH ?? ""}`;
	const cached = availabilityCache.get(key);
	if (cached) return cached;
	const probe = probeCommand(cmd).catch(() => false);
	availabilityCache.set(key, probe);
	return probe;
}

/** Tests: forget probed availability (PATH changed in-process). */
export function resetCommandAvailabilityForTests(): void {
	availabilityCache.clear();
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Fan-out that stays off the
 * critical path must not become a serial chain either: with N observed PRs a serial loop
 * multiplies one call's latency by N (and one hung call dominates the whole refresh).
 * Rejections are collected, never thrown: the caller decides what a partial round means.
 */
export async function mapLimited<T>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<{ ok: boolean; errors: unknown[] }> {
	const errors: unknown[] = [];
	let cursor = 0;
	const width = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: width }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			try {
				await fn(items[index], index);
			} catch (err) {
				errors.push(err);
			}
		}
	});
	await Promise.all(workers);
	return { ok: errors.length === 0, errors };
}

/** Serialized, atomic, non-blocking file writes (replaces sync `writeFileSync` on hot paths). */
export class WriteQueue {
	private tail: Promise<void> = Promise.resolve();
	private queued = 0;
	private waiters = new Set<() => void>();
	private log?: TaskLogger;

	constructor(log?: TaskLogger) {
		this.log = log;
	}

	/**
	 * Queue an atomic tmp+rename write. Order is preserved: a later write to the same file
	 * never lands before an earlier one, and nothing here blocks the event loop.
	 */
	write(file: string, data: string): Promise<void> {
		this.queued++;
		const job = this.tail.then(async () => {
			const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
			try {
				await fsp.mkdir(path.dirname(file), { recursive: true });
				await fsp.writeFile(tmp, data, "utf-8");
				await fsp.rename(tmp, file);
			} catch (err) {
				try {
					await fsp.rm(tmp, { force: true });
				} catch {}
				this.log?.(`failed to write ${file}: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				this.queued--;
				if (this.queued === 0) {
					for (const done of Array.from(this.waiters)) done();
					this.waiters.clear();
				}
			}
		});
		// Keep the chain alive even when a write fails.
		this.tail = job.catch(() => undefined);
		return job;
	}

	/** Wait for every queued write. Pi awaits `session_shutdown`, so the last state stays durable. */
	async drain(timeoutMs = 5_000): Promise<boolean> {
		if (this.queued === 0) return true;
		return new Promise<boolean>((resolve) => {
			const finish = () => {
				clearTimeout(timer);
				resolve(true);
			};
			const timer = setTimeout(() => {
				this.waiters.delete(finish);
				resolve(false);
			}, timeoutMs);
			timer.unref?.();
			this.waiters.add(finish);
		});
	}

	get size(): number {
		return this.queued;
	}
}
