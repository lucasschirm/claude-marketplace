// The vocabulary of a delegate: what a driver is, what a session record holds, and which values the
// `delegate_task` tool accepts.
//
// This module knows no agent. `drivers/*.ts` supply the agent-shaped halves of these interfaces, and
// the engine (runtime/session/queue) may only ever speak them — never an ACP payload, never a model id,
// never a CLI name. That restriction is the whole point of the split: it is what lets a second agent
// arrive without an edit in the engine.

import type { ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PermissionDecision } from "./permissions.ts";

// ---------------------------------------------------------------- the tool-facing selection

/**
 * The canonical reasoning-effort vocabulary. It is the *union* across drivers on purpose: `xhigh`
 * exists for agy and Claude and must be refused for Devin rather than silently dropped, and a value
 * that no driver implements is still a value a caller will try.
 *
 * Devin has no in-band effort knob — its effort is part of the model id (`swe-2-high`, `swe-2-max`),
 * so its driver maps a level onto a model instead of sending it (see drivers/devin.ts).
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** What the caller asked to run, before any driver has translated it. */
export interface Selection {
	/** Driver-facing model id as the caller typed it (Devin accepts fuzzy names, so this is not validated hard). */
	model?: string;
	thinking?: ThinkingLevel;
	/** Canonical permission intent: dangerous | smart | accept-edits | plan | ask. Drivers alias it. */
	mode: string;
}

/** How to start one agent's ACP server. The transport has no opinion about which agent it is. */
export interface LaunchPlan {
	command: string;
	args: string[];
	/** Merged OVER `process.env` by the transport — and a driver that names a key here wins against an
	 *  inherited value of the same name. That order is load-bearing for Devin: `DEVIN_MODEL` is live in
	 *  some shells, and an inherited value would otherwise override the model of every delegation. */
	env: Record<string, string>;
	/** Names the agent in errors and in the wire log: "devin acp exited with code 42". */
	label: string;
	clientInfo: { name: string; version: string };
	/** `initialize` capabilities. Declaring nothing means the agent offers nothing: `subagents` and the
	 *  gateway auth methods are withheld this way deliberately (see the driver notes). */
	clientCapabilities?: Record<string, unknown>;
	/** ACP protocol version offered in `initialize` (agents may negotiate a draft v2 — see claude). */
	protocolVersion?: number;
}

export interface DriverCapabilities {
	/** false ⇒ `delegate_task` refuses `thinking` for this agent rather than ignoring it. */
	thinking: boolean;
	/**
	 * A recorded session id can be prompted again after its process is gone, **and this engine implements the
	 * way back in** (`reattachSession`: spawn, then prompt the recorded id). An agent that merely advertises
	 * `loadSession` is not enough — the adapter call would have to be made, so such a driver declares false
	 * until there is a loader behind it. `followUp` refuses to continue a session whose driver says false.
	 */
	resume: boolean;

	/**
	 * The canonical `thinking` levels this driver can actually apply. Absent means every level the tool offers.
	 *
	 * Validation without this is a promise the wire may break: an effort the agent does not accept costs a
	 * slot, a spawned session and a warning buried in a tool result, when the answer was known beforehand.
	 */
	thinkingLevels?(): readonly string[];

	/** The sentence this driver says when `thinking` is refused, in its own words about its own models. */
	thinkingRefusal?(): string;
	cancel: boolean;
	/** The agent asks `session/request_permission` and blocks the turn until answered. */
	permissions: boolean;
	plans: boolean;
	/** Who isolates the checkout: the host (Orca/git worktree, before the session starts) or the agent. */
	worktree: "host" | "agent" | "none";
	/** Block the agent's own CLI through bash so delegation cannot bypass the queue. Deliberately true
	 *  only for Devin — see the note in drivers/devin.ts before setting it for anything else. */
	blocksOwnCli: boolean;
	/** The agent's CLI name, when `blocksOwnCli` is true. */
	cli?: string;
}

/** A value set the agent will actually accept. Catalogues drive validation AND tool text. */
export interface Catalogue {
	default: string;
	values: readonly string[];
	/** `reject` hard-fails an unknown value; `warn` accepts it with a line in the result.
	 *  Modes are `reject` (an agent that ignores an unknown mode silently runs something else);
	 *  models are `warn` (Devin's advertised vocabulary omits models its `--model` flag accepts, and
	 *  it resolves fuzzy names). */
	onUnknown: "reject" | "warn";
}

