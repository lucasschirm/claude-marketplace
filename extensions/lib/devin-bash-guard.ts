/**
 * Detects shell commands that invoke the `devin` CLI, so the Devin Delegate extension can block
 * them and steer the agent to the `devin_*` tools instead.
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
// Flags that make `devin` do real work even when a help flag is also present.
const WORK_FLAGS = new Set(["-p", "--print", "--prompt-file", "-c", "--continue", "-r", "--resume", "--"]);
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
			if (end === -1) return input.length;
			i = end;
		} else if (c === '"' && open === "(") {
			for (i++; i < input.length && input[i] !== '"'; i++) {
				if (input[i] === "\\") i++;
			}
		} else if (open === "(" && c === open) {
			depth++;
		} else if (c === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return input.length;
}

/** Splits a shell string into simple commands (lists of words), recursing into substitutions. */
function parseCommands(input: string, out: string[][], depth: number): void {
	if (depth > MAX_DEPTH) {
		// Too deeply nested to analyze: fail closed.
		out.push(["devin", "<nested-too-deeply>"]);
		return;
	}

	let words: string[] = [];
	let cur = "";
	let inWord = false;
	const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];

	const flushWord = () => {
		if (inWord) words.push(cur);
		cur = "";
		inWord = false;
	};
	const flushCommand = () => {
		flushWord();
		if (words.length) out.push(words);
		words = [];
	};
	const substitution = (open: string, close: string, from: number): number => {
		const end = findClosing(input, from, open, close);
		parseCommands(input.slice(from, end), out, depth + 1);
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
			while (i + 1 < input.length && input[i + 1] !== "\n") i++;
		} else if (c === "\n") {
			flushCommand();
			// Skip heredoc bodies: they are text, not commands.
			for (const heredoc of heredocs.splice(0)) {
				for (i++; i < input.length; ) {
					const eol = input.indexOf("\n", i);
					const line = input.slice(i, eol === -1 ? input.length : eol);
					i = eol === -1 ? input.length : eol + 1;
					if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
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

/** True for the read-only `devin` invocations that stay allowed. */
function isReadOnlyDevin(args: string[]): boolean {
	if (args.some((a) => HELP_FLAGS.has(a))) {
		return !args.some((a) => WORK_FLAGS.has(a));
	}
	const [sub, sub2] = args;
	const onlyFlags = (rest: string[]) => rest.every((a) => a.startsWith("-"));
	if (sub === "models") return sub2 === "list" && onlyFlags(args.slice(2));
	if (sub === "list" || sub === "ls") return onlyFlags(args.slice(1));
	if (sub === "version" || sub === "help") return true;
	return false;
}

/** Returns the offending command text if `words` invokes a disallowed `devin`. */
function checkCommand(rawWords: string[], depth: number): string | undefined {
	if (depth > MAX_DEPTH) return rawWords.join(" ");
	const words = stripRedirections(rawWords);

	let i = 0;
	while (i < words.length && (ASSIGNMENT.test(words[i]) || RESERVED.has(words[i]))) i++;
	if (i >= words.length) return undefined;

	const base = basename(words[i]);

	if (base === "devin") {
		return isReadOnlyDevin(words.slice(i + 1)) ? undefined : words.slice(i).join(" ");
	}

	if (WRAPPERS.has(base)) {
		// `command -v devin` only looks the binary up.
		if (base === "command" && words.slice(i + 1).some((w) => w === "-v" || w === "-V")) return undefined;
		// Wrapper options take arguments (`timeout 10`, `sudo -u x`), so try every later word as a command start.
		for (let j = i + 1; j < words.length; j++) {
			const hit = checkCommand(words.slice(j), depth + 1);
			if (hit) return hit;
		}
		return undefined;
	}

	if (SHELLS.has(base)) {
		const flag = words.findIndex((w, k) => k > i && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
		if (flag !== -1 && words[flag + 1] !== undefined) {
			return findBlocked(words[flag + 1], depth + 1);
		}
		return undefined;
	}

	if (base === "eval") {
		return findBlocked(words.slice(i + 1).join(" "), depth + 1);
	}

	if (base === "find" || base === "fd") {
		for (let j = i + 1; j < words.length; j++) {
			if (EXEC_FLAGS.has(words[j])) {
				const hit = checkCommand(words.slice(j + 1), depth + 1);
				if (hit) return hit;
			}
		}
	}

	return undefined;
}

function findBlocked(command: string, depth: number): string | undefined {
	const commands: string[][] = [];
	parseCommands(command, commands, depth);
	for (const words of commands) {
		const hit = checkCommand(words, depth);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * Returns the offending command if `command` runs the `devin` CLI in a way other than the
 * read-only subcommands (`models list`, `list`/`ls`, `version`, `help`, `--help`, `--version`).
 */
export function findBlockedDevinCommand(command: string): string | undefined {
	return findBlocked(command, 0);
}

export const DEVIN_BASH_BLOCK_REASON =
	"Running the `devin` CLI from a shell is blocked in this session. Delegate with the `devin_delegate` tool " +
	"(then `devin_status`, `devin_message`, `devin_cancel`, `devin_restart`) so the work is queued, tracked and " +
	"reported back to you. Read-only commands such as `devin models list`, `devin ls`, `devin version` and " +
	"`devin --help` are still allowed. If the user really wants a direct CLI run, they can lift the block with `/devin allow_bash`.";
