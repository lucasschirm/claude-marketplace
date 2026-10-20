import type { ExtensionAPI, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
	fetchReviewThreads,
	getRepoCoordinates,
	replyToReviewThread,
	resolveReviewThread,
	applyCodeSuggestion,
	isStaleNodeError,
	describeGhError,
	FETCH_TIMEOUT_MS,
	type GitHubCommentNode,
} from "./lib/github-review-threads.ts";
import { ghHealth, isGhAvailabilityError, isGhAuthError } from "./lib/gh-health.ts";
import { ok, err, capList } from "./lib/tool-result.ts";
import { logError } from "./lib/extension-log.ts";
import {
	PRTasksManager,
	countTasksByStatus,
	formatTaskSummary,
	formatTaskDetail,
	formatLoopMessage,
	formatStaleNotice,
	formatTaskFileLocation,
	isListedDeadThread,
	sameReplyBody,
	toReply,
	type PRTask,
} from "./lib/pr-tasks-manager.ts";

const execFileAsync = promisify(execFile);
const GLOBAL_GUARD_KEY = "__PI_PR_TASKS_EXTENSION_ACTIVE__";
// Identical settle nudges (same unresolved tasks, no new replies) delivered before the extension
// stops blocking the agent from settling
const MAX_IDENTICAL_NUDGES = 3;

class PRTasksDashboardComponent {
	private theme: any;
	private manager: PRTasksManager;
	private onClose: () => void;

	constructor(theme: any, manager: PRTasksManager, onClose: () => void) {
		this.theme = theme;
		this.manager = manager;
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
		const tasks = this.manager.getAllTasks();
		const counts = this.manager.getCounts();

		lines.push("");
		const title = th.fg("accent", " PR Review Conversation Tasks ");
		const headerLine =
			th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 36)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		const statusSummary = `  Total: ${counts.total}  |  ${th.fg("warning", `Open: ${counts.open}`)}  |  ${th.fg(
			"error",
			`Blocked: ${counts.blocked}`,
		)}  |  ${th.fg("success", `Resolved: ${counts.resolved}`)}  |  ${th.fg("dim", `Stale: ${counts.stale}`)}`;
		lines.push(truncateToWidth(statusSummary, width));
		lines.push("");

		if (tasks.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No PR conversation tasks tracked.")}`, width));
		} else {
			for (const task of tasks) {
				let statusColor = "warning";
				if (task.status === "RESOLVED") statusColor = "success";
				if (task.status === "BLOCKED") statusColor = "error";
				if (task.status === "STALE") statusColor = "dim";

				const statusBadge = th.fg(statusColor as any, `[${task.status}]`);
				const taskHeader = `  ${statusBadge} Task #${task.conversationId} (${formatTaskFileLocation(task)})`;
				lines.push(truncateToWidth(taskHeader, width));

				const snippet = task.message.split("\n")[0] || "";
				lines.push(truncateToWidth(`    ${th.fg("muted", snippet)}`, width));
				lines.push(
					truncateToWidth(
						`    Author: ${task.author} | Replies: ${task.replies.length} | Suggestion: ${
							task.hasSuggestion ? "Yes" : "No"
						}`,
						width,
					),
				);
				lines.push("");
			}
		}

		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape or 'q' to close")}`, width));
		lines.push("");

		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	if ((globalThis as any)[GLOBAL_GUARD_KEY]) {
		return;
	}
	(globalThis as any)[GLOBAL_GUARD_KEY] = true;

	// (the reopen grace can be lowered for tests that re-open a conversation right after resolving it)
	const graceEnv = Number.parseInt(process.env.PI_PR_TASKS_REOPEN_GRACE_MS ?? "", 10);
	const manager = new PRTasksManager(Number.isNaN(graceEnv) ? {} : { reopenGraceMs: graceEnv });
	let lastUIContext: ExtensionUIContext | undefined;
	let lastCwd: string = process.cwd();
	let syncAllInFlight: { run: Promise<void>; cwd: string; explicitPr?: number } | undefined;
	let lastSettleNudgeTime = 0;
	let lastNudgeSignature = "";
	let identicalNudgeCount = 0;
	let sessionId = 0; // bumped on shutdown, so a sync still in flight then is dropped
	let prTasksShutdown = false; // a retry must not outlive the session's shutdown

	// ---- Stale-context safety (same pattern as observe-pr) ------------------
	// pi invalidates the extension runtime on session replacement/reload. ExtensionAPI
	// exposes no staleness query: after invalidation every pi.* action method throws an
	// error matching STALE_MARKER. pr-tasks' background work (in-flight syncAllPRs
	// continuations, the ghHealth backoff retry hook) outlives the context, and a
	// teardown that skips the session_shutdown event never runs its cleanup - so every
	// pi call made from background code goes through tryPi(): the first stale throw
	// runs handleStaleContext() (the same teardown session_shutdown performs, so the
	// surviving work stops hitting the dead context), later calls are silent no-ops.
	// Errors go to the file log (extension-log), never to the console/TUI.
	const STALE_MARKER = /stale after session replacement|API is no longer active/;
	const EXT_LOG_SCOPE = "pr-tasks";
	let ctxStale = false;

	function isStaleError(err: unknown): boolean {
		const msg = err instanceof Error ? err.message : String(err);
		return STALE_MARKER.test(msg);
	}

	function handleStaleContext(caller: string): void {
		if (ctxStale) return;
		ctxStale = true;
		logError(EXT_LOG_SCOPE, "extension context invalidated; tearing down pr-tasks background work", new Error(`first stale call: ${caller}`));
		try {
			// The same teardown session_shutdown performs - this path missed that event.
			sessionId++; // drop syncs still in flight (syncPROrThrow's session check)
			prTasksShutdown = true;
			syncAllInFlight = undefined;
			ghHealth.reset();
			manager.clear();
			lastNudgeSignature = "";
			identicalNudgeCount = 0;
			// session_shutdown also released the registration globals; without that the
			// next session's factory re-run would early-return and pr-tasks would be
			// dead until the process restarts.
			delete (globalThis as any)[GLOBAL_GUARD_KEY];
			delete (globalThis as any).__PI_ON_PR_POLL__;
			delete (globalThis as any).__PI_ON_PR_CLOSED__;
		} catch (err) {
			logError(EXT_LOG_SCOPE, "stale-context teardown failed", err);
		}
	}

	// Runs a pi action that background code may call. Stale: tear down once and return
	// the fallback (never throws, so event-handler continuations cannot surface as TUI
	// extension errors). Non-stale: rethrow for the call site's existing handling.
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

