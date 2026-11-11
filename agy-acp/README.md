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
`conversation_id`, and returns the live permission `modes` and the `model`/`effort`
selectors (see "Choosing the model, the effort and the mode" below); requested `mcpServers`
are reported via `_meta` rather than silently dropped. `session/prompt`
accepts text, resource-link and embedded-text blocks (flattened to one text, since agy
headless is text-only), rejects image/audio with `-32602`, and runs one turn at a time
(`-32002`). The stream maps to `session/update` notifications - `text_delta` becomes
`agent_message_chunk`, tool steps become `tool_call` / `tool_call_update` (pending, completed
with truncated output, or failed), per-turn usage becomes `usage_update` - and every turn
ends with a `stopReason` or a JSON-RPC error, never an error dressed as `end_turn`:
`result` ERROR and a child exit without a `result` are `-32603` errors (the latter marks the
session for a `--conversation` respawn on the next prompt), a headless auto-deny is an
`end_turn` whose `denied_actions` go out as a notice before the response and ride in
`_meta.deniedActions`. `session/cancel` is live, and with it the process lifecycle the long
unattended runs need (see below): the prompt answers `stopReason: "cancelled"`, the pending
permission requests are denied with that reason, and `agy` is made to stop rather than asked.
A session outlives the process that made it: `session/load`, `session/resume` and `session/list`
read agy-acp's own store (below), so a client that restarts can pick a conversation up, replay its
transcript, and continue it with `agy --conversation <id>` on the next prompt.
Permissions are live (the PreToolUse bridge, below); the rest of
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
and client ask. `session/set_mode` answers the request and emits a `current_mode_update`
notification; three of the four mode ids (`default`, `accept-edits`, `plan`) are offered by
default, and `bypass` - which lets every tool call through this gate - only when the operator
says so with `--allow-bypass` / `AGY_ACP_ALLOW_BYPASS=1`. A client that asks for a mode that
is not offered gets `-32602` naming that switch, and no update.

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
dispose every pending request is denied. A request that arrives with **no turn in flight** is refused
outright rather than asked - between a cancel and the child's death, or from a hook that outlived an
`agy` that died mid-turn, there is no prompt left to carry the answer, so an ask would be a dialog
nobody can close. The session's live turn is what answers this question (`currentTurn`), so a new
turn asks as usual without anything having to be reset - and because the gate also counts prompts
(`turnCount`), a cancel stops being the reason for a refusal as soon as a later turn has run, even a
turn that never reached a hook.

agy emits a tool step's `ACTIVE` stream event **before** running the `PreToolUse` hook, so
the `tool_call` is created from the stream's parameters and the hook's args arrive as an
`in_progress` update - they are the args that get evaluated and shown. When they differ on
a stream-reported key (agy adds metadata fields such as `toolSummary`, which are not a
rewrite), the difference is logged and flagged `_meta.argsRewritten`. Remaining risk:
our hook may not sort last in the chain, so a repo hook running after ours can still
rewrite the args we evaluated.

## Choosing the model, the effort and the mode

Three things decide what a turn runs on: the **mode** (what the bridge allows), the **model** and
the **effort** (`agy --model`, `agy --effort`). ACP has one method for the first
(`session/set_mode`) and none for the other two, so model and effort are ACP **config options**:
`session/new` returns them in `configOptions` - a `model` selector in category `model`, an `effort`
selector in category `thought_level` - each carrying its `currentValue` and its options with agy's
own display names (`claude-opus-5-5-high` is "Claude Opus 5.5 (High)"), and `agy-acp` also answers
`session/set_model`, the name clients reach for first. Both names are the same action, and the
answer is the whole selector list, so a client never has to guess what else moved.

`agy models` is the source of the ids; it runs **once per server process** (`agy models` can take
seconds and needs credentials) and its answer - success or failure - is cached. When it fails,
`session/new` says so in `_meta.models` (`{"listed": false, "reason": "...", "note": "..."}`) -
`reason` is agy's own words, so a client can tell "sign in" from "timed out" instead of guessing from
the server log - the `model` selector carries only the model the child reported, and an id the bridge
cannot name is passed to agy, whose startup error becomes the session error. A `-32602` naming every
available id is refused without touching a running child.

