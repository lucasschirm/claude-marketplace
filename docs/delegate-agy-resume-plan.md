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
| a cancel that lands mid-reattach stops the prompt — for a fresh **and** an already-cancelled conversation | same, against `rt.cancels` |
| an id the agent hands back a second time cannot evict the session that already holds it | same |
| a hostile id in `state.json` cannot stop recovery or leave the storage tree | `test/test-delegate-recovery.ts` |
| a recorded root survives only when both halves are ids, and a session is keyed by its own record | same |
| a debounced record write lands in the home it was scheduled in, not the one answering three seconds later | `test/test-delegate-runtime.ts` |
| the pids that are lethal (`0`, `-1`, this process) are never probed and never killed | `test/test-delegate-process.ts` |
| a planted `pid` never survives `normalizeMeta`, and hostile container scalars never become counters | `test/test-delegate-recovery.ts` |
| a hostile recorded root cannot stop recovery even when its session is listed; the binding follows the record | same |
| provenance that points both ways is not turned into two pointers that refuse each other forever | same |
| cancelling a parked agent is not a second completed turn; cancelling a running one is | `test/test-delegate-runtime.ts` |
| a start still spawning when pi shut down registers nothing and prompts nothing | `test/test-delegate-resume.ts` |
| a released worktree, or one removed without the session being told, is a refusal rather than a prompt | same |
| a release deletes the folder it checked, never the id it was handed | `test/test-delegate-worktree.ts` |
| a sweep that stops partway answers with an error and with the folders it already released | same |
| a start pi shut down mid-way takes the worktree it provisioned, and writes no record anywhere | same, `test/test-delegate-resume.ts` |
| a start that was choosing its mode when pi shut down sends no prompt and re-registers nothing | `test/test-delegate-resume.ts` |
| an agent that dies before it was ever prompted is not a completed turn; one that dies mid-turn is exactly one | `test/test-delegate-runtime.ts` |
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
| a queued task naming its parent marks the parent too, in the boot that restores it | same |
| restored queue ids are unique, so a pointer cannot match a task that is not its restart | same |
| a folder mid-release is not reusable, and the release publishes itself before its first await | same |
| two overlapping releases of one folder keep it off-limits until the last one finishes | same |
| a cancel that overlaps a restart does not release the folder the successor is spawning into | same |
| a duplicate restored queue id terminates recovery instead of spinning forever | `test/test-delegate-recovery.ts` |
| the queue-id generator starts above every id restored from disk | same |
| missing, repeated and id-less queue records still end up one id per task | same |
| a poisoned counter or an unreachable suffix cannot freeze the id generator | same |
| abandoning a queued restart does not promote a session half that is dead | same |
| a cancel that lands mid-reattach stops the prompt instead of denying there is anything to cancel | `test/test-delegate-resume.ts` |
| a session cancelled earlier is still a conversation, and a connecting one still owns its worktree | same, `test/test-delegate-worktree.ts` |
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
* **A pointer naming nothing is handed back.** Absent means no successor **with provenance** came back. It does
  not mean the restart never happened: `drainQueue` pops and persists the entry before the successor is
  spawned, so a crash there leaves a `{queueId}` with nothing queued and possibly a record on disk that never
  got its `parentSessionId` — a session existed, and nothing says whose it was. Whatever the history, a pointer
  to an absent target sends every caller somewhere they cannot act on, permanently, while each worktree path
  skips the record and the folder stops being reclaimable. Recovery clears it and logs what it dropped. Deriving
  first is what makes this safe: a pointer derived from something that came back is not cleared after.
