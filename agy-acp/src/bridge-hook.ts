#!/usr/bin/env node
// The agy PreToolUse hook the session bridge dials. agy runs this via
// `sh -c "exec <node> <abs>/bridge-hook.ts"` (the `exec` matters: without it a timeout kills
// the sh and leaves this process running); stdin is the hook payload JSON, stdout is the
// decision.
//
// Fail-closed by construction: every exit path goes through finish(), the only writer on
// stdout, which always prints one JSON decision object first. Empty stdout is impossible -
// in agy, empty stdout means allow, so this is the security line. The "Do not retry this
// call" wording matters: without it the model retried 5 times (spike). All paths exit 0:
// a non-zero exit would make agy report its own generic "hook failed" text instead of the
// reason the model needs.
//
// The deadline ladder (enforced by the caller, mirrored here): the client deadline (default
// 10 min) is below AGY_ACP_HOOK_DEADLINE_MS (this file's own timer), which is below the
// hooks.json timeout, which is the only timer agy itself enforces.

import { connect } from "node:net";

const NO_RETRY = "Do not retry this call.";
const local = (why: string): string => `denied by agy-acp: ${why}`;

const written = { value: false };
/** The single stdout writer: prints one JSON decision, then exits 0. Idempotent. Every denial
 * carries the no-retry wording - enforced here, so no path can forget it. */
function finish(decision: "allow" | "deny", reason?: string): void {
	if (written.value) return;
	written.value = true;
	const out =
		decision === "deny"
			? (() => {
					const r = reason ?? "the permission bridge failed";
					return JSON.stringify({ decision, reason: r.includes(NO_RETRY) ? r : `${r}. ${NO_RETRY}` });
				})()
			: JSON.stringify({ decision });
	try {
		process.stdout.write(out);
	} catch {
		// a dead stdout cannot be revived; the bytes already queued still say the decision
	}
	process.exit(0);
}

const deadlineMs = Number(process.env.AGY_ACP_HOOK_DEADLINE_MS ?? 0);
if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
	setTimeout(
		() => finish("deny", local(`no answer from the permission bridge within ${Math.round(deadlineMs / 1000)} s`)),
		deadlineMs,
	).unref();
}
process.on("SIGTERM", () => finish("deny", local("the hook was terminated")));
process.on("SIGINT", () => finish("deny", local("the hook was terminated")));
process.on("uncaughtException", (err) => finish("deny", local(`the hook failed (${err.message})`)));

let input = "";
let payloadHandled = false;
function onPayload(): void {
	if (payloadHandled) return;
	payloadHandled = true;
	let payload: unknown;
	try {
		payload = JSON.parse(input);
	} catch {
		finish("deny", local("the hook payload is not valid JSON"));
		return;
	}
	const sock = process.env.AGY_ACP_SOCK;
	if (!sock) {
		finish("deny", local("AGY_ACP_SOCK is not set (the permission bridge is unavailable)"));
		return;
	}
	const o = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
	const tc = typeof o.toolCall === "object" && o.toolCall !== null ? (o.toolCall as Record<string, unknown>) : {};
	const args = typeof tc.args === "object" && tc.args !== null ? (tc.args as Record<string, unknown>) : {};
	const request = {
		token: process.env.AGY_ACP_TOKEN ?? "",
		conversationId: typeof o.conversationId === "string" ? o.conversationId : "",
		stepIdx: typeof o.stepIdx === "number" ? o.stepIdx : -1,
		toolCall: { name: typeof tc.name === "string" ? tc.name : "", args },
	};
	const conn = connect(sock);
	let buf = "";
	conn.on("connect", () => {
		try {
			conn.write(`${JSON.stringify(request)}\n`);
		} catch {
			finish("deny", local("writing to the permission bridge failed"));
		}
	});
	conn.on("data", (d: Buffer) => {
		buf += d.toString("utf8");
		const i = buf.indexOf("\n");
		if (i < 0) return;
		let ans: unknown;
		try {
			ans = JSON.parse(buf.slice(0, i));
		} catch {
			finish("deny", local("the answer from the permission bridge was not valid JSON"));
			return;
		}
		const a = typeof ans === "object" && ans !== null ? (ans as Record<string, unknown>) : {};
		if (a.decision === "allow") {
			finish("allow");
			return;
		}
		if (a.decision === "deny") {
			finish("deny", typeof a.reason === "string" && a.reason !== "" ? a.reason : local("the permission bridge denied the call"));
			return;
		}
		finish("deny", local("the answer from the permission bridge was not a decision"));
	});
	conn.on("error", (err: Error) => finish("deny", local(`the permission socket is unavailable (${err.message})`)));
	conn.on("close", () => finish("deny", local("the permission bridge closed the connection before answering (the token may be rejected)")));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
	input += d;
});
process.stdin.on("end", () => onPayload());
