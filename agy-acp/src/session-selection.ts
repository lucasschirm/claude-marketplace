// What a client may change about a session - its mode, its model, its effort - and what each change
// costs. Kept apart from AgySession itself because the rules are the interesting part and are all
// about the selection, not about turns: the mode is enforced by the bridge right now, so a change
// answers immediately whatever the child does next, and all three are `agy` startup arguments, so a
// change marks the live child stale and the next prompt respawns it with `--conversation` (issue #55).
//
// Every setter validates and throws RpcError(-32602): the caller is a JSON-RPC method, and "unknown
// model" is the client's mistake to hear about, not ours.

import { INVALID_PARAMS, RpcError } from "./errors.ts";
import type { AcpSessionUpdate } from "./acp.ts";
import type { AcpConfigOption, AcpConfigOptionUpdate } from "./config-options.ts";
import type { ModelCatalog } from "./agy/models.ts";
import { AGY_DEFAULT_CHOICE, type SessionSelection } from "./config-options.ts";
import type { SelectionRecord } from "./selection-record.ts";

export interface SelectionCommandsConfig {
	/** The session's own selection; this class never replaces it, only changes it. */
	selection: SessionSelection;
	/** The per-process `agy models` list; without it no id here can be checked (see agy/models.ts). */
	catalog?: ModelCatalog;
	/** The session's emitter, so the notification carries the session id. */
	emit: (update: AcpSessionUpdate) => void;
	/** The bridge policy follows the mode immediately, mid-turn included. */
	onModeChange: (modeId: string) => void;
}

export class SelectionCommands {
	private readonly selection: SessionSelection;
	private readonly catalog?: ModelCatalog;
	private readonly emit: (update: AcpSessionUpdate) => void;
	private readonly onModeChange: (modeId: string) => void;

	constructor(config: SelectionCommandsConfig) {
		this.selection = config.selection;
		this.catalog = config.catalog;
		this.emit = config.emit;
		this.onModeChange = config.onModeChange;
	}

	/** The selection that decides what the next child is launched with. */
	relaunchKey(): string {
		return this.selection.relaunchKey();
	}

	/**
	 * What the session is set to launch with, in the shape the store keeps (issue #56): `default` means
	 * "pass no flag". The launch triple rather than what agy's `init` reported, for the reason in
	 * selection-record.ts - a record must say what to do next, not what somebody said last time.
	 */
	record(): SelectionRecord {
		const f = this.selection.flags();
		return { mode: this.selection.mode, model: f.model ?? AGY_DEFAULT_CHOICE, effort: f.effort ?? AGY_DEFAULT_CHOICE };
	}

	/** The `agy` arguments this selection produces, for the next spawn. */
	flags() {
		return this.selection.flags();
	}

	/**
	 * The model the running child reported in its `init`. An `init` with no model says nothing, so it
	 * changes nothing: the value already held (a pick, or an earlier report) is what a client sees.
	 */
	setReportedModel(model: string | undefined): void {
		if (typeof model === "string" && model !== "") this.selection.setReportedModel(model);
	}

	/** The session/new `modes` block: the current mode and the ones this session may be put into. */
	modes() {
		return this.selection.modes();
	}

	/** The session/new `configOptions`: ACP selectors for the model list and the effort levels. */
	configOptions(): AcpConfigOption[] {
		return this.selection.configOptions(this.catalog?.snapshot() ?? null);
	}

	/**
	 * The `models` block, kept for the clients that read ids without a display name. Whatever it names as
	 * current is one of the values it lists - `default` included, since setting `default` is how a client
	 * asks for no `--model` flag. A block whose current value is unselectable is a control that cannot be
	 * redrawn from its own data.
	 */
	modelsState(): { currentModelId: string; availableModels: string[] } {
		const current = this.selection.model;
		const ids = this.selection.knownModels(this.catalog?.snapshot() ?? null);
		return { currentModelId: current, availableModels: ids.includes(current) ? ids : [current, ...ids] };
	}

	/**
	 * session/set_mode. The bridge policy changes immediately (the next permission decision is made
	 * under the new mode, even mid-turn); the `--mode` flag is a launch argument, so a child that was
	 * started in another mode is not kept to argue about it.
	 */
	setMode(modeId: string): void {
		try {
			this.selection.setMode(modeId); // the id and the bypass gate, in one place
			this.onModeChange(modeId);
		} catch (err) {
			throw new RpcError(INVALID_PARAMS, (err as Error).message);
		}
		// The agent notifies the mode change (ACP: current_mode_update); the caller knows, but
		// other listeners of the update stream do not.
		this.emit({ sessionUpdate: "current_mode_update", currentModeId: modeId });
	}

	/**
	 * session/set_model, and the `model` config option. Validated against `agy models` when we have it;
	 * with no list nothing here can judge the id, so it goes through and agy's startup refusal (which
	 * names every available model) is the verdict. Takes effect on the next turn.
	 */
	async setModel(modelId: string): Promise<void> {
		const known = (await this.catalog?.list()) ?? null;
		try {
			this.selection.setModel(modelId, known);
		} catch (err) {
			const ids = this.selection.knownModels(known);
			throw new RpcError(INVALID_PARAMS, (err as Error).message, {
				availableModels: ids.includes(AGY_DEFAULT_CHOICE) ? ids : [AGY_DEFAULT_CHOICE, ...ids],
			});
		}
		this.emitConfigOptions();
	}

	/** session/set_config_option(effort): one of agy's levels, or `default` for "pass no flag". */
	setEffort(effort: string): void {
		try {
			this.selection.setEffort(effort);
		} catch (err) {
			throw new RpcError(INVALID_PARAMS, (err as Error).message);
		}
		this.emitConfigOptions();
	}

	/** The ACP way to push a selector: the notification carries the whole set, not the diff. */
	emitConfigOptions(): void {
		const update: AcpConfigOptionUpdate = { sessionUpdate: "config_option_update", configOptions: this.configOptions() };
		this.emit(update);
	}
}
