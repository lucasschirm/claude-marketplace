// Lifecycle tests for the devin-delegate extension using a fake `devin acp`
// binary (no real Devin account required).
//
// Run: pi -ne -e test/test-devin-delegate-lifecycle.ts --offline -p "test"
//
// T1+T2: a turn longer than the old 60s timeout must complete (idle) with the
//        streamed assistant chunks captured (regression: issue #16)
// T3:    devin_cancel mid-turn must kill the process (no orphans)
// T4:    a process death mid-turn must mark interrupted (not failed), and
//        devin_restart must start a working follow-up turn
// T5:    an out-of-vocab model (swe-2-max) must not fail the session and the
//        redundant set_config_option(model) call must not be made
// T6:    recovery reconciliation: dead-pid -> interrupted; live-pid -> killed + interrupted
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ext from "../extensions/devin-delegate.ts";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function testRunner(pi: ExtensionAPI): void {
	const registeredTools = new Map<string, any>();
	const mockPi = {
		...pi,
		registerTool(t: any) {
			registeredTools.set(t.name, t);
			return pi.registerTool(t);
		},
	};

	const here = path.dirname(fileURLToPath(import.meta.url));
	const binDir = path.join(here, ".fake-devin-bin");
	const markerDir = path.join(os.tmpdir(), `devin-fake-markers-${Date.now()}`);

	// --- Fake `devin` on PATH (created before ext() so isCommandAvailable sees it)
	fs.mkdirSync(binDir, { recursive: true });
	const devinShim = path.join(binDir, "devin");
	fs.writeFileSync(
		devinShim,
		`#!/bin/sh
if [ "$1" = "acp" ]; then
  exec node "${path.join(here, "fake-acp-server.mjs")}" "$@"
fi
exit 0
`,
	);
	fs.chmodSync(devinShim, 0o755);
	process.env.PATH = `${binDir}:${process.env.PATH}`;
	process.env.FAKE_MARKER_DIR = markerDir;
	process.env.FAKE_DELAY_MS = "70000";
	process.env.FAKE_EXIT_EARLY_MS = "0";

	const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

	// --- T6 fixture: plant a persisted state (dead pid + live pid) before the
	// extension's session_start handler runs recoverState.
	let fixtureLivePid = 0;
	let realPiSessionId = "unknown";
	let fixturePlanted = false;
	pi.on("session_start", (_e, ctx: any) => {
		realPiSessionId = ctx.sessionManager?.getSessionId?.() || "unknown";
		if (fixturePlanted) return;
		fixturePlanted = true;
		// Live process to be treated as an orphan by recovery. argv[0] is labelled
		// "devin-fake" (via bash's exec -a; dash lacks it) so the kill-path's
		// cmdline identity check accepts it — a bare `sleep 300` would be refused
		// as a non-devin process (and a dead pid that gets reused must stay refused).
		const sleeper = spawn("bash", ["-c", "exec -a devin-fake sleep 300"], { detached: true, stdio: "ignore" });
		sleeper.unref();
		fixtureLivePid = sleeper.pid || 0;

		const dir = path.join(os.homedir(), ".pi", "agent", "devin_delegate", realPiSessionId);
		fs.mkdirSync(dir, { recursive: true });
		const metaDead: any = {
			sessionId: "rec-dead-1",
			queueId: "q-d",
			prompt: "fixture dead",
			model: "swe-2-high",
			mode: "dangerous",
			status: "running",
			createdAt: Date.now() - 3600_000,
			startedAt: Date.now() - 3600_000,
			lastMessageTime: Date.now() - 3600_000,
			pid: 999999, // dead
		};
		const metaLive: any = { ...metaDead, sessionId: "rec-live-1", pid: fixtureLivePid };
		fs.mkdirSync(path.join(dir, "rec-dead-1"), { recursive: true });
		fs.writeFileSync(path.join(dir, "rec-dead-1", "meta.json"), JSON.stringify(metaDead));
		fs.mkdirSync(path.join(dir, "rec-live-1"), { recursive: true });
		fs.writeFileSync(path.join(dir, "rec-live-1", "meta.json"), JSON.stringify(metaLive));
		fs.writeFileSync(
			path.join(dir, "state.json"),
			JSON.stringify({ maxRuns: 2, totalInvoked: 2, totalCompleted: 0, queue: [], sessionIds: ["rec-dead-1", "rec-live-1"] }),
		);
	});

	ext(mockPi);

	// Poll devin_status until the session reaches `want` or `timeoutMs` elapses.
	async function waitForStatus(
		statusTool: any,
		mockCtx: any,
		sessionId: string,
		want: string,
		timeoutMs: number,
	): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		let last = "unknown";
		while (Date.now() < deadline) {
			const res = await statusTool.execute("poll", { session_id: sessionId }, undefined, undefined, mockCtx);
			const text: string = res.content[0].text;
			const m = text.match(/\(Status: (\w+)/);
			last = m ? m[1].toLowerCase() : "unknown";
			if (last === want) return last;
			await sleepMs(2000);
		}
		return last;
	}

	pi.on("session_start", async (_event, ctx) => {
		const mockCtx = {
			cwd: ctx.cwd,
			mode: "tui" as const,
			hasUI: true,
			ui: {
				setStatus: () => {},
				notify: () => {},
				custom: async () => {},
			},
			sessionManager: { getSessionId: () => realPiSessionId },
		} as any;

		const delegateTool = registeredTools.get("devin_delegate")!;
		const statusTool = registeredTools.get("devin_status")!;
		const cancelTool = registeredTools.get("devin_cancel")!;
		const restartTool = registeredTools.get("devin_restart")!;
		const created: string[] = [];

		console.log("=== Devin Delegate LIFECYCLE tests (fake acp) ===");

		try {
			// ---------- T6 (recovery reconciliation; ran on session_start) ----------
			console.log("T6: recovery reconciliation (planted dead-pid + live-pid running sessions)...");
			await sleepMs(3000); // allow async dead-pid backfill to settle
			const recDead = await statusTool.execute("t6a", { session_id: "rec-dead-1" }, undefined, undefined, mockCtx);
			assert.match(recDead.content[0].text, /interrupted/, "dead-pid session must be interrupted");
			const recLive = await statusTool.execute("t6b", { session_id: "rec-live-1" }, undefined, undefined, mockCtx);
			assert.match(recLive.content[0].text, /interrupted/, "live-pid (orphaned) session must be interrupted");
			let orphanAlive = true;
			try {
				process.kill(fixtureLivePid, 0);
			} catch {
				orphanAlive = false;
			}
			assert.strictEqual(orphanAlive, false, "orphaned devin process must be terminated on recovery");
			console.log("✓ T6 recovery: dead->interrupted, orphan killed+interrupted");

			// ---------- T1+T2 (turn > 60s completes; chunks captured) ----------
			console.log("T1: starting a 70s turn (exceeds old 60s timeout)...");
			process.env.FAKE_DELAY_MS = "70000";
			process.env.FAKE_EXIT_EARLY_MS = "0";
			const t1 = await delegateTool.execute("t1", { prompt: "long running task", model: "swe-2-high", mode: "dangerous", create_worktree: false }, undefined, undefined, mockCtx);
			assert.match(t1.content[0].text, /^Your session started with id: /);
			const t1Id = t1.content[0].text.replace("Your session started with id: ", "").trim();
			created.push(t1Id);

			// At +70s (old behavior: failed at +60s) the session must be idle.
			const t1Status = await waitForStatus(statusTool, mockCtx, t1Id, "idle", 120_000);
			assert.strictEqual(t1Status, "idle", `T1 session must be idle after long turn (was ${t1Status})`);
			const t1Meta = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "devin_delegate", realPiSessionId, t1Id, "meta.json"), "utf-8"));
			assert.strictEqual(t1Meta.status, "idle");
			assert.strictEqual(t1Meta.error, undefined, "T1 must not be marked failed");
			console.log("✓ T1: 70s turn completed idle (no false 60s failure)");

			// T2: streamed chunks must be captured as assistant output
			const t2 = await statusTool.execute("t2", { session_id: t1Id, complete: true }, undefined, undefined, mockCtx);
			assert.match(t2.content[0].text, /Working on it:/, "T2: streamed chunk must be captured");
			assert.match(t2.content[0].text, /Final answer from fake devin\./, "T2: final assistant output must be captured");
			const events = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "devin_delegate", realPiSessionId, t1Id, "events.jsonl"), "utf-8").split("\n");
			assert.ok(events.some((l) => l.includes('"usage_update"')), "T2: usage_update must be logged");
			assert.ok(events.some((l) => l.includes('"tool_call"')), "T2: tool_call must be logged");
			console.log("✓ T2: chunks/tool/usage observability captured");

			// ---------- T3 (cancel mid-turn kills the process) ----------
			console.log("T3: cancelling a 30s turn mid-way...");
			process.env.FAKE_DELAY_MS = "30000";
			const t3 = await delegateTool.execute("t3", { prompt: "task to cancel", model: "swe-2-high", mode: "dangerous", create_worktree: false }, undefined, undefined, mockCtx);
			const t3Id = t3.content[0].text.replace("Your session started with id: ", "").trim();
			created.push(t3Id);
			await sleepMs(5000);
			const t3c = await cancelTool.execute("t3c", { session_id: t3Id }, undefined, undefined, mockCtx);
			assert.match(t3c.content[0].text, /was cancelled/);
			await sleepMs(3000); // SIGKILL fallback is +1.5s
			const t3Meta = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "devin_delegate", realPiSessionId, t3Id, "meta.json"), "utf-8"));
			let t3alive = true;
			try {
				process.kill(t3Meta.pid, 0);
			} catch {
				t3alive = false;
			}
			assert.strictEqual(t3alive, false, "T3: cancelled session's devin process must be terminated (no orphans)");
			const t3s = await statusTool.execute("t3s", { session_id: t3Id }, undefined, undefined, mockCtx);
			assert.match(t3s.content[0].text, /cancelled/);
			console.log("✓ T3: cancel mid-turn killed the process, no orphans");

			// ---------- T4 (process death mid-turn -> interrupted; restart works) ----------
			console.log("T4: process dies mid-turn (exit 42 at +4s)...");
			process.env.FAKE_DELAY_MS = "30000";
			process.env.FAKE_EXIT_EARLY_MS = "4000";
			const t4 = await delegateTool.execute("t4", { prompt: "task that dies", model: "swe-2-high", mode: "dangerous", create_worktree: false }, undefined, undefined, mockCtx);
			const t4Id = t4.content[0].text.replace("Your session started with id: ", "").trim();
			created.push(t4Id);
			const t4Status = await waitForStatus(statusTool, mockCtx, t4Id, "interrupted", 30_000);
			assert.strictEqual(t4Status, "interrupted", `T4 must be interrupted (was ${t4Status})`);
			const t4Meta = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "devin_delegate", realPiSessionId, t4Id, "meta.json"), "utf-8"));
			assert.notStrictEqual(t4Meta.status, "failed", "T4: process death must not be marked failed");
			assert.match(t4Meta.error || "", /code 42/);
			console.log("✓ T4: mid-turn process death -> interrupted (not failed)");

			console.log("T4b: restarting the interrupted session...");
			process.env.FAKE_EXIT_EARLY_MS = "0";
			process.env.FAKE_DELAY_MS = "5000";
			const t4r = await restartTool.execute("t4r", { session_id: t4Id, prompt: "retry the task" }, undefined, undefined, mockCtx);
			assert.match(t4r.content[0].text, /^Your session was restarted with id: /);
			const t4rId = t4r.content[0].text.replace("Your session was restarted with id: ", "").trim();
			created.push(t4rId);
			const t4rStatus = await waitForStatus(statusTool, mockCtx, t4rId, "idle", 30_000);
			assert.strictEqual(t4rStatus, "idle", `T4b restarted session must be idle (was ${t4rStatus})`);
			console.log("✓ T4b: restart after interruption completes a fresh turn");

			// ---------- T4c (clean exit code 0 mid-turn -> idle, NOT overwritten to failed) ----------
			console.log("T4c: process exits cleanly (code 0) mid-turn...");
			process.env.FAKE_DELAY_MS = "30000";
			process.env.FAKE_EXIT_EARLY_MS = "4000";
			process.env.FAKE_EXIT_CODE = "0";
			const t4c = await delegateTool.execute("t4c", { prompt: "task that exits cleanly", model: "swe-2-high", mode: "dangerous", create_worktree: false }, undefined, undefined, mockCtx);
			const t4cId = t4c.content[0].text.replace("Your session started with id: ", "").trim();
			created.push(t4cId);
			const t4cStatus = await waitForStatus(statusTool, mockCtx, t4cId, "idle", 30_000);
			assert.strictEqual(t4cStatus, "idle", `T4c clean exit must be idle, not failed (was ${t4cStatus})`);
			const t4cMeta = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "devin_delegate", realPiSessionId, t4cId, "meta.json"), "utf-8"));
			assert.notStrictEqual(t4cMeta.status, "failed", "T4c: clean exit must not be marked failed by the prompt catch path");
			process.env.FAKE_EXIT_CODE = "42";
			console.log("✓ T4c: clean exit code 0 mid-turn -> idle (no false failed)");

			// ---------- T5 (out-of-vocab model: no set_config_option, no failure) ----------
			console.log("T5: delegating with out-of-vocab model swe-2-max...");
			try {
				fs.rmSync(path.join(markerDir, "set_config_option_model"), { force: true });
			} catch {}
			process.env.FAKE_DELAY_MS = "5000";
			process.env.FAKE_EXIT_EARLY_MS = "0";
			process.env.FAKE_EXIT_CODE = "42";
			const t5 = await delegateTool.execute("t5", { prompt: "task with swe-2-max", model: "swe-2-max", mode: "dangerous", create_worktree: false }, undefined, undefined, mockCtx);
			const t5Id = t5.content[0].text.replace("Your session started with id: ", "").trim();
			created.push(t5Id);
			const t5Status = await waitForStatus(statusTool, mockCtx, t5Id, "idle", 30_000);
			assert.strictEqual(t5Status, "idle", `T5 must be idle (was ${t5Status})`);
			assert.strictEqual(fs.existsSync(path.join(markerDir, "set_config_option_model")), false, "T5: redundant set_config_option(model) must not be called");
			console.log("✓ T5: out-of-vocab model works via --model spawn flag, no set_config_option call");

			// Clean up
			for (const id of created) {
				try {
					await cancelTool.execute(`clean-${id}`, { session_id: id }, undefined, undefined, mockCtx);
				} catch {}
			}
			await sleepMs(2000);
			console.log("\n✓ ALL DEVIN DELEGATE LIFECYCLE TESTS PASSED\n");
			process.exit(0);
		} catch (err: any) {
			console.error("\n❌ Lifecycle test failure:", err);
			for (const id of created) {
				try {
					await cancelTool.execute(`clean-${id}`, { session_id: id }, undefined, undefined, {} as any);
				} catch {}
			}
			process.exit(1);
		}
	});
}
