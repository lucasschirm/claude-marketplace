# Plan: Handle GitHub API failures in PR monitoring silently with paced retries

Reported symptom: a session showed timeout errors while connecting to `api.github.com` — the PR monitoring extensions (`observe-pr.ts`, `pr-tasks.ts`) surface GitHub failures to the TUI (raw `console.error` text), send the agent misleading messages, and re-attempt at a fixed cadence with no backoff, hammering the API while it is unreachable.

Requirements:
1. GitHub usage failures are **silent** for the TUI and the agent.
2. The extensions **keep retrying** in the background.
3. Retry pacing: **every 30 s, 5 times**; if failures continue, **every 10 min** (until a call succeeds).

---

## 1. Investigation summary

| # | Problem | Where | Effect when GitHub is unreachable |
|---|---|---|---|
| F1 | **No timeout on `gh` calls in `observe-pr.ts`** — every one-shot `execFileAsync("gh", …)` lacks a `timeout` (unlike `github-review-threads.ts`, which uses `FETCH_TIMEOUT_MS = 60 s`) | `pollPR` (~L411), `checkTrackedBranches` (~L701), `checkAllCIPassed` (~L268), `watchRun` close handler `gh run view` (~L352), `getRunErrorSummary` (~L234, L248), `observe_pr` tool (~L937) | A hung `gh` blocks the call forever. Worse, `checkTrackedBranches` is serialized by `isCheckingBranches` — one hung call wedges **all** branch auto-detection permanently. |
| F2 | **`gh run watch` network failure is misclassified as a CI failure** | `watchRun` close handler (~L345–395) | `gh run watch` exits non-zero on a network error; the `gh run view` fallback also fails; the heuristic `exitCode !== 0 \|\| output.includes("failure")` → `conclusion = "failure"`. The agent gets a **false** "CI run X failed … investigate" message whose "error summary" is the connection error (via `getRunErrorSummary`), and the run is dropped from `activeRuns`. |
| F3 | **`checkAllCIPassed` catch-block reports a false "All CI passed"** | `checkAllCIPassed` (~L262–293) | When `gh pr checks` fails (network), the `catch` falls back to run bookkeeping and tells the agent **"All CI passed"** — an opposite false positive. |
| F4 | **No backoff: fixed-cadence hammering** | `pollPR` `setInterval` (60 s), `gh pr checks --watch` restart (`startChecksProcess` close → `setTimeout(interval)`), `checkTrackedBranches` `setInterval` (60 s), `pr-tasks` `syncAllPRs` on `session_start`/`turn_end`/`agent_before_settle`/tools | Every observed PR + every tracked branch + every task sync independently re-attempt on their own timers — N parallel `gh` invocations every 60 s, forever, with no shared state and no increase in spacing. |
| F5 | **Failures surface in the TUI and to the agent** | `console.error("[observe_pr] Error polling PR …")` (~L490), `console.error("[observe_pr] …checks process…")` (L322/327/534/539), `console.error("[observe_pr] Error checking tracked branches")` (L755), `console.error("[pr_tasks] Failed to sync review threads …")` (~L218) | Pi does **not** intercept extension `console.*` (verified in the devin-delegate post-mortem, §4.2 of `docs/devin-delegate-reliability-plan.md`): the text is written raw into the alternate-screen terminal and is visible in the TUI. `observe_pr` tool returns raw `stderr` in its tool result. |
| F6 | **`pr-tasks` settle loop degrades badly on outage** | `agent_before_settle` (~L380–430) → `syncAllPRs` | While GitHub is down, `syncPROrThrow` waits up to 60 s per PR (plus per-page GraphQL fetches) serially — every settle attempt stalls for minutes, and unresolved tasks (stale local state) keep nudging the agent (existing cap of 3 identical nudges still applies, but each nudge tick is slow). |
| F7 | **No recovery bookkeeping** | — | No failure counting, no "degraded" state, no reset-on-success; nothing coordinates the retry cadence across the call sites. |

Root causes: **RC1** missing timeouts on one-shot `gh` calls; **RC2** no shared health/backoff state — every call site retries on its own fixed timer (hammering, no pacing, no reset); **RC3** error classification conflates "GitHub unavailable" with "CI failed / all CI passed", producing false agent messages; **RC4** failure paths log via raw `console.error` (TUI-visible) and leak `stderr` into tool results.