/** Preflight answer: can this agent run here at all, and what should the caller do if not. */
export type DriverHealth = { ok: true; note?: string } | { ok: false; error: string; hint?: string };

/** One `session/update` as it arrived on the wire, before any driver looked at it. */
export interface AcpUpdateFrame {
	sessionId?: string;
	update?: Record<string, unknown>;
	[key: string]: unknown;
}

// ---------------------------------------------------------------- the canonical event set
//
// The single seam a wire format is allowed to touch. Everything downstream — the JSONL transcript,
// the dashboard, the status bar, the stall watchdog, the completion notice — consumes these and
// nothing else, which is why `turn.completed` carries `stopReason` even though the old extension
// threw it away: `max_tokens` is not success.

export interface UsageTotals {
	total?: number;
	input?: number;
	output?: number;
}

/**
 * One update from an agent, after its driver has said what it means.
 *
 * There is deliberately no `session.started` / `turn.completed` / `turn.failed` here: those moments are
 * the engine's own — it created the session, it holds the prompt promise, it knows how the turn ended —
 * and a kind that no mapper can ever emit is a lie waiting to drift. The vocabulary an agent advertises at
 * `session/new` and the stop reason of a turn are recorded where the engine acts on them.
 */
export type DelegateEvent =
	| { kind: "assistant.delta"; text: string }
	| { kind: "assistant.completed"; text: string }
	| { kind: "thought.delta"; text: string }
	| { kind: "tool.started"; toolCallId?: string; title?: string }
	| { kind: "tool.updated"; toolCallId?: string; title?: string; status?: string }
	| { kind: "plan.updated"; entries?: number; done?: number }
	| { kind: "usage.updated"; used?: number; size?: number; tokens: UsageTotals }
	| { kind: "selection.updated"; options: Record<string, string[]> }
	| { kind: "mode.changed"; modeId: string }
	| { kind: "ignored"; reason: string };

/** Normalized `session/prompt` outcome. `unknown` is an honest answer, not a bug: an agent may send a
 *  reason we have never seen, and inventing `end_turn` for it would report a truncation as success. */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" | "error" | "unknown";

// ---------------------------------------------------------------- the driver contract

export interface DriverPermissionPolicy {
	/** Which option answers a decision. The default refuses every option that *widens* what the agent
	 *  may do later (`allow_always`, project/global approvals, "switch to bypass") — that policy is
	 *  Devin's and it applies to every driver, so a driver that cannot honour it says so here. */
	pickOption(options: { optionId: string; name: string; kind: string }[], decision: PermissionDecision): string | undefined;
	/** True when `allow_session` has no equivalent and degrades to a single approval (Claude). The
	 *  tool must then SAY that out loud rather than let the caller believe a durable rule was made. */
	readonly degradesAllowSession?: boolean;
}

/**
 * One agent behind one interface.
 *
 * A driver is **data plus pure-ish functions**; it never owns a process, a timer, a slot or a
 * promise. Every one of those is where the repo's invariants live (slot admission before the first
 * await, the stall watchdog, the dispose that breaks reference chains), and a driver that owned its
 * own lifecycle would make each of them re-auditable once per agent.
 */
export interface AgentDriver {
	readonly id: string;
	/** Human name for notices and the dashboard: "Devin", "Claude". */
	readonly title: string;
	/** Whether the driver is compiled in or declared by a descriptor — surfaced by `/delegate agents`. */
	readonly source: "built-in" | "descriptor";
	capabilities(): DriverCapabilities;
	/** Called before a slot is spent, so a bad `agent` fails fast instead of ten seconds into a spawn. */
	preflight(): Promise<DriverHealth>;
	launchPlan(sel: Selection, cwd: string): LaunchPlan;
	/**
	 * Apply model/thinking after `session/new`, for agents that set them in band. Return the warnings
	 * the tool should surface. Devin returns none: its model is a spawn flag and
	 * `session/set_config_option(model)` answers `-32602` for ids outside its vocabulary.
	 */
	applySelection?(ctx: SelectionContext, sel: Selection): Promise<string[]>;
	/** The wire mode id, or an error naming the ids this agent accepts. */
	resolveMode(mode: string): { ok: true; modeId: string } | { ok: false; error: string };
	/** Model catalogue for validation and tool text. `values` may be empty (unknown), which warns never. */
	models(): Catalogue;
	/** The modes this agent accepts under their canonical names, for the tool description. */
	modes(): Catalogue;
	/** Map one wire `session/update` to zero or more canonical events. */
	mapUpdate(frame: AcpUpdateFrame): DelegateEvent[];
	/**
	 * Read the agent's own session store for the last assistant message of a session whose process died
	 * while pi was down. This is the one place an agent's private on-disk format is allowed to appear:
	 * it answers "did the turn actually finish?" during recovery, when the wire is gone. Absent means
	 * "no such store", and recovery then reports the session as interrupted instead of guessing.
	 */
	backfill?(sessionId: string): Promise<string | null>;
	permission(): DriverPermissionPolicy;
	/** The mode the session starts in when the caller did not ask (descriptors may withhold bypass). */
	defaultMode(): string;
}

