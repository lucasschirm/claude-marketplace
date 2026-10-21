#!/usr/bin/env node
/**
 * The MCP stdio server of the pr-observer plugin (Devin CLI and Claude Code).
 *
 * Two properties here are the whole reason this file exists in this shape:
 *
 *  1. Plain JavaScript. The host starts the server with whatever `node` is on PATH
 *     (`node <plugin>/src/mcp-server.mjs`), and Node only runs TypeScript directly from 22.18. A
 *     `.ts` entry point answers nothing at all on an older runtime, and every host reports that as
 *     an unusable server rather than as a Node version problem. The engine it drives *is*
 *     TypeScript, but it is imported lazily, so even when the engine cannot load the server still
 *     completes the handshake and answers `tools/list` - the reason then surfaces in the tool
 *     result instead of disappearing into the host.
 *
 *  2. Self-contained. Installed plugins live in the host's own plugin cache (a `plugins/cache/...`
 *     directory under Devin's and Claude's data dirs), so nothing outside this directory exists at
 *     run time. The review-task engine is vendored byte-for-byte into ../lib/ from
 *     `extensions/lib/` - `node scripts/sync-plugin-libs.mjs --write`, enforced by `npm run
 *     validate`. Before that, this server imported `../../../extensions/lib/pr-tasks-manager.ts`,
 *     which only resolves in a repository checkout: installed, the process died on import before
 *     the handshake, and Devin showed "Failed to list tools for server 'pr-observer'" with no cause.
 *
 * The protocol handling is newline-delimited JSON-RPC 2.0 (MCP over stdio): one object per line,
 * replies on stdout, diagnostics on stderr.
 */
import * as path from "node:path";
import { execFile } from "node:child_process";
import * as readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(HERE, "..", "lib");
const SERVER_INFO = { name: "pr-observer", version: "1.0.0" };
/** Node runs the engine's TypeScript directly from this version on. */
const MIN_NODE = "22.18";
/** A `gh` call that outlives this is treated as failed (the same ceiling the extensions use). */
const GH_TIMEOUT_MS = 60_000;

// ------------------------------------------------------------------ the vendored engine

const ENGINE_FILES = ["pr-tasks-manager.ts", "github-review-threads.ts", "ci-verdict.ts"];

let loading;

/**
 * The engine, loaded on first tool call and kept for the process lifetime. Never a crash: the
 * message names what to fix, because the host shows tool output and nothing else.
 */
function engine() {
	loading ??= (async () => {
		const [tasks, gh, ci] = await Promise.all(
			ENGINE_FILES.map((file) => import(pathToFileURL(path.join(LIB_DIR, file)).href)),
		);
		return {
			manager: new tasks.PRTasksManager(),
			formatTaskSummary: tasks.formatTaskSummary,
			formatTaskDetail: tasks.formatTaskDetail,
			toReply: tasks.toReply,
			sameReplyBody: tasks.sameReplyBody,
			fetchReviewThreads: gh.fetchReviewThreads,
			getRepoCoordinates: gh.getRepoCoordinates,
			replyToReviewThread: gh.replyToReviewThread,
			resolveReviewThread: gh.resolveReviewThread,
			applyCodeSuggestion: gh.applyCodeSuggestion,
			describeGhError: gh.describeGhError,
			isStaleNodeError: gh.isStaleNodeError,
			evaluateCiVerdict: ci.evaluateCiVerdict,
		};
	})().catch((err) => {
		loading = undefined; // a later call may find a newer Node or a repaired plugin cache
		throw new Error(
			`the review-task engine of this plugin did not load (${err?.message ?? err}). It needs Node ` +
				`${MIN_NODE} or newer on PATH (the engine is TypeScript, run directly, without a build step) ` +
				`and ${ENGINE_FILES.join(", ")} in ${LIB_DIR}.`,
		);
	});
	return loading;
}

// ------------------------------------------------------------------ GitHub reads

/**
 * The PR a call applies to: `pr_number` when given ("42", "#42" or 42), else the current branch's.
 */
