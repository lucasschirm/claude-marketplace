import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { AcpClient } from "./lib/acp-client.ts";
import {
	MODE_NAMES,
	PERMISSION_DECISIONS,
	type PermissionDecision,
	type PermissionRequest,
	optionValues,
	parsePermissionRequest,
	permissionOutcome,
	pickPermissionOption,
	resolveAcpMode,
} from "./lib/devin-permissions.ts";
import { SessionSlots } from "./lib/devin-slots.ts";
import { DEVIN_BASH_BLOCK_REASON, findBlockedDevinCommand } from "./lib/devin-bash-guard.ts";
import { stripAnsi, extractCliError } from "./lib/devin-diagnostics.ts";
import { removeOrcaWorktree, checkWorktreeSafety } from "./lib/orca-client.ts";
import { capList, type ToolDetails } from "./lib/tool-result.ts";
import { logError as fileLogError, logWarn as fileLogWarn } from "./lib/extension-log.ts";
import { WriteQueue, commandExists, createTaskScope, reportBudgetViolation } from "./lib/nonblocking.ts";

const execFileAsync = promisify(execFile);
const GLOBAL_GUARD_KEY = "__PI_DEVIN_DELEGATE_EXTENSION_ACTIVE__";
const MODE_DESCRIPTION = `Permission mode: ${MODE_NAMES.join(", ")} (default: dangerous). dangerous (= bypass) approves every tool call; smart (alias auto) approves what Devin judges safe; in every mode but dangerous, Devin may ask permission, and the request is forwarded to you to answer with devin_permission.`;

// Process exit hooks are registered once per process (not per factory invocation —
// a /reload re-runs the factory and would otherwise stack listeners that pin the
// old generation's state until the first signal fires) and dispatch to the
// current generation's cleanup. cleanupAllClients is idempotent, so repeated
// signals are harmless.
let currentProcessExitCleanup: (() => void) | undefined;
let processExitHooksRegistered = false;
function registerProcessExitHooks(): void {
	if (processExitHooksRegistered) return;
	processExitHooksRegistered = true;
	const run = () => currentProcessExitCleanup?.();
	process.on("exit", run);
	process.on("SIGINT", run);
	process.on("SIGTERM", run);
}

// --- Types ---

interface QueuedTask {
	queueId: string;
	prompt: string;
	model: string;
	mode: string;
	createWorktree: boolean;
	enqueuedAt: number;
	parentSessionId?: string;
	worktreePath?: string;
	worktreeBranch?: string;
	worktreeId?: string;
	parentWorktreeId?: string;
	worktreeStatus?: "active" | "released" | "retained";
}

interface SessionMeta {
	sessionId: string;
	queueId?: string;
	prompt: string;
	model: string;
	mode: string;
	createWorktree: boolean;
	worktreePath?: string;
	worktreeBranch?: string;
	worktreeId?: string;
	parentWorktreeId?: string;
	worktreeStatus?: "active" | "released" | "retained";
	prState?: string;
	status: "running" | "stalled" | "idle" | "completed" | "cancelled" | "failed" | "interrupted";
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	lastMessageTime?: number;
	turnStartedAt?: number;
	turnCompletedAt?: number;
	pid?: number;
	dbBackfilled?: boolean;
	error?: string;
	detectedPrNumber?: number;
}

interface PersistedState {
	maxRuns: number;
	totalInvoked: number;
	totalCompleted: number;
	queue: QueuedTask[];
	sessionIds: string[];
	// Self-describing: the storage directory (pi session id) each session was written to,
	// so recovery does not depend on the current anchor value.
	sessionDirs?: Record<string, string>;
}

// --- Dashboard Component (Arrow Keys Navigation) ---

class DevinDashboardComponent {
	private selectedIndex = 0;
	private viewMode: "sessions" | "messages" = "sessions";
	private messageScrollOffset = 0;
	private cachedMessages: string[] = [];

	constructor(
		private tui: any,
		private theme: any,
		private getSessions: () => SessionMeta[],
		private getQueue: () => QueuedTask[],
		private readSessionMessages: (session: SessionMeta, count?: number) => string[],
		private onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.onClose();
			return;
		}

		const sessions = this.getSessions();
		const queue = this.getQueue();
		const totalItems = sessions.length + queue.length;

		if (this.viewMode === "sessions") {
			if (matchesKey(data, "up")) {
				if (this.selectedIndex > 0) {
					this.selectedIndex--;
					this.tui?.requestRender?.();
				}
			} else if (matchesKey(data, "down")) {
				if (this.selectedIndex < totalItems - 1) {
					this.selectedIndex++;
					this.tui?.requestRender?.();
				}
			} else if (matchesKey(data, "right") || matchesKey(data, "return")) {
				if (this.selectedIndex < sessions.length) {
					this.viewMode = "messages";
					this.messageScrollOffset = 0;
					this.cachedMessages = this.readSessionMessages(sessions[this.selectedIndex], 50);
					this.tui?.requestRender?.();
				}
			}
		} else {
			if (matchesKey(data, "left") || matchesKey(data, "backspace")) {
				this.viewMode = "sessions";
				this.cachedMessages = [];
				this.tui?.requestRender?.();
			} else if (matchesKey(data, "up")) {
				if (this.messageScrollOffset > 0) {
					this.messageScrollOffset--;
					this.tui?.requestRender?.();
				}
			} else if (matchesKey(data, "down")) {
				if (this.messageScrollOffset < Math.max(0, this.cachedMessages.length - 10)) {
					this.messageScrollOffset++;
					this.tui?.requestRender?.();
				}
			}
		}
	}

	render(width: number): string[] {
		// Never crash the TUI render loop (e.g. a theme token missing from a
		// custom theme). Render failures surface as a plain-text placeholder.
		try {
			return this.renderInner(width);
		} catch (err: any) {
			return [`[devin-delegate] dashboard unavailable: ${stripAnsi(String(err?.message || err))}`];
		}
	}

	renderInner(width: number): string[] {
		const lines: string[] = [];
		const th = this.theme;
		const sessions = this.getSessions();
		const queue = this.getQueue();
		const totalItems = sessions.length + queue.length;

		lines.push("");
		const title = th.fg("accent", " Devin Delegate Sessions ");
		const headerLine = th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 30)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (totalItems === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No Devin sessions or queued tasks found.")}`, width));
			lines.push(truncateToWidth(`  ${th.fg("dim", "Use the devin_delegate tool to start a session.")}`, width));
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("muted", "Press 'q' or 'Esc' to close.")}`, width));
			return lines;
		}

		if (this.viewMode === "sessions") {
			lines.push(truncateToWidth(`  ${th.fg("muted", "Use Up/Down to select, Right/Enter to view messages, 'q' to close:")}`, width));
			lines.push("");

			// Render active/finished sessions
			for (let i = 0; i < sessions.length; i++) {
				const s = sessions[i];
				const isSelected = i === this.selectedIndex;
				const pointer = isSelected ? th.fg("accent", "▶ ") : "  ";
				const statusColor = s.status === "running" ? "success" : s.status === "failed" ? "error" : "muted";
				const statusBadge = th.fg(statusColor, `[${s.status.toUpperCase()}]`);
				const prBadge = s.detectedPrNumber ? th.fg("accent", ` PR #${s.detectedPrNumber}`) : "";
				const timeStr = s.lastMessageTime ? new Date(s.lastMessageTime).toLocaleTimeString() : "N/A";

				const lineText = `${pointer}${th.bold(s.sessionId)} ${statusBadge}${prBadge} (${timeStr}) - ${s.prompt.slice(0, 40)}`;
				lines.push(truncateToWidth(lineText, width));
			}

			// Render queued tasks
			if (queue.length > 0) {
				lines.push("");
				lines.push(truncateToWidth(`  ${th.fg("muted", `Queued Tasks (${queue.length}):`)}`, width));
				for (let j = 0; j < queue.length; j++) {
					const q = queue[j];
					const itemIndex = sessions.length + j;
					const isSelected = itemIndex === this.selectedIndex;
					const pointer = isSelected ? th.fg("accent", "▶ ") : "  ";
					const badge = th.fg("warning", `[QUEUED #${j + 1}]`);
					const lineText = `${pointer}${th.bold(q.queueId)} ${badge} - ${q.prompt.slice(0, 45)}`;
					lines.push(truncateToWidth(lineText, width));
				}
			}
		} else {
			const s = sessions[this.selectedIndex];
			lines.push(truncateToWidth(`  ${th.fg("accent", `Session: ${s.sessionId}`)} ${th.fg("dim", `[${s.status}]`)}`, width));
			lines.push(truncateToWidth(`  ${th.fg("muted", "Use Up/Down to scroll, Left to return to session list, 'q' to close:")}`, width));
			lines.push("");

			// `invalidate()` drops the transcript; re-read it so a theme change does not blank the view.
			if (this.cachedMessages.length === 0) {
				this.cachedMessages = this.readSessionMessages(s, 50);
			}
			if (this.cachedMessages.length === 0) {
				lines.push(truncateToWidth(`  ${th.fg("dim", "No messages recorded yet.")}`, width));
			} else {
				const visible = this.cachedMessages.slice(this.messageScrollOffset, this.messageScrollOffset + 15);
				for (const msg of visible) {
					lines.push(truncateToWidth(`  ${msg}`, width));
				}
			}
		}

		lines.push("");
		return lines;
	}

	/**
	 * Required by pi-tui's `Component`: the transcript is this component's only cached state, and
	 * render() re-reads it lazily, so a theme change or a full redraw simply starts from empty.
	 */
	invalidate(): void {
		this.cachedMessages = [];
	}
}

// --- Main Extension Entrypoint ---

