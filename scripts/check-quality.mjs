#!/usr/bin/env node
/**
 * Repo-specific quality invariants that a general-purpose linter cannot express, plus a ratchet for the
 * legacy debt biome reports but cannot gate on yet.
 *
 *   node scripts/check-quality.mjs                 # same as --check
 *   node scripts/check-quality.mjs --check         # CI: fail if anything got worse
 *   node scripts/check-quality.mjs --write         # record improvements back into the baseline
 *   node scripts/check-quality.mjs --write --reason "why a threshold went up"
 *   node scripts/check-quality.mjs --list          # invariant names
 *   node scripts/check-quality.mjs --only <name>   # run one invariant
 *   node scripts/check-quality.mjs --full          # list every violating site, not the first 8
 *
 * Ratchet semantics (the part that decides whether this survives a deadline):
 *   - every metric may stay equal or shrink;
 *   - `--write` without `--reason` only ever lowers numbers, so a good-faith cleanup cannot be undone
 *     by a later stale baseline;
 *   - an increase fails `--check`, and the only way to record it is `--write --reason "..."`, which
 *     appends a visible line to `notes` in the baseline. Widening the gate is therefore always an
 *     attributable line in the diff, never a silent edit.
 *
 * Nothing here may depend on a package that is not a devDependency, and `--only wiredTests` must run
 * with no node_modules at all (test/run.sh calls it before anything is installed).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "scripts", "quality-baseline.json");

// ---------------------------------------------------------------- file collection

function listTs(dir) {
	const out = [];
	const walk = (d) => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (entry.isFile() && /\.(ts|mjs)$/.test(entry.name)) out.push(p);
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return out.sort();
}

const extensionFiles = () => listTs(path.join(ROOT, "extensions"));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function linesOf(file) {
	return fs.readFileSync(file, "utf-8").split("\n");
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/** Skip a string/template literal that starts at `i`; returns the index of its closing quote. */
function skipLiteral(src, i) {
	const quote = src[i];
	for (let j = i + 1; j < src.length; j++) {
		if (src[j] === "\\") {
			j++;
			continue;
		}
		if (src[j] === quote) return j;
		// An apostrophe in a comment must not swallow the file: a quote cannot cross a newline.
		if (quote !== "`" && src[j] === "\n") return j;
	}
	return src.length;
}

/** Whether `index` sits in a line comment or after a block-comment gutter (a mentioned API is not a call). */
/** Whether the `/` at `i` opens a regex literal rather than a division, judged from the previous code char. */
function startsRegex(prev) {
	return prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev);
}

/** End index of a regex literal starting at `i`; stops at the line end if it never closes. */
function skipRegex(line, i) {
	let inClass = false;
	for (let j = i + 1; j < line.length; j++) {
		const c = line[j];
		if (c === "\\") {
			j++;
			continue;
		}
		if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) return j;
	}
	return line.length;
}

/**
 * If `src[i]` opens a literal or comment, the index of its last character; otherwise -1. Regex literals
 * matter: `{env:{P:/[(]/}}` would otherwise read as unbalanced brackets, corrupting the depth count and
 * letting one call reach into the next one's text.
 */
function skipCompound(src, i, prev) {
	const c = src[i];
	if (c === '"' || c === "'" || c === "`") return skipLiteral(src, i);
	if (c === "/" && src[i + 1] === "/") {
		const eol = src.indexOf("\n", i);
		return eol < 0 ? src.length : eol;
	}
	if (c === "/" && src[i + 1] === "*") {
		const end = src.indexOf("*/", i);
		return end < 0 ? src.length : end + 1;
	}
	if (c === "/" && startsRegex(prev)) return skipRegex(src, i);
	return -1;
}

/**
 * Whether `index` in `src` is real code, decided by scanning its line with the same literal-aware rules.
 * Testing raw text for `//` made `const u = "https://x"` look like a comment starting before the call, which
 * hid every call site after the URL; the opposite error counted `execFileAsync(...)` written inside a
 * comment or a string literal as a real site.
 */
/** Whether the name at `index` is being declared rather than called (`declare function execAsync(...)`). */
function isDeclaration(src, index) {
	const lineStart = src.lastIndexOf("\n", index - 1) + 1;
	return /\b(?:function|class|declare)\s+$/.test(src.slice(lineStart, index));
}

function isRealCode(src, index) {
	const lineStart = src.lastIndexOf("\n", index - 1) + 1;
	let lineEnd = src.indexOf("\n", lineStart);
	if (lineEnd < 0) lineEnd = src.length;
	const line = src.slice(lineStart, lineEnd);
	let prev = "";
	for (let i = 0; i < line.length; i++) {
		if (lineStart + i >= index) return true;
		const jump = skipCompound(line, i, prev);
		if (jump >= i) {
			if (lineStart + jump >= index) return false;
			i = jump;
			prev = line[jump] ?? prev;
			continue;
		}
		if (!/\s/.test(line[i])) prev = line[i];
	}
	return true;
}

/**
 * The source of the call whose callee name starts at `nameIndex`: from its "(" through the matching ")",
 * with literals and comments skipped so a bracket inside a string cannot end the scan.
 *
 * This exists because a flat line window was demonstrably wrong in both directions: two adjacent calls
 * masked each other (the second call's `timeout:` landed inside the first call's window), and an unrelated
 * mutating verb a few lines below false-flagged a benign call.
 */
function callTextAt(src, nameIndex) {
	const open = src.indexOf("(", nameIndex);
	if (open < 0) return "";
	let depth = 0;
	let prev = "";
	for (let j = open; j < src.length; j++) {
		const jump = skipCompound(src, j, prev);
		if (jump >= j) {
			j = jump;
			prev = src[j] ?? prev;
			continue;
		}
		const c = src[j];
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			depth--;
			if (depth === 0) return src.slice(open, j + 1);
		}
		if (!/\s/.test(c)) prev = c;
	}
	return "";
}

/** The argument strings of a call, in order, lowercased: ["worker", "stop", "--dispatch", "x"]. */
function callArgs(call) {
	const out = [];
	for (let i = 0; i < call.length; i++) {
		const c = call[i];
		if (c !== '"' && c !== "'" && c !== "`") continue;
		const end = skipLiteral(call, i);
		out.push(call.slice(i + 1, end).toLowerCase());
		i = end;
	}
	return out;
}

/**
 * The last code character of a line, with literals skipped and anything from a comment onward ignored:
 * `foo(); // note` ends in `;`. Reading the raw text instead made every line after a trailing comment look
 * like a continuation, so a `const x =` four lines up appeared to bind an unrelated call.
 */
