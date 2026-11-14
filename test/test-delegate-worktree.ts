// Run with: node --test test/test-delegate-worktree.ts
//
// Provisioning a worktree is the one place the extension writes into the user's repository, so the
// tests run against a real throwaway git repo: branch numbering and the "the folder is already there"
// skip are only proved by doing it.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeStub } from "./helpers/delegate-stub.ts";
import {
	createWorktree,
	markWorktreeReleasing,
	releaseWorktree,
	unmarkWorktreeReleasing,
	worktreeIsReusable,
} from "../extensions/lib/delegate/worktree.ts";
import { cancelSession, drainQueue, onPrClosed } from "../extensions/lib/delegate/queue.ts";
import { buildSessionTools } from "../extensions/lib/delegate/tools-session.ts";
import { metaFor } from "./helpers/delegate-stub.ts";
import { must } from "./helpers/must.ts";

/** A committed repo on `feature`, with an origin so "pushed" has a meaning. */
function makeRepo(): string {
	const dir = fs.mkdtempSync(path.join("/tmp", "delegate-repo-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "-b", "feature");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
	git("add", "README.md");
	git("commit", "-m", "initial");
	return dir;
}

/** Orca is present in this environment; the git-only path is what these tests exercise. */
function withoutOrca(rt: any): void {
	rt.commandExists = async () => false;
}

// Which refusal and which note a mid-sweep answer must name (kept at the top, where this repo keeps its patterns).
const RECONNECT_REFUSAL_RE = /reconnecting session s-2/;
const RELEASED_NOTE_RE = /s-1: removed/;

test("a worktree lands in orca's layout with the next -dt index", async () => {
	const stub = makeStub();
	const repo = makeRepo();
	try {
		withoutOrca(stub.rt);
		const made = await createWorktree(stub.rt, repo);
		assert.equal(made.worktreeBranch, "feature-dt1");
		assert.ok(made.worktreePath.endsWith(path.join("orca", "workspaces", path.basename(repo), "feature-dt1")), made.worktreePath);
		assert.ok(fs.existsSync(made.worktreePath), "the folder exists — a path is a claim until it does");
		const branches = execFileSync("git", ["branch", "--list"], { cwd: repo, encoding: "utf-8" });
		assert.match(branches, /feature-dt1/);
	} finally {
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("an index already taken on disk is skipped, not reused", async () => {
	const stub = makeStub();
	const repo = makeRepo();
	try {
		withoutOrca(stub.rt);
		const first = await createWorktree(stub.rt, repo);
		// A second provisioning must not land in the first one's folder, and must not take its branch name.
		const second = await createWorktree(stub.rt, repo);
		assert.equal(first.worktreeBranch, "feature-dt1");
		assert.equal(second.worktreeBranch, "feature-dt2");
		assert.notEqual(second.worktreePath, first.worktreePath);
	} finally {
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a half-written folder is skipped too", async () => {
	const stub = makeStub();
	const repo = makeRepo();
	try {
		withoutOrca(stub.rt);
		const expected = path.join(stub.home, "orca", "workspaces", path.basename(repo));
		fs.mkdirSync(path.join(expected, "feature-dt1"), { recursive: true });
		const made = await createWorktree(stub.rt, repo);
		assert.equal(made.worktreeBranch, "feature-dt2", "a timed-out add leaves a folder and no branch");
	} finally {
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a failed checkout says why, instead of returning a path that does not exist", async () => {
	const stub = makeStub();
	const repo = makeRepo();
	try {
		withoutOrca(stub.rt);
		// A branch listing that fails is answered with a guess and a warning; here the add itself fails.
		const bogus = path.join(repo, "..", `not-a-repo-${process.pid}`);
		fs.mkdirSync(bogus, { recursive: true });
		execFileSync("git", ["init", "-b", "feature"], { cwd: bogus, stdio: "pipe" });
		await assert.rejects(
			() => createWorktree(stub.rt, bogus),
			(err: any) => /worktree|fatal|not a git repository/i.test(err.message),
		);
	} finally {
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(path.join(repo, "..", `not-a-repo-${process.pid}`), { recursive: true, force: true });
	}
});

// The three ways a settled record's folder is claimed, as the operator sees them in the skip warning. Naming the
// wrong one is not cosmetic: "wait for the restart" sends someone after a `delegate_restart` that will never come.
const SUPERSEDED_SKIP_RE = /superseded session old-1 \(restarted as new-1\)/;
const RESTART_SKIP_RE = /whose restart is in flight/;
const RECONNECT_SKIP_RE = /whose follow-up is reconnecting it/;

test("a closed PR does not release a worktree a restarted session is working in", async () => {
	// `delegate_restart` reuses the worktree, so one folder can be named by two records: the settled one whose
	// conversation moved on, and the session that took it. Releasing "settled sessions with an active worktree"
	// would cut that folder out from under a live agent, and the safety check inside looks at uncommitted work,
	// not at who owns the folder.
	const stub = makeStub();
	const repo = makeRepo();
	withoutOrca(stub.rt);
	try {
		const made = await createWorktree(stub.rt, repo);
		const shared = {
			status: "completed" as const,
			worktreePath: made.worktreePath,
			worktreeBranch: made.worktreeBranch,
			worktreeStatus: "active" as const,
			detectedPrNumber: 42,
		};
		const superseded = metaFor("old-1", { ...shared, supersededBy: { sessionId: "new-1" } });
		const successor = metaFor("new-1", shared);
		stub.rt.sessions.set("old-1", superseded);
		stub.rt.sessions.set("new-1", successor);
		// The same folder one moment earlier: the restart has been entered and has not written its pointer, so
		// the parent is settled and unmarked and only the in-flight claim says the folder is mid-handover.
		const inFlight = metaFor("old-2", { ...shared });
		stub.rt.sessions.set("old-2", inFlight);
		stub.rt.restarting.add("old-2");
		// And the third settled record with a live process behind it: a follow-up is reconnecting it, so the
		// child is spawned and its prompt is about to run in this directory (round 12).
		const connecting = metaFor("old-3", { ...shared });
		stub.rt.sessions.set("old-3", connecting);
		stub.rt.reattaching.set("old-3", Promise.resolve(undefined as never));
		const warns: string[] = [];
		stub.rt.logWarn = (message: string) => {
			warns.push(message);
		};

		await onPrClosed(stub.rt, 42, "closed");

		assert.strictEqual(superseded.worktreeStatus, "active", "a record whose conversation moved on owns nothing to release");
		const told = stub.sent.join("\n");
		assert.ok(!told.includes("old-1"), `the superseded session was still treated as dead wood: ${told}`);
		assert.strictEqual(inFlight.worktreeStatus, "active", "a session whose restart is in flight owns nothing to release either");
		assert.ok(!told.includes("old-2"), `a folder mid-handover was released: ${told}`);
		assert.strictEqual(connecting.worktreeStatus, "active", "a session mid-reattach owns nothing to release");
		assert.ok(!told.includes("old-3"), `a folder a reattach is working in was released: ${told}`);
		// The skip is right; the sentence has to name the right claim. "Wait for the restart" is bad advice when
		// what holds the folder is an ordinary follow-up reconnecting it.
		const skipped = warns.filter((w) => w.includes("Skipping worktree cleanup"));
		const byId = (id: string) => skipped.find((w) => w.includes(id)) ?? "";
		assert.match(byId("old-1"), SUPERSEDED_SKIP_RE, byId("old-1"));
		assert.match(byId("old-2"), RESTART_SKIP_RE, byId("old-2"));
		assert.match(byId("old-3"), RECONNECT_SKIP_RE, byId("old-3"));
		assert.ok(!byId("old-3").includes("restart"), `a reattach was logged as a restart: ${byId("old-3")}`);
		assert.ok(told.includes("new-1"), `the session that does own the folder should have been handled: ${told}`);
	} finally {
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a cancel during a reattach does not release the folder that reattach is working in", async () => {
	// Cancelling a connecting session is real (round 11), which means the release at the end of `cancelSession`
	// runs for a session whose agent is being spawned into its worktree right now. A prompt against a deleted
	// cwd is a failed turn nobody asked for.
	const stub = makeStub();
	const repo = makeRepo();
	withoutOrca(stub.rt);
	try {
		const made = await createWorktree(stub.rt, repo);
		const meta = metaFor("att-1", {
			status: "completed",
			worktreePath: made.worktreePath,
			worktreeBranch: made.worktreeBranch,
			worktreeStatus: "active",
		});
		stub.rt.sessions.set("att-1", meta);
		stub.rt.reattaching.set("att-1", Promise.resolve(undefined as never));

		assert.strictEqual(await cancelSession(stub.rt, "att-1"), "session", "the cancel still cancels the session");
		assert.ok(
			!stub.rt.releasingWorktrees.has(made.worktreePath),
			"a cancel that overlaps a reattach fired a release on the folder the agent is starting in",
		);
		assert.strictEqual(meta.worktreeStatus, "active", "the folder is still this session's to reclaim later");
	} finally {
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a release deletes the folder it checked, never the id it was handed", async () => {
	// The safety check is a statement about one directory: its uncommitted and unpushed work. orca deletes
	// whatever the selector names, so a record pairing a clean path with a borrowed — or planted — id would
	// have the borrowed worktree removed past the check. `state.json` is where that id comes from.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-release-"));
	const spy = path.join(dir, "orca-args.log");
	const script = path.join(dir, "orca");
	fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> ${spy}\necho '{"ok":true,"result":{"removed":true}}'\n`, { mode: 0o755 });
	const previous = process.env.ORCA_CLI_COMMAND;
	process.env.ORCA_CLI_COMMAND = script;
	const { rt, restoreHome } = makeStub();
	try {
		const worktree = path.join(dir, "checkout");
		fs.mkdirSync(worktree);
		const meta = metaFor("s-1", {
			status: "idle",
			worktreePath: worktree,
			worktreeId: "someone-elses-worktree",
			worktreeStatus: "active",
		});
		const res = await releaseWorktree(rt, meta, { force: true });
		assert.strictEqual(res.removed, true, res.note);
		const args = fs.existsSync(spy) ? fs.readFileSync(spy, "utf8") : "";
		assert.match(args, /--worktree path:/, `the deletion was addressed by path: ${args}`);
		assert.ok(!args.includes("someone-elses-worktree"), `the stored id selected the deletion: ${args}`);
	} finally {
		if (previous === undefined) {
			delete process.env.ORCA_CLI_COMMAND;
		} else {
			process.env.ORCA_CLI_COMMAND = previous;
		}
		restoreHome();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("releasing says why it did nothing", async () => {
	const stub = makeStub();
	try {
		const nothing = await releaseWorktree(stub.rt, metaFor("ag-1"));
		assert.deepEqual(nothing, { removed: false, note: "no worktree" });
		const already = await releaseWorktree(stub.rt, metaFor("ag-2", { worktreePath: "/tmp/x", worktreeStatus: "released" }));
		assert.deepEqual(already, { removed: false, note: "already released" });
	} finally {
		stub.restoreHome();
	}
});

test("a folder that is on its way out cannot take a restarted agent", async () => {
	// `delegate_cancel` then `delegate_restart` is the documented recovery flow, and the release that cancel
	// starts is not awaited: it spends seconds in a safety check and an orca removal with `worktreeStatus`
	// still "active" and the folder still on disk. Asked "reusable?" in that window, the restart answered yes
	// and started an agent in a directory about to be deleted.
	const stub = makeStub();
	const repo = makeRepo();
	withoutOrca(stub.rt);
	try {
		const made = await createWorktree(stub.rt, repo);
		const meta = metaFor("ag-r", {
			status: "completed",
			worktreePath: made.worktreePath,
			worktreeBranch: made.worktreeBranch,
			worktreeStatus: "active",
		});
		assert.ok(worktreeIsReusable(stub.rt, meta), "an active folder that exists is where a restarted agent belongs");

		const releasing = releaseWorktree(stub.rt, meta);
		// Deterministic rather than raced: everything up to the safety check is synchronous, so this lands in
		// the window the registry exists to describe.
		assert.ok(stub.rt.releasingWorktrees.has(made.worktreePath), "a release must publish itself before its first await");
		assert.ok(!worktreeIsReusable(stub.rt, meta), "a folder mid-release is not reusable, folder or no folder");

		await releasing;
		assert.ok(!stub.rt.releasingWorktrees.has(made.worktreePath), "a release unregisters whatever the outcome");
	} finally {
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("two releases of one folder keep it off-limits until the last one finishes", () => {
	// A cancel's release is unawaited and `delegate_clean_worktree` or a PR-close event can start another on
	// the same path, so "is this folder being removed" has to survive one of them finishing. As a set, the
	// first `finally` cleared the marker while the other release was still inside the removal, and a restart
	// in that window reused a directory that was about to disappear.
	const stub = makeStub();
	try {
		const folder = "/tmp/one-folder-two-releases";
		markWorktreeReleasing(stub.rt, folder);
		markWorktreeReleasing(stub.rt, folder);
		unmarkWorktreeReleasing(stub.rt, folder);
		assert.ok(stub.rt.releasingWorktrees.has(folder), "one release finishing must not clear the other's claim");
		unmarkWorktreeReleasing(stub.rt, folder);
		assert.ok(!stub.rt.releasingWorktrees.has(folder), "the last release has to lift it");
	} finally {
		stub.restoreHome();
	}
});

test("a cancel that overlaps a restart leaves the folder the successor is spawning into", async () => {
	// §7.2 used to claim `cancelSession` could not reach a mid-handover folder because a restart has moved its
	// parent out of a cancellable status. Its own gate lets a settled session through while something still
	// holds a client for it — the sub-second case of a child whose pid is gone but whose exit event has not
	// been delivered — so the guard is the predicate the other two call sites use.
	const stub = makeStub();
	const repo = makeRepo();
	withoutOrca(stub.rt);
	try {
		const made = await createWorktree(stub.rt, repo);
		const parent = metaFor("old-9", {
			status: "idle",
			worktreePath: made.worktreePath,
			worktreeBranch: made.worktreeBranch,
			worktreeStatus: "active",
		});
		stub.rt.sessions.set("old-9", parent);
		stub.rt.activeClients.set("old-9", { dispose: () => {}, notify: () => {} } as never);
		stub.rt.restarting.add("old-9");

		const outcome = await cancelSession(stub.rt, "old-9");

		assert.strictEqual(outcome, "session", "the cancel still cancels the session");
		// The release is fired unawaited, so `worktreeStatus` would say "active" whether or not it started.
		// What cannot lie is the marker: a release that began registers the path before its first await.
		assert.ok(!stub.rt.releasingWorktrees.has(made.worktreePath), "a cancel that overlaps a restart fired a release on the folder anyway");
	} finally {
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("a sweep that stops partway says so, and says what it already did", async () => {
	// The collected target list is a list of intentions, not a set of permissions: releases await, and a
	// follow-up can claim a later folder while the first is still being removed. The refusal has to arrive as a
	// tool result — pi reads `content ?? []` and leaves `isError` unset, so a bare `{message, code}` would reach
	// the caller as an empty success — and it has to carry the notes of the folders already gone.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-sweep-"));
	const spy = path.join(dir, "orca-args.log");
	const script = path.join(dir, "orca");
	// The removal sleeps half a second, which is the whole point: the first release has to still be running
	// when the second folder gains its claim, or the re-check has nothing to refuse.
	fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> ${spy}\nsleep 0.5\necho '{"ok":true,"result":{"removed":true}}'\n`, { mode: 0o755 });
	const previous = process.env.ORCA_CLI_COMMAND;
	process.env.ORCA_CLI_COMMAND = script;
	const stub = makeStub();
	const repo = makeRepo();
	try {
		withoutOrca(stub.rt);
		const first = await createWorktree(stub.rt, repo);
		const second = await createWorktree(stub.rt, repo);
		stub.rt.sessions.set(
			"s-1",
			metaFor("s-1", { status: "idle", worktreePath: first.worktreePath, worktreeStatus: "active", createWorktree: true }),
		);
		stub.rt.sessions.set(
			"s-2",
			metaFor("s-2", { status: "idle", worktreePath: second.worktreePath, worktreeStatus: "active", createWorktree: true }),
		);
		const tool = must(buildSessionTools(stub.rt).find((s) => s.name === "delegate_clean_worktree"));
		const ctx = { cwd: repo, ui: { notify: () => {} }, mode: "cli", hasUI: false } as never;
		// `force` so the first release is about the sweep, not about whether a fresh worktree counts as unpushed work.
		const sweeping = tool.execute("sweep-1", { all_settled: true, force: true }, undefined, undefined, ctx);
		// Collection happens once, up front; the claim lands after it, while the first release is still running.
		await new Promise((done) => setTimeout(done, 200));
		stub.rt.reattaching.set("s-2", Promise.resolve(undefined as never));
		const res: any = await sweeping;
		assert.strictEqual(res.isError, true, `a mid-sweep refusal must be an error, got ${JSON.stringify(res)}`);
		const text = String(res.content?.[0]?.text ?? "");
		assert.match(text, RECONNECT_REFUSAL_RE, "it names the claim that stopped it");
		assert.match(text, RELEASED_NOTE_RE, "and reports the folder it had already released");
		assert.strictEqual(res.details?.code, "SESSION_CONNECTING");
		assert.ok(fs.existsSync(second.worktreePath), "the claimed folder is untouched");
	} finally {
		if (previous === undefined) {
			delete process.env.ORCA_CLI_COMMAND;
		} else {
			process.env.ORCA_CLI_COMMAND = previous;
		}
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a start pi shut down mid-way takes the folder it provisioned with it", async () => {
	// The folder is created before the agent is asked for its id, so a shutdown in that window leaves a
	// `*-dtN` checkout and branch that no record names: `--all_settled` needs a record with `worktreePath` and
	// `active`, and nothing else ever learned the name. The failed-start path removes it; the shut-down path
	// must too.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dt-abandon-"));
	const spy = path.join(dir, "orca-args.log");
	const script = path.join(dir, "orca");
	fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> ${spy}\necho '{"ok":true,"result":{"removed":true}}'\n`, { mode: 0o755 });
	const previous = process.env.ORCA_CLI_COMMAND;
	process.env.ORCA_CLI_COMMAND = script;
	const stub = makeStub();
	const repo = makeRepo();
	const calls: string[] = [];
	try {
		withoutOrca(stub.rt);
		stub.rt.baseDir = repo;
		stub.rt.makeTransport = () =>
			({
				pid: 4343,
				start: async () => {},
				setLogFilePath: () => {},
				setOnUpdate: () => {},
				setOnExit: () => {},
				setOnRequest: () => {},
				logEvent: () => {},
				appendAssistantMessage: () => {},
				appendUserMessage: () => {},
				respond: () => {},
				request: async (method: string) => {
					calls.push(method);
					if (method === "session/new") {
						await new Promise((done) => setTimeout(done, 400));
						return { sessionId: "spawned-1", configOptions: [] };
					}
					return { stopReason: "end_turn" };
				},
				dispose: () => {},
			}) as never;
		const task = {
			queueId: "q-1",
			agent: "agy",
			prompt: "p",
			mode: "plan",
			createWorktree: true,
			enqueuedAt: Date.now(),
		} as never;
		stub.rt.queue.push(task);
		await drainQueue(stub.rt);
		await new Promise((done) => setTimeout(done, 120));
		const folder = (task as never as { worktreePath: string }).worktreePath;
		assert.ok(folder && fs.existsSync(folder), "the task got its worktree and is inside its handshake");
		stub.rt.shutdown();
		await new Promise((done) => setTimeout(done, 700));
		assert.strictEqual(stub.rt.sessions.size, 0, "nothing registered into a shut-down runtime");
		assert.ok(!calls.includes("session/prompt"), "and nothing was prompted");
		const args = fs.existsSync(spy) ? fs.readFileSync(spy, "utf8") : "";
		assert.ok(args.includes(`--worktree path:${folder}`), `the provisioned folder was left behind (orca calls: ${JSON.stringify(args)})`);
	} finally {
		if (previous === undefined) {
			delete process.env.ORCA_CLI_COMMAND;
		} else {
			process.env.ORCA_CLI_COMMAND = previous;
		}
		stub.restoreHome();
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
