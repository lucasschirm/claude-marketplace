// delegate_task — delegate work to another agent (Devin, Claude, Antigravity) and get told when it finishes.
//
// This file is the pi surface and nothing else: flags, lifecycle hooks, tools (plus the deprecated
// `devin_*` aliases), the `/delegate` command, and the bash guard. The engine lives in `lib/delegate/`
// — `runtime.ts` owns the state, `queue.ts` the admission, `session.ts` the turn, `drivers/` the
// per-agent differences. If you are looking for why a delegation did not start, start in `queue.ts`;
// if you are looking for why an agent was launched with a particular flag, start in its driver.
//
// Two things here are load-bearing beyond registration:
//  * The global guard. pi re-runs the extension factory on `/reload`, and a second generation with its
//    own maps would double-register tools and leave the first generation's sessions unrecoverable.
//  * `session_start` is detached behind a budget, and every mutating tool path awaits `recoveryDone`.
//    Pi awaits that hook before painting the transcript, so recovery that runs inside it delays the TUI
//    on the one path a user waits on; recovery detached without the gate would let a tool call racing it
//    see partial state and then have its own writes overwritten.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reportBudgetViolation } from "./lib/nonblocking.ts";
import { DelegateRuntime } from "./lib/delegate/runtime.ts";
import { recoverState } from "./lib/delegate/recovery.ts";
import { cancelSession, drainQueue, onPrClosed } from "./lib/delegate/queue.ts";
import { ALIAS_NOTE, aliasSpecs } from "./lib/delegate/compat.ts";
import { buildTools, type ToolSpec } from "./lib/delegate/tools.ts";
import { buildSessionTools } from "./lib/delegate/tools-session.ts";
import { cliBlockReason, findBlockedCliCommand } from "./lib/delegate/bash-guard.ts";
import { describeAgents, guardedClis } from "./lib/delegate/registry.ts";
import { DelegateDashboardComponent } from "./lib/delegate/dashboard.ts";
import { readLastMessages } from "./lib/delegate/transcript.ts";

const EXTENSION_NAME = "delegate_task";
const GLOBAL_GUARD_KEY = "__PI_DELEGATE_TASK_EXTENSION_ACTIVE__";
/** observe-pr's poll task calls this when a PR merges or closes, to release the worktree behind it. */
const PR_CLOSED_KEY = "__PI_ON_PR_CLOSED_DELEGATE__";
/** Test seam: flush the detached state writes (there is no other way to await them from a suite). */
const FLUSH_KEY = "__PI_DELEGATE_FLUSH__";

/** The deprecated `devin_*` surface, forwarded to its replacement with `agent` pinned to Devin. */
let processExitHooksRegistered = false;
let currentCleanup: (() => void) | undefined;

/**
 * Registered once per process, dispatching to the current generation's cleanup.
 *
 * A `/reload` re-runs the factory; stacking listeners would pin every previous generation's state until
 * the first signal fires. The dispatch indirection is the whole reason `currentCleanup` exists.
 */
function registerProcessExitHooks(): void {
	if (processExitHooksRegistered) {
		return;
	}
	processExitHooksRegistered = true;
	const run = () => currentCleanup?.();
	process.on("exit", run);
	process.on("SIGINT", run);
	process.on("SIGTERM", run);
}

