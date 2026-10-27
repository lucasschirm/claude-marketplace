// agy PreToolUse hook -> agy-acp permission bridge (zero deps, Node >= 23.6).
// agy runs this via `sh -c "exec node bridge-hook.ts"`; stdin = hook payload JSON.
// It forwards the payload over the Unix socket named by AGY_ACP_SOCK, blocks for the
// parent's answer and prints {"decision":"allow"|"deny","reason"} on stdout.
// Every failure path prints an explicit deny (fail closed) and exits 0, so the model
// sees a readable reason instead of agy's generic "hook failed" text.
import { connect } from "node:net";

const sock = process.env.AGY_ACP_SOCK;
const deadlineMs = Number(process.env.AGY_ACP_HOOK_DEADLINE_MS ?? 0); // 0 = rely on agy's timeout
const t0 = Date.now();
let done = false;

function finish(decision: "allow" | "deny", reason?: string): void {
  if (done) return;
  done = true;
  process.stdout.write(JSON.stringify(reason ? { decision, reason } : { decision }));
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => { input += d; });
process.stdin.on("end", () => {
  let payload: unknown;
  try { payload = JSON.parse(input); } catch { return finish("deny", "agy-acp: unreadable hook payload"); }
  if (!sock) return finish("deny", "agy-acp: AGY_ACP_SOCK not set; permission bridge unavailable");
  if (deadlineMs > 0) setTimeout(() => finish("deny", `agy-acp: the user did not answer this permission request within ${Math.round(deadlineMs / 1000)} s. Do not retry this action or work around it; stop and ask the user how to proceed.`), deadlineMs).unref();
  const c = connect(sock);
  let buf = "";
  c.setEncoding("utf8");
  c.on("connect", () => {
    c.write(JSON.stringify({ v: 1, type: "pre_tool_use", hookPid: process.pid, spawnedMs: Date.now() - t0, payload }) + "\n");
  });
  c.on("data", (d: string) => {
    buf += d;
    const i = buf.indexOf("\n");
    if (i < 0) return;
    let ans: { decision?: string; reason?: string };
    try { ans = JSON.parse(buf.slice(0, i)); } catch { return finish("deny", "agy-acp: malformed answer from bridge"); }
    if (ans.decision === "allow") return finish("allow");
    return finish("deny", ans.reason || "agy-acp: denied by user");
  });
  c.on("error", (e: Error) => finish("deny", `agy-acp: permission bridge unavailable (${e.message})`));
  c.on("close", () => finish("deny", "agy-acp: permission bridge closed before answering"));
});
process.on("SIGTERM", () => finish("deny", "agy-acp: hook terminated"));
