import type { ExtensionAPI, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, type ChildProcess } from "node:child_process";
import { type ExecFailure, failureText, MUTATION_TIMEOUT_MS, READ_TIMEOUT_MS, runJson, runText } from "./lib/exec.ts";
import { checkedOutBranch, repoRoot } from "./lib/git-repo.ts";
import type { Schema } from "./lib/exec-payload.ts";
import { ghHealth, isGhAvailabilityError, isGhAuthError, isNoPullRequestFailure } from "./lib/gh-health.ts";
import { ok, err, capList, parseEnvKeys } from "./lib/tool-result.ts";
import { bookkeepingAtHead, CI_CHECK_ROWS, evaluateCiVerdict, type ObservedRun } from "./lib/ci-verdict.ts";
import { logError } from "./lib/extension-log.ts";
import { commandExists, createTaskScope, mapLimited, reportBudgetViolation } from "./lib/nonblocking.ts";

const GLOBAL_GUARD_KEY = "__PI_OBSERVE_PR_EXTENSION_ACTIVE__";
// A hung gh call (network) must not wedge a poll loop or the serialized branch check. The number is the
// door's measured read timeout (lib/exec.ts, D7) rather than a value chosen per file.
const GH_TIMEOUT_MS = READ_TIMEOUT_MS;

/**
 * What `gh pr view --json` has to look like for the observer to act on it. Deliberately shallow: what is
 * caught is a payload that is not an object at all (an error page, `null`, a bare string), which used to
 * arrive three assignments later as `undefined.state`. A schema demanding every field would turn a
 * routine gh rename into a silent observer, which is the worse failure of the two.
 */
const PR_VIEW_SCHEMA: Schema = {
	type: "object",
	properties: {
		number: { type: "number" },
		state: { anyOf: [{ type: "string" }, { type: "null" }] },
		isDraft: { anyOf: [{ type: "boolean" }, { type: "null" }] },
	},
};

interface PrViewPayload {
	number?: number;
	state?: string | null;
	isDraft?: boolean | null;
	headRefOid?: string | null;
	closed?: string | null;
	mergedAt?: string | null;
	comments?: unknown[];
	/** The rollup rows are only read for `detailsUrl`, which is where the run id lives for a new run. */
	statusCheckRollup?: Array<{ detailsUrl?: string | null; [key: string]: unknown }>;
}

/** One watched run's verdict, from `gh run view --json conclusion,status,headSha`. */
const RUN_VIEW_SCHEMA: Schema = {
	type: "object",
	properties: {
		conclusion: { anyOf: [{ type: "string" }, { type: "null" }] },
		status: { anyOf: [{ type: "string" }, { type: "null" }] },
		headSha: { anyOf: [{ type: "string" }, { type: "null" }] },
	},
};

interface RunViewPayload {
	conclusion?: string | null;
	status?: string | null;
	headSha?: string | null;
}

// How long a background round may keep starting new gh calls. Boot is held to a tighter budget:
// it must never be what makes `pi` feel frozen (see extensions/lib/nonblocking.ts).
const POLL_BUDGET_MS = Number.parseInt(process.env.PI_OBSERVE_PR_POLL_BUDGET_MS ?? "", 10) || 90_000;
const BOOT_BUDGET_MS = Number.parseInt(process.env.PI_EXT_BOOT_BUDGET_MS ?? "", 10) || 5_000;
// Observed PRs polled per round (a serial round multiplies one slow call by the PR count).
const POLL_CONCURRENCY = 2;
// Budgets for the lifecycle paths Pi awaits.
const CRITICAL_BUDGET_MS: Record<string, number> = { session_start: 20, input: 10, turn_end: 20 };

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
	/**
	 * runId -> the commit that run was for (`gh run view --json headSha`). The empty-check-list
	 * fallback in checkAllCIPassed only trusts completed runs whose commit matches headSha below.
	 */
	runShas: Map<string, string>;
	/** The PR's current commit, from the poll's `headRefOid`. Undefined until the first poll lands. */
	headSha?: string;
	runProcesses: Map<string, ChildProcess>;
	rewatchTimers: Map<string, NodeJS.Timeout>;
	pollTimer?: NodeJS.Timeout;
	restartTimer?: NodeJS.Timeout;
	knownComments: Map<string, CommentInfo>;
	allPassedReported?: boolean;
	/**
	 * A CI evaluation is in flight for this PR. Not persisted: it describes a live await, and a
	 * restored observation starts with none. See checkAllCIPassed.
	 */
	ciCheckInFlight?: boolean;
	/** The agent has already been told this PR is observed (notice delivered, or the observation
	 * was explicitly started via the tool, whose result is the notification). */
	announced?: boolean;
}

/**
 * The observer's own run history for a PR, with each run's commit attached. Feeds
 * bookkeepingAtHead(), which decides which of these runs are evidence about the head commit.
 */
function observedRuns(pr: ObservedPR): ObservedRun[] {
	const runs = new Map<string, ObservedRun>();
	for (const id of pr.completedRuns) runs.set(id, { sha: pr.runShas.get(id) });
	// Written second so an id in both sets counts as the failure it cannot un-be.
	for (const id of pr.failedRuns) runs.set(id, { sha: pr.runShas.get(id), failed: true });
	return [...runs.values()];
}

const STATE_CUSTOM_TYPE = "pi_observe_pr_state";

interface PersistedObservedPR {
	prNumber: number;
	cwd: string;
	activeRuns: string[];
	seenRuns: string[];
	failedRuns: string[];
	completedRuns: string[];
	/**
	 * Optional on purpose: state written before commits were recorded still restores. Those runs
	 * keep their bookkeeping (no re-notify, no re-watch) but carry no commit, so the empty-check-list
	 * fallback stays silent for them instead of passing on evidence of unknown vintage.
	 */
	runShas?: Record<string, string>;
	// Comment bodies are omitted to keep session entries small; updatedAt-based edit detection
	// still works after a restore (pollPR tolerates a missing body on the stored entry).
	knownComments: Array<{ id: string; number: string; updatedAt?: string }>;
	allPassedReported: boolean;
	announced: boolean;
}

interface PersistedObserverState {
	v: 1;
	observed: PersistedObservedPR[];
	// PRs explicitly stopped (tool re-call, /pr_observer stop) or auto-stopped (merged/closed).
	stopped: number[];
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

	/**
	 * Required by pi-tui's `Component` (called when the theme changes or the overlay needs a full
	 * redraw). This dashboard derives every line from live state on each render() and caches nothing,
	 * so there is nothing to drop - implementing it is what keeps `ctx.ui.custom()` from throwing.
	 */
	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;
		const stats = this.getStats();

		lines.push("");
		const title = th.fg("accent", " PR Observer Dashboard ");
		const headerLine = th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 28)));
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

