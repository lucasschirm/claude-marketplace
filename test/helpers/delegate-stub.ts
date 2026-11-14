// A DelegateRuntime wired to a stubbed pi API, for tests that exercise the engine without a host.
//
// The runtime touches pi in exactly two places — `getFlag` and `sendUserMessage` — so a stub is short,
// and the fact that it *can* be short is the point of the runtime not reaching for the host elsewhere.
// Anything a test needs beyond that is a sign the runtime has grown a dependency it should have been
// given instead.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegateRuntime } from "../../extensions/lib/delegate/runtime.ts";
import type { SessionMeta } from "../../extensions/lib/delegate/types.ts";

export interface Stub {
	rt: DelegateRuntime;
	/** Every message the engine tried to send into the parent session. */
	sent: string[];
	/** `ui.notify` calls: [text, level]. */
	notifications: Array<[string, string | undefined]>;
	/** `ui.setStatus` calls, keyed by status id; undefined clears. */
	statuses: Array<[string, string | undefined]>;
	flags: Record<string, string | boolean | undefined>;
	ui: { notify(text: string, level?: string): void; setStatus(id: string, text: string | undefined): void };
	/** Restore the temp HOME the runtime was pointed at. */
	restoreHome(): void;
	/** Where the state files went. */
	home: string;
}

/**
 * The last temp home this process made, and every home it has made.
 *
 * `storage.ts` resolves `os.homedir()` when a write happens, and a write can happen after the test that caused
 * it has finished — a debounced meta persist, a continuation of `recoverState`, a turn's flush on process exit.
 * Restoring HOME at the end of each test handed those writes the developer's real `~/.pi/agent/delegate_task/`,
 * which is the one thing the redirect exists to prevent. So the pin stays: a finished test's home keeps
 * answering `os.homedir()` until the next stub takes over, and every home goes when the process does.
 */
const stubHomes: string[] = [];
let realHomedir: (() => string) | undefined;

function pinHome(home: string): void {
	if (!realHomedir) {
		realHomedir = os.homedir;
		process.on("exit", () => {
			os.homedir = realHomedir as () => string;
			for (const dir of stubHomes) {
				try {
					fs.rmSync(dir, { recursive: true, force: true });
				} catch {
					// A temp directory that outlives the run is a nuisance; a throw in an exit hook is worse.
				}
			}
		});
	}
	stubHomes.push(home);
	os.homedir = () => stubHomes[stubHomes.length - 1] as string;
}

/**
 * A runtime whose storage points at a temp directory.
 *
 * HOME is redirected because every path in `storage.ts` hangs off `os.homedir()`; leaving it alone would have
 * the tests read and write the real `~/.pi/agent/delegate_task/` of whoever runs them. `restoreHome` restores
 * the environment but keeps the directory, for the writes described above.
 */
export function makeStub(flags: Record<string, string | boolean | undefined> = {}): Stub {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-"));
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	pinHome(home);
	const sent: string[] = [];
	const notifications: Array<[string, string | undefined]> = [];
	const statuses: Array<[string, string | undefined]> = [];
	const ui = {
		notify: (text: string, level?: string) => notifications.push([text, level]),
		setStatus: (id: string, text: string | undefined) => statuses.push([id, text]),
	};
	const pi = {
		getFlag: (name: string) => flags[name],
		sendUserMessage: (text: string) => {
			sent.push(text);
		},
	} as unknown as ExtensionAPI;
	const rt = new DelegateRuntime(pi, "delegate_task_test");
	rt.setUi(ui as never);
	rt.baseDir = home;
	rt.currentPiSessionId = "pi-test";
	return {
		rt,
		sent,
		notifications,
		statuses,
		flags,
		ui,
		home,
		restoreHome: () => {
			// The env goes back so nothing outside a stub believes a temp path; the directory stays, because a
			// write still in flight belongs somewhere and that somewhere must not be the real home. The exit
			// hook above reclaims it.
			process.env.HOME = previousHome;
			if (stubHomes[stubHomes.length - 1] === home) {
				// Nothing is pinned here any more; the next `os.homedir()` before the next stub is this test's
				// late write, and its own directory is the honest answer.
				os.homedir = () => home;
			}
		},
	};
}

export function metaFor(sessionId: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		sessionId,
		agent: "devin",
		prompt: "do the thing",
		mode: "dangerous",
		createWorktree: false,
		status: "running",
		createdAt: Date.now(),
		...overrides,
	};
}

/**
 * A fake transport with the wiring `attach()` installs, so a test can hand the engine an update frame.
 *
 * It implements the slice of `DelegateTransport` the session layer touches and records what the engine
 * wrote, which is what makes "a heartbeat refreshed the clock and wrote no transcript line" a test instead
 * of a reading of `attach`.
 */
export function fakeTransport() {
	const written: Array<{ type: string; data: unknown }> = [];
	const handlers: { update?: (frame: any) => void; exit?: (code: number | null) => void; request?: (req: any) => boolean } = {};
	return {
		written,
		pid: 4242,
		setOnUpdate(cb: (frame: any) => void) {
			handlers.update = cb;
		},
		setOnExit(cb: (code: number | null) => void) {
			handlers.exit = cb;
		},
		setOnRequest(cb: (req: any) => boolean) {
			handlers.request = cb;
		},
		logEvent(type: string, data: unknown) {
			written.push({ type, data });
		},
		appendAssistantMessage(text: string) {
			written.push({ type: "assistant_message", data: { text } });
		},
		appendThoughtMessage() {},
		appendUserMessage() {},
		request: async () => ({}),
		dispose() {},
		/** Deliver a `session/update` the way the wire would. */
		emitUpdate(frame: any) {
			handlers.update?.(frame);
		},
		emitExit(code: number | null) {
			handlers.exit?.(code);
		},
		emitRequest(req: any) {
			return handlers.request?.(req) ?? false;
		},
	};
}

/** A fake transport: records what the engine answered, so permission tests need no child process. */
export function fakeClient() {
	const responses: Array<{ id: number | string; result: unknown }> = [];
	const events: Array<{ type: string; data: unknown }> = [];
	return {
		responses,
		events,
		respond(id: number | string, result: unknown) {
			responses.push({ id, result });
		},
		logEvent(type: string, data: unknown) {
			events.push({ type, data });
		},
		dispose() {},
		appendAssistantMessage() {},
		appendThoughtMessage() {},
		appendUserMessage() {},
		notify() {},
	};
}