function codeTail(line) {
	const code = codeOnly(line).trimEnd();
	return code === "" ? "" : code.slice(-1);
}

/** Text preceding the callee inside its own statement (binding, `return`, a condition). */
function beforeInStatement(src, nameIndex) {
	const lineStart = src.lastIndexOf("\n", nameIndex - 1) + 1;
	let start = lineStart;
	// Pull in the lines above that continue this statement (a call split across lines after `const x =`).
	while (start > 0) {
		const prevEnd = src.lastIndexOf("\n", start - 2) + 1;
		const tail = codeTail(src.slice(prevEnd, start - 1));
		// A blank or comment-only line is not a boundary: `const res =` / note / `await ...` is one statement,
		// and stopping there reported a bound call as an unchecked mutation.
		if (tail === "") {
			start = prevEnd;
			continue;
		}
		if (tail === ";" || tail === "{" || tail === "}") break;
		start = prevEnd;
	}
	return src.slice(start, nameIndex);
}

/** A line with literals preserved and comments removed (prose must not satisfy a "the result is checked"
 * heuristic, and a comment must not end the scan). */
function codeOnly(line) {
	let out = "";
	let prev = "";
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) break;
		const jump = skipCompound(line, i, prev);
		if (jump >= i) {
			out += line.slice(i, jump + 1);
			i = jump;
			prev = line[jump] ?? prev;
			continue;
		}
		out += c;
		if (!/\s/.test(c)) prev = c;
	}
	return out;
}

/**
 * Text following the call inside its own statement: a `.then(...)`, `.ok`, `&&` chain that continues on
 * following lines. Continuation means the next line *starts* with an operator — a later, unrelated line
 * that merely contains `.then(` is a different statement, and treating it as this one's chain hid an
 * unchecked `spawnSync("git", ["push"])` sitting two lines above a chained call.
 */
function afterInStatement(src, callEnd) {
	const pieces = [];
	let end = src.indexOf("\n", callEnd);
	pieces.push(src.slice(callEnd, end < 0 ? src.length : end));
	if (end < 0) end = src.length;
	for (;;) {
		const nextEnd = src.indexOf("\n", end + 1);
		const next = src.slice(end + 1, nextEnd < 0 ? src.length : nextEnd).trim();
		if (!/^(\.|&&|\|\||\?|:)/.test(next)) break;
		pieces.push(next);
		if (nextEnd < 0) break;
		end = nextEnd;
	}
	return pieces.map(codeOnly).join("\n");
}

// ---------------------------------------------------------------- biome metrics

/** Counts of biome diagnostics per rule over extensions/, or null when biome is unavailable. */
/**
 * Turns a biome run into per-rule counts over `extensions/`.
 *
 * Returns null when biome did not run at all, `{ runFailed, detail }` when it ran but its output must not be
 * trusted as a measurement, and `{ counts, shapeOk }` otherwise. Everything here fails closed, because every
 * way this function can read "less debt" than there is turns into a lowered baseline: an exit status that says
 * the run broke (an unknown rule name in biome.jsonc), diagnostics belonging to some other tree (a stub, a
 * changed cwd, a path filter), or records whose file or rule we cannot read.
 */
function readBiomeDiagnosticJson(res) {
	if (!res || res.error) return null;
	// Checked before the stdout test: a run that died printing nothing is still a failed run, and reporting it
	// as "biome is not runnable" sends the reader to install dependencies when the config is what broke.
	// biome exits 0 when all it found are warnings. A non-zero status means the run itself failed (an unknown
	// rule name in biome.jsonc, an unreadable path), and its output is not a measurement of anything.
	if (typeof res.status === "number" && res.status !== 0) {
		const first =
			String(res.stderr ?? "")
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l !== "") ?? "(no stderr)";
		return { runFailed: true, detail: `biome exited ${res.status} - ${first}` };
	}
	let parsed;
	try {
		parsed = JSON.parse(res.stdout);
	} catch {
		return null;
	}
	// An empty result counts only if the shape is one we recognise: a --reporter=json change would otherwise
	// look like "no debt" and silently ungate the whole biome half of the ratchet.
	const shapeOk = Array.isArray(parsed) || Array.isArray(parsed?.diagnostics);
	const diagnostics = Array.isArray(parsed) ? parsed : shapeOk ? parsed.diagnostics : [];
	const counts = new Map();
	let ruleless = 0;
	let pathless = 0;
	let offTree = 0;
	for (const d of diagnostics) {
		const rule = String(d?.category ?? "").replace(/^lint\//, "");
		if (!rule) {
			ruleless++;
			continue;
		}
		// biome 2.x puts the path at location.path (a string); older reporters nested it as location.path.file.
		const loc = d?.location?.path;
		const file = typeof loc === "string" ? loc : typeof loc?.file === "string" ? loc.file : undefined;
		if (file === undefined || file === "") {
			pathless++;
			continue;
		}
		const abs = path.isAbsolute(file) ? path.normalize(file) : path.resolve(ROOT, file);
		// Only the gated tree counts. Counting files elsewhere reports debt going down while no extension was
		// touched, which is the same quiet pass as a rule being switched off - just with extra steps.
		if (!isUnderExtensions(abs)) {
			offTree++;
			continue;
		}
		counts.set(rule, (counts.get(rule) ?? 0) + 1);
	}
	// The summary is biome's own count of what it found. If it disagrees with the array, the run was capped or
	// truncated, and a count of a partial run is a count that can only go down.
	const summary = typeof parsed?.summary === "object" && parsed.summary !== null ? parsed.summary : undefined;
	if (summary) {
		const notPrinted = Number(summary.diagnosticsNotPrinted ?? 0);
		if (notPrinted > 0) {
			return {
				runFailed: true,
				detail: `biome printed ${diagnostics.length} diagnostics and held back ${notPrinted} - the per-rule counts would be wrong`,
			};
		}
		const reported = Number(summary.errors ?? 0) + Number(summary.warnings ?? 0) + Number(summary.infos ?? 0);
		if (Number.isFinite(reported) && diagnostics.length > 0 && reported !== diagnostics.length) {
			return {
				runFailed: true,
				detail: `biome's summary counts ${reported} diagnostics, the reporter emitted ${diagnostics.length} - the counts are not trustworthy`,
			};
		}
	}
	if (diagnostics.length > 0 && counts.size === 0) {
		const why =
			ruleless === diagnostics.length
				? `${diagnostics.length} diagnostic(s) carried no lint category - the reporter shape is not the one we read`
				: pathless > 0
					? `${pathless} diagnostic(s) carried a rule but no readable file - the reporter shape is not the one we read`
					: `${diagnostics.length} diagnostic(s) reported and none inside extensions/ (${offTree} outside it) - the run measured something other than the gated tree`;
		return { runFailed: true, detail: why };
	}
	return { counts, shapeOk };
}

