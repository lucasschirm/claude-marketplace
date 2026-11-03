// The session's selection state: mode, model and effort - and the ACP shapes that advertise them
// (issue #55).
//
// ACP v1 gives a client two surfaces. Modes are first-class: `modes` in session/new,
// `session/set_mode`, the `current_mode_update` update. Anything else the client may pick is a
// `configOptions` selector - `{id, name, category, type: "select", currentValue, options}` - set with
// `session/set_config_option` and pushed back as `config_option_update`. agy's model list has no ACP
// field of its own, so its ids go in two places: the `models` block agy-acp has published since
// sub-issue 3 (ids only) and the `model` selector, which is where the display names live.
//
// The state lives here rather than in session.ts because all three selections share one rule: they
// are agy *launch* flags, so a change cannot reach the process that is already running. `launchKey()`
// is how the session notices that: the same key means the live child still says what we believe, a
// different key means the next turn relaunches it with `--conversation <id>` and the new flags.
//
// `bypass` is the one mode that is not always offered: it allows everything the bridge would ask
// about, so advertising it by default would let an unattended delegate shop its way out of every
// permission prompt. The operator enables it (AGY_ACP_ALLOW_BYPASS=1) when that is the intent.

import type { AcpSessionMode } from "./acp.ts";
import { AGY_ACP_MODES, type AcpModeInfo } from "./permission.ts";
import { AGY_DEFAULT_CHOICE, AGY_EFFORTS, effortConflict, isEffort, modelEffort, type AgyModel } from "./agy/models.ts";

// ---------------------------------------------------------------- the ACP wire shapes of a selector

/** One choice in a `select`: the value the client sends back, and the label to show it. */
export interface AcpConfigOptionChoice {
	value: string;
	name: string;
	description?: string;
}

/** A session configuration selector (ACP `SessionConfigOption` with `type: "select"`). */
export interface AcpConfigOption {
	id: string;
	name: string;
	description?: string;
	/** `mode` | `model` | `thought_level` | anything else; UX only, never load-bearing. */
	category?: string;
	type: "select";
	currentValue: string;
	options: AcpConfigOptionChoice[];
}

/** The session/update that pushes the whole selector set after a change (ACP `ConfigOptionUpdate`). */
export interface AcpConfigOptionUpdate {
	sessionUpdate: "config_option_update";
	configOptions: AcpConfigOption[];
}

/** The mode a session starts in, and the sentinel every selector offers for "no flag". */
export const DEFAULT_MODE_ID = "default";
export { AGY_DEFAULT_CHOICE };

/** The mode ids `agy --mode` accepts (agy 1.4.2 help: `accept-edits, auto, plan`). */
const AGY_MODE_FLAGS: Readonly<Record<string, string>> = { "accept-edits": "accept-edits", plan: "plan" };

/**
 * The modes a session may be put into, and the client may be offered: the four documented modes,
 * minus `bypass` unless the operator enabled it.
 */
export function offeredModes(allowBypass: boolean): AcpModeInfo[] {
	return allowBypass ? AGY_ACP_MODES : AGY_ACP_MODES.filter((m) => m.id !== "bypass");
}

/**
 * The `--mode` value matching an agy-acp mode, or `undefined` for "pass no flag".
 *
 * The flag is a hint, never a gate. agy 1.4.2 accepts it headless, and `init` still reports
 * `permission_mode: "request-review"` under `--mode plan` (`always-proceed` only once
 * `--dangerously-skip-permissions` is on, which agy-acp forces for its own hook). So the bridge
 * policy is what enforces a mode, and the flag's job is to stop the model *trying* to mutate state
 * in plan mode. `auto` is deliberately unmapped: it is account-gated (agy prints "Auto mode is not
 * available for this account") and auto-approval is the bridge's decision, not the model's.
 * `default` and `bypass` have no agy counterpart either - the first is what agy does with no flag,
 * the second is already `--dangerously-skip-permissions`.
 */
