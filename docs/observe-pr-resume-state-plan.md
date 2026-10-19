# Plan: `observe-pr` — persist observer state across session resume

Scope: `extensions/observe-pr.ts` (+ tests). Fix for: on resume/reopen of a session that already has a PR under observation, the extension re-detects the PR as *new*, re-observes it, and appends the "The PR 5046 recently created is now being observed…" notice to the user's first message. It also re-observes PRs the agent explicitly **stopped** observing.

## Root cause

All observer state is process-memory only and is wiped on process exit (and explicitly on `session_shutdown`):

- `observedPRs`, `autoDetectedPRs`, `trackedBranchesByRepo`, `branchToPR` (`observe-pr.ts:136-139`); `cleanupAll()` (`:629`) deliberately clears the bookkeeping — "a new session re-detects from scratch".
- Per-PR dedup state (`seenRuns`, `knownComments`, `failedRuns`, `completedRuns`, `allPassedReported`, `:34-49`) dies with the process along with the `gh run watch` / `gh pr checks` child processes.

On resume, `session_start` (`:769`) re-runs `checkTrackedBranches(cwd, true)`. With `observedPRs` and `autoDetectedPRs` empty, any open non-draft PR on a tracked branch passes the guard at `:717-720` and is treated as newly auto-detected: `startObserving()` + deferred announcement (`:722-760`). The deferred path (`input` transform at `:778`) then appends the tracking notice to the first idle plain user message of the resumed session — even though the agent already received that notice earlier in the same (persisted) session.

Consequences, all reproducible:

1. **Duplicate notice** on resume (the reported bug).
2. **Stopped PRs re-observed**: `stopObserving()` records the PR in `autoDetectedPRs` (`:600`) so it is skipped for the rest of the *process* lifetime, but after a restart the set is empty and the branch check re-observes + re-announces.
3. **Related, fixed by the same mechanism**: observation is silently lost on restart — in-flight runs are never reported (the `gh run watch` processes died), and once re-detected, `seenRuns`/`knownComments`/`failedRuns`/`completedRuns`/`allPassedReported` are empty, so existing comments are re-announced as "added or updated" (`:466-475`) and finished runs can be re-notified (e.g. "All CI passed", or a stale failure) after `watchRun` re-watches them (`:307-397`).

## Mechanism: pi's built-in session state persistence

Pi's session file supports `CustomEntry` — "Persist extension state across session reloads. On reload, extensions can scan entries for their customType and reconstruct internal state. Does NOT participate in LLM context." The API surface (verified in `dist/core/extensions/types.d.ts` and `agent-session.js`):

- **Write**: `pi.appendEntry(customType, data)` → `sessionManager.appendCustomEntry()` — appends as a child of the current leaf. Safe before the session file exists: entries are kept in memory until the first user/assistant message, then flushed with the file (`session-manager.js` `_persist`).
- **Read**: `ctx.sessionManager.getBranch()` in the `session_start` handler (the event carries `reason: "startup" | "reload" | "new" | "resume" | "fork"`) — walks root→leaf, so it is branch-aware (abandoned branches are alternative histories and are excluded). This is exactly the pattern pi's docs recommend: "Durable data excluded from model context → `pi.appendEntry()`"; "Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`."

Because entries live in the session file, state is automatically per-session: a resumed session restores its own state; a fresh session (empty file) re-detects from scratch; a fork restores the state up to the fork point — all matching what the agent's visible history in that session implies.

## Design

### Persisted state

```ts
const STATE_TYPE = "pi_observe_pr_state";

interface PersistedObservedPR {
  prNumber: number;
  cwd: string;
  activeRuns: string[];     // re-watched on restore (in-flight runs survive restart)
  seenRuns: string[];       // prevents re-announcing known runs
  failedRuns: string[];     // prevents re-notifying old failures
  completedRuns: string[];
  knownComments: Array<Pick<CommentInfo, "id" | "number" | "updatedAt">>; // body omitted (size); updatedAt-based edit detection still works (pollPR :469 tolerates missing body)
  allPassedReported: boolean;
  announced: boolean;       // the agent has already been told this PR is observed
}

interface PersistedObserverState {
  v: 1;
  observed: PersistedObservedPR[];
  stopped: number[];        // PRs explicitly stopped (or auto-stopped: merged/closed) — never auto-re-observed
}
```