---

## 2. Fix plan

Phased, in implementation order. Each phase is independently shippable and testable.

### Phase 1 — Shared GitHub health/backoff manager (`extensions/lib/gh-health.ts`, new)

A small singleton (module-level instance, imported by `observe-pr.ts` and `pr-tasks.ts` — same module cache, so one shared state across both extensions) that owns all retry pacing:

State: `consecutiveFailures`, `lastFailureAt`, `status: "healthy" | "degraded"`, a single `retryTimer`.

Policy (per the requirement):
- Any **availability failure** increments `consecutiveFailures` and marks `degraded`.
- While `consecutiveFailures < 5`: next retry after **30 s** (i.e. retries at +30, +60, +90, +120, +150 s).
- After the 5th consecutive failure: next retry after **10 min**, and every 10 min thereafter, until a success.
- Any **success** from any call path resets to `healthy` (failures = 0, timer cleared).
- **Single-flight**: only one retry timer at a time. While degraded, other callers do not pile on — they skip and let the scheduled retry run (this is what stops the N-parallel-calls hammering of F4).
- Timers cleared on `session_shutdown`.
- Injectable `now()` + interval overrides (or `PI_GH_HEALTH_FAST_MS` env) so tests run with 100 ms/5 s spacings instead of 30 s/10 min.

API sketch:
```ts
export const ghHealth = new GhHealth();           // singleton
export function isGhAvailabilityError(err: unknown): boolean;
// caller pattern for a background call:
if (ghHealth.skipOrAwaitRetry()) return;         // degraded + retry not yet due → skip tick
try { await ghCall(); ghHealth.recordSuccess(); }
catch (err) { if (isGhAvailabilityError(err)) ghHealth.recordFailure(); /* silent */ }
```
`recordFailure()` schedules the next attempt (30 s / 10 min) and invokes a registered `onRetry` callback that re-runs the pending operation (poll tick, branch check, task sync).

Error classification `isGhAvailabilityError`: counts execFile `killed`/`signal` (our own timeout), `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`/`EAI_FAILED`/`ENETUNREACH`, stderr patterns `timed out`, `failed to connect`, `connection reset`, `dial tcp`, `TLS handshake`, `HTTP 429`/`503`, `token expired`/`unauthorized` (auth is also paced + silent; visible on demand in the dashboard). **Excluded** (not availability): 404 / "not found" / "Could not resolve" (per-PR logic owns those) — a single 404 must not push shared state into the 10-min tier.

### Phase 2 — `observe-pr.ts` integration

1. **Timeouts (RC1):** add `timeout` (reuse `FETCH_TIMEOUT_MS` = 60 s) to every one-shot `gh` call listed in F1. Fixes the `isCheckingBranches` wedge (F1) as a side effect.
2. **Silence (RC4):** remove `console.error` from all GH-failure paths (L322, 327, 490, 534, 539, 755); failures become invisible. Keep logging (via the devin-delegate TUI-safe `logWarn`/`logError` pattern) only for non-GH internal errors.
3. **Backoff (RC2):** route `pollPR`, `checkTrackedBranches`, `checkAllCIPassed`, the `gh pr checks --watch` restart, and the `observe_pr` tool's pre-check through `ghHealth` (skip-when-degraded + scheduled retry; the `gh pr checks --watch` restart delay becomes the backoff slot instead of a fixed `interval`).
4. **False CI-failure fix (RC3, F2):** in the `watchRun` close handler, when `gh run view` fails with an availability error (or the watch process itself died on a network error pattern in its stderr): do **not** conclude `failure`; `recordFailure()`, keep the run in `activeRuns`, and re-arm `watchRun` on the next backoff slot. Only a confirmed non-availability failure reports the run conclusion.
5. **False "All CI passed" fix (RC3, F3):** `checkAllCIPassed` catch-block: on an availability error → `recordFailure()`, stay silent, **no** "All CI passed" message.
6. **`observe_pr` tool (agent-initiated):** on an availability failure, don't return raw `stderr`; return a brief status ("GitHub unreachable — observation of PR N will start automatically once the connection recovers"), and register a pending start that executes on the next backoff success (announcement then flows as usual). 404/draft handling stays as today (not an availability failure).
7. **Dashboard (on demand only):** `PRObserverDashboardComponent` / `/pr_observer list` show one line: `GitHub: degraded (6 consecutive failures, next retry in 9m)`. Nothing automatic is emitted (requirement 1).