What a choice costs is decided by what it is: **mode** is enforced by the bridge the moment it is set -
the next permission decision is made under the new mode, even mid-turn - and `session/set_mode` answers
at once; **every one of the three is also an `agy` startup argument**, so a change marks the child stale
and the next `session/prompt` starts a new one with `--conversation`, keeping the conversation. Mode is
in that rule because a flag cannot be taken back: a child launched with `--mode plan` goes on refusing
to *try* mutations after the session moved back to `default`, and a session that advertises one mode
while its agy behaves as another is worse than the respawn it costs. A change is per session: a second
`session/new` starts from the operator's launch, not from whatever a client last picked. `agy` refuses
an effort that contradicts an effort-qualified model id (it said so on stderr in the spike:
`--model gemini-3.8-flash-low conflicts with --effort=high`), and `agy-acp` refuses it before breaking a
running turn.

The operator sets the starting point with `--model` / `--effort` / `--sandbox` (or
`AGY_ACP_MODEL` / `AGY_ACP_EFFORT` / `AGY_ACP_SANDBOX`); the client may then change model and
effort, never the sandbox, and only the modes that are offered. A starting point `agy` would refuse
is refused here instead, with the values it could have been: a typo in the environment is the
operator's, and every session of that server inheriting a child that will not start is a poor way to
say so.

Whatever is advertised can be chosen: the `models` block always lists what it names as current, and a
selector's `currentValue` is always one of its `options` - including `default`, which is how a client
asks for no flag at all. A control whose current value is not in its own list cannot be redrawn from
that list, which is the failure this rule exists to prevent.

## Continuing a session: agy-acp's own store

`initialize` answers `loadSession: true` and `sessionCapabilities: {list, resume}`. Everything that
supports them is in `src/session-store/`, and the store is **agy-acp's own**: agy keeps its own
conversation state, and this server never reads it — no `agy` storage, no SQLite, no OAuth token,
no `~/.gemini`, no hook `transcriptPath`. A conversation `agy` knows about and `agy-acp` does not is
an unknown session, and says so; the two tools' ideas of a session are deliberately separate.

