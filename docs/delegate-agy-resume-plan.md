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
  `configOptions` — and an effort of `default`, which is the adapter's way of saying the model chose, clears
  `meta.thinking` rather than leaving the refused level in the record. A restore emits no `current_mode_update` and no `set_*` frame, so this answer is the only
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

The recorded folder wins over the current one even for an agent with no store to disagree, and that is a
choice with a cost: a follow-up whose creation folder has since been deleted fails, where re-parenting it
onto whatever pi is running in now would have kept going. A conversation continued in a workspace nothing
else about it belongs to is the worse of the two. What it fails *with* mattered more than expected: Node
reports a failed spawn as `spawn <command> ENOENT` whichever of the two is missing, so the transport now
quotes the working directory too — otherwise the operator reads "agy-acp not found" for a binary that is
sitting right there, and the deleted folder never appears in the story.

Both recorded directories are re-checked on the way back in, by `absolutePathOr` beside `isStorageSafeId`:
a state file is read after a crash with whatever it names, and these two values become a spawn cwd. A
relative path is dropped, so a planted record sends a session to the runtime's base rather than somewhere
resolved against pi's own directory.

## 5. Failure is the adapter's sentence

`followUp` answers `REATTACH_FAILED` and releases the slot it reserved, and the store's refusals arrive in
its own words rather than translated. Of `OpenFailure`'s five kinds, three are the ones a caller can act
on: no such conversation, a conversation belonging to another workspace — where the recorded path *is* the
fix — and a conversation another process still holds. The other two are still quoted rather than turned into
one code: this adapter already having the conversation open, and the store itself being unusable (its root
or its lock — a record that will not decode is `unknown`, the first kind, not this one).

One spawn serves a window. `activeClients` is filled at the **end** of a reattach and a session is not
`running` until its turn starts, so two follow-ups arriving together would each spawn an agent and each ask
for the conversation; the loser of the store's lock then answers "held by another `agy-acp` process", which
reads like a dead conversation and sends the caller to `delegate_restart` — the loss this path exists to
prevent. `reattachSession` therefore keys an in-flight promise per session, and the second caller waits for
the connection the first is making instead of competing for it.

Waiting is not the end of it: the caller that waited must not then prompt a session somebody else just
started a turn on. `agy-acp` answers a second concurrent `session/prompt` with `TURN_IN_PROGRESS`, and the
rejection path marks the session failed while the real turn is still running — which would have made the
second caller's `{ok: true}` a silently dropped message. `followUp` therefore re-reads the status after the
await and answers `BUSY`, telling the caller to send it again.

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
| two follow-ups in the reattach window share one spawn, adopt once, and the loser is refused (`BUSY`) rather than double-prompting | same |
| an effort the model picked for itself clears `meta.thinking` instead of leaving the refused level | same |
| the restore answer still names `_meta.restored.*` and the advertised state | `test/test-delegate-agy.ts` |
| on the wire: `new → prompt → resume → prompt`, in two different processes | same, against `test/fake-acp-server.mjs` with `FAKE_STORE_DIR` |
| on the wire: an unknown conversation never gets a prompt | same |
| a reattach that lands after this pi closed the session installs nothing and disposes its child | same |
| a restarted conversation refuses its follow-ups naming the new id, and spawns nothing for them | same |
| a restart that lands mid-reattach stops the prompt and disposes the child | same |
| a spawn failure names the missing workspace, not only the command | `test/test-delegate-transport.ts` |
| the real `delegate_restart` leaves the pointer, and the real `delegate_message` reads it | `test/test-delegate-queue.ts` (Q4) |
| restarting an already-restarted id refuses, naming the successor and not a second sibling | same (Q4) |
| a message that lands during the restart's own spawn window is refused, not reattached beside it | same (Q4b) |
| a queued restart's pointer resolves to the session it started, and shows in the report | same (Q11) |
| the pointer survives `normalizeMeta`; a string, a number, an array and `{}` do not become one | `test/test-delegate-resume.ts` |
| a closed PR does not release a worktree a restarted sibling is working in | `test/test-delegate-worktree.ts` |
| a session whose restart is still in flight is skipped by that cleanup as well | same |
| recovery derives a missing pointer from the successor that came back, and writes it out | `test/test-delegate-recovery.ts` |
| a pointer naming nothing is dropped, one naming a restart still queued is kept | same |
| the driver still claims what the adapter still offers (`loadSession`, `session/resume`, its params) | `test/test-delegate-agy.ts` |

`test/fake-acp-server.mjs` gained the store (`FAKE_STORE_DIR`, `FAKE_RESUME_NOTES`) rather than the test
gaining a mock: the fake now *is* an agent with a conversation that outlives its process, and it refuses
a prompt for one it did not create in this process. The order is then read off `<store>/<id>.calls`, so
the proof is the child's, not the test's.

## 7. A restarted session stops being addressable (round 5)

Round 4 guarded the reattach against the session going away, and round 5 read `delegate_restart` closely
enough to find that the guard had missed the case its own message named: a restart **mints a new id** and
leaves the old record in `rt.sessions`, unmutated, so `rt.sessions.get(meta.sessionId) === meta` holds
throughout and the check passed. What it should have caught is worse than an orphaned connection — a
follow-up addressed to the old id reattaches the conversation and prompts it while the restarted sibling
runs, and `delegate_restart` reuses the worktree, so two live agents of one conversation end up editing one
checkout. `queue.ts` already refuses that for cancelled sessions, and the same end state is reachable
sequentially (restart, then message the old id, which stayed resumable by design), so the fix was the
pointer rather than a narrower comment.