**Acceptance:** with GitHub unreachable, the TUI shows no output, the agent receives no messages (no false CI failures, no false "all passed"), `gh` invocations happen at 30 s × 5 then 10 min cadence, and the first success after an outage resumes polling, run watching, and branch detection with a reset counter.

### Phase 3 — `pr-tasks.ts` integration

1. `syncAllPRs` first consults `ghHealth`: while degraded with no slot due, **skip** the sync (no 60 s-per-PR serial waiting, F6) and rely on the scheduled retry; on failure `recordFailure()` and stay silent (remove the L218 `console.error`).
2. `session_start` / `turn_end` / `agent_before_settle` syncs behave the same — settle stays fast during an outage; the existing `MAX_IDENTICAL_NUDGES = 3` cap still protects the agent from a settle block on stale state.
3. Tool invocations: reads (`pr_tasks_list`, `pr_task_detail`) return a brief "GitHub unreachable" status (silent retry continues in background); **mutations** (`pr_task_resolve`, `pr_task_blocked`) report a short error to the agent — an agent-initiated mutation must not be silently retried (a re-posted reply is not safe without the agent's say-so); the background sync retry still paces the shared state.
4. `session_shutdown` clears the shared retry timer (shared with Phase 1/2).

**Acceptance:** with GitHub unreachable, `turn_end`/settle do not stall, no TUI output, no per-PR serial 60 s waits; task state is re-synced on the first successful backoff retry.

### Phase 4 — Tests (existing harness: mock `gh` on `PATH` + mocked `pi`, `pi -ne -e test/… --offline -p "test"`; unit via `node --test`)

1. **Unit — `test/test-gh-health.ts`** (injected clock / fast intervals): failure count → 30 s slots × 5 → 10 min slots (timestamps asserted); any success resets; single-flight (no overlapping retries); 404-class errors do not change state; timer cleared on shutdown.
2. **E2E — extend `test-observe-pr.sh` pattern** with a `gh` that fails with a network error for N invocations, then succeeds:
   - **T1 (F2 regression):** `gh run watch` dies with a network error → agent receives **no** "CI run X failed" message; the run stays `activeRuns` and is re-watched after recovery.
   - **T2 (F3 regression):** `gh pr checks` fails → **no** "All CI passed" message.
   - **T3 (F5):** zero console output and zero agent messages across all failure paths; failure timestamps follow 30 s × 5 → 10 min (fast-scaled).
   - **T4:** recovery — first successful poll delivers a pending comment update; branch detection resumes after a hung-call wedge is gone (F1).
3. **E2E — extend `test-pr-tasks.ts`:** network off for a few ticks → no console output, settle is fast (no serial 60 s waits), sync skipped while degraded, one background retry batch on the slot, tasks sync on recovery; mutation tool on outage returns a short error (no silent retry of the mutation).

---

## 3. Effort & sequence

| Phase | Fixes | Effort | Ships standalone? |
|---|---|---|---|
| 1 — `gh-health.ts` + classification + unit tests | RC2, RC7 | S | foundation |
| 2 — `observe-pr` integration (timeouts, silence, false-failure fixes, tool/dash) | RC1, RC3, RC4 | M | yes |
| 3 — `pr-tasks` integration (skip+retry, silence, fast settle) | RC4, RC2 | S–M | yes |
| 4 — regression E2E tests | all | M | run alongside 2–3 |

Sequence: **1 → (4 scaffold) → 2 → 3**, one PR per phase (2+3 may combine as "outage handling").

## 4. Open questions (verify during implementation)

1. Long outages: after several 10-min retries, should a **one-time** status be sent to the agent (e.g. "GitHub still unreachable")? Default: no — fully silent per the requirement; the dashboard shows it on demand.
2. HTTP 429: honor a `Retry-After` from `gh` stderr when present (extends the current slot) — nice-to-have.
3. `devin-delegate`'s one-shot `gh pr view` PR detection (~L1197–1207) and `orca-client.ts` (~L378) can adopt the same classifier/timeout later; out of scope here.
4. `gh`'s own built-in HTTP timeout varies by version; the explicit `timeout` in Phase 2 makes behavior version-independent.

---

## 5. Implementation notes (decisions taken during implementation)

1. **Auth errors are a sub-class of availability, but are surfaced on explicit calls.** `isGhAuthError()` (token expired / unauthorized / bad credentials) counts as an availability failure for *background* pacing (a bad token must not hammer the API), but an explicit `observe_pr` call and a `pr-tasks` mutation surface the auth error to the user/agent instead of the "temporarily unreachable" note — it is not self-resolving. A failed explicit call with an auth error does **not** register an auto-start: a permanently failing auto-start would claim every backoff slot and starve the polling of other PRs (regression found in `test-branch-observer` test 10).
2. **`recordCurrentBranch` stays ungated** in `checkTrackedBranches`: it is a local `git` call and must run even when the `gh` branch check is skipped/paced, or a skipped check would drop branch tracking (regression found in `test-branch-observer` test 3).
3. **No-op work must not reset the shared state:** `recordSuccess` is only called when a real `gh` call was made and succeeded (the `ghCallMade` flag in `checkTrackedBranches`; skip-paths in `syncPR`/`refreshTask` record nothing). A 404-class error records neither success nor failure.
4. **`pr-tasks` `refreshTask` is slot-gated, not status-gated:** degraded with the slot not yet due → the mutation proceeds on the *cached* task state (at most one backoff interval old); the mutation's own `gh` call is the connectivity test. A status-gated fast-fail broke the existing suite (a one-off 502 in test 21 poisoned test 22's retry). Mutation errors are classified in the tool's catch (`mutationErrorText`): availability → concise "temporarily unreachable", everything else keeps the detailed `gh` error.
5. **Test support:** `test/gh-fail-env.ts` (1.5 s × 5 / 8 s) and `test/gh-fast-env.ts` (0.5 s × 5 / 2 s) set the `PI_GH_HEALTH_*` env vars before the `ghHealth` singleton loads (imports are hoisted — the vars must be set at module load). `test-pr-tasks.ts` imports `gh-fail-env.ts` and `test-branch-observer.ts` imports `gh-fast-env.ts`; `pr-tasks.ts` exposes `globalThis.__PI_GH_HEALTH__` for test inspection.