The layout is `$XDG_STATE_HOME/agy-acp/sessions/<conversation_id>/` (`AGY_ACP_STATE_DIR` overrides
the `agy-acp` directory itself; with no `XDG_STATE_HOME` it falls back to `~/.local/state/agy-acp`,
and with no home to a temp directory — and every answer records which of those it chose, so "where
are my sessions?" has one answer):

```
meta.json        version, sessionId, cwd, mode/model/effort, title, turns, createdAt/updatedAt
updates.ndjson   one session/update per line, NDJSON, append-only (updates.ndjson.1 after a rotation)
lock             the holder: {pid, host, startedAtMs}, created with O_EXCL
```

Session directories are 0700 and every file 0600 (re-applied on each open, so a directory that
loosened gets tightened). `meta.json` is replaced atomically — temp file, `fsync`, `rename`,
`fsync` of the directory — so a kill mid-write costs nothing. `updates.ndjson` is only ever
appended to: a line is JSON with a trailing newline, so a kill between two writes costs that one
update, the reader skips the torn tail, and the count reaches the client as
`_meta.restored.droppedUpdates`. The transcript is fsynced at **turn end**, before the prompt's
answer is sent: `session/prompt` returning is the point at which that turn survives a restart. Past
2 MiB a session's log rotates, keeping one previous generation — history is bounded, not unlimited.

The lock is what keeps two `agy-acp` processes from writing the same transcript. It is taken with
`O_EXCL` and holds the holder's pid and host. Another process asking for the same conversation gets
an error naming the holder, whatever the two processes disagree about. A lock whose pid is gone on
the same host is dead and is taken over; a lock on another host is believed until it is older than
the stale deadline, because a pid means nothing across a machine boundary; a lock file that cannot
be read protects nothing and is taken over. Releasing is best-effort and idempotent, and a
`session/load` that finishes after its connection closed hands the lock back with the session.

**`session/load`** validates (the record exists, its `cwd` is the requested workspace), adopts the
session, then replays the stored `session/update` messages in order as notifications before the
answer. Heartbeats are never stored or replayed — they describe a turn that is running, and
replaying one would tell a client that an old turn is still in flight. **`session/resume`** runs the
same validation and replays nothing: a client that wants the transcript asks for `load`. Neither one
starts `agy`: the child (with `--conversation <id>`) appears at the next `session/prompt`, which is
what keeps a browse-and-pick UI from paying a launch per session. **`session/list`** reports this
store only, filtered by `cwd` when one is given, newest first, one page at a time; `nextCursor` is
opaque (an id and a timestamp, base64url) and stays valid while new sessions arrive: the next page is
"everything older than the pair you were last shown", so a conversation that takes a turn between two
pages neither repeats on the next one nor disappears from it. One call reads at
most 2000 records, because reading is one `meta.json` per directory; a store bigger than that answers
with `_meta.truncated` and the numbers instead of pretending the list is complete.

The answers when a load cannot happen, so a client does not have to guess:

| case | error |
| --- | --- |
| no such session (or a record this version cannot read) | `-32002`, `data.reason: "session_not_found"` |
| the session belongs to another workspace | `-32602`, `data.reason: "cwd_mismatch"`, `data.recordedCwd` |
| it is already open in this process, including a second load of it in flight | `-32602`, `data.reason: "session_open"` |
| another `agy-acp` process holds it | `-32603`, `data.reason: "session_in_use"`, holder in the message |
| the store cannot be read or written, or cannot take its own lock file | `-32603`, `data.reason: "store_unavailable"` |

A lock the state directory refuses (read-only, full, or a directory where the lock belongs) is
`store_unavailable` rather than `session_in_use`: the first is a disk to fix, the second is a
process to wait for, and only one of them ever lets go.

`-32002` is also what `session/prompt` uses for "a turn is already running": ACP fixes
resource-not-found at that code and this server's turn-in-progress code predates it, so the two
collide. They are told apart by `data.reason` and by the method they answer, and neither code is
changed — a client switching on the number would break either way. A corrupt `meta.json` is an
unknown session, never a repair: inventing a record would invent a history. A store that cannot be
written fails `session/new` outright rather than handing out a session that cannot come back, and a
load whose store can no longer replace the record fails the same way rather than promising a history
that stops there. `mcpServers` and `additionalDirectories` on a load or resume are answered with
`_meta`, as they are on `session/new`: accepted, reported unsupported, never silently dropped.

What is restored is what the client chose — mode, model, effort, with `default` meaning "pass no
flag" — not what agy's `init` volunteered, which arrives again with the first resumed turn. A
stored value the current launch cannot honour (a `bypass` mode with `AGY_ACP_ALLOW_BYPASS` off, an
effort the stored model does not offer) is dropped on its own with a note in `_meta.restored.notes`
rather than failing the load.

## Cancelling a turn, and the process going away

A turn lives inside an `agy` process, and a long unattended run is where the two come apart. Both
directions are the process's problem, not the model's, so they are handled here.

**`session/cancel`** (a notification: it is never answered, so a cancel of an unknown session is
logged rather than answered with an error) does four things, in the order a client can rely on:

1. every pending `session/request_permission` of this session is denied with the cancellation
   reason, so the hook is released with the same words the client sees - and the `tool_call_update`
   that closes the dialog goes out with `_meta.permission.state: "cancelled"`. Anything that asks
   **after** the turn is over is refused with those same words rather than asked: `agy` can fire a
   hook between the cancel and the death it causes, and there is no `session/prompt` left to carry an
   answer to it. The rule is the general one - no turn in flight, no permission request (see
   `currentTurn` above) - so a hook that outlives an `agy` that died mid-turn is refused too, with
   the session-ended reason.
2. the in-flight `session/prompt` answers `{ "stopReason": "cancelled" }` **at once**, with its
   still-`ACTIVE` tools reported failed: a client that asked to stop is never made to wait for an
   `agy` that may take seconds to die (a `result` that arrives afterwards is ignored);
3. `agy` gets `SIGINT` - the mechanism it implements, answering with `error: "interrupted"` and
   killing the tool command it was running. One that is still alive `AGY_ACP_CANCEL_ESCALATE_MS`
   later gets the teardown ladder on its process group (`SIGTERM`, then `SIGKILL`); one that died
   on the `SIGINT` but left its tool command running in that group is swept the same way, because a
   signal aimed at `agy` alone never reaches it;
4. the session is marked `needsRespawn`: the next prompt relaunches `agy` with
   `--conversation <id>`, so the cancellation costs the conversation nothing.

A `session/cancel` that arrives **between** turns is a no-op, logged as one: a `SIGINT` there would
only kill a healthy child and buy a multi-second resume, with nothing hung to unstick. One that
arrives **during** a respawn (the turn has a prompt and a child that is still probing, or none at
all) is answered like any other: the child is killed and the prompt is never sent, so the turn the
client called off is never run.

**The heartbeat** is how a silent turn tells a watchdog "waiting" from "gone" - the distinction that
matters when a `PreToolUse` hook is blocked on a decision or a command has been running for a
minute. While a turn is in flight the session emits a `session/update` whose only content is `_meta`:

```json
{ "sessionUpdate": "heartbeat",
  "_meta": { "heartbeat": { "seq": 4, "atMs": 1764000000000, "turnMs": 45000,
                            "state": "waiting_permission", "pendingPermissions": 1 } } }
```

`state` is `waiting_permission` while a decision is outstanding and `running` otherwise. A client
that does not know the update ignores it (nothing else on the stream changes); one that does never
has to parse content to prove liveness. The interval is `AGY_ACP_HEARTBEAT_MS` (default 15 000,
`0` disables it), and the beat stops the moment the turn settles.

**When agy-acp itself goes away** - the client closes stdin (ACP's hang-up), or `SIGTERM`, `SIGINT`
or `SIGHUP` arrives - all three run one exit path: cancel every turn, deny every pending request,
dispose every child, remove every bridge dir, flush the protocol channel, and only then exit. A
hang-up *starts* that path rather than disposing the sessions first and reporting afterwards, because
a teardown that happens before the deadline is armed is a teardown the deadline cannot bound. The
path has a deadline (`AGY_ACP_SHUTDOWN_TIMEOUT_MS`, default 10 000) that **races** the cleanup rather
than watches it: past it the process exits with the cleanup abandoned mid-flight and what is being
left named in the log, because a wedged child must not turn a hang-up into a process somebody has to
kill by hand. A second signal skips the remaining politeness. Exit code 0
when the cleanup finished inside the deadline, 1 when it was forced.

Two residuals, both from being killed rather than told to leave:

- `SIGKILL`ed (or crashed) `agy-acp` cannot clean up: its `agy` children keep running (they are in
  their own process groups, which is what makes the ladder reliable) and its bridge dirs survive.
  The next start sweeps stale dirs - over an hour old **and** with a socket that no longer answers -
  so the dirs go eventually; nothing reclaims the orphaned `agy` processes, and a hook of theirs
  fails closed on the dead socket, so an orphan cannot run a tool call.
- a tool command that detached itself (`setsid`, `nohup`, `& disown`) belongs to no process group we
  can see, so it outlives every ladder above. `agy` killing its own tool children is what the spike
  recorded; ours is the backstop for the ones it did not kill.

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
- one child per session, in its own process group, with a controlled env;
- a child that dies is not respawned eagerly: the session marks `needsRespawn` and the next prompt
  pays the resume, which is what keeps a session that goes quiet for an hour from spending launches.
  A child that dies **during** a turn fails its still-`ACTIVE` tools and errors the prompt.

The contract types for `init` / `step_update` / `result` live in `src/agy/contract.ts` and are
pinned against the recorded fixtures: every field in `test/fixtures/stream/field-inventory.json`
has a typed accessor, and unknown event types or fields are kept as `raw` rather than fatal
(agy 1.4.2 is not version-gated on a strict schema - see `checkAgyVersion`).

## Requirements

- Node.js >= 23.6 (runs the TypeScript sources directly; there is no build step — unless you want
  the single executable, see "Building the single executable" below: the built binary needs no
  Node at all)
- POSIX: the driver signals the child's process group with `SIGINT`/`SIGTERM`/`SIGKILL`, which
  Windows `process.kill` does not map to (a `SIGINT` there terminates the process outright);
  the process-group lifetime model is a POSIX one
- `agy` CLI on `PATH` - tested against 1.4.2. The package exports `checkAgyVersion` for the
  session layer to call before launch: it reports an untested version via a `warning` field
  and sets `strictRefusal: true` when `AGY_ACP_STRICT_VERSION=1` - the driver itself does
  not invoke it yet

Zero npm runtime dependencies: Node built-ins only. (Building the single executable uses
`esbuild` and `postject`, which are dev-only tooling in the root `package.json` — the
`agy-acp` package itself stays dependency-free, and the built binary needs nothing but the
OS it was built for.)

## Running it from an ACP client

Point the client at the binary — `bin` maps `agy-acp` to `src/main.ts`, which Node >= 23.6 runs
directly:

```sh
node agy-acp/src/main.ts            # or the installed `agy-acp` bin
agy-acp --version                   # print the version
agy-acp --help                      # usage
AGY_ACP_LOG=/tmp/agy-acp.log agy-acp   # diagnostics to a file instead of stderr
```

Or build the single executable (next section) and point the client at it: the binary is the
server, and the permission hook is the same binary re-executed with `--bridge-hook` — no Node,
no script files, no install.

The knobs, all with the defaults above and all read from the environment (`agy-acp --help` prints
them): `AGY_ACP_COMMAND` (the `agy` binary to launch), `AGY_ACP_CANCEL_ESCALATE_MS` (the
`SIGINT` -> process-group window), `AGY_ACP_HEARTBEAT_MS` (0 disables the beat) and
`AGY_ACP_SHUTDOWN_TIMEOUT_MS` (the exit deadline) and `AGY_ACP_STATE_DIR` (where the session store
lives — see "Continuing a session" above; it must be an absolute path, and a relative one is ignored
with a note about it in the log). The selection knobs are `AGY_ACP_MODEL`,
`AGY_ACP_EFFORT`, `AGY_ACP_SANDBOX`, `AGY_ACP_MODELS_TIMEOUT_MS` (how long `agy models` may take
before the list is written off) and `AGY_ACP_ALLOW_BYPASS`, which exists because bypassing the
permission gate is the operator's decision: without it the `bypass` mode is not even advertised.

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

… or, with the single executable:

```json
{
	"agent_servers": {
		"Antigravity (agy-acp)": {
			"command": "/path/to/agy-acp"
		}
	}
}
```

Closing stdin is the hang-up: the server disposes its sessions and their children, then exits 0.

## Building the single executable (Node SEA)

`npm run build:sea` (from `agy-acp/`, or `node agy-acp/scripts/build-sea.mjs` from the repo
root) produces `dist/agy-acp`: a standalone ELF executable — no install, no Node on the target
machine. The build is three steps, all in `scripts/build-sea.mjs`:

1. `esbuild` bundles `src/main.ts` to a single CommonJS file (`dist/main.cjs`); the SEA blob
   must be CJS, and everything in this package is Node built-ins, so the bundle is the whole
   program.
2. `node --experimental-sea-config` patches a copy of the local Node runtime with the blob and
   writes the executable (the config names the bundle as `output` and the Node version the
   blob was built against).
3. `postject` injects the blob into the binary in place, with Node's sentinel fuse
   (`NODE_SEA_FUSE_…`) so the executable fails loudly rather than silently running as a plain
   Node binary.

The build records and prints the result — size, sha256, and the startup time to a first
`initialize` response (best of 3) — which the CI job (`agy-acp-sea`) repeats and publishes as
an artifact. On a Linux x86-64 host with Node 24 the binary is about 121 MiB (unstripped;
`strip` roughly halves it, at the cost of the debug info) and answers `initialize` in roughly
30 ms.

The binary is both halves of the bridge in one file: as a plain process it is the ACP server;
re-executed with `--bridge-hook` it is the permission hook (the same code path script-mode
`bridge-hook.ts` runs, reached from `src/main.ts`). The hooks.json a SEA session writes names
the binary's absolute path plus `--bridge-hook` — no hook *file* — so moving the executable does
not orphan a stray script: existing sessions keep pointing at the old path until they are
re-created, and new sessions pick up the new location automatically.

Two honest caveats:

- Node's SEA is still an experimental feature: the binary prints the `ExperimentalWarning: Single
  executable application is an experimental feature` line to stderr on every start (the test
  suites strip that one line so both modes see the same surface), and the feature contract can
  still move in a Node release — the build records the Node version it was made against.
- The binary is a snapshot of the Node runtime: build it on the platform it will run on (the
  CI job builds on `ubuntu-latest`, Node 24). It is not a universal binary, and it is not
  stripped.

## Development

The package is wired into the repo's quality gates: `npm run qa` typechecks, lints and formats it,
`scripts/check-quality.mjs` applies its invariants to `agy-acp/src/`, and `bash test/run.sh agy-acp`
runs the unit tests under `agy-acp/test/`. The suites are mode-agnostic through one seam
(`test/bin-target.ts`): with `AGY_ACP_TEST_BIN=/path/to/dist/agy-acp` set, the same suite spawns
the built executable instead of `node <script>` (the hook as a re-exec with `--bridge-hook`, the
hooks.json layout with the flag instead of a hook file) — that is how CI proves the single
executable, not just the sources.

## Live smoke test (opt-in, never in CI)

`node agy-acp/scripts/smoke-live.ts` (from the repo root; `npm run smoke:live` from `agy-acp/`,
`--agy <path>` for a non-PATH binary, `--record` below) runs ten fixed scenarios against the
**real** `agy` with `gemini-3.8-flash-low`, under a hard cap of 15 model turns: simple, multi-turn
(three turns in one process), tool allow, tool deny, plan-mode deny, `allow_always` (two identical
commands, one ask), cancel of a running `sleep 30` via the production `cancelAgy` ladder, a simulated
crash followed by a `--conversation` respawn, an unknown model id (agy's own refusal, before any
turn), and a client disconnect mid-turn against the real server (`node agy-acp/src/main.ts`,
the client's stdin closed while a tool is running).

It drives the real package code, not a copy of it: the production permission gate (a real bridge
dir, hooks.json, socket and `bridge-hook.ts`) under a driver that mirrors `AgyProcess` (the
probe, the close-stdin/grace/SIGTERM/term/SIGKILL dispose ladder, the budgeted stderr tail) and
additionally taps the **raw stdout lines** — the exact lines a recorded fixture is made of, which
is what makes a `--record` refresh accurate. A recorder hook in the scratch workspace appends
every `PreToolUse` stdin payload to a log (capped) so the report carries the hook's own input.

Before it spends a model turn it checks `agy --version` (a version the fixtures were not recorded
against is a **warning** in the report, not a refusal — the run's job is to notice the drift, and a
refusal would notice it too late) and that `agy models` lists the model (that one *is* a refusal,
before any turn at all). After the scenarios it confirms that no processes the run started are
left (a pid liveness check plus a `/proc` scan for stray tool commands) and that the user
configuration is unchanged (a sha256 of every `~/.gemini/**/settings.json` and `hooks.json`, taken
before and after the run).

A run writes `agy-acp/reports/smoke-<date>/` (a dated, append-only directory; a second run the same
day takes `smoke-<date>-2`): `report.md` (per-scenario checks, the post-run checks, the field-inventory
diff summary), `smoke-report.json` (the machine-readable twin), `fixtures/` (each scenario's raw
stdout lines plus meta — source run, agy version, args, input lines, exit code/signal, stderr,
timeline — with the scratch and home paths normalised to `<SMOKE>`/`<HOME>` the way the committed
fixtures are), `fixtures/hook-payloads.jsonl` (the recorded hook stdin payloads),
`field-inventory.live.json` and `field-inventory.diff.json`. The run **refuses to start when `CI`
is set** (it spends model quota and needs a logged-in `agy`, both of which are a human's decision),
and `test/run.sh` never names it.

## Recording fixtures (`--record`)

`node agy-acp/scripts/smoke-live.ts --record` writes the run's fixtures into `test/fixtures/stream/`
under their committed names (the mapping is a table in the script: `simple` → `simple-textblock`,
`multi-turn` → `simple-multiturn-textblocks`, `tool-allow` →
`tool-allowed-skip-permissions`, `tool-deny` → `tool-hook-denied`, `plan-deny` →
`plan-mode-denied`, `allow-always` → `allow-always-grant`, `cancel-sleep` → `interrupted-sigint`,
`resume-after-restart` → `resumed-conversation`, `bad-model` → `bad-model-id` —
`simple-textblock`, `plan-mode-denied` and `allow-always-grant` are new fixtures, since
no committed fixture covers them) — the other committed fixtures (crash, shutdown, permission,
bridge) are untouched — and recomputes `test/fixtures/stream/field-inventory.json` from the whole
directory (the same file `npm run qa`'s contract tests check the types against). The run's report
records which names were written and the inventory diff between the committed and the recomputed
file, so a record is always diffable against what it replaced.

## Drift watch

The stream contract is versioned by observation, not by pinning: `TESTED_AGY_VERSIONS`
(`src/agy/version.ts`) is the set the committed fixtures were recorded against, and the
`checkAgyVersion` warning is the mechanism that notices a newer `agy` at launch. When an `agy`
version ships, the procedure is:

1. **Run the drift watch**: `node agy-acp/scripts/smoke-live.ts` against the new `agy`. The
   report's `field-inventory.diff.json` (summarised in `report.md`) is the verdict: added and
   removed paths, type changes, and added/removed string literals per event type. The inventory is
   the shape contract (every field in it has a typed accessor in `src/agy/contract.ts`); a non-empty
   diff is the contract moving.
2. **Check the changelog**: `agy changelog` (or the release notes) against the known-breakage list
   below. A change to the stream schema, the hook semantics or the permission semantics must be
   examined even when the inventory diff is empty — the inventory sees shape, not meaning.
3. **Land the fix**: a new field or a changed one goes into `src/agy/contract.ts` with its test in
   the same commit (the contract test asserts the fixture's shape against the type, so the two
   cannot drift apart), and a `--record` run updates the committed fixtures and the inventory.
4. **Bump the tested set**: add the version to `TESTED_AGY_VERSIONS` in the same commit as the
   contract change, so the warning stops the moment the fix lands — and append the entry to the
   table below.

Known breakage (seeded; append an entry for every drift observed, newest last):

| agy | what changed | where it landed |
| --- | --- | --- |
| 1.4.3 | `PostToolUse` hooks no longer run after a failed tool: a `PreToolUse` denial short-circuits the hook chain, and a `PostToolUse` in the same `hooks.json` does not fire for a denied tool (the denial is final; the hook's stdin payload for a denial is the one to record). | `src/permission-gate.ts` (a denial is a denial, no second hook); the `tool-deny` fixture |
| 1.4.6 | Subagent grants: a `PreToolUse` fired for a subagent's internal tool call now carries the **subagent's** `conversation_id` in the hook's stdin (the per-session token still serves it, so the gate serves the subagent's call under the parent's session); the grant tables are keyed per conversation, so a subagent grant no longer leaks to the parent. | `src/permission-gate.ts` (the subagent case) |
| 1.4.7 | `lastUserInput` in the hook's stdin payload: a `PreToolUse` now also carries the text of the user prompt that led to the tool call. The gate does not use it (a decision on prompt text is a policy the client owns); it is recorded in the fixture meta so a hook author can see the turn that triggered the call. | the `hooks.json` layout is unchanged; the `tool-allow` fixture meta |

## Bumping the version

`agy-acp`'s version (`agy-acp/package.json`) moves on the drift-watch procedure above, in one
commit: the contract type, the fixtures (a `--record` run), the inventory, the `TESTED_AGY_VERSIONS`
entry and the `package.json` version together, so `git log` answers "what did 0.2.0 buy me?" in
one diff. Semver by what the user sees: a **minor** when a new `agy` version is supported with no
change to the ACP surface, a **patch** when nothing outside `agy-acp` moved, a **major** when the
ACP surface (a method, an error, a capability) changes. The bot that bumps **plugin** versions
(`.github/workflows/plugin-version-bump.yml`) is a different mechanism (it filters to `plugins/**`
and can never bump `agy-acp`); `agy-acp`'s version is a human's, in the same PR as the change it
names. The dated report the run that proved the new version works goes in the PR description (the
reports directory itself is git-ignored: it is run output, and the `--record` fixtures are its
committed form).
