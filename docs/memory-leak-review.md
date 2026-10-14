# Review: Pi extensions — memory leak audit

Scope: full review of `extensions/*.ts` + `extensions/lib/*.ts` (devin-delegate, observe-pr, orca-orchestration, pr-tasks, tools, and all lib files) for unbounded growth / lifetime bugs.

Method: static review of every long-lived container (maps, sets, timers, child processes, closures), plus an empirical harness that loads the real extensions with a mocked `ExtensionAPI` and mirrors pi's actual lifecycle — **the factory runs once per process; `session_start`/`session_shutdown` fire repeatedly** (this is what `/new`, `/resume`, `/switch`, and fork do; only `/reload` re-runs the factory — verified in pi's loader: `loadExtensionModule` caches the factory per process, `newSession`/`switchSession` rebind the same extension runtime). The harness ran 10 session cycles per extension with forced GC before each measurement.

## Empirical results (pre-fix, 10 sessions each, heapUsed after forced GC)

| Extension | Work per session | Heap growth | Verdict |
|---|---|---|---|
| `devin-delegate` | 2 delegated sessions | **+0.3 MB, monotonic** (12.2 → 12.6 MB) | State is retained forever |
| `orca-orchestration` | 2 dispatched workers × 8 KB spec | **+0.3 MB, monotonic** (12.7 → 13.1 MB) — ≈ exactly the 160 KB of dispatched spec text | `observedWorkers` is never freed |
| `observe-pr` | 1 observed PR, ~1.6 MB CI output streamed | flat after GC (13.1 MB); **~1 MB held mid-stream** until the `gh run watch` process exits | Per-run buffer is unbounded in *duration*; cross-session state is mostly released |

Additionally proven: in session 2 (new pi session id), `devin_status` lists **session 1's** devin session (`sess-1 [IDLE]`) — previous-session state both persists in memory and is re-persisted to the *new* session's `state.json` by `recoverState()`'s `raw == null → persistState()` path.

## Findings

### High

**F1 — `orca-orchestration.ts`: `observedWorkers` is never evicted and never cleared on `session_shutdown`** (`extensions/orca-orchestration.ts:281`, shutdown handler `:684`)

Every `orca_orchestration_dispatch` stores the **full task spec** plus `summary`, `filesModified`, `reportPath` in the map. Nothing removes entries: not turn completion, not `session_shutdown`, no time-based eviction — only explicit tool calls (`action: "stop"` with a dispatch id, or a full stop) do. Combined with the once-per-process factory lifecycle, a long supervisory session (the extension's primary use case: dispatching dozens–hundreds of workers) accumulates every spec ever dispatched. The harness measured growth exactly proportional to spec size (20 × 8 KB = 160 KB ≈ 0.3 MB).

Note: the full spec text is never actually *used* after registration — the dashboard/overviews only ever render `spec.slice(0, 35..50)`.

**F2 — `devin-delegate.ts`: per-session state is never reset on `session_shutdown` and leaks into the next pi session** (state at `:482, :520, :523, :526, :875`; shutdown handler `:1580`)

The shutdown handler only does `cleanupAllClients()` (kills the ACP children) and resets `lastUIContext`. `sessions` (all `SessionMeta`, including terminal ones), `queue`, `sessionConfigOptions`, `sessionDirs`, `stallTimers`, `pendingMetaSaves`, `assistantBuffers` all survive the shutdown. Consequences, all verified:

1. Monotonic heap growth across sessions in one pi process (~15 KB per devin session, never freed).
2. The next pi session (`/new`, `/resume` of a *different* session) sees the previous session's devin sessions via `devin_status` — stale "idle/failed" entries whose processes were already killed at shutdown.
3. `recoverState()` for the new (empty) session id takes the `raw == null` path and calls `persistState()`, which **re-anchors the previous session's in-memory state under the new session id** — the leak also persists to disk.

This is a behavior bug, not just a leak: the old `devin` slash-command/dashboard and queue in the new session operate on dead sessions.

**F3 — `devin-delegate.ts`: stall-watchdog and meta-save timers are only cleared indirectly on shutdown** (`:520`, `:875`, `:1580`)

`cleanupAllClients()` → `AcpClient.dispose()` sets `isDisposed = true`, so the child's `exit` handler skips `onExitCallback` (`:197` checks `!this.isDisposed`). The 60 s `setInterval` watchdogs are therefore stopped only *indirectly*, via the `.catch()` of the rejected `session/prompt` promise (a microtask, and only while `meta.status` is still `running`/`stalled`). The common path works, but cleanup depends on microtask timing and status state; in edge cases the (unref'd, so process-keeping) timers keep firing against dead state. The shutdown handler should stop them directly.

