# Pi Extensions — Code Quality Review & Improvement Plan

Scope: `extensions/*.ts` (7,322 lines, 5 entry files) and `extensions/lib/*.ts` (2,198 lines, 5 modules), plus the
quality gates around them (`package.json`, `test/run.sh`, `.github/workflows/ci.yml`, `scripts/validate-marketplace.mjs`,
`CLAUDE.md`).

How this was measured (all reproducible):

| Measurement | Method | Result |
| --- | --- | --- |
| Strict type errors | `tsc --noEmit --strict` against installed `@earendil-works/pi-coding-agent` (scratch copy in `/tmp/qc-check`, repo untouched) | **34 errors in `extensions/`** |
| Function/class size | brace-matching pass over all 10 files | 164 declarations, **12 over 100 lines, 3 over 200** |
| `any` usage | `grep -oE ':\s*any\|as any\|<any>'` | **145** occurrences |
| Empty `catch {}` | literal match | **48** |
| `execFileAsync` without `timeout` | grep of call sites | **29** |
| `pi.registerTool` sites | grep | **19** (all 19 fail the `details` contract, see F1) |
| `console.*` calls | grep | **23** |
| CI coverage | `test/run.sh` + `ci.yml` matrix | `devin-delegate` and `orca-orchestration` suites are **excluded from CI** |
| Verbatim duplication | normalized 5-line n-gram clusters across files | 1 cluster (the code is not copy-paste bloated; the duplication is *structural*) |

---

## 1. Verdict

| Dimension | Grade | Notes |
|---|---|---|
| Correctness of the happy path | **A-** | Logic is carefully reasoned; PR-task reconciliation is genuinely hard and handled well |
| Failure/edge-case handling | **B** | Excellent in `pr-tasks`/`lib`; weak in `checkAllCIPassed` (F2) and `execOrca` (F3) |
| Pi API contract conformance | **D** | 19/19 tools violate `AgentToolResult` (missing required `details`); 4/5 UI components violate `Component` (missing `invalidate`) |
| Architecture & size | **C** | 4 entry files >1,100 lines; no shared `exec`/`gh`/`log` layer; cross-extension coupling through untyped `globalThis` strings |
| Type safety | **C** | No `tsconfig.json`, so nothing is ever type-checked; 145 `any` |
| Tests | **B** | 94 fast unit tests are high quality; but 2 of 5 extensions have no CI coverage and the Pi-runtime suites are monolithic fail-fast scripts |
| Automated gates | **D** | Only manifest validation + unit tests. No typecheck, no lint, no format, no coverage, no `engines` |
| Docs for agents (rules) | **C+** | `CLAUDE.md` exists but has drifted (F19); no `AGENTS.md`, no Antigravity rules, no project skill for extension work |

One-sentence summary: **the logic is unusually well thought out and unusually well commented, but nothing in this repo
mechanically checks anything** — every class of defect below (contract violations, untyped JSON, hangs, drift) is exactly
what a 30-line CI job would have caught, and the same absence is why agent-driven changes will keep reintroducing them.

---

## 2. What is good (keep doing this)

- **Comments explain *why*, not *what*** — e.g. the stale-entry identity guards in `observe-pr.ts:473`, `observe-pr.ts:557`,
  `observe-pr.ts:753`, and the "A killed-then-replaced watcher must not touch the live entry" reasoning. This is the
  highest-value comment style and it is applied consistently.
- **`extensions/lib/pr-tasks-manager.ts` is a pure, deterministic core** (0 `any`, 0 `console`, 0 `await`) with 73 unit
  tests. This is the pattern the other extensions should be pulled toward.
- **`extensions/lib/github-review-threads.ts` fails loud on partial data** (`fetchReviewThreads` throws instead of
  returning a truncated page list, `github-review-threads.ts:189` "Refetching the first page would loop forever"), keeps
  `-f` vs `-F` semantics correct, and treats a timed-out mutation as possibly-applied (`runMutation`,
  `github-review-threads.ts:309`).
- **`checkWorktreeSafety` fails closed** on every ambiguity (`orca-client.ts:489` "Could not verify… unpushed: true").
- **Resource discipline is a real design concern** and mostly right: bounded output tails (`observe-pr.ts:545`),
  `unref()`'d escalation timers, process-group kills, listener teardown in `AcpClient.dispose()`
  (`devin-delegate.ts:295`), and `resetObserverState()` covering every timer/child.
- **Retry/idempotency thinking** in `resolveTaskLocked` (`pr-tasks.ts:407`) — a suggestion is never applied twice, a
  re-posted reply is detected, edited comments are shown before acting.
- `scripts/validate-marketplace.mjs` proves the repo *can* build its own gates — it just doesn't apply them to code.

---

## 3. Findings

### P1 — correctness & platform contract

