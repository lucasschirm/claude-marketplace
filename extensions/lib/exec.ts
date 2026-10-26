/**
 * The single door to subprocesses.
 *
 * Everything a Pi extension runs outside this file goes through `runJson` / `runText` /
 * `spawnLongLived`, and `scripts/check-quality.mjs` enforces that (`execLocation`, `execTimeout`,
 * `jsonParseLocation`). The reason is not tidiness. Before C2 the interesting failure of an external
 * call was an `undefined` three assignments later: a CLI that exits non-zero and prints nothing makes
 * `JSON.parse(stdout)` throw, the `catch` swallows it, and the caller reports "no workers" to a
 * coordinator that then dispatches work that is already running. A discriminated envelope makes that
 * state unrepresentable - reading `data` requires having checked `ok`, so `res.ok` discipline is the
 * compiler's job rather than a reviewer's, and the failure names which of its causes it was.
 *
 * Two kinds of subprocess live here because they need opposite policies:
 *
 *   - a **request** (`gh pr view`, `orca worker-list`) must not be able to hang the TUI, so a timeout
 *     is mandatory and the signature has no path to "no timeout";
 *   - a **session** (`devin acp`) must not be killed by the wall clock. Its liveness is "has it said
 *     anything lately", with a longer allowance while a tool call is open - see `spawnLongLived`.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";

const execFileAsync = promisify(execFile);

/**
 * Request timeouts, measured rather than picked. D7 read 191 completed Devin turns and 7 396 tool
 * calls out of the `events.jsonl` files under `~/.pi/agent/devin_delegate`: the longest silence with no tool open was
 * 37.1 s, so a read that has not answered in 60 s is stuck, not slow. A mutation may wait for a
 * server-side write, hence 120 s. No call site in this repo needs more.
 */
export const READ_TIMEOUT_MS = 60_000;
export const MUTATION_TIMEOUT_MS = 120_000;

/** The envelope a large `worker-list` answers with is megabytes; this is the limit the door has always used. */
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * How much of a command's output is kept on the failure. Bounded because the text goes into tool
 * results and into persisted state, but generous: when a CLI says something long, the part that
 * explains it is usually what the user needs. (`gh` embeds a whole reply body in one line.)
 */
const EXCERPT_CHARS = 2048;
/** How many schema violations are named before "and N more". */
const MAX_SCHEMA_ERRORS = 5;

export type ExecFailureCode =
	/** Ran out of time. The process was killed; the command may or may not have had its effect. */
	| "TIMEOUT"
	/** The executable is not on PATH (or the cwd is gone). Nothing ran. */
	| "NOT_FOUND"
	/** Output exceeded `maxBuffer`: the command worked, the reader gave up. Raise the limit, do not retry. */
	| "MAX_BUFFER"
	/** The process exited non-zero. `exitCode`/`stderr` say what it said. */
	| "EXIT"
	/** Exit 0 (or `acceptJsonOnFailure`) with a body that is not JSON. */
	| "BAD_JSON"
	/** Valid JSON that is not the shape asked for. Names the paths, never the payload. */
	| "BAD_SCHEMA"
	/** The spawn itself failed for a reason that is not a missing binary (permissions, EPERM). */
	| "SPAWN";

export interface ExecSuccess<T> {
	ok: true;
	data: T;
}

export interface ExecFailure {
	ok: false;
	code: ExecFailureCode;
	/** A short, safe sentence. Never the whole payload: the caller decides what a user sees. */
	message: string;
	/** What the command wrote on stdout, excerpted. Present whenever there was any. */
	stdout?: string;
	stderr?: string;
	exitCode?: number | null;
	signal?: string | null;
	/**
	 * The original error, for callers that classify GitHub availability (`ghHealth`). Do not render
	 * it: `execFile` embeds the command line and the output in `Error.message`.
	 */
	cause?: unknown;
}

export type ExecResult<T> = ExecSuccess<T> | ExecFailure;

