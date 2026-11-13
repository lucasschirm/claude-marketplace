// Admission, the queue, cancellation and the follow-up turn.
//
// One rule runs this whole file: **a task either reserves a slot or joins the FIFO, never both**. The
// FIFO is what makes "queued as 2 of 3" a promise rather than an estimate, and a task that is admitted
// while others wait would jump the line — which is why admission requires an empty queue, not merely a
// free slot.
//
// With more than one agent there is a second rule, and it changes the drain rather than the admission:
// the drain scans for the first task whose agent has capacity instead of stopping at the head. A queue
// that stops at a blocked head turns "Devin is busy" into "Claude is blocked too", which is exactly the
// starvation the per-agent ceilings exist to prevent. Fairness between agents is preserved because each
// agent's own tasks stay in order.

import { extractCliError } from "./diagnostics.ts";
import { detectPullRequest } from "./pr-detect.ts";
import { agentTitle, findAgent } from "./registry.ts";
import { commandForCaller } from "./permissions.ts";
import { configureSession, installDrainer, reattachSession, spawnSession, startTurn } from "./session.ts";
import type { DelegateTransport } from "./transport.ts";
import type { DelegateRuntime } from "./runtime.ts";
import { createWorktree, releaseWorktree } from "./worktree.ts";
import type { AgentDriver, QueuedTask, Selection, SessionMeta } from "./types.ts";

export interface DelegateRequest {
	driver: AgentDriver;
	selection: Selection;
	prompt: string;
	createWorktree: boolean;
	/** Set when this task re-runs another session (restart): kept for provenance in `delegate_status`. */
	parentSessionId?: string;
	/** Reuse an existing worktree instead of provisioning one (restart in place). */
	reuseWorktree?: {
		worktreePath?: string;
		worktreeBranch?: string;
		worktreeId?: string;
		parentWorktreeId?: string;
		worktreeStatus?: SessionMeta["worktreeStatus"];
	};
}

export type DelegateResult =
	| { ok: true; started: SessionMeta; warnings: string[] }
	// `position` and `queueTotal` are the queue as this call left it, not as the caller reads it later:
	// six parallel delegations all queue inside one tick, and a reply that read `rt.queue.length` when it
	// was formatted told every one of them it was last.
	| { ok: true; queued: QueuedTask; position: number; queueTotal: number; reason: QueueReason; warnings: string[] }
	| { ok: false; code: string; error: string };

/** Why a task was not started immediately. Each one implies a different action by the caller. */
export type QueueReason = "agent-limit" | "total-limit" | "ahead-in-queue";

/**
 * The reason a reservation failed, in the caller's terms.
 *
 * Must be called with the task *not yet* in the queue: once it is pushed, "the queue is not empty" is
 * true of every refusal and says nothing about the one that stopped this task.
 */
function queueReason(rt: DelegateRuntime, agent: string): QueueReason {
	if (rt.queue.length > 0) {
		return "ahead-in-queue";
	}
	if (rt.slots.inFlight(agent) >= rt.maxRuns) {
		return "agent-limit";
	}
	return "total-limit";
}

/**
 * Admit a task: preflight the agent, take a slot if the queue is empty, else join the FIFO.
 *
 * `preflight()` is awaited before the reservation, so an agent that is not installed costs a
 * subprocess, not a slot. The reservation happens before the first `await` of the start itself — that
 * is the whole point of it (see slots.ts).
 */