	function updateStatusUI(ui?: ExtensionUIContext) {
		const targetUI = ui || lastUIContext;
		if (!targetUI) return;

		const counts = manager.getCounts();
		try {
			const staleNote = counts.stale > 0 ? ` / ${counts.stale} stale` : "";
			if (counts.total > 0) {
				targetUI.setStatus(
					"pr_tasks",
					`PR Tasks: ${counts.open} open / ${counts.blocked} blocked / ${counts.resolved} resolved${staleNote}`,
				);
			} else {
				targetUI.setStatus("pr_tasks", undefined);
			}
		} catch (err) {
			// A dead UI must not break the event-handler continuation that called this.
			if (isStaleError(err)) handleStaleContext("updateStatusUI");
			else logInternal(`[pr_tasks] Failed to update status UI: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// File-only log for internal errors, so failures stay silent in the TUI but remain
	// debuggable (extension-log). GitHub availability failures are handled by ghHealth
	// (silent + paced retry) and never logged here.
	function logInternal(msg: string) {
		logError(EXT_LOG_SCOPE, msg);
	}

	function sendAgentMessage(content: string) {
		try {
			tryPi("sendAgentMessage", () => pi.sendUserMessage(content, { deliverAs: "steer" }), undefined);
		} catch (err) {
			logInternal(`[pr_tasks] Failed to send message to agent: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	type SyncTarget = { prNumber: number; cwd?: string; repo?: string };

	function getObservedPRs(): SyncTarget[] {
		const observedMap = (globalThis as any).__PI_OBSERVED_PRS__;
		if (observedMap && typeof observedMap.entries === "function") {
			// (each from observe-pr's folder for it, so it resolves to its own repository)
			return Array.from(observedMap.entries() as Iterable<[number, any]>).map(([prNumber, pr]) => ({
				prNumber,
				cwd: typeof pr?.cwd === "string" ? pr.cwd : undefined,
			}));
		}
		return [];
	}

	async function detectCurrentBranchPR(cwd: string): Promise<number | undefined> {
		if (!ghHealth.acquireSlot()) return undefined;
		let ghErr: unknown;
		let number: number | undefined;
		try {
			const { stdout } = await execFileAsync("gh", ["pr", "view", "--json", "number"], { cwd, timeout: FETCH_TIMEOUT_MS });
			const parsed = JSON.parse(stdout);
			if (parsed?.number) number = parsed.number;
		} catch (err) {
			ghErr = err;
		} finally {
			if (ghErr === undefined) ghHealth.recordSuccess();
			else if (isGhAvailabilityError(ghErr)) ghHealth.recordFailure();
			ghHealth.release();
		}
		return number;
	}

	async function getTargetPRs(cwd: string, explicitPr?: number): Promise<SyncTarget[]> {
		if (explicitPr !== undefined) {
			// The current folder's PR, plus any tracked or observed PR with that number in its own folder
			const known = [...manager.getPRsToSync(), ...getObservedPRs()].filter((t) => t.prNumber === explicitPr);
			return [{ prNumber: explicitPr, cwd }, ...known];
		}
		// PRs with open tasks stay synced even when no longer observed (e.g. observe-pr stopped after
		// a merge), so their tasks can't keep nudging from cached state
		// (STALE ones too: they recover only through a sync that lists their thread again)
		const tracked = manager.getPRsToSync();
		const observed = getObservedPRs();
		const detected = observed.length > 0 ? undefined : await detectCurrentBranchPR(cwd);
		const current = observed.length > 0 ? observed : detected !== undefined ? [{ prNumber: detected, cwd }] : [];
		return [...current, ...tracked];
	}

	/**
	 * The folder to reach a task's (or PR's) repository from: its recorded folder while it exists.
	 * When that was removed (e.g. a deleted worktree), the fallback is used only if it is the same
	 * repository, so another repo's PR with the same number is never synced (or acted on) instead.
	 */
	async function folderFor(target: { cwd?: string; repo?: string }, fallback: string): Promise<string | undefined> {
		if (target.cwd && existsSync(target.cwd)) return target.cwd;
		// (a removed folder of unknown repository, e.g. an observed PR's, may be any repo: never replaced)
		if (!target.repo) return target.cwd ? undefined : fallback;
		// (degraded: a cold `gh repo view` would wait out its timeout; the retry covers it)
		if (ghHealth.status === "degraded") return undefined;
		try {
			const coords = await getRepoCoordinates(fallback);
			return `${coords.owner}/${coords.repo}` === target.repo ? fallback : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * The folder to act on a task from (see folderFor); throws when its repository has no local checkout.
	 */
	async function taskFolder(task: PRTask, fallback: string): Promise<string> {
		const folder = await folderFor(task, fallback);
		if (!folder) throw new Error(`no local checkout of ${task.repo} is available`);
		return folder;
	}

	async function syncPR(prNumber: number, cwd: string): Promise<void> {
		// Paced by the shared GitHub health state: while degraded with the retry slot
		// not yet due, the sync is skipped (the scheduled retry covers it) instead of
		// waiting out 60 s per PR.
		if (!ghHealth.acquireSlot()) return;
		let ghErr: unknown;
		try {
			await syncPROrThrow(prNumber, cwd);
		} catch (err) {
			ghErr = err;
			// A GitHub-availability failure is silent; the backoff retry re-syncs. A
			// non-GitHub error is still worth a TUI-safe warning.
			if (!isGhAvailabilityError(err)) {
				logInternal(`[pr_tasks] Failed to sync review threads for PR ${prNumber}: ${describeGhError(err)}`);
			}
		} finally {
			if (ghErr === undefined) ghHealth.recordSuccess();
			else if (isGhAvailabilityError(ghErr)) ghHealth.recordFailure();
			ghHealth.release();
		}
	}

	async function syncPROrThrow(prNumber: number, cwd: string): Promise<void> {
		// Syncs overlap (tools, turn_end, observe-pr polls): the tick lets the manager order them
		const fetchedAt = manager.beginFetch();
		const session = sessionId;
		const threads = await fetchReviewThreads(prNumber, cwd);
		const coords = await getRepoCoordinates(cwd); // (cached by fetchReviewThreads)
		// (thrown, so an action waiting on this refresh doesn't go on from discarded state)
		if (session !== sessionId) throw new Error("the session shut down while syncing");
		const { unblockedTasks, repostedTasks, staleTasks } = manager.syncFromGitHubThreads(prNumber, threads, fetchedAt, {
			repo: `${coords.owner}/${coords.repo}`,
			cwd,
		});

		// Check for unblocked tasks that received user replies
		for (const { task, latestReply } of unblockedTasks) {
			const unblockMsg = `The task ${task.conversationId} you blocked received a reply from the user. use the **pr_task_detail** if you need more details about the task. ${latestReply.body}`;
			// (dropped if the action held up meanwhile showed the agent that reply)
			noticeAfterActions(task, unblockMsg, () => Boolean(task.seenReplies?.includes(latestReply.id)));
		}
		for (const task of repostedTasks) {
			noticeAfterActions(
				task,
				`The task ${task.conversationId} you blocked was re-posted by the reviewer, so it is open again. use the **pr_task_detail** to see the comment.`,
			);
		}
		// Reported once, on the transition (a task with an action in flight is reported by that action)
		const newlyStale = staleTasks.filter((t) => !taskLocks.has(t));
		if (newlyStale.length > 0) sendAgentMessage(formatStaleNotice(newlyStale));

		updateStatusUI();
	}

	const taskLocks = new WeakMap<PRTask, Promise<unknown>>();
	const heldNotices = new WeakMap<PRTask, Array<{ message: string; shown?: () => boolean }>>();

	/**
	 * Sends a notice about a task, holding it while an action on the task is in flight (e.g. the
	 * reply of a /tasks resolve unblocking it): it is sent once the action is done, unless the task
	 * ended up resolved or `shown` reports the action already showed the agent what it is about.
	 */
	function noticeAfterActions(task: PRTask, message: string, shown?: () => boolean): void {
		if (taskLocks.has(task)) heldNotices.set(task, [...(heldNotices.get(task) || []), { message, shown }]);
		else sendAgentMessage(message);
	}
	let suggestionEdits: Promise<void> = Promise.resolve();

	/**
	 * Runs actions on one task one at a time, so overlapping calls (parallel tool calls, or a
	 * /tasks command during the agent's call) see each other's replies instead of both posting.
	 */
	async function withTaskLock<T>(task: PRTask, fn: () => Promise<T>): Promise<T> {
		const run = (taskLocks.get(task) ?? Promise.resolve()).catch(() => {}).then(fn);
		taskLocks.set(task, run);
		try {
			return await run;
		} finally {
			if (taskLocks.get(task) === run) {
				taskLocks.delete(task);
				const held = heldNotices.get(task) || [];
				heldNotices.delete(task);
				// (notices that a task is open again, so only while it still is)
				if (task.status === "UNRESOLVED") {
					for (const { message, shown } of held) if (!shown?.()) sendAgentMessage(message);
				}
			}
		}
	}

	// gone: a resolved task whose thread is no longer listed (e.g. a STALE task the agent cleared)
	type UpstreamState = "already_resolved" | "stale" | "gone";
	type ThreadReplyOutcome = { kind: "replied"; comment: GitHubCommentNode } | { kind: UpstreamState };

	/**
	 * Source-of-truth check before acting on a task: re-syncs its PR so a conversation resolved
	 * upstream, or a replaced thread node (e.g. after a PR merge), is reflected in the task.
	 * Throws when GitHub can't be checked, so nothing is acted on from cached state.
	 *
	 * A task STALE on a thread ID GitHub rejected but still lists is not reported as "stale":
	 * acting on it is a real attempt, which re-syncs and follows a replacement node if one is
	 * listed by then (see withCurrentThread).
	 */
	async function refreshTask(task: PRTask, cwd: string): Promise<UpstreamState | undefined> {
		// (degraded with the slot not yet due: use the cached state — at most one
		// backoff interval old; the background retry re-syncs, and the mutation's own
		// gh call is the connectivity test then)
		if (ghHealth.acquireSlot()) {
			try {
				await syncPROrThrow(task.prNumber, cwd);
				ghHealth.recordSuccess();
			} catch (err) {
				if (isGhAuthError(err)) {
					// (not self-resolving: surface it instead of a "temporarily unreachable" note)
					ghHealth.recordFailure();
					throw new Error(`GitHub authentication failed: ${describeGhError(err)}`);
				}
				if (isGhAvailabilityError(err)) {
					// Silent for the failure itself; the caller shows the concise message
					ghHealth.recordFailure();
					throw new Error("GitHub is temporarily unreachable, so the conversation state could not be checked (the extension is retrying in the background); try again later");
				}
				throw new Error(`could not check the conversation on GitHub: ${describeGhError(err)}`);
			} finally {
				ghHealth.release();
			}
		}
		// (checked first: even /tasks reply, which may post to a resolved conversation, can't post there)
		if (task.status === "RESOLVED" && !task.isListed) return "gone";
		if (task.isResolvedUpstream) return "already_resolved";
		if (task.status === "STALE" && !isListedDeadThread(task)) return "stale";
		return undefined;
	}

	/**
	 * Whether a refreshed task's upstream state rules out posting to its thread.
	 */
	function blocksPosting(state: UpstreamState, allowResolved = false): boolean {
		return state === "stale" || state === "gone" || (state === "already_resolved" && !allowResolved);
	}

	type ThreadAttempt<T> = { ok: true; value: T } | { ok: false; state: UpstreamState | "dead"; error: unknown };

	/**
	 * Runs a mutation against the task's current thread ID. If GitHub rejects the ID as
	 * unresolvable, re-syncs (preferring a live node for the same conversation) and retries once on
	 * the re-linked thread. "dead" means GitHub still rejects the only thread the task can use.
	 */
	async function withCurrentThread<T>(
		task: PRTask,
		cwd: string,
		op: (threadId: string) => Promise<T>,
		{ allowResolved = false } = {},
	): Promise<ThreadAttempt<T>> {
		const staleThreadId = task.threadId;
		let lastError: unknown;
		const attempt = async (threadId: string): Promise<ThreadAttempt<T>> => {
			const value = await op(threadId);
			manager.threadAccepted(task, threadId);
			return { ok: true, value };
		};
		try {
			return await attempt(staleThreadId);
		} catch (err) {
			if (!isStaleNodeError(err)) throw err;
			lastError = err;
		}

		// Flag the rejected ID first, so a re-sync that still lists it prefers the live node
		manager.markDeadThread(task);
		const upstream = await refreshTask(task, cwd);
		if (upstream && blocksPosting(upstream, allowResolved)) return { ok: false, state: upstream, error: lastError };
		if (task.threadId !== staleThreadId) {
			try {
				return await attempt(task.threadId);
			} catch (err) {
				if (!isStaleNodeError(err)) throw err;
				lastError = err;
			}
		}
		return { ok: false, state: "dead", error: lastError };
	}

	/**
	 * Marks a task STALE because GitHub keeps rejecting its thread ID (a resolved task stays resolved).
	 */
	function markThreadDead(task: PRTask, error: unknown): UpstreamState {
		if (task.status === "RESOLVED") return "gone";
		manager.markStale(task, `Review thread ${task.threadId} no longer resolves on GitHub (${describeGhError(error)}).`, {
			deadThread: true,
		});
		return "stale";
	}

	/**
	 * Replies to the task's review thread, following a replaced thread node (see withCurrentThread)
	 * and marking the task STALE when no usable thread is left. Call `refreshTask` first so upstream
	 * state is checked before posting. `own: false` marks a reply written by the user (via
	 * /tasks reply), which may unblock the task.
	 */
	async function replyToTaskThread(
		task: PRTask,
		body: string,
		cwd: string,
		{ allowResolved = false, own = true } = {},
	): Promise<ThreadReplyOutcome> {
		// A sync finishing before the reply call returns must not take the reply for a user's
		const forget = own ? manager.expectOwnReply(task, body) : undefined;
		let attempt: ThreadAttempt<GitHubCommentNode>;
		try {
			attempt = await withCurrentThread(task, cwd, (threadId) => replyToReviewThread(threadId, body, cwd), {
				allowResolved,
			});
		} finally {
			forget?.();
		}
		if (!attempt.ok) {
			return { kind: attempt.state === "dead" ? markThreadDead(task, attempt.error) : attempt.state };
		}

		const comment = attempt.value;
		// The agent's own replies are recorded so they never count as a user reply that unblocks the task
		if (own) manager.addReply(task, toReply(comment));
		return { kind: "replied", comment };
	}

	/**
	 * Resolves the task's thread on GitHub (after its reply was posted) and marks the task resolved,
	 * following a replaced thread node (see withCurrentThread).
	 */
	async function resolveTaskThread(task: PRTask, cwd: string): Promise<void> {
		const alreadyPosted = " (the reply was already posted)";
		let attempt: ThreadAttempt<boolean>;
		try {
			attempt = await withCurrentThread(task, cwd, (threadId) => resolveReviewThread(threadId, cwd));
		} catch (err) {
			throw new Error(`${describeGhError(err)}${alreadyPosted}`);
		}

		if (!attempt.ok) {
			const state = attempt.state === "dead" ? markThreadDead(task, attempt.error) : attempt.state;
			if (state === "already_resolved" || state === "gone") {
				// (the sync already recorded GitHub's resolve, or the task was resolved locally meanwhile)
				if (task.status !== "RESOLVED") manager.markResolved(task);
				return;
			}
			throw new Error(`its review thread no longer exists on GitHub${alreadyPosted}`);
		}
		if (!attempt.value) throw new Error(`GitHub did not mark the review thread as resolved${alreadyPosted}`);
		manager.markResolved(task, { upstream: true });
	}

	type ResolveResult = { kind: "resolved" | "skipped" | "error"; text: string };

	/**
	 * The resolve flow shared by pr_task_resolve and /tasks resolve: upstream check, optional code
	 * suggestion, reply, and thread resolve. Retries are safe: a suggestion is applied to the file
	 * once, and when the thread's latest reply already is this message (an earlier call posted it,
	 * then resolving failed) only the resolve is retried.
	 */
	async function resolveTask(
		task: PRTask,
		message: string,
		cwd: string,
		options: { acceptSuggestion?: boolean; own?: boolean } = {},
	): Promise<ResolveResult> {
		// (the task's own checkout: GitHub calls and a suggestion's file edit must reach its repository)
		const folder = await taskFolder(task, cwd);
		return withTaskLock(task, () => resolveTaskLocked(task, message, folder, options.acceptSuggestion ?? false, options.own ?? true));
	}

	/**
	 * `own: false` marks the reply as the user's (/tasks resolve), which may unblock the task if
	 * resolving it then fails.
	 */
	async function resolveTaskLocked(
		task: PRTask,
		message: string,
		cwd: string,
		acceptSuggestion: boolean,
		own: boolean,
	): Promise<ResolveResult> {
		let appliedNow = false;
		const replyBodyFor = (accept: boolean) =>
			accept && !message.toLowerCase().includes("suggestion") ? `${message}\n\nApplied suggested changes.` : message;
		const replyBody = replyBodyFor(acceptSuggestion);

		// Check GitHub before touching the code: the conversation may already be closed upstream
		const wasStale = task.status === "STALE";
		const upstream = await refreshTask(task, cwd);
		// (an earlier call may already have written the suggestion to disk)
		const notApplied =
			task.appliedSuggestion !== undefined
				? "the suggestion had already been applied to the code by an earlier call"
				: "the suggestion was not applied";
		if (acceptSuggestion && upstream !== "already_resolved" && task.status === "STALE") {
			// Its thread is likely gone, so the code change might have no conversation to acknowledge it
			return {
				kind: "error",
				text: `Conversation ${task.conversationId} is STALE (${task.staleReason}); ${notApplied}. Resolve it without accept_suggestion to retry its thread or clear it.`,
			};
		}
		if (upstream === "stale" && wasStale) {
			// Resolving a task already known to be STALE clears it: there is no thread left to post to.
			// (One whose rejected thread GitHub still lists gets a real attempt instead, and is never
			// cleared while listed, in case the thread does exist.)
			// (accept_suggestion was refused above)
			manager.markResolved(task);
			return {
				kind: "resolved",
				text: `Conversation ${task.conversationId} has no review thread on GitHub anymore, so nothing was posted; it is now marked as resolved.`,
			};
		}
		if (upstream) {
			const skipped = acceptSuggestion ? `No reply was posted, and ${notApplied}.` : "No reply was posted.";
			return { kind: "skipped", text: describeUpstreamState(task, upstream, skipped) };
		}

		// Validated on the refreshed task: the reviewer may have added or removed the suggestion
		if (acceptSuggestion && (!task.hasSuggestion || task.suggestion === undefined)) {
			return {
				kind: "error",
				text: `Invalid resolution: Conversation ${task.conversationId} does not contain any code suggestion to accept.`,
			};
		}

		// The exact reply an earlier resolve posted is still the thread's latest: only the resolve failed
		const lastReply = task.replies[task.replies.length - 1];
		// (matched by author and body, which survive GitHub re-issuing comment IDs for a replaced thread)
		const posted = task.resolveReply;
		const isRetry =
			posted !== undefined &&
			lastReply !== undefined &&
			lastReply.author === posted.author &&
			// (either form: a retry may drop or add accept_suggestion once the suggestion is on disk)
			[replyBodyFor(true), replyBodyFor(false)].some((body) => sameReplyBody(lastReply.body, body)) &&
			(!acceptSuggestion || task.appliedSuggestion === task.suggestion);

		// (a retry too: the comment or its replies may have changed since the earlier call)
		if (own && task.seenMessage !== undefined && !sameReplyBody(task.seenMessage, task.message)) {
			// The reviewer edited the comment since the agent read it: show the new text first
			manager.markShown(task);
			return {
				kind: "error",
				text: `Conversation ${task.conversationId} was not resolved: its comment changed on GitHub since you last saw it. It now reads:\n${task.message}\nIf your resolution still fits, call **pr_task_resolve** again.`,
			};
		}
		if (own) {
			// Replies the agent hasn't seen may change the resolution: show them before closing the conversation
			const unseen = showUnseenReplies(task, "resolved", "pr_task_resolve", "change your resolution");
			if (unseen) return { kind: "error", text: unseen };
		}

		if (!isRetry) {
			if (acceptSuggestion && task.appliedSuggestion !== task.suggestion) {
				if (task.appliedSuggestion !== undefined) {
					// Its lines now hold the earlier suggestion: applying the new one by line number could clobber code
					return {
						kind: "error",
						text: `The code suggestion of conversation ${task.conversationId} changed on GitHub after an earlier version was already applied to the code; nothing more was applied. Update the code manually, then resolve without accept_suggestion.`,
					};
				}
				if (task.isOutdated || task.isBaseSide || task.isFileLevel) {
					const why = task.isOutdated
						? "is outdated: the code changed since the comment"
						: task.isBaseSide
							? "is on the base side of the diff (old or deleted lines)"
							: "is on the whole file, not on lines";
					return {
						kind: "error",
						text: `Conversation ${task.conversationId} ${why}, so its suggestion can't be applied by line number. Apply it manually, then resolve without accept_suggestion.`,
					};
				}
				// (the suggestion is part of the comment: the comment as last shown must still be current)
				if (task.seenMessage === undefined || !sameReplyBody(task.seenMessage, task.message)) {
					// Never apply code the agent hasn't been shown; showing it now makes a retry valid
					const lead =
						task.seenMessage === undefined
							? `You haven't been shown the code suggestion of conversation ${task.conversationId} yet; nothing was applied.`
							: `The code suggestion of conversation ${task.conversationId} changed on GitHub since you last saw it; nothing was applied.`;
					manager.markShown(task);
					return {
						kind: "error",
						text: `${lead} It is:\n\`\`\`\n${task.suggestion}\n\`\`\`\nCall again to apply it.`,
					};
				}
				// (captured as checked: a sync while the edit waits may change the task)
				const { file, line } = task;
				const startLine = task.startLine || line;
				// Re-read here on purpose: the guard above narrowed `task.suggestion`, and the awaits
				// between the two points reset that narrowing (a sync can also have dropped it).
				const suggestion = task.suggestion;
				if (suggestion === undefined) {
					return {
						kind: "error",
						text: `Conversation ${task.conversationId} no longer carries a code suggestion; nothing was applied.`,
					};
				}
				try {
					// One edit at a time: two suggestions for the same file must not overwrite each other
					const edit = suggestionEdits.then(() => applyCodeSuggestion(file, startLine, line, suggestion, cwd));
					suggestionEdits = edit.catch(() => {});
					await edit;
				} catch (err: any) {
					return { kind: "error", text: `Failed to apply code suggestion to ${task.file}: ${describeGhError(err)}` };
				}
				task.appliedSuggestion = suggestion;
				appliedNow = true;
			}

			let outcome: ThreadReplyOutcome;
			try {
				outcome = await replyToTaskThread(task, replyBody, cwd, { own });
			} catch (err) {
				const note = acceptSuggestion ? " (the suggestion was already applied to the code; a retry won't apply it again)" : "";
				throw new Error(`${describeGhError(err)}${note}`);
			}
			if (outcome.kind !== "replied") {
				const suggestionNote = acceptSuggestion
					? " The suggestion was already applied to the code; check whether that change should be kept."
					: "";
				return {
					// The local code change no longer has a conversation to acknowledge it
					kind: acceptSuggestion ? "error" : "skipped",
					text: describeUpstreamState(task, outcome.kind, `No reply was posted.${suggestionNote}`),
				};
			}
			task.resolveReply = { author: toReply(outcome.comment).author };
		}

		await resolveTaskThread(task, cwd);
		const retryNote = isRetry ? " (the reply had already been posted by an earlier call)" : "";
		// An applied suggestion is never applied again (its lines no longer hold the original code)
		const suggestionNote = !acceptSuggestion
			? ""
			: appliedNow
				? " Applied suggestion to code."
				: " The suggestion had already been applied to the code by an earlier call, so it was not applied again; check the code still has it.";
		return { kind: "resolved", text: `Conversation ${task.conversationId} resolved successfully${retryNote}.${suggestionNote}` };
	}

	/**
	 * When the task has replies the agent hasn't been shown, shows them (marking them seen) and
	 * returns the text declining the action, which calling again then performs.
	 */
	function showUnseenReplies(task: PRTask, action: string, tool: string, effect: string): string | undefined {
		const unseen = manager.getUnseenReplies(task);
		if (unseen.length === 0) return undefined;
		// (only the replies: the suggestion isn't shown here, so it must not count as seen)
		manager.markRepliesShown(task, unseen);
		const shown = unseen.map((r) => `- ${r.author}: ${r.body}`).join("\n");
		return `Conversation ${task.conversationId} was not ${action}: it has replies you haven't seen yet:\n${shown}\nIf they don't ${effect}, call **${tool}** again.`;
	}

	function describeUpstreamState(task: PRTask, state: UpstreamState, skipped: string): string {
		if (state === "gone") {
			return `Conversation ${task.conversationId} is resolved and has no review thread on GitHub anymore. ${skipped}`;
		}
		if (state === "already_resolved") {
			return `Conversation ${task.conversationId} is already resolved. ${skipped}`;
		}
		return (
			`Conversation ${task.conversationId} is now marked as STALE: its review thread no longer exists on GitHub ` +
			`(replaced or deleted, e.g. after the PR was merged). ${skipped} It no longer counts as an open task. ` +
			`Details: ${task.staleReason}`
		);
	}

	/**
	 * Finds a task, syncing the observed/current PRs once if it isn't tracked yet.
	 */
	async function findTaskSyncing(id: string | number, cwd: string): Promise<PRTask | undefined> {
		const found = manager.findTask(id);
		if (found) return found;
		// (fresh: an in-flight sync may have fetched before the conversation existed)
		await syncAllPRs(cwd, undefined, { fresh: true });
		return manager.findTask(id);
	}

	// (degraded: a not-tracked conversation can't be fetched — say so instead of "not found",
	// so a transient outage is not mistaken for a missing conversation)
	function notFoundResult(rawId: string | number, tool: string) {
		const details = { tool, conversationId: String(rawId) };
		if (ghHealth.status === "degraded") {
			// Not an error: the task may exist, GitHub just cannot be reached right now.
			return ok(
				`Conversation ${rawId} is not tracked and GitHub is temporarily unreachable, so it could not be fetched (the extension is retrying in the background); try again later.`,
				{ ...details, result: "unreachable_untracked", degraded: true },
			);
		}
		return err(`Error: Conversation ${rawId} not found.`, "NOT_FOUND", { ...details, result: "not_found" });
	}

	async function syncAllPRs(cwd: string, explicitPr?: number, { fresh = false } = {}): Promise<void> {
		// Concurrent callers wait for the running sync instead of returning before it finishes, and
		// reuse it when it covers the same PRs (unless they need a fetch started after their call)
		for (let inFlight = syncAllInFlight; inFlight; inFlight = syncAllInFlight) {
			await inFlight.run;
			if (!fresh && inFlight.cwd === cwd && inFlight.explicitPr === explicitPr) return;
		}
		const run = (async () => {
			// Each PR is synced once, from its own folder (a PR whose repository has no folder left is skipped)
			const prs = new Map<string, { prNumber: number; cwd: string }>();
			for (const target of await getTargetPRs(cwd, explicitPr)) {
				const folder = await folderFor(target, cwd);
				if (folder) prs.set(`${folder}|${target.prNumber}`, { prNumber: target.prNumber, cwd: folder });
			}
			for (const pr of prs.values()) {
				await syncPR(pr.prNumber, pr.cwd);
			}
		})();
		const entry = { run, cwd, explicitPr };
		syncAllInFlight = entry;
		try {
			await run;
		} finally {
			if (syncAllInFlight === entry) syncAllInFlight = undefined;
		}
	}

	// (test/debug hook: inspect the shared GitHub health state)
	(globalThis as any).__PI_GH_HEALTH__ = ghHealth;
	// Register integration hooks for observe-pr
	(globalThis as any).__PI_ON_PR_POLL__ = async (prNumber: number, cwd: string) => {
		await syncPR(prNumber, cwd);
	};
	// A final sync when a PR is merged or closed, so its tasks reflect GitHub (merges can replace threads)
	(globalThis as any).__PI_ON_PR_CLOSED__ = async (prNumber: number, _state: string, cwd?: string) => {
		await syncPR(prNumber, cwd || lastCwd);
	};

	// A backoff retry slot: re-sync all targets (each syncPR paces itself via the shared
	// health state). No-op after a session shutdown.
	ghHealth.registerRetryHook(() => {
		if (prTasksShutdown) return;
		guardAsync("syncAllPRs", syncAllPRs(lastCwd));
	});

	pi.on("session_start", async (_evt, ctx) => {
		try {
			prTasksShutdown = false;
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || process.cwd();
			await syncAllPRs(lastCwd);
			updateStatusUI(ctx.ui);
		} catch (err) {
			// A stale ctx (its ui/cwd getters throw post-replacement) is the first stale
			// detection: tear down (a session_shutdown this path missed would have).
			if (isStaleError(err)) handleStaleContext("session_start");
			else logInternal(`[pr_tasks] session_start handling failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	pi.on("turn_end", async (_evt, ctx) => {
		try {
			if (ctx?.cwd) lastCwd = ctx.cwd;
			if (ctx?.ui) lastUIContext = ctx.ui;
			await syncAllPRs(lastCwd);
			updateStatusUI(ctx?.ui);
		} catch (err) {
			// A stale ctx (its ui/cwd getters throw post-replacement) is the first stale
			// detection: tear down (a session_shutdown this path missed would have).
			if (isStaleError(err)) handleStaleContext("turn_end");
			else logInternal(`[pr_tasks] turn_end sync failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// Loop enforcement: prevent agent from settling while unresolved tasks remain
	pi.on("agent_before_settle", async (_evt, ctx) => {
		try {
			if (ctx?.cwd) lastCwd = ctx.cwd;
			if (ctx?.ui) lastUIContext = ctx.ui;

			await syncAllPRs(lastCwd);
			updateStatusUI(ctx?.ui);

			const unresolvedTasks = manager.getUnresolvedTasks();
			if (unresolvedTasks.length === 0) {
				lastNudgeSignature = "";
				identicalNudgeCount = 0;
				return;
			}
			// Throttle loop messages to prevent runaway loops if identical tick
			const now = Date.now();
			if (now - lastSettleNudgeTime < 1000) {
				return;
			}
			lastSettleNudgeTime = now;

			// Cap nudges that make no progress (same tasks, no new replies): stop blocking and warn once
			const signature = unresolvedTasks
				.map((t) => `${t.repo ?? ""}#${t.prNumber}:${t.conversationId}:${t.replies.length}`)
				.sort()
				.join(",");
			identicalNudgeCount = signature === lastNudgeSignature ? identicalNudgeCount + 1 : 1;
			lastNudgeSignature = signature;
			if (identicalNudgeCount > MAX_IDENTICAL_NUDGES) {
				if (identicalNudgeCount === MAX_IDENTICAL_NUDGES + 1) {
					try {
						lastUIContext?.notify(
							`[pr_tasks] ${unresolvedTasks.length} open task(s) unchanged after ${MAX_IDENTICAL_NUDGES} nudges; no longer blocking the agent from stopping. Use /tasks to review them.`,
							"warning",
						);
					} catch {
						// a dead UI must not break the settle handler
					}
				}
				return;
			}

			const totalTasks = manager.getAllTasks().length;
			const loopMessage = formatLoopMessage(unresolvedTasks, totalTasks);
			try {
				tryPi("settle_loop", () => pi.sendUserMessage(loopMessage, { deliverAs: "followUp" }), undefined);
				for (const t of unresolvedTasks) manager.markShown(t);
			} catch (err) {
				logInternal(`[pr_tasks] Failed to send settle loop message: ${err instanceof Error ? err.message : String(err)}`);
			}
			return { continue: true };
		} catch (err) {
			// A stale ctx (its ui/cwd getters throw post-replacement) or a dropped in-flight
			// sync: stale is the first stale detection (tear down); the rest stay in the file log.
			if (isStaleError(err)) handleStaleContext("agent_before_settle");
			else logInternal(`[pr_tasks] agent_before_settle failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	const PROMPT_GUIDELINES =
		"PR review conversations are tracked as tasks. Unresolved reviewer conversations must be resolved before completing your work.\n" +
		"- Use `pr_tasks_list` to view open conversation tasks.\n" +
		"- Use `pr_task_detail` to inspect the full conversation, replies, and code suggestions.\n" +
		"- Use `pr_task_resolve` to reply and resolve the conversation once addressed (use `accept_suggestion: true` if applying reviewer's code suggestion).\n" +
		"- Use `pr_task_blocked` if you require human clarification before you can resolve the conversation.\n" +
		"- Do not stop your run with unresolved tasks unless they are marked as blocked.";

	// A new prompt from the user re-arms the nudge cap (the nudges themselves arrive as extension input)
	pi.on("input", (event) => {
		if (event.source !== "extension") {
			lastNudgeSignature = "";
			identicalNudgeCount = 0;
		}
	});

	pi.on("before_agent_start", (event) => {
		if (event.systemPromptOptions?.promptGuidelines) {
			if (!event.systemPromptOptions.promptGuidelines.includes(PROMPT_GUIDELINES)) {
				event.systemPromptOptions.promptGuidelines.push(PROMPT_GUIDELINES);
			}
		}

		return {
			systemPrompt: event.systemPrompt
				? `${event.systemPrompt}\n\n${PROMPT_GUIDELINES}`
				: PROMPT_GUIDELINES,
		};
	});

	pi.on("session_shutdown", () => {
		delete (globalThis as any)[GLOBAL_GUARD_KEY];
		delete (globalThis as any).__PI_ON_PR_POLL__;
		delete (globalThis as any).__PI_ON_PR_CLOSED__;
		sessionId++;
		prTasksShutdown = true;
		// (the singleton outlives the session: a pending retry timer or a wedged slot
		// must not carry into the next session in the same process)
		try {
			ghHealth.reset();
		} catch (err) {
			logInternal(`[pr_tasks] session_shutdown ghHealth reset failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		syncAllInFlight = undefined; // its results are dropped, so it must not be reused
		lastNudgeSignature = "";
		identicalNudgeCount = 0;
		try {
			manager.clear();
		} catch (err) {
			logInternal(`[pr_tasks] session_shutdown manager clear failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// Tool 1: pr_tasks_list
	pi.registerTool({
		name: "pr_tasks_list",
		label: "List PR Tasks",
		description:
			"Lists PR review conversation tasks. By default lists only unresolved, blocked, and stale tasks. Set show_all to true to include resolved tasks.",
		parameters: Type.Object({
			pr_number: Type.Optional(
				Type.Union([Type.Number(), Type.String()], {
					description: "Optional PR number to filter tasks. If omitted, lists tasks across observed PRs or current branch PR.",
				}),
			),
			show_all: Type.Optional(
				Type.Boolean({
					description:
						"If true, shows all tasks including resolved ones. By default only unresolved/blocked/stale tasks are shown.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			const rawPr = (params as any)?.pr_number ?? (params as any)?.prNumber;
			let prNum: number | undefined;
			if (rawPr !== undefined) {
				const parsed = parseInt(String(rawPr).replace(/^#/, "").trim(), 10);
				if (!isNaN(parsed) && parsed > 0) prNum = parsed;
			}

			await syncAllPRs(ctx.cwd, prNum);
			updateStatusUI(ctx.ui);

			const showAll = Boolean((params as any)?.show_all ?? (params as any)?.showAll);
			const allTasks = manager.getAllTasks(prNum);
			const filteredTasks = showAll ? allTasks : manager.getVisibleTasks(prNum);

			const formatted = formatTaskSummary(filteredTasks, allTasks.length);
			for (const t of filteredTasks) manager.markShown(t);
			// (degraded: the list could not be refreshed — the cached state is valid but may be stale)
			const degraded = ghHealth.status === "degraded";
			const staleNote = degraded
				? "\n(GitHub is temporarily unreachable, so this list could not be refreshed; the extension is retrying in the background.)"
				: "";
			return ok(formatted + staleNote, {
				tool: "pr_tasks_list",
				prNumber: prNum ?? null,
				showAll,
				counts: countTasksByStatus(allTasks),
				returned: filteredTasks.length,
				total: allTasks.length,
				degraded,
				...capList("taskIds", filteredTasks.map((t) => t.conversationId)),
			});
		},
	});

	// Tool 2: pr_task_resolve
	pi.registerTool({
		name: "pr_task_resolve",
		label: "Resolve PR Task",
		description:
			"Resolves a PR review conversation task by sending a reply and marking the thread resolved on GitHub. Optional accept_suggestion applies code suggestion.",
		parameters: Type.Object({
			conversation_id: Type.Union([Type.String(), Type.Number()], {
				description: "The conversation ID / task ID to resolve",
			}),
			message: Type.String({
				description: "Resolution message explaining how the conversation was addressed",
			}),
			accept_suggestion: Type.Optional(
				Type.Boolean({
					description:
						"If true, accepts and applies the code suggestion from the conversation. Returns an error if no suggestion exists.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			const rawId = (params as any)?.conversation_id ?? (params as any)?.conversationId;
			const message = String((params as any)?.message || "").trim();
			const acceptSuggestion = Boolean(
				(params as any)?.accept_suggestion ?? (params as any)?.acceptSuggestion,
			);

			// A blank message stays rejected: GitHub needs a body for the reply. The details say
			// which half is missing, so "you sent nothing" is never reported for an empty string.
			if (!rawId || !message) {
				return err("Error: conversation_id and message are required.", "MISSING_PARAMS", {
					tool: "pr_task_resolve",
					conversationId: rawId ? String(rawId) : null,
					messageProvided: message.length > 0,
				});
			}

			const task = await findTaskSyncing(rawId, ctx.cwd);

			if (!task) {
				return notFoundResult(rawId, "pr_task_resolve");
			}

			const taskDetails = {
				tool: "pr_task_resolve",
				conversationId: task.conversationId,
				prNumber: task.prNumber,
				file: task.file,
				acceptSuggestion,
			};

			try {
				const result = await resolveTask(task, message, ctx.cwd, { acceptSuggestion });
				updateStatusUI(ctx.ui);
				const details = { ...taskDetails, kind: result.kind, status: task.status };
				return result.kind === "error" ? err(result.text, "RESOLVE_FAILED", details) : ok(result.text, details);
			} catch (cause: any) {
				return err(
					`Error resolving conversation ${task.conversationId}: ${mutationErrorText(cause)}`,
					mutationErrorCode(cause),
					{ ...taskDetails, status: task.status },
				);
			}
		},
	});

	/**
	 * Text for a failed agent-initiated mutation: a GitHub-availability failure is shown
	 * concisely (no raw stderr — the background retry covers the reconnect); anything else
	 * keeps the detailed gh error.
	 */
	/** The machine-readable twin of mutationErrorText(): unreachable is a different retry story. */
	function mutationErrorCode(err: unknown): string {
		return isGhAvailabilityError(err) ? "GH_UNREACHABLE" : "GH_FAILED";
	}

	function mutationErrorText(err: unknown): string {
		if (isGhAvailabilityError(err)) {
			return "GitHub is temporarily unreachable (the extension is retrying in the background); try again later";
		}
		return describeGhError(err);
	}

	// Tool 3: pr_task_detail
	pi.registerTool({
		name: "pr_task_detail",
		label: "PR Task Detail",
		description: "Retrieves the full detail of a PR conversation task including all replies and suggestions.",
		parameters: Type.Object({
			conversation_id: Type.Union([Type.String(), Type.Number()], {
				description: "The conversation ID / task ID to inspect",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			const rawId = (params as any)?.conversation_id ?? (params as any)?.conversationId;
			const task = await findTaskSyncing(rawId, ctx.cwd);

			if (!task) {
				return notFoundResult(rawId, "pr_task_detail");
			}

			const formatted = formatTaskDetail(task);
			manager.markShown(task, task.replies);
			return ok(formatted, {
				tool: "pr_task_detail",
				conversationId: task.conversationId,
				prNumber: task.prNumber,
				file: task.file,
				status: task.status,
				replies: task.replies?.length ?? 0,
				hasSuggestion: Boolean(task.suggestion),
				isOutdated: task.isOutdated,
				isResolvedUpstream: task.isResolvedUpstream,
			});
		},
	});

	// Tool 4: pr_task_blocked
	pi.registerTool({
		name: "pr_task_blocked",
		label: "Mark PR Task Blocked",
		description:
			"Marks a PR conversation task as blocked when human intervention is required, posting the reason as a reply.",
		parameters: Type.Object({
			conversation_id: Type.Union([Type.String(), Type.Number()], {
				description: "The conversation ID / task ID to mark as blocked",
			}),
			reason: Type.String({
				description: "Detailed reason why human assistance or clarification is needed",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			lastCwd = ctx.cwd || lastCwd;

			const rawId = (params as any)?.conversation_id ?? (params as any)?.conversationId;
			const reason = String((params as any)?.reason || "").trim();

			if (!rawId || !reason) {
				return err("Error: conversation_id and reason are required.", "MISSING_PARAMS", {
					tool: "pr_task_blocked",
					conversationId: rawId ? String(rawId) : null,
					hasReason: Boolean(reason),
				});
			}

			const task = await findTaskSyncing(rawId, ctx.cwd);

			if (!task) {
				return notFoundResult(rawId, "pr_task_blocked");
			}

			const text = (t: string, extra: Record<string, unknown> = {}) =>
				ok(t, { tool: "pr_task_blocked", conversationId: task.conversationId, prNumber: task.prNumber, ...extra });
			const upstreamResult = (state: UpstreamState, note: string) => {
				updateStatusUI(ctx.ui);
				return text(describeUpstreamState(task, state, note), { upstreamState: state, posted: false });
			};

			try {
				return await withTaskLock(task, async () => {
					const folder = await taskFolder(task, ctx.cwd);
					const upstream = await refreshTask(task, folder);
					if (upstream && blocksPosting(upstream)) return upstreamResult(upstream, "The blocked reason was not posted.");

					// Those replies may already answer the question: show them instead of blocking
					const unseen = showUnseenReplies(task, "blocked", "pr_task_blocked", "answer your question");
					if (unseen)
						return err(unseen, "UNSEEN_USER_REPLIES", {
							tool: "pr_task_blocked",
							conversationId: task.conversationId,
							prNumber: task.prNumber,
							posted: false,
						});

					const outcome = await replyToTaskThread(task, reason, folder);
					if (outcome.kind !== "replied") return upstreamResult(outcome.kind, "The blocked reason was not posted.");
					if (task.status === "RESOLVED" || task.status === "STALE") {
						// A sync while the reply was being posted closed the conversation: don't override that
						const state = task.status === "RESOLVED" ? "already_resolved" : "stale";
						return upstreamResult(state, "The blocked reason was posted, but the task was not marked as blocked.");
					}
					manager.markBlocked(task, reason);
					updateStatusUI(ctx.ui);
					return text(
						`Conversation ${task.conversationId} is now marked as Blocked. When a user replies to this conversation, it will be automatically unblocked.`,
						{ status: task.status, posted: true },
					);
				});
			} catch (cause: any) {
				return err(
					`Error marking conversation ${task.conversationId} as blocked: ${mutationErrorText(cause)}`,
					mutationErrorCode(cause),
					{ tool: "pr_task_blocked", conversationId: task.conversationId, prNumber: task.prNumber, posted: false },
				);
			}
		},
	});

	// Slash Command: /tasks
	pi.registerCommand("tasks", {
		description: "PR conversation tasks controls (subcommands: list, detail <id>, resolve <id> <reason>, reply <id> <msg>)",
		handler: async (args, ctx) => {
			lastUIContext = ctx.ui;
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			// resolve and reply refresh their task's PR themselves, so only sync up front for the rest
			if (sub !== "resolve" && sub !== "reply") {
				await syncAllPRs(ctx.cwd);
				updateStatusUI(ctx.ui);
			}

			if (!sub || sub === "list") {
				const showAll = parts[1]?.toLowerCase() === "all";
				if (ctx.mode === "tui" && ctx.hasUI) {
					await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
						return new PRTasksDashboardComponent(theme, manager, () => done());
					});
				} else {
					const allTasks = manager.getAllTasks();
					const tasks = showAll ? allTasks : manager.getVisibleTasks();
					const formatted = formatTaskSummary(tasks, allTasks.length);
					ctx.ui.notify(formatted, "info");
				}
				return;
			}

			if (sub === "detail") {
				const taskId = parts[1];
				if (!taskId) {
					ctx.ui.notify("Please specify a task ID: /tasks detail <taskId>", "warning");
					return;
				}
				const task = manager.findTask(taskId);
				if (!task) {
					ctx.ui.notify(`Task #${taskId} not found.`, "warning");
					return;
				}
				ctx.ui.notify(formatTaskDetail(task), "info");
				return;
			}

			if (sub === "resolve") {
				const taskId = parts[1];
				const reasonMatch = trimmed.match(/^resolve\s+\S+\s+(?:"([^"]+)"|'([^']+)'|(.+))$/i);
				const reason = reasonMatch ? (reasonMatch[1] || reasonMatch[2] || reasonMatch[3])?.trim() : "";

				if (!taskId || !reason) {
					ctx.ui.notify('Usage: /tasks resolve <taskId> "<reason>"', "warning");
					return;
				}

				const task = await findTaskSyncing(taskId, ctx.cwd);
				if (!task) {
					ctx.ui.notify(`Task #${taskId} not found.`, "warning");
					return;
				}

				try {
					const result = await resolveTask(task, reason, ctx.cwd, { own: false });
					updateStatusUI(ctx.ui);
					const level = result.kind === "resolved" ? "info" : result.kind === "skipped" ? "warning" : "error";
					ctx.ui.notify(result.text, level);
				} catch (err: any) {
					ctx.ui.notify(`Failed to resolve task #${taskId}: ${describeGhError(err)}`, "error");
				}
				return;
			}

			if (sub === "reply") {
				const taskId = parts[1];
				const msgMatch = trimmed.match(/^reply\s+\S+\s+(?:"([^"]+)"|'([^']+)'|(.+))$/i);
				const replyMsg = msgMatch ? (msgMatch[1] || msgMatch[2] || msgMatch[3])?.trim() : "";

				if (!taskId || !replyMsg) {
					ctx.ui.notify('Usage: /tasks reply <taskId> "<message>"', "warning");
					return;
				}

				const task = await findTaskSyncing(taskId, ctx.cwd);
				if (!task) {
					ctx.ui.notify(`Task #${taskId} not found.`, "warning");
					return;
				}

				try {
					// Replying to a resolved conversation is fine; only a stale thread is skipped. This is the
					// user writing, so the reply can unblock the task.
					const folder = await taskFolder(task, ctx.cwd);
					const upstream = await refreshTask(task, folder);
					const outcome: ThreadReplyOutcome = upstream && blocksPosting(upstream, true)
						? { kind: upstream }
						: await replyToTaskThread(task, replyMsg, folder, { allowResolved: true, own: false });
					if (outcome.kind !== "replied") {
						updateStatusUI(ctx.ui);
						ctx.ui.notify(describeUpstreamState(task, outcome.kind, "No reply was posted."), "warning");
						return;
					}
					// Pick up the reply now, so a BLOCKED task unblocks and the agent is notified right away
					await syncPR(task.prNumber, folder);
					updateStatusUI(ctx.ui);
					ctx.ui.notify(`Reply posted to task #${task.conversationId}.`, "info");
				} catch (err: any) {
					ctx.ui.notify(`Failed to reply to task #${taskId}: ${describeGhError(err)}`, "error");
				}
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand '${sub}'. Available subcommands: list [all], detail <id>, resolve <id> "<reason>", reply <id> "<message>"`,
				"warning",
			);
		},
	});
}