async function resolvePrNumber(explicit, cwd) {
	const text = explicit === undefined || explicit === null ? "" : String(explicit).replace(/^#/, "").trim();
	if (text !== "") {
		const number = Number(text);
		if (!Number.isInteger(number) || number <= 0) throw new Error(`'${explicit}' is not a pull request number`);
		return number;
	}
	const { stdout } = await execFileAsync("gh", ["pr", "view", "--json", "number"], { cwd, timeout: GH_TIMEOUT_MS });
	const number = Number(JSON.parse(stdout)?.number);
	if (!Number.isInteger(number) || number <= 0) throw new Error("GitHub did not report a pull request number");
	return number;
}

/**
 * `gh pr checks` rows plus whether they are usable. Failed checks make `gh` exit non-zero, so a
 * non-zero exit with a JSON array on stdout is data; only an unusable call is `ghFailed`.
 */
async function readChecks(prNumber, cwd) {
	let stdout = "";
	let failed = false;
	try {
		stdout = (await execFileAsync("gh", ["pr", "checks", String(prNumber), "--json", "bucket,state"], { cwd, timeout: GH_TIMEOUT_MS })).stdout;
	} catch (err) {
		stdout = typeof err?.stdout === "string" ? err.stdout : "";
		failed = true;
	}
	try {
		const checks = JSON.parse(stdout);
		if (Array.isArray(checks)) return { checks, ghFailed: false };
	} catch {
		// (falls through: unparseable output tells nothing, whatever the exit code said)
	}
	return { checks: null, ghFailed: true };
}

// ------------------------------------------------------------------ task state

const syncing = new Map(); // "<cwd>#<pr>" -> in flight sync, so a burst of calls fetches once

/**
 * Fetches the PR's review threads and reconciles them into the manager, in the same
 * `beginFetch` -> fetch -> `syncFromGitHubThreads` order the Pi extension uses, with the repository
 * the list came from as the sync scope (same PR numbers exist in other repositories).
 */
function syncPR(prNumber, cwd) {
	const key = `${cwd}#${prNumber}`;
	if (syncing.has(key)) return syncing.get(key);
	const running = (async () => {
		const e = await engine();
		const fetchedAt = e.manager.beginFetch();
		const nodes = await e.fetchReviewThreads(prNumber, cwd);
		const coords = await e.getRepoCoordinates(cwd); // (already cached by the fetch)
		const repo = `${coords.owner}/${coords.repo}`;
		const result = await e.manager.syncFromGitHubThreads(prNumber, nodes, fetchedAt, { repo, cwd });
		return { ...result, repo };
	})().finally(() => syncing.delete(key));
	syncing.set(key, running);
	return running;
}

/**
 * A task by conversation/thread/comment ID, syncing the PR first when it isn't in memory yet.
 * `pr_number` says where to look; without it the current branch's PR is used.
 */
async function findTask(id, prNumberArg, cwd) {
	const e = await engine();
	const needle = String(id ?? "").trim();
	if (!needle) throw new Error("a conversation id is required (see pr_tasks_list)");
	let task = e.manager.findTask(needle);
	let prNumber;
	if (!task) {
		prNumber = await resolvePrNumber(prNumberArg, cwd);
		await syncPR(prNumber, cwd);
		task = e.manager.findTask(needle);
	}
	if (!task) {
		throw new Error(
			`conversation ${needle} is not a review conversation of PR #${prNumber}. ` +
				`Run pr_tasks_list to see the open ones (pass pr_number to read another pull request).`,
		);
	}
	return task;
}

/**
 * Runs a mutation against the task's current thread ID. GitHub replaces thread nodes (a merge, a
 * re-posted comment), so a rejected ID is flagged, the PR is re-synced to re-link the task, and the
 * operation runs once more on the new ID.
 */
async function withCurrentThread(task, cwd, op) {
	const e = await engine();
	const first = task.threadId;
	try {
		const value = await op(first);
		e.manager.threadAccepted(task, first);
		return value;
	} catch (err) {
		if (!e.isStaleNodeError(err)) throw new Error(e.describeGhError(err));
		e.manager.markDeadThread(task);
		await syncPR(task.prNumber, task.cwd || cwd);
		if (task.threadId !== first) {
			try {
				const value = await op(task.threadId);
				e.manager.threadAccepted(task, task.threadId);
				return value;
			} catch (retryErr) {
				if (!e.isStaleNodeError(retryErr)) throw new Error(e.describeGhError(retryErr));
			}
		}
		e.manager.markStale(task, `Review thread ${task.threadId} no longer resolves on GitHub.`);
		throw new Error(
			`conversation ${task.conversationId} no longer has a review thread on GitHub; it is marked STALE and will stop being reported.`,
		);
	}
}

// ------------------------------------------------------------------ tools

const PR_NUMBER_SCHEMA = { anyOf: [{ type: "number" }, { type: "string" }] };

const TOOLS = [
	{
		name: "observe_pr",
		description:
			"Read a pull request now: the CI verdict from `gh pr checks` plus the state of its review " +
			"conversations (open, blocked, stale, resolved). A snapshot - this plugin has no background " +
			"watcher, so call it again to refresh. Omit pr_number for the current branch's pull request.",
		inputSchema: {
			type: "object",
			properties: {
				pr_number: { ...PR_NUMBER_SCHEMA, description: "PR number (42 or '#42'). Default: the current branch's PR." },
			},
		},
	},
	{
		name: "pr_tasks_list",
		description:
			"List the review conversations of a pull request. Fetches the threads from GitHub first, so the " +
			"listing is current. Each conversation is identified by its Conversation Id, which is what " +
			"pr_task_detail, pr_task_resolve and pr_task_blocked take.",
		inputSchema: {
			type: "object",
			properties: {
				pr_number: { ...PR_NUMBER_SCHEMA, description: "PR number. Default: the current branch's PR." },
				show_all: { type: "boolean", description: "When true, includes conversations already resolved." },
			},
		},
	},
	{
		name: "pr_task_detail",
		description:
			"Full detail of one review conversation: the comment, its file and lines, every reply, and the " +
			"code suggestion block if it has one (pr_task_resolve only applies a suggestion it has shown here).",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string", description: "Conversation Id from pr_tasks_list." },
				pr_number: { ...PR_NUMBER_SCHEMA, description: "PR number. Default: the current branch's PR." },
			},
			required: ["task_id"],
		},
	},
	{
		name: "pr_task_resolve",
		description:
			"Resolve a review conversation: posts `message` as a reply to its thread and resolves the thread " +
			"on GitHub. With accept_suggestion, the reviewer's suggestion is also written to the file - only " +
			"if pr_task_detail has shown it and only once.",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string", description: "Conversation Id from pr_tasks_list." },
				message: { type: "string", description: "The explanation posted as the reply to the reviewer." },
				accept_suggestion: { type: "boolean", description: "Apply the conversation's code suggestion before resolving." },
				pr_number: { ...PR_NUMBER_SCHEMA, description: "PR number. Default: the current branch's PR." },
			},
			required: ["task_id", "message"],
		},
	},
	{
		name: "pr_task_blocked",
		description:
			"Mark a review conversation BLOCKED: posts `reason` as a reply and keeps the conversation out of " +
			"the work you owe until the reviewer answers it.",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string", description: "Conversation Id from pr_tasks_list." },
				reason: { type: "string", description: "What is needed from a human, posted as the reply." },
				pr_number: { ...PR_NUMBER_SCHEMA, description: "PR number. Default: the current branch's PR." },
			},
			required: ["task_id", "reason"],
		},
	},
];

