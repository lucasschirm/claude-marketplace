// The driver registry: which agents exist, what the tool says about them, and whether a request is
// admissible — all three derived from the same source so they cannot disagree.
//
// The tool descriptions used to be hand-written sentences that hardcoded Devin's model default and
// mode vocabulary. Those sentences drifted the moment a second agent was added (and `MODE_DESCRIPTION`
// had already drifted once with only one). Generating them from the registry is the mechanism that
// keeps them honest; `/delegate agents` is the same data for a human.
//
// Validation order is fixed and every check runs **before a slot is reserved**: a bad `agent` or an
// unsupported `thinking` must not occupy one of the two slots for the seconds a preflight subprocess
// takes.

import { CANONICAL_MODES, type ModeResolution } from "./permissions.ts";
import type { AgentDriver, Selection, ThinkingLevel } from "./types.ts";
import { THINKING_LEVELS } from "./types.ts";
import { devinDriver } from "./drivers/devin.ts";
import { claudeDriver } from "./drivers/claude.ts";

/** The agent used when the caller does not name one. One release of this default, then reconsider. */
export const DEFAULT_AGENT = "devin";

const DRIVERS: Record<string, AgentDriver> = {
	devin: devinDriver,
	claude: claudeDriver,
};

/**
 * The agent's own name for itself — `Devin`, `Claude` — for anything a human or a model reads.
 *
 * An id is for maps, a title is for sentences. A reply that says "devin has no way to continue" reads like
 * a different tool from the one that said "Devin" two lines earlier, and falling back to the id is always
 * better than throwing over a name.
 */
export function agentTitle(agentId?: string): string {
	if (!agentId) {
		return "agent";
	}
	const found = findAgent(agentId);
	return found.ok ? found.driver.title : agentId;
}

export function listDrivers(): AgentDriver[] {
	return Object.values(DRIVERS);
}

export type AgentLookup = { ok: true; driver: AgentDriver } | { ok: false; error: string };

/** An unknown agent names every agent it could have meant, with its health status left to preflight. */
export function findAgent(agent?: string): AgentLookup {
	if (agent === undefined || agent === null || String(agent).trim() === "") {
		return { ok: true, driver: DRIVERS[DEFAULT_AGENT] };
	}
	const key = String(agent).trim().toLowerCase();
	const driver = DRIVERS[key];
	if (driver) {
		return { ok: true, driver };
	}
	return {
		ok: false,
		error: `Unknown agent '${agent}'. Available: ${listDrivers()
			.map((d) => d.id)
			.join(", ")}.`,
	};
}

// ---------------------------------------------------------------- generated tool text

export function agentDescription(): string {
	const parts = listDrivers().map(
		(d) => `${d.id}${d.id === DEFAULT_AGENT ? " (default)" : ""}: ${d.title} via ${d.launchPlan({ mode: "" }, "").label}`,
	);
	return `Which agent to delegate to. ${parts.join(". ")}.`;
}

/** The mode sentence, over the union of driver vocabularies and each driver's default. */
export function modeDescription(): string {
	return (
		`Permission mode: ${CANONICAL_MODES.join(", ")} (default: dangerous). ` +
		"dangerous approves every tool call the agent would otherwise ask about; smart approves what the agent judges safe; " +
		"accept-edits, plan and ask restrict it further. In every mode but dangerous the agent may ask permission and its turn " +
		"blocks until you answer with delegate_permission. Each driver maps these names to its own wire ids, and a mode the " +
		"agent cannot honour is refused rather than silently substituted."
	);
}

export function thinkingDescription(): string {
	const supporting = listDrivers()
		.filter((d) => d.capabilities().thinking)
		.map((d) => d.id);
	const refusing = listDrivers().filter((d) => !d.capabilities().thinking);
	// Each refusing driver says why in its own words. The engine used to speak for all of them with Devin's
	// sentence, which told a future third agent to go change its `swe-2-high` model id.
	const tail = refusing.length
		? ` Refused for: ${refusing.map((d) => `${d.id} (${d.capabilities().thinkingRefusal?.() ?? "no reasoning-effort control"})`).join("; ")}.`
		: "";
	const levels = supportedLevels();
	return `Reasoning effort: ${THINKING_LEVELS.join(", ")}. Supported by: ${supporting.join(", ") || "no agent"}.${levels}${tail}`;
}

/** The levels at least one registered driver can apply — the honest intersection of "valid" and "usable". */
function supportedLevels(): string {
	const usable = new Set<string>();
	for (const d of listDrivers()) {
		if (d.capabilities().thinking) {
			for (const level of d.capabilities().thinkingLevels?.() ?? THINKING_LEVELS) {
				usable.add(level);
			}
		}
	}
	const missing = THINKING_LEVELS.filter((l) => !usable.has(l));
	return missing.length ? ` No registered agent applies: ${missing.join(", ")}.` : "";
}

