// One ACP session: owns the agy child and the permission gate, maps the stream to
// session/update notifications, and settles each prompt with a stopReason or a JSON-RPC
// error (an error is never end_turn - see turn.ts). A child exit without a `result` marks
// needsRespawn (the next prompt relaunches agy with `--conversation <id>`); a headless
// auto-deny is an end_turn with _meta.deniedActions.
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
import { runTurn, failActiveTools, settleTurn, type PendingTurn } from "./turn.ts";
import { AgyProcess, ZERO_CUMULATIVE, type AgyCumulative, type AgyDriverEvent, type AgyExitInfo } from "./agy-driver.ts";
// Type-only (erased at runtime): the launch options are the server's public API.
import type { AgyLaunchOptions } from "./server.ts";
import {
	agentMessageChunk,
	systemMessageText,
	toolCallCompleted,
	toolCallFailed,
	toolCallIdOf,
	toolCallStarted,
	toolKindOf,
	toolLocationsOf,
	toolTitleOf,
} from "./update-map.ts";

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
	// Public (turn.ts): the turn machinery settles the pending turn and the still-active tools.
	pending: PendingTurn | null = null;
	activeTools = new Set<string>();
	// Sub-issue 54 (cancel) will set this; until it lands it is never true, so a `result ERROR` is always an error.
	cancelRequested = false;
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
		});
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
		this.turn = runTurn(this, text).finally(() => (this.turn = null));
		return this.turn;
	}

	/** Kills the child (if any) and abandons any pending turn; idempotent. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const driver = this.driver;
		this.driver = null;
		this.live = false;
		const pending = this.pending;
		if (pending && !pending.settled) {
			pending.settled = true;
			this.pending = null;
			pending.reject(new Error("session disposed"));
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
			this.live = false;
			await driver.dispose();
			this.driver = null;
			throw new RpcError(INTERNAL_ERROR, `agy failed to ${resume ? "resume" : "start"}: ${(err as Error).message}`, {
				stderrTail: driver.stderrTail,
			});
		}
	}

	private spawnDriver(resume: boolean): AgyProcess {
		const a = this.config;
		return new AgyProcess({
			cwd: this.config.cwd,
			// Child env: configured env plus the bridge trio (socket, token, hook deadline) - the hook dials with these.
			env: {
				...(a.env ?? process.env),
				AGY_ACP_SOCK: this.gate.socketPath,
				AGY_ACP_TOKEN: this.hookToken,
				AGY_ACP_HOOK_DEADLINE_MS: String(this.hookDeadlineMs),
			},
			command: a.command,
			argvPrefix: a.argvPrefix,
			model: a.model,
			effort: a.effort,
			addDirs: [...(a.addDirs ?? []), this.gate.dir],
			// Forced: the bridge hook is the only gate, and a hook cannot override headless
			// auto-deny - the two are a pair. A launch without a bridge must never happen.
			skipPermissions: true,
			conversation: resume ? this.id : undefined,
			previous: this.cumulative,
			probeTimeoutMs: a.probeTimeoutMs,
			graceMs: a.graceMs,
			termMs: a.termMs,
			log: this.config.log,
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
			this.mapStep(e);
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
		const pending = this.pending;
		if (pending && !pending.settled) {
			// A child that dies mid-turn: fail its still-active tools, then error the prompt - never an end_turn.
			failActiveTools(this, "the agy process exited before the turn finished");
			const why = `exit code=${info.code ?? "none"} signal=${info.signal ?? "none"}`;
			pending.settled = true;
			this.pending = null;
			pending.reject(new RpcError(INTERNAL_ERROR, `agy exited without a result (${why})`, { agyError: why, stderrTail: info.stderrTail }));
		}
	}

	private mapStep(e: Extract<AgyDriverEvent, { event: "step_update" }>): void {
		const s = e.step_update;
		if (s.step_type === "agent_response") {
			if (typeof s.text_delta === "string" && s.text_delta !== "") this.emit(agentMessageChunk(s.text_delta));
			return;
		}
		if (s.step_type === "system_message") {
			this.config.log(`session ${this.id}: system_message step ${s.step_index} (${s.state})`);
			this.emit(agentMessageChunk(systemMessageText(s.text_delta)));
			return;
		}
		// A terminal step_update may carry the step's own type (an invoke_subagent DONE arrives as step_type
		// "subagent"), so settling is tracking-based: any tracked id settles, untracked ones (user_input)
		// are ignored. Subagent *internal* steps stay unmapped (sub-issue 59). A state outside the
		// observed set (a newer agy state) keeps the tool tracked: failActiveTools settles it at turn end.
		const id = toolCallIdOf(this.id, s.step_index);
		if (s.state === "ACTIVE") this.mapActiveTool(s, id);
		else if (s.state !== "DONE" && s.state !== "ERROR") return;
		else if (this.activeTools.delete(id)) this.settleTerminalTool(s, id);
	}

	private mapActiveTool(s: Extract<AgyDriverEvent, { event: "step_update" }>["step_update"], id: string): void {
		if (s.step_type !== "tool") return;
		this.activeTools.add(id);
		const name = s.tool_name ?? s.tool_info?.name ?? "tool";
		const parameters = s.tool_info?.parameters;
		// The stream's ACTIVE precedes the PreToolUse hook: the call is created from the stream's
		// parameters; the gate follows with an in_progress update on a rewrite or a pending ask.
		this.gate.onStreamActive(s.step_index, name, parameters);
		const title = toolTitleOf(name, parameters ?? {});
		this.emit(toolCallStarted(id, title, toolKindOf(name), parameters, parameters ? toolLocationsOf(parameters) : undefined));
	}

	private settleTerminalTool(s: Extract<AgyDriverEvent, { event: "step_update" }>["step_update"], id: string): void {
		if (s.state === "DONE") this.emit(toolCallCompleted(id, s.tool_info?.output));
		else if (s.state === "ERROR") this.emit(toolCallFailed(id, s.tool_info?.error?.message ?? "tool failed"));
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