### Medium

**F4 — `observe-pr.ts`: `watchRun` accumulates the *entire* CI output of a watched run in a closure string** (`:333, :336`)

`output += chunk.toString()` on both stdout and stderr, for the whole lifetime of the `gh run watch` process. The string is only used for fallback heuristics (`output.includes("failure" | "success")`). A CI run that lasts hours and streams megabytes-to-gigabytes of logs holds it all in the closure until the process closes. Harness: ~1 MB held mid-stream for a 1.6 MB stream, released only when the process exited — the per-run bound is unbounded in *time*.

**F5 — `observe-pr.ts`: `trackedBranchesByRepo`, `branchToPR`, `autoDetectedPRs` are never cleared, not even on `session_shutdown`** (`:136–138`; `cleanupAll` `:624`; shutdown `:854`)

Slow cross-session accumulation (branch names, PR numbers — small entries, but unbounded across sessions/repos; `autoDetectedPRs` grows by one per observed/stopped PR forever). These are session-scoped knowledge; after a session switch, re-detection is the desired behavior, so they should be cleared in `cleanupAll()`.

### Low (robustness / hygiene)

**F6 — `devin-delegate.ts`: `AcpClient.dispose()` never closes the `readline` interface or detaches the child's streams** (created `:117–196`, `dispose()` `:238`)

`rl` is released only when the child actually exits. If the process-group kill silently fails (detached child), the client — and with it the `onUpdateCallback`/`onExitCallback` closures referencing the session meta — stays referenced. Close `rl`, remove child stream listeners, and destroy stdin in `dispose()`.

**F7 — `devin-delegate.ts`: `__PI_ON_PR_CLOSED_DEVIN__` is not deleted on `session_shutdown`** (assigned `:2352`; shutdown `:1580` deletes only the guard key)

The stale closure pins the previous generation's state in `globalThis` until the extension re-runs (which only happens on `/reload`). Other extensions delete their globals on shutdown (`__PI_ON_PR_POLL__`, `__PI_ON_PR_CLOSED__` in pr-tasks; `__PI_OBSERVED_PRS__` in observe-pr) — this one was missed.

**F8 — `devin-delegate.ts`: `process.once("exit"|"SIGINT"|"SIGTERM")` listeners re-registered on every `/reload`** (`:1601–1603`)

The guard is released on shutdown, so a reload re-runs the factory and adds three more process listeners. Each pins that generation's closure (and its `sessions` map etc.) until the first matching signal fires — an accumulation across reloads. Move the exit hooks to module scope, registered once, dispatching to the current generation's cleanup.

**F9 — `orca-orchestration.ts`: `lastUIContext` is not reset on `session_shutdown`** (`:684`)

Stale UI context is then used by `updateStatusUI` for post-shutdown events (inconsistent with devin-delegate, which resets it). `activeRunId`/`activeObjective` also carry over until `discoverActiveRun` overwrites them on the next `session_start`.

**F10 — `observe-pr.ts`: `lastUIContext` is not reset on `session_shutdown`** (`:854`)

Same as F9.

### Reviewed — no issues found