`SessionMeta.supersededBy` is written by `markSuperseded` when a restart starts (`{sessionId}`) or queues
(`{queueId}`), persisted and re-read by `normalizeMeta`, and terminal — except for a restart that is still
only queued: if that entry is cancelled, or fails to start, `abandonQueuedRestart` hands the conversation
back, because nothing may dead-end it for something that never happened. Once a successor session exists the
pointer is permanent.

### §7.1 The three things that had to be true for the pointer to mean anything (round 6)

Writing the pointer was the first draft of the fix. Round 6 found it was not enough, in three ways that each
survived the tests written alongside it:

* **It was written too late.** `markSuperseded` ran after `await delegate()` — that is, after the kill window,
  the spawn, the handshake, the config round trips and the first prompt. For all of that, the old id was fully
  addressable, and a `delegate_message` landing in the window passed every check and reattached the
  conversation beside the sibling. The pointer cannot be the marker for a window that opens before it can
  exist, so `rt.restarting` holds the id **from the moment the restart tool is entered, before its first
  await** — including `begin()`, which is what the first version of the fix still left open, and what the new
  queue scenario caught. In flight is process-local by definition: after a pi restart nothing is pending, so
  it is a `Set` in the runtime and never a record on disk, where a crashed restart would have dead-ended a
  conversation for ever. The same rule works the other way: a restart refuses while a reattach is in flight.
* **Restart ignored it.** `delegate_restart` of an already-superseded id minted yet another sibling into the
  same worktree and overwrote the pointer, losing the link. It now refuses and names where the conversation
  went; the successor is the only way on.
* **The worktree had changed hands and nobody knew.** A restart reuses the folder, so a *settled* superseded
  record still names a directory a live agent is editing. `delegate_clean_worktree` (both `session_id` and
  `all_settled`), `onPrClosed` and `cancelSession` all treat "settled, worktree active" as dead wood, and the
  safety check inside `releaseWorktree` looks at uncommitted work, not at ownership. Each now skips a
  superseded record; cancelling the *queued* restart no longer removes the reused folder either, since that
  folder was provisioned for the parent and never came back.

The pointer is also rendered now — in the `delegate_status` overview line and the session report — because
otherwise the only way to learn where a conversation went is to send it a message and be refused.


### §7.2 What a crash leaves, and what recovery may conclude (round 7)

A pointer is a promise about the future, and `markSuperseded` still runs after `await delegate()` — it cannot
run earlier, because there is nothing to point at until a successor exists. `rt.restarting` closes the window
for the process that started the restart and for nobody else, so a pi that dies mid-restart leaves three
promises that may not match the records on disk. Recovery now reads them back:

* **A successor that came back takes the conversation.** `delegate_restart` is the only writer of
  `parentSessionId`, so a restored session naming a parent *is* that restart, and the parent is marked even
  though the restart never reached its own pointer. Without this both records are addressable and both name
  the folder the restart reused: the exact hazard §7.1 exists to prevent, arriving through a crash instead of
  through a race. The provenance write now happens the moment `parentSessionId` is assigned in `startNow`,
  because the narrower that window, the less recovery has to infer.
* **A pointer naming nothing is handed back.** A `{queueId}` entry absent from the restored queue can only
  mean the restart never produced a session — `resolveQueuedRestart` rewrites to `{sessionId}` before a
  successor can exist — and a `{sessionId}` whose record could not be read names a ghost either way. The
  refusal would send every caller to something that does not exist, permanently, while every worktree path
  skips the record, so the folder became unreclaimable too. Recovery clears it and logs what it dropped.
  Deriving first is what makes this safe: a pointer derived from a live successor is never cleared after.
* **The in-flight claim covers the folder too.** Through a restart's spawn window the parent is settled and
  unmarked, and `releaseWorktree`'s safety check looks at uncommitted work, not ownership: a
  `delegate_clean_worktree` sweep or a PR closed in that window deleted the directory the successor was about
  to start in. That sweep and the PR-closed cleanup now ask `restartClaimsWorktree` — the pointer check plus
  `rt.restarting` — and naming a session to `delegate_clean_worktree` refuses on either. `cancelSession` needs
  no such guard: by the time a restart is in flight it has already moved its parent out of a cancellable
  status, so its release cannot run for the folder mid-handover.

One detail is load-bearing in the tests rather than in the code: `normalizeMeta` rebuilds a pointer with
**exactly the keys that were set**, so a `{ queueId }` round-trips into `{ queueId }`. Growing an
`undefined` twin made a recovered pointer stop comparing equal to the one that was written, which is how the
round-trip test caught it.

What stays impossible: a crash between the successor's registration and its provenance write leaves nothing to
derive from. The parent remains addressable, the successor is an ordinary session, and both name one folder —
recovery cannot tell that story from evidence it does not have, so it does not guess, and the operator's
`delegate_status` shows two sessions.

## 8. Out of scope

* `backfill` for `agy` recovery (reading another program's private store during recovery), still refused
  by the epic's security rules — recovery reports `interrupted`.
* A `session/load`-based transcript replay for `agy` sessions (a caller wanting the history asks for
  `delegate_status`, not a second copy of it in the log).
* Making `session/list` reachable from the tools: it would answer "which of my sessions can I continue",
  which is a tool-design question of its own.
* The subagent view of `agy` sessions (agy-acp #59 attributes them; the delegate renders one opaque tool
  call).