/** True when `abs` is a file inside the tree the biome metrics are supposed to describe. */
function isUnderExtensions(abs) {
	const rel = path.relative(path.join(ROOT, "extensions"), abs);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Per-rule diagnostic counts over extensions/, plus whether the reporter shape was recognised; null when biome cannot run. */
function biomeRuleCounts() {
	// PI_QA_BIOME points the metric collector at a command other than node_modules/.bin/biome, and is honoured
	// only when PI_QA_FIXTURES=1 (set by test/quality-gate-fixtures.sh), so a stray variable cannot swap out
	// biome in ordinary use or in CI. Even inside the fixtures it cannot buy a quiet pass: empty output is
	// fatal, an unrecognised shape is fatal, and a metric falling to zero must be reasoned - see the zero-drop
	// rule in run().
	const override = process.env.PI_QA_FIXTURES === "1" ? process.env.PI_QA_BIOME?.trim() || process.env.PI_QA_BIOME : undefined;
	if (override) {
		return readBiomeDiagnosticJson(
			spawnSync(override, ["lint", "--reporter=json", "--max-diagnostics=none", "extensions"], {
				cwd: ROOT,
				encoding: "utf-8",
				maxBuffer: 32 * 1024 * 1024,
			}),
		);
	}
	const localBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "biome.cmd" : "biome");
	const cmd = fs.existsSync(localBin) ? localBin : "npx";
	// --max-diagnostics=none: a capped report would understate debt, and undercounting is the failure direction
	// this whole file is built to refuse.
	const args = fs.existsSync(localBin)
		? ["lint", "--reporter=json", "--max-diagnostics=none", "extensions"]
		: ["--no-install", "biome", "lint", "--reporter=json", "--max-diagnostics=none", "extensions"];

	const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
	return readBiomeDiagnosticJson(res);
}

// ---------------------------------------------------------------- source-scanned metrics

// `(?<![.\w$])` keeps a method call out of it: `runRegex.exec(line)` is not a process spawn.
// `(?<![.\w$])` keeps method calls out (`runRegex.exec(line)` is not a spawn); the optional generic admits
// `execOrca<{...}>([...])`, which the codebase really writes - without it those sites are invisible to every
// exec metric. `execAsync` is the conventional promisify(exec) name.
const EXEC_CALL_RE = /(?<![.\w$])(execFileAsync|execFileSync|execFile|execSync|execAsync|exec|spawnSync|spawn)\s*(?:<[^<>()]*>)?\s*\(/g;

/**
 * execFile/exec/spawn sites, split by location and by whether *that call* passes a timeout. The timeout
 * is looked for inside the call's own parentheses: with a line window, `exec(a); exec(b, {timeout: 1})`
 * counted the first call as guarded.
 */
function execSites() {
	const all = [];
	for (const file of extensionFiles()) {
		const src = fs.readFileSync(file, "utf-8");
		for (const m of src.matchAll(EXEC_CALL_RE)) {
			if (!isRealCode(src, m.index) || isDeclaration(src, m.index)) continue;
			const call = callTextAt(src, m.index);
			all.push({
				file: rel(file),
				line: lineOf(src, m.index),
				// A deadline guards a request. A *session* child (`devin acp`) must not be killed by the wall
				// clock, so `spawnLongLived` guards it with a liveness policy instead and `idleNoToolMs` counts
				// as the guard - for `spawn` only, because an execFile call claiming an idle policy would be
				// a request with no deadline at all.
				hasTimeout: /\b(timeout|timeoutMs)\s*:/.test(call) || (m[1] === "spawn" && /\bidleNoToolMs\s*:/.test(call)),
				src,
				nameIndex: m.index,
				call,
			});
		}
	}
	return all;
}

function countEmptyCatches() {
	const hits = [];
	for (const file of extensionFiles()) {
		const src = fs.readFileSync(file, "utf-8");
		for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{([^}]*)\}/g)) {
			// A reason comment satisfies the rule — that is the rule. A lone `;` or comma is not a reason.
			if (!/^[\s;,]*$/.test(m[1])) continue;
			hits.push(`${rel(file)}:${lineOf(src, m.index)}`);
		}
	}
	return { count: hits.length, hits };
}

/**
 * A write (or delete) of a global slot. Reads must not count: `(globalThis as any)[K]` also appears in
 * `if (...)` guards, and counting those would inflate the metric and hide the real ones.
 */
/**
 * A write (or delete) of a global slot. Reads must not count: `(globalThis as any)[K]` also appears in
 * `if (...)` guards, and counting those would inflate the metric and hide the real ones.
 *
 * `Object.assign(globalThis, {...})` and `Reflect.set/deleteProperty(globalThis, ...)` are the natural
 * way a module publishes a batch of slots, so they are writes too; so is every compound assignment and
 * `++`/`--`, which the first version of this detector missed.
 */
const GLOBAL_WRITE_TAIL =
	/globalThis\s*(?:as\s+[^)]{0,20}\)\s*)?(?:\[[^\]]+\]|\.[A-Za-z_$][\w$]*)\s*(?:\?\?=|\|\|=|&&=|\*\*=|\*=|\|=|>>>=|>>=|<<=|&=|\^=|%=|\/=|\+=|-=|=|\+\+|--)(?!=)/;

// An alias hands the shared object to whatever the variable touches, so the declaration is the site worth
// naming: a line-level scan cannot see `g.__X__ = ...`, and without this the alias would be free. Only the
// binding of globalThis itself counts - `const x = globalThis.__SLOT__ ?? new Map()` is a read, which is
// how every current caller uses it. The casts are removed before matching: a lookahead cannot tell "the
// binding ends here" from the ")" of a cast it only partly consumed, which is how a plain read was flagged.
const GLOBAL_ALIAS_HEAD = /\b(?:const|let|var)\s+[\w$]+(?:\s*:\s*[^=;]+)?\s*=\s*globalThis\s*(?:[;,)]|$)/;

function isGlobalThisAlias(line) {
	const stripped = line
		.replace(/\(\s*globalThis\s+as\s+[^)]{1,24}\)/g, "globalThis")
		.replace(/\bglobalThis\s+as\s+[\w\s<>|[\]]{1,24}(?=[;,)=&|])/, "globalThis");
	return GLOBAL_ALIAS_HEAD.test(stripped);
}