`announced` covers every way the agent could already know:
- deferred notice attached to a turn that actually started (delivered on `agent_start` while `noticeAttached`),
- mid-session delayed-timer notice fired,
- the agent started observation itself via `observe_pr` (the tool result *is* the notification),
- the agent's `observe_pr` call cancelled a pending auto-detection notice (tool result informs it).

`announced === false` on restore ⇒ the agent never saw the notice ⇒ it is deferred onto the first plain idle user message, exactly like today's startup path.

### Changes in `extensions/observe-pr.ts`

1. **Replace `autoDetectedPRs` with `stoppedPRs = new Set<number>()`** (persisted). `observedPRs` already covers "auto-detected and observed". Update the guards in `checkTrackedBranches` (`:700`, `:717-720`) to `observedPRs.has(pr) || stoppedPRs.has(pr)`.

2. **`persistState()`** — serializes the full current state (last entry wins on restore) and calls `pi.appendEntry(STATE_TYPE, state)` inside try/catch (read-only session / missing API ⇒ log and degrade to today's in-process behavior). Called from the real change points:
   - `startObserving()` — except when called as part of a restore (flag); set `pr.announced = true` first for explicit tool starts.
   - `stopObserving()` — after `stoppedPRs.add(prNumber)`.
   - notice delivery points (below).
   - explicit `observe_pr` start on a PR in `stoppedPRs` ⇒ `stoppedPRs.delete(prNumber)` + persist (explicit action overrides a prior stop).

3. **`restoreState(ctx)` in the `session_start` handler, before `startupCheck = checkTrackedBranches(...)`** (synchronous, so the branch check sees restored state):
   - hard-reset in-memory state *without persisting*: kill all timers/processes (extract from `stopObserving`/`cleanupAll` into a `resetObserverState()` used by both restore and `session_shutdown`), clear `stoppedPRs`, `trackedBranchesByRepo`, `branchToPR`, `deferredAnnouncements`, reset the notice flags.
   - read the **latest** `pi_observe_pr_state` entry from `ctx.sessionManager?.getBranch?.()` (guarded — test mocks don't have it); validate `v === 1` / shape, otherwise ignore.
   - for each `stopped` PR: `stoppedPRs.add(n)`.
   - for each `observed` PR: rebuild the `ObservedPR` (sets from arrays; `knownComments` without body), re-spawn the `gh pr checks` process (extract `startChecksProcess` from `startObserving` so restore can reuse it without a second persist), restart the poll `setInterval`, and `watchRun()` every `activeRuns` entry so in-flight runs complete and get reported after restart.
   - for each observed PR with `!announced`: `deferredAnnouncements.set(...)` + `suppressUpdates = true` — the existing `input`/`agent_start` machinery delivers it once and releases suppression.
   - `updateStatusUI()` so the restored observation shows in status/dashboard.

4. **Mark + persist `announced` at the delivery points:**
   - `agent_start` while `noticeAttached` (`:811-819`): before `deferredAnnouncements.clear()`, set `announced = true` on each deferred PR, then `persistState()`.
   - delayed-timer path (`:736-748`): after `announceTracking(prNumber)`, if the PR is still observed, set `announced = true` + persist.
   - `observe_pr` tool: explicit start ⇒ `announced = true` (persists via `startObserving`); pending-notice cancellation path (`:897-911`) ⇒ `announced = true` + persist.

5. **`watchRun` close handler dedup guard** (`:344`): if `currentPr.failedRuns.has(runId)` / `completedRuns.has(runId)`, only update bookkeeping/UI — skip the agent notification. Prevents double-notifications when a restored or re-discovered run is re-watched (and any other re-encounter).

6. **`session_shutdown`** (`:866`): use the non-persisting `resetObserverState()` instead of `cleanupAll()`'s per-PR `stopObserving` — the state was already persisted at the moment of the last change; shutdown must not append a redundant (or misleading) entry to the dying session.

7. Keep `globalThis.__PI_OBSERVED_PRS__` populated with restored PRs so cross-extension integrations (`pr-tasks` reconciliation, devin `__PI_ON_PR_CLOSED_DEVIN__`) keep working across restart.

### Behavior matrix after the fix

| Situation | Before | After |
|---|---|---|
| Resume session, PR observed + agent was told | re-observe, notice re-appended to first message | observation resumed silently (runners re-spawned), no notice |
| Resume session, PR observed, notice never delivered (pending at close) | lost; re-detect + re-notice (accidentally OK, but state/dedup lost) | observation resumed; notice delivered once on first plain idle message, then persisted as `announced` |
| Resume session, PR stopped by agent (`observe_pr` ×2 / `/pr_observer stop` / merged/closed) | auto re-observe + re-notice | stays stopped; no notice |
| Agent re-observes a stopped PR explicitly via tool | works in-process; lost after restart | works; `stopped` entry removed, persisted |
| Fresh session (same repo/branch) | re-detect + notice (by design) | unchanged — empty file ⇒ empty restore |
| Fork before observation started / after it | n/a (no persistence) | restore matches forked history (none / with state) |
| Restart while runs in flight | runs silently lost; re-detection re-announces finished runs/comments | active runs re-watched; `seenRuns`/`knownComments`/`failedRuns`/`completedRuns`/`allPassedReported` prevent duplicate notifications |

Optional polish: the notice text says "recently created" which is inaccurate for restored pending notices — reword to "The PR {n} is now being observed…" (only affects the rare pending-at-close case).

## Tests

Existing harness pattern: mock `ExtensionAPI`, fake `gh` on `PATH`, drive handlers directly (`test/test-startup-notice.ts`, `test/test-branch-observer.ts`).

1. **Update `test-startup-notice.ts`**: add `appendEntry() {}` to the mock pi and `sessionManager: { getBranch: () => [] }` to `ctx` (empty history ⇒ today's startup behavior must be byte-identical — this test doubles as the regression check for the no-prior-state path). Same for `test-branch-observer.ts` if its mock touches `session_start`.
2. **New `test/test-observe-pr-resume.ts`** (mock `gh` as in the existing tests):
   - **R1 — no duplicate notice on resume**: `getBranch()` returns a state entry `{ observed: [PR 7, announced: true, knownComments: [c1], completedRuns: [r1]], stopped: [] }`. `session_start` → first plain user message ⇒ `input` returns `continue` (no transform/notice); no "Comment 1 added" message for the restored comment; no re-notification of finished run r1; PR 7 re-registered (checks process spawned, poll timer running); restore appends no new state entry.
   - **R2 — stopped PR stays stopped**: state `{ stopped: [8] }`, mock `gh` reports open PR 8 for the branch ⇒ not observed, no notice on first message.
   - **R3 — pending notice survives resume exactly once**: state `{ observed: [PR 9, announced: false] }` ⇒ first plain message carries the notice (`transform`), `agent_start` persists `announced: true`; a second `session_start` with the latest entry ⇒ `continue` (delivered once across resumes).
   - **R4 — persistence points**: explicit `observe_pr` start ⇒ entry with `announced: true`; second call ⇒ entry with PR in `stopped`; merged/closed auto-stop ⇒ entry in `stopped`.
   - **R5 — dedup guard**: a run already in `failedRuns` re-closing via `watchRun` sends no second failure message.
3. Manual E2E: real repo + PR, observe via tool, exit pi, reopen the session (`--resume`), type a message ⇒ no appended notice, CI updates still arrive; stop observing, restart ⇒ no auto re-observation.

## Verification checklist (no test tooling in repo — run the harness scripts)

- `npx pi -ne -e test/test-startup-notice.ts --offline -p "test"` (and the new resume test) pass.
- `test-observe-pr.sh` / `test-branch-observer` still pass (mocks updated).
- Grep-level sanity: every `appendEntry` call site is reachable only from real state changes; `resetObserverState` never persists.

## Open questions

- **Cross-session stop memory** (intentionally out of scope): a *new* session in the same repo/branch still re-observes a PR the agent stopped in a *different* session — current design intent (`cleanupAll` comment: re-detection on session switch is desired). If that should also persist, the state entry would need a non-session store keyed by repo/branch (external file), a bigger behavior change.
- **Compaction** does not remove custom entries from the file, and `getBranch()` is entry-level (not context-aware), so the restore read is unaffected by compaction. No action needed.
- If `pi.appendEntry` throws (read-only/older pi), the extension degrades to today's behavior — log once, don't spam.

## Post-review fixes (Devin review round 1, PR #32)

The first review round found 8 findings; all were fixed:

1. **Dedup-set mutations were never persisted** (major). `persistState()` ran only at start/stop/notice-delivery, so a run that finished (or a new comment, or an "All CI passed") after the last persist point left a stale snapshot: on resume the finished run was re-discovered and re-notified. Fix: persist at every notification-producing mutation — `watchRun` close (failure and completion branches, when the run was newly reported), `pollPR` when comments change, and `checkAllCIPassed` when `allPassedReported` flips. Run *discovery* (`seenRuns`/`activeRuns`) stays unpersisted on purpose: runs are re-discovered automatically via the checks process/rollup, and re-watching is safe thanks to the dedup guards.
2. **Killed-then-replaced watchers corrupted the live entry** (minor, plus a sibling bug the review missed). `resetObserverState` SIGTERMs the checks/run processes; when their `close` events fire after `restoreState` re-registered the same PR, the stale handlers passed the `observedPRs.has()` check and scheduled a second checks lineage (never collected — a per-resume process leak) — and a stale `watchRun` close would have misclassified a still-running replacement as *failed* (SIGTERM exit code → failure heuristic). Fix: identity guards in both close handlers (`current.checksProcess !== checksProc` / `runProcesses.get(runId) !== child` → return).
3. **`__PI_OBSERVED_PRS__` not re-exposed** (minor): `session_shutdown` deletes it, so cross-extension readers (pr-tasks) saw `[]` after an in-process session switch. Fix: re-assign it in `session_start`.
4. **`observe_pr` cancel path missed deferred notices** (minor): a PR whose notice sat in `deferredAnnouncements` (startup-suppressed or restored-`!announced`) fell through to the stop branch — "Stoping observing" for a PR the agent never learned about. Fix: the cancel branch now covers `deferredAnnouncements` too (cancel, release suppression per the existing bookkeeping, mark announced, persist, return the start message).
5. **`agent_start` marked PRs that never received the notice** (minor): a notice deferred in *after* the input transform was marked `announced` anyway, permanently losing it across restarts. Fix: the input handler snapshots `noticeAttachedFor`; `agent_start` marks only the snapshot.
6. **Restore entry guards** (nit): reject `prNumber <= 0`/`NaN`, skip PRs in `stoppedPRs` (stopped wins on conflict) and duplicates (avoids orphaned timers).
7. **In-flight branch check outliving a session switch** (nit, pre-existing race, escalated by persistence): it could `startObserving` + persist into the *new* session's file, and its `finally` could clear the re-entry guard out from under the new session's startup check. Fix: `stateGeneration` counter bumped in `resetObserverState`; the check validates the generation after each await and only the current generation's check resets `isCheckingBranches` (also reset directly).
8. **Test gaps** (minor/nit): R5 now exercises the *real* resume path — a realistic stale snapshot (failure recorded in `failedRuns`, run re-discoverable) re-discovered via a `statusCheckRollup` entry in the fake `gh`, then the dedup guard verified; R1 additionally asserts the poll timer and checks process were re-spawned. `appendEntry` failures now log once instead of per change (plan item).

`cleanupAll` and the unused `startObserving({ fromRestore })` option were removed as dead code after the rewrite.
