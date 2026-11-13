// The `/delegate` dashboard: a keyboard-navigable list of sessions and queued tasks, with a transcript
// view for each.
//
// Two rules govern everything in this file, and both come from crashing the host:
//  * `render()` never throws. A missing theme token in a custom theme takes down pi's render loop if it
//    escapes, so the whole render is wrapped and a failure becomes one plain line.
//  * No state beyond the transcript cache. Sessions and queued tasks are read through the callbacks on
//    every paint, so the dashboard cannot show a stale world; `invalidate()` drops the cache and the
//    next paint re-reads it.

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "./diagnostics.ts";
import { findAgent } from "./registry.ts";
import type { QueuedTask, SessionMeta } from "./types.ts";

/** How many transcript lines fit one screen, and how far the scroll can go past them. */
const VISIBLE_LINES = 15;
const SCROLL_MARGIN = 10;

interface Theme {
	fg(kind: string, text: string): string;
	bold(text: string): string;
}

/** `[devin]` / `[claude]` — a two-agent list where every row just says "session" is not a list of two agents. */
function agentTag(agentId: string): string {
	const found = findAgent(agentId);
	return found.ok ? found.driver.id : agentId;
}

export class DelegateDashboardComponent {
	private selectedIndex = 0;
	private viewMode: "sessions" | "messages" = "sessions";
	private messageScrollOffset = 0;
	private cachedMessages: string[] = [];

	private readonly tui: { requestRender?: () => void };
	private readonly theme: Theme;
	private readonly getSessions: () => SessionMeta[];
	private readonly getQueue: () => QueuedTask[];
	private readonly readSessionMessages: (session: SessionMeta, count?: number) => string[];
	private readonly onClose: () => void;

