import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Silent, file-based error logging for the pi extensions.
 *
 * Extension failures (stale contexts, persist failures, torn-down UI contexts) must not
 * reach the terminal: `console.*` output interleaves with the TUI and breaks it, while a
 * swallowed failure is invisible. These helpers append JSON lines to a per-scope log file
 * (the same layout pi uses for `~/.pi/agent/crashes.json` and this repo's devin_delegate
 * session logs) instead: silent for the TUI, but preserved for debugging.
 *
 * Everything here is best-effort and exception-swallowing: logging must never change the
 * behavior of the call site, and a full/unwritable log file degrades to a silent no-op.
 */

const MAX_FILE_BYTES = 1024 * 1024; // trim below this size
const TRIM_KEEP_BYTES = 256 * 1024; // keep the tail when trimming

/** Where log files go. `PI_EXTENSION_LOG_DIR` overrides (tests); default `~/.pi/agent/logs`. */
export function logDir(): string {
	return process.env.PI_EXTENSION_LOG_DIR || path.join(os.homedir(), ".pi", "agent", "logs");
}

/** Log file for a scope: `<logDir>/<scope>.jsonl`. Exposed for tests. */
export function logPath(scope: string): string {
	return path.join(logDir(), `${scope}.jsonl`);
}

function flagOn(value: string | undefined): boolean {
	return value === "1" || value === "true";
}

/** Debug logging is on with `PI_EXTENSION_DEBUG=1` (any scope) or `PI_<SCOPE>_DEBUG=1`. */
export function isDebugEnabled(scope: string): boolean {
	if (flagOn(process.env.PI_EXTENSION_DEBUG)) return true;
	const specific = process.env[`PI_${scope.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_DEBUG`];
	return flagOn(specific);
}

function errorFields(err: unknown): { message: string; stack?: string } {
	if (err instanceof Error) return { message: err.message, stack: err.stack };
	return { message: String(err) };
}

function ensureDir(file: string): boolean {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		return true;
	} catch {
		return false;
	}
}

function fileBytes(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

/**
 * Append a line, keeping the file under MAX_FILE_BYTES. When over the cap, keep the most
 * recent TRIM_KEEP_BYTES (line-aligned tail) and append to that. A log must never grow
 * without bound for the life of a process that has a failing observer.
 */
function appendCapped(file: string, line: string): void {
	if (!ensureDir(file)) return;
	let keep = "";
	if (fileBytes(file) > MAX_FILE_BYTES) {
		try {
			const content = fs.readFileSync(file, "utf8");
			const start = Math.max(0, content.length - TRIM_KEEP_BYTES);
			const atLineStart = content.indexOf("\n", start);
			keep = atLineStart === -1 ? content.slice(start) : content.slice(atLineStart + 1);
			fs.writeFileSync(file, keep);
		} catch {
			return; // unreadable file: drop the record rather than throw
		}
	}
	try {
		fs.appendFileSync(file, `${line}\n`);
	} catch {
		// silent by design
	}
}

function writeRecord(scope: string, level: "error" | "warn" | "debug", what: string, fields: Record<string, unknown>): void {
	const record = {
		ts: new Date().toISOString(),
		pid: process.pid,
		scope,
		level,
		what,
		...fields,
	};
	appendCapped(logPath(scope), JSON.stringify(record));
}

/**
 * Record an error for debugging. Never throws, never writes to the console.
 * `err` may be an Error (message + stack are captured) or any thrown value.
 */
export function logError(scope: string, what: string, err?: unknown): void {
	try {
		const fields = err === undefined ? {} : errorFields(err);
		writeRecord(scope, "error", what, fields);
	} catch {
		// never break the call site
	}
}

/**
 * Record a warning for debugging. Never throws, never writes to the console.
 */
export function logWarn(scope: string, what: string): void {
	try {
		writeRecord(scope, "warn", what, {});
	} catch {
		// never break the call site
	}
}

/** Record a debug line; only written while debug logging is enabled for the scope. */
export function logDebug(scope: string, what: string, data?: Record<string, unknown>): void {
	try {
		if (!isDebugEnabled(scope)) return;
		writeRecord(scope, "debug", what, data ?? {});
	} catch {
		// never break the call site
	}
}