### Review round 1 (Devin, `swe-2-max`) — fixes applied

1. **Burned-slot stall** (bug): `release()` now clears `windowUsed` — a slot holder that records neither success nor failure (no-op branch check, 404-class call) no longer burns the window and stalls all gated work permanently. Single-flight is preserved (in-flight double-claim is still blocked; a record-less release makes the still-due slot claimable again, which is the normal-cadence behavior for a non-failing call).
2. **`inFlight` leak across sessions** (bug): the `gh pr checks --watch` close handler releases the slot *before* the `observedPRs.has` early return, so a stop/shutdown mid-outage can't wedge the singleton.
3. **Checks-watcher exit misclassification** (bug): `gh pr checks --watch` exits 1/8 for failed/pending CI — only a real availability error in a kept stderr tail records a failure (a CI failure no longer flaps the shared state degraded↔healthy).
4. **`formatMs` scope** (bug): moved to module scope — the TUI dashboard no longer throws `ReferenceError` on render.
5. **ENOENT / `context deadline exceeded` / `unexpected EOF` / `auth login`** (bug+risk): classified as availability (a missing `gh` binary no longer respawns at 1 Hz; Go HTTP timeouts and not-logged-in pace instead of spamming the TUI).
6. **403 rate limit ≠ auth** (risk): `isGhAuthError` excludes rate-limit text first, so a 403 rate limit keeps the silent+auto-start path instead of surfacing as an auth error.
7. **`pendingAutoStart` reconciliation** (risk): deleted on the tool's explicit start/stop paths and skipped for already-observed PRs in `settlePendingAutoStarts` — no duplicate `startObserving` (timer/process leak + double announcement).
8. **`session_shutdown` resets the shared state** (plan deviation): both extensions call `ghHealth.reset()` so a pending timer / wedged slot never carries into the next session.
