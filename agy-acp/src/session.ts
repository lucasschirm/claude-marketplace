// One ACP session: owns the agy child and the permission gate, and settles each prompt with a
// stopReason or a JSON-RPC error (an error is never end_turn - see turn.ts; the stream mapping lives
// in map-steps.ts). A child exit without a `result` marks needsRespawn, so the next prompt relaunches
// agy with --conversation <id>; a headless auto-deny is an end_turn carrying _meta.deniedActions.
// Issue #54 is the process lifecycle here: session/cancel (asks denied with the cancel reason, SIGINT,
// then the group ladder), the lazy respawn of a child that died idle, and the heartbeat.
import { INVALID_PARAMS, INTERNAL_ERROR, RpcError } from "./errors.ts";
import { TURN_IN_PROGRESS, type AcpPromptResult, type AcpSessionUpdate } from "./acp.ts";
import { flattenPrompt } from "./prompt.ts";
import {
	DEFAULT_CLIENT_DEADLINE_MS,
	DEFAULT_HOOK_DEADLINE_MS,
	DEFAULT_HOOK_TIMEOUT_SEC,
	newPermissionToken,
	PermissionGate,
} from "./permission-gate.ts";
import { runTurn, failActiveTools, settleCancelled, settleTurn, type PendingTurn } from "./turn.ts";
import { mapStepToUpdates } from "./map-steps.ts";
import { spawnSessionAgy } from "./spawn-agy.ts";
import { TurnHeartbeat } from "./heartbeat.ts";
import { cancelAgy, CANCELLED_TOOL_REASON } from "./cancel.ts";
import { DEFAULT_CANCEL_ESCALATE_MS, DEFAULT_HEARTBEAT_MS } from "./config.ts";
import { ZERO_CUMULATIVE, type AgyProcess, type AgyCumulative, type AgyDriverEvent, type AgyExitInfo } from "./agy-driver.ts";
// Type-only (erased at runtime): the launch options are the server's public API.
import type { AgyLaunchOptions } from "./server.ts";
export interface SessionLaunchConfig extends AgyLaunchOptions {
	cwd: string;
	log: (line: string) => void;
	/** Sends one session/update notification for this session. */
	notify: (sessionId: string, update: AcpSessionUpdate) => void;
	/** Sends one session/request_permission to the client (the session id is added here). */
	requestPermission: (params: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
}

export class AgySession {
	private readonly config: SessionLaunchConfig;
	private driver: AgyProcess | null = null;
	private readonly gate: PermissionGate;
	private readonly hookToken: string;
	private readonly hookDeadlineMs: number;
	private idValue = "";
	private initModelValue = "";
	private live = false;
	private needsRespawnValue = false;
	private disposed = false;
	private cumulative: AgyCumulative = { ...ZERO_CUMULATIVE, usage: { ...ZERO_CUMULATIVE.usage } };
	private turn: Promise<AcpPromptResult> | null = null;
	private readonly heartbeat: TurnHeartbeat;
	// Public (turn.ts, map-steps.ts): the turn machinery settles the pending turn and the still-active tools.
	pending: PendingTurn | null = null;
	activeTools = new Set<string>();
	constructor(config: SessionLaunchConfig) {
		this.config = config;
		this.hookToken = newPermissionToken();
		this.hookDeadlineMs = config.hookDeadlineMs ?? DEFAULT_HOOK_DEADLINE_MS;
		this.gate = new PermissionGate({
			log: config.log,
			notify: (update) => this.emit(update),
			request: (_method, params, timeoutMs) => this.config.requestPermission(params, timeoutMs),
			cwd: config.cwd,
			clientDeadlineMs: config.clientDeadlineMs ?? DEFAULT_CLIENT_DEADLINE_MS,
			hookDeadlineMs: this.hookDeadlineMs,
			hookTimeoutSec: config.hookTimeoutSec ?? DEFAULT_HOOK_TIMEOUT_SEC,
			token: this.hookToken,
			conversationId: () => (this.idValue === "" ? null : this.idValue),
			// Derived, not a flag to keep in step: no prompt in flight means no answer to give.
			currentTurn: () => this.turn,
		});
		this.heartbeat = new TurnHeartbeat((update) => this.emit(update), { pendingPermissions: () => this.gate.pendingAsks() });
	}

