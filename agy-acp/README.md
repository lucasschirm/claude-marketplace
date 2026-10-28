# agy-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server that drives Google's
`agy` CLI through its documented headless mode
(`agy -p --input-format stream-json --output-format stream-json`).

It speaks JSON-RPC 2.0 over stdio: newline-delimited frames on stdin/stdout, diagnostics on stderr
(or the file named by `AGY_ACP_LOG`). Any ACP client — Zed, or this repo's Pi delegate, which already
talks ACP to `devin acp` — can spawn it and hand work to Antigravity.

## Status

The transport, the `initialize` handshake, the **agy process driver** (the `AgyProcess` in
`src/agy/`, driven in tests by the fixture-replaying fake `agy` under `test/`) and the
**session layer** (`src/session.ts` + `src/server.ts`) are implemented. `session/new`
validates `cwd` (absolute, existing directory) and `mcpServers`, probes agy for the
`conversation_id`, and returns the live permission `modes` (see below; agy-level model and
effort selection lands in sub-issue 6); requested `mcpServers` are reported via `_meta`
rather than silently dropped. `session/prompt`
accepts text, resource-link and embedded-text blocks (flattened to one text, since agy
headless is text-only), rejects image/audio with `-32602`, and runs one turn at a time
(`-32002`). The stream maps to `session/update` notifications - `text_delta` becomes
`agent_message_chunk`, tool steps become `tool_call` / `tool_call_update` (pending, completed
with truncated output, or failed), per-turn usage becomes `usage_update` - and every turn
ends with a `stopReason` or a JSON-RPC error, never an error dressed as `end_turn`:
`result` ERROR and a child exit without a `result` are `-32603` errors (the latter marks the
session for a `--conversation` respawn on the next prompt), a headless auto-deny is an
`end_turn` whose `denied_actions` go out as a notice before the response and ride in
`_meta.deniedActions`. Permissions are live (the PreToolUse bridge, below); the rest of
the ACP surface lands in the
follow-up issues of
[lucasschirm/claude-marketplace#49](https://github.com/lucasschirm/claude-marketplace/issues/49).

## The permission bridge

agy runs `--dangerously-skip-permissions`, so agy-acp is the only permission gate. For each
session it creates a private bridge dir (`$XDG_RUNTIME_DIR/agy-acp/agy-acp-<random>`, 0700,
falling back to `os.tmpdir()`) holding `.agents/hooks.json` (one `PreToolUse` hook under an
unguessable per-session name, passed to agy as an `--add-dir`) and a 0600 Unix socket.
agy runs the hook (`src/bridge-hook.ts`) on every tool call; the hook dials the socket
with the tool name, args and a per-session token and waits for a decision. The hook is
fail-closed: every exit path prints one JSON decision (empty stdout would be an allow in
agy), every denial carries the "Do not retry this call." wording (without it the model
retried 5 times in the spike), and every path exits 0.

Stale bridge dirs (a crashed run) are cleaned at startup: a dir is removed when it is
over an hour old **and its socket no longer answers** - a live session's dir is never
removed, however old it is. A subagent's internal tool call may carry its own conversation
id; it is served (the per-session token is the boundary) and goes through the same policy
and client ask. `session/set_mode` (the four mode ids) answers the request and emits a
`current_mode_update` notification.

The decision ladder (`src/permission.ts` + `src/permission-gate.ts`), in every mode:

1. a tool call whose args reference the bridge dir or socket is denied (the agent can see
   the dir in `workspacePaths`); in `plan` mode, state-changing tools are denied locally;
2. `read_file` inside the workspace is auto-allowed (plus `write_file`/`edit_file` in
   `accept-edits`); an `allow-always` answer is held as an in-session grant (run_command
   grants cover the full whitespace-normalised command, file grants the resolved
   path); unknown tools are never auto-allowed;
3. otherwise the client is asked via `session/request_permission` (options `allow_once`,
   `allow_always`, `reject_once`; anything else - including a timeout or a closed
   connection - is a deny).

The deadline ladder, lowest to highest: the client deadline (default 10 min, a deny with
reason) < `AGY_ACP_HOOK_DEADLINE_MS` (the hook's own timer) < the `hooks.json` timeout
(720 s, agy's timer). While a request is pending the `tool_call` update carries
`_meta.permission` (state, deadline) for a client watchdog; on cancel, a child exit or
dispose every pending request is denied.

agy emits a tool step's `ACTIVE` stream event **before** running the `PreToolUse` hook, so
the `tool_call` is created from the stream's parameters and the hook's args arrive as an
`in_progress` update - they are the args that get evaluated and shown. When they differ on
a stream-reported key (agy adds metadata fields such as `toolSummary`, which are not a
rewrite), the difference is logged and flagged `_meta.argsRewritten`. Remaining risk:
our hook may not sort last in the chain, so a repo hook running after ours can still
rewrite the args we evaluated.

## The agy process driver

The process model, from the spike (agy 1.4.2):

- launched as `agy --input-format stream-json --output-format stream-json -p= [flags]`;
- its `conversation_id` comes from the `init` event, which is only emitted **after the first
  stdin line** - so `probe()` sends an event agy ignores and gets an id without a model turn;
- stdout is newline-delimited JSON events (split on `"\n"` only, never readline);
- `result.usage`, `num_turns` and `duration_seconds` are cumulative per process and per resumed
  conversation - the driver emits per-turn deltas and keeps the raw cumulative state under
  `result.cumulative` for the next process of a `--conversation` resume;
- SIGINT cancels the running turn (agy reports `error: "interrupted"` and kills its own tool
  children); closing stdin does **not** stop a running turn, so `dispose()` escalates:
  close stdin, `graceMs`, SIGTERM the process group, `termMs`, SIGKILL - nothing outlives it;
- one child per session, in its own process group, with a controlled env.

The contract types for `init` / `step_update` / `result` live in `src/agy/contract.ts` and are
pinned against the recorded fixtures: every field in `test/fixtures/stream/field-inventory.json`
has a typed accessor, and unknown event types or fields are kept as `raw` rather than fatal
(agy 1.4.2 is not version-gated on a strict schema - see `checkAgyVersion`).

## Requirements

- Node.js >= 23.6 (runs the TypeScript sources directly; there is no build step)
- POSIX: the driver signals the child's process group with `SIGINT`/`SIGTERM`/`SIGKILL`, which
  Windows `process.kill` does not map to (a `SIGINT` there terminates the process outright);
  the process-group lifetime model is a POSIX one
- `agy` CLI on `PATH` - tested against 1.4.2. The package exports `checkAgyVersion` for the
  session layer to call before launch: it reports an untested version via a `warning` field
  and sets `strictRefusal: true` when `AGY_ACP_STRICT_VERSION=1` - the driver itself does
  not invoke it yet

Zero npm runtime dependencies: Node built-ins only.

## Running it from an ACP client

Point the client at the binary — `bin` maps `agy-acp` to `src/main.ts`, which Node >= 23.6 runs
directly:

```sh
node agy-acp/src/main.ts            # or the installed `agy-acp` bin
agy-acp --version                   # print the version
agy-acp --help                      # usage
AGY_ACP_LOG=/tmp/agy-acp.log agy-acp   # diagnostics to a file instead of stderr
```

For Zed, an `agent_servers` entry along the lines of:

```json
{
	"agent_servers": {
		"Antigravity (agy-acp)": {
			"command": "node",
			"args": ["/path/to/repo/agy-acp/src/main.ts"]
		}
	}
}
```

The server exits cleanly (code 0) when the client closes stdin.

## Development

The package is wired into the repo's quality gates: `npm run qa` typechecks, lints and formats it,
`scripts/check-quality.mjs` applies its invariants to `agy-acp/src/`, and `bash test/run.sh agy-acp`
runs the unit tests under `agy-acp/test/`.
