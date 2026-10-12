import { execFile, spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OrcaCommandOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
}

export interface OrcaEnvelope<T = any> {
	id?: string;
	ok: boolean;
	result?: T;
	error?: {
		code?: string;
		message: string;
		details?: any;
	};
	_meta?: Record<string, any>;
}

export interface OrcaRun {
	runId: string;
	objective?: string;
	status?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface OrcaWorkerRow {
	dispatchId: string;
	taskId: string;
	runId: string;
	workerState?: string;
	dispatchStatus?: string;
	agentTerminalHandle?: string;
	terminalState?: "active" | "reclaimable" | "retained" | "release_pending" | "release_unknown" | "released";
	projection?: {
		id: string;
		dispatchId: string;
		taskId: string;
		runId: string;
		stage?: {
			worker?: string;
			dispatch?: string;
			detail?: string;
		};
		outcome?: "succeeded" | "failed" | string;
		liveness?: {
			verdict?: "live" | "exited" | "unverifiable" | string;
			reason?: string;
			source?: string;
		};
		attention?: {
			categories?: string[];
			requiresAction?: boolean;
		};
		nextAction?: {
			kind?: string;
			argv?: string[];
		};
	};
	resource?: {
		id?: string;
		ownershipState?: string;
		terminalHandle?: string;
		worktreeId?: string;
	};
}

export interface OrcaWorktree {
	id: string;
	identity?: {
		key?: string;
		instanceId?: string;
		executionHostId?: string;
	};
	instanceId?: string;
	repoId?: string;
	projectId?: string;
	hostId?: string;
	path: string;
	branch?: string;
	head?: string;
	displayName?: string;
	displayNameMode?: string;
	comment?: string;
	workspaceStatus?: string;
	isArchived?: boolean;
	parentWorktreeId?: string | null;
	childWorktreeIds?: string[];
	lineage?: any;
	linkedPR?: number | null;
	linkedIssue?: number | null;
	createdWithAgent?: string;
	git?: {
		path: string;
		branch?: string;
		head?: string;
		isBare?: boolean;
		isMainWorktree?: boolean;
	};
}

export interface OrcaWorktreeSafetyResult {
	safe: boolean;
	reason: string;
	worktreePath: string;
	branch?: string;
	prNumber?: number;
	prState?: "OPEN" | "MERGED" | "CLOSED" | "NONE" | string;
	uncommitted?: boolean;
	unpushed?: boolean;
}

export interface OrcaMessageDelivery {
	deliveryId: string;
	messages: Array<{
		id: string;
		type: "worker_done" | "question" | "escalation" | "heartbeat" | string;
		from?: string;
		to?: string;
		body?: string;
		dispatchId?: string;
		taskId?: string;
		outcome?: "succeeded" | "failed" | string;
		summary?: string;
		filesModified?: string[];
		reportPath?: string;
		timestamp?: string;
		payload?: any;
	}>;
}

/**
 * Resolves the path or binary name for Orca CLI commands.
 */
export function resolveOrcaCmd(): string {
	if (process.env.ORCA_CLI_COMMAND) {
		return process.env.ORCA_CLI_COMMAND;
	}
	if (process.env.ORCA_BIN) {
		return process.env.ORCA_BIN;
	}
	if (process.env.ORCA_DEV_REPO_ROOT) {
		return "orca-dev";
	}

	// Check if orca-ide is available on PATH (used on Linux outside managed terminal)
	try {
		const checkTool = process.platform === "win32" ? "where" : "which";
		execFileSync(checkTool, ["orca-ide"], { stdio: "ignore" });
		return "orca-ide";
	} catch {}

	return "orca";
}

/**
 * Executes an Orca CLI command with JSON formatting and returns the parsed envelope.
 */
export async function execOrca<T = any>(args: string[], options: OrcaCommandOptions = {}): Promise<OrcaEnvelope<T>> {
	const cmd = resolveOrcaCmd();
	const fullArgs = [...args];
	if (!fullArgs.includes("--json")) {
		fullArgs.push("--json");
	}

	try {
		const { stdout } = await execFileAsync(cmd, fullArgs, {
			cwd: options.cwd || process.cwd(),
			timeout: options.timeoutMs || 30000,
			maxBuffer: 10 * 1024 * 1024,
			env: {
				...process.env,
				...options.env,
			},
		});

		try {
			return JSON.parse(stdout) as OrcaEnvelope<T>;
		} catch (parseErr: any) {
			return {
				ok: true,
				result: stdout.trim() as any,
			};
		}
	} catch (err: any) {
		const stdout = err?.stdout || "";
		if (stdout) {
			try {
				const parsed = JSON.parse(stdout);
				return parsed as OrcaEnvelope<T>;
			} catch {}
		}
		const stderr = err?.stderr || err?.message || String(err);
		return {
			ok: false,
			error: {
				code: "EXEC_ERROR",
				message: stderr.trim(),
			},
		};
	}
}

/**
 * Spawns an Orca long-poll process for orchestration message check.
 */
export function spawnOrcaCheck(
	runId?: string,
	options: { cwd?: string; timeoutMs?: number; ackDeliveryId?: string } = {},
): ChildProcess {
	const cmd = resolveOrcaCmd();
	const args = [
		"orchestration",
		"check",
		"--wait",
		"--types",
		"worker_done,escalation,question",
		"--timeout-ms",
		String(options.timeoutMs || 900000),
		"--json",
	];

	if (runId) {
		args.push("--run", runId);
	}
	if (options.ackDeliveryId) {
		args.push("--ack", options.ackDeliveryId);
	}

	return spawn(cmd, args, {
		cwd: options.cwd || process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * Removes an Orca worktree and deletes its folder/branch.
 */
export async function removeOrcaWorktree(
	selector: string,
	options: { force?: boolean; cwd?: string } = {},
): Promise<OrcaEnvelope<{ removed: boolean }>> {
	const args = ["worktree", "rm", "--worktree", selector];
	if (options.force !== false) {
		args.push("--force");
	}
	return execOrca<{ removed: boolean }>(args, { cwd: options.cwd });
}

/**
 * Gets the Orca worktree for the current working directory.
 */
export async function getCurrentWorktree(
	cwd?: string,
): Promise<OrcaEnvelope<{ worktree?: OrcaWorktree }>> {
	return execOrca<{ worktree?: OrcaWorktree }>(["worktree", "current"], { cwd });
}

/**
 * Gets details for a single Orca worktree selector.
 */
export async function getWorktree(
	selector: string,
	cwd?: string,
): Promise<OrcaEnvelope<{ worktree?: OrcaWorktree }>> {
	return execOrca<{ worktree?: OrcaWorktree }>(["worktree", "show", "--worktree", selector], { cwd });
}

/**
 * Lists Orca worktrees, optionally filtered by repo selector.
 */
export async function listWorktrees(
	options: { repo?: string; cwd?: string } = {},
): Promise<OrcaEnvelope<{ worktrees?: OrcaWorktree[] }>> {
	const args = ["worktree", "list"];
	if (options.repo) {
		args.push("--repo", options.repo);
	}
	return execOrca<{ worktrees?: OrcaWorktree[] }>(args, { cwd: options.cwd });
}

/**
 * Evaluates whether an Orca worktree is safe to delete.
 */
export async function checkWorktreeSafety(
	worktreePath: string,
	branch?: string,
	cwd?: string,
): Promise<OrcaWorktreeSafetyResult> {
	if (!fs.existsSync(worktreePath)) {
		return {
			safe: true,
			reason: "Worktree path does not exist on disk",
			worktreePath,
			branch,
		};
	}

	// 1. Check uncommitted changes
	try {
		const { stdout } = await execFileAsync("git", ["status", "--porcelain"], { cwd: worktreePath });
		if (stdout.trim().length > 0) {
			return {
				safe: false,
				reason: "Worktree has uncommitted git changes",
				worktreePath,
				branch,
				uncommitted: true,
			};
		}
	} catch {}

	let targetBranch = branch;
	if (!targetBranch) {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
			targetBranch = stdout.trim();
		} catch {}
	}

	// 2. Check associated GitHub PR status
	let prNum: number | undefined;
	let prState: string = "NONE";
	if (targetBranch) {
		try {
			const { stdout } = await execFileAsync("gh", ["pr", "view", targetBranch, "--json", "number,state"], {
				cwd: worktreePath,
			});
			const parsed = JSON.parse(stdout);
			if (parsed.number && typeof parsed.number === "number") {
				prNum = parsed.number;
				prState = String(parsed.state || "").toUpperCase();
			}
		} catch {}
	}

	if (prState === "MERGED" || prState === "CLOSED") {
		return {
			safe: true,
			reason: `Associated PR #${prNum} is ${prState.toLowerCase()}`,
			worktreePath,
			branch: targetBranch,
			prNumber: prNum,
			prState,
		};
	}

	if (prState === "OPEN") {
		return {
			safe: false,
			reason: `Associated PR #${prNum} is still open on GitHub`,
			worktreePath,
			branch: targetBranch,
			prNumber: prNum,
			prState,
		};
	}

	// 3. Check for unpushed commits
	if (targetBranch) {
		try {
			const { stdout: diffOut } = await execFileAsync("git", ["log", "@{u}..HEAD", "--oneline"], {
				cwd: worktreePath,
			});
			if (diffOut.trim().length > 0) {
				return {
					safe: false,
					reason: "Worktree branch has unpushed commits ahead of upstream",
					worktreePath,
					branch: targetBranch,
					unpushed: true,
					prState,
				};
			}
		} catch {
			try {
				const { stdout: logOut } = await execFileAsync("git", ["log", "origin/main..HEAD", "--oneline"], {
					cwd: worktreePath,
				});
				if (logOut.trim().length > 0) {
					return {
						safe: false,
						reason: "Worktree branch has commits not yet merged into origin/main",
						worktreePath,
						branch: targetBranch,
						unpushed: true,
						prState,
					};
				}
			} catch {}
		}
	}

	return {
		safe: true,
		reason: "No uncommitted or unpushed changes found",
		worktreePath,
		branch: targetBranch,
		prState,
	};
}

/**
 * Audits child worktrees of the current or specified parent workspace and deletes safe/stray ones.
 */
export async function pruneChildWorktrees(
	options: { parentWorktreeId?: string; cwd?: string; force?: boolean } = {},
): Promise<{
	removed: Array<{ id: string; path: string; reason: string }>;
	retained: Array<{ id: string; path: string; reason: string }>;
}> {
	const parentRes = await getCurrentWorktree(options.cwd);
	const parent = parentRes.result?.worktree;
	const childIds = parent?.childWorktreeIds || [];

	const removed: Array<{ id: string; path: string; reason: string }> = [];
	const retained: Array<{ id: string; path: string; reason: string }> = [];

	for (const childId of childIds) {
		const childRes = await getWorktree(childId, options.cwd);
		const child = childRes.result?.worktree;
		const childPath = child?.path || (childId.includes("::") ? childId.split("::")[1] : childId);
		const branch = child?.branch?.replace(/^refs\/heads\//, "");

		const safety = await checkWorktreeSafety(childPath, branch, options.cwd);
		if (safety.safe || options.force) {
			const rmRes = await removeOrcaWorktree(childId, { force: true, cwd: options.cwd });
			if (rmRes.ok) {
				removed.push({ id: childId, path: childPath, reason: safety.reason || "Removed successfully" });
			} else {
				retained.push({
					id: childId,
					path: childPath,
					reason: rmRes.error?.message || "orca worktree rm failed",
				});
			}
		} else {
			retained.push({ id: childId, path: childPath, reason: safety.reason });
		}
	}

	return { removed, retained };
}

