// The tool surface: parameter shapes, admission, and results an agent can act on.
//
// Every result here carries the same `details` block (counters, the code that decided this outcome) so a
// follow-up turn does not have to re-query the engine to know whether it is looking at a queue or a
// session. Errors are results too, and they name the code (`UNKNOWN_AGENT`, `THINKING_UNSUPPORTED`,
// `AGENT_UNAVAILABLE`) because the caller is a model, and "Unknown agent" without the list of known ones
// is a question rather than an answer.
//
// Nothing in this file owns state or control flow. Admission is `registry.admit`, the lifecycle is
// `queue.delegate`, and the transcript is `transcript.readLastMessages`. A tool that starts managing a
// timer here is a tool that has escaped the engine.

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { admit, agentDescription, DEFAULT_AGENT, modelDescription, modeDescription, thinkingDescription } from "./registry.ts";
import type { DelegateRuntime } from "./runtime.ts";
import { delegate, type QueueReason } from "./queue.ts";
import { commandForCaller } from "./permissions.ts";
import { readFullTranscript, readLastMessages } from "./transcript.ts";
import type { SessionMeta } from "./types.ts";
import { capList } from "../tool-result.ts";

/** What `pi.registerTool` needs, kept loose so the table can hold tools with different params. */
export interface ToolSpec {
	name: string;
	label: string;
	description: string;
	parameters: any;
	execute(toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionToolContext): Promise<any>;
}

export function textResult(rt: DelegateRuntime, tool: string, text: string, extra: Record<string, unknown> = {}): any {
	return { content: [{ type: "text", text }], details: rt.toolDetails(tool, extra) };
}

export function errorResult(rt: DelegateRuntime, tool: string, text: string, extra: Record<string, unknown> = {}): any {
	return { content: [{ type: "text", text }], details: rt.toolDetails(tool, { result: "error", ...extra }), isError: true };
}

/** The prologue every tool runs: which UI to notify, and a state recovery that must finish first. */
export async function begin(rt: DelegateRuntime, ctx: ExtensionToolContext): Promise<void> {
	rt.setUi(ctx.ui);
	// Recovery runs detached from session_start: reading or mutating state before it finishes means
	// this call's changes are overwritten when it does (the queue, the counters).
	await rt.recoveryDone;
	rt.warnPiSessionMismatch(ctx);
}

// Generated from the driver registry, so a second agent cannot be added without the tool text saying so.
const AGENT_PARAM = Type.Optional(Type.String({ description: agentDescription() }));
const MODE_PARAM = Type.Optional(Type.String({ description: modeDescription() }));

/** One line per session: id, agent, status, and the thing that distinguishes it (PR, model, queue position). */
function sessionLine(s: SessionMeta): string {
	const bits: string[] = [s.status];
	if (s.status === "running" || s.status === "stalled") {
		bits.push(`pid ${s.pid ?? "?"}`);
	}
	if (s.model) {
		bits.push(s.model);
	}
	if (s.thinking) {
		bits.push(`thinking=${s.thinking}`);
	}
	if (s.detectedPrNumber) {
		bits.push(`PR #${s.detectedPrNumber}`);
	}
	if (s.worktreePath) {
		bits.push(s.worktreePath);
	}
	if (s.error) {
		bits.push(`error: ${s.error}`);
	}
	return `- ${s.sessionId} (${s.agent}) ${bits.join(", ")} — ${clip(s.prompt, 120)}`;
}

function clip(text: string, max: number): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * What the queue reply says about *why* the task waits.
 *
 * The three reasons ask for three different actions — wait, cancel a session of this agent, or cancel
 * any session — so naming the wrong one sends the caller to the wrong target.
 */
export function queueReasonText(rt: DelegateRuntime, agent: string, reason: QueueReason): string {
	if (reason === "agent-limit") {
		return `${agent} is at its limit of ${rt.maxRuns}`;
	}
	if (reason === "total-limit") {
		return `${rt.slots.inFlight()} sessions are in flight of the ${rt.maxRunsTotal} total limit (${agent} alone would allow ${rt.maxRuns})`;
	}
	return "other tasks are already queued, and the queue is served in order";
}

