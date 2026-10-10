// Run with: node --test test/test-devin-tui-safety.ts
import { test } from "node:test";
import * as assert from "node:assert";
import { stripAnsi, extractCliError } from "../extensions/lib/devin-diagnostics.ts";

// --- stripAnsi ---

test("stripAnsi removes CSI sequences", () => {
	assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
	assert.equal(stripAnsi("\x1b[1;32m bold-green \x1b[39m"), " bold-green ");
});

test("stripAnsi removes OSC sequences (BEL and ST terminated)", () => {
	assert.equal(stripAnsi("before\x1b]0;window title\x07after"), "beforeafter");
	assert.equal(stripAnsi("before\x1b]2;title\x1b\\after"), "beforeafter");
});

test("stripAnsi removes charset designations", () => {
	assert.equal(stripAnsi("\x1b(Btext\x1b(B"), "text");
});

test("stripAnsi leaves plain text untouched", () => {
	assert.equal(stripAnsi("no escapes\nnew line"), "no escapes\nnew line");
});

// --- extractCliError ---

test("extractCliError parses orca ok:false JSON from stdout", () => {
	// Replicates real orca behavior: exit 1, empty stderr, ok:false JSON on stdout.
	const err: any = new Error("Command failed: orca worktree create --name x --base-branch y --json");
	err.stdout =
		'{"ok":false,"error":{"code":"runtime_error","message":"Command failed: git worktree add --no-track -b x /path/x y\\nfatal: invalid reference: y"}}';
	err.stderr = "";
	const out = extractCliError(err);
	assert.match(out, /invalid reference: y/);
	assert.doesNotMatch(out, /^Command failed: orca/);
});

test("extractCliError prefers stderr when present", () => {
	const err: any = new Error("Command failed: git worktree add ...");
	err.stdout = "Preparing worktree (new branch 'x')";
	err.stderr = "fatal: a branch named 'x' already exists";
	const out = extractCliError(err);
	assert.match(out, /a branch named 'x' already exists/);
});

test("extractCliError falls back to the generic message", () => {
	const err: any = new Error("Command failed: orca worktree create --name x --json");
	assert.match(extractCliError(err), /Command failed: orca/);
});

test("extractCliError handles non-error values", () => {
	assert.equal(extractCliError("plain string"), "plain string");
	assert.match(extractCliError(undefined), /undefined/);
});

test("extractCliError ignores a non-failure JSON payload", () => {
	const err: any = new Error("Command failed: orca");
	err.stdout = '{"ok":true,"result":{"worktree":{"path":"/x"}}}';
	// ok:true has no error.message -> falls back to the generic message.
	assert.match(extractCliError(err), /Command failed: orca/);
});

test("extractCliError strips ANSI and flattens whitespace", () => {
	const err: any = new Error("boom");
	err.stderr = "\x1b[31mError:\n  something\n  bad\x1b[0m";
	const out = extractCliError(err);
	assert.equal(out, "Error: something bad");
});

test("extractCliError truncates long output", () => {
	const err: any = new Error("boom");
	err.stderr = "x".repeat(1000);
	assert.equal(extractCliError(err).length, 300);
});
