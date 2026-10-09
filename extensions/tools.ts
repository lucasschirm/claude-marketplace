import type { ExtensionAPI, ExtensionContext, Theme, ToolInfo } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi, visibleWidth } from "@earendil-works/pi-tui";

const GLOBAL_GUARD_KEY = "__PI_TOOLS_EXTENSION_ACTIVE__";

// State persisted to session entries for branch navigation and resume
export interface ToolsSessionState {
	enabledTools: string[];
}

export type ViewMode = "list" | "details";

/**
 * Format property schema details for the tool parameters view
 */
export function formatParamSchema(name: string, schema: any, isRequired: boolean, theme: Theme, width: number): string[] {
	const lines: string[] = [];
	const reqTag = isRequired ? theme.fg("error", " [required]") : theme.fg("dim", " [optional]");
	const typeStr = schema?.type ? theme.fg("accent", String(schema.type)) : theme.fg("dim", "any");

	let header = `  • ${theme.bold(name)}: ${typeStr}${reqTag}`;
	if (schema?.default !== undefined) {
		header += theme.fg("muted", ` (default: ${JSON.stringify(schema.default)})`);
	}
	lines.push(truncateToWidth(header, width));

	if (schema?.description) {
		const descLines = wrapTextWithAnsi(schema.description, Math.max(10, width - 8));
		for (const d of descLines) {
			lines.push(`      ${theme.fg("muted", d)}`);
		}
	}

	if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
		lines.push(truncateToWidth(`      ${theme.fg("dim", `Allowed values: [${schema.enum.map((v: any) => JSON.stringify(v)).join(", ")}]`)}`, width));
	}

	// Nested object properties
	if (schema?.type === "object" && schema?.properties) {
		const nestedRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
		for (const [nestedKey, nestedProp] of Object.entries(schema.properties)) {
			const nestedIsReq = nestedRequired.has(nestedKey);
			const nestedType = (nestedProp as any)?.type ? theme.fg("accent", String((nestedProp as any).type)) : theme.fg("dim", "any");
			const nestedReqTag = nestedIsReq ? theme.fg("error", " [req]") : theme.fg("dim", " [opt]");
			lines.push(truncateToWidth(`      - ${nestedKey}: ${nestedType}${nestedReqTag}`, width));
			if ((nestedProp as any)?.description) {
				const nestedDesc = wrapTextWithAnsi((nestedProp as any).description, Math.max(10, width - 12));
				for (const nd of nestedDesc) {
					lines.push(`          ${theme.fg("muted", nd)}`);
				}
			}
		}
	}

	// Array items
	if (schema?.type === "array" && schema?.items) {
		const itemType = schema.items.type ? String(schema.items.type) : "item";
		lines.push(truncateToWidth(`      ${theme.fg("dim", `Items type: ${itemType}`)}`, width));
	}

	return lines;
}

/**
 * Interactive UI Component for the /tools command
 */
export class ToolsManagerComponent {
	private allTools: ToolInfo[];
	private enabledTools: Set<string>;
	private theme: Theme;
	private onClose: () => void;
	private onToggle: (toolName: string, enabled: boolean) => void;