* **The in-flight claim covers the folder too.** Through a restart's spawn window the parent is settled and
  unmarked, and `releaseWorktree`'s safety check looks at uncommitted work, not ownership: a
  `delegate_clean_worktree` sweep or a PR closed in that window deleted the directory the successor was about
  to start in. That sweep and the PR-closed cleanup now ask `restartClaimsWorktree` — the pointer check plus
  `rt.restarting` — and naming a session to `delegate_clean_worktree` refuses on either. `cancelSession` asks
  the same predicate: its gate lets a *settled* session through when something still holds a client for it, so
  a cancel that overlaps a restart really can reach the release — and the sub-second case (child pid gone, exit
  event not yet delivered, stale client entry) is exactly the moment the folder is mid-handover.

One detail is load-bearing in the tests rather than in the code: `normalizeMeta` rebuilds a pointer with
**exactly the keys that were set**, so a `{ queueId }` round-trips into `{ queueId }`. Growing an
`undefined` twin made a recovered pointer stop comparing equal to the one that was written, which is how the
round-trip test caught it.

What stays impossible: a crash between the successor's registration and its provenance write leaves nothing to
derive from. The parent remains addressable, the successor is an ordinary session, and both name one folder —
recovery cannot tell that story from evidence it does not have, so it does not guess, and the operator's
`delegate_status` shows two sessions.

### §7.3 The three seams round 8 found in the crash story

Round 7 closed the crash window and left three seams of its own, all found by Devin reading the new code
against a boot rather than against a race:

* **The provenance write outran the folder.** `startNow` persisted the successor the moment `parentSessionId`
  was assigned — which was *before* the worktree fields were, and `persistMeta` serializes at the call. A pi
  dying inside `configureSession` then left a record that said "I am the restarted one" and named no folder:
  recovery pointed the parent at it correctly, the child restored with no worktree claim, every cleanup path
  skipped the parent, and the directory leaked for good. The five assignments are synchronous, so moving them
  above the write costs nothing and keeps "before anything awaitable" true.
* **A release is seconds long and says nothing while it runs.** `releaseWorktree` keeps `worktreeStatus` at
  `"active"` through the safety check and the orca removal, and `cancelSession` fires it unawaited — while
  "cancel it, then restart" is the documented recovery flow. A restart asking "is that folder reusable?" in
  that window said yes and started an agent in a directory about to be deleted. `rt.releasingWorktrees` is the
  transitional state, published by the primitive so no caller can forget to, and read by `worktreeIsReusable`,
  which is now the one place that answers the question. A session whose folder is mid-release restarts into a
  fresh one; the old folder finishes going away.
* **Recovery read the sessions and not the queue.** A queued restart persists its task (`parentSessionId` and
  all) long before the tool call can write a pointer, so the same crash-consistency gap existed one step
  earlier: the boot restored the task, started it, and never marked the parent — both ids addressable until
  *some later* boot derived it from the child. Derivation now reads queued tasks too, pointing at the entry
  rather than a session, which is what the caller needs to be told anyway.

Two of the fixes are about pointers meaning what they say. A pointer with both keys and one live half is kept
(the caller has somewhere to go); restored queue ids are made unique, because `normalizeTask`'s id-less
fallback cannot see its siblings and a duplicate would make a dead pointer look alive. And two comments were
wrong in ways a future reader would rely on: `parentSessionId` was documented as generic delegation
provenance when `delegate_restart` is its only writer — the exclusivity derivation depends on — and §7.2's
claim that an absent `{queueId}` "can only mean the restart never produced a session" was stronger than what
holds: the crash can land after the entry was popped, leaving a successor that never got its provenance. The
decision to hand the conversation back is unchanged; the reason is that no successor *with provenance* came
back, which is what the code can actually know.

Round 8's commit message said that second sentence had been rewritten. It had rewritten the comment in
`recovery.ts` and not the sentence in this document, and round 9 caught §7.2 still contradicting §7.3. The fix
is in §7.2 now. A correction that lands in the summary of a change and not in the thing being corrected is not
a correction — which is worth writing down, because the commit message is what nobody re-reads.

### §7.4 What round 9 found in round 8's own fixes