function isGlobalThisWrite(line) {
	const idx = line.indexOf("globalThis");
	if (idx < 0) return false;
	if (/\bdelete\s+\(?\s*$/.test(line.slice(0, idx))) return true;
	if (/\bObject\s*\.\s*(?:assign|defineProperty|defineProperties)\s*\(\s*globalThis\b/.test(line)) return true;
	if (/\bReflect\s*\.\s*(?:set|deleteProperty|defineProperty)\s*\(\s*globalThis\b/.test(line)) return true;
	return GLOBAL_WRITE_TAIL.test(line.slice(idx));
}

function countGlobalThisWrites() {
	const hits = [];
	for (const file of extensionFiles()) {
		if (rel(file) === "extensions/lib/cross-extension.ts") continue;
		linesOf(file).forEach((line, i) => {
			if (isGlobalThisWrite(line) || isGlobalThisAlias(line)) hits.push(`${rel(file)}:${i + 1}`);
		});
	}
	return { count: hits.length, hits };
}

/**
 * Where parsing the output of an external command is allowed: the door, and the sibling that knows what
 * its payloads look like. Two files, named exactly - a prefix match would let `exec-anything.ts` parse
 * whatever it liked, which is the hole this invariant exists to keep shut.
 */
const OUTPUT_PARSE_ALLOWLIST = new Set(["extensions/lib/exec.ts", "extensions/lib/exec-payload.ts"]);

function countJsonParseOutsideExecLib() {
	const hits = [];
	for (const file of extensionFiles()) {
		if (OUTPUT_PARSE_ALLOWLIST.has(rel(file))) continue;
		const lines = linesOf(file);
		lines.forEach((line, i) => {
			const trimmed = line.trim();
			if (/^(\/\/|\*|\/\*)/.test(trimmed)) return; // a mention in a comment is not a call
			// Covers `JSON.parse(`, `JSON.parse<T>(`, `JSON.parse (` and the `JSON["parse"](...)` spelling.
			if (/\bJSON\s*(?:\.\s*parse|\[\s*["']parse["']\s*\])\s*(?:<[^<>]*>)?\s*\(/.test(line)) hits.push(`${rel(file)}:${i + 1}`);
		});
	}
	return { count: hits.length, hits };
}

function countStdioWrites() {
	const hits = [];
	for (const file of extensionFiles()) {
		const lines = linesOf(file);
		lines.forEach((line, i) => {
			if (/process\.(stdout|stderr)\.write\s*\(/.test(line)) hits.push(`${rel(file)}:${i + 1}`);
		});
	}
	return { count: hits.length, hits };
}

/**
 * A mutating external call whose result is never read. `execOrca([... "worker-stop" ...])` with no
 * assignment is how `/orchestration stop` came to announce success on a failed call, so the shape
 * itself is the bug. The verb is read from the call's own argument vector, so both `"worker-stop"` and
 * `["worker", "stop"]` count, and a neighbouring line can neither trigger nor hide a hit.
 */
const MUTATING_SEQUENCES = [
	["worker", "stop"],
	["worker", "release"],
	["worker", "dispatch"],
	["worker", "cancel"],
	["run", "stop"],
	["pr", "merge"],
	["pr", "close"],
	["pr", "comment"],
	["pr", "review"],
	["pr", "edit"],
	["pr", "ready"],
	["issue", "close"],
	["issue", "comment"],
	["git", "push"],
	["git", "commit"],
	["push"],
	["commit"],
	["rm"],
	["delete"],
	["remove"],
];

const FUNNEL_CALL_RE =
	/(?<![.\w$])(execFileAsync|execFileSync|execFile|execSync|execAsync|exec|spawnSync|spawn|execOrca|runJson|runText)\s*(?:<[^<>()]*>)?\s*\(/g;

/**
 * Whether the call's argv says "change something".
 *
 * Only the words *before the first flag* are considered: that is where a CLI puts its verb, and it keeps
 * `gh pr comment --body "...delete the stale cache..."` from reading as a delete. Each word is split on
 * `-` and `_`, so both spellings in the tree match: ["worker","stop"] and the single-token "worker-stop"
 * (which the first version of this detector dropped while fixing the flat-window false positives).
 */
function isMutatingCall(call) {
	const args = callArgs(call);
	const end = args.findIndex((arg) => arg.startsWith("-"));
	const words = (end < 0 ? args : args.slice(0, end)).flatMap((arg) => arg.split(/[-_]+/)).filter(Boolean);
	return MUTATING_SEQUENCES.some((seq) =>
		words.some((_, i) => seq.length + i <= words.length && seq.every((token, k) => words[i + k] === token)),
	);
}

/** Whether the result of the call reaches the caller: bound, returned, tested, or chained on. */
function resultReachesCaller(before, after) {
	const left = before.trimEnd();
	if (/\b(?:const|let|var)\s+[\w$\s,{}\[\]:]*=[^=]/.test(before)) return true; // bound to a variable
	if (/^\s*(?:return|throw)\b/.test(before)) return true; // handed to the caller
	if (/[\w$]]\s*=\s*(?:await\s*)?$/.test(left)) return true; // assigned: `res = await ...`
	if (/\b(?:if|while)\s*\($/.test(left)) return true; // tested directly
	if (/(?:&&|\|\||\?\?|\|\||\?)\s*$/.test(left)) return true; // feeds a condition
	// Chained on. `.on`/`.once` count as consuming the handle; a listener that ignores the exit code is still
	// the bug this invariant exists for, but the callback body is out of reach from here.
	if (/\.\s*(?:then|catch|finally|on|once)\s*[(.]/.test(after)) return true;
	if (/\.ok\b|!==|===|\bassert\b|\.error\b/.test(after)) return true; // inspected on the spot
	return false;
}

function countUncheckedMutations() {
	const hits = [];
	for (const file of extensionFiles()) {
		const src = fs.readFileSync(file, "utf-8");
		for (const m of src.matchAll(FUNNEL_CALL_RE)) {
			if (!isRealCode(src, m.index) || isDeclaration(src, m.index)) continue;
			const call = callTextAt(src, m.index);
			if (!call || !isMutatingCall(call)) continue;
			const callEnd = m.index + m[0].length - 1 + call.length;
			if (resultReachesCaller(beforeInStatement(src, m.index), afterInStatement(src, callEnd))) continue;
			hits.push(`${rel(file)}:${lineOf(src, m.index)}`);
		}
	}
	return { count: hits.length, hits };
}

function fileLineBudget() {
	const map = {};
	for (const file of extensionFiles()) {
		map[rel(file)] = linesOf(file).length;
	}
	return map;
}

// ---------------------------------------------------------------- structural invariants

function checkPiExtensionsMatchDisk() {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
	const declared = (pkg?.pi?.extensions ?? []).map((entry) => entry.replace(/^\.\//, ""));
	const onDisk = fs
		.readdirSync(path.join(ROOT, "extensions"))
		.filter((f) => f.endsWith(".ts"))
		.map((f) => `extensions/${f}`);
	const missing = onDisk.filter((f) => !declared.includes(f));
	const stale = declared.filter((f) => !fs.existsSync(path.join(ROOT, f)));
	const hits = [
		...missing.map((f) => `${f} not declared in package.json -> pi.extensions`),
		...stale.map((f) => `${f} declared but absent`),
	];
	return { count: hits.length, hits };
}

/** A lib no entry file imports is dead code - the same class of bug as an unrun test file. */
function checkUnusedLibs() {
	const libDir = path.join(ROOT, "extensions", "lib");
	if (!fs.existsSync(libDir)) return { count: 0, hits: [] };
	const read = (f) => fs.readFileSync(f, "utf-8");
	const libFiles = fs.readdirSync(libDir).filter((f) => f.endsWith(".ts"));
	// Reachability, not textual mention: a lib imported only by another live lib is used.
	const reached = new Set();
	const queue = fs
		.readdirSync(path.join(ROOT, "extensions"))
		.filter((f) => f.endsWith(".ts"))
		.map((f) => path.join(ROOT, "extensions", f));
	while (queue.length > 0) {
		const file = queue.pop();
		if (!fs.existsSync(file)) continue;
		const src = read(file);
		for (const m of src.matchAll(/from\s+["']([^"']+\.ts)["']/g)) {
			// Resolve the specifier the way the runtime does instead of looking for one that spells "lib/".
			// Inside extensions/lib/ the normal spelling is "./sibling.ts", so the text-only match called a
			// lib reached solely through its sibling unreachable - a false accusation against exactly the
			// factored-out helpers this repo is trying to grow, and a rule that cries wolf gets widened.
			const target = path.resolve(path.dirname(file), m[1]);
			const name = path.relative(libDir, target);
			if (!name || name.startsWith("..") || path.isAbsolute(name)) continue;
			if (!libFiles.includes(name) || reached.has(name)) continue;
			reached.add(name);
			queue.push(target);
		}
	}
	const hits = libFiles.filter((f) => !reached.has(f)).map((f) => `extensions/lib/${f} is reachable from no entry file`);
	return { count: hits.length, hits };
}

/** Every test/test-*.ts must be reachable from run.sh or a suite runner, or it silently never runs. */
function checkWiredTests() {
	const testDir = path.join(ROOT, "test");
	const runner = path.join(testDir, "run.sh");
	if (!fs.existsSync(runner) || !fs.existsSync(testDir)) return { count: 0, hits: [] };
	// Named in run.sh's header: these start real Devin sessions, so they are run deliberately.
	const deliberate = new Set(["test-devin-delegate.ts", "test-devin-delegate-lifecycle.ts"]);
	const haystacks = [
		runner,
		...fs
			.readdirSync(testDir)
			.filter((f) => f.endsWith(".sh"))
			.map((f) => path.join(testDir, f)),
	]
		.filter((f) => fs.existsSync(f))
		.map((f) => fs.readFileSync(f, "utf-8"))
		.join("\n");
	const hits = fs
		.readdirSync(testDir)
		.filter((f) => f.startsWith("test-") && f.endsWith(".ts"))
		.filter((f) => !deliberate.has(f))
		.filter((f) => !haystacks.includes(f))
		.map((f) => `test/${f} is wired into no suite - add it to UNIT_TESTS or to a suite runner`);
	return { count: hits.length, hits };
}

/** SKILL.md / agents/*.md need name + description frontmatter (moved here from validate-marketplace). */
function checkFrontmatter() {
	const hits = [];
	// Same tolerance the marketplace validator has always had: BOM and CRLF are not a missing block.
	const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/;
	const check = (file) => {
		const src = fs.readFileSync(file, "utf-8");
		const m = FRONTMATTER_RE.exec(src);
		if (!m) {
			hits.push(`${rel(file)} has no frontmatter block`);
			return;
		}
		const fields = {};
		for (const line of m[1].split(/\r?\n/)) {
			const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
			if (kv) fields[kv[1]] = kv[2].trim();
		}
		for (const key of ["name", "description"]) {
			if (!fields[key]) hits.push(`${rel(file)} frontmatter is missing '${key}'`);
		}
		if (fields.name && fields.name.length > 64) hits.push(`${rel(file)}: \`name\` must be 64 characters or fewer`);
	};
	const walk = (dir, visit) => {
		if (!fs.existsSync(dir)) return;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(p, visit);
			else if (entry.isFile()) visit(p);
		}
	};
	walk(path.join(ROOT, "plugins"), (p) => {
		if (p.endsWith("SKILL.md") || (p.includes(`${path.sep}agents${path.sep}`) && p.endsWith(".md"))) check(p);
	});
	walk(path.join(ROOT, "skills"), (p) => {
		if (p.endsWith("SKILL.md")) check(p);
	});
	return { count: hits.length, hits };
}

// ---------------------------------------------------------------- invariant registry

// Per-file budget for a file with no baseline entry: the issue's absolute targets, applied immediately. */
function defaultBudgetFor(file) {
	if (file.startsWith("extensions/lib/")) return 500;
	if (file.startsWith("extensions/")) return 300;
	return Number.POSITIVE_INFINITY;
}

const INVARIANTS = [
	{
		name: "execLocation",
		description: "no execFile/spawn outside extensions/lib/** (P1 migrates the call sites into lib/exec.ts)",
		measure: () => {
			const hits = execSites()
				.filter((s) => !s.file.startsWith("extensions/lib/"))
				.map((s) => `${s.file}:${s.line}`);
			return { count: hits.length, hits };
		},
	},
	{
		name: "execTimeout",
		description: "every execFile/spawn call passes timeout/timeoutMs",
		measure: () => {
			const hits = execSites()
				.filter((s) => !s.hasTimeout)
				.map((s) => `${s.file}:${s.line}`);
			return { count: hits.length, hits };
		},
	},
	{
		name: "mutationResultChecked",
		description: 'a mutating external call must bind its result (no `await execOrca([... "worker-stop"])`)',
		measure: countUncheckedMutations,
	},
	{
		name: "globalThisOwnership",
		description: "no globalThis writes outside extensions/lib/cross-extension.ts",
		measure: countGlobalThisWrites,
	},
	{
		name: "jsonParseLocation",
		description: "only the subprocess door parses external command output",
		measure: countJsonParseOutsideExecLib,
	},
	{
		name: "noStdioWrites",
		description: "no process.stdout/stderr.write in extensions/** (stdout is the TUI's)",
		measure: countStdioWrites,
	},
	{
		name: "emptyCatch",
		description: "empty catch blocks need a reason comment",
		measure: countEmptyCatches,
	},
	{
		name: "fileLineBudget",
		description: "per-file line counts may only shrink (absolute targets are the goal of the P2 splits)",
		measure: () => {
			const budget = fileLineBudget();
			const baseline = readBaseline().files ?? {};
			const hits = Object.entries(budget)
				.filter(([file, lines]) => (baseline[file] ?? lines) < lines)
				.map(([file, lines]) => `${file}: ${lines} lines, baseline ${baseline[file] ?? lines}`);
			return { count: hits.length, hits, skipInWrite: true };
		},
		dynamic: true,
	},
	{
		name: "piExtensionsMatchDisk",
		description: "package.json -> pi.extensions matches extensions/*.ts in both directions",
		measure: checkPiExtensionsMatchDisk,
	},
	{
		name: "noUnusedLibs",
		description: "every extensions/lib/*.ts is imported by at least one entry file",
		measure: checkUnusedLibs,
	},
	{
		name: "wiredTests",
		description: "every test/test-*.ts is referenced by run.sh or a suite runner",
		measure: checkWiredTests,
	},
	{
		name: "frontmatter",
		description: "every SKILL.md and agents/*.md has name + description frontmatter",
		measure: checkFrontmatter,
	},
];

// ---------------------------------------------------------------- baseline I/O

/** A short fingerprint of biome.jsonc as it stands on disk (raw bytes, so comments and formatting count too). */
function biomeConfigHash() {
	try {
		return createHash("sha256")
			.update(fs.readFileSync(path.join(ROOT, "biome.jsonc")))
			.digest("hex")
			.slice(0, 16);
	} catch {
		return "absent";
	}
}

/**
 * Whether biome.jsonc still runs a rule ("suspicious/noExplicitAny"). Consulted for the stale-metric check,
 * where the counts are ambiguous. An unreadable config answers "enabled": the conservative direction is to
 * keep measuring, never to let a metric quietly disappear.
 */
function ruleEnabledInConfig(rule) {
	let cfg;
	try {
		const raw = fs
			.readFileSync(path.join(ROOT, "biome.jsonc"), "utf-8")
			.replace(/^\uFEFF/, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
		cfg = JSON.parse(raw);
	} catch {
		return true;
	}
	if (cfg?.linter?.enabled === false || cfg?.linter?.rules === "off") return false;
	const [group, name] = rule.split("/");
	const groupCfg = cfg?.linter?.rules?.[group];
	if (groupCfg === "off") return false;
	const levelOf = (value) => (typeof value === "string" ? value : value?.level);
	let enabled = true;
	const severity = groupCfg?.[name];
	if (severity !== undefined) enabled = levelOf(severity) !== "off";
	else enabled = cfg?.linter?.recommended !== false && cfg?.linter?.rules?.recommended !== false;
	// An overrides entry can switch a rule off for exactly the tree this gate measures
	// (`includes: ["extensions/**/*.ts"]`), which is invisible at the top level. Any override whose include
	// patterns could match a gated file and turns the rule off wins: the conservative answer is that the rule
	// is no longer running, which sends the metric down the reasoned path instead of calling it an improvement.
	// Glob matching is deliberately approximate - the zero-drop rule in run() is what actually guarantees the
	// record, this only names the cause in the message.
	for (const o of Array.isArray(cfg?.overrides) ? cfg.overrides : []) {
		const includes = Array.isArray(o?.includes) ? o.includes : [];
		const reachesExtensions = includes.some(
			(pattern) => pattern === "**" || pattern.startsWith("**") || pattern.startsWith("extensions/") || pattern.includes("**."),
		);
		if (!reachesExtensions) continue;
		if (o?.linter?.rules === "off") return false;
		const oGroup = o?.linter?.rules?.[group];
		if (oGroup === "off") return false;
		if (oGroup?.[name] !== undefined && levelOf(oGroup[name]) === "off") return false;
	}
	return enabled;
}

function readBaseline() {
	if (!fs.existsSync(BASELINE_PATH)) return { metrics: {}, files: {}, notes: [] };
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
	} catch (err) {
		fail([`scripts/quality-baseline.json is not valid JSON: ${err.message}`]);
	}
	// A metric that is not a finite non-negative integer is not a threshold, it is a bug or an edit: "147 debt"
	// compared as `value > "147 debt"` -> false -> "ok", and 1e999 parses to Infinity, which is larger than
	// anything a file can grow to. Both silently delete the gate.
	const problems = [];
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		problems.push("scripts/quality-baseline.json must contain an object");
	} else {
		for (const section of ["metrics", "files"]) {
			const entries = parsed[section];
			if (entries === undefined) continue;
			if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
				problems.push(`\`${section}\` must be an object of counts`);
				continue;
			}
			for (const [key, value] of Object.entries(entries)) {
				if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
					problems.push(
						`${section}['${key}'] must be a finite non-negative integer, got ${typeof value} ${JSON.stringify(value) ?? String(value)}`,
					);
				}
			}
		}
		if (parsed.notes !== undefined && !Array.isArray(parsed.notes)) problems.push("`notes` must be an array");
		if (parsed.biomeConfigHash !== undefined && typeof parsed.biomeConfigHash !== "string") {
			problems.push("`biomeConfigHash` must be a string");
		}
	}
	if (problems.length > 0) fail(problems);
	return parsed;
}

/** The commit the baseline was captured from, so a stale baseline is at least datable. */
function headSha() {
	try {
		return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf-8", timeout: 5000 }).trim();
	} catch {
		return "unrecorded";
	}
}

function writeBaseline(next) {
	fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

function fail(messages) {
	console.error(`\n✖ check-quality failed:\n${messages.map((m) => `  ${m}`).join("\n")}`);
	process.exit(1);
}

// ---------------------------------------------------------------- collection + compare

function collect({ includeBiome }) {
	const metrics = {};
	for (const inv of INVARIANTS) {
		if (inv.dynamic) continue;
		const { count } = inv.measure();
		metrics[inv.name] = count;
	}
	if (includeBiome) {
		const result = biomeRuleCounts();
		if (result === null) {
			console.error("biome is not runnable (node_modules/.bin/biome missing) - run `npm install` first.");
			console.error("Source-scanned invariants still ran; biome-derived metrics were skipped.");
			process.exit(1);
		}
		if (result.runFailed) {
			console.error(`the biome run is not a measurement: ${result.detail}`);
			console.error("Refusing to read debt numbers out of it - a metric counted from a broken run is a metric that can only go down.");
			process.exit(1);
		}
		if (!result.shapeOk) {
			console.error(
				"biome produced output that is not in the JSON reporter shape we read - the biome half of the ratchet is measuring nothing, and that is not a pass.",
			);
			process.exit(1);
		}
		if (result.unattributed) {
			console.error(
				"biome reported diagnostics carrying no lint category - the JSON reporter shape changed, and the biome half of the ratchet is measuring nothing.",
			);
			process.exit(1);
		}
		for (const [rule, n] of result.counts) metrics[`biome.${rule}`] = n;
	}
	return { metrics, files: fileLineBudget() };
}

function run({ mode, only, reason, full }) {
	const selected = only ? INVARIANTS.filter((i) => i.name === only) : INVARIANTS;
	if (only && selected.length === 0) {
		fail([`unknown invariant '${only}' - known: ${INVARIANTS.map((i) => i.name).join(", ")}`]);
	}
	// The runner calls --only wiredTests before anything is installed, so that path must not need biome.
	// --only <name> is the dependency-free path (test/run.sh calls --only wiredTests before
	// `npm install`), so biome runs only for the full gate.
	const needBiome = !only;
	const current = collect({ includeBiome: needBiome });
	const baseline = readBaseline();

	const rows = [];
	const problems = [];
	const improvements = [];
	// Everything that may only rise with a `--reason` (file budgets, unmeasured rules) collects here, so one
	// list drives both the report and the write gate. Declared with the other accumulators on purpose: it is
	// appended to from several places, and declaring it lower down was a TDZ crash the moment a rule went
	// unmeasured.
	const gatedExtras = [];

	// Source-scanned invariants carry their failing sites, which is what makes a failure actionable.
	for (const inv of selected) {
		if (inv.dynamic) continue;
		const measured = inv.measure();
		rows.push({ key: inv.name, value: measured.count, allowed: baseline.metrics?.[inv.name], hits: measured.hits ?? [] });
	}

	// biome metrics are gated against the same baseline but have no invariant object; a rule missing
	// from the baseline must be zero, so switching a rule on cannot land new debt unnoticed.
	if (needBiome) {
		for (const [key, value] of Object.entries(current.metrics)) {
			if (!key.startsWith("biome.")) continue;
			rows.push({ key, value, allowed: baseline.metrics?.[key] ?? 0, hits: [] });
		}
		// And the mirror image: a baseline entry the current run no longer measures must not be dropped
		// by silence. Switching `noExplicitAny` off, renaming a rule in a biome upgrade, or a changed
		// --reporter=json shape all make 147 `any`s stop being gated while `--check` still exits 0.
		for (const key of Object.keys(baseline.metrics ?? {})) {
			if (!key.startsWith("biome.") || key in current.metrics) continue;
			const was = baseline.metrics[key];
			// "The rule reported nothing" has two opposite causes and the counts cannot tell them apart, so the
			// question goes to the config: if biome.jsonc still enables the rule the debt is gone, which is an
			// improvement the baseline should be able to record; if the rule is off, the debt is still there and
			// merely stopped being reported, which has to be a deliberate, reasoned decision.
			if (ruleEnabledInConfig(key.slice("biome.".length))) {
				rows.push({ key, value: 0, allowed: was, hits: [] });
				continue;
			}
			const problem = `${key}: baseline ${was} is no longer measured and biome.jsonc has the rule off - fix the remaining ${was} and record the zero, or switch the rule back on (a metric that is not measured is not gated)`;
			problems.push(problem);
			gatedExtras.push(problem);
		}
	}

	for (const row of rows) {
		// A biome metric that used to carry debt and now reports nothing is the one change this gate cannot
		// read: "all 147 `any`s fixed" and "the rule stopped being reported" (switched off in the config or in
		// an override, renamed by a biome upgrade, or fed a stubbed reporter) look identical. So it is treated
		// as a widening: it fails --check and needs --write --reason, exactly like a rise. Partial decreases
		// stay free, because they can only mean work was done.
		if (row.key.startsWith("biome.") && row.allowed !== undefined && row.allowed > 0 && row.value === 0) {
			const problem = `${row.key}: ${row.allowed} -> 0. Either the debt is genuinely gone or the rule stopped reporting it (biome.jsonc, an overrides entry, a renamed rule, a substituted reporter). Record the decision with \`--write --reason "why"\``;
			problems.push(problem);
			gatedExtras.push(problem);
			continue;
		}
		if (row.allowed === undefined && row.value === 0) {
			// Nothing to ratchet yet: a clean invariant does not need a baseline line.
			continue;
		}
		if (row.allowed === undefined) {
			problems.push(`${row.key}: ${row.value} occurrences with no baseline entry - run \`npm run qa:baseline\``);
		} else if (row.value > row.allowed) {
			const shown = full ? row.hits : row.hits.slice(0, 8);
			const detail = shown.map((h) => `\n      ${h}`).join("");
			const more = row.hits.length > shown.length ? `\n      … and ${row.hits.length - shown.length} more (--full)` : "";
			problems.push(`${row.key}: ${row.value} > baseline ${row.allowed} (was ${row.allowed}, now ${row.value})${detail}${more}`);
		} else if (row.value < row.allowed) {
			improvements.push(`${row.key}: ${row.allowed} -> ${row.value}`);
		}
	}

	// Per-file line budget: existing files may only shrink; a new file starts at the issue's absolute
	// target, so the ratchet cannot be sidestepped by adding another 2,600-line module.
	if (!only || only === "fileLineBudget") {
		for (const [file, lines] of Object.entries(current.files)) {
			const allowed = baseline.files?.[file];
			// Growth of a file that already has an entry is a rise like any other: `--write` must not
			// quietly re-capture it, or the budget follows the file instead of constraining it.
			const problem =
				allowed === undefined
					? lines > defaultBudgetFor(file)
						? `${file}: ${lines} lines, and a new file's budget is ${defaultBudgetFor(file)} (raise deliberately: --write --reason)`
						: undefined
					: lines > allowed
						? `${file}: ${lines} lines > baseline ${allowed} (files may only shrink)`
						: undefined;
			if (!problem) continue;
			problems.push(problem);
			gatedExtras.push(problem);
		}
	}

	console.log(`check-quality (${mode}) — ${rows.length} metrics, ${Object.keys(current.files).length} files`);
	for (const row of rows.sort((a, b) => a.key.localeCompare(b.key))) {
		const status = row.allowed === undefined ? "new " : row.value > row.allowed ? "FAIL" : row.value < row.allowed ? "better" : "ok  ";
		console.log(`  ${status}  ${row.key.padEnd(56)} ${String(row.value).padStart(5)} / ${String(row.allowed ?? "-").padStart(5)}`);
	}

	// `notes` is the record of every deliberate widening; a hand-deleted array must not be rewritten as an
	// empty one by the next --write, which is how a raise would end up with no attributable line.
	// Scoped to the full gate: test/run.sh calls `--only wiredTests` before anything is installed, and that
	// path has to keep working whatever the baseline file looks like.
	if (!only && fs.existsSync(BASELINE_PATH) && !Array.isArray(baseline.notes)) {
		fail(["scripts/quality-baseline.json has no `notes` array - restore it; the ratchet history is not optional"]);
	}

	// The debt figures are only comparable to the configuration that produced them. Silencing a rule for one
	// file - `{"includes": ["extensions/tools.ts"], "linter": {"rules": {"suspicious": {"noExplicitAny":
	// "off"}}}}` - moves the count the same way fixing that file's debt does, and no amount of counting tells
	// them apart (147 -> 137 was recorded as an improvement with the source untouched). So biome.jsonc is part
	// of the baseline: change it and re-recording the biome metrics takes a reason, which lands in `notes`.
	const configHash = biomeConfigHash();
	const recordedConfigHash = baseline.biomeConfigHash;
	const baselineHoldsBiome = Object.keys(baseline.metrics ?? {}).some((k) => k.startsWith("biome."));
	const configDrift = !only && fs.existsSync(BASELINE_PATH) && baselineHoldsBiome && recordedConfigHash !== configHash;
	if (configDrift) {
		const msg = `biome.jsonc changed since these numbers were recorded (${recordedConfigHash ?? "unrecorded"} -> ${configHash}): a rule silenced for a subset of files is indistinguishable from that debt being fixed. Re-record deliberately with \`node scripts/check-quality.mjs --write --reason "what changed and why"\``;
		if (mode === "write") gatedExtras.push(msg);
		else problems.push(msg);
	}

	if (mode === "write") {
		// --only evaluates one invariant; writing from a partial measurement would drop every other
		// entry, including all biome.* metrics.
		if (only) {
			fail([
				"--write must run without --only: a partial measurement would rewrite the baseline and lose the metrics that were not measured",
			]);
		}
		// The first capture has nothing to compare against; after that, any rise needs a reason. A rule
		// that appears later (because it was switched on) still counts as an increase.
		const initialCapture = !fs.existsSync(BASELINE_PATH);
		const increasing = initialCapture
			? []
			: [
					...rows.filter((r) => r.allowed !== undefined && r.value > r.allowed),
					...rows.filter((r) => r.allowed === undefined && r.value > 0),
				];
		const gated = [...increasing, ...gatedExtras];
		if (gated.length > 0 && !reason) {
			fail([
				`${gated.length} metric(s) would rise. Lower them, or record the increase with a reason:`,
				...increasing.map((r) => `  ${r.key}: ${r.allowed} -> ${r.value}`),
				...gatedExtras.map((m) => `  ${m}`),
				`  node scripts/check-quality.mjs --write --reason "what changed, and why it is acceptable"`,
			]);
		}
		const next = {
			...baseline,
			generatedFrom: headSha(),
			biomeConfigHash: biomeConfigHash(),
			metrics: { ...current.metrics },
			files: { ...current.files },
			notes: baseline.notes ?? [],
		};
		if (gated.length > 0) {
			next.notes.push({
				at: new Date().toISOString().slice(0, 10),
				reason,
				changes: [...increasing.map((r) => `${r.key}: ${r.allowed} -> ${r.value}`), ...gatedExtras],
			});
		}
		writeBaseline(next);
		console.log(
			`\nwrote ${rel(BASELINE_PATH)} (${improvements.length} metric(s) lowered${gated.length ? `, ${gated.length} recorded with a reason` : ""}).`,
		);
		return;
	}

	if (improvements.length > 0) {
		console.log(`\n${improvements.length} metric(s) improved; run \`npm run qa:baseline\` to lower the baseline:`);
		for (const line of improvements.slice(0, 10)) console.log(`  ${line}`);
	}

	if (problems.length > 0) fail(problems);
	console.log("\n✓ all quality invariants within baseline");
}

// ---------------------------------------------------------------- CLI

const argv = process.argv.slice(2);
if (argv.includes("--list")) {
	console.log("Invariants enforced by scripts/check-quality.mjs:\n");
	for (const inv of INVARIANTS) console.log(`  ${inv.name.padEnd(26)} ${inv.description}`);
	console.log("\n  biome.<rule>              one metric per biome lint rule over extensions/");
	process.exit(0);
}

const onlyIndex = argv.indexOf("--only");
const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined;
const reasonIndex = argv.indexOf("--reason");
const reason = reasonIndex >= 0 ? argv[reasonIndex + 1] : undefined;
const mode = argv.includes("--write") ? "write" : "check";
const full = argv.includes("--full");

if (mode === "write" && reason !== undefined) {
	const why = reasonProblem(reason);
	if (why) fail([why]);
}
if (only !== undefined && only.startsWith("--")) fail([`--only must name an invariant (see --list), got '${only}'`]);

run({ mode, only, reason: reason?.trim(), full });

/**
 * A reason is the only record of a widening, and it is read by whoever reviews the next baseline diff. Text
 * that is merely non-empty is not a record: "." and "why this is acceptable" both authorised ungating in
 * review, so the bar is a sentence, not a keystroke.
 */
function reasonProblem(text) {
	const t = String(text ?? "").trim();
	if (t === "") return "--reason must not be empty";
	// `--write --reason --only wiredTests` would otherwise take "--only" for the reason text.
	if (t.startsWith("--")) return `--reason must be a sentence, not a flag (got '${t}')`;
	if (!/[A-Za-z0-9]{3}/.test(t)) return `--reason must say something; '${t}' is punctuation`;
	const words = t.split(/[^A-Za-z0-9'%.-]+/).filter((w) => w.replace(/\W/g, "").length > 1);
	if (words.length < 4) return `--reason must be a sentence of at least four words (got '${t}')`;
	if (t.length < 24) return `--reason must be at least 24 characters of explanation (got ${t.length}: '${t}')`;
	// No placeholder blacklist: every list of "banned vague words" rejects the honest short note and admits the
	// vague sentence long enough to slip past. Length plus word count is the blunt instrument, and the actual
	// reviewer of a widened baseline is a human reading `notes`.
	return undefined;
}