export async function delegate(rt: DelegateRuntime, req: DelegateRequest): Promise<DelegateResult> {
	const agent = req.driver.id;
	const health = await rt.preflightAgent(req.driver);
	if (!health.ok) {
		return { ok: false, code: "AGENT_UNAVAILABLE", error: health.hint ? `${health.error} — ${health.hint}` : health.error };
	}

	const task: QueuedTask = {
		queueId: `q-${++rt.totalInvoked}`,
		agent,
		prompt: req.prompt,
		model: req.selection.model,
		thinking: req.selection.thinking,
		mode: req.selection.mode,
		createWorktree: req.createWorktree,
		enqueuedAt: Date.now(),
		parentSessionId: req.parentSessionId,
		...(req.reuseWorktree ?? {}),
	};

	const release = rt.queue.length === 0 ? rt.slots.tryReserve(agent) : null;
	if (!release) {
		// Why it waits, decided *before* the push: after pushing, the queue is never empty, so a reason
		// computed afterwards blamed "tasks ahead of it" for a refusal that the limits caused.
		const reason = queueReason(rt, agent);
		rt.queue.push(task);
		// Position likewise: this task is last, and everything else about the queue is as this call left
		// it. Reading `rt.queue.length` when the tool formats its reply told six parallel delegations
		// each that they were last.
		const position = rt.queue.length;
		const queueTotal = rt.queue.length;
		rt.persistState();
		rt.updateStatusUI();
		// Something may already be startable for a different agent than the queue head.
		void drainQueue(rt);
		return { ok: true, queued: task, position, queueTotal, reason, warnings: [] };
	}
	// `announce: false` — this caller is holding a tool result that already contains the id.
	const res = await startNow(rt, task, release, req.driver, { announce: false });
	if (!res.ok) {
		// This call is the event that freed the slot. The queue used to be re-run only when a *dequeued*
		// start failed, so a first task that died at spawn left everything behind it waiting for some
		// unrelated event, while the capacity to run them already existed.
		void drainQueue(rt);
	}
	return res;
}

/** Reserve held: provision, spawn, configure, run. Always releases the reservation exactly once. */
/**
 * `announce` decides who tells the parent session about the id.
 *
 * A caller that queued gets a tool result saying "queued as q-3" and nothing else; when that task later
 * starts, the id has to reach it as a message, or it never learns which session to follow up on. A
 * caller that started immediately already has the id in its tool result — repeating it as a message is
 * noise in the conversation, and six delegations meant six duplicated lines.
 */
async function startNow(
	rt: DelegateRuntime,
	task: QueuedTask,
	release: () => void,
	driver: AgentDriver,
	{ announce = true }: { announce?: boolean } = {},
): Promise<DelegateResult> {
	let registered = false;
	let provisionedHere = false;
	let started: SessionMeta | undefined;
	let client: DelegateTransport | undefined;
	try {
		if (task.createWorktree && !task.worktreePath) {
			const wt = await provisionWorktree(rt, task);
			if (!wt.ok) {
				release();
				return { ok: false, code: "WORKTREE_CREATE_FAILED", error: wt.error };
			}
			provisionedHere = true;
		}
		const cwd = task.worktreePath ?? rt.baseDir;
		const selection: Selection = { model: task.model, thinking: task.thinking, mode: task.mode };
		const spawned = await spawnSession(rt, driver, selection, {
			prompt: task.prompt,
			cwd,
			queueId: task.queueId,
			createWorktree: task.createWorktree,
		});
		started = spawned.meta;
		client = spawned.client;
		// Registered: from here the session holds the slot itself, through its own status.
		registered = true;
		release();

		started.queueId = task.queueId;
		started.parentSessionId = task.parentSessionId;
		started.worktreePath = task.worktreePath;
		started.worktreeBranch = task.worktreeBranch;
		started.worktreeId = task.worktreeId;
		started.parentWorktreeId = task.parentWorktreeId;
		started.worktreeStatus = task.worktreePath ? "active" : undefined;

		const warnings = await configureSession(rt, driver, started, client, selection);
		if (started.status === "cancelled") {
			// Cancelled while its mode and model were still being chosen — a window that is two round trips
			// long. Starting the turn anyway would hand the caller back a session it had just stopped, with a
			// live process behind it.
			client.dispose();
			return { ok: false, code: "CANCELLED_DURING_START", error: "the session was cancelled while it was being configured" };
		}
		startTurn(rt, started, client, task.prompt);
		if (announce) {
			rt.sendAgentMessage(`Your session started with id: ${started.sessionId}`);
		}
		return { ok: true, started, warnings };
	} catch (err) {
		const reason = extractCliError(err) ?? String(err);
		if (!registered) {
			release();
			if (provisionedHere && task.worktreePath) {
				// A folder created for a session that never existed: nothing else owns it, so nothing else
				// will ever clean it up. (A queued task's folder is released by `delegate_cancel`.)
				const { removeOrcaWorktree } = await import("../orca-client.ts");
				void removeOrcaWorktree(task.worktreeId || `path:${task.worktreePath}`).catch(() => {});
			}
		} else if (started && client) {
			// Registered, and then something threw on the way to the first turn. Left alone, that is a
			// session recorded `running` with a client that will never run a turn: a slot nothing releases and
			// a status line that lies. Close it as the failed start it is.
			started.status = "failed";
			started.error = reason;
			started.finishedAt = Date.now();
			client.dispose();
			rt.activeClients.delete(started.sessionId);
			rt.persistSessionMeta(started, true);
			rt.persistState();
			rt.updateStatusUI();
		}
		rt.logError(`Failed to start ${task.agent} session for ${task.queueId}: ${reason}`);
		return { ok: false, code: "START_FAILED", error: reason };
	}
}

