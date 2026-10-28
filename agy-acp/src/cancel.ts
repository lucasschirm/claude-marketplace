// The cancel ladder (issue #54): how a cancelled turn's process actually dies.
//
// SIGINT first, because that is the mechanism agy itself implements: the spike record
// `interrupted-sigint` (agy 1.4.2) answers SIGINT with `result{status:"ERROR",error:"interrupted"}`,
// kills the tool command it was running, and exits 1. A group kill is no substitute - SIGINT is the
// only signal that reaches agy's *turn* rather than its process - so it is the primary cancel and
// the ladder below is what catches the two cases it cannot settle:
//
//   - agy ignores the SIGINT. The driver's own teardown runs (close stdin, graceMs, SIGTERM the
//     group, termMs, SIGKILL), so there is still exactly one way a child dies and no second timer
//     to reason about. The group is the driver's own, and its leader is alive: the id is ours.
//   - agy exits and leaves a tool command running in its group. Nothing owns that process any more,
//     so the sweep SIGTERMs the group and SIGKILLs it `escalateMs` later. Both sweeps happen within
//     a beat of the exit, far inside the window in which the id could be recycled to a new group.
//
// A tool command that detached itself (`setsid`, `nohup`, `& disown`) belongs to no group we can
// see and survives all of this - the documented residual risk, alongside SIGKILL of agy-acp itself.
//
// `escalateMs` is configurable (AGY_ACP_CANCEL_ESCALATE_MS); 0 runs the ladder immediately.

import type { AgyProcess } from "./agy-driver.ts";

/** The reason a tool call is reported failed when its turn is cancelled. */
export const CANCELLED_TOOL_REASON = "the turn was cancelled";

/** How long a leftover in the group is given to leave on its own before the sweep signals it. */
const SWEEP_GRACE_MS = 100;

/**
 * SIGINT the child and keep its process group honest. Fire-and-forget by design: `session/cancel`
 * is a notification, and the turn is settled by the stream (the interrupted `result`) or by the
 * child's exit, whichever lands first - never by this ladder.
 */
export function cancelAgy(driver: AgyProcess, escalateMs: number, log: (line: string) => void): void {
	const pgid = driver.pid;
	driver.interrupt();
	if (pgid === undefined) return; // never spawned: there is no group to keep
	const escalate = (): void => {
		if (!driver.exited) {
			log(`agy ignored SIGINT for ${escalateMs} ms - running the teardown ladder on its process group`);
			void driver.dispose(); // close stdin, graceMs, SIGTERM the group, termMs, SIGKILL
			return;
		}
		sweepGroup(pgid, escalateMs, log);
	};
	if (escalateMs <= 0) {
		escalate();
		return;
	}
	const timer = setTimeout(escalate, escalateMs);
	timer.unref(); // the child's stdio keeps the loop alive; the escalation timer must not
	// The usual outcome of a successful cancel: agy dies on the SIGINT and the group is checked
	// shortly after, in case it left its tool command behind.
	driver.once("exit", () => {
		const grace = setTimeout(() => sweepGroup(pgid, escalateMs, log), SWEEP_GRACE_MS);
		grace.unref();
	});
}

/**
 * Kills what outlived agy inside its process group (a tool command it did not take with it).
 * A no-op in the common case, where the group is already empty, so every cancel can afford it.
 */
function sweepGroup(pgid: number, escalateMs: number, log: (line: string) => void): void {
	if (!groupExists(pgid)) return;
	log(`process group ${pgid} still has members after agy exited - SIGTERM, then SIGKILL`);
	signalGroup(pgid, "SIGTERM", log);
	const killAfter = Math.max(escalateMs, SWEEP_GRACE_MS);
	const killer = setTimeout(() => {
		if (groupExists(pgid)) signalGroup(pgid, "SIGKILL", log);
	}, killAfter);
	killer.unref();
}

/** Does a process group with this id still exist? (It does as long as any member is alive.) */
function groupExists(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (err) {
		// ESRCH: the group is gone. Anything else (EPERM) means it exists but is not ours to signal.
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function signalGroup(pgid: number, signal: NodeJS.Signals, log: (line: string) => void): void {
	try {
		process.kill(-pgid, signal);
	} catch (err) {
		// ESRCH here means the group went away between the check and the signal: fine.
		log(`signalling process group -${pgid} ${signal} failed: ${(err as Error).message}`);
	}
}
