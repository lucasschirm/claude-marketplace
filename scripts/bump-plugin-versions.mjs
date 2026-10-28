#!/usr/bin/env node
// Bumps the minor version of every plugin whose files a push to the default branch changed.
//
//   node scripts/bump-plugin-versions.mjs <before-sha> <after-sha>
//
// CI runs this on every push to main/dev (see .github/workflows/plugin-version-bump.yml): a merge
// that changed files under plugins/<name>/ bumps that plugin's version (1.1.0 -> 1.2.0) in both
// manifest layouts it ships (.devin-plugin and .claude-plugin), commits, and pushes - so an
// installed plugin's cache key changes and hosts re-fetch it.
//
// The loop guard is the manifest filter below: the bump commit itself touches only the manifests,
// which do not count as plugin changes, so the workflow's own push is a no-op.
//
// Exits 0 in every no-op case (no base, no plugin changes, nothing writable) - a skipped bump must
// never fail CI. The pure half (changed files -> plugins, version arithmetic) is exported for the
// test suite.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATHS = [".devin-plugin/plugin.json", ".claude-plugin/plugin.json"];

/** A manifest file of any plugin - the version bump's own footprint, never a plugin change. */
export function isPluginManifest(file) {
	return MANIFEST_PATHS.some((manifest) => file === manifest || file.endsWith(`/${manifest}`));
}

/** The plugins a push changed, as directory names that exist under plugins/. */
export function pluginsFromChangedFiles(files) {
	const names = new Set();
	for (const file of files) {
		const match = /^plugins\/([^/]+)\//.exec(file);
		if (match) names.add(match[1]);
	}
	return [...names].filter((name) => fs.existsSync(path.join(ROOT, "plugins", name))).sort();
}

/** Semver minor bump: 1.1.0 -> 1.2.0, 1.2.3 -> 1.3.0. Unparseable/missing versions answer undefined. */
export function bumpVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(version ?? ""));
	if (!match) return undefined;
	return `${match[1]}.${Number(match[2]) + 1}.0`;
}

/**
 * Bumps one manifest file in place, preserving the 2-space JSON layout. Answers
 * `{ from, to }`, or undefined when there was nothing to do (missing file, unparseable
 * JSON or version, already bumped).
 */
export function bumpManifestFile(file) {
	if (!fs.existsSync(file)) return undefined;
	let json;
	try {
		json = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (err) {
		console.warn(`skip ${path.relative(ROOT, file)}: unparseable JSON (${err.message})`);
		return undefined;
	}
	const to = bumpVersion(json.version);
	if (to === undefined) {
		console.warn(`skip ${path.relative(ROOT, file)}: no parseable version field`);
		return undefined;
	}
	const from = json.version;
	if (to === from) return undefined;
	json.version = to;
	fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
	return { from, to };
}

function main() {
	const [before, after] = process.argv.slice(2);
	if (!before || !after || /^0+$/.test(before)) {
		console.log("No base revision to diff against; nothing to bump.");
		return 0;
	}
	let files;
	try {
		files = execFileSync("git", ["diff", "--name-only", before, after], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
	} catch (err) {
		console.warn(`Could not diff ${before}..${after} (${err.message.split("\n")[0]}); nothing to bump.`);
		return 0;
	}
	// The version bump's own commit must not bump again: manifests never count as plugin changes.
	const plugins = pluginsFromChangedFiles(files.filter((file) => !isPluginManifest(file)));
	if (plugins.length === 0) {
		console.log("No plugin source changes in this push; nothing to bump.");
		return 0;
	}
	let bumped = 0;
	for (const name of plugins) {
		for (const manifest of MANIFEST_PATHS) {
			const result = bumpManifestFile(path.join(ROOT, "plugins", name, manifest));
			if (result) {
				bumped++;
				console.log(`${name} (${manifest}): ${result.from} -> ${result.to}`);
			}
		}
	}
	if (bumped === 0) console.log(`Plugin(s) changed (${plugins.join(", ")}) but no manifest had a bumpable version.`);
	return 0;
}

// Run as a CLI when executed directly; imported modules get only the exported pure half.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main());
}