* **A dedupe loop that could not terminate.** The replacement id round 8 minted was
  `q-${rt.totalInvoked + restoredIds.size + 1}`, and both terms are fixed for the duration of one task's
  `while`: when the candidate was already taken the loop spun forever inside `recoverState`, which every tool
  path awaits. Crafted state reaches it in one line (`totalInvoked: 5` with two entries named `q-7`), and a
  half-written or hand-edited `state.json` is not far away. Recovery now raises `totalInvoked` above the
  highest numeric id on disk, and a duplicate is replaced by a single `++rt.totalInvoked` rather than by a
  retry: the counter has been cleared above everything on disk and only climbs, so the first candidate is
  replaced by a single `++rt.totalInvoked` — and the reason "so the first candidate is already free" needed
  saying twice, because round 9 was true of that pass and false of the program. §7.5 is what came of it.
  That also closes the finding's second half: `totalInvoked` *is* the id generator, so ids restored from disk
  have to sit below the next mint — otherwise a restored `q-50` and a future `q-50` are one lookup key, and
  the ambiguity the dedupe exists to remove comes back through the counter. The retry loop is gone rather than
  bounded, because a synchronous spin in recovery cannot even be timed out — a test hung on it while the
  harness waited for an event loop the spin was holding.
* **The marker was a set, and two releases overlap.** `cancelSession` fires its release unawaited, and
  `delegate_clean_worktree` or a PR-close event can start another on the same path. Both added the same
  element; whichever finished first deleted it while the other was still inside `removeOrcaWorktree`, and the
  folder looked reusable again. It is a count now (`markWorktreeReleasing` / `unmarkWorktreeReleasing`), and
  the last publication is what lifts it.
* **Write the record, then the pointer that names it.** Round 8 moved the worktree fields ahead of the
  successor's write but left `resolveQueuedRestart` — which writes the parent's `{sessionId}` pointer — before
  that write. Crashed between the two, the parent pointed at a successor with no provenance and no folder:
  recovery keeps a pointer whose session exists, so nothing healed and the folder leaked. The successor's own
  record going first makes the residual self-healing, because recovery derives pointers from it.
* **The same leak for a session that never restarted.** The early persist was gated on `parentSessionId`, so an
  ordinary task assigned its worktree fields without a write: die during `configureSession` and a provisioned
  folder belongs to a record that does not know it exists. Pre-existing on `main`; the gate is
  `parentSessionId || worktreePath` now.
* **`cancelSession` needed the folder guard after all**, for the reason §7.2 had dismissed: its settled-session
  gate passes while a client is still registered, so a cancel can overlap a restart. One line, the same
  predicate as the other two call sites.
* **Two smaller truths.** Abandoning a queued restart clears only the `{queueId}` half of a pointer (§7.5 puts a
  condition on that half); and the `git worktree remove` fallback behind `removeOrcaWorktree` got the mutation
  timeout its sibling calls already carried, because a hung git there would pin a folder's release marker
  forever.

### §7.5 One id, one writer, and only reachable numbers (round 10)

Round 9 raised the generator above the ids on disk and minted once. It had not stopped the *other* writer:
`normalizeTask` still filled a missing `queueId` with `q-${totalInvoked + 1}` — a read, never an increment. So
`[{no id}, {no id}]` restored as two `q-6`s, and `[{no id}, {q-7}, {q-7}]` as `q-10, q-7, q-10`: the id-less entry
kept `q-10`, and reminting the second `q-7` produced exactly that string. The collision the pass exists to remove
arrived by another door, and the harm is the one the pass already names — `{queueId}` pointers,
`delegate_cancel` and `abandonQueuedRestart` all match on the id, so twins make a dead restart look like it is
still waiting and a cancel frees only the first twin. Recovery is now the only thing that hands ids out: the
normalizer returns an empty `queueId` and the pass mints it. That is also the condition under which "the first
candidate is free" is true, rather than merely asserted — the counter sits above every reachable id, and every
mint consumes it.

