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

// ---------------------------------------------------------------- biome metrics

/** Counts of biome diagnostics per rule over extensions/, or null when biome is unavailable. */
function biomeRuleCounts() {
	const localBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "biome.cmd" : "biome");
	const cmd = fs.existsSync(localBin) ? localBin : "npx";
	const args = fs.existsSync(localBin)
		? ["lint", "--reporter=json", "extensions"]
		: ["--no-install", "biome", "lint", "--reporter=json", "extensions"];

	const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
	if (res.error || typeof res.stdout !== "string" || res.stdout.trim() === "") {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(res.stdout);
	} catch {
		return null;
	}
	const diagnostics = Array.isArray(parsed) ? parsed : (parsed?.diagnostics ?? []);
	const counts = new Map();
	for (const d of diagnostics) {
		const rule = String(d?.category ?? "").replace(/^lint\//, "");
		if (!rule) continue;
		counts.set(rule, (counts.get(rule) ?? 0) + 1);
	}
	return counts;
}

// ---------------------------------------------------------------- source-scanned metrics

/**
 * execFile/execFileAsync/spawn sites, split by location and by whether a timeout is visible in the
 * call. The window is the call line plus the six that follow: enough for the options object of every
 * call in the tree today, short enough that an unrelated `timeout` below does not mask a missing one.
 */
function execSites() {
	const all = [];
	for (const file of extensionFiles()) {
		const lines = linesOf(file);
		for (let i = 0; i < lines.length; i++) {
			if (!/\b(execFileAsync|execFileSync|execFile|spawn|spawnSync)\s*\(/.test(lines[i])) continue;
			const window = lines.slice(i, i + 7).join("\n");
			all.push({ file: rel(file), line: i + 1, hasTimeout: /\b(timeout|timeoutMs)\s*:/.test(window) });
		}
	}
	return all;
}

function countEmptyCatches() {
	let n = 0;
	const hits = [];
	for (const file of extensionFiles()) {
		const src = fs.readFileSync(file, "utf-8");
		for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)) {
			n++;
			hits.push(`${rel(file)}:${src.slice(0, m.index).split("\n").length}`);
		}
	}
	return { count: n, hits };
}

/**
 * A write (or delete) of a global slot. Reads must not count: `(globalThis as any)[K]` also appears in
 * `if (...)` guards, and counting those would inflate the metric and hide the real ones.
 */
function isGlobalThisWrite(line) {
	const idx = line.indexOf("globalThis");
	if (idx < 0) return false;
	if (/\bdelete\s+\(?\s*$/.test(line.slice(0, idx))) return true;
	return /globalThis\s*(?:as\s+any\s*\))?\s*(?:\[[^\]]+\]|\.[A-Za-z_$][\w$]*)\s*(?:=|\?\?=|\|\|=|&&=)(?!=)/.test(line.slice(idx));
}

function countGlobalThisWrites() {
	const hits = [];
	for (const file of extensionFiles()) {
		if (rel(file) === "extensions/lib/cross-extension.ts") continue;
		linesOf(file).forEach((line, i) => {
			if (isGlobalThisWrite(line)) hits.push(`${rel(file)}:${i + 1}`);
		});
	}
	return { count: hits.length, hits };
}

