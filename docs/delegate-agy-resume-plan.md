# Plan: continue an `agy` session whose process is gone (`resume`)

Follow-up to `docs/delegate-agy-backend-plan.md` §"Resume", which declared `capabilities().resume`
`false` for the `agy` driver — correctly, at the time: `session/load`/`session/resume` (agy-acp #56)
lived on `dev` while the delegate's driver registry lived on `main`, and the engine's reattach was
"spawn, then prompt the recorded id", which `agy-acp`'s registry refuses for an id it did not mint.
The `dev`→`main` convergence (PR #84) put both halves in one tree, so the claim is now available and
this document is the work of earning it.

## 1. Goal

`delegate_message` on an `agy` session whose `agy-acp` process died continues the **same**
conversation: the new process adopts the recorded id, and the first prompt of the new turn respawns
`agy` with `--conversation`. Today that call answers `NO_CONNECTION` and sends the caller to
`delegate_restart`, which re-runs the prompt from scratch under a new id — a different conversation
wearing the same title.

## 2. The hook is the driver's, the call is the engine's

`capabilities().resume` was always a promise about code the engine has to own, and the two agents that
could claim it differ in how it is reached:

| agent | where the conversation lives | what a fresh process needs |
| --- | --- | --- |
| Devin | its own servers | nothing — it answers the recorded id on the next `session/prompt` |
| Claude | nothing **verified**: `claude-agent-acp` advertises `loadSession`, but no `resumeHandshake` has ever been run against it | — , so `resume` stays `false` |
| agy | `agy-acp`'s on-disk store (`AGY_ACP_STATE_DIR`, #56) | `session/resume {sessionId, cwd}` before the prompt |

So `AgentDriver` gains an **optional** `resumeHandshake(sessionId, cwd) → {method, params}` and
`reattachSession` makes it, between spawning and prompting, only for a driver that declares one.
Asking Devin would be a `method not found` on every follow-up, and asking no one is what the old code
did; the optionality is the difference between the two bugs.

`session/resume`, not `session/load`, and that choice is the interesting one. The adapter's two methods
differ only in whether the stored transcript is replayed as `session/update` frames — and our event log
**is** the file `delegate_status` reads. A load would append a second copy of the whole conversation on
every follow-up, in the record the caller trusts, forever. `resume` registers and answers; nothing else
arrives.

## 3. What the answer is good for

The restore answers with what `session/new` answers with (modes, models, `configOptions`) plus
`_meta.restored`: what the store kept, and the notes — a stored mode or model this process cannot
honour, corrected on the way in.

* The vocabulary goes through `seedOptions`, the one writer for both handshakes, so a session that came
  back is configured against the list it really advertised. `session/new`'s parser moving to
  `handshake.ts` is what makes "the same reader for both answers" a fact rather than an intention.
* The notes are written to the session's own event log (`session_resumed`) and repeated on the
  warning channel: a session that is not in the mode its record claims is the operator's problem, not a
  footnote in a file nobody opens.
* A correction replaces the preference it corrected, in all three controls: `meta.mode` from
  `modes.currentModeId`, `meta.model` and `meta.thinking` from the `model` / `effort` entries of
  `configOptions`. A restore emits no `current_mode_update` and no `set_*` frame, so this answer is the only
  place the truth is written — and `delegate_status` reads `meta`, and `delegate_restart` re-sends it. A
  session restored into `default` that keeps reporting the `accept-edits` it was refused is the exact lie
  `mode.changed` was written to prevent mid-turn.
* An answer naming a **different** id — or no id at all — is a refusal. The engine prompts the id it
  recorded; sending the caller's next sentence into somebody else's conversation is the one outcome worse
  than failing, and an answer that never confirmed adoption is only a hope.

## 4. The workspace rule

`agy-acp` never moves a conversation to another workspace, and it refuses a resume whose `cwd` is not
the one its record names. The engine used to recompute the workspace as `worktreePath ?? baseDir` at
reattach time, which is the same answer only while nothing else changes — and a pi restart from a
different folder is exactly when a resume gets asked for. `SessionMeta` therefore now records
`sessionCwd` at creation, and the handshake asks in that folder. Records written before this change have
no `sessionCwd` and fall back to the old expression — and once a resume succeeds, the workspace the store
named in `_meta.restored.cwd` is written into the record, so the next restart asks in the folder the store
vouched for instead of falling back again.

Both recorded directories are re-checked on the way back in, by `absolutePathOr` beside `isStorageSafeId`:
a state file is read after a crash with whatever it names, and these two values become a spawn cwd. A
relative path is dropped, so a planted record sends a session to the runtime's base rather than somewhere
resolved against pi's own directory.

## 5. Failure is the adapter's sentence

`followUp` answers `REATTACH_FAILED` and releases the slot it reserved, and the store's refusals arrive in
its own words rather than translated. Of `OpenFailure`'s five kinds, three are the ones a caller can act
on: no such conversation, a conversation belonging to another workspace — where the recorded path *is* the
fix — and a conversation another process still holds. The other two, this adapter already having it open
and a record it could not read, are still quoted rather than turned into one code.

One spawn serves a window. `activeClients` is filled at the **end** of a reattach and a session is not
`running` until its turn starts, so two follow-ups arriving together would each spawn an agent and each ask
for the conversation; the loser of the store's lock then answers "held by another `agy-acp` process", which
reads like a dead conversation and sends the caller to `delegate_restart` — the loss this path exists to
prevent. `reattachSession` therefore keys an in-flight promise per session, and the second caller waits for
the connection the first is making instead of competing for it.

## 6. Tests

| Claim | Where |
| --- | --- |
| the handshake is sent before the prompt, with the id and the workspace | `test/test-delegate-resume.ts` (stub transport, RPC order) |
| Devin is prompted with no handshake | same |
| the resumed vocabulary seeds the catalogue `configureSession` reads | same |
| a refused resume reports the adapter's words, prompts nothing, frees the slot | same |
| an answer naming another id is refused | same |
| `sessionCwd` survives a restart in another folder; legacy records still resolve | same |
| the workspace survives the **record** on disk, and a planted relative one is dropped | same, through `normalizeMeta` |
| a mode the adapter corrected on restore stops being reported as the one that was asked for | same |
| the same for model and effort, and the store's own workspace is back-filled into an old record | same |
| an answer naming no id at all is refused, and nothing is prompted | same |
| two follow-ups in the reattach window share one spawn and adopt the conversation once | same |
| the restore answer still names `_meta.restored.*` and the advertised state | `test/test-delegate-agy.ts` |
| on the wire: `new → prompt → resume → prompt`, in two different processes | same, against `test/fake-acp-server.mjs` with `FAKE_STORE_DIR` |
| on the wire: an unknown conversation never gets a prompt | same |
| the driver still claims what the adapter still offers (`loadSession`, `session/resume`, its params) | `test/test-delegate-agy.ts` |

`test/fake-acp-server.mjs` gained the store (`FAKE_STORE_DIR`, `FAKE_RESUME_NOTES`) rather than the test
gaining a mock: the fake now *is* an agent with a conversation that outlives its process, and it refuses
a prompt for one it did not create in this process. The order is then read off `<store>/<id>.calls`, so
the proof is the child's, not the test's.

## 7. Out of scope

* `backfill` for `agy` recovery (reading another program's private store during recovery), still refused
  by the epic's security rules — recovery reports `interrupted`.
* A `session/load`-based transcript replay for `agy` sessions (a caller wanting the history asks for
  `delegate_status`, not a second copy of it in the log).
* Making `session/list` reachable from the tools: it would answer "which of my sessions can I continue",
  which is a tool-design question of its own.
* The subagent view of `agy` sessions (agy-acp #59 attributes them; the delegate renders one opaque tool
  call).
