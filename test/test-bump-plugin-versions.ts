// Run with: node --test test/test-bump-plugin-versions.ts
//
// The version-bump automation (scripts/bump-plugin-versions.mjs): which changed files count as
// plugin changes, the manifest filter that keeps the bump commit from bumping again, the semver
// minor arithmetic, and the manifest write round-trip. The git-diff and CLI halves are thin and
// exercised by the workflow itself.
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bumpManifestFile, bumpVersion, isPluginManifest, pluginsFromChangedFiles } from "../scripts/bump-plugin-versions.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("plugin changes are detected from the changed-file list, unknown dirs ignored", () => {
	assert.deepEqual(pluginsFromChangedFiles(["plugins/pr-observer/scripts/x.mjs", "extensions/y.ts"]), ["pr-observer"]);
	assert.deepEqual(pluginsFromChangedFiles(["plugins/pr-observer/a", "plugins/claude-basics/b", "README.md"]), [
		"claude-basics",
		"pr-observer",
	]);
	// A directory that does not exist under plugins/ (a deleted or renamed plugin) is not a bump.
	assert.deepEqual(pluginsFromChangedFiles(["plugins/ghost/file"]), []);
	assert.deepEqual(pluginsFromChangedFiles(["plugins.txt", "plugins/"]), []);
});

test("the manifest filter is what keeps the bump commit from bumping again", () => {
	// A bump commit touches only the manifests of the plugins it bumped: filtered, no bump.
	const bumpCommitFiles = ["plugins/pr-observer/.devin-plugin/plugin.json", "plugins/pr-observer/.claude-plugin/plugin.json"];
	assert.deepEqual(pluginsFromChangedFiles(bumpCommitFiles.filter((f) => !isPluginManifest(f))), []);
	// The filter is per-layout, not per-plugin: any plugin's manifests are filtered.
	assert.equal(isPluginManifest("plugins/other/.devin-plugin/plugin.json"), true);
	assert.equal(isPluginManifest("plugins/other/.claude-plugin/plugin.json"), true);
	// ...and a manifest-shaped path elsewhere in the tree is not (the root has none, but be exact).
	assert.equal(isPluginManifest(".devin-plugin/plugin.json"), true);
	assert.equal(isPluginManifest("plugins/pr-observer/scripts/check-settle.mjs"), false);
	assert.equal(isPluginManifest("plugins/pr-observer/.devin-plugin/plugin.json.bak"), false);
});

test("the minor bump: 1.1.0 -> 1.2.0, patch and prerelease reset, unparseable fails safe", () => {
	assert.equal(bumpVersion("1.1.0"), "1.2.0");
	assert.equal(bumpVersion("1.2.3"), "1.3.0");
	assert.equal(bumpVersion("10.0.9"), "10.1.0");
	assert.equal(bumpVersion("1.1.0-beta.1"), "1.2.0");
	assert.equal(bumpVersion("1.1"), undefined);
	assert.equal(bumpVersion("one.one"), undefined);
	assert.equal(bumpVersion(""), undefined);
	assert.equal(bumpVersion(undefined), undefined);
	assert.equal(bumpVersion(null), undefined);
});

test("bumpManifestFile rewrites the version in place and preserves the layout", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-manifest-"));
	try {
		const file = path.join(dir, "plugin.json");
		fs.writeFileSync(file, '{\n  "name": "pr-observer",\n  "version": "1.1.0",\n  "description": "d"\n}\n');
		const result = bumpManifestFile(file);
		assert.deepEqual(result, { from: "1.1.0", to: "1.2.0" });
		assert.equal(
			fs.readFileSync(file, "utf8"),
			'{\n  "name": "pr-observer",\n  "version": "1.2.0",\n  "description": "d"\n}\n',
			"the 2-space layout and trailing newline are preserved",
		);
		// Idempotent at the file level: bumping again answers a new version (the caller's
		// manifest filter is what prevents the second call, not the file).
		assert.deepEqual(bumpManifestFile(file), { from: "1.2.0", to: "1.3.0" });

		// A differently laid-out manifest (the repo's claude-basics ships 4-space, no newline)
		// must not be reformatted by a bump.
		const fourSpace = path.join(dir, "four.json");
		fs.writeFileSync(fourSpace, '{\n    "name": "x",\n    "version": "1.1.0"\n}');
		assert.deepEqual(bumpManifestFile(fourSpace), { from: "1.1.0", to: "1.2.0" });
		assert.equal(
			fs.readFileSync(fourSpace, "utf8"),
			'{\n    "name": "x",\n    "version": "1.2.0"\n}',
			"indent width and the missing trailing newline survive",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("bumpManifestFile skips missing files, unparseable JSON and unparseable versions", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bump-manifest-"));
	try {
		assert.equal(bumpManifestFile(path.join(dir, "absent.json")), undefined);
		const bad = path.join(dir, "bad.json");
		fs.writeFileSync(bad, "{not json");
		assert.equal(bumpManifestFile(bad), undefined);
		const noVersion = path.join(dir, "noversion.json");
		fs.writeFileSync(noVersion, '{"name": "x"}\n');
		assert.equal(bumpManifestFile(noVersion), undefined);
		assert.equal(fs.readFileSync(noVersion, "utf8"), '{"name": "x"}\n', "a skipped file is left untouched");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("every real plugin manifest is parseable and in the shape the automation expects", () => {
	// Not a fixture: the actual manifests on disk, discovered rather than hardcoded, so a new
	// plugin is covered the moment it ships one. Layouts differ across plugins (indent width,
	// trailing newline) and bumpManifestFile preserves each file's own - so only the content
	// shape is asserted here.
	const pluginsDir = path.join(REPO, "plugins");
	const discovered = fs
		.readdirSync(pluginsDir)
		.flatMap((name) =>
			[".devin-plugin/plugin.json", ".claude-plugin/plugin.json"]
				.map((manifest) => path.join(pluginsDir, name, manifest))
				.filter((file) => fs.existsSync(file)),
		);
	assert.ok(discovered.length >= 2, "the discovery itself must find the shipped manifests");
	for (const file of discovered) {
		const json = JSON.parse(fs.readFileSync(file, "utf8"));
		assert.match(String(json.version), /^\d+\.\d+\.\d+$/);
		assert.equal(typeof json.name, "string");
	}
});