function countJsonParseOutsideExecLib() {
	const hits = [];
	for (const file of extensionFiles()) {
		if (rel(file) === "extensions/lib/exec.ts") continue;
		const lines = linesOf(file);
		lines.forEach((line, i) => {
			if (/\bJSON\.parse\s*\(/.test(line)) hits.push(`${rel(file)}:${i + 1}`);
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
 * itself is the bug. Verbs are matched on the argument vector, not on the function name.
 */
const MUTATING_VERBS =
	/\b(worker-stop|worker-release|pr\s+merge|pr\s+review|pr\s+comment|pr\s+close|issue\s+close|push|commit|rm|delete)\b/;

function countUncheckedMutations() {
	const hits = [];
	for (const file of extensionFiles()) {
		const lines = linesOf(file);
		lines.forEach((line, i) => {
			const call = /^\s*await\s+(execOrca|execFileAsync|execFileSync|runJson|runText)\s*\(/.test(line);
			if (!call) return;
			const window = lines.slice(i, i + 5).join(" ");
			if (MUTATING_VERBS.test(window)) hits.push(`${rel(file)}:${i + 1}`);
		});
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
	const entries = fs
		.readdirSync(path.join(ROOT, "extensions"))
		.filter((f) => f.endsWith(".ts"))
		.map((f) => path.join(ROOT, "extensions", f));
	const corpus = entries.map((f) => fs.readFileSync(f, "utf-8")).join("\n");
	const hits = fs
		.readdirSync(libDir)
		.filter((f) => f.endsWith(".ts"))
		.filter((f) => !corpus.includes(`./lib/${f}`) && !corpus.includes(`lib/${f}`))
		.map((f) => `extensions/lib/${f} is imported by no entry file`);
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
	const check = (file) => {
		const src = fs.readFileSync(file, "utf-8");
		const m = /^---\n([\s\S]*?)\n---/.exec(src);
		if (!m) {
			hits.push(`${rel(file)} has no frontmatter block`);
			return;
		}
		for (const key of ["name", "description"]) {
			if (!new RegExp(`^${key}:\\s*\\S`, "m").test(m[1])) hits.push(`${rel(file)} frontmatter is missing '${key}'`);
		}
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
		description: "only extensions/lib/exec.ts parses external command output",
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

function readBaseline() {
	if (!fs.existsSync(BASELINE_PATH)) return { metrics: {}, files: {}, notes: [] };
	try {
		return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
	} catch (err) {
		fail([`scripts/quality-baseline.json is not valid JSON: ${err.message}`]);
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
		const counts = biomeRuleCounts();
		if (counts === null) {
			console.error("biome is not runnable (node_modules/.bin/biome missing) - run `npm install` first.");
			console.error("Source-scanned invariants still ran; biome-derived metrics were skipped.");
			process.exit(1);
		}
		for (const [rule, n] of counts) metrics[`biome.${rule}`] = n;
	}
	return { metrics, files: fileLineBudget() };
}

function run({ mode, only, reason }) {
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
	}

	for (const row of rows) {
		if (row.allowed === undefined && row.value === 0) {
			// Nothing to ratchet yet: a clean invariant does not need a baseline line.
			continue;
		}
		if (row.allowed === undefined) {
			problems.push(`${row.key}: ${row.value} occurrences with no baseline entry - run \`npm run qa:baseline\``);
		} else if (row.value > row.allowed) {
			const detail = row.hits
				.slice(0, 8)
				.map((h) => `\n      ${h}`)
				.join("");
			const more = row.hits.length > 8 ? `\n      … and ${row.hits.length - 8} more` : "";
			problems.push(`${row.key}: ${row.value} > baseline ${row.allowed} (was ${row.allowed}, now ${row.value})${detail}${more}`);
		} else if (row.value < row.allowed) {
			improvements.push(`${row.key}: ${row.allowed} -> ${row.value}`);
		}
	}

	// Per-file line budget: only shrink, and a brand-new file is allowed at its current size.
	if (!only) {
		for (const [file, lines] of Object.entries(current.files)) {
			const allowed = baseline.files?.[file];
			if (allowed !== undefined && lines > allowed) {
				problems.push(`${file}: ${lines} lines > baseline ${allowed} (files may only shrink)`);
			}
		}
	}

	console.log(`check-quality (${mode}) — ${rows.length} metrics, ${Object.keys(current.files).length} files`);
	for (const row of rows.sort((a, b) => a.key.localeCompare(b.key))) {
		const status = row.allowed === undefined ? "new " : row.value > row.allowed ? "FAIL" : row.value < row.allowed ? "better" : "ok  ";
		console.log(`  ${status}  ${row.key.padEnd(56)} ${String(row.value).padStart(5)} / ${String(row.allowed ?? "-").padStart(5)}`);
	}

	if (mode === "write") {
		// The first capture has nothing to compare against; after that, any rise needs a reason. A rule
		// that appears later (because it was switched on) still counts as an increase.
		const initialCapture = Object.keys(baseline.metrics ?? {}).length === 0;
		const increasing = initialCapture
			? []
			: [
					...rows.filter((r) => r.allowed !== undefined && r.value > r.allowed),
					...rows.filter((r) => r.allowed === undefined && r.value > 0),
				];
		if (increasing.length > 0 && !reason) {
			fail([
				`${increasing.length} metric(s) would rise. Lower them, or record the increase with a reason:`,
				...increasing.map((r) => `  ${r.key}: ${r.allowed} -> ${r.value}`),
				`  node scripts/check-quality.mjs --write --reason "why this is acceptable"`,
			]);
		}
		const next = {
			...baseline,
			generatedFrom: process.env.GIT_SHA ?? "unrecorded",
			metrics: { ...current.metrics },
			files: { ...current.files },
			notes: baseline.notes ?? [],
		};
		if (increasing.length > 0) {
			next.notes.push({
				at: new Date().toISOString().slice(0, 10),
				reason,
				changes: increasing.map((r) => `${r.key}: ${r.allowed} -> ${r.value}`),
			});
		}
		writeBaseline(next);
		console.log(
			`\nwrote ${rel(BASELINE_PATH)} (${improvements.length} metric(s) lowered${increasing.length ? `, ${increasing.length} recorded with a reason` : ""}).`,
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

if (mode === "write" && reason && reason.trim() === "") fail(["--reason must not be empty"]);

run({ mode, only, reason });
