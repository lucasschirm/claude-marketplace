// Run with: node --test test/test-delegate-cli-guard.ts
import { test } from "node:test";
import assert from "node:assert";
import { cliBlockReason, findBlockedCliCommand } from "../extensions/lib/delegate/bash-guard.ts";
import { guardedClis } from "../extensions/lib/delegate/registry.ts";

// The guard takes the names to watch from the driver registry, so the test names them too. `devin` is
// the driver with `blocksOwnCli`; a test that hardcoded the list would pass when a driver flipped the
// capability off.
const GUARDED = ["devin"];

const blocked = [
	"devin",
	"devin -p 'fix the tests' --model swe-2-high",
	"devin -p x --permission-mode dangerous --respect-workspace-trust false",
	"devin --prompt-file /tmp/prompt.md --model glm-5-3-flash-max",
	"devin -c",
	"devin -r abc123",
	"devin acp",
	"devin rm abc",
	"devin models",
	"devin ls extra-positional",
	"devin -p x --help",
	"/home/lucas/.local/bin/devin -p x",
	"./devin -p x",
	"cd repo && devin -p x",
	"cd repo; devin -p x",
	"false || devin -p x",
	"echo hi | devin -p x",
	"devin -p x &",
	"devin -p x > out.txt 2>&1",
	"2>/dev/null devin -p x",
	"DEVIN_MODEL=swe-2-max devin -p x",
	"A=1 B=2 devin -p x",
	"sudo devin -p x",
	"env FOO=1 devin -p x",
	"env -u HOME devin -p x",
	"nohup devin -p x &",
	"timeout 600 devin -p x",
	"time devin -p x",
	"command devin -p x",
	"exec devin -p x",
	"echo prompt | xargs devin -p",
	"(devin -p x)",
	"{ devin -p x; }",
	"if true; then devin -p x; fi",
	"echo $(devin -p x)",
	"echo `devin -p x`",
	'echo "result: $(devin -p x)"',
	"bash -c 'devin -p x'",
	'sh -c "cd /tmp && devin -p x"',
	"bash -lc 'devin -p x'",
	"sudo bash -c 'devin -p x'",
	"bash -c \"bash -c 'devin -p x'\"",
	"eval 'devin -p x'",
	"eval devin -p x",
	"find . -name '*.md' -exec devin -p x {} \\;",
	"devin\\\n -p x",
	"d\\evin -p x",
	"'devin' -p x",
	'"devin" -p x',
	"cat <<EOF | bash\nnot reached\nEOF\ndevin -p x",
	"echo a\ndevin -p x",
	"devin.exe -p x",
];

const allowed = [
	"devin models list",
	"devin models list | grep Free",
	"devin models list --json",
	"devin models list 2>&1 | head",
	"devin models list > /tmp/models.txt",
	"devin ls",
	"devin list",
	"devin ls --all",
	"devin version",
	"devin help",
	"devin --version",
	"devin -V",
	"devin --help",
	"devin -h",
	"devin models --help",
	"/home/lucas/.local/bin/devin models list",
	"cd repo && devin ls",
	"which devin",
	"command -v devin",
	"type devin",
	"ls ~/.config/devin",
	"cat ~/.config/devin/config.json",
	"grep -rn devin README.md",
	"echo devin",
	"echo 'run devin -p x later'",
	"git commit -m 'Add devin delegate'",
	"git log --oneline -- extensions/devin-delegate.ts",
	"devinp",
	"mydevin -p x",
	"npm run devin-test",
	"pgrep -af devin",
	"# devin -p x",
	"echo ok # devin -p x",
	"cat > notes.md <<'EOF'\ndevin -p 'a prompt in a heredoc'\nEOF",
	"cat <<-EOF\n\tdevin -p x\n\tEOF\necho done",
	"cat <<EOF\ndevin -p x\nEOF",
	"cat <<< 'devin -p x'",
	"find . -name devin",
	"echo $(date)",
	'echo "$(git rev-parse HEAD)"',
	"ls 2>&1 | wc -l",
	"",
];

test("blocks every direct devin invocation that is not read-only", () => {
	for (const command of blocked) {
		assert.ok(findBlockedCliCommand(command, GUARDED), `expected to block: ${JSON.stringify(command)}`);
	}
});

test("allows read-only devin subcommands and unrelated commands", () => {
	for (const command of allowed) {
		assert.strictEqual(
			findBlockedCliCommand(command, GUARDED),
			undefined,
			`expected to allow: ${JSON.stringify(command)} (flagged: ${findBlockedCliCommand(command, GUARDED)})`,
		);
	}
});

test("reports the offending command", () => {
	assert.strictEqual(findBlockedCliCommand("cd repo && devin -p x --model m", GUARDED), "devin -p x --model m");
	assert.strictEqual(findBlockedCliCommand("echo hi; sudo devin -p x", GUARDED), "devin -p x");
});

test("fails closed on pathologically nested commands", () => {
	let command = "devin -p x";
	for (let i = 0; i < 12; i++) command = `bash -c '${command.replace(/'/g, "'\\''")}'`;
	assert.ok(findBlockedCliCommand(command, GUARDED));
});

test("the guarded list is the registry's, and Claude is deliberately not on it", () => {
	// `claude` is the operator's own CLI: blocking it would break the host to protect a queue
	// (see the note in drivers/devin.ts). If this assertion starts failing, that decision was changed
	// and the note has to change with it.
	assert.deepEqual(guardedClis(), ["devin"]);
	assert.strictEqual(findBlockedCliCommand("claude -p 'fix it'", guardedClis()), undefined);
	// A second agent's CLI is guarded when its driver says so, by name and not by assumption.
	assert.ok(findBlockedCliCommand("otheragent -p x", ["otheragent"]));
});

test("the block reason names the binaries actually blocked", () => {
	const reason = cliBlockReason(["devin"]);
	assert.match(reason, /devin/);
	assert.match(reason, /delegate_task/);
	assert.ok(!reason.includes("claude"), "the reason must not promise tools for agents that are not blocked");
});

test("read-only verbs of any guarded CLI stay allowed", () => {
	for (const cmd of ["devin --version", "devin models list", "devin auth status", "otheragent --help"]) {
		const name = cmd.split(" ")[0];
		assert.strictEqual(findBlockedCliCommand(cmd, [name]), undefined, cmd);
	}
});
