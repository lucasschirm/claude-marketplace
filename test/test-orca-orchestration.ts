import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import ext from "../extensions/orca-orchestration.ts";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function testRunner(pi: ExtensionAPI): void {
	const registeredTools = new Map<string, any>();
	let registeredCommand: any = null;
	let registeredFlag: any = null;
	const sentMessages: Array<{ content: string; options?: any }> = [];

	// Create temporary mock orca CLI
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-orca-test-"));
	const mockOrcaBin = path.join(tmpDir, "orca");

	const mockScript = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);

// orchestration check --wait
if (args[0] === 'orchestration' && args[1] === 'check' && args.includes('--wait')) {
  // Emit keepalive
  console.log(JSON.stringify({ _keepalive: true }));
  // Emit worker_done message delivery
  const delivery = {
    ok: true,
    result: {
      deliveryId: 'del-mock-1',
      messages: [
        {
          id: 'msg-done-1',
          type: 'worker_done',
          dispatchId: 'ctx-mock-1',
          taskId: 'task-mock-1',
          outcome: 'succeeded',
          summary: 'Unit tests passed successfully.',
          filesModified: ['src/index.ts']
        }
      ]
    }
  };
  console.log(JSON.stringify(delivery));
  process.exit(0);
}

// orchestration run-current
if (args[0] === 'orchestration' && args[1] === 'run-current') {
  console.log(JSON.stringify({ ok: true, result: { run: null } }));
  process.exit(0);
}

// orchestration run-create
if (args[0] === 'orchestration' && args[1] === 'run-create') {
  console.log(JSON.stringify({ ok: true, id: 'run-mock-100', result: { run: { id: 'run-mock-100', objective: 'Test objective' } } }));
  process.exit(0);
}

// orchestration worker-start
if (args[0] === 'orchestration' && args[1] === 'worker-start') {
  console.log(JSON.stringify({
    ok: true,
    result: {
      dispatchId: 'ctx-mock-1',
      taskId: 'task-mock-1',
      terminalHandle: 'term-mock-1'
    }
  }));
  process.exit(0);
}

// orchestration worker-list
if (args[0] === 'orchestration' && args[1] === 'worker-list') {
  console.log(JSON.stringify({
    ok: true,
    result: {
      workers: [
        {
          dispatchId: 'ctx-mock-1',
          taskId: 'task-mock-1',
          runId: 'run-mock-100',
          terminalState: 'active',
          projection: {
            stage: { worker: 'running' },
            outcome: null,
            liveness: { verdict: 'live' }
          }
        }
      ]
    }
  }));
  process.exit(0);
}

// orchestration worker-read
if (args[0] === 'orchestration' && args[1] === 'worker-read') {
  console.log(JSON.stringify({
    ok: true,
    result: {
      dispatchId: 'ctx-mock-1',
      source: 'terminal',
      terminal: {
        tail: [
          'Line 1: Worker initializing...',
          'Line 2: Running test suite...',
          'Line 3: All tests passed.'
        ]
      }
    }
  }));
  process.exit(0);
}

// orchestration worker-show
if (args[0] === 'orchestration' && args[1] === 'worker-show') {
  console.log(JSON.stringify({
    ok: true,
    result: {
      dispatchId: 'ctx-mock-1',
      projection: {
        stage: { worker: 'succeeded' },
        outcome: 'succeeded',
        attention: { categories: [] }
      }
    }
  }));
  process.exit(0);
}

// orchestration reply
if (args[0] === 'orchestration' && args[1] === 'reply') {
  console.log(JSON.stringify({ ok: true, result: { replied: true } }));
  process.exit(0);
}

// orchestration run-list
if (args[0] === 'orchestration' && args[1] === 'run-list') {
  console.log(JSON.stringify({
    ok: true,
    result: {
      runs: [
        {
          id: 'run-mock-100',
          objective: 'Test objective',
          coordinator_handle: 'term-mock-1'
        }
      ]
    }
  }));
  process.exit(0);
}

// orchestration run-show
if (args[0] === 'orchestration' && args[1] === 'run-show') {
  console.log(JSON.stringify({
    ok: true,
    result: {
      run: {
        id: 'run-mock-100',
        objective: 'Test objective'
      }
    }
  }));
  process.exit(0);
}