Reachable is the other half of the proof, and it was missing. `state.totalInvoked` is a JSON number nothing
type-checked: `"abc"` makes `Math.max` return NaN and every mint for the boot is `q-NaN`; a
`q-999999999999999999999` on disk parses to 1e21, where `++` is absorbed, so every mint is the same string
forever — and the minted `q-1e+21` no longer matches `QUEUE_ID_RE`, so the next boot cannot see the value that
stalled it either. Both ends now pass `Number.isSafeInteger` under a `MAX_QUEUE_ID` ceiling, because a queue a
billion deep is corrupt data rather than a queue, and believing it costs the generator every id after it.

The same round caught the abandoned-queue pointer promoting whatever session half it found. A both-halves pointer
only arrives from disk — live writers emit one half each — and a disk half can name a session that died, which
would refuse the parent as "restarted as `<gone>`" with nothing behind the id until the next boot reconciled it.
The half is checked against `rt.sessions` now, and a pointer naming nothing is dropped rather than inherited.


### §7.6 Cancelling a session that is still connecting, and where a test's writes actually land (round 11)

**A follow-up mid-reattach looked finished to `delegate_cancel`.** The gate asked for `running`/`stalled` or an
`activeClients` entry, and during `await reattachSession` the record is settled and no client is registered —
`reattachOnce` registers one only after the spawn and the resume handshake. So `delegate_cancel` answered
"nothing to cancel" while the reattach went on to spawn an agent and prompt it: the caller was told there was
nothing to stop, and then watched a turn start. The window is the whole handshake, and the path is new in this
PR — before it, a dead connection got `NO_CONNECTION` without spawning anything. Three changes, all in the shape
the spawn path already used (`startNow` refuses to start a session that was cancelled during `configureSession`):
the gate also treats `rt.reattaching` as cancellable; `reattachRefusal` refuses a record that was cancelled while
its agent was starting, disposing the child it just spawned; and that branch neither kills the recorded pid (a
recycled number belonging to something else — the live child is not registered yet) nor counts a completion for
a turn that never ran.

**The delegate test suite was writing into the developer's real `~/.pi`.** `makeStub` redirects `HOME`, and
`storage.ts` resolves `os.homedir()` *when a write happens*, so any write still in flight after `restoreHome`
resolved the real home. Round 11 found the receipts: `~/.pi/agent/delegate_task/pi-test/state.json`, mtime equal
to the last run, holding this suite's prompts and reminted queue ids, alongside `meta.json` litter from four
different test files — some of it older than this branch. Round 10's `Promise.all` made it systematic (every
case's continuation ran after a sibling had restored the environment), so the case tables are sequential tests
again; the helper fix is what makes the class go away. A finished stub now keeps its directory answering
`os.homedir()` until the next stub takes over, and every directory a run created is reclaimed when the process
exits. A late write belongs somewhere, and that somewhere must not be whoever ran the tests.

**Two refusals prescribed a `delegate_cancel` that could not work.** During an in-flight restart there is nothing
cancelable at the old id — the record is settled and the successor is not registered yet — so the `RESTARTING`
text no longer suggests it. The mid-reattach one does, and after the change above it is true.


### §7.7 A refusal that outstayed its window, and the settled record with a process behind it (round 12)

**`cancelled` is a fact about the last turn, not a ban on the conversation.** Round 11's refusal checked the status
without asking when the cancel landed, so it also fired for a session cancelled before the follow-up was typed —
spending a process spawn and a driver restore (for `agy`, a `session/resume` that adopts the whole conversation)
before saying no, describing a cancel from yesterday as "while its agent was starting", and quietly removing a
capability: on `main` `reattachSession` checked nothing, so a cancelled session whose agent keeps its history
server-side could simply be continued by `delegate_message`. The check now asks whether the record was already
cancelled when this attempt began. If "cancelled is terminal for messaging" ever becomes the rule, it belongs next
to `conversationTakenElsewhere` in `followUp`, where it costs nothing and can tell the truth — not in the middle
of a handshake that exists to be refused.