	private viewMode: ViewMode = "list";
	private selectedIndex: number = 0;
	private detailsScrollOffset: number = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		allTools: ToolInfo[],
		enabledTools: Set<string>,
		theme: Theme,
		onToggle: (toolName: string, enabled: boolean) => void,
		onClose: () => void
	) {
		this.allTools = allTools;
		this.enabledTools = enabledTools;
		this.theme = theme;
		this.onToggle = onToggle;
		this.onClose = onClose;
	}

	getViewMode(): ViewMode {
		return this.viewMode;
	}

	getSelectedIndex(): number {
		return this.selectedIndex;
	}

	getSelectedTool(): ToolInfo | undefined {
		return this.allTools[this.selectedIndex];
	}

	handleInput(data: string): void {
		if (this.viewMode === "list") {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q" || data === "Q") {
				this.onClose();
				return;
			}

			if (matchesKey(data, "up") || data === "k") {
				if (this.selectedIndex > 0) {
					this.selectedIndex--;
					this.invalidate();
				}
				return;
			}

			if (matchesKey(data, "down") || data === "j") {
				if (this.selectedIndex < this.allTools.length - 1) {
					this.selectedIndex++;
					this.invalidate();
				}
				return;
			}

			// Space: toggle enable/disable
			if (data === " ") {
				const current = this.allTools[this.selectedIndex];
				if (current) {
					const nowEnabled = !this.enabledTools.has(current.name);
					if (nowEnabled) {
						this.enabledTools.add(current.name);
					} else {
						this.enabledTools.delete(current.name);
					}
					this.onToggle(current.name, nowEnabled);
					this.invalidate();
				}
				return;
			}

			// Right arrow or Enter: open details
			if (matchesKey(data, "right") || matchesKey(data, "enter") || data === "l") {
				if (this.allTools.length > 0) {
					this.viewMode = "details";
					this.detailsScrollOffset = 0;
					this.invalidate();
				}
				return;
			}
		} else {
			// Details view
			if (
				matchesKey(data, "left") ||
				matchesKey(data, "escape") ||
				data === "h" ||
				data === "q" ||
				data === "Q"
			) {
				this.viewMode = "list";
				this.invalidate();
				return;
			}

			if (matchesKey(data, "ctrl+c")) {
				this.onClose();
				return;
			}

			// Space: toggle enable/disable directly in details view
			if (data === " ") {
				const current = this.allTools[this.selectedIndex];
				if (current) {
					const nowEnabled = !this.enabledTools.has(current.name);
					if (nowEnabled) {
						this.enabledTools.add(current.name);
					} else {
						this.enabledTools.delete(current.name);
					}
					this.onToggle(current.name, nowEnabled);
					this.invalidate();
				}
				return;
			}

			// Scrolling inside details
			if (matchesKey(data, "up") || data === "k") {
				if (this.detailsScrollOffset > 0) {
					this.detailsScrollOffset--;
					this.invalidate();
				}
				return;
			}

			if (matchesKey(data, "down") || data === "j") {
				this.detailsScrollOffset++;
				this.invalidate();
				return;
			}

			if (matchesKey(data, "pageup")) {
				this.detailsScrollOffset = Math.max(0, this.detailsScrollOffset - 10);
				this.invalidate();
				return;
			}

			if (matchesKey(data, "pagedown")) {
				this.detailsScrollOffset += 10;
				this.invalidate();
				return;
			}
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;
		const safeWidth = Math.max(20, width);

		if (this.viewMode === "list") {
			// List header
			lines.push("");
			const title = th.fg("accent", " Tools & Extensions Configuration ");
			const headerLine = th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, safeWidth - visibleWidth("───" + " Tools & Extensions Configuration "))));
			lines.push(truncateToWidth(headerLine, safeWidth));
			lines.push("");

			const enabledCount = this.allTools.filter(t => this.enabledTools.has(t.name)).length;
			lines.push(truncateToWidth(`  Active tools in this session: ${th.fg("accent", `${enabledCount}/${this.allTools.length}`)} enabled`, safeWidth));
			lines.push("");

			if (this.allTools.length === 0) {
				lines.push(truncateToWidth(`  ${th.fg("dim", "No tools discovered in this session.")}`, safeWidth));
			} else {
				const maxVisible = 15;
				let startIdx = 0;
				let endIdx = this.allTools.length;

				if (this.allTools.length > maxVisible) {
					const half = Math.floor(maxVisible / 2);
					if (this.selectedIndex <= half) {
						startIdx = 0;
						endIdx = maxVisible;
					} else if (this.selectedIndex >= this.allTools.length - half) {
						startIdx = this.allTools.length - maxVisible;
						endIdx = this.allTools.length;
					} else {
						startIdx = this.selectedIndex - half;
						endIdx = startIdx + maxVisible;
					}
				}

				for (let i = startIdx; i < endIdx; i++) {
					const tool = this.allTools[i];
					const isSelected = i === this.selectedIndex;
					const pointer = isSelected ? th.fg("accent", "▶ ") : "  ";
					const isEnabled = this.enabledTools.has(tool.name);
					const statusBadge = isEnabled
						? th.fg("success", "[● ENABLED] ")
						: th.fg("dim", "[○ DISABLED]");

					const nameStyled = isSelected ? th.bold(tool.name) : th.fg("text", tool.name);
					const oneLineDesc = tool.description ? tool.description.split("\n")[0].trim() : "";
					const descStr = oneLineDesc ? th.fg("muted", ` - ${oneLineDesc}`) : "";

					const row = `${pointer}${statusBadge} ${nameStyled}${descStr}`;
					lines.push(truncateToWidth(row, safeWidth));
				}

				if (this.allTools.length > maxVisible) {
					lines.push(truncateToWidth(`  ${th.fg("dim", `[Showing ${startIdx + 1}-${endIdx} of ${this.allTools.length} tools]`)}`, safeWidth));
				}
			}

			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "↑/↓: navigate  •  Space: toggle enable/disable  •  →/Enter: view parameters  •  Esc: close")}`, safeWidth));
			lines.push("");
		} else {
			// Details view
			const tool = this.allTools[this.selectedIndex];
			if (!tool) {
				lines.push(truncateToWidth(`  ${th.fg("error", "Tool not found.")}`, safeWidth));
			} else {
				const isEnabled = this.enabledTools.has(tool.name);
				const statusBadge = isEnabled
					? th.fg("success", "[● ENABLED]")
					: th.fg("dim", "[○ DISABLED]");

				lines.push("");
				const title = th.fg("accent", ` Tool Details: ${tool.name} `);
				const headerLine = th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, safeWidth - visibleWidth("───" + ` Tool Details: ${tool.name} `))));
				lines.push(truncateToWidth(headerLine, safeWidth));
				lines.push("");

				const detailContentLines: string[] = [];

				detailContentLines.push(truncateToWidth(`  Status:      ${statusBadge} (Press Space to toggle)`, safeWidth));
				if (tool.exposure) {
					detailContentLines.push(truncateToWidth(`  Exposure:    ${th.fg("muted", tool.exposure)}`, safeWidth));
				}
				if (tool.sourceInfo?.source) {
					detailContentLines.push(truncateToWidth(`  Source:      ${th.fg("muted", tool.sourceInfo.source)}`, safeWidth));
				}
				detailContentLines.push("");

				// Description
				detailContentLines.push(truncateToWidth(`  ${th.bold("Description:")}`, safeWidth));
				if (tool.description) {
					const descWrapped = wrapTextWithAnsi(tool.description, safeWidth - 6);
					for (const d of descWrapped) {
						detailContentLines.push(`    ${th.fg("text", d)}`);
					}
				} else {
					detailContentLines.push(`    ${th.fg("dim", "No description provided.")}`);
				}
				detailContentLines.push("");

				// Parameters
				detailContentLines.push(truncateToWidth(`  ${th.bold("Parameters:")}`, safeWidth));
				const paramsObj = tool.parameters as any;
				const properties = paramsObj?.properties;
				const requiredFields = new Set<string>(Array.isArray(paramsObj?.required) ? paramsObj.required : []);

				if (properties && Object.keys(properties).length > 0) {
					for (const [propName, propSchema] of Object.entries(properties)) {
						const isReq = requiredFields.has(propName);
						const formattedParam = formatParamSchema(propName, propSchema, isReq, th, safeWidth);
						detailContentLines.push(...formattedParam);
						detailContentLines.push("");
					}
				} else {
					detailContentLines.push(`    ${th.fg("dim", "This tool accepts no parameters.")}`);
					detailContentLines.push("");
				}

				// Prompt Guidelines if available
				if (tool.promptGuidelines) {
					detailContentLines.push(truncateToWidth(`  ${th.bold("Prompt Guidelines:")}`, safeWidth));
					const guidelinesWrapped = wrapTextWithAnsi(tool.promptGuidelines, safeWidth - 6);
					for (const g of guidelinesWrapped) {
						detailContentLines.push(`    ${th.fg("muted", g)}`);
					}
					detailContentLines.push("");
				}

				// Apply scrolling if needed
				const maxDisplayLines = 25;
				const maxScroll = Math.max(0, detailContentLines.length - maxDisplayLines);
				if (this.detailsScrollOffset > maxScroll) {
					this.detailsScrollOffset = maxScroll;
				}

				const visibleLines = detailContentLines.slice(
					this.detailsScrollOffset,
					this.detailsScrollOffset + maxDisplayLines
				);
				lines.push(...visibleLines);

				if (detailContentLines.length > maxDisplayLines) {
					const scrollPct = Math.round(((this.detailsScrollOffset + maxDisplayLines) / detailContentLines.length) * 100);
					lines.push(truncateToWidth(`  ${th.fg("dim", `[Showing lines ${this.detailsScrollOffset + 1}-${Math.min(detailContentLines.length, this.detailsScrollOffset + maxDisplayLines)} of ${detailContentLines.length} (${scrollPct}%)]`)}`, safeWidth));
				}
			}

			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", "←/Esc: back to list  •  Space: toggle enable/disable  •  ↑/↓: scroll details")}`, safeWidth));
			lines.push("");
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * Extension entry point
 */
