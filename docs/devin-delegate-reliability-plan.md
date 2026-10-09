# Plan: Make `devin-delegate` reliable

Issue: [#16](https://github.com/lucasschirm/claude-marketplace/issues/16) — *devin_delegate: sessions falsely marked FAILED by 60s session/prompt RPC timeout; completed results only recoverable from the Devin session DB*

Date of investigation: 2026-10-09. Branch: `devin_delegate-sessions-falsely-marked-failed-by`.

---

## 1. Investigation summary

The bug was reproduced end-to-end on 2026-10-09 21:36–21:47 UTC in this workspace
(session `juvenile-session`, pi session `01a12298-…`, model `swe-2-high`, a multi-step
prompt with ~90 tool calls). Combined with the 5-session evidence from the issue
(sessions `sage-munchkin` et al. in `~/.pi/agent/devin_delegate/01a120ae-…`) the failure
mechanism is fully confirmed:

| # | Observed behavior | Evidence |
|---|---|---|
| 1 | Session marked `failed` at exactly `startedAt + 60s` | `meta.json`: `error: "devin acp RPC request timed out after 60000ms (session/prompt)"`, `finishedAt − startedAt = 60.000s` — identical across all 6 observed sessions |
| 2 | The turn kept running and **completed successfully** | events.jsonl shows 91 `tool_call` events, 636 `agent_message_chunk` events, and the final `session/prompt` response `{"id":5,"result":{"stopReason":"end_turn",…}}` arriving ~155s after the timeout (sage-munchkin: arrival at 20:35:49, 12 min after the 60s timeout) |
| 3 | The final result is **discarded** | `AcpClient.request()` deletes the pending request on timeout, so the late response falls through `handleMessage()` unhandled; the session stays `failed` forever |
| 4 | `devin_status` is **blind** — shows only the initial prompt | `onUpdate` only logs `sessionUpdate === "agent_message"` + `content` or `output`; Devin streams `agent_message_chunk` (and `tool_call`, `usage_update`), so **zero `assistant_message` entries are ever written** to events.jsonl |
| 5 | **Orphaned ACP processes** | On timeout only the promise is rejected; the `devin acp` child is never disposed. Found 6 live orphans (15–16+ h old); the fresh reproduction's orphan stayed alive after the client gave up until explicitly cancelled |
| 6 | **TUI counters stuck at 0/0/0** | `totalCompleted` is only incremented in the success `.then()` path; the timeout path marks `failed` without incrementing, so `Devin ${running}/${queued}/${totalCompleted}` freezes at `0/0/0` and never flips to "completed" when the turn finishes late |
| 7 | **`set_config_option` model rejection** | The ACP `config_option_update` for `model` exposes a fixed vocabulary (`adaptive, swe-2-high, swe-1-7-lightning-medium, claude-fable-5-1-medium, claude-opus-5-5-medium, gpt-6-*-medium, kimi-k3-high, glm-5-2`) that does **not** include `swe-2-max`, even though `devin models list` and the `--model` spawn flag accept it. The redundant `set_config_option` call therefore fails `-32602 Invalid value` (seen in issue logs). The `--model` flag at spawn is the authoritative channel (session DB records `model=swe-2-max`). |

### Root causes

- **RC1 — turn lifetime ≫ RPC timeout.** `session/prompt` is a long-running ACP request that only resolves when the whole agent turn ends (minutes to hours for multi-step work). `AcpClient.request("session/prompt", …)` uses the default `timeoutMs = 60000`, so every real delegation "times out" and is marked failed while the work continues.
- **RC2 — no lifecycle cleanup on timeout.** Timeout only rejects the pending promise; the child process (own process group, `detached: true`) is never cancelled or killed → orphans holding DB handles and TLS connections indefinitely.
- **RC3 — no assistant output capture for the update types Devin actually emits** (`agent_message_chunk`, `tool_call`, `usage_update`) → transcripts are prompt-only and `devin_status`/dashboard can never show progress or results.
- **RC4 — status/counter state is derived from the client-side RPC lifecycle**, not from turn completion, so late completions are invisible in the UI.
- **RC5 — redundant, vocabulary-mismatched `set_config_option(model)` call** that always fails for models outside the ACP config vocabulary (e.g. `swe-2-max`).
- **RC6 (found during this investigation) — state anchoring is unstable.** Storage is keyed by `currentPiSessionId`, which is (re-)set both at `session_start` and at *every* `devin_delegate` tool execution from `ctx.sessionManager.getSessionId()`. If the two calls disagree (resume, session rotation), one session's state is split across two directories and `devin_status` reads from the wrong one. During the investigation, `~/.pi/agent/devin_delegate/<pi-session>/` directories also intermittently became unresolvable (stale `readdir` vs `ENOENT`) in this shared multi-pi environment — file access must tolerate transient `ENOENT`.
- **RC7 — recovery is lossy.** `recoverState()` marks every `running` session `interrupted` unconditionally, with no check of the Devin session DB, so turns that actually completed while pi was down are reported as interrupted and their results are lost.

### Secondary observations (noted for the fix, lower priority)

- `devin_restart` on a session whose original `devin acp` process is still alive (orphan) can start a *second* live process for the same logical session — pid tracking is missing.
- `onExit` handler marks the session `failed` on non-zero exit even when the failure was a client-side abort (e.g. `SIGTERM` from our own `dispose()`).
- `devin_message` re-attach spawns a brand-new `devin acp` for an existing session id; the semantics of re-attaching to the original session (ACP `session/load` if available) should be verified.

---

## 2. Fix plan

Phased, in implementation order. Each phase is independently shippable and testable.

### Phase 1 — Treat `session/prompt` as an async job (fixes RC1, RC6-counter part of RC4)

**Goal: a turn's completion is detected by the arriving ACP response, never by a wall-clock timer.**

1. Split RPC timeouts:
   - Control-plane RPCs (`initialize`, `session/new`, `session/set_mode`, `session/set_config_option`) keep a short timeout (30–60s is fine — these return in <1s).
   - `session/prompt` is sent with **no response timeout** (add a `timeoutMs = 0` sentinel to `AcpClient.request()` meaning "wait for response indefinitely"; keep a separate *stall watchdog*, see 3).
2. Track turn state explicitly in `SessionMeta`:
   - `turnStartedAt`, `lastTurnUpdateAt`, `turnCompletedAt`, and (for recovery) the child `pid`.
   - `status: "running"` while the turn is in flight; transition to `idle` only when the `session/prompt` response arrives (or the child dies — Phase 2).
3. Stall watchdog instead of a hard timeout — use **two distinct signals**:
   - **Turn progress**: any `session/update` activity — `agent_message_chunk`, `tool_call`/`tool_call_update`, and `usage_update` all count as liveness (`usage_update` is confirmed streaming on free-tier swe-2 models, e.g. 62 events across `sage-munchkin`'s 12-min turn). If **nothing** arrives for `N` minutes (default 30, configurable via `--devin-turn-stall`), mark the turn `stalled` and notify the agent with the session id so the user can `devin_cancel`/`devin_restart`. Do **not** mark `failed` and do **not** kill the process.
   - **Process liveness**: child exit state + the devin-ACP stderr heartbeat (the ~15s periodic skills-discovery refresh). This distinguishes "process is alive but the turn is possibly stalled (model thinking / long tool call)" from "process is dead" (→ Phase 2 `interrupted`).
4. Late-arriving responses are the happy path:
   - `handleMessage()` must resolve the pending `session/prompt` response whenever it arrives, regardless of how long the turn took.
   - On success: `status = "idle"`, `totalCompleted++`, `finishedAt`, PR detection, agent notification, `drainQueue()` — i.e. the current `.then()` body, now actually reachable for multi-minute turns.
   - Counter fix (RC4): `updateStatusUI()` counts "in progress" = sessions with a **live client and in-flight turn**; "completed" = `totalCompleted` which is incremented when the turn completes — so a late completion flips the TUI from `running` to `completed` (fixes the stuck `0/0/0`).

**Acceptance:** a 2–5 minute delegated turn ends in `idle` with a completion notification; no `failed` at 60s; TUI counter advances to completed.

### Phase 2 — Lifecycle: no orphaned processes (fixes RC2, part of RC7)

1. Any terminal transition disposes the child:
   - `stalled` + user `devin_cancel` → `session/cancel` notify, then `dispose()` (group SIGTERM → SIGKILL after 1.5s, as today).
   - Process **exit** while a turn is in flight → `status = "interrupted"` (not `failed`), record exit code; distinguish "we killed it" (flag set before `dispose()`) from a crash.
2. Record the child `pid` in `meta.json` at `startSession()`.
3. Startup reconciliation in `recoverState()`:
   - For each persisted `running` session: is its `pid` alive?
     - Alive + pi restarted → mark `interrupted`, offer `devin_restart` (do not silently re-adopt; the ACP connection is gone).
     - Dead + no exit cause recorded → check the Devin session DB (Phase 3.3) for a completed turn → `idle` with backfilled final message, otherwise `interrupted`.
   - This replaces the blanket "running ⇒ interrupted" (RC7) and makes `devin_restart`/recovery honest.
4. `devin_restart` guard: refuse (with a clear message) to start a second `devin acp` if the session's recorded `pid` is still alive — kill or cancel first.

**Acceptance:** after any cancel/crash/timeout-stall, `ps aux | grep "devin acp"` shows no leftover process for that session within ~5s; recovered sessions are never silently mislabeled.

### Phase 3 — Observability: make `devin_status` and the transcript real (fixes RC3, RC4)

1. Capture every relevant `session/update` type in `onUpdate` → events.jsonl:
   - `agent_message` (full), **`agent_message_chunk`** (append the chunk to an in-memory accumulator per session; flush the accumulated message to events.jsonl on turn end or every K chars — keep the 64KB tail-read path working),
   - `tool_call` (record `toolCallId`, tool name/title only — not full input, to keep logs small),
   - `usage_update` (token counts — dashboard + liveness signal; confirmed streaming on free-tier swe-2 models, so it counts toward the stall-watchdog heartbeat; see Phase 1.3).
2. `devin_status` (and dashboard) then actually show: running turns with last tool/message, completed turns with the final assistant text.
3. Late-result backfill: when the local transcript has no final message but the session is known-complete (Phase 2 reconciliation, or a `devin_status` on a finished session with an empty transcript), fall back to the Devin session DB (`~/.devin-xdg-data/devin/cli/sessions.db`, `sessions` + `message_nodes` — verified to contain the full final assistant message in the issue's recovery) or `devin` CLI session export, and attach it to the session meta so it is visible without raw DB access.
4. TUI counter: `Devin <active>/<queued>/<completed>` where *active* is derived from live clients + in-flight turns (Phase 1.4); optionally surface a `stalled` count so orphaned/stuck sessions are visible and actionable (issue "Suggested fixes" item 2).

**Acceptance:** after a completed turn, `devin_status <id>` shows the final assistant message (not "(Initial prompt: …)"); the dashboard can scroll real output; a completed turn is visible in the counter.

### Phase 4 — Fix the model/mode configuration (fixes RC5)

1. **Drop the redundant `set_config_option(model)` call.** The model is already authoritative via the `--model` spawn flag (session DB records it; the issue's sessions ran on `swe-2-max` this way).
2. If mid-session model switching is ever needed: read the `model` option's `options` list from the last `config_option_update` (now captured in Phase 3), and only call `set_config_option` when the requested model is in that list; otherwise report "model not switchable mid-session; model is fixed at spawn (`--model`)".
3. Keep the `dangerous → bypass` mode mapping; validate the mode against `current_mode_update`/`config_option_update` options instead of guessing, and surface a clear error for unknown modes.

**Acceptance:** no `-32602` errors in events/devin logs for `swe-2-max` (or any model outside the config vocabulary); sessions still run on the requested model (verify via session DB row / `devin` logs).

### Phase 5 — State persistence hardening (fixes RC6 + environment findings)

1. Anchor storage to the pi session id captured at `session_start`; tool executions must not re-anchor it (if they disagree, log loudly and keep the original anchor).
2. Make all file reads/writes tolerant of transient `ENOENT`/flaky paths (retry once after a short delay; the shared-volume environment observed here showed directories flapping between visible and `ENOENT` within seconds — reads of `meta.json`/`events.jsonl` must not throw session state over this).
3. Persist `meta.json` **immediately** on every terminal transition (done today) and on `turnStartedAt`/`lastTurnUpdateAt` changes (debounced is fine for liveness, immediate for terminal).
4. `state.json` should store, per session id, the directory it was written to (self-describing), so recovery never depends on the current `currentPiSessionId` value.

### Phase 6 — Tests

Extend the existing test harness (pi-extension test pattern, `pi -ne -e test/test-devin-delegate.ts --offline -p "test"`):

1. **Fake ACP server** (new `test/fixtures/fake-devin-acp.mjs` + a `devin` shim on `PATH` for the test run): a JSON-RPC over stdio server that implements `initialize`, `session/new` (returns a deterministic id), `session/set_mode`, `session/set_config_option`, and `session/prompt` with a configurable delay; emits a few `agent_message_chunk`/`tool_call` updates mid-turn, then the `stopReason: "end_turn"` response.
2. Test cases (fast: 3–5s turns for the happy path; one 90s turn for the timeout path, or a time-scaled variant):
   - **T1** long turn (delay > old 60s, e.g. 90s or time-scaled 10s with a scaled-out timeout) → session ends `idle`, completion notification sent, `totalCompleted` incremented, no `failed` anywhere. *(The core regression test for issue #16.)*
   - **T2** `agent_message_chunk` updates → `assistant_message` entries present in events.jsonl; `devin_status` returns the final text.
   - **T3** `devin_cancel` on a running turn → child process dead within 5s (verified via `ps`/pid), session `cancelled`.
   - **T4** fake server exits mid-turn → session `interrupted` (not `failed`); `devin_restart` works.
   - **T5** `set_config_option` for an out-of-vocabulary model → no error event; spawn flag remains the model source.
   - **T6** restart recovery: kill pi mid-turn (or simulate by re-`recoverState` over persisted state with a live/dead pid) → correct labeling per Phase 2 rules.
3. Keep the existing live test (`test-devin-delegate.ts`) for end-to-end, and the bash-guard tests; run the fake-server suite in CI (no network/devin account needed).

---

## 3. Suggested implementation order & effort

| Phase | What it fixes | Rough effort | Ships standalone? |
|---|---|---|---|
| 1 | false FAILED (RC1), stuck counters (RC4) | S–M | yes — the headline fix |
| 2 | orphaned processes (RC2), honest recovery (RC7) | M | yes |
| 3 | blind `devin_status`/transcripts (RC3) | M | yes |
| 4 | model config errors (RC5) | S | yes |
| 5 | state anchoring/flakiness (RC6) | S–M | yes |
| 6 | regression tests (fake ACP) | M | run alongside 1 |

Suggested sequence: **6 (fake ACP scaffold) → 1 → 2 → 4 → 3 → 5**, one PR per phase (or 1+2 combined as "lifecycle", 3+4 as "observability + config"), each with its T-tests.

## 4. Implementation status (2026-10-09, branch `devin_delegate-sessions-falsely-marked-failed-by`)

All six phases are implemented in `extensions/devin-delegate.ts` (+ test suite):

| Phase | Status | Notes |
|---|---|---|
| 1 — async turn model | done | `AcpClient.request(…, timeoutMs = 0)` waits indefinitely for `session/prompt`; stall watchdog (`--devin-turn-stall`, default 30 min) marks `stalled` (never auto-fails/kills); late responses resolve the pending request; `stalled → running` on activity; TUI shows `Devin <running>/<queued>/<completed> (+N stalled)` and counts running+stalled as in-flight |
| 2 — lifecycle / no orphans | done | `pid` recorded in `meta.json`; mid-turn exit → `interrupted` (code-0 → `idle`); cancel path (`devin_cancel`, `/devin cancel`) disposes live client or kills recorded pid directly (post-restart orphans); `devin_restart` refuses when recorded pid alive; `recoverState` reconciles: live pid → kill + `interrupted`, dead pid → DB backfill → `idle`/`interrupted` |
| 3 — observability | done | `agent_message_chunk` buffered (flush at 2 KB / turn end), `tool_call`/`tool_call_update`, `usage_update`, `config_option_update` captured; `devin_status` shows tool + usage lines and backfills the final assistant message from `sessions.db` (`node:sqlite`, read-only) when the local transcript lacks it; dashboard surfaces `stalled` |
| 4 — model/mode config | done | `set_config_option(model)` call removed (`--model` spawn flag is authoritative); `set_mode` error surfaces the advertised mode vocabulary when known |
| 5 — persistence hardening | done | tool executions no longer re-anchor storage (mismatch → loud warn, keep original anchor); `readFileSyncWithRetry` tolerates transient ENOENT; `state.json` carries `sessionDirs` (self-describing); recovery re-anchors recovered metas into the current dir and reads from the recorded dir when the meta moved |
| 6 — tests | done | `test/fake-acp-server.mjs` (fake `devin acp`, env-driven delay/exit, mimics real `-32602` model vocab) + `test/test-devin-delegate-lifecycle.ts`: **T1** 70 s turn → `idle` (the issue #16 regression), **T2** chunks/tool/usage captured, **T3** cancel kills process (no orphans), **T4** process death → `interrupted` (not `failed`) + `devin_restart` works, **T5** `swe-2-max` works with no `set_config_option` call, **T6** recovery reconciliation (dead pid → `interrupted`; live pid → killed + `interrupted`). All pass via `pi -ne -e test/test-devin-delegate-lifecycle.ts --offline -p "test"`; the existing live test and bash-guard tests also pass. |

Deviations from the plan (deliberate):
- **Stall watchdog**: one timer per running session (60 s tick) keyed on `lastMessageTime` (any `session/update` advances it, incl. `usage_update` per the confirmed free-tier streaming); the devin-ACP stderr heartbeat is available as a secondary signal but not required — a dead process is handled by `onExit` as `interrupted`, which is the ground truth.
- **Backfill source**: the `devin` CLI has no session-export command (verified `devin --help`), so backfill reads `~/.devin-xdg-data/devin/cli/sessions.db` directly via `node:sqlite` (`DatabaseSync`, read-only). Key finding: `sessions.id` **is** the friendly session name (= the ACP `sessionId`), so no id translation is needed; final message = last `message_nodes` row with `role = "assistant"`.
- **`usage_update`** counts toward liveness (confirmed: 62 events across `sage-munchkin`'s 12-min turn on a free-tier model) and is logged as dashboard data.

Remaining open questions (unchanged, lower priority): ACP `session/cancel` semantics; whether ACP supports `session/load`/re-attach for `devin_message` (re-attach still spawns a fresh `devin acp`); default stall threshold tuning (30 min vs. longest observed real turn ~15 min).

## 5. Open questions (verify during implementation)

1. ACP `session/cancel` semantics — does it abort in-flight agent work, or only end the session? (Needed to phrase Phase 2 correctly; verify with a fake/real ACP server.)
2. Exact schema of `~/.devin-xdg-data/devin/cli/sessions.db` (`sessions`, `message_nodes`) — confirm the read path for backfill (issue #16 recovered all 5 results from it).
3. Does the Devin ACP support `session/load`/re-attach, so `devin_message` can reuse the original session instead of spawning a fresh `devin acp`?
4. Default stall threshold (30 min) — confirm against longest observed real turns (issue: 719–863s; nothing > 15 min observed).

## 6. Appendix: reproduction transcript (2026-10-09)

- Delegation: `devin_delegate` (prompt: survey `extensions/` directory, multi-step, ~90 tool calls), model `swe-2-high`, 21:36:56 UTC, session `juvenile-session`.
- 21:38:xx — steer received: `The session juvenile-season failed: devin acp RPC request timed out after 60000ms (session/prompt)`.
- `meta.json`: `status: "failed"`, `finishedAt = startedAt + 60.000s`, yet `lastMessageTime` kept advancing (last update 21:41:34).
- events.jsonl (read via the extension's still-open fd, `/proc/<pi-pid>/fd/29`): 91 `tool_call`, 636 `agent_message_chunk`, **0 `assistant_message`**, and the final response `{"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn","usage":{…}}}` at **21:41:35** — discarded by the client; session stayed `failed`.
- `devin_status juvenile-season` at 21:41:34: `Status: failed … Last 3 messages: (Initial prompt: "…")` — blind, exactly as in issue #16.
- Orphan: `devin acp --model swe-2-high` (pid 2925757) alive >90s after the client gave up; removed by explicit `devin_cancel` (the only working cleanup path).
- `config_option_update` captured from the live stream: `model` options = `adaptive, swe-2-high, swe-1-7-lightning-medium, claude-fable-5-1-medium, claude-opus-5-5-medium, gpt-6-astra-medium, gpt-6-sol-medium, gpt-6-luna-medium, kimi-k3-high, glm-5-2` — no `swe-2-max`, confirming RC5.
