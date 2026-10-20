# P0 execution plan — issue #35 "Extensions code quality: remediation checklist"

Scope: the **P0 — Stop the bleeding** section of #35 only. P1 (lint, `check-quality.mjs`, ratchet, `AGENTS.md`) and P2
(splits) are explicitly out; see §8 for what must *not* creep in.

Current facts this plan is built on (verified in this workspace):

| Fact | Value |
| --- | --- |
| `tsc --noEmit --strict` over `extensions/` | **34 errors** (18 × `details`, 4 × `invalidate`, 2 × `registerTool` arg, 4 × implicit-`any` params, 2 × `stage.activity`, 2 × `pageup`/`pagedown`, 1 × `string[]`→`string`, 1 × `string \| undefined`) |
| `pi.registerTool(` sites | **19** — devin 6, observe-pr 3, orca 6 (5 distinct defs: `observeToolDef` at `orca-orchestration.ts:879` is registered at `:1020` and re-registered under a second name at `:1021`), pr-tasks 4 |
| `ctx.ui.custom(` sites | 5 — 4 missing `invalidate()`, only `tools.ts:531` is correct |
| Config today | no `tsconfig.json`, no lockfile, no `devDependencies`, no `engines`, `.gitignore` has **no `node_modules`** |
| Registry | `typescript` 7.0.2, `@earendil-works/pi-coding-agent` 1.3.0, `@earendil-works/pi-tui` 1.3.0, `typebox` 1.4.2 |
| Local toolchain | node v24.22.0, `pi` 1.3.0 on PATH (`/usr/local/bin/pi` → `/usr/bin/pi`, package at `/usr/lib/node_modules/@earendil-works/pi-coding-agent`) → the Pi-runtime suites can be run locally |
| Type contract | `AgentToolResult<T = JsonValue \| undefined>` (`pi-agent-core/dist/types.d.ts:370`, re-exported by `pi-coding-agent`) has **required** `content` **and** `details`; `pi-tui` `Component.invalidate()` is required (`pi-tui/dist/tui.d.ts:88`) |
| Module layout | `pi-agent-core` / `pi-tui` live *nested* under `pi-coding-agent/node_modules` — `pi-tui` must be a direct devDependency (extensions import it by name), `pi-agent-core` resolves transitively |
| CI today | 2 jobs (`manifests-and-unit-tests`, `pi-extension-tests`), node `'24'`, pi installed globally, repo itself never `npm install`ed |