/** Model sentence, per driver, from each driver's own catalogue. */
export function modelDescription(): string {
	const per = listDrivers().map((d) => {
		const cat = d.models();
		const known = cat.values.length ? ` Known: ${cat.values.join(", ")}.` : "";
		return `${d.id} defaults to '${cat.default}'.${known}`;
	});
	return `Model id for the chosen agent. ${per.join(" ")} An unrecognised id is passed through with a warning: agents resolve their own aliases and their advertised vocabulary is not always what they accept.`;
}

/** `/delegate agents`: the honest capability list, including where a driver's limits are enforced. */
export function describeAgents(): string[] {
	return listDrivers().map((d) => {
		const caps = d.capabilities();
		const flags = [
			caps.thinking ? "thinking" : "no-thinking",
			caps.resume ? "resume" : "no-resume",
			caps.permissions ? "asks-permission" : "never-asks",
			caps.plans ? "plans" : "no-plans",
			caps.blocksOwnCli ? `blocks-${caps.cli}-cli` : "cli-unguarded",
			`worktree=${caps.worktree}`,
		];
		return `${d.id} (${d.source}, ${d.title}) — model default '${d.models().default}', modes default '${d.defaultMode()}'; ${flags.join(", ")}`;
	});
}

// ---------------------------------------------------------------- admission

export interface ValidatedRequest {
	driver: AgentDriver;
	selection: Selection;
	/** Non-fatal notes the tool result must carry (an unknown model id, a degraded decision). */
	warnings: string[];
}

export type AdmissionFailure = { ok: false; code: string; error: string };
export type Admission = ({ ok: true } & ValidatedRequest) | AdmissionFailure;

/**
 * Decide whether a `delegate_task` call may start, without starting anything.
 *
 * `mode` resolution is `reject` because an agent that silently ignores an unknown mode runs something
 * other than what was asked (Devin accepted `set_mode("auto")` and stayed in `accept-edits`).
 * `model` is `warn` because Devin resolves fuzzy names and its advertised vocabulary is narrower than
 * its `--model` flag. `thinking` is refused when the agent has no such control, naming what to do
 * instead — silently dropping it would let a caller believe it had asked for more thinking.
 */
export function admit(params: { agent?: string; model?: string; thinking?: string; mode?: string }): Admission {
	const agentRes = findAgent(params.agent);
	if (!agentRes.ok) {
		return { ok: false, code: "UNKNOWN_AGENT", error: agentRes.error };
	}
	const driver = agentRes.driver;

	const mode = (params.mode ?? driver.defaultMode()).trim() || driver.defaultMode();
	const modeRes: ModeResolution = driver.resolveMode(mode);
	if (!modeRes.ok) {
		return { ok: false, code: "INVALID_MODE", error: modeRes.error };
	}

	const warnings: string[] = [];
	let thinking: ThinkingLevel | undefined;
	if (params.thinking !== undefined && params.thinking !== null && String(params.thinking).trim() !== "") {
		const level = String(params.thinking).trim().toLowerCase();
		if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
			return {
				ok: false,
				code: "INVALID_THINKING",
				error: `Unknown thinking level '${params.thinking}'. Valid levels: ${THINKING_LEVELS.join(", ")}.`,
			};
		}
		const caps = driver.capabilities();
		if (!caps.thinking) {
			return {
				ok: false,
				code: "THINKING_UNSUPPORTED",
				error: `${driver.title}: ${caps.thinkingRefusal?.() ?? "this agent has no reasoning-effort control"}`,
			};
		}
		// The level has to be one *this* agent can apply. A level admitted and then refused on the wire costs a
		// spawned session, a slot, and a warning buried at the end of a tool result the caller already read.
		const offered = caps.thinkingLevels?.() ?? THINKING_LEVELS;
		if (!offered.includes(level)) {
			return {
				ok: false,
				code: "THINKING_UNAVAILABLE",
				error: `${driver.title} offers ${offered.join(", ")} for thinking; '${level}' is not one of them.`,
			};
		}
		thinking = level as ThinkingLevel;
	}

	const selection: Selection = { model: params.model?.trim() || undefined, thinking, mode };

	const catalogue = driver.models();
	if (selection.model && catalogue.values.length && !catalogue.values.includes(selection.model)) {
		warnings.push(
			`'${selection.model}' is not in ${driver.title}'s known model list (${catalogue.values.join(", ")}); passing it through — the agent resolves its own aliases`,
		);
	}

	return { ok: true, driver, selection, warnings };
}

/** The CLI names whose use through bash must be blocked, so delegation cannot bypass the queue. */
export function guardedClis(): string[] {
	return listDrivers()
		.filter((d) => d.capabilities().blocksOwnCli)
		.map((d) => d.capabilities().cli)
		.filter((cli): cli is string => Boolean(cli));
}
