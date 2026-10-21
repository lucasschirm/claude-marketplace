# Plan: Make Pi boot-time work non-blocking (TUI must stay responsive; results land after the run)

Reported symptom: starting `pi` with this package installed feels frozen — something runs a *blocking*
request during initialization. Investigation confirms it: the package's extensions put network/subprocess
work **on Pi's awaited startup and turn boundaries**, so `pi` cannot finish booting (first paint of the
restored conversation, provider count, first `renderNow()`) until `gh` / `orca` / `git` subprocesses come
back — and does the same on every message submit, every `turn_end` and every settle attempt.

Expected behavior (the requirement this plan encodes):

> Any boot-time code must not block the TUI or any process. It may run, and may only change the TUI /
> affect state **after** its run completes.

---

## 1. How Pi schedules extension code (why this matters)

Verified in `@earendil-works/pi-coding-agent/dist`:

| Pi behavior | Source | Consequence for our extensions |
|---|---|---|
| `await factory(api)` — an extension factory is awaited **before the TUI is even created** | `core/extensions/loader.js:514` | subprocess/sync work at factory or module scope delays process startup for *every* invocation (`pi -p`, `--list-models`, SDK hosts) |
| `await this.rebindCurrentSession()` — emits `session_start` — runs after `ui.start()` but **before** `renderInitialMessages()`, `updateAvailableProviderCount()` and `ui.renderNow()` | `modes/interactive/interactive-mode.js:787` (init order), `ui.start()` at `:706` | an awaited `session_start` handler delays the first real frame and the initial transcript |
| `async emit(event)` **awaits every handler, sequentially, in extension load order** | `core/extensions/runner.js:813` | the startup cost of all extensions **sums**; one slow handler delays all later ones |
| `emitInput()` awaits `input` handlers before the prompt runs | `core/extensions/runner.js:1201`, called from `core/agent-session.js:1565` | a slow `input` handler = the user's message appears to hang on Enter |
| `agent_before_settle` is an awaited boundary | `core/agent-session.js:1543` | network inside it = the agent cannot finish its turn |
| Docs: "Pi waits for an asynchronous factory before startup continues… Do not start processes, sockets, watchers, or timers in the factory… Start long-lived resources from `session_start`" | `docs/extensions.md` (§ Respect the runtime lifecycle) | `session_start` is the right *place* to start work — it must not be the place to *await* it |
| A synchronous syscall freezes the single-threaded loop (no render, no keystroke echo) | Node event loop | `execFileSync` / `spawnSync` / `Atomics.wait` / sync `fs.*` are TUI freezes, however short |

---

## 2. Measurements

Method A — per-handler cost. Mock-`pi` harness loads the real extensions in package order, runs their
`session_start` → first `input` → `turn_end` handlers exactly the way Pi does, and measures both the
**awaited** time and the **worst synchronous event-loop freeze** (2 ms lag sampler). `child_process` and
`fs` sync APIs are wrapped to log any blocking call. A fake `gh` on `PATH` sleeps 700 ms per call and
reports PR #123 with 2 unresolved review threads (realistic per-call latency, run in this repo):

| stage | observe-pr | devin-delegate | orca-orchestration | pr-tasks | tools | **total (awaited)** |
|---|---|---|---|---|---|---|
| factory (module load) | 7 ms | 0 | 0 | 0 | 0 | **7 ms** |
| `session_start` | 3 ms | 1 ms | 219 ms | **2 413 ms** | 0 | **2 636 ms** |
| `turn_end` | **2 418 ms** | – | 152 ms | 809 ms | – | **3 379 ms** |

* `session_start` with no `gh` reachable at all (this container, unauthenticated `gh`): 730 ms total.
* observe-pr alone with a slower branch check (`gh` 1.2 s / 3.0 s), first message submitted right after
  startup: the `input` handler stalls **143 ms / 1 910 ms** — and is hard-capped at
  `STARTUP_CHECK_WAIT_MS = 5000 ms` (`extensions/observe-pr.ts:170`, used at `:964-971`), so with several
  tracked branches (a serial `for … await gh pr view` loop) the **user's first message stalls the full 5 s**.
* Synchronous freeze: ≤ 5 ms in this container, because `execFileSync("which", …)` costs ~2 ms *here*. On a
  cold PATH, a slow NFS/overlay volume, or a Windows `where` probe it is an unbounded freeze — see B5/B6/B7.

Re-run after PR #33 merged (`main` @ `4097f53`, i.e. against the code anchored above): `session_start` total
**2 721 ms** (pr-tasks 2 434, orca 283), `turn_end` total **3 322 ms** (observe-pr 2 406, pr-tasks 803,
orca 113), worst sync freeze 5 ms — and the first-message stall is still there (observe-pr `input`: 142 ms at
`gh` 1.2 s, **1 906 ms** at `gh` 3.0 s, cap 5 s).

Method B — end-to-end wall clock, real `pi -p "say ok"` (model ≈ 1.5–2 s), best of 2 runs, fake `gh` @700 ms:

| configuration | no PR on branch | PR, threads resolved | PR, 2 unresolved threads |
|---|---|---|---|
| baseline (`pi -ne`, no extensions) | 1.68 – 2.13 s | 1.43 – 2.04 s | 1.98 – 2.50 s |
| all five extensions of this package | 4.20 – 5.88 s | 7.38 – 7.52 s | **8.38 – 11.39 s** |

Related hazard observed while attributing: with `pr-tasks` loaded against a PR whose threads never resolve,
`agent_before_settle` re-syncs and re-nudges on every settle attempt — the run did not finish inside 120 s.
Not the boot bug itself, but proof that network latency sits *inside* the settle loop (B4).

