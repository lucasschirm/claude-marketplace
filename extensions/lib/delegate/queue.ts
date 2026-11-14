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
import {
	configureSession,
	installDrainer,
	markSuperseded,
	PiShutDownError,
	reattachSession,
	worktreeHasLiveClaim,
	spawnSession,
	startTurn,
	supersededError,
	supersededPointerText,
	workspaceProblem,
} from "./session.ts";
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
/** The mirror of `resolveQueuedRestart`: a restart that will never start must hand the conversation back. */
export function abandonQueuedRestart(rt: DelegateRuntime, task: QueuedTask): void {
	if (!task.parentSessionId) {
		return;
	}
	const parent = rt.sessions.get(task.parentSessionId);
	const pointer = parent?.supersededBy;
	if (!parent || !pointer || pointer.queueId !== task.queueId) {
		return;
	}
	// Only the half this entry was — a pointer that also names a live session still has somewhere to send a
	// caller. The half must be checked, not trusted: a both-halves pointer only ever arrives from disk (live
	// writers emit one half each), so its session half can name something that died, and promoting that would
	// refuse the parent as "restarted as <id>" with nothing behind the id until the next boot reconciles it.
	parent.supersededBy = pointer.sessionId && rt.sessions.has(pointer.sessionId) ? { sessionId: pointer.sessionId } : undefined;
	rt.persistSessionMeta(parent, true);
	rt.persistState();
}

/**
 * A queued restart resolves the moment its session exists: the parent's pointer named this queue entry, and
 * without the rewrite it goes on refusing with "queue entry q-7", sending the caller to something that stopped
 * existing when it started.
 */
