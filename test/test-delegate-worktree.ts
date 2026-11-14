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
import { createWorktree, releaseWorktree, worktreeIsReusable } from "../extensions/lib/delegate/worktree.ts";
import { onPrClosed } from "../extensions/lib/delegate/queue.ts";
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

		await onPrClosed(stub.rt, 42, "closed");

		assert.strictEqual(superseded.worktreeStatus, "active", "a record whose conversation moved on owns nothing to release");
		const told = stub.sent.join("\n");
		assert.ok(!told.includes("old-1"), `the superseded session was still treated as dead wood: ${told}`);
		assert.strictEqual(inFlight.worktreeStatus, "active", "a session whose restart is in flight owns nothing to release either");
		assert.ok(!told.includes("old-2"), `a folder mid-handover was released: ${told}`);
		assert.ok(told.includes("new-1"), `the session that does own the folder should have been handled: ${told}`);
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