export default function delegateTaskExtension(pi: ExtensionAPI): void {
	if ((globalThis as any)[GLOBAL_GUARD_KEY]) {
		return;
	}
	(globalThis as any)[GLOBAL_GUARD_KEY] = true;

	const rt = new DelegateRuntime(pi, EXTENSION_NAME);

	// --- Flags (each with the historical `devin-*` name still accepted) ---

	pi.registerFlag("delegate-max-runs", { description: "Maximum concurrent sessions per agent (default: 2)", type: "string" });
	pi.registerFlag("devin-max-runs", { description: "Deprecated alias for --delegate-max-runs", type: "string" });
	pi.registerFlag("delegate-max-runs-total", { description: "Maximum concurrent sessions across all agents (default: 3)", type: "string" });
	pi.registerFlag("delegate-turn-stall", {
		description: "Minutes of agent silence before a turn is reported stalled (default: 30)",
		type: "string",
	});
	pi.registerFlag("devin-turn-stall", { description: "Deprecated alias for --delegate-turn-stall", type: "string" });
	pi.registerFlag("delegate-permission-timeout", {
		description: "Minutes before an unanswered permission request auto-rejects (default: 5)",
		type: "string",
	});
	pi.registerFlag("devin-permission-timeout", { description: "Deprecated alias for --delegate-permission-timeout", type: "string" });
	pi.registerFlag("delegate-allow-bash", { description: "Allow the agent to call delegated agents' CLIs from bash", type: "boolean" });
	pi.registerFlag("devin-allow-bash", { description: "Deprecated alias for --delegate-allow-bash", type: "boolean" });

	const allowBashFlag = rt.flag("delegate-allow-bash", "devin-allow-bash");
	if (allowBashFlag !== undefined) {
		rt.allowGuardedBash = true;
	}

	const initialRuns = rt.flag("delegate-max-runs", "devin-max-runs");
	if (initialRuns !== undefined) {
		const parsed = Number.parseInt(initialRuns, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			rt.maxRuns = parsed;
		}
	}
	const initialTotal = rt.flag("delegate-max-runs-total");
	if (initialTotal !== undefined) {
		const parsed = Number.parseInt(initialTotal, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			rt.maxRunsTotal = Math.max(parsed, rt.maxRuns);
		}
	}

	const checkBudget = (event: string, startedAt: number): void => {
		reportBudgetViolation(EXTENSION_NAME, event, performance.now() - startedAt, 20, (msg) => rt.logError(msg));
	};

	// --- Lifecycle ---

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		const startedAt = performance.now();
		rt.tasks.resume();
		rt.setUi(ctx.ui);
		rt.baseDir = ctx.cwd;
		const piId = ctx.sessionManager?.getSessionId() || "default";
		// Detached: pi awaits session_start before it paints the restored transcript, so the disk reads
		// and orphan reconciliation land afterwards. `run()` never rejects, so keeping the promise as the
		// gate every tool waits on is safe.
		rt.recoveryDone = rt.tasks.run(
			"recover-state",
			async (signal) => {
				await recoverState(rt, piId, signal);
			},
			{ budgetMs: 5_000 },
		);
		(globalThis as any)[FLUSH_KEY] = async (timeoutMs?: number) => {
			const limit = timeoutMs ?? 10_000;
			await rt.tasks.flush(limit);
			await rt.stateWrites.drain(limit);
		};
		checkBudget("session_start", startedAt);
	});

	pi.on("session_shutdown", async () => {
		// Stop recovery work and flush queued state: pi awaits session_shutdown, so the last write of the
		// session is durable even though writes are asynchronous.
		rt.tasks.abort();
		await rt.stateWrites.drain(5_000);
		delete (globalThis as any)[GLOBAL_GUARD_KEY];
		delete (globalThis as any)[PR_CLOSED_KEY];
		delete (globalThis as any)[FLUSH_KEY];
		rt.shutdown();
	});

	// Block the agent from driving a delegated agent's own CLI through bash/powershell, which would route
	// around the queue, the limits and the transcript. Nested tool calls from codemode scripts pass
	// through here too, which is what makes codemode not a hole in the guard.
	pi.on("tool_call", async (event) => {
		if (rt.allowGuardedBash) {
			return;
		}
		if (event.toolName !== "bash" && event.toolName !== "powershell") {
			return;
		}
		const guarded = guardedClis();
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !findBlockedCliCommand(command, guarded)) {
			return;
		}
		return { block: true, reason: cliBlockReason(guarded) };
	});

	currentCleanup = () => rt.cleanupClients();
	registerProcessExitHooks();

	// --- Tools ---

	// The tools, then the retired `devin_*` names answering for one minor version. The alias table, the
	// note they all carry, and the fact that they force `agent: "devin"` live in `lib/delegate/compat.ts`.
	const specs: ToolSpec[] = [...buildTools(rt), ...buildSessionTools(rt)];
	for (const spec of specs) {
		pi.registerTool(spec as never);
	}
	for (const alias of aliasSpecs(specs)) {
		pi.registerTool(alias as never);
	}

	// --- Cross-extension hook: a PR that landed releases the worktree behind it ---

	(globalThis as any)[PR_CLOSED_KEY] = async (prNumber: number, state: string) => {
		// observe-pr calls this from a detached poll task. Recovery may still be rebuilding the session
		// map, and a session it has not re-added yet would be skipped permanently — this hook does not
		// fire twice for one close. Same gate as every other mutating path.
		await rt.recoveryDone;
		await onPrClosed(rt, prNumber, state);
	};

	// --- /delegate ---

	// A function rather than an inline handler, because the deprecated `/devin` name has to run the
	// same code: pi has no command-to-command dispatch, and two copies of this would drift.
	const delegateCommand = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		rt.setUi(ctx.ui);
		await rt.recoveryDone;
		const parts = (args || "").trim().split(/\s+/);
		const sub = parts[0]?.toLowerCase();

		if (sub === "agents") {
			ctx.ui.notify(agentsNote(), "info");
			return;
		}
		if (sub === "limit") {
			if (!parts[1]) {
				ctx.ui.notify(`${EXTENSION_NAME}: ${rt.maxRuns} per agent, ${rt.maxRunsTotal} in total.`, "info");
				return;
			}
			const n = Number.parseInt(parts[1], 10);
			if (Number.isNaN(n) || n <= 0) {
				ctx.ui.notify("Usage: /delegate limit <positive number>", "warning");
				return;
			}
			rt.maxRuns = n;
			rt.maxRunsTotal = Math.max(rt.maxRunsTotal, n);
			rt.persistState();
			rt.updateStatusUI(ctx.ui);
			ctx.ui.notify(`Delegation limit updated to ${n} per agent.`, "info");
			void drainQueue(rt);
			return;
		}
		if (sub === "allow-bash" || sub === "allow_bash") {
			const arg = parts[1]?.toLowerCase();
			if (arg === "status") {
				ctx.ui.notify(
					`Direct CLI calls for ${guardedClis().join(", ") || "no agent"} are ${rt.allowGuardedBash ? "ALLOWED" : "BLOCKED"}.`,
					"info",
				);
				return;
			}
			if (arg && !["on", "allow", "off", "block"].includes(arg)) {
				ctx.ui.notify("Usage: /delegate allow-bash [on|off|status] (no argument toggles)", "warning");
				return;
			}
			rt.allowGuardedBash = arg ? arg === "on" || arg === "allow" : !rt.allowGuardedBash;
			ctx.ui.notify(
				rt.allowGuardedBash
					? "Direct delegated-agent CLI calls are now ALLOWED for this session."
					: "Direct delegated-agent CLI calls are now BLOCKED. The agent must use the delegate_* tools.",
				"info",
			);
			return;
		}
		if (sub === "cancel") {
			const targetId = parts[1];
			if (!targetId) {
				ctx.ui.notify("Usage: /delegate cancel <session-id>", "warning");
				return;
			}
			const kind = await cancelSession(rt, targetId);
			if (kind === "not_found") {
				ctx.ui.notify(`Session '${targetId}' not found.`, "warning");
			} else {
				ctx.ui.notify(kind === "queued" ? `Cancelled queued task ${targetId}.` : `Cancelled session ${targetId}.`, "info");
			}
			return;
		}
		if (!sub || sub === "list" || sub === "sessions" || sub === "dashboard") {
			if (ctx.mode === "tui" && ctx.hasUI) {
				await ctx.ui.custom<void>((tui, theme, _kb, done) => {
					return new DelegateDashboardComponent(
						tui as never,
						theme as never,
						() => [...rt.sessions.values()],
						() => [...rt.queue],
						(session, count) => readLastMessages(rt, session, count),
						() => done(),
					);
				});
			} else {
				ctx.ui.notify(
					`${EXTENSION_NAME}: ${rt.slots.inFlight()} in flight, ${rt.queue.length} queued, ${rt.totalCompleted} completed (limit ${rt.maxRuns}/agent, ${rt.maxRunsTotal} total), ${rt.pendingPermissions.size} awaiting permission`,
					"info",
				);
			}
			return;
		}
		ctx.ui.notify(`Unknown subcommand '${sub}'. Try: list, agents, limit [n], cancel <id>, allow-bash [on|off|status]`, "warning");
	};

	pi.registerCommand("delegate", {
		description: "Delegation controls: list | agents | limit [n] | cancel <id> | allow-bash [on|off|status]",
		handler: delegateCommand,
	});

	// The retired command, forwarding rather than duplicating: a subcommand implemented twice is two
	// places for behaviour to diverge, which is how `/devin cancel` and `delegate_cancel` disagreed.
	pi.registerCommand("devin", {
		description: `Deprecated: use /delegate. ${ALIAS_NOTE}`,
		handler: async (args, ctx) => {
			ctx.ui.notify(`/devin is now /delegate. ${ALIAS_NOTE}`, "warning");
			await delegateCommand(args, ctx);
		},
	});
}

/** `/delegate agents`: what exists, what each one can do, and where its limits are enforced. */
function agentsNote(): string {
	return describeAgents().join("\n");
}
