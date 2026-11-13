// Run with: node --test test/test-bump-plugin-versions.ts
//
// The version-bump automation (scripts/bump-plugin-versions.mjs): which changed files count as
// plugin changes, the manifest filter that keeps the bump commit from bumping again, the semver
// minor arithmetic, and the manifest write round-trip. The git half is NOT thin: the workflow step
// that commits and pushes the bump is extracted from the YAML and run here against a local origin,
// because the first time a push actually carried a plugin change, that step was what failed - and
// nothing else had ever executed it.
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gitSandboxEnv } from "./helpers/git-repo.ts";
import { bumpManifestFile, bumpVersion, isPluginManifest, pluginsFromChangedFiles } from "../scripts/bump-plugin-versions.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = path.join(REPO, ".github", "workflows", "plugin-version-bump.yml");
// `${{ env.KEY }}` lines of the commit-and-push step, and the body's indentation (steps at 2, keys at
// 8, the `run: |` block at 10).
const ENV_LINE = /^ {10}([A-Z_]+): \$\{\{ ([\w.]+) \}\}\s*$/;
const RUN_BLOCK = /^ {8}run: \|\s*$/;
const NEXT_STEP = /^ {6}- name: /;
const BODY_INDENT = " ".repeat(10);
const RE_PUSH_FAILED = /Push attempt 1 failed/;
const RE_NO_BUMPS = /No version bumps to commit\./;
const RE_BUMP_SUBJECT = /^chore\(plugins\): bump versions after 0{40}$/;
const RE_VERSION_120 = /"version": "1\.2\.0"/;

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

// ---------------------------------------------------------------- the workflow's commit-and-push step

/**
 * The `Commit and push the bump` step, as it would run on the runner: its `env:` mapping with the
 * github context substituted in, and its shell body. Reading the YAML rather than copying the script
 * is the point - a copied script tests the copy.
 */
function bumpPushStep(context: Record<string, string>): { body: string; env: Record<string, string> } {
	const lines = fs.readFileSync(WORKFLOW, "utf8").split("\n");
	const start = lines.findIndex((line) => line.trim() === "- name: Commit and push the bump");
	assert.ok(start >= 0, "the workflow has the commit-and-push step");
	const env: Record<string, string> = {};
	const body: string[] = [];
	let i = start + 1;
	for (; i < lines.length && !RUN_BLOCK.test(lines[i] ?? ""); i++) {
		const pair = ENV_LINE.exec(lines[i] ?? "");
		if (pair) {
			assert.ok(pair[2] in context, `the step reads \${{ ${pair[2]} }}, which this test does not supply`);
			env[pair[1]] = context[pair[2]] ?? "";
			continue;
		}
		if (NEXT_STEP.test(lines[i] ?? "")) {
			break;
		}
	}
	for (i += 1; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		if (raw.trim() === "") {
			body.push("");
			continue;
		}
		if (!raw.startsWith(BODY_INDENT)) {
			break;
		}
		body.push(raw.slice(BODY_INDENT.length));
	}
	const text = body.join("\n");
	assert.ok(!text.includes("${{"), `the body must reach the shell through env, not interpolation: ${text}`);
	return { body: text, env };
}

/**
 * A bare origin with one plugin manifest on `dev`, and a clone of it left detached like a push event.
 * The env is hermetic on purpose: no ambient config, no ambient identity, because what the step has to
 * prove is that it works on a runner that has neither.
 */