async function provisionWorktree(rt: DelegateRuntime, task: QueuedTask): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const wt = await createWorktree(rt, rt.baseDir);
		task.worktreePath = wt.worktreePath;
		task.worktreeBranch = wt.worktreeBranch;
		task.worktreeId = wt.worktreeId;
		task.parentWorktreeId = wt.parentWorktreeId;
		task.worktreeStatus = "active";
		return { ok: true };
	} catch (err) {
		const error = extractCliError(err) ?? String(err);
		rt.logError(`Failed to create worktree for task ${task.queueId}: ${error}`);
		return { ok: false, error };
	}
}

const draining = new WeakMap<DelegateRuntime, boolean>();

/** Start as many queued tasks as capacity allows. Re-checked after the loop, so no capacity is stranded. */
export async function drainQueue(rt: DelegateRuntime): Promise<void> {
	if (draining.get(rt)) {
		return;
	}
	draining.set(rt, true);
	try {
		for (;;) {
			const idx = rt.queue.findIndex((task) => rt.slots.inFlight(task.agent) < rt.maxRuns);
			if (idx < 0) {
				break;
			}
			const [task] = rt.queue.splice(idx, 1);
			const release = rt.slots.tryReserve(task.agent);
			if (!release) {
				// Lost the race between the scan and the reservation. Put it back **where it came from**: a
				// task found further down the queue (this scan looks past an agent at its limit) must not be
				// promoted to the head, and the positions already quoted to callers must stay true.
				rt.queue.splice(idx, 0, task);
				break;
			}
			rt.persistState();
			rt.updateStatusUI();
			const found = findAgent(task.agent);
			if (!found.ok) {
				// A descriptor removed from disk after its task was queued: the agent was promised a
				// session, so say this one is not coming rather than leaving it in the FIFO forever.
				release();
				rt.sendAgentMessage(`The queued task ${task.queueId} cannot start: ${found.error}`);
				continue;
			}
			void startNow(rt, task, release, found.driver).then((res) => {
				if (!res.ok) {
					// The agent was promised a session id for this task: say it is not coming.
					rt.sendAgentMessage(`The queued task ${task.queueId} failed to start: ${res.error}. Delegate it again with "delegate_task".`);
				}
				void drainQueue(rt);
			});
		}
	} finally {
		draining.set(rt, false);
	}
	// No re-check here. The loop above already re-scans until nothing in the queue is admissible, and a
	// second pass in this same tick would be a tail call in name only: with a queue whose every agent is
	// at its per-agent limit, `queue.length > 0` and `inFlight() < maxRunsTotal` stay true forever and the
	// re-check calls itself until the stack overflows. It did, in the queue suite. Capacity that appears
	// later (a turn ending, a cancel, a failed start) calls `drainQueue` from that event instead, which is
	// where new capacity actually comes from.
}