**A third settled record has a live process behind it.** Rounds 5 through 8 taught the worktree paths about a
restart: written pointer, or still spawning. A follow-up mid-reattach is the same shape — spawned, resuming, about
to prompt *in that directory* — and it is settled with no registered client, so `delegate_clean_worktree` (both
`session_id` and `--all_settled`), `onPrClosed` and `cancelSession`'s own release could cut the folder out from
under it, which `onPrClosed` reaches with no user asking. They ask `worktreeHasLiveClaim` now. It is not folded
into `restartClaimsWorktree`, because the reason is "this session is connecting", not "a restart owns this".

**And the microtask after the handshake.** `reattachOnce` registers the client as its last act, so a cancel
landing between that and the caller's continuation is invisible to the guard above: `startTurn` rewrote
`cancelled` to `running`, counted a completion for a turn that never ran, and re-registered the client the cancel
had disposed. `followUp` rechecks the status on the way to `startTurn` and refuses with its own code rather than
`BUSY` — nothing else started a turn. This one has no test: the window is a single microtask, and a test would
have to schedule itself into it, which means the test would define the race rather than observe it. The guard is
two lines; the alternative is a session that comes back from a cancel with a turn running and a completion
counted for it.

Getting that check into `followUp` nearly cost the guarantee round 3 was written for. `followUp` had crossed the
cognitive-complexity budget, so the reattach block moved into a helper — and the first version returned the
connection for the caller to start the turn on, which added an `await` between the shared reattach resolving and
`startTurn`. The winner's continuation slipped behind the loser's, both read a session that was not mid-turn, and
the shared-spawn test failed with two prompts. So the helper, `deliverFollowUp`, starts the turn itself: one call
from `followUp`, not a call and an await. Its docblock says so, because the next reader will want to tidy it back
into a function that returns a client.

Round 13 found the last wrong word: the skip inside `onPrClosed` still described every claim on a folder as a
restart, so a session whose ordinary follow-up was reconnecting it produced a warning telling the operator to wait
for a `delegate_restart` that would never come. `liveClaimText` names the claim — superseded, restart in flight,
follow-up reconnecting — and the test asserts the three wordings rather than only the skip. A correct decision
with a wrong explanation is the same defect rounds 11 and 12 were about, one layer down.

### §7.8 A cancel no status can express, and a container nobody validated (round 14)

Round 12 scoped the mid-reattach refusal by asking whether the record had *already* been cancelled, and that
question cannot be answered from `meta.status`. A conversation that arrives cancelled is one the caller may still
continue — that is what reattach exists for — and it answers `cancelled` to a fresh cancel too, so "cancelled
before" and "cancelled just now" are the same string. The caller heard "Cancelled, the slot is free" and watched
the turn start anyway: round 11's lie, surviving for exactly the sessions reattach serves. `rt.cancels` counts
cancels per id, and both guards compare the count across their own await. Two tests hold the line from opposite
sides — a conversation cancelled earlier is still continuable, a second cancel mid-reattach stops the prompt and
disposes the child — and reverting the guard to a status comparison reddens the first.

The same round moved the trust boundary to `state.json` itself. `normalizeMeta` validates the fields of a record
and `isStorageSafeId` guards ids from the wire, but the container's own values went straight into `path.join`: a
non-string in `sessionIds` threw `TypeError` partway through the session loop — queue already restored, every
later session unread, `persistState` and the drain skipped — and a `..`-bearing id read or appended outside the
tree this extension owns. `sessionDirs` keys *and* values are path segments too (the value is the pi session id a
record was written under), and `rt.sessions` is now keyed by `meta.sessionId` rather than by the list entry, so a
record and its key can no longer be two answers written forward on the next save. The first attempt at this fix
validated the recorded root with `absolutePathOr` — which would have dropped **every** legitimate entry, because
those values are ids and not absolute paths — and the failure mode would have been quiet: recovery simply not
finding records under a renamed pi session id.