export default function devinDelegateExtension(pi: ExtensionAPI): void {
	if ((globalThis as any)[GLOBAL_GUARD_KEY]) {
		return;
	}
	(globalThis as any)[GLOBAL_GUARD_KEY] = true;

	// State
	let currentPiSessionId = "default";
	let maxRuns = 2;
	let totalInvoked = 0;
	let totalCompleted = 0;
	const queue: QueuedTask[] = [];
	const sessions = new Map<string, SessionMeta>();
	const activeClients = new Map<string, AcpClient>();
	let lastUIContext: ExtensionUIContext | undefined;

	/**
	 * The `details` block every tool result of this extension carries: which tool answered and the
	 * session/queue counters a follow-up turn would otherwise re-query. Per-call facts go in `extra`.
	 */
	function toolDetails(tool: string, extra: ToolDetails = {}): ToolDetails {
		return {
			tool,
			sessions: sessions.size,
			queuedTasks: queue.length,
			inFlight: slots.inFlight(),
			maxInFlight: maxRuns,
			totalCompleted,
			...extra,
		};
	}

	// Diagnostics: in TUI mode route through the pi UI (raw console writes
	// corrupt the alternate-screen render); in non-TUI modes use the console.
	// Every call is also file-logged (extension-log) as a persistent debug record.
	function logWarn(message: string): void {
		const safe = stripAnsi(message).replace(/\s+/g, " ").trim().slice(0, 500);
		fileLogWarn("devin-delegate", safe);
		const ui = lastUIContext;
		if (ui?.notify) {
			try {
				ui.notify(safe, "warning");
				return;
			} catch {}
		}
		console.warn(safe);
	}

	function logError(message: string): void {
		const safe = stripAnsi(message).replace(/\s+/g, " ").trim().slice(0, 500);
		fileLogError("devin-delegate", safe);
		const ui = lastUIContext;
		if (ui?.notify) {
			try {
				ui.notify(safe, "error");
				return;
			} catch {}
		}
		console.error(safe);
	}

	let baseDir = process.cwd();
	// When false (default), shell calls to the `devin` CLI are blocked so work goes through the devin_* tools.
	let allowBash = false;

	// Binary availability cache
	const binaryAvailableCache = new Map<string, boolean>();

	// Boot is the tight budget here: recovering state must never be what makes `pi` feel frozen.
	const BOOT_BUDGET_MS = Number.parseInt(process.env.PI_EXT_BOOT_BUDGET_MS ?? "", 10) || 5_000;
	// Every state file write goes through one serialized queue (atomic tmp+rename preserved).
	const stateWrites = new WriteQueue((msg) => logError(msg));
	// Startup recovery and any other background work: never on a path Pi awaits.
	const tasks = createTaskScope("devin_delegate", { onError: (msg) => logError(msg) });

	function checkBudget(event: string, startedAt: number): void {
		reportBudgetViolation("devin_delegate", event, performance.now() - startedAt, 20, (msg) => logError(msg));
	}

	// Turn liveness: per-session stall watchdog timers and streamed assistant chunk buffers
	const stallTimers = new Map<string, NodeJS.Timeout>();
	// Permission requests Devin is blocked on, oldest first, each with its auto-reject timer
	const pendingPermissions = new Map<string, Array<PermissionRequest & { timer: NodeJS.Timeout }>>();
	const assistantBuffers = new Map<string, string>();
	// Advertised ACP config-option vocabularies, captured from config_option_update
	const sessionConfigOptions = new Map<string, Map<string, string[]>>();
	// Where each session's files were last written (mirrors state.json's sessionDirs),
	// so recovered sessions' event files can be found in their original directory.
	const sessionDirs = new Map<string, string>();

	// Async PATH probe (see lib/nonblocking.ts): the synchronous `which` probe it replaces froze the
	// TUI for its whole duration.
	async function isCommandAvailable(cmd: string): Promise<boolean> {
		const available = await commandExists(cmd);
		binaryAvailableCache.set(cmd, available);
		return available;
	}

	// CLI Flag: --devin-max-runs <value>
	pi.registerFlag("devin-max-runs", {
		description: "Maximum concurrent active Devin sessions (default: 2)",
		type: "string",
	});

	// CLI Flag: --devin-turn-stall <minutes>
	pi.registerFlag("devin-turn-stall", {
		description: "Minutes of ACP silence before a running turn is marked stalled (default: 30)",
		type: "string",
	});

	// CLI Flag: --devin-permission-timeout <minutes>
	pi.registerFlag("devin-permission-timeout", {
		description: "Minutes a Devin permission request waits for devin_permission before it is rejected (default: 5)",
		type: "string",
	});

	function getPermissionTimeoutMs(): number {
		const flag = pi.getFlag("devin-permission-timeout");
		const n = flag != null ? Number.parseFloat(String(flag)) : Number.NaN;
		return (Number.isFinite(n) && n > 0 ? n : 5) * 60000;
	}

	function getStallTimeoutMs(): number {
		const flag = pi.getFlag("devin-turn-stall");
		const n = flag != null ? parseInt(String(flag), 10) : NaN;
		return (!isNaN(n) && n > 0 ? n : 30) * 60000;
	}

	function isPidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	// Kill a detached devin process group directly (used when no live AcpClient exists,
	// e.g. after a pi restart left an orphaned `devin acp` behind).
	// PID-recycle guard: before killing a *recorded* (possibly long-dead) pid, verify
	// on Linux that it is still a devin process. Returns null when unverifiable
	// (non-Linux, unreadable cmdline) — in that case the kill proceeds as before.
	function looksLikeDevinProcess(pid: number): boolean | null {
		if (process.platform !== "linux") return null;
		try {
			const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
			return cmdline.includes("devin");
		} catch {
			return null;
		}
	}

	function killProcessGroup(pid: number): void {
		if (looksLikeDevinProcess(pid) === false) {
			logWarn(`refusing to kill pid ${pid}: not a devin process (possible pid reuse)`);
			return;
		}
		try {
			if (process.platform !== "win32") {
				try {
					process.kill(-pid, "SIGTERM");
				} catch {
					try {
						process.kill(pid, "SIGTERM");
					} catch {}
				}
			} else {
				try {
					process.kill(pid, "SIGTERM");
				} catch {}
			}
			setTimeout(() => {
				try {
					if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
				} catch {
					try {
						process.kill(pid, "SIGKILL");
					} catch {}
				}
			}, 1500).unref();
		} catch {}
	}

	// Tolerate transient ENOENT (observed on shared volumes: directories flapping between
	// visible and ENOENT within seconds) by retrying once after a short delay. The delay is an
	// ordinary timer: the Atomics.wait version this replaces froze the event loop — and with it the
	// TUI — for 150 ms per retried file, right in the middle of session_start.
	async function readTextFileWithRetry(p: string): Promise<string> {
		try {
			return await fsp.readFile(p, "utf-8");
		} catch (err: any) {
			if (err?.code !== "ENOENT") throw err;
			await new Promise((resolve) => setTimeout(resolve, 150));
			return fsp.readFile(p, "utf-8");
		}
	}

	function countInFlight(): number {
		let n = 0;
		for (const s of sessions.values()) {
			if (s.status === "running" || s.status === "stalled") n++;
		}
		return n;
	}

	// Starts are counted from the moment they are admitted, not when the session registers.
	const slots = new SessionSlots(countInFlight, () => maxRuns);

	function clearStallTimer(sessionId: string): void {
		const t = stallTimers.get(sessionId);
		if (t) {
			clearInterval(t);
			stallTimers.delete(sessionId);
		}
	}

	// Every caller ends the turn (completed, failed, cancelled, exited), which also ends the
	// permission requests it was blocked on.
	function stopStallWatchdog(sessionId: string): void {
		clearStallTimer(sessionId);
		dropPendingPermissions(sessionId);
	}

	// Stall watchdog: replaces the old hard 60s prompt timeout. A turn is considered
	// stalled only when *no* ACP update arrives for N minutes; the process being alive
	// (child + stderr heartbeat) distinguishes "possibly thinking/waiting" from "dead"
	// (which onExit handles as interrupted). A stalled turn is never auto-failed or killed.
	function startStallWatchdog(meta: SessionMeta): void {
		clearStallTimer(meta.sessionId);
		const stallMs = getStallTimeoutMs();
		const timer = setInterval(() => {
			if (meta.status !== "running") {
				// Only this timer ends here: a stalled turn is still in flight, and whatever ended a
				// finished turn already called stopStallWatchdog.
				clearStallTimer(meta.sessionId);
				return;
			}
			// Waiting on the agent, not stalled: the permission timeout settles it.
			if (pendingPermissions.get(meta.sessionId)?.length) return;
			const last = meta.lastMessageTime || meta.startedAt || 0;
			if (Date.now() - last > stallMs) {
				meta.status = "stalled";
				persistSessionMeta(meta, true);
				updateStatusUI();
				sendAgentMessage(
					`The session ${meta.sessionId} appears stalled (no ACP activity for ${Math.round(stallMs / 60000)} minutes). Verify with "devin_status"; if it is stuck, use "devin_cancel" then "devin_restart" to recover.`,
				);
			}
		}, 60000);
		timer.unref();
		stallTimers.set(meta.sessionId, timer);
	}

	// --- Permission requests: Devin blocks the turn until each one is answered ---

	function formatWait(ms: number): string {
		return ms >= 60000 ? `${Math.round(ms / 60000)} minutes` : `${Math.round(ms / 1000)} seconds`;
	}

	function onPermissionRequest(meta: SessionMeta, requestId: number | string, params: unknown): void {
		const req = parsePermissionRequest(requestId, params);
		// Asking is activity: a turn marked stalled is alive after all.
		meta.lastMessageTime = Date.now();
		if (meta.status === "stalled") {
			meta.status = "running";
			startStallWatchdog(meta);
		}
		const timeoutMs = getPermissionTimeoutMs();
		const timer = setTimeout(() => answerPermission(meta.sessionId, "reject", "timeout", requestId), timeoutMs);
		timer.unref();
		const list = pendingPermissions.get(meta.sessionId) ?? [];
		list.push({ ...req, timer });
		pendingPermissions.set(meta.sessionId, list);
		activeClients.get(meta.sessionId)?.logEvent("permission_request", { requestId, command: req.command });
		updateStatusUI();
		sendAgentMessage(
			`The session ${meta.sessionId} is waiting for permission to run: ${req.command}\nAnswer with "devin_permission" (decision: "allow", "allow_session" or "reject") within ${formatWait(timeoutMs)}, or it is rejected automatically. The session's turn is blocked until then. Delegate with mode "dangerous" to let Devin run tools without asking.`,
		);
	}

	// Answer one pending request (the oldest, or `requestId`'s). Returns it, or null when none is pending.
	function answerPermission(
		sessionId: string,
		decision: PermissionDecision,
		by: "agent" | "timeout",
		requestId?: number | string,
	): (PermissionRequest & { optionId?: string }) | null {
		const list = pendingPermissions.get(sessionId);
		const idx = !list ? -1 : requestId === undefined ? 0 : list.findIndex((r) => r.requestId === requestId);
		if (!list || idx < 0 || idx >= list.length) return null;
		const [req] = list.splice(idx, 1);
		if (list.length === 0) pendingPermissions.delete(sessionId);
		clearTimeout(req.timer);
		const optionId = pickPermissionOption(req.options, decision);
		const client = activeClients.get(sessionId);
		client?.respond(req.requestId, permissionOutcome(optionId));
		client?.logEvent("permission_answer", { requestId: req.requestId, decision, optionId: optionId ?? null, by });
		const meta = sessions.get(sessionId);
		if (meta) {
			// The turn resumes now: the stall clock restarts from the answer, not the question.
			meta.lastMessageTime = Date.now();
			persistSessionMeta(meta, false);
		}
		updateStatusUI();
		if (by === "timeout") {
			sendAgentMessage(
				`The permission request of session ${sessionId} to run "${req.command}" got no answer and was rejected automatically; Devin continues without it. Answer the next request with "devin_permission", or restart the session with mode "dangerous".`,
			);
		}
		return { ...req, optionId };
	}

	// A line for devin_status: what the session's turn is blocked on, if anything.
	function permissionNote(sessionId: string): string {
		const list = pendingPermissions.get(sessionId);
		if (!list?.length) return "";
		const more = list.length > 1 ? ` (+${list.length - 1} more)` : "";
		return `\nAwaiting permission to run: ${list[0].command}${more}. Answer with "devin_permission".`;
	}

	// The turn ended: its requests can no longer be answered.
	function dropPendingPermissions(sessionId: string): void {
		const list = pendingPermissions.get(sessionId);
		if (!list) return;
		for (const r of list) clearTimeout(r.timer);
		pendingPermissions.delete(sessionId);
	}

	// Flush the accumulated assistant chunk buffer into the event log.
	function flushAssistantBuffer(meta: SessionMeta): void {
		const buf = assistantBuffers.get(meta.sessionId);
		if (!buf) return;
		assistantBuffers.delete(meta.sessionId);
		const client = activeClients.get(meta.sessionId);
		if (client) {
			client.appendAssistantMessage(buf);
		} else {
			appendEventLog(meta, "assistant_message", { text: buf });
		}
	}

	function appendEventLog(meta: SessionMeta, type: string, data: any): void {
		try {
			const p = getEventsLogPath(currentPiSessionId, meta.sessionId);
			fs.mkdirSync(path.dirname(p), { recursive: true });
			fs.appendFileSync(p, JSON.stringify({ timestamp: new Date().toISOString(), type, data }) + "\n");
		} catch (err) {
			logError(`Failed to append event for ${meta.sessionId}: ${extractCliError(err)}`);
		}
	}

	function extractChunkText(content: any): string {
		if (content == null) return "";
		if (typeof content === "string") return content;
		if (Array.isArray(content)) return content.map((p: any) => extractChunkText(p?.text ?? p)).join("");
		if (typeof content.text === "string") return content.text;
		return "";
	}

	function extractToolTitle(u: any): string | undefined {
		const parts = Array.isArray(u.content) ? u.content : [];
		for (const p of parts) {
			const t = p?.content?.text;
			if (typeof t === "string") return t.slice(0, 120);
			const d = p?.content?.description;
			if (typeof d === "string") return d.slice(0, 120);
			const title = p?.content?.title;
			if (typeof title === "string") return title.slice(0, 120);
		}
		return undefined;
	}

	// Backfill the final assistant message from the Devin session DB when the local
	// transcript does not have it (e.g. a turn that completed while pi was down, or a
	// pre-fix session falsely marked failed). sessions.id is the devin session id.
	async function tryDevinDbBackfill(meta: SessionMeta): Promise<string | null> {
		if (meta.dbBackfilled) return null;
		const dbPath = path.join(os.homedir(), ".devin-xdg-data", "devin", "cli", "sessions.db");
		let exists = false;
		try {
			exists = fs.existsSync(dbPath);
		} catch {}
		if (!exists) return null;
		let DatabaseSync: any;
		try {
			const mod: any = await import("node:sqlite");
			DatabaseSync = mod.DatabaseSync;
		} catch {
			return null; // node:sqlite unavailable (older node) — degrade gracefully
		}
		let db: any = null;
		try {
			db = new DatabaseSync(dbPath, { readOnly: true });
			const sess = db.prepare("SELECT id FROM sessions WHERE id = ?").get(meta.sessionId);
			if (!sess) return null;
			const rows = db
				.prepare("SELECT chat_message FROM message_nodes WHERE session_id = ? ORDER BY row_id DESC LIMIT 100")
				.all(meta.sessionId) as any[];
			for (const r of rows) {
				try {
					const j = JSON.parse(r.chat_message);
					if (j.role !== "assistant") continue;
					const c = j.content;
					const text =
						typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("") : "";
					if (text.trim()) return text;
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

	// Backfill + record the final message; returns the text (or null when unavailable).
	async function backfillFinalMessage(meta: SessionMeta): Promise<string | null> {
		const text = await tryDevinDbBackfill(meta);
		if (!text) return null;
		meta.dbBackfilled = true;
		appendEventLog(meta, "assistant_message", { text, backfilled: true });
		meta.lastMessageTime = Date.now();
		persistSessionMeta(meta, true);
		return text;
	}

	// Shared cancel path (tool + /devin cancel): terminal status, flush partial output,
	// dispose the live client, or kill an orphaned process directly when no client exists.
	// Returns "queued" | "session" | null (not found).
	function cancelSessionById(targetId: string): "queued" | "session" | null {
		const queueIndex = queue.findIndex((q) => q.queueId === targetId);
		if (queueIndex !== -1) {
			const queued = queue[queueIndex];
			queue.splice(queueIndex, 1);
			if (queued.worktreePath) {
				const selector = queued.worktreeId || `path:${queued.worktreePath}`;
				removeOrcaWorktree(selector).catch(() => {});
			}
			persistState();
			updateStatusUI();
			return "queued";
		}
		const meta = sessions.get(targetId);
		if (!meta) return null;
		meta.status = "cancelled";
		meta.finishedAt = Date.now();
		stopStallWatchdog(meta.sessionId);
		flushAssistantBuffer(meta);
		const client = activeClients.get(targetId);
		if (client) {
			client.notify("session/cancel", { sessionId: targetId });
			client.dispose();
			activeClients.delete(targetId);
		} else if (meta.pid && isPidAlive(meta.pid)) {
			killProcessGroup(meta.pid);
		}

		if (meta.worktreePath && meta.worktreeStatus === "active") {
			checkWorktreeSafety(meta.worktreePath, meta.worktreeBranch)
				.then((safety) => {
					if (safety.safe) {
						const selector = meta.worktreeId || `path:${meta.worktreePath}`;
						removeOrcaWorktree(selector)
							.then((rmRes) => {
								if (rmRes.ok) {
									meta.worktreeStatus = "released";
									persistSessionMeta(meta, true);
								}
							})
							.catch(() => {});
					}
				})
				.catch(() => {});
		}

		persistSessionMeta(meta, true);
		persistState();
		updateStatusUI();
		drainQueue();
		return "session";
	}

	function getStorageDir(piSessionId: string): string {
		return path.join(os.homedir(), ".pi", "agent", "devin_delegate", piSessionId);
	}

	function getSessionDir(piSessionId: string, devinSessionId: string): string {
		return path.join(getStorageDir(piSessionId), devinSessionId);
	}

	function getEventsLogPath(piSessionId: string, devinSessionId: string): string {
		return path.join(getSessionDir(piSessionId, devinSessionId), "events.jsonl");
	}

	function getMetaPath(piSessionId: string, devinSessionId: string): string {
		return path.join(getSessionDir(piSessionId, devinSessionId), "meta.json");
	}

	function getStatePath(piSessionId: string): string {
		return path.join(getStorageDir(piSessionId), "state.json");
	}

	function persistState(): void {
		try {
			const state: PersistedState = {
				maxRuns,
				totalInvoked,
				totalCompleted,
				queue,
				sessionIds: Array.from(sessions.keys()),
				sessionDirs: Object.fromEntries(Array.from(sessions.keys()).map((id) => [id, currentPiSessionId])),
			};
			for (const id of sessions.keys()) sessionDirs.set(id, currentPiSessionId);
			// Queued: the atomic tmp+rename is preserved, but the write no longer blocks the event loop
			// (this runs on every status change, including while turns stream).
			void stateWrites.write(getStatePath(currentPiSessionId), JSON.stringify(state, null, 2));
		} catch (err) {
			logError(`Failed to persist state: ${extractCliError(err)}`);
		}
	}

	// Debounced metadata updater to eliminate disk thrashing during streaming
	const pendingMetaSaves = new Map<string, { meta: SessionMeta; timer: NodeJS.Timeout }>();

	function persistSessionMeta(meta: SessionMeta, immediate = false): Promise<void> | void {
		const save = (): Promise<void> | void => {
			try {
				const metaPath = getMetaPath(currentPiSessionId, meta.sessionId);
				// Queued behind every other state write, in order, and off the event loop.
				return stateWrites.write(metaPath, JSON.stringify(meta, null, 2));
			} catch (err) {
				logError(`Failed to persist meta for ${meta.sessionId}: ${extractCliError(err)}`);
			}
		};

		if (immediate) {
			if (pendingMetaSaves.has(meta.sessionId)) {
				clearTimeout(pendingMetaSaves.get(meta.sessionId)!.timer);
				pendingMetaSaves.delete(meta.sessionId);
			}
			save();
			return;
		}

		if (!pendingMetaSaves.has(meta.sessionId)) {
			const timer = setTimeout(() => {
				pendingMetaSaves.delete(meta.sessionId);
				save();
			}, 3000);
			pendingMetaSaves.set(meta.sessionId, { meta, timer });
		}
	}

	function updateStatusUI(ui?: ExtensionUIContext): void {
		const targetUI = ui || lastUIContext;
		if (!targetUI) return;

		let stalledCount = 0;
		let settledCount = 0;
		for (const s of sessions.values()) {
			if (s.status === "stalled") stalledCount++;
			else if (["completed", "idle", "failed", "cancelled", "interrupted"].includes(s.status)) settledCount++;
		}
		const inFlight = slots.inFlight();
		const queuedCount = queue.length;
		const totalSettled = Math.max(settledCount, totalCompleted);

		if (inFlight === 0 && totalSettled === 0 && queuedCount === 0) {
			targetUI.setStatus("devin_delegate", undefined);
			return;
		}

		// Devin <in flight>/<limit> · <queued> queued · <completed> done (N stalled, M awaiting permission).
		// Stalled and permission-blocked sessions hold their slot, so they count as in flight: a separate
		// "running" figure read 0 while two frozen sessions blocked the whole queue (0/6/0).
		const notes = [
			stalledCount > 0 ? `${stalledCount} stalled` : "",
			pendingPermissions.size > 0 ? `${pendingPermissions.size} awaiting permission` : "",
		];
		const suffix = notes.filter(Boolean).join(", ");
		targetUI.setStatus(
			"devin_delegate",
			`Devin ${inFlight}/${maxRuns} · ${queuedCount} queued · ${totalCompleted} done${suffix ? ` (${suffix})` : ""}`,
		);
	}

	function sendAgentMessage(content: string): void {
		try {
			// "steer" lands after the current turn's tool calls; "followUp" would wait until the agent stops calling tools.
			pi.sendUserMessage(content, { deliverAs: "steer" });
		} catch (err) {
			logError(`Failed to send message to agent: ${extractCliError(err)}`);
		}
	}

	// Read last N messages on demand from disk with fixed-size tail buffer (O(1) RAM)
	function readLastMessagesFromDisk(meta: SessionMeta, count = 3): string[] {
		// Recovered sessions may keep their events file in the old (pre-restart)
		// directory — the state record carries the mapping.
		let filePath = getEventsLogPath(currentPiSessionId, meta.sessionId);
		const recordedDir = sessionDirs.get(meta.sessionId);
		if (!fs.existsSync(filePath) && recordedDir && recordedDir !== currentPiSessionId) {
			const oldPath = path.join(getStorageDir(recordedDir), meta.sessionId, "events.jsonl");
			if (fs.existsSync(oldPath)) filePath = oldPath;
		}
		if (!fs.existsSync(filePath)) {
			return [`(Session initialized: "${meta.prompt.slice(0, 100)}")`];
		}
		try {
			const stat = fs.statSync(filePath);
			if (stat.size === 0) {
				return [`(Initial prompt: "${meta.prompt.slice(0, 100)}")`];
			}
			const bufferSize = Math.min(stat.size, 65536);
			const buffer = Buffer.alloc(bufferSize);
			const fd = fs.openSync(filePath, "r");
			try {
				fs.readSync(fd, buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
			} finally {
				fs.closeSync(fd);
			}

			const chunk = buffer.toString("utf-8");
			const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
			const messages: string[] = [];

			for (let i = lines.length - 1; i >= 0 && messages.length < count; i--) {
				try {
					const obj = JSON.parse(lines[i]);
					if (obj.type === "assistant_message" && obj.data?.text) {
						messages.unshift(`[Devin]: ${obj.data.text.trim()}`);
					} else if (obj.type === "user_message" && obj.data?.text) {
						messages.unshift(`[User]: ${obj.data.text.trim()}`);
					} else if (obj.type === "tool_call" && obj.data) {
						const label = obj.data.title || obj.data.status;
						if (label) messages.unshift(`[Tool]: ${label}`);
					} else if (obj.type === "usage_update" && obj.data) {
						const total = obj.data.tokens?.total ?? "?";
						messages.unshift(`[Usage]: ${total} tokens`);
					} else if (obj.type === "error" && obj.data) {
						messages.unshift(`[Error]: ${JSON.stringify(obj.data)}`);
					}
				} catch {}
			}

			if (messages.length === 0) {
				messages.push(`(Initial prompt: "${meta.prompt.slice(0, 100)}")`);
			}
			return messages;
		} catch {
			return [`(Error reading log for ${meta.sessionId})`];
		}
	}

	// Read full transcript on demand from disk
	function readFullTranscriptFromDisk(meta: SessionMeta): string {
		const filePath = getEventsLogPath(currentPiSessionId, meta.sessionId);
		if (!fs.existsSync(filePath)) {
			return `No transcript logged yet for session ${meta.sessionId}. Initial prompt: "${meta.prompt}"`;
		}
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.split("\n").filter((l) => l.trim().length > 0);
			const transcript: string[] = [];

			for (const line of lines) {
				try {
					const obj = JSON.parse(line);
					if (obj.type === "assistant_message" && obj.data?.text) {
						transcript.push(`[${obj.timestamp}] Devin: ${obj.data.text.trim()}`);
					} else if (obj.type === "user_message" && obj.data?.text) {
						transcript.push(`[${obj.timestamp}] User: ${obj.data.text.trim()}`);
					} else if (obj.type === "error") {
						transcript.push(`[${obj.timestamp}] Error: ${JSON.stringify(obj.data)}`);
					}
				} catch {}
			}
			return transcript.join("\n\n") || `Initial prompt: "${meta.prompt}" (no assistant turns logged)`;
		} catch (err: any) {
			return `Failed to read transcript for ${meta.sessionId}: ${err.message}`;
		}
	}

	// --- Worktree Management ---

	async function getGitBranch(cwd: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
			return stdout.trim() || "main";
		} catch {
			return "main";
		}
	}

	async function findNextWorktreeIndex(cwd: string, baseBranch: string): Promise<number> {
		try {
			const { stdout } = await execFileAsync("git", ["branch", "--list", `${baseBranch}-dt*`], { cwd });
			const lines = stdout.split("\n").map((l) => l.trim().replace(/^[*+]\s*/, ""));
			const indices: number[] = [];
			const escapedBase = baseBranch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const reg = new RegExp(`^${escapedBase}-dt(\\d+)$`);

			for (const line of lines) {
				const match = line.match(reg);
				if (match) {
					indices.push(parseInt(match[1], 10));
				}
			}
			return indices.length > 0 ? Math.max(...indices) + 1 : 1;
		} catch {
			return 1;
		}
	}

	async function getRootRepoName(cwd: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], { cwd });
			const commonDir = stdout.trim();
			const gitDir = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
			return path.basename(path.dirname(gitDir));
		} catch {
			try {
				const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd });
				return path.basename(stdout.trim());
			} catch {
				return path.basename(cwd);
			}
		}
	}

	async function createWorktree(
		cwd: string,
	): Promise<{ worktreePath: string; worktreeBranch: string; worktreeId?: string; parentWorktreeId?: string }> {
		const currentBranch = await getGitBranch(cwd);
		const baseBranch = currentBranch.replace(/^refs\/heads\//, "");
		let index = await findNextWorktreeIndex(cwd, baseBranch);
		const orcaAvailable = await isCommandAvailable("orca");
		const repoName = await getRootRepoName(cwd);

		while (true) {
			const targetBranch = `${baseBranch}-dt${index}`;
			const targetFolder = path.join(os.homedir(), "orca", "workspaces", repoName, targetBranch);

			if (fs.existsSync(targetFolder)) {
				index++;
				continue;
			}

			let orcaFailure: string | undefined;
			if (orcaAvailable) {
				try {
					const { stdout } = await execFileAsync(
						"orca",
						["worktree", "create", "--name", targetBranch, "--base-branch", baseBranch, "--json"],
						{ cwd },
					);
					const parsed = JSON.parse(stdout);
					// orca exiting 0 with an `ok: false` payload is still a failure.
					if (parsed && parsed.ok === false) {
						const m = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
						throw new Error(m ?? "orca worktree create failed");
					}
					const createdPath = parsed.result?.worktree?.path || targetFolder;
					const worktreeId = parsed.result?.worktree?.id;
					const parentWorktreeId = parsed.result?.worktree?.parentWorktreeId;
					return {
						worktreePath: createdPath,
						worktreeBranch: targetBranch,
						worktreeId,
						parentWorktreeId,
					};
				} catch (orcaErr) {
					// orca reports failures as `ok: false` JSON on stdout and exits
					// non-zero; surface the real error instead of a generic
					// "Command failed" before falling back to git.
					orcaFailure = extractCliError(orcaErr) || "unknown orca failure";
					logWarn(`orca worktree create failed for ${targetBranch}, falling back to git: ${orcaFailure}`);
				}
			}

			// Fallback: Git worktree
			try {
				fs.mkdirSync(path.dirname(targetFolder), { recursive: true });
				await execFileAsync("git", ["worktree", "add", "-b", targetBranch, targetFolder, baseBranch], { cwd });
			} catch (gitErr) {
				const gitFailure = extractCliError(gitErr) || String(gitErr);
				throw new Error(orcaFailure ? `orca: ${orcaFailure}; git fallback: ${gitFailure}` : gitFailure);
			}
			return { worktreePath: targetFolder, worktreeBranch: targetBranch };
		}
	}

	// --- PR Detection ---

	async function detectPullRequest(cwd: string, branch?: string): Promise<number | undefined> {
		if (!(await isCommandAvailable("gh"))) return undefined;

		// 1. Determine candidate branches: actual checked out branch in cwd, followed by provisioned worktree branch
		const candidateBranches: string[] = [];
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
			const currentBranch = stdout.trim();
			if (currentBranch && currentBranch !== "HEAD") {
				candidateBranches.push(currentBranch);
			}
		} catch {}

		if (branch && !candidateBranches.includes(branch)) {
			candidateBranches.push(branch);
		}

		for (const b of candidateBranches) {
			try {
				const { stdout } = await execFileAsync("gh", ["pr", "view", b, "--json", "number"], { cwd });
				const parsed = JSON.parse(stdout);
				if (parsed.number && typeof parsed.number === "number") {
					return parsed.number;
				}
			} catch {}
		}

		// Fallback: gh pr view from worktree directory without branch selector
		try {
			const { stdout } = await execFileAsync("gh", ["pr", "view", "--json", "number"], { cwd });
			const parsed = JSON.parse(stdout);
			if (parsed.number && typeof parsed.number === "number") {
				return parsed.number;
			}
		} catch {}

		return undefined;
	}

	// Wire ACP client events consistently across fresh and re-attached sessions
	function wireClientEvents(client: AcpClient, meta: SessionMeta): void {
		const configOptions = new Map<string, string[]>();
		sessionConfigOptions.set(meta.sessionId, configOptions);

		client.setOnRequest((req) => {
			if (req.method !== "session/request_permission") return false;
			onPermissionRequest(meta, req.id, req.params);
			return true;
		});

		client.setOnUpdate((update) => {
			meta.lastMessageTime = Date.now();
			// Activity resumed: a stalled turn with new updates goes back to running,
			// and its watchdog (stopped when it marked stalled) must restart.
			if (meta.status === "stalled") {
				meta.status = "running";
				startStallWatchdog(meta);
			}
			const u = update.update;
			if (u) {
				if (u.sessionUpdate === "agent_message" && u.content) {
					flushAssistantBuffer(meta);
					client.appendAssistantMessage(typeof u.content === "string" ? u.content : JSON.stringify(u.content));
				} else if (u.sessionUpdate === "agent_message_chunk") {
					// Devin streams assistant output as chunks; accumulate and flush every ~2KB
					// so devin_status and the dashboard see real progress and final output.
					const text = extractChunkText(u.content);
					if (text) {
						const buf = (assistantBuffers.get(meta.sessionId) || "") + text;
						if (buf.length >= 2000) {
							flushAssistantBuffer(meta);
						} else {
							assistantBuffers.set(meta.sessionId, buf);
						}
					}
				} else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
					client.logEvent("tool_call", { toolCallId: u.toolCallId, title: extractToolTitle(u), status: u.status });
				} else if (u.sessionUpdate === "usage_update") {
					client.logEvent("usage_update", {
						used: u.used,
						size: u.size,
						tokens: {
							total: u.usage?.totalTokens ?? u.totalTokens,
							input: u.usage?.inputTokens ?? u.inputTokens,
							output: u.usage?.outputTokens ?? u.outputTokens,
						},
					});
				} else if (u.sessionUpdate === "config_option_update" && Array.isArray(u.configOptions)) {
					for (const co of u.configOptions) {
						if (co && co.id && Array.isArray(co.options)) configOptions.set(co.id, optionValues(co.options));
					}
				}
			}
			persistSessionMeta(meta, false);
		});

		client.setOnExit((code) => {
			const turnInFlight = meta.status === "running" || meta.status === "stalled";
			stopStallWatchdog(meta.sessionId);
			// Always drop the client — even when the process dies between turns, a stale
			// entry would let devin_message write to a destroyed stdin.
			activeClients.delete(meta.sessionId);
			if (turnInFlight) {
				flushAssistantBuffer(meta);
				// A mid-turn process exit is an interruption, not a failure: the devin
				// session is recoverable via devin_restart (or DB backfill on recovery).
				meta.status = code === 0 ? "idle" : "interrupted";
				meta.finishedAt = Date.now();
				if (code !== 0) {
					meta.error = `devin acp exited with code ${code} (turn in flight)`;
					sendAgentMessage(
						`The session ${meta.sessionId} was interrupted: ${meta.error}. Check it with "devin_status" or restart it with "devin_restart".`,
					);
				}
				persistSessionMeta(meta, true);
				totalCompleted++;
				persistState();
				updateStatusUI();
				drainQueue();
			}
		});
	}

	// --- Session Execution Engine ---

	async function startSession(task: QueuedTask): Promise<SessionMeta> {
		const targetCwd = task.worktreePath || baseDir;
		const client = new AcpClient(targetCwd, task.model);
		try {
			await client.start();

			// Create session in ACP
			const newSessionRes = await client.request("session/new", {
				cwd: targetCwd,
				mcpServers: [],
			});
			const realSessionId = newSessionRes.sessionId as string;

			// Set real log file path now that session ID is resolved (zero file rename conflicts)
			const realLogFile = getEventsLogPath(currentPiSessionId, realSessionId);
			client.setLogFilePath(realLogFile);

			const meta: SessionMeta = {
				sessionId: realSessionId,
				queueId: task.queueId,
				prompt: task.prompt,
				model: task.model,
				mode: task.mode,
				createWorktree: task.createWorktree,
				worktreePath: task.worktreePath,
				worktreeBranch: task.worktreeBranch,
				worktreeId: task.worktreeId,
				parentWorktreeId: task.parentWorktreeId,
				worktreeStatus: task.worktreePath ? "active" : undefined,
				status: "running",
				createdAt: task.enqueuedAt,
				startedAt: Date.now(),
				lastMessageTime: Date.now(),
				turnStartedAt: Date.now(),
				pid: client.pid,
			};

			sessions.set(realSessionId, meta);
			activeClients.set(realSessionId, client);
			persistSessionMeta(meta, true);
			persistState();
			updateStatusUI();

			wireClientEvents(client, meta);

			// Configure ACP mode (validated against the advertised config vocabulary when known).
			// The model is set authoritatively via the --model spawn flag above; there is
			// deliberately no set_config_option(model) call — the ACP config vocabulary does
			// not cover every CLI model (e.g. swe-2-max) and the redundant call used to
			// fail with -32602 "Invalid value".
			// The tools validate the mode; a task queued before that validation may still carry an old value.
			const resolvedMode = resolveAcpMode(task.mode);
			const acpMode = resolvedMode.ok ? resolvedMode.acpMode : task.mode;
			try {
				await client.request("session/set_mode", {
					sessionId: realSessionId,
					modeId: acpMode,
				});
			} catch (err: any) {
				const knownModes = sessionConfigOptions.get(realSessionId)?.get("mode");
				logWarn(`set_mode ${acpMode} failed${knownModes ? ` (valid modes: ${knownModes.join(", ")})` : ""}: ${extractCliError(err)}`);
			}

			// Turn liveness watchdog (replaces the old hard 60s prompt timeout)
			startStallWatchdog(meta);

			// Execute initial prompt asynchronously — no response timeout: a turn completes
			// when the ACP session/prompt response arrives, minutes or hours later.
			client.appendUserMessage(task.prompt);
			client
				.request(
					"session/prompt",
					{
						sessionId: realSessionId,
						prompt: [{ type: "text", text: task.prompt }],
					},
					0,
				)
				.then(async () => {
					stopStallWatchdog(meta.sessionId);
					flushAssistantBuffer(meta);
					meta.status = "idle";
					meta.turnCompletedAt = Date.now();
					meta.finishedAt = Date.now();
					totalCompleted++;
					persistSessionMeta(meta, true);

					// Detect PR if worktree was created
					let prSuffix = " No pullrequest was created";
					if (task.worktreePath) {
						const prNum = await detectPullRequest(task.worktreePath, task.worktreeBranch);
						if (prNum) {
							meta.detectedPrNumber = prNum;
							prSuffix = ` The session created the pr #${prNum}`;
							persistSessionMeta(meta, true);
						}
					}

					persistState();
					updateStatusUI();

					// Turn complete notification
					sendAgentMessage(
						`The session ${meta.sessionId} is done. use the "devin_status" to check the session last messages. or "devin_message" to send a new message.${prSuffix}`,
					);

					drainQueue();
				})
				.catch((err) => {
					// Only override a turn that is still in flight: onExit (idle/interrupted)
					// and devin_cancel (cancelled) already set the terminal state.
					if (meta.status === "running" || meta.status === "stalled") {
						stopStallWatchdog(meta.sessionId);
						flushAssistantBuffer(meta);
						meta.status = "failed";
						meta.error = err.message || String(err);
						meta.finishedAt = Date.now();
						persistSessionMeta(meta, true);
						persistState();
						updateStatusUI();

						sendAgentMessage(
							`The session ${meta.sessionId} failed: ${meta.error}. You can check details with "devin_status" or restart it with "devin_restart".`,
						);
						drainQueue();
					}
				});

			return meta;
		} catch (err) {
			// Spawn/handshake/session-new failed: kill the spawned child so it is not
			// an untracked orphan, then surface the error.
			client.dispose();
			throw err;
		}
	}

	let isDraining = false;
	async function drainQueue(): Promise<void> {
		if (isDraining) {
			// A drain is in progress; its post-loop recheck picks up new capacity.
			return;
		}
		isDraining = true;
		try {
			while (queue.length > 0) {
				// Reserve before the first await: a start only counts once its session registers, and
				// this loop does not wait for that, so counting sessions alone emptied the whole queue.
				const release = slots.tryReserve();
				if (!release) break;
				const task = queue.shift()!;
				persistState();
				updateStatusUI();

				// Prepare worktree if needed
				if (task.createWorktree && !task.worktreePath) {
					try {
						const wt = await createWorktree(baseDir);
						task.worktreePath = wt.worktreePath;
						task.worktreeBranch = wt.worktreeBranch;
						task.worktreeId = wt.worktreeId;
						task.parentWorktreeId = wt.parentWorktreeId;
						task.worktreeStatus = "active";
					} catch (err: any) {
						logError(`Failed to create worktree for queued task ${task.queueId}: ${extractCliError(err)}`);
					}
				}

				startSession(task)
					.then((meta) => {
						// Notify agent as soon as queued session starts
						sendAgentMessage(`Your session started with id: ${meta.sessionId}`);
					})
					.catch((err) => {
						const reason = extractCliError(err);
						logError(`Failed to start dequeued session ${task.queueId}: ${reason}`);
						// The agent was promised a session id for this task: say it is not coming.
						sendAgentMessage(`The queued task ${task.queueId} failed to start: ${reason}. Delegate it again with "devin_delegate".`);
					})
					.finally(() => {
						// Registered (it holds its own slot now) or failed (the slot is free for the next task).
						release();
						drainQueue();
					});
			}
		} finally {
			isDraining = false;
		}
		// Recheck: turns may have completed (or a session failed to start) while we were
		// draining, and drain calls made during the drain were skipped by the guard.
		if (queue.length > 0 && slots.inFlight() < maxRuns) {
			drainQueue();
		}
	}

	// --- Startup & Crash Recovery ---

	async function recoverState(piSessionId: string, signal?: AbortSignal): Promise<void> {
		currentPiSessionId = piSessionId;
		const sPath = getStatePath(piSessionId);
		let raw: string | null = null;
		try {
			raw = await readTextFileWithRetry(sPath);
		} catch {
			raw = null;
		}
		if (signal?.aborted) return;
		if (raw == null) {
			persistState();
			return;
		}

		let state: PersistedState;
		try {
			state = JSON.parse(raw);
		} catch (err) {
			logError(`Error recovering state (bad state.json): ${extractCliError(err)}`);
			return;
		}

		try {
			// Do not let default flag override a custom persisted limit
			const flagRuns = pi.getFlag("devin-max-runs");
			if (flagRuns !== undefined && flagRuns !== null) {
				const parsed = parseInt(String(flagRuns), 10);
				if (!isNaN(parsed) && parsed > 0) maxRuns = parsed;
			} else if (state.maxRuns && state.maxRuns > 0) {
				maxRuns = state.maxRuns;
			}

			totalInvoked = state.totalInvoked || 0;
			totalCompleted = state.totalCompleted || 0;
			for (const [id, dir] of Object.entries(state.sessionDirs ?? {})) {
				sessionDirs.set(id, dir);
			}

			// Restore session records from disk (current dir first, then the dir the
			// session was persisted to — self-describing sessionDirs).
			if (Array.isArray(state.sessionIds)) {
				for (const sId of state.sessionIds) {
					const candidates = [getMetaPath(piSessionId, sId)];
					const recorded = state.sessionDirs?.[sId];
					if (recorded && recorded !== piSessionId) {
						candidates.push(path.join(getStorageDir(recorded), sId, "meta.json"));
					}
					let meta: SessionMeta | null = null;
					for (const mPath of candidates) {
						if (signal?.aborted) return;
						try {
							meta = JSON.parse(await readTextFileWithRetry(mPath)) as SessionMeta;
							break;
						} catch {}
					}
					if (!meta) continue;

					// Reconcile in-flight sessions: was the devin process still alive
					// (orphaned) when pi came back?
					if (meta.status === "running" || meta.status === "stalled") {
						if (meta.pid && isPidAlive(meta.pid)) {
							// Orphan: the ACP connection is gone with the old process,
							// so the process is dead weight — terminate it.
							killProcessGroup(meta.pid);
							meta.status = "interrupted";
							meta.finishedAt = Date.now();
							meta.error =
								"pi session restarted; the devin process was still running (orphaned) and was terminated. Restart with devin_restart.";
							persistSessionMeta(meta, true);
						} else {
							// Process is dead: the turn may have completed on devin's side
							// while pi was down — check the devin session DB.
							tasks.run(`backfill-${sId}`, async (backfillSignal) => {
								try {
									const text = await backfillFinalMessage(meta);
									// The session may have shut down (or the budget expired) while the session DB
									// was read. Its results belong to the session that is gone, and the drain
									// below could otherwise start Devin runs for a session that no longer exists.
									if (backfillSignal.aborted) return;
									if (text) {
										meta.status = "idle";
										meta.finishedAt = Date.now();
										totalCompleted++;
										sendAgentMessage(
											`The session ${meta.sessionId} completed while pi was down (recovered from the devin session DB). Check it with "devin_status".`,
										);
									} else {
										meta.status = "interrupted";
										meta.finishedAt = Date.now();
										meta.error = "Process interrupted unexpectedly (pi session restart)";
									}
									persistSessionMeta(meta, true);
									persistState();
								} catch (err) {
									logError(`Error reconciling session ${meta.sessionId}: ${extractCliError(err)}`);
								}
								if (backfillSignal.aborted) return;
								updateStatusUI();
								drainQueue();
							});
						}
					}
					sessions.set(sId, meta);
					// Re-anchor the meta under the current storage dir (fixes split state).
					persistSessionMeta(meta, true);
				}
			}

			// Restore queue. Nothing can have been queued yet: every tool path awaits `recoveryDone`
			// before it mutates state, so this overwrite cannot discard a live delegation.
			if (Array.isArray(state.queue)) {
				queue.length = 0;
				for (const q of state.queue) {
					queue.push(q);
				}
			}

			persistState();
			updateStatusUI();
			// Resume processing pending queue
			drainQueue();
		} catch (err) {
			logError(`Error recovering state: ${extractCliError(err)}`);
		}
	}

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		const startedAt = performance.now();
		tasks.resume();
		lastUIContext = ctx.ui;
		baseDir = ctx.cwd;
		const piId = ctx.sessionManager?.getSessionId() || "default";
		// Detached: Pi awaits session_start before it paints the restored transcript, so the disk reads
		// and orphan reconciliation land afterwards (the status line and queue drain update when done).
		// `recoveryDone` is the gate tool paths wait on; run() never rejects, so it is safe to keep.
		recoveryDone = tasks.run(
			"recover-state",
			async (signal) => {
				await recoverState(piId, signal);
			},
			{ budgetMs: BOOT_BUDGET_MS },
		);
		// (test hook: recovery and state writes are deliberately not awaited on boot)
		(globalThis as any).__PI_DEVIN_FLUSH__ = async (timeoutMs?: number) => {
			const limit = timeoutMs ?? 10_000;
			await tasks.flush(limit);
			await stateWrites.drain(limit);
		};
		checkBudget("session_start", startedAt);
	});

	// Recovery is detached, so it owns a gate: a tool call that lands while its disk reads are still
	// running would otherwise see partial state *and* have its mutations overwritten when recovery
	// finishes (`queue.length = 0`, the restored counters). Tool paths await this first — waiting is
	// correct there, because the agent asked for the data and Pi is not on a lifecycle boundary.
	let recoveryDone: Promise<void> = Promise.resolve();

	function cleanupAllClients(): void {
		for (const client of activeClients.values()) {
			client.dispose();
		}
		activeClients.clear();
	}

	// Release the load guard so a session switch (/resume, /new, /reload) re-registers the tools.
	// Also drop the PR-closed hook so a stale closure can't pin this generation's state.
	// Release all per-session state (maps, timers, buffers): a new pi session
	// (/new, /resume of another session, /switch) must start clean and the previous
	// session's state must be GC-able. On-disk state is untouched: recoverState
	// re-anchors it via sessionDirs when the same pi session id resumes, so
	// devin_restart still recovers those sessions. Timers are cleared directly —
	// dispose() suppresses the child 'exit' callback, so the indirect stop path via
	// the rejected prompt promise is not relied on.
	// (Dropping lastUIContext: delayed diagnostics after shutdown fall back to
	// console instead of calling notify on a dead context.)
	pi.on("session_shutdown", async () => {
		// Stop recovery work and flush queued state: Pi awaits session_shutdown, so the last write of
		// the session is durable even though writes are no longer synchronous.
		tasks.abort();
		await stateWrites.drain(5_000);
		delete (globalThis as any)[GLOBAL_GUARD_KEY];
		delete (globalThis as any).__PI_ON_PR_CLOSED_DEVIN__;
		delete (globalThis as any).__PI_DEVIN_FLUSH__;
		lastUIContext = undefined;
		cleanupAllClients();
		for (const t of stallTimers.values()) clearInterval(t);
		stallTimers.clear();
		for (const p of pendingMetaSaves.values()) clearTimeout(p.timer);
		pendingMetaSaves.clear();
		sessions.clear();
		queue.length = 0;
		sessionConfigOptions.clear();
		sessionDirs.clear();
		assistantBuffers.clear();
		totalInvoked = 0;
		totalCompleted = 0;
		currentPiSessionId = "default";
	});

	// Block the agent from driving the devin CLI through bash/powershell (read-only subcommands stay allowed).
	// Covers codemode scripts too, since their nested tool calls pass through this handler.
	pi.on("tool_call", async (event) => {
		if (allowBash) return;
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !findBlockedDevinCommand(command)) return;
		return { block: true, reason: DEVIN_BASH_BLOCK_REASON };
	});

	// Register OS process exit hooks to prevent orphaned Devin processes
	// (module-scope, registered once per process — see registerProcessExitHooks)
	currentProcessExitCleanup = cleanupAllClients;
	registerProcessExitHooks();

	// --- Tool Registrations ---

	// 1. devin_delegate
	pi.registerTool({
		name: "devin_delegate",
		label: "Devin Delegate",
		description:
			"Delegates a coding or research task to Devin in the background. Runs asynchronously and queues if concurrency limit is exceeded.",
		parameters: Type.Object({
			prompt: Type.String({
				description: "Instructions and task description for Devin",
			}),
			model: Type.Optional(
				Type.String({
					description: "Devin model to use (default: swe-2-high)",
				}),
			),
			mode: Type.Optional(
				Type.String({
					description: MODE_DESCRIPTION,
				}),
			),
			create_worktree: Type.Optional(
				Type.Boolean({
					description: "Create an isolated worktree branch for this session (default: false)",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			// Recovery runs detached from session_start: wait for it before reading or mutating state,
			// or this call's changes are overwritten when recovery finishes (queue, counters).
			await recoveryDone;
			baseDir = ctx.cwd;
			// Do not re-anchor on tool calls: storage stays with the session_start anchor.
			const toolPiId = ctx.sessionManager?.getSessionId();
			if (toolPiId) {
				if (currentPiSessionId === "default") {
					currentPiSessionId = toolPiId;
				} else if (toolPiId !== currentPiSessionId) {
					logWarn(`pi session id mismatch (tool: ${toolPiId}, anchored: ${currentPiSessionId}); keeping anchored storage dir`);
				}
			}

			const prompt = params.prompt;
			const model = params.model || "swe-2-high";
			const mode = params.mode || "dangerous";
			const createWorktreeReq = Boolean(params.create_worktree);
			const modeCheck = resolveAcpMode(mode);
			if (!modeCheck.ok) {
				return {
					details: toolDetails("devin_delegate", { result: "invalid_mode", code: "INVALID_MODE" }),
					content: [{ type: "text", text: modeCheck.error }],
					isError: true,
				};
			}

			totalInvoked++;
			const queueId = `q-${totalInvoked}`;

			// FIFO: while tasks wait, a new one queues behind them. The slot is reserved before the first
			// await, or parallel calls all see the same free slots (6 calls, 6 starts, limit 2).
			const release = queue.length === 0 ? slots.tryReserve() : null;
			if (release) {
				try {
					// Start immediately
					let wtPath: string | undefined;
					let wtBranch: string | undefined;
					let wtId: string | undefined;
					let parentWtId: string | undefined;

					if (createWorktreeReq) {
						try {
							const wt = await createWorktree(ctx.cwd);
							wtPath = wt.worktreePath;
							wtBranch = wt.worktreeBranch;
							wtId = wt.worktreeId;
							parentWtId = wt.parentWorktreeId;
						} catch (err: any) {
							return {
								details: toolDetails("devin_delegate", { result: "worktree_create_failed", code: "WORKTREE_CREATE_FAILED" }),
								content: [{ type: "text", text: `Error creating worktree: ${err.message}` }],
								isError: true,
							};
						}
					}

					const task: QueuedTask = {
						queueId,
						prompt,
						model,
						mode,
						createWorktree: createWorktreeReq,
						worktreePath: wtPath,
						worktreeBranch: wtBranch,
						worktreeId: wtId,
						parentWorktreeId: parentWtId,
						worktreeStatus: wtPath ? "active" : undefined,
						enqueuedAt: Date.now(),
					};

					try {
						const meta = await startSession(task);
						return {
							details: toolDetails("devin_delegate", { result: "session_started", sessionId: meta.sessionId }),
							content: [{ type: "text", text: `Your session started with id: ${meta.sessionId}` }],
						};
					} catch (err: any) {
						return {
							details: toolDetails("devin_delegate", { result: "session_start_failed", code: "SESSION_START_FAILED" }),
							content: [{ type: "text", text: `Failed to start Devin session: ${err.message}` }],
							isError: true,
						};
					}
				} finally {
					release();
					drainQueue();
				}
			} else {
				// Queue session
				const task: QueuedTask = {
					queueId,
					prompt,
					model,
					mode,
					createWorktree: createWorktreeReq,
					enqueuedAt: Date.now(),
				};
				queue.push(task);
				const position = queue.length;
				const queuePendingTotal = queue.length;
				persistState();
				updateStatusUI(ctx.ui);
				drainQueue();

				return {
					details: toolDetails("devin_delegate", { result: "queued", queueId, queuePosition: position, queueTotal: queuePendingTotal }),
					content: [
						{
							type: "text",
							text: `Your session was queued as ${position} of ${queuePendingTotal}. You will receive the session id as soon it start`,
						},
					],
				};
			}
		},
	});

	// 2. devin_status
	pi.registerTool({
		name: "devin_status",
		label: "Devin Status",
		description: "Checks status and recent or full messages for Devin sessions. Reads on-demand from disk without RAM memory overhead.",
		parameters: Type.Object({
			session_id: Type.Optional(
				Type.String({
					description: "Session ID to check. If omitted, returns recent messages for all sessions.",
				}),
			),
			complete: Type.Optional(
				Type.Boolean({
					description: "If true, returns full message history. Requires session_id.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			// Recovery runs detached from session_start: wait for it before reading or mutating state,
			// or this call's changes are overwritten when recovery finishes (queue, counters).
			await recoveryDone;
			// Do not re-anchor on tool calls (same rule as devin_delegate).
			const toolPiId = ctx.sessionManager?.getSessionId();
			if (toolPiId && currentPiSessionId !== "default" && toolPiId !== currentPiSessionId) {
				logWarn(`pi session id mismatch (tool: ${toolPiId}, anchored: ${currentPiSessionId}); keeping anchored storage dir`);
			}
			if (params.complete && !params.session_id) {
				return {
					details: toolDetails("devin_status", {
						result: "invalid_params",
						code: "INVALID_PARAMS",
						reason: "complete_requires_session_id",
					}),
					content: [{ type: "text", text: "The 'complete' parameter requires a 'session_id'." }],
					isError: true,
				};
			}

			if (params.session_id) {
				// Check active/finished sessions
				const meta = sessions.get(params.session_id);
				if (meta) {
					if (params.complete) {
						const transcript = readFullTranscriptFromDisk(meta);
						return {
							details: toolDetails("devin_status", { result: "full_transcript", sessionId: meta.sessionId, status: meta.status }),
							content: [
								{
									type: "text",
									text: `Full transcript for session ${meta.sessionId} (Status: ${meta.status}):\n\n${transcript}`,
								},
							],
						};
					}

					let lastMessages = readLastMessagesFromDisk(meta, 3);
					// On-demand backfill: terminal session with no assistant output in the
					// local transcript (e.g. pre-fix false-failed, or completed while pi was down).
					if (
						["idle", "failed", "interrupted"].includes(meta.status) &&
						!meta.dbBackfilled &&
						!lastMessages.some((m) => m.startsWith("[Devin]"))
					) {
						try {
							await backfillFinalMessage(meta);
							lastMessages = readLastMessagesFromDisk(meta, 3);
						} catch {}
					}
					const timeStr = meta.lastMessageTime ? new Date(meta.lastMessageTime).toISOString() : "N/A";
					const prStr = meta.detectedPrNumber ? ` | PR: #${meta.detectedPrNumber}` : "";

					return {
						details: toolDetails("devin_status", {
							result: "session_summary",
							sessionId: meta.sessionId,
							status: meta.status,
							prNumber: meta.detectedPrNumber ?? null,
						}),
						content: [
							{
								type: "text",
								text: `Session ${meta.sessionId} (Status: ${meta.status}${prStr})${permissionNote(meta.sessionId)}\nLast message time: ${timeStr}\n\nLast 3 messages:\n${lastMessages.join("\n")}`,
							},
						],
					};
				}

				// Check queued tasks
				const queuedTask = queue.find((q) => q.queueId === params.session_id);
				if (queuedTask) {
					const pos = queue.indexOf(queuedTask) + 1;
					return {
						details: toolDetails("devin_status", {
							result: "queued_task",
							queueId: queuedTask.queueId,
							queuePosition: pos,
							queueTotal: queue.length,
						}),
						content: [
							{
								type: "text",
								text: `Queued task ${queuedTask.queueId} (Position: ${pos} of ${queue.length})\nPrompt: "${queuedTask.prompt}"\nModel: ${queuedTask.model} | Mode: ${queuedTask.mode}`,
							},
						],
					};
				}

				return {
					details: toolDetails("devin_status", { result: "not_found", code: "NOT_FOUND", requested: String(params.session_id ?? "") }),
					content: [{ type: "text", text: `Devin session or queued task '${params.session_id}' not found.` }],
					isError: true,
				};
			}

			// No session_id: return 3 last messages for each session and summary of queued items
			if (sessions.size === 0 && queue.length === 0) {
				return {
					details: toolDetails("devin_status", { result: "nothing_registered" }),
					content: [{ type: "text", text: "No Devin sessions or queued tasks registered yet." }],
				};
			}

			const summaries: string[] = [];
			for (const meta of sessions.values()) {
				let lastMessages = readLastMessagesFromDisk(meta, 3);
				if (
					["idle", "failed", "interrupted"].includes(meta.status) &&
					!meta.dbBackfilled &&
					!lastMessages.some((m) => m.startsWith("[Devin]"))
				) {
					try {
						await backfillFinalMessage(meta);
						lastMessages = readLastMessagesFromDisk(meta, 3);
					} catch {}
				}
				const timeStr = meta.lastMessageTime ? new Date(meta.lastMessageTime).toISOString() : "N/A";
				const prStr = meta.detectedPrNumber ? ` | PR: #${meta.detectedPrNumber}` : "";

				summaries.push(
					`Session: ${meta.sessionId} [${meta.status.toUpperCase()}${prStr}]${permissionNote(meta.sessionId)}\nLast message time: ${timeStr}\nLast 3 messages:\n${lastMessages.join("\n")}`,
				);
			}

			if (queue.length > 0) {
				const queueList = queue.map((q, idx) => `  ${idx + 1}. [${q.queueId}] "${q.prompt.slice(0, 60)}" (${q.model})`).join("\n");
				summaries.push(`Queued Tasks (${queue.length}):\n${queueList}`);
			}

			return {
				details: toolDetails("devin_status", { result: "all_sessions", sessionCount: sessions.size, queueTotal: queue.length }),
				content: [{ type: "text", text: summaries.join("\n\n---\n\n") }],
			};
		},
	});

	// 3. devin_message
	pi.registerTool({
		name: "devin_message",
		label: "Devin Message",
		description: "Sends a follow-up message or prompt to an existing Devin session.",
		parameters: Type.Object({
			session_id: Type.String({
				description: "Session ID of the Devin session",
			}),
			message: Type.String({
				description: "Message or follow-up instruction to send",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			// Recovery runs detached from session_start: wait for it before reading or mutating state,
			// or this call's changes are overwritten when recovery finishes (queue, counters).
			await recoveryDone;
			const meta = sessions.get(params.session_id);
			if (!meta) {
				return {
					details: toolDetails("devin_message", { result: "not_found", code: "NOT_FOUND", requested: String(params.session_id ?? "") }),
					content: [{ type: "text", text: `Session '${params.session_id}' not found.` }],
					isError: true,
				};
			}

			if (meta.status === "running" || meta.status === "stalled") {
				return {
					details: toolDetails("devin_message", { result: "busy", sessionId: params.session_id, status: meta.status }),
					content: [
						{
							type: "text",
							text: `Session '${params.session_id}' is currently ${meta.status}. Please wait for the current turn to complete (or devin_cancel it first).${permissionNote(meta.sessionId)}`,
						},
					],
				};
			}

			let client = activeClients.get(params.session_id);
			if (!client) {
				// Re-attach ACP client
				const targetCwd = meta.worktreePath || baseDir;
				const realLogFile = getEventsLogPath(currentPiSessionId, meta.sessionId);
				client = new AcpClient(targetCwd, meta.model);
				client.setLogFilePath(realLogFile);
				try {
					await client.start();
					activeClients.set(params.session_id, client);
					wireClientEvents(client, meta);
				} catch (err: any) {
					// A failed handshake must not leave the spawned child behind.
					client.dispose();
					return {
						details: toolDetails("devin_message", { result: "reattach_failed", code: "REATTACH_FAILED", sessionId: params.session_id }),
						content: [{ type: "text", text: `Failed to re-attach to session: ${err.message}` }],
						isError: true,
					};
				}
				// Track the new process so recovery/devin_restart can see it.
				meta.pid = client.pid;
			}

			meta.status = "running";
			meta.lastMessageTime = Date.now();
			meta.turnStartedAt = Date.now();
			startStallWatchdog(meta);
			persistSessionMeta(meta, true);
			updateStatusUI(ctx.ui);

			client.appendUserMessage(params.message);
			client
				.request(
					"session/prompt",
					{
						sessionId: meta.sessionId,
						prompt: [{ type: "text", text: params.message }],
					},
					0,
				)
				.then(async () => {
					stopStallWatchdog(meta.sessionId);
					flushAssistantBuffer(meta);
					meta.status = "idle";
					meta.turnCompletedAt = Date.now();
					meta.finishedAt = Date.now();
					persistSessionMeta(meta, true);

					let prSuffix = " No pullrequest was created";
					if (meta.worktreePath) {
						const prNum = await detectPullRequest(meta.worktreePath, meta.worktreeBranch);
						if (prNum) {
							meta.detectedPrNumber = prNum;
							prSuffix = ` The session created the pr #${prNum}`;
							persistSessionMeta(meta, true);
						}
					}

					persistState();
					updateStatusUI();

					sendAgentMessage(
						`The session ${meta.sessionId} is done. use the "devin_status" to check the session last messages. or "devin_message" to send a new message.${prSuffix}`,
					);
					drainQueue();
				})
				.catch((err) => {
					// Only override a turn that is still in flight: onExit (idle/interrupted)
					// and devin_cancel (cancelled) already set the terminal state.
					if (meta.status === "running" || meta.status === "stalled") {
						stopStallWatchdog(meta.sessionId);
						flushAssistantBuffer(meta);
						meta.status = "failed";
						meta.error = err.message || String(err);
						persistSessionMeta(meta, true);
						updateStatusUI();

						sendAgentMessage(
							`The session ${meta.sessionId} failed: ${meta.error}. You can check details with "devin_status" or restart it with "devin_restart".`,
						);
						drainQueue();
					}
				});

			return {
				details: toolDetails("devin_message", { result: "message_sent", sessionId: meta.sessionId }),
				content: [{ type: "text", text: `Message sent to session ${meta.sessionId}.` }],
			};
		},
	});

	// 3b. devin_permission
	pi.registerTool({
		name: "devin_permission",
		label: "Devin Permission",
		description:
			"Answers a Devin session's pending permission request (its turn is blocked until then). allow: run it once; allow_session: also allow the same command for the rest of the session; reject: refuse it.",
		parameters: Type.Object({
			session_id: Type.String({
				description: "Session ID whose oldest pending permission request to answer",
			}),
			decision: Type.Union(
				PERMISSION_DECISIONS.map((d) => Type.Literal(d)),
				{ description: "allow, allow_session or reject" },
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			await recoveryDone;
			const answered = answerPermission(params.session_id, params.decision as PermissionDecision, "agent");
			if (!answered) {
				return {
					details: toolDetails("devin_permission", { result: "nothing_pending", code: "NOTHING_PENDING", sessionId: params.session_id }),
					content: [{ type: "text", text: `Session '${params.session_id}' has no pending permission request.` }],
					isError: true,
				};
			}
			const chosen = answered.optionId ?? "cancelled (Devin offered no matching option)";
			return {
				details: toolDetails("devin_permission", { result: "answered", sessionId: params.session_id, optionId: answered.optionId ?? null }),
				content: [
					{
						type: "text",
						text: `Answered "${answered.command}" for session ${params.session_id}: ${chosen}.${permissionNote(params.session_id)}`,
					},
				],
			};
		},
	});

	// 4. devin_cancel
	pi.registerTool({
		name: "devin_cancel",
		label: "Devin Cancel",
		description: "Cancels an active or queued Devin session.",
		parameters: Type.Object({
			session_id: Type.String({
				description: "Session ID or queue ID to cancel",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			// Recovery runs detached from session_start: wait for it before reading or mutating state,
			// or this call's changes are overwritten when recovery finishes (queue, counters).
			await recoveryDone;
			// Do not re-anchor on tool calls (same rule as devin_delegate).
			const toolPiId = ctx.sessionManager?.getSessionId();
			if (toolPiId && currentPiSessionId !== "default" && toolPiId !== currentPiSessionId) {
				logWarn(`pi session id mismatch (tool: ${toolPiId}, anchored: ${currentPiSessionId}); keeping anchored storage dir`);
			}
			const targetId = params.session_id;

			// Queued tasks and sessions share the cancel path (also kills an orphaned
			// devin process directly when no live client exists, e.g. after a pi restart).
			const kind = cancelSessionById(targetId);
			if (kind) {
				return {
					details: toolDetails("devin_cancel", { result: "cancelled", sessionId: targetId, cancelled: kind }),
					content: [
						{
							type: "text",
							text: kind === "queued" ? `Queued session ${targetId} was cancelled.` : `Session ${targetId} was cancelled.`,
						},
					],
				};
			}

			return {
				details: toolDetails("devin_cancel", { result: "not_found", code: "NOT_FOUND", requested: String(targetId ?? "") }),
				content: [{ type: "text", text: `Session '${targetId}' not found.` }],
				isError: true,
			};
		},
	});

	// 5. devin_restart
	pi.registerTool({
		name: "devin_restart",
		label: "Devin Restart",
		description: "Restarts or resumes an interrupted, failed, or stopped Devin session in its original worktree.",
		parameters: Type.Object({
			session_id: Type.String({
				description: "Session ID to restart",
			}),
			prompt: Type.Optional(
				Type.String({
					description: "Optional new or revised prompt. If omitted, re-uses original prompt.",
				}),
			),
			mode: Type.Optional(
				Type.String({
					description: `New permission mode for the restarted session (default: the original session's). ${MODE_DESCRIPTION}`,
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			// Recovery runs detached from session_start: wait for it before reading or mutating state,
			// or this call's changes are overwritten when recovery finishes (queue, counters).
			await recoveryDone;
			// Do not re-anchor on tool calls (same rule as devin_delegate).
			const toolPiId = ctx.sessionManager?.getSessionId();
			if (toolPiId && currentPiSessionId !== "default" && toolPiId !== currentPiSessionId) {
				logWarn(`pi session id mismatch (tool: ${toolPiId}, anchored: ${currentPiSessionId}); keeping anchored storage dir`);
			}
			const meta = sessions.get(params.session_id);
			if (!meta) {
				return {
					details: toolDetails("devin_restart", { result: "not_found", code: "NOT_FOUND", requested: String(params.session_id ?? "") }),
					content: [{ type: "text", text: `Session '${params.session_id}' not found.` }],
					isError: true,
				};
			}
			// A restart repeats the original mode unless told otherwise: a mode that blocks the session
			// would otherwise block every restart of it too.
			const restartMode = params.mode || meta.mode;
			const modeCheck = resolveAcpMode(restartMode);
			if (!modeCheck.ok) {
				return {
					details: toolDetails("devin_restart", { result: "invalid_mode", code: "INVALID_MODE", sessionId: params.session_id }),
					content: [{ type: "text", text: modeCheck.error }],
					isError: true,
				};
			}

			if (meta.status === "running" || meta.status === "stalled") {
				return {
					details: toolDetails("devin_restart", { result: "busy", sessionId: params.session_id, status: meta.status }),
					content: [
						{
							type: "text",
							text: `Session '${params.session_id}' is currently running. Cancel it first before restarting.`,
						},
					],
					isError: true,
				};
			}

			// Guard: never start a second `devin acp` for a session whose process is still alive.
			if (meta.pid && isPidAlive(meta.pid)) {
				if (meta.status !== "cancelled") {
					return {
						details: toolDetails("devin_restart", {
							result: "process_alive",
							code: "PROCESS_ALIVE",
							sessionId: params.session_id,
							pid: meta.pid ?? null,
						}),
						content: [
							{
								type: "text",
								text: `The original devin process for '${params.session_id}' is still alive (pid ${meta.pid}). Cancel it first with devin_cancel before restarting.`,
							},
						],
						isError: true,
					};
				}
				// Cancelled: the old process may still be inside its dispose kill window —
				// force-kill it and wait (async, so pending SIGKILL timers can fire) until it is
				// actually gone before spawning a new one.
				killProcessGroup(meta.pid);
				for (let i = 0; i < 30 && isPidAlive(meta.pid); i++) {
					await new Promise((r) => setTimeout(r, 100));
				}
				if (isPidAlive(meta.pid)) {
					return {
						details: toolDetails("devin_restart", {
							result: "process_not_stopped",
							code: "PROCESS_NOT_STOPPED",
							sessionId: params.session_id,
							pid: meta.pid ?? null,
						}),
						content: [
							{
								type: "text",
								text: `The old devin process for '${params.session_id}' (pid ${meta.pid}) could not be terminated in time. Try devin_restart again shortly.`,
							},
						],
						isError: true,
					};
				}
			}

			const revisedPrompt = params.prompt || meta.prompt;
			totalInvoked++;
			const queueId = `q-${totalInvoked}`;

			let wtPath = meta.worktreePath;
			let wtBranch = meta.worktreeBranch;
			let wtId = meta.worktreeId;
			let parentWtId = meta.parentWorktreeId;
			let wtStatus = meta.worktreeStatus;

			if (meta.createWorktree && (!wtPath || wtStatus === "released" || !fs.existsSync(wtPath))) {
				try {
					const wt = await createWorktree(ctx.cwd || baseDir);
					wtPath = wt.worktreePath;
					wtBranch = wt.worktreeBranch;
					wtId = wt.worktreeId;
					parentWtId = wt.parentWorktreeId;
					wtStatus = "active";
				} catch (err: any) {
					return {
						details: toolDetails("devin_restart", {
							result: "worktree_recreate_failed",
							code: "WORKTREE_CREATE_FAILED",
							sessionId: params.session_id,
						}),
						content: [{ type: "text", text: `Failed to recreate worktree for restart: ${err.message}` }],
						isError: true,
					};
				}
			}

			const task: QueuedTask = {
				queueId,
				prompt: revisedPrompt,
				model: meta.model,
				mode: restartMode,
				createWorktree: meta.createWorktree,
				worktreePath: wtPath,
				worktreeBranch: wtBranch,
				worktreeId: wtId,
				parentWorktreeId: parentWtId,
				worktreeStatus: wtStatus,
				enqueuedAt: Date.now(),
				parentSessionId: meta.sessionId,
			};

			// Same admission rule as devin_delegate: FIFO behind waiting tasks, slot reserved before awaiting.
			const release = queue.length === 0 ? slots.tryReserve() : null;
			if (release) {
				try {
					const newMeta = await startSession(task);
					return {
						details: toolDetails("devin_restart", { result: "restarted", sessionId: newMeta.sessionId }),
						content: [{ type: "text", text: `Your session was restarted with id: ${newMeta.sessionId}` }],
					};
				} catch (err: any) {
					return {
						details: toolDetails("devin_restart", { result: "restart_failed", code: "RESTART_FAILED", sessionId: params.session_id }),
						content: [{ type: "text", text: `Failed to restart session: ${err.message}` }],
						isError: true,
					};
				} finally {
					release();
					drainQueue();
				}
			} else {
				queue.push(task);
				const position = queue.length;
				const queuePendingTotal = queue.length;
				persistState();
				updateStatusUI(ctx.ui);
				drainQueue();

				return {
					details: toolDetails("devin_restart", { result: "queued", queuePosition: position, queueTotal: queuePendingTotal }),
					content: [
						{
							type: "text",
							text: `Your restarted session was queued as ${position} of ${queuePendingTotal}. You will receive the session id as soon it start`,
						},
					],
				};
			}
		},
	});

	// 6. devin_clean_worktree
	pi.registerTool({
		name: "devin_clean_worktree",
		label: "Devin Clean Worktree",
		description:
			"Releases and removes an isolated worktree for a settled or finished Devin session, releasing the child workspace in Orca.",
		parameters: Type.Object({
			session_id: Type.Optional(
				Type.String({
					description: "Session ID whose worktree should be released and deleted",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description: "Force deletion without checking uncommitted or unpushed changes (default: false)",
				}),
			),
			all_settled: Type.Optional(
				Type.Boolean({
					description: "Clean all settled sessions whose PRs are merged or closed (default: false)",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			// Recovery runs detached from session_start: wait for it before reading or mutating state,
			// or this call's changes are overwritten when recovery finishes (queue, counters).
			await recoveryDone;
			const targetId = params.session_id;

			if (params.all_settled) {
				const cleaned: string[] = [];
				const skipped: Array<{ sessionId: string; reason: string }> = [];

				for (const [sId, meta] of sessions.entries()) {
					if (!meta.worktreePath || meta.worktreeStatus === "released") continue;
					if (meta.status === "running" || meta.status === "stalled") {
						skipped.push({ sessionId: sId, reason: "Session is still active" });
						continue;
					}

					const safety = await checkWorktreeSafety(meta.worktreePath, meta.worktreeBranch);
					const prSettled = safety.prState === "MERGED" || safety.prState === "CLOSED";
					if (!params.force && (!safety.safe || (!prSettled && safety.prState !== "NONE" && safety.prState !== undefined))) {
						skipped.push({
							sessionId: sId,
							reason: !safety.safe ? safety.reason : `PR #${safety.prNumber} is still ${safety.prState || "OPEN"}`,
						});
						continue;
					}

					const selector = meta.worktreeId || `path:${meta.worktreePath}`;
					const rmRes = await removeOrcaWorktree(selector, { force: true });
					if (rmRes.ok) {
						meta.worktreeStatus = "released";
						persistSessionMeta(meta, true);
						cleaned.push(sId);
					} else {
						skipped.push({ sessionId: sId, reason: rmRes.error?.message || "orca worktree rm failed" });
					}
				}

				persistState();
				updateStatusUI();

				const lines = [`Cleaned worktrees for ${cleaned.length} settled session(s): ${cleaned.join(", ") || "none"}.`];
				if (skipped.length > 0) {
					lines.push("Skipped sessions:");
					for (const s of skipped) {
						lines.push(`  - ${s.sessionId}: ${s.reason}`);
					}
				}
				return {
					details: toolDetails("devin_clean_worktree", {
						result: "pruned",
						...capList("cleanedSessionIds", cleaned),
						skipped: skipped.length,
					}),
					content: [{ type: "text", text: lines.join("\n") }],
				};
			}

			if (!targetId) {
				return {
					details: toolDetails("devin_clean_worktree", { result: "missing_target", code: "MISSING_TARGET" }),
					content: [
						{
							type: "text",
							text: "Please specify a session_id or set all_settled: true to clean up Devin worktrees.",
						},
					],
					isError: true,
				};
			}

			const meta = sessions.get(targetId);
			if (!meta) {
				return {
					details: toolDetails("devin_clean_worktree", { result: "not_found", code: "NOT_FOUND", requested: String(targetId ?? "") }),
					content: [{ type: "text", text: `Session '${targetId}' not found.` }],
					isError: true,
				};
			}

			if (!meta.worktreePath) {
				return {
					details: toolDetails("devin_clean_worktree", { result: "no_worktree", code: "NO_WORKTREE", sessionId: targetId }),
					content: [{ type: "text", text: `Session '${targetId}' was not created with an isolated worktree.` }],
					isError: true,
				};
			}

			if (meta.worktreeStatus === "released") {
				return {
					details: toolDetails("devin_clean_worktree", { result: "already_released", sessionId: targetId }),
					content: [{ type: "text", text: `Worktree for session '${targetId}' has already been released.` }],
				};
			}

			if (meta.status === "running" || meta.status === "stalled") {
				return {
					details: toolDetails("devin_clean_worktree", { result: "busy", sessionId: targetId, status: meta.status }),
					content: [
						{
							type: "text",
							text: `Session '${targetId}' is currently ${meta.status}. Wait for it to complete or use devin_cancel first.`,
						},
					],
					isError: true,
				};
			}

			const safety = await checkWorktreeSafety(meta.worktreePath, meta.worktreeBranch);
			if (!safety.safe && !params.force) {
				return {
					details: toolDetails("devin_clean_worktree", {
						result: "worktree_unsafe",
						code: "WORKTREE_UNSAFE",
						sessionId: targetId,
						reason: safety.reason,
					}),
					content: [
						{
							type: "text",
							text: `Cannot safely delete worktree for '${targetId}': ${safety.reason}. To force deletion anyway, pass force: true.`,
						},
					],
					isError: true,
				};
			}

			const selector = meta.worktreeId || `path:${meta.worktreePath}`;
			const rmRes = await removeOrcaWorktree(selector, { force: true });
			if (!rmRes.ok) {
				return {
					details: toolDetails("devin_clean_worktree", {
						result: "worktree_remove_failed",
						code: "WORKTREE_REMOVE_FAILED",
						sessionId: targetId,
					}),
					content: [
						{
							type: "text",
							text: `Failed to remove worktree for session '${targetId}': ${rmRes.error?.message || "Unknown error"}`,
						},
					],
					isError: true,
				};
			}

			meta.worktreeStatus = "released";
			persistSessionMeta(meta, true);
			persistState();
			updateStatusUI();

			return {
				details: toolDetails("devin_clean_worktree", { result: "worktree_released", sessionId: targetId, worktreePath: meta.worktreePath }),
				content: [
					{
						type: "text",
						text: `Worktree for session '${targetId}' (${meta.worktreePath}) has been deleted and released from Orca.`,
					},
				],
			};
		},
	});

	// Global PR closed hook to clean up worktrees whose PRs are merged or closed
	(globalThis as any).__PI_ON_PR_CLOSED_DEVIN__ = async (prNumber: number, state: string) => {
		// Called from observe-pr's detached poll tasks. Recovery may still be rebuilding `sessions`,
		// and a session it has not re-added yet would simply be skipped here — a permanent miss, since
		// this hook does not fire twice for one PR close. Same gate as every other mutating path.
		await recoveryDone;
		for (const [sId, meta] of sessions.entries()) {
			if (!meta.worktreePath || meta.worktreeStatus !== "active") continue;
			if (meta.status === "running" || meta.status === "stalled") {
				logWarn(`Skipping worktree cleanup for active session ${sId} on PR #${prNumber} closed event`);
				continue;
			}

			// Match by stored detectedPrNumber or query worktree PR dynamically
			let matches = meta.detectedPrNumber === prNumber;
			if (!matches && !meta.detectedPrNumber && fs.existsSync(meta.worktreePath)) {
				const activePr = await detectPullRequest(meta.worktreePath, meta.worktreeBranch);
				if (activePr === prNumber) {
					meta.detectedPrNumber = activePr;
					persistSessionMeta(meta, true);
					matches = true;
				}
			}

			if (matches) {
				const safety = await checkWorktreeSafety(meta.worktreePath, undefined);
				if (!safety.safe) {
					logWarn(`Cannot safely release worktree for PR #${prNumber} (session ${sId}): ${safety.reason}`);
					continue;
				}
				const selector = meta.worktreeId || `path:${meta.worktreePath}`;
				const rmRes = await removeOrcaWorktree(selector, { force: true });
				if (rmRes.ok) {
					meta.worktreeStatus = "released";
					persistSessionMeta(meta, true);
					sendAgentMessage(
						`Child worktree for PR #${prNumber} (session ${sId}) was automatically released from Orca because the PR was ${state.toLowerCase()}.`,
					);
				}
			}
		}
	};

	// --- Slash Command /devin ---

	pi.registerCommand("devin", {
		description:
			"Devin delegation controls and dashboard (subcommands: list, sessions, limit [n], cancel <id>, allow_bash [on|off|status])",
		handler: async (args, ctx) => {
			lastUIContext = ctx.ui;
			// Same gate as the tools: `/devin cancel` must not run against state recovery is replacing.
			await recoveryDone;
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const sub = parts[0]?.toLowerCase();

			if (sub === "limit") {
				if (!parts[1]) {
					ctx.ui.notify(`Devin concurrency limit is currently set to ${maxRuns}.`, "info");
					return;
				}
				const newLimit = parseInt(parts[1], 10);
				if (isNaN(newLimit) || newLimit <= 0) {
					ctx.ui.notify("Please specify a valid positive number for limit: /devin limit <n>", "warning");
					return;
				}
				maxRuns = newLimit;
				persistState();
				updateStatusUI(ctx.ui);
				ctx.ui.notify(`Devin concurrency limit updated to ${maxRuns}.`, "info");
				drainQueue();
				return;
			}

			if (sub === "allow_bash") {
				const arg = parts[1]?.toLowerCase();
				if (arg === "status") {
					ctx.ui.notify(`Direct \`devin\` bash calls are currently ${allowBash ? "ALLOWED" : "BLOCKED"}.`, "info");
					return;
				}
				if (arg && !["on", "allow", "off", "block"].includes(arg)) {
					ctx.ui.notify("Usage: /devin allow_bash [on|off|status] (no argument toggles)", "warning");
					return;
				}
				allowBash = arg ? arg === "on" || arg === "allow" : !allowBash;
				ctx.ui.notify(
					allowBash
						? "Direct `devin` bash calls are now ALLOWED for this session. Run /devin allow_bash again to block them."
						: "Direct `devin` bash calls are now BLOCKED. The agent must use the devin_* tools.",
					"info",
				);
				return;
			}

			if (sub === "cancel") {
				const targetId = parts[1];
				if (!targetId) {
					ctx.ui.notify("Please specify a session ID to cancel: /devin cancel <session-id>", "warning");
					return;
				}
				// Share the tool's cancel path (watchdog stop, buffer flush, orphan-pid kill).
				const kind = cancelSessionById(targetId);
				if (kind) {
					ctx.ui.notify(kind === "queued" ? `Cancelled queued session ${targetId}.` : `Cancelled session ${targetId}.`, "info");
				} else {
					ctx.ui.notify(`Session '${targetId}' not found.`, "warning");
				}
				return;
			}

			if (!sub || sub === "list" || sub === "sessions" || sub === "dashboard") {
				if (ctx.mode === "tui" && ctx.hasUI) {
					await ctx.ui.custom<void>((tui, theme, _kb, done) => {
						return new DevinDashboardComponent(
							tui,
							theme,
							() => Array.from(sessions.values()),
							() => [...queue],
							(s, count) => readLastMessagesFromDisk(s, count),
							() => done(),
						);
					});
				} else {
					ctx.ui.notify(
						`Devin Delegate: ${slots.inFlight()} in flight, ${queue.length} queued, ${totalCompleted} completed (Limit: ${maxRuns}), ${pendingPermissions.size} awaiting permission`,
						"info",
					);
				}
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand '${sub}'. Available subcommands: list, sessions, limit [n], cancel <id>, allow_bash [on|off|status]`,
				"warning",
			);
		},
	});
}
