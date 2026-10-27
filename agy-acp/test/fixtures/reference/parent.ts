// Minimal agy-acp permission-bridge prototype (zero deps, Node >= 23.6).
// usage: node parent.ts <scenario.json>
// scenario: { name, repo, home?, hookTimeoutS, hookDeadlineMs?, turns: [{ prompt, answer }] }
//   answer: "allow" | "deny" | "silent" | {"delayMs":n,"then":"allow"|"deny"} | "close-server" | "die"
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const SPIKE = dirname(HERE);
const sc = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = join(SPIKE, "runs", "proto-" + sc.name);
mkdirSync(out, { recursive: true });
const tl = join(out, "timeline.txt");
writeFileSync(tl, "");
const t0 = performance.now();
const ts = () => (performance.now() - t0).toFixed(1).padStart(9);
const log = (s: string) => appendFileSync(tl, `${ts()} ${s}\n`);

// 1. Private bridge dir, injected with --add-dir. Path sorts after the repo path so our hook runs last.
const id = randomBytes(4).toString("hex");
const bridgeDir = join(SPIKE, "zz-bridge-" + id);
mkdirSync(join(bridgeDir, ".agents"), { recursive: true });
const hookName = "agy-acp-" + randomBytes(8).toString("hex"); // unguessable: a repo hook cannot shadow it
writeFileSync(join(bridgeDir, ".agents", "hooks.json"), JSON.stringify({
  [hookName]: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `exec ${process.execPath} ${join(HERE, "bridge-hook.ts")}`, timeout: sc.hookTimeoutS }] }] },
}, null, 2));

// 2. Socket server. Hook cwd is <bridgeDir>/.agents, so a relative path keeps us under the 107-byte sun_path limit.
process.chdir(bridgeDir);
const SOCK_REL = "agy-acp.sock";
const conns = new Set<Socket>();
let turnIdx = -1;
let lastActive = 0;
let lastAnswer = 0;
const server = createServer((c) => {
  conns.add(c);
  c.on("close", () => conns.delete(c));
  let buf = "";
  c.setEncoding("utf8");
  c.on("data", (d: string) => {
    buf += d;
    const i = buf.indexOf("\n");
    if (i < 0) return;
    const req = JSON.parse(buf.slice(0, i));
    const tReq = performance.now();
    const p = req.payload;
    log(`REQ hookPid=${req.hookPid} hookStartToConnect=${req.spawnedMs}ms sinceToolActive=${(tReq - lastActive).toFixed(1)}ms tool=${p.toolCall?.name} stepIdx=${p.stepIdx} args=${JSON.stringify(p.toolCall?.args).slice(0, 160)}`);
    const ans = sc.turns[turnIdx]?.answer ?? "deny";
    const reply = (decision: string, reason?: string) => {
      lastAnswer = performance.now();
      log(`ANS ${decision}${reason ? " " + reason : ""} (held ${(lastAnswer - tReq).toFixed(1)}ms)`);
      c.write(JSON.stringify({ decision, reason }) + "\n");
    };
    if (ans === "allow") reply("allow");
    else if (ans === "deny") reply("deny", "User rejected this tool call in the ACP client (code PROTO-REJECT-42).");
    else if (ans === "silent") log("ANS (silent: never answering)");
    else if (ans === "close-server") { log("closing server + all connections"); server.close(); for (const k of conns) k.destroy(); }
    else if (ans === "die") { log(`parent SIGKILLing itself; agy pid=${child.pid}`); writeFileSync(join(out, "agy.pid"), String(child.pid)); process.kill(process.pid, "SIGKILL"); }
    else if (typeof ans === "object") setTimeout(() => reply(ans.then, ans.then === "deny" ? "late deny" : undefined), ans.delayMs);
  });
});
server.listen(SOCK_REL, () => log(`listening on ${bridgeDir}/${SOCK_REL}; hook=${hookName}`));

// 3. agy in stream-json mode, all native prompts disabled; the hook is the only gate.
const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("ORCA_") && v !== undefined) env[k] = v;
if (sc.home) env.HOME = sc.home;
env.AGY_ACP_SOCK = "../" + SOCK_REL;
if (sc.hookDeadlineMs) env.AGY_ACP_HOOK_DEADLINE_MS = String(sc.hookDeadlineMs);
const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.8-flash-low",
  "--dangerously-skip-permissions", "--add-dir", bridgeDir, "--log-file", join(out, "agy.log"), "-p="];
const child = spawn("agy", args, { cwd: sc.repo, env, stdio: ["pipe", "pipe", "pipe"] });
log(`spawned agy pid=${child.pid}`);
let err = "";
child.stderr.on("data", (d) => { err += d; });
const nd = join(out, "stdout.ndjson");
writeFileSync(nd, "");
let lb = "";
function nextTurn() {
  turnIdx++;
  const t = sc.turns[turnIdx];
  if (!t) { log("close stdin"); child.stdin.end(); return; }
  const line = JSON.stringify({ event: "user", message: { content: t.prompt } });
  appendFileSync(join(SPIKE, "turn-ledger.txt"), `${new Date().toISOString()}\tproto-${sc.name}\t${line.slice(0, 160)}\n`);
  log(`>> turn ${turnIdx} answer=${JSON.stringify(t.answer)}: ${t.prompt}`);
  child.stdin.write(line + "\n");
}
child.stdout.on("data", (d) => {
  lb += d;
  let i;
  while ((i = lb.indexOf("\n")) >= 0) {
    const line = lb.slice(0, i); lb = lb.slice(i + 1);
    appendFileSync(nd, line + "\n");
    const ev = JSON.parse(line);
    const su = ev.step_update;
    if (su?.step_type === "tool") {
      if (su.state === "ACTIVE") lastActive = performance.now();
      const extra = su.state !== "ACTIVE" && lastAnswer ? ` sinceAnswer=${(performance.now() - lastAnswer).toFixed(1)}ms` : "";
      log(`EV tool ${su.tool_name} ${su.state} step=${su.step_index}${extra}${su.tool_info?.error ? " err=" + JSON.stringify(su.tool_info.error.message).slice(0, 200) : ""}`);
    } else if (su) log(`EV ${su.step_type} ${su.state}${su.text_delta ? " " + JSON.stringify(su.text_delta).slice(0, 100) : ""}`);
    else log(`EV ${ev.event}${ev.result ? " " + JSON.stringify({ s: ev.result.status, e: ev.result.error, r: ev.result.response, d: ev.result.denied_actions }).slice(0, 300) : ""}`);
    if (ev.event === "result") setTimeout(nextTurn, 100);
  }
});
child.on("exit", (code, sig) => {
  log(`agy exit code=${code} sig=${sig}`);
  writeFileSync(join(out, "stderr.txt"), err);
  server.close();
  for (const k of conns) k.destroy();
  rmSync(bridgeDir, { recursive: true, force: true });
  process.stdout.write(readFileSync(tl, "utf8"));
});
nextTurn();
setTimeout(() => { log("WATCHDOG: killing agy"); child.kill("SIGKILL"); }, sc.watchdogMs ?? 600000).unref();
