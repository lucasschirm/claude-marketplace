# agy-acp — Code Quality Review

Scope: `agy-acp/src/**` (37 files, 5,104 lines) and the gates around it (`tsconfig.json`, `biome.jsonc`,
`scripts/check-quality.mjs`, `test/run.sh`, `.github/workflows/ci.yml`). Measured on
`lucasschirm-app/quality` at `79b8f02`, with `npm install` run first.

Every number below is reproducible; nothing is copied from an issue.

**What became of it.** Every finding here was fixed on this branch, under the plan in
`docs/agy-acp-quality-plan.md` (14 tasks, one commit each, `62ea8c0..HEAD`). Each finding carries a
**Status** line naming the task and the commit; §4's gate decisions landed with them, and the
commit-time enforcement §5 argues for is `.githooks/` + `scripts/check-commit-hygiene.mjs`. The
measurements above are the *before* picture and are deliberately left as they were taken - what
replaced them is in `CLAUDE.md` and in the baseline's `notes`.

| Measurement | Command | Result |
| --- | --- | --- |
| Current gates | `npm run typecheck`, `npx biome lint agy-acp` | **both clean** — every finding here is invisible to the toolchain as configured |
| `tsc` + `noUncheckedIndexedAccess` | one-flag tsconfig over `agy-acp/**` | **11 errors in `src/`**, 128 in `test/` |
| `tsc` + `exactOptionalPropertyTypes` | same | **11 in `src/`**, 0 in `test/` |
| `tsc` + `noImplicitReturns` / `noUnusedLocals` / `noUnusedParameters` / `verbatimModuleSyntax` | same, one flag each | **0 errors each** (free to adopt) |
| `tsc` + `noPropertyAccessFromIndexSignature` | same | 170 in `src/`, 382 in `test/` — rejected, see §4 |
| `biome lint` with `rules.preset: "all"` | `--config-path` over `agy-acp/src` | **657 diagnostics across 38 rules** |
| Gate runtimes | `time` each npm script | typecheck 1.0 s, lint 0.4 s, format 0.3 s, `check` 3.1 s, validate 0.1 s, `agy-acp` tests 14.7 s |
| Git hooks installed | `git config core.hooksPath`, `ls .git/hooks` | **none** — only `*.sample` files; nothing runs at commit time |
| Commit-time enforcement in CI | `.github/workflows/ci.yml` | **none** — CI checks the head of the branch only, and cannot tell a verified commit from a bypassed one |

## 1. Verdict

| Dimension | Grade | Notes |
| --- | --- | --- |
| Architecture & file size | **A** | 37 files, largest 348 lines, one responsibility each; the `lib/`-only spawn door and the `agy-driver.ts` re-export seam are real boundaries, not decoration |
| Documentation of intent | **A** | Every module header explains *why*. Three findings below (F3, F8, F14) exist precisely because a comment and its code disagree |
| Failure-path handling | **B+** | Deadline ladders, fail-closed hook, bounded teardown, single-flight dispose. Two unbounded buffers (F11, F12) and one fail-open window (F2) |
| Correctness of the data mapping | **B** | One confirmed corruption bug (F1); lenient contract parsing is right, but one optional is set unconditionally (F9) |
| Permission policy | **B+** | Fail-closed by construction and well tested, but two conditions do not say what they mean (F3, F4) and neither is pinned by a test |
| DRY | **B** | One 40-line routine exists twice (F7); turn settling exists five times (F8) |
| Gate strength | **C** | The strongest gate in the repo (invariants + ratchet + fixtures) still passes all 14 findings. The configured strictness stops exactly where these bugs begin |

## 2. Findings

### F1 — `truncate()` corrupts a complete emoji at the cut boundary (CONFIRMED, with repro)

`agy-acp/src/update-map.ts:96-102`. The guard tests the last code **unit** against the whole surrogate
range `0xD800–0xDFFF`. When a complete pair ends exactly at `maxChars`, the unit at `cut.length - 1` is
its **low** surrogate, so the branch fires and drops half of a valid character:

```
$ node -e 'import("./agy-acp/src/update-map.ts").then(m => console.log(JSON.stringify(m.truncate("ab\u{1F600}cd", 4))))'
"ab\ud83d\n… [truncated, 6 characters total]"     # a lone high surrogate, from a complete 😀
```

The actual split case (`maxChars` = 3) is handled correctly, so the test range is right for the half it
was written for and wrong for the other half. Every tool output over `MAX_TOOL_TEXT_CHARS` (8192) and
every title over 200 chars goes through this. **Fix:** test `0xD800–0xDBFF` (high surrogates only).
No test covers the boundary; `test-jsonrpc.ts:64` is the only place an emoji appears, and it never
reaches `truncate`.

