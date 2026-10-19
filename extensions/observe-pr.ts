import type { ExtensionAPI, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { ghHealth, isGhAvailabilityError, isGhAuthError } from "./lib/gh-health.ts";

const execFileAsync = promisify(execFile);
const GLOBAL_GUARD_KEY = "__PI_OBSERVE_PR_EXTENSION_ACTIVE__";
// A hung gh call (network) must not wedge a poll loop or the serialized branch check
const GH_TIMEOUT_MS = 60_000;

function isCommandAvailable(cmd: string): boolean {
	try {
		const checkTool = process.platform === "win32" ? "where" : "which";
		execFileSync(checkTool, [cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

interface CommentInfo {
	id: string;
	number: string;
	updatedAt?: string;
	body?: string;
}

interface ObservedPR {
	prNumber: number;
	cwd: string;
	checksProcess?: ChildProcess;
	activeRuns: Set<string>;
	seenRuns: Set<string>;
	failedRuns: Set<string>;
	completedRuns: Set<string>;
	runProcesses: Map<string, ChildProcess>;
	rewatchTimers: Map<string, NodeJS.Timeout>;
	pollTimer?: NodeJS.Timeout;
	restartTimer?: NodeJS.Timeout;
	knownComments: Map<string, CommentInfo>;
	allPassedReported?: boolean;
}

interface PRObserverStats {
	isEnabled: boolean;
	interval: number;
	prs: Array<{
		prNumber: number;
		activeRuns: string[];
		completedCount: number;
		failedCount: number;
		commentsCount: number;
	}>;
	trackedBranches: string[];
	github: { status: "healthy" | "degraded"; consecutiveFailures: number; nextRetryInMs: number };
}

/** Human-readable duration for the dashboard / status ("45s", "1m 30s"). */
function formatMs(ms: number): string {
	if (ms <= 0) return "now";
	const s = Math.ceil(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rs = s % 60;
	return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
}

class PRObserverDashboardComponent {
	private theme: any;
	private getStats: () => PRObserverStats;
	private onClose: () => void;

	constructor(theme: any, getStats: () => PRObserverStats, onClose: () => void) {
		this.theme = theme;
		this.getStats = getStats;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.onClose();
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;
		const stats = this.getStats();

		lines.push("");
		const title = th.fg("accent", " PR Observer Dashboard ");
		const headerLine =
			th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 28)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		const toolStatus = stats.isEnabled ? th.fg("success", "● Enabled") : th.fg("error", "○ Disabled");
		lines.push(truncateToWidth(`  Tool status: ${toolStatus}  (Interval: ${stats.interval}s)`, width));
		lines.push("");
		const gh = stats.github;
		const ghText =
			gh.status === "degraded"
				? `unreachable — ${gh.consecutiveFailures} consecutive failure(s), next retry in ${formatMs(gh.nextRetryInMs)}`
				: "ok";
		lines.push(truncateToWidth(`  GitHub: ${th.fg(gh.status === "degraded" ? "warning" : "success", ghText)}`, width));
		lines.push("");

		if (stats.trackedBranches && stats.trackedBranches.length > 0) {
			lines.push(truncateToWidth(`  Tracked branch(es): ${th.fg("accent", stats.trackedBranches.join(", "))}`, width));
			lines.push("");
		}

		if (stats.prs.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No PRs currently being observed.")}`, width));
			lines.push(truncateToWidth(`  ${th.fg("dim", "Use the observe_pr tool to start observing a PR.")}`, width));
		} else {
			lines.push(truncateToWidth(`  ${th.fg("muted", `Observing ${stats.prs.length} PR(s):`)}`, width));
			lines.push("");

			for (const pr of stats.prs) {
				const prHeader = `  ${th.fg("accent", `#${pr.prNumber}`)}: ${pr.activeRuns.length} active run(s), ${pr.completedCount} passed, ${pr.failedCount} failed, ${pr.commentsCount} comments tracked`;
				lines.push(truncateToWidth(prHeader, width));

				if (pr.activeRuns.length > 0) {
					lines.push(truncateToWidth(`    Active run IDs: ${th.fg("warning", pr.activeRuns.join(", "))}`, width));
				}
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape or 'q' to close")}`, width));
		lines.push("");

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	// Register configurable CLI flag for watch/poll intervals
	try {
		pi.registerFlag("pr-observer-interval", {
			description: "Watch and poll interval in seconds for PR observer (default: 60)",
			type: "string",
			default: "60",
		});
	} catch {}

	// Prevent duplicate instance registration if loaded from multiple paths
	if ((globalThis as any)[GLOBAL_GUARD_KEY]) {
		return;
	}
	(globalThis as any)[GLOBAL_GUARD_KEY] = true;

	const observedPRs = new Map<number, ObservedPR>();
	(globalThis as any).__PI_OBSERVED_PRS__ = observedPRs;
	const trackedBranchesByRepo = new Map<string, Set<string>>();
	const branchToPR = new Map<string, number>();
	const autoDetectedPRs = new Set<number>();
	const pendingAnnouncements = new Map<number, { timer: NodeJS.Timeout; delivered: boolean; prNumber: number }>();
	// PRs whose observe_pr call raced a GitHub outage: the pre-check failed for
	// availability reasons, and observation starts automatically on the first
	// successful backoff retry (which re-checks the state).
	const pendingAutoStart = new Map<number, { cwd: string }>();
	let branchPollTimer: NodeJS.Timeout | undefined;
	let lastUIContext: ExtensionUIContext | undefined;
	let lastCwd: string = process.cwd();
	let isCheckingBranches = false;
	// Announcements found by the session_start check; appended to the user's next message instead of
	// being sent as a standalone follow-up that would trigger an agent turn on startup/resume.
	const deferredAnnouncements = new Map<number, string>();
	// While a startup notice is undelivered, PR updates are discarded: the agent only hears about
	// updates that happen after it knows the PR is tracked. Released once the notice's turn starts.
	let suppressUpdates = false;
	let noticeAttached = false;
	// An idle user message has been received; the next agent run is that turn, even if no notice could be attached (e.g. a slash command).
	let userTurnPending = false;
	// Any agent run has started. A startup check finishing later than that falls back to the normal delayed announcement.
	let sessionHasRun = false;
	let disposed = false;
	// The session_start branch check; the first plain user message waits briefly for it so the notice isn't missed.
	let startupCheck: Promise<void> | undefined;
	const STARTUP_CHECK_WAIT_MS = 5000;

	function getObserverInterval(): number {
		const flagVal = pi.getFlag("pr-observer-interval");
		const parsed = parseInt(String(flagVal || "60"), 10);
		return isNaN(parsed) || parsed <= 0 ? 60 : parsed;
	}

	// TUI-safe log for non-GitHub internal errors. GitHub availability failures are
	// handled by ghHealth (silent + paced retry) and never logged here.
	function logInternal(what: string, err: unknown) {
		const msg = `[observe_pr] ${what}: ${err instanceof Error ? err.message : String(err)}`;
		if (lastUIContext) {
			try {
				lastUIContext.notify(msg, "warning");
			} catch {}
		}
	}

	function updateStatusUI(ui?: ExtensionUIContext) {
		const targetUI = ui || lastUIContext;
		if (!targetUI) return;

		const totalPrs = observedPRs.size;
		let totalRuns = 0;
		for (const pr of observedPRs.values()) {
			totalRuns += pr.activeRuns.size;
		}

		if (totalPrs > 0) {
			targetUI.setStatus("pr_observer", `${totalPrs}/${totalRuns} observed`);
		} else {
			targetUI.setStatus("pr_observer", undefined);
		}
	}

	function sendAgentMessage(content: string) {
		if (suppressUpdates) return;
		try {
			// "steer" lands after the current turn's tool calls; "followUp" would wait until the agent stops calling tools.
			pi.sendUserMessage(content, { deliverAs: "steer" });
		} catch (err) {
			logInternal("Failed to send message to agent", err);
		}
	}

	// Announce a newly tracked PR; while the startup notice is still pending it joins that notice instead.
	function announceTracking(prNumber: number) {
		if (suppressUpdates) {
			deferredAnnouncements.set(prNumber, getTrackingAnnouncement(prNumber));
			return;
		}
		sendAgentMessage(getTrackingAnnouncement(prNumber));
	}

	function getTrackingAnnouncement(prNumber: number): string {
		return `The PR ${prNumber} recently created is now being observed and you will get all updates for the PR. Calling the "observe_pr" tool will stop the tracking for the PR and automatic updates`;
	}

	function getStats(): PRObserverStats {
		const activeTools = pi.getActiveTools();
		const isEnabled = activeTools.includes("observe_pr");
		const prs = Array.from(observedPRs.values()).map((p) => ({
			prNumber: p.prNumber,
			activeRuns: Array.from(p.activeRuns),
			completedCount: p.completedRuns.size,
			failedCount: p.failedRuns.size,
			commentsCount: p.knownComments.size,
		}));
		const github = {
			status: ghHealth.status,
			consecutiveFailures: ghHealth.consecutiveFailures,
			// (0 while a retry is in flight: the in-flight call is the retry)
			nextRetryInMs: ghHealth.nextRetryInMs(),
		};

		const allBranches = new Set<string>();
		for (const branches of trackedBranchesByRepo.values()) {
			for (const b of branches) {
				allBranches.add(b);
			}
		}

		return {
			isEnabled,
			interval: getObserverInterval(),
			prs,
			trackedBranches: Array.from(allBranches),
			github,
		};
	}

	async function getRunErrorSummary(runId: string, cwd: string): Promise<string> {
		try {
			const { stdout, stderr } = await execFileAsync("gh", ["run", "view", runId, "--log-failed"], {
				cwd,
				maxBuffer: 2 * 1024 * 1024,
				timeout: GH_TIMEOUT_MS,
			});
			const output = (stdout || stderr || "").trim();
			if (output && !output.includes("log not found")) {
				const lines = output.split("\n").filter((l) => l.trim().length > 0);
				return lines.slice(-20).join("\n");
			}
		} catch {
			// Fallback to standard run view if log-failed is not available
		}

		try {
			const { stdout, stderr } = await execFileAsync("gh", ["run", "view", runId], {
				cwd,
				maxBuffer: 1024 * 1024,
				timeout: GH_TIMEOUT_MS,
			});
			const output = (stdout || stderr || "").trim();
			if (output) {
				return output;
			}
		} catch (err: any) {
			return err.message || "Failed to retrieve CI run error summary";
		}

		return "No failure summary available.";
	}

	async function checkAllCIPassed(prNumber: number, pr: ObservedPR) {
		if (pr.activeRuns.size !== 0) return;
		if (pr.allPassedReported) return;
		if (!ghHealth.acquireSlot()) return;

		let stdout: string | undefined;
		let ghErr: unknown;
		try {
			const res = await execFileAsync("gh", ["pr", "checks", String(prNumber), "--json", "bucket,state"], {
				cwd: pr.cwd,
				timeout: GH_TIMEOUT_MS,
			});
			stdout = res.stdout;
		} catch (err) {
			ghErr = err;
		}
		try {
			if (stdout !== undefined) {
				const checks = JSON.parse(stdout);
				if (Array.isArray(checks) && checks.length > 0) {
					const hasPending = checks.some(
						(c: any) =>
							c.bucket === "pending" ||
							["PENDING", "IN_PROGRESS", "QUEUED"].includes(String(c.state || c.status || "").toUpperCase()),
					);
					const hasFailed = checks.some(
						(c: any) =>
							["fail", "cancel"].includes(c.bucket) ||
							["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(
								String(c.state || c.conclusion || "").toUpperCase(),
							),
					);
					const hasPassed = checks.every(
						(c: any) =>
							["pass", "skipping"].includes(c.bucket) ||
							["SUCCESS", "SKIPPED", "NEUTRAL"].includes(String(c.state || c.conclusion || "").toUpperCase()),
					);

					if (!hasPending && !hasFailed && hasPassed) {
						pr.allPassedReported = true;
						sendAgentMessage(`All CI passed for the PR ${prNumber}.`);
					}
				} else if (pr.completedRuns.size > 0 && pr.failedRuns.size === 0) {
					pr.allPassedReported = true;
					sendAgentMessage(`All CI passed for the PR ${prNumber}.`);
				}
			} else if (ghErr !== undefined && !isGhAvailabilityError(ghErr)) {
				// A non-GitHub gh failure: the run bookkeeping fallback is still meaningful
				if (pr.completedRuns.size > 0 && pr.failedRuns.size === 0) {
					pr.allPassedReported = true;
					sendAgentMessage(`All CI passed for the PR ${prNumber}.`);
				}
				logInternal(`Error checking CI status for PR ${prNumber}`, ghErr);
			}
			// A GitHub-availability failure is silent: no verdict, no message — the
			// backoff retry re-checks the state.
		} catch (err) {
			// Malformed gh output: the run bookkeeping fallback is still meaningful
			if (pr.completedRuns.size > 0 && pr.failedRuns.size === 0) {
				pr.allPassedReported = true;
				sendAgentMessage(`All CI passed for the PR ${prNumber}.`);
			}
			logInternal(`Error checking CI status for PR ${prNumber}`, err);
		} finally {
			if (ghErr === undefined) ghHealth.recordSuccess();
			else if (isGhAvailabilityError(ghErr)) ghHealth.recordFailure();
			ghHealth.release();
		}
	}

	// A run whose watcher died on a GitHub-availability error is re-watched on the next
	// backoff slot (one timer per run, spaced by the shared health state).
	function scheduleRewatch(prNumber: number, runId: string, cwd: string) {
		const pr = observedPRs.get(prNumber);
		if (!pr || pr.rewatchTimers.has(runId)) return;
		pr.rewatchTimers.set(
			runId,
			setTimeout(() => {
				pr.rewatchTimers.delete(runId);
				const current = observedPRs.get(prNumber);
				if (current && current.activeRuns.has(runId)) watchRun(prNumber, runId, cwd);
			}, Math.max(ghHealth.nextRetryInMs(), 1000)),
		);
	}

	async function watchRun(prNumber: number, runId: string, cwd: string) {
		const pr = observedPRs.get(prNumber);
		if (!pr) return;

		pr.allPassedReported = false;
		const intervalStr = String(getObserverInterval());

		let output = "";
		let child: ChildProcess;
		try {
			child = spawn("gh", ["run", "watch", runId, "--compact", "--interval", intervalStr, "--exit-status"], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			// A missing gh binary is an availability-class error: silent + paced retry
			if (isGhAvailabilityError(err)) ghHealth.recordFailure();
			else logInternal(`Error spawning gh run watch ${runId}`, err);
			scheduleRewatch(prNumber, runId, cwd);
			return;
		}

		child.on("error", (err) => {
			if (isGhAvailabilityError(err)) ghHealth.recordFailure();
			else logInternal(`Error in gh run watch process for run ${runId}`, err);
			scheduleRewatch(prNumber, runId, cwd);
		});

		pr.runProcesses.set(runId, child);

		// Keep only a rolling tail: the buffer is used for fallback heuristics
		// (substring search for "failure"/"success" in the final output) only,
		// and a long CI run can stream megabytes to gigabytes of logs — the
		// previous full accumulation grew without bound for the run's duration.
		const maxOutputTail = 65536;
		child.stdout?.on("data", (chunk) => {
			output = (output + chunk.toString()).slice(-maxOutputTail);
		});
		child.stderr?.on("data", (chunk) => {
			output = (output + chunk.toString()).slice(-maxOutputTail);
		});

		child.on("close", async (exitCode) => {
			const currentPr = observedPRs.get(prNumber);
			if (!currentPr) return;

			currentPr.runProcesses.delete(runId);

			// A timed-out / errored `gh run view` must never be mistaken for a CI
			// failure: on a GitHub-availability error we stay silent and re-watch on
			// the next backoff slot instead of reporting a verdict.
			let conclusion = "unknown";
			let viewError: unknown;
			let viewDone = false;
			if (ghHealth.acquireSlot()) {
				try {
					const { stdout } = await execFileAsync("gh", ["run", "view", runId, "--json", "conclusion,status"], {
						cwd,
						timeout: GH_TIMEOUT_MS,
					});
					const parsed = JSON.parse(stdout);
					conclusion = String(parsed.conclusion || "").toLowerCase();
					viewDone = true;
				} catch (err) {
					viewError = err;
				} finally {
					if (viewError === undefined) ghHealth.recordSuccess();
					else if (isGhAvailabilityError(viewError)) ghHealth.recordFailure();
					ghHealth.release();
				}
			}
			if (!viewDone) {
				if (viewError !== undefined && !isGhAvailabilityError(viewError)) {
					// A non-availability gh failure: fall back to the output heuristics
					if (exitCode !== 0 || output.includes("failure") || output.includes("cancelled")) {
						conclusion = "failure";
					} else if (output.includes("success") || exitCode === 0) {
						conclusion = "success";
					}
					logInternal(`Error viewing run ${runId}`, viewError);
				} else {
					// A GitHub-availability failure (or the slot was not due while
					// degraded): no verdict, silent — re-watch on the next backoff slot
					scheduleRewatch(prNumber, runId, cwd);
					return;
				}
			}

			const isFailure =
				conclusion === "failure" ||
				conclusion === "cancelled" ||
				conclusion === "timed_out" ||
				conclusion === "action_required" ||
				conclusion === "startup_failure" ||
				(exitCode !== 0 && conclusion !== "success" && conclusion !== "neutral" && conclusion !== "skipped");

			if (isFailure) {
				currentPr.failedRuns.add(runId);
				currentPr.activeRuns.delete(runId);
				updateStatusUI();

				const errorSummary = await getRunErrorSummary(runId, cwd);
				sendAgentMessage(
					`The CI run ${runId} failed for the pr ${prNumber}. Investigate and fix the error: ${errorSummary}`,
				);
			} else {
				currentPr.completedRuns.add(runId);
				currentPr.activeRuns.delete(runId);
				updateStatusUI();

				await checkAllCIPassed(prNumber, currentPr);
			}
		});
	}

	function parseCommentInfo(rawComment: any, index: number): CommentInfo {
		const url = rawComment.url || "";
		const match = url.match(/#(?:issuecomment|discussion_r|r|pullrequestreviewcomment-)(\d+)/);
		const dbId = rawComment.databaseId ? String(rawComment.databaseId) : undefined;
		const id = String(rawComment.id || dbId || index + 1);
		const commentNumber = match ? match[1] : (dbId || id);

		return {
			id,
			number: commentNumber,
			updatedAt: rawComment.updatedAt || rawComment.updated_at || rawComment.createdAt,
			body: rawComment.body,
		};
	}

	async function pollPR(prNumber: number) {
		const pr = observedPRs.get(prNumber);
		if (!pr) return;
		if (!ghHealth.acquireSlot()) return;

		let data: any;
		let ghErr: unknown;
		try {
			const { stdout } = await execFileAsync(
				"gh",
				["pr", "view", String(prNumber), "--json", "state,isDraft,closed,mergedAt,comments,statusCheckRollup"],
				{ cwd: pr.cwd, timeout: GH_TIMEOUT_MS },
			);
			data = JSON.parse(stdout);
		} catch (err) {
			ghErr = err;
		}
		try {
			if (ghErr !== undefined) {
				// A GitHub-availability failure is silent: no log, no agent message —
				// the shared backoff retry re-polls on the next slot.
				if (!isGhAvailabilityError(ghErr)) logInternal(`Error polling PR ${prNumber}`, ghErr);
				return;
			}

			const state = String(data.state || "").toUpperCase();
			if (state === "MERGED" || state === "CLOSED") {
				const status = state === "MERGED" ? "merged" : "canceled";
				sendAgentMessage(
					`Stoping observing the pr ${prNumber}. The PR was ${status}. You will no longer receive updates about this PR.`,
				);
				stopObserving(prNumber);
				if (typeof (globalThis as any).__PI_ON_PR_CLOSED_DEVIN__ === "function") {
					try {
						await (globalThis as any).__PI_ON_PR_CLOSED_DEVIN__(prNumber, state);
					} catch {}
				}
				if (typeof (globalThis as any).__PI_ON_PR_CLOSED__ === "function") {
					try {
						await (globalThis as any).__PI_ON_PR_CLOSED__(prNumber, state, pr.cwd);
					} catch {}
				}
				return;
			}

			// Check for newly triggered runs via statusCheckRollup
			if (Array.isArray(data.statusCheckRollup)) {
				for (const check of data.statusCheckRollup) {
					const url = check.detailsUrl || "";
					const match = url.match(/\/actions\/runs\/(\d+)/);
					if (match) {
						const runId = match[1];
						if (!pr.seenRuns.has(runId)) {
							pr.seenRuns.add(runId);
							pr.activeRuns.add(runId);
							updateStatusUI();
							watchRun(prNumber, runId, pr.cwd);
						}
					}
				}
			}

			// Check comments
			if (Array.isArray(data.comments)) {
				const changedNumbers: string[] = [];

				for (let i = 0; i < data.comments.length; i++) {
					const info = parseCommentInfo(data.comments[i], i);
					const existing = pr.knownComments.get(info.id);

					if (!existing) {
						changedNumbers.push(info.number);
						pr.knownComments.set(info.id, info);
					} else if (
						(info.updatedAt && existing.updatedAt && info.updatedAt !== existing.updatedAt) ||
						(info.body && existing.body && info.body !== existing.body)
					) {
						changedNumbers.push(info.number);
						pr.knownComments.set(info.id, info);
					}
				}

				if (changedNumbers.length > 0) {
					sendAgentMessage(`Comment ${changedNumbers.join(", ")} added or updated to the PR ${prNumber}.`);
				}
			}

			if (typeof (globalThis as any).__PI_ON_PR_POLL__ === "function") {
				try {
					await (globalThis as any).__PI_ON_PR_POLL__(prNumber, pr.cwd);
				} catch {}
			}

			// Verify if all runs and checks passed (gated on its own slot)
			await checkAllCIPassed(prNumber, pr);
		} finally {
			if (ghErr === undefined) ghHealth.recordSuccess();
			else if (isGhAvailabilityError(ghErr)) ghHealth.recordFailure();
			ghHealth.release();
		}
	}

	function startObserving(prNumber: number, initialComments: any[], cwd: string, ui?: ExtensionUIContext) {
		if (ui) {
			lastUIContext = ui;
		}

		const pr: ObservedPR = {
			prNumber,
			cwd,
			activeRuns: new Set(),
			seenRuns: new Set(),
			failedRuns: new Set(),
			completedRuns: new Set(),
			runProcesses: new Map(),
			rewatchTimers: new Map(),
			knownComments: new Map(),
			allPassedReported: false,
		};

		if (Array.isArray(initialComments)) {
			initialComments.forEach((c, idx) => {
				const info = parseCommentInfo(c, idx);
				pr.knownComments.set(info.id, info);
			});
		}

		observedPRs.set(prNumber, pr);
		updateStatusUI(ui);

		const interval = getObserverInterval();
		const intervalStr = String(interval);

		function startChecksProcess() {
			if (!observedPRs.has(prNumber)) return;

			// While degraded, the spawn itself holds the slot (released on close), so
			// the watcher cannot run ahead of the shared backoff pacing.
			let slotHeld = false;
			if (ghHealth.status === "degraded") {
				if (!ghHealth.acquireSlot()) {
					pr.restartTimer = setTimeout(() => {
						if (observedPRs.has(prNumber)) startChecksProcess();
					}, Math.max(ghHealth.nextRetryInMs(), 1000));
					return;
				}
				slotHeld = true;
			}

			let checksProc: ChildProcess;
			try {
				checksProc = spawn("gh", ["pr", "checks", String(prNumber), "--watch", "--interval", intervalStr], {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (err) {
				if (slotHeld) ghHealth.release();
				// A missing gh binary is an availability-class error: silent + paced restart
				if (isGhAvailabilityError(err)) ghHealth.recordFailure();
				else logInternal(`Error spawning gh pr checks for PR ${prNumber}`, err);
				pr.restartTimer = setTimeout(() => {
					if (observedPRs.has(prNumber)) startChecksProcess();
				}, Math.max(ghHealth.nextRetryInMs(), 1000));
				return;
			}

			checksProc.on("error", (err) => {
				if (isGhAvailabilityError(err)) ghHealth.recordFailure();
				else logInternal(`Error in gh pr checks process for PR ${prNumber}`, err);
			});

			pr.checksProcess = checksProc;

			let lineBuffer = "";
			const handleData = (chunk: Buffer) => {
				lineBuffer += chunk.toString();
				const lines = lineBuffer.split("\n");
				lineBuffer = lines.pop() || "";

				for (const line of lines) {
					const runRegex = /\/actions\/runs\/(\d+)/g;
					let match: RegExpExecArray | null;
					while ((match = runRegex.exec(line)) !== null) {
						const runId = match[1];
						if (!pr.seenRuns.has(runId)) {
							pr.seenRuns.add(runId);
							pr.activeRuns.add(runId);
							updateStatusUI();
							watchRun(prNumber, runId, cwd);
						}
					}
				}
			};

			checksProc.stdout?.on("data", handleData);
			// A short stderr tail so the close handler can classify the exit (a CI failure
			// must not be recorded as a GitHub failure; only a real availability error is)
			let errTail = "";
			checksProc.stderr?.on("data", (chunk: Buffer) => {
				errTail = (errTail + chunk.toString()).slice(-2000);
			});
			checksProc.stderr?.on("data", handleData);

			checksProc.on("close", (code) => {
				// (release before the removal check: a stop/shutdown mid-outage must not
				// wedge the shared slot — the singleton outlives this observation)
				if (slotHeld) ghHealth.release();
				if (!observedPRs.has(prNumber)) return;
				// (code === null: the process was killed by signal, e.g. our own stop —
				// not a GitHub failure; gh exits 1/8 for failed/pending checks — those are
				// CI results, not availability: only a real availability error in the
				// stderr tail records a failure, and the restart follows the shared
				// backoff instead of the fixed interval)
				if (code !== null && code !== 0 && isGhAvailabilityError({ code, message: errTail })) {
					ghHealth.recordFailure();
				}
				void pollPR(prNumber);
				if (!observedPRs.has(prNumber)) return;
				const delay =
					code !== 0 || ghHealth.status === "degraded"
						? Math.max(ghHealth.nextRetryInMs(), 1000)
						: interval * 1000;
				pr.restartTimer = setTimeout(() => {
					if (observedPRs.has(prNumber)) {
						startChecksProcess();
					}
				}, delay);
			});
		}

		startChecksProcess();

		pr.pollTimer = setInterval(() => {
			pollPR(prNumber);
		}, interval * 1000);
	}

	function stopObserving(prNumber: number) {
		// A PR that is no longer tracked must not be announced; stop suppressing once nothing is pending.
		deferredAnnouncements.delete(prNumber);
		if (deferredAnnouncements.size === 0 && !noticeAttached) suppressUpdates = false;

		const pending = pendingAnnouncements.get(prNumber);
		if (pending) {
			clearTimeout(pending.timer);
			pendingAnnouncements.delete(prNumber);
		}

		autoDetectedPRs.add(prNumber);

		const pr = observedPRs.get(prNumber);
		if (!pr) return;

		if (pr.pollTimer) {
			clearInterval(pr.pollTimer);
		}

		if (pr.restartTimer) {
			clearTimeout(pr.restartTimer);
		}

		if (pr.checksProcess) {
			try {
				pr.checksProcess.kill("SIGTERM");
			} catch {}
		}

		for (const proc of pr.runProcesses.values()) {
			try {
				proc.kill("SIGTERM");
			} catch {}
		}

		for (const timer of pr.rewatchTimers.values()) {
			clearTimeout(timer);
		}
		pr.rewatchTimers.clear();

		pr.runProcesses.clear();
		observedPRs.delete(prNumber);
		updateStatusUI();
	}

	function cleanupAll() {
		if (branchPollTimer) {
			clearInterval(branchPollTimer);
			branchPollTimer = undefined;
		}

		for (const pending of pendingAnnouncements.values()) {
			clearTimeout(pending.timer);
		}
		pendingAnnouncements.clear();

		for (const prNumber of Array.from(observedPRs.keys())) {
			stopObserving(prNumber);
		}

		// Branch/PR bookkeeping is session-scoped: a new session re-detects from
		// scratch. Without clearing, these accumulate across every session in one
		// process (and re-announcing after a session switch is the desired behavior).
		trackedBranchesByRepo.clear();
		branchToPR.clear();
		autoDetectedPRs.clear();
	}

	async function getRepoRoot(cwd: string): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
			const root = stdout.trim();
			return root || undefined;
		} catch {
			return undefined;
		}
	}

	async function recordCurrentBranch(cwd: string) {
		try {
			const repoRoot = (await getRepoRoot(cwd)) || cwd;
			const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd });
			const branch = stdout.trim();
			if (branch) {
				let branches = trackedBranchesByRepo.get(repoRoot);
				if (!branches) {
					branches = new Set();
					trackedBranchesByRepo.set(repoRoot, branches);
				}
				branches.add(branch);
			}
		} catch {
			// Ignore if not a git repository or detached HEAD
		}
	}

	async function checkTrackedBranches(cwd: string, deferAnnouncements = false) {
		const isEnabled = pi.getActiveTools().includes("observe_pr");
		if (!isEnabled) return;

		// (a local git call — always runs, even when the gh check below is skipped or paced)
		await recordCurrentBranch(cwd);
		if (isCheckingBranches) return;
		if (!ghHealth.acquireSlot()) return;
		isCheckingBranches = true;
		let ghErr: unknown;
		let ghCallMade = false;
		try {
			const repoRoot = (await getRepoRoot(cwd)) || cwd;
			const branches = trackedBranchesByRepo.get(repoRoot);
			if (!branches) return;

			for (const branch of Array.from(branches)) {
				const cacheKey = `${repoRoot}:${branch}`;
				const knownPr = branchToPR.get(cacheKey);
				if (knownPr && (observedPRs.has(knownPr) || autoDetectedPRs.has(knownPr))) {
					continue;
				}

				try {
					ghCallMade = true;
					const { stdout } = await execFileAsync(
						"gh",
						["pr", "view", branch, "--json", "number,state,isDraft,comments,statusCheckRollup"],
						{ cwd: repoRoot, timeout: GH_TIMEOUT_MS },
					);
					if (disposed) return;
					const data = JSON.parse(stdout);
					const prNumber = data.number;
					const state = String(data.state || "").toUpperCase();
					const isDraft = Boolean(data.isDraft);

					if (prNumber) {
						branchToPR.set(cacheKey, prNumber);
					}

					if (
						state === "OPEN" &&
						!isDraft &&
						prNumber &&
						!observedPRs.has(prNumber) &&
						!autoDetectedPRs.has(prNumber)
					) {
						autoDetectedPRs.add(prNumber);
						startObserving(prNumber, data.comments || [], repoRoot, lastUIContext);

						if (deferAnnouncements && !sessionHasRun) {
							deferredAnnouncements.set(prNumber, getTrackingAnnouncement(prNumber));
							suppressUpdates = true;
							continue;
						}

						const delay = process.env.PI_OBSERVE_PR_DELIVERY_DELAY
							? parseInt(process.env.PI_OBSERVE_PR_DELIVERY_DELAY, 10)
							: 3500;

						const announcementTimer = setTimeout(() => {
							const pending = pendingAnnouncements.get(prNumber);
							if (pending && !pending.delivered) {
								pending.delivered = true;
								pendingAnnouncements.delete(prNumber);
								announceTracking(prNumber);
							}
						}, delay);

						pendingAnnouncements.set(prNumber, {
							prNumber,
							timer: announcementTimer,
							delivered: false,
						});
					}
				} catch (err) {
					// A GitHub-availability failure stops the loop (the other calls would fail
					// the same way): silent, handled by the backoff retry.
					if (isGhAvailabilityError(err)) {
						ghErr = err;
						break;
					}
					// No PR found for branch or per-PR gh error: ignore
				}
			}
		} catch (err) {
			if (ghErr === undefined) ghErr = err;
			// GitHub-availability failures are silent; anything else is an internal error
			if (!isGhAvailabilityError(err)) logInternal("Error checking tracked branches", err);
		} finally {
			isCheckingBranches = false;
			// (only a real gh response proves reachability — a no-op check must not
			// reset the shared backoff state)
			if (ghErr !== undefined) {
				if (isGhAvailabilityError(ghErr)) ghHealth.recordFailure();
			} else if (ghCallMade) {
				ghHealth.recordSuccess();
			}
			ghHealth.release();
		}
	}

	function startBranchPollTimer() {
		if (branchPollTimer) clearInterval(branchPollTimer);
		const interval = getObserverInterval();
		branchPollTimer = setInterval(() => {
			checkTrackedBranches(lastCwd);
		}, interval * 1000);
	}

	pi.on("session_start", (_evt, ctx) => {
		lastUIContext = ctx.ui;
		lastCwd = ctx.cwd || process.cwd();
		updateStatusUI(ctx.ui);
		disposed = false;
		startupCheck = checkTrackedBranches(lastCwd, true);
		startBranchPollTimer();
	});

	pi.on("input", async (event) => {
		// Skill/template commands are expanded after this event, so appending text would corrupt them.
		if (event.source === "extension") {
			return { action: "continue" };
		}
		const idle = event.streamingBehavior === undefined;
		if (idle) userTurnPending = true;
		if (event.text.startsWith("/")) {
			return { action: "continue" };
		}
		if (startupCheck) {
			const check = startupCheck;
			startupCheck = undefined;
			let timer: NodeJS.Timeout | undefined;
			await Promise.race([
				check,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, STARTUP_CHECK_WAIT_MS);
				}),
			]);
			if (timer) clearTimeout(timer);
		}
		// A message queued while the agent is streaming starts no new turn, so keep the notice for an idle one.
		if (!idle || deferredAnnouncements.size === 0) {
			return { action: "continue" };
		}
		// Keep the notice queued until the turn actually starts, so a prompt that fails is retried with it.
		const notices = Array.from(deferredAnnouncements.values()).join("\n\n");
		noticeAttached = true;
		return { action: "transform", text: `${event.text}\n\n${notices}`, images: event.images };
	});

	// The user's message (with the notice) is now running, so follow-ups queue behind it.
	pi.on("agent_start", () => {
		sessionHasRun = true;
		if (!noticeAttached && !userTurnPending) return;
		if (noticeAttached) deferredAnnouncements.clear();
		noticeAttached = false;
		userTurnPending = false;
		suppressUpdates = false;
	});

	async function pollAllObservedPRs() {
		// (degraded: at most one PR gets the slot per backoff slot — a long outage
		// starves later PRs deterministically; harmless, since all calls fail alike)
		for (const prNumber of Array.from(observedPRs.keys())) {
			await pollPR(prNumber);
		}
	}

	async function settlePendingAutoStarts() {
		if (pendingAutoStart.size === 0) return;
		for (const [prNumber, entry] of Array.from(pendingAutoStart.entries())) {
			// (already observed through another path in the meantime: cancel it)
			if (observedPRs.has(prNumber)) {
				pendingAutoStart.delete(prNumber);
				continue;
			}
			if (!ghHealth.acquireSlot()) return; // The slot is busy; the next one settles it
			let ghErr: unknown;
			let data: any;
			try {
				const { stdout } = await execFileAsync(
					"gh",
					["pr", "view", String(prNumber), "--json", "state,isDraft,number,comments"],
					{ cwd: entry.cwd, timeout: GH_TIMEOUT_MS },
				);
				data = JSON.parse(stdout);
			} catch (err) {
				ghErr = err;
			}
			if (ghErr === undefined) {
				ghHealth.recordSuccess();
				const state = String(data.state || "").toUpperCase();
				pendingAutoStart.delete(prNumber);
				if (state === "OPEN" && !data.isDraft) {
					startObserving(prNumber, data.comments || [], entry.cwd, lastUIContext);
					announceTracking(prNumber);
				}
				// (closed/draft: nothing to observe; dropped silently)
			} else if (isGhAvailabilityError(ghErr)) {
				ghHealth.recordFailure(); // silent; the next slot retries
			} else {
				pendingAutoStart.delete(prNumber); // 404 and friends: nothing to observe
			}
			ghHealth.release();
		}
	}

	// A backoff retry slot: settle pending auto-starts first (an explicit
	// agent/user request), then poll and branch-check. Each operation acquires its
	// own slot, so at most one extension's work runs per slot.
	ghHealth.registerRetryHook(() => {
		if (disposed) return;
		void settlePendingAutoStarts();
		void pollAllObservedPRs();
		void checkTrackedBranches(lastCwd);
	});

	pi.on("turn_end", async (_evt, ctx) => {
		if (ctx?.cwd) lastCwd = ctx.cwd;
		if (ctx?.ui) lastUIContext = ctx.ui;
		await pollAllObservedPRs();
		await checkTrackedBranches(lastCwd);
	});

	const AUTO_TRACKING_PROMPT_MESSAGE =
		"Automatic PR tracking is enabled. Any pull request created for tracked branches will be automatically tracked and all updates will be sent to you. Do not poll for PR updates (for example by repeatedly running `gh`): while a PR is observed, the observer sends you messages for new comments, CI results and PR status changes. You may still use `gh` to read the details of a comment or CI failure you were notified about. When the PR is observed and you have no other work to do until CI finishes, end your turn and wait for those messages.\n\n" +
		"# Rules\n\n" +
		"- NEVER use \"gh\" sleep loops or \"--track\" in the bash for git updates. All CI/State/Comments updates in the PR will be automatically sent to you, but it may delay the message if you run long run bash commands with sleep loop.\n" +
		"- Only use \"gh\" to get specific information about coments, failing CI or extend the information passed from the widget.\n" +
		"- Is OK to end your work and wait for the updates from the CI if there are no other pending tasks until the PR is done or state changes.";

	pi.on("before_agent_start", (event) => {
		const isEnabled = pi.getActiveTools().includes("observe_pr");
		if (!isEnabled) {
			if (event.systemPromptOptions?.sections?.pr_auto_tracking) {
				delete event.systemPromptOptions.sections.pr_auto_tracking;
			}
			return;
		}

		if (event.systemPromptOptions?.sections) {
			event.systemPromptOptions.sections.pr_auto_tracking = AUTO_TRACKING_PROMPT_MESSAGE;
		}

		if (event.systemPromptOptions?.promptGuidelines) {
			if (!event.systemPromptOptions.promptGuidelines.includes(AUTO_TRACKING_PROMPT_MESSAGE)) {
				event.systemPromptOptions.promptGuidelines.push(AUTO_TRACKING_PROMPT_MESSAGE);
			}
		}

		return {
			systemPrompt: event.systemPrompt
				? `${event.systemPrompt}\n\n${AUTO_TRACKING_PROMPT_MESSAGE}`
				: AUTO_TRACKING_PROMPT_MESSAGE,
		};
	});

	pi.on("session_shutdown", () => {
		disposed = true;
		deferredAnnouncements.clear();
		pendingAutoStart.clear();
		// (the singleton outlives the session: a pending retry timer or a wedged slot
		// must not carry into the next session in the same process)
		ghHealth.reset();
		suppressUpdates = false;
		noticeAttached = false;
		userTurnPending = false;
		sessionHasRun = false;
		startupCheck = undefined;
		lastUIContext = undefined;
		delete (globalThis as any)[GLOBAL_GUARD_KEY];
		delete (globalThis as any).__PI_OBSERVED_PRS__;
		cleanupAll();
	});

	pi.registerTool({
		name: "observe_pr",
		label: "Observe PR",
		description:
			"Observe CI checks, runs, and comments for a pull request. Automatically watches runs and notifies when CI fails or finishes. Calling again on the same PR stops observation.",
		parameters: Type.Object({
			pr_number: Type.Union([Type.Number(), Type.String()], {
				description: "The pull request number to observe",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;
			const rawPr = (params as any)?.pr_number ?? (params as any)?.prNumber ?? (params as any)?.pr;
			const cleanStr = String(rawPr ?? "").replace(/^#/, "").trim();
			const prNumber = parseInt(cleanStr, 10);

			if (isNaN(prNumber) || prNumber <= 0) {
				return {
					content: [{ type: "text", text: `Invalid PR number: ${rawPr}` }],
				};
			}

			// If the PR was auto-detected and announcement is still pending delivery,
			// cancel the announcement and return the usual start message without stopping observation
			const pending = pendingAnnouncements.get(prNumber);
			if (pending && !pending.delivered) {
				clearTimeout(pending.timer);
				pendingAnnouncements.delete(prNumber);
				return {
					content: [
						{
							type: "text",
							text: `Starting observing ${prNumber}. You will receive a message whenever the CI failed or finished. To stop the observation use the same tool again.`,
						},
					],
				};
			}

			// If the agent calls the same tool for the same PR, stop observing
			if (observedPRs.has(prNumber)) {
				stopObserving(prNumber);
				// (a stopped observation cancels its pending auto-start too)
				pendingAutoStart.delete(prNumber);
				return {
					content: [
						{
							type: "text",
							text: `Stoping observing the PR ${prNumber}. You will no longer receive updates about the CI on this PR.`,
						},
					],
				};
			}

			// Check PR state and draft status using gh
			let prData: any;
			try {
				const { stdout } = await execFileAsync(
					"gh",
					["pr", "view", String(prNumber), "--json", "state,isDraft,number,comments,statusCheckRollup"],
					{ cwd: ctx.cwd, timeout: GH_TIMEOUT_MS },
				);
				prData = JSON.parse(stdout);
			} catch (err: any) {
				// An auth problem is not self-resolving: surface it (the shared backoff
				// still paces the retry). No auto-start: a permanently failing
				// auto-start would claim every backoff slot and starve the polling.
				if (isGhAuthError(err)) {
					ghHealth.recordFailure();
					const authStderr = err?.stderr || err?.message || "";
					return {
						content: [{ type: "text", text: `Error inspecting PR ${prNumber}: ${authStderr}` }],
					};
				}
				// A GitHub-availability failure is not reported as an error: the
				// observation starts automatically on the first successful retry.
				if (isGhAvailabilityError(err)) {
					ghHealth.recordFailure();
					pendingAutoStart.set(prNumber, { cwd: ctx.cwd });
					return {
						content: [
							{
								type: "text",
								text: `GitHub is temporarily unreachable, so PR ${prNumber} could not be inspected. Observation will start automatically once the connection recovers.`,
							},
						],
					};
				}
				const stderr = err?.stderr || err?.message || "";
				if (
					stderr.includes("Could not resolve") ||
					stderr.includes("not found") ||
					stderr.includes("no pull requests") ||
					stderr.includes("404")
				) {
					return {
						content: [{ type: "text", text: `PR ${prNumber} don't exist. Not possible to observe` }],
					};
				}
				return {
					content: [{ type: "text", text: `Error inspecting PR ${prNumber}: ${stderr}` }],
				};
			}

			const state = String(prData.state || "").toUpperCase();
			const isDraft = Boolean(prData.isDraft);

			if (state !== "OPEN" || isDraft) {
				const reason = isDraft ? "is a draft" : `is not open (state: ${state.toLowerCase()})`;
				return {
					content: [
						{
							type: "text",
							text: `PR ${prNumber} ${reason}. Only open and non-draft PRs can be observed.`,
						},
					],
				};
			}

			startObserving(prNumber, prData.comments || [], ctx.cwd, ctx.ui);
			// (the observation started through this explicit path: the pending
			// auto-start, if any, must not start it a second time on the next slot)
			pendingAutoStart.delete(prNumber);

			return {
				content: [
					{
						type: "text",
						text: `Starting observing ${prNumber}. You will receive a message whenever the CI failed or finished. To stop the observation use the same tool again.`,
					},
				],
			};
		},
	});

	pi.registerCommand("pr_observer", {
		description: "PR observer controls and dashboard (subcommands: list, enable, disable, stop <pr>)",
		handler: async (args, ctx) => {
			lastUIContext = ctx.ui;
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			if (sub === "stop") {
				const targetPr = parseInt(parts[1]?.replace(/^#/, "") || "", 10);
				if (isNaN(targetPr) || targetPr <= 0) {
					ctx.ui.notify("Please specify a valid PR number to stop: /pr_observer stop <prNumber>", "warning");
					return;
				}
				const pending = pendingAnnouncements.get(targetPr);
				if (pending) {
					clearTimeout(pending.timer);
					pendingAnnouncements.delete(targetPr);
				}
				if (observedPRs.has(targetPr)) {
					stopObserving(targetPr);
					ctx.ui.notify(`Stopped observing PR #${targetPr}.`, "info");
				} else {
					ctx.ui.notify(`PR #${targetPr} is not currently being observed.`, "warning");
				}
				updateStatusUI(ctx.ui);
				return;
			}

			if (sub === "list" || sub === "status" || sub === "dashboard") {
				if (ctx.mode === "tui" && ctx.hasUI) {
					await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
						return new PRObserverDashboardComponent(theme, getStats, () => done());
					});
				} else {
					const stats = getStats();
					const branchesStr =
						stats.trackedBranches.length > 0 ? ` | Branches: ${stats.trackedBranches.join(", ")}` : "";
					const statusText =
						`PR Observer: ${stats.isEnabled ? "Enabled" : "Disabled"} | ${stats.prs.length} PR(s) observed${branchesStr} (Interval: ${stats.interval}s) | ` +
						`GitHub: ${stats.github.status === "degraded" ? `unreachable (next retry in ${formatMs(stats.github.nextRetryInMs)})` : "ok"}`;
					ctx.ui.notify(statusText, "info");
				}
				return;
			}

			const activeTools = pi.getActiveTools();
			const isEnabled = activeTools.includes("observe_pr");

			if (!sub || sub === "toggle") {
				if (isEnabled) {
					pi.setActiveTools(activeTools.filter((t) => t !== "observe_pr"));
					ctx.ui.notify("observe_pr tool disabled.", "info");
				} else {
					pi.setActiveTools([...activeTools, "observe_pr"]);
					ctx.ui.notify("observe_pr tool enabled.", "info");
				}
			} else if (sub === "enable" || sub === "on") {
				if (!isEnabled) {
					pi.setActiveTools([...activeTools, "observe_pr"]);
				}
				ctx.ui.notify("observe_pr tool enabled.", "info");
			} else if (sub === "disable" || sub === "off") {
				if (isEnabled) {
					pi.setActiveTools(activeTools.filter((t) => t !== "observe_pr"));
				}
				ctx.ui.notify("observe_pr tool disabled.", "info");
			} else {
				ctx.ui.notify(
					`Unknown subcommand '${sub}'. Available subcommands: list, enable, disable, stop <prNumber>`,
					"warning",
				);
			}
			updateStatusUI(ctx.ui);
		},
	});

	if (isCommandAvailable("requestdb")) {
		pi.registerTool({
			name: "requestdb",
			label: "Request DB",
			description:
				"Creates or retrieves an isolated test database and user credentials for the current folder. Returns connection credentials (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD) in .env format.",
			parameters: Type.Object({
				new: Type.Optional(
					Type.Boolean({
						description:
							"If true, destroys the existing database/user for this folder and creates a fresh one (-new)",
					}),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
				try {
					const args: string[] = [];
					if (params?.new) {
						args.push("-new");
					}
					const { stdout, stderr } = await execFileAsync("requestdb", args, { cwd: ctx.cwd });
					const output = (stdout || stderr || "").trim();
					return {
						content: [{ type: "text", text: output || "Database credentials generated successfully." }],
					};
				} catch (err: any) {
					const errorMsg = (err?.stdout || "") + "\n" + (err?.stderr || err?.message || String(err));
					return {
						content: [{ type: "text", text: `Error running requestdb:\n${errorMsg.trim()}` }],
						isError: true,
					};
				}
			},
		});
	}

	if (isCommandAvailable("destroydb")) {
		pi.registerTool({
			name: "destroydb",
			label: "Destroy DB",
			description:
				"Tears down the isolated test database and user for the current folder or all registered test databases.",
			parameters: Type.Object({
				all: Type.Optional(
					Type.Boolean({
						description: "If true, destroys all registered test databases (--all)",
					}),
				),
				folder: Type.Optional(
					Type.String({
						description: "Optional target folder path to destroy database for (defaults to current folder)",
					}),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
				try {
					const args: string[] = [];
					if (params?.all) {
						args.push("--all");
					} else if (params?.folder) {
						args.push(params.folder);
					}
					const { stdout, stderr } = await execFileAsync("destroydb", args, { cwd: ctx.cwd });
					const output = (stdout || stderr || "").trim();
					return {
						content: [{ type: "text", text: output || "Database destroyed successfully." }],
					};
				} catch (err: any) {
					const errorMsg = (err?.stdout || "") + "\n" + (err?.stderr || err?.message || String(err));
					return {
						content: [{ type: "text", text: `Error running destroydb:\n${errorMsg.trim()}` }],
						isError: true,
					};
				}
			},
		});
	}
}
