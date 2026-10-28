// Run with: node --test test/test-pr-observer-mcp.ts
//
// The pr-observer plugin is installed by being *copied* into the host's plugin cache, and its MCP
// server is whatever answers the handshake there. That is what this suite drives: a copy of the
// plugin in a throwaway directory (no repository around it, exactly like an install), the launcher
// from the plugin's own .mcp.json, and a fake `gh` on PATH.
//
// The bug it gates: src/mcp-server.ts imported ../../../extensions/lib/..., which only exists in a
// checkout. Installed, the process died on import before answering `initialize`, and Devin's only
// report was "Failed to list tools for server 'pr-observer'. Please try again."
import { test, after } from "node:test";
import * as assert from "node:assert";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./helpers/git-repo.ts";
import { checkPluginLibs, VENDORING } from "../scripts/sync-plugin-libs.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(REPO, "plugins", "pr-observer");
const TOOL_NAMES = ["observe_pr", "pr_tasks_list", "pr_task_detail", "pr_task_resolve", "pr_task_blocked"];

const closeFns: Array<() => void> = [];
after(() => {
	for (const close of closeFns.splice(0)) close();
});

// ------------------------------------------------------------------ the fake gh

const FAKE_GH = `#!/usr/bin/env node
// Answers the calls plugins/pr-observer makes, from the JSON in FAKE_GH_STATE, and records every
// call in <FAKE_GH_STATE>.calls so a test can assert what GitHub actually received.
const fs = require("node:fs");
const argv = process.argv.slice(2);
const arg = (needle) => argv.find((a) => String(a).includes(needle));
const value = (needle) => String(arg(needle) ?? "").slice(needle.length);
fs.appendFileSync(process.env.FAKE_GH_STATE + ".calls", JSON.stringify(argv) + "\\n");
const state = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, "utf8"));
const out = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");

function main() {
  if (argv[0] === "repo" && argv[1] === "view") return out({ owner: { login: state.owner }, name: state.repo });
  if (argv[0] === "pr" && argv[1] === "view") return out({ number: state.pr, mergeable: state.mergeable, mergeStateStatus: state.mergeStateStatus });
  if (argv[0] === "pr" && argv[1] === "checks") {
    if (state.checksFailed) return process.exit(1);
    return out(state.checks);
  }
  if (argv[0] === "api") {
    if (arg("resolveReviewThread")) {
      state.resolves = [...(state.resolves || []), value("threadId=")];
      fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state, null, 2));
      return out({ data: { resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } } });
    }
    if (arg("addPullRequestReviewThreadReply")) {
      const body = value("body=");
      state.replies = [...(state.replies || []), body];
      fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(state, null, 2));
      return out({
        data: {
          addPullRequestReviewThreadReply: {
            comment: { id: "PRRC_reply_1", databaseId: 4200, body, createdAt: "2026-10-21T10:00:00Z", author: { login: "agent_bot" } },
          },
        },
      });
    }
    return out({
      data: {
        repository: {
          pullRequest: {
            id: "PR_1",
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state.threads || [] },
          },
        },
      },
    });
  }
  return process.exit(2);
}
main();
`;

/** A `gh` on PATH serving `state`, plus the calls it received. */
function fakeGh(state: Record<string, unknown>) {
	const binDir = tmpDir("pr-observer-ghbin-");
	const stateFile = path.join(tmpDir("pr-observer-ghstate-"), "state.json");
	fs.writeFileSync(path.join(binDir, "gh"), FAKE_GH);
	fs.chmodSync(path.join(binDir, "gh"), 0o755);
	fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
	return {
		binDir,
		stateFile,
		calls(): string[][] {
			const file = `${stateFile}.calls`;
			if (!fs.existsSync(file)) return [];
			return fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line));
		},
	};
}

function reviewThread(overrides: Record<string, unknown> = {}) {
	return {
		id: "PRRT_1",
		isResolved: false,
		isOutdated: false,
		path: "src/app.ts",
		line: 3,
		originalLine: 3,
		startLine: 3,
		originalStartLine: 3,
		diffSide: "RIGHT",
		startDiffSide: "RIGHT",
		comments: {
			totalCount: 1,
			nodes: [
				{
					id: "PRRC_1",
					databaseId: 100,
					body: "Use a named constant.\n```suggestion\nconst MAX = 3;\n```",
					createdAt: "2026-10-21T09:00:00Z",
					author: { login: "reviewer_alice" },
				},
			],
		},
		...overrides,
	};
}

