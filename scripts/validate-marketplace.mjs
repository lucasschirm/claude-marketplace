#!/usr/bin/env node
// Validates the marketplace manifests and the Pi package manifest:
//   node scripts/validate-marketplace.mjs
//
// Checks, for every plugin declared in .claude-plugin/marketplace.json:
//   - the JSON manifests parse and carry the required fields
//   - `source` resolves to a directory holding .claude-plugin/plugin.json
//   - the plugin.json `name` matches the marketplace entry it belongs to
//   - every plugins/*/.claude-plugin/plugin.json is listed in the marketplace
// SKILL.md / agents/*.md frontmatter is NOT checked here: scripts/check-quality.mjs owns that invariant
// (same BOM/CRLF tolerance and `name` length rule, plus the root skills/ tree this never covered). Two
// parsers for one rule is how they start to disagree.
// `npm run check` runs it; `npm run validate` runs this file.
// and for package.json:
//   - every path in the `pi` manifest (extensions, skills) exists

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const checked = [];

const fail = (msg) => problems.push(msg);
const ok = (msg) => checked.push(msg);

const readJson = (rel) => {
	const abs = path.join(root, rel);
	let raw;
	try {
		raw = fs.readFileSync(abs, "utf8");
	} catch {
		fail(`${rel}: missing`);
		return null;
	}
	try {
		return JSON.parse(raw);
	} catch (err) {
		fail(`${rel}: invalid JSON (${err.message})`);
		return null;
	}
};

// --- Claude Code marketplace ------------------------------------------------

const marketplace = readJson(".claude-plugin/marketplace.json");
const declared = new Set();

if (marketplace) {
	if (!marketplace.name) fail(".claude-plugin/marketplace.json: `name` is required");
	if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
		fail(".claude-plugin/marketplace.json: `plugins` must be a non-empty array");
	}

	for (const [index, entry] of (marketplace.plugins ?? []).entries()) {
		const where = `marketplace.plugins[${index}]${entry?.name ? ` (${entry.name})` : ""}`;
		if (!entry?.name) fail(`${where}: \`name\` is required`);
		if (!entry?.description) fail(`${where}: \`description\` is required`);
		if (!entry?.source) {
			fail(`${where}: \`source\` is required`);
			continue;
		}
		if (entry.name) {
			if (declared.has(entry.name)) fail(`${where}: duplicate plugin name "${entry.name}"`);
			declared.add(entry.name);
		}

		const sourceDir = path.join(root, entry.source);
		if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
			fail(`${where}: source "${entry.source}" does not resolve to a directory`);
			continue;
		}

		const manifestRel = path.join(entry.source, ".claude-plugin/plugin.json");
		const manifest = readJson(manifestRel);
		if (!manifest) continue;
		if (manifest.name && entry.name && manifest.name !== entry.name) {
			fail(`${where}: name "${entry.name}" != ${manifestRel} name "${manifest.name}"`);
		}
		if (!manifest.description) fail(`${manifestRel}: \`description\` is required`);
		if (!manifest.version) fail(`${manifestRel}: \`version\` is required`);
		ok(`${entry.name}: source + manifest ok`);
	}
}

// Every plugin on disk must be listed in the marketplace manifest.
if (fs.existsSync(path.join(root, "plugins"))) {
	for (const dir of fs.readdirSync(path.join(root, "plugins"), { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const manifest = path.join(root, "plugins", dir.name, ".claude-plugin/plugin.json");
		if (!fs.existsSync(manifest)) {
			fail(`plugins/${dir.name}/ has no .claude-plugin/plugin.json`);
			continue;
		}
		const parsed = readJson(path.relative(root, manifest));
		const name = parsed?.name ?? dir.name;
		if (!declared.has(name)) fail(`plugins/${dir.name} (${name}) is not listed in marketplace.json`);
	}
}

// --- Pi package manifest ---------------------------------------------------

const pkg = readJson("package.json");
if (pkg?.pi) {
	for (const [key, entries] of Object.entries(pkg.pi)) {
		for (const entry of Array.isArray(entries) ? entries : [entries]) {
			if (typeof entry !== "string") continue;
			if (!fs.existsSync(path.join(root, entry))) fail(`package.json pi.${key}: "${entry}" does not exist`);
			else ok(`package.json pi.${key}: ${entry} ok`);
		}
	}
}

for (const line of checked) console.log(`  ok  ${line}`);
if (problems.length) {
	console.error(`\n${problems.length} problem(s) found:`);
	for (const problem of problems) console.error(`  x   ${problem}`);
	process.exit(1);
}
console.log(`\n✓ Marketplace and Pi manifests valid (${checked.length} checks)`);
