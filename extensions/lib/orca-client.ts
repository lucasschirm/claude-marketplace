import { execFile, spawn, execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OrcaCommandOptions {
	cwd?: string;
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
	/**
	 * The command's stdout is terminal text rather than an envelope (e.g. `worker-read`). Only for
	 * those commands is unparseable output a success; everywhere else it is a BAD_JSON failure.
	 */
	expectText?: boolean;
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
			/** Short free-text description of what the worker is doing right now. */
			activity?: string;
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
 * "message (CODE)" from a failed envelope, for tool text and user-facing notices. A caller that
 * reports a failure must not reduce it to an empty result: a coordinator told "no workers" will
 * dispatch work that is already running.
 */
export function orcaErrorText(env: { error?: { code?: string; message: string } }): string {
	// String(): an envelope from another tool version may carry a non-string message.
	const message = String(env.error?.message ?? "").trim() || "unknown error";
	return env.error?.code ? `${message} (${env.error.code})` : message;
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
			// Reporting unparseable output as ok:true is how a failed CLI call used to look like an
			// empty worker list or "no messages". `expectText` commands are the deliberate exception.
			if (options.expectText) {
				return { ok: true, result: stdout.trim() as unknown as T };
			}
			return {
				ok: false,
				error: {
					code: "BAD_JSON",
					message: `Orca CLI returned output that is not JSON: ${parseErr?.message || String(parseErr)}`,
					details: { raw: stdout.trim().slice(0, 2048) },
				},
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
 * Normalizes an Orca worktree selector (e.g. "path:/dir", "repo::/dir", "/dir") to an absolute filesystem path.
 */
export function normalizeWorktreePath(selector: string, cwd?: string): string {
	let p = selector.trim();
	if (p.startsWith("path:")) {
		p = p.slice(5).trim();
	} else if (p.includes("::")) {
		const parts = p.split("::");
		if (parts[1]) p = parts[1].trim();
	}
	if (!path.isAbsolute(p) && cwd) {
		p = path.resolve(cwd, p);
	}
	return p;
}

/**
 * Removes an Orca worktree and deletes its folder/branch.
 */
export async function removeOrcaWorktree(
	selector: string,
	options: { force?: boolean; cwd?: string } = {},
): Promise<OrcaEnvelope<{ removed: boolean }>> {
	const args = ["worktree", "rm", "--worktree", selector];
	if (options.force === true) {
		args.push("--force");
	}
	const res = await execOrca<{ removed: boolean }>(args, { cwd: options.cwd });
	// Fallback to git worktree remove if orca execution failed
	if (!res.ok) {
		try {
			const normPath = normalizeWorktreePath(selector, options.cwd);
			if (fs.existsSync(normPath)) {
				const gitArgs = ["worktree", "remove", normPath];
				if (options.force === true) gitArgs.push("--force");
				await execFileAsync("git", gitArgs, { cwd: options.cwd || process.cwd() });
				return { ok: true, result: { removed: true } };
			}
		} catch {}
	}
	return res;
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
 * Evaluates whether an Orca worktree is safe to delete. Fails closed on any ambiguity or execution failure.
 */
export async function checkWorktreeSafety(
	worktreeSelectorOrPath: string,
	branch?: string,
	cwd?: string,
): Promise<OrcaWorktreeSafetyResult> {
	const worktreePath = normalizeWorktreePath(worktreeSelectorOrPath, cwd);

	if (!fs.existsSync(worktreePath)) {
		return {
			safe: true,
			reason: "Worktree path does not exist on disk",
			worktreePath,
			branch,
		};
	}

	// 1. Check uncommitted changes (fail closed on git error)
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
	} catch (err: any) {
		return {
			safe: false,
			reason: `Failed to verify git status: ${err?.message || String(err)}`,
			worktreePath,
			branch,
		};
	}

	let targetBranch = branch;
	if (!targetBranch) {
		try {
			const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
			targetBranch = stdout.trim();
		} catch (err: any) {
			return {
				safe: false,
				reason: `Failed to detect git branch: ${err?.message || String(err)}`,
				worktreePath,
			};
		}
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

	// 3. Check for unpushed commits - FAIL CLOSED on ambiguous or errored results
	if (targetBranch) {
		let unpushedChecked = false;

		// 3a. Check against tracking upstream if set
		try {
			const { stdout: diffOut } = await execFileAsync("git", ["log", "@{u}..HEAD", "--oneline"], {
				cwd: worktreePath,
			});
			unpushedChecked = true;
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
			// No upstream configured for branch @{u}
		}

		// 3b. Check against origin remote branch if origin/<branch> exists
		if (!unpushedChecked) {
			try {
				const { stdout: remoteBranchOut } = await execFileAsync(
					"git",
					["log", `origin/${targetBranch}..HEAD`, "--oneline"],
					{ cwd: worktreePath },
				);
				unpushedChecked = true;
				if (remoteBranchOut.trim().length > 0) {
					return {
						safe: false,
						reason: `Worktree branch has unpushed commits ahead of origin/${targetBranch}`,
						worktreePath,
						branch: targetBranch,
						unpushed: true,
						prState,
					};
				}
			} catch {
				// origin/<branch> not present
			}
		}

		// 3c. Check against default base branch (origin/main, origin/master, main, master)
		if (!unpushedChecked) {
			const candidateBases = ["origin/main", "origin/master", "main", "master"];
			let foundBase = false;
			for (const base of candidateBases) {
				try {
					await execFileAsync("git", ["rev-parse", "--verify", base], { cwd: worktreePath });
					const { stdout: baseDiff } = await execFileAsync("git", ["log", `${base}..HEAD`, "--oneline"], {
						cwd: worktreePath,
					});
					foundBase = true;
					unpushedChecked = true;
					if (baseDiff.trim().length > 0) {
						return {
							safe: false,
							reason: `Worktree branch has unpushed commits ahead of ${base}`,
							worktreePath,
							branch: targetBranch,
							unpushed: true,
							prState,
						};
					}
					break;
				} catch {}
			}

			if (!foundBase) {
				// Could not determine base or upstream - fail closed!
				return {
					safe: false,
					reason: "Could not verify if worktree branch has unpushed commits against an upstream or base branch",
					worktreePath,
					branch: targetBranch,
					unpushed: true,
					prState,
				};
			}
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
	let childIds: string[] = [];

	if (options.parentWorktreeId) {
		const parentRes = await getWorktree(options.parentWorktreeId, options.cwd);
		childIds = parentRes.result?.worktree?.childWorktreeIds || [];
	} else {
		const parentRes = await getCurrentWorktree(options.cwd);
		childIds = parentRes.result?.worktree?.childWorktreeIds || [];
	}

	const removed: Array<{ id: string; path: string; reason: string }> = [];
	const retained: Array<{ id: string; path: string; reason: string }> = [];

	for (const childId of childIds) {
		const childRes = await getWorktree(childId, options.cwd);
		const child = childRes.result?.worktree;
		const childPath = child?.path || normalizeWorktreePath(childId, options.cwd);
		const branch = child?.branch?.replace(/^refs\/heads\//, "");

		// Guard against active running workers in the child workspace
		const isChildActive =
			child?.workspaceStatus === "running" ||
			(child as any)?.liveTerminalCount > 0 ||
			(child as any)?.status === "active";
		if (isChildActive && !options.force) {
			retained.push({ id: childId, path: childPath, reason: "Child workspace is currently active" });
			continue;
		}

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