const BASE_STATE = {
	owner: "octo",
	repo: "widgets",
	pr: 7,
	checks: [{ bucket: "pass", state: "SUCCESS" }],
	threads: [reviewThread()],
};

// ------------------------------------------------------------------ the plugin, as installed

/** A copy of the plugin in a throwaway directory: the layout `devin plugins install` produces. */
function installedPlugin(): string {
	const dir = tmpDir("pr-observer-install-");
	const target = path.join(dir, "plugins", "cache", "github.com_owner_claude-marketplace_plugins_pr-observer-abc123", "1.0.0");
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.cpSync(PLUGIN, target, { recursive: true });
	return target;
}

/** A git repository holding the reviewed file, standing in for the agent's workspace. */
function workspace(): string {
	const dir = tmpDir("pr-observer-ws-");
	cp.execFileSync("git", ["init", "-q", dir]);
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(path.join(dir, "src", "app.ts"), "one\ntwo\nMAX = 2\nfour\n");
	return dir;
}

/**
 * The launcher string the shipped .mcp.json hands to the host. Asserted rather than reimplemented:
 * a launcher that only works when a host substitutes a particular variable is the failure mode this
 * plugin kept hitting, so the tests run exactly what the hosts will run.
 */
function launcher(): string {
	const config = JSON.parse(fs.readFileSync(path.join(PLUGIN, ".mcp.json"), "utf8"));
	const server = config.mcpServers["pr-observer"];
	assert.equal(server.command, "sh", ".mcp.json starts the server through a shell so one file serves both hosts");
	assert.equal(server.args[0], "-c");
	return server.args[1];
}

interface Server {
	call(method: string, params?: unknown): Promise<any>;
	text(result: any): string;
	stderr(): string;
	/**
	 * Resolves with the exit code when the child is gone **and its stdio has reached EOF** ('close').
	 * Deliberately the only way to wait for the server: 'exit' fires when the process is reaped, and a
	 * message it wrote to stderr on its way out can still be in flight, so `await <exit>` followed by
	 * `stderr()` is a race. CI met it: the launcher exited 1 and `stderr()` came back empty 11 ms later
	 * (`a25d729` era, unit job of run 39872388212), while 240 local trials never lost a byte - a
	 * scheduling difference on a throttled runner, not something a longer sleep fixes. Waiting for
	 * stdio EOF is the documented guarantee, and there is no `exited` seam to reach for by mistake.
	 */
	closed: Promise<number | null>;
	close(): void;
}

/**
 * Spawns the plugin's MCP server the way a host does: through the .mcp.json launcher, with the
 * given plugin-root placeholders (or none) and the fake `gh` first on PATH.
 */