export interface ExecOptions {
	cwd?: string;
	/** Merged over `process.env`, as a shell would. `undefined` values delete the key. */
	env?: Record<string, string | undefined>;
	/** Optional here only because every entry point supplies a default; no path through this file runs without one. */
	timeoutMs?: number;
	maxBuffer?: number;
}

export interface JsonOptions extends ExecOptions {
	/**
	 * Shape the payload must satisfy. A mismatch is `BAD_SCHEMA` naming the offending paths, which is
	 * how a CLI rename turns into a report instead of a silent empty list.
	 */
	schema?: TSchema;
	/**
	 * Some CLIs answer with a JSON envelope and exit non-zero (Orca does: `ok: false` plus exit 1).
	 * With this set, a non-zero exit whose stdout parses is returned as success and the caller reads
	 * the envelope's own verdict. A non-zero exit with unusable stdout is still `EXIT`.
	 */
	acceptJsonOnFailure?: boolean;
}

export interface TextOptions extends ExecOptions {
	/** Default true: callers compare text, and a trailing newline is never part of the answer. */
	trim?: boolean;
}

function excerpt(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	if (!text) return undefined;
	return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text;
}

/**
 * Map a node child-process error onto a cause the caller can act on. The order matters: a timeout is
 * also a non-zero exit, and `ENOENT` on a missing cwd is not a missing binary worth reporting as one.
 */
function classify(err: unknown, maxBufferBytes: number): ExecFailure {
	const e = err as {
		killed?: boolean;
		signal?: string | null;
		code?: string | number | null;
		message?: string;
		stdout?: unknown;
		stderr?: unknown;
	};
	const stdout = excerpt(e.stdout);
	const stderr = excerpt(e.stderr);
	const base = { stdout, stderr, cause: err, signal: typeof e.signal === "string" ? e.signal : null };

	// execFile's timeout kills the child: `killed` is true and the code is a signal, not an exit code.
	if (e.killed === true || e.code === "ETIMEDOUT") {
		return { ok: false, code: "TIMEOUT", message: "the command exceeded its timeout and was killed", ...base };
	}
	// Node's own code is ERR_CHILD_PROCESS_STDIO_MAXBUFFER - no underscore between MAX and BUFFER - so a
	// match written from the ExecFailureCode spelling never fires and the failure lands in EXIT.
	if (typeof e.code === "string" && /MAX_?BUFFER/.test(e.code)) {
		return {
			ok: false,
			code: "MAX_BUFFER",
			// Node discards what it read, so this is the only advice the caller gets: the command worked.
			message: `the command produced more than maxBuffer (${String(maxBufferBytes)} bytes); raise the limit instead of retrying`,
			...base,
		};
	}
	if (e.code === "ENOENT") {
		return {
			ok: false,
			code: "NOT_FOUND",
			message: "the command could not be started (not on PATH, or the working directory is gone)",
			...base,
		};
	}
	return {
		ok: false,
		code: "EXIT",
		message: stderr ?? `the command exited with code ${String(e.code ?? "unknown")}`,
		exitCode: typeof e.code === "number" ? e.code : null,
		...base,
	};
}

/** `ok` is on the raw result too: without it `{ stdout } | ExecFailure` cannot be narrowed by a check. */
type RawResult = { ok: true; stdout: string } | ExecFailure;

async function runRaw(cmd: string, args: string[], options: ExecOptions): Promise<RawResult> {
	try {
		const res = await execFileAsync(cmd, args, {
			cwd: options.cwd ?? process.cwd(),
			timeout: options.timeoutMs ?? READ_TIMEOUT_MS,
			maxBuffer: options.maxBuffer ?? MAX_OUTPUT_BYTES,
			env: options.env ? { ...process.env, ...options.env } : process.env,
		});
		return { ok: true, stdout: res.stdout };
	} catch (err) {
		const maxBuffer = options.maxBuffer ?? MAX_OUTPUT_BYTES;
		// A non-zero exit is not exceptional here, it is the answer: everything below this line turns it
		// into a coded failure instead of a throw, so no caller has to write the same try/catch (and
		// every caller that forgot one used to lose the reason).
		return classify(err, maxBuffer);
	}
}