Two smaller ones with the same shape. `persistMeta` deferred a debounced save by three seconds and resolved the
storage root *inside* the timer, so the write answered whatever home the process believed in by then; it resolves
when the save is scheduled now. And `spawnSession` no longer overwrites: an agent handing back an id already in
`rt.sessions` used to evict the record pi was tracking while that session's transport kept running — one
`meta.json`, one `events.jsonl`, and a live agent slot accounting no longer counts — so the second start is
refused and its child disposed.

Finally, the pin's own honesty. The two-stub recovery test restored neither stub, leaving `HOME` pointing at a
temp directory for every later test in the file and letting two runtimes write one `pi-test` namespace
last-writer-wins; it restores newest-first now. And the comment written in round 11 claimed interleaved
continuations resolved the real `~/.pi` — true before the pin, wrong after it, where a late write lands in
whatever sibling stub currently owns the process-global home. The comment says that instead.

### §7.9 The record reaches the process table and the worktree registry (round 15)

Two blockers, and both were the same mistake seen from further out. Rounds 12–14 validated the *paths* a
persisted record could name; round 15 found the two fields that do worse than read a file.

**A pid ends in `kill(-pid)`.** `normalizeMeta` passed `pid` through raw, the boot sweep kills whatever a
running record names, and `killProcessGroup` negates it to take the process group. `kill(0, 0)` and
`kill(-1, 0)` both *succeed* in Node, so `isPidAlive` called them alive; the recycle guard then reads
`/proc/0/cmdline`, cannot read it, and correctly declines to block a kill of something it cannot identify. A
`meta.json` with `"pid": -1, "status": "running"` therefore SIGTERMs every process the user can signal at boot,
repeats with SIGKILL 1.5 s later, and the same pair is reachable from `cancelSession` and `delegate_restart`.
`isKillablePid` now decides: a safe integer above 1, and never this process. Probing keeps the weaker rule —
`isPidAlive(own pid)` is a legitimate question — but nothing kills on a claim that fails it, and
`normalizeMeta` drops such a `pid` so the sweep never sees one.

**A stored worktree id is a deletion selector.** The safety check in `releaseWorktreeNow` is a statement about
one directory — its uncommitted and unpushed work — while orca deletes whatever selector it is handed, and the
selector preferred `meta.worktreeId`. A record pairing a clean path with a borrowed or planted id had the
borrowed worktree deleted past the check, and the queued-cancel removal ran no check at all. Both now select by
`path:` of the directory that was actually examined; a stored id that no longer resolves simply fails the
removal, which is the right shape of failure. `normalizeTask` also stopped passing the queued worktree fields
through raw — `worktreePath` is a spawn cwd, and a relative one used to be resolved against whichever folder pi
happened to run in.

**Recovery's own door.** Round 14 validated `sessionDirs` into the map and then read the raw container again one
function further down, which is the same value arriving at `path.join` by a second door: a non-string throws
mid-loop, and because recovery is floated the rejection is swallowed, `recoveryDone` resolves, and every tool
later in that boot runs on a half-restored state. `readMeta` now takes the validated map. The remaining
container scalars — `totalCompleted`, `maxRuns`, `maxRunsTotal` — were guarded like `totalInvoked` was not:
`"3"`, `true`, `1.5` all compare greater than zero, and `1e999` is `Infinity`, which quietly stops the total
ceiling binding at all.