Worst-case bounds by reading the code: `FETCH_TIMEOUT_MS = 60_000` per `gh` call
(`extensions/lib/github-review-threads.ts:10`), `GH_TIMEOUT_MS = 60_000` (`extensions/observe-pr.ts:11`),
`execOrca` default `timeoutMs = 30_000` (`extensions/lib/orca-client.ts:176`) — and the calls are **serial per
PR/branch**, so a black-holed network turns `session_start` into minutes, not seconds. `session_start` re-runs
on `/new`, `/resume`, `/fork`, `/reload`, so the cost is paid again on every session switch.

---

## 3. Findings

| # | Problem | Where | Effect |
|---|---|---|---|
| **B1** | `session_start` awaits a full GitHub review-thread sync (detect PR → repo coordinates → paginated GraphQL), serially per PR | `extensions/pr-tasks.ts:768-774` → `syncAllPRs` (`:723`) → `syncPR`/`syncPROrThrow` (`:237-280`) | **2.4 s measured** of blocked startup; minutes on a hung network. Delays first frame + initial transcript (`interactive-mode.js:787`) |
| **B2** | The `input` handler waits for the boot-time branch check (`Promise.race` with a 5 s cap) | `extensions/observe-pr.ts:1265-1304` (`Promise.race` at `:1278-1288`), `STARTUP_CHECK_WAIT_MS` `:224`, `startupCheck` set at `:1261` | The user's **first message** hangs on Enter up to 5 s; message echo and the run start are both delayed |
| **B3** | `turn_end` handlers await all polling/syncing | `extensions/observe-pr.ts:1395-1400` (`pollAllObservedPRs` + `checkTrackedBranches`), `extensions/pr-tasks.ts:776-781`, `extensions/orca-orchestration.ts:664-668` | **3.4 s measured** where Pi is still busy after every turn (status/next prompt blocked); scales with observed PR count |
| **B4** | `agent_before_settle` performs a network sync before deciding whether the agent may settle | `extensions/pr-tasks.ts:784-790` | Network latency and GitHub outages are inside the settle boundary (up to 60 s × PRs) |
| **B5** | `session_start` awaits two Orca CLI round-trips; `resolveOrcaCmd()` runs `execFileSync("which", ["orca-ide"])` on **every** `execOrca`/`spawnOrcaCheck` call | `extensions/orca-orchestration.ts:654-662` (`discoverActiveRun`, `reconcileWorkers`), `extensions/lib/orca-client.ts:142-160`, `:176` | ~0.2 s awaited per boot (30 s CLI timeout worst case) + a synchronous loop freeze on every Orca call, incl. the 30 s reconcile timer |
| **B6** | Boot-time state recovery uses synchronous fs with a **blocking** retry (`Atomics.wait` 150 ms) and sync writes; `persistState()` (`writeFileSync` + `renameSync`) runs on every state change, including during streaming | `extensions/devin-delegate.ts:1601-1606` → `recoverState` (`:1483`), `readFileSyncWithRetry` (`:660`), `sleepSync` (`:652-658`), `persistState` (`:889-908`), `persistSessionMeta` (`:913-925`) | 150 ms hard freeze per missing/flatlining meta file at boot (multiplied by recovered sessions) and repeated freezes during streaming; also blocks startup while `session_start` reads state |
| **B7** | `isCommandAvailable()` (`execFileSync("which")`) runs at **factory/module load**, before the TUI exists, to decide whether to register `requestdb`/`destroydb` | `extensions/observe-pr.ts:1690`, `:1727`, helper `:13-19`; `extensions/devin-delegate.ts:564-573` (used at `:1118`, `:1179`) | 2 subprocess spawns on the load path of every `pi` run (also `pi install`, `--list-models`, SDK hosts) |
| **B8** | Serial fan-out and no overall budget: `syncAllPRs` (`for … await syncPR`), `pollAllObservedPRs` (`for … await pollPR`), branch loop in `checkTrackedBranches`; timeouts are per-call (30–60 s), never per refresh | `extensions/pr-tasks.ts:737`, `extensions/observe-pr.ts:1338-1342`, `checkTrackedBranches` `:1117-1240` | Latency multiplies with PR/branch count; a single hung call dominates the whole boundary |
| **B9** | No budget/lint keeping this from regressing: nothing measures or fails when a critical-path handler starts awaiting I/O | all extensions | Every new feature naturally "just awaits" — this is how B1–B4 arrived |

Root causes: **RC1** awaited I/O on Pi's critical paths (`factory`, `session_start`, `input`,
`agent_before_settle`, `turn_end`); **RC2** synchronous syscalls (`execFileSync`, `Atomics.wait`, sync `fs`)
inside a live event loop; **RC3** no shared "run it in the background, apply it when it lands" plumbing, so
each extension re-implements refresh inline; **RC4** no budgets on fan-out and no regression guard.

Explicitly **not** in scope (already background-safe): the long-lived watchers (`gh run watch`,
`gh pr checks --watch`, `orca orchestration check --wait`) are `spawn`ed, and the announce/steer machinery
that delivers their results later. `tools.ts` only reads in-memory state on `session_start`.

---

## 4. Fix plan

Phased; each phase ships and is testable on its own. Target invariant, enforced by the Phase 6 guard test:

| Budget | Value |
|---|---|
| factory / module load | < 15 ms total, **0 subprocesses**, 0 blocking syscalls |
| `session_start` (each extension) | returns in **< 10 ms** — 0 awaited I/O |
| `input`, `before_agent_start`, `agent_before_settle` | **< 5 ms** — 0 network, 0 subprocess |
| `turn_end` | **< 20 ms** — schedule, never await |
| any single synchronous freeze | **< 20 ms** — no `execFileSync`/`spawnSync`/`Atomics.wait`/sync `fs` in live paths |
| end-to-end `pi -p` vs. no-extension baseline (fake `gh` @700 ms) | **≤ baseline + 1 000 ms** (today: +2 s to +9 s) |

### Phase 1 — Shared non-blocking plumbing (`extensions/lib/nonblocking.ts`, new)

One small module used by all five extensions (same module cache across extensions, so state is shared):

```ts
/** Fire-and-forget with guaranteed error capture, abort on shutdown, and a test flush hook. */
export function runDetached(name: string, fn: (signal: AbortSignal) => Promise<void>,
                            opts?: { onError?: (e: unknown) => void }): void;
export function abortDetached(): void;              // from session_shutdown
export function flushDetached(timeoutMs: number): Promise<boolean>;   // tests only

/** Single-flight refresh with coalescing: concurrent callers share one run; a request that arrives
 *  while running schedules exactly one follow-up (so nothing is lost by not awaiting). */
export function refresh(key: string, fn: (signal: AbortSignal) => Promise<void>): Promise<void>;

/** Async PATH probe — replaces every `execFileSync(which …)`. Result memoized; probe is single-flight. */
export function whichAsync(cmd: string): Promise<boolean>;

/** Async, serialized, atomic writes — replaces sync writeFileSync+renameSync on hot paths. */
export class WriteQueue { write(file: string, data: string): Promise<void>; drain(): Promise<void>; }

/** Wrap a lifecycle handler: measures awaited time and reports violations (dev/CI only). */
export function critical<E extends EventName>(pi: ExtensionAPI, event: E,
        handler: Handler<E>, budgetMs: number): void;
```

Semantics of `runDetached`/`refresh`: never throws into Pi, never `await`s at the call site, errors go to the
extension's existing TUI-safe logger (`observe-pr.ts:logInternal`, `devin-delegate`'s `logError`, etc. — never
raw `console.error`, per §4.2 of `docs/devin-delegate-reliability-plan.md`), and everything is aborted by the
per-session `AbortController` on `session_shutdown`.

### Phase 2 — Strip awaiting I/O off `session_start` (B1, B5, B6)

* `pr-tasks.ts:768` — store `ctx`, paint an optimistic status (`"PR Tasks: syncing…"`), then
  `runDetached("pr-tasks:boot-sync", signal => syncAllPRs(lastCwd, undefined, { signal, budgetMs: BOOT_BUDGET_MS }))`;
  `updateStatusUI` runs when it lands. Tool paths keep awaiting (`findTaskSyncing`, `:699-705`) — that is the
  correct place to wait, because the agent asked for data.
* `orca-orchestration.ts:654` — same shape for `discoverActiveRun` + `reconcileWorkers`; `startReconcileTimer()`
  is started immediately (the timer tolerates `activeRunId` being filled in later — the status widget and
  `startCheckProcess()` are already re-entrant).
* `devin-delegate.ts:1601` — `recoverState` becomes `async` (`fs.promises`, `WriteQueue`), is `runDetached`, and
  updates status/queue when recovery completes. Anything that needs the recovered state (a `devin_status`/
  `devin_delegate` call that races boot) awaits `refresh("devin:recover", …)` once — bounded, agent-initiated.
* `observe-pr.ts:1250` — already non-blocking; keep, and make `startBranchPollTimer()`'s first tick immediate
  instead of relying on `startupCheck`.
* Add `BOOT_BUDGET_MS` (default 5 000, env `PI_EXT_BOOT_BUDGET_MS`) as a *per-refresh* deadline via
  `AbortSignal`, so a boot refresh can never chain 60 s timeouts. Refreshes that get cut short are simply
  retried by the existing timers / `ghHealth` pacing.

### Phase 3 — Don't block the user's first message (B2)

* Delete the `Promise.race` on `startupCheck` in `observe-pr.ts:1278-1288`; `input` returns `{ action: "continue" }`
  immediately.
* Reuse the existing deferred-announcement path (`deferredAnnouncements`, `pendingAnnouncements`,
  `announceTracking`, `suppressUpdates`, `noticeAttached`) so the "now observing PR #N" notice rides the **next**
  message or is delivered with `pi.sendUserMessage(..., { deliverAs: "steer" })` once the check lands. Net effect:
  the notice appears when known — exactly the required behavior — instead of the Enter key waiting for it.
* Keep the `agent_start` bookkeeping that suppresses updates until the first real turn starts.

### Phase 4 — Take I/O out of `turn_end` and the settle boundary (B3, B4)

* All three `turn_end` handlers (`observe-pr.ts:1395`, `pr-tasks.ts:776`, `orca-orchestration.ts:664`) become
  `runDetached` + `refresh(key, …)` — same cadence, no awaited time. State changes are applied when the work
  finishes (status line, `pi.sendUserMessage` steer notices) rather than before Pi reports idle.
* `pr-tasks.ts:784` (`agent_before_settle`): decide from **cached** task state and kick a background refresh.
  Preserve the enforcement contract:
  * unresolved/blocked tasks in cache still produce the nudge (existing `lastSettleNudgeTime` /
    `lastNudgeSignature` / `identicalNudgeCount` caps unchanged);
  * if the cache is empty (nothing fetched yet — first turn of a fresh boot), allow settle and let the boot
    refresh's completion deliver the notice, instead of fetching inside the boundary;
  * a refresh that discovers newly-opened tasks after settle surfaces on the next turn (already the behavior for
    tasks discovered mid-session).
