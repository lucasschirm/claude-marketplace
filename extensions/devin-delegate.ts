import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";
import { DEVIN_BASH_BLOCK_REASON, findBlockedDevinCommand } from "./lib/devin-bash-guard.ts";

const execFileAsync = promisify(execFile);
const GLOBAL_GUARD_KEY = "__PI_DEVIN_DELEGATE_EXTENSION_ACTIVE__";

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

interface AcpMessage {
	jsonrpc: "2.0";
	id?: number;
	method?: string;
	params?: any;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

// --- AcpClient Implementation ---

class AcpClient {
	private child: ChildProcess | null = null;
	private nextRpcId = 1;
	private pendingRequests = new Map<
		number,
		{ resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout | null }
	>();
	private logStream: fs.WriteStream | null = null;
	private onUpdateCallback?: (update: any) => void;
	private onExitCallback?: (code: number | null, signal: string | null) => void;
	private isDisposed = false;

	constructor(
		private cwd: string,
		private model: string,
	) {}

	setLogFilePath(logFilePath: string): void {
		if (this.logStream) {
			this.logStream.end();
		}
		fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
		this.logStream = fs.createWriteStream(logFilePath, { flags: "a" });
	}

	async start(): Promise<void> {
		const args = ["acp"];
		if (this.model) {
			args.push("--model", this.model);
		}

		// Spawn process in a new process group for clean tree termination
		const isPosix = process.platform !== "win32";
		this.child = spawn("devin", args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached: isPosix,
			env: {
				...process.env,
				DEVIN_MODEL: this.model,
			},
		});

		this.child.on("error", (err) => {
			this.logEvent("error", { message: err.message });
			for (const req of this.pendingRequests.values()) {
				if (req.timer) clearTimeout(req.timer);
				req.reject(err);
			}
			this.pendingRequests.clear();
			if (!this.isDisposed && this.onExitCallback) {
				this.onExitCallback(1, null);
			}
		});

		// Swallow async stream errors on stdin (EPIPE when writing to a dying process);
		// an unhandled 'error' event would crash the host pi process.
		if (this.child.stdin) {
			this.child.stdin.on("error", () => {});
		}

		const rl = readline.createInterface({
			input: this.child.stdout!,
			crlfDelay: Infinity,
		});

		rl.on("line", (line) => {
			if (!line.trim()) return;
			this.logEvent("stdout", line);
			try {
				const msg = JSON.parse(line) as AcpMessage;
				this.handleMessage(msg);
			} catch {
				// Non-json output
			}
		});

		this.child.stderr?.on("data", (chunk: Buffer) => {
			this.logEvent("stderr", chunk.toString());
		});

		this.child.on("exit", (code, signal) => {
			if (!this.isDisposed && this.onExitCallback) {
				this.onExitCallback(code, signal);
			}
			for (const req of this.pendingRequests.values()) {
				if (req.timer) clearTimeout(req.timer);
				req.reject(new Error(`devin acp exited with code ${code}`));
			}
			this.pendingRequests.clear();
		});

		// Handshake: initialize
		await this.request("initialize", {
			clientInfo: { name: "pi-devin-delegate", version: "1.0" },
			protocolVersion: 1,
		});
	}

	setOnUpdate(cb: (update: any) => void): void {
		this.onUpdateCallback = cb;
	}

	setOnExit(cb: (code: number | null, signal: string | null) => void): void {
		this.onExitCallback = cb;
	}