const VERDICT_TEXT = {
	passed: "CI passed (every reported check)",
	failed: "CI failed",
	unknown: "CI status unknown (checks still running, or `gh pr checks` could not be read)",
};

async function observePR(args, cwd) {
	const e = await engine();
	const prNumber = await resolvePrNumber(args?.pr_number, cwd);
	const [{ checks, ghFailed }, syncResult] = await Promise.all([readChecks(prNumber, cwd), syncPR(prNumber, cwd)]);
	const verdict = e.evaluateCiVerdict({ checks, ghFailed });
	const counts = e.manager.getCounts(prNumber);

	const lines = [
		`PR #${prNumber} (${syncResult.repo}): ${VERDICT_TEXT[verdict]}.`,
		`Review conversations: ${counts.open} open, ${counts.blocked} blocked, ${counts.stale} stale, ${counts.resolved} resolved.`,
	];
	if (syncResult.newTasks.length > 0) {
		lines.push(`New since the last read: ${syncResult.newTasks.map((t) => t.conversationId).join(", ")}.`);
	}
	if (counts.open + counts.blocked + counts.stale > 0) {
		lines.push("Use pr_tasks_list for the conversations, pr_task_detail for one of them.");
	}
	lines.push("(Snapshot: call observe_pr again to refresh - the plugin does not watch in the background.)");
	return lines.join("\n");
}