* Fan-out becomes bounded: `Promise.allSettled` with a small concurrency cap (2) in `syncAllPRs`,
  `pollAllObservedPRs` and `checkTrackedBranches`, each child honoring the refresh `AbortSignal` (B8).

### Phase 5 — Remove synchronous syscalls from live paths (B5, B6, B7)

* `extensions/lib/orca-client.ts:142-160` — `resolveOrcaCmd()` → memoized `ensureOrcaCmd()` (single-flight,
  `whichAsync`); `execOrca`/`spawnOrcaCheck` `await` it (both are already async). Deletes one `execFileSync` per
  Orca call per 30 s timer.
* `observe-pr.ts:1690/:1727` — the factory becomes `async` and awaits `whichAsync("requestdb")` /
  `whichAsync("destroydb")`: Pi awaits the factory, registration order is unchanged, and no subprocess runs
  before the TUI exists.
* `devin-delegate.ts:564-573` `isCommandAvailable` → async `whichAsync` (its `binaryAvailableCache` stays).
* `devin-delegate.ts:652-666` — delete `sleepSync`/`Atomics.wait`. `readFileSyncWithRetry` becomes async with a
  `setTimeout`-based retry (the ENOENT flapping it guards against is a shared-volume artifact, not a reason to
  freeze the loop). `persistState`/`persistSessionMeta` go through `WriteQueue` (async, serialized, atomic
  tmp+rename retained), drained in `session_shutdown` — which Pi awaits, so the last write is still durable.

### Phase 6 — Guard against regression (B9)

* `test/test-boot-nonblocking.ts` (mock-`pi` harness, same shape as `test/test-startup-notice.ts`): loads the
  real extensions in package order, patches `child_process.execFileSync`/`spawnSync`, `fs` sync APIs and
  `Atomics.wait` to **fail the test** if called after load, samples event-loop lag, then runs
  `session_start` → `input` → `turn_end` → `agent_before_settle` against a fake `gh`/`orca` (`PATH` stub sleeping
  300–700 ms, PR with threads) and asserts the budget table above.
* Same test asserts the *functional* half of the requirement: after `flushDetached()`, the PR-tasks status line
  is set, the observe-pr tracking notice is delivered, and `orca` worker state is reflected — i.e. background
  work still lands, just after the boundary.
* `test/test-boot-nonblocking.sh` (mirrors `test/test-observe-pr.sh`): `pi --list-models` load check +
  `pi -ne -e test/test-boot-nonblocking.ts --offline -p "test"`.
* Optional manual check (documented in the test header):
  `PI_TIMING=1 pi -p "hi"` with and without `-ne` — extension factories stay ~0 ms and the wall-clock delta
  drops under the budget.

---

## 5. Risks and invariants to preserve

* **Task enforcement** (`agent_before_settle` nudging) must keep working — Phase 4 changes the data source
  (cache), not the rule; keep the existing nudge caps and mark tasks STALE only after a real fetch.
* **Notice delivery ordering** — observe-pr already models "attach to next plain message vs. steer"; reuse it, do
  not invent a second path.
* **Durability** — state writes move from sync to queued-async; `session_shutdown` must `await drain()`, and the
  existing atomic tmp+rename must stay (crash-safe).
* **Session switching** — `/new`, `/resume`, `/fork`, `/reload` re-emit `session_start`: every detached task must
  take the per-session `AbortSignal` and every guard keyed on `globalThis` must keep being released in
  `session_shutdown` (see `docs/memory-leak-review.md`).
* **Coordination with PR #33** — *merged* into `main` at `4097f53`, so **branch this work from `main`** and note
  that `observe-pr.ts` grew (~460 lines) with the failure-handling + resume-state work: every
  `extensions/observe-pr.ts` anchor above is against `main` @ `4097f53`.
  `lib/gh-health.ts` landed and `GhHealth.acquireSlot()` gates `checkTrackedBranches`/`syncPROrThrow`
  (`pr-tasks.ts:241`, `observe-pr.ts:1120`), with syncs skipped while degraded (`pr-tasks.ts:219`). That bounds
  *outage* stalls (no serial 60 s waits when GitHub is unreachable) but changes **nothing** on the healthy path
  measured here: `session_start`/`turn_end`/`agent_before_settle` still await the full round-trip. Keep this work
  in *new* `lib/nonblocking.ts` plus handler bodies only. Division of responsibility: `ghHealth` decides *when*
  GitHub is contacted; `nonblocking.ts` decides *where* the wait happens — never on a Pi critical path.

## 6. Suggested PR split

1. `lib/nonblocking.ts` + `test/test-boot-nonblocking.{ts,sh}` (red: budgets violated) — no behavior change.
2. `pr-tasks.ts` (B1, B3, B4, B8) — the dominant win (~2.4 s boot, 3.4 s per turn).
3. `observe-pr.ts` (B2, B3, B7, B8).
4. `orca-orchestration.ts` + `lib/orca-client.ts` (B5).
5. `devin-delegate.ts` (B6) — largest blast radius (state durability), ship last.
6. Flip the guard test to green-only expectations and record before/after numbers in this document.

## 7. Implementation results (as shipped)

Landed in one PR rather than the six in §6: the phases share `lib/nonblocking.ts` and each handler
change is small once the scope exists, so splitting them would only have created rebase work.
Re-measured with the harness from §2 (`pi -ne -e /tmp/pi-boot-test/harness_all.ts --offline -p "test"`,
mock `gh` at 1.2 s latency, all five extensions loaded):

