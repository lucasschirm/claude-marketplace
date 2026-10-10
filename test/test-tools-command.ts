import type { ExtensionAPI, ToolInfo, Theme } from "@earendil-works/pi-coding-agent";
import toolsExtension, { ToolsManagerComponent, formatParamSchema } from "../extensions/tools.ts";

function assert(condition: boolean, msg: string) {
	if (!condition) {
		console.error("FAIL:", msg);
		process.exit(1);
	}
	console.log("✓", msg);
}

// Mock theme
const mockTheme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `**${text}**`,
	italic: (text: string) => `*${text}*`,
	underline: (text: string) => `_${text}_`,
	strikethrough: (text: string) => `~~${text}~~`,
} as any;

const sampleTools: ToolInfo[] = [
	{
		name: "read",
		description: "Read the contents of a file.\nSupports offsets and limits.",
		parameters: {
			type: "object",
			required: ["path"],
			properties: {
				path: {
					type: "string",
					description: "Path to file",
				},
				offset: {
					type: "number",
					description: "Line number offset",
					default: 1,
				},
			},
		},
		exposure: "direct",
		sourceInfo: { source: "built-in" },
	},
	{
		name: "bash",
		description: "Execute bash commands in session environment",
		parameters: {
			type: "object",
			required: ["command"],
			properties: {
				command: {
					type: "string",
					description: "Bash command string",
				},
			},
		},
		exposure: "direct",
		sourceInfo: { source: "built-in" },
	},
	{
		name: "devin_delegate",
		description: "Delegate tasks to Devin coding agent",
		parameters: {
			type: "object",
			required: ["prompt"],
			properties: {
				prompt: {
					type: "string",
					description: "Prompt for Devin",
				},
				mode: {
					type: "string",
					enum: ["safe", "dangerous"],
					description: "Execution mode",
				},
			},
		},
		exposure: "direct",
		sourceInfo: { source: "extension" },
	},
];

