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
	status: "running" | "idle" | "completed" | "cancelled" | "failed" | "interrupted";
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	lastMessageTime?: number;
	error?: string;
	detectedPrNumber?: number;
}

interface PersistedState {
	maxRuns: number;
	totalInvoked: number;
	totalCompleted: number;
	queue: QueuedTask[];
	sessionIds: string[];
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
		{ resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }
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
				clearTimeout(req.timer);
				req.reject(err);
			}
			this.pendingRequests.clear();
			if (!this.isDisposed && this.onExitCallback) {
				this.onExitCallback(1, null);
			}
		});

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
				clearTimeout(req.timer);
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

			const timer = setTimeout(() => {
				if (this.pendingRequests.has(id)) {
					this.pendingRequests.delete(id);
					reject(new Error(`devin acp RPC request timed out after ${timeoutMs}ms (${method})`));
				}
			}, timeoutMs);

			this.pendingRequests.set(id, { resolve, reject, timer });
			this.child.stdin.write(JSON.stringify(req) + "\n");
		});
	}

	notify(method: string, params: any): void {
		if (!this.child || !this.child.stdin || this.child.killed) return;
		const msg: AcpMessage = { jsonrpc: "2.0", method, params };
		this.child.stdin.write(JSON.stringify(msg) + "\n");
	}

	private handleMessage(msg: AcpMessage): void {
		if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
			const { resolve, reject, timer } = this.pendingRequests.get(msg.id)!;
			clearTimeout(timer);
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
			clearTimeout(req.timer);
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

				const lineText = `${pointer}${th.fg("bold", s.sessionId)} ${statusBadge}${prBadge} (${timeStr}) - ${s.prompt.slice(0, 40)}`;
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
					const lineText = `${pointer}${th.fg("bold", q.queueId)} ${badge} - ${q.prompt.slice(0, 45)}`;
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

	// Binary availability cache
	const binaryAvailableCache = new Map<string, boolean>();

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
			};
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

		if (totalInvoked === 0) {
			targetUI.setStatus("devin_delegate", undefined);
			return;
		}

		let runningCount = 0;
		for (const s of sessions.values()) {
			if (s.status === "running") runningCount++;
		}
		const queuedCount = queue.length;
		// Short format: Devin <running>/<queued>/<completed>
		targetUI.setStatus("devin_delegate", `Devin ${runningCount}/${queuedCount}/${totalCompleted}`);
	}

	function sendAgentMessage(content: string): void {
		try {
			pi.sendUserMessage(content, { deliverAs: "followUp" });
		} catch (err) {
			console.error("[devin-delegate] Failed to send message to agent:", err);
		}
	}

	// Read last N messages on demand from disk with fixed-size tail buffer (O(1) RAM)
	function readLastMessagesFromDisk(meta: SessionMeta, count = 3): string[] {
		const filePath = getEventsLogPath(currentPiSessionId, meta.sessionId);
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
			fs.readSync(fd, buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
			fs.closeSync(fd);

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
		client.setOnUpdate((update) => {
			meta.lastMessageTime = Date.now();
			if (update.update?.sessionUpdate === "agent_message" && update.update?.content) {
				client.appendAssistantMessage(update.update.content);
			} else if (update.update?.output) {
				client.appendAssistantMessage(update.update.output);
			}
			persistSessionMeta(meta, false);
		});

		client.setOnExit((code) => {
			if (meta.status === "running") {
				meta.status = code === 0 ? "idle" : "failed";
				if (code !== 0) {
					meta.error = `devin acp exited with code ${code}`;
					sendAgentMessage(
						`The session ${meta.sessionId} failed: ${meta.error}. You can check details with "devin_status" or restart it with "devin_restart".`,
					);
				}
				meta.finishedAt = Date.now();
				persistSessionMeta(meta, true);
				activeClients.delete(meta.sessionId);
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

		// Configure ACP mode
		const acpMode = task.mode === "dangerous" ? "bypass" : task.mode;
		try {
			await client.request("session/set_mode", {
				sessionId: realSessionId,
				modeId: acpMode,
			});
		} catch (err) {
			console.warn(`[devin-delegate] set_mode ${acpMode} warning:`, err);
		}

		// Configure model
		try {
			await client.request("session/set_config_option", {
				sessionId: realSessionId,
				configId: "model",
				value: task.model,
			});
		} catch (err) {
			console.warn(`[devin-delegate] set_config_option model warning:`, err);
		}

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
		};

		sessions.set(realSessionId, meta);
		activeClients.set(realSessionId, client);
		persistSessionMeta(meta, true);
		persistState();
		updateStatusUI();

		wireClientEvents(client, meta);

		// Execute initial prompt asynchronously
		client.appendUserMessage(task.prompt);
		client
			.request("session/prompt", {
				sessionId: realSessionId,
				prompt: [{ type: "text", text: task.prompt }],
			})
			.then(async () => {
				meta.status = "idle";
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
				if (meta.status !== "cancelled") {
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
	}

	async function drainQueue(): Promise<void> {
		let runningCount = 0;
		for (const s of sessions.values()) {
			if (s.status === "running") runningCount++;
		}

		while (runningCount < maxRuns && queue.length > 0) {
			const task = queue.shift()!;
			runningCount++;
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
					drainQueue();
				});
		}
	}

	// --- Startup & Crash Recovery ---

	function recoverState(piSessionId: string): void {
		currentPiSessionId = piSessionId;
		const sPath = getStatePath(piSessionId);
		if (!fs.existsSync(sPath)) {
			persistState();
			return;
		}

		try {
			const raw = fs.readFileSync(sPath, "utf-8");
			const state = JSON.parse(raw) as PersistedState;

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

			// Restore session records from disk
			if (Array.isArray(state.sessionIds)) {
				for (const sId of state.sessionIds) {
					const mPath = getMetaPath(piSessionId, sId);
					if (fs.existsSync(mPath)) {
						try {
							const meta = JSON.parse(fs.readFileSync(mPath, "utf-8")) as SessionMeta;
							// If session was running when system crashed, mark interrupted
							if (meta.status === "running") {
								meta.status = "interrupted";
								meta.error = "Process interrupted unexpectedly (power outage or system reboot)";
								persistSessionMeta(meta, true);
							}
							sessions.set(sId, meta);
						} catch {}
					}
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

	pi.on("session_shutdown", cleanupAllClients);

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
			if (ctx.sessionManager?.getSessionId()) {
				currentPiSessionId = ctx.sessionManager.getSessionId();
			}

			const prompt = params.prompt;
			const model = params.model || "swe-2-high";
			const mode = params.mode || "dangerous";
			const createWorktreeReq = Boolean(params.create_worktree);

			totalInvoked++;
			const queueId = `q-${totalInvoked}`;

			let runningCount = 0;
			for (const s of sessions.values()) {
				if (s.status === "running") runningCount++;
			}

			if (runningCount < maxRuns) {
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

					const lastMessages = readLastMessagesFromDisk(meta, 3);
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
				const timeStr = meta.lastMessageTime
					? new Date(meta.lastMessageTime).toISOString()
					: "N/A";
				const lastMessages = readLastMessagesFromDisk(meta, 3);
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

			if (meta.status === "running") {
				return {
					content: [
						{
							type: "text",
							text: `Session '${params.session_id}' is currently running. Please wait for the current turn to complete.`,
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
					return {
						content: [{ type: "text", text: `Failed to re-attach to session: ${err.message}` }],
						isError: true,
					};
				}
			}

			meta.status = "running";
			meta.lastMessageTime = Date.now();
			persistSessionMeta(meta, true);
			updateStatusUI(ctx.ui);

			client.appendUserMessage(params.message);
			client
				.request("session/prompt", {
					sessionId: meta.sessionId,
					prompt: [{ type: "text", text: params.message }],
				})
				.then(async () => {
					meta.status = "idle";
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
					meta.status = "failed";
					meta.error = err.message || String(err);
					persistSessionMeta(meta, true);
					updateStatusUI();

					sendAgentMessage(
						`The session ${meta.sessionId} failed: ${meta.error}. You can check details with "devin_status" or restart it with "devin_restart".`,
					);
					drainQueue();
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
			const targetId = params.session_id;

			// Check queued tasks
			const queueIndex = queue.findIndex((q) => q.queueId === targetId);
			if (queueIndex !== -1) {
				queue.splice(queueIndex, 1);
				persistState();
				updateStatusUI(ctx.ui);
				return {
					content: [{ type: "text", text: `Queued session ${targetId} was cancelled.` }],
				};
			}

			// Check active sessions
			const meta = sessions.get(targetId);
			if (!meta) {
				return {
					content: [{ type: "text", text: `Session '${targetId}' not found.` }],
					isError: true,
				};
			}

			meta.status = "cancelled";
			meta.finishedAt = Date.now();
			persistSessionMeta(meta, true);

			const client = activeClients.get(targetId);
			if (client) {
				client.notify("session/cancel", { sessionId: targetId });
				client.dispose();
				activeClients.delete(targetId);
			}

			persistState();
			updateStatusUI(ctx.ui);
			drainQueue();

			return {
				content: [{ type: "text", text: `Session ${targetId} was cancelled.` }],
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
			const meta = sessions.get(params.session_id);
			if (!meta) {
				return {
					content: [{ type: "text", text: `Session '${params.session_id}' not found.` }],
					isError: true,
				};
			}

			if (meta.status === "running") {
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

			const revisedPrompt = params.prompt || meta.prompt;
			totalInvoked++;
			const queueId = `q-${totalInvoked}`;

			let runningCount = 0;
			for (const s of sessions.values()) {
				if (s.status === "running") runningCount++;
			}

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

			if (runningCount < maxRuns) {
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
		description: "Devin delegation controls and dashboard (subcommands: list, sessions, limit [n], cancel <id>)",
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

			if (sub === "cancel") {
				const targetId = parts[1];
				if (!targetId) {
					ctx.ui.notify("Please specify a session ID to cancel: /devin cancel <session-id>", "warning");
					return;
				}
				const meta = sessions.get(targetId);
				const qIdx = queue.findIndex((q) => q.queueId === targetId);

				if (qIdx !== -1) {
					queue.splice(qIdx, 1);
					persistState();
					updateStatusUI(ctx.ui);
					ctx.ui.notify(`Cancelled queued session ${targetId}.`, "info");
					return;
				}

				if (meta) {
					meta.status = "cancelled";
					const client = activeClients.get(targetId);
					if (client) {
						client.notify("session/cancel", { sessionId: targetId });
						client.dispose();
						activeClients.delete(targetId);
					}
					persistSessionMeta(meta, true);
					persistState();
					updateStatusUI(ctx.ui);
					ctx.ui.notify(`Cancelled session ${targetId}.`, "info");
					drainQueue();
					return;
				}

				ctx.ui.notify(`Session '${targetId}' not found.`, "warning");
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
					let running = 0;
					for (const s of sessions.values()) {
						if (s.status === "running") running++;
					}
					ctx.ui.notify(
						`Devin Delegate: ${running} running, ${queue.length} queued, ${totalCompleted} completed (Limit: ${maxRuns})`,
						"info",
					);
				}
				return;
			}

			ctx.ui.notify(
				`Unknown subcommand '${sub}'. Available subcommands: list, sessions, limit [n], cancel <id>`,
				"warning",
			);
		},
	});
}