/** What a driver may use while applying a selection: the transport, and nowhere else to go. */
export interface SelectionContext {
	sessionId: string;
	cwd: string;
	request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
	/** The config-option vocabulary this session currently advertises, keyed by option id
	 *  (`{model: [...], effort: [...]}`). Empty until a `config_option_update` has arrived. */
	advertisedOptions(): Record<string, string[]>;
}

// ---------------------------------------------------------------- session and queue records

export type SessionStatus = "running" | "stalled" | "idle" | "completed" | "cancelled" | "failed" | "interrupted";
export type WorktreeStatus = "active" | "released" | "retained";

/** The task as admitted: either it starts now or it waits in the FIFO with exactly these fields. */
export interface QueuedTask {
	queueId: string;
	agent: string;
	prompt: string;
	/** Model id as the caller asked for it; undefined means the driver's default. */
	model?: string;
	thinking?: ThinkingLevel;
	mode: string;
	createWorktree: boolean;
	enqueuedAt: number;
	parentSessionId?: string;
	worktreePath?: string;
	worktreeBranch?: string;
	worktreeId?: string;
	parentWorktreeId?: string;
	worktreeStatus?: WorktreeStatus;
}

export interface SessionMeta {
	sessionId: string;
	/**
	 * The session this one was delegated from, when the caller was itself a delegated session.
	 *
	 * Recorded on the session, not only on the queued task that carried it, so a transcript or a status
	 * report can still say whose child this after the queue entry is gone.
	 */
	parentSessionId?: string;
	queueId?: string;
	agent: string;
	prompt: string;
	/**
	 * The model id this session was asked to run, undefined meaning the driver's own default. There is no
	 * second field for "what was requested": nothing rewrites a model any more (Devin's effort is part of the
	 * model id, so `thinking` on a Devin task is refused rather than translated into a different model).
	 */
	model?: string;
	thinking?: ThinkingLevel;
	mode: string;
	createWorktree: boolean;
	worktreePath?: string;
	worktreeBranch?: string;
	worktreeId?: string;
	parentWorktreeId?: string;
	worktreeStatus?: WorktreeStatus;
	prState?: string;
	status: SessionStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	lastMessageTime?: number;
	turnStartedAt?: number;
	turnCompletedAt?: number;
	pid?: number;
	dbBackfilled?: boolean;
	error?: string;
	detectedPrNumber?: number;
	stopReason?: StopReason;
}

export interface PersistedState {
	/** Absent in files written before the rename; recovery does not depend on it. */
	version?: number;
	maxRuns: number;
	maxRunsTotal: number;
	totalInvoked: number;
	totalCompleted: number;
	queue: QueuedTask[];
	sessionIds: string[];
	// Self-describing: the storage directory (pi session id) each session was written to,
	// so recovery does not depend on the current anchor value.
	sessionDirs?: Record<string, string>;
}

// ---------------------------------------------------------------- the engine surface the tools use
//
// Declared here so `tools.ts`, `command.ts` and `queue.ts` can be written against one contract
// without importing the runtime (which would cycle through the session layer).

export interface DelegateHooks {
	/** UI context, captured from whichever call is most recent (every tool passes `ctx.ui`). */
	setUi(ui: ExtensionUIContext): void;
	/** Await before reading or mutating state: detached recovery owns it until it finishes. */
	readonly settled: Promise<void>;
	/** The pi session id the storage directory is anchored to. */
	piSessionId(): string;
	warnPiSessionMismatch(ctx: ExtensionToolContext): void;
	uiContext(): ExtensionUIContext | undefined;
}
