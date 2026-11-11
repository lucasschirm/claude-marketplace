# Plan: the delegate runs Antigravity (`agent: "agy"`) through `agy-acp`

Issue: lucasschirm/claude-marketplace#57 — sub-issue 8 of 11 in the `agy-acp` epic (#49).
Depends on sub-issues 3–5 (sessions, the permission bridge, cancel) and 6 (modes/model/effort), all
merged. Sub-issue 7 (`session/load`, `session/resume`, `session/list`) landed on `dev` and is
deliberately **not** used here — see "Resume" below.

## 1. Goal

Hand work to Antigravity from the same tools that drive Devin and Claude: `delegate_task` with
`agent: "agy"`, the existing ACP transport, queue, slots, worktrees, stall watchdog, permission
forwarding, status tools and recovery. A driver file plus its own differences; nothing in the tool
layer.

## 2. Base branch, and why this branch is not based on `dev`

Both branches left `79b8f02` (agy-acp 6/11) on 3 November and both moved on 10 November, and they took
different halves of the repo:

| branch | what it added |
| --- | --- |
| `dev` | agy-acp 7/11 (`#56`: the session store, `session/load`, `resume`, `list`) and 9/11 (`#58`: packaging, Node SEA) |
| `main` | the quality gate (`#76`, `#77`), **the delegate split (`#79`)** and agy-acp's subagent gating (`#59`) |

`dev` still carries the pre-#79 delegate (`extensions/devin-delegate.ts`, 2 669 lines, one agent,
`lib/acp-client.ts` with Devin's binary hard-coded) and has no driver registry. `main` has #79 — the split
into `extensions/lib/delegate/**` with `drivers/{devin,claude}.ts` — which is exactly the seam this issue
extends ("generalise the spawner", which the issue offers as a conditional, is already done there).

agy-acp work has landed on both (`#56`, `#58` on `dev`; `#59` on `main`), so there is no convention here
to follow — only the question of which tree this change can be written against. `dev` is the epic's
integration branch and this issue belongs there; it cannot be *written* there, because the driver
registry it extends does not exist on that branch. The base is therefore the one flagged thing about
this PR, and retargeting it after a `main`→`dev` convergence costs little: outside
`extensions/lib/delegate/**` (which `dev` does not have at all, so it lands as an addition) the only
file that disagrees is `README.md`, where `dev` still carries the pre-#79 wording of the same section.

Two options were evaluated on a scratch merge:

- **base `dev`, merge `main` in**: six conflicts, four of them in `agy-acp`'s core (`session.ts`,
  `jsonrpc.ts`, `server.ts`, `errors.ts`) where #77's quality pass and #56's session store restructured
  the same functions. The PR diff would be 175 files / +15 317 lines of already-reviewed code from
  other issues, and the review of *this* work would be buried in it. Resolving a security-critical
  permission bridge under a feature PR is a decision for whoever owns the `dev`↔`main` convergence.
- **base `main`** (taken): the diff is this issue only, nothing in `agy-acp/` is touched, and the
  `dev`↔`main` conflict is left exactly as it was instead of being decided here.

Consequence to remember when `dev` catches up with `main`: `#56`'s `session/resume` is the one piece
that would let an `agy` session continue after its process died (see §6).

## 3. What the backend parameter is

No `backend` parameter is added. #79 shipped the generalised form: `delegate_task`'s `agent` names the
driver, and `agent: "agy"` is the backend choice. `devin_*` aliases keep forcing `agent: "devin"`, so
no old name can reach the new agent. This is the "decide and document which" the issue asks for.

## 4. The `agy` driver (`extensions/lib/delegate/drivers/agy.ts`)