export default async function (pi: ExtensionAPI) {
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
	// PRs that must not be auto-observed again: stopped by the agent (/pr_observer stop, second
	// observe_pr call) or auto-stopped (merged/closed). Restored from the session on resume.
	const stoppedPRs = new Set<number>();
	const pendingAnnouncements = new Map<number, { timer: NodeJS.Timeout; delivered: boolean; prNumber: number }>();
	// PRs whose observe_pr call raced a GitHub outage: the pre-check failed for
	// availability reasons, and observation starts automatically on the first
	// successful backoff retry (which re-checks the state).
	const pendingAutoStart = new Map<number, { cwd: string }>();
	let branchPollTimer: NodeJS.Timeout | undefined;
	let lastUIContext: ExtensionUIContext | undefined;
	let lastCwd: string = process.cwd();
	let isCheckingBranches = false;
	// Bumped by resetObserverState (shutdown/restore): an in-flight branch check from a previous
	// session must not detect-and-persist into the new session's file.
	let stateGeneration = 0;
	// Announcements found by the session_start check; appended to the user's next message instead of
	// being sent as a standalone follow-up that would trigger an agent turn on startup/resume.
	const deferredAnnouncements = new Map<number, string>();
	// While a startup notice is undelivered, PR updates are discarded: the agent only hears about
	// updates that happen after it knows the PR is tracked. Released once the notice's turn starts.
	let suppressUpdates = false;
	let noticeAttached = false;
	// The PRs whose notices the attached message actually contains; agent_start marks only these
	// (a PR deferred in after the transform never rode the message and must not be marked).
	let noticeAttachedFor: Set<number> | undefined;
	// Set once a persist failure was logged; appendEntry failures are not spammed per change.
	let persistFailureLogged = false;
	// An idle user message has been received; the next agent run is that turn, even if no notice could be attached (e.g. a slash command).
	let userTurnPending = false;
	// A non-carrying input (slash, extension, queued) arrived while a notice was armed: the
	// armed prompt likely failed before its turn started, so the next agent_start does not
	// belong to the armed message and must not mark its notice delivered.
	let noticeAttachBroken = false;
	// Any agent run has started. A startup check finishing later than that falls back to the normal delayed announcement.
	let sessionHasRun = false;
	let disposed = false;

	// Every gh round this extension starts lives here, never on a path Pi awaits: the outcome lands
	// afterwards as a status line, a tracking notice or a steer message.
	const tasks = createTaskScope("observe_pr", {
		onError: (msg) => logInternal(msg),
		budgetMs: POLL_BUDGET_MS,
	});

	// Tripwire for future changes: a critical-path handler that starts awaiting I/O again is reported
	// once (file log) instead of silently stalling every boot, message or turn.
	function checkBudget(event: string, startedAt: number): void {
		reportBudgetViolation("observe_pr", event, performance.now() - startedAt, CRITICAL_BUDGET_MS[event] ?? 20, logInternal);
	}

	// A startup branch check that finishes after the user already started a turn has no message left
	// to ride on: deliver its notices the normal way rather than holding them (and the PR updates they
	// gate) back indefinitely. Before any turn started they stay deferred for the next plain message.
	function releaseLateStartupNotices(): void {
		if (disposed || !sessionHasRun || deferredAnnouncements.size === 0) return;
		// Snapshot first: a PR deferred in *during* this loop still owes the user an announcement.
		const prNumbers = Array.from(deferredAnnouncements.keys());
		// Delivering the steer settles these entries exactly the way agent_start settles a notice that
		// rode the user's message. Left in place, the next plain idle input would append the identical
		// text a second time, and since `announced` would still be false in the session file a resume
		// would defer it again for a third delivery.
		let changed = false;
		for (const prNumber of prNumbers) {
			deferredAnnouncements.delete(prNumber);
			const pr = observedPRs.get(prNumber);
			if (pr && !pr.announced) {
				pr.announced = true;
				changed = true;
			}
		}
		suppressUpdates = deferredAnnouncements.size > 0;
		if (changed) persistState();
		for (const prNumber of prNumbers) announceTracking(prNumber);
	}

	// ---- Stale-context safety -------------------------------------------
	// pi invalidates the extension runtime on session replacement/reload
	// (newSession/fork/switchSession/reload/session teardown). ExtensionAPI exposes no
	// staleness query: after invalidation every pi.* action method throws an error
	// matching STALE_MARKER. Observer background work (poll timers, long-lived `gh`
	// watchers, in-flight `gh` awaits, backoff retry hooks) outlives the context, and a
	// teardown that skips the session_shutdown event (e.g. a session dispose without a
	// shutdown emit) never runs resetObserverState() - so every pi call made from
	// background code goes through tryPi(): the first stale throw runs
	// handleStaleContext() (the same teardown session_shutdown performs, so the
	// surviving timers stop hitting the dead context), later calls are silent no-ops.
	// Errors go to the file log (extension-log), never to the console/TUI.
	const STALE_MARKER = /stale after session replacement|API is no longer active/;
	const EXT_LOG_SCOPE = "observe-pr";
	let ctxStale = false;
	let lastInterval: number | undefined;

	function isStaleError(err: unknown): boolean {
		const msg = err instanceof Error ? err.message : String(err);
		return STALE_MARKER.test(msg);
	}

	function handleStaleContext(caller: string): void {
		if (ctxStale) return;
		ctxStale = true;
		disposed = true;
		logError(
			EXT_LOG_SCOPE,
			"extension context invalidated; tearing down observer background work",
			new Error(`first stale call: ${caller}`),
		);
		try {
			// The same teardown session_shutdown performs - this path missed that event.
			resetObserverState();
			// Same as session_shutdown: without this an in-flight gh round keeps making real calls until
			// it happens to reach a guard, and its poll key stays booked in the single-flight slot.
			tasks.abort();
			ghHealth.reset();
			pendingAnnouncements.clear();
			pendingAutoStart.clear();
			deferredAnnouncements.clear();
			// session_shutdown also released the registration globals; without that the
			// next session's factory re-run would early-return (global guard) and the
			// extension would be dead until the process restarts.
			delete (globalThis as any)[GLOBAL_GUARD_KEY];
			delete (globalThis as any).__PI_OBSERVED_PRS__;
		} catch (err) {
			logError(EXT_LOG_SCOPE, "stale-context teardown failed", err);
		}
	}

	// Runs a pi action that background code may call. Stale: tear down once and return
	// the fallback (never throws, so timers and child-process callbacks cannot wedge or
	// crash the TUI process). Non-stale: rethrow for the call site's existing handling.
	function tryPi<T>(caller: string, fn: () => T, fallback: T): T {
		if (ctxStale) return fallback;
		try {
			return fn();
		} catch (err) {
			if (isStaleError(err)) {
				handleStaleContext(caller);
				return fallback;
			}
			throw err;
		}
	}

	// Guards a fire-and-forget observer promise so a rejection can never become an
	// unhandled rejection (Node's default for those is to crash the process).
	function guardAsync(what: string, p: Promise<unknown>): void {
		void p.catch((err) => {
			if (isStaleError(err)) handleStaleContext(what);
			else logError(EXT_LOG_SCOPE, `${what} failed`, err);
		});
	}

	function getObserverInterval(): number {
		// Runs inside timers and child-process callbacks: a stale context must not throw here.
		const value = tryPi(
			"getObserverInterval",
			() => {
				const flagVal = pi.getFlag("pr-observer-interval");
				const parsed = parseInt(String(flagVal || "60"), 10);
				return isNaN(parsed) || parsed <= 0 ? 60 : parsed;
			},
			0,
		);
		if (value > 0) {
			lastInterval = value;
			return value;
		}
		return lastInterval ?? 60;
	}

	// File-only log for internal errors, so failures stay silent in the TUI but remain
	// debuggable (extension-log). GitHub availability failures are handled by ghHealth
	// (silent + paced retry) and never logged here.
	// `err` is optional so this also serves as the task scope's logger, which reports a bare
	// message instead of an error object.
	function logInternal(what: string, err?: unknown) {
		logError(EXT_LOG_SCOPE, what, err);
	}

	function updateStatusUI(ui?: ExtensionUIContext) {
		const targetUI = ui || lastUIContext;
		if (!targetUI) return;

		const totalPrs = observedPRs.size;
		let totalRuns = 0;
		for (const pr of observedPRs.values()) {
			totalRuns += pr.activeRuns.size;
		}

		try {
			if (totalPrs > 0) {
				targetUI.setStatus("pr_observer", `${totalPrs}/${totalRuns} observed`);
			} else {
				targetUI.setStatus("pr_observer", undefined);
			}
		} catch (err) {
			// A dead UI must not break the child-process callback that called this.
			if (isStaleError(err)) handleStaleContext("updateStatusUI");
			else logInternal("Failed to update status UI", err);
		}
	}

	function sendAgentMessage(content: string) {
		if (suppressUpdates) return;
		try {
			// "steer" lands after the current turn's tool calls; "followUp" would wait until the agent stops calling tools.
			tryPi("sendAgentMessage", () => pi.sendUserMessage(content, { deliverAs: "steer" }), undefined);
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
		return `The PR ${prNumber} is now being observed and you will get all updates for the PR. Calling the "observe_pr" tool will stop the tracking for the PR and automatic updates`;
	}

	// Persist the full observer state as a session custom entry (last entry wins on restore).
	// Never participates in LLM context; degrades to in-process-only state if the append fails.
	function persistState() {
		if (ctxStale) return;
		try {
			const state: PersistedObserverState = {
				v: 1,
				observed: Array.from(observedPRs.values()).map((p) => ({
					prNumber: p.prNumber,
					cwd: p.cwd,
					activeRuns: Array.from(p.activeRuns),
					seenRuns: Array.from(p.seenRuns),
					failedRuns: Array.from(p.failedRuns),
					completedRuns: Array.from(p.completedRuns),
					runShas: Object.fromEntries(p.runShas),
					knownComments: Array.from(p.knownComments.values()).map((c) => ({
						id: c.id,
						number: c.number,
						updatedAt: c.updatedAt,
					})),
					allPassedReported: Boolean(p.allPassedReported),
					announced: Boolean(p.announced),
				})),
				stopped: Array.from(stoppedPRs),
			};
			pi.appendEntry(STATE_CUSTOM_TYPE, state);
		} catch (err) {
			if (isStaleError(err)) {
				// A replacement torn down without session_shutdown: self-tear-down once
				// (file-logged) so the surviving timers stop hitting the stale context.
				handleStaleContext("persistState");
			} else if (!persistFailureLogged) {
				persistFailureLogged = true;
				logError(EXT_LOG_SCOPE, "Failed to persist observer state (further failures suppressed)", err);
			}
		}
	}

	// Stop all watchers and clear every in-memory container without emitting a state entry.
	// Used on session_shutdown (state was already persisted at the last real change) and as the
	// first step of restoreState() (the incoming session's entries are the source of truth).
	function resetObserverState() {
		if (branchPollTimer) {
			clearInterval(branchPollTimer);
			branchPollTimer = undefined;
		}

		for (const pending of pendingAnnouncements.values()) {
			clearTimeout(pending.timer);
		}
		pendingAnnouncements.clear();

		for (const pr of observedPRs.values()) {
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
			pr.runProcesses.clear();
		}
		observedPRs.clear();

		// Branch/PR bookkeeping is session-scoped: a fresh session re-detects from scratch, a
		// resumed session is rebuilt by restoreState() from its persisted entries.
		stoppedPRs.clear();
		trackedBranchesByRepo.clear();
		branchToPR.clear();
		deferredAnnouncements.clear();
		suppressUpdates = false;
		noticeAttached = false;
		noticeAttachedFor = undefined;
		userTurnPending = false;
		noticeAttachBroken = false;
		sessionHasRun = false;
		// Invalidate in-flight branch checks and clear the re-entry guard so the incoming
		// session's own startup check is not skipped by a stale one.
		stateGeneration++;
		isCheckingBranches = false;
	}

	// Rebuild in-memory state from the session's latest pi_observe_pr_state entry (branch-aware,
	// so forked/navigated sessions restore the state of their own history). Observed PRs are
	// re-observed silently — the agent already knows about them — except PRs whose notice was
	// still pending when the session ended, which ride the first plain idle user message again.
	function restoreState(sessionManager?: { getBranch?: () => unknown[] }) {
		resetObserverState();

		let entries: unknown[] = [];
		try {
			entries = sessionManager?.getBranch?.() ?? [];
		} catch (err) {
			logInternal("Failed to read session branch for state restore", err);
		}

		let latest: any;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i] as any;
			if (e && e.type === "custom" && e.customType === STATE_CUSTOM_TYPE) {
				latest = e;
				break;
			}
		}
		const state = latest?.data as PersistedObserverState | undefined;
		if (!state || state.v !== 1 || !Array.isArray(state.observed)) return;

		for (const n of Array.isArray(state.stopped) ? state.stopped : []) {
			if (typeof n === "number" && n > 0) stoppedPRs.add(n);
		}

		let restored = 0;
		for (const p of state.observed) {
			// Sanity guards: reject corrupt items (including non-integer prNumbers, which would
			// bypass the type-strict Set.has dedup); a PR in both lists keeps the stopped
			// decision; a duplicate prNumber would orphan the first entry's timers.
			if (!p || typeof p.prNumber !== "number" || !Number.isInteger(p.prNumber) || p.prNumber <= 0 || typeof p.cwd !== "string") continue;
			if (stoppedPRs.has(p.prNumber) || observedPRs.has(p.prNumber)) continue;
			const pr: ObservedPR = {
				prNumber: p.prNumber,
				cwd: p.cwd,
				activeRuns: new Set(Array.isArray(p.activeRuns) ? p.activeRuns : []),
				seenRuns: new Set(Array.isArray(p.seenRuns) ? p.seenRuns : []),
				failedRuns: new Set(Array.isArray(p.failedRuns) ? p.failedRuns : []),
				completedRuns: new Set(Array.isArray(p.completedRuns) ? p.completedRuns : []),
				runShas: new Map(
					p.runShas && typeof p.runShas === "object"
						? Object.entries(p.runShas).filter((entry): entry is [string, string] => typeof entry[1] === "string")
						: [],
				),
				runProcesses: new Map(),
				rewatchTimers: new Map(),
				knownComments: new Map(
					(Array.isArray(p.knownComments) ? p.knownComments : []).map((c: any) => [
						String(c?.id),
						{ id: String(c?.id), number: String(c?.number), updatedAt: c?.updatedAt },
					]),
				),
				allPassedReported: Boolean(p.allPassedReported),
				announced: Boolean(p.announced),
			};

			observedPRs.set(pr.prNumber, pr);
			startChecksProcess(pr);
			// Tracked by the scope: single-flight per PR, aborted with the session, never on a path Pi awaits.
			pr.pollTimer = setInterval(() => {
				tasks.schedule(`poll-${pr.prNumber}`, async (signal) => {
					if (signal.aborted || disposed) return;
					await pollPR(pr.prNumber);
				});
			}, getObserverInterval() * 1000);
			// In-flight runs survive the restart: re-watching is silent for already-reported runs
			// (the watchRun close handler dedups on failedRuns/completedRuns).
			for (const runId of pr.activeRuns) {
				guardAsync("watchRun", watchRun(pr.prNumber, runId, pr.cwd));
			}

			if (!pr.announced) {
				deferredAnnouncements.set(pr.prNumber, getTrackingAnnouncement(pr.prNumber));
				suppressUpdates = true;
			}
			restored++;
		}
		if (restored > 0) {
			updateStatusUI();
		}
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
		const failedLog = await runText("gh", ["run", "view", runId, "--log-failed"], {
			cwd,
			maxBuffer: 2 * 1024 * 1024,
			timeoutMs: GH_TIMEOUT_MS,
		});
		// "log not found" is what gh says when a run's logs have expired: an answer, but not a summary.
		if (failedLog.ok && failedLog.data && !failedLog.data.includes("log not found")) {
			const lines = failedLog.data.split("\n").filter((l) => l.trim().length > 0);
			return lines.slice(-20).join("\n");
		}

		// Fallback to standard run view if log-failed is not available
		const view = await runText("gh", ["run", "view", runId], { cwd, maxBuffer: 1024 * 1024, timeoutMs: GH_TIMEOUT_MS });
		if (view.ok && view.data) return view.data;
		// A summary is a courtesy on top of a failure already reported, so a failure here is not worth
		// throwing over - but it is worth naming: "no summary available" and "gh timed out twice" are
		// different things to read in a notification.
		return view.ok ? "No failure summary available." : failureText(view) || "No failure summary available.";
	}

	async function checkAllCIPassed(prNumber: number, pr: ObservedPR) {
		if (pr.activeRuns.size !== 0) return;
		if (pr.allPassedReported) return;
		// One evaluation per PR at a time. allPassedReported is only set *after* the gh await, so the
		// interval poll and a run-completion callback can both get past it with the same empty answer
		// and announce the same pass twice - not hypothetical, it is how T4 of
		// test-observe-pr-gh-failure failed once the two aligned. Skipping is not losing: the poll asks
		// again on its next cycle, and allPassedReported stays false until a real pass.
		if (pr.ciCheckInFlight) return;
		if (!ghHealth.acquireSlot()) return;

		pr.ciCheckInFlight = true;
		try {
			// The verdict is decided by evaluateCiVerdict(), which never answers "passed" for a failed
			// `gh pr checks` call or an unusable payload. Both of those branches used to announce
			// "All CI passed" as long as one run had completed and none had failed — the most expensive
			// false green an agent can be handed. A non-pass verdict just waits for the next slot, and
			// allPassedReported stays false until there is a real pass.
			let checks: unknown;
			let failure: ExecFailure | undefined;
			// Decided from the raw error the door kept: `ghHealth` matches Node error codes and stderr text,
			// which the door's own category names are not.
			let availability = false;
			// `stale` is read only by the finally below: a stale call still releases the slot, but it
			// must not touch ghHealth (it never saw the response) or announce anything.
			let stale = false;
			// acquireSlot() to release() must be exception-safe: the singleton counts a missed release
			// as a permanently busy slot, so from then on no timer anywhere can claim a retry again.
			// The parse and the shape check happen behind the door, so a payload that is not the rows asked
			// for counts as a failed call rather than as an empty check list - which `evaluateCiVerdict`
			// reads as "nothing is knowable", the only honest answer available.
			try {
				const res = await runJson<unknown>("gh", ["pr", "checks", String(prNumber), "--json", "bucket,state"], {
					cwd: pr.cwd,
					timeoutMs: GH_TIMEOUT_MS,
					schema: CI_CHECK_ROWS,
				});
				// A stop or a resume-restore during the gh await must not let this stale call
				// deliver "All CI passed" through the replacement entry's turn.
				if (observedPRs.get(prNumber) !== pr) {
					stale = true;
					return;
				}
				if (res.ok) checks = res.data;
				else {
					failure = res;
					availability = isGhAvailabilityError(res.cause);
				}
			} finally {
				if (!stale) {
					if (failure === undefined) ghHealth.recordSuccess();
					else if (availability) ghHealth.recordFailure();
				}
				ghHealth.release();
			}

			try {
				if (failure !== undefined) {
					// A failed call carries no verdict at all. GitHub-availability failures stay silent
					// (the shared backoff re-checks); any other gh failure is logged, never reported as
					// a pass, and malformed output is treated the same way.
					if (!availability) logInternal(`Error checking CI status for PR ${prNumber}`, failureText(failure));
				} else if (
					evaluateCiVerdict({
						checks,
						ghFailed: false,
						headSha: pr.headSha,
						// Only consulted for an empty check list, and then only the runs recorded for the commit
						// being polled: a green from an earlier commit cannot pass a push that was never built, and
						// a red from an earlier commit must not strand one that was. Scoping here rather than
						// requiring one common commit across completedRuns is what keeps a long observation - which
						// accumulates runs across pushes - able to report a pass at all.
						bookkeeping: bookkeepingAtHead(pr.headSha, observedRuns(pr)),
					}) === "passed"
				) {
					pr.allPassedReported = true;
					sendAgentMessage(`All CI passed for the PR ${prNumber}.`);
					// Persisted so a session restart does not announce the same pass again.
					persistState();
				}
			} catch (err) {
				// A throwing verdict/notify path must not escape with the slot held either.
				logInternal(`Error evaluating CI status for PR ${prNumber}`, err);
			}
		} finally {
			// Every path above returns or throws out of the guarded block, including the stale-call
			// return; a flag left true would silence CI reporting for this PR forever.
			pr.ciCheckInFlight = false;
		}
	}
	// A run whose watcher died on a GitHub-availability error is re-watched on the next
	// backoff slot (one timer per run, spaced by the shared health state).
	function scheduleRewatch(prNumber: number, runId: string, cwd: string) {
		const pr = observedPRs.get(prNumber);
		if (!pr || pr.rewatchTimers.has(runId)) return;
		pr.rewatchTimers.set(
			runId,
			setTimeout(
				() => {
					pr.rewatchTimers.delete(runId);
					const current = observedPRs.get(prNumber);
					if (current && current.activeRuns.has(runId)) guardAsync("watchRun", watchRun(prNumber, runId, cwd));
				},
				Math.max(ghHealth.nextRetryInMs(), 1000),
			),
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

			// A killed-then-replaced watcher (resume, or in-process stop + re-observe) must not
			// touch the live entry: its stale exit code would misclassify the replacement's run.
			if (currentPr.runProcesses.get(runId) !== child) return;
			currentPr.runProcesses.delete(runId);

			// A run that was already reported (e.g. re-watched after a resume) keeps its
			// bookkeeping and UI state but must not notify the agent twice.
			const alreadyReported = currentPr.failedRuns.has(runId) || currentPr.completedRuns.has(runId);

			// A timed-out / errored `gh run view` must never be mistaken for a CI
			// failure: on a GitHub-availability error we stay silent and re-watch on
			// the next backoff slot instead of reporting a verdict.
			let conclusion = "unknown";
			let runSha: string | undefined;
			let viewError: unknown;
			let viewDone = false;
			if (ghHealth.acquireSlot()) {
				try {
					const res = await runJson<RunViewPayload>("gh", ["run", "view", runId, "--json", "conclusion,status,headSha"], {
						cwd,
						timeoutMs: GH_TIMEOUT_MS,
						schema: RUN_VIEW_SCHEMA,
					});
					if (res.ok) {
						conclusion = String(res.data.conclusion || "").toLowerCase();
						runSha = typeof res.data.headSha === "string" && res.data.headSha !== "" ? res.data.headSha : undefined;
						viewDone = true;
					} else {
						// `ghHealth` and the availability branch below read a gh error object, so hand them the
						// one the door kept rather than a re-wrapped sentence.
						viewError = res.cause ?? new Error(failureText(res));
					}
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

			// Re-check: a stop or a resume-restore during the gh await must not let this stale
			// close mutate (or notify through) the replacement entry.
			if (observedPRs.get(prNumber) !== currentPr) return;

			// Which commit this run belonged to, recorded with the run. A run that went green on one
			// commit is not evidence about a later push, and the watcher outlives pushes.
			if (runSha) currentPr.runShas.set(runId, runSha);

			if (isFailure) {
				currentPr.failedRuns.add(runId);
				currentPr.activeRuns.delete(runId);
				updateStatusUI();

				if (!alreadyReported) {
					const errorSummary = await getRunErrorSummary(runId, cwd);
					if (observedPRs.get(prNumber) !== currentPr) return;
					sendAgentMessage(`The CI run ${runId} failed for the pr ${prNumber}. Investigate and fix the error: ${errorSummary}`);
					// Persist the new failure so a resume does not re-watch + re-notify this run.
					persistState();
				}
			} else {
				currentPr.completedRuns.add(runId);
				currentPr.activeRuns.delete(runId);
				updateStatusUI();

				await checkAllCIPassed(prNumber, currentPr);
				// Persist the new completion so a resume does not re-notify (checkAllCIPassed
				// persists itself when it flips allPassedReported).
				if (!alreadyReported) persistState();
			}
		});
	}

	function parseCommentInfo(rawComment: any, index: number): CommentInfo {
		const url = rawComment.url || "";
		const match = url.match(/#(?:issuecomment|discussion_r|r|pullrequestreviewcomment-)(\d+)/);
		const dbId = rawComment.databaseId ? String(rawComment.databaseId) : undefined;
		const id = String(rawComment.id || dbId || index + 1);
		const commentNumber = match ? match[1] : dbId || id;

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

		const poll = await runJson<PrViewPayload>(
			"gh",
			["pr", "view", String(prNumber), "--json", "state,isDraft,closed,mergedAt,comments,statusCheckRollup,headRefOid"],
			{ cwd: pr.cwd, timeoutMs: GH_TIMEOUT_MS, schema: PR_VIEW_SCHEMA },
		);
		// A stop or a resume-restore during the gh await must not let this stale poll mutate
		// the replacement entry (or persist into the new session's file).
		if (observedPRs.get(prNumber) !== pr) {
			ghHealth.release();
			return;
		}
		try {
			if (!poll.ok) {
				// A GitHub-availability failure is silent: no log, no agent message —
				// the shared backoff retry re-polls on the next slot.
				if (!isGhAvailabilityError(poll.cause)) logInternal(`Error polling PR ${prNumber}`, failureText(poll));
				return;
			}
			const data = poll.data;

			const state = String(data.state || "").toUpperCase();
			if (state === "MERGED" || state === "CLOSED") {
				const status = state === "MERGED" ? "merged" : "canceled";
				sendAgentMessage(`Stoping observing the pr ${prNumber}. The PR was ${status}. You will no longer receive updates about this PR.`);
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

			// The commit the checks and the run watchers belong to. Not persisted: after a resume the
			// first poll lands it again, and until then the fallback has nothing to compare against and
			// stays silent, which is the correct answer rather than a stale one.
			if (typeof data.headRefOid === "string" && data.headRefOid !== "") pr.headSha = data.headRefOid;

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
							guardAsync("watchRun", watchRun(prNumber, runId, pr.cwd));
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
					// Persist the newly-seen comments so a resume does not re-announce them.
					persistState();
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
			if (poll.ok) ghHealth.recordSuccess();
			else if (isGhAvailabilityError(poll.cause)) ghHealth.recordFailure();
			ghHealth.release();
		}
	}

	function startChecksProcess(pr: ObservedPR) {
		const prNumber = pr.prNumber;
		if (!observedPRs.has(prNumber)) return;

		const interval = getObserverInterval();
		const intervalStr = String(interval);

		// While degraded, the spawn itself holds the slot (released on close), so
		// the watcher cannot run ahead of the shared backoff pacing.
		let slotHeld = false;
		if (ghHealth.status === "degraded") {
			if (!ghHealth.acquireSlot()) {
				pr.restartTimer = setTimeout(
					() => {
						const livePr = observedPRs.get(prNumber);
						if (livePr) startChecksProcess(livePr);
					},
					Math.max(ghHealth.nextRetryInMs(), 1000),
				);
				return;
			}
			slotHeld = true;
		}

		let checksProc: ChildProcess;
		try {
			checksProc = spawn("gh", ["pr", "checks", String(prNumber), "--watch", "--interval", intervalStr], {
				cwd: pr.cwd,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err) {
			if (slotHeld) ghHealth.release();
			// A missing gh binary is an availability-class error: silent + paced restart.
			// (a non-availability spawn error while healthy restarts at the normal
			// interval — 1 s would be a respawn loop)
			const ghDown = isGhAvailabilityError(err);
			if (ghDown) ghHealth.recordFailure();
			else logInternal(`Error spawning gh pr checks for PR ${prNumber}`, err);
			pr.restartTimer = setTimeout(
				() => {
					const livePr = observedPRs.get(prNumber);
					if (livePr) startChecksProcess(livePr);
				},
				ghDown || ghHealth.status === "degraded" ? Math.max(ghHealth.nextRetryInMs(), 1000) : interval * 1000,
			);
			return;
		}

		checksProc.on("error", (err) => {
			if (isGhAvailabilityError(err)) ghHealth.recordFailure();
			else logInternal(`Error in gh pr checks process for PR ${prNumber}`, err);
		});

		pr.checksProcess = checksProc;

		let lineBuffer = "";
		const handleData = (chunk: Buffer) => {
			// Identity guard: buffered output from a killed-then-replaced checks process must not
			// spawn duplicate run watchers against the live replacement entry.
			if (observedPRs.get(prNumber)?.checksProcess !== checksProc) return;
			lineBuffer += chunk.toString();
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() || "";

			for (const line of lines) {
				const runRegex = /\/actions\/runs\/(\d+)/g;
				// No assignment in the loop condition (biome noAssignInExpressions): the exec result is
				// bound inside the loop and breaks on null, which is the same iteration the old
				// `while ((match = …) !== null)` did - same regex object, same lastIndex progression.
				for (;;) {
					const match = runRegex.exec(line);
					if (match === null) break;
					const runId = match[1];
					if (!pr.seenRuns.has(runId)) {
						pr.seenRuns.add(runId);
						pr.activeRuns.add(runId);
						updateStatusUI();
						guardAsync("watchRun", watchRun(prNumber, runId, pr.cwd));
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

		checksProc.on("close", async (code) => {
			// (release before the removal check: a stop/shutdown mid-outage must not
			// wedge the shared slot — the singleton outlives this observation)
			if (slotHeld) ghHealth.release();
			// Identity guard: a killed-then-replaced watcher (resetObserverState + restore, or an
			// in-process stop + re-observe) must not poll or schedule a restart against the live
			// entry — it would spawn a second, never-collected checks watcher lineage.
			const current = observedPRs.get(prNumber);
			if (!current || current.checksProcess !== checksProc) return;
			// (code === null: the process was killed by signal, e.g. our own stop —
			// not a GitHub failure. gh exits 1/8 for failed/pending checks — those are
			// CI results, not availability: only a real availability error in the
			// stderr tail records a failure and paces the restart; every other exit
			// restarts at the normal interval, never at 1 s)
			const ghDown = code !== null && code !== 0 && isGhAvailabilityError({ code, message: errTail });
			if (ghDown) ghHealth.recordFailure();
			await pollPR(prNumber);
			// Re-check: a stop may have happened during the poll.
			const currentPr = observedPRs.get(prNumber);
			if (!currentPr || currentPr.checksProcess !== checksProc) return;
			const delay = ghDown || ghHealth.status === "degraded" ? Math.max(ghHealth.nextRetryInMs(), 1000) : interval * 1000;
			currentPr.restartTimer = setTimeout(() => {
				const livePr = observedPRs.get(prNumber);
				if (livePr) {
					startChecksProcess(livePr);
				}
			}, delay);
		});
	}

	function startObserving(
		prNumber: number,
		initialComments: readonly unknown[],
		cwd: string,
		ui?: ExtensionUIContext,
		options?: { explicit?: boolean },
	) {
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
			runShas: new Map(),
			runProcesses: new Map(),
			rewatchTimers: new Map(),
			knownComments: new Map(),
			allPassedReported: false,
			announced: false,
		};

		if (Array.isArray(initialComments)) {
			initialComments.forEach((c, idx) => {
				const info = parseCommentInfo(c, idx);
				pr.knownComments.set(info.id, info);
			});
		}

		// An explicit tool call informs the agent via its result, so no separate notice is due;
		// an explicit start also overrides a prior stop for this PR.
		if (options?.explicit) {
			pr.announced = true;
			stoppedPRs.delete(prNumber);
		}

		observedPRs.set(prNumber, pr);
		updateStatusUI(ui);

		startChecksProcess(pr);

		const interval = getObserverInterval();
		pr.pollTimer = setInterval(() => {
			tasks.schedule(`poll-${prNumber}`, async (signal) => {
				if (signal.aborted || disposed) return;
				await pollPR(prNumber);
			});
		}, interval * 1000);

		// Restore re-registers observed PRs directly (seeding the dedup sets) without going
		// through startObserving, so every call here is a real state change worth persisting.
		persistState();
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

		stoppedPRs.add(prNumber);

		const pr = observedPRs.get(prNumber);
		if (!pr) {
			// Not actively observed, but the stop is still a state change worth recording.
			persistState();
			return;
		}

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
		persistState();
	}

	/**
	 * Where this folder's repository is, and what branch it has checked out.
	 *
	 * Both lookups live in `lib/git-repo.ts` now - the same question is asked by `pr-tasks`,
	 * `devin-delegate` and `orca-client`, and this site was the one that had no deadline at all: a git
	 * with a locked index held the branch-check chain open indefinitely. The policy that is specific to
	 * the observer stays here, which is why this returns `undefined` rather than a failure:
	 *
	 *   - not a repository at all → nothing to track, so no entry;
	 *   - a repository whose branch lookup failed → keep the resolved root and report an empty branch,
	 *     because the caller only commits a non-empty branch after its generation check.
	 */
	async function recordCurrentBranch(cwd: string): Promise<{ repoRoot: string; branch: string } | undefined> {
		const root = await repoRoot(cwd, { timeoutMs: GH_TIMEOUT_MS });
		if (!root.ok) return undefined; // not a git repository
		const branch = await checkedOutBranch(cwd, { timeoutMs: GH_TIMEOUT_MS });
		// Read-only: the caller commits the branch to trackedBranchesByRepo only after its generation
		// check, so a stale check cannot inject into a reset session.
		return { repoRoot: root.value || cwd, branch: branch.ok ? branch.value || "" : "" };
	}

	async function checkTrackedBranches(cwd: string, deferAnnouncements = false, signal?: AbortSignal) {
		// A stale context must not throw here (runs from timers, the backoff retry hook and
		// turn_end): abort silently.
		const activeTools = tryPi("checkTrackedBranches", () => pi.getActiveTools(), undefined);
		if (!activeTools || !activeTools.includes("observe_pr")) return;

		// A check that outlives a session switch (resetObserverState bumps stateGeneration) must
		// not complete its detection against the new session's state or persist into its file.
		const gen = stateGeneration;
		// (a local git call — always runs, even when the gh check below is skipped or paced)
		const rec = await recordCurrentBranch(cwd);
		if (gen !== stateGeneration) return;
		if (rec && rec.branch) {
			let branches = trackedBranchesByRepo.get(rec.repoRoot);
			if (!branches) {
				branches = new Set();
				trackedBranchesByRepo.set(rec.repoRoot, branches);
			}
			branches.add(rec.branch);
		}
		if (isCheckingBranches) return;
		if (!ghHealth.acquireSlot()) return;
		isCheckingBranches = true;
		let ghErr: unknown;
		let ghCallMade = false;
		try {
			const repoRoot = rec?.repoRoot || cwd;
			const branches = trackedBranchesByRepo.get(repoRoot);
			if (!branches) return;

			for (const branch of Array.from(branches)) {
				// A superseded round stops starting work; a gh call already running ends on its own timeout.
				if (signal?.aborted || disposed) return;
				const cacheKey = `${repoRoot}:${branch}`;
				const knownPr = branchToPR.get(cacheKey);
				if (knownPr && (observedPRs.has(knownPr) || stoppedPRs.has(knownPr))) {
					continue;
				}

				try {
					ghCallMade = true;
					const res = await runJson<PrViewPayload>(
						"gh",
						["pr", "view", branch, "--json", "number,state,isDraft,comments,statusCheckRollup"],
						{ cwd: repoRoot, timeoutMs: GH_TIMEOUT_MS, schema: PR_VIEW_SCHEMA },
					);
					if (disposed) return;
					if (gen !== stateGeneration) return;
					// A branch with no PR is a normal answer (`gh pr view` says so and exits non-zero); anything
					// else it said is worth one line, because otherwise "this branch has no PR" and "gh is
					// broken" look identical forever and auto-tracking just quietly never happens.
					if (!res.ok) {
						// A GitHub-availability failure stops the scan and counts as a failure, which is what the
						// throwing version did and what the door made a choice again rather than a fall-through:
						// the remaining branches would fail the same way, the log stays quiet, the shared backoff
						// owns the retry. Reading it off `res.cause` is load-bearing, not tidiness - the `finally`
						// records a *success* for any scan that saw no failure, so a silently-continued outage
						// loop used to flip a degraded ghHealth back to healthy while gh was still unreachable
						// (review finding on `3c149dc`).
						if (isGhAvailabilityError(res.cause)) {
							ghErr = res.cause;
							break;
						}
						// A branch with no PR is a normal answer (`gh pr view` says so and exits non-zero);
						// anything else it said gets one line, because otherwise "no PR here" and "gh is
						// broken" are the same silence forever and auto-tracking quietly never happens.
						if (!isNoPullRequestFailure(failureText(res))) logInternal(`Branch check failed for ${branch}`, failureText(res));
						continue;
					}
					const data = res.data;
					const prNumber = data.number;
					const state = String(data.state || "").toUpperCase();
					const isDraft = Boolean(data.isDraft);

					if (prNumber) {
						branchToPR.set(cacheKey, prNumber);
					}

					if (state === "OPEN" && !isDraft && prNumber && !observedPRs.has(prNumber) && !stoppedPRs.has(prNumber)) {
						startObserving(prNumber, data.comments || [], repoRoot, lastUIContext);

						if (deferAnnouncements && !sessionHasRun) {
							deferredAnnouncements.set(prNumber, getTrackingAnnouncement(prNumber));
							suppressUpdates = true;
							continue;
						}

						const delay = process.env.PI_OBSERVE_PR_DELIVERY_DELAY ? parseInt(process.env.PI_OBSERVE_PR_DELIVERY_DELAY, 10) : 3500;

						const announcementTimer = setTimeout(() => {
							const pending = pendingAnnouncements.get(prNumber);
							if (pending && !pending.delivered) {
								pending.delivered = true;
								pendingAnnouncements.delete(prNumber);
								announceTracking(prNumber);
								// If announceTracking deferred the notice (startup suppression),
								// agent_start marks it announced instead.
								if (!suppressUpdates) {
									const pr = observedPRs.get(prNumber);
									if (pr && !pr.announced) {
										pr.announced = true;
										persistState();
									}
								}
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
			// Only the current generation's check owns the re-entry guard; a stale one must not
			// clear it out from under the incoming session's own startup check.
			if (gen === stateGeneration) isCheckingBranches = false;
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
			tasks.schedule("branch-check", (signal) => checkTrackedBranches(lastCwd, false, signal));
		}, interval * 1000);
	}

	pi.on("session_start", (_evt, ctx) => {
		const startedAt = performance.now();
		try {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || process.cwd();
			disposed = false;
			// session_shutdown aborts the scope and `abort` is sticky; without this a session that
			// reuses the instance would silently never branch-check, poll or re-watch again.
			tasks.resume();
			// Rebuild in-memory state from this session's persisted entries before the branch check,
			// so resumed observation is silent and stopped PRs stay stopped.
			restoreState(ctx.sessionManager);
			// Re-expose the observed map: session_shutdown deletes the global, and cross-extension
			// readers (e.g. pr-tasks) need it to exist after an in-process session switch.
			(globalThis as any).__PI_OBSERVED_PRS__ = observedPRs;
			updateStatusUI(ctx.ui);
			// Detached on purpose: Pi awaits session_start before it paints the restored transcript, so
			// branch/PR discovery may only affect the TUI after it completes (a tracking notice rides the
			// user's next plain message, or arrives as a steer message if a turn started meanwhile).
			tasks.run(
				"startup-branch-check",
				async (signal) => {
					await checkTrackedBranches(lastCwd, true, signal);
					if (!signal.aborted) releaseLateStartupNotices();
				},
				{ budgetMs: BOOT_BUDGET_MS, onError: (msg) => logInternal(msg) },
			);
			startBranchPollTimer();
			// (test hook: startup/poll work is deliberately not awaited, so tests wait for quiescence instead)
			(globalThis as any).__PI_OBSERVE_PR_FLUSH__ = (timeoutMs?: number) => tasks.flush(timeoutMs);
			checkBudget("session_start", startedAt);
		} catch (err) {
			// A stale ctx (its ui/cwd/sessionManager getters throw post-replacement) must not
			// surface as a handler error in the TUI.
			if (!isStaleError(err)) logInternal("session_start handling failed", err);
		}
	});

	pi.on("input", async (event) => {
		// performance.now(), matching checkBudget: an epoch start against the monotonic clock makes
		// the elapsed time hugely negative, so the tripwire could never fire.
		const startedAt = performance.now();
		try {
			// Skill/template commands are expanded after this event, so appending text would corrupt them.
			if (event.source === "extension") {
				if (noticeAttached) noticeAttachBroken = true;
				return { action: "continue" };
			}
			const idle = event.streamingBehavior === undefined;
			if (idle) userTurnPending = true;
			if (event.text.startsWith("/")) {
				if (noticeAttached) noticeAttachBroken = true;
				return { action: "continue" };
			}
			// Never wait for the startup branch check here: `input` is awaited before the prompt runs, so a
			// wait is the user's Enter key hanging. A notice that is not known yet simply rides the next
			// plain message, and if a turn started first it arrives as a steer message.
			// A message queued while the agent is streaming starts no new turn, so keep the notice for an idle one.
			if (!idle || deferredAnnouncements.size === 0) {
				if (noticeAttached) noticeAttachBroken = true;
				return { action: "continue" };
			}
			// Keep the notice queued until the turn actually starts, so a prompt that fails is retried with it.
			const notices = Array.from(deferredAnnouncements.values()).join("\n\n");
			noticeAttached = true;
			// A fresh arm supersedes any interposition recorded before it.
			noticeAttachBroken = false;
			// Snapshot what this message actually carries; agent_start marks only these (a PR
			// deferred in after the transform never rode the message and must not be marked).
			noticeAttachedFor = new Set(deferredAnnouncements.keys());
			return { action: "transform", text: `${event.text}\n\n${notices}`, images: event.images };
		} finally {
			// Everything the handler does is in-memory today; measuring every exit (not just the
			// transform path) is the alarm if that ever stops being true.
			checkBudget("input", startedAt);
		}
	});

	// The user's message (with the notice) is now running, so follow-ups queue behind it.
	pi.on("agent_start", () => {
		sessionHasRun = true;
		if (!noticeAttached && !userTurnPending) return;
		if (noticeAttached && !noticeAttachBroken) {
			// The notice rode on this turn: the agent has now been told about the PRs it carried.
			let changed = false;
			const markedSource = noticeAttachedFor ?? new Set(deferredAnnouncements.keys());
			for (const prNumber of markedSource) {
				const pr = observedPRs.get(prNumber);
				if (pr && !pr.announced) {
					pr.announced = true;
					changed = true;
				}
			}
			// Delete only the notices this turn delivered. A PR deferred in after the snapshot
			// (e.g. a suppressed announcement timer firing in this window) did not ride the
			// message: keep suppressing until it rides the next idle input.
			for (const prNumber of markedSource) deferredAnnouncements.delete(prNumber);
			suppressUpdates = deferredAnnouncements.size > 0;
			if (changed) persistState();
		} else {
			// A turn that started without carrying the notice (e.g. a slash command, or the armed
			// prompt failed and a non-carrying turn started instead): release suppression so
			// updates flow; any pending notice stays queued for the next idle input.
			suppressUpdates = false;
		}
		noticeAttached = false;
		noticeAttachedFor = undefined;
		userTurnPending = false;
		noticeAttachBroken = false;
	});

	async function pollAllObservedPRs(signal?: AbortSignal): Promise<void> {
		// (degraded: at most one PR gets the slot per backoff slot — a long outage
		// starves later PRs deterministically; harmless, since all calls fail alike)
		// Bounded fan-out: with several observed PRs a serial round multiplies one slow gh call.
		await mapLimited(Array.from(observedPRs.keys()), POLL_CONCURRENCY, async (prNumber) => {
			if (signal?.aborted || disposed) return;
			await pollPR(prNumber);
		});
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
			// Everything below runs while holding the one slot ghHealth grants in degraded mode, so the
			// release must survive a throw: `startObserving`/`announceTracking` sit here, and a wedged
			// `inFlight` on the process-wide singleton starves every later retry for *both* extensions.
			try {
				let ghErr: unknown;
				let data: any;
				const res = await runJson<PrViewPayload>("gh", ["pr", "view", String(prNumber), "--json", "state,isDraft,number,comments"], {
					cwd: entry.cwd,
					timeoutMs: GH_TIMEOUT_MS,
					schema: PR_VIEW_SCHEMA,
				});
				if (res.ok) data = res.data;
				// `cause`, not the envelope: `isGhAvailabilityError` matches Node error codes, and the door's
				// category name is not one of them. Passing the envelope used to classify a missing gh as "not
				// an availability problem", so a pending auto-start the user explicitly asked for was deleted
				// instead of retried on the next slot (review finding on `3c149dc`).
				else ghErr = res.cause ?? new Error(failureText(res));
				if (ghErr === undefined && data !== undefined) {
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
			} finally {
				ghHealth.release();
			}
		}
	}

	// A backoff retry slot: settle pending auto-starts first (an explicit
	// agent/user request), then poll and branch-check. Each operation acquires its
	// own slot, so at most one extension's work runs per slot.
	ghHealth.registerRetryHook(() => {
		if (disposed) return;
		// The retry runs detached too: when it succeeds it releases exactly the notifications
		// this round would have delivered.
		tasks.run(
			"backoff-retry",
			async (signal) => {
				if (signal.aborted) return;
				// Concurrent, and started on the hook's own tick. In degraded mode `ghHealth` grants a
				// single retry slot per window to whoever asks first, and each helper pairs
				// acquire/release itself: serialising these lets the first one burn the slot every round,
				// and deferring the round to a later tick loses that race to the CI watchers' respawn —
				// either way the poll stops getting retry attempts for the whole outage. This hook runs
				// from a ghHealth timer, not from a path Pi awaits, so it does not need the deferral.
				await Promise.allSettled([settlePendingAutoStarts(), pollAllObservedPRs(signal), checkTrackedBranches(lastCwd, false, signal)]);
			},
			{ onError: (msg) => logInternal(msg), immediate: true },
		);
	});

	pi.on("turn_end", async (_evt, ctx) => {
		const startedAt = performance.now();
		try {
			if (ctx?.cwd) lastCwd = ctx.cwd;
			if (ctx?.ui) lastUIContext = ctx.ui;
			// Polling is scheduled, not awaited: an awaited round keeps Pi busy after every turn,
			// while its only effects (a status line, a notification) land later anyway.
			tasks.schedule(
				"poll-round",
				async (signal) => {
					await pollAllObservedPRs(signal);
					await checkTrackedBranches(lastCwd, false, signal);
				},
				{ onError: (msg) => logInternal(msg) },
			);
			checkBudget("turn_end", startedAt);
		} catch (err) {
			// A handler error would surface as an extension error in the TUI; internal
			// failures stay in the file log.
			if (!isStaleError(err)) logInternal("turn_end check failed", err);
		}
	});

	const AUTO_TRACKING_PROMPT_MESSAGE =
		"Automatic PR tracking is enabled. Any pull request created for tracked branches will be automatically tracked and all updates will be sent to you. Do not poll for PR updates (for example by repeatedly running `gh`): while a PR is observed, the observer sends you messages for new comments, CI results and PR status changes. You may still use `gh` to read the details of a comment or CI failure you were notified about. When the PR is observed and you have no other work to do until CI finishes, end your turn and wait for those messages.\n\n" +
		"# Rules\n\n" +
		'- NEVER use "gh" sleep loops or "--track" in the bash for git updates. All CI/State/Comments updates in the PR will be automatically sent to you, but it may delay the message if you run long run bash commands with sleep loop.\n' +
		'- Only use "gh" to get specific information about coments, failing CI or extend the information passed from the widget.\n' +
		"- Is OK to end your work and wait for the updates from the CI if there are no other pending tasks until the PR is done or state changes.";

	pi.on("before_agent_start", (event) => {
		// A run started by a non-user message (e.g. pi.sendMessage(..., { triggerTurn: true }))
		// fires no input event: if a notice is still armed, the armed prompt must have died, and
		// this run must not consume the arm (same stale-arm class as the input-side interposition).
		// 'user' runs always follow an input event, so only non-user sources break the arm.
		if (event.messageType !== "user" && noticeAttached) noticeAttachBroken = true;
		// A stale context must not throw here (a replacement after this session): treat the
		// tool as unknown and leave the system prompt as it is.
		const activeTools = tryPi("before_agent_start", () => pi.getActiveTools(), undefined);
		const isEnabled = activeTools?.includes("observe_pr") ?? false;
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
			systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${AUTO_TRACKING_PROMPT_MESSAGE}` : AUTO_TRACKING_PROMPT_MESSAGE,
		};
	});

	pi.on("session_shutdown", () => {
		// resetObserverState first: a throw in any later cleanup must not leave the timers and
		// watchers alive (they would keep hitting a torn-down context).
		try {
			resetObserverState();
		} catch (err) {
			logInternal("session_shutdown reset failed", err);
		}
		disposed = true;
		deferredAnnouncements.clear();
		pendingAutoStart.clear();
		// (the singleton outlives the session: a pending retry timer or a wedged slot
		// must not carry into the next session in the same process)
		try {
			ghHealth.reset();
		} catch (err) {
			logInternal("session_shutdown ghHealth reset failed", err);
		}
		suppressUpdates = false;
		noticeAttached = false;
		userTurnPending = false;
		sessionHasRun = false;
		// Stop every gh round in flight: its results belong to the session that is going away.
		// (resetObserverState() already ran above — it is the first thing done, so a throw later in
		// this handler cannot leave timers and watchers pointing at the torn-down context.)
		tasks.abort();
		lastUIContext = undefined;
		delete (globalThis as any)[GLOBAL_GUARD_KEY];
		delete (globalThis as any).__PI_OBSERVED_PRS__;
		delete (globalThis as any).__PI_OBSERVE_PR_FLUSH__;
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
			const cleanStr = String(rawPr ?? "")
				.replace(/^#/, "")
				.trim();
			const prNumber = parseInt(cleanStr, 10);

			if (isNaN(prNumber) || prNumber <= 0) {
				return ok(`Invalid PR number: ${rawPr}`, {
					tool: "observe_pr",
					requested: String(rawPr ?? ""),
					result: "invalid_pr_number",
				});
			}

			// If the PR was auto-detected and its notice is still pending delivery (delayed timer,
			// or the startup notice queued for the next user message), cancel the notice and return
			// the usual start message without stopping observation. The tool result informs the
			// agent, so the PR counts as announced from now on.
			const pending = pendingAnnouncements.get(prNumber);
			const deferred = deferredAnnouncements.has(prNumber);
			if ((pending && !pending.delivered) || deferred) {
				if (pending) {
					clearTimeout(pending.timer);
					pendingAnnouncements.delete(prNumber);
				}
				if (deferred) {
					deferredAnnouncements.delete(prNumber);
					if (deferredAnnouncements.size === 0 && !noticeAttached) suppressUpdates = false;
				}
				const pr = observedPRs.get(prNumber);
				if (pr && !pr.announced) {
					pr.announced = true;
				}
				persistState();
				return ok(
					`Starting observing ${prNumber}. You will receive a message whenever the CI failed or finished. To stop the observation use the same tool again.`,
					{
						tool: "observe_pr",
						prNumber,
						action: "start",
						result: "pending_announcement_taken_over",
						...capList("observedPrs", Array.from(observedPRs.keys()).map(String)),
					},
				);
			}

			// If the agent calls the same tool for the same PR, stop observing
			if (observedPRs.has(prNumber)) {
				stopObserving(prNumber);
				// (a stopped observation cancels its pending auto-start too)
				pendingAutoStart.delete(prNumber);
				return ok(`Stoping observing the PR ${prNumber}. You will no longer receive updates about the CI on this PR.`, {
					tool: "observe_pr",
					prNumber,
					action: "stop",
					...capList("observedPrs", Array.from(observedPRs.keys()).map(String)),
				});
			}

			// Check PR state and draft status using gh
			const view = await runJson<PrViewPayload>(
				"gh",
				["pr", "view", String(prNumber), "--json", "state,isDraft,number,comments,statusCheckRollup"],
				{ cwd: ctx.cwd, timeoutMs: GH_TIMEOUT_MS, schema: PR_VIEW_SCHEMA },
			);
			let prData: PrViewPayload;
			if (view.ok) {
				prData = view.data;
			} else {
				// `stderr` is the half worth quoting back: the door keeps the command line - and with it any
				// reply body - out of `message`, and each branch below shows the user what gh actually said.
				const err = view.cause ?? new Error(failureText(view));
				const stderr = failureText(view);
				// An auth problem is not self-resolving: surface it (the shared backoff
				// still paces the retry). No auto-start: a permanently failing
				// auto-start would claim every backoff slot and starve the polling.
				if (isGhAuthError(err)) {
					ghHealth.recordFailure();
					const authStderr = stderr;
					return ok(`Error inspecting PR ${prNumber}: ${authStderr}`, {
						tool: "observe_pr",
						prNumber,
						result: "gh_auth_error",
					});
				}
				// A GitHub-availability failure is not reported as an error: the
				// observation starts automatically on the first successful retry.
				if (isGhAvailabilityError(err)) {
					ghHealth.recordFailure();
					pendingAutoStart.set(prNumber, { cwd: ctx.cwd });
					return ok(
						`GitHub is temporarily unreachable, so PR ${prNumber} could not be inspected. Observation will start automatically once the connection recovers.`,
						{
							tool: "observe_pr",
							prNumber,
							result: "github_unreachable",
							autoStartPending: true,
						},
					);
				}
				if (
					stderr.includes("Could not resolve") ||
					stderr.includes("not found") ||
					stderr.includes("no pull requests") ||
					stderr.includes("404")
				) {
					return ok(`PR ${prNumber} don't exist. Not possible to observe`, {
						tool: "observe_pr",
						prNumber,
						result: "pr_not_found",
					});
				}
				return ok(`Error inspecting PR ${prNumber}: ${stderr}`, {
					tool: "observe_pr",
					prNumber,
					result: "gh_failed",
					ghError: stderr.slice(0, 500),
				});
			}

			const state = String(prData.state || "").toUpperCase();
			const isDraft = Boolean(prData.isDraft);

			if (state !== "OPEN" || isDraft) {
				const reason = isDraft ? "is a draft" : `is not open (state: ${state.toLowerCase()})`;
				return ok(`PR ${prNumber} ${reason}. Only open and non-draft PRs can be observed.`, {
					tool: "observe_pr",
					prNumber,
					result: "not_observable",
					state,
					isDraft,
				});
			}

			startObserving(prNumber, prData.comments || [], ctx.cwd, ctx.ui, { explicit: true });
			// (the observation started through this explicit path: the pending
			// auto-start, if any, must not start it a second time on the next slot)
			pendingAutoStart.delete(prNumber);

			return ok(
				`Starting observing ${prNumber}. You will receive a message whenever the CI failed or finished. To stop the observation use the same tool again.`,
				{
					tool: "observe_pr",
					prNumber,
					action: "start",
					result: "observing",
					state,
					isDraft,
					...capList("observedPrs", Array.from(observedPRs.keys()).map(String)),
				},
			);
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
				// (delete the pending auto-start unconditionally: a pending-but-not-yet-observed PR
				// must stay stopped on recovery too — the user's intent is "don't observe this PR")
				pendingAutoStart.delete(targetPr);
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
					const branchesStr = stats.trackedBranches.length > 0 ? ` | Branches: ${stats.trackedBranches.join(", ")}` : "";
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
				ctx.ui.notify(`Unknown subcommand '${sub}'. Available subcommands: list, enable, disable, stop <prNumber>`, "warning");
			}
			updateStatusUI(ctx.ui);
		},
	});

	// PATH probes are async on purpose: a `which` subprocess here runs before the TUI exists, on every
	// `pi` invocation that loads this package (Pi awaits the factory before startup continues).
	// Probed together rather than one awaited after the other: two serial scans of PATH is the only
	// I/O left on the one boot path Pi still waits for.
	const [hasRequestDb, hasDestroyDb] = await Promise.all([commandExists("requestdb"), commandExists("destroydb")]);
	if (hasRequestDb) {
		pi.registerTool({
			name: "requestdb",
			label: "Request DB",
			description:
				"Creates or retrieves an isolated test database and user credentials for the current folder. Returns connection credentials (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD) in .env format.",
			parameters: Type.Object({
				new: Type.Optional(
					Type.Boolean({
						description: "If true, destroys the existing database/user for this folder and creates a fresh one (-new)",
					}),
				),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
				try {
					const args: string[] = [];
					if (params?.new) {
						args.push("-new");
					}
					const res = await runText("requestdb", args, { cwd: ctx.cwd, timeoutMs: MUTATION_TIMEOUT_MS });
					if (!res.ok) {
						const detail = [(res.stdout ?? "").trim(), (res.stderr ?? "").trim() || res.message].filter(Boolean).join("\n").trim();
						return err(`Error running requestdb:\n${detail}`, "REQUESTDB_FAILED", {
							tool: "requestdb",
							cause: res.code,
							fresh: Boolean(params?.new),
						});
					}
					const output = res.data;
					// The text carries DB_PASSWORD, so it stays out of details (details reach the session file and the UI).
					return ok(output || "Database credentials generated successfully.", {
						tool: "requestdb",
						fresh: Boolean(params?.new),
						keys: parseEnvKeys(output),
					});
				} catch (cause: any) {
					const errorMsg = (cause?.stdout || "") + "\n" + (cause?.stderr || cause?.message || String(cause));
					return err(`Error running requestdb:\n${errorMsg.trim()}`, "REQUESTDB_FAILED", {
						tool: "requestdb",
						fresh: Boolean(params?.new),
					});
				}
			},
		});
	}

	if (hasDestroyDb) {
		pi.registerTool({
			name: "destroydb",
			label: "Destroy DB",
			description: "Tears down the isolated test database and user for the current folder or all registered test databases.",
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
					const res = await runText("destroydb", args, { cwd: ctx.cwd, timeoutMs: MUTATION_TIMEOUT_MS });
					if (!res.ok) {
						const detail = [(res.stdout ?? "").trim(), (res.stderr ?? "").trim() || res.message].filter(Boolean).join("\n").trim();
						return err(`Error running destroydb:\n${detail}`, "DESTROYDB_FAILED", {
							tool: "destroydb",
							cause: res.code,
							scope: params?.all ? "all" : "folder",
							folder: params?.folder ?? ctx.cwd,
						});
					}
					const output = res.data;
					return ok(output || "Database destroyed successfully.", {
						tool: "destroydb",
						scope: params?.all ? "all" : "folder",
						folder: params?.folder ?? ctx.cwd,
					});
				} catch (cause: any) {
					const errorMsg = (cause?.stdout || "") + "\n" + (cause?.stderr || cause?.message || String(cause));
					return err(`Error running destroydb:\n${errorMsg.trim()}`, "DESTROYDB_FAILED", {
						tool: "destroydb",
						scope: params?.all ? "all" : "folder",
						folder: params?.folder ?? ctx.cwd,
					});
				}
			},
		});
	}
}