// The session layer settles turns and has to re-run the queue when one ends. Registering here (rather
// than passing a callback through six call sites) means there is exactly one drainer per process.
installDrainer(drainQueue);

/**
 * Whether a turn is in flight. A function, because `followUp` asks twice — before it seeks a connection and
 * again after an `await` that may have let somebody else start the turn — and a type narrowed by the first
 * answer says nothing about the second.
 */
const midTurn = (meta: SessionMeta) => meta.status === "running" || meta.status === "stalled";

/**
 * Continue a session with another prompt, on its live connection if there is one.
 *
 * No re-spawn when the process is alive: a second `devin acp` for a live session id would fork the
 * agent's view of its own work. When it is gone `reattachSession` spawns a fresh one and restores the
 * conversation for a driver with a `resumeHandshake`; one without is prompted with the recorded id, as
 * Devin's server takes it. A conversation the agent will not give back is reported, naming `delegate_restart`.
 */
export async function followUp(
	rt: DelegateRuntime,
	meta: SessionMeta,
	prompt: string,
): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
	const driver = findAgent(meta.agent);
	if (!driver.ok) {
		return { ok: false, code: "AGENT_UNAVAILABLE", error: `the driver '${meta.agent}' is no longer registered: ${driver.error}` };
	}
	if (midTurn(meta)) {
		// "Still working" is the wrong story when the session is blocked on a decision the caller could
		// make right now, and a permission-blocked session is exactly what a follow-up message arrives on.
		// Name the request, in the same words the status line uses, so the caller can act on the refusal.
		const pending = rt.pendingPermissions.get(meta.sessionId) ?? [];
		if (pending.length > 0) {
			return {
				ok: false,
				code: "BUSY_AWAITING_PERMISSION",
				error:
					`the session is currently running and is blocked on a permission request. ` +
					`Awaiting permission to run: ${commandForCaller(pending[0].command)}${pending.length > 1 ? ` (+${pending.length - 1} more)` : ""}. ` +
					`Answer with delegate_permission(session_id='${meta.sessionId}', decision=allow|allow_session|reject) to unblock it, or delegate_cancel to stop it.`,
			};
		}
		return { ok: false, code: "BUSY", error: "the session is still working; wait for it or delegate_cancel first" };
	}

	// A follow-up turn occupies capacity exactly the way an initial one does, so it asks for the slot the
	// same way. Without this the limits were a suggestion: two running sessions plus a follow-up was a third
	// turn inside a per-agent limit of two, and the status line reported more in flight than there were.
	const release = rt.slots.tryReserve(meta.agent);
	if (!release) {
		const reason = queueReason(rt, meta.agent);
		return {
			ok: false,
			code: "LIMIT",
			error:
				`${agentTitle(meta.agent)} is at its capacity (${reason === "total-limit" ? "the total limit across agents" : "this agent's limit"}), so the session cannot take another turn. ` +
				`Wait for one to finish, or raise the limit with "/delegate limit <n>".`,
		};
	}

	let client = rt.activeClients.get(meta.sessionId);
	if (!client) {
		if (!driver.driver.capabilities().resume) {
			release();
			return {
				ok: false,
				code: "NO_CONNECTION",
				error: `${agentTitle(meta.agent)} has no way to continue a session whose process is gone — use delegate_restart to run the prompt again (same worktree, new session id)`,
			};
		}
		try {
			client = await reattachSession(rt, driver.driver, meta);
		} catch (err: any) {
			release();
			return {
				ok: false,
				code: "REATTACH_FAILED",
				error: `could not re-attach to the session: ${extractCliError(err) ?? err?.message ?? err}`,
			};
		}
		// Somebody else's reattach was also their turn: an agent mid-turn refuses a second prompt
		// (`TURN_IN_PROGRESS`) and the rejection path marks the session failed, so starting here would answer
		// `{ok: true}` to a message nothing received. The check above ran before this await and could not see
		// it; the live-client path needs none, because nothing is awaited before its `startTurn`.
		if (midTurn(meta)) {
			release();
			return {
				ok: false,
				code: "BUSY",
				error:
					`another follow-up started a turn on this session while yours was waiting for the connection. ` +
					`Wait for it, or delegate_cancel to stop it, and send the message again.`,
			};
		}
	}
	// The reservation ends where the session's own `running` status begins — the same handoff an initial
	// start makes in `startNow`. Between them there is no window in which the turn is uncounted.
	release();
	startTurn(rt, meta, client, prompt);
	return { ok: true };
}

