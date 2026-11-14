// Run with: node --test test/test-delegate-process.ts
//
// Killing a pid recorded some time ago is a claim about the world, and the world recycles pids. These
// are the two directions that matter: it is gone and we must not care, or it is somebody else's and we
// must not shoot.
import { test } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { driverCli, isPidAlive, killProcessGroup } from "../extensions/lib/delegate/process.ts";

function spawnSleeped(seconds = 60): { pid: number; exited: Promise<number | null> } {
	const child = spawn("sleep", [String(seconds)], { detached: process.platform !== "win32", stdio: "ignore" });
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	return { pid: child.pid as number, exited };
}

async function untilGone(pid: number, timeoutMs = 4000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 25));
	}
	return !isPidAlive(pid);
}

test("a live pid is alive and a made-up one is not", () => {
	assert.equal(isPidAlive(process.pid), true);
	assert.equal(isPidAlive(2_147_483_000), false);
});

test("the CLI a driver wraps comes from the driver, not from a hardcoded name", () => {
	assert.equal(driverCli("devin"), "devin");
	assert.equal(driverCli("claude"), "claude");
	assert.equal(driverCli("no-such-agent"), undefined);
});

test("the pids that are lethal are never probed and never killed", () => {
	// `kill(0)` signals this process's own group, and `kill(-1)` — what negating a recorded `1` reaches —
	// signals every process the user may signal. Node reports both as success, so a liveness check calls them
	// alive and the recycle guard reads `/proc/0/cmdline`, fails, and stands aside. A record can carry any of
	// them: a corrupt `state.json`, a hand-edit, a value that never came from a spawn.
	const warnings: string[] = [];
	for (const pid of [-1, 0, 1, 1.5, Number.NaN, 2 ** 53]) {
		assert.strictEqual(isPidAlive(pid), false, `pid ${pid} is not a live process`);
		killProcessGroup(pid, "agy", (m) => warnings.push(m));
	}
	assert.strictEqual(warnings.length, 6, `each refusal says so: ${warnings.join(" | ")}`);
	// Killing pi itself by way of a recorded pid is the same mistake.
	killProcessGroup(process.pid, "agy", (m) => warnings.push(m));
	assert.strictEqual(warnings.length, 7, "pi's own pid is not a kill target");
});

test("a recorded pid that is not the agent's process is left alone", async (t) => {
	if (process.platform !== "linux") {
		t.skip("the recycle guard reads /proc, which is Linux-only");
		return;
	}
	const { pid } = spawnSleeped();
	const warnings: string[] = [];
	try {
		// Somebody else's process, reached through a pid we believed. The guard must refuse, warn, and
		// leave it running — killing an unrelated process is worse than leaking one.
		killProcessGroup(pid, "devin", (m) => warnings.push(m));
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(isPidAlive(pid), true, "the pid was not a devin process and must still be there");
		assert.match(warnings.join("\n"), /refusing to kill pid/);
		assert.match(warnings.join("\n"), /pid reuse/);
	} finally {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
	}
});

test("when the name matches, the group actually dies", async () => {
	const { pid } = spawnSleeped();
	assert.equal(isPidAlive(pid), true);
	// `sleep` is in this process's cmdline, so the guard lets the kill through.
	killProcessGroup(pid, "sleep");
	assert.equal(await untilGone(pid), true);
});

test("killing something already gone is not an error", () => {
	const warnings: string[] = [];
	killProcessGroup(2_147_483_001, undefined, (m) => warnings.push(m));
	assert.deepEqual(warnings, [], "nothing happened, so nothing was worth saying");
});