function resolveQueuedRestart(rt: DelegateRuntime, task: QueuedTask, sessionId: string): void {
	if (!task.parentSessionId) {
		return;
	}
	const parent = rt.sessions.get(task.parentSessionId);
	if (parent?.supersededBy?.queueId === task.queueId) {
		markSuperseded(rt, parent, { sessionId });
	}
}

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
	// `drainQueue` floats this call and nothing else holds it, so `session_shutdown` does not reach it. Without
	// the epoch check a start that was mid-flight when pi closed finishes anyway: it registers into a runtime
	// that has been cleared, persists under whatever pi session id answers next (the orphan `default/`
	// namespace), and leaves an agent running for a session that no longer exists — invisible to the next boot's
	// recovery, and visible to this process's own tools until it exits.
	const epoch = rt.epoch;
	const shutDown = () => rt.epoch !== epoch;
	const gone = { ok: false, code: "SESSION_CLOSED", error: "pi closed this session before its task started" } as const;
	try {
		if (task.createWorktree && !task.worktreePath) {
			const wt = await provisionWorktree(rt, task);
			if (!wt.ok) {
				release();
				return { ok: false, code: "WORKTREE_CREATE_FAILED", error: wt.error };
			}
			provisionedHere = true;
			if (shutDown()) {
				// The folder was created for a task that will never run, and nothing else knows its name.
				void releaseWorktree(rt, { ...task, sessionId: task.queueId } as never).catch(() => {});
				release();
				return gone;
			}
		}
		if (shutDown()) {
			release();
			return gone;
		}
		const cwd = task.worktreePath ?? rt.baseDir;
		const selection: Selection = { model: task.model, thinking: task.thinking, mode: task.mode };
		const spawned = await spawnSession(rt, driver, selection, {
			prompt: task.prompt,
			cwd,
			queueId: task.queueId,
			createWorktree: task.createWorktree,
			// Checked inside `spawnSession` too: it registers and persists on its own way out, and a record
			// written into a shut-down runtime is worse than no record at all.
			stale: shutDown,
		});
		if (shutDown()) {
			// Backstop for anything that registered and still returned: give back everything it added, stop the
			// child, and take away the folder this start made. Past this line the session would be live, owned by
			// nobody — and the folder would be a `*-dtN` checkout and branch no record names, so no sweep sees it.
			unregisterStart(rt, spawned.meta, spawned.client);
			if (provisionedHere && task.worktreePath) {
				const { removeOrcaWorktree } = await import("../orca-client.ts");
				void removeOrcaWorktree(`path:${task.worktreePath}`).catch(() => {});
			}
			release();
			return gone;
		}
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
		// The successor's own record before anything that points at it, and before the next await. Two reasons,
		// both about a crash landing between these writes: a claim naming no worktree orphans the folder (every
		// cleanup path skips a superseded parent, and this record would have nothing to release), and a parent
		// already pointing here would be a pointer to a session with no provenance — one recovery keeps, because
		// the session exists, and cannot rebuild. Written first, the residual heals: recovery derives the
		// pointer from this record. A plain task gets the same write for the first reason alone.
		if (task.parentSessionId || started.worktreePath) {
			rt.persistSessionMeta(started, true);
		}
		resolveQueuedRestart(rt, task, started.sessionId);

		const warnings = await configureSession(rt, driver, started, client, selection);
		if (shutDown()) {
			// Choosing the mode and the model is two awaited round trips, and `session_shutdown` cannot reach a
			// floated start through them. Starting the turn here would repopulate a cleared runtime, start a
			// stall watchdog on a session pi has forgotten, and announce a failure into whatever session is
			// current next.
			unregisterStart(rt, started, client);
			return gone;
		}
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
				void removeOrcaWorktree(`path:${task.worktreePath}`).catch(() => {});
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
		if (err instanceof PiShutDownError) {
			// Same reason as the other shutdown exits: the task did not fail, pi went away. A caller keying on
			// `code` should see the closed session, not a start that broke.
			rt.logWarn(`Dropped the start of ${task.agent} task ${task.queueId}: pi closed while it was starting`);
			return gone;
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
	const epoch = rt.epoch;
	try {
		for (;;) {
			if (rt.epoch !== epoch) {
				// `session_shutdown` cleared the runtime and the queue with it. Everything after this point
				// would be starting work for a pi session that no longer exists.
				return;
			}
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
				abandonQueuedRestart(rt, task);
				rt.sendAgentMessage(`The queued task ${task.queueId} cannot start: ${found.error}`);
				continue;
			}
			void startNow(rt, task, release, found.driver).then((res) => {
				if (!res.ok) {
					// The agent was promised a session id for this task: say it is not coming. And if that task
					// was a restart, its parent keeps pointing at an entry that will never start unless this says
					// otherwise — the conversation is its own again.
					abandonQueuedRestart(rt, task);
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
 * Take back a registration that must not stand: pi shut down while its start was still awaiting.
 *
 * `spawnSession` puts the session in the map, the client table and the transcript before the caller sees it
 * back, so an abandoned start has to be removed from all three and its child stopped — a record left in a
 * cleared runtime is a session the tools can address and nobody owns.
 */
export function unregisterStart(rt: DelegateRuntime, meta: SessionMeta, client: DelegateTransport): void {
	rt.sessions.delete(meta.sessionId);
	rt.activeClients.delete(meta.sessionId);
	rt.turnInFlight.delete(meta.sessionId);
	rt.stopStallWatchdog(meta.sessionId);
	// A `session/update` that arrived during the configuration round trips (a `current_mode_update` answering
	// `session/set_mode` is normal) can have armed the debounced record write and filled the stream buffers.
	// Left armed, the timer fires after pi is gone and persists a record for the session this function is
	// unregistering — the phantom write `spawnSession`'s `stale` check exists to prevent, one await later.
	const pendingSave = rt.pendingMetaSaves.get(meta.sessionId);
	if (pendingSave) {
		clearTimeout(pendingSave.timer);
		rt.pendingMetaSaves.delete(meta.sessionId);
	}
	rt.assistantBuffers.delete(meta.sessionId);
	rt.thoughtBuffers.delete(meta.sessionId);
	client.dispose();
}

/**
 * Whether this conversation still belongs to the id it was addressed by. A restart mints a new id and leaves
 * this record where it was, so the pointer is what says the conversation moved on; the in-flight set says the
 * same thing one moment earlier, while the restart is still spawning what its pointer will name. Either way
 * the sibling works in this session's worktree, and reattaching would run two live agents of it in one
 * checkout — which is why a follow-up is refused rather than queued behind the restart.
 */
function conversationTakenElsewhere(rt: DelegateRuntime, meta: SessionMeta): { code: string; error: string } | undefined {
	if (meta.supersededBy) {
		return { code: "SUPERSEDED", error: supersededError(meta) };
	}
	if (rt.restarting.has(meta.sessionId)) {
		return {
			code: "RESTARTING",
			error:
				`a delegate_restart of this session is in flight, and the session it starts will own this conversation. ` +
				`Wait for it — there is nothing here to cancel yet — and nothing was prompted.`,
		};
	}
	return undefined;
}

/**
 * Get this conversation's connection and put the prompt on it, or say why neither can happen.
 *
 * Everything between "the caller addressed this session" and "a turn starts" lives here: no resume capability at
 * all, a reattach that failed, a conversation cancelled or taken over while its agent was connecting, or a turn
 * another follow-up began while this one waited for the connection. The live-client path needs none of the checks
 * that follow the spawn, because nothing between it and `startTurn` is awaited.
 *
 * The turn is *started* here rather than by the caller, and that is not tidiness. Two follow-ups that arrive
 * inside one reattach window await the same promise; the first one's continuation is what makes the session
 * `running`, and the second reads that status to refuse itself. A second `await` between resolving the shared
 * promise and calling `startTurn` slips the winner's continuation behind the loser's, both see a session that is
 * not mid-turn, and the agent answers the second prompt with `TURN_IN_PROGRESS` while the tool has already said
 * `{ok: true}` twice.
 */
async function deliverFollowUp(
	rt: DelegateRuntime,
	driver: AgentDriver,
	meta: SessionMeta,
	prompt: string,
	release: () => void,
): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
	const refusal = (code: string, error: string) => {
		release();
		return { ok: false, code, error };
	};
	let client = rt.activeClients.get(meta.sessionId);
	if (!client) {
		if (!driver.capabilities().resume) {
			return refusal(
				"NO_CONNECTION",
				`${agentTitle(meta.agent)} has no way to continue a session whose process is gone — use delegate_restart to run the prompt again (same worktree, new session id)`,
			);
		}
		// Only a cancel that lands *during* the reattach refuses: `cancelled` describes the last turn, and a
		// conversation the caller wants back is still a conversation. The count is what makes that decidable —
		// a session that arrived cancelled has the status either way, and round 14 caught this guard reading a
		// cancel that landed mid-handshake as the pre-existing one. `reattachSession` makes the same
		// distinction; the window that matters for the answer below opens when its promise resolves.
		const cancelsSeen = rt.cancelCount(meta.sessionId);
		try {
			client = await reattachSession(rt, driver, meta);
		} catch (err: any) {
			return refusal("REATTACH_FAILED", `could not re-attach to the session: ${extractCliError(err) ?? err?.message ?? err}`);
		}
		// A cancel landing in the microtask between `reattachOnce` registering the client and this continuation is
		// invisible to that guard. Without this the caller heard "cancelled" and then watched `startTurn` rewrite
		// the status and re-register the client the cancel had just disposed.
		if (rt.cancelCount(meta.sessionId) !== cancelsSeen) {
			return refusal("CANCELLED", "this session was cancelled while its connection was being made; nothing was prompted");
		}
		// Somebody else's reattach was also their turn: an agent mid-turn refuses a second prompt
		// (`TURN_IN_PROGRESS`) and the rejection path marks the session failed, so starting here would answer
		// `{ok: true}` to a message nothing received. A restart that landed during the same await is caught
		// inside `reattachSession`, by the pointer it leaves on this record.
		if (midTurn(meta)) {
			return refusal(
				"BUSY",
				`another follow-up started a turn on this session while yours was waiting for the connection. ` +
					`Wait for it, or delegate_cancel to stop it, and send the message again.`,
			);
		}
	}
	// The reservation ends where the session's own `running` status begins — the same handoff an initial start
	// makes in `startNow`. Between them there is no window in which the turn is uncounted.
	release();
	startTurn(rt, meta, client, prompt);
	return { ok: true };
}

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
	const taken = conversationTakenElsewhere(rt, meta);
	if (taken) {
		return { ok: false, ...taken };
	}

	// Nowhere to work is a refusal before it is a slot: a released worktree, a folder on its way out, or a
	// workspace that has simply been deleted. Prompting into one hands the agent a cwd its next file operation
	// fails in — or, if the path was recreated by a later worktree, a restore that lands in somebody else's
	// checkout. `delegate_restart` is the way back: it provisions fresh when the recorded folder cannot be
	// reused.
	const workspace = workspaceProblem(rt, meta);
	if (workspace) {
		return {
			ok: false,
			code: "WORKSPACE_GONE",
			error: `this session has no workspace to continue in: ${workspace}. Use delegate_restart to run the prompt again with a new one.`,
		};
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

	// Everything after the reservation belongs to `deliverFollowUp`, and it is one call, not one call and an
	// await: the first follow-up back from a shared reattach has to reach `startTurn` before the second reads the
	// session's status.
	return deliverFollowUp(rt, driver.driver, meta, prompt, release);
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
		// A cancelled restart must not leave its parent pointing at an entry that will never start: the
		// conversation it was going to take over is still its own, and the refusal would be a lie.
		abandonQueuedRestart(rt, queued);
		// Only a folder this task provisioned itself goes back. A restart reuses its parent's worktree, which
		// the parent's conversation still lives in, and this path has no safety check to lose.
		if (queued.worktreePath && !queued.parentSessionId) {
			// Provisioned for a task that will never run: give the folder back.
			// By path for the same reason `releaseWorktreeNow` is: the id arrived from `state.json` and orca
			// deletes whatever the id it is given names.
			const { removeOrcaWorktree } = await import("../orca-client.ts");
			void removeOrcaWorktree(`path:${queued.worktreePath}`).catch(() => {});
		}
		rt.persistState();
		rt.updateStatusUI();
		return "queued";
	}
	const meta = rt.sessions.get(targetId);
	if (!meta) {
		return "not_found";
	}
	// A follow-up mid-reattach looks finished — settled, no client — but it is about to spawn an agent and
	// prompt it, so "nothing to cancel" would be answered while a turn started anyway. The reattach itself is
	// what makes this conversation cancellable; `reattachRefusal` stops the prompt on the way through.
	const reattaching = rt.reattaching.has(targetId);
	if (meta.status !== "running" && meta.status !== "stalled" && !rt.activeClients.has(targetId) && !reattaching) {
		// Already finished. Cancelling it used to rewrite `failed` as `cancelled`, count a second completion
		// for one turn, run the worktree release a settled session already ran, and tell the caller "the slot
		// is free" when no slot was held.
		return "not_running";
	}

	meta.status = "cancelled";
	// The status says what the conversation is; this says that *this* cancel happened. A reattach cannot tell
	// the two apart from `status` alone, and has to be able to.
	rt.cancels.set(targetId, rt.cancelCount(targetId) + 1);
	meta.finishedAt = Date.now();
	rt.stopStallWatchdog(meta.sessionId);
	rt.flushBuffers(meta);
	const client = rt.activeClients.get(targetId);
	if (client) {
		client.notify("session/cancel", { sessionId: targetId });
		client.dispose();
		rt.activeClients.delete(targetId);
	} else if (meta.pid && !reattaching) {
		// The pid kill is PID-recycle-guarded by the driver's CLI name, so it comes from the driver. During a
		// reattach the recorded pid is the dead process's, and the live child is not registered yet: killing
		// that stale number could reach whatever recycled it, while the child is disposed by the reattach instead.
		rt.killProcessGroup(meta.pid, rt.driverCli(meta.agent));
	}
	// Count the cancel only when it stopped a turn. A settled record with a live client is a parked agent — idle
	// sessions keep their process between turns, and cancelling one is how a caller puts it away — and its turn
	// was counted when it settled. The marker is taken here rather than tested so the settle path cannot also
	// charge it, whichever of the two arrives first.
	if (!reattaching && rt.turnInFlight.delete(targetId)) {
		rt.totalCompleted++;
	}
	rt.persistSessionMeta(meta, true);
	rt.persistState();
	rt.updateStatusUI();
	void drainQueue(rt);

	// A restart owns this folder — its pointer written, or the restart still spawning — and so does a
	// reattach still in flight, which is how this same call answers a cancel of a session that is only
	// connecting. The safety check inside `releaseWorktree` looks at uncommitted work, not at who the folder
	// belongs to.
	if (meta.worktreePath && meta.worktreeStatus === "active" && !worktreeHasLiveClaim(rt, meta)) {
		void releaseWorktree(rt, meta).catch((err) => rt.logError(`worktree release failed for ${meta.sessionId}: ${extractCliError(err)}`));
	}
	return "session";
}

/** Which live claim keeps a settled record's folder off the cleanup list, in the words the log needs. */
function liveClaimText(rt: DelegateRuntime, id: string, meta: SessionMeta): string {
	if (meta.supersededBy) {
		return `superseded session ${id} (${supersededPointerText(meta)})`;
	}
	if (rt.restarting.has(id)) {
		return `session ${id}, whose restart is in flight`;
	}
	return `session ${id}, whose follow-up is reconnecting it`;
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
		if (worktreeHasLiveClaim(rt, meta)) {
			// Something else owns this folder and may be live: a conversation that moved to a restart, a restart
			// mid-spawn whose pointer has not landed, or a follow-up reconnecting it in this very directory. A
			// settled record is not evidence its worktree is dead wood, and the log has to say which of the three
			// it is — an operator told to wait for a restart that does not exist waits for the wrong thing.
			rt.logWarn(`Skipping worktree cleanup for ${liveClaimText(rt, id, meta)} on PR #${prNumber} closed event`);
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
		// Re-checked, because `detectPullRequest` above is a `gh` call and its seconds are enough for a
		// follow-up to reconnect this session or a restart to claim it. The checks at the top of the loop are
		// then out of date, and the release deletes a folder an agent is about to work in.
		// `midTurn` is a re-read, not a restatement of the check at the top of the loop: TypeScript narrows
		// `meta.status` there, and the whole point here is that the await in between makes that narrowing
		// stale — a turn can have started in exactly those seconds.
		if (worktreeHasLiveClaim(rt, meta) || midTurn(meta)) {
			rt.logWarn(`Skipping worktree cleanup for ${liveClaimText(rt, id, meta)} on PR #${prNumber} closed event`);
			continue;
		}
		const res = await releaseWorktree(rt, meta);
		rt.sendAgentMessage(
			`Worktree for session ${id} ${res.removed ? "removed" : `not removed (${res.note})`} after PR #${prNumber} was ${state}.`,
		);
	}
}