**F1. All 19 registered tools violate `AgentToolResult` (required `details` is never returned).**
`AgentToolResult` declares `details: T` as **required** (`pi-agent-core/dist/types.d.ts:370`). Every `execute()` returns
`{ content: [...] }` only → 19 failing sites (`18 × TS2322` plus 2 mismatched `registerTool` argument objects at
`orca-orchestration.ts:1020-1021`; e.g. `devin-delegate.ts:1689`, `1804`, `1939`, `2061`, `2107`, `2263`; `observe-pr.ts:1198`, `1398`, `1439`; `pr-tasks.ts` tool sites; `orca-orchestration.ts` tool sites).
Impact: no structured payload for logs/`renderResult`/programmatic callers, a contract violation that only becomes a hard
break when pi tightens validation, and — because nobody runs `tsc` — it is invisible today.
Fix: add `extensions/lib/tool-result.ts`:
```ts
export const ok = (text: string, details: Record<string, unknown> = {}) =>
	({ content: [{ type: "text" as const, text }], details });
export const err = (text: string, details: Record<string, unknown> = {}) =>
	({ content: [{ type: "text" as const, text }], details, isError: true });
```
Replace all 19 sites; put the state each tool already computes into `details` (pr numbers, task ids, session ids, counts).

**F2. "All CI passed" can be announced when `gh` fails.** `checkAllCIPassed` catches *any* error from
`gh pr checks` and, if `completedRuns.size > 0 && failedRuns.size === 0`, declares success
(`observe-pr.ts:506-512`, message at `:510`). A rate limit / network blip / auth expiry after the last watched run therefore tells the agent
the PR is green — the single most expensive false positive in an agent loop (it is the signal to stop working / merge).
Fix: in the `catch`, only *skip* (optionally notify "could not verify checks"); never assert a passing state that was not
observed. Reserve the affirmative message for the validated branch.

**F3. `execOrca` converts an unparseable response into success.** `orca-client.ts:176-181` catches the `JSON.parse`
failure and returns `{ ok: true, result: stdout.trim() as any }` (`orca-client.ts:186-190`), and the `parseErr` binding is
unused. Combined with the shape-sniffing downstream (`formatWorkerOutput` tries 10 field shapes,
`orca-orchestration.ts:49-73`; `res.result.workers || res.result.rows || Array.isArray(...)` at
`orca-orchestration.ts:98` and `:556`; `data.result?.delivery || data.delivery || data.result || data` at
`orca-orchestration.ts:455`), a renamed Orca field
silently degrades to "no workers / no messages" instead of an error.
Fix: keep the raw text but return `{ ok: false, error: { code: "BAD_JSON", message, details: { raw } } }`; add
`lib/orca-schema.ts` with one typed adapter per command (`worker-list`, `run-list`, `check`) that validates with
`Value.Check` from `typebox` (already a peer dep) and names the missing field in the error.

**F4. Four UI components do not implement the `Component` interface (missing `invalidate`).**
`pi-tui`'s `Component.invalidate(): void` is required, and `TuiBase.invalidate()` calls
`overlay.component.invalidate()` **without** optional chaining. Missing in
`DevinDashboardComponent` (`devin-delegate.ts:356`), `PRObserverDashboardComponent` (`observe-pr.ts:81`),
`OrcaDashboardComponent` (`orca-orchestration.ts:161`), `PRTasksDashboardComponent` (`pr-tasks.ts:37`)
→ 4 × `TS2345` at the `ctx.ui.custom(...)` call sites. Today they are mounted via `editorContainer.addChild()`
(where `Container.invalidate()` uses `child.invalidate?.()`, so it survives), but as soon as one is shown with
`{ overlay: true }`, or pi routes a color-scheme/cell-size invalidation through the overlay stack, it throws
`TypeError: component.invalidate is not a function`. `tools.ts` is the only file that implements it
(`tools.ts:451`) and is also the only one caching render output — the others will render stale theme colors on a theme
switch if they ever start caching.
Fix: add `invalidate()` to all four; extract the shared chrome into `lib/tui.ts` (see §4).

**F5. `applyCodeSuggestion` writes to an unvalidated path derived from GitHub data.**
`github-review-threads.ts:420`: `path.isAbsolute(filePath) ? filePath : path.join(await repoRoot(cwd), filePath)`.
A `filePath` of `../../.ssh/authorized_keys` — or any absolute path — escapes the repository and is written by
`pr_task_resolve` with `accept_suggestion: true`, i.e. by an autonomous agent acting on remote review data. Low
probability, high impact, trivial fix:
```ts
const root = await repoRoot(cwd);
const absolutePath = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(root, filePath));
if (absolutePath !== root && !absolutePath.startsWith(root + path.sep))
	throw new Error(`suggestion path ${filePath} resolves outside the repository`);
```

**F6. The two largest extensions have no CI coverage at all.** `test/run.sh:8-11` documents that
`test-devin-delegate.ts`, `test-devin-delegate-lifecycle.ts` (real Devin sessions) and `test-orca-orchestration.sh`
(live Orca backend) are excluded, and `ci.yml:40-55` mirrors that. So `devin-delegate.ts` (2,540 lines: RPC client,
process groups, crash recovery) and `orca-orchestration.ts` (1,575 lines) can be changed freely and CI stays green.
Fix: add hermetic suites — `test/fake-acp-server.mjs` already exists, so drive `AcpClient` against it with
`DEVIN_COMMAND=<fake>` (make the binary name injectable via env, currently hard-coded at `devin-delegate.ts:137`);
for Orca, point `ORCA_CLI_COMMAND` (already honoured, `orca-client.ts:143`) at a fixture script and add a
`ci`-safe `orca-orchestration` suite. Both then join the CI matrix.