| Subject | Decision | Why |
| --- | --- | --- |
| spawn | `agy-acp [--model <id>] [--effort <level>]` | The adapter's own documented launch flags. A flag beats an env var twice over: `agy-acp` validates the start selection at `session/new` (`assertStartSelection`) and refuses a model it cannot run, naming the ids that work; and an explicit flag beats an inherited `AGY_ACP_MODEL` in the operator's shell — the same trap `DEVIN_MODEL` set for Devin. With no `model` no flag is passed, so agy picks, and the tool text says the default is the install's own. `--effort` is agy's `low\|medium\|high\|xhigh\|max`. |
| selection channel | launch flags, **no** `applySelection` | Both channels end in the same argv, because the child is exec'd with the current selection — `session/new` spawns eagerly to probe, and a child whose selection changed is respawned at the next prompt — but the flag route refuses a bad id before any turn runs, while `session/set_config_option` answers `-32602` after the session exists. A refusal that costs nothing beats a warning that costs a session. |
| models | `values: []`, `onUnknown: "warn"`, `default: "default"` | The list is `agy models`, which is account-specific and needs credentials. `agy-acp` publishes it per session and refuses an id agy does not know, listing the ones it does; hardcoding a catalogue here would be a lie about someone else's install (the Claude driver's reasoning, and stronger here because we own the server). |
| thinking | `true`, levels `low, medium, high, xhigh, max` | `agy --help`'s `--effort`. `off`/`minimal` are refused at admission rather than costing a spawn. The level list and the mode ids are mirrored from `agy-acp` — as is the version — and `test-delegate-agy.ts` compares all three against the adapter's own tables, so a mirror that stops reflecting is a failing test rather than a driver that quietly refuses a level agy grew. |
| modes | `dangerous→bypass`, `auto→default`, `smart→default`, `accept-edits→accept-edits`, `plan→plan`, `ask→default`, `manual→default`; default mode **`accept-edits`** | The four modes `agy-acp` advertises. `bypass` is operator-gated (`AGY_ACP_ALLOW_BYPASS=1`): the driver reads that knob and **refuses** `dangerous` when it is off, naming the knob — the rule the Claude driver applies to `bypassPermissions` under root. The driver never sets the knob itself: an unattended delegate must not shop its way out of every prompt, and `agy-acp`'s own comment says that gate is the operator's, not a client's. Because the tool's historical default is therefore usually refused, this driver's default is `accept-edits`: a delegated run edits its own workspace and asks before running commands. `smart` — with it `auto`, the alias the tool advertises and the other two drivers accept, which this driver refused until round 1 of its review — map to `default` because agy has no agent-judged tier; the mapping is **stricter** than asked, and `session/set_mode` answers `current_mode_update`, so the session record carries the wire mode it is really in. The default is advertised in `/delegate agents`, which now prints each driver's own, and in `delegate_task`'s parameter text. |
| the default mode's price | one extra `agy` start per un-named delegation | `agy-acp` starts every session in `default` and the mode is part of `relaunchKey`, so `session/set_mode accept-edits` marks the eager child and the first prompt respawns it with the flag. The bridge enforces the mode from the first tool call either way; the flag only has to agree, and a mode that resolves to `default` pays one start. Passing the mode at launch would need a `--mode` the adapter does not have, which is another sub-issue rather than a line in this one. |
| permissions | exact ids only: `allow→allow_once`, `allow_session→allow_always`, `reject→reject_once` | `agy-acp` offers exactly those three (`PERMISSION_OPTION_IDS`), and its `allow_always` is an **in-memory, per-session** grant keyed by tool + full command or resolved path — never written to disk, never project-wide. That is what `allow_session` promises, so unlike Claude there is nothing to degrade. Any other id, and any unknown id, answers `cancelled` (= deny). |
| `mapUpdate` | default table + heartbeat | `agy-acp` is spec-conformant on chunks, tool calls, usage and mode; the one update the default table would drop is its `heartbeat`. |
| resume | **false** | The engine's reattach is "spawn, then prompt the recorded id", and `agy-acp`'s registry refuses an id it did not create in this process. `session/resume` (#56) is the way in and lives on `dev`; until a driver loader exists, `delegate_message` on a dead `agy` session refuses with `delegate_restart`, which is honest. `capabilities.resume` stays false rather than promising a continuation nothing restores. |
| `backfill` | absent | `agy-acp` keeps its own store, but reading another program's private on-disk format during recovery is the one thing the epic's security rules refuse. Recovery reports `interrupted` instead of guessing. |
| bash guard | `blocksOwnCli: true`, `cli: "agy-acp"` (the spawned process), `extraClis: ["agy"]`, read-only verbs per binary | Two guards read `cli` and want different names: the pid-recycle guard substring-matches `/proc/<pid>/cmdline` before killing a pid recorded a while ago, so `cli` is what the process *is* (`agy` is three letters a recycled pid's path can contain — this workspace's own directory does, three times), while the bash guard wants every name the work answers to, so the CLI goes in `extraClis` and both are blocked. `--help`/`--version` and the listings stay allowed (see §7). |
| preflight | `agy-acp` on `PATH`, then `agy --version` against the tested version | Cached 60 s like Claude's auth probe. The messages name the two distinct causes: the adapter missing ("install it, or point the driver at it"), and agy missing, unreporting or untested (naming the tested version and `AGY_ACP_COMMAND`). No `agy auth status` probe: `agy-acp`'s `session/new` refuses unsigned-in work with a message the turn itself reports, and a second probe of the same account would be a second thing to keep honest. |
| `env` | `{}` — the driver sets nothing | `agy-acp`'s knobs (`AGY_ACP_MODEL`, `AGY_ACP_EFFORT`, `AGY_ACP_ALLOW_BYPASS`, `AGY_ACP_HEARTBEAT_MS`, `AGY_ACP_LOG`) are operator-level, which is why they are env; a delegate that set them would reconfigure someone's adapter per request. The one deliberate exception is reading `AGY_ACP_ALLOW_BYPASS`, because admission has to be honest about a mode the adapter withholds. |

## 5. The framing fix (`acp-client.ts` → `transport.ts`)

`node:readline` splits on U+2028/U+2029 as well as `\n`, so an ACP frame carrying either inside a JSON
string is torn in half — and `JSON.stringify` does not escape them for a *stream* (only for embedding
in JS source). `transport.ts` therefore reads bytes through a `\n`-only decoder with a named byte
ceiling, in `extensions/lib/delegate/framing.ts` (mirrors `agy-acp/src/framing.ts`; the two trees
share no runtime module — `extensions/` ships without `agy-acp/`, and pi ships without either's tests).
The two failures the decoder can hit are reported, not swallowed: a frame over the ceiling, and a frame
that is not valid UTF-8. `transport.ts` writes either as a `framing_problem` event on the session's own log
— which *is* the file `delegate_status` reads, so the record now says why a session's story stops
mid-sentence (`[framing]: …`, the reason flattened to one line because it is still agent-supplied bytes, and
it never enters the prose-only full read) — and warns through the runtime's failure channel, which is where
a transcript that can no longer be written already goes. Nothing goes to stdout: the extension has no
stdout to write to, which is what the gate's `noStdioWrites` invariant is for.

The exit-vs-close drain logic is untouched: the tail buffer is flushed when stdout ends, so a final
unterminated frame still arrives — the ordinary shape of a one-turn agent that answers, writes, and exits.

## 6. Permissions: only exact ids are answers

`pickPermissionOption` falls back to "the first option whose `kind` is `allow_once`". The fake that
reproduces the 2026-10-22 incident carries the real payload, and in it `allow_session` has
`kind: "allow_always"` — proof that `kind` is a label, not an identity. The shared policy now matches
`optionId` exactly and answers `cancelled` when the id it needs is absent; a driver may map a
*different exact id* (agy's `allow_always`) but never a foreign one, and never anything whose id it
has not been told about. A `trust`-style option that an adapter offers with `kind: "allow_once"` is
the exact case this stops.

## 7. Bash guard

Two things had to change, and one of them was wrong in every driver's favour.

**Read-only verbs are a fact about a CLI, not a shared list.** The old set covered Devin's forms
(`models list`, `auth status`, `list`, `ls`, `version`, `help`) and nothing else, so `agy models` — asking
which models exist, the question the delegate skill itself tells an agent to ask — would have been
refused, while a bare `models` in the set would have let `agy models delete` through. A shared list was
the cheap version of the rule and it got both directions wrong. `READ_ONLY_VERBS` is now a per-binary
table and `isReadOnlyInvocation(binary, args)` asks about the binary it matched. `agy-acp` deliberately
has no verbs: `--help`/`--version` are allowed by the base set, and everything else about it starts a server.

**`--flag=value` is the same flag.** The work-flag test matched whole tokens, so `agy --help -p x` was
blocked and `agy --help -p=x` was allowed — one command decided by a character. Both shapes are pinned.

**The headless work flags were missing.** `WORK_FLAGS` had `--print` and `--resume` but not `-p`, `-c`,
`-r`, `--conversation`, `--input-format`, `--output-format`, `--dangerously-skip-permissions` or a bare
`--` (agy's end-of-options) — which is the whole shape of running a CLI unattended. `agy --help -p "..."`
works, and reached the allow-list. Both directions are pinned in `test/test-delegate-cli-guard.ts`.

**A driver can now guard more than one name.** `capabilities.extraClis` joins `cli` in `guardedClis()`,
which the tool layer already read from the registry: the delegate blocks `agy` *and* `agy-acp`, because
the adapter starts the same work behind a name a guard watching `agy` would not match. Claude is still
not guarded (blocking the operator's own CLI would break unrelated sessions), and the test that the
guarded list is derived rather than copied now also asserts every guarded binary has a deliberate
read-only surface — an empty table there is a decision, not an oversight.

## 8. Install check

`preflight()` is the delegate's install check and runs before a slot is spent (`queue.ts`), so a missing
install costs a subprocess, not a session:

- `agy-acp` not on `PATH` → "the `agy-acp` adapter is not on PATH" + the install hint.
- `agy` not on `PATH`, or `agy --version` unreadable → says the adapter needs agy at the tested version.
- an untested agy version → a warning, not a refusal (matching `agy-acp`'s own version gate; it is the
  one that refuses when `AGY_ACP_STRICT_VERSION=1`).

The tested version is declared in the driver and a test asserts it equals `agy-acp`'s own
`TESTED_AGY_VERSIONS`, so the two cannot drift silently.

## 9. Liveness: a heartbeat is not a stall

`agy-acp` emits a `session/update` with `sessionUpdate: "heartbeat"` and `_meta.heartbeat.{state,
pendingPermissions,turnMs,seq}` while a turn runs, because agy goes silent when its hook blocks. Every
frame already refreshes `meta.lastMessageTime`, so a beat keeps the stall clock quiet; what was missing
is that the beat is *named*: `defaultMapUpdate` maps it to a canonical `liveness` event, which writes
no transcript line (a beat every 15 s over a long turn is not history), and the stall verdict becomes a function — `isStalledNow({status, pendingPermissions, lastActivityMs,
stallMs})` — which `DelegateRuntime.stallTick`, the body of the watchdog timer, asks instead of
re-implementing. Round 1 of the review caught the first version of this: the function existed, the timer
kept its own copy of the clauses, and the tests certified the copy. One verdict now has one caller, so
"waiting on a permission answer is not a stall" is an assertion about the code that ships.

The beat's payload (`state`, `pendingPermissions`, `turnMs`, `seq`) travels on the event and is not read by
the engine, stated rather than implied: the engine's own outstanding-ask count is the authority on whether a
session is waiting, and putting the agent's number in charge of the watchdog that judges the agent would be
backwards. What the beat is for is that an adapter which is silent by design still produces frames — and any
frame is activity.

## 10. Acceptance mapping

| Acceptance item | Where |
| --- | --- |
| backend selection | `test/test-delegate-registry.ts` (admit + generated tool text + `/delegate agents` line) |
| spawn argv per backend | `test/test-delegate-agy.ts` (driver argv per selection), `test/test-delegate-transport.ts` + `test/fake-acp-server.mjs` (argv observed by the child) |
| permission mapping by exact id; unknown option never chosen | `test/test-delegate-agy.ts`, `test/test-delegate-permissions.ts` |
| watchdog does not flag a pending permission as stalled | `test/test-delegate-liveness.ts` |
| framing fix proven by a frame with U+2028 | `test/test-delegate-framing.ts` |
| `agy` blocked from bash, read-only exceptions | `test/test-delegate-cli-guard.ts` |
| manual end to end | not possible in CI (needs a signed-in agy 1.4.2); recorded as a follow-up in the PR |

## 11. Out of scope, recorded

- A `session/resume` loader for `agy` (needs #56, which is on `dev`).
- `backfill` for `agy` recovery (refused by the epic's security rules).
- A subagent view of `agy` sessions (sub-issue 10).
- Making `--allow-bypass` reachable for a delegate: it stays the operator's knob.
