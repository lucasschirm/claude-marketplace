/**
 * Detects shell commands that invoke a delegated agent's own CLI, so the delegate extension can block
 * them and steer the agent to the `delegate_*` tools instead.
 *
 * Which binaries are guarded is data, not a regex in this file: it is the `cli` of every driver whose
 * `capabilities().blocksOwnCli` is true, plus that driver's `extraClis`. Today that is Devin (`devin`)
 * and Antigravity (`agy` and the `agy-acp` adapter that starts the same work); `claude` is deliberately
 * absent — it is the operator's own CLI (pi itself may be driving it), so blocking it would break the
 * host to protect a queue. See `drivers/devin.ts` before adding a name.
 *
 * Static analysis of a command string cannot be complete. It covers direct calls, pipelines and
 * lists, `$(...)`/backtick substitutions, `bash -c`/`eval` strings, wrapper commands (`sudo`,
 * `env`, `timeout`, `xargs`, ...) and `find -exec`. It does not see through variable expansion
 * (`$CMD -p x`), scripts run from a file, or heredocs fed to a shell.
 */

const MAX_DEPTH = 8;

const WRAPPERS = new Set([
	"sudo",
	"doas",
	"env",
	"command",
	"builtin",
	"exec",
	"nohup",
	"time",
	"nice",
	"ionice",
	"timeout",
	"stdbuf",
	"setsid",
	"xargs",
	"watch",
	"unbuffer",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until", "fi", "done"]);
const EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-x", "-X", "--exec", "--exec-batch"]);
const HELP_FLAGS = new Set(["--help", "-h", "--version", "-V"]);
// Flags that make a guarded CLI do real work even when a help flag is also present. The headless shapes
// are here because that is how an agent would route around the queue in one line: `agy -p` with the
// stream formats runs a whole session to completion, and `--conversation` continues one, neither of
// which a queue entry, a slot or a status line will ever mention.
const WORK_FLAGS = new Set(
	"-p --print --prompt-file -c --continue -r --resume --conversation --input-format --output-format --add-dir --dangerously-skip-permissions --".split(
		" ",
	),
);

/** A work flag in either shape a shell accepts. Matching only the bare token let `agy --help -p=x` through
 *  while `agy --help -p x` was blocked: one invocation, decided by a character, which is not a distinction
 *  a guard gets to make. */
function isWorkFlag(arg: string): boolean {
	if (WORK_FLAGS.has(arg)) {
		return true;
	}
	const eq = arg.indexOf("=");
	return eq > 0 && arg.startsWith("-") && WORK_FLAGS.has(arg.slice(0, eq));
}
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT_WORD = /^(?:\d*|&)(?:>>?|<<<?|<|>&|<&|>\|)/;
const REDIRECT_ONLY = /^(?:\d*|&)(?:>>?|<<<?|<|>&|<&|>\|)$/;

function basename(word: string): string {
	const last = word.split(/[\\/]/).pop() ?? word;
	return last.replace(/\.(?:exe|cmd|bat)$/i, "");
}

/** Index of the paren/backtick that closes the substitution opened just before `start`. */
function findClosing(input: string, start: number, open: string, close: string): number {
	let depth = 1;
	for (let i = start; i < input.length; i++) {
		const c = input[i];
		if (c === "\\") {
			i++;
		} else if (c === "'" && open === "(") {
			const end = input.indexOf("'", i + 1);
			if (end === -1) {
				return input.length;
			}
			i = end;
		} else if (c === '"' && open === "(") {
			for (i++; i < input.length && input[i] !== '"'; i++) {
				if (input[i] === "\\") {
					i++;
				}
			}
		} else if (open === "(" && c === open) {
			depth++;
		} else if (c === close) {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return input.length;
}

/** Splits a shell string into simple commands (lists of words), recursing into substitutions. */
function parseCommands(input: string, out: string[][], depth: number, guarded: readonly string[]): void {
	if (depth > MAX_DEPTH) {
		// Too deeply nested to analyze: fail closed, under a name the guard is actually watching.
		out.push([guarded[0] ?? "agent", "<nested-too-deeply>"]);
		return;
	}

	let words: string[] = [];
	let cur = "";
	let inWord = false;
	const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];

	const flushWord = () => {
		if (inWord) {
			words.push(cur);
		}
		cur = "";
		inWord = false;
	};
	const flushCommand = () => {
		flushWord();
		if (words.length) {
			out.push(words);
		}
		words = [];
	};
	const substitution = (open: string, close: string, from: number): number => {
		const end = findClosing(input, from, open, close);
		parseCommands(input.slice(from, end), out, depth + 1, guarded);
		cur += "$(…)";
		inWord = true;
		return end;
	};

	for (let i = 0; i < input.length; i++) {
		const c = input[i];

		if (c === "\\") {
			if (input[i + 1] === "\n") {
				i++;
			} else if (i + 1 < input.length) {
				cur += input[++i];
				inWord = true;
			}
		} else if (c === "'") {
			const end = input.indexOf("'", i + 1);
			const stop = end === -1 ? input.length : end;
			cur += input.slice(i + 1, stop);
			inWord = true;
			i = stop;
		} else if (c === '"') {
			inWord = true;
			for (i++; i < input.length && input[i] !== '"'; i++) {
				if (input[i] === "\\" && i + 1 < input.length) {
					cur += input[++i];
				} else if (input[i] === "$" && input[i + 1] === "(") {
					i = substitution("(", ")", i + 2);
				} else if (input[i] === "`") {
					i = substitution("`", "`", i + 1);
				} else {
					cur += input[i];
				}
			}
		} else if (c === "$" && input[i + 1] === "(") {
			i = substitution("(", ")", i + 2);
		} else if (c === "`") {
			i = substitution("`", "`", i + 1);
		} else if (c === "#" && !inWord) {
			while (i + 1 < input.length && input[i + 1] !== "\n") {
				i++;
			}
		} else if (c === "\n") {
			flushCommand();
			// Skip heredoc bodies: they are text, not commands.
			for (const heredoc of heredocs.splice(0)) {
				for (i++; i < input.length; ) {
					const eol = input.indexOf("\n", i);
					const line = input.slice(i, eol === -1 ? input.length : eol);
					i = eol === -1 ? input.length : eol + 1;
					if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) {
						break;
					}
				}
				i--;
			}
		} else if (c === ";" || c === "|" || c === "(" || c === ")") {
			flushCommand();
		} else if (c === "&") {
			// `2>&1`, `>&2` and `&>file` are redirections, not command separators.
			if (/[<>]$/.test(cur) || input[i + 1] === ">") {
				cur += c;
				inWord = true;
			} else {
				flushCommand();
			}
		} else if (c === " " || c === "\t") {
			flushWord();
		} else if (c === "<" && input[i + 1] === "<" && input[i + 2] !== "<" && input[i - 1] !== "<") {
			const match = /^<<(-?)[ \t]*(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>]+))/.exec(input.slice(i));
			if (match) {
				heredocs.push({ delimiter: match[2] ?? match[3] ?? match[4] ?? "", stripTabs: match[1] === "-" });
				flushWord();
				i += match[0].length - 1;
			} else {
				cur += c;
				inWord = true;
			}
		} else {
			cur += c;
			inWord = true;
		}
	}
	flushCommand();
}

