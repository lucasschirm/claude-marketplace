// Run with: node --test test/test-delegate-process.ts
//
// Killing a pid recorded some time ago is a claim about the world, and the world recycles pids. These
// are the two directions that matter: it is gone and we must not care, or it is somebody else's and we
// must not shoot.
import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { waitFor } from "./helpers/poll.ts";
import { driverCli, isPidAlive, killProcessGroup } from "../extensions/lib/delegate/process.ts";

function spawnSleeped(seconds = 60): { pid: number; exited: Promise<number | null> } {
	const child = spawn("sleep", [String(seconds)], { detached: process.platform !== "win32", stdio: "ignore" });
	const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
	return { pid: child.pid as number, exited };
}

/**
 * Wait until the child has finished `exec`, so `/proc/<pid>/cmdline` really describes it.
 *
 * Both kill tests need this. A pid forked a moment ago still reports its parent's command line, and the
 * recycle guard reads that file to decide whether the process is the agent it was recorded as. Killing
 * immediately after `spawn` therefore asks the guard a question it cannot answer — and the two tests want
 * opposite answers from it, so the race shows up as one of them failing under load and neither failing alone.
 */
function execdRead(pid: number, needle: string): () => true | null {
	return () => {
		try {
			return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(needle) ? true : null;
		} catch (err: any) {
			if (err?.code === "ENOENT" || err?.code === "EPERM") {
				// Genuinely unreadable: still mid-exec, or already gone.
				return null;
			}
			// Anything else is a bug in this helper. Swallowing it — as an earlier version did with a missing
			// `fs` import — turns two assertions into a wait that always ends in failure.
			throw err;
		}
	};
}

async function untilExecd(pid: number, needle: string, timeoutMs = 3000): Promise<boolean> {
	if (process.platform !== "linux") {
		// The guard only reads `/proc` on Linux, so nothing there waits for the exec.
		return true;
	}
	try {
		await waitFor(execdRead(pid, needle), timeoutMs);
		return true;
	} catch (err: any) {
		if (String(err?.message ?? "").startsWith("timed out after")) {
			return false;
		}
		throw err;
	}
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
		assert.ok(await untilExecd(pid, "sleep"), "the child became `sleep` before the guard was asked about it");
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
	assert.ok(await untilExecd(pid, "sleep"), "the child became `sleep` before the guard was asked about it");
	// `sleep` is in this process's cmdline, so the guard lets the kill through.
	killProcessGroup(pid, "sleep");
	assert.equal(await untilGone(pid), true);
});

test("killing something already gone is not an error", () => {
	const warnings: string[] = [];
	killProcessGroup(2_147_483_001, undefined, (m) => warnings.push(m));
	assert.deepEqual(warnings, [], "nothing happened, so nothing was worth saying");
});
