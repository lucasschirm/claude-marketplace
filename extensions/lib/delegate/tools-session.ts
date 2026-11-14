// The tools that act on a session that already exists.
//
// Each one is a thin decision the engine cannot make for itself: whether to answer a permission request,
// whether to cancel, whether to throw another turn at an idle session. Everything below delegates the
// *mechanics* — `runtime.answerPermission`, `queue.cancelSession`, `queue.followUp`, `queue.delegate` —
// because those mechanics have to be identical to what the slash command does. Where a tool and
// `/delegate cancel` behaved differently, both bugs were reported; they are one function now.

import { Type } from "typebox";
import { extractCliError } from "./diagnostics.ts";
import { admit, findAgent } from "./registry.ts";
import type { DelegateRuntime } from "./runtime.ts";
import { cancelSession, delegate, followUp, type DelegateRequest } from "./queue.ts";
import { markSuperseded, supersededPointerText, worktreeHasLiveClaim } from "./session.ts";
import { commandForCaller, PERMISSION_DECISIONS, type PermissionDecision } from "./permissions.ts";
import { releaseWorktree, worktreeIsReusable } from "./worktree.ts";
import type { SessionMeta } from "./types.ts";
import { begin, errorResult, queueReasonText, textResult, type ToolSpec } from "./tools.ts";

const SESSION_ID = Type.String({ description: "Session ID" });

/** The reply to a permission decision, worded so the caller knows what was actually chosen. */
/** The agent's display name, so a reply never says `devin` where the rest of the family says `Devin`. */
function agentTitle(agentId: string): string {
	const found = findAgent(agentId);
	return found.ok ? found.driver.title : agentId;
}

function permissionReply(agentId: string, decision: PermissionDecision, chosen: string | undefined): string {
	const policy = findAgent(agentId);
	const degrades = policy.ok && policy.driver.permission().degradesAllowSession && decision === "allow_session";
	if (!chosen) {
		return "Rejected: the agent offered no option this decision could map to, so the request was cancelled.";
	}
	const base = `Answered '${decision}' with the agent's option '${chosen}'.`;
	return degrades
		? `${base} ${policy?.driver.title} has no session-scoped approval, so this approves this one call only — say so to the user rather than implying a standing rule.`
		: base;
}

/**
 * Why a settled session's folder cannot be cleaned right now — or nothing, and it is dead wood.
 *
 * Settled status is not evidence the folder is idle. A conversation that was restarted left its folder to its
 * successor; a restart mid-spawn is handing it over; a follow-up mid-reattach has a child spawned in it with a
 * prompt due in that directory. Three reasons, one question — the sweep over every settled session asks the same
 * one through `worktreeHasLiveClaim`, without needing the words.
 */
function cleanWorktreeRefusal(rt: DelegateRuntime, meta: SessionMeta): { message: string; code: string } | undefined {
	const id = meta.sessionId;
	if (meta.supersededBy) {
		return {
			message: `Session ${id} ${supersededPointerText(meta)}; its worktree is that session's to clean.`,
			code: "SESSION_SUPERSEDED",
		};
	}
	if (rt.restarting.has(id)) {
		return {
			message:
				`A delegate_restart of session ${id} is in flight and its worktree is being handed to that restart. ` +
				"Wait for it to finish, then try again.",
			code: "RESTART_IN_FLIGHT",
		};
	}
	if (rt.reattaching.has(id)) {
		return {
			message:
				`A follow-up is reconnecting session ${id} right now, and its agent works in that worktree. ` +
				"Wait for it, or delegate_cancel it, then clean up.",
			code: "SESSION_CONNECTING",
		};
	}
	return undefined;
}