/** Run a command and hand back its stdout. Failures are reported, never returned as empty text. */
export async function runText(cmd: string, args: string[], options: TextOptions = {}): Promise<ExecResult<string>> {
	const raw = await runRaw(cmd, args, options);
	if (!raw.ok) return raw;
	return { ok: true, data: options.trim === false ? raw.stdout : raw.stdout.trim() };
}

/**
 * Run a command and parse its stdout as JSON.
 *
 * `BAD_JSON` keeps the #36 semantics: unparseable output is a failure, because answering "no
 * workers" for a CLI that crashed is how a coordinator double-dispatches. With a `schema`, a payload
 * in the wrong shape is `BAD_SCHEMA` naming up to five paths (`/workers/0/id: must be string`) and
 * **not** the payload - command output can carry tokens, and these messages reach tool results.
 */
export async function runJson<T>(cmd: string, args: string[], options: JsonOptions = {}): Promise<ExecResult<T>> {
	const raw = await runRaw(cmd, args, options);
	if (raw.ok) {
		const parsed = parseBody<T>(raw.stdout, options.schema);
		return parsed.ok ? { ok: true, data: parsed.data } : parsed.failure;
	}
	// An exit the CLI still gave a JSON answer to: the envelope's own `ok` is the verdict, not the code.
	if (options.acceptJsonOnFailure && raw.stdout) {
		const parsed = parseBody<T>(raw.stdout, options.schema);
		if (parsed.ok) return { ok: true, data: parsed.data };
	}
	return raw;
}

function parseBody<T>(stdout: string, schema?: TSchema): { ok: true; data: T } | { ok: false; failure: ExecFailure } {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch (err) {
		return {
			ok: false,
			failure: {
				ok: false,
				code: "BAD_JSON",
				// The code carries the category, so the message is the parser's own reason verbatim: a caller
				// that prefixes it ("Orca CLI returned output that is not JSON: ...") should not have to
				// strip a duplicate out of it.
				message: err instanceof Error ? err.message : String(err),
				stdout: excerpt(stdout),
				cause: err,
			},
		};
	}
	if (schema && !Check(schema, value)) {
		const lines: string[] = [];
		let extra = 0;
		for (const issue of Errors(schema, value)) {
			if (lines.length < MAX_SCHEMA_ERRORS) lines.push(`${issue.instancePath || "/"}: ${issue.message}`);
			else extra++;
		}
		return {
			ok: false,
			failure: {
				ok: false,
				code: "BAD_SCHEMA",
				// Paths and messages only. The payload is deliberately absent: see the doc above.
				message: `output does not match the expected shape (${lines.join("; ")}${extra ? `; and ${extra} more` : ""})`,
			},
		};
	}
	return { ok: true, data: value as T };
}

// ---------------------------------------------------------------- the session door

type SpawnOptions = NonNullable<Parameters<typeof spawn>[2]>;

export interface LongLivedOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	/**
	 * Silence with **no** tool call open that counts as a stall. Measured ceiling: 37.1 s over 191
	 * completed turns (p99 14.2 s), so 90 s is ~2.4x the worst healthy pause and will not fire on a
	 * thinking agent.
	 */
	idleNoToolMs: number;
	/**
	 * Silence while at least one tool call is open. A running build is not a stalled agent: observed
	 * tool durations reach 1 335 s (p99.9 748 s), so the allowance is 30 minutes.
	 */
	idleWithToolMs: number;
	/**
	 * A stall is a **notice**, never a kill. Only `onExit` ends a session: an agent that has gone quiet
	 * still has state worth reading (`devin_status`) and work the user may want finished, and a
	 * watchdog that kills has turned a slow turn into a lost delegation.
	 */
	onStall?: (info: { silentMs: number; openTools: string[] }) => void;
	/** Newline-delimited stdout, which is what an ACP/JSON-RPC child speaks. */
	onLine?: (line: string) => void;
	onStderr?: (chunk: string) => void;
	onExit?: (info: { code: number | null; signal: string | null }) => void;
}