**F22. Three user-visible defects that exist only because nothing type-checks.** Running `tsc` surfaced bugs no test
or reviewer caught:
- **`/tools` PageUp/PageDown are dead keys** (`tools.ts:237`, `:243`): `matchesKey(data, "pageup")` / `"pagedown"` —
  pi-tui's `KeyId` union spells them `pageUp` / `pageDown` (`pi-tui/dist/keys.d.ts:32`), so neither branch can ever
  match, while the footer advertises scrolling. A one-character-casing fix.
- **`promptGuidelines` is rendered as a coerced array** (`tools.ts:401`): `ToolInfo.promptGuidelines` is
  `string[]` (`pi-coding-agent/dist/core/extensions/types.d.ts:463`), but it is passed straight to
  `wrapTextWithAnsi(…, safeWidth - 6)`, so the detail view shows comma-joined guidelines as one blob instead of lines.
- **`applyCodeSuggestion`'s range check cannot reject non-numeric input, and its call site has an
  unproven argument** (`pr-tasks.ts:573` → `github-review-threads.ts:411`): `endLine > lines.length ||
  startLine > endLine` is *false* when `endLine` is not a number, so the call proceeds —
  `slice(startIdx, undefined)` then spans the rest of the file and `splice(startIdx, NaN, …)` deletes
  nothing, inserting the suggestion instead of replacing the reviewed lines. Reaching that state from
  the current call site is *not* possible: `line` comes from `PRTask.line`, which the manager always
  fills in (`pr-tasks-manager.ts:678` `node.line || node.originalLine || 1`). What the compiler does
  flag there is the sibling argument: `suggestion` is optional, and its narrowing at `pr-tasks.ts:511`
  is reset by the awaits between the guard and the call, so nothing proves a suggestion still exists.
  Fixed in P0 by validating the range at the top of the function (contract, in case a future caller
  is less careful) and re-reading `task.suggestion` at the use site.

### P2 — structure, resilience, developer experience

**F7. No typecheck, lint, format or Node-version gate anywhere.** No `tsconfig.json`, no
eslint/biome/prettier config, no `.nvmrc`, no `engines` in `package.json`, no `devDependencies`. Node ≥ 23.6 is a
documented convention (`CLAUDE.md`) that nothing enforces, and `peerDependencies: "*"` (three entries) is unpinned while
CI installs `pi-coding-agent@^1.3.0` — so extensions can be developed against a pi API that CI never sees. This is the
root cause that makes F1/F4/F10 invisible and is the cheapest thing to fix (§5.3).

**F8. Four monolith entry files.** `devin-delegate.ts` 2,540 / `orca-orchestration.ts` 1,575 / `observe-pr.ts` 1,462 /
`pr-tasks.ts` 1,137. Each mixes: pi registration, external CLI drivers, state persistence, dashboards, and business
rules. Largest declarations: `PRTasksManager` 451 lines (`pr-tasks-manager.ts:87`), `ToolsManagerComponent` 381
(`tools.ts:71`), `AcpClient` 250 (`devin-delegate.ts:103`), `checkWorktreeSafety` 185 (`orca-client.ts:304`),
`resolveTaskLocked` 156 (`pr-tasks.ts:407`). Splitting plan in §4.

**F9. Duplicated turn-completion logic in `devin-delegate.ts` with a real divergence.** The
`session/prompt().then(...)` block at `devin-delegate.ts:1375-1404` (initial turn) and `devin-delegate.ts:2000-2025`
(`devin_message` turn) are ~30 near-identical lines — and only the first increments `totalCompleted++` (`:1381`).
So the dashboard/`PersistedState` completion count silently under-reports every follow-up turn. Fix: extract
`completeTurn(meta, { countCompletion })` and call it from both paths (the `.catch` branches at `:1405` and `:2026` are
the same story).

**F10. 29 `execFileAsync` calls with no timeout.** Notably in the polling hot paths: `gh pr view` in `pollPR`
(`observe-pr.ts:640`), `gh pr checks` in `checkAllCIPassed` (`observe-pr.ts:469`), `gh pr view <branch>` in
`checkTrackedBranches` (`observe-pr.ts:958`) and the observe-pr tool's own `gh pr view` (`observe-pr.ts:1257`).
`gh` hangs (keychain prompt, proxy stall) then block a `setInterval` callback forever, and the interval keeps firing →
one hung child per tick. `lib/github-review-threads.ts` already solved this (`FETCH_TIMEOUT_MS = 60_000`, comment:
"A hung gh call would otherwise block every sync"); the rest of the code base never adopted it. Same for
`git worktree add` (`devin-delegate.ts:1167`) and the 8 untimeouted `git`/`gh` calls in `checkWorktreeSafety`, which
guards destructive worktree removal.