**Exit criteria for P0** (all must hold before the P0 boxes in #35 are ticked):

1. `npx tsc --noEmit` exits **0**.
2. Every one of the 19 tools returns `details`; every dashboard component implements `invalidate()`.
3. `gh`/CLI failures can no longer be reported as success ("All CI passed", `ok: true` on bad JSON).
4. A `filePath` from the GitHub API cannot write outside the repo root; `applyCodeSuggestion` rejects non-integer lines.
5. CI has a `quality` job that fails on a type error, and the whole suite set (`bash test/run.sh`) is green locally.

---

## 1. Branch & PR strategy

Two PRs, both from the current branch `lucasschirm-app/code-quality-review` (already contains the untracked
`docs/extensions-code-quality-review.md`, which lands with PR-A).

| | PR-A — `chore(qa): strict typecheck + Pi tool-result contract` | PR-B — `fix(qa): trust boundaries for gh/CLI output and suggestion writes` |
| --- | --- | --- |
| Nature | mechanical, **no behaviour change** except the two declared F22 fixes | behaviour changes, each with a test that fails before the fix |
| Size | ~1 file of new helpers + 19 tool sites + 4 components + 6 config files | 4 small logic sites + 3 new test files |
| Merge order | **first** (unblocks the typecheck gate) | second, rebased on A |
| Reviewer | Antigravity workflow (independent, structural) | Claude Code `code-quality-reviewer` (independent of the author engine) |

Rule from #35 that applies throughout: **the engine that authors a diff does not review it.** Both PRs paste the
`npm run typecheck` + `bash test/run.sh` output into the PR body.

Keep each PR-A step as its own commit so a reviewer can drop one without losing the rest.

---

## 2. PR-A — steps in order

### A1. Toolchain scaffolding (1 commit, no source edits)

- [ ] `.gitignore`: add `node_modules/`.
- [ ] `package.json`:
      ```jsonc
      "engines": { "node": ">=23.6" },
      "scripts": {
        "test": "bash test/run.sh",
        "test:unit": "node --test test/test-devin-bash-guard.ts test/test-devin-tui-safety.ts test/test-pr-tasks-manager.ts",
        "typecheck": "tsc --noEmit",
        "validate": "node scripts/validate-marketplace.mjs"
      },
      "devDependencies": {
        "typescript": "^7.0.2",
        "@types/node": "^24.0.0",
        "@earendil-works/pi-coding-agent": "1.3.0",
        "@earendil-works/pi-tui": "1.3.0",
        "typebox": "1.4.2"
      }
      ```
      Pin the pi packages to **exact `1.3.0`** (= the version CI installs globally) — see risk **R1**.
- [ ] `tsconfig.json`:
      ```jsonc
      {
        "compilerOptions": {
          "target": "esnext",
          "module": "nodenext",
          "moduleResolution": "nodenext",
          "lib": ["esnext"],
          "types": ["node"],
          "strict": true,
          "noEmit": true,
          "skipLibCheck": true,
          "allowImportingTsExtensions": true,   // extensions import "./lib/x.ts"
          "verbatimModuleSyntax": false,        // keep off in P0: type-only-import churn is P1
          "noUnusedLocals": false,              // P1, once lint owns it
          "noImplicitOverride": true
        },
        "include": ["extensions/**/*.ts", "scripts/**/*.mjs"],
        "exclude": ["test/**", "node_modules", "plugins/**"]
      }
      ```
      `test/**` is excluded in P0 (the Pi-runtime harnesses rely on ambient globals); widening `include` is a P1 task.
- [ ] Commit `package-lock.json` (generated by `npm install`).
- [ ] **Verify before continuing:** `npm install && npx tsc --noEmit | tee /tmp/tsc-before.log | tail -1` → expect
      **34 errors**, and `bash test/run.sh` (all 8 suites in `ALL_SUITES`) still green with `node_modules/` present →
      this is the empirical check for **R1**.

### A2. `extensions/lib/tool-result.ts` + `details` on all 19 tools (F1)

New helper (no `any` in the signature, so every call site is checked):

```ts
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Keep this JSON-serialisable: results are persisted into the session JSON. */
export type ToolDetails = Record<string, unknown>;

export function ok<T extends ToolDetails>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}
export function err<T extends ToolDetails>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}
```

Generic `T` (not bare `AgentToolResult`) is what makes the call sites checked: the default `T = JsonValue | undefined`
means a non-generic signature would accept `details: undefined` again.

Per-tool `details` payload (state each tool already computes but currently drops — the point is machine-readable
output for the next turn and for `renderCall`/`renderResult`):

| Tool | site | `details` keys |
| --- | --- | --- |
| `devin_delegate` | `devin-delegate.ts:1663` | `sessionId`, `queueId?`, `worktree?`, `model`, `status` |
| `devin_status` | `:1786` | `sessionIds[]`, `counts{running,queued,completed,failed}`, `complete` |
| `devin_message` | `:1926` | `sessionId`, `turnAccepted`, `status` |
| `devin_cancel` | `:2051` | `sessionId`, `cancelled`, `wasQueued` |
| `devin_restart` | `:2092` | `sessionId`, `resumed`, `status` |
| `devin_clean_worktree` | `:2240` | `sessionId`, `worktreePath`, `released`, `pruned[]` |
| `observe_pr` | `observe-pr.ts:1187` | `prNumber`, `observed[]`, `action` (`observe`\|`stop`), `repo` |
| `requestdb` | `:1384` | `dbHost`, `dbPort`, `dbName`, `dbUser`, `fresh` (never include `DB_PASSWORD`) |
| `destroydb` | `:1421` | `scope` (`folder`\|`all`), `destroyed[]` |
| `orca_orchestration_dispatch` | `orca-orchestration.ts:725` | `dispatchId`, `taskId`, `runId`, `agent`, `worktree` |
| `orca_orchestration_observe` **+** `orca_orchestration_observe_orchestration` | shared `observeToolDef` (`:879`, registered `:1020`/`:1021`) | `action`, `dispatchId?`, `runId?`, `observed[]` — one fix covers both names |
| `orca_orchestration_status` | `:1027` | `dispatchId?`, `state`, `attention[]`, `workers[]` |
| `orca_orchestration_reply` | `:1236` | `messageId`, `dispatchId`, `delivered` |
| `orca_orchestration_release` | `:1283` | `dispatchId`, `action`, `released`, `worktreePath?` |
| `pr_tasks_list` | `pr-tasks.ts:793` | `prNumber`, `counts{open,resolved,blocked,stale}`, `taskIds[]` |
| `pr_task_resolve` | `:839` | `conversationId`, `resolved`, `suggestionApplied`, `file?` |
| `pr_task_detail` | `:907` | `conversationId`, `replies`, `hasSuggestion`, `state` |
| `pr_task_blocked` | `:940` | `conversationId`, `blocked`, `reasonSlug` |

Conventions: keys `camelCase`; `details` must be JSON-serialisable (convert `Set`/`Map` to arrays — e.g. the observed
run sets); never put secrets, tokens or full command output in `details` (`requestdb` returns `DB_PASSWORD` in its
text — keep it out of `details`); cap arrays at 50 entries with `truncated: true`; error paths use `err()` with a stable
`code` (`"GH_FAILED"`, `"NO_SESSION"`, `"BAD_JSON"`, `"PATH_ESCAPE"`).

- [ ] Convert the happy paths and the error paths (the ~48 `catch` blocks mostly end in a text-only error result).
- [ ] **Verify:** `npx tsc --noEmit 2>&1 | grep -c "details"` → `0`; `bash test/run.sh unit tools pr-tasks observe-pr`.

### A3. `invalidate()` on the 4 dashboards (F4)

Add to `DevinDashboardComponent`, `PRObserverDashboardComponent`, `OrcaDashboardComponent`,
`PRTasksDashboardComponent` — the pattern `tools.ts:451` already uses:

```ts
invalidate(): void {
  this.cachedWidth = 0;      // force re-render
  this.cachedLines = undefined;
}
```

- [ ] Cache the rendered lines like `tools.ts` does (width-keyed) so `invalidate()` has something to clear —
      do **not** add per-frame work.
- [ ] **Verify:** `npx tsc --noEmit | grep -c TS2345` → 0 for the four `ui.custom` sites; manual smoke of each
      dashboard (e.g. `pi -e extensions/pr-tasks.ts` → open the dashboard, resize the terminal, confirm no throw and
      correct re-layout).

### A4. Remaining type errors are real bugs (F3-lite, F22)

- [ ] `orca-orchestration.ts:907` — 4 implicitly-`any` callback params: annotate the handler signature
      (`(toolCallId: string, params: <typed>, …)`) rather than adding `any`.
- [ ] `orca-orchestration.ts:131-132` — `stage.activity` is read but not in the declared row shape: add `activity?: string`
      to `OrcaWorkerRow` (or the stage type) instead of casting.
- [ ] `orca-orchestration.ts:1020-1021` — `pi.registerTool(observeToolDef)` (an untyped object literal, `:879`) no longer
      fits the overload once `details` is required; add `details` and, if the literal still mismatches, annotate it with
      `satisfies Parameters<typeof pi.registerTool>[0]` (never `as`).
- [ ] `tools.ts:237`,`:243` — `"pageup"`/`"pagedown"` → **`"pageUp"`/`"pageDown"`** (`pi-tui` `KeyId`,
      `keys.d.ts:32`). Today those branches are unreachable while the footer advertises scrolling.
- [ ] `tools.ts:400` — `promptGuidelines` is `string[]`: render one line per guideline
      (`for (const g of tool.promptGuidelines) wrapTextWithAnsi(g, safeWidth - 6)`).
- [ ] `pr-tasks.ts:573` — see **B3** (needs a guard + test, so it is done in PR-B; if it blocks `tsc` green in PR-A,
      apply the guard in PR-A and the test in PR-B and say so in the PR body).
- [ ] **Verify:** `npx tsc --noEmit` → **exit 0**.

### A5. CI gate + docs commit

- [ ] `.github/workflows/ci.yml`: add a `quality` job **before** the existing two —
      `actions/checkout@v4` → `actions/setup-node@v4` (`node-version: '24'`, `cache: npm`) → `npm ci` →
      `npm run typecheck` → `npm run validate`.
- [ ] `test/run.sh`: add a `typecheck` suite (`npx tsc --noEmit`) to `run_suite` and to `ALL_SUITES` (8 → 9 suites), so
      `bash test/run.sh` locally runs the same gate CI does. Note the unit list is duplicated in `test/run.sh` and
      `ci.yml` — keep both in sync in P0 and log the de-duplication as P1 (it belongs to the `npm run qa` task).
- [ ] Commit `docs/extensions-code-quality-review.md` (currently untracked) so #35's reference resolves.
- [ ] **Verify:** `bash test/run.sh` (all 8 suites) green locally; push and confirm the `quality` job runs and passes.

---

## 3. PR-B — steps in order

Each item is: extract → test (red) → fix (green).

### B1. `gh` failure must not mean "All CI passed" (F2)

`sendAgentMessage("All CI passed…")` is emitted from **three** places in `checkAllCIPassed`; two are fallbacks that
cannot know the truth:

| Site | Condition | Problem |
| --- | --- | --- |
| `observe-pr.ts:498` | `!hasPending && !hasFailed && hasPassed` | correct — validated `gh pr checks` output |
| `observe-pr.ts:501-503` | `else if` — output was not a non-empty array | announces success from `completedRuns`/`failedRuns` bookkeeping |
| `observe-pr.ts:506-511` | `catch` — **`gh` failed or timed out** | same announcement on an error path |

- [ ] Extract the pure decision into `lib/ci-verdict.ts`:
      `evaluateCiVerdict(checks: unknown, obs: { completed: number; failed: number; ghFailed: boolean }): "passed" | "failed" | "unknown"`
      — `"unknown"` when `ghFailed` or when `checks` is not a non-empty array; `"failed"` on any fail/cancel bucket or
      `FAILURE/ERROR/CANCELLED/TIMED_OUT/ACTION_REQUIRED/STARTUP_FAILURE` state, `"unknown"` on `pending`/
      `PENDING/IN_PROGRESS/QUEUED`; `"passed"` only when every entry is pass/skip **and** `ghFailed === false`. Move the
      existing bucket/state string lists verbatim so behaviour on real data is unchanged.
- [ ] New unit test `test/test-ci-verdict.ts` (add to `UNIT_TESTS` in `test/run.sh` **and** to `ci.yml`):
      `checks: []`, `ghFailed: true`, `completed: 3`, `failed: 0` → `"unknown"`; `ghFailed: true` with an all-green
      array → `"unknown"`; one `FAILURE` → `"failed"`; all `SUCCESS`/`SKIPPED` with `ghFailed: false` → `"passed"`;
      any `PENDING` → `"unknown"`.
- [ ] Route all three sites through the verdict: on `"unknown"` emit nothing and re-check next poll; notify "could not
      verify checks for PR N" only after N consecutive unknowns (reuse the existing `sendAgentMessage` path). Keep the
      `observedPRs.get(prNumber) !== pr` identity guards exactly where they are.
- [ ] **Verify:** test passes; `bash test/run.sh observe-pr observe-pr-resume`.

### B2. Unparseable CLI output is a failure (F3)

- [ ] `orca-client.ts:186-191`: on `JSON.parse` failure return
      `{ ok: false, error: { code: "BAD_JSON", message: parseErr.message, details: { raw: stdout.slice(0, 2048) } } }`
      — `OrcaEnvelope` (`orca-client.ts:14-22`) **already** declares `error?: { code?; message; details? }`, so no type
      change is needed; use the `parseErr` binding that is dead today.
- [ ] Callers in `orca-orchestration.ts` surface `BAD_JSON` as an error text instead of "no workers"/"no messages".
- [ ] New test `test/test-orca-client.ts` using `ORCA_CLI_COMMAND` pointed at a fixture that prints non-JSON
      (`test/fakes/orca-bad-json.sh`) → expects `ok: false` with `error.code === "BAD_JSON"`.
- [ ] **Verify:** `bash test/run.sh unit`.

### B3. Contain suggestion writes and validate line numbers (F5, F22-3)

- [ ] Add `resolveRepoFilePath(repoRoot: string, filePath: string): string` in `lib/github-review-threads.ts`: reject
      absolute paths and, after `path.resolve` + `realpath` of the existing ancestor, require the result to be inside
      `repoRoot` (`..`, symlink escape) — throw with a clear message.
- [ ] Add an explicit integer guard at the top of `applyCodeSuggestion` (`github-review-threads.ts:411`):
      `if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine > endLine) throw …`. Today
      `endLine: undefined` passes the range check (NaN comparison), `slice(startIdx, undefined)` spans to EOF and
      `splice(startIdx, NaN, …)` deletes nothing → the suggestion is inserted instead of replacing the reviewed lines.
- [ ] New unit tests in `test/test-pr-tasks-manager.ts` (or a new `test/test-review-thread-paths.ts` added to
      `UNIT_TESTS` + `ci.yml`): `../../outside.txt` throws; `/tmp/abs.txt` throws; `src/a.ts` resolves;
      `endLine: undefined` throws; `startLine > endLine` throws.
- [ ] **Verify:** `bash test/run.sh unit pr-tasks`.

---

## 4. Verification matrix (run in this order, paste into the PR body)

| Command | PR-A expected | PR-B expected |
| --- | --- | --- |
| `npm ci` | installs typescript + `@types/node` + pinned pi types | same |
| `npm run typecheck` | exit 0 (was 34 errors) | exit 0 |
| `bash test/run.sh manifest unit` | green + new unit files | green |
| `bash test/run.sh` (needs `pi` 1.3.0) | all suites green | all suites green |
| `npm run validate` | 27 checks green | green |
| manual: `/tools` overlay → PageUp/PageDown scroll; guidelines shown as lines | works (F22-1/2) | — |
| manual: dashboard opens, terminal resized, no `component.invalidate is not a function` | works (F4) | — |

## 5. Risks

| ID | Risk | Mitigation / decision point |
| --- | --- | --- |
| **R1** | Adding `@earendil-works/pi-*` to `devDependencies` puts a second copy of the package in this repo's `node_modules/`; extension files import bare specifiers, so a duplicate module instance could load at runtime (the globally installed pi sits outside this resolution tree) | Pin exact `1.3.0` (= CI's global install) and run **all** suites locally in A1 as the empirical check. If a duplicate instance is detected: revert to type-only resolution by installing the types in a scratch dir (`qa-types/`) and pointing `tsconfig.paths` there — the same isolation used to produce this review — and record the decision in `docs/` |
| **R2** | `typescript` 7.0.2 is a new major; error text/behaviour may differ from the run that produced the 34-error baseline | Baseline is re-captured in A1 on the exact pinned version; only error *count/sites* matter, not wording |
| **R3** | `details` additions change `renderResult` output and could break `test-tools-command.sh` / `test-pr-tasks.sh` assertions | Run those two suites after A2 (not just at the end); keep `content` text byte-identical, add only `details` |
| **R4** | `invalidate()` + line caching changes dashboard rendering | Cache keyed on width and invalidate on every state mutation, mirroring `tools.ts`; manual smoke per dashboard is in A3/A5 |
| **R5** | Fixing the dead `pageUp`/`pageDown` keys is a behaviour change inside a "mechanical" PR | Declared in the PR-A body with the footer hint, so it is not a surprise |
| **R6** | `engines` may warn for contributors on older Node | That is the intent (repo convention is ≥ 23.6); CI already uses 24 |
| **R7** | PR-A grows past reviewable size (19 call sites) | One commit per extension file (`tool-result`, then devin, observe-pr, orca, pr-tasks); reviewer can review file-by-file |