export function buildSessionTools(rt: DelegateRuntime): ToolSpec[] {
	return [
		{
			name: "delegate_message",
			label: "Delegate Message",
			description:
				"Sends a follow-up prompt to a delegated session and returns immediately. The session must be idle: " +
				"a running session is still working, one whose process died is continued where the agent can " +
				"restore its conversation and otherwise restarted (delegate_restart), and one whose conversation a restart took over refuses and names where it went.",
			parameters: Type.Object({
				session_id: SESSION_ID,
				message: Type.String({ description: "Follow-up instruction for the session" }),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				await begin(rt, ctx);
				const meta = rt.sessions.get(String(params.session_id));
				if (!meta) {
					return errorResult(rt, "delegate_message", `Session '${params.session_id}' not found.`, { code: "NOT_FOUND" });
				}
				const res = await followUp(rt, meta, params.message);
				if (!res.ok) {
					return errorResult(rt, "delegate_message", `Cannot message '${meta.sessionId}': ${res.error}`, {
						code: res.code,
						sessionId: meta.sessionId,
						status: meta.status,
					});
				}
				const sent = `Sent to ${agentTitle(meta.agent)} session ${meta.sessionId}. You will be told when the turn ends.`;
				return textResult(rt, "delegate_message", sent, { result: "sent", sessionId: meta.sessionId, agent: meta.agent });
			},
		},
		{
			name: "delegate_permission",
			label: "Delegate Permission",
			description:
				"Answers a pending permission request from a delegated session. allow approves once; allow_session approves " +
				"for the session where the agent supports it (it degrades to once where it does not, and says so); reject refuses. " +
				"A request left unanswered times out to reject.",
			parameters: Type.Object({
				session_id: SESSION_ID,
				decision: Type.String({ description: `One of: ${PERMISSION_DECISIONS.join(", ")}` }),
				request_id: Type.Optional(Type.String({ description: "Which pending request to answer. Omit to answer the oldest one." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				await begin(rt, ctx);
				const meta = rt.sessions.get(String(params.session_id));
				if (!meta) {
					return errorResult(rt, "delegate_permission", `Session '${params.session_id}' not found.`, { code: "NOT_FOUND" });
				}
				const decision = String(params.decision ?? "").trim() as PermissionDecision;
				if (!(PERMISSION_DECISIONS as readonly string[]).includes(decision)) {
					return errorResult(
						rt,
						"delegate_permission",
						`Unknown decision '${params.decision}'. Valid: ${PERMISSION_DECISIONS.join(", ")}.`,
						{
							code: "INVALID_DECISION",
						},
					);
				}
				const pending = rt.pendingPermissions.get(meta.sessionId) ?? [];
				if (pending.length === 0) {
					return errorResult(rt, "delegate_permission", `Session '${meta.sessionId}' has no pending permission request.`, {
						code: "NO_PENDING_REQUEST",
						sessionId: meta.sessionId,
					});
				}
				const answered = rt.answerPermission(meta.sessionId, decision, "agent", params.request_id);
				if (!answered) {
					const ids = (rt.pendingPermissions.get(meta.sessionId) ?? []).map((r) => String(r.requestId));
					return errorResult(
						rt,
						"delegate_permission",
						`No pending request '${params.request_id}' on ${meta.sessionId}. Pending: ${ids.join(", ")}.`,
						{
							code: "UNKNOWN_REQUEST",
							pending: ids,
						},
					);
				}
				const remaining = rt.pendingPermissions.get(meta.sessionId) ?? [];
				const stillWaiting =
					remaining.length > 0
						? `\nAwaiting permission to run: ${commandForCaller(remaining[0].command)}${remaining.length > 1 ? ` (+${remaining.length - 1} more)` : ""}. Answer with "delegate_permission".`
						: "";
				return textResult(rt, "delegate_permission", permissionReply(meta.agent, decision, answered.optionId) + stillWaiting, {
					result: "answered",
					sessionId: meta.sessionId,
					agent: meta.agent,
					decision,
					optionId: answered.optionId ?? null,
					stillPending: (rt.pendingPermissions.get(meta.sessionId) ?? []).length,
				});
			},
		},
		{
			name: "delegate_cancel",
			label: "Delegate Cancel",
			description:
				"Cancels a running delegated session or removes a queued task by id. Stops the agent's process, releases a safe " +
				"worktree, and frees the slot so the queue moves.",
			parameters: Type.Object({ session_id: Type.String({ description: "Session ID (a running session) or queue ID (q-N)" }) }),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				await begin(rt, ctx);
				const outcome = await cancelSession(rt, String(params.session_id));
				if (outcome === "not_found") {
					const missing = `Nothing running or queued with id '${params.session_id}'. delegate_status lists the ids.`;
					return errorResult(rt, "delegate_cancel", missing, { code: "NOT_FOUND" });
				}
				if (outcome === "not_running") {
					// It finished. Saying "cancelled, the slot is free" would claim a slot that was never held and
					// rewrite a recorded outcome in the caller's mind.
					const meta = rt.sessions.get(String(params.session_id));
					return errorResult(
						rt,
						"delegate_cancel",
						`Session '${params.session_id}' is not running (it is ${meta?.status ?? "unknown"}), so there is nothing to cancel.`,
						{ code: "NOT_RUNNING", status: meta?.status },
					);
				}
				return textResult(
					rt,
					"delegate_cancel",
					`Cancelled ${outcome === "queued" ? "queued task" : "session"} ${params.session_id}. The slot is free and the queue is draining.`,
					{ result: outcome, cancelled: String(params.session_id) },
				);
			},
		},
		{
			name: "delegate_restart",
			label: "Delegate Restart",
			description:
				"Runs an interrupted, failed or finished session again in its original worktree, with the original prompt or a revised one. " +
				"The id it was given stops taking messages, and restarting it again refuses: the new session owns the conversation. " +
				"This starts a NEW session id — the old one keeps its record; a running session must be cancelled first.",
			parameters: Type.Object({
				session_id: SESSION_ID,
				prompt: Type.Optional(Type.String({ description: "Revised prompt. Omit to re-run the original." })),
				mode: Type.Optional(Type.String({ description: "Permission mode for the restarted session (default: the original session's)." })),
				agent: Type.Optional(Type.String({ description: "Run the restart on another agent (default: the original session's)." })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				// Claim the conversation from the id the caller wrote, before the first await. Everything between
				// here and the pointer — anchoring the session, the kill window, the spawn, the handshake, the first
				// prompt — is time in which `delegate_message` on this id would otherwise reattach the conversation
				// beside the sibling this call is starting, in the worktree the two share. In flight is
				// process-local: a restart that died with pi leaves nothing behind to dead-end anybody.
				const requested = String(params.session_id);
				if (rt.restarting.has(requested)) {
					return errorResult(rt, "delegate_restart", `Session '${requested}' is already being restarted; wait for that call.`, {
						code: "RESTART_IN_FLIGHT",
					});
				}
				rt.restarting.add(requested);
				try {
					await begin(rt, ctx);
					const meta = rt.sessions.get(requested);
					if (!meta) {
						return errorResult(rt, "delegate_restart", `Session '${params.session_id}' not found.`, { code: "NOT_FOUND" });
					}
					if (meta.supersededBy) {
						// This id's conversation already has an owner, and that owner may be live in the same worktree.
						// Restarting the dead id again would put a second agent of one conversation in that folder and
						// overwrite the pointer, so the caller is sent to the session that took it.
						return errorResult(
							rt,
							"delegate_restart",
							`'${meta.sessionId}' was ${supersededPointerText(meta)}. Restart or message that session instead; restarting this id again would put a second agent of one conversation in the worktree they share.`,
							{ code: "SUPERSEDED" },
						);
					}
					if (rt.reattaching.has(meta.sessionId)) {
						// The mirror of the rule below: a follow-up is reconnecting this conversation right now, and a
						// restart spawning beside it is the same two agents in one checkout.
						return errorResult(
							rt,
							"delegate_restart",
							`A follow-up is reconnecting '${meta.sessionId}' right now. Wait for it, or delegate_cancel it, then restart.`,
							{ code: "REATTACH_IN_FLIGHT" },
						);
					}
					if (meta.status === "running" || meta.status === "stalled") {
						return errorResult(
							rt,
							"delegate_restart",
							`Session '${meta.sessionId}' is ${meta.status}. Cancel it first with delegate_cancel.`,
							{
								code: "BUSY",
								status: meta.status,
							},
						);
					}
					if (meta.pid && rt.isPidAlive(meta.pid)) {
						if (meta.status !== "cancelled") {
							return errorResult(
								rt,
								"delegate_restart",
								`The ${meta.agent} process for '${meta.sessionId}' is still alive (pid ${meta.pid}). Cancel it with delegate_cancel before restarting.`,
								{ code: "PROCESS_ALIVE", pid: meta.pid },
							);
						}
						// Cancelled: the old process may still be inside its dispose kill window. Wait for the
						// SIGKILL timers to fire — starting a second agent on a worktree the first is still
						// writing to is how two sessions end up editing one checkout.
						rt.killProcessGroup(meta.pid, rt.driverCli(meta.agent));
						for (let i = 0; i < 30 && rt.isPidAlive(meta.pid); i++) {
							await new Promise((r) => setTimeout(r, 100));
						}
						if (rt.isPidAlive(meta.pid)) {
							return errorResult(
								rt,
								"delegate_restart",
								`The old process (pid ${meta.pid}) would not stop. Try delegate_restart again shortly.`,
								{
									code: "PROCESS_NOT_STOPPED",
								},
							);
						}
					}

					const agentId = params.agent ?? meta.agent;
					const admitted = admit({
						agent: agentId,
						model: meta.model,
						thinking: meta.thinking,
						mode: params.mode ?? meta.mode,
					});
					if (!admitted.ok) {
						return errorResult(rt, "delegate_restart", admitted.error, { code: admitted.code, agent: agentId });
					}

					// The worktree is the session's state: reuse it, and let `delegate` provision a fresh one
					// only when it is gone or was already released. Restarting into a deleted folder would put
					// the agent in the parent checkout, where it would edit the wrong tree.
					let worktree: DelegateRequest["reuseWorktree"] = {
						worktreePath: meta.worktreePath,
						worktreeBranch: meta.worktreeBranch,
						worktreeId: meta.worktreeId,
						parentWorktreeId: meta.parentWorktreeId,
						worktreeStatus: meta.worktreeStatus,
					};
					const releasing = meta.worktreePath !== undefined && rt.releasingWorktrees.has(meta.worktreePath);
					const reusable = worktreeIsReusable(rt, meta);
					if (!reusable && (meta.createWorktree || releasing)) {
						// Either it wants a folder of its own, or the one it names is on its way out — a cancel's
						// release runs unawaited, and "cancel then restart" is the documented recovery flow, so the two
						// overlap by design. Provision fresh rather than start the agent in a directory being removed.
						worktree = undefined;
					}

					const res = await delegate(rt, {
						driver: admitted.driver,
						selection: admitted.selection,
						prompt: params.prompt ?? meta.prompt,
						createWorktree: meta.createWorktree,
						parentSessionId: meta.sessionId,
						reuseWorktree: worktree,
					});
					if (!res.ok) {
						return errorResult(rt, "delegate_restart", `Failed to restart '${meta.sessionId}': ${res.error}`, { code: res.code });
					}
					// The conversation belongs to the restarted session now. A restart mints a new id and leaves this
					// record where it was, so without the pointer a later `delegate_message` to the old id would reattach
					// it beside its sibling: two live agents of one conversation in the worktree a restart reuses.
					markSuperseded(rt, meta, "started" in res ? { sessionId: res.started.sessionId } : { queueId: res.queued.queueId });
					const warnings = [...admitted.warnings];
					const note = warnings.length ? `\nNote: ${warnings.join("; ")}` : "";
					if ("started" in res) {
						return textResult(rt, "delegate_restart", `Restarted as session ${res.started.sessionId} (${res.started.agent}).${note}`, {
							result: "restarted",
							sessionId: res.started.sessionId,
							agent: res.started.agent,
							parentSessionId: meta.sessionId,
						});
					}
					return textResult(
						rt,
						"delegate_restart",
						`Restart queued as ${res.queued.queueId} (position ${res.position} of ${res.queueTotal}) — ${queueReasonText(rt, res.queued.agent, res.reason)}. You will receive the session id when it starts.${note}`,
						{
							result: "queued",
							queueId: res.queued.queueId,
							parentSessionId: meta.sessionId,
						},
					);
				} finally {
					rt.restarting.delete(requested);
				}
			},
		},
		{
			name: "delegate_clean_worktree",
			label: "Delegate Clean Worktree",
			description:
				"Removes the git worktree of a finished session, or of every settled session (--all_settled). Checks safety first: " +
				"a worktree with uncommitted or unpushed work is kept and reported, not deleted.",
			parameters: Type.Object({
				session_id: Type.Optional(Type.String({ description: "Session ID whose worktree to remove" })),
				all_settled: Type.Optional(
					Type.Boolean({ description: "Clean every session whose turn has ended and whose PR is merged or closed" }),
				),
				force: Type.Optional(
					Type.Boolean({ description: "Skip the safety check. Only when the user has confirmed the work is disposable." }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				await begin(rt, ctx);
				const targets: SessionMeta[] = [];
				if (params.session_id !== undefined) {
					const meta = rt.sessions.get(String(params.session_id));
					if (!meta) {
						return errorResult(rt, "delegate_clean_worktree", `Session '${params.session_id}' not found.`, { code: "NOT_FOUND" });
					}
					const refusal = cleanWorktreeRefusal(rt, meta);
					if (refusal) {
						return errorResult(rt, "delegate_clean_worktree", refusal.message, {
							code: refusal.code,
							session_id: meta.sessionId,
						});
					}
					targets.push(meta);
				} else if (params.all_settled === true) {
					for (const s of rt.sessions.values()) {
						if (s.status === "running" || s.status === "stalled") {
							continue;
						}
						// A settled record whose conversation moved on — or is moving this moment — is not evidence its
						// folder is dead wood: a restart, written or in flight, owns it.
						if (worktreeHasLiveClaim(rt, s)) {
							continue;
						}
						if (s.worktreePath && s.worktreeStatus === "active") {
							targets.push(s);
						}
					}
				} else {
					return errorResult(rt, "delegate_clean_worktree", "Pass session_id or all_settled.", { code: "INVALID_PARAMS" });
				}

				const notes: string[] = [];
				for (const meta of targets) {
					if (!meta.worktreePath) {
						notes.push(`${meta.sessionId}: no worktree`);
						continue;
					}
					// Collected targets are a list of intentions, not a set of permissions: the releases below
					// await, and a restart or a follow-up can claim one of the later folders while the first is
					// still being removed.
					const claim = cleanWorktreeRefusal(rt, meta);
					if (claim) {
						return claim;
					}
					if (meta.status === "running" || meta.status === "stalled") {
						// The agent is working in that folder. Removing it under a live process — or marking the
						// session's worktree `retained` so the PR hook and the cancel path both stop looking at it —
						// is worse than refusing, whatever `force` was passed for.
						return errorResult(
							rt,
							"delegate_clean_worktree",
							`Session ${meta.sessionId} is ${meta.status}; its worktree is where it is working. Cancel it first, then clean.`,
							{ code: "SESSION_ACTIVE", session_id: meta.sessionId },
						);
					}
					try {
						const res = await releaseWorktree(rt, meta, { force: params.force === true });
						notes.push(`${meta.sessionId}: ${res.note}`);
					} catch (err) {
						notes.push(`${meta.sessionId}: failed (${extractCliError(err)})`);
					}
				}
				if (targets.length === 0) {
					return textResult(rt, "delegate_clean_worktree", "No settled session holds an active worktree.", { result: "nothing_to_do" });
				}
				// What changed is worth a line even when nothing was removed: `kept: <reason>` is the answer to
				// "why is this folder still here", and the operator is the only one who can decide to force it.
				rt.persistState();
				rt.updateStatusUI();
				return textResult(rt, "delegate_clean_worktree", notes.join("\n"), { result: "done", sessions: targets.length });
			},
		},
	];
}