/** `delegate_status` without an id: the whole picture, in the order a caller acts on it. */
function overview(rt: DelegateRuntime): string {
	const sessions = [...rt.sessions.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	const lines: string[] = [];
	lines.push(
		`Delegated sessions: ${sessions.length} (${rt.slots.inFlight()} in flight of ${rt.maxRunsTotal} total, ${rt.maxRuns} per agent), ${rt.queue.length} queued, ${rt.totalCompleted} completed.`,
	);
	if (rt.pendingPermissions.size > 0) {
		lines.push(`Awaiting a permission decision: ${[...rt.pendingPermissions.keys()].join(", ")} — answer with delegate_permission.`);
	}
	for (const s of sessions) {
		lines.push(sessionLine(s));
	}
	if (rt.queue.length > 0) {
		lines.push("Queued:");
		for (const [i, q] of rt.queue.entries()) {
			lines.push(`- ${q.queueId} (${q.agent}) #${i + 1} — ${clip(q.prompt, 100)}`);
		}
	}
	if (sessions.length === 0 && rt.queue.length === 0) {
		lines.push("Nothing delegated yet. Start one with delegate_task (agents: describeAgents lists them).");
	}
	return lines.join("\n");
}

/** `delegate_status` with an id: meta, then what the agent actually said. */
function sessionReport(rt: DelegateRuntime, meta: SessionMeta, full: boolean, limit: number): string {
	const lines: string[] = [];
	lines.push(`Session ${meta.sessionId} (${meta.agent}): ${meta.status}`);
	const facts = [`mode=${meta.mode}`];
	if (meta.model) {
		facts.push(`model=${meta.model}`);
	}
	if (meta.thinking) {
		facts.push(`thinking=${meta.thinking} (requested)`);
	}
	if (meta.startedAt) {
		facts.push(`started ${new Date(meta.startedAt).toLocaleString()}`);
	}
	if (meta.turnCompletedAt) {
		facts.push(`turn ended ${new Date(meta.turnCompletedAt).toLocaleString()}`);
	}
	if (meta.stopReason) {
		facts.push(`stopReason=${meta.stopReason}`);
	}
	if (meta.detectedPrNumber) {
		facts.push(`PR #${meta.detectedPrNumber}`);
	}
	if (meta.worktreePath) {
		facts.push(`worktree ${meta.worktreePath} (${meta.worktreeStatus ?? "active"})`);
	}
	if (meta.pid) {
		facts.push(`pid ${meta.pid}${rt.isPidAlive(meta.pid) ? "" : " (dead)"}`);
	}
	lines.push(facts.join(", "));
	if (meta.error) {
		lines.push(`Error: ${meta.error}`);
	}

	// One request per line, oldest first, and the rest as a count: a session that asks for ten commands
	// must not turn its own status report into ten screens. The caller acts on the oldest anyway.
	const pending = rt.pendingPermissions.get(meta.sessionId) ?? [];
	if (pending.length > 0) {
		const [first, ...rest] = pending;
		lines.push(
			// Quoted, capped and framed like every other surface that shows this text, and the id is printed the
			// way the tool asks it back (as text), because a copy-pasteable line is the point of showing it.
			`Awaiting permission (request ${first.requestId}): ${commandForCaller(first.command)}${rest.length > 0 ? ` (+${rest.length} more)` : ""} — answer with delegate_permission(session_id='${meta.sessionId}', decision=allow|allow_session|reject, request_id='${String(first.requestId)}').`,
		);
	}
	lines.push("");
	lines.push(full ? readFullTranscript(rt, meta) : readLastMessages(rt, meta, limit).join("\n\n"));
	return lines.join("\n");
}

export function buildTools(rt: DelegateRuntime): ToolSpec[] {
	return [
		{
			name: "delegate_task",
			label: "Delegate Task",
			description:
				"Delegates a task to another agent (Devin, Claude) in the background and returns immediately. " +
				"Runs asynchronously; queues when the agent or the total limit is reached. Watch it with delegate_status, " +
				"continue it with delegate_message, answer its permission requests with delegate_permission.",
			parameters: Type.Object({
				prompt: Type.String({ description: "Instructions and task description for the agent" }),
				agent: AGENT_PARAM,
				model: Type.Optional(Type.String({ description: modelDescription() })),
				thinking: Type.Optional(Type.String({ description: thinkingDescription() })),
				mode: MODE_PARAM,
				create_worktree: Type.Optional(
					Type.Boolean({ description: "Run in an isolated git worktree instead of the current checkout (default: false)" }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				await begin(rt, ctx);
				const admitted = admit({
					agent: params.agent,
					model: params.model,
					thinking: params.thinking,
					mode: params.mode,
				});
				if (!admitted.ok) {
					return errorResult(rt, "delegate_task", admitted.error, { code: admitted.code, agent: params.agent ?? DEFAULT_AGENT });
				}
				const res = await delegate(rt, {
					driver: admitted.driver,
					selection: admitted.selection,
					prompt: params.prompt,
					createWorktree: params.create_worktree === true,
				});
				if (!res.ok) {
					return errorResult(rt, "delegate_task", `Failed to start the ${admitted.driver.id} session: ${res.error}`, {
						code: res.code,
						agent: admitted.driver.id,
					});
				}
				const warnings = [...admitted.warnings, ...res.warnings];
				const note = warnings.length ? `\nNote: ${warnings.join("; ")}` : "";
				if ("started" in res) {
					const meta = res.started;
					return textResult(
						rt,
						"delegate_task",
						`Delegated to ${admitted.driver.title}. Session id: ${meta.sessionId}. It runs now; you will be told when the turn ends.${note}`,
						{
							result: "started",
							agent: meta.agent,
							sessionId: meta.sessionId,
							model: meta.model,
							thinking: meta.thinking,
							mode: meta.mode,
							warnings,
						},
					);
				}
				const q = res.queued;
				return textResult(
					rt,
					"delegate_task",
					`Delegated to ${admitted.driver.title}, queued as ${q.queueId} (position ${res.position} of ${res.queueTotal}) — ${queueReasonText(rt, q.agent, res.reason)}. You will receive the session id when it starts.${note}`,
					{
						result: "queued",
						agent: q.agent,
						queueId: q.queueId,
						queuePosition: res.position,
						queueTotal: res.queueTotal,
						queueReason: res.reason,
						warnings,
					},
				);
			},
		},
		{
			name: "delegate_status",
			label: "Delegate Status",
			description:
				"Reads delegated sessions: everything in flight and queued when no id is given, or one session's state and transcript. " +
				"Reads from disk, so a session whose agent process has died is still readable.",
			parameters: Type.Object({
				session_id: Type.Optional(
					Type.String({ description: "Session ID to inspect. Omit for the overview of all sessions and the queue." }),
				),
				full: Type.Optional(Type.Boolean({ description: "With session_id: the whole transcript instead of the last messages (verbose)" })),
				limit: Type.Optional(Type.Number({ description: "With session_id: how many last messages to return (default 3)" })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				await begin(rt, ctx);
				if (params.session_id === undefined) {
					return textResult(rt, "delegate_status", overview(rt), { result: "overview" });
				}
				const meta = rt.sessions.get(String(params.session_id));
				if (!meta) {
					const ids = [...rt.sessions.keys()];
					return errorResult(
						rt,
						"delegate_status",
						`Session '${params.session_id}' not found.${ids.length ? ` Known: ${ids.slice(0, 10).join(", ")}` : ""}`,
						{ code: "NOT_FOUND", requested: String(params.session_id), ...capList("knownSessions", ids) },
					);
				}
				return textResult(rt, "delegate_status", sessionReport(rt, meta, params.full === true, params.limit ?? 3), {
					result: "session",
					sessionId: meta.sessionId,
					agent: meta.agent,
					status: meta.status,
				});
			},
		},
	];
}