export default function toolsExtension(pi: ExtensionAPI) {
	// Guard against duplicate registrations in the same process
	if ((globalThis as any)[GLOBAL_GUARD_KEY]) {
		return;
	}
	(globalThis as any)[GLOBAL_GUARD_KEY] = true;

	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	function persistState() {
		try {
			pi.appendEntry<ToolsSessionState>("tools-config", {
				enabledTools: Array.from(enabledTools),
			});
		} catch {
			// Ignore if appendEntry fails in test/headless environments
		}
	}

	function applyTools() {
		try {
			pi.setActiveTools(Array.from(enabledTools));
		} catch (err) {
			console.error("[tools] Error setting active tools:", err);
		}
	}

	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = pi.getAllTools();
		const allToolNames = allTools.map(t => t.name);

		let savedTools: string[] | undefined;
		try {
			const branchEntries = ctx.sessionManager.getBranch();
			for (const entry of branchEntries) {
				if (entry.type === "custom" && entry.customType === "tools-config") {
					const data = entry.data as ToolsSessionState | undefined;
					if (data?.enabledTools && Array.isArray(data.enabledTools)) {
						savedTools = data.enabledTools;
					}
				}
			}
		} catch {
			// No branch entries or headless
		}

		if (savedTools) {
			// Filter to tools that currently exist
			enabledTools = new Set(savedTools.filter(t => allToolNames.includes(t)));
			applyTools();
		} else {
			// Sync with currently active tools
			enabledTools = new Set(pi.getActiveTools());
		}
	}

	// Register the /tools command
	pi.registerCommand("tools", {
		description: "Browse tools, view parameters, and enable/disable tools for this session",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/tools requires interactive TUI mode", "error");
				return;
			}

			// Refresh current tools list and sync enabled state
			allTools = pi.getAllTools();
			enabledTools = new Set(pi.getActiveTools());

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				const component = new ToolsManagerComponent(
					allTools,
					enabledTools,
					theme,
					(_name, _isEnabled) => {
						applyTools();
						persistState();
						tui.requestRender();
					},
					() => {
						done();
					}
				);

				return {
					render(width: number) {
						return component.render(width);
					},
					invalidate() {
						component.invalidate();
					},
					handleInput(data: string) {
						component.handleInput(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	// Restore state on session start
	pi.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state when navigating session tree
	pi.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Release guard on session shutdown so /resume, /new, /reload re-registers cleanly
	pi.on("session_shutdown", async () => {
		delete (globalThis as any)[GLOBAL_GUARD_KEY];
	});
}