**Status:** fixed in Task 5 (`c5b4726`) - high surrogates only, with a test that walks every cut around a pair.

### F2 — the PreToolUse hook can exit before its decision reaches agy (fail-open window)

`agy-acp/src/bridge-hook.ts:36-41` writes the decision and calls `process.exit(0)` in the same tick.
Node's `process.stdout` is **asynchronous when it is a pipe on macOS** (synchronous on Linux and
Windows); `process.exit()` does not drain pending writes. The hook's own header and
`agy-acp/README.md:44` both state the consequence: *"empty stdout would be an allow in agy"*. So the one
way this file can fail is the one failure it exists to prevent, on one of the two platforms agy ships for.

The repo already solved this for the server: `src/flush-stdout.ts` is a bounded drain that exists, is
documented, and is granted a stdout exemption by the quality gate — and the hook does not use it.
**Fix:** `process.stdout.write(out, () => process.exit(0))` with a bounded fallback timer, or reuse
`flushStdout()`.

**Status:** fixed in Task 6 (`fdfa7f1`) - the exit leaves from the write's completion callback, with a bounded fallback; proven on Linux with a 256 KiB decision, where 146 KiB of it used to arrive. The `stdoutExitDrain` invariant now fails any file in `agy-acp/src/` that exits past an unacknowledged `process.stdout.write`.

### F3 — the bridge's conversation check contains a dead conjunct that reads as its own opposite

`agy-acp/src/bridge-server.ts:172`:

```ts
if (expected === null || (req.conversationId !== expected && req.conversationId === "")) {
```

`expected` is never `""` (the gate maps the unprobed state to `null`, `permission-gate.ts:77`), so
`req.conversationId === ""` already implies `!== expected`. The effective rule is *"refuse only an empty
id"* — subagent ids are accepted deliberately (the comment above it says so, and `test-bridge.ts:709`
exercises the empty case). But the condition is **written** as a mismatch test, so the next reader
simplifies it into one and silently breaks every subagent tool call. **Fix:** write the rule as what it
is (`req.conversationId === ""`), keep the explanation, and add the test that pins subagent acceptance.

Biome's `noUnnecessaryConditions` does **not** catch this (verified: 23 hits in `src/`, none of them this
line — see §4).

**Status:** fixed in Task 7 (`5d32bd8`) - the check is `expected === null || req.conversationId === ""`, and says so in the log.

### F4 — plan mode's redundant `KNOWN_TOOLS` guard turns a list slip into a silent policy hole

`agy-acp/src/permission.ts:167`:

```ts
if (mode === "plan" && KNOWN_TOOLS.has(toolName) && STATE_CHANGING_TOOLS.has(toolName))
```

Containment holds today — verified: all 38 `STATE_CHANGING_TOOLS` are among the 63 `KNOWN_TOOLS` — so the
middle term is dead. It is also load-bearing in the wrong direction: add a state-changing tool to one
whitespace-string list and forget the other, and plan mode stops **denying** it and downgrades to
**ask**. Two hand-maintained string lists, no test asserting the relation. **Fix:** drop the term; add
`STATE_CHANGING_TOOLS ⊆ KNOWN_TOOLS` as an assertion in `test-permission-policy.ts`.

**Status:** fixed in Task 7 (`5d32bd8`) - the guard is gone, and two tests pin the policy: `STATE_CHANGING_TOOLS ⊆ KNOWN_TOOLS`, and plan mode denies every state-changing tool by name.

### F5 — the strict-version refusal reads `process.env`, not the env it was handed

`agy-acp/src/agy/version.ts:26-36`. `checkAgyVersion(argv, timeoutMs, env)` spawns with `env` and then
decides policy from `process.env.AGY_ACP_STRICT_VERSION`. A caller that passes an environment — the
server does, `launch.ts:88` — cannot make the gate strict, and the comparison also re-implements
`config.ts`'s `envFlag` without its `trim()`. Two env sources in one function, one of them unreachable
by configuration. **Fix:** `envFlag(env, "AGY_ACP_STRICT_VERSION")`.

**Status:** fixed in Task 8 (`1c49901`) - the flag is read from the env the caller handed in, and the `envAccessLocation` invariant keeps `process.env` to the five files that are doors.

### F6 — quadratic stderr trimming

`agy-acp/src/agy/process.ts:246-253` trims the 64 KiB stderr budget **one code point at a time**, calling
`Buffer.byteLength` over the whole string each iteration. A child that dumps a megabyte in one chunk runs
~10⁶ iterations, each measuring ~64 KiB — on the event loop, while a turn is live. **Fix:** compute the
drop once by byte offset, then fix up a split code point.