function stripRedirections(words: string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < words.length; i++) {
		if (REDIRECT_ONLY.test(words[i])) {
			i++; // the redirection target
		} else if (!REDIRECT_WORD.test(words[i])) {
			kept.push(words[i]);
		}
	}
	return kept;
}

/**
 * The read-only verbs, per guarded binary: the invocations that ask a question instead of starting work.
 *
 * Which subcommand means "just asking" is a fact about one CLI, not a fact about all of them: `agy models`
 * is the listing (the same probe `agy-acp` runs once per process), while Devin's is `models list` and a
 * bare `devin models` is a usage error this guard has always blocked. One shared list would have to either
 * allow the first or excuse the second, and "one agent's read-only verb widens another's" is the mistake
 * the data-driven shape of this file exists to avoid.
 *
 * A binary with no entry has no read-only verb beyond `--help`/`--version`, so a new driver fails closed.
 * `test-delegate-cli-guard.ts` asks for a deliberate entry for every guarded name.
 */
const READ_ONLY_VERBS: Record<string, readonly (readonly string[])[]> = {
	devin: [["models", "list"], ["auth", "status"], ["list"], ["ls"], ["version"], ["help"]],
	agy: [["models"], ["auth", "status"]],
	// The adapter takes no verbs: `agy-acp --version` is the whole read-only surface, and every other
	// invocation starts a server that runs agent work no queue entry mentions.
	"agy-acp": [],
};

