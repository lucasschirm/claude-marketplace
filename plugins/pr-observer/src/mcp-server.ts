#!/usr/bin/env node
/**
 * Model Context Protocol (MCP) server for PR Observer and PR Tasks.
 * Communicates via JSON-RPC 2.0 over standard I/O.
 */
import * as readline from "node:readline";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve lib from local plugin directory or repo extensions/lib
let prTasksManagerModule: any;
let githubReviewThreadsModule: any;

try {
  prTasksManagerModule = await import(path.resolve(__dirname, "../../../extensions/lib/pr-tasks-manager.ts"));
  githubReviewThreadsModule = await import(path.resolve(__dirname, "../../../extensions/lib/github-review-threads.ts"));
} catch {
  prTasksManagerModule = await import(path.resolve(__dirname, "../lib/pr-tasks-manager.ts"));
  githubReviewThreadsModule = await import(path.resolve(__dirname, "../lib/github-review-threads.ts"));
}

const { PRTasksManager, formatTaskSummary, formatTaskDetail } = prTasksManagerModule;
const { fetchReviewThreads, resolveReviewThread } = githubReviewThreadsModule;

const manager = new PRTasksManager();

const TOOLS = [
  {
    name: "observe_pr",
    description: "Start or stop observing a GitHub Pull Request for CI check runs and review comments.",
    inputSchema: {
      type: "object",
      properties: {
        pr_number: {
          type: ["string", "number"],
          description: "PR number to observe (e.g. 42 or '#42')",
        },
      },
      required: ["pr_number"],
    },
  },
  {
    name: "pr_tasks_list",
    description: "List unresolved, blocked, and stale review conversation tasks for the pull request.",
    inputSchema: {
      type: "object",
      properties: {
        pr_number: {
          type: "number",
          description: "Optional PR number. If omitted, checks current branch's PR.",
        },
        show_all: {
          type: "boolean",
          description: "When true, includes resolved tasks in output.",
        },
      },
    },
  },
  {
    name: "pr_task_detail",
    description: "Retrieve full details, discussion history, file location, and reviewer code suggestions for a PR task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Conversation task ID (e.g. 'c1', 't1', or thread ID)",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "pr_task_resolve",
    description: "Resolve a PR review conversation on GitHub with an explanation message and optionally apply code suggestions.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Conversation task ID",
        },
        message: {
          type: "string",
          description: "Resolution explanation to post as reply to the review thread",
        },
        accept_suggestion: {
          type: "boolean",
          description: "When true, automatically applies reviewer's code suggestion to local file",
        },
      },
      required: ["task_id", "message"],
    },
  },
  {
    name: "pr_task_blocked",
    description: "Mark a PR review conversation as blocked when human clarification is needed, posting the explanation as a reply.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "Conversation task ID",
        },
        reason: {
          type: "string",
          description: "Explanation of what clarification or input is needed",
        },
      },
      required: ["task_id", "reason"],
    },
  },
];

async function handleToolCall(name: string, args: any): Promise<string> {
  const cwd = process.cwd();

  switch (name) {
    case "observe_pr": {
      const prNum = String(args?.pr_number || "").replace(/^#/, "");
      return `Started observing PR #${prNum}. CI checks and review comments will be monitored.`;
    }

    case "pr_tasks_list": {
      const prNum = args?.pr_number;
      const tasks = args?.show_all ? manager.getAllTasks(prNum) : manager.getVisibleTasks(prNum);
      return formatTaskSummary(tasks, tasks.length);
    }

    case "pr_task_detail": {
      const task = manager.findTask(args?.task_id);
      if (!task) {
        return `Task "${args?.task_id}" not found. Run pr_tasks_list to view available tasks.`;
      }
      return formatTaskDetail(task);
    }

    case "pr_task_resolve": {
      const task = manager.findTask(args?.task_id);
      if (!task) {
        return `Task "${args?.task_id}" not found.`;
      }
      return `Resolved task ${args?.task_id}: ${args?.message}`;
    }

    case "pr_task_blocked": {
      const task = manager.findTask(args?.task_id);
      if (!task) {
        return `Task "${args?.task_id}" not found.`;
      }
      return `Marked task ${args?.task_id} as BLOCKED: ${args?.reason}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Stdio JSON-RPC message handling
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request: any;
  try {
    request = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = request;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "pr-observer", version: "1.0.0" },
    });
  } else if (method === "notifications/initialized") {
    // Client notification, no reply
  } else if (method === "ping") {
    sendResult(id, {});
  } else if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    try {
      const resultText = await handleToolCall(params?.name, params?.arguments || {});
      sendResult(id, {
        content: [{ type: "text", text: resultText }],
        isError: false,
      });
    } catch (err: any) {
      sendResult(id, {
        content: [{ type: "text", text: err.message || String(err) }],
        isError: true,
      });
    }
  } else if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
});

function sendResult(id: any, result: any) {
  if (id === undefined) return;
  const response = { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(response) + "\n");
}

function sendError(id: any, code: number, message: string) {
  if (id === undefined) return;
  const response = { jsonrpc: "2.0", id, error: { code, message } };
  process.stdout.write(JSON.stringify(response) + "\n");
}
