// Unit tests for the permission policy engine (issue #53 acceptance: the policy matrix
// mode x tool x path inside or outside x bridge-path reference, option-id handling, and the
// allow-always key matching rules).
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	bridgeReferenceReason,
	decidePolicy,
	isPathWithinWorkspace,
	normalizeCommand,
	grantKeyOf,
	parsePermissionOutcome,
	PERMISSION_OPTION_IDS,
	PLAN_DENY_REASON,
	argsDifferFrom,
} from "../src/permission.ts";

const BASE = "/workspace";
const BRIDGE = "/tmp/bridge/agy-acp-deadbeefdeadbeef";
const SOCK = `${BRIDGE}/socket`;

/** The policy input for one (mode, tool, args) case, with the given in-workspace path. */
function inputFor(mode: string, toolName: string, args: Record<string, unknown>): Parameters<typeof decidePolicy>[0] {
	return {
		mode,
		toolName,
		args,
		workspaceRoots: [BASE],
		baseDir: BASE,
		bridgeDir: BRIDGE,
		socketPath: SOCK,
	};
}

const kind = (d: ReturnType<typeof decidePolicy>): string => d.kind;

test("the policy matrix (mode x tool x inside/outside x bridge reference)", () => {
	// default: only read_file inside the workspace is auto-allowed; everything else asks.
	assert.strictEqual(kind(decidePolicy(inputFor("default", "read_file", { Path: `${BASE}/a.txt` }))), "allow", "default: read_file inside");
	assert.strictEqual(kind(decidePolicy(inputFor("default", "read_file", { Path: "/etc/hostname" }))), "ask", "default: read_file outside");
	assert.strictEqual(kind(decidePolicy(inputFor("default", "read_file", {}))), "ask", "default: read_file without a Path");
	assert.strictEqual(kind(decidePolicy(inputFor("default", "run_command", { CommandLine: "touch a.txt" }))), "ask", "default: run_command");
	assert.strictEqual(
		kind(decidePolicy(inputFor("default", "write_file", { Path: `${BASE}/a.txt` }))),
		"ask",
		"default: write_file inside still asks",
	);
	assert.strictEqual(
		kind(decidePolicy(inputFor("default", "edit_file", { Path: `${BASE}/a.txt` }))),
		"ask",
		"default: edit_file inside still asks",
	);
	assert.strictEqual(kind(decidePolicy(inputFor("default", "search_web", { query: "x" }))), "ask", "default: search_web");
	assert.strictEqual(kind(decidePolicy(inputFor("default", "invoke_subagent", { Role: "x" }))), "ask", "default: invoke_subagent");
	assert.strictEqual(kind(decidePolicy(inputFor("default", "teleport_unicorn", {}))), "ask", "default: unknown tool asks");

	// accept-edits: writes and edits inside the workspace are auto-allowed (outside still asks).
	assert.strictEqual(
		kind(decidePolicy(inputFor("accept-edits", "write_file", { Path: `${BASE}/a.txt` }))),
		"allow",
		"accept-edits: write_file inside",
	);
	assert.strictEqual(
		kind(decidePolicy(inputFor("accept-edits", "edit_file", { Path: `${BASE}/a.txt` }))),
		"allow",
		"accept-edits: edit_file inside",
	);
	assert.strictEqual(
		kind(decidePolicy(inputFor("accept-edits", "write_file", { Path: "/etc/hostname" }))),
		"ask",
		"accept-edits: write_file outside",
	);
	assert.strictEqual(
		kind(decidePolicy(inputFor("accept-edits", "read_file", { Path: `${BASE}/a.txt` }))),
		"allow",
		"accept-edits: read_file inside",
	);
	assert.strictEqual(
		kind(decidePolicy(inputFor("accept-edits", "run_command", { CommandLine: "ls" }))),
		"ask",
		"accept-edits: run_command",
	);

	// plan: state-changing is denied with the exact reason; reads follow the default policy.
	const planDeny = decidePolicy(inputFor("plan", "run_command", { CommandLine: "touch a.txt" }));
	assert.strictEqual(planDeny.kind, "deny", "plan: run_command denied");
	assert.strictEqual(planDeny.kind === "deny" ? planDeny.reason : "", PLAN_DENY_REASON, "plan: the exact reason");
	assert.strictEqual(
		kind(decidePolicy(inputFor("plan", "write_file", { Path: `${BASE}/a.txt` }))),
		"deny",
		"plan: write_file inside is denied (not auto-allowed)",
	);
	assert.strictEqual(kind(decidePolicy(inputFor("plan", "edit_file", { Path: `${BASE}/a.txt` }))), "deny", "plan: edit_file denied");
	assert.strictEqual(kind(decidePolicy(inputFor("plan", "invoke_subagent", { Role: "x" }))), "deny", "plan: invoke_subagent denied");
	assert.strictEqual(
		kind(decidePolicy(inputFor("plan", "read_file", { Path: `${BASE}/a.txt` }))),
		"allow",
		"plan: read_file inside allowed",
	);
	assert.strictEqual(kind(decidePolicy(inputFor("plan", "read_file", { Path: "/etc/hostname" }))), "ask", "plan: outside read asks");
	assert.strictEqual(kind(decidePolicy(inputFor("plan", "search_web", { query: "x" }))), "ask", "plan: non-state-changing asks");
	assert.strictEqual(
		kind(decidePolicy(inputFor("plan", "teleport_unicorn", {}))),
		"ask",
		"plan: an unknown tool cannot be classified - it asks",
	);

	// bypass: everything is allowed and logged (unknown tools included).
	assert.strictEqual(kind(decidePolicy(inputFor("bypass", "run_command", { CommandLine: "rm -rf /" }))), "allow", "bypass: run_command");
	assert.strictEqual(kind(decidePolicy(inputFor("bypass", "write_file", { Path: "/etc/hostname" }))), "allow", "bypass: outside write");
	assert.strictEqual(kind(decidePolicy(inputFor("bypass", "teleport_unicorn", {}))), "allow", "bypass: unknown tool allowed too");
	assert.strictEqual(kind(decidePolicy(inputFor("bypass", "read_file", { Path: `${BASE}/a.txt` }))), "allow", "bypass: read");

	// A bridge-dir or socket reference is denied in every mode - bypass included.
	for (const mode of ["default", "accept-edits", "plan", "bypass"]) {
		const direct = decidePolicy(inputFor(mode, "read_file", { Path: `${BRIDGE}/.agents/hooks.json` }));
		assert.strictEqual(direct.kind, "deny", `${mode}: a bridge-dir Path is denied`);
		assert.match(direct.kind === "deny" ? direct.reason : "", /Do not retry this call/, `${mode}: the denial does not invite a retry`);
		const command = decidePolicy(inputFor(mode, "run_command", { CommandLine: `cat ${SOCK}` }));
		assert.strictEqual(command.kind, "deny", `${mode}: a socket reference in a command is denied`);
		const nested = decidePolicy(inputFor(mode, "run_command", { args: { list: [SOCK] } }));
		assert.strictEqual(nested.kind, "deny", `${mode}: a nested socket reference is denied`);
	}
	// And a path that merely contains the words is not a reference.
	assert.strictEqual(
		kind(decidePolicy(inputFor("default", "read_file", { Path: `${BASE}/bridge-notes.txt` }))),
		"allow",
		"a similar-sounding path is not a reference",
	);
});