export type CancelOutcome = "queued" | "session" | "not_running" | "not_found";

/**
 * Cancel a queued task or a running session.
 *
 * A cancelled turn is not a failure and must not be rewritten as one: the status is set before the
 * client is disposed, so when the prompt promise rejects the settlement path sees `cancelled` and
 * leaves it alone.
 */
export async function cancelSession(rt: DelegateRuntime, targetId: string): Promise<CancelOutcome> {
	const queueIndex = rt.queue.findIndex((t) => t.queueId === targetId);
	if (queueIndex >= 0) {
		const [queued] = rt.queue.splice(queueIndex, 1);
		if (queued.worktreePath) {
			// Provisioned for a task that will never run: give the folder back.
			const { removeOrcaWorktree } = await import("../orca-client.ts");
			void removeOrcaWorktree(queued.worktreeId || `path:${queued.worktreePath}`).catch(() => {});
		}
		rt.persistState();
		rt.updateStatusUI();
		return "queued";
	}
	const meta = rt.sessions.get(targetId);
	if (!meta) {
		return "not_found";
	}
	if (meta.status !== "running" && meta.status !== "stalled" && !rt.activeClients.has(targetId)) {
		// Already finished. Cancelling it used to rewrite `failed` as `cancelled`, count a second completion
		// for one turn, run the worktree release a settled session already ran, and tell the caller "the slot
		// is free" when no slot was held.
		return "not_running";
	}

	meta.status = "cancelled";
	meta.finishedAt = Date.now();
	rt.stopStallWatchdog(meta.sessionId);
	rt.flushBuffers(meta);
	const client = rt.activeClients.get(targetId);
	if (client) {
		client.notify("session/cancel", { sessionId: targetId });
		client.dispose();
		rt.activeClients.delete(targetId);
	} else if (meta.pid) {
		// The pid kill is PID-recycle-guarded by the driver's CLI name, so it comes from the driver.
		rt.killProcessGroup(meta.pid, rt.driverCli(meta.agent));
	}
	rt.totalCompleted++;
	rt.persistSessionMeta(meta, true);
	rt.persistState();
	rt.updateStatusUI();
	void drainQueue(rt);

	if (meta.worktreePath && meta.worktreeStatus === "active") {
		void releaseWorktree(rt, meta).catch((err) => rt.logError(`worktree release failed for ${meta.sessionId}: ${extractCliError(err)}`));
	}
	return "session";
}

/**
 * observe-pr calls this when a PR merges or closes: a worktree whose PR landed is dead wood, and the
 * agent is not going to clean it up on its own.
 */
export async function onPrClosed(rt: DelegateRuntime, prNumber: number, state: string): Promise<void> {
	for (const [id, meta] of rt.sessions.entries()) {
		if (!meta.worktreePath || meta.worktreeStatus !== "active") {
			continue;
		}
		if (meta.status === "running" || meta.status === "stalled") {
			rt.logWarn(`Skipping worktree cleanup for active session ${id} on PR #${prNumber} closed event`);
			continue;
		}
		let matches = meta.detectedPrNumber === prNumber;
		if (!matches && !meta.detectedPrNumber) {
			const active = await detectPullRequest(rt, meta.worktreePath, meta.worktreeBranch);
			if (active === prNumber) {
				meta.detectedPrNumber = active;
				matches = true;
			}
		}
		if (!matches) {
			continue;
		}
		const res = await releaseWorktree(rt, meta);
		rt.sendAgentMessage(
			`Worktree for session ${id} ${res.removed ? "removed" : `not removed (${res.note})`} after PR #${prNumber} was ${state}.`,
		);
	}
}
