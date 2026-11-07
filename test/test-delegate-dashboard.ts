// Run with: node --test test/test-delegate-dashboard.ts
//
// The dashboard is the one component that runs inside pi's render loop, so its contract is "renders
// something, never throws", plus the keyboard behaviour the help text promises.
import { test } from "node:test";
import assert from "node:assert";
import { DelegateDashboardComponent } from "../extensions/lib/delegate/dashboard.ts";
import { metaFor } from "./helpers/delegate-stub.ts";
import { stripAnsi } from "../extensions/lib/delegate/diagnostics.ts";
import type { QueuedTask, SessionMeta } from "../extensions/lib/delegate/types.ts";

const theme = { fg: (_kind: string, text: string) => text, bold: (text: string) => text };
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";

function dashboard(
	sessions: SessionMeta[],
	queue: QueuedTask[] = [],
	messages: () => string[] = () => ["[Devin]: the change is in src/a.ts"],
) {
	let closed = 0;
	let reads = 0;
	let renders = 0;
	const component = new DelegateDashboardComponent(
		{ requestRender: () => renders++ },
		theme,
		() => sessions,
		() => queue,
		() => {
			reads++;
			return messages();
		},
		() => closed++,
	);
	const render = (width = 100) => component.render(width).join("\n");
	return { component, render, closed: () => closed, reads: () => reads, renders: () => renders };
}

const RUNNING = metaFor("ag-running", { status: "running", prompt: "fix the parser", lastMessageTime: 1_700_000_000_000 });
const DONE = metaFor("ag-done", { agent: "claude", status: "idle", prompt: "review the diff", detectedPrNumber: 77 });
const QUEUED: QueuedTask = { queueId: "q-9", agent: "devin", prompt: "wait your turn", enqueuedAt: 1 };

test("an empty dashboard says so instead of showing a blank screen", () => {
	const d = dashboard([]);
	const out = d.render();
	assert.match(out, /No delegated sessions or queued tasks yet/);
	assert.match(out, /delegate_task/);
});

test("every row says which agent it is, which is the point of having two", () => {
	const d = dashboard([RUNNING, DONE], [QUEUED]);
	const out = d.render();
	assert.match(out, /ag-running devin \[RUNNING\]/);
	assert.match(out, /ag-done claude \[IDLE\] PR #77/);
	assert.match(out, /Queued Tasks \(1\)/);
	assert.match(out, /q-9 devin \[QUEUED #1\]/);
});

test("arrow keys move the selection and cannot walk off the list", () => {
	const d = dashboard([RUNNING, DONE], [QUEUED]);
	assert.match(d.render(), /▶ ag-running/);
	d.component.handleInput(DOWN);
	assert.match(d.render(), /▶ ag-done/);
	d.component.handleInput(DOWN);
	assert.match(d.render(), /▶ q-9/, "the queue is part of the list");
	d.component.handleInput(DOWN);
	assert.match(d.render(), /▶ q-9/, "and it stops at the end");
	d.component.handleInput(UP);
	d.component.handleInput(UP);
	d.component.handleInput(UP);
	assert.match(d.render(), /▶ ag-running/);
});

test("right opens the transcript, left closes it, q closes the dashboard", () => {
	const d = dashboard([RUNNING, DONE]);
	d.component.handleInput(RIGHT);
	const open = d.render();
	assert.match(open, /Session: ag-running/);
	assert.match(open, /Session: ag-running \[running\]/);
	assert.match(open, /the change is in src\/a\.ts/);
	d.component.handleInput(LEFT);
	assert.match(d.render(), /▶ ag-running/);
	d.component.handleInput(ENTER);
	assert.match(d.render(), /Session: ag-running/, "enter opens like right does");
	d.component.handleInput("q");
	assert.equal(d.closed(), 1);
	d.component.handleInput("\x1b");
	assert.equal(d.closed(), 2, "escape closes too");
});

test("a transcript is read once and re-read only when invalidated", () => {
	const d = dashboard([RUNNING]);
	d.component.handleInput(RIGHT);
	d.render();
	d.render();
	assert.equal(d.reads(), 1, "the transcript is the component's only cache");
	d.component.invalidate();
	d.render();
	assert.equal(d.reads(), 2);
});

test("a session with nothing logged yet renders a sentence, not an error", () => {
	const d = dashboard([RUNNING], [], () => []);
	d.component.handleInput(RIGHT);
	assert.match(d.render(), /No messages recorded yet/);
});

test("a theme that throws costs a line, not the TUI", () => {
	const broken = new DelegateDashboardComponent(
		{},
		{
			fg: (_k: string, _t: string) => {
				throw new Error("missing theme token");
			},
			bold: (t: string) => t,
		},
		() => [RUNNING],
		() => [],
		() => [],
		() => {},
	);
	const lines = broken.render(80);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /dashboard unavailable: missing theme token/);
});

test("rows never exceed the width they were rendered for", () => {
	const long = metaFor("ag-very-long-session-identifier-that-goes-on", {
		status: "running",
		prompt: "a prompt long enough to be a problem a prompt long enough to be a problem a prompt long enough",
		lastMessageTime: 1_700_000_000_000,
	});
	const d = dashboard([long], [QUEUED]);
	for (const line of d.component.render(60)) {
		const visible = stripAnsi(line);
		assert.ok(visible.length <= 60, `line of ${visible.length} chars: ${visible}`);
	}
});