// default fallback
console.log(JSON.stringify({ ok: true, result: {} }));
`;

	fs.writeFileSync(mockOrcaBin, mockScript, { mode: 0o755 });
	process.env.ORCA_BIN = mockOrcaBin;

	let eventListeners: Record<string, Function[]> = {};

	const mockPi = {
		...pi,
		on(event: string, handler: any) {
			if (!eventListeners[event]) eventListeners[event] = [];
			eventListeners[event].push(handler);
			return pi.on(event, handler);
		},
		registerTool(t: any) {
			registeredTools.set(t.name, t);
			return pi.registerTool(t);
		},
		registerCommand(name: string, opts: any) {
			if (name === "orchestration") registeredCommand = { name, ...opts };
			return pi.registerCommand(name, opts);
		},
		registerFlag(name: string, opts: any) {
			if (name === "orca-observer-interval") registeredFlag = { name, ...opts };
			return pi.registerFlag(name, opts);
		},
		getFlag: pi.getFlag.bind(pi),
		getActiveTools: pi.getActiveTools.bind(pi),
		setActiveTools: pi.setActiveTools.bind(pi),
		sendUserMessage(content: string, options?: any) {
			sentMessages.push({ content, options });
			return pi.sendUserMessage(content, options);
		},
	};

	ext(mockPi);

	pi.on("session_start", async (_event, ctx) => {
		console.log("=== Testing Orca Orchestration Extension ===");

		try {
			// 1. Verify Tool Registrations
			console.log("Test 1: Verifying registered tools...");
			const expectedTools = [
				"orca_orchestration_dispatch",
				"orca_orchestration_observe",
				"orca_orchestration_status",
				"orca_orchestration_reply",
				"orca_orchestration_release",
			];
			for (const t of expectedTools) {
				assert.ok(registeredTools.has(t), `Expected tool ${t} to be registered`);
			}
			console.log("✓ All expected tools are registered:", expectedTools);

			// 2. Verify Command and Flag
			console.log("Test 2: Verifying command and flag registration...");
			assert.ok(registeredCommand, "Command /orchestration should be registered");
			assert.ok(registeredFlag, "Flag --orca-observer-interval should be registered");
			console.log("✓ Command /orchestration and CLI flag verified");

			// Mock context
			let currentStatus: string | undefined;
			let notifiedMessages: string[] = [];
			const mockCtx = {
				cwd: ctx.cwd,
				mode: "tui" as const,
				hasUI: true,
				ui: {
					setStatus: (_key: string, text?: string) => {
						currentStatus = text;
					},
					notify: (msg: string) => {
						notifiedMessages.push(msg);
					},
					custom: async () => {},
				},
				sessionManager: {
					getSessionId: () => "test-session",
				},
			} as unknown as ExtensionToolContext;

			// 3. Test before_agent_start Prompt Augmentation
			console.log("Test 3: Testing prompt augmentation...");
			const beforeAgentStartHandlers = eventListeners["before_agent_start"] || [];
			assert.ok(beforeAgentStartHandlers.length > 0, "before_agent_start handler registered");
			const dummyEvent = {
				systemPrompt: "You are an assistant.",
				systemPromptOptions: {
					sections: {} as Record<string, string>,
					promptGuidelines: [] as string[],
				},
			};
			beforeAgentStartHandlers[0](dummyEvent);
			assert.ok(
				dummyEvent.systemPromptOptions.sections.orca_auto_observation,
				"Expected orca_auto_observation section in systemPromptOptions",
			);
			console.log("✓ Prompt guideline correctly injected");

			// 4. Test orca_orchestration_dispatch Tool Execution
			console.log("Test 4: Testing orca_orchestration_dispatch execution...");
			const dispatchTool = registeredTools.get("orca_orchestration_dispatch")!;
			const dispatchRes = await dispatchTool.execute(
				"call-disp-1",
				{
					spec: "Implement database migration and tests",
					objective: "Improve test suite",
					agent: "codex",
				},
				undefined,
				undefined,
				mockCtx,
			);
			assert.strictEqual(dispatchRes.isError, undefined);
			assert.match(dispatchRes.content[0].text, /Worker successfully dispatched/);
			assert.match(dispatchRes.content[0].text, /Dispatch ID: ctx-mock-1/);
			console.log("✓ orchestration_dispatch dispatched worker and returned receipt");

			// 5. Test Background Check & Steer Message Delivery
			console.log("Test 5: Testing background check message receipt and steer delivery...");
			// Wait briefly for mock orca check child process to stream worker_done
			await new Promise((resolve) => setTimeout(resolve, 1500));

			const steerMsg = sentMessages.find((m) => m.content.includes("finished with outcome 'SUCCEEDED'"));
			assert.ok(steerMsg, "Expected steer notification for worker completion");
			assert.strictEqual(steerMsg.options?.deliverAs, "steer");
			assert.match(steerMsg.content, /Unit tests passed successfully/);
			console.log("✓ Worker completion steer message successfully delivered to agent");

			// 6. Test orca_orchestration_status
			console.log("Test 6: Testing orca_orchestration_status inspection...");
			const statusTool = registeredTools.get("orca_orchestration_status")!;

			// 6a. Single dispatch status
			const statusRes = await statusTool.execute(
				"call-stat-1",
				{ dispatch_id: "ctx-mock-1" },
				undefined,
				undefined,
				mockCtx,
			);
			assert.match(statusRes.content[0].text, /Dispatch ctx-mock-1 Status/);
			assert.match(statusRes.content[0].text, /Outcome: succeeded/);
			assert.ok(!statusRes.content[0].text.includes("[object Object]"), "Status must not contain [object Object]");

			// 6b. Worker output reading
			const outputRes = await statusTool.execute(
				"call-stat-2",
				{ dispatch_id: "ctx-mock-1", read_output: true },
				undefined,
				undefined,
				mockCtx,
			);
			assert.match(outputRes.content[0].text, /Line 1: Worker initializing/);
			assert.match(outputRes.content[0].text, /Line 3: All tests passed/);
			assert.ok(!outputRes.content[0].text.includes("[object Object]"), "Output read must not contain [object Object]");

			// 6c. Overview status
			const overviewRes = await statusTool.execute(
				"call-stat-3",
				{},
				undefined,
				undefined,
				mockCtx,
			);
			assert.match(overviewRes.content[0].text, /Active Run: run-mock-100/);
			assert.ok(!overviewRes.content[0].text.includes("[object Object]"), "Overview must not contain [object Object]");

			// 6d. All runs/workers across sessions
			const allStatusRes = await statusTool.execute(
				"call-stat-4",
				{ all: true },
				undefined,
				undefined,
				mockCtx,
			);
			assert.match(allStatusRes.content[0].text, /All Orchestration Runs & Workers Across Sessions/);
			assert.match(allStatusRes.content[0].text, /run-mock-100/);
			console.log("✓ orca_orchestration_status returned accurate, safely formatted output without [object Object]");

			// 7. Test orca_orchestration_reply
			console.log("Test 7: Testing orca_orchestration_reply...");
			const replyTool = registeredTools.get("orca_orchestration_reply")!;
			const replyRes = await replyTool.execute(
				"call-rep-1",
				{ message_id: "msg-q-1", answer: "Proceed with Option B" },
				undefined,
				undefined,
				mockCtx,
			);
			assert.match(replyRes.content[0].text, /Reply sent successfully/);
			console.log("✓ orca_orchestration_reply executed successfully");

			// 8. Test orca_orchestration_release
			console.log("Test 8: Testing orca_orchestration_release...");
			const releaseTool = registeredTools.get("orca_orchestration_release")!;
			const releaseRes = await releaseTool.execute(
				"call-rel-1",
				{ dispatch_id: "ctx-mock-1" },
				undefined,
				undefined,
				mockCtx,
			);
			assert.match(releaseRes.content[0].text, /Worker terminal for dispatch ctx-mock-1 has been successfully released/);
			console.log("✓ orca_orchestration_release released worker terminal");

			// 9. Test orca_orchestration_observe Tool
			console.log("Test 9: Testing orca_orchestration_observe status reporting...");
			const observeTool = registeredTools.get("orca_orchestration_observe")!;
			const observeRes = await observeTool.execute("call-obs-1", {}, undefined, undefined, mockCtx);
			assert.match(observeRes.content[0].text, /Orca Orchestration Observer: Active/);

			// 9b. Test observe with all: true
			const observeAllRes = await observeTool.execute("call-obs-2", { all: true }, undefined, undefined, mockCtx);
			assert.match(observeAllRes.content[0].text, /All Orchestration Runs & Workers Across Sessions/);

			// 9c. Test observe with a specific run_id having 0 workers to verify guidance
			const zeroObserveRes = await observeTool.execute("call-obs-4", { run_id: "run-empty" }, undefined, undefined, mockCtx);
			assert.match(zeroObserveRes.content[0].text, /If this run was started by another session you can manually start observing it by passing the parameters 'run_id'/);
			console.log("✓ orca_orchestration_observe reported accurate status and guidance");

			// 10. Test Command Subcommands
			console.log("Test 10: Testing /orchestration command handler...");
			await registeredCommand.handler("status", mockCtx);
			assert.ok(
				notifiedMessages.some((m) => m.includes("Orca Orchestration")),
				"Notification sent for /orchestration status",
			);
			console.log("✓ /orchestration command handler verified");

			console.log("\n✓ ALL ORCA ORCHESTRATION EXTENSION TESTS PASSED SUCCESSFULLY!");

			// Clean up temp dir
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {}

			process.exit(0);
		} catch (err: any) {
			console.error("\n❌ TEST FAILED:", err);
			try {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			} catch {}
			process.exit(1);
		}
	});
}