**Status:** fixed in Task 9 (`9041ac3`) - one pass through `trimToByteBudget` over what it drops; a linearity test times 1 MiB against 64 KiB.

### F7 — the two one-shot `agy` probes are one routine written twice

`agy-acp/src/agy/version.ts:38-89` and `agy-acp/src/agy/models.ts:67-117` are the same 40-line machine —
spawn a one-shot `agy`, accumulate stdout/stderr, watchdog-SIGKILL the group, settle exactly once — with
different parsers. The comments cross-reference each other (*"agy/version.ts, same shape"*), which is the
copy admitting what it is. **Fix:** one `runAgyOneShot()` in `src/agy/one-shot.ts`; each caller keeps only
its parse-and-judge.

**Status:** fixed in Task 8 (`1c49901`) - one `runAgyOneShot` in `agy/one-shot.ts`, used by both probes, with the group kill it needed.

### F8 — turn settling is implemented five times, with inconsistent guards

`turn.ts:51-57`, `turn.ts:69-75`, `turn.ts:84-94` (`settleCancelled`), `turn.ts:103-107` (`settleTurn`),
and `session.ts:311-319` (`onExit`, by hand). `settleCancelled` checks `pending.settled`; `settleTurn`
does not. That is safe only because of an unstated invariant — *settled implies `pending === null`* —
which four of the five sites maintain by hand and nothing tests. **Fix:** one
`settleOnce(host, fn): boolean` that every path goes through, and an invariant forbidding
`pending.settled =` outside `turn.ts`.

**Status:** fixed in Task 10 (`9dd5bf2`) - `settleOnce` in `turn.ts` is the only writer of `pending.settled`, enforced by the `settleOwnership` invariant.

### F9 — `tool_info` is set to `undefined` on every step that has none

`agy-acp/src/agy/contract.ts:209` assigns unconditionally while every sibling optional (`text_delta`,
`usage`, `tool_name`, …) is assigned only when present. The property therefore exists with value
`undefined` on all non-tool steps. One of 11 `exactOptionalPropertyTypes` errors in `src/`.

**Status:** fixed in Task 2 (`3d9a759`) - `exactOptionalPropertyTypes` made the construction illegal, so the field is absent rather than present-and-undefined.

### F10 — 11 index reads typed as if they cannot be `undefined`

With `noUncheckedIndexedAccess`: `models.ts:61` (`match[1]`, `match[2]`), `agy/process.ts:52` and
`agy/version.ts:41` (`argv[0]` — an empty `argvPrefix` would exec `undefined`; `launch.ts:74` exists to
prevent exactly that, which is the admission that the type is lying), `config-options.ts:260` (`value[0]`),
`launch.ts:129/134/135` (`tokens[i]` used as an index key). Also `config-options.ts:79`: `agyModeFlag`
returns `AGY_MODE_FLAGS[modeId]`, declared `string | undefined` and typed `string` by the index signature
— honest only by accident of the return annotation.

**Status:** fixed in Task 3 (`739d3f1`) - `noUncheckedIndexedAccess` is on for `agy-acp/src/`; all 11 reads now prove themselves (`agy-acp/test/**` is exempt by a measured decision - see §4).

### F11 — no backpressure on the protocol channel, and `send()` lies about failure

`agy-acp/src/jsonrpc.ts:180-194`. The return of `this.output.write(frame)` is discarded, so a client that
stops reading makes a long turn's `session/update` stream grow Node's write buffer without bound.
`AgyProcess.sendRaw` (`agy/process.ts:114`) does check it and log. Worse, `send()` returns `true` after a
write that **threw**, against its own doc comment (*"Returns false when nothing was written"*), which
disables `sendResult`'s not-serializable fallback for that case.

**Status:** fixed in Task 9 (`9041ac3`) - `send()` returns a `SendOutcome`, backpressure is logged once per transition with a `drain` listener, and a write that throws rejects its request instead of resolving.

### F12 — the bridge socket buffers an unauthenticated peer without limit

`agy-acp/src/bridge-server.ts:148-156` accumulates `buf` until a newline arrives; the token check at
:166 happens only **after** the first line is complete. `maxHoldMs` bounds the time (~12 min by default),
nothing bounds the memory. `framing.ts` is this exact reader **with** a cap, built for the other socket.
**Fix:** reuse `FrameDecoder`, or cap at a documented ceiling and destroy.

**Status:** fixed in Task 9 (`9041ac3`) - 64 KiB per request line, checked before the token comparison, and the `inboundBufferCap` invariant requires every accumulating reader in `agy-acp/src/` to name a ceiling.