- `devin-delegate`: `AcpClient.pendingRequests` is cleared on error/exit/dispose (indefinite `timeoutMs = 0` prompt promises are by design — resolved by turn completion or process exit); `assistantBuffers` flush at ≥ 2 KB and are deleted on flush/cancel/exit; `pendingMetaSaves` are 3 s self-clearing debounce timers; `binaryAvailableCache` is bounded by command names; `readLastMessagesFromDisk` uses a fixed 64 KB tail buffer; DB backfill closes its `DatabaseSync` in `finally`.
- `observe-pr`: `observedPRs` and all per-PR sets/maps are fully released by `stopObserving`/`cleanupAll`; poll/restart timers are cleared; all child processes are killed on stop; `pendingAnnouncements` timers are cleared.
- `pr-tasks`: `taskLocks`/`heldNotices` are `WeakMap`s (auto-GC); `manager` is cleared on shutdown; `syncAllInFlight` is a single slot that is invalidated on shutdown. `manager.tasks` keeps `RESOLVED` tasks (with full reply bodies) for the session lifetime — bounded by GitHub data and cleared on shutdown (optional hardening below).
- `github-review-threads.ts`: `repoCache`/`repoRootCache` are module-level and unbounded across sessions, but entries are ~40 B — negligible.
- `tools.ts`: state re-fetched per `/tools` invocation; components are transient; the guard release on shutdown is correct.
- `orca-client.ts`, `devin-diagnostics.ts`, `devin-bash-guard.ts`: stateless or bounded constants.
- All TUI dashboard components (devin, pr-observer, orca, pr-tasks, tools) are created per command invocation and released by `done()`.

## Fix plan

### Phase 1 — stop the accumulation (high-impact, low-risk)

**P1.1 — orca-orchestration: bound `observedWorkers`** (fixes F1)
1. In the `session_shutdown` handler: `observedWorkers.clear()`.
2. Store a truncated spec: `spec: params.spec.slice(0, 1024)` (only the first ~50 chars are ever rendered; keep 1 KB headroom for `formatWorkerOutput`-style uses).
3. Evict settled workers: when `observedWorkers.size > 50`, drop the oldest entries with a settled status (`succeeded`/`failed`/`released`/`stopped` — never `running`) until back under the cap. Same eviction in the reconcile path.

**P1.2 — devin-delegate: reset per-session state on `session_shutdown`** (fixes F2)

In the `session_shutdown` handler, after `cleanupAllClients()`:

```ts
for (const t of stallTimers.values()) clearInterval(t);
stallTimers.clear();
for (const p of pendingMetaSaves.values()) clearTimeout(p.timer);
pendingMetaSaves.clear();
sessions.clear();
queue.length = 0;
sessionConfigOptions.clear();
sessionDirs.clear();
assistantBuffers.clear();
totalInvoked = 0;
totalCompleted = 0;
currentPiSessionId = "default";
```

Notes:
- This also fixes the cross-session persistence leak, because `recoverState()`'s `raw == null → persistState()` path then persists *nothing* for a fresh session id.
- Consistent with the existing shutdown behavior of killing all devin processes: the next pi session starts clean, and `devin_restart`/recovery from disk (via the self-describing `sessionDirs`) still works when the *same* pi session id is resumed.
- Update `test-devin-delegate-lifecycle.ts` expectations if any test relies on cross-session visibility (none currently do).

**P1.3 — devin-delegate: stop timers directly on shutdown** (fixes F3)

Covered by P1.2 (direct `clearInterval` on all `stallTimers` + `clearTimeout` on `pendingMetaSaves`).

**P1.4 — observe-pr: bound `watchRun` output** (fixes F4)

Rolling tail, since only substring heuristics and the final status matter:

```ts
child.stdout?.on("data", (chunk) => { output = (output + chunk.toString()).slice(-65536); });
child.stderr?.on("data", (chunk) => { output = (output + chunk.toString()).slice(-65536); });
```