export default function testToolsExtension(pi: ExtensionAPI) {
	console.log("=== Testing Tools Extension ===");

	// 1. Test formatParamSchema helper
	console.log("Test 1: Testing formatParamSchema formatting...");
	const formattedParam = formatParamSchema(
		"mode",
		{ type: "string", enum: ["safe", "dangerous"], description: "Execution mode" },
		true,
		mockTheme,
		80
	);
	assert(formattedParam.length > 0, "formatParamSchema returns formatted lines");
	assert(formattedParam.some(l => l.includes("mode") && l.includes("[required]")), "Includes param name and required flag");
	assert(formattedParam.some(l => l.includes("Allowed values")), "Includes allowed enum values");

	// 2. Test ToolsManagerComponent list and details navigation
	console.log("Test 2: Testing ToolsManagerComponent navigation and actions...");
	const enabled = new Set<string>(["read", "bash"]);
	let toggledTool: string | undefined;
	let toggledState: boolean | undefined;
	let closed = false;

	const comp = new ToolsManagerComponent(
		sampleTools,
		enabled,
		mockTheme,
		(t, s) => {
			toggledTool = t;
			toggledState = s;
		},
		() => {
			closed = true;
		}
	);

	assert(comp.getViewMode() === "list", "Initial view mode is 'list'");
	assert(comp.getSelectedIndex() === 0, "Initial selectedIndex is 0");
	assert(comp.getSelectedTool()?.name === "read", "Initial selected tool is 'read'");

	// Render list view
	const listLines = comp.render(80);
	assert(listLines.length > 5, "List view renders lines");
	assert(listLines.some(l => l.includes("Tools & Extensions Configuration")), "Renders header");
	assert(listLines.some(l => l.includes("[● ENABLED]  **read**")), "Renders enabled read tool");
	assert(listLines.some(l => l.includes("[○ DISABLED] devin_delegate")), "Renders disabled devin_delegate");

	// Move down
	comp.handleInput("\x1b[B"); // down arrow
	assert(comp.getSelectedIndex() === 1, "Down arrow advances index to 1");
	assert(comp.getSelectedTool()?.name === "bash", "Selected tool is now 'bash'");

	// Toggle disable on bash
	comp.handleInput(" ");
	assert(toggledTool === "bash" && toggledState === false, "Space toggles tool to disabled");
	assert(!enabled.has("bash"), "Tool removed from enabled set");

	// Move down to devin_delegate and toggle enable
	comp.handleInput("\x1b[B"); // down arrow
	assert(comp.getSelectedTool()?.name === "devin_delegate", "Selected tool is now 'devin_delegate'");
	comp.handleInput(" ");
	assert(toggledTool === "devin_delegate" && toggledState === true, "Space toggles tool to enabled");
	assert(enabled.has("devin_delegate"), "Tool added to enabled set");

	// Switch to details view (Right arrow)
	comp.handleInput("\x1b[C"); // right arrow
	assert(comp.getViewMode() === "details", "Right arrow switches to 'details' view");

	const detailLines = comp.render(80);
	assert(detailLines.some(l => l.includes("Tool Details: devin_delegate")), "Details view header displays tool name");
	assert(detailLines.some(l => l.includes("Parameters:")), "Details view displays Parameters section");
	assert(detailLines.some(l => l.includes("prompt")), "Details view displays prompt parameter");
	assert(detailLines.some(l => l.includes("mode")), "Details view displays mode parameter");

	// Return to list view (Left arrow)
	comp.handleInput("\x1b[D"); // left arrow
	assert(comp.getViewMode() === "list", "Left arrow returns to 'list' view");

	// Go into details with Enter
	comp.handleInput("\r"); // enter
	assert(comp.getViewMode() === "details", "Enter switches to 'details' view");

	// Return to list view with Escape
	comp.handleInput("\x1b"); // escape
	assert(comp.getViewMode() === "list", "Escape returns to 'list' view");

	// Close component from list view with Escape
	comp.handleInput("\x1b");
	assert(closed === true, "Escape in list view invokes onClose callback");

	// 3. Register real tools extension and verify command registration and API calls
	console.log("Test 3: Testing tools extension in Pi runtime...");
	toolsExtension(pi);

	pi.on("session_start", async (_evt, ctx) => {
		assert(typeof pi.getActiveTools === "function", "pi.getActiveTools is available");
		assert(typeof pi.getAllTools === "function", "pi.getAllTools is available");
		assert(typeof pi.setActiveTools === "function", "pi.setActiveTools is available");

		const all = pi.getAllTools();
		assert(all.length > 0, `Discovered ${all.length} tools`);

		const active = pi.getActiveTools();
		console.log("Initial active tools:", active);
		assert(active.includes("read"), "read tool is initially active");

		// Test modifying active tools
		const newActive = active.filter(n => n !== "read");
		pi.setActiveTools(newActive);
		const updatedActive = pi.getActiveTools();
		assert(!updatedActive.includes("read"), "read tool successfully disabled via setActiveTools");

		// Re-enable
		pi.setActiveTools([...updatedActive, "read"]);
		assert(pi.getActiveTools().includes("read"), "read tool successfully re-enabled via setActiveTools");

		// 4. Test branch restoration logic with tools-config entry
		console.log("Test 4: Testing branch restoration from tools-config entry...");
		const mockSessionContext: any = {
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "tools-config",
						data: { enabledTools: ["read", "bash"] },
					},
				],
			},
		};
		// Trigger session_tree handler to verify restoration from branch
		const treeHandlers = (pi as any)._handlers?.get("session_tree") || [];
		for (const h of treeHandlers) {
			await h({}, mockSessionContext);
		}
		const restoredActive = pi.getActiveTools();
		assert(restoredActive.includes("read") && restoredActive.includes("bash"), "read and bash restored from branch entry");

		// 5. Test error boundary behavior and fallback UI
		console.log("Test 5: Testing UI error boundary and human-readable fallback UI...");
		const errorComp = new ToolsManagerComponent(
			sampleTools,
			new Set(["read"]),
			mockTheme,
			() => {},
			() => {}
		);
		// Simulate a caught error
		errorComp.setError(new Error("Simulated schema rendering error"));
		const errorLines = errorComp.render(80);
		assert(errorLines.some(l => l.includes("Tool Manager Error")), "Error fallback header is rendered");
		assert(errorLines.some(l => l.includes("Simulated schema rendering error")), "Error details are clearly displayed to the user");
		assert(errorLines.some(l => l.includes("Press 'r' or Left Arrow")), "Recovery instructions are displayed");

		// Test clearing error / recovery with 'r' key
		errorComp.handleInput("r");
		const recoveredLines = errorComp.render(80);
		assert(recoveredLines.some(l => l.includes("Tools & Extensions Configuration")), "Component cleanly recovers back to tools list");

		console.log("✓ ALL TESTS PASSED!");
		process.exit(0);
	});
}
