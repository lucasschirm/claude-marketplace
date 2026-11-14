// Run with: node --test test/test-delegate-worktree.ts
//
// Provisioning a worktree is the one place the extension writes into the user's repository, so the
// tests run against a real throwaway git repo: branch numbering and the "the folder is already there"
// skip are only proved by doing it.
import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeStub } from "./helpers/delegate-stub.ts";
import {
	createWorktree,
	markWorktreeReleasing,
	releaseWorktree,
	unmarkWorktreeReleasing,
	worktreeIsReusable,
} from "../extensions/lib/delegate/worktree.ts";
import { cancelSession, onPrClosed } from "../extensions/lib/delegate/queue.ts";
import { metaFor } from "./helpers/delegate-stub.ts";

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
