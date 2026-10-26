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

### Amendment, made while implementing PR A: the door validates with its own checker

The spike is correct and it measured the wrong graph.

`extensions/**` resolves packages from this repo's `node_modules`, so `typebox/value` is available to it. A
`plugins/pr-observer/lib/**` file is a *copy* of extension code that an installed plugin runs with no
`node_modules` of its own - an install copies the plugin directory and nothing else. The door is vendored into
that plugin (it has to be: `github-review-threads.ts` imports it), so `import { Check } from "typebox/value"`
in `lib/exec.ts` reproduces the exact crash #46 was opened for. What catches it now is
`test/test-pr-observer-mcp.ts`, which walks the plugin's real import graph and fails on any non-`node:`
specifier - it used to check a hard-coded list of names, which is why it did not catch this until CI did.

So the door and `lib/exec-payload.ts` use `node:` builtins only, and D5 flips to the option it rejected:
`extensions/lib/exec-payload.ts` carries `Schema` and `schemaErrors()` (~90 lines) instead of `Check`.
What was really rejected was not "hand-written validators" but *a validator that cannot travel*.

Honest cost: ~90 lines of our own code, exercised directly by `test/test-exec.ts` rather than inherited
trust; unknown payload keys are accepted on purpose (a routine CLI field addition must not fail a call), and
an unsupported schema keyword throws at construction instead of quietly validating nothing. Benefit: the door
validates identically in the host and in an installed plugin, and a failure names a path
(`/workers/0/id: must be a string`) rather than dumping the payload.

## Scope

Seven steps, **two PRs**. Not seven, because review is the bottleneck and each PR re-runs the whole loop; not one,
because the failure modes are unrelated and `main` moves fast (it took four PRs while C1 sat open, forcing two conflict
resolutions and two extra review rounds).

| PR | Steps | Why they belong together |
| --- | --- | --- |
| **A** - the runtime core | C2.1 `lib/exec.ts`, C2.4 `lib/orca-schema.ts`, C2.2 logger + `noConsole` error, C2.3 `lib/git-repo.ts` + cache TTLs | one theme: how the extensions talk to the outside world. C2.4 and C2.1 touch the same file (`lib/orca-client.ts`), C2.2 and C2.1 both touch `devin-delegate.ts`, so splitting them buys a revert boundary and costs a second conflict pass over the same lines |
| **B** - contracts and leftovers | C2.5 head-SHA scoping, C2.6 `DEVIN_COMMAND` + CI wiring, C2.7 closeout | C2.5 changes a **persisted format** (the serialised run sets at `observe-pr.ts:430,:549`) and needs a resume-safety story of its own; C2.6 is CI infrastructure. Neither is a reason to hold up PR A |

`main` uses merge commits, so each step lands as its own commit on `main`: bisect and `git revert` granularity stay
per-step even inside a PR - provided every commit passes `npm run qa` on its own. That is the condition, and the one
thing not to relax when a step gets tangled.

### Standing rules (every commit, both PRs)

- **Every commit green alone:** `npm run qa` (typecheck, lint, format, invariants, manifests, unit).
- **Vendored copies.** `plugins/pr-observer/lib/` carries byte-copies of `ci-verdict.ts`, `github-review-threads.ts`
  and `pr-tasks-manager.ts`, and `npm run validate` fails when they drift - #37 proved it, because the format sweep had
  silently desynchronised three of them. Any commit touching those files runs
  `node scripts/sync-plugin-libs.mjs --write` in the **same** commit.
- **New libs must be used.** `noUnusedLibs` fails an `extensions/lib/*.ts` with no entry-file importer, and
  `fileLineBudget` gives a new lib a 500-line start - so `exec.ts`, `git-repo.ts` and `orca-schema.ts` each land with
  their first caller, never as a dangling module.
- **Invariant changes carry fixtures.** Only D8 edits `check-quality.mjs`; it ships the fixture that fails without the
  change, in the same commit, and stays away from migration commits because it changes what the rest is measured by.
- **Baseline rises name their source.** `--write --reason` says whether debt was authored here or inherited from
  `main`, and an inherited figure is verified by measuring `origin/main` with the same script and `biome.jsonc`.
