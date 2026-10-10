// Run with: node --test test/test-devin-tui-safety.ts
import { test } from "node:test";
import * as assert from "node:assert";
import { stripAnsi, extractCliError } from "../extensions/lib/devin-diagnostics.ts";

// --- stripAnsi ---

test("stripAnsi removes CSI sequences", () => {
	assert.equal(stripAnsi("\x1b[31mred\x1b[0m plain"), "red plain");
	assert.equal(stripAnsi("\x1b[1;32m bold-green \x1b[39m"), " bold-green ");
});

test("stripAnsi removes extended CSI forms", () => {
	// Colon-style SGR (24-bit color)
	assert.equal(stripAnsi("\x1b[38:2:255:0:0mred\x1b[0m"), "red");
	// Private parameter markers
	assert.equal(stripAnsi("\x1b[>4;2mfoo"), "foo");
	// Intermediate bytes (DECSTR / DECSCUSR)
	assert.equal(stripAnsi("\x1b[!pDECSTR\x1b[0 qDECSCUSR"), "DECSTRDECSCUSR");
	// Non-alpha final bytes
	assert.equal(stripAnsi("\x1b[38;5;198 m ok"), " ok"); // CSI: params 38;5;198, intermediate ' ', final 'm'
	assert.equal(stripAnsi("a\x1b[0 ba"), "aa"); // \x1b[0 b is a valid CSI (param 0, intermediate ' ', final 'b')
});

test("stripAnsi removes other ESC sequences and lone ESC", () => {
	assert.equal(stripAnsi("\x1b=keypad"), "keypad"); // keypad mode
	assert.equal(stripAnsi("\x1b>shift"), "shift"); // keypad mode
	assert.equal(stripAnsi("\x1b7save"), "save"); // save cursor
	assert.equal(stripAnsi("\x1bMscroll"), "scroll"); // reverse index
	assert.equal(stripAnsi("\x1bcRIS"), "RIS"); // reset
	assert.equal(stripAnsi("dangling\x1b"), "dangling"); // lone trailing ESC
});

test("stripAnsi removes DCS/PM/APC sequences", () => {
	assert.equal(stripAnsi("a\x1bPDCS payload\x1b\\b"), "ab");
	assert.equal(stripAnsi("a\x1bXso- payload\x1b\\b"), "ab");
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

test("extractCliError parses string-form error payloads", () => {
	const err: any = new Error("Command failed: orca");
	err.stdout = '{"ok":false,"error":"something went wrong"}';
	assert.equal(extractCliError(err), "something went wrong");
});

test("extractCliError inspects stdout when stderr is whitespace-only", () => {
	const err: any = new Error("Command failed: orca");
	err.stderr = " \n";
	err.stdout = '{"ok":false,"error":{"message":"real cause"}}';
	assert.equal(extractCliError(err), "real cause");
});

test("extractCliError preserves the stack for internal errors", () => {
	try {
		throw new Error("Failed to persist state");
	} catch (err) {
		const out = extractCliError(err as Error);
		assert.match(out, /Failed to persist state/);
		assert.match(out, /extractCliError|at /); // stack frames present
	}
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