	request(method: string, params: any, timeoutMs = 60000): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this.child || !this.child.stdin || this.child.killed) {
				return reject(new Error("devin acp process is not running"));
			}
			const id = this.nextRpcId++;
			const req: AcpMessage = { jsonrpc: "2.0", id, method, params };

			// timeoutMs <= 0 means "wait for the response indefinitely" — used for
			// long-running session/prompt turns, which complete by the ACP response
			// arriving, never by a wall-clock timer.
			let timer: NodeJS.Timeout | null = null;
			if (timeoutMs > 0) {
				timer = setTimeout(() => {
					if (this.pendingRequests.has(id)) {
						this.pendingRequests.delete(id);
						reject(new Error(`devin acp RPC request timed out after ${timeoutMs}ms (${method})`));
					}
				}, timeoutMs);
			}

			this.pendingRequests.set(id, { resolve, reject, timer });
			try {
				this.child.stdin.write(JSON.stringify(req) + "\n");
			} catch (err) {
				// Synchronous write failure (e.g. destroyed stdin): don't leave a zombie
				// pending entry — reject immediately.
				this.pendingRequests.delete(id);
				if (timer) clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	notify(method: string, params: any): void {
		if (!this.child || !this.child.stdin || this.child.killed) return;
		const msg: AcpMessage = { jsonrpc: "2.0", method, params };
		this.child.stdin.write(JSON.stringify(msg) + "\n");
	}

	private handleMessage(msg: AcpMessage): void {
		if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
			const { resolve, reject, timer } = this.pendingRequests.get(msg.id)!;
			if (timer) clearTimeout(timer);
			this.pendingRequests.delete(msg.id);
			if (msg.error) {
				reject(new Error(msg.error.message || `RPC error ${msg.error.code}`));
			} else {
				resolve(msg.result);
			}
			return;
		}

		if (msg.method === "session/update" && msg.params) {
			if (this.onUpdateCallback) {
				this.onUpdateCallback(msg.params);
			}
		}
	}

	logEvent(type: string, data: any): void {
		if (!this.logStream) return;
		const entry = {
			timestamp: new Date().toISOString(),
			type,
			data,
		};
		try {
			this.logStream.write(JSON.stringify(entry) + "\n");
		} catch {}
	}

	appendAssistantMessage(text: string): void {
		this.logEvent("assistant_message", { text });
	}

	appendUserMessage(text: string): void {
		this.logEvent("user_message", { text });
	}

	dispose(): void {
		this.isDisposed = true;
		for (const req of this.pendingRequests.values()) {
			if (req.timer) clearTimeout(req.timer);
			req.reject(new Error("AcpClient disposed"));
		}
		this.pendingRequests.clear();

		if (this.child && !this.child.killed) {
			try {
				if (process.platform !== "win32" && this.child.pid) {
					// Kill process group
					try {
						process.kill(-this.child.pid, "SIGTERM");
					} catch {
						this.child.kill("SIGTERM");
					}
				} else {
					this.child.kill("SIGTERM");
				}

				const pid = this.child.pid;
				setTimeout(() => {
					try {
						if (pid && process.platform !== "win32") {
							process.kill(-pid, "SIGKILL");
						}
					} catch {}
				}, 1500).unref();
			} catch {}
		}
		if (this.logStream) {
			try {
				this.logStream.end();
			} catch {}
			this.logStream = null;
		}
	}
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
				const statusColor =
					s.status === "running" ? "success" : s.status === "failed" ? "error" : "muted";
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
	let baseDir = process.cwd();
	// When false (default), shell calls to the `devin` CLI are blocked so work goes through the devin_* tools.
	let allowBash = false;

	// Binary availability cache
	const binaryAvailableCache = new Map<string, boolean>();

	// Turn liveness: per-session stall watchdog timers and streamed assistant chunk buffers
	const stallTimers = new Map<string, NodeJS.Timeout>();
	const assistantBuffers = new Map<string, string>();
	// Advertised ACP config-option vocabularies, captured from config_option_update
	const sessionConfigOptions = new Map<string, Map<string, string[]>>();
	// Where each session's files were last written (mirrors state.json's sessionDirs),
	// so recovered sessions' event files can be found in their original directory.
	const sessionDirs = new Map<string, string>();

	function isCommandAvailable(cmd: string): boolean {
		if (binaryAvailableCache.has(cmd)) {
			return binaryAvailableCache.get(cmd)!;
		}
		try {
			const checkTool = process.platform === "win32" ? "where" : "which";
			execFileSync(checkTool, [cmd], { stdio: "ignore" });
			binaryAvailableCache.set(cmd, true);
			return true;
		} catch {
			binaryAvailableCache.set(cmd, false);
			return false;
		}
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
			console.warn(`[devin-delegate] refusing to kill pid ${pid}: not a devin process (possible pid reuse)`);
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

	function sleepSync(ms: number): void {
		try {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
		} catch {}
	}

	// Tolerate transient ENOENT (observed on shared volumes: directories flapping between
	// visible and ENOENT within seconds) by retrying once after a short delay.
	function readFileSyncWithRetry(p: string): string {
		try {
			return fs.readFileSync(p, "utf-8");
		} catch (err: any) {
			if (err?.code !== "ENOENT") throw err;
			sleepSync(150);
			return fs.readFileSync(p, "utf-8");
		}
	}

	function countInFlight(): number {
		let n = 0;
		for (const s of sessions.values()) {
			if (s.status === "running" || s.status === "stalled") n++;
		}
		return n;
	}

	function stopStallWatchdog(sessionId: string): void {
		const t = stallTimers.get(sessionId);
		if (t) {
			clearInterval(t);
			stallTimers.delete(sessionId);
		}
	}

	// Stall watchdog: replaces the old hard 60s prompt timeout. A turn is considered
	// stalled only when *no* ACP update arrives for N minutes; the process being alive
	// (child + stderr heartbeat) distinguishes "possibly thinking/waiting" from "dead"
	// (which onExit handles as interrupted). A stalled turn is never auto-failed or killed.
	function startStallWatchdog(meta: SessionMeta): void {
		stopStallWatchdog(meta.sessionId);
		const stallMs = getStallTimeoutMs();
		const timer = setInterval(() => {
			if (meta.status !== "running") {
				stopStallWatchdog(meta.sessionId);
				return;
			}
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
			console.error(`[devin-delegate] Failed to append event for ${meta.sessionId}:`, err);
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
						typeof c === "string"
							? c
							: Array.isArray(c)
								? c.map((p: any) => (typeof p === "string" ? p : p?.text || "")).join("")
							: "";
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
			queue.splice(queueIndex, 1);
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
			const dir = getStorageDir(currentPiSessionId);
			fs.mkdirSync(dir, { recursive: true });
			const state: PersistedState = {
				maxRuns,
				totalInvoked,
				totalCompleted,
				queue,
				sessionIds: Array.from(sessions.keys()),
				sessionDirs: Object.fromEntries(Array.from(sessions.keys()).map((id) => [id, currentPiSessionId])),
			};
			for (const id of sessions.keys()) sessionDirs.set(id, currentPiSessionId);
			const tempFile = path.join(dir, `state.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
			fs.writeFileSync(tempFile, JSON.stringify(state, null, 2), "utf-8");
			fs.renameSync(tempFile, getStatePath(currentPiSessionId));
		} catch (err) {
			console.error("[devin-delegate] Failed to persist state:", err);
		}
	}

	// Debounced metadata updater to eliminate disk thrashing during streaming
	const pendingMetaSaves = new Map<string, { meta: SessionMeta; timer: NodeJS.Timeout }>();

	function persistSessionMeta(meta: SessionMeta, immediate = false): void {
		const save = () => {
			try {
				const sDir = getSessionDir(currentPiSessionId, meta.sessionId);
				fs.mkdirSync(sDir, { recursive: true });
				const metaPath = getMetaPath(currentPiSessionId, meta.sessionId);
				fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
			} catch (err) {
				console.error(`[devin-delegate] Failed to persist meta for ${meta.sessionId}:`, err);
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

		let runningCount = 0;
		let stalledCount = 0;
		let settledCount = 0;
		for (const s of sessions.values()) {
			if (s.status === "running") runningCount++;
			else if (s.status === "stalled") stalledCount++;
			else if (["completed", "idle", "failed", "cancelled", "interrupted"].includes(s.status)) settledCount++;
		}
		const queuedCount = queue.length;
		const totalSettled = Math.max(settledCount, totalCompleted);

		if (runningCount === 0 && stalledCount === 0 && totalSettled === 0 && queuedCount === 0) {
			targetUI.setStatus("devin_delegate", undefined);
			return;
		}

		// Short format: Devin <running>/<queued>/<completed> (+N stalled)
		const stalledSuffix = stalledCount > 0 ? ` (+${stalledCount} stalled)` : "";
		targetUI.setStatus("devin_delegate", `Devin ${runningCount}/${queuedCount}/${totalCompleted}${stalledSuffix}`);
	}

	function sendAgentMessage(content: string): void {
		try {
			// "steer" lands after the current turn's tool calls; "followUp" would wait until the agent stops calling tools.
			pi.sendUserMessage(content, { deliverAs: "steer" });
		} catch (err) {
			console.error("[devin-delegate] Failed to send message to agent:", err);
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

	async function createWorktree(cwd: string): Promise<{ worktreePath: string; worktreeBranch: string }> {
		const currentBranch = await getGitBranch(cwd);
		const baseBranch = currentBranch.replace(/^refs\/heads\//, "");
		let index = await findNextWorktreeIndex(cwd, baseBranch);
		const orcaAvailable = isCommandAvailable("orca");
		const repoName = await getRootRepoName(cwd);

		while (true) {
			const targetBranch = `${baseBranch}-dt${index}`;
			const targetFolder = path.join(os.homedir(), "orca", "workspaces", repoName, targetBranch);

			if (fs.existsSync(targetFolder)) {
				index++;
				continue;
			}

			if (orcaAvailable) {
				try {
					const { stdout } = await execFileAsync(
						"orca",
						["worktree", "create", "--name", targetBranch, "--base-branch", baseBranch, "--json"],
						{ cwd },
					);
					const parsed = JSON.parse(stdout);
					const createdPath = parsed.result?.worktree?.path || targetFolder;
					return { worktreePath: createdPath, worktreeBranch: targetBranch };
				} catch (orcaErr) {
					console.warn("[devin-delegate] orca worktree create failed, falling back to git:", orcaErr);
				}
			}

			// Fallback: Git worktree
			fs.mkdirSync(path.dirname(targetFolder), { recursive: true });
			await execFileAsync("git", ["worktree", "add", "-b", targetBranch, targetFolder, baseBranch], { cwd });
			return { worktreePath: targetFolder, worktreeBranch: targetBranch };
		}
	}

	// --- PR Detection ---

	async function detectPullRequest(cwd: string, branch?: string): Promise<number | undefined> {
		if (!branch || !isCommandAvailable("gh")) return undefined;
		try {
			const { stdout } = await execFileAsync("gh", ["pr", "view", branch, "--json", "number"], { cwd });
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
						if (co && co.id && Array.isArray(co.options)) configOptions.set(co.id, co.options);
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
		const acpMode = task.mode === "dangerous" ? "bypass" : task.mode;
		try {
			await client.request("session/set_mode", {
				sessionId: realSessionId,
				modeId: acpMode,
			});
		} catch (err: any) {
			const knownModes = sessionConfigOptions.get(realSessionId)?.get("mode");
			console.warn(
				`[devin-delegate] set_mode ${acpMode} failed${knownModes ? ` (valid modes: ${knownModes.join(", ")})` : ""}:`,
				err,
			);
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

				// Detect PR if worktree was created
				let prSuffix = " No pullrequest was created";
				const prNum = await detectPullRequest(targetCwd, task.worktreeBranch);
				if (prNum) {
					meta.detectedPrNumber = prNum;
					prSuffix = ` The session created the pr #${prNum}`;
				}

				persistSessionMeta(meta, true);
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
			while (countInFlight() < maxRuns && queue.length > 0) {
				const task = queue.shift()!;
				persistState();
				updateStatusUI();

				// Prepare worktree if needed
				if (task.createWorktree && !task.worktreePath) {
					try {
						const wt = await createWorktree(baseDir);
						task.worktreePath = wt.worktreePath;
						task.worktreeBranch = wt.worktreeBranch;
					} catch (err: any) {
						console.error(`[devin-delegate] Failed to create worktree for queued task ${task.queueId}:`, err);
					}
				}

				startSession(task)
					.then((meta) => {
						// Notify agent as soon as queued session starts
						sendAgentMessage(`Your session started with id: ${meta.sessionId}`);
					})
					.catch((err) => {
						console.error(`[devin-delegate] Failed to start dequeued session:`, err);
						// Slot freed: the post-loop recheck below starts the next task.
					});
			}
		} finally {
			isDraining = false;
		}
		// Recheck: turns may have completed (or a session failed to start) while we were
		// draining, and drain calls made during the drain were skipped by the guard.
		if (queue.length > 0 && countInFlight() < maxRuns) {
			drainQueue();
		}
	}

	// --- Startup & Crash Recovery ---

	function recoverState(piSessionId: string): void {
		currentPiSessionId = piSessionId;
		const sPath = getStatePath(piSessionId);
		let raw: string | null = null;
		try {
			raw = readFileSyncWithRetry(sPath);
		} catch {
			raw = null;
		}
		if (raw == null) {
			persistState();
			return;
		}

		let state: PersistedState;
		try {
			state = JSON.parse(raw);
		} catch (err) {
			console.error("[devin-delegate] Error recovering state (bad state.json):", err);
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
						try {
							meta = JSON.parse(readFileSyncWithRetry(mPath)) as SessionMeta;
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
							meta.error = "pi session restarted; the devin process was still running (orphaned) and was terminated. Restart with devin_restart.";
							persistSessionMeta(meta, true);
						} else {
							// Process is dead: the turn may have completed on devin's side
							// while pi was down — check the devin session DB.
							void (async () => {
								try {
									const text = await backfillFinalMessage(meta);
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
									console.error(`[devin-delegate] Error reconciling session ${meta.sessionId}:`, err);
								}
								updateStatusUI();
								drainQueue();
							})();
						}
					}
					sessions.set(sId, meta);
					// Re-anchor the meta under the current storage dir (fixes split state).
					persistSessionMeta(meta, true);
				}
			}

			// Restore queue
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
			console.error("[devin-delegate] Error recovering state:", err);
		}
	}

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		lastUIContext = ctx.ui;
		baseDir = ctx.cwd;
		const piId = ctx.sessionManager?.getSessionId() || "default";
		recoverState(piId);
	});

	function cleanupAllClients(): void {
		for (const client of activeClients.values()) {
			client.dispose();
		}
		activeClients.clear();
	}

	// Release the load guard so a session switch (/resume, /new, /reload) re-registers the tools.
	pi.on("session_shutdown", () => {
		delete (globalThis as any)[GLOBAL_GUARD_KEY];
		cleanupAllClients();
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
	const onProcessExit = () => cleanupAllClients();
	process.once("exit", onProcessExit);
	process.once("SIGINT", onProcessExit);
	process.once("SIGTERM", onProcessExit);

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
					description: "Permission mode: dangerous, auto, accept-edits (default: dangerous)",
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
			baseDir = ctx.cwd;
			// Do not re-anchor on tool calls: storage stays with the session_start anchor.
			const toolPiId = ctx.sessionManager?.getSessionId();
			if (toolPiId) {
				if (currentPiSessionId === "default") {
					currentPiSessionId = toolPiId;
				} else if (toolPiId !== currentPiSessionId) {
					console.warn(
						`[devin-delegate] pi session id mismatch (tool: ${toolPiId}, anchored: ${currentPiSessionId}); keeping anchored storage dir`,
					);
				}
			}

			const prompt = params.prompt;
			const model = params.model || "swe-2-high";
			const mode = params.mode || "dangerous";
			const createWorktreeReq = Boolean(params.create_worktree);

			totalInvoked++;
			const queueId = `q-${totalInvoked}`;

			if (countInFlight() < maxRuns) {
				// Start immediately
				let wtPath: string | undefined;
				let wtBranch: string | undefined;

				if (createWorktreeReq) {
					try {
						const wt = await createWorktree(ctx.cwd);
						wtPath = wt.worktreePath;
						wtBranch = wt.worktreeBranch;
					} catch (err: any) {
						return {
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
					enqueuedAt: Date.now(),
				};

				try {
					const meta = await startSession(task);
					return {
						content: [{ type: "text", text: `Your session started with id: ${meta.sessionId}` }],
					};
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `Failed to start Devin session: ${err.message}` }],
						isError: true,
					};
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

				return {
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
		description:
			"Checks status and recent or full messages for Devin sessions. Reads on-demand from disk without RAM memory overhead.",
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
			// Do not re-anchor on tool calls (same rule as devin_delegate).
			const toolPiId = ctx.sessionManager?.getSessionId();
			if (toolPiId && currentPiSessionId !== "default" && toolPiId !== currentPiSessionId) {
				console.warn(
					`[devin-delegate] pi session id mismatch (tool: ${toolPiId}, anchored: ${currentPiSessionId}); keeping anchored storage dir`,
				);
			}
			if (params.complete && !params.session_id) {
				return {
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
					const timeStr = meta.lastMessageTime
						? new Date(meta.lastMessageTime).toISOString()
						: "N/A";
					const prStr = meta.detectedPrNumber ? ` | PR: #${meta.detectedPrNumber}` : "";

					return {
						content: [
							{
								type: "text",
								text: `Session ${meta.sessionId} (Status: ${meta.status}${prStr})\nLast message time: ${timeStr}\n\nLast 3 messages:\n${lastMessages.join("\n")}`,
							},
						],
					};
				}

				// Check queued tasks
				const queuedTask = queue.find((q) => q.queueId === params.session_id);
				if (queuedTask) {
					const pos = queue.indexOf(queuedTask) + 1;
					return {
						content: [
							{
								type: "text",
								text: `Queued task ${queuedTask.queueId} (Position: ${pos} of ${queue.length})\nPrompt: "${queuedTask.prompt}"\nModel: ${queuedTask.model} | Mode: ${queuedTask.mode}`,
							},
						],
					};
				}

				return {
					content: [{ type: "text", text: `Devin session or queued task '${params.session_id}' not found.` }],
					isError: true,
				};
			}

			// No session_id: return 3 last messages for each session and summary of queued items
			if (sessions.size === 0 && queue.length === 0) {
				return {
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
				const timeStr = meta.lastMessageTime
					? new Date(meta.lastMessageTime).toISOString()
					: "N/A";
				const prStr = meta.detectedPrNumber ? ` | PR: #${meta.detectedPrNumber}` : "";

				summaries.push(
					`Session: ${meta.sessionId} [${meta.status.toUpperCase()}${prStr}]\nLast message time: ${timeStr}\nLast 3 messages:\n${lastMessages.join("\n")}`,
				);
			}

			if (queue.length > 0) {
				const queueList = queue
					.map((q, idx) => `  ${idx + 1}. [${q.queueId}] "${q.prompt.slice(0, 60)}" (${q.model})`)
					.join("\n");
				summaries.push(`Queued Tasks (${queue.length}):\n${queueList}`);
			}

			return {
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
			const meta = sessions.get(params.session_id);
			if (!meta) {
				return {
					content: [{ type: "text", text: `Session '${params.session_id}' not found.` }],
					isError: true,
				};
			}

			if (meta.status === "running" || meta.status === "stalled") {
				return {
					content: [
						{
							type: "text",
							text: `Session '${params.session_id}' is currently ${meta.status}. Please wait for the current turn to complete (or devin_cancel it first).`,
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

					let prSuffix = " No pullrequest was created";
					const prNum = await detectPullRequest(meta.worktreePath || baseDir, meta.worktreeBranch);
					if (prNum) {
						meta.detectedPrNumber = prNum;
						prSuffix = ` The session created the pr #${prNum}`;
					}

					persistSessionMeta(meta, true);
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
				content: [{ type: "text", text: `Message sent to session ${meta.sessionId}.` }],
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
			// Do not re-anchor on tool calls (same rule as devin_delegate).
			const toolPiId = ctx.sessionManager?.getSessionId();
			if (toolPiId && currentPiSessionId !== "default" && toolPiId !== currentPiSessionId) {
				console.warn(
					`[devin-delegate] pi session id mismatch (tool: ${toolPiId}, anchored: ${currentPiSessionId}); keeping anchored storage dir`,
				);
			}
			const targetId = params.session_id;

			// Queued tasks and sessions share the cancel path (also kills an orphaned
			// devin process directly when no live client exists, e.g. after a pi restart).
			const kind = cancelSessionById(targetId);
			if (kind) {
				return {
					content: [
						{
							type: "text",
							text: kind === "queued" ? `Queued session ${targetId} was cancelled.` : `Session ${targetId} was cancelled.`,
						},
					],
				};
			}

			return {
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
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
			lastUIContext = ctx.ui;
			// Do not re-anchor on tool calls (same rule as devin_delegate).
			const toolPiId = ctx.sessionManager?.getSessionId();
			if (toolPiId && currentPiSessionId !== "default" && toolPiId !== currentPiSessionId) {
				console.warn(
					`[devin-delegate] pi session id mismatch (tool: ${toolPiId}, anchored: ${currentPiSessionId}); keeping anchored storage dir`,
				);
			}
			const meta = sessions.get(params.session_id);
			if (!meta) {
				return {
					content: [{ type: "text", text: `Session '${params.session_id}' not found.` }],
					isError: true,
				};
			}

			if (meta.status === "running" || meta.status === "stalled") {
				return {
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

			const task: QueuedTask = {
				queueId,
				prompt: revisedPrompt,
				model: meta.model,
				mode: meta.mode,
				createWorktree: meta.createWorktree,
				worktreePath: meta.worktreePath,
				worktreeBranch: meta.worktreeBranch,
				enqueuedAt: Date.now(),
				parentSessionId: meta.sessionId,
			};

			if (countInFlight() < maxRuns) {
				try {
					const newMeta = await startSession(task);
					return {
						content: [{ type: "text", text: `Your session was restarted with id: ${newMeta.sessionId}` }],
					};
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `Failed to restart session: ${err.message}` }],
						isError: true,
					};
				}
			} else {
				queue.push(task);
				const position = queue.length;
				const queuePendingTotal = queue.length;
				persistState();
				updateStatusUI(ctx.ui);

				return {
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

	// --- Slash Command /devin ---

	pi.registerCommand("devin", {
		description: "Devin delegation controls and dashboard (subcommands: list, sessions, limit [n], cancel <id>, allow_bash [on|off|status])",
		handler: async (args, ctx) => {
			lastUIContext = ctx.ui;
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
					ctx.ui.notify(
						kind === "queued" ? `Cancelled queued session ${targetId}.` : `Cancelled session ${targetId}.`,
						"info",
					);
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
					const running = countInFlight();
					ctx.ui.notify(
						`Devin Delegate: ${running} in flight, ${queue.length} queued, ${totalCompleted} completed (Limit: ${maxRuns})`,
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
