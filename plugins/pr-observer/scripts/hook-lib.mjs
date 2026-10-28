#!/usr/bin/env node
/**
 * Shared plumbing for the pr-observer plugin's lifecycle hooks (check-settle, notify-changes,
 * session-init). Node builtins and the plugin's own vendored engine only - no package
 * dependencies, so an installed plugin runs the hooks with no npm install.
 *
 * Every failure is logged and fails open (the hook exits 0 without blocking anything): hooks are
 * documented best-effort, and a broken watcher must never wedge a session. The log is JSON lines
 * in the state directory, one line per event, so a silent session can still be debugged.
 */
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const GH_TIMEOUT_MS = 30_000;
/** Room a poll round (pr view + pr checks) needs; the watcher never starts one with less left. */
export const POLL_RESERVE_MS = numberEnv("PR_OBSERVER_HOOK_POLL_RESERVE_MS", 2 * GH_TIMEOUT_MS + 10_000);

/** Seconds the host may let a Stop hook run; the watcher sleeps strictly inside this. */
export const STOP_HOOK_TIMEOUT_S = numberEnv("PR_OBSERVER_HOOK_TIMEOUT_S", 300);
/** Sleep per Stop invocation: the timeout minus a margin, so the hook always exits before the kill. */
export const WATCH_CHUNK_MS = numberEnv("PR_OBSERVER_HOOK_CHUNK_MS", Math.max(5_000, STOP_HOOK_TIMEOUT_S * 1000 - 15_000));
/** Poll cadence while watching. */
export const WATCH_POLL_MS = numberEnv("PR_OBSERVER_HOOK_POLL_MS", 30_000);
/** Total watch budget across chained re-arms (the state file carries the clock). */
export const WATCH_MAX_MS = numberEnv("PR_OBSERVER_HOOK_MAX_WATCH_MS", 4 * 60 * 60 * 1000);
/** PostToolUse checks the PR at most this often (one gh round per tool call would be heavy). 0 disables the gate. */
export const NOTIFY_MIN_INTERVAL_MS = numberEnv("PR_OBSERVER_HOOK_MIN_NOTIFY_MS", 60_000, 0);

function numberEnv(name, fallback, minimum = 1) {
	const parsed = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

/**
 * Where state and logs live. `PLUGIN_DATA` is the Agent Plugins spec's persistent per-plugin
 * directory when the host provides it; tests override with PR_OBSERVER_HOOK_STATE_DIR; the
 * temporary directory is the fallback (state is disposable, the log is the record).
 */
export function stateDir() {
	return process.env.PR_OBSERVER_HOOK_STATE_DIR || process.env.PLUGIN_DATA || path.join(os.tmpdir(), "devin-pr-observer-hooks");
}

/** Stable per-session-per-repo key, so parallel sessions in one plugin never share state. */
export function stateKey(sessionId, cwd) {
	const hash = crypto.createHash("sha1").update(`${sessionId}\n${cwd}`).digest("hex").slice(0, 12);
	return `${sanitize(sessionId)}-${hash}`;
}

function sanitize(raw) {
	return String(raw ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "unknown";
}

export function readStdinJson(script, sessionId) {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => {
			try {
				resolve(data.trim() ? JSON.parse(data) : {});
			} catch (err) {
				// The payload is host-provided; a malformed one is worth a line, then the hook
				// proceeds with an empty payload (every consumer tolerates missing fields).
				logLine(script, sessionId, "warn", "malformed stdin payload; continuing with an empty one", err?.message ?? String(err));
				resolve({});
			}
		});
		// A host that passes no stdin must not hang the hook: EOF arrives on its own, but a
		// resumed/suspended stdin would not - bail after a short grace period.
		setTimeout(() => resolve({}), 2_000).unref();
	});
}

export function writeHookOutput(payload) {
	// fd 1 synchronously: a plain process.stdout.write followed by process.exit can truncate the
	// buffered write, and a truncated `decision: block` is silently no block at all.
	fs.writeSync(1, `${JSON.stringify(payload)}\n`);
}

/** The JSON-lines log. Never throws: a full or unwritable disk must not break the hook. */
export function logLine(script, sessionId, level, what, detail) {
	try {
		const dir = stateDir();
		fs.mkdirSync(dir, { recursive: true });
		const entry = {
			ts: new Date().toISOString(),
			pid: process.pid,
			script,
			session: sanitize(sessionId),
			level,
			what,
			...(detail !== undefined ? { detail: String(detail).slice(0, 4_000) } : {}),
		};
		fs.appendFileSync(path.join(dir, "hooks.log"), `${JSON.stringify(entry)}\n`);
	} catch {
		// (logging is best-effort by definition; nothing left to do with a logging failure)
	}
}

/** The session's state file, or {} when absent/unreadable (logged - corruption must be visible). */
export function readState(key, script, sessionId) {
	try {
		return JSON.parse(fs.readFileSync(path.join(stateDir(), `state-${key}.json`), "utf8"));
	} catch (err) {
		if (err?.code !== "ENOENT") {
			logLine(script, sessionId, "warn", "state file unreadable; starting from an empty state", err?.message ?? String(err));
		}
		return {};
	}
}

export function writeState(key, state) {
	try {
		const dir = stateDir();
		fs.mkdirSync(dir, { recursive: true });
		// Temp file + rename: a rename is atomic on POSIX, so a concurrent hook read never sees a
		// half-written state file (the hooks read-modify-write the same file).
		const target = path.join(dir, `state-${key}.json`);
		const tmp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
		fs.renameSync(tmp, target);
		return true;
	} catch (err) {
		return false;
	}
}