test("the bridge reference reason names the reference", () => {
	const reason = bridgeReferenceReason({ Path: `${BRIDGE}/.agents/hooks.json` }, BRIDGE, SOCK);
	assert.match(reason ?? "", /permission bridge/);
	assert.match(reason ?? "", /hooks\.json/);
	assert.strictEqual(bridgeReferenceReason({ Path: `${BASE}/a.txt` }, BRIDGE, SOCK), undefined, "a plain path has no reference");
});

test("the path containment check is resolved and symlink-safe", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-policy-"));
	try {
		const file = path.join(dir, "a.txt");
		fs.writeFileSync(file, "x");
		assert.ok(isPathWithinWorkspace(file, [dir], dir), "an absolute in-workspace path");
		assert.ok(isPathWithinWorkspace("a.txt", [dir], dir), "a relative in-workspace path");
		assert.ok(!isPathWithinWorkspace("/etc/hostname", [dir], dir), "an outside path");
		assert.ok(!isPathWithinWorkspace(`${dir}/../outside.txt`, [dir], dir), "a sibling via .. is not inside");
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-policy-out-"));
		const outsideFile = path.join(outside, "b.txt");
		fs.writeFileSync(outsideFile, "y");
		const link = path.join(dir, "link-to-outside");
		fs.symlinkSync(outsideFile, link);
		assert.ok(!isPathWithinWorkspace(link, [fs.realpathSync(dir)], dir), "a symlink that points out of the workspace stays outside");
		const dirLink = path.join(dir, "dirl");
		fs.symlinkSync(dir, dirLink);
		assert.ok(
			isPathWithinWorkspace(path.join(dirLink, "a.txt"), [fs.realpathSync(dir)], dir),
			"a symlink that stays inside resolves inside",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the client options are the three exact ids, and only they are answers", () => {
	assert.deepStrictEqual(PERMISSION_OPTION_IDS, ["allow_once", "allow_always", "reject_once"]);
	assert.strictEqual(parsePermissionOutcome({ outcome: { outcome: "selected", optionId: "allow_once" } }), "allow");
	assert.strictEqual(parsePermissionOutcome({ outcome: { outcome: "selected", optionId: "allow_always" } }), "allow-always");
	assert.strictEqual(parsePermissionOutcome({ outcome: { outcome: "selected", optionId: "reject_once" } }), "reject");
	assert.strictEqual(parsePermissionOutcome({ outcome: "cancelled" }), "reject", "cancelled means deny");
	assert.strictEqual(parsePermissionOutcome({ outcome: { outcome: "selected", optionId: "maybe" } }), "reject", "an unknown id means deny");
	assert.strictEqual(parsePermissionOutcome({ outcome: { outcome: "selected" } }), "reject", "a selection without an id means deny");
	assert.strictEqual(parsePermissionOutcome("cancelled"), "reject", "a bare string means deny");
	assert.strictEqual(parsePermissionOutcome(null), "reject", "null means deny");
	assert.strictEqual(parsePermissionOutcome({ outcome: { outcome: "selected", optionId: 42 } }), "reject", "a non-string id means deny");
});

test("the allow-always key matching rules", () => {
	// run_command: the full normalised command (whitespace collapsed, no prefix truncation).
	assert.strictEqual(
		grantKeyOf("run_command", { CommandLine: "git status" }, BASE),
		grantKeyOf("run_command", { CommandLine: "git  status" }, BASE),
		"whitespace runs normalise",
	);
	assert.notStrictEqual(
		grantKeyOf("run_command", { CommandLine: "git status" }, BASE),
		grantKeyOf("run_command", { CommandLine: "git status --ignored" }, BASE),
		"a different command is a different grant",
	);
	assert.notStrictEqual(
		grantKeyOf("run_command", { CommandLine: "git status" }, BASE),
		grantKeyOf("run_command", { CommandLine: "git stash" }, BASE),
		"a different command is a different grant",
	);
	assert.strictEqual(normalizeCommand("git   status"), "git status");
	assert.strictEqual(normalizeCommand("  git status  "), "git status");
	// the key is the full normalised command: a tail difference beyond 64 chars is a different grant
	// (a prefix key would let `granted; hostile` inherit the grant).
	const longA = `a${"b".repeat(70)}c`;
	const longB = `a${"b".repeat(70)}d`;
	assert.notStrictEqual(
		grantKeyOf("run_command", { CommandLine: longA }, BASE),
		grantKeyOf("run_command", { CommandLine: longB }, BASE),
		"a tail difference is a different grant",
	);
	const wsA = `a${"b".repeat(70)}  c`;
	const wsB = `a${"b".repeat(70)}   c`;
	assert.strictEqual(
		grantKeyOf("run_command", { CommandLine: wsA }, BASE),
		grantKeyOf("run_command", { CommandLine: wsB }, BASE),
		"whitespace runs normalise even in long commands",
	);
	// file tools: the tool plus the resolved (symlink-safe) path.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-policy-grant-"));
	try {
		const a = path.join(dir, "a.txt");
		fs.writeFileSync(a, "x");
		assert.strictEqual(
			grantKeyOf("write_file", { Path: a }, dir),
			grantKeyOf("write_file", { Path: a }, dir),
			"the same path is the same grant",
		);
		assert.notStrictEqual(
			grantKeyOf("write_file", { Path: a }, dir),
			grantKeyOf("write_file", { Path: path.join(dir, "b.txt") }, dir),
			"a different path is a different grant",
		);
		assert.notStrictEqual(
			grantKeyOf("write_file", { Path: a }, dir),
			grantKeyOf("edit_file", { Path: a }, dir),
			"a different tool is a different grant",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	// everything else: the tool name alone.
	assert.strictEqual(
		grantKeyOf("search_web", { query: "a" }, BASE),
		grantKeyOf("search_web", { query: "b" }, BASE),
		"search_web grants cover all queries",
	);
	assert.strictEqual(grantKeyOf("invoke_subagent", { Role: "a" }, BASE), "invoke_subagent");
});

test("argsDifferFrom: order-insensitive on the stream's keys; extra hook-side keys are metadata, not a rewrite", () => {
	assert.strictEqual(argsDifferFrom({ CommandLine: "ls" }, { CommandLine: "ls" }), false, "equal");
	assert.strictEqual(argsDifferFrom({ a: 1, b: 2 }, { b: 2, a: 1 }), false, "key order is irrelevant");
	assert.strictEqual(argsDifferFrom({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }), false, "nested key order is irrelevant");
	assert.strictEqual(argsDifferFrom({ a: 1 }, { a: 1, toolSummary: "a" }), false, "an extra hook-side key (agy metadata) is not a rewrite");
	assert.strictEqual(argsDifferFrom({ CommandLine: "ls" }, { CommandLine: "ls -la" }), true, "a value difference is a rewrite");
	assert.strictEqual(
		argsDifferFrom({ CommandLine: "ls", WaitMs: 5 }, { CommandLine: "ls" }),
		true,
		"a stream key missing from the hook's args is a rewrite",
	);
	assert.strictEqual(argsDifferFrom({}, { CommandLine: "ls" }), false, "no stream keys: nothing to differ on");
	assert.strictEqual(argsDifferFrom(undefined, { CommandLine: "ls" }), false, "an undefined stream is treated as no keys");
	assert.strictEqual(argsDifferFrom({ a: [1, 2] }, { a: [2, 1] }), true, "array order is meaningful");
});