### F13 — parameter shadowing next to a closure that reads a `const` declared later

`agy-acp/src/server.ts:175-176`: the inner `(params, timeoutMs)` shadows `handleSessionNew`'s own
`params`, and the same closure reads `sessionId` — a `const` declared two statements later (:178). It
works only because nothing invokes it before the probe returns. `main.ts:88` is the same shape: the
`cleanup` closure reads `server`, declared at :92. Both are one reordering away from a TDZ throw on a
path that only fires under failure.

**Status:** fixed in Task 4 (`049b370`) - the closure reads a `let` assigned after `session.start()`, and `RpcError` now takes an `ErrorOptions` (`cause`).

### F14 — `spawn-agy.ts` promises an explicit env and ships `process.env`

`agy-acp/src/spawn-agy.ts:38-39` spreads `a.env ?? process.env` under a header that reads *"The env is
explicit, never inherited"*. The default **is** an implicit inherit; `lib/child-process.ts` making `env`
required bought the guarantee one layer down and this layer gives it back. Either the comment or the
default is wrong — decide which, in writing.

**Status:** fixed in Task 8 (`1c49901`) - the explicit env is what gets spawned; `envAccessLocation` ratchets the two remaining reads at 2 so neither can grow.

### Minor (each folded into the task that touches its file)

| Where | What | Status |
| --- | --- | --- |
| `prompt.ts:26` | *"Only embedded text is flammable"* → flattenable | fixed, Task 11 |
| `map-steps.ts:57` | dead `return` mid-`if/else` chain (biome `noUselessReturn`); the chain reads as if something follows it | fixed, Task 4 (biome) |
| `agy/process.ts:126` | `this.pendingProbe = this.probePromise = null` (chained assignment) | fixed, Task 4 (`noMultiAssign`) |
| `agy/process.ts:193-209` | `settle` is referenced by two closures declared above its own `const` | fixed, Task 11 |
| `agy/process.ts:138/184`, `version.ts:77`, `models.ts:94` | `if (…)` with a bare unbraced `try` statement as its body | fixed, Task 4 (`useBlockStatements`) |
| `turn.ts:42`, `permission-gate.ts:202`, `session-registry.ts:59` | assignment as an arrow-function body (`noReturnAssign`) | fixed, Task 4 (`noReturnAssign`) |
| 7 sites (`session.ts:119/133/245`, `session-selection.ts:90/108/120`, `server.ts:156`) | `throw new RpcError(...)` discards the caught error; `RpcError` has no `cause` | fixed, Task 4 (`RpcError` cause) |
| `permission-gate.ts:116-122` | `fs.realpathSync` per hook request, uncached, inside the async handler | fixed, Task 11 (resolved once, cached) |
| `agy/contract.ts:247` | on a JSON failure, returns `raw` (always `undefined`) and drops the line it could not parse | fixed, Task 11 (the line is kept as `raw`) |
| `agy/contract.ts:274-287` | `resultDeltas` never clamps; if agy's counters ever restart, negative usage goes to the client | fixed, Task 11 (clamped, with `clamped: true`) |

## 3. Why the current gate missed all of it

The gate is strong where it was aimed: exec location and timeouts, stdout ownership, `JSON.parse`
location, `globalThis`, file budgets, wired tests, and a ratchet with `--reason` on every widening. Its
blind spot is uniform — **it checks where code lives, not what the code says**:

1. `tsc` runs at `strict` but with the optionality flags off. The 22 type lies behind F9 and F10 are
   exactly what those flags print, and one of them (`argv[0]`) already forced a workaround at
   `launch.ts:74` instead of a fix.
2. `biome` runs `recommended` only; `noShadow` (F13), `noReturnAssign`, `noMultiAssign` are off.
3. Nothing checks commit time at all. The invariants run in CI on the branch head, so a commit made with
   `--no-verify` is indistinguishable from a verified one — and a bisect lands on commits the gate would
   have rejected.
4. F1–F8 and F11–F14 are semantic. No linter will find them; what finds them is a test at the boundary
   and a reviewer. The gate's job is to keep the *class* from returning: a cap on every inbound buffer,
   one settle path, one env door, one stdout drain.

## 4. Gate-hardening decisions, with the measurement behind each