/** Opportunistic cleanup: state files older than a week are dropped (logs keep). */
export function sweepOldState(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
	try {
		const dir = stateDir();
		if (!fs.existsSync(dir)) return;
		const cutoff = Date.now() - maxAgeMs;
		for (const file of fs.readdirSync(dir)) {
			if (!file.startsWith("state-") || !file.endsWith(".json")) continue;
			const full = path.join(dir, file);
			if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
		}
	} catch {
		// (best-effort)
	}
}

/**
 * Runs `gh` and answers with parsed JSON, or { failed, err } - a non-zero exit is DATA for some
 * calls (`gh pr checks` fails when checks fail), so the caller decides what an exit means.
 */
export function ghJson(args, cwd) {
	return new Promise((resolve) => {
		execFile("gh", args, { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				resolve({ failed: true, err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
				return;
			}
			try {
				resolve({ failed: false, data: JSON.parse(stdout) });
			} catch (parseErr) {
				resolve({ failed: true, err: parseErr, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
			}
		});
	});
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The vendored engine (the same files the MCP server imports). Loaded lazily so an old Node that
 * cannot strip TypeScript degrades to the inline fallback below instead of dying: the hook then
 * still sees mergeability from the raw fields, it just classifies with the short local copy.
 */
export async function loadEngine(pluginRoot) {
	try {
		const [mergeability, ciVerdict] = await Promise.all([
			import(pathToFileURL(path.join(pluginRoot, "lib", "mergeability.ts")).href),
			import(pathToFileURL(path.join(pluginRoot, "lib", "ci-verdict.ts")).href),
		]);
		return { classifyMergeability: mergeability.classifyMergeability, evaluateCiVerdict: ciVerdict.evaluateCiVerdict, vendored: true };
	} catch (err) {
		return { classifyMergeability: classifyMergeabilityFallback, evaluateCiVerdict: undefined, vendored: false, err };
	}
}

/** Minimal copy of the vendored classification, used only when the engine could not load. */
function classifyMergeabilityFallback(payload) {
	const mergeable = String(payload?.mergeable ?? "").toUpperCase();
	const state = String(payload?.mergeStateStatus ?? payload?.mergeableState ?? "").toUpperCase();
	if (mergeable === "CONFLICTING" || state === "DIRTY") return "conflicting";
	if (state === "BEHIND") return "behind";
	if (mergeable === "MERGEABLE" || state === "CLEAN" || state === "UNSTABLE" || state === "BLOCKED" || state === "HAS_HOOKS") {
		return "mergeable";
	}
	return undefined;
}

/** One PR snapshot with everything the hooks decide on. `error` marks an unusable read. */
export async function readPrSnapshot(engine, cwd) {
	const view = await ghJson(
		["pr", "view", "--json", "number,state,isDraft,mergeable,mergeStateStatus"],
		cwd,
	);
	if (view.failed) {
		// "no pull requests found" is a normal answer here (the branch has no PR): not an error.
		const text = `${view.stderr}\n${view.err?.message ?? ""}`;
		if (/no pull requests|Could not resolve to a Pull/i.test(text)) return { none: true };
		return { error: view.err?.message ?? view.stderr ?? "gh pr view failed" };
	}
	const pr = view.data ?? {};
	const state = String(pr.state ?? "").toUpperCase();
	if (state !== "OPEN") return { none: true, state };
	if (Boolean(pr.isDraft)) return { none: true, state, draft: true, prNumber: Number(pr.number) };

	const number = Number(pr.number);
	const mergeState = engine.classifyMergeability(pr) ?? null;

	const checks = await ghJson(["pr", "checks", String(number), "--json", "name,bucket,state"], cwd);
	let ci = { verdict: "none", failedNames: [], pendingCount: 0, ghFailed: false };
	if (checks.failed) {
		// `gh pr checks` exits non-zero when checks fail - stdout may still carry the rows.
		const rows = Array.isArray(checks.stdout) ? checks.stdout : parseRows(checks.stdout);
		if (Array.isArray(rows) && rows.length > 0) {
			ci = summarizeChecks(engine, rows, false);
		} else {
			ci = { verdict: "unknown", failedNames: [], pendingCount: 0, ghFailed: true };
		}
	} else {
		ci = summarizeChecks(engine, checks.data, false);
	}

	return { none: false, prNumber: number, mergeState, ci };
}

function parseRows(stdout) {
	try {
		const rows = JSON.parse(String(stdout ?? ""));
		return Array.isArray(rows) ? rows : null;
	} catch {
		return null;
	}
}

function summarizeChecks(engine, rows, ghFailed) {
	const list = Array.isArray(rows) ? rows : [];
	const verdict = engine.evaluateCiVerdict ? engine.evaluateCiVerdict({ checks: list, ghFailed }) : verdictFallback(list, ghFailed);
	const failedNames = [];
	let pendingCount = 0;
	for (const row of list) {
		const bucket = String(row?.bucket ?? "").toLowerCase();
		const state = String(row?.state ?? row?.status ?? row?.conclusion ?? "").toUpperCase();
		const name = String(row?.name ?? "check");
		if (bucket === "pending" || ["PENDING", "IN_PROGRESS", "QUEUED"].includes(state)) pendingCount++;
		else if (bucket === "fail" || bucket === "cancel" || ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state)) {
			failedNames.push(name);
		}
	}
	return { verdict, failedNames, pendingCount, ghFailed };
}

function verdictFallback(rows, ghFailed) {
	const list = Array.isArray(rows) ? rows : [];
	if (ghFailed) return "unknown";
	if (list.length === 0) return "unknown";
	const states = list.map((row) => String(row?.state ?? row?.status ?? "").toUpperCase());
	if (states.some((s) => ["PENDING", "IN_PROGRESS", "QUEUED"].includes(s))) return "unknown";
	if (states.some((s) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(s))) return "failed";
	if (states.every((s) => ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(s))) return "passed";
	return "unknown";
}