**F11. Cross-extension coupling via undocumented `globalThis` strings.** `__PI_OBSERVED_PRS__`
(`observe-pr.ts:161`, re-exposed at `:1047`, deleted at `:1184`, read at `pr-tasks.ts:152`),
`__PI_ON_PR_POLL__` / `__PI_ON_PR_CLOSED__` (written `pr-tasks.ts:680-685`, read `observe-pr.ts:714` and `:662`),
`__PI_ON_PR_CLOSED_DEVIN__` (written `devin-delegate.ts:2407`, read `observe-pr.ts:657`), plus 5 `GLOBAL_GUARD_KEY`
duplicates. Signatures live only in comments; a mismatch is a
silent no-op (pr-tasks simply syncs nothing if observe-pr loads second). Fix: `extensions/lib/cross-extension.ts`
exporting typed accessors (`getObservedPRs()`, `onPRPoll()`, `onPRClosed()`, `withRegistrationGuard(name, fn)`) that own
the key strings and types in one place.

**F12. Hand-rolled concurrency state machines with implicit invariants.** `observe-pr.ts` carries ~10 module-level
mutable coordination values (`suppressUpdates`, `noticeAttached`, `noticeAttachedFor`, `noticeAttachBroken`,
`userTurnPending`, `sessionHasRun`, `disposed`, `isCheckingBranches`, `stateGeneration`, `startupCheck`) whose legal
combinations are explained only in prose, plus identity-guard comparisons repeated at 6 sites. `pr-tasks.ts` uses its
own `sessionId` generation counter (`pr-tasks.ts:123`, `:229`). These are correct-looking today and unmaintainable
tomorrow. Fix: (a) collapse to one explicit `AnnouncementState` object with a documented transition table;
(b) standardize on `AbortController`/generation tokens for "is my result still valid"; (c) table-driven unit tests over
`(state, event) → (state, effects)` — pure and fast, like the `pr-tasks-manager` tests.

**F13. Unstable comment IDs cause duplicate notifications.** `parseCommentInfo` falls back to
`index + 1` for the id (`observe-pr.ts:624`), so for comments without `id`/`databaseId` the identity depends on the
position in the response. Deleting/merging an earlier comment renumbers the rest → `!existing` → "Comment N added or
updated" spam to the agent, and `persistState()` persists the wrong ids. Fix: derive a stable key
(`updatedAt` + author + body hash) and never fall back to an index.

**F14. 48 silent `catch {}` and 23 direct `console.*` calls.** Many empty catches are deliberate, but the codebase has
no convention marking *why*, and `console.error` writes into the terminal of a TUI application
(`observe-pr.ts` ×9, `tools.ts` ×8, `orca-orchestration.ts` ×5, `pr-tasks.ts` ×3, `devin-delegate.ts` ×2), which can
corrupt rendering and is invisible after the fact. Fix: `lib/log.ts` with `log.error(scope, err)` routed to pi
diagnostics/a log file, and a gate that rejects `console.*` in `extensions/**`; require
`catch { /* reason */ }` (eslint `no-empty` with `allowEmptyCatch: false` + a comment allowance).

**F15. Pi-runtime test harnesses are monolithic fail-fast scripts.** `test-pr-tasks.ts` is 1,180 lines inside one
`export default async function`, running "Test 1…Test 44" sequentially, each ending in
`if (a || b || c || d) { console.log("✗ Test 38 Failed…"); process.exit(1) }` (e.g. `test-pr-tasks.ts:1032`, `:1134`).
A failure kills the run (no coverage of the remaining cases), and compound conditions don't say *which* sub-assertion
broke. `test-observe-pr.sh:4-38` also writes `test/test-temp-runner.ts` into the repo (not parallel-safe, `git status`
noise). Fix: a shared `test/harness.ts` exposing `check(name, fn)` / `expectText()` / `expectExit()` that collects
failures, prints a summary, and exits non-zero; generate temp runners under `os.tmpdir()`.

**F16. Repeated helper logic that belongs in one place.** Repo/branch/PR detection is implemented 4×
(`observe-pr.ts:896-920`, `pr-tasks.ts:163-170`, `devin-delegate.ts:1178-1210`, `orca-client.ts:335-395`);
`which`/`where` availability probing 2× (`observe-pr.ts:11-18`, `orca-client.ts:150-156`); `gh ... → JSON.parse`
unguarded at ~20 sites; prompt-guideline injection duplicated
(`observe-pr.ts:1139-1170`, `pr-tasks.ts:751-778`); 5 dashboard components re-implement the same box chrome,
windowing and footer (`tools.ts:289-320`, `observe-pr.ts:96-130`, `pr-tasks.ts:55-100`, `orca-orchestration.ts:161`,
`devin-delegate.ts:356`), each with its own hardcoded header width (`observe-pr.ts:106` uses `width - 28`,
`pr-tasks.ts:63` uses `width - 36`).
Fix: `lib/exec.ts` (`runJson(cmd, args, { schema, timeoutMs })`), `lib/git-repo.ts`, `lib/prompt.ts`
(`appendToSystemPrompt(event, text)`), `lib/tui.ts` (`dashboardFrame()`, `listWindow()`, `withInvalidate()`).

**F17. `render()` with side effects.** `tools.ts:411` mutates `this.detailsScrollOffset` inside `render()` to clamp
scroll; combined with the `cachedLines` fast path this makes rendered output depend on call order. Keep clamping in
`handleInput`/`invalidate`, or expose scroll as a derived value.

