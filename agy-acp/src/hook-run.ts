// The agy PreToolUse hook the session bridge dials. agy runs it via
// `sh -c "exec <node> <abs>/bridge-hook.ts"` (script mode) or `sh -c "exec <binary> --bridge-hook"`
// (SEA mode, where the same function is re-executed inside the single executable); the `exec`
// matters: without it a timeout kills the sh and leaves this process running. stdin is the hook
// payload JSON, stdout is the decision.
//
// Fail-closed by construction: every exit path goes through finish(), the only writer on stdout,
// which always prints one JSON decision object first AND waits for it to reach the pipe before
// exiting. Empty stdout is impossible - in agy, empty stdout means allow, so this is the security
// line, and a half-written line is the same failure: unparseable JSON is not a denial. The "Do not
// retry this call" wording matters: without it the model retried 5 times (spike). All paths exit 0:
// a non-zero exit would make agy report its own generic "hook failed" text instead of the reason
// the model needs.
//
// The deadline ladder (enforced by the caller, mirrored here): the client deadline (default 10 min)
// is below AGY_ACP_HOOK_DEADLINE_MS (this file's own timer), which is below the hooks.json timeout,
// which is the only timer agy itself enforces.
//
// `runBridgeHook()` is entered exactly once per process: as the whole program by `bridge-hook.ts`,
// or by `main.ts` when the binary is invoked with `--bridge-hook` (there the whole server module
// graph has already evaluated: a module-eval failure exits non-zero with empty stdout, which agy
// reads as a fail-closed hook failure).

import { connect } from "node:net";
import { FLUSH_TIMEOUT_MS } from "./flush-stdout.ts";

export function runBridgeHook(): void {
	const NO_RETRY = "Do not retry this call.";
	/**
	 * The ceiling on each stream this hook reads - its own stdin payload, and the bridge's answer. agy
	 * writes the first and agy-acp writes the second, but the hook is the security boundary and must
	 * not be the one reader that buffers whatever it is handed: past the ceiling it denies, which is
	 * the answer it would have to give anyway. A deny reason is kilobytes (the longest recorded is
	 * under 300 KiB).
	 */
	const MAX_STREAM_BYTES = 1024 * 1024;
	const local = (why: string): string => `denied by agy-acp: ${why}`;

	const written = { value: false };
	/** The single stdout writer: prints one JSON decision, then exits 0. Idempotent. Every denial
	 * carries the no-retry wording - enforced here, so no path can forget it. */
	function finish(decision: "allow" | "deny", reason?: string): void {
		if (written.value) {
			return;
		}
		written.value = true;
		const why = reason ?? "the permission bridge failed";
		const out =
			decision === "deny"
				? JSON.stringify({ decision, reason: why.includes(NO_RETRY) ? why : `${why}. ${NO_RETRY}` })
				: JSON.stringify({ decision });
		// The exit must not outrun the bytes: a bare `process.exit` abandons whatever stdout still has
		// queued, and a decision stops fitting one write as soon as a deny reason is long (the pipe
		// buffer is 64 KiB) - exiting here truncated the JSON into something agy cannot parse, which it
		// reads as no decision at all. So leave from the write's own completion callback, with a bounded
		// fallback for a stdout nobody drains: a hook that never exits is worse than a late one.
		const leave = (): void => process.exit(0);
		setTimeout(leave, FLUSH_TIMEOUT_MS);
		try {
			process.stdout.write(out, leave);
		} catch {
			// a dead stdout cannot be revived; the bytes already queued still say the decision
			leave();
		}
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
	function makeRequest(o: Record<string, unknown>): Record<string, unknown> {
		const tc = typeof o.toolCall === "object" && o.toolCall !== null ? (o.toolCall as Record<string, unknown>) : {};
		const args = typeof tc.args === "object" && tc.args !== null ? (tc.args as Record<string, unknown>) : {};
		return {
			token: process.env.AGY_ACP_TOKEN ?? "",
			conversationId: typeof o.conversationId === "string" ? o.conversationId : "",
			stepIdx: typeof o.stepIdx === "number" ? o.stepIdx : -1,
			toolCall: { name: typeof tc.name === "string" ? tc.name : "", args },
		};
	}
	function handleReply(raw: string): void {
		let ans: unknown;
		try {
			ans = JSON.parse(raw);
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
	}
	function onPayload(): void {
		if (payloadHandled) {
			return;
		}
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
		const request = makeRequest(o);
		const conn = connect(sock);
		let buf = "";
		conn.on("connect", () => {
			try {
				conn.write(`${JSON.stringify(request)}\n`);
			} catch {
				finish("deny", local("writing to the permission bridge failed"));
			}
		});
		let replyBytes = 0;
		conn.on("data", (d: Buffer) => {
			replyBytes += d.length;
			if (replyBytes > MAX_STREAM_BYTES) {
				finish("deny", local(`the answer from the permission bridge exceeded ${MAX_STREAM_BYTES} bytes`));
				return;
			}
			buf += d.toString("utf8");
			const i = buf.indexOf("\n");
			if (i < 0) {
				return;
			}
			handleReply(buf.slice(0, i));
		});
		conn.on("error", (err: Error) => finish("deny", local(`the permission socket is unavailable (${err.message})`)));
		conn.on("close", () =>
			finish("deny", local("the permission bridge closed the connection before answering (the token may be rejected)")),
		);
	}

	process.stdin.setEncoding("utf8");
	let inputBytes = 0;
	process.stdin.on("data", (d: string) => {
		inputBytes += Buffer.byteLength(d, "utf8");
		if (inputBytes > MAX_STREAM_BYTES) {
			finish("deny", local(`the hook payload exceeded ${MAX_STREAM_BYTES} bytes`));
			return;
		}
		input += d;
	});
	process.stdin.on("end", () => onPayload());
}
