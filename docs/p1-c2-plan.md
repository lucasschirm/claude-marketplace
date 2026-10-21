# P1 / C2 — external-call hygiene (issue #35)

Plan written at `0cb0b83` (the merge of #37, which landed C1's gates on `main`). Every number below was measured on
that commit, in this tree, with `node scripts/check-quality.mjs` and `grep` - not copied from the issue text, which
was written against a tree three PRs old and is wrong in four places (noted inline).

The flow is the one that worked for P0 and C1: measure → split so each step is independently pickable with an
acceptance command → author self-review → **independent review by a different engine** → fix → re-verify at the exact
SHA → merge. No step here is "done" until its acceptance command has been run at the SHA being reported.

## Measured starting point (`main` = `0cb0b83`)

| Metric (from `scripts/quality-baseline.json`) | Value | Where it is |
| --- | --- | --- |
| `execLocation` (exec outside `extensions/lib/**`) | **25** | `observe-pr.ts` 14, `devin-delegate.ts` 10, `pr-tasks.ts` 1 |
| `execTimeout` (exec/spawn with no `timeout`/`timeoutMs`) | **25** | spread across the six files below |
| exec/spawn sites, total | **42** | `observe-pr.ts` 14, `devin-delegate.ts` 10, `lib/orca-client.ts` 10, `lib/github-review-threads.ts` 6, `pr-tasks.ts` 1, `lib/nonblocking.ts` 1 |
| `jsonParseLocation` (`JSON.parse` outside `lib/exec.ts`) | **27** | `devin-delegate.ts` 9, `observe-pr.ts` 6, `lib/github-review-threads.ts` 6, `lib/orca-client.ts` 3, `pr-tasks.ts` 1, `orca-orchestration.ts` 1, `lib/devin-diagnostics.ts` 1 |
| `biome.suspicious/noConsole` | **10** | `tools.ts` 8, `devin-delegate.ts` 2 (verified as real call sites, not comment mentions) |
| `globalThisOwnership` | **33** | see the key census below |
| `git rev-parse` call sites | **8** | `devin-delegate.ts` 4, `lib/orca-client.ts` 2, `observe-pr.ts` 1, `lib/github-review-threads.ts` 1 |
| `mutationResultChecked` | **0** | already enforced - a mutating call whose envelope is unread fails the gate |

`globalThis` key census (33 writes): five cross-extension contract keys (`__PI_OBSERVED_PRS__` 5 sites,
`__PI_ON_PR_POLL__` 5, `__PI_ON_PR_CLOSED__` 5, `__PI_ON_PR_CLOSED_DEVIN__` 4, `__PI_GH_HEALTH__` 1), five
`__PI_<ext>_EXTENSION_ACTIVE__` registration guards (one per extension), and four flush-hook pairs
(`__PI_{OBSERVE_PR,PR_TASKS,ORCA_ORCHESTRATION,DEVIN}_FLUSH__`, set + deleted). The first group is C3's job; the
third is a test seam that already has two shapes (set-on-`globalThis`, deleted on dispose) and belongs with it.

**Corrections to what issue #35 asserts:**

- The issue's `lib/log.ts` step says "replace all 23 `console.*` calls". Today there are **10**, because `main`
  already landed `extensions/lib/extension-log.ts` (`logError(scope, what, err?)`, `logWarn`, `logDebug`,
  `logPath`, `isDebugEnabled`) via #41 and migrated most call sites. C2 therefore **reuses that file**, it does not
  add a competing one.
- The issue's `lib/git-repo.ts` step says "the four copies". There are **8 `rev-parse` sites in 4 files**.
- The `which`/`where` probe duplication is **already resolved** by `lib/nonblocking.ts:350` (`isCommandAvailable`);
  the remaining work is to make callers use it, not to write it.
- The issue cites `devin-delegate.ts:137` for `spawn("devin", …)`; it is now **`devin-delegate.ts:133`**.

## Resolved by spike (was the biggest unknown in C1's plan)

`import { Check } from "typebox/value"` **resolves and works under Pi's extension loader.** Verified at `0cb0b83`
by loading a throwaway extension with `pi -ne -e spike.ts -p hi --offline`: with `typebox@^1.4.2` already a
devDependency and optional peer, `Check(Schema, {workers:[{id:"w1"}]})` returned `true` and
`Check(Schema, {workers:[{id:7}]})` returned `false`. So schema validation of external command output needs no new
dependency and no hand-rolled validator. `typebox` is already imported at runtime by the extensions today (`Type`
for tool parameters), so this adds no new install-time requirement. To reproduce:

```bash
cat > /tmp/spike-typebox.ts <<'EOF'
import { Check } from "typebox/value";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const Schema = Type.Object({ workers: Type.Array(Type.Object({ id: Type.String() })) });
export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		console.log(`SPIKE ok=${Check(Schema, { workers: [{ id: "w1" }] })} rejects=${!Check(Schema, { workers: [{ id: 7 }] })}`);
	});
}
EOF
cp /tmp/spike-typebox.ts ./spike-typebox.ts && pi -ne -e spike-typebox.ts -p hi --offline && rm spike-typebox.ts
# SPIKE ok=true rejects=true
```

(It must run from the repo root so `node_modules` resolves - the same condition the extensions themselves rely on.)

## Scope

One PR per numbered step. Steps 1-2 are the load-bearing ones; 3-6 are small and independently pickable.

### C2.1 — `extensions/lib/exec.ts`, one door for every subprocess

`runJson(cmd, args, { schema, timeoutMs, cwd, maxBuffer })` and `runText(cmd, args, {...})`, both returning a
discriminated envelope (`{ ok: true, data: T }` / `{ ok: false, code, message }`) so the compiler, not a reviewer,
enforces `res.ok` discipline. This file becomes the only place that calls `execFile*` and the only place that
`JSON.parse`s command output (`jsonParseLocation` → 0 for command output; parsing config/test fixtures stays legal
and is exempted by the invariant's existing allow-list).

- Default `timeoutMs` is **mandatory, not optional**: the signature has no path to "no timeout". Each call site
  passes its own value where the current one matters (`GH_TIMEOUT_MS` for `gh`, etc.).
- Long-lived children are a separate door: `spawnLongLived(cmd, args, { idleTimeoutMs })`. The `devin acp` child is
  a session, not a request, and a flat `timeout` on it would kill a healthy delegation. `execTimeout` accepts
  `idleTimeoutMs` as satisfying the rule; that exception needs a **fixture in the same commit** (an invariant with no
  failing fixture is an invariant that measures nothing - four of them did when the gate was written).
- Validation failure is an error with `code = "BAD_SCHEMA"`, reported with the path biome-style (`/workers/0/id`),
  and **never** with the payload embedded if the payload can contain secrets.
- Migration order, one commit each so a revert is one step: `lib/orca-client.ts` (10) → `lib/github-review-threads.ts`
  (6) → `observe-pr.ts` (14) → `pr-tasks.ts` (1) → `devin-delegate.ts` (10).
- Keep `BAD_JSON` semantics from #36 (`error.code = "BAD_JSON"`) and the `expectText` option for `worker-read`; they
  have tests (`test/test-orca-client.ts`) that must stay green unedited.

**Accept:** `node scripts/check-quality.mjs` shows `execLocation 0` and `execTimeout 0` (or only the documented
`spawnLongLived` sites), `npm run qa` green, and this empty:

```bash
grep -rnE "execFileAsync\(|execFileSync\(|\bspawn\(" extensions --include='*.ts' \
  | grep -v 'extensions/lib/exec.ts\|extensions/lib/nonblocking.ts'
```

### C2.2 — finish the logger and flip `noConsole` to error

Migrate the 10 remaining `console.*` call sites (`tools.ts` 8, `devin-delegate.ts` 2) to
`extensions/lib/extension-log.ts`, then flip `noConsole` from warn to **error in the same commit** - the documented
policy: a rule that errors while ten calls remain buys ten suppressions, which is debt that reads like compliance.

**Accept:** `noConsole` at 0 in the baseline, `biome.jsonc` with `noConsole: "error"`, and `npm run check` passing
without `--reason` on that metric (falls to zero are reasoned only for Biome metrics *entering* zero from a silenced
rule - see D8).

### C2.3 — `extensions/lib/git-repo.ts`

One `repoRoot()`, `currentBranch()`, `prForBranch(cwd)`; deletes the 8 `rev-parse` sites. While inside this area,
pull forward the P2 hygiene item **F20** for the same files: `repoCache` (`lib/github-review-threads.ts:46`) and
`repoRootCache` (`:223`) get a TTL or `invalidate()` - a cache keyed by cwd that never expires is a wrong-answer
generator when a worktree is deleted and recreated. (The issue cites `:45` and `:221`; the maps are one line later
than that at `0cb0b83`.)

**Accept:** `git grep -c '"rev-parse"' extensions/` = 0 outside `lib/git-repo.ts` (and `lib/exec.ts` if it hosts the
helper); the cache has an expiry or invalidation path **with a test that fails without it**; `test/test-review-thread-paths.ts`
stays 19/19 (it owns the git-metadata and symlink containment work from C1 - do not regress it).

### C2.4 — `extensions/lib/orca-schema.ts`

Typed adapters, validated with `Check` from `typebox/value` (spike above), for `orchestration worker-list`,
`run-list`, `check` and `worker-read`. This is where the `any` on the Orca boundary dies: today
`OrcaEnvelope<T = any>` plus `OrcaWorkerRow` are shaped by hope, and `orcaErrorText()` has to defend against
`error.message` being anything at all.

**Accept:** the boundary types are inferred from the schemas (no `as` casts at the call sites),
`biome.suspicious/noExplicitAny` measurably lower than 160 and lowered via `npm run qa:baseline`, and
`test/test-orca-status.ts` + `test/test-orca-client.ts` green, including the "failed call renders an error, not
`No live workers currently active.`" behaviour from #36.

### C2.5 — scope the CI-pass bookkeeping fallback to the head SHA

`evaluateCiVerdict({ checks, ghFailed, bookkeeping })` currently trusts the observer's
`completedRuns`/`failedRuns` when `gh pr checks` returns an *empty* list, and those sets are not keyed by commit, so
a push after the runs were recorded could let an old green pass over a new commit (reachable only through a non-`gh`
shim, since real `gh` exits non-zero on an empty rollup - which is why this is P1 and not P0).

- Record each completed/failed run **with the head SHA it was observed at**; pass the SHA being polled into
  `evaluateCiVerdict` and trust only matching entries.
- Persisted state (`observe-pr.ts:430,:549` serialises the two sets) gains the SHA without breaking resume from an
  older shape: an entry with no SHA is treated as *not matching* anything, never as a pass.

**Accept:** `test/test-ci-verdict.ts` gains a case that fails with the change reverted - checks empty, bookkeeping
says "completed 3, failed 0", head SHA differs → verdict `unknown`, **not** `passed`. Plus a resume test with an
older persisted shape.

### C2.6 — make the Devin binary injectable and un-exile its lifecycle suite

`extensions/devin-delegate.ts:133` calls `spawn("devin", args, …)` directly. Add an injectable command
(`DEVIN_COMMAND`, mirroring the already-supported `ORCA_CLI_COMMAND` precedent) and use it in the one place.

Then wire **`test/test-devin-delegate-lifecycle.ts`** into `test/run.sh` and the CI matrix. `test/run.sh:13`
currently labels it "starts real Devin sessions; run deliberately" - that label is **factually wrong**: the file
builds a fake `devin` shim on `PATH` (`test/.fake-devin-bin`, `fake-acp-server.mjs`) and needs no account, so it has
been rotting un-run in CI for no reason. Deleting the stale comment block is part of the issue's own acceptance text.

**Accept:** the suite runs in the CI matrix; `bash test/run.sh --list` includes it; `node scripts/check-quality.mjs`'s
`wiredTests` covers it (it does today too, but only because the file is *named* - the point is a run suite); the
"run deliberately" block is gone.

### C2.7 — closeout

Update `docs/p1-quality-plan.md` and `CLAUDE.md` with what actually changed (including any claim of mine that
measurement disproved - the P1 plan's "formatter first run is a no-op" line is the standing example), tick the issue
boxes with inline annotations saying what landed differently, and post the ratchet delta table on the PR.

## Out of scope for C2 (do not smuggle these in)

- `lib/cross-extension.ts` and `lib/prompt.ts` (C3): the 33 `globalThis` writes and the five contract keys move in a
  PR with its own revert boundary, because changing a cross-extension contract can break an extension that is not in
  the diff.
- The P2 per-extension splits (`observe-pr.ts` 1992 lines, `devin-delegate.ts` 2684, `orca-orchestration.ts` 1735,
  `pr-tasks.ts` 1505 against a 300-line entry-file target).
- Sweeping `any` (160) wholesale, coverage floors, `test/harness.ts`, and the numbered-harness migration.
- Changing `biome.jsonc` rules beyond the `noConsole` flip - the config hash makes every edit a recorded decision.

## Decision gates (need a call before the relevant step)

**D4 - envelope shape for `lib/exec.ts`.**
(a) Discriminated union `{ ok: true, data: T } | { ok: false, code, message }` - `data` does not exist on the failure
branch, so forgetting to check is a compile error, and `mutationResultChecked` becomes belt-and-braces rather than
the only defence. (b) Today's `OrcaEnvelope<T>` shape (`ok`, `data?`, `error?`) everywhere - smaller diff across ~40
call sites, but `data` can be read on a failed call and typecheck stays quiet.
*Recommendation: (a).* The whole C2 theme is that trust boundaries should be enforced by the compiler where the
compiler can do it.

**D5 - schema validation.** Resolved by the spike: (a) `Check` from `typebox/value` - no new dependency, works under
the loader, proven above; (b) hand-written validators. *Recommendation: (a)*, with one guard: the schema file must not
import anything Pi-only, so `test --test` can exercise it without booting Pi.

**D6 - Devin binary injection.** (a) `DEVIN_COMMAND` env var, symmetric with `ORCA_CLI_COMMAND`; (b) an injectable
field on the manager class. *Recommendation: (a)* - it also works for the shim-based tests without touching
constructors, and it matches the precedent the repo already set.

**D7 - timeouts.** (a) one default (`30_000`) with per-site overrides; (b) a per-verb table. *Recommendation: (a)* -
the current spread is 30 s for `gh`, and there is no measured slow verb that needs an exception; exceptions get
justified inline. Long-lived children go through `spawnLongLived({ idleTimeoutMs })`, never a flat timeout, or a busy
Devin delegation dies mid-turn.

**D8 - should the zero-drop reason rule cover repo invariants too?** It currently covers Biome metrics: a metric that
falls to zero needs `--write --reason`, because a fall to zero is indistinguishable from the rule being renamed or
silenced. `execLocation`, `execTimeout` and `jsonParseLocation` will legitimately hit zero in C2. (a) leave as is -
those falls are auto-written; (b) extend the rule to every invariant, so "the last violator disappeared" is always a
recorded line in `notes`. *Recommendation: (b)*, plus a fixture in `test/quality-gate-fixtures.sh` for the new bite -
and note this is the one step where C2 edits the gate, so it needs its own commit, away from the migrations.

## Sequencing and risk

Suggested order: **C2.1** (biggest, needs D4/D7), then **C2.4** (its schemas make C2.1's `runJson` useful at the
Orca boundary), then C2.2, C2.3, C2.5, C2.6, C2.7.

| Risk | Why it is real | Mitigation |
| --- | --- | --- |
| A timeout that never fired before now kills a working call | Nothing has ever bounded 25 of these calls; some may be slow in practice and nobody noticed because there was no timeout | Add the timeout per file, run that file's suite repeatedly (`observe-pr-gh-failure` three times was how the gh-health race was found), and keep the failure text distinguishable ("timed out after 30s" vs "gh failed") |
| Killing a live `devin acp` child | A flat `timeout` on a session-shaped spawn is a bug factory | `spawnLongLived({ idleTimeoutMs })`, exempted by an invariant change that ships with a fixture |
| Schema validation rejecting output `gh`/`orca` legitimately sends | A strict `Type.Object` rejects extra keys and any field that is sometimes absent | Schemas are permissive on unknown keys and mark genuinely-optional fields `Type.Optional`; rejection is surfaced as `BAD_SCHEMA` with the path, never silently coerced |
| `maxBuffer` truncation turning into `BAD_JSON` | Large `worker-list` output today succeeds because the default buffer is generous | Set it explicitly in `runJson` and include the byte count in the error code text |
| Regressing C1's security work | `lib/github-review-threads.ts` holds the git-metadata, symlink and `.git`-containment logic that took two review rounds | C2.3 must leave `test/test-review-thread-paths.ts` at 19/19 with no edits to its assertions |
| Resume from an older persisted shape (C2.5) | The two run sets are serialised; users mid-session upgrade across this change | Entries without a SHA are trusted for nothing, and a resume test proves an old file still loads |

Two loose ends that are **not** code and stay tracked outside C2: the repo has no required status checks, so a PR
whose runs silently never start looks untouched (that is exactly what happened during the Actions incident window on
#37 - fix is branch protection, an admin action); and the regex scanners behind `check-quality.mjs` cannot see
dynamically aliased calls (`const s = cp.spawn; s(...)`) - a documented, bounded limit, and the reason `lib/exec.ts`
being the single door matters more than the detector.
