// Queue, concurrency and permission tests for the devin-delegate extension, on a fake `devin acp`
// (test/fake-acp-server.mjs), so no Devin account is needed and CI can run it.
//
// Run: pi -ne -e test/test-devin-delegate-queue.ts --offline -p "test"
//
// Regression (2026-10-22): an agent delegated 6 sessions with mode "auto". Every session froze on
// its first session/request_permission, which the extension never answered, so 2 frozen sessions
// held both slots and the status line read 0/6/0 until the 30-minute stall watchdog fired. When
// the queue did drain, it started every queued task at once (peak 8 in flight against a limit of 2).
//
// Q1: 6 parallel devin_delegate calls -> 2 start, 4 queue, never more than 2 turns in flight
// Q2: a permission request reaches the agent and devin_permission answers it
// Q3: an unanswered permission request is rejected automatically after the timeout
// Q4: mode "auto" maps to Devin's "smart", an unknown mode is refused, restart can override the mode
// Q5: a request the extension does not implement gets a JSON-RPC error instead of silence
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ext from "../extensions/devin-delegate.ts";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

export default function testRunner(pi: ExtensionAPI): void {
	const registeredTools = new Map<string, any>();
	const agentMessages: string[] = [];
	const statusLines: string[] = [];
	let permissionTimeoutMinutes = "1";
	const mockPi = {
		...pi,
		registerTool(t: any) {
			registeredTools.set(t.name, t);
			return pi.registerTool(t);
		},
		// Record notifications instead of steering the real pi agent, which would act on them.
		sendUserMessage(content: any, _opts?: any) {
			agentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
		},
		getFlag(name: string) {
			if (name === "devin-permission-timeout") return permissionTimeoutMinutes;
			return pi.getFlag(name);
		},
	};

	const here = path.dirname(fileURLToPath(import.meta.url));
	const binDir = path.join(here, ".fake-devin-bin");
	const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-queue-markers-"));

	// Fake `devin` on PATH (created before ext() so isCommandAvailable sees it)
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

	function fakeEnv(env: Record<string, string>): void {
		const defaults = {
			FAKE_DELAY_MS: "2000",
			FAKE_EXIT_EARLY_MS: "0",
			FAKE_NEW_DELAY_MS: "0",
			FAKE_PERMISSION: "0",
			FAKE_UNKNOWN_REQUEST: "0",
		};
		Object.assign(process.env, defaults, env);
	}

	const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const turnsInFlight = () => fs.readdirSync(markerDir).filter((f) => f.startsWith("turn-")).length;

	async function waitFor(what: string, cond: () => boolean, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (cond()) return;
			await sleepMs(100);
		}
		assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
	}

	ext(mockPi as ExtensionAPI);

	pi.on("session_start", async (_event, ctx) => {
		const piSessionId = ctx.sessionManager?.getSessionId?.() || "unknown";
		const mockCtx = {
			cwd: ctx.cwd,
			mode: "tui" as const,
			hasUI: true,
			ui: { setStatus: (_k: string, text?: string) => text && statusLines.push(text), notify: () => {}, custom: async () => {} },
			sessionManager: { getSessionId: () => piSessionId },
		} as any;
		const call = (name: string, params: any) =>
			registeredTools.get(name)!.execute(`${name}-${Date.now()}`, params, undefined, undefined, mockCtx);
		const text = (res: any): string => res.content[0].text;
		const startedId = (res: any): string =>
			text(res)
				.replace(/^Your (restarted )?session (started|was restarted) with id: /, "")
				.trim();
		const doneCount = () => agentMessages.filter((m) => / is done\./.test(m)).length;
		const created: string[] = [];

		console.log("=== Devin Delegate QUEUE tests (fake acp) ===");
		try {
			// ---------- Q1: concurrency limit holds under a burst of parallel calls ----------
			console.log("Q1: 6 parallel devin_delegate calls against a limit of 2...");
			// A slow session/new widens the window in which a started session is not yet registered.
			fakeEnv({ FAKE_NEW_DELAY_MS: "1500", FAKE_DELAY_MS: "2500" });
			let peak = 0;
			const sampler = setInterval(() => {
				peak = Math.max(peak, turnsInFlight());
			}, 25);
			const results = await Promise.all(
				Array.from({ length: 6 }, (_, i) => call("devin_delegate", { prompt: `burst task ${i}`, model: "swe-2-high", mode: "dangerous" })),
			);
			const started = results.filter((r) => /^Your session started with id: /.test(text(r)));
			const queued = results.filter((r) => /^Your session was queued as /.test(text(r)));
			for (const r of started) created.push(startedId(r));
			assert.strictEqual(started.length, 2, `2 sessions must start immediately, got ${started.length}: ${results.map(text).join(" | ")}`);
			assert.strictEqual(queued.length, 4, `4 sessions must queue, got ${queued.length}`);
			await waitFor("all 6 burst sessions to finish", () => doneCount() >= 6, 90_000);
			clearInterval(sampler);
			assert.ok(peak <= 2, `never more than 2 turns in flight (peak was ${peak})`);
			assert.strictEqual(peak, 2, "the 2 slots must actually be used");
			const dequeued = agentMessages.filter((m) => /^Your session started with id: /.test(m));
			assert.strictEqual(dequeued.length, 4, "each queued task must report its session id when it starts");
			for (const m of dequeued) created.push(startedId({ content: [{ text: m }] }));
			assert.ok(
				statusLines.some((s) => /^Devin 2\/2 · 4 queued/.test(s)),
				`status line must show slot use and queue depth (saw: ${[...new Set(statusLines)].slice(0, 6).join(" | ")})`,
			);
			console.log(`✓ Q1: 2 started, 4 queued, peak ${peak} in flight, all 6 completed`);

			// ---------- Q2: permission request -> agent -> devin_permission ----------
			console.log("Q2: a permission request is forwarded and answered...");
			fakeEnv({ FAKE_PERMISSION: "1" });
			permissionTimeoutMinutes = "1";
			const q2 = await call("devin_delegate", { prompt: "needs a shell command", model: "swe-2-high", mode: "smart" });
			const q2Id = startedId(q2);
			created.push(q2Id);
			await waitFor("the permission notice", () => agentMessages.some((m) => m.includes(`${q2Id} is waiting for permission`)), 15_000);
			const notice = agentMessages.find((m) => m.includes(`${q2Id} is waiting for permission`))!;
			assert.match(notice, /rg -l table-access-policy/, "the notice must show the command Devin wants to run");
			const q2Status = text(await call("devin_status", { session_id: q2Id }));
			assert.match(q2Status, /awaiting permission/i, `devin_status must show the pending request (got: ${q2Status})`);
			assert.ok(
				statusLines.some((s) => /1 awaiting permission/.test(s)),
				"the status line must count the session awaiting permission",
			);
			const answer = await call("devin_permission", { session_id: q2Id, decision: "allow" });
			assert.ok(!answer.isError, `devin_permission must succeed (got: ${text(answer)})`);
			await waitFor("the allowed turn to finish", () => agentMessages.some((m) => m.startsWith(`The session ${q2Id} is done.`)), 15_000);
			const q2Transcript = text(await call("devin_status", { session_id: q2Id, complete: true }));
			assert.match(q2Transcript, /Permission outcome: allow_once\./);
			const again = await call("devin_permission", { session_id: q2Id, decision: "allow" });
			assert.ok(again.isError, "answering when nothing is pending must be an error");
			console.log("✓ Q2: forwarded, shown in status, answered allow_once, turn completed");

			// ---------- Q3: unanswered permission request times out to a rejection ----------
			console.log("Q3: an unanswered permission request is rejected automatically...");
			fakeEnv({ FAKE_PERMISSION: "1" });
			permissionTimeoutMinutes = "0.05"; // 3 seconds
			const q3 = await call("devin_delegate", { prompt: "nobody answers", model: "swe-2-high", mode: "accept-edits" });
			const q3Id = startedId(q3);
			created.push(q3Id);
			await waitFor("the timed-out turn to finish", () => agentMessages.some((m) => m.startsWith(`The session ${q3Id} is done.`)), 20_000);
			const q3Transcript = text(await call("devin_status", { session_id: q3Id, complete: true }));
			assert.match(q3Transcript, /Permission outcome: reject_once\./);
			assert.ok(
				agentMessages.some((m) => m.includes(q3Id) && /rejected automatically/.test(m)),
				"the agent must be told the request was rejected automatically",
			);
			permissionTimeoutMinutes = "1";
			console.log("✓ Q3: rejected after the timeout, turn completed instead of hanging");

			// ---------- Q4: mode vocabulary ----------
			console.log("Q4: mode aliases and validation...");
			fakeEnv({ FAKE_DELAY_MS: "500" });
			const q4 = await call("devin_delegate", { prompt: "auto mode", model: "swe-2-high", mode: "auto" });
			const q4Id = startedId(q4);
			created.push(q4Id);
			await waitFor("set_mode smart", () => fs.existsSync(path.join(markerDir, "set_mode-smart")), 10_000);
			assert.strictEqual(fs.existsSync(path.join(markerDir, "set_mode-auto")), false, '"auto" must not reach Devin, which ignores it');
			const bad = await call("devin_delegate", { prompt: "bad mode", model: "swe-2-high", mode: "yolo" });
			assert.ok(bad.isError, "an unknown mode must be refused");
			assert.match(text(bad), /dangerous/, "the refusal must list the valid modes");
			await waitFor("the auto-mode turn to finish", () => agentMessages.some((m) => m.startsWith(`The session ${q4Id} is done.`)), 15_000);
			// An idle session keeps its process for follow-ups; a restart needs it cancelled first.
			await call("devin_cancel", { session_id: q4Id });
			const restarted = await call("devin_restart", { session_id: q4Id, mode: "dangerous" });
			assert.match(text(restarted), /^Your session was restarted with id: /, text(restarted));
			created.push(startedId(restarted));
			await waitFor("set_mode bypass", () => fs.existsSync(path.join(markerDir, "set_mode-bypass")), 10_000);
			console.log("✓ Q4: auto -> smart, unknown mode refused, restart mode override applied");

			// ---------- Q5: unimplemented client methods are answered with an error ----------
			console.log("Q5: an unimplemented request gets a JSON-RPC error...");
			fakeEnv({ FAKE_UNKNOWN_REQUEST: "1", FAKE_DELAY_MS: "500" });
			const q5 = await call("devin_delegate", { prompt: "unknown request", model: "swe-2-high", mode: "dangerous" });
			created.push(startedId(q5));
			const responseFile = path.join(markerDir, "response-unknown-1");
			await waitFor("a response to the unknown request", () => fs.existsSync(responseFile), 10_000);
			const response = JSON.parse(fs.readFileSync(responseFile, "utf-8"));
			assert.strictEqual(response.error?.code, -32601, `expected method-not-found, got ${JSON.stringify(response)}`);
			console.log("✓ Q5: unimplemented request answered with -32601");

			for (const id of created) {
				try {
					await call("devin_cancel", { session_id: id });
				} catch {}
			}
			await sleepMs(2000);
			console.log("\n✓ ALL DEVIN DELEGATE QUEUE TESTS PASSED\n");
			process.exit(0);
		} catch (err: any) {
			console.error("\n❌ Queue test failure:", err);
			for (const id of created) {
				try {
					await call("devin_cancel", { session_id: id });
				} catch {}
			}
			process.exit(1);
		}
	});
}
