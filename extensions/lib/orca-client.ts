import { execFile, spawn, execFileSync, type ChildProcess } from "node:child_process";
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