## 6. Sequencing and timebox

| # | Step | Est. |
| --- | --- | --- |
| 1 | A1 scaffolding + baseline recapture + full local suite run (R1 check) | 45 min |
| 2 | A2 helper + 19 `details` (4 commits) | 2–3 h |
| 3 | A3 `invalidate()` ×4 + caching | 45 min |
| 4 | A4 remaining type errors | 45 min |
| 5 | A5 CI `quality` job + `run.sh` suite + docs commit, PR open | 30 min |
| 6 | Independent review round (Antigravity for A) | async |
| 7 | B1 verdict extraction + test | 45 min |
| 8 | B2 BAD_JSON + fixture test | 45 min |
| 9 | B3 path containment + integer guard + tests | 1 h |
| 10 | Independent review round (Claude reviewer for B), tick #35 boxes | 30 min |

≈ one focused day, matching the #35 P0 estimate. Steps 2–4 are mechanically parallelisable per extension file if
delegated (one module per supervised worker, `npm run typecheck` + `bash test/run.sh unit` as the acceptance gate).

## 7. Closing out #35

After PR-B merges, tick in #35: all four "Contract fixes" boxes (incl. the three F22 sub-boxes), all three "Safety
fixes" boxes, and the three "Make it un-regressable" boxes — **except** `lint/format config`,
`check-quality.mjs`, the ratchet and `npm run qa`, which are P1. Update the body with:

```bash
gh issue view 35 --json body -q .body > /tmp/issue35.md   # flip "- [ ]" → "- [x]" for the closed P0 items
gh issue edit 35 --body-file /tmp/issue35.md
```

Leave a comment recording the resolved values so later phases have a baseline: typecheck error count (`34 → 0`),
`details` sites (`0/19 → 19/19`), `invalidate()` (`1/5 → 5/5`), suites green, CI job added.

## 8. Explicitly out of scope for P0

No ESLint/Biome rollout, no `check-quality.mjs`, no ratchet, no `AGENTS.md`/`.agent/rules`, no file splits
(`devin-delegate.ts` stays 2,540 lines), no `lib/exec.ts`/`lib/log.ts`, no `console.*` removal, no hermetic
Devin/Orca suites, no coverage tooling, no `test/**` in `tsconfig.include`. Adding any of these here means the typecheck
gate lands late — they are P1/P3 items in #35.

---

## 9. Execution record (P0 as implemented)

| Plan item | Result |
| --- | --- |
| A1 toolchain | `tsconfig.json` (strict, `noEmit`, `allowImportingTsExtensions`), `engines.node >= 23.6`, pinned devDeps, lockfile, `node_modules/` gitignored. Baseline recaptured: **34 errors**. R1 cleared — all suites green with pi packages installed locally |
| A2 `details` on 19 tools | done; **`tsc` 34 → 0** across `extensions/` |
| A3 `invalidate()` ×4 | done (no-op where nothing is cached; devin's transcript cache is dropped and re-read lazily) |
| A4 remaining type errors | done: dead `pageUp`/`pageDown`, `promptGuidelines[]`, `stage.activity`, implicit-`any` handler, `run-show` narrowed run id, `applyCodeSuggestion` contract |
| A5 CI + `run.sh` | `quality` job added (npm ci → typecheck → validate); `typecheck` suite added to `ALL_SUITES` (8 → 9); unit list now `npm run test:unit` in both places |
| B1 CI verdict | `lib/ci-verdict.ts` + 6 tests; both false-positive branches removed |
| B2 BAD_JSON | `execOrca` returns `error.code = "BAD_JSON"`; 4 tests against an `ORCA_CLI_COMMAND` fixture in tmpdir |
| B3 containment | `isInsideDir()` + `resolveRepoFilePath()` + integer/range guard + realpath re-check; 6 tests |

**Deviations from the plan, and why:**

1. **One PR, not two.** #35's P0 header says "one PR"; the two PRs the plan sketched would also have had
   to share a branch. Commits are split by finding so a reviewer can still drop one.
2. **`ok()`/`err()` were not forced onto every site.** Rule applied instead: single-text results go
   through `ok()`/`err()` (`pr-tasks.ts`, `observe-pr.ts`); multi-block template literals keep their
   literal and gain `details` from a file-local `toolDetails()` (`orca-orchestration.ts`,
   `devin-delegate.ts`), which also injects the run/session/queue counters once.
3. **`err()` is only used where the result already set `isError`.** `observe_pr`'s "invalid PR number",
   "PR don't exist" and "not observable" return plain text today; turning them into error results is a
   behaviour change, so they got `details.result` instead and keep their old `isError` semantics.
4. **"notify after N consecutive unknowns" (B1) was not implemented.** An unknown verdict is silently
   retried on the next poll and `allPassedReported` stays false, which is the safety-critical half.
   Follow-up if a noisy `gh` should become visible to the user.
5. **`execOrca` gained an `expectText` option** instead of failing on every non-JSON body:
   `orchestration worker-read` legitimately returns a terminal tail, which `formatWorkerOutput()`
   already handles as a string. Everything else now fails with `BAD_JSON`.
6. **An existing test encoded the vulnerability.** `test-pr-tasks-manager.ts` applied suggestions via an
   **absolute** path into a tmpdir, which only worked because absolute paths were accepted unchecked.
   It now runs inside a git repo with a relative path (`test/helpers/git-repo.ts`); the whole
   line-ending table is unchanged.
7. **F22-3 was overstated in the review** — corrected in `docs/extensions-code-quality-review.md`: the
   `endLine: undefined` path is not reachable from the current call site (`PRTask.line` is always
   filled in); the reachable defect there is the un-narrowed optional `suggestion`.

**Behaviour changes to check by eye in the PR:** `/tools` PageUp/PageDown scroll again and its
guidelines render one line each; the four dashboards survive `ui.custom()` invalidation; a failing
`gh pr checks` no longer produces "All CI passed"; `orca_orchestration_status` reports
`BAD_JSON`/`EXEC_ERROR` instead of an empty worker list.

**Counts after P0:** type errors `34 → 0`; unit tests `94 → 110`; CI suites `8 → 9`; tools returning
`details` `0/19 → 19/19`; dashboards implementing `invalidate()` `1/5 → 5/5`.
