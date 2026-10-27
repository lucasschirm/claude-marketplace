// One ACP session: owns the agy child process for one conversation, maps its stream to
// session/update notifications, and settles each session/prompt with a stopReason or a
// JSON-RPC error.
//
// The guarantee this sub-issue is named for: an error is never reported as end_turn. A
// `result` ERROR and a child exit without a `result` are -32603 errors (the latter marks
// the session needsRespawn, so the next prompt relaunches agy with `--conversation <id>`);
// a headless auto-deny is an end_turn, but the denied actions go out as a notice before
// the response and ride in _meta.deniedActions. Tool steps still ACTIVE when the turn
// ends are reported failed, so a client never shows a tool running forever.

import { INTERNAL_ERROR, RpcError } from "./errors.ts";
import { TURN_IN_PROGRESS, type AcpPromptResult, type AcpSessionUpdate } from "./acp.ts";
import { flattenPrompt } from "./prompt.ts";
import { AgyProcess, ZERO_CUMULATIVE, type AgyCumulative, type AgyDriverEvent, type AgyExitInfo } from "./agy-driver.ts";
// Type-only (erased at runtime): the launch options are the server's public API.
import type { AgyLaunchOptions } from "./server.ts";
import {
	agentMessageChunk,
	deniedActionsNotice,
	systemMessageText,
	toolCallCompleted,
	toolCallFailed,
	toolCallIdOf,
	toolCallStarted,
	toolKindOf,
	toolLocationsOf,
	toolTitleOf,
	usageUpdate,
} from "./update-map.ts";
export interface SessionLaunchConfig extends AgyLaunchOptions {
	cwd: string;
	log: (line: string) => void;
	/** Sends one session/update notification for this session. */
	notify: (sessionId: string, update: AcpSessionUpdate) => void;
}