**The rest.** A follow-up now refuses a workspace that is gone: `releaseWorktree` sets `worktreeStatus` and
deliberately leaves the path fields pointing at the folder, so a follow-up reading them prompted an agent into a
deleted cwd — or restored a conversation against a checkout orca had recreated for a later branch. The existence
probe only applies when the record itself claims the folder is live; a cwd nothing ever claimed still fails at
`spawn`, with the message that names the workspace. `startNow` carries the runtime's epoch, because
`drainQueue` floats it and `session_shutdown` cannot reach a floated call: a start that resolved after shutdown
used to register into a cleared runtime, persist under whatever pi session id answered next, and leave an agent
running for a session that no longer exists. Cancelling a *parked* agent (idle status, live client) no longer
charges a second completion — the marker is taken, not tested, so settle cannot also charge it. A provenance
cycle in `state.json` is not turned into two pointers that refuse each other forever. And the two comments about
`agy-acp`'s heartbeat said its state "exists in the engine" and is "the one a watchdog acts on": nothing reads
the parsed fields, `liveness.ts` decides from silence alone, and the comments now say that instead.

### §7.10 The shutdown window was wider than the check, and a refusal that was not an answer (round 17)

**A refusal has to be a tool result.** `cleanWorktreeRefusal` returns `{ message, code }`, and the single-session
path wrapped it in `errorResult` while the mid-sweep re-check added in round 15 returned it bare. Pi reads
`content ?? []` and leaves `isError` unset, so the caller of `delegate_clean_worktree` got an empty successful
answer — and because the return discarded `notes`, the folders the sweep had already released were unreported
too. Same shape on the neighbouring `SESSION_ACTIVE` refusal. Both now go through `errorResult`, and `withNotes`
appends what already happened, so "stopped at the third folder" cannot be read as "did nothing".

**The epoch check guarded one await of a five-await start.** Round 15 put it after `spawnSession` and at the top
of the drain loop, which is where the leaked agent is visible — but `spawnSession` registers, writes the
transcript path and persists on its way out, so a shutdown during the handshake had already written
`meta.json` plus a container entry into whatever namespace answers next (`shutdown()` resets the pi session id
to `default`; a later tool call that re-anchors would put the phantom in the *new* session's folder, where the
next boot reads it as state). `spawnSession` now takes a `stale` predicate and throws before any of that, which
also routes the failure through the not-registered cleanup. And the two configuration round trips — mode, then
selection — sat between the check and `startTurn`; a shutdown in there started a turn on a cleared runtime,
armed a stall watchdog for a session pi had forgotten, and announced a verdict into whichever session is current
now. One helper, `unregisterStart`, takes back all three registrations and stops the child at both exits.

**An abandoned start kept the folder.** The worktree is provisioned before the agent is asked for its id, and the
record naming it is written *after* the epoch exit, so a shut-down start left a `*-dtN` checkout and branch that
no record points at — invisible to `--all_settled`, which needs `worktreePath` and `active`. The failed-start
`catch` already removed it; the shut-down path does too now, and by `path:` like everywhere else (the last
id-preferring removal was this `catch`, safe only by the accident that a freshly provisioned id cannot have been
restored, and the comment in `recovery.ts` that said stored ids "reach `removeOrcaWorktree`" is corrected —
nothing selects by a stored id any more).

**A completion is taken, not inferred — including on exit.** Round 15 made `settle` and `cancelSession` take the
marker; `onExit` still counted on `status`, and `spawnSession` records `running` to hold the slot before any
prompt exists. A child that dies in that configuration window charged a turn that was never sent. `onExit` takes
the marker too now, which both kills the phantom count and clears the marker on that path.


## 8. Out of scope

* `backfill` for `agy` recovery (reading another program's private store during recovery), still refused
  by the epic's security rules — recovery reports `interrupted`.
* A `session/load`-based transcript replay for `agy` sessions (a caller wanting the history asks for
  `delegate_status`, not a second copy of it in the log).
* Making `session/list` reachable from the tools: it would answer "which of my sessions can I continue",
  which is a tool-design question of its own.
* The subagent view of `agy` sessions (agy-acp #59 attributes them; the delegate renders one opaque tool
  call).