export function agyModeFlag(modeId: string): string | undefined {
	return AGY_MODE_FLAGS[modeId];
}

/** The flag-level view of a session: what its next agy process must be launched with. */
export interface LaunchFlags {
	model?: string;
	effort?: string;
	mode?: string;
	sandbox?: boolean;
}

/** Where the selections start: the operator's launch options, plus the server-wide gates. */
export interface SelectionState {
	model?: string;
	effort?: string;
	sandbox: boolean;
	allowBypass: boolean;
}

/**
 * What one session is set to run with. Every setter validates and throws an `Error` whose message is
 * written for the client: an unknown value names the values that are not unknown. The session turns
 * that into a `-32602`.
 */
export class SessionSelection {
	readonly sandbox: boolean;
	readonly allowBypass: boolean;
	private modeId = DEFAULT_MODE_ID;
	private modelId: string;
	private effortId: string;
	/** The model agy's `init` reported for the live child ("" until it answers - and always, if we
	 * passed no `--model`: agy 1.4.2 only reports the model it was given one of). */
	private reported = "";

	/**
	 * The starting point comes from the operator (AGY_ACP_MODEL / AGY_ACP_EFFORT and their flags), and it
	 * goes through the same two rules a client's pick does. A typo there would otherwise surface as agy
	 * refusing to start - on every session/new, with a message about a process the client cannot fix.
	 * Model *ids* are not checked here: the list is the catalogue's business (agy/models.ts) and the
	 * session layer has it when it builds the session.
	 */
	constructor(state: SelectionState) {
		this.modelId = state.model ?? AGY_DEFAULT_CHOICE;
		this.effortId = state.effort ?? AGY_DEFAULT_CHOICE;
		this.sandbox = state.sandbox;
		this.allowBypass = state.allowBypass;
		if (!isEffort(this.effortId)) {
			throw new Error(`unknown effort: ${this.effortId} (available: ${AGY_DEFAULT_CHOICE}, ${AGY_EFFORTS.join(", ")})`);
		}
		const clash = effortConflict(this.modelId, this.effortId);
		if (clash !== null) throw new Error(`${clash} (the model and effort this server was started with)`);
	}

	get mode(): string {
		return this.modeId;
	}
	/** The current model as a client sees it: the selection, or what agy says it is running. */
	get model(): string {
		return this.modelId === AGY_DEFAULT_CHOICE ? this.reported || AGY_DEFAULT_CHOICE : this.modelId;
	}
	get effort(): string {
		return this.effortId;
	}
	setReportedModel(modelId: string): void {
		this.reported = modelId;
	}

	modes(): { currentModeId: string; availableModes: AcpSessionMode[] } {
		return { currentModeId: this.modeId, availableModes: offeredModes(this.allowBypass) };
	}

	/**
	 * The ids `set_model` accepts: everything agy listed, plus what this session is actually running.
	 * The two extras are the ids no listing carried - the model an `init` reported, and a pick accepted
	 * while the listing was failing - and without them the selector would show a `currentValue` a client
	 * could not choose, which is the one thing a dropdown cannot recover from.
	 */
	knownModels(models: AgyModel[] | null): string[] {
		const ids = models ? models.map((m) => m.modelId) : [];
		for (const own of [this.reported, this.modelId]) {
			if (own !== "" && own !== AGY_DEFAULT_CHOICE && !ids.includes(own)) ids.push(own);
		}
		return ids;
	}

	setMode(modeId: string): void {
		const offered = offeredModes(this.allowBypass);
		if (!offered.some((m) => m.id === modeId)) {
			const hint = modeId === "bypass" ? " - bypass is off: start agy-acp with AGY_ACP_ALLOW_BYPASS=1 to offer it" : "";
			throw new Error(`unknown mode: ${modeId} (available: ${offered.map((m) => m.id).join(", ")})${hint}`);
		}
		this.modeId = modeId;
	}