### P3 — hygiene

- **F18. Typos in agent- and user-facing strings**: `Stoping observing…` (`observe-pr.ts:654`, `:1248`),
  `PR ${n} don't exist` (`observe-pr.ts:1272`), `coments` in the injected system-prompt rule
  (`observe-pr.ts:1143`), `No pullrequest was created` (`devin-delegate.ts:1385`, `:2008`). These strings are re-emitted
  by the model, so they cost credibility and tokens. Also `PRObserver*` naming (`observe-pr.ts:68`, `:81`, `:408`).
- **F19. `CLAUDE.md` has drifted**: it states "Currently one plugin exists: `plugins/claude-basics`… `skills/claude-rule-creator/`
  scaffolded but not yet populated" (`CLAUDE.md:27`) while there are 3 plugins (`lsc-claude-basics`,
  `lsc-frontend-development`, `lsc-multiagent-development`) and `claude-rule-creator/SKILL.md` exists. Agent-facing docs
  that lie are worse than none — this is exactly the file every coding agent reads first.
- **F20. Uncached/never-invalidated caches**: `repoCache` (`github-review-threads.ts:45`) and `repoRootCache`
  (`:221`) never expire — fine within a session, wrong after an `origin` change; `theme: any` in 4 dashboards discards
  the real `Theme` type that `tools.ts:78` uses correctly.
- **F21. Magic numbers inline**: max visible rows 15 (`tools.ts:296`), details window 25 (`tools.ts:408`), output tail
  64 KiB (`observe-pr.ts:545`), 2 KB chunk flush (`devin-delegate.ts:1241`), RPC default 60 s
  (`devin-delegate.ts:211`), Orca default 30 s (`orca-client.ts:176`). Hoist to named constants at module top.

---

## 4. Target architecture

```
extensions/
  observe-pr.ts            # ≤250 lines: registerTool/registerCommand + event wiring only
  pr-tasks.ts              # ≤250 lines: same
  orca-orchestration.ts    # ≤250 lines: same
  devin-delegate.ts        # ≤250 lines: same
  tools.ts                 # ≤250 lines: same
  lib/
    exec.ts                # runJson(cmd,args,{schema,timeoutMs,maxBuffer}) / runText / isCommandAvailable
    log.ts                 # scoped logger (no console.* in extensions/)
    prompt.ts              # appendGuideline(event, text) — one systemPrompt/promptGuidelines/sections path
    git-repo.ts            # repoRoot / currentBranch / prForBranch (single implementation)
    cross-extension.ts     # typed registry for the 5 globalThis contracts + withRegistrationGuard()
    tui.ts                 # dashboardFrame(), listWindow(), withInvalidate(), typed Theme
    tool-result.ts         # ok()/err() -> AgentToolResult with details
    observe-state.ts       # PR observer state machine (pure) + persistence (v: 2)
    orca-schema.ts         # typed adapters for orca worker-list / run-list / check
    acp-client.ts          # extracted from devin-delegate.ts:103-353
    devin-state.ts         # PersistedState v:1 -> versioned, migration-safe
    devin-worktrees.ts     # createWorktree / detectPullRequest / cleanup
tests: keep test/*.ts, add test/harness.ts, plus fake binaries under test/fakes/
```
Rule of thumb: **entry files register; lib files decide.** Only `lib/*` touches `child_process`, reads env, or parses
external JSON — which is also what makes the logic unit-testable without Pi.

---

## 5. Keeping the quality: rules → gates → skills → agents → CI

Agents do not follow prose; they follow **cheap, fast, deterministic commands** and **the nearest instruction file**.
So the plan is five layers, cheapest first. Every layer below is a real file in this repo, not a policy document.

### 5.1 Layered model

| # | Layer | Answers | Fails how |
|---|---|---|---|
| 1 | Rules (`AGENTS.md`, `.agent/rules`) | "What invariants must my change hold?" | Model ignores it (that's why it is not layer 1's job to catch defects) |
| 2 | Deterministic gates (`npm run qa`) | "Is my change correct *right now*?" | Loud, local, sub-30-second |
| 3 | Skills (`pi` + Claude Code + Antigravity workflow) | "How do I do this task in *this* repo?" | Model skips → gates still catch |
| 4 | Agents/subagents | "Who reviews this independently?" | Cheap second opinion per PR |
| 5 | CI + PR loop (`ci.yml`, `observe_pr`, `pr_tasks`) | "Does main stay releasable?" | Hard block |

The order matters: put the machine in front of the prose. Today this repo has layers 1 and 5 only, and layer 5 has one
gate (`validate-marketplace.mjs`) plus unit tests.

### 5.2 Layer 1 — Rules: one file, three agents

`AGENTS.md` at the repo root is the vendor-neutral standard read by **pi**, Codex, Devin and Antigravity; pi loads
`AGENTS.md`/`CLAUDE.md` as context files (pi docs `configuration.md` §Context files — and it does **not** expand
`@imports`, so the file must stand on its own). Keep `CLAUDE.md` as a thin shim that imports it (Claude Code does
support `@` imports), so there is exactly **one** file to maintain:

```markdown
<!-- CLAUDE.md -->
@AGENTS.md

## Claude Code / Pi specifics
- Pi extensions and skills live outside `plugins/` (see AGENTS.md §Layout).
```

```markdown
<!-- AGENTS.md -->
# claude-marketplace — rules for coding agents

## Layout (do not move things)
- `extensions/*.ts` are Pi extensions; `plugins/*` are Claude Code plugins. Never move a Pi skill under `plugins/`.
- Entry files register with Pi (`registerTool`/`registerCommand`/events). Business logic and I/O live in `extensions/lib/*`.
- Only `extensions/lib/*` may import `node:child_process`, read `process.env`, or parse external JSON.

## Pi API invariants (violating these is a bug)
- Every `execute()` returns `AgentToolResult` **including `details`** — use `ok()`/`err()` from `extensions/lib/tool-result.ts`.
- Components returned from `ctx.ui.custom()` implement `render`, `handleInput` and **`invalidate()`**.
- Every external command goes through `runJson()`/`runText()` from `extensions/lib/exec.ts` — no direct
  `execFileAsync`/`spawn`, and always with a `timeoutMs`.
- Cross-extension communication only through `extensions/lib/cross-extension.ts` (no new `globalThis` keys).
- Persisted session state carries a `v:` field; bumping it requires a migration path in the same PR.
- Tool failures set `isError: true`; never report a successful state that was not observed (e.g. "All CI passed").

## Definition of done (run before opening a PR)
- `npm run qa` — typecheck + lint + format check + unit tests, all green.
- New/changed behaviour has a test in the suite that CI actually runs.
- If you edited `CLAUDE.md`-described structure, update `AGENTS.md` in the same commit.

## Hard no
- No new `any` in changed code; no `console.*` in `extensions/**`; no empty `catch {}` without a `/* reason */`.
- No `--track`/`sleep` polling loops for PR state; use the `observe_pr` tool.
```

Antigravity (workspace rules + workflows, Windsurf-style `.agent/` — verify the exact paths against the installed
build; if `.agent/rules` is not honored, put the always-on rule text in `AGENTS.md`, which Antigravity also reads):

