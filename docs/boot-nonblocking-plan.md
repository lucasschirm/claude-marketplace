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
