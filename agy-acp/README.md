# agy-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) server that drives Google's
`agy` CLI through its documented headless mode
(`agy -p --input-format stream-json --output-format stream-json`).

It speaks JSON-RPC 2.0 over stdio: newline-delimited frames on stdin/stdout, diagnostics on stderr
(or the file named by `AGY_ACP_LOG`). Any ACP client — Zed, or this repo's Pi delegate, which already
talks ACP to `devin acp` — can spawn it and hand work to Antigravity.

## Status

Early scaffold: the transport and the `initialize` handshake are implemented. `session/new`,
`session/prompt`, permissions and the rest of the ACP surface land in the follow-up issues of
[lucasschirm/claude-marketplace#49](https://github.com/lucasschirm/claude-marketplace/issues/49).
Until then every method but `initialize` is answered with `-32601`.

## Requirements

- Node.js >= 23.6 (runs the TypeScript sources directly; there is no build step)
- `agy` CLI on `PATH` — tested against 1.4.2 (needed once session support lands)

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