**P1.5 — observe-pr: clear cross-session caches** (fixes F5)

In `cleanupAll()` (which runs on `session_shutdown`): `trackedBranchesByRepo.clear(); branchToPR.clear(); autoDetectedPRs.clear();`

### Phase 2 — robustness

**P2.1 — `AcpClient.dispose()`: release `rl` and child streams** (fixes F6)

Keep `rl` as a field; in `dispose()`: `this.rl?.close()`, `this.child.stdout?.removeAllListeners()`, `this.child.stderr?.removeAllListeners()`, `this.child.stdin?.destroy()`, `this.child.removeAllListeners()`.

**P2.2 — delete `__PI_ON_PR_CLOSED_DEVIN__` on shutdown** (fixes F7)

**P2.3 — module-level process exit hooks** (fixes F8)

Hoist a module-scope `let currentShutdownCleanup: (() => void) | undefined`; the factory sets it to `cleanupAllClients`. Register `process.once("exit"|"SIGINT"|"SIGTERM")` **once per process** (module-level guard that is *not* released on `session_shutdown`), dispatching to `currentShutdownCleanup?.()`.

**P2.4 — reset `lastUIContext` (and, for orca, `activeRunId`/`activeObjective`) on `session_shutdown`** (fixes F9, F10)

### Phase 3 — optional hardening (separate PR, no behavior coupling)

