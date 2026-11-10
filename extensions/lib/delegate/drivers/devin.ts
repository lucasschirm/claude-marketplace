// The Devin driver: how Devin's ACP server is launched, and which of its habits the generic engine
// must respect rather than smooth over.
//
// Every constant here used to be hardcoded in `lib/acp-client.ts` or in the delegate extension's
// closure. Two of them are not arbitrary and must not be "tidied" away:
//
// * The model is a **spawn flag**. Devin's `session/set_config_option(model)` answers
//   `-32602 Invalid value` for ids outside its advertised vocabulary (`swe-2-max` among them), so the
//   authoritative channel is `--model` — the old code had a redundant selector call that always failed
//   for exactly that model.
// * `DEVIN_MODEL` is set in the spawn env **and wins over the inherited one**. `devin acp` reads that
//   variable itself (`devin acp --help`: "Also read from DEVIN_MODEL"), and it is live in some shells
//   here. A transport that merged the env in the other order would silently run every delegation on
//   whatever the parent shell exported.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandExists } from "../../nonblocking.ts";
import { defaultMapUpdate } from "../events.ts";
import { makeModeResolver, modeCatalogue, pickPermissionOption } from "../permissions.ts";
import type { AgentDriver, Catalogue, DriverCapabilities, DriverHealth, LaunchPlan, Selection } from "../types.ts";

/** Canonical mode → Devin's wire mode id. `dangerous` is the tool's historical name for `bypass`. */
const DEVIN_MODE_ALIASES: Record<string, string> = {
	dangerous: "bypass",
	smart: "smart",
	// Not a Devin mode: it accepted set_mode("auto") and silently stayed in accept-edits.
	auto: "smart",
	"accept-edits": "accept-edits",
	plan: "plan",
	ask: "ask",
};

/** The default the tool has always used, so an omitted `model` still means the same thing. */
export const DEVIN_MODEL_DEFAULT = "swe-2-high";

/**
 * Known-good ids for tool text and soft validation. `onUnknown: "warn"` because Devin resolves fuzzy
 * model names itself ("family slug, alias, or partial name, e.g. `--model opus`", per `devin acp
 * --help`) and its advertised ACP vocabulary is narrower than what `--model` accepts. A hard refusal
 * here would break delegation the first time the upstream catalogue gains a model.
 */
const DEVIN_MODEL_CATALOGUE: Catalogue = {
	default: DEVIN_MODEL_DEFAULT,
	values: ["swe-2-high", "swe-2-max", "swe-1-7-lightning-medium", "glm-5-3-flash-max"],
	onUnknown: "warn",
};

/** Devin has no in-band reasoning-effort control: effort is part of the model id (`swe-2-high` vs
 *  `swe-2-max`). Refusing `thinking` and naming the model route beats guessing which model a level
 *  means — the ids differ in capability as well as effort, so a rewrite would be a guess with a
 *  confident face. */
export const DEVIN_THINKING_UNSUPPORTED =
	"has no separate reasoning-effort control: `thinking` is part of the model id (for example swe-2-high vs swe-2-max, glm-5-3-flash-max for research). Choose the model instead.";

export function devinLaunchPlan(sel: Selection, _cwd: string): LaunchPlan {
	const model = sel.model?.trim() || DEVIN_MODEL_DEFAULT;
	return {
		command: "devin",
		args: ["acp", "--model", model],
		env: { DEVIN_MODEL: model },
		label: "devin acp",
		clientInfo: { name: "pi-delegate-task", version: "1.0" },
	};
}

/**
 * Devin keeps its own conversation store at `~/.devin-xdg-data/devin/cli/sessions.db`. When pi died
 * mid-turn the ACP connection is gone with the process, but the agent may well have finished: this is
 * how a session that completed while nobody was watching is reported as done rather than interrupted.
 *
 * Every failure mode answers null. The database may not exist, `node:sqlite` may be unavailable on an
 * older node, the schema may change, and the session may not be in it — none of those is worth an error
 * to a caller whose question is "is there a final message?", and a wrong "no" costs one honest
 * "interrupted" line while a thrown error would abort recovery for every other session.
 */
export async function devinBackfillFinalMessage(sessionId: string): Promise<string | null> {
	const dbPath = path.join(os.homedir(), ".devin-xdg-data", "devin", "cli", "sessions.db");
	try {
		if (!fs.existsSync(dbPath)) {
			return null;
		}
	} catch {}
	let DatabaseSync: (new (p: string, o?: { readOnly?: boolean }) => any) | undefined;
	try {
		DatabaseSync = (await import("node:sqlite")).DatabaseSync;
	} catch {
		return null;
	}
	if (!DatabaseSync) {
		return null;
	}
	let db: any;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
		if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId)) {
			return null;
		}
		const rows: any[] = db
			.prepare("SELECT chat_message FROM message_nodes WHERE session_id = ? ORDER BY row_id DESC LIMIT 100")
			.all(sessionId);
		for (const r of rows) {
			try {
				const j = JSON.parse(r.chat_message);
				if (j.role !== "assistant") {
					continue;
				}
				const c = j.content;
				const text =
					typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("") : "";
				if (text.trim()) {
					return text;
				}
			} catch {}
		}
		return null;
	} catch {
		return null;
	} finally {
		try {
			db?.close?.();
		} catch {}
	}
}

export const devinDriver: AgentDriver = {
	id: "devin",
	title: "Devin",
	source: "built-in",

	capabilities(): DriverCapabilities {
		return {
			thinking: false,
			// Devin's effort lives in the model id (`swe-2-high` vs `swe-2-max`), so the refusal has to name
			// models to be useful — and only this driver knows them. A third agent without thinking will supply
			// its own sentence for the same reason: the engine has no business explaining another agent's models.
			thinkingRefusal: () => DEVIN_THINKING_UNSUPPORTED,
			// Devin session ids outlive the ACP server process: re-attaching spawns a fresh `devin acp`
			// and prompts the old id without session/new. No session/load needed.
			resume: true,
			cancel: true,
			permissions: true,
			plans: false,
			worktree: "host",
			// True only for Devin, deliberately. The guard exists so delegation cannot bypass the
			// queue, and `devin` has no legitimate use from a shell here. `claude` does: it is the
			// operator's own CLI, pi itself may be driving it, and blocking it would break the host
			// to protect a queue.
			blocksOwnCli: true,
			cli: "devin",
		};
	},

	async preflight(): Promise<DriverHealth> {
		if (!(await commandExists("devin"))) {
			return { ok: false, error: "the `devin` CLI is not on PATH", hint: "install it (https://docs.devin.ai) or pick another agent" };
		}
		return { ok: true };
	},

	launchPlan(sel: Selection, _cwd: string): LaunchPlan {
		return devinLaunchPlan(sel, _cwd);
	},

	// No `applySelection` at all, deliberately: the model is a spawn flag and the mode is set by the
	// engine with session/set_mode. A selector call here used to fail -32602 for every model outside
	// Devin's advertised vocabulary, so absence is the correct declaration, not an empty function.

	resolveMode: makeModeResolver(DEVIN_MODE_ALIASES),

	models(): Catalogue {
		return DEVIN_MODEL_CATALOGUE;
	},

	modes(): Catalogue {
		return modeCatalogue("dangerous");
	},

	defaultMode(): string {
		return "dangerous";
	},

	mapUpdate: defaultMapUpdate,

	backfill: devinBackfillFinalMessage,

	permission() {
		return {
			pickOption: pickPermissionOption,
			degradesAllowSession: false,
		};
	},
};