/** One binary's declared exceptions — exported so a test can insist the table was thought about. */
export function readOnlyVerbsFor(binary: string): readonly (readonly string[])[] {
	return READ_ONLY_VERBS[binary] ?? [];
}

/**
 * True for the read-only invocations that stay allowed: a version/help probe or a listing that starts
 * nothing. The point of the guard is to stop work being routed around the queue, not to stop people asking
 * what is installed.
 */
function isReadOnlyInvocation(binary: string, args: string[]): boolean {
	if (args.some((a) => HELP_FLAGS.has(a))) {
		return !args.some(isWorkFlag);
	}
	const onlyFlags = (rest: string[]) => rest.every((a) => a.startsWith("-"));
	return readOnlyVerbsFor(binary).some(
		(verb) => verb.length <= args.length && verb.every((word, i) => args[i] === word) && onlyFlags(args.slice(verb.length)),
	);
}

/** Returns the offending command text if `words` invokes a guarded CLI in a way that is not read-only. */
function checkCommand(rawWords: string[], depth: number, guarded: ReadonlySet<string>): string | undefined {
	if (depth > MAX_DEPTH) {
		return rawWords.join(" ");
	}
	const words = stripRedirections(rawWords);

	let i = 0;
	while (i < words.length && (ASSIGNMENT.test(words[i]) || RESERVED.has(words[i]))) {
		i++;
	}
	if (i >= words.length) {
		return undefined;
	}

	const base = basename(words[i]);

	if (guarded.has(base)) {
		return isReadOnlyInvocation(base, words.slice(i + 1)) ? undefined : words.slice(i).join(" ");
	}

	if (WRAPPERS.has(base)) {
		// `command -v devin` only looks the binary up; it starts nothing.
		if (base === "command" && words.slice(i + 1).some((w) => w === "-v" || w === "-V")) {
			return undefined;
		}
		// Wrapper options take arguments (`timeout 10`, `sudo -u x`), so try every later word as a command start.
		for (let j = i + 1; j < words.length; j++) {
			const hit = checkCommand(words.slice(j), depth + 1, guarded);
			if (hit) {
				return hit;
			}
		}
		return undefined;
	}

	if (SHELLS.has(base)) {
		const flag = words.findIndex((w, k) => k > i && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
		if (flag !== -1 && words[flag + 1] !== undefined) {
			return findBlocked(words[flag + 1], depth + 1, guarded);
		}
		return undefined;
	}

	if (base === "eval") {
		return findBlocked(words.slice(i + 1).join(" "), depth + 1, guarded);
	}

	if (base === "find" || base === "fd") {
		for (let j = i + 1; j < words.length; j++) {
			if (EXEC_FLAGS.has(words[j])) {
				const hit = checkCommand(words.slice(j + 1), depth + 1, guarded);
				if (hit) {
					return hit;
				}
			}
		}
	}

	return undefined;
}

function findBlocked(command: string, depth: number, guarded: ReadonlySet<string>): string | undefined {
	const commands: string[][] = [];
	parseCommands(command, commands, depth, [...guarded]);
	for (const words of commands) {
		const hit = checkCommand(words, depth, guarded);
		if (hit) {
			return hit;
		}
	}
	return undefined;
}

/**
 * Returns the offending command if `command` runs one of `guarded` (the CLI names of drivers with
 * `blocksOwnCli`) in any way other than that binary's read-only subcommands: `--help`/`--version` for every
 * one of them, plus the verbs declared in `READ_ONLY_VERBS`.
 */
export function findBlockedCliCommand(command: string, guarded: readonly string[]): string | undefined {
	if (guarded.length === 0) {
		return undefined;
	}
	return findBlocked(command, 0, new Set(guarded));
}

/** The block message names the binaries actually blocked, so it cannot promise a tool the agent has no driver for. */
export function cliBlockReason(guarded: readonly string[]): string {
	const names = guarded.map((g) => `\`${g}\``).join(" or ");
	return (
		`Running ${names} from a shell is blocked in this session. Delegate with the \`delegate_task\` tool ` +
		"(then `delegate_status`, `delegate_message`, `delegate_cancel`, `delegate_restart`) so the work is queued, " +
		"tracked and reported back to you. Read-only commands such as `--help`, `--version`, `models`, " +
		"`models list` and `list` are still allowed. If the user really wants a direct CLI run, they can lift the block with " +
		"`/delegate allow-bash`."
	);
}