async function listTasks(args, cwd) {
	const e = await engine();
	const prNumber = await resolvePrNumber(args?.pr_number, cwd);
	await syncPR(prNumber, cwd);
	const all = e.manager.getAllTasks(prNumber);
	const visible = e.manager.getVisibleTasks(prNumber);
	const shown = args?.show_all ? all : visible;
	// (recorded so a later read reports only what arrived since)
	for (const task of shown) e.manager.markShown(task);
	const summary = e.formatTaskSummary(shown, all.length);
	if (shown.length === 0) {
		return `${summary}\n\nPR #${prNumber} has no ${args?.show_all ? "" : "open "}review conversations to handle.`;
	}
	return `${summary}\n\n-----\n\nUse pr_task_detail with a Conversation Id for the full discussion and code suggestion.`;
}

async function taskDetail(args, cwd) {
	const e = await engine();
	const task = await findTask(args?.task_id, args?.pr_number, cwd);
	const detail = e.formatTaskDetail(task);
	e.manager.markShown(task, task.replies);
	return detail;
}

async function resolveTask(args, cwd) {
	const e = await engine();
	const message = String(args?.message ?? "").trim();
	if (!message) throw new Error("message is required: it is the reply the reviewer sees");
	const task = await findTask(args?.task_id, args?.pr_number, cwd);
	const folder = task.cwd || cwd;

	if (task.status === "RESOLVED") return `Conversation ${task.conversationId} is already resolved.`;
	if (task.isResolvedUpstream) {
		e.manager.markResolved(task, { upstream: true });
		return `Conversation ${task.conversationId} was already resolved on GitHub; it is marked resolved here.`;
	}

	const accept = Boolean(args?.accept_suggestion);
	const replyBody = accept && task.suggestion !== undefined && !message.toLowerCase().includes("suggestion") ? `${message}\n\nApplied suggested changes.` : message;

	if (accept) {
		const blockedReason = suggestionGuard(e, task);
		if (blockedReason) return blockedReason;
		// (captured after the guard: a sync could replace the task while the edit waits)
		const { file, line } = task;
		const startLine = task.startLine || line;
		const suggestion = task.suggestion;
		try {
			await e.applyCodeSuggestion(file, startLine, line, suggestion, folder);
		} catch (err) {
			return `Not resolved: the code suggestion of conversation ${task.conversationId} could not be applied to ${file}: ${e.describeGhError(err)}.`;
		}
		task.appliedSuggestion = suggestion;
	}

	// A sync finishing after the reply is posted must not read this reply as a reviewer's
	const forget = e.manager.expectOwnReply(task, replyBody);
	let comment;
	try {
		comment = await withCurrentThread(task, folder, (threadId) => e.replyToReviewThread(threadId, replyBody, folder));
	} catch (err) {
		// The code change is on disk and has no conversation acknowledging it: say so, loudly
		throw new Error(`${err.message}${task.appliedSuggestion !== undefined ? " (its suggestion was already written to the file; a retry will not write it again)" : ""}`);
	} finally {
		forget?.();
	}
	e.manager.addReply(task, e.toReply(comment));

	const resolved = await withCurrentThread(task, folder, (threadId) => e.resolveReviewThread(threadId, folder));
	if (!resolved) {
		return `Reply posted, but GitHub did not mark conversation ${task.conversationId} as resolved. Call pr_task_resolve again with the same message.`;
	}
	e.manager.markResolved(task, { upstream: true });
	return `Resolved conversation ${task.conversationId} (${task.file}).${accept ? ` Applied its code suggestion to ${task.file}.` : ""}`;
}

/**
 * Why a suggestion must not be applied right now, or undefined when it may. Mirrors the Pi
 * extension: never write code the agent has not been shown, never write it twice, never by line
 * number when the reviewed lines are gone.
 */