| Path | Before (`main` @ `4097f53`) | After | Budget |
|---|---|---|---|
| extension factories | 5 ms sync `which` probes + module work | 0–5 ms (async probes) | 20 ms |
| `session_start` (summed, awaited by Pi) | **2721 ms** (pr-tasks 2434, orca 283) | **15 ms** | 20 ms |
| first user message (`input`) | up to **1906 ms** observed, `STARTUP_CHECK_WAIT_MS = 5000` cap | **0 ms** | 10 ms |
| `turn_end` (summed, awaited by Pi) | **3322 ms** (observe-pr 2406, pr-tasks 803, orca 113) | **7 ms** | 20 ms |
| longest synchronous event-loop freeze during boot | 150 ms `Atomics.wait` + `execFileSync` probes | 0 ms (only pi's own 4 ms read) | 20 ms |

What each extension now does:

* **`lib/nonblocking.ts` (new)** — `createTaskScope()` (`run` / `schedule` / `join` / `abort` /
  `flush`), `mapLimited()` for fan-out, `commandExists()` for PATH probes, `WriteQueue` for
  state files, and `reportBudgetViolation()` as the tripwire. Unit-tested in
  `test/test-nonblocking.ts` (runs in the `unit` suite).
* **`pr-tasks.ts`** — `session_start`, `turn_end` and `agent_before_settle` schedule one
  single-flight refresh (`sync-all`) instead of awaiting GitHub; the settle decision reads cached
  task state; refreshes run with `SYNC_CONCURRENCY = 2` and honour an `AbortSignal`;
  `session_shutdown` aborts them. Stale-context attribution is preserved by tagging a detached
  refresh with the boundary that scheduled it (`inBackground("session_start", …)`), which is what
  `test/test-pr-tasks-stale.ts` asserts.
* **`observe-pr.ts`** — startup branch check detached (`tasks.run`), the `input`-path wait for it
  deleted entirely, per-PR poll timers and the branch timer go through `tasks.schedule`, the
  ghHealth backoff retry runs as a task, and PATH probes for `requestdb`/`destroydb` are async in
  an now-async factory.
* **`orca-orchestration.ts` + `lib/orca-client.ts`** — `resolveOrcaCmd`/`spawnOrcaCheck` are async
  (no `execFileSync("which")` on any path); boot discovery and per-turn reconcile are detached; a
  generation counter keeps a late-spawned check process from claiming `checkProcess` after a stop.
* **`devin-delegate.ts`** — `Atomics.wait` retry removed (async read with a timer retry),
  `recoverState` runs detached from `session_start`, and every state/meta write goes through one
  ordered `WriteQueue` (atomic tmp+rename preserved) that is drained in `session_shutdown`.

Tests that encode "the handler awaited the work" were updated to wait for quiescence instead
(`__PI_PR_TASKS_FLUSH__`, `__PI_OBSERVE_PR_FLUSH__`, `__PI_ORCA_ORCHESTRATION_FLUSH__`), which is the
honest expression of the new contract: the *work* still happens, it simply is not on Pi's critical path.
Where a test asserted a side effect that now lands a moment later (`test-observe-pr-resume` R6b) it polls
for that effect rather than waiting on a lifecycle promise.

Guarantees kept from the work that landed on `main` while this was in progress: file-only internal
logging (`lib/extension-log.ts`, never `console.*`), stale-context teardown with caller attribution
(`test-pr-tasks-stale`, `test-observe-pr-stale`), and `ghHealth` pacing — `ghHealth` still decides
*when* GitHub is contacted, `nonblocking.ts` decides *where* the wait happens.

## 8. Review round 1 (Devin `swe-2-max`) and what it changed

The first review found real defects; all of them are fixed here.

1. **`lib/orca-client.ts` had not been converted** — the async `resolveOrcaCmd`/`spawnOrcaCheck`
   work was lost while rebasing, so `execFileSync("which", "orca-ide")` still froze the event loop
   on *every* Orca call (boot discovery, every `turn_end`, every 30 s reconcile tick) and the
   `await` in `startCheckProcess` was a no-op. Restored: `resolveOrcaCmd()` is async and memoized on
   `commandExists`, and `execOrca`/`spawnOrcaCheck` await it.
2. **Task bodies ran inside the awaited handler.** `start()` invoked `work()` synchronously, so a
   task's preamble (spawning `gh`, `existsSync` scans) executed on the path Pi awaits. Tasks now
   start on a **macrotask** (`setImmediate`) — a microtask yield is not enough, because Pi's own
   continuation after the handler is a microtask. Re-measured `session_start`: 15 ms → **1 ms**,
   and the awaited `turn_end` cost is now 0 ms.
   `RunOptions.immediate` opts out for work that is *not* scheduled from a path Pi awaits: the
   `ghHealth` retry hooks. With the deferral on, those hooks lost the degraded-mode retry slot to
   the CI watchers' respawn in the same tick and `pr view` retries were starved for a whole outage
   (`observe-pr-gh-failure` T3: 2 attempts instead of 7). With `immediate: true` the cadence is
   back to main's (7 attempts, min gap ~1.6 s).
3. **`recoverState` could clobber live tool state.** Recovery is detached, so a `devin_delegate`
   call landing during its disk reads was wiped by `queue.length = 0` after the tool had already
   reported "queued". `run()` now returns a never-rejecting promise, `session_start` keeps it as
   `recoveryDone`, and every mutating tool path plus the `/devin` command awaits that gate first.
4. **A late startup notice was delivered twice** (and a third time after a resume):
   `releaseLateStartupNotices` sent the steer but left the entry in `deferredAnnouncements` and
   `announced` false, so the next plain message attached the same text and `persistState` carried it
   into the resumed session. It now consumes the entry and marks `announced`, like the
   `pendingAnnouncements` timer does.
5. **Check-process stop paths could let a late spawn re-attach.** Every stop now goes through
   `stopCheckProcess()`, which also retires the spawn generation, and a discarded spawn gets an
   `error` listener before it is killed (an unhandled `'error'` event on a `ChildProcess` crashes Node).
6. **Aborted work still applied results.** `reconcileWorkers`/`discoverActiveRun` take the scope's
   `AbortSignal` and stop after each awaited Orca round; devin's DB-backfill IIFE is a tracked task
   that checks its signal before notifying and before draining the queue.
7. **`abort()` is now sticky** (nothing may start on a shut-down scope) with an explicit `resume()`
   called from each extension's `session_start`, closing the `join`/`schedule`-resurrects-work gap.
8. **A throwing logger can no longer break a task**: the task's failure report and the `WriteQueue`'s
   logger call are guarded, so neither can produce an unhandled rejection.
9. **The `input` tripwire is wired** (both extensions declared the budget but never measured it),
   and the duplicated `agent_before_settle` measurement was removed.

`schedule()` semantics were also pinned down: work is read when a run actually starts, so requests
that arrive before it began do not add a run — they replace what it does (latest request wins).

## 9. Review round 2 (Devin `swe-2-max`)

Round 2 confirmed the non-blocking goal ("no lifecycle handler or factory awaits network/subprocess
I/O") but caught two round-1 claims that were **not actually in the code** — both lost while the
branch was rebuilt on `origin/main` — plus four more defects. Fixed here:

1. **`releaseLateStartupNotices()` still did not consume the notice.** It sent the steer but left the
   `deferredAnnouncements` entry and `pr.announced === false`, so the next plain message attached the
   identical text and a persisted `announced: false` made a resume deliver it again. It now mirrors
   what `agent_start` does for a notice that rode the user's message: mark announced, delete the
   entries it delivered (snapshot first, so a PR deferred in *during* the loop still owes an
   announcement), and persist.
2. **`tasks.resume()` was missing from observe-pr's `session_start`** while its `session_shutdown`
   calls the now-sticky `tasks.abort()` — an instance reused across sessions would silently never
   branch-check, poll or re-watch again. (Stock Pi re-runs the factory per session, so this is
   defensive; the asymmetry with the other three extensions was the real signal.)
3. **`reconcileWorkers` checked the abort signal only on entry.** After the awaited `worker-list`
   round-trip it mutated the registry and sent coordinator steers unconditionally — and the context is
   still live during the `session_shutdown` emit, so a stopped session could be steered. It now
   returns after the round-trip and before each row's notify.
4. **`stopCheckProcess()` left a pending respawn timer.** A `check --wait` exit schedules a respawn
   one second later while a run looks live; stopping inside that window still spawned a fresh 900 s
   watcher whose deliveries steered into the stopped session. `stopCheckProcess` now clears
   `restartCheckTimer` too.
5. **`__PI_ON_PR_CLOSED_DEVIN__` mutated state without the recovery gate.** A poll that detects a
   merged PR during detached recovery iterated a partially restored `sessions` map, so sessions not
   yet re-added had their worktrees never released for that close (the hook does not fire twice). It
   now awaits `recoveryDone` — correct because it is only invoked from detached poll tasks.
6. **`settlePendingAutoStarts()` released its `ghHealth` slot outside a `finally`.** A throw from
   `startObserving`/`announceTracking` would leave `inFlight` set on the process-wide singleton,
   starving every later degraded-mode retry for *both* extensions permanently. Now `try/finally`.

Nits also taken: the two `commandExists` PATH probes in observe-pr's factory run concurrently instead
of serially on the awaited factory path; the `input` tripwire is wired in observe-pr too; the
`agent_before_settle` measurement moved to a `finally` (its early returns were skipping it);
`reportBudgetViolation` cannot throw through a lifecycle handler; the duplicated `resetObserverState()`
in `session_shutdown` is gone; and **`TaskScope.join()` was deleted** — pr-tasks' `syncAllInFlight`
already provides awaited single-flight for tool paths, so it was unused API.

`schedule()` coalescing was tightened to match its documented contract: a request that arrives before
the deferred body of the current round has *entered* replaces that round's work instead of queueing a
follow-up. Previously `turn_end` and `agent_before_settle` — adjacent emits sharing `SYNC_ALL_KEY` —
caused two full `gh pr view` fan-outs back to back on every turn end. Scheduling during a round that
has actually entered still queues exactly one follow-up carrying the newest work.

## 10. Review round 3 (Devin `swe-2-max`)

Round 3 confirmed the goal again ("nothing awaits on any path Pi awaits", boot harness: factories
0–1 ms, `session_start` 1 ms, `input` 0 ms, `turn_end` 0 ms, `blocking_sync_calls: []`) and caught the
reason rounds 1–2 kept claiming unlanded fixes: **an `edit` call with several replacements is atomic**
— one non-matching entry rejected the whole call, so four `observe-pr.ts` changes from round 2 (and
one from round 1) never reached the file while the commit message said they had. Those four are now
applied and verified in the file:

1. `releaseLateStartupNotices()` consumes what it delivers (delete + `pr.announced` + `persistState`).
   Reachable when a check defers one PR and then awaits another round-trip — e.g. a repo root that
   still tracks a previous branch — so a turn can start in between and the release fires with
   `sessionHasRun` already true.
2. `settlePendingAutoStarts()` releases its `ghHealth` slot in a `finally`.
3. The two factory `commandExists` PATH probes run via `Promise.all`.
4. `checkBudget("input", …)` wired in observe-pr.

New findings from this round, also fixed:

5. **`startCheckProcess` consumed `lastPendingAckDeliveryId` before the spawn was adopted.** Resolving
   the orca command is async, so a spawn that gets discarded (`disposed`, or a newer
   `checkSpawnSeq`) used to take the pending ack with it; the process that replaced it could not ack,
   Orca re-delivered the message, and `handleCheckDelivery` has no delivery-id dedup → duplicate
   `worker_done`/`question` steers. The pending ack is now cleared only when the process is adopted.
6. **`handleStaleContext` did not abort the task scope** in either observe-pr or pr-tasks, so after a
   teardown that skipped `session_shutdown` a detached refresh kept making real `gh` calls until it
   happened to reach a guard, and its single-flight slot stayed booked. Both teardowns now abort.
7. **Detached stale attribution used one shared variable.** `backgroundCaller` was set/restored around
   `await`s, so with two interleaved refreshes the stale log named whichever task set it last. It is
   now an `AsyncLocalStorage`, which follows each execution through its awaits.
8. **A replaced single-flight round kept the first caller's opts.** `begin()` captured `slot.opts`
   while reading `slot.work` at body entry, so a request that replaced a not-yet-started round ran the
   new work under the old budget and reported failures through the old handler (e.g. pr-tasks' 5 s
   boot budget applied to a 45 s sync). Work and options are now both read when the body runs, and the
   budget clock is armed there, so the budget bounds the work and not the time it spent queued.

Not covered by a suite (stated plainly): the exact late-release interleaving in finding 1 — no Pi test
drives a check that defers one PR and then awaits another round-trip while a turn starts.

Also observed once, not reproduced in five later runs (including the same batch configuration):
`observe-pr-gh-failure` T4 timing out at its 25 s wait for the `observe_pr(202)` auto-start. The
changes in this batch touch neither `pendingAutoStart` nor slot accounting, so this reads as the
suite's fixed wait meeting a loaded machine (up to 8 s backoff windows after an outage), not a
regression — but it is a timing-sensitive test worth widening independently of this PR.

## 11. Review round 4 (Devin `swe-2-max`)

Round 4 verified every round-3 item **at file level** (all nine present — the atomic-edit failure mode
is closed) and found one real defect plus a silent one:

1. **A stale generation could steal the newer round's `again` → single-flight violated**
   (`lib/nonblocking.ts`). `begin()` chained the coalesced follow-up from `entry.promise.finally`,
   clearing only its own generation but consuming `slot.again` regardless. Trigger: a round in flight
   during `session_shutdown` (a `gh` call up to its timeout) → `abort()` → `session_start` →
   `resume()` → a new round R2 starts for the new session → another request sets `again` → the aborted
   predecessor finally settles and starts a **third concurrent run on the same key**, overwriting the
   live slot bookkeeping. Reproduced (`peak concurrency 2`) and now covered by a regression test that
   fails on the old code and passes on the new. The continuation is gated on slot identity
   (`slot.running !== holder → return`), so an aborted round cannot chain past its replacement.
2. **The observe-pr `input` tripwire could never fire**: `startedAt = Date.now()` measured against
   `performance.now()` inside `checkBudget` → elapsed ≈ −1.7e12 → always under budget. Now
   `performance.now()`, matching every other boundary in both extensions (verified: all eight
   `startedAt` declarations are monotonic).

Nits from the same round, also taken:

3. The follow-up chain now runs **inside** the finishing task's `finally`, before its entry leaves
   `running`, so `pendingTasks()`/`flush()` cannot report quiescence in the gap between a round and its
   coalesced follow-up.
4. The pending orchestration ack is bound to the run it was recorded for (`lastPendingAckRunId`) and
   the spawn uses the `runId` captured at start, so a watcher for a new run can never carry an ack from
   the old one.
5. Dead state removed: the slot holder's `promise` and the scope's monotonic `seq` counter (nothing
   read them once `join()` was deleted); generations are identified by object identity instead.

Round 4's verdict on the one-off `observe-pr-gh-failure` T4 timeout: the test file is byte-identical to
`main`, the auto-start path is timing-equivalent to base (`settlePendingAutoStarts` still claims the
retry slot first), so it is the suite's fixed wait meeting a loaded machine — worth widening
independently of this PR.

## 12. Review round 5 (Devin `swe-2-max`)

Round 5 confirmed the round-4 fixes at file level and validated the chaining rule across every
interleaving it could construct (schedule → replace → abort → resume → late settle, same-tick doubles,
`immediate` tasks, throwing work, `flush()` racing the chain). It also answered the spawn-`'error'`
question empirically: Node emits a synchronous spawn failure at the first microtask drain, and
`spawnOrcaCheck` spawns last with the listener attached in the same microtask burst, so the async
conversion is safe.

One should-fix, and it is a real behaviour regression from moving the settle decision to cached state:

1. **A task discovered by the post-settle refresh was recorded but never announced.**
   `agent_before_settle` now decides from `manager.getUnresolvedTasks()` (the cache of the last
   completed refresh) and schedules a refresh; `syncFromGitHubThreads` reports `newTasks`, which
   `syncPROrThrow` used to discard. So a reviewer comment arriving during the final turn was added to
   the task list while the agent settled unblocked, and nothing was said until the next user turn —
   "the following settle attempt" in the old comment does not exist once the agent has settled.
   Now `syncPROrThrow` notifies on `newTasks` through the same `sendAgentMessage` path the
   unblocked/reposted/stale transitions already use. Pi's own `prompt()` (which `sendUserMessage`
   calls) starts a turn when idle and only queues while streaming, so the notice re-engages a settled
   agent. The **first sync of a PR seeds silently** (`seededPRs`): a boot or a newly tracked PR
   discovers every open conversation at once, and those are covered by the settle gate. Cleared on
   `session_shutdown` and stale teardown.
   Covered by `pr-tasks` Test 45, verified to fail without the notification and pass with it.

Nits taken from the same round:

2. `startCheckProcess()`'s `ackDeliveryId` parameter was dead (all nine call sites passed nothing) —
   removed; the pending-ack path is the only source.
3. The pending ack's run binding now uses the run of the watcher that *delivered* the message
   (`wireCheckProcess(proc, runId)` → `handleCheckDelivery(data, runId)`), not `activeRunId` at
   arrival time, which during a run switch is already the next run.
4. observe-pr's `input` tripwire measures every exit (`try/finally`), not only the transform path.
5. `resume()` now **stops** what the previous session left running before clearing the bookkeeping,
   instead of only dropping the bookkeeping: an orphaned round whose signal never fired used to overlap
   the new session's work on the same single-flight key (transient peak 2) and could never chain.
   Covered by a unit test.

## 13. Review round 6 (Devin `swe-2-max`)

Round 6 verified the round-5 items at file level (including a line-by-line comparison of the re-indented
`input` handler against `main` — early returns and the transform return are unchanged) and found two
defects in the new notification logic I had introduced:

1. **Seeding was keyed by PR number, not repository.** `seededPRs` was a `Set<number>` while the manager
   scopes syncs by `owner/repo#prNumber`. Two folders carrying the same PR number (worktrees of two
   repos, or an observed PR in another folder) meant the *second* repository's first sync saw
   `seeded === true` and announced every conversation it discovered — exactly the first-sync storm the
   seeding exists to suppress. Key is now `` `${coords.owner}/${coords.repo}#${prNumber}` ``.
2. **Tasks arriving already resolved upstream were announced as new open conversations.** `createTask`
   sets `status: "RESOLVED"` when GitHub reports the thread resolved, `fetchReviewThreads` lists resolved
   threads, and unmatched nodes land in `newTasks` — so a reviewer resolving a conversation between two
   syncs produced a steer claiming it blocks stopping, and started a turn for a task that blocks
   nothing. The filter is now `t.status === "UNRESOLVED" && !taskLocks.has(t)`.

Both are covered by new tests, each verified to fail without its fix: `pr-tasks` Test 46 (resolved on
arrival is not announced) and Test 47 (first sync of the same PR number in another repository seeds
silently, and once seeded a new conversation there is announced like anywhere else) — Test 47 needed the
mock `gh` to report a per-folder repository (`repo_overrides.json`).

Nit not changed, deliberately: the observe-pr factory still awaits the two `commandExists` PATH probes.
It is the one documented exception on the awaited factory path — async rather than `execFileSync`, run in
parallel, memoized per `(cmd, PATH)`, ~2 ms in the harness with `blocking_sync_calls: []`. Removing it
would mean registering `requestdb`/`destroydb` unconditionally (offering tools whose binaries are absent)
or registering them after the factory, which Pi's loading model does not cleanly support.

## 14. Review round 7 (Devin `swe-2-max`) — clean

Round 7 verified the round-6 items at file level and found nothing that needs to change. It traced the
full notification surface of `syncPROrThrow` (all four buckets, no duplication across overlapping
syncs, nothing sent into a torn-down session, the notice → turn → refresh loop terminating under the
settle gate's existing `MAX_IDENTICAL_NUDGES` cap), every `schedule`/`again`/`resume` interleaving,
every `ghHealth` acquire/release pair, the orca ack/run binding and check-process lifecycle, and the
observe-pr notice machine. It also closed the two questions left open earlier: the exception of awaiting
two `commandExists` probes in the observe-pr factory is **acceptable** (removing it would advertise
absent tools or race tool registration against the first turn, for ~2 ms once per process), and the
RESOLVED→UNRESOLVED transition question below is the only gap it found.

**Verification of record:** typecheck; `unit` 166/166; all suites (`pr-tasks` incl. Tests 45–47,
`observe-pr`, `observe-pr-gh-failure`, `pr-tasks-gh-failure`, `observe-pr-stale`, `pr-tasks-stale`,
`observe-pr-resume`, `startup-notice`, `pr-tasks-reconcile`, `branch-observer`, `compaction-recovery`,
`tools`, `manifest`, `typecheck`) passing; boot harness with factories ≤2 ms, awaited boundaries 0–1 ms,
`blocking_sync_calls: []`, `sync_freeze_during_startup_ms: 0`.

### Follow-up (pre-existing on `main`, deliberately out of scope here)

`pr-tasks-manager.ts` flips a task `RESOLVED → UNRESOLVED` when a reviewer un-resolves a thread, and
`STALE → UNRESOLVED` when its thread comes back, without putting those tasks in any `SyncResult` bucket.
So while the agent is idle, a reopened conversation does not wake it — the same idle-agent gap this PR
closed for newly created tasks. Identical on `main`, so it is not a regression of this change; the fix
would be a `reopenedTasks` bucket in `applyThreadNode` announced next to `newlyOpen` (no seeding gate
needed, since a seeding sync has no tracked tasks to reopen). Tracked here rather than folded into this
PR, whose subject is keeping I/O off the paths Pi awaits.