| Candidate | Measured on `agy-acp/src` | Decision |
| --- | --- | --- |
| `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` | 0 errors each | **Adopt now**, no code change |
| `exactOptionalPropertyTypes` | 11 errors (incl. F9) | **Adopt**, fix the 11 |
| `noUncheckedIndexedAccess` | 11 in `src`, 128 in `test` | **Adopt for `src`**, fix the 11; `test/**` keeps a relaxed override (fixture indexing, no production risk) |
| `noPropertyAccessFromIndexSignature` | 170 in `src`, 382 in `test` | **Reject** — it fires on every `process.env.X` and every wire record; cost without signal |
| `suspicious/noShadow` | 2 hits, both real (F13) | **Adopt** |
| `suspicious/noReturnAssign` | 3 hits, all real | **Adopt** |
| `style/noMultiAssign` | 1 hit, real | **Adopt** |
| `style/useBlockStatements` | 182 hits, all autofixable | **Adopt** after one `--write` pass; it is what makes the unbraced `if (…) try {…}` bodies impossible |
| `style/useErrorCause` | 7 hits, all real | **Adopt** once `RpcError` takes a `cause` |
| `suspicious/noUnnecessaryConditions` | 23 hits — `session.ts:139/160/187/300`, `jsonrpc.ts:112/140/151/170/181`, `process.ts:111/120/194/213/238`, … | **Reject.** Flow-insensitive on fields initialised `false`, so it flags every `if (this.disposed) return` idempotency guard and misses F3 and F4 — the two conditions that are genuinely dead. Measured, not assumed |
| `performance/noAwaitInLoops` | 5 hits | **Reject** — `SessionRegistry.disposeOnce` awaits sequentially on purpose |
| `style/useNamingConvention` (112), `style/noTernary` (81), `style/noMagicNumbers` (24), `correctness/noNodejsModules` (21), `style/noProcessEnv` (13), `performance/noNamespaceImport` (12), `correctness/useQwikValidLexicalScope` (16) | — | **Reject** — wire fields are `snake_case` by contract, this is a Node server, and one rule is for a framework this repo does not use |
| New invariant `envAccessLocation` | 15 `process.env` reads across 9 files | **Add** — allowlist the config door (`config.ts`, `launch.ts`, `main.ts`, `bridge-hook.ts`, `bridge-server.ts`), ratchet the rest. This is what F5 and F14 are |
| New invariant `stdoutExitDrain` | 1 violation (F2) | **Add** — in `agy-acp/src/**`, a `process.exit` may not follow a `process.stdout.write` in the same function without the drain helper |
| New invariant `settleOwnership` | 5 sites (F8) | **Add** — `pending.settled =` only in `turn.ts` |
| New invariant `inboundBufferCap` | 2 readers, 1 capped (F12) | **Add** — a `+=` accumulation of socket/stdin data in `agy-acp/src/**` must live in a file that also names a byte ceiling |

## 5. Commit-time enforcement: what is actually enforceable

A local hook cannot be made unforgeable — the agent that would skip it can also read it. What *is*
achievable: make a skip **visible**, and make CI's verdict identical to the hook's. Each mechanic below
was tested in a throwaway repo before being written down.

| Verified fact | Consequence for the design |
| --- | --- |
| A **relative** `core.hooksPath` resolves per worktree (`HOOK RAN in …/wt`) | One committed `.githooks/` works in every Orca worktree; no absolute path, no per-worktree install |
| `git commit --no-verify` skips `pre-commit` **but not** `prepare-commit-msg` | The trailer must be gated on a sentinel that only `pre-commit` writes. A naive `prepare-commit-msg` trailer is stamped onto bypassed commits — observed |
| `git interpret-trailers --in-place --if-exists replace` keeps exactly one trailer across `--amend` | Without `--if-exists replace`, an amend accumulates trailers and the check misparses — observed |
| `git patch-id --stable` is **identical before and after a rebase** | Bind the trailer to the patch-id, not the tree oid: routine rebases stay valid, a bypass still has no trailer |
| The hook-side `git diff --cached --no-color HEAD \| git patch-id --stable` equals the CI-side `git diff-tree -p <sha> \| git patch-id --stable` | Hook and CI compute the same identity with no shared state |
| `git commit <path>` and `git commit -a` give the hooks the right index (`GIT_INDEX_FILE`) | Partial and `-a` commits verify correctly — observed |
| A merge commit runs `pre-merge-commit`, not `pre-commit`, and gets no trailer | CI exempts commits with more than one parent |

So: `pre-commit` runs the 5-second static gate and leaves a sentinel keyed to the staged patch-id;
`prepare-commit-msg` turns that sentinel into a `Quality-Gate:` trailer; CI's `commit-hygiene` job walks
`base..head` and fails on any non-merge, non-bot commit whose trailer is missing or whose patch-id does
not match. A bypass is then a red CI job that names the commit — not a silent landing.