- **P3.1** `pr-tasks`: evict `RESOLVED` tasks older than 24 h (manager already records `resolvedAtMs`); keeps `getPRsToSync()`/`getAllTasks()` bounded in very long sessions.
- **P3.2** `devin-delegate`: cap `readFullTranscriptFromDisk` at the last ~1 MB of the events file (reuse the tail-buffer technique already used in `readLastMessagesFromDisk`), noting truncation in the output.
- **P3.3** Add the session-cycle harness (this review's harness, with fake `devin acp`/`orca`/`gh` binaries) as a regression test asserting post-shutdown state is empty (`sessions.size === 0`, `observedWorkers.size === 0`) and per-cycle heap growth stays flat.

## Validation

1. Re-run the session-cycle harness after the fix: all three curves must be flat after the first (warm-up) cycle; the observe-pr mid-stream bump must cap at ~64 KB.
2. Run the existing test files with `pi -ne -e test/<file>.ts --offline -p "test"` (lifecycle, devin-delegate, orca-orchestration, branch-observer, startup-notice, pr-tasks, tools-command) — all must pass unchanged, except lifecycle expectations intentionally updated by P1.2.
3. Smoke: load the package in an interactive pi, delegate a devin task, `/new`, then `devin_status` (must report no sessions), `observe_pr` on a PR, `/new` again (branch poll timer replaced, no duplicate observation announcements for the old session's PRs).
4. `jq .` checks per CLAUDE.md for any manifest changes (none expected).

## Implementation (applied)

All Phase 1 + Phase 2 items were implemented in this branch:

- **P1.1** `orca-orchestration.ts`: `observedWorkers.clear()` + reset of `activeRunId`/`activeObjective`/`lastUIContext` on `session_shutdown`; dispatched `spec` truncated to the first 1 KB (UIs render at most 50 chars); `evictSettledWorkers()` evicts the oldest settled (non-running) workers once the map exceeds 50 entries, called from dispatch, `worker_done`, reconcile, and both tracking tool paths.
- **P1.2** `devin-delegate.ts`: `session_shutdown` now resets all per-session state — `stallTimers`, `pendingMetaSaves`, `sessions`, `queue`, `sessionConfigOptions`, `sessionDirs`, `assistantBuffers`, `totalInvoked`, `totalCompleted`, `currentPiSessionId` — and deletes `__PI_ON_PR_CLOSED_DEVIN__` (P2.2). On-disk state is untouched: `recoverState` re-anchors it via `sessionDirs` when the same pi session id resumes, so `devin_restart` still recovers those sessions.
- **P1.3 + P1.4 + P1.5** `observe-pr.ts`: 64 KB rolling tail for `gh run watch` output (stdout and stderr); `cleanupAll()` clears `trackedBranchesByRepo`/`branchToPR`/`autoDetectedPRs`; `lastUIContext` reset on shutdown.
- **P2.1** `AcpClient.dispose()`: `rl` is now a field and is closed on dispose; `onUpdateCallback`/`onExitCallback` are nulled; stderr/stdin listeners removed and stdin destroyed. The child's `error`/`exit` handlers are deliberately kept (both no-ops once disposed) so delayed child errors keep being swallowed instead of crashing the host process.
- **P2.3** `devin-delegate.ts`: exit/SIGINT/SIGTERM hooks hoisted to module scope, registered once per process, dispatching to the current generation's `cleanupAllClients` (idempotent).

Intentional behavior change (P1.2): a *new* pi session starts with clean devin state — the previous session's devin sessions are no longer visible via `devin_status` after `/new`/`/resume` of another session. Resuming the *same* pi session id still recovers its devin sessions from disk.

## Validation results

Harness: session-cycle loop that loads the real extensions via jiti with a mocked `ExtensionAPI` and mirrors pi's real lifecycle (factory once, N × `session_start`/`session_shutdown`, forced `global.gc()` before each measurement; fake `devin acp`/`orca`/`gh` binaries). 20 devin sessions with 2 × 16 KB prompts per cycle, 10 orca cycles with 2 × 8 KB dispatched specs, 10 observe-pr cycles streaming ~1.6 MB of CI output per cycle.

| Curve (after GC each cycle) | Original | Fixed |
| --- | --- | --- |
| devin-delegate, 20 sessions | +1.0 MB, still growing at cycle 20 (13.0 → 13.2) | **+0.0–0.4 MB, flat from cycle 9** (12.6 × 4) |
| orca-orchestration, 10 cycles | +0.3 MB, monotonic | +0.2 MB (warm-up only, flat after cycle 4) |
| observe-pr, 10 cycles | +0.1 MB, mid-stream bump held until child exit | **+0.0 MB, mid-stream capped at the 64 KB tail** |

Behavioral checks:

- Cross-session carry-over test: session 2's `devin_status` now reports "No Devin sessions or queued tasks registered yet." (before: listed session 1's `sess-1 [IDLE]`).
- Post-shutdown state probes: `sessions`/`sessionConfigOptions`/`sessionDirs`/`stallTimers` all 0 after `session_shutdown`; fresh `session_start` begins with 0.
- Child-process hygiene: after dispose, every fake `devin acp` child is dead within the SIGTERM (1.5 s SIGKILL fallback) window; no surviving processes or active `ChildProcess` handles after the session loop.
- Full test suite (`pi -ne -e test/<file> --offline -p "test"` + the four `.sh` tests): `test-devin-delegate`, `test-devin-delegate-lifecycle`, `test-orca-orchestration`, `test-startup-notice`, `test-tools-command`, `test-pr-tasks`, `test-pr-tasks-reconcile`, `test-observe-pr.sh`, `test-orca-orchestration.sh`, `test-pr-tasks.sh`, `test-tools-command.sh` all pass. `test-devin-bash-guard`, `test-devin-tui-safety`, `test-pr-tasks-manager` exit 1 on *both* the original and fixed code (pre-existing: the files are plain scripts, so pi prints "does not export a valid factory function" after all their assertions pass ✔) — unchanged by this fix.

Note from debugging: an early harness run showed a residual per-cycle ramp that was traced to the fake `devin acp` returning the same session id (`sess-1`) for every spawned server, which collided in `activeClients` and orphaned one child per cycle. Real `devin` session ids are unique; the harness now issues unique ids, and the fixed curve is flat.