```markdown
<!-- .agent/rules/pi-extensions.md -->
---
trigger: alwaysOn
---
Follow `AGENTS.md` at the repo root. Additional: run `npm run qa` before finishing;
do not edit `test/**`, `.github/**` or `package.json` unless the task explicitly asks.
<!-- .agent/rules/poison-checklist.md -->
---
trigger: glob
globs: extensions/**/*.ts
---
Checklist for Pi extension edits: `details` in every tool result; `invalidate()` on every component;
`runJson()` with `timeoutMs`; no `globalThis`; `isError` on failure paths; no unvalidated path writes.
```

Division of labour between rule files: **rules = invariants (short, always true)**, **skills = procedures (how to do X)**,
**agents = roles with tool budgets (who)**. Duplicating a procedure into rules is how rules rot.

### 5.3 Layer 2 — Deterministic gates (`npm run qa`)

1. `tsconfig.json` (strict, `noEmit`, `allowImportingTsExtensions`) — this alone turns F1/F4/F10-class drift into a
   3-second error. Add `devDependencies`: `typescript`, `@types/node`, `@biomejs/biome`. Start with
   `"strict": true` and fix the 34 current errors in one sweep (19 are the `details` fix, 4 the `invalidate` fix, the
   rest are `any`-adjacent); keep `noUncheckedIndexedAccess` off initially and enable it in a follow-up PR.
2. **`biome` (or eslint) flat config** with: `noExplicitAny: warn` (baseline-gated, see 4), `noEmptyInterface`,
   `noConsole: error` for `extensions/**`, `noUnusedVariables/Parameters`, formatter enabled
   (`tabWidth`/`useTabs` matched to the current style so the first run is a no-op).
3. `scripts/check-quality.mjs` — repo-specific invariants a linter can't express, in the spirit of the existing
   `validate-marketplace.mjs`:
   - every `pi.registerTool({...})` `execute` returns `details` (AST/regex + rely on `tsc`);
   - no `execFileAsync(`/`spawn(` outside `extensions/lib/*`, and always with `timeout`/`timeoutMs`;
   - no `globalThis` writes outside `extensions/lib/cross-extension.ts`;
   - no `console.` in `extensions/**`;
   - file-size budget (entry files ≤ 300 lines, `lib/*` ≤ 500) and declaration budget (≤ 150 lines/function);
   - every `SKILL.md`/`agents/*.md` has `name` + `description` (move here from the manifest script);
   - `pi.extensions` in `package.json` matches the files on disk (and vice versa).
4. **Ratchet, don't boil.** `scripts/quality-baseline.json` stores the current counts (`any: 145`, `emptyCatch: 48`,
   `untimedExec: 29`, `linesPerFile: {...}`); the gate fails only on an **increase**. This makes it safe to land the gate
   today with 100 % legacy debt and pay it down one PR at a time — the ratchet is what keeps agent-driven churn from
   re-inflating the numbers.
5. `package.json` scripts + `engines`:
```json
{
  "engines": { "node": ">=23.6" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check extensions test scripts",
    "check": "node scripts/check-quality.mjs",
    "qa": "npm run typecheck && npm run lint && npm run check && npm run test:unit && npm run validate"
  }
}
```

### 5.4 Layer 3 — Skills (the "how", loaded on demand)

Add one skill, published through the existing plugin mechanism so **Pi, Claude Code and Antigravity all get it**:

```
plugins/claude-basics/skills/pi-extension-quality/
  SKILL.md                       # procedure + reference to AGENTS.md invariants
  references/pi-contracts.md     # AgentToolResult.details, Component.invalidate, event order, session persistence
  references/reviewer-checklist.md
```
`SKILL.md` frontmatter description must name the triggers ("editing or reviewing `extensions/*.ts`, registering a Pi
tool/command, adding an observer/poller, touching timers or child processes"). Body = ordered procedure:
`npm run qa` → read `lib/` for an existing helper before writing one → apply the poison checklist (F1, F4, F5, F10, F11)
→ add/extend a test in a CI-run suite → report gate output in the PR body.
Also install it for local Pi use (`.pi/skills/pi-extension-quality/SKILL.md`) or declare it in `package.json` → `pi.skills`
so contributors get it by installing this very package. Keep Antigravity's copy as a **workflow** (procedure, not rule):

```markdown
<!-- .agent/workflows/code-quality-review.md -->
1. `npm run qa`; report every failing check verbatim.
2. Diff against `main`; for each touched file in `extensions/**` apply references/reviewer-checklist.md.
3. Look specifically for: missing `details`, missing `invalidate`, untimeouted exec, unvalidated JSON/path,
   new `globalThis` keys, timers/children without teardown, duplicated logic that belongs in `lib/`.
4. Post findings as inline review comments with `file:line`; do not edit code.
```

### 5.5 Layer 4 — Agents (independent reviewers, one per engine)

| Engine | Artifact | Role | Trigger |
|---|---|---|---|
| Claude Code | `plugins/claude-basics/agents/code-quality-reviewer.md` (read-only tools: read/grep/bash) | Contract + duplication review against `references/reviewer-checklist.md` | every PR touching `extensions/**` |
| Pi | `.pi/prompts/quality.md` → `/quality` slash command running `npm run qa` + self-review of the current diff | developer's in-session gate | manual, pre-push |
| Pi extension | `extensions/quality-gate.ts` — reuse the proven `agent_before_settle` pattern from `pr-tasks.ts:703`: if `npm run qa` failed after the last edit, feed the failure back instead of letting the agent settle; plus a `tool_call` hook that nudges when a `bash` call edits `extensions/**` without a later gate run | **hard loop-level enforcement**, the same mechanism that already forces PR-task resolution | automatic |
| Antigravity | `.agent/workflows/code-quality-review.md` (above) run from a fresh conversation, plus `.agent/rules/*` for invariants | second-model structural review | on request / weekly sweep |
| Devin / Codex | existing `devin_delegate` (`create_worktree: true`) with a *review-only* prompt, or a supervised Orca worker | independent debt reduction on one module at a time (e.g. "extract `lib/acp-client.ts`, keep tests green") | scheduled debt PRs |

Policy that makes the multi-agent setup worth its cost: the **author's engine never reviews its own diff** — Pi-authored
changes get the Antigravity or Claude reviewer and vice versa; both are instructed to report, not to fix, so the author
stays in context. Keep one reviewer per PR to avoid contradictory guidance; escalate to the second only for `lib/`
extractions and persistence-format changes.

### 5.6 Layer 5 — CI and the PR loop

Extend `ci.yml` (all cheap, all fast):

```yaml
  quality:                      # new job, runs first
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: node scripts/check-quality.mjs      # includes the ratchet
      - run: bash test/run.sh manifest unit
```
plus: `node-version` matrix `['23.6', '24']` (the documented floor is currently untested), a `pi-version` matrix
(`^1.3` and the previous minor) since `peerDependencies` are `*`, per-suite `if: always()` + a JUnit reporter so one
red suite doesn't hide the others, and a coverage floor for `extensions/lib/*` (`c8 --reporter=text-sky --check-coverage
--lines 80`) since that is where the pure logic lives. Finally add the two currently-excluded suites once F6 lands
(`DEVIN_COMMAND`/`ORCA_CLI_COMMAND` fixtures) and delete the "excluded on purpose" comment block instead of keeping it
as folklore.

PR loop mechanics that already exist and should be *required* in `AGENTS.md`: open the PR → `observe_pr` (never `gh`
poll loops) → resolve every `pr_tasks` conversation before finishing (already enforced by the settle gate) → the
reviewer agent's findings become PR conversations, so they are tracked by the same system.

### 5.7 Which engine for which work

- **Pi (this session's engine)** — day-to-day extension work: it owns the runtime being modified, can load and
  event-test extensions in-process, and its `observe_pr`/`pr_tasks` extensions close the PR loop.
- **Claude Code** — plugin/skill/agent authoring and rule maintenance (`claude-rule-creator`, `agents-md-maintainer`
  already exist in `plugins/claude-basics/skills/` — use them for exactly that job).
- **Antigravity** — independent structural review (no in-session bias, good at "this file does five things") and
  always-on `.agent/rules` enforcement for humans working in the IDE.
- **Devin / supervised Orca workers** — mechanical, well-bounded debt tasks in isolated worktrees (extract `lib/*`,
  convert `console.*` → `log.*`, add the hermetic ACP/Orca fixtures), one module per worker, tests as the acceptance
  gate.

---

## 6. Phased roadmap

| Phase | Deliverables | Fixes | Effort | Acceptance |
|---|---|---|---|---|
| **P0 — stop the bleeding (1 PR)** | `tsconfig.json` + `devDependencies` + `engines`; `lib/tool-result.ts` and `details` at all 19 tool sites; `invalidate()` on the 4 dashboards; fix F2 (no "All CI passed" on error); path containment F5; the three F22 one-liners (`pageUp`/`pageDown`, `promptGuidelines` lines, integer line guard); `quality` job in CI | F1, F2, F4, F5, F7-partial, F22 | 0.5–1 day | `npm run typecheck` exits 0; CI has a typecheck step; tests for "gh fails → no pass announcement" and "suggestion path outside repo → error" |
| **P1 — make it un-regressable (1–2 PRs)** | biome config + `scripts/check-quality.mjs` + `quality-baseline.json` ratchet; `npm run qa`; `.agent/rules/*`; `AGENTS.md` written, `CLAUDE.md` reduced to an import (fixes drift F19); `lib/{exec,log,git-repo,prompt,cross-extension,tui}.ts` introduced and adopted where the duplication lives | F7, F10, F11, F14, F16, F18, F19, F21 | 2–3 days | `npm run qa` green locally + in CI; `any`/empty-catch/untimed-exec counts equal or lower than baseline; no `globalThis` keys outside the registry |
| **P2 — restructure (one PR per extension, in this order: tools → pr-tasks → observe-pr → orca-orchestration → devin-delegate)** | split to the §4 layout; extract `lib/acp-client.ts`, `lib/devin-state.ts` (versioned), `lib/observe-state.ts` (explicit FSM + transition-table tests); fix F9 (`completeTurn`) and F13 (stable comment ids) | F8, F9, F12, F13, F20 | 3–5 days | each entry file ≤ ~300 lines; `PRTasksManager`-style pure core per extension; `completeTurn` used by both turn paths; new FSM tests in a CI-run suite |
| **P3 — coverage & independence (ongoing)** | hermetic `devin`/`orca` suites via `DEVIN_COMMAND`/`ORCA_CLI_COMMAND` fixtures; `test/harness.ts` refactor of the numbered harnesses; quality-gate Pi extension; reviewer agent + workflow + skill; node/pi version matrices; coverage floor | F6, F15 + layer 3–5 | 2–4 days, then incremental | every extension has at least one CI-run suite; a Pi-runtime test failure names the single failing assertion; `extensions/lib/*` coverage ≥ 80 % |

Suggested commit/PR granularity: P0 must land before any feature work (it is the smallest change that makes the rest
safe); P1 and P2 can interleave with features as long as the ratchet never loosens.

---

## 7. Appendix — evidence

Typecheck inventory (`tsc --noEmit --strict`, extensions only, 34 errors):

| File | Errors | Dominant cause |
|---|---|---|
| `orca-orchestration.ts` | 14 | missing `details` ×n, missing `invalidate`, `stage.activity` not in `OrcaWorkerRow` (`:131` → `TS2339`: read of an undeclared field, i.e. the adapter and the data already disagree) |
| `devin-delegate.ts` | 7 | missing `details` ×6 (`:1689`, `:1804`, `:1939`, `:2061`, `:2107`, `:2263`), `DevinDashboardComponent` not a `Component` (`:2514`) |
| `pr-tasks.ts` | 6 | missing `details` |
| `observe-pr.ts` | 4 | missing `details` ×3 (`:1198`, `:1398`, `:1439`), `PRObserverDashboardComponent` not a `Component` (`:1339`) |
| `tools.ts` | 3 | `details` on `/tools`-adjacent results |

Root-cause split: **19 × `details`**, **4 × `invalidate`**, 2 × dead `pageup`/`pagedown` key ids,
2 × `stage.activity` read outside the declared `OrcaWorkerRow` shape, 4 × implicitly-`any` handler params
(`orca-orchestration.ts:907`), 1 × `string[]`→`string`, 1 × `string | undefined` (F22).
Every one of these is a defect a `tsc` CI step would block for free.

Reproduce:
```bash
cp -r {extensions,test,scripts,package.json} /tmp/qc-check && cd /tmp/qc-check
npm i -D typescript @types/node typebox && npm i @earendil-works/pi-coding-agent
npx tsc --noEmit            # 34 errors, all in extensions/
bash test/run.sh unit       # 94 tests, currently green
node /tmp/m2.mjs extensions/*.ts extensions/lib/*.ts   # size + duplication pass (§"How this was measured")
```

Related existing docs (keep them linked from `AGENTS.md`): `docs/memory-leak-review.md`,
`docs/devin-delegate-reliability-plan.md`, `docs/observe-pr-resume-state-plan.md` — they already contain the reasoning
for most of the defensive code; the missing piece was never analysis, it was enforcement.