	get id(): string {
		return this.idValue;
	}
	/** The model agy's init event reported (the session/new `models` stub). */
	get initModel(): string {
		return this.initModelValue;
	}
	get needsRespawn(): boolean {
		return this.needsRespawnValue;
	}
	/** Spawns agy and probes for the conversation id; a failure disposes the child and throws. */
	async start(): Promise<string> {
		// The bridge comes up before agy: the launch argv and env need its dir, and a session must never launch ungated.
		try {
			await this.gate.start();
		} catch (err) {
			throw new RpcError(INTERNAL_ERROR, `the permission bridge could not start: ${(err as Error).message}`);
		}
		const driver = this.spawnDriver(false);
		this.driver = driver;
		this.live = true;
		this.wire(driver);
		try {
			this.idValue = await driver.probe(this.config.probeTimeoutMs);
			return this.id;
		} catch (err) {
			this.live = false;
			await this.gate.dispose();
			await driver.dispose();
			this.driver = null;
			throw new RpcError(INTERNAL_ERROR, `could not start agy: ${(err as Error).message}`, { stderrTail: driver.stderrTail });
		}
	}

	/** One prompt; the caller must already know the session exists (the registry checks). */
	prompt(blocks: unknown): Promise<AcpPromptResult> {
		if (this.disposed) throw new RpcError(INTERNAL_ERROR, "session is closed");
		const text = flattenPrompt(blocks);
		if (this.turn) throw new RpcError(TURN_IN_PROGRESS, "turn in progress");
		// The beat starts before the child is chosen: a respawn is silence a watchdog must read as waiting.
		this.heartbeat.start(this.config.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
		this.turn = runTurn(this, text).finally(() => {
			this.turn = null;
			this.heartbeat.stop();
		});
		return this.turn;
	}

	/**
	 * session/cancel (issue #54), in the order a client can rely on: deny every pending permission
	 * request with the "cancelled" reason, answer the prompt `cancelled`, then make agy stop - SIGINT,
	 * and for an agy still alive `cancelEscalateMs` later the process-group ladder (SIGTERM, SIGKILL).
	 * The session is marked for a `--conversation` respawn either way; a cancel arriving mid-respawn is
	 * answered too, and that turn never starts.
	 */
	cancel(): void {
		if (this.disposed) return;
		const driver = this.driver;
		if (!this.turn) {
			// Idle between turns: a SIGINT would only kill a healthy child and buy a resume. Nothing is hung.
			this.config.log(`session ${this.id}: session/cancel with no turn in flight - nothing to cancel`);
			return;
		}
		this.needsRespawnValue = true;
		// The asks before anything else: a hook holding a tool call is released with our reason, so the
		// model reads "cancelled" instead of a hook timeout, and the client's dialog closes now.
		this.gate.abortPending("the client cancelled the turn", "cancelled");
		this.gate.onTurnEnd();
		// Then the turn itself, answered now rather than whenever agy gets round to dying: a client
		// that asked to stop is never made to wait out the ladder below (this fails the tools still
		// ACTIVE too, so nothing keeps spinning). Whatever agy sends afterwards is ignored.
		settleCancelled(this, CANCELLED_TOOL_REASON);
		// The SIGINT -> process-group window is AGY_ACP_CANCEL_ESCALATE_MS (default 5 s).
		const escalateMs = this.config.cancelEscalateMs ?? DEFAULT_CANCEL_ESCALATE_MS;
		if (!driver) {
			// Still choosing its child (a respawn); turn.ts puts that child away instead of sending it text.
			this.config.log(`session ${this.id}: cancelling a turn with no child yet - it will not start`);
			return;
		}
		this.config.log(`session ${this.id}: cancelling the turn (SIGINT; group escalation after ${escalateMs} ms)`);
		cancelAgy(driver, escalateMs, (line) => this.config.log(`session ${this.id}: ${line}`));
	}

	/** Kills the child (if any) and settles any pending turn `cancelled`; idempotent. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const driver = this.driver;
		this.driver = null;
		this.live = false;
		this.heartbeat.stop();
		const pending = this.pending;
		if (pending && !pending.settled) {
			// An interruption we caused is a cancellation, not an error (the session/cancel rule); stdin
			// EOF is a half-close, so the client may still be reading what we already settled.
			settleCancelled(this, "the session was disposed");
		}
		if (driver) await driver.dispose();
		await this.gate.dispose(); // denies any pending permission request and removes the bridge dir
	}

	/** The live child, respawning when needed: relaunches agy with `--conversation <id>` and the
	 * last cumulative counters, so usage deltas and the step numbering continue. */
	async ensureDriver(): Promise<AgyProcess> {
		const current = this.driver;
		if (current && this.live && !this.needsRespawn) return current;
		const resume = this.needsRespawn;
		if (current && !current.exited) {
			// The child we are replacing is still dying (a cancel escalates asynchronously and the next
			// prompt can arrive first). Awaiting the driver's bounded ladder is what keeps a session
			// from ending up with a child nobody owns any more.
			this.config.log(`session ${this.id}: waiting for the dying agy child before respawning`);
			this.driver = null;
			this.live = false;
			await current.dispose();
		}
		const driver = this.spawnDriver(resume);
		this.driver = driver;
		this.live = true;
		this.wire(driver);
		this.config.log(`session ${this.id}: ${resume ? `respawning agy with --conversation ${this.id}` : "spawning agy"}`);
		try {
			const probed = await driver.probe(this.config.probeTimeoutMs);
			// A resume that starts a fresh conversation would produce negative usage deltas (the driver was
			// seeded with the last cumulative state). Refuse; needsRespawn survives, so retry on the next prompt.
			if (resume && probed !== this.id) throw new Error(`agy started a new conversation (${probed}) instead of resuming ${this.id}`);
			this.needsRespawnValue = false;
			return driver;
		} catch (err) {
			// Unown the child before waiting for it to die: its exit must not answer the prompt instead of this error.
			this.live = false;
			this.driver = null;
			await driver.dispose();
			throw new RpcError(INTERNAL_ERROR, `agy failed to ${resume ? "resume" : "start"}: ${(err as Error).message}`, {
				stderrTail: driver.stderrTail,
			});
		}
	}

	/** The child for one launch (first start or `--conversation` respawn); see spawn-agy.ts. */
	private spawnDriver(resume: boolean): AgyProcess {
		return spawnSessionAgy({
			config: this.config,
			bridge: { socketPath: this.gate.socketPath, dir: this.gate.dir },
			hookToken: this.hookToken,
			hookDeadlineMs: this.hookDeadlineMs,
			resume,
			conversationId: this.id,
			previous: this.cumulative,
		});
	}

	private wire(driver: AgyProcess): void {
		driver.on("event", (e: AgyDriverEvent) => this.onEvent(driver, e));
		driver.on("exit", (info: AgyExitInfo) => this.onExit(driver, info));
	}

	private onEvent(driver: AgyProcess, e: AgyDriverEvent): void {
		if (e.event === "init") {
			this.initModelValue = e.init.model;
			// First start: this.id is still empty (the probe sets it); a mismatch can only exist on a respawned driver - the one to log.
			if (this.id !== "" && e.conversation_id !== this.id)
				this.config.log(`session ${this.id}: init id ${e.conversation_id} differs from ${this.id}`);
			return;
		}
		if (e.event === "step_update") {
			if (!this.pending) {
				this.config.log(`session ${this.id}: step_update outside a turn (step ${e.step_update.step_index}) - ignored`);
				return;
			}
			// The stream mapping lives in map-steps.ts (the session owns the lifecycle, not the mapping).
			mapStepToUpdates(
				{ activeTools: this.activeTools, conversationId: this.id, log: this.config.log, emit: (u) => this.emit(u), gate: this.gate },
				e.step_update,
			);
			return;
		}
		// result: the turn's terminal event; the raw cumulative state is kept for a respawn.
		this.cumulative = e.result.cumulative;
		settleTurn(this, e, driver);
		this.gate.onTurnEnd();
	}

	private onExit(driver: AgyProcess, info: AgyExitInfo): void {
		if (driver !== this.driver) return; // a superseded child after a respawn
		if (!this.disposed) {
			this.live = false;
			this.needsRespawnValue = true;
			this.gate.abortPending("the agy process exited"); // the hook died with the group
			this.gate.onTurnEnd();
			this.config.log(
				`session ${this.id}: agy exited (code=${info.code ?? "none"} signal=${info.signal ?? "none"}) - the next prompt respawns`,
			);
		}
		// A cancel settled the turn when it was asked, so a cancelled child exiting is the expected
		// ending here and reaches nothing below.
		const pending = this.pending;
		if (pending && !pending.settled) {
			// A child that dies on its own mid-turn: fail its still-active tools, then error the prompt.
			failActiveTools(this, "the agy process exited before the turn finished");
			const why = `exit code=${info.code ?? "none"} signal=${info.signal ?? "none"}`;
			pending.settled = true;
			this.pending = null;
			pending.reject(new RpcError(INTERNAL_ERROR, `agy exited without a result (${why})`, { agyError: why, stderrTail: info.stderrTail }));
		}
	}

	/** The session/update emitter (public: turn.ts settles turns through the session). */
	emit(update: AcpSessionUpdate): void {
		try {
			this.config.notify(this.id, update);
		} catch (err) {
			this.config.log(`session ${this.id}: session/update failed: ${(err as Error).message}`);
		}
	}

	/** The session/set_mode handler (the agy-level mode wiring lands in sub-issue 6). */
	setMode(modeId: string): void {
		try {
			this.gate.setMode(modeId);
		} catch (err) {
			throw new RpcError(INVALID_PARAMS, (err as Error).message);
		}
		// The agent notifies the mode change (ACP: current_mode_update); the caller knows, but
		// other listeners of the update stream do not.
		this.emit({ sessionUpdate: "current_mode_update", currentModeId: modeId });
	}
}