	// Explicit assignment, not parameter properties: node runs this tree with
	// `--experimental-strip-types`, which erases types and cannot implement them.
	constructor(
		tui: { requestRender?: () => void },
		theme: Theme,
		getSessions: () => SessionMeta[],
		getQueue: () => QueuedTask[],
		readSessionMessages: (session: SessionMeta, count?: number) => string[],
		onClose: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.getSessions = getSessions;
		this.getQueue = getQueue;
		this.readSessionMessages = readSessionMessages;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q" || data === "Q") {
			this.onClose();
			return;
		}
		const total = this.getSessions().length + this.getQueue().length;
		if (this.viewMode === "sessions") {
			this.navigateSessions(data, total);
		} else {
			this.navigateMessages(data);
		}
	}

	private navigateSessions(data: string, total: number): void {
		if (matchesKey(data, "up")) {
			if (this.selectedIndex > 0) {
				this.selectedIndex--;
				this.tui.requestRender?.();
			}
		} else if (matchesKey(data, "down")) {
			if (this.selectedIndex < total - 1) {
				this.selectedIndex++;
				this.tui.requestRender?.();
			}
		} else if (matchesKey(data, "right") || matchesKey(data, "return")) {
			const sessions = this.getSessions();
			if (this.selectedIndex < sessions.length) {
				this.viewMode = "messages";
				this.messageScrollOffset = 0;
				this.cachedMessages = this.readSessionMessages(sessions[this.selectedIndex], 50);
				this.tui.requestRender?.();
			}
		}
	}

	private navigateMessages(data: string): void {
		if (matchesKey(data, "left") || matchesKey(data, "backspace")) {
			this.viewMode = "sessions";
			this.cachedMessages = [];
			this.tui.requestRender?.();
		} else if (matchesKey(data, "up")) {
			if (this.messageScrollOffset > 0) {
				this.messageScrollOffset--;
				this.tui.requestRender?.();
			}
		} else if (matchesKey(data, "down")) {
			if (this.messageScrollOffset < Math.max(0, this.cachedMessages.length - SCROLL_MARGIN)) {
				this.messageScrollOffset++;
				this.tui.requestRender?.();
			}
		}
	}

	render(width: number): string[] {
		try {
			return this.renderInner(width);
		} catch (err: any) {
			return [`[delegate_task] dashboard unavailable: ${stripAnsi(String(err?.message ?? err))}`];
		}
	}

	private renderInner(width: number): string[] {
		const th = this.theme;
		const sessions = this.getSessions();
		const queue = this.getQueue();
		const total = sessions.length + queue.length;

		const lines: string[] = [""];
		const title = th.fg("accent", " Delegated Sessions ");
		const header = th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 27)));
		lines.push(truncateToWidth(header, width), "");

		if (total === 0) {
			lines.push(
				truncateToWidth(`  ${th.fg("dim", "No delegated sessions or queued tasks yet.")}`, width),
				truncateToWidth(`  ${th.fg("dim", "Use the delegate_task tool to start one.")}`, width),
				"",
				truncateToWidth(`  ${th.fg("muted", "Press 'q' or 'Esc' to close.")}`, width),
			);
			return lines;
		}

		if (this.viewMode === "sessions") {
			lines.push(truncateToWidth(`  ${th.fg("muted", "Up/Down to select, Right/Enter for messages, 'q' to close:")}`, width), "");
			for (const [i, s] of sessions.entries()) {
				lines.push(truncateToWidth(this.sessionLine(s, i === this.selectedIndex), width));
			}
			if (queue.length > 0) {
				lines.push("", truncateToWidth(`  ${th.fg("muted", `Queued Tasks (${queue.length}):`)}`, width));
				queue.forEach((q, j) => {
					const i = sessions.length + j;
					lines.push(truncateToWidth(this.queueLine(q, j, i === this.selectedIndex), width));
				});
			}
			return [...lines, ""];
		}

		const selected = sessions[this.selectedIndex];
		lines.push(
			truncateToWidth(`  ${th.fg("accent", `Session: ${selected.sessionId}`)} ${th.fg("dim", `[${selected.status}]`)}`, width),
			truncateToWidth(`  ${th.fg("muted", "Up/Down to scroll, Left to return, 'q' to close:")}`, width),
			"",
		);
		if (this.cachedMessages.length === 0) {
			this.cachedMessages = this.readSessionMessages(selected, 50);
		}
		if (this.cachedMessages.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No messages recorded yet.")}`, width));
		} else {
			for (const msg of this.cachedMessages.slice(this.messageScrollOffset, this.messageScrollOffset + VISIBLE_LINES)) {
				lines.push(truncateToWidth(`  ${msg}`, width));
			}
		}
		return [...lines, ""];
	}

	private sessionLine(s: SessionMeta, selected: boolean): string {
		const th = this.theme;
		const pointer = selected ? th.fg("accent", "▶ ") : "  ";
		const color = s.status === "running" ? "success" : s.status === "failed" ? "error" : s.status === "stalled" ? "warning" : "muted";
		const badge = th.fg(color, `[${s.status.toUpperCase()}]`);
		const pr = s.detectedPrNumber ? th.fg("accent", ` PR #${s.detectedPrNumber}`) : "";
		const when = s.lastMessageTime ? new Date(s.lastMessageTime).toLocaleTimeString() : "N/A";
		return `${pointer}${th.bold(s.sessionId)} ${agentTag(s.agent)} ${badge}${pr} (${when}) - ${s.prompt.slice(0, 40)}`;
	}

	private queueLine(q: QueuedTask, index: number, selected: boolean): string {
		const th = this.theme;
		const pointer = selected ? th.fg("accent", "▶ ") : "  ";
		return `${pointer}${th.bold(q.queueId)} ${agentTag(q.agent)} ${th.fg("warning", `[QUEUED #${index + 1}]`)} - ${q.prompt.slice(0, 45)}`;
	}

	/**
	 * Required by pi-tui's `Component`: the transcript is this component's only cached state, and
	 * render() re-reads it lazily, so a theme change or a full redraw simply starts from empty.
	 */
	invalidate(): void {
		this.cachedMessages = [];
	}
}
