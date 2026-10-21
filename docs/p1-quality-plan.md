# P1 execution plan — issue #35 "Make it un-regressable"

Plan for the **P1** section of #35, executed with the same flow that worked for P0 (#36): verify every
claim against the repo first, split the work so the gate lands before the code it governs, make each
step independently pickable with an acceptance command, then run the review loop
(author self-review → independent Devin/SWE review → fix → re-verify) until there are no findings and
CI is green on the head.

Everything below is **measured on `main` at `6fcb4e7`** (merge of #36), not copied from the issue text.
Where the two disagree, §1 says so and proposes the decision.

## 0. Baseline measured on main

### 0.1 Inventory (`extensions/**`, 13 files, 10,618 lines)

| file | lines | | file | lines |
| --- | --- | --- | --- | --- |
| `devin-delegate.ts` | 2603 | | `lib/pr-tasks-manager.ts` | 854 |
| `observe-pr.ts` | 1779 | | `lib/orca-client.ts` | 592 |
| `orca-orchestration.ts` | 1661 | | `lib/github-review-threads.ts` | 516 |
| `pr-tasks.ts` | 1276 | | `lib/devin-bash-guard.ts` | 276 |
| `tools.ts` | 611 | | `lib/gh-health.ts` | 259 |
| | | | `lib/devin-diagnostics.ts` | 65 |
| | | | `lib/ci-verdict.ts` | 69 |
| | | | `lib/tool-result.ts` | 57 |

### 0.2 `biome lint` with `recommended: true` only (biome 2.5.15)

| severity | count | rule |
| --- | --- | --- |
| error | 11 | `suspicious/noControlCharactersInRegex` — all 11 in `lib/devin-diagnostics.ts` (ANSI-stripping regexes) |
| error | 1 | `suspicious/noAssignInExpressions` — `observe-pr.ts:920` |
| warning | 147 | `suspicious/noExplicitAny` |
| warning | 8 | `suspicious/noGlobalIsNan` |
| warning | 6 | `style/noNonNullAssertion` |
| warning | 6 | `complexity/useOptionalChain` |
| warning | 1 + 1 | `correctness/noUnusedFunctionParameters`, `correctness/noUnusedImports` |
| info | 7 | `style/useTemplate` |

**12 blocking diagnostics today.** Everything else is warning-or-below, so `recommended` can gate CI
after two small commits (C1.2). Note `suspicious/noConsole` is **not** in `recommended`; it has to be
turned on explicitly (17 call sites today).

### 0.3 Repo-specific metrics (the ratchet's starting values)

| metric | measured | note |
| --- | --- | --- |
| explicit `any` (biome) | **147** | issue said 145; use biome's count as canonical |
| `console.*` in `extensions/**` | **17** | issue said 23 |
| empty `catch {}` | **49** | includes the 4 cross-extension handler calls that swallow every failure |
| `exec`/`spawn` call sites | **44** | of which **28 have no timeout** in the call: `devin-delegate.ts` 11, `lib/orca-client.ts` 10, `observe-pr.ts` 7 |
| `JSON.parse(` | **27** | `devin-delegate.ts` 9, `lib/github-review-threads.ts` 6, `observe-pr.ts` 6, `lib/orca-client.ts` 3, 1 each elsewhere |
| functions with cognitive complexity > 20 | **51** | `devin-delegate` 15, `observe-pr` 13, `orca-orchestration` 10, `pr-tasks` 4, `lib/devin-bash-guard` 3, `tools` 3, `lib/pr-tasks-manager` 2, `lib/orca-client` 1 |
| `globalThis` writes | **20** (11 assignments + 9 `delete`) | 5 registration guards + 5 shared keys; the 5 `if ((globalThis …)[K])` reads are **not** writes. (The first draft of this plan said 15, which counted reads and deletes loosely — `check-quality` is the source of truth.) |

### 0.4 Duplication inventory (measured, current line numbers)

| duplication | sites |
| --- | --- |
| registration-guard block (`if (globalThis[…]) return; …`) | 5 — keys `__PI_{OBSERVE_PR,PR_TASKS,DEVIN_DELEGATE,ORCA_ORCHESTRATION,TOOLS}_EXTENSION_ACTIVE__`, 20 mentions of `GLOBAL_GUARD_KEY` |
| shared `globalThis` keys | `__PI_OBSERVED_PRS__` (`observe-pr.ts:192,1250,1448` + `pr-tasks.ts:173`), `__PI_ON_PR_POLL__` (`observe-pr.ts:844,846` + `pr-tasks.ts:769,880`), `__PI_ON_PR_CLOSED__` (`observe-pr.ts:792,794` + `pr-tasks.ts:773,881`), `__PI_ON_PR_CLOSED_DEVIN__` (`devin-delegate.ts:1657,2470` + `observe-pr.ts:787,789`), `__PI_GH_HEALTH__` (written at `pr-tasks.ts:767` — the health singleton is published by an extension, not by `lib/gh-health.ts`) |
| git repo root / branch | `observe-pr.ts:1081` (`--show-toplevel`), `:1093` (`branch --show-current`), `lib/github-review-threads.ts:227`, `devin-delegate.ts:1098,1127,1133,1213`, `lib/orca-client.ts:389,492` |
| `which`/`where` availability probe | `observe-pr.ts:17`, `lib/orca-client.ts:162`, `devin-delegate.ts:598` (issue said two) |
| `before_agent_start` prompt-append block | `observe-pr.ts:1400`, `orca-orchestration.ts:709`, `pr-tasks.ts:864` (~37 lines each, three near-identical string builders) |

### 0.5 Formatter drift by `lineWidth` (tabs, `assist` off, 13 files)

| lineWidth | 80 | 100 | 110 | **120** | **140** | 160 | 200 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| files rewritten | 13/13 | 13/13 | 12/13 | 12/13 | 12/13 | 12/13 | 13/13 |
| lines changed | 4,634 | 2,519 | 1,847 | 1,542 | **1,458** | 1,530 | 1,707 |

## 1. Five assumptions in #35 that the measurements falsify — decision gates

These need a yes/no before code, because each one changes what lands.

**D1 — "formatter enabled … so the first run is a no-op" is false.**
No `lineWidth` makes biome agree with the current tree: the best case (`140`) rewrites **12 of 13 files,
1,458 lines**. Options:

- **(a)** one dedicated `style: apply biome` commit now — honest, but it collides with every other PR
  touching these files and buries `git blame`;
- **(b)** land `lint` now and enforce `format` **only on files touched by the PR** (`check-quality.mjs`
  diffs against `origin/main`, runs `biome format --write` on that set, fails if it changed anything);
- **(c)** don't enable the formatter at all.

**Recommendation: (b)**, with the config already carrying `lineWidth: 140`, `indentStyle: "tab"`, and a
`.git-blame-ignore-revs` file created the day a full sweep is taken deliberately. Cost: one command to
learn (`npm run format`), zero churn today. Needs your sign-off, since it is the difference between
"the repo is formatted" and "changed code is formatted".

**D2 — the absolute file-size budget (entries ≤ 300, `lib/*` ≤ 500) is unreachable today.**
Entries are 611–2,603 lines and `lib/pr-tasks-manager.ts` is 854. As an absolute gate it fails on
commit one. **Recommendation:** ship it as a **ratcheted** budget in `quality-baseline.json` (per-file
line count may only shrink) and let the P2 splits take it down; keep the *absolute* numbers as the
target recorded in `AGENTS.md`, enforced the day the splits land.

**D3 — "≤ 150 lines per declaration" is the wrong metric.**
It needs a hand-rolled brace parser (false positives around template literals are guaranteed) and it
passes the code that actually hurts. **Recommendation:** use biome's
`complexity/noExcessiveCognitiveComplexity` (measured: **51** functions above 20) inside the ratchet,
and skip the line-per-declaration rule entirely.

**D4 — `Value.Check` from `typebox` does not exist in the pinned version.**
`import { Value } from "typebox"` → not exported (verified in Node). The working import is
`import { Check } from "typebox/value"` (verified: `Check` is a function). Unresolved: whether pi's
loader (which virtualises `typebox` to its bundled copy — verified in P0) resolves the **subpath**
`typebox/value`. **Recommendation: C2.0 is a spike** — run a `pi -ne -e` file that calls
`Check(Type.Object({...}), value)` and record the answer in §12 before any migration depends on it. If
it fails, `lib/exec.ts` carries ~40 lines of hand-written validators instead, and the schemas stay
type-only.

**D5 — `noConsole` must be turned on explicitly, and cannot be `error` until C2.2 lands.**
17 sites today, all of them `console.*` writing into a live TUI. Order: land lint with `noConsole:
"warn"` + ratchet (C1), migrate to `lib/log.ts` (C2.2), then flip to `error` in the same commit that
removes the last call.

## 2. Branch and PR strategy

Three PRs, strictly in this order — the gate lands before the code that has to satisfy it, exactly as
in P0.

| PR | contents | behaviour change | depends on |
| --- | --- | --- | --- |
| **C1 — Deterministic gates** | biome config + dep, `scripts/check-quality.mjs`, `scripts/quality-baseline.json`, `npm run qa`, CI `quality` job extended, two tiny lint-error fixes | none (the two fixes are semantics-preserving) | main |
| **C2 — External-call hygiene** | `lib/exec.ts`, `lib/log.ts`, `lib/git-repo.ts`, `lib/orca-schema.ts`, migrations, head-SHA scoping | yes, deliberately (timeouts, validated output, logged failures) — every change test-first | C1 |
| **C3 — Cross-extension contracts + agent rules** | `lib/cross-extension.ts`, `lib/prompt.ts`, `AGENTS.md`, `CLAUDE.md` reduction, `.agent/rules/*`, frontmatter-check relocation | low (typed accessors replace untyped slots) | C1 (C2 not required, but rebase onto it if it lands first) |

Branch names: `lucasschirm-app/qa-p1-gates`, `…/qa-p1-exec`, `…/qa-p1-contracts`.

Why C1 first: after the gate exists, every line written in C2/C3 is written under it, so C2/C3 land
with zero lint debt instead of a cleanup commit at the end. C1 itself must stay small — it is the only
PR allowed to touch config without touching logic.

---

## 3. PR-C1 — Deterministic gates

### C1.1 Add biome and the config (1 commit, no `extensions/` edits)

- Add `@biomejs/biome` **exact pin `2.5.15`** to `devDependencies` (biome ships platform binaries via
  optional deps; `npm ci` handles it — verify the lockfile has no `npm audit` blockers), regenerate
  `package-lock.json`.
- Add `biome.json` at the repo root:
  - `files.includes`: `extensions/**`, `scripts/**`, plus `test/**` **only if** measuring `test/**`
    drift (do it in this step and paste the number in the commit message) stays under ~400 lines;
    otherwise `test/**` joins later.
  - `formatter`: `enabled: true`, `indentStyle: "tab"`, `lineWidth: 140` (measured minimum-drift, §0.5),
    `assist.organizeImports: off` (import-order churn is a separate decision).
  - `linter.rules`: `recommended: true`; `suspicious.noExplicitAny: "warn"`;
    `suspicious.noConsole: "warn"` (→ `error` in C2.2);
    `correctness.noUnusedVariables: "error"`, `correctness.noUnusedFunctionParameters: "warn"`
    (biome 2.x names: `noUnusedFunctionParameters`, **not** `noUnusedParameters` — verified against
    `configuration_schema.json`; both live in `correctness`);
    `complexity.noExcessiveCognitiveComplexity: ["error", { maxAllowedComplexity: 20 }]` **with the
    ratchet**, since 51 functions exceed it today.
  - `overrides` for `extensions/lib/devin-diagnostics.ts` turning `noControlCharactersInRegex` off with
    a one-line reason (ANSI stripping *is* control characters) — one override beats 11
    `// biome-ignore` comments, and unlike the comments it cannot drift away from the file.
- Add `.git-blame-ignore-revs` with a header comment and no SHAs yet (the day D1(a) is taken, its SHA
  goes in).

**Accept:** `npx biome --version` prints 2.5.15; `npx biome lint extensions` reports exactly the 12
known errors and 169/7 warnings-infos of §0.2 — the numbers must match §0.2, which proves the config is
the one that was measured.

### C1.2 Land the 12 recommended errors clean (2 commits)

- `observe-pr.ts:920` `noAssignInExpressions`: rewrite the assign-in-condition into an explicit
  statement. Must be visibly semantics-preserving; note the surrounding control flow in the message.
- `lib/devin-diagnostics.ts`: the `overrides` entry from C1.1 already covers it — commit it here so the
  suppression is reviewed on its own, with the reason in the config comment.

**Accept:** `npx biome lint extensions` → **0 errors**; warnings/infos unchanged (147 + 8 + 6 + 6 + 2,
7 info). Any change in the warning count means the fix changed something it should not have.

### C1.3 `scripts/quality-baseline.json` + ratchet semantics (1 commit)

Shape:

```json
{
  "generatedFrom": "<sha>",
  "metrics": { "biome.suspicious/noExplicitAny": 147, "execCallsWithoutTimeout": 28, "...": 0 },
  "files": { "extensions/devin-delegate.ts": { "lines": 2603, "cognitiveOver20": 15 } },
  "notes": []
}
```

Ratchet semantics — the part that decides whether this survives contact with a deadline:

- every metric may only stay equal or **shrink**;
- a shrink is **written back automatically** by `npm run qa:baseline` (so the baseline never goes stale
  and a good-faith cleanup can't be "restored" later);
- an increase fails the gate with the offending metric, the count, the file, and the command to
  reproduce; the only way past it is `npm run qa:baseline -- --reason "<why>"`, which **appends to
  `notes`** — so a raise is always a visible, attributable line in the diff (that is the whole design:
  the ratchet cannot be quietly widened);
- `--check` for CI, no write-back in CI.

**Accept:** `node scripts/check-quality.mjs --check` exits 0 on a fresh clone; raising a threshold in a
scratch commit without `--reason` fails; `git diff` of a `--reason` run shows the `notes` line.

### C1.4 `scripts/check-quality.mjs` (2–3 commits, one per invariant)

Each invariant is its own function, its own `--only <name>` selector, and its own message naming the
file and line. No invariant may shell out to a tool that isn't a devDependency.

1. **exec discipline (`F10`)** — no `execFileAsync(`/`execFileSync(`/`spawn(` outside
   `extensions/lib/**`; every call inside `lib/**` must pass `timeout`/`timeoutMs` in the call or via a
   constant the checker can see. Baseline: 28 untimeouted sites (all in `lib/**` already or in
   `devin-delegate.ts`, which migrates in C2) — ratcheted, and **new** sites fail immediately.
2. **`res.ok` discipline** (P0 follow-up) — a call to a mutating command (`worker-stop`,
   `worker-release`, `gh pr review`, `git push`, …) whose result is not bound to a variable is an error.
   This is the rule that would have caught `/orchestration stop` announcing success on a failed call.
3. **`globalThis` ownership (`F11`)** — no `globalThis` write outside `extensions/lib/cross-extension.ts`
   (after C3) — until C3 lands, `extensions/lib/**` only, ratcheted from 15.
4. **no `console.` in `extensions/**` (`F14`)** — reported by biome; `check-quality` additionally fails
   on `process.stdout.write` and `process.stderr.write`, which biome does not see (measured today: **0**
   of each, so this invariant is purely preventive — it costs nothing and closes the door on the
   "writes into a live TUI" problem arriving by another route).
5. **file budget (`F8`, per D2)** — per-file line counts from the baseline, may only shrink; the
   absolute numbers from the issue are recorded as targets in the report output, not enforced.
6. **manifest ↔ disk** — `package.json` → `pi.extensions` matches `extensions/*.ts` **both directions**
   (today `scripts/validate-marketplace.mjs` does not check this at all — verified: it never mentions
   `pi.extensions`), and every `extensions/lib/*.ts` is imported by at least one entry file (a lib no
   entry imports is dead code; this is the same class of bug as an orphaned test, which `test/run.sh`
   now catches for tests).
7. **frontmatter** (`SKILL.md` / `agents/*.md` need `name` + `description`) — moved out of
   `validate-marketplace.mjs` per the issue; `validate` keeps manifest structure. Split rationale goes in
   both script headers so the next reader can find the check.
8. **no orphaned tests** — kept in `test/run.sh` (already shipped in P0); `check-quality` does not
   duplicate it, it just runs the runner's check once so `npm run qa` covers it.

**Accept:** `node scripts/check-quality.mjs --list` prints all 8; each `--only <name>` exits 0 on main;
for each invariant there is a fixture commit in the PR that makes it fail (this is the P0 lesson: an
assertion that cannot fail is not a test).

### C1.5 `npm run qa` (1 commit)

```
"lint": "biome lint extensions",
"format": "biome format --write extensions",
"format:check": "node scripts/check-quality.mjs --only changedFormat",
"check": "node scripts/check-quality.mjs --check",
"qa:baseline": "node scripts/check-quality.mjs --write",
"qa": "npm run typecheck && npm run lint && npm run check && npm run validate && npm run test:unit"
```

Add a `lint` and a `check` suite to `test/run.sh` (so `bash test/run.sh` covers them and CI inherits
them), and a `qa` alias suite is *not* added — `qa` is the fast loop, `run.sh` is the full one.

**Accept:** `npm run qa` green locally; removing `node_modules/.bin/biome` fails the `lint` suite with a
message naming `npm install` (same shape as the P0 `typecheck` suite fix).

### C1.6 CI (1 commit)

Extend the existing `quality` job — it already runs first and both other jobs are `needs: quality`:
`npm ci` → `npm run typecheck` → `npm run lint` → `npm run check` → `npm run validate`.
Keep one job: these are all sub-10-second steps against the same install.

**Accept:** a scratch PR with one `console.log` added to `extensions/tools.ts` turns CI red **in the
quality job only**, in under a minute (biome flags it as an error once C2.2 flips the rule; until then
use an `any`-free recommended error such as `noAssignInExpressions` to prove the path).

---

## 4. PR-C2 — External-call hygiene

### C2.0 Spike: `typebox/value` inside pi's loader (30 min, results into §12)

`test/test-spike-typebox.ts` run as `pi -ne -e test/test-spike-typebox.ts --offline -p "test"`:
import `Type` from `typebox` and `Check` from `typebox/value`, validate a literal, assert. Record:
resolved (keep going), or failed (switch `lib/exec.ts` to hand-written validators and mark the schema
boxes as "typed schemas, runtime checks by hand"). Delete the spike file after recording, or promote it
to a suite if it passes — that decision and its reason go in the execution record.

### C2.1 `lib/exec.ts` (3–4 commits)

- `runJson(cmd, args, { schema?, timeoutMs, maxBuffer?, env?, cwd? })` → `{ ok: true, result } |
  { ok: false, error: { code, message, details? } }`, codes `EXEC_ERROR` / `TIMEOUT` / `BAD_JSON`
  (same taxonomy `orca-client.ts` already uses, so existing callers keep working), and
  `runText(...)` for the `expectText` case.
- **`timeoutMs` is required with no default** — a call that wants to be slow passes a big number; a call
  that forgot cannot hang the extension. This is the actual fix for the 28 untimeouted sites.
- Migrate in this order, each with its own commit and its own test:
  1. `orca-client.execOrca` (already envelope-shaped, already covered by `test-orca-client.ts` +
     `test-orca-status.ts` → a clean refactor with a safety net),
  2. the git helpers (as part of C2.3, they become `lib/git-repo.ts` internals),
  3. the `gh` sites in `observe-pr.ts`, `pr-tasks.ts`, `github-review-threads.ts`
     (`JSON.parse` count 27 → target: only `lib/exec.ts` parses),
  4. `devin-delegate.ts` (11 untimeouted sites; the file is 2,603 lines, so this migration is the
     shallowest possible: swap the call, keep the handling).
- Availability probes (`which`/`where`, 3 sites) move here as `hasBinary(name)`.

**Accept:** `grep -c "JSON.parse" extensions/**.ts` == 1 (`lib/exec.ts`); `check-quality --only
execTimeout` reports **0** untimeouted sites; every migration commit keeps the suite it belongs to
green (`observe-pr`, `pr-tasks`, `tools`, `unit`).

### C2.2 `lib/log.ts` + the last `console.*` (2 commits)

- `logError(where, err)`, `logInfo(text)` appending JSON lines to
  `join(os.homedir(), ".local", "state", "pi-extensions", "extensions.log")`, size-capped (truncate at
  ~1 MiB by rewriting), `PI_EXT_LOG=1` mirrors to stderr for debugging. Never to stdout: stdout is the
  TUI's.
- Replace all **17** `console.*` sites; for the ones currently used as user-facing messages, use
  `ctx.ui.notify(..., "error")` instead of the log — say in the commit which sites changed audience,
  because that is a visible behaviour change.
- Then `noConsole: "error"` in `biome.json` **in the same commit** as the last removal, so the gate is
  never red on main.
- Empty catches: the 49 `catch {}` get triaged — each becomes either a reason comment
  (`catch { /* best-effort: the poll must not die over one bad row */ }`) or real handling. Start with
  the 4 cross-extension handler invocations (`observe-pr.ts:787,792,844`, `pr-tasks.ts` mirrors): a
  swallowed handler error today means `pr-tasks` silently stops cleaning up after merged PRs.

**Accept:** `npx biome lint extensions` → 0 errors with `noConsole: error`; `grep -rn "console\."
extensions` → 0; `grep -rc "catch {}"` ≤ the new baseline and every remaining one carries a comment
(enforced by a `check-quality` invariant).

### C2.3 `lib/git-repo.ts` (2 commits)

`repoRoot(cwd)`, `currentBranch(cwd)`, `prForBranch(cwd, branch)` built on `runJson`/`runText`,
replacing: `observe-pr.ts:1081,1093`, `lib/github-review-threads.ts:227`, `devin-delegate.ts:1098,1127,
1133,1213`, `lib/orca-client.ts:389,492`. Note the four variants disagree on `--abbrev-ref HEAD` vs
`--show-current` and on detached-HEAD behaviour — the unified version returns `undefined` for a detached
HEAD and documents it, which is what the two callers that compare against a branch name need.

Tests: real throwaway git repos via `test/helpers/git-repo.ts` (exists; now also registers tmpdirs for
cleanup) covering: normal branch, detached HEAD, not-a-repo, nested cwd.

**Accept:** one definition each (`grep -c "rev-parse" extensions/**` drops to `lib/git-repo.ts` only);
new unit tests pass; `observe-pr`, `pr-tasks` suites unchanged.

### C2.4 `lib/orca-schema.ts` (2 commits)

Adapters for `worker-list`, `run-list`, `check` replacing the shape sniffing
(`orca-orchestration.ts:49-73`, `:98`, the reconciliation loop, and the `stage.activity` read) with
tolerant-by-default validators: unknown fields ignored, missing optional fields → `undefined`, and a
malformed **row** drops that row with a `logError`, it does not empty the whole list (that is the
`BAD_JSON` lesson from #36 applied one level down: a partial answer must not look like "nothing
running").

Fixtures captured from a real backend go in `test/fixtures/orca/*.json` — **needs one live capture**;
if none is available, the adapters are built against the current sniffing behaviour's tests instead and
§12 records that the fixture capture is still owed.

**Accept:** `formatAllWorkersAndRuns` and the reconciliation loop read only through the adapters;
`test-orca-status.ts` still passes; a fixture with one malformed row keeps the other rows visible.

### C2.5 Head-SHA scoping of the CI-pass fallback (1 commit, test-first)

The `evaluateCiVerdict` empty-check-list fallback trusts `completedRuns`/`failedRuns`, which are not
keyed by commit. Record the head SHA next to each observed run (`gh pr view --json headRefOid`, already
fetched by the poll) and let the fallback trust only entries for the SHA being polled.

**Accept:** new test in `test/test-ci-verdict.ts` (run recorded for SHA A, polled at SHA B → `unknown`,
not `passed`); `observe-pr-gh-failure` suite still green.

---

## 5. PR-C3 — Cross-extension contracts and agent-facing rules

### C3.1 `extensions/lib/cross-extension.ts` (2 commits)

Owns the five `globalThis` keys with **typed** accessors, following the pattern `lib/gh-health.ts`
already sets (a lib owns the singleton; extensions import it):

- `getObservedPRs(): ReadonlyMap<number, ObservedPROutline>`
- `onPRPoll(handler: (pr: number, cwd: string) => void): () => void`
- `onPRClosed(handler: (pr: number, state: string, cwd: string) => void): () => void`
- `onDevinPRClosed(handler: (pr: number, state: string) => void): () => void`
- `withRegistrationGuard(name: string, register: () => void): void`
- `getGhHealth()` — moves the write at `pr-tasks.ts:767` into `lib/gh-health.ts` (the singleton's own
  module), which also removes the oddity that an unrelated extension publishes it.

The point is not tidiness: the handlers are called across extension boundaries with `typeof … ===
"function"` and `try { … } catch {}`, so a **signature mismatch is currently invisible** — one
extension passing `(pr, cwd)` where the other expects `(pr, state, cwd)` fails silently. Typed
registration makes that a compile error, which is the acceptance criterion.

**Accept:** `grep -rn "globalThis" extensions/*.ts` → 0 (all access is through the lib);
`check-quality --only globalThis` → 0 outside the lib; a scratch commit that registers a handler with
the wrong arity fails `npm run typecheck`; load order cannot change behaviour (assert in a suite:
`pr-tasks` alone, then `observe-pr` alone, then both — no missing-handler warnings).

### C3.2 `lib/prompt.ts` (1 commit)

`appendToSystemPrompt(event, text)` replacing the three `before_agent_start` blocks
(`observe-pr.ts:1400`, `orca-orchestration.ts:709`, `pr-tasks.ts:864`). Keep each extension's text
byte-identical so the diff is obviously text-preserving; the block differences (trailing newlines,
heading style) get normalised in a second commit that says so.

**Accept:** the three handlers are 3–5 lines each; a suite asserts each extension's prompt contribution
still contains its own tool-usage lines.

### C3.3 `AGENTS.md` at the repo root (1 commit)

Standalone file (verified: pi documents `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` discovery in
`docs/configuration.md:18` and **nowhere** mentions expanding `@imports` — so references must be paths
an agent opens, not includes). Contents:

- layout rules (entries stay thin; anything shared goes in `lib/`; nothing imports across entries);
- Pi invariants learned the expensive way, one line each with its `docs/` link: `details` is required on
  every tool result; `Component.invalidate()` is required; never treat a failed CLI call as an empty
  result; `globalThis` slots belong to `lib/cross-extension.ts`; every exec must carry a timeout;
- definition of done: `npm run qa` green, `bash test/run.sh` green, new tests wired (runner enforces),
  a test for every behaviour change, PR body states behaviour changes;
- the hard "no" list: no new `any` in touched code, no `console.*`, no secrets in `details`,
  no absolute paths from external input written without containment, no `--force` on destructive
  commands without an explicit user ask;
- links to `docs/`: `memory-leak-review.md`, `devin-delegate-reliability-plan.md`,
  `observe-pr-resume-state-plan.md`, `pr-monitoring-gh-failure-handling-plan.md`,
  `extensions-code-quality-review.md`, `p0-quality-plan.md`.

### C3.4 Reduce `CLAUDE.md` and fix its drift (1 commit, same PR)

Measured drift: `CLAUDE.md` still says *"Currently one plugin exists: `plugins/claude-basics` … it has a
`skills/claude-rule-creator/` directory scaffolded but not yet populated with a `SKILL.md`"*. There are
**three** plugins (`claude-basics`, `frontend-development`, `multiagent-development`) and
`claude-rule-creator/SKILL.md` **exists**. Replace with `@AGENTS.md` (Claude Code does expand imports;
pi does not, which is why the content lives in `AGENTS.md`) plus the Claude/Pi-specific notes that do
not belong in the shared file.

**Accept:** no statement in `CLAUDE.md` contradicts `ls plugins/*`/`ls plugins/*/skills/*`; the P0 gate
still validates manifests.

### C3.5 Antigravity workspace rules (1 commit)

`.agent/rules/pi-extensions.md` (`trigger: alwaysOn`, points at `AGENTS.md`, adds "run `npm run qa`
before finishing") and `.agent/rules/poison-checklist.md` (`trigger: glob`,
`globs: extensions/**/*.ts`) listing the mechanically-checkable items: `details` on tool results,
`invalidate()`, containment of external paths, exec timeouts, `res.ok` checks, no `globalThis` writes.
`.agent/` does not exist today (verified) — this creates it.

### C3.6 Script split bookkeeping (1 commit)

Move the skill/agent frontmatter checks into `check-quality.mjs` (issue box), keep manifest structure in
`validate-marketplace.mjs`, and cross-reference both script headers so the next reader can find a check
by name. Update `CLAUDE.md`'s "Validating changes" section accordingly.

---

## 6. Verification matrix (run in this order; paste the table into the PR body)

| # | command | expected |
| --- | --- | --- |
| 1 | `npm ci` | clean install, lockfile unchanged |
| 2 | `npm run typecheck` | 0 errors |
| 3 | `npx biome lint extensions` | 0 errors; warnings == baseline |
| 4 | `node scripts/check-quality.mjs --check` | exit 0, no metric above baseline |
| 5 | `npm run validate` | exit 0 |
| 6 | `npm run qa` | exit 0 |
| 7 | `bash test/run.sh` | all suites green, **0** leftover tmpdirs |
| 8 | `grep -c "JSON.parse" extensions/*.ts extensions/lib/*.ts` | only `lib/exec.ts` non-zero |
| 9 | `grep -rn "console\." extensions` | 0 (after C2.2) |
| 10 | `grep -rn "globalThis" extensions/*.ts` | 0 (after C3.1) |
| 11 | scratch: `console.log` in `extensions/tools.ts` | CI red in the `quality` job only |
| 12 | scratch: register a cross-extension handler with wrong arity | `typecheck` red (after C3.1) |

## 7. Risks

| # | risk | mitigation |
| --- | --- | --- |
| R1 | A full format sweep (D1a) makes `git blame` useless for the whole tree | recommended D1(b); if (a) is ever taken, its SHA goes in `.git-blame-ignore-revs` in the same PR |
| R2 | `typebox/value` does not resolve inside pi's loader | C2.0 spike before any migration; fallback is hand-written validators (no new dependency) |
| R3 | Ratchet becomes decoration (thresholds quietly raised) | auto-lower on improvement; increases require `--reason`, which writes a visible `notes` line into the baseline; CI runs `--check`, never `--write` |
| R4 | biome's `recommended` set flips semantics between minors (it is pinned exactly, but a `^` would drift) | exact pin + lockfile; the §0.2 numbers are asserted in C1.1's accept so a biome bump shows up as a diff in the plan, not a surprise in CI |
| R5 | Adding a required `timeoutMs` changes behaviour where a call legitimately ran long (Devin CLI, `git push`) | per-call explicit numbers chosen from observed durations, listed in the commit; `runJson` never silently retries |
| R6 | `lib/orca-schema.ts` validators too strict for a backend version the fixtures never saw | tolerant-by-default adapters; a dropped row is logged, never silent; fixture provenance recorded in §12 |
| R7 | C2 touches five big files at once → review becomes unreadable | one commit per migration site group, each independently revertible; C2 is explicitly "no refactors beyond the call swap" |
| R8 | `AGENTS.md` and `CLAUDE.md` drift apart again | `CLAUDE.md` becomes `@AGENTS.md` + notes, and `check-quality` gains an invariant: a `CLAUDE.md` claim about the tree (plugin/skill counts) must match the filesystem — or, simpler, `CLAUDE.md` stops making count claims (preferred) |
| R9 | CI minutes grow with each gate | the four fast gates share one job against one install (§C1.6), staying under ~1 min before the Pi matrix |
| R10 | Cross-extension typed accessors change load-order behaviour (#36's gh-health work is close to this) | the C3.1 accept criterion explicitly tests the three load orders; keep `gh-health`'s singleton publishing where it is, only typed |

## 8. Sequencing and timebox

| PR | step | estimate |
| --- | --- | --- |
| C1 | C1.1 config + dep | 1 h |
| C1 | C1.2 clear the 12 errors | 45 m |
| C1 | C1.3 baseline + ratchet | 2 h |
| C1 | C1.4 the 8 invariants + fixtures | 3–4 h |
| C1 | C1.5–C1.6 scripts + CI | 1 h |
| C2 | C2.0 spike | 30 m |
| C2 | C2.1 `lib/exec.ts` + 4 migration groups | 4–5 h |
| C2 | C2.2 log + console + catch triage | 2–3 h |
| C2 | C2.3 `lib/git-repo.ts` | 2 h |
| C2 | C2.4 `lib/orca-schema.ts` | 3 h (+ fixture capture) |
| C2 | C2.5 head-SHA scoping | 1 h |
| C3 | C3.1–C3.2 typed contracts | 3 h |
| C3 | C3.3–C3.6 agent-facing files | 2–3 h |

Total ≈ 3 focused days, review loops included per PR. Do not merge C2 and C3: C2 changes behaviour and
wants its own revert boundary; C3 is contracts and docs.

## 9. Closing out #35

| issue box | PR |
| --- | --- |
| lint/format config | C1 (lint) + D1 decision for format |
| `scripts/check-quality.mjs` (+ all six sub-boxes) | C1.4 |
| `quality-baseline.json` ratchet | C1.3 |
| `npm run qa` aggregate | C1.5 |
| `lib/exec.ts` | C2.1 |
| `lib/log.ts` + `console.*` + empty catches | C2.2 |
| `lib/git-repo.ts` + probe fold-in | C2.3 |
| `lib/orca-schema.ts` | C2.4 |
| `lib/cross-extension.ts` | C3.1 |
| `lib/prompt.ts` | C3.2 |
| `AGENTS.md` | C3.3 |
| `CLAUDE.md` → `@AGENTS.md` + drift fix | C3.4 |
| `.agent/rules/*` | C3.5 |
| docs linked from `AGENTS.md` | C3.3 |
| P0 follow-ups (head-SHA scoping; `res.ok` rule) | C2.5 / C1.4 |

Tick each box in the same commit that closes it, and update the issue with one comment per PR
containing the §6 table — the format #36 used.

## 10. Explicitly out of scope for P1

- **P2 splits** (`tools.ts` → `pr-tasks` → `observe-pr` → `orca-orchestration` → `devin-delegate`) —
  after C1/C2 land, each split becomes a mechanical extraction with the gate proving it.
- Test coverage tooling, ESLint (biome was chosen), commit hooks/`husky` (CI gates; hooks are a
  separate decision), Dependabot/Renovate, moving `test/**` under `src`, the `docs/` re-organisation,
  hermetic Devin/Orca suites, and any behaviour change not driven by an invariant above.
- P0's remaining follow-up on `matchesKey` case sensitivity (cosmetic; P0 documented it).

## 11. Review flow (same as P0)

1. Implement per PR; before pushing, re-read the diff of each commit as a reviewer and fix findings in
   the same commit where they belong (P0's `git add -A` bundling is what produced a commit message that
   did not describe its contents — use explicit paths, keep commits focused).
2. Push, open the PR, and delegate an independent read-only review to Devin (SWE) against the PR head,
   with the acceptance criteria of every step in this file pasted in as the contract, plus the explicit
   instruction to verify claims by running things rather than reading them.
3. Fix every blocker and should-fix; re-verify at the new SHA and ask Devin to re-check that SHA
   specifically (a reviewer working from a stale checkout produced three false findings in #36 — always
   hand it the SHA).
4. Repeat until no findings; then the loop-close comment on #35 with the §6 table and the
   blockers/should-fix/nits actually fixed.

## 12. Execution record

Filled in as implemented — the P0 habit that made #36 reviewable: every deviation and every claim that
turned out to be wrong is written down here rather than discovered later.

## C1 — Deterministic gates (implemented)

**Decisions taken:** D1 **(a)** — the full format sweep landed as its own commit (`style: apply biome
format`), followed by `.git-blame-ignore-revs` carrying that SHA. D2 **(b)** ratcheted per-file line
budgets. D3 **(b)** `noExcessiveCognitiveComplexity` at 20, warned by biome and counted by the ratchet.

**Measured sweep cost (whole included tree, not just `extensions/`):** 32 files, +2,442/−2,031 —
extensions 12 files (+698/−758), test 18 files (+1,562/−1,091, mostly 2-space → tab), scripts 1 file
(+105/−105). `biome format .` is now a no-op, so CI gates formatting of the whole tree rather than only
changed files. Lint counts were identical before and after (0 errors / 237 warnings / 7 infos) and all
suites passed, so the sweep proved itself to be whitespace-only.

**Biome API facts learned the hard way (the plan's snippet was wrong in three places):**
- `biome.json` is parsed as **strict JSON**: the rationale comments require the name `biome.jsonc`.
- `overrides` is a **top-level** key in biome 2.x, not `linter.overrides`.
- `noUnusedParameters` does not exist; the rule is `correctness.noUnusedFunctionParameters`
  (`noUnusedVariables` also lives in `correctness`, not `style`).
- `--reporter=json` puts diagnostics on stdout (and an experimental notice on stderr); the JSON's field
  is `category`, e.g. `lint/suspicious/noExplicitAny`.

**Baseline captured** (`scripts/quality-baseline.json`, 20 metrics + 13 file budgets):
`execLocation` 27, `execTimeout` 28, `jsonParseLocation` 27, `emptyCatch` 49, `globalThisOwnership` 20,
`mutationResultChecked`/`noStdioWrites`/`piExtensionsMatchDisk`/`noUnusedLibs`/`wiredTests`/`frontmatter`
0; `biome.suspicious/noExplicitAny` 147, `biome.complexity/noExcessiveCognitiveComplexity` 51,
`biome.suspicious/noConsole` 17, `biome.suspicious/noGlobalIsNan` 8, `biome.style/noNonNullAssertion` 6,
`biome.complexity/useOptionalChain` 6, `biome.style/useTemplate` 7, `biome.correctness/noUnusedImports` 1,
`biome.correctness/noUnusedFunctionParameters` 1.

**Proof the gate bites:** 15 fixtures run against the working tree — each invariant gets a minimal
violation and must fail naming itself, plus the biome ratchet, the refusal to raise without `--reason`,
and the `notes` entry `--reason` writes. All 15 behaved; the harness was temporary and is not committed.

**Corrections found while implementing:**
- §0.3's `globalThis` count (15) was loose — see the corrected row: 20 write/delete sites, and the
  detector had to be rewritten (the first version missed `(globalThis as any).KEY =` writes and
  `delete` statements while counting `if (...)` reads). The ratchet records the correction with a
  `--reason` line rather than pretending the number was always 20.
- The plan said `execLocation` would be "28 untimeouted sites in `lib/**` or `devin-delegate.ts`"; the
  split is 27 call sites outside `lib/` (`execLocation`) and 28 without a timeout (`execTimeout`) out of
  44 total, overlapping.

**Wiring:** `npm run lint|format|format:check|check|qa:baseline|qa`; `run.sh` gained `lint`, `format` and
`check` suites (**15 suites** now, CI picks them up through `run.sh` as well as the `quality` job); the
orphaned-test guard that #36 put in `run.sh` moved into `check-quality.mjs` so there is one
implementation, reachable as `--only wiredTests` without any installed dependencies.

## Still pending

- **C2.0 spike result** (does `typebox/value` resolve under `pi -ne -e`?): _pending_
- **C2.4 fixture provenance** (captured from which backend version, or owed): _pending_
- **Baseline deltas at each PR merge** (metric → before → after): C1 changed no source metric (it only
  added measurement); the deltas start with C2.
- **Claims in this plan or in #35 found to be wrong**: see "Corrections found while implementing" above.

## C1 review rounds 2 and 3 — what the gate got wrong, and how it is now proven

`19c3182`/`26a1d92` shipped a gate that did not measure several of the things it claimed. The independent
review found 19 issues across three rounds; every one was reproduced before being fixed. The classes matter
more than the list:

| class | what happened | the general rule |
| --- | --- | --- |
| **raw text instead of code** | a `//` inside a string (`"https://x"`) read as a comment start and hid every call after it; a call inside `/* */` or a string counted as real; regex literals (`{P:/[(]/}`) corrupted bracket depth so one call's extent ran into the next; generic callees `execOrca<{…}>([…])` — the codebase's own spelling — matched no callee list | any "detector" that is not literal-aware will be wrong in both directions, silently. One scanner (`skipCompound`) now serves extent, statement-boundary and comment questions. |
| **counts that cannot answer the question asked** | "the rule reported nothing" and "the rule was switched off" are the same number. My first discriminator (zero diagnostics ⇒ legit) was exactly inverted, so switching `noExplicitAny` off recorded 147 `any`s as an improvement. | ask the config, not the counts: `ruleEnabledInConfig()` reads biome.jsonc. Still enabled ⇒ debt gone (recordable improvement). Off with debt ⇒ fails, and only `--write --reason` may record it. |
| **a check with a bypass one command away** | `--check` failed on stale keys while `--write` dropped them silently; the new `notes` guard fired on the dependency-free `--only` path (which `run.sh` runs before `npm install`); `gatedExtras` was pushed to before it was declared, so the stale-rule path crashed with a TDZ error. | the write path is the attack surface of a ratchet. Every gate must be refused by *both* modes. |
| **an invariant nobody proves** | four of the twelve measured nothing at first, and the TDZ crash proves the path had never run. | `test/quality-gate-fixtures.sh`: 105 assertions, in CI, run against a copy of the tree. New invariant ⇒ fixture in the same commit. |

Two things worth recording about the process:

- **A fixture harness that mutates the tree it tests is a hazard.** An early draft replaced
  `node_modules/.bin/biome` with a stub and left a fake binary in the checkout, which then made the *real*
  gate report "biome produced output in an unrecognised shape" — a true positive about a broken environment.
  The committed suite copies the tree to a temp dir and injects biome through `PI_QA_BIOME`. Its cleanup must
  never `git checkout --`: an earlier draft reverted uncommitted work under review that way.
- **Reachability claims get measured.** The bare-repo `.git` hole (R2-19) is real at the exported layer, but
  `git rev-parse --show-toplevel` was measured to *fail* — not print `.git` — inside `.git`, a bare repo and a
  worktree gitdir. So the guard is defence in depth for future callers, and that is what its comment says,
  rather than claiming an exploit the current caller cannot reach.

## Round 4 found the hole in the hole-catcher

Round 3 closed the "rule switched off in biome.jsonc" case. Round 4 pointed out that the fix inspected only
the top level of the config, while `biome.jsonc` in this repo has `overrides` - and `"overrides": [{
"includes": ["extensions/**/*.ts"], "linter": {"rules": {"suspicious": {"noExplicitAny": "off"}}}}]` silences
all 147 sites with the top level still reading `"warn"`. Confirmed locally: the metric fell to zero and the
gate called it an improvement. Two more in the same round: `PI_QA_BIOME` plus a stub printing
`{"diagnostics": []}` reached the same place (and the seam's docstring claimed it could not), and adding
`**=` to the compound-assignment alternation had dropped `*=` - the character class `[-+/%&|^]` never held
`*`, and the fixture only ever tested `+=`.

The lesson is that `ruleEnabledInConfig` was asked to answer "is this rule running?" by reading config, which
it cannot do reliably: severity strings vs `{level: ...}` objects, group-level `"off"`, per-glob overrides, a
rule renamed by a biome upgrade, a reporter substituted under a test seam. So the guarantee moved out of the
config reader and into the ratchet:

- **a biome metric may fall freely, but not to zero.** 147 -> 90 can only mean work was done. 147 -> 0 is
  indistinguishable from "stopped measuring", so it fails `--check` and needs `--write --reason`, which puts
  the decision in the file where a reviewer sees it. The config reader still runs, but only to name the cause
  in the message.
- **`PI_QA_BIOME` is honoured only when `PI_QA_FIXTURES=1`**, set solely by the fixture suite. An env var in a
  normal shell or CI cannot redirect the lint run.
- **compound operators are enumerated, not classed**, and the fixture now walks all seventeen write forms
  (`*= /= %= &= |= ^= -= >>= >>>= ||= &&= **= ??= += -= <<=`, `++`, plus `Object.assign`/`Reflect.set`/`delete`)
  and asserts four read shapes stay clean.

105 fixture assertions pass. Three of the new ones exist only because a reviewer thought of them.