export class AgySession {
	private readonly config: SessionLaunchConfig;
	private driver: AgyProcess | null = null;
	private idValue = "";
	private initModelValue = "";
	private live = false;
	private needsRespawnValue = false;
	private disposed = false;
	private cumulative: AgyCumulative = { ...ZERO_CUMULATIVE, usage: { ...ZERO_CUMULATIVE.usage } };
	private turn: Promise<AcpPromptResult> | null = null;
	private pending: { resolve: (result: AcpPromptResult) => void; reject: (error: Error) => void; settled: boolean } | null = null;
	private activeTools = new Set<string>();
	// Sub-issue 54 (cancel) will set this; until it lands it is never true, so a `result ERROR` is always an error.
	private cancelRequested = false;
	constructor(config: SessionLaunchConfig) {
		this.config = config;
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
		const driver = this.spawnDriver(false);
		this.driver = driver;
		this.live = true;
		this.wire(driver);
		try {
			this.idValue = await driver.probe(this.config.probeTimeoutMs);
			return this.id;
		} catch (err) {
			this.live = false;
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
		this.turn = this.runTurn(text).finally(() => (this.turn = null));
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
	}

	private async runTurn(text: string): Promise<AcpPromptResult> {
		const driver = await this.ensureDriver();
		const promise = new Promise<AcpPromptResult>((resolve, reject) => (this.pending = { resolve, reject, settled: false }));
		this.activeTools.clear();
		try {
			driver.send(text);
		} catch (err) {
			const pending = this.pending;
			if (pending && !pending.settled) {
				pending.settled = true;
				this.pending = null;
				pending.reject(new RpcError(INTERNAL_ERROR, `cannot send to agy: ${(err as Error).message}`));
			}
		}
		return promise;
	}

	/**
	 * The live child, respawning when needed: a needsRespawn session relaunches agy with
	 * `--conversation <id>` and the last reported cumulative counters, so usage deltas and the
	 * step numbering continue the conversation.
	 */
	private async ensureDriver(): Promise<AgyProcess> {
		const current = this.driver;
		if (current && this.live && !this.needsRespawn) return current;
		const resume = this.needsRespawn;
		const driver = this.spawnDriver(resume);
		this.driver = driver;
		this.live = true;
		this.wire(driver);
		this.config.log(`session ${this.id}: ${resume ? `respawning agy with --conversation ${this.id}` : "spawning agy"}`);
		try {
			await driver.probe(this.config.probeTimeoutMs);
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
			env: a.env ?? process.env,
			command: a.command,
			argvPrefix: a.argvPrefix,
			model: a.model,
			effort: a.effort,
			addDirs: a.addDirs,
			skipPermissions: a.skipPermissions,
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
			if (e.conversation_id !== this.id) this.config.log(`session ${this.id}: init id ${e.conversation_id} differs from ${this.id}`);
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
		this.settleTurn(e, driver);
	}

	private onExit(driver: AgyProcess, info: AgyExitInfo): void {
		if (driver !== this.driver) return; // a superseded child after a respawn
		if (!this.disposed) {
			this.live = false;
			this.needsRespawnValue = true;
			this.config.log(
				`session ${this.id}: agy exited (code=${info.code ?? "none"} signal=${info.signal ?? "none"}) - the next prompt respawns`,
			);
		}
		const pending = this.pending;
		if (pending && !pending.settled) {
			// A child that dies mid-turn leaves the turn unsettled: fail its still-active tools,
			// then answer the prompt with an error - never an end_turn.
			this.failActiveTools("the agy process exited before the turn finished");
			const why = `exit code=${info.code ?? "none"} signal=${info.signal ?? "none"}`;
			pending.settled = true;
			this.pending = null;
			pending.reject(new RpcError(INTERNAL_ERROR, `agy exited without a result (${why})`, { agyError: why, stderrTail: info.stderrTail }));
		}
	}

	private settleTurn(e: Extract<AgyDriverEvent, { event: "result" }>, driver: AgyProcess): void {
		const pending = this.pending;
		if (!pending) return;
		pending.settled = true;
		this.pending = null;
		// A tool still ACTIVE when the turn ends is reported failed, so a client never shows
		// a tool running forever.
		this.failActiveTools("the turn ended before the tool reported a terminal state");
		const denied = e.result.denied_actions;
		// The driver already turned agy's cumulative counters into per-turn deltas (no double counting across turns).
		if (e.result.status === "SUCCESS") {
			this.emit(usageUpdate(e.result.usage, e.result.num_turns, e.result.duration_seconds));
			const meta: NonNullable<AcpPromptResult["_meta"]> = {
				usage: e.result.usage,
				numTurns: e.result.num_turns,
				durationSeconds: e.result.duration_seconds,
			};
			if (denied && denied.length > 0) {
				// The notice goes out before the response: a headless auto-deny is never a
				// silent end_turn.
				this.emit(agentMessageChunk(deniedActionsNotice(denied)));
				meta.deniedActions = denied;
			}
			pending.resolve({ stopReason: "end_turn", _meta: meta });
		} else if (this.cancelRequested && (e.result.error === "interrupted" || e.result.error === "cancelled")) {
			// Sub-issue 54: an interruption we caused is a cancellation, not an error.
			pending.resolve({ stopReason: "cancelled" });
		} else {
			pending.reject(
				new RpcError(INTERNAL_ERROR, `agy turn failed: ${e.result.error ?? "unknown error"}`, {
					agyError: e.result.error ?? "unknown error",
					stderrTail: driver.stderrTail,
				}),
			);
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
		if (s.step_type !== "tool") return; // user_input, subagent (sub-issue 59): logged by the caller's record, not mapped
		const id = toolCallIdOf(this.id, s.step_index);
		if (s.state === "ACTIVE") {
			this.activeTools.add(id);
			const name = s.tool_name ?? s.tool_info?.name ?? "tool";
			const parameters = s.tool_info?.parameters;
			const title = toolTitleOf(name, parameters ?? {});
			this.emit(toolCallStarted(id, title, toolKindOf(name), parameters, parameters ? toolLocationsOf(parameters) : undefined));
		} else if (s.state === "DONE") {
			this.activeTools.delete(id);
			this.emit(toolCallCompleted(id, s.tool_info?.output));
		} else if (s.state === "ERROR") {
			this.activeTools.delete(id);
			this.emit(toolCallFailed(id, s.tool_info?.error?.message ?? "tool failed"));
		}
	}

	private failActiveTools(message: string): void {
		for (const id of this.activeTools) this.emit(toolCallFailed(id, message));
		this.activeTools.clear();
	}

	private emit(update: AcpSessionUpdate): void {
		try {
			this.config.notify(this.id, update);
		} catch (err) {
			this.config.log(`session ${this.id}: session/update failed: ${(err as Error).message}`);
		}
	}
}