- **Reviews attach to the SHA they ran on**, and the reviewer is not the engine that wrote the diff.

### C2.1 — `extensions/lib/exec.ts`, one door for every subprocess

`runJson(cmd, args, { schema, timeoutMs, cwd, maxBuffer })` and `runText(cmd, args, {...})`, both returning a
discriminated envelope (`{ ok: true, data: T }` / `{ ok: false, code, message }`) so the compiler, not a reviewer,
enforces `res.ok` discipline. This file becomes the only place that calls `execFile*` and the only place that
`JSON.parse`s command output (`jsonParseLocation` → 0 for command output; parsing config/test fixtures stays legal
and is exempted by the invariant's existing allow-list).

- Default `timeoutMs` is **mandatory, not optional**: the signature has no path to "no timeout". Each call site
  passes its own value where the current one matters (`GH_TIMEOUT_MS` for `gh`, etc.).
- Long-lived children are a separate door: `spawnLongLived(cmd, args, { idleNoToolMs, idleWithToolMs })`. The
  `devin acp` child is a session, not a request, and a flat `timeout` on it would kill a healthy delegation; the two
  thresholds are measured in D7 below (90 s of silence with no tool open, 30 min while a tool call is open), and the
  open-tool state is tracked as a **set of `toolCallId`s**, not a flag, because Devin runs tools concurrently.
  `execTimeout` accepts `idleNoToolMs` as satisfying the rule; that exception needs a **fixture in the same commit** (an invariant with no
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

**Accept:** `npm run check` fails first with the fall to zero refused, and
`npm run qa:baseline -- --write --reason "..."` records it (D8 makes the reason mandatory for any metric reaching zero,
Biome or repo); `biome.jsonc` shows `noConsole: "error"`, and a fixture asserts that a fresh `console.log` in
`extensions/` now fails the gate instead of warning.

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

## Decisions (locked) and the measurement behind D7

**D4 = (a)** discriminated envelope. **D6 = (a)** `DEVIN_COMMAND`. **D8 = (b)** the zero-drop reason rule extends to
repo invariants. **D7** is answered from logs below.

### D7 - what "idle" means for a Devin delegation, measured

The question was how long a healthy Devin turn can go without the agent doing anything. Answered from the extension's
own event logs: `~/.pi/agent/devin_delegate/<piSession>/<devinSession>/events.jsonl` (419 sessions on this machine,
735 MB; 179 large enough to contain turns). A turn is delimited by a logged `user_message` and the ACP frame carrying
`stopReason`, so **every gap below comes from a turn that completed normally** - which is the only population that can
measure a false positive.

Activity = the ACP `session/update` kinds the stream actually produces: `agent_thought_chunk`, `agent_message_chunk`,
`tool_call`, `tool_call_update`, `plan` (plus `usage_update`, measured and **useless as a heartbeat** - counting it as
liveness changed nothing, so it is not a keepalive).

| Population | n | p99 | p99.9 | **max** |
| --- | --- | --- | --- | --- |
| Silence with **no tool call open** (genuinely the model thinking) | 10,257 | 14.2 s | 25.6 s | **37.1 s** |
| Silence while **a tool call is open** (agent waiting on a command) | 125,344 | 13 s | 58 s | **297 s** |
| Tool duration, `tool_call` -> `completed`/`failed` | 7,396 | 79 s | 748 s | **1,335 s** (22 min) |

Per-turn maximum of the no-tool silence: p50 1 s, p90 21 s, p95 25 s, p99 33 s, **max 37 s** - **0 of 191 turns** would
have been flagged at 60 s or above. Two classification facts drive the design:

- **Every** silence over 120 s (41/41) and over 180 s (32/32) had a `tool_call` still open. 82% of those over 60 s did.
  The long quiet periods are not the agent thinking; they are `npm ci`, test suites and builds, which are silent by
  nature. A timer that ignores open tool calls would therefore call 18 real tool runs "stalled" at 300 s (0.24% of
  tools) and would have misdiagnosed the longest-silent turn in the dataset (297 s, a tool in flight).
- Real model silence is short and tight: the worst in the whole corpus is **37 s**, and only 5 gaps out of 10,257
  exceeded 30 s.

**Therefore:**

```ts
spawnLongLived("devin", args, {
	idleNoToolMs: 90_000,   // >2x the 37s observed max; nothing healthy is silent this long with no tool open
	idleWithToolMs: 1_800_000, // > max tool duration 1335s; a build/test may be quiet for 20 minutes legitimately
});
```

And the action stays what the existing stall watchdog already does (`devin-delegate.ts:713-731`): mark `stalled`, send
one steering message telling the user to check `devin_status` / `devin_cancel` / `devin_restart`, and **never**
auto-fail or kill - process death is already detected by `onExit` as `interrupted`. What changes in C2 is the number
and the condition, not the policy:

- Today's default is **30 minutes** of no ACP update at all (`stallTimeoutMinutes`, `devin-delegate.ts:617`) - about
  49x the observed true-silence maximum, which is why it has never been useful.
- The replacement is tool-aware: 90 s with no tool open, 30 min with a tool open. Suppression on `tool_call` and
  re-arm on the terminal `tool_call_update` must be tracked **by `toolCallId` as a set**, because Devin runs tools
  concurrently - single-slot tracking misclassified 41 gaps over 120 s the first time it was tried here, and produced
  a fictitious 297 s "thinking" gap.
- Request-shaped calls keep plain deadlines: `GH_TIMEOUT_MS = 60_000` (8 sites), `FETCH_TIMEOUT_MS = 60_000` (6 read
  sites), `MUTATION_TIMEOUT_MS = 120_000` - so the default for `runJson`/`runText` is 60 s with writes at 120 s, not
  the 30 s this plan first proposed. 30 s would newly break calls that are healthy today. The `timeoutMs: 900000` at
  `orca-orchestration.ts:450` is not a counterexample: it is `--timeout-ms` passed into orca's own argv, not our
  process deadline.

Limits of the measurement, stated because the recommendation depends on it: one machine, one user, 191 matched turns,
mixed Devin models that the event log does not label, and `events.jsonl` files truncated by the log-size trim - so
the 37 s maximum is an order statistic from a modest tail, and the 90 s threshold keeps >2x headroom rather than 1.1x.

---

### Decision record (options, reversibility)

| | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| **D4** | Discriminated envelope `{ ok: true; data: T } \| { ok: false; code; message }` | reuse `OrcaEnvelope` (`ok`, `result?`, `error?`) | reading `data` on a failed call becomes a compile error instead of an `undefined` at runtime; the five causes (`ENOENT`, `EXIT`, `TIMEOUT`, `BAD_JSON`, `BAD_SCHEMA`) stop rendering identically in UI text. `mutationResultChecked` already gates unread envelopes at baseline 0, but it is a regex scanner with a known blind spot (`const s = cp.spawn; s(...)`); the type system has none. Reversing later is cheap one way (a)\u2192(b) and 40 call sites the other |
| **D5** | *(amended during PR A)* the door carries its own `Schema` / `schemaErrors()` checker in `lib/exec-payload.ts` | `Check` from `typebox/value` - this row's original choice; and any validator reached through `node_modules` | the original row rested on a spike of `extensions/**`, where packages do resolve. The door is vendored into `plugins/pr-observer`, where an installed plugin has no `node_modules` at all: importing `typebox` there is the #46 crash again. `test/test-pr-observer-mcp.ts` enforces the graph, so this is a measured constraint and not a preference. Reasoning above |
| **D6** | `DEVIN_COMMAND` env var | injectable constructor field | symmetric with `resolveOrcaCmd()`/`ORCA_CLI_COMMAND`; the existing lifecycle test prepends a directory to `process.env.PATH` (`test-devin-delegate-lifecycle.ts:57`), which re-points every binary lookup in the process and can leak across tests, and a PATH shim needs `.cmd` on Windows. Caveat kept visible: a command taken from the environment is a trust boundary, same class as `ORCA_CLI_COMMAND` and `PATH`, and `AGENTS.md` (C3) should state it |
| **D7** | Tool-aware idle rule: 90 s with no tool open, 30 min while a `toolCallId` is open, notice-only as today. Requests: 60 s default, 120 s for mutations | a flat `timeout` on the spawn; this plan's original 30 s default | measured on 191 completed turns - real model silence maxes at 37 s, while 41/41 silences over 120 s had a tool running. A flat or naive rule kills healthy work; 30 s would newly break calls the tree already runs at 60 s. Evidence above |
| **D8** | zero-drop `--reason` rule extended from `biome.*` to every invariant | Biome-only | `execLocation`/`execTimeout`/`jsonParseLocation` hit zero **because code moved into `lib/exec.ts`**, and would hit zero identically if a scanner regex stopped matching or `extensionFiles()` stopped seeing a directory. The two outcomes are the same number; a human signs the difference into `notes`. Cost: three reason lines and one fixture |

## Sequencing and risk

### PR A - commit sequence

1. `feat(exec): lib/exec.ts` - the door, the envelope (D4), 60 s/120 s defaults, `spawnLongLived` with the two D7
   thresholds, unit tests. Nothing migrates yet, so this commit changes no behaviour at runtime.
2. `refactor(orca): runJson + schemas at the orca boundary` - C2.4's `lib/orca-schema.ts` together with the 10
   `lib/orca-client.ts` sites, because a schema without a caller trips `noUnusedLibs` and a caller without a schema is
   the `any` we are removing.
3. `refactor(review-threads): exec.ts for the gh and git calls` - 6 sites, `sync-plugin-libs --write` in the same commit.
4. `refactor(observe-pr): exec.ts for the 14 gh sites`.
5. `refactor(pr-tasks): exec.ts for the last direct gh site`.
6. `refactor(devin-delegate): exec.ts for the gh/git calls` - 9 request sites (the `devin acp` spawn is the tenth
   exec site and moves in step 7).
7. `fix(devin): tool-aware stall thresholds from the log evidence` - `DEVIN_COMMAND` (D6) plus `spawnLongLived` on the
   ACP child, replacing the 30-minute default. C2.6's first half lives here: the injection and the watchdog are
   the same two lines.
8. `style(logging): the last 10 console.* calls, noConsole becomes an error` - C2.2.
9. `refactor(git): lib/git-repo.ts and the repo caches` - C2.3, `sync-plugin-libs --write`.
10. `fix(qa): a fall to zero is a decision for every invariant, not just biome's` - D8, with its fixture.
11. `docs: what C2 changed` - plan doc, `CLAUDE.md`, issue ticks.

Then: merge `origin/main`, re-run `bash test/run.sh` (20 suites since main's `devin-queue` landed) and
`quality-fixtures` (132) at that SHA, and get an
**independent review at the exact head SHA**. If findings and a merge follow, the merge commit is re-verified the same
way - C1 needed rounds 6 and 7 precisely because that rule was the only thing standing between a green PR and a green
commit nobody looked at.

### PR B - commit sequence

1. `fix(observe-pr): the CI-pass fallback trusts only the head SHA it was recorded for` - C2.5, with a resume test for
   the older persisted shape.
2. `test(ci): wire the devin lifecycle suite, delete the stale exclusion block` - C2.6's second half; `DEVIN_COMMAND`
   replaces the PATH shim rather than adding a new seam.
3. `docs: C2 closeout` - ratchet delta table and issue #35 ticks with deviations annotated inline.

Same gate: green at the exact head SHA, independent review, re-verified after any merge.

| Risk | Why it is real | Mitigation |
| --- | --- | --- |
| A timeout that never fired before now kills a working call | Nothing has ever bounded 25 of these calls; some may be slow in practice and nobody noticed because there was no timeout | Add the timeout per file, run that file's suite repeatedly (`observe-pr-gh-failure` three times was how the gh-health race was found), and keep the failure text distinguishable ("timed out after 30s" vs "gh failed") |
| Killing a live `devin acp` child | A flat `timeout` on a session-shaped spawn is a bug factory, and the log evidence is blunt: silences over 120 s had an open tool call in 41 of 41 cases, up to 297 s, while real model silence never exceeded 37 s | `spawnLongLived({ idleNoToolMs, idleWithToolMs })`, tool-aware and notice-only, exempted by an invariant change that ships with a fixture |
| Schema validation rejecting output `gh`/`orca` legitimately sends | A strict `Type.Object` rejects extra keys and any field that is sometimes absent | Schemas are permissive on unknown keys and mark genuinely-optional fields `Type.Optional`; rejection is surfaced as `BAD_SCHEMA` with the path, never silently coerced |
| `maxBuffer` truncation turning into `BAD_JSON` | Large `worker-list` output today succeeds because the default buffer is generous | Set it explicitly in `runJson` and include the byte count in the error code text |
| Regressing C1's security work | `lib/github-review-threads.ts` holds the git-metadata, symlink and `.git`-containment logic that took two review rounds | C2.3 must leave `test/test-review-thread-paths.ts` at 19/19 with no edits to its assertions |
| Resume from an older persisted shape (C2.5) | The two run sets are serialised; users mid-session upgrade across this change | Entries without a SHA are trusted for nothing, and a resume test proves an old file still loads |

Two loose ends that are **not** code and stay tracked outside C2: the repo has no required status checks, so a PR
whose runs silently never start looks untouched (that is exactly what happened during the Actions incident window on
#37 - fix is branch protection, an admin action); and the regex scanners behind `check-quality.mjs` cannot see
dynamically aliased calls (`const s = cp.spawn; s(...)`) - a documented, bounded limit, and the reason `lib/exec.ts`
being the single door matters more than the detector.

## Definition of done for C2

- `execLocation` 0, `execTimeout` 0, `jsonParseLocation` 0 for command output, `noConsole` 0 with the rule at `error`;
  every fall to zero is a line in `quality-baseline.json`'s `notes` naming what earned it.
- No extension calls `execFile*`/`spawn` outside `lib/exec.ts`, and no extension parses command output.
- A failed external call is a typed branch, not an `undefined` read, and names which of the five causes it was.
- A Devin turn is never killed by the wall clock: 90 s of silence with nothing running produces a stall notice, an open
  tool suppresses it up to 30 minutes, `onExit` still owns real death - and the constants cite the measurement.
- The Devin lifecycle suite runs in CI and the "run deliberately" block is gone.
- Every commit in both PRs passes `npm run qa` alone; `plugins/pr-observer/lib/` never drifts from its originals.
- Independent review said "ready to merge" at the head SHA actually merged, by an engine that did not author the diff.
- Issue #35: the External-call hygiene boxes and the Devin CI-coverage boxes ticked, anything done differently from the
  issue text annotated inline instead of quietly re-pointed.

## C2.5 as landed, and what review round 1 changed

PR #47 landed the head-SHA scoping; the independent review (Antigravity, at `d3e75d8`) returned *ready to merge* with
two should-fix findings, both real, both fixed before merge. They are recorded here because each is a class of mistake,
not a typo.

| Finding | What was actually wrong | What it became |
| --- | --- | --- |
| R-1 · duplicate pass | `checkAllCIPassed` latched `allPassedReported` only *after* awaiting `gh pr checks`, so the 2 s poll and a run-completion callback could both pass the entry check on the same answer and announce the same pass twice. The reviewer hit it live in a full suite run. | A per-PR `ciCheckInFlight` guard, released in a `finally`. Proven both ways: with the guard 4/4 suite runs pass; with the guard removed 4/4 fail (T4's exactly-once, or T5 seeing two passes). The window is widened deliberately by a `slow_checks` marker in the mock - an assertion that only fires when the reviewer's machine happened to be slow is not an assertion. |
| R-2 · the strand | My own scoping was `commonRunSha(completedRuns)`: *all* completed runs had to agree on one commit. But `completedRuns` accumulates across pushes, so after the second push a legitimately green head was `unknown` forever - silently, on every poll, with no user-visible signal. The reviewer wrote the reproducer; my tests did not have it. | `bookkeepingAtHead(headSha, runs)`: runs whose recorded commit is not the head are **ignored**, not counted - a green on `A` cannot pass `B`, and a red on `A` cannot strand `B`. |

R-2 is the lesson worth keeping. Scoping a claim to a commit has two directions, and I only tested the one that felt
dangerous: *do not pass what you did not watch*. The other direction - *do not go silent on what you did watch* - is
the same one line of code, and its failure mode is an observer that says nothing forever. The e2e now covers both:
run 777 belongs to the pre-push commit and produces nothing, then run 778 arrives on the head commit and must produce
exactly one pass while 777 stays in `completedRuns`. Reverting to the `commonRunSha` rule reproduces the reviewer's
prediction exactly: the negative assertion still passes, and the positive one times out.

The first version of the negative assertion was a point-in-time check that **passed with the fix reverted** - a race
masquerading as a test, the same failure mode `test/quality-gate-fixtures.sh` was de-hardcoded against. It is now a
six-second window (three poll cycles) after the run has demonstrably completed.

## PR A as landed so far (PR #48, through `3801bb3`), and what is deliberately left

Four commits, each file-scoped so a regression names a file:

| Commit | What moved | Debt it paid |
| --- | --- | --- |
| `8580a65` | `lib/exec.ts` + `lib/exec-payload.ts` exist; `orca-client.ts` is the first caller | door opens; `execTimeout` accepts `idleNoToolMs` on `spawn` only |
| `e4e9592` | `lib/github-review-threads.ts`: 6 calls, 5 bare parses | `jsonParseLocation` 25 → 19, `emptyCatch` 52 → 50 |
| `dc57c70` | plugin-closure test walks the import graph | closes the class of bug that broke CI on the previous commit |
| `3c149dc` | `observe-pr.ts`: 12 calls, 6 parses | `execLocation` 24 → 12, `execTimeout` 25 → 21, `jsonParseLocation` 19 → 13, `noExplicitAny` 158 → 153 |
| `3801bb3` | `devin-delegate.ts` provisioning + `pr-tasks.ts` | `execLocation` 12 → 2, `execTimeout` 21 → 12, `jsonParseLocation` 13 → 9, `emptyCatch` 50 → 47 |

Where the counters stand on this branch: `execLocation` 2, `execTimeout` 12, `jsonParseLocation` 9,
`emptyCatch` 47, `noConsole` 10, `noExplicitAny` 153, `globalThisOwnership` 33.

**The two `execLocation` survivors are `spawn`s, and they stay direct for now on purpose**: `gh run watch`
and `gh pr checks --watch` are children whose whole job is to outlive a request, so a deadline would be a
bug. They belong with the session-lifetime work (the same policy `spawnLongLived` implements for Devin), not
with the request migration, and converting them here would have meant shipping the idle policy half-tested.

**The 12 `execTimeout` survivors** are the `orca-client.ts` git helpers (8), two `spawn`s in `observe-pr.ts`,
the `orca` check spawn and `acp-client.ts`'s `spawn("devin")`. That is exactly the C2.3 remainder:

1. `lib/git-repo.ts` - absorb the repeated `rev-parse`/`status`/`log` helpers behind TTL'd caches, giving the
   git calls their timeouts in one place instead of eight.
2. The long-lived children: `gh run watch`, `gh pr checks --watch`, and the Devin ACP session, all through
   `spawnLongLived`'s tool-aware idle policy (notice-only, never a kill).
3. `console.*` → `lib/extension-log.ts`, flipping `noConsole` to `error` in the same commit so the rule cannot
   be re-loosened without a reason.
4. D8: the zero-drop invariant plus fixtures for the three metrics that reach zero *because code moved into
   the door* - the fall and the disappearance of a scanner are the same number, and a human signs which.
5. PR B's remainder: `DEVIN_COMMAND` (D6), wiring `test/test-devin-delegate-lifecycle.ts` into CI, closeout.

Two coverage caveats a reviewer should weigh rather than infer:

- **Provisioning is not exercised by any CI suite.** `test-devin-delegate*.ts` need real Devin and are listed
  "run deliberately" (`test/run.sh:8-11`); that gap is what PR B exists to close. `3801bb3` therefore rests on
  typecheck and reading, with the behaviour it must preserve written out in the commit message.
- **`branch-observer` is flaky on `main`, independently of this branch.** Measured at `4ca7ff0` in a clean
  worktree: 3 of 5 consecutive local runs failed; on this branch, 2 of 5. Two modes, both races against the
  fixed 1 s announcement timer the test itself comments on. Tracked as #62, not fixed inside #48: a suite that
  needs a design change does not belong in a revert-boundary PR about subprocesses - but it does mean a green
  CI run on this branch is partly luck, and a red one is not automatically this branch's fault.
