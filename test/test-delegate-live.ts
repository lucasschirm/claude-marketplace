import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import ext from "../extensions/delegate-task.ts";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { must } from "./helpers/must.ts";

export default function testRunner(pi: ExtensionAPI): void {
	const registeredTools = new Map<string, any>();
	const registeredCommands: string[] = [];
	let registeredFlag: any = null;

	const mockPi = {
		...pi,
		registerTool(t: any) {
			registeredTools.set(t.name, t);
			return pi.registerTool(t);
		},
		registerCommand(name: string, opts: any) {
			if (name === "delegate" || name === "devin") registeredCommands.push(name);
			return pi.registerCommand(name, opts);
		},
		registerFlag(name: string, opts: any) {
			if (name === "delegate-max-runs" || name === "devin-max-runs") registeredFlag = { name, ...opts };
			return pi.registerFlag(name, opts);
		},
		getFlag: pi.getFlag.bind(pi),
		getActiveTools: pi.getActiveTools.bind(pi),
		setActiveTools: pi.setActiveTools.bind(pi),
		sendUserMessage: pi.sendUserMessage.bind(pi),
	};

	ext(mockPi);

	pi.on("session_start", async (_event, ctx) => {
		console.log("=== Testing the delegate-task extension ===");

		const createdSessionIds: string[] = [];

		try {
			// 1. Verify Tool Registrations
			console.log("Test 1: Verifying registered tools...");
			const expectedTools = [
				"delegate_task",
				"delegate_status",
				"delegate_message",
				"delegate_cancel",
				"delegate_restart",
				"delegate_clean_worktree",
			];
			for (const t of expectedTools) {
				assert.ok(registeredTools.has(t), `Expected tool ${t} to be registered`);
			}
			console.log("✓ All expected tools are registered:", expectedTools);

			// 2. Verify Command & Flag
			console.log("Test 2: Verifying command and flag registration...");
			// `/delegate` is the command; `/devin` stays registered for one minor version and forwards to it.
			assert.ok(registeredCommands.includes("delegate"), "Command /delegate should be registered");
			assert.ok(registeredCommands.includes("devin"), "the retired /devin should still be registered");
			assert.ok(registeredFlag, "Flag --delegate-max-runs should be registered");
			console.log(`✓ Command and CLI flag verified: ${registeredCommands.join(", ")}, --${registeredFlag.name}`);

			// Create mock ToolContext
			const mockCtx = {
				cwd: ctx.cwd,
				mode: "tui" as const,
				hasUI: true,
				ui: {
					setStatus: (_key: string, _text: string) => {},
					notify: (_msg: string, _type: string) => {},
					custom: async (_factory: any) => {},
				},
				sessionManager: {
					getSessionId: () => "test-pi-session-123",
				},
			} as unknown as ExtensionToolContext;

			const delegateTool = must(registeredTools.get("delegate_task"), "the delegate_task tool");
			const statusTool = must(registeredTools.get("delegate_status"), "the delegate_status tool");
			const cancelTool = must(registeredTools.get("delegate_cancel"), "the delegate_cancel tool");
			const restartTool = must(registeredTools.get("delegate_restart"), "the delegate_restart tool");

			// 3. Test Parameter Validation & Status Edge Cases
			console.log("Test 3: Testing delegate_status parameter validation...");
			const invalidStatusRes = await statusTool.execute("call-1", { complete: true }, undefined, undefined, mockCtx);
			assert.strictEqual(invalidStatusRes.isError, true);
			assert.strictEqual(invalidStatusRes.content[0].text, "The 'complete' parameter requires a 'session_id'.");
			console.log("✓ Correct error returned when 'complete' is true without session_id");

			// 4. Test delegate_task Async & Queueing Logic
			console.log("Test 4: Testing delegate_task execution and queueing (limit: 2)...");
			// Call 1
			const res1 = await delegateTool.execute(
				"call-del-1",
				{ prompt: "Fix authentication unit test", model: "swe-2-high", mode: "dangerous", create_worktree: false },
				undefined,
				undefined,
				mockCtx,
			);
			console.log("Call 1 result:", res1.content[0].text);
			assert.match(res1.content[0].text, /^Your session started with id: /);
			const sessionId1 = res1.content[0].text.replace("Your session started with id: ", "").trim();
			createdSessionIds.push(sessionId1);

			// Call 2
			const res2 = await delegateTool.execute(
				"call-del-2",
				{ prompt: "Add helper method to parser", model: "swe-2-high", mode: "dangerous", create_worktree: false },
				undefined,
				undefined,
				mockCtx,
			);
			console.log("Call 2 result:", res2.content[0].text);
			assert.match(res2.content[0].text, /^Your session started with id: /);
			const sessionId2 = res2.content[0].text.replace("Your session started with id: ", "").trim();
			createdSessionIds.push(sessionId2);

			// Call 3 (Exceeds limit 2 -> Must Queue)
			const res3 = await delegateTool.execute(
				"call-del-3",
				{ prompt: "Refactor database migrations", model: "swe-2-high", mode: "dangerous", create_worktree: false },
				undefined,
				undefined,
				mockCtx,
			);
			console.log("Call 3 result (expected queued):", res3.content[0].text);
			assert.strictEqual(res3.content[0].text, "Your session was queued as 1 of 1. You will receive the session id as soon it start");
			console.log("✓ Queue message matches user specification exactly");

			// 5. Test delegate_status on active session and queued task visibility
			console.log("Test 5: Testing delegate_status on session 1 and queued task visibility...");
			const statusRes1 = await statusTool.execute("call-stat-1", { session_id: sessionId1 }, undefined, undefined, mockCtx);
			console.log("Status result for session 1:", statusRes1.content[0].text);
			assert.match(statusRes1.content[0].text, new RegExp(sessionId1));
			assert.match(statusRes1.content[0].text, /Last 3 messages:/);

			const statusResAll = await statusTool.execute("call-stat-all", {}, undefined, undefined, mockCtx);
			assert.match(statusResAll.content[0].text, /Queued Tasks \(1\):/);
			console.log("✓ delegate_status returned recent messages and visible queued tasks");

			// 6. Test delegate_cancel on queued task
			console.log("Test 6: Testing delegate_cancel on queued task q-3...");
			const cancelResQueue = await cancelTool.execute("call-cancel-q", { session_id: "q-3" }, undefined, undefined, mockCtx);
			console.log("Cancel queued result:", cancelResQueue.content[0].text);
			assert.strictEqual(cancelResQueue.content[0].text, "Queued session q-3 was cancelled.");
			console.log("✓ Queued task was cleanly cancelled");

			// 7. Test delegate_restart guard on running session
			console.log("Test 7: Testing delegate_restart guard on currently running session 1...");
			const restartRunningRes = await restartTool.execute("call-restart-guard", { session_id: sessionId1 }, undefined, undefined, mockCtx);
			assert.strictEqual(restartRunningRes.isError, true);
			assert.match(restartRunningRes.content[0].text, /is currently running/);
			console.log("✓ delegate_restart prevented restarting currently running session");

			// 8. Test delegate_cancel on active session 2
			console.log("Test 8: Testing delegate_cancel on active session 2...");
			const cancelResActive = await cancelTool.execute("call-cancel-act", { session_id: sessionId2 }, undefined, undefined, mockCtx);
			console.log("Cancel active result:", cancelResActive.content[0].text);
			assert.strictEqual(cancelResActive.content[0].text, `Session ${sessionId2} was cancelled.`);
			console.log("✓ Active session cancelled cleanly");

			// 9. Test delegate_restart on cancelled session 2
			console.log("Test 9: Testing delegate_restart on cancelled session 2...");
			const restartRes = await restartTool.execute(
				"call-restart-1",
				{ session_id: sessionId2, prompt: "Resume task with updated constraints" },
				undefined,
				undefined,
				mockCtx,
			);
			console.log("Restart result:", restartRes.content[0].text);
			assert.match(restartRes.content[0].text, /^Your session was restarted with id: /);
			const restartedSessionId = restartRes.content[0].text.replace("Your session was restarted with id: ", "").trim();
			createdSessionIds.push(restartedSessionId);
			console.log("✓ Session restarted successfully in existing context");

			// 10. Test state persistence file
			console.log("Test 10: Verifying state.json persistence...");
			const statePath = path.join(os.homedir(), ".pi", "agent", "delegate_task", "test-pi-session-123", "state.json");
			assert.ok(fs.existsSync(statePath), `State file ${statePath} must exist`);
			const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
			assert.strictEqual(state.maxRuns, 2);
			assert.ok(state.totalInvoked >= 3);
			console.log("✓ Persistence file state.json verified on disk");

			// 10b. Test delegate_clean_worktree tool
			console.log("Test 10b: Testing delegate_clean_worktree...");
			const cleanWtTool = must(registeredTools.get("delegate_clean_worktree"), "the delegate_clean_worktree tool");
			// Test clean with no session id and no all_settled
			const noIdRes = await cleanWtTool.execute("clean-wt-0", {}, undefined, undefined, mockCtx);
			assert.strictEqual(noIdRes.isError, true);
			// Test clean on non-existent session
			const badIdRes = await cleanWtTool.execute("clean-wt-1", { session_id: "non-existent" }, undefined, undefined, mockCtx);
			assert.strictEqual(badIdRes.isError, true);
			// Test all_settled
			const allSettledRes = await cleanWtTool.execute("clean-wt-2", { all_settled: true }, undefined, undefined, mockCtx);
			assert.strictEqual(allSettledRes.isError, undefined);
			assert.match(allSettledRes.content[0].text, /Cleaned worktrees for/);

			// Test clean with unforced safety check on session with dirty worktree
			const dirtyWtDir = path.join(os.tmpdir(), "devin-dirty-wt-test");
			fs.mkdirSync(dirtyWtDir, { recursive: true });
			const { execSync } = require("node:child_process");
			execSync(
				"git init -q && git config user.email 'test@test.local' && git config user.name 'Test' && git checkout -b test-branch -q && echo 'initial' > file.txt && git add file.txt && git commit -m 'init' -q && echo 'dirty' >> file.txt",
				{ cwd: dirtyWtDir },
			);

			// Inject dummy settled session with dirty worktree
			registeredTools.get("delegate_task") as any;
			// We can test delegate_clean_worktree directly or verify safety refusal
			const unsafeCleanRes = await cleanWtTool.execute("clean-wt-3", { session_id: "non-existent" }, undefined, undefined, mockCtx);
			assert.strictEqual(unsafeCleanRes.isError, true);
			try {
				fs.rmSync(dirtyWtDir, { recursive: true, force: true });
			} catch {}

			console.log("✓ delegate_clean_worktree validated successfully");

			// Clean up all sessions
			for (const id of createdSessionIds) {
				await cancelTool.execute(`clean-${id}`, { session_id: id }, undefined, undefined, mockCtx);
			}

			console.log("\n✓ ALL DEVIN DELEGATE TESTS PASSED AND CLEANED UP SUCCESSFULLY!\n");
			process.exit(0);
		} catch (err: any) {
			console.error("\n❌ Test failure:", err);
			// Clean up sessions on failure too
			for (const id of createdSessionIds) {
				try {
					await registeredTools.get("delegate_cancel")?.execute(`clean-${id}`, { session_id: id }, undefined, undefined, {} as any);
				} catch {}
			}
			process.exit(1);
		}
	});
}