	/**
	 * A model id, or `default` for "no `--model` flag, whatever agy picks". `known` is the list agy
	 * gave us; `null` means the listing failed, nothing can be checked here, and the id goes through
	 * for agy to judge at startup - its refusal names every available model (the `bad-model-id`
	 * fixture), and the session reports that as a startup error rather than inventing a verdict.
	 */
	setModel(modelId: string, known: AgyModel[] | null): void {
		if (modelId === "") throw new Error("modelId must not be empty");
		if (known !== null) {
			const ids = this.knownModels(known);
			if (modelId !== AGY_DEFAULT_CHOICE && !ids.includes(modelId)) {
				throw new Error(`unknown model: ${modelId} (available: ${[AGY_DEFAULT_CHOICE, ...ids].join(", ")})`);
			}
		}
		const clash = effortConflict(modelId, this.effortId);
		if (clash !== null) {
			throw new Error(`${clash} - set the effort to ${AGY_DEFAULT_CHOICE} or to ${modelEffort(modelId) ?? "the model's own"}`);
		}
		this.modelId = modelId;
	}

	setEffort(effort: string): void {
		if (!isEffort(effort)) {
			throw new Error(`unknown effort: ${effort} (available: ${AGY_DEFAULT_CHOICE}, ${AGY_EFFORTS.join(", ")})`);
		}
		const clash = effortConflict(this.modelId, effort);
		if (clash !== null) throw new Error(`${clash} - set the model to ${AGY_DEFAULT_CHOICE} first`);
		this.effortId = effort;
	}

	/** The flags for the next agy process; a sentinel selection simply passes nothing. */
	flags(): LaunchFlags {
		return {
			model: this.modelId === AGY_DEFAULT_CHOICE ? undefined : this.modelId,
			effort: this.effortId === AGY_DEFAULT_CHOICE ? undefined : this.effortId,
			mode: agyModeFlag(this.modeId),
			sandbox: this.sandbox,
		};
	}

	/**
	 * The signature of the flags that need a new process; `ensureDriver`'s question to the live child.
	 *
	 * Model and effort are in it because they are exec-time arguments. Mode is in it because a `--mode`
	 * flag already on a child cannot be taken back: a session that respawned while `plan` was set would
	 * otherwise keep an agy that self-censors mutations after the client moved it back to `default`, and
	 * stopping the model *trying* is that flag's whole job - the bridge would have allowed the call, and
	 * it would never arrive. Keeping mode out saved a respawn and bought a session advertising one mode
	 * while its child behaved as another, with nothing to converge them; the bridge still applies a mode
	 * the moment it is set, so what the respawn buys is that the child agrees by the next turn.
	 */
	relaunchKey(): string {
		const f = this.flags();
		return JSON.stringify([f.model ?? "", f.effort ?? "", f.mode ?? "", f.sandbox === true]);
	}

	/** The `configOptions` selectors (ACP): the model list with its names, and the effort levels. */
	configOptions(models: AgyModel[] | null): AcpConfigOption[] {
		const ids = this.knownModels(models);
		const named = new Map((models ?? []).map((m) => [m.modelId, m.name]));
		const modelChoices: AcpConfigOptionChoice[] = [
			{ value: AGY_DEFAULT_CHOICE, name: "agy default", description: "No --model flag: whatever agy chooses when given none" },
			...ids.map((id) => ({ value: id, name: named.get(id) ?? id })),
		];
		return [
			{
				id: "model",
				name: "Model",
				description: "The model the next agy process runs (a change respawns the child)",
				category: "model",
				type: "select",
				currentValue: this.model,
				options: modelChoices,
			},
			{
				id: "effort",
				name: "Effort",
				description: "Reasoning level for the next agy process (agy judges the pair it is given with the model)",
				category: "thought_level",
				type: "select",
				currentValue: this.effort,
				options: [AGY_DEFAULT_CHOICE, ...AGY_EFFORTS].map((value) => ({
					value,
					name: value === AGY_DEFAULT_CHOICE ? "agy default" : `${value[0].toUpperCase()}${value.slice(1)}`,
				})),
			},
		];
	}
}