function suggestionGuard(e, task) {
	if (!task.hasSuggestion || task.suggestion === undefined) {
		return `Conversation ${task.conversationId} carries no code suggestion, so accept_suggestion does nothing. Resolve it with just a message.`;
	}
	if (task.appliedSuggestion !== undefined) {
		if (task.appliedSuggestion === task.suggestion) return undefined; // already on disk, resolve from here
		return `The suggestion of conversation ${task.conversationId} changed on GitHub after an earlier version was applied; nothing more was applied. Edit the code yourself, then resolve without accept_suggestion.`;
	}
	if (task.isOutdated || task.isBaseSide || task.isFileLevel) {
		const why = task.isOutdated
			? "it is outdated: the code changed since the comment"
			: task.isBaseSide
				? "the comment is on the base side of the diff (old or deleted lines)"
				: "the comment is on the whole file, not on lines";
		return `The suggestion of conversation ${task.conversationId} cannot be applied by line number (${why}). Apply it manually, then resolve without accept_suggestion.`;
	}
	if (task.seenMessage === undefined || !e.sameReplyBody(task.seenMessage, task.message)) {
		const lead =
			task.seenMessage === undefined
				? `You have not been shown the code suggestion of conversation ${task.conversationId}`
				: `The code suggestion of conversation ${task.conversationId} changed on GitHub since you last saw it`;
		// Showing it now (in the text below) is what makes a retry with accept_suggestion valid
		e.manager.markShown(task);
		return `${lead}; nothing was applied. It is:\n\`\`\`\n${task.suggestion}\n\`\`\`\nCall pr_task_resolve again with accept_suggestion to apply it.`;
	}
	return undefined;
}

async function blockTask(args, cwd) {
	const e = await engine();
	const reason = String(args?.reason ?? "").trim();
	if (!reason) throw new Error("reason is required: it is the reply the reviewer sees");
	const task = await findTask(args?.task_id, args?.pr_number, cwd);
	const folder = task.cwd || cwd;

	if (task.status === "RESOLVED") return `Conversation ${task.conversationId} is already resolved; it cannot be blocked.`;
	if (task.isResolvedUpstream) {
		e.manager.markResolved(task, { upstream: true });
		return `Conversation ${task.conversationId} was resolved on GitHub; nothing was posted.`;
	}

	const forget = e.manager.expectOwnReply(task, reason);
	let comment;
	try {
		comment = await withCurrentThread(task, folder, (threadId) => e.replyToReviewThread(threadId, reason, folder));
	} finally {
		forget?.();
	}
	e.manager.addReply(task, e.toReply(comment));
	e.manager.markBlocked(task, reason);
	return `Marked conversation ${task.conversationId} as BLOCKED and posted the reason to its thread.`;
}

const HANDLERS = {
	observe_pr: observePR,
	pr_tasks_list: listTasks,
	pr_task_detail: taskDetail,
	pr_task_resolve: resolveTask,
	pr_task_blocked: blockTask,
};

async function handleToolCall(name, args) {
	const handler = HANDLERS[name];
	if (!handler) throw new Error(`Unknown tool: ${name}`);
	return await handler(args, process.cwd());
}

// ------------------------------------------------------------------ JSON-RPC over stdio

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
	if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
	if (id !== undefined && id !== null) send({ jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * One request, one reply, never an exception: an unhandled throw here would kill the process and
 * the host would report an unusable server without a reason (the bug this file exists for).
 */
async function handleRequest(request) {
	const { id, method, params } = request;
	if (typeof method !== "string") return;

	// (notifications expect no reply, per JSON-RPC)
	if (method === "initialize") {
		sendResult(id, {
			protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
			capabilities: { tools: {} },
			serverInfo: SERVER_INFO,
		});
	} else if (method === "ping") {
		sendResult(id, {});
	} else if (method === "tools/list") {
		sendResult(id, { tools: TOOLS });
	} else if (method === "tools/call") {
		const name = params?.name;
		try {
			sendResult(id, { content: [{ type: "text", text: await handleToolCall(name, params?.arguments || {}) }], isError: false });
		} catch (err) {
			sendResult(id, { content: [{ type: "text", text: `${name} failed: ${err?.message ?? String(err)}` }], isError: true });
		}
	} else if (method === "logging/setLevel" || method.startsWith("notifications/")) {
		sendResult(id, {});
	} else {
		sendError(id, -32601, `Method not found: ${method}`);
	}
}

const lines = readline.createInterface({ input: process.stdin, terminal: false });
lines.on("line", (line) => {
	const trimmed = line.trim();
	if (!trimmed) return;
	let request;
	try {
		request = JSON.parse(trimmed);
	} catch {
		return; // (not JSON-RPC: nothing to answer, and answering would only confuse the host)
	}
	// (requests are handled concurrently: a `gh` call must not hold the next message hostage)
	handleRequest(request).catch((err) => {
		console.error(`pr-observer: ${err?.stack ?? err}`);
		sendError(request?.id, -32603, err?.message ?? String(err));
	});
});
lines.on("close", () => process.exit(0));