function bumpFixture(): { origin: string; work: string; manifest: string; env: NodeJS.ProcessEnv } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bump-step-"));
	const origin = path.join(root, "origin.git");
	const work = path.join(root, "work");
	const env = gitSandboxEnv({ HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
	git(["init", "-q", "--bare", "-b", "dev", origin], env);
	git(["clone", "-q", origin, work], env);
	// Cloning an empty repository names the local branch after the client's `init.defaultBranch`, which
	// is `master` on a CI runner and `dev` on some laptops: say which branch this fixture is about.
	git(["checkout", "-q", "-b", "dev"], env, work);
	const manifest = path.join(work, "plugins", "demo", ".claude-plugin", "plugin.json");
	fs.mkdirSync(path.dirname(manifest), { recursive: true });
	fs.writeFileSync(manifest, '{\n  "name": "demo",\n  "version": "1.1.0",\n  "description": "d"\n}\n');
	git(["add", "."], env, work);
	git(["-c", "user.name=Setup", "-c", "user.email=setup@example.invalid", "commit", "-qm", "ship a plugin"], env, work);
	git(["push", "-q", "origin", "dev"], env, work);
	// The runner checks a push event out detached, where a bare `git push` refuses to guess a destination.
	git(["checkout", "-q", "--detach"], env, work);
	return { origin, work, manifest, env };
}

function git(args: string[], env: NodeJS.ProcessEnv, cwd?: string): string {
	return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Run the step body exactly as the runner does: `bash -e`, the step's env, no git identity of its own. */
function runBumpStep(
	body: string,
	stepEnv: Record<string, string>,
	fx: { work: string; env: NodeJS.ProcessEnv },
): {
	ok: boolean;
	output: string;
} {
	const script = path.join(path.dirname(fx.work), "step.sh");
	fs.writeFileSync(script, body);
	try {
		const env = gitSandboxEnv({ ...fx.env, ...stepEnv });
		return { ok: true, output: execFileSync("bash", ["-e", script], { cwd: fx.work, env, encoding: "utf8" }) };
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
		return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}` };
	}
}

const CONTEXT = { "github.ref_name": "dev", "github.sha": "0".repeat(40) };

test("the bump step commits the bumped manifest and pushes it to the branch it was triggered on", () => {
	const fx = bumpFixture();
	const { origin, manifest, env } = fx;
	const step = bumpPushStep(CONTEXT);
	assert.deepStrictEqual(step.env, { BRANCH: "dev", TRIGGERED_SHA: "0".repeat(40) });
	// What the bump script leaves behind: a tracked manifest, modified and uncommitted.
	const bumped = bumpManifestFile(manifest);
	assert.deepStrictEqual(bumped, { from: "1.1.0", to: "1.2.0" });
	const run = runBumpStep(step.body, step.env, fx);
	assert.ok(run.ok, `the step must succeed: ${run.output}`);
	const subject = git(["log", "--format=%s", "-1", "dev"], env, origin);
	assert.match(subject, RE_BUMP_SUBJECT);
	// The identity has to come from the step: the runner has none, and `git commit` without one dies.
	assert.strictEqual(
		git(["log", "--format=%an <%ae>", "-1", "dev"], env, origin),
		"github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
	);
	assert.match(git(["show", "dev:plugins/demo/.claude-plugin/plugin.json"], env, origin), RE_VERSION_120);
});

test("the bump step loses a push race, rebases onto the moved ref and pushes", () => {
	const fx = bumpFixture();
	const { origin, manifest, env } = fx;
	const step = bumpPushStep(CONTEXT);
	const bumped = bumpManifestFile(manifest);
	assert.ok(bumped, "the fixture bumped something");
	// Somebody else lands a commit while this step is running: the first push is rejected.
	const other = path.join(path.dirname(fx.work), "other");
	git(["clone", "-q", origin, other], env);
	fs.writeFileSync(path.join(other, "NOTES.md"), "moved\n");
	git(["add", "NOTES.md"], env, other);
	git(["-c", "user.name=Other", "-c", "user.email=other@example.invalid", "commit", "-qm", "another merge"], env, other);
	git(["push", "-q", "origin", "dev"], env, other);
	const run = runBumpStep(step.body, step.env, fx);
	assert.ok(run.ok, `the retry must recover: ${run.output}`);
	assert.match(run.output, RE_PUSH_FAILED, "and say what it recovered from");
	const history = git(["log", "--format=%s", "dev"], env, origin).split("\n");
	assert.match(history[0] ?? "", RE_BUMP_SUBJECT, "the bump is on top of what moved");
	assert.strictEqual(history[1], "another merge");
});

test("a push that changed no plugin commits nothing and says so", () => {
	const fx = bumpFixture();
	const { origin, env } = fx;
	const step = bumpPushStep(CONTEXT);
	const before = git(["rev-parse", "dev"], env, origin);
	const run = runBumpStep(step.body, step.env, fx);
	assert.ok(run.ok, `nothing to bump is a success: ${run.output}`);
	assert.match(run.output, RE_NO_BUMPS);
	assert.strictEqual(git(["rev-parse", "dev"], env, origin), before, "and the branch did not move");
});