export interface LongLivedHandle {
	child: ChildProcess;
	/**
	 * Open tool calls, by id. A **set**, not a counter or a flag: Devin runs tools concurrently, and a
	 * flag cleared by the first completion re-arms the short threshold while two builds are still
	 * running. (That misclassification produced a fictitious 297 s "thinking" gap while measuring D7.)
	 */
	toolOpen(id: string): void;
	toolClosed(id: string): void;
	openToolIds(): string[];
	/** Any sign of life. Called for every line received, and by the caller for anything else it sees. */
	touch(): void;
	silentMs(): number;
	/** Tear the child down. The only thing that ends a session besides its own exit. */
	stop(): void;
}

/**
 * Start a long-lived child and watch its silence with two thresholds.
 *
 * There is deliberately no `timeout` here: the wall clock is the wrong instrument for a session, and
 * `execTimeout` accepts `idleNoToolMs` as the guard instead (with a fixture in
 * `test/quality-gate-fixtures.sh`, because an exemption with no failing fixture is an exemption that
 * measures nothing).
 */
export function spawnLongLived(cmd: string, args: string[], options: LongLivedOptions): LongLivedHandle {
	// `idleNoToolMs` is not a Node option and is ignored by it. It is carried into the call so that
	// `execTimeout` can see this child is guarded by a liveness rule instead of by nothing - the gate
	// reads the call, and an exemption that lives in a comment is an exemption nobody enforces.
	const child = spawn(cmd, args, {
		cwd: options.cwd ?? process.cwd(),
		env: options.env ? { ...process.env, ...options.env } : process.env,
		stdio: ["pipe", "pipe", "pipe"],
		idleNoToolMs: options.idleNoToolMs,
	} as SpawnOptions);

	const open = new Set<string>();
	let lastActivity = Date.now();
	let reported = false;
	// Declared before the listeners that clear it, so a child that errors on its way up cannot reach
	// past the declaration.
	let timer: ReturnType<typeof setInterval> | undefined;

	// ACP is line-oriented; a chunk can hold several messages or half of one.
	let carry = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		lastActivity = Date.now();
		reported = false;
		carry += chunk;
		let nl = carry.indexOf("\n");
		while (nl >= 0) {
			const line = carry.slice(0, nl).trim();
			carry = carry.slice(nl + 1);
			if (line) options.onLine?.(line);
			nl = carry.indexOf("\n");
		}
	});
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		lastActivity = Date.now();
		reported = false;
		options.onStderr?.(chunk);
	});
	child.on("error", (err) => {
		clearInterval(timer);
		options.onStderr?.(err instanceof Error ? err.message : String(err));
	});
	child.on("exit", (code, signal) => {
		if (timer) clearInterval(timer);
		options.onExit?.({ code, signal });
	});

	const limit = () => (open.size > 0 ? options.idleWithToolMs : options.idleNoToolMs);
	timer = setInterval(
		() => {
			const silentMs = Date.now() - lastActivity;
			if (silentMs < limit()) {
				reported = false;
				return;
			}
			if (reported) return;
			reported = true;
			options.onStall?.({ silentMs, openTools: [...open] });
		},
		Math.max(250, Math.floor(Math.min(options.idleNoToolMs, options.idleWithToolMs) / 4)),
	);
	// The child owns the process's life; a watchdog must not keep a session alive on its own.
	timer.unref();

	return {
		child,
		toolOpen: (id) => {
			open.add(id);
			lastActivity = Date.now();
			reported = false;
		},
		toolClosed: (id) => {
			open.delete(id);
			lastActivity = Date.now();
			reported = false;
		},
		openToolIds: () => [...open],
		touch: () => {
			lastActivity = Date.now();
			reported = false;
		},
		silentMs: () => Date.now() - lastActivity,
		stop: () => {
			clearInterval(timer);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		},
	};
}
