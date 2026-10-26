#!/usr/bin/env node
// Keeps the vendored copies of `extensions/lib/` inside the plugins in sync:
//
//   node scripts/sync-plugin-libs.mjs            # report drift, exit 1 (what `npm run validate` runs)
//   node scripts/sync-plugin-libs.mjs --write    # copy extensions/lib/<file> -> plugins/<plugin>/lib/
//
// Why plugins carry their own copies at all: `devin plugins install` and `/plugin install` copy a
// plugin directory into the host's own plugin cache, so a plugin can never read a file outside
// itself. pr-observer's MCP server imported `../../../extensions/lib/pr-tasks-manager.ts`, which
// only exists in a repository checkout: installed, the server died on import, before answering the
// handshake, and Devin reported `Failed to list tools for server 'pr-observer'`.
//
// Vendoring fixes the crash; this check is what keeps the copy honest. The files are compared
// byte for byte, so a plugin can never ship an engine that differs from the tested extensions one -
// run `--write` after changing anything under extensions/lib/ that a plugin vendors.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every plugin that vendors shared engine files, and which files it carries. */
export const VENDORING = [
	{
		plugin: "plugins/pr-observer",
		source: "extensions/lib",
		// github-review-threads (gh calls) + pr-tasks-manager (task reconciliation) are the review
		// conversation engine; ci-verdict answers "did CI pass?" from `gh pr checks` rows; exec and
		// exec-payload are their door to subprocesses, pulled in by the first.
		//
		// The whole graph must stay importable from node builtins alone: an installed plugin is copied
		// into a host's own cache, so a package import resolves only by luck. That is not hypothetical -
		// this list exists because pr-observer once imported a path outside its own directory and died on
		// import before answering the handshake (#46). Adding a package dependency to any file here needs
		// the same care.
		files: ["github-review-threads.ts", "pr-tasks-manager.ts", "ci-verdict.ts", "exec.ts", "exec-payload.ts"],
	},
];

/**
 * The drift of every vendored copy: missing, stale, or vendored from a source that no longer exists.
 * Returns messages (empty means everything matches), so the marketplace validator can report them
 * alongside its own checks.
 */
export function checkPluginLibs(base = root) {
	const problems = [];
	for (const { plugin, source, files } of VENDORING) {
		for (const file of files) {
			const origin = path.join(base, source, file);
			const copy = path.join(base, plugin, "lib", file);
			if (!fs.existsSync(origin)) {
				problems.push(`${source}/${file}: vendored by ${plugin} but no longer exists`);
				continue;
			}
			if (!fs.existsSync(copy)) {
				problems.push(`${plugin}/lib/${file}: missing - run 'node scripts/sync-plugin-libs.mjs --write'`);
				continue;
			}
			if (!fs.readFileSync(origin).equals(fs.readFileSync(copy))) {
				problems.push(`${plugin}/lib/${file}: differs from ${source}/${file} - run 'node scripts/sync-plugin-libs.mjs --write'`);
			}
		}
	}
	return problems;
}

function writePluginLibs() {
	const written = [];
	for (const { plugin, source, files } of VENDORING) {
		const target = path.join(root, plugin, "lib");
		fs.mkdirSync(target, { recursive: true });
		for (const file of files) {
			fs.copyFileSync(path.join(root, source, file), path.join(target, file));
			written.push(`${plugin}/lib/${file}`);
		}
	}
	return written;
}

// (only when run directly, so importing the check above has no side effects)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--write")) {
		for (const file of writePluginLibs()) console.log(`vendored ${file}`);
		process.exit(0);
	}
	const problems = checkPluginLibs();
	if (problems.length > 0) {
		console.error("Vendored plugin libraries are out of sync:");
		for (const problem of problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	console.log("Vendored plugin libraries match extensions/lib");
}
