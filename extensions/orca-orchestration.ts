import type { ExtensionAPI, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import {
	execOrca,
	resolveOrcaCmd,
	spawnOrcaCheck,
	type OrcaWorkerRow,
	type OrcaMessageDelivery,
} from "./lib/orca-client.ts";

const GLOBAL_GUARD_KEY = "__PI_ORCA_ORCHESTRATION_EXTENSION_ACTIVE__";

export interface ObservedWorker {
	dispatchId: string;
	taskId?: string;
	runId?: string;
	status: "running" | "succeeded" | "failed" | "stopped" | "released" | "unknown";
	spec?: string;
	taskTitle?: string;
	agent?: string;
	terminalHandle?: string;
	outcome?: string;
	summary?: string;
	filesModified?: string[];
	reportPath?: string;
	startedAt: number;
	finishedAt?: number;
	lastAttention?: string;
}

export interface OrchestrationStats {
	isEnabled: boolean;
	interval: number;
	activeRunId?: string;
	objective?: string;
	runningCount: number;
	succeededCount: number;
	failedCount: number;
	releasedCount: number;
	workers: ObservedWorker[];
}

export class OrcaDashboardComponent {
	private theme: any;
	private getStats: () => OrchestrationStats;
	private onClose: () => void;
	private selectedIndex = 0;

	constructor(theme: any, getStats: () => OrchestrationStats, onClose: () => void) {
		this.theme = theme;
		this.getStats = getStats;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.onClose();
			return;
		}

		const stats = this.getStats();
		if (matchesKey(data, "up")) {
			if (this.selectedIndex > 0) this.selectedIndex--;
		} else if (matchesKey(data, "down")) {
			if (this.selectedIndex < stats.workers.length - 1) this.selectedIndex++;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;
		const stats = this.getStats();

		lines.push("");
		const title = th.fg("accent", " Orca Orchestration Observer ");
		const headerLine =
			th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 33)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		const toolStatus = stats.isEnabled ? th.fg("success", "● Active") : th.fg("error", "○ Inactive");
		const runInfo = stats.activeRunId ? `Run: ${th.fg("accent", stats.activeRunId)}` : "No active Run bound";
		lines.push(truncateToWidth(`  Status: ${toolStatus} | ${runInfo} (Reconcile: ${stats.interval}s)`, width));

		if (stats.objective) {
			lines.push(truncateToWidth(`  Objective: "${stats.objective}"`, width));
		}
		lines.push(
			truncateToWidth(
				`  Workers: ${th.fg("warning", String(stats.runningCount))} running, ${th.fg("success", String(stats.succeededCount))} succeeded, ${th.fg("error", String(stats.failedCount))} failed, ${th.fg("dim", String(stats.releasedCount))} released`,
				width,
			),
		);
		lines.push("");

		if (stats.workers.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No workers observed yet.")}`, width));
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", "Use the orca_orchestration_dispatch tool to start a supervised worker.")}`,
					width,
				),
			);
		} else {
			lines.push(truncateToWidth(`  ${th.fg("muted", "Observed Workers:")}`, width));
			lines.push("");

			for (let i = 0; i < stats.workers.length; i++) {
				const w = stats.workers[i];
				const isSelected = i === this.selectedIndex;
				const pointer = isSelected ? th.fg("accent", "▶ ") : "  ";

				let statusColor = "muted";
				if (w.status === "running") statusColor = "warning";
				else if (w.status === "succeeded") statusColor = "success";
				else if (w.status === "failed") statusColor = "error";

				const statusBadge = th.fg(statusColor, `[${w.status.toUpperCase()}]`);
				const agentInfo = w.agent ? ` (${w.agent})` : "";
				const titleStr = w.taskTitle || w.spec?.slice(0, 35) || w.dispatchId;

				lines.push(
					truncateToWidth(
						`${pointer}${th.bold(w.dispatchId)} ${statusBadge}${agentInfo}: ${titleStr}`,
						width,
					),
				);

				if (w.summary) {
					lines.push(truncateToWidth(`     Summary: ${w.summary.slice(0, 60)}`, width));
				}
				if (w.filesModified && w.filesModified.length > 0) {
					lines.push(truncateToWidth(`     Files: ${w.filesModified.join(", ")}`, width));
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape or 'q' to close")}`, width));
		lines.push("");

		return lines;
	}
}

export default function orcaOrchestrationExtension(pi: ExtensionAPI): void {
	try {
		pi.registerFlag("orca-observer-interval", {
			description: "Reconciliation and watch interval in seconds for Orca orchestration (default: 30)",
			type: "string",
			default: "30",
		});
	} catch {}

	if ((globalThis as any)[GLOBAL_GUARD_KEY]) {
		return;
	}
	(globalThis as any)[GLOBAL_GUARD_KEY] = true;

	// State
	let activeRunId: string | undefined;
	let activeObjective: string | undefined;
	const observedWorkers = new Map<string, ObservedWorker>();
	let checkProcess: ChildProcess | null = null;
	let reconcileTimer: NodeJS.Timeout | undefined;
	let restartCheckTimer: NodeJS.Timeout | undefined;
	let lastPendingAckDeliveryId: string | undefined;
	let lastUIContext: ExtensionUIContext | undefined;
	let lastCwd: string = process.cwd();
	let disposed = false;
	let isReconciling = false;

	function getObserverInterval(): number {
		const flagVal = pi.getFlag("orca-observer-interval");
		const parsed = parseInt(String(flagVal || "30"), 10);
		return isNaN(parsed) || parsed <= 0 ? 30 : parsed;
	}

	function updateStatusUI(ui?: ExtensionUIContext) {
		const targetUI = ui || lastUIContext;
		if (!targetUI) return;

		let running = 0;
		let succeeded = 0;
		let failed = 0;

		for (const w of observedWorkers.values()) {
			if (w.status === "running") running++;
			else if (w.status === "succeeded") succeeded++;
			else if (w.status === "failed") failed++;
		}

		const settled = succeeded + failed;
		if (running === 0 && settled === 0) {
			targetUI.setStatus("orca_orchestration", undefined);
			return;
		}

		targetUI.setStatus("orca_orchestration", `Orca: ${running} running / ${settled} settled`);
	}

	function sendAgentMessage(content: string) {
		try {
			pi.sendUserMessage(content, { deliverAs: "steer" });
		} catch (err) {
			console.error("[orca-orchestration] Failed to send message to agent:", err);
		}
	}

	function getStats(): OrchestrationStats {
		const activeTools = pi.getActiveTools();
		const isEnabled = activeTools.includes("orca_orchestration_dispatch");

		let runningCount = 0;
		let succeededCount = 0;
		let failedCount = 0;
		let releasedCount = 0;

		for (const w of observedWorkers.values()) {
			if (w.status === "running") runningCount++;
			else if (w.status === "succeeded") succeededCount++;
			else if (w.status === "failed") failedCount++;
			else if (w.status === "released") releasedCount++;
		}

		return {
			isEnabled,
			interval: getObserverInterval(),
			activeRunId,
			objective: activeObjective,
			runningCount,
			succeededCount,
			failedCount,
			releasedCount,
			workers: Array.from(observedWorkers.values()),
		};
	}

	// --- Check Loop Engine (orca orchestration check --wait) ---

	function startCheckProcess(ackDeliveryId?: string) {
		if (disposed) return;
		if (checkProcess) {
			try {
				checkProcess.kill("SIGTERM");
			} catch {}
			checkProcess = null;
		}

		try {
			checkProcess = spawnOrcaCheck(activeRunId, {
				cwd: lastCwd,
				timeoutMs: 900000,
				ackDeliveryId: ackDeliveryId || lastPendingAckDeliveryId,
			});
		} catch (err) {
			console.error("[orca-orchestration] Failed to spawn orchestration check process:", err);
			return;
		}

		lastPendingAckDeliveryId = undefined;
		const proc = checkProcess;

		proc.on("error", (err) => {
			console.error("[orca-orchestration] Check process error:", err);
		});

		const rl = readline.createInterface({
			input: proc.stdout!,
			crlfDelay: Infinity,
		});

		rl.on("line", (line) => {
			if (!line.trim()) return;
			try {
				const data = JSON.parse(line);
				// Ignore keepalive messages
				if (data._keepalive || data._heartbeat) {
					return;
				}

				handleCheckDelivery(data);
			} catch {
				// Non-JSON output (log headers, etc.)
			}
		});

		proc.on("close", (code) => {
			if (disposed) return;
			checkProcess = null;

			// If active dispatches remain, restart the check process after brief pause
			let hasRunningWorkers = false;
			for (const w of observedWorkers.values()) {
				if (w.status === "running") {
					hasRunningWorkers = true;
					break;
				}
			}

			if (hasRunningWorkers || activeRunId) {
				restartCheckTimer = setTimeout(() => {
					if (!disposed && !checkProcess) {
						startCheckProcess();
					}
				}, 1000);
			}
		});
	}

	function handleCheckDelivery(data: any) {
		const delivery: any =
			data.result?.delivery || data.delivery || data.result || data;

		const deliveryId = delivery?.deliveryId || data.result?.deliveryId || data.deliveryId;
		if (deliveryId) {
			lastPendingAckDeliveryId = deliveryId;
		}

		const messages =
			delivery?.messages || (Array.isArray(data.result) ? data.result : Array.isArray(data) ? data : []);
		if (!Array.isArray(messages) || messages.length === 0) return;

		for (const msg of messages) {
			const type = msg.type;
			const dispatchId = msg.dispatchId || msg.from;
			const taskId = msg.taskId;

			let worker: ObservedWorker | undefined;
			if (dispatchId && observedWorkers.has(dispatchId)) {
				worker = observedWorkers.get(dispatchId);
			}

			if (type === "worker_done") {
				const outcome = String(msg.outcome || "succeeded").toLowerCase();
				const isSuccess = outcome === "succeeded";
				const summary = msg.summary || msg.body || "No summary provided.";
				const filesModified = Array.isArray(msg.filesModified) ? msg.filesModified : [];
				const reportPath = msg.reportPath;

				if (worker) {
					worker.status = isSuccess ? "succeeded" : "failed";
					worker.outcome = outcome;
					worker.summary = summary;
					worker.filesModified = filesModified;
					worker.reportPath = reportPath;
					worker.finishedAt = Date.now();
				} else if (dispatchId) {
					observedWorkers.set(dispatchId, {
						dispatchId,
						taskId,
						runId: activeRunId,
						status: isSuccess ? "succeeded" : "failed",
						outcome,
						summary,
						filesModified,
						reportPath,
						startedAt: Date.now() - 1000,
						finishedAt: Date.now(),
					});
				}

				updateStatusUI();

				const filesStr = filesModified.length > 0 ? `\nModified files: ${filesModified.join(", ")}` : "";
				const reportStr = reportPath ? `\nReport: ${reportPath}` : "";

				sendAgentMessage(
					`[Orca Orchestration] Worker ${dispatchId || "unknown"} finished with outcome '${outcome.toUpperCase()}'.\n` +
						`Summary: ${summary}${filesStr}${reportStr}\n\n` +
						`Use "orca_orchestration_release" with dispatch_id "${dispatchId}" to release the worker terminal resources, or review changes.`,
				);
			} else if (type === "question") {
				const questionText = msg.body || msg.summary || "No question text.";
				sendAgentMessage(
					`[Orca Orchestration] Worker ${dispatchId || "unknown"} asked a blocking question (ID: ${msg.id}):\n` +
						`"${questionText}"\n\n` +
						`Please reply promptly using the "orca_orchestration_reply" tool: ` +
						`orca_orchestration_reply({ message_id: "${msg.id}", answer: "<your answer>" })`,
				);
			} else if (type === "escalation") {
				const reason = msg.body || msg.summary || "No escalation details.";
				sendAgentMessage(
					`[Orca Orchestration] Worker ${dispatchId || "unknown"} escalated an issue:\n` +
						`"${reason}"\n\n` +
						`Investigate using "orca_orchestration_status" or stop the worker using "orca_orchestration_release" with action "stop".`,
				);
			}
		}

		// Acknowledge the batch immediately so subsequent checks receive fresh events
		if (deliveryId) {
			execOrca(["orchestration", "check", "--ack", deliveryId], { cwd: lastCwd }).catch((err) => {
				console.warn("[orca-orchestration] Failed to ack delivery:", err);
			});
		}
	}

	// --- Reconciliation Watcher (orca orchestration worker-list) ---

	async function reconcileWorkers() {
		if (disposed || isReconciling) return;
		isReconciling = true;

		try {
			const res = await execOrca<{ rows: OrcaWorkerRow[] }>(
				["orchestration", "worker-list"],
				{ cwd: lastCwd },
			);

			if (res.ok && res.result && Array.isArray(res.result.rows)) {
				for (const row of res.result.rows) {
					const dId = row.dispatchId;
					if (!dId) continue;

					let w = observedWorkers.get(dId);
					const verdict = row.projection?.liveness?.verdict;
					const terminalState = row.terminalState;
					const outcome = row.projection?.outcome;
					const requiresAction = row.projection?.attention?.requiresAction;

					if (!w) {
						// Only track if active or belongs to current run
						if (terminalState === "active" || (activeRunId && row.runId === activeRunId)) {
							w = {
								dispatchId: dId,
								taskId: row.taskId,
								runId: row.runId,
								status: terminalState === "active" ? "running" : outcome === "succeeded" ? "succeeded" : "failed",
								terminalHandle: row.agentTerminalHandle,
								startedAt: Date.now(),
							};
							observedWorkers.set(dId, w);
						}
					}

					if (w) {
						if (terminalState === "released") {
							w.status = "released";
						} else if (terminalState === "reclaimable" || verdict === "exited") {
							if (w.status === "running") {
								w.status = outcome === "succeeded" ? "succeeded" : "failed";
								w.finishedAt = Date.now();

								// If process exited without worker_done message, alert the coordinator
								if (!w.outcome) {
									w.outcome = "exited_without_report";
									sendAgentMessage(
										`[Orca Orchestration] Worker ${dId} process exited (${row.projection?.liveness?.reason || "exit observed"}). ` +
											`Inspect details with "orca_orchestration_status".`,
									);
								}
							}
						}

						if (requiresAction && row.projection?.attention?.categories) {
							const categories = row.projection.attention.categories.join(", ");
							if (w.lastAttention !== categories && w.status === "running") {
								w.lastAttention = categories;
								sendAgentMessage(
									`[Orca Orchestration] Attention required for worker ${dId} (${categories}). Use "orca_orchestration_status" to inspect.`,
								);
							}
						}
					}
				}
				updateStatusUI();
			}
		} catch (err) {
			console.error("[orca-orchestration] Error during worker reconciliation:", err);
		} finally {
			isReconciling = false;
		}
	}

	function startReconcileTimer() {
		if (reconcileTimer) clearInterval(reconcileTimer);
		const interval = getObserverInterval();
		reconcileTimer = setInterval(() => {
			reconcileWorkers();
		}, interval * 1000);
	}

	async function discoverActiveRun(cwd: string) {
		try {
			const res = await execOrca<{ run: any }>(["orchestration", "run-current"], { cwd });
			if (res.ok && res.result?.run) {
				const run = res.result.run;
				activeRunId = run.id || run.runId;
				activeObjective = run.objective;
				startCheckProcess();
			}
		} catch {}
	}

	// --- Lifecycle Hooks ---

	pi.on("session_start", async (_evt, ctx) => {
		lastUIContext = ctx.ui;
		lastCwd = ctx.cwd || process.cwd();
		disposed = false;
		updateStatusUI(ctx.ui);
		await discoverActiveRun(lastCwd);
		await reconcileWorkers();
		startReconcileTimer();
	});

	pi.on("turn_end", async (_evt, ctx) => {
		if (ctx?.cwd) lastCwd = ctx.cwd;
		if (ctx?.ui) lastUIContext = ctx.ui;
		await reconcileWorkers();
	});

	const AUTO_OBSERVATION_PROMPT_MESSAGE =
		"Automatic Orca orchestration observation is active. Dispatched workers are automatically monitored in the background. " +
		"Do not write shell scripts or poll `orca orchestration check` / `worker-list` in loops. " +
		"You will automatically receive high-priority messages when workers finish (`worker_done`), ask questions, or escalate. " +
		"When your dispatches are in flight and you have no other work to do, end your turn and wait for worker updates.";

	pi.on("before_agent_start", (event) => {
		const isEnabled = pi.getActiveTools().includes("orca_orchestration_dispatch");
		if (!isEnabled) {
			if (event.systemPromptOptions?.sections?.orca_auto_observation) {
				delete event.systemPromptOptions.sections.orca_auto_observation;
			}
			return;
		}

		if (event.systemPromptOptions?.sections) {
			event.systemPromptOptions.sections.orca_auto_observation = AUTO_OBSERVATION_PROMPT_MESSAGE;
		}

		if (event.systemPromptOptions?.promptGuidelines) {
			if (!event.systemPromptOptions.promptGuidelines.includes(AUTO_OBSERVATION_PROMPT_MESSAGE)) {
				event.systemPromptOptions.promptGuidelines.push(AUTO_OBSERVATION_PROMPT_MESSAGE);
			}
		}

		return {
			systemPrompt: event.systemPrompt
				? `${event.systemPrompt}\n\n${AUTO_OBSERVATION_PROMPT_MESSAGE}`
				: AUTO_OBSERVATION_PROMPT_MESSAGE,
		};
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		if (reconcileTimer) clearInterval(reconcileTimer);
		if (restartCheckTimer) clearTimeout(restartCheckTimer);
		if (checkProcess) {
			try {
				checkProcess.kill("SIGTERM");
			} catch {}
			checkProcess = null;
		}
		delete (globalThis as any)[GLOBAL_GUARD_KEY];
	});

	// --- Registered Tools ---

	// 1. orca_orchestration_dispatch
	pi.registerTool({
		name: "orca_orchestration_dispatch",
		label: "Orchestration Dispatch",
		description:
			"Dispatches a supervised task/worker in Orca orchestration. Automatically binds a Run, registers the worker, and begins background observation so you receive completion and question messages automatically.",
		parameters: Type.Object({
			spec: Type.String({
				description:
					"Task specification adhering to the task-spec contract (Target, Change, Constraints, Ownership, Acceptance criteria)",
			}),
			objective: Type.Optional(
				Type.String({
					description: "Objective for the orchestration Run if a Run is not already created",
				}),
			),
			agent: Type.Optional(
				Type.String({
					description:
						"Orca agent id to run the worker (e.g., codex, claude, cursor, antigravity). Defaults to codex or environment default",
				}),
			),
			worktree: Type.Optional(
				Type.String({
					description: "Worktree placement: current, new-child, new-top-level, or selector (default: current)",
				}),
			),
			task_title: Type.Optional(
				Type.String({
					description: "Concise title for the orchestration task",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: "Optional provider model id for the agent launch",
				}),
			),
			effort: Type.Optional(
				Type.String({
					description: "Reasoning effort level for the selected model",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			// Ensure an active Run exists
			if (!activeRunId) {
				const objective = params.objective || params.task_title || params.spec.slice(0, 60);
				const runRes = await execOrca<{ run?: any; id?: string }>(
					["orchestration", "run-create", "--objective", objective],
					{ cwd: ctx.cwd },
				);

				if (!runRes.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Failed to create orchestration Run: ${runRes.error?.message || "Unknown error"}`,
							},
						],
						isError: true,
					};
				}

				const createdRun = runRes.result?.run || runRes.result;
				activeRunId = createdRun?.id || createdRun?.runId || runRes.id;
				activeObjective = objective;
			}

			// Assemble worker-start args
			const args = ["orchestration", "worker-start", "--spec", params.spec];
			if (params.worktree) {
				args.push("--worktree", params.worktree);
			} else {
				args.push("--worktree", "current");
			}

			if (params.agent) {
				args.push("--agent", params.agent);
			} else {
				args.push("--agent", "codex");
			}

			if (params.task_title) {
				args.push("--task-title", params.task_title);
			}
			if (params.model) {
				args.push("--model", params.model);
			}
			if (params.effort) {
				args.push("--effort", params.effort);
			}
			if (activeRunId) {
				args.push("--run", activeRunId);
			}

			const startRes = await execOrca<any>(args, { cwd: ctx.cwd, timeoutMs: 60000 });
			if (!startRes.ok) {
				const errMsg = startRes.error?.message || JSON.stringify(startRes.error || "worker-start failed");
				return {
					content: [{ type: "text", text: `Failed to dispatch worker:\n${errMsg}` }],
					isError: true,
				};
			}

			const receipt = startRes.result?.worker || startRes.result || {};
			const dispatchId = receipt.dispatchId || receipt.id || `dispatch-${Date.now()}`;
			const taskId = receipt.taskId || receipt.task?.id;
			const terminalHandle = receipt.terminalHandle || receipt.agentTerminalHandle;

			// Register in observer
			const worker: ObservedWorker = {
				dispatchId,
				taskId,
				runId: activeRunId,
				status: "running",
				spec: params.spec,
				taskTitle: params.task_title,
				agent: params.agent || "codex",
				terminalHandle,
				startedAt: Date.now(),
			};
			observedWorkers.set(dispatchId, worker);
			updateStatusUI(ctx.ui);

			// Start check process if not running
			if (!checkProcess) {
				startCheckProcess();
			}

			return {
				content: [
					{
						type: "text",
						text:
							`Worker successfully dispatched and is now being automatically observed.\n` +
							`Dispatch ID: ${dispatchId}\n` +
							`Task ID: ${taskId || "N/A"}\n` +
							`Run ID: ${activeRunId}\n` +
							`Terminal Handle: ${terminalHandle || "N/A"}\n\n` +
							`You will receive an automatic steering message when this worker completes, fails, asks a question, or escalates. ` +
							`Do not poll for updates.`,
					},
				],
			};
		},
	});

	// 2. orca_orchestration_observe
	const observeToolDef = {
		name: "orca_orchestration_observe",
		label: "Observe Orchestration",
		description:
			"Checks or configures automatic observation on Orca orchestration dispatches. Calling without parameters reports currently observed workers and Run status.",
		parameters: Type.Object({
			action: Type.Optional(
				Type.String({
					description: "Action to perform: 'status', 'start', or 'stop' (default: status)",
				}),
			),
			dispatch_id: Type.Optional(
				Type.String({
					description: "Optional specific dispatch ID to start or stop observing",
				}),
			),
			run_id: Type.Optional(
				Type.String({
					description: "Optional Run ID to bind or observe",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;
			const action = params.action?.toLowerCase() || "status";

			if (params.run_id && params.run_id !== activeRunId) {
				activeRunId = params.run_id;
				startCheckProcess();
			}

			if (action === "stop") {
				if (params.dispatch_id) {
					observedWorkers.delete(params.dispatch_id);
					updateStatusUI(ctx.ui);
					return {
						content: [{ type: "text", text: `Stopped observing dispatch ${params.dispatch_id}.` }],
					};
				}

				if (checkProcess) {
					try {
						checkProcess.kill("SIGTERM");
					} catch {}
					checkProcess = null;
				}
				updateStatusUI(ctx.ui);
				return {
					content: [{ type: "text", text: `Orca orchestration automatic check process paused.` }],
				};
			}

			if (action === "start" && !checkProcess) {
				startCheckProcess();
			}

			await reconcileWorkers();
			const stats = getStats();

			const workerLines = stats.workers.map(
				(w) => `  - [${w.status.toUpperCase()}] ${w.dispatchId} (${w.agent || "agent"}): ${w.taskTitle || w.spec?.slice(0, 40) || "No title"}`,
			);

			return {
				content: [
					{
						type: "text",
						text:
							`Orca Orchestration Observer: ${stats.isEnabled ? "Active" : "Disabled"}\n` +
							`Active Run: ${stats.activeRunId || "None"}\n` +
							`Workers: ${stats.runningCount} running, ${stats.succeededCount} succeeded, ${stats.failedCount} failed, ${stats.releasedCount} released\n\n` +
							(workerLines.length > 0
								? `Observed Workers:\n${workerLines.join("\n")}`
								: `No workers currently tracked.`),
					},
				],
			};
		},
	};
	pi.registerTool(observeToolDef);
	pi.registerTool({
		...observeToolDef,
		name: "orca_orchestration_observe_orchestration",
	});

	// 3. orca_orchestration_status
	pi.registerTool({
		name: "orca_orchestration_status",
		label: "Orchestration Status",
		description:
			"Checks status, attention categories, and bounded output for supervised workers without needing manual bash scripts.",
		parameters: Type.Object({
			dispatch_id: Type.Optional(
				Type.String({
					description: "Specific dispatch ID to inspect. If omitted, returns overview of all workers in the Run",
				}),
			),
			read_output: Type.Optional(
				Type.Boolean({
					description: "If true, reads recent output lines from the target worker (requires dispatch_id)",
				}),
			),
			complete: Type.Optional(
				Type.Boolean({
					description: "If true, returns full inspectable dispatch details via worker-show",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			if (params.dispatch_id) {
				const dId = params.dispatch_id;
				const localMeta = observedWorkers.get(dId);

				if (params.read_output) {
					const readRes = await execOrca<any>(
						["orchestration", "worker-read", "--dispatch", dId, "--source", "auto"],
						{ cwd: ctx.cwd },
					);
					const output =
						readRes.result?.output ||
						readRes.result?.lines?.join("\n") ||
						readRes.result ||
						readRes.error?.message ||
						"No output captured.";

					return {
						content: [
							{
								type: "text",
								text: `Output from worker ${dId} (Status: ${localMeta?.status || "unknown"}):\n\n${output}`,
							},
						],
					};
				}

				if (params.complete) {
					const showRes = await execOrca<any>(
						["orchestration", "worker-show", "--dispatch", dId],
						{ cwd: ctx.cwd },
					);
					return {
						content: [
							{
								type: "text",
								text: `Worker show details for ${dId}:\n${JSON.stringify(showRes.result || showRes, null, 2)}`,
							},
						],
					};
				}

				// Standard dispatch status
				const showRes = await execOrca<any>(
					["orchestration", "worker-show", "--dispatch", dId],
					{ cwd: ctx.cwd },
				);
				const proj = showRes.result?.projection || showRes.result || {};
				const stage = proj.stage?.worker || localMeta?.status || "unknown";
				const outcome = proj.outcome || localMeta?.outcome || "pending";
				const attention = proj.attention?.categories?.join(", ") || "none";

				return {
					content: [
						{
							type: "text",
							text:
								`Dispatch ${dId} Status:\n` +
								`Stage: ${stage} | Outcome: ${outcome}\n` +
								`Attention Categories: ${attention}\n` +
								(localMeta?.summary ? `Summary: ${localMeta.summary}\n` : "") +
								(localMeta?.filesModified?.length ? `Modified Files: ${localMeta.filesModified.join(", ")}\n` : "") +
								(localMeta?.reportPath ? `Report Path: ${localMeta.reportPath}\n` : ""),
						},
					],
				};
			}

			// Overview
			await reconcileWorkers();
			const stats = getStats();
			const list: string[] = [];

			for (const w of stats.workers) {
				list.push(
					`[${w.status.toUpperCase()}] ${w.dispatchId} (${w.agent || "agent"})\n` +
						`  Spec: ${w.spec?.slice(0, 50) || "N/A"}\n` +
						(w.outcome ? `  Outcome: ${w.outcome}\n` : "") +
						(w.summary ? `  Summary: ${w.summary}\n` : ""),
				);
			}

			return {
				content: [
					{
						type: "text",
						text:
							`Active Run: ${stats.activeRunId || "None"} (Objective: "${stats.objective || "N/A"}")\n` +
							`Worker Counts: ${stats.runningCount} running, ${stats.succeededCount} succeeded, ${stats.failedCount} failed, ${stats.releasedCount} released\n\n` +
							(list.length > 0 ? list.join("\n") : "No workers observed yet."),
					},
				],
			};
		},
	});

	// 4. orca_orchestration_reply
	pi.registerTool({
		name: "orca_orchestration_reply",
		label: "Orchestration Reply",
		description:
			"Replies to a blocking question or escalation from a supervised worker to unblock its execution.",
		parameters: Type.Object({
			message_id: Type.String({
				description: "The identifier of the message/question being answered",
			}),
			answer: Type.String({
				description: "The answer or instructions to provide to the worker",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			const replyRes = await execOrca<any>(
				["orchestration", "reply", "--id", params.message_id, "--body", params.answer],
				{ cwd: ctx.cwd },
			);

			if (!replyRes.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send orchestration reply: ${replyRes.error?.message || "Unknown error"}`,
						},
					],
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Reply sent successfully for message ${params.message_id}. Worker will resume execution.`,
					},
				],
			};
		},
	});

	// 5. orca_orchestration_release
	pi.registerTool({
		name: "orca_orchestration_release",
		label: "Orchestration Release",
		description:
			"Performs lifecycle cleanup: releases the terminal of a settled worker (succeeded or failed), or stops/fences a running worker.",
		parameters: Type.Object({
			dispatch_id: Type.String({
				description: "Dispatch ID of the worker to release or stop",
			}),
			action: Type.Optional(
				Type.String({
					description: "Action to take: 'release' (default, for settled workers) or 'stop' (to cancel running worker)",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;
			const action = params.action?.toLowerCase() || "release";
			const dId = params.dispatch_id;

			if (action === "stop") {
				const stopRes = await execOrca<any>(
					["orchestration", "worker-stop", "--dispatch", dId],
					{ cwd: ctx.cwd },
				);

				if (!stopRes.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Failed to stop worker ${dId}: ${stopRes.error?.message || "Unknown error"}`,
							},
						],
						isError: true,
					};
				}

				const w = observedWorkers.get(dId);
				if (w) {
					w.status = "stopped";
				}
				updateStatusUI(ctx.ui);

				return {
					content: [{ type: "text", text: `Worker ${dId} was successfully stopped and fenced.` }],
				};
			}

			// Default: release settled worker
			const releaseRes = await execOrca<any>(
				["orchestration", "worker-release", "--dispatch", dId],
				{ cwd: ctx.cwd },
			);

			if (!releaseRes.ok) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to release worker ${dId}: ${releaseRes.error?.message || "Unknown error"}`,
						},
					],
					isError: true,
				};
			}

			const w = observedWorkers.get(dId);
			if (w) {
				w.status = "released";
			}
			updateStatusUI(ctx.ui);

			return {
				content: [
					{
						type: "text",
						text: `Worker terminal for dispatch ${dId} has been successfully released.`,
					},
				],
			};
		},
	});

	// --- Command / Dashboard ---

	pi.registerCommand("orchestration", {
		description: "Orca orchestration controls and dashboard (subcommands: list, dashboard, stop <id>, release <id>, enable, disable)",
		handler: async (args, ctx) => {
			lastUIContext = ctx.ui;
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			if (sub === "stop") {
				const target = parts[1];
				if (!target) {
					ctx.ui.notify("Please specify a dispatch ID: /orchestration stop <dispatch_id>", "warning");
					return;
				}
				await execOrca(["orchestration", "worker-stop", "--dispatch", target], { cwd: ctx.cwd });
				const w = observedWorkers.get(target);
				if (w) w.status = "stopped";
				ctx.ui.notify(`Stopped worker ${target}.`, "info");
				updateStatusUI(ctx.ui);
				return;
			}

			if (sub === "release") {
				const target = parts[1];
				if (!target) {
					ctx.ui.notify("Please specify a dispatch ID: /orchestration release <dispatch_id>", "warning");
					return;
				}
				await execOrca(["orchestration", "worker-release", "--dispatch", target], { cwd: ctx.cwd });
				const w = observedWorkers.get(target);
				if (w) w.status = "released";
				ctx.ui.notify(`Released worker ${target}.`, "info");
				updateStatusUI(ctx.ui);
				return;
			}

			if (sub === "dashboard" || sub === "ui") {
				if (ctx.mode === "tui" && ctx.hasUI) {
					await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
						return new OrcaDashboardComponent(theme, getStats, () => done());
					});
				} else {
					const stats = getStats();
					ctx.ui.notify(
						`Orca Orchestration: ${stats.runningCount} running, ${stats.succeededCount} succeeded, ${stats.failedCount} failed`,
						"info",
					);
				}
				return;
			}

			if (sub === "list" || sub === "status") {
				await reconcileWorkers();
				const stats = getStats();
				const statusText = `Orca Orchestration: ${stats.isEnabled ? "Active" : "Disabled"} | Run: ${stats.activeRunId || "None"} | ${stats.runningCount} running, ${stats.succeededCount} succeeded, ${stats.failedCount} failed`;
				ctx.ui.notify(statusText, "info");
				return;
			}

			const activeTools = pi.getActiveTools();
			const isEnabled = activeTools.includes("orca_orchestration_dispatch");

			if (sub === "enable" || sub === "on") {
				if (!isEnabled) {
					pi.setActiveTools([
						...activeTools,
						"orca_orchestration_dispatch",
						"orca_orchestration_observe",
						"orca_orchestration_observe_orchestration",
						"orca_orchestration_status",
						"orca_orchestration_reply",
						"orca_orchestration_release",
					]);
				}
				ctx.ui.notify("Orca orchestration tools enabled.", "info");
			} else if (sub === "disable" || sub === "off") {
				if (isEnabled) {
					const orchTools = [
						"orca_orchestration_dispatch",
						"orca_orchestration_observe",
						"orca_orchestration_observe_orchestration",
						"orca_orchestration_status",
						"orca_orchestration_reply",
						"orca_orchestration_release",
					];
					pi.setActiveTools(activeTools.filter((t) => !orchTools.includes(t)));
				}
				ctx.ui.notify("Orca orchestration tools disabled.", "info");
			} else {
				ctx.ui.notify(
					`Unknown subcommand '${sub}'. Available: list, dashboard, stop <id>, release <id>, enable, disable`,
					"warning",
				);
			}
			updateStatusUI(ctx.ui);
		},
	});
}
