# PR Observer Plugin (Devin CLI & Claude Code)

Review-conversation and CI tools for **Devin CLI** and **Claude Code**: the agent reads a pull
request's CI verdict and its review conversations, and closes conversations it has addressed.

## Tools

| Tool                | What it does                                                                        |
| ------------------- | ----------------------------------------------------------------------------------- |
| `observe_pr`        | CI verdict (`gh pr checks`) plus conversation counts, for a PR or the current branch. |
| `pr_tasks_list`     | Fetches the PR's review threads and lists the conversations (open, blocked, stale). |
| `pr_task_detail`    | One conversation: comment, file and lines, every reply, code suggestion.            |
| `pr_task_resolve`   | Posts a reply and resolves the thread; optionally applies its code suggestion.      |
| `pr_task_blocked`   | Posts the reason and marks the conversation BLOCKED until the reviewer answers.     |

Everything is read from GitHub on each call, so a listing is never stale. `pr_number` selects a pull
request; without it the current branch's PR is used.

**There is no background watcher in this plugin's MCP server.** `observe_pr` is a snapshot - call it
again to refresh. Continuous monitoring with push notifications is what the Pi extensions in this
repository (`extensions/observe-pr.ts`, `extensions/pr-tasks.ts`) do. What this plugin ships instead
are lifecycle hooks (`hooks.json`, local Devin sessions only; best-effort and fail-open by design):

- **SessionStart** (`scripts/session-init.mjs`) - initializes the session's watch state (per session
  and repository, under `PLUGIN_DATA` or the system temp dir) and sweeps state older than a week.
- **PostToolUse** (`scripts/notify-changes.mjs`) - after tool calls, at most once a minute, diffs the
  branch's PR (mergeability + CI) against the last snapshot and injects transitions into the agent's
  context (`additionalContext`): a conflict appearing, the base moving ahead, CI failing or passing.
- **Stop** (`scripts/check-settle.mjs`) - the watcher. While the PR cannot land (conflict, BEHIND,
  failing CI, CI still running) it holds the stop: actionable problems block with the reason as the
  news; CI running sleeps in bounded chunks and re-arms with a heartbeat ("stop again to keep
  waiting"). Merged/closed/landable PRs allow the stop. The user is never trapped: Esc cancels the
  agent, and the total watch time is capped (4 h, carried across re-arms).

The hooks share the vendored engine with the MCP server (same classification logic), run with Node
builtins only, and log every decision and failure as JSON lines to `hooks.log` in the state
directory. Review conversations are deliberately out of scope for the hooks - the MCP tools and the
AGENTS.md rule own those.

## Requirements

- `gh` authenticated on the machine, inside a checkout of the repository whose PR is read.
- **Node 22.18 or newer on PATH.** The tools run the engine's TypeScript directly - there is no build
  step, so an installed plugin needs no `npm install`, but an older Node cannot load it. The server
  itself is plain `.mjs`: on an old Node it still completes the MCP handshake and reports this
  requirement in the tool result instead of going silent.

## Installation

### Devin CLI

```bash
devin plugins install lucasschirm/claude-marketplace#plugins/pr-observer
```

Devin copies the plugin into `~/.devin*/cli/plugins/cache/<source>/<version>/`. After changing the
plugin, re-install (or delete the cached copy) so the host picks the new files up:

```bash
devin plugins install lucasschirm/claude-marketplace#plugins/pr-observer   # re-resolves the source
```

### Claude Code

```
/plugin marketplace add lucasschirm/claude-marketplace
/plugin install lsc-pr-observer
```

## Layout

```
.claude-plugin/plugin.json   # Claude Code manifest (lsc-pr-observer)
.devin-plugin/plugin.json    # Devin CLI manifest (pr-observer)
.mcp.json                    # MCP server registration
hooks.json                   # Stop hook (fail-open placeholder)
skills/                      # observe-pr, pr-tasks
src/mcp-server.mjs           # MCP stdio server: JSON-RPC, tool schemas, the flows above
lib/                         # vendored copies of extensions/lib/ (see below)
scripts/check-settle.mjs     # the Stop hook's command
```

### Why `lib/` holds copies of `extensions/lib/`

An install copies the plugin directory **alone** into the host's cache, so nothing outside it exists
at run time. `src/mcp-server.mjs` therefore cannot import the repository's `extensions/lib/`. The
three files it needs are vendored here byte-for-byte:

```bash
node scripts/sync-plugin-libs.mjs --write    # after changing anything under extensions/lib/
```

`npm run validate` fails when a copy drifts from its source, and
`test/test-pr-observer-mcp.ts` runs the tools from a copy of this directory in a throwaway folder -
the layout an install produces - so a plugin that only works inside a checkout cannot land.

## Troubleshooting

**"Failed to list tools for server 'pr-observer'"** (Devin) or an MCP server that never connects.
Both hosts report a server that does not answer the handshake this way, without the underlying
error, so check in this order:

1. `node --version` on PATH - it must be 22.18 or newer.
2. `ls <plugin cache>/src/mcp-server.mjs` and `<plugin cache>/lib/` - an old cached copy (from
   before the plugin was self-contained) has `src/mcp-server.ts` and no `lib/`. Re-install.
3. Run it by hand and drive the handshake; the answer or the error tells you what the host saw:

   ```bash
   printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
     '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
     | node "<plugin cache>/src/mcp-server.mjs"
   ```

   A `result` with five tools means the plugin is fine and the host's plugin-root placeholder is the
   problem; `.mcp.json` resolves `PLUGIN_ROOT`, `DEVIN_PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` in that
   order and falls back to searching the host's plugin cache, printing what it saw on stderr.

**"skipping installed plugin 'pr-observer': ... is not a directory"** (Devin log). An install from a
local path that has since been deleted (an old worktree, for instance) stays registered in
`~/.devin*/cli/plugins/lock.json` and is retried on every session. Remove that install
(`devin plugins remove <the path>`), or drop its entry from the lockfile, and the warnings stop.

**A conversation that was never resolved, but the tool says it resolved.** Every tool calls GitHub
and reports what GitHub answered: a reply or a resolve that failed is reported as a failure, with
the `gh` error text. Nothing here writes a success it did not observe.