function startServer(options: {
	pluginRoot?: string;
	claudePluginRoot?: string;
	home?: string;
	gh?: ReturnType<typeof fakeGh>;
	cwd: string;
}): Server {
	// (the real user environment must not leak in: its caches and its plugin-root variables would
	//  decide the outcome instead of the ones the test passes)
	const env: Record<string, string | undefined> = { ...process.env };
	for (const name of ["PLUGIN_ROOT", "DEVIN_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "XDG_DATA_HOME"]) delete env[name];
	env.PATH = `${options.gh?.binDir ?? ""}${path.delimiter}${env.PATH ?? ""}`;
	if (options.gh) env.FAKE_GH_STATE = options.gh.stateFile;
	if (options.home) env.HOME = options.home;
	if (options.pluginRoot) env.PLUGIN_ROOT = options.pluginRoot;
	if (options.claudePluginRoot) env.CLAUDE_PLUGIN_ROOT = options.claudePluginRoot;

	const child = cp.spawn("sh", ["-c", launcher()], { cwd: options.cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => (stderr += chunk));

	const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
	const waiting = new Map<number, (message: any) => void>();
	let buffer = "";
	let exitCode: number | null = null;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			const pending = waiting.get(message.id);
			if (pending) {
				waiting.delete(message.id);
				pending(message);
			}
		}
	});
	child.on("exit", (code) => {
		exitCode = code;
	});

	let nextId = 1;
	const server: Server = {
		async call(method, params) {
			if (exitCode !== null) throw new Error(`the server exited (${exitCode}) before answering ${method}: ${stderr}`);
			const id = nextId++;
			const response = new Promise<any>((resolve, reject) => {
				waiting.set(id, resolve);
				setTimeout(() => {
					if (waiting.delete(id)) reject(new Error(`no response to ${method} within 30s; stderr: ${stderr}`));
				}, 30_000).unref();
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return await response;
		},
		text: (result) => {
			assert.ok(result?.result, `no result in ${JSON.stringify(result)}`);
			assert.equal(result.result.isError, false, JSON.stringify(result.result.content));
			return result.result.content[0].text as string;
		},
		stderr: () => stderr,
		closed,
		close: () => {
			child.stdin.end();
			child.kill();
		},
	};
	closeFns.push(server.close);
	return server;
}

/** A server reached through a host that substitutes `${PLUGIN_ROOT}`, which is what Devin does. */
function connectedServer(gh: ReturnType<typeof fakeGh>, cwd = workspace()): Server {
	const server = startServer({ pluginRoot: installedPlugin(), home: tmpDir("pr-observer-home-"), gh, cwd });
	return server;
}

// ------------------------------------------------------------------ the plugin is self-contained

test("no plugin file reaches outside the plugin directory", () => {
	// An install copies this directory alone, so any path that climbs out of it names a file the
	// installed server will never see - which is exactly how the server used to die on import.
	const offenders: string[] = [];
	for (const entry of fs.readdirSync(PLUGIN, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.(?:mjs|cjs|js|ts|json)$/.test(entry.name)) continue;
		const file = path.join(entry.parentPath ?? entry.path, entry.name);
		for (const [number, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
			// (comments may narrate the old broken path; only code decides what the server reads)
			if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
			const code = line.replace(/\/\/.*$/, "");
			if (/(?:from|require\(|import\()\s*["'`][^"'`]*\.\.\//.test(code)) offenders.push(`${entry.name}:${number + 1}: ${line.trim()}`);
		}
	}
	assert.deepEqual(offenders, [], "plugin files must stay inside the plugin:\n" + offenders.join("\n"));
});

test("the vendored engine matches extensions/lib", () => {
	// The same gate `npm run validate` applies, asserted here so `npm test` catches drift too.
	assert.deepEqual(checkPluginLibs(REPO), []);
});

/** Line and block comments out, literals intact - prose is not an import. */
function stripComments(source) {
	return source
		.split("\n")
		.map((line) => {
			let out = "";
			let quote = "";
			for (let i = 0; i < line.length; i++) {
				const c = line[i];
				if (quote) {
					out += c;
					if (c === "\\") {
						out += line[++i] ?? "";
						continue;
					}
					if (c === quote) quote = "";
					continue;
				}
				if (c === '"' || c === "'" || c === "`") {
					quote = c;
					out += c;
					continue;
				}
				if (c === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) break;
				out += c;
			}
			return out;
		})
		.join("\n");
}

test("the vendored engine is the whole dependency closure of the review tools", async () => {
	// An installed plugin can only resolve node: builtins and files it carries itself, so every relative
	// import in the vendored graph has to land on a file that is in the plugin. Walked from the vendored
	// list rather than a hard-coded set of names: when lib/exec.ts joined the graph the old version of this
	// test failed for the right reason, and the fix it wanted was "check the filesystem", not "add a name".
	// Absolute from the repo root, not from `process.cwd()`: the queue is deduplicated by string, and
	// seeding relatively while pushing absolutely made every transitively imported file visit twice - and
	// made the whole test fail when it was run from anywhere but the repo root.
	const queue = VENDORING.flatMap(({ plugin, files }) => files.map((file) => path.resolve(REPO, plugin, "lib", file)));
	const unresolved: string[] = [];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const dir = path.dirname(file);
		if (!fs.existsSync(file)) {
			unresolved.push(
				`${path.relative(REPO, file)} is declared as vendored but is not on disk - run 'node scripts/sync-plugin-libs.mjs --write'`,
			);
			continue;
		}
		// Only real import/export statements. A bare `from "..."` search counted prose: a vendored comment
		// reading `// parse the output from "gh pr view"` failed the test as an illegal package import, and
		// a gate that fails on comments gets disabled rather than fixed.
		for (const match of stripComments(fs.readFileSync(file, "utf8")).matchAll(
			/(?:^|[;\n])\s*(?:import|export)[^;]*?\bfrom\s*["']([^"']+)["']/g,
		)) {
			const specifier = match[1];
			if (specifier.startsWith("node:")) continue;
			if (!specifier.startsWith("./")) {
				unresolved.push(`${path.relative(REPO, file)} imports "${specifier}" - a package, which no install guarantees`);
				continue;
			}
			const target = path.resolve(dir, specifier);
			if (!fs.existsSync(target)) unresolved.push(`${path.relative(REPO, file)} imports "${specifier}", which the plugin does not carry`);
			else if (!seen.has(target)) queue.push(target);
		}
	}
	assert.deepEqual(unresolved, [], "the plugin cannot resolve its own import graph:\n" + unresolved.join("\n"));
});

// ------------------------------------------------------------------ the launcher

test("the handshake succeeds when the host substitutes PLUGIN_ROOT (Devin)", async () => {
	const gh = fakeGh({ ...BASE_STATE });
	const server = connectedServer(gh);

	const init = await server.call("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
	assert.equal(init.result.serverInfo.name, "pr-observer");
	assert.ok(init.result.capabilities.tools, "the server must advertise the tools capability");

	const tools = await server.call("tools/list");
	assert.deepEqual(
		tools.result.tools.map((tool: { name: string }) => tool.name),
		TOOL_NAMES,
	);
	for (const tool of tools.result.tools) {
		assert.ok(tool.description.length > 20, `${tool.name} needs a description an agent can route on`);
		assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object inputSchema`);
	}
	server.close();
});

test("the handshake succeeds when the host substitutes CLAUDE_PLUGIN_ROOT (Claude Code)", async () => {
	const gh = fakeGh({ ...BASE_STATE });
	// (outside every cache the launcher could stumble into: only the substitution can find it)
	const server = startServer({ claudePluginRoot: installedPlugin(), home: tmpDir("pr-observer-home-"), gh, cwd: workspace() });
	const tools = await server.call("tools/list");
	assert.equal(tools.result.tools.length, TOOL_NAMES.length);
	server.close();
});

test("the handshake succeeds when nothing is substituted and only the cache is there", async () => {
	const gh = fakeGh({ ...BASE_STATE });
	const home = tmpDir("pr-observer-home-");
	const dir = path.join(
		home,
		".devin-xdg-data",
		"devin",
		"cli",
		"plugins",
		"cache",
		"github.com_owner_repo_plugins_pr-observer-abc",
		"1.0.0",
	);
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	fs.cpSync(PLUGIN, dir, { recursive: true });
	const server = startServer({ home, gh, cwd: workspace() });

	const tools = await server.call("tools/list");
	assert.equal(tools.result.tools.length, TOOL_NAMES.length);
	server.close();
});

test("an unusable plugin says why instead of dying silently", async () => {
	const server = startServer({ home: tmpDir("pr-observer-home-"), cwd: workspace() });
	const code = await server.closed;
	assert.equal(code, 1, "the launcher must exit non-zero when it cannot find the server");
	// Names what was actually captured, so a future failure says whether stderr never arrived or said
	// something else - the difference between a broken launcher and a test that read too early.
	assert.match(
		server.stderr(),
		/could not locate the plugin directory/,
		`the launcher must say why it gave up; captured stderr was ${JSON.stringify(server.stderr())}`,
	);
	server.close();
});

// ------------------------------------------------------------------ the tools

test("a plugin whose engine cannot load still answers tools/list and says why", async () => {
	// The host's only report for a server that dies at import is "Failed to list tools for server", so
	// the handshake and the listing must survive a broken engine, and the reason must reach the agent.
	const broken = installedPlugin();
	fs.rmSync(path.join(broken, "lib"), { recursive: true, force: true });
	const gh = fakeGh({ ...BASE_STATE });
	const server = startServer({ pluginRoot: broken, home: tmpDir("pr-observer-home-"), gh, cwd: workspace() });

	await server.call("initialize", {});
	const tools = await server.call("tools/list");
	assert.equal(tools.result.tools.length, TOOL_NAMES.length);

	const failed = await server.call("tools/call", { name: "pr_tasks_list", arguments: {} });
	assert.equal(failed.result.isError, true);
	assert.match(failed.result.content[0].text, /engine of this plugin did not load/);
	assert.match(failed.result.content[0].text, /Node 22\.18 or newer/);
	server.close();
});

test("pr_tasks_list reads the review conversations of the current branch's PR", async () => {
	const gh = fakeGh({ ...BASE_STATE });
	const server = connectedServer(gh);
	await server.call("initialize", {});

	const listed = server.text(await server.call("tools/call", { name: "pr_tasks_list", arguments: {} }));
	assert.match(listed, /\*\*Conversation Id\*\*: 100 /);
	assert.match(listed, /src\/app\.ts/);
	assert.match(listed, /Showing 1 tasks of 1/);
	assert.ok(
		gh.calls().some((call) => call[0] === "api" && call.some((a) => String(a).includes("reviewThreads"))),
		"the listing must come from GitHub, not from memory",
	);
	server.close();
});

test("observe_pr reports the CI verdict and the conversation counts", async () => {
	const gh = fakeGh({ ...BASE_STATE });
	const server = connectedServer(gh);
	await server.call("initialize", {});

	const seen = server.text(await server.call("tools/call", { name: "observe_pr", arguments: { pr_number: "#7" } }));
	assert.match(seen, /PR #7 \(octo\/widgets\)/);
	assert.match(seen, /CI passed/);
	assert.match(seen, /1 open/);
	assert.ok(
		gh.calls().some((call) => call.includes("pr=7")),
		"the '#' prefix must not reach GitHub",
	);
	server.close();
});

test("observe_pr never calls an unreadable CI status a pass", async () => {
	const gh = fakeGh({ ...BASE_STATE, checks: null, checksFailed: true });
	const server = connectedServer(gh);
	await server.call("initialize", {});
	const seen = server.text(await server.call("tools/call", { name: "observe_pr", arguments: { pr_number: 7 } }));
	assert.match(seen, /CI status unknown/);
	server.close();
});

test("observe_pr reports a conflicting PR as unlandable", async () => {
	const gh = fakeGh({ ...BASE_STATE, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
	const server = connectedServer(gh);
	await server.call("initialize", {});
	const seen = server.text(await server.call("tools/call", { name: "observe_pr", arguments: { pr_number: 7 } }));
	assert.match(seen, /Mergeability: CONFLICTING/);
	assert.ok(
		gh.calls().some((call) => call.includes("mergeable,mergeStateStatus")),
		"the mergeability must come from GitHub, not be assumed",
	);
	server.close();
});

test("observe_pr reports a BEHIND PR and stays silent on a clean one", async () => {
	const gh = fakeGh({ ...BASE_STATE, mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" });
	const server = connectedServer(gh);
	await server.call("initialize", {});
	assert.match(server.text(await server.call("tools/call", { name: "observe_pr", arguments: { pr_number: 7 } })), /Mergeability: BEHIND/);
	server.close();

	const clean = fakeGh({ ...BASE_STATE, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
	const cleanServer = connectedServer(clean);
	await cleanServer.call("initialize", {});
	// (a clean PR adds no mergeability line: CI and approvals have their own reporting)
	const seen = cleanServer.text(await cleanServer.call("tools/call", { name: "observe_pr", arguments: { pr_number: 7 } }));
	assert.doesNotMatch(seen, /Mergeability/);
	cleanServer.close();
});

test("pr_task_resolve applies a shown suggestion, replies and resolves the thread", async () => {
	const gh = fakeGh({ ...BASE_STATE });
	const cwd = workspace();
	const server = connectedServer(gh, cwd);
	await server.call("initialize", {});
	// (GitHub's comment databaseId is what the listing hands out as the Conversation Id)
	const id = "100";

	// A suggestion nobody has been shown is never written to disk, and nothing is posted.
	const tooSoon = await server.call("tools/call", {
		name: "pr_task_resolve",
		arguments: { task_id: id, message: "Done", accept_suggestion: true },
	});
	assert.match(tooSoon.result.content[0].text, /not been shown the code suggestion/);
	assert.match(fs.readFileSync(path.join(cwd, "src", "app.ts"), "utf8"), /MAX = 2/);
	assert.deepEqual(
		gh.calls().filter((call) => call.some((a) => String(a).includes("addPullRequestReviewThreadReply"))),
		[],
	);

	// Showing it is what makes the same call valid afterwards.
	const listed = server.text(await server.call("tools/call", { name: "pr_task_detail", arguments: { task_id: id } }));
	assert.match(listed, /Code Suggestion/);

	const resolved = server.text(
		await server.call("tools/call", { name: "pr_task_resolve", arguments: { task_id: id, message: "Fixed", accept_suggestion: true } }),
	);
	assert.match(resolved, new RegExp(`Resolved conversation ${id}`));
	assert.equal(fs.readFileSync(path.join(cwd, "src", "app.ts"), "utf8"), "one\ntwo\nconst MAX = 3;\nfour\n");

	const posted = gh.calls().filter((call) => call.some((a) => String(a).includes("addPullRequestReviewThreadReply")));
	const resolvedCalls = gh.calls().filter((call) => call.some((a) => String(a).includes("resolveReviewThread")));
	assert.equal(posted.length, 1, "one reply per resolve");
	assert.equal(resolvedCalls.length, 1, "the thread is resolved on GitHub");
	assert.ok(
		posted[0].some((a) => String(a).startsWith("body=Fixed")),
		"the reviewer sees the message",
	);

	const counts = server.text(await server.call("tools/call", { name: "observe_pr", arguments: { pr_number: 7 } }));
	assert.match(counts, /0 open, 0 blocked, 0 stale, 1 resolved/);
	server.close();
});

test("pr_task_blocked posts the reason and reports the conversation as blocked", async () => {
	const gh = fakeGh({ ...BASE_STATE });
	const server = connectedServer(gh);
	await server.call("initialize", {});
	const listed = server.text(await server.call("tools/call", { name: "pr_tasks_list", arguments: {} }));
	const id = listed.match(/\*\*Conversation Id\*\*: (\S+) /)?.[1];
	assert.ok(id, `no conversation id in the listing: ${listed}`);

	const blocked = server.text(
		await server.call("tools/call", { name: "pr_task_blocked", arguments: { task_id: id, reason: "Which name?" } }),
	);
	assert.match(blocked, /BLOCKED/);
	assert.ok(gh.calls().some((call) => call.some((a) => String(a) === "body=Which name?")));

	// (a blocked conversation is still reported: it is open work waiting on a human, not finished)
	const relisted = server.text(await server.call("tools/call", { name: "pr_tasks_list", arguments: {} }));
	assert.match(relisted, /\*\*Status\*\*: BLOCKED/);
	server.close();
});

test("a bad call answers as a tool error and the server stays usable", async () => {
	const gh = fakeGh({ ...BASE_STATE, threads: [] });
	const server = connectedServer(gh);
	await server.call("initialize", {});

	const unknownTool = await server.call("tools/call", { name: "nope", arguments: {} });
	assert.equal(unknownTool.result.isError, true);
	assert.match(unknownTool.result.content[0].text, /Unknown tool/);

	const missingTask = await server.call("tools/call", { name: "pr_task_detail", arguments: { task_id: "PRRC_missing" } });
	assert.equal(missingTask.result.isError, true);
	assert.match(missingTask.result.content[0].text, /not a review conversation/);

	// (surviving a bad call is the point: a host reports a dead server as an unusable plugin)
	assert.equal((await server.call("tools/list")).result.tools.length, TOOL_NAMES.length);
	assert.equal((await server.call("things/whatever")).error.code, -32601);
	server.close();
});
