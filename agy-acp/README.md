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
`conversation_id`, and returns `modes`/`models` stubs (real selection lands in sub-issue 6);
requested `mcpServers` are reported via `_meta` rather than silently dropped. `session/prompt`
accepts text, resource-link and embedded-text blocks (flattened to one text, since agy
headless is text-only), rejects image/audio with `-32602`, and runs one turn at a time
(`-32002`). The stream maps to `session/update` notifications - `text_delta` becomes
`agent_message_chunk`, tool steps become `tool_call` / `tool_call_update` (pending, completed
with truncated output, or failed), per-turn usage becomes `usage_update` - and every turn
ends with a `stopReason` or a JSON-RPC error, never an error dressed as `end_turn`:
`result` ERROR and a child exit without a `result` are `-32603` errors (the latter marks the
session for a `--conversation` respawn on the next prompt), a headless auto-deny is an
`end_turn` whose `denied_actions` go out as a notice before the response and ride in
`_meta.deniedActions`. Permissions and the rest of the ACP surface land in the
follow-up issues of
[lucasschirm/claude-marketplace#49](https://github.com/lucasschirm/claude-marketplace/issues/49).

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
