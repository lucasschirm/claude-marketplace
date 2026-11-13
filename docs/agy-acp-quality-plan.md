# agy-acp Quality Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 14 findings in `agy-acp/src`, and raise the gate so each one's *class* is caught by
`tsc`, by biome, by a repo invariant, or at commit time — before CI.

**Architecture:** Three layers, in this order. (1) **Gate first** — the repo's own idiom: the check lands
in the same commit as the code it governs, so the fix is verified by the thing that will keep it fixed.
(2) **Fixes**, each with the boundary test that would have caught it. (3) **Commit time** — a committed
`.githooks/` running the 5-second static gate, a `Quality-Gate:` trailer bound to the staged patch-id,
and a CI job that walks `base..head` and fails on any commit that carries no trailer. A local hook cannot
be unforgeable; this makes a skip *visible* and makes CI's verdict identical to the hook's.

**Tech Stack:** TypeScript (type-stripped, Node >= 23.6, no build), `node --test`, biome 2.5.15,
`scripts/check-quality.mjs` (invariants + ratchet), bash fixtures, GitHub Actions.

**Spec:** `docs/agy-acp-code-quality-review.md` — every finding (F1–F14), its evidence, and the measured
adopt/reject decision for every candidate rule. Executors read both.

## Global Constraints

- Node >= 23.6; `agy-acp` has **zero runtime dependencies** and no build step — nothing added here may
  introduce either.
- `npm run qa` is the definition of done for every task: `typecheck && lint && format:check && check &&
  validate && test:unit`.
- A metric that rises, falls to zero, or a changed `biome.jsonc` needs
  `npm run qa:baseline -- --write --reason "<a sentence, >= 4 words and >= 24 chars>"`. The reason lands
  in the baseline's visible `notes`.
- Every new invariant gets its fixture in `test/quality-gate-fixtures.sh` **in the same commit** — one
  case proving it fails on a minimal violation naming `file:line`, one proving each exemption does not
  fire. An invariant no fixture fails measures nothing.
- `agy-acp/src/**` keeps a 300-line per-file budget; `session.ts` is at 348 with a baseline entry, so it
  may only shrink.
- stdout is the protocol channel: only `jsonrpc.ts`, `main.ts`, `bridge-hook.ts` and `flush-stdout.ts`
  may write it (`agyStdoutFramesOnly`).
- Hooks must work from a git **worktree** (this repo is used through Orca worktrees): `core.hooksPath`
  stays **relative**.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

Input classes the spec implies that no task's happy path exercises. Each has its test assigned to the
task that owns the code:

1. **A surrogate pair ending exactly at the truncation boundary** — currently corrupted into a lone high
   surrogate (F1). A client should get a shorter, *valid* string. → Task 5.
2. **A hook decision on a pipe that has not drained when the process exits** — agy reads empty stdout as
   *allow* (F2). → Task 6.
3. **A tool call from a subagent conversation id** — must still be served and asked (F3); the condition
   that allows it reads as if it refuses it. → Task 7.
4. **A state-changing tool present in one policy list but not the other** — plan mode must still deny it
   (F4). → Task 7.
5. **A peer that sends bytes to the bridge socket and never a newline** — bounded time today, unbounded
   memory (F12); and a client that stops reading stdout mid-turn (F11). → Task 9.

---

## Task 1: `tsc` flags that cost nothing

**Files:** Modify `tsconfig.json`

**Interfaces:** Produces: no code surface; later tasks inherit the stricter compile.

- [ ] **Step 1: Add the four measured-free flags** to `compilerOptions`: `noImplicitReturns`,
      `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax` — each measured at **0 errors** over
      `agy-acp/**` (review §4). Replace the stale comment at `tsconfig.json:21`
      (*"P1 (lint owns these): verbatimModuleSyntax, noUnusedLocals, noUnusedParameters"*) with one line
      saying tsc owns them now and biome's `noUnusedVariables` stays as the faster signal.
- [ ] **Step 2: Verify** — Run `npm run typecheck`. Expected: clean.
- [ ] **Step 3: Verify the gate bites** — temporarily add `const unused = 1;` to
      `agy-acp/src/errors.ts`, run `npm run typecheck`, expect `error TS6133`, then revert.
- [ ] **Step 4: Commit** — `git add tsconfig.json && git commit -m "agy-acp: four strict flags that were already satisfied"`

## Task 2: `exactOptionalPropertyTypes`, and the 11 optionals that were lying (F9)

**Files:** Modify `tsconfig.json`, `agy-acp/src/agy/contract.ts:209`, `agy-acp/src/launch.ts:60,65,66,74`,
`agy-acp/src/config.ts:86`, `agy-acp/src/session.ts:83,89`, `agy-acp/src/spawn-agy.ts:36`,
`agy-acp/src/session-selection.ts:35`, `agy-acp/src/config-options.ts:209`
**Test:** `agy-acp/test/test-contract.ts`

**Interfaces:** Consumes: Task 1's tsconfig. Produces: `step_update` records no longer carry a
`tool_info` key when the step has none.

- [ ] **Step 1: Write the failing test** in `test-contract.ts`:

```ts
test("a non-tool step carries no tool_info key at all", () => {
  const parsed = parseAgyLine(JSON.stringify({ event: "step_update", step_update: { conversation_id: "c", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "hi" } }));
  assert.strictEqual(parsed.kind, "event");
  const step = (parsed.event as AgyStepUpdateEvent).step_update;
  assert.strictEqual(Object.hasOwn(step, "tool_info"), false, "an absent optional must be absent, not present-and-undefined");
});
```

- [ ] **Step 2: Run it** — `node --test agy-acp/test/test-contract.ts`. Expected: FAIL (the key exists).
- [ ] **Step 3: Fix `contract.ts:209`** — assign `tool_info` only when `toToolInfo(su.tool_info)` returns
      a value, matching the conditional style of every sibling optional on the same record.
- [ ] **Step 4: Enable the flag** — add `"exactOptionalPropertyTypes": true` to `tsconfig.json`, then run
      `npm run typecheck` and fix the remaining 10 errors. They are all the same shape: a field declared
      `x?: T` being handed `T | undefined`. Prefer **widening the declaration** to `x?: T | undefined`
      where the field genuinely means "may be explicitly absent" (`AgyLaunchOptions`, `LifecycleConfig`,
      `SelectionState`, `SelectionCommandsConfig`, `AgyProcessOptions`), and conditional assignment where
      the key should not exist (`contract.ts`). Do not introduce `as` casts or `!`.
- [ ] **Step 5: Verify** — `npm run typecheck && node --test agy-acp/test/test-contract.ts`. Expected:
      clean, PASS.
- [ ] **Step 6: Commit**

## Task 3: `noUncheckedIndexedAccess` for `src`, and the 11 index reads it exposes (F10)

**Files:** Modify `tsconfig.json`, create `agy-acp/test/tsconfig.json`, modify
`agy-acp/src/agy/models.ts:61`, `agy-acp/src/agy/process.ts:50-52`, `agy-acp/src/agy/version.ts:41`,
`agy-acp/src/config-options.ts:79,260`, `agy-acp/src/launch.ts:126-139`
**Test:** `agy-acp/test/test-config.ts`

**Interfaces:** Produces: `launchArgv()` returns a non-empty tuple type `[string, ...string[]]`;
`agyModeFlag(modeId: string): string | undefined` becomes honest.

- [ ] **Step 1: Write the failing tests** in `test-config.ts`:

```ts
test("an empty argvPrefix never reaches a spawn as argv[0] === undefined", () => {
  assert.strictEqual(withEnvDefaults({ argvPrefix: [] }).argvPrefix, undefined);
  assert.deepStrictEqual(launchArgv(withEnvDefaults({ argvPrefix: [] })), ["agy"]);
});
test("parseLaunchArgs refuses a value flag with no value", () => {
  assert.strictEqual(parseLaunchArgs(["--model"]), undefined);
  assert.strictEqual(parseLaunchArgs(["--effort", "--sandbox"]), undefined);
});
test("parseModelsTable skips a row whose id or name is missing", () => {
  assert.deepStrictEqual(parseModelsTable("gemini-3.8-flash-low\tFlash Low\nbroken-row\n\t\n"), [{ modelId: "gemini-3.8-flash-low", name: "Flash Low" }]);
});
```

- [ ] **Step 2: Run them** — `node --test agy-acp/test/test-config.ts`. Expected: PASS for the behaviour
      that already holds, and `launchArgv` is not exported yet → FAIL to compile. Export it from
      `launch.ts`; the tests then pin the behaviour the types are about to assert.
- [ ] **Step 3: Enable the flag for `src` only** — add `"noUncheckedIndexedAccess": true` to the root
      `tsconfig.json` and create `agy-acp/test/tsconfig.json` that extends the root with
      `"noUncheckedIndexedAccess": false` and `"include": ["./**/*.ts"]`, with a comment giving the
      measured reason: 128 fixture-indexing errors in tests, no production risk. Add the new tsconfig to
      `npm run typecheck` (`tsc --noEmit && tsc --noEmit -p agy-acp/test`) so tests stay typechecked.
- [ ] **Step 4: Fix the 11 errors** — `parseModelsTable` destructures the match instead of indexing;
      `launchArgv` returns `[string, ...string[]]` so `argv[0]` is known-present in `process.ts` and
      `version.ts`; `config-options.ts:260` guards the first character; `parseLaunchArgs` binds
      `const name = tokens[i]` with an explicit `if (name === undefined) break;` and looks each flag up
      once; `agyModeFlag` reads through a `Map` or keeps the `Record` with an explicit `?? undefined`.
- [ ] **Step 5: Verify** — `npm run typecheck && npm run test:unit`. Expected: clean, all PASS.
- [ ] **Step 6: Commit**

## Task 4: biome rules measured to earn their place (F13 + minors)

**Files:** Modify `biome.jsonc`, `agy-acp/src/errors.ts`, `agy-acp/src/server.ts:156,175-176`,
`agy-acp/src/session.ts:119,133,245`, `agy-acp/src/session-selection.ts:90,108,120`,
`agy-acp/src/turn.ts:42`, `agy-acp/src/permission-gate.ts:202`, `agy-acp/src/session-registry.ts:59`,
`agy-acp/src/agy/process.ts:126`, `agy-acp/src/map-steps.ts:57`
**Test:** `agy-acp/test/test-jsonrpc.ts`

**Interfaces:** Produces: `new RpcError(code, message, data?, options?: { cause?: unknown })` — the
`cause` is set on the Error so a wrapped failure keeps its origin.

- [ ] **Step 1: Write the failing test** in `test-jsonrpc.ts`:

```ts
test("RpcError keeps the error it wrapped as its cause", () => {
  const origin = new Error("bridge refused");
  const err = new RpcError(INTERNAL_ERROR, "the permission bridge could not start: bridge refused", undefined, { cause: origin });
  assert.strictEqual(err.cause, origin);
});
```

- [ ] **Step 2: Run it** — `node --test agy-acp/test/test-jsonrpc.ts`. Expected: FAIL.
- [ ] **Step 3: Add the `cause` parameter** to `RpcError` in `errors.ts` (pass it to `super` via
      `ErrorOptions`), then thread the caught error through the 7 `throw new RpcError` sites.
- [ ] **Step 4: Turn the rules on** in `biome.jsonc` — `suspicious.noShadow`, `suspicious.noReturnAssign`,
      `style.noMultiAssign`, `style.useErrorCause`, `style.useBlockStatements`, all `"error"`. Record the
      rejected candidates in the same comment block with their measured counts and the reason
      (`noUnnecessaryConditions` 23 hits / 0 true positives, `noPropertyAccessFromIndexSignature` 170,
      `noAwaitInLoops` 5 intentional, `useNamingConvention` 112 wire fields) so the next person does not
      re-litigate it from scratch.
- [ ] **Step 5: Apply the autofix and the hand fixes** — `npx biome lint --write agy-acp/src` clears the
      182 `useBlockStatements` hits; then by hand: rename the shadowed `params` in `server.ts:175` to
      `permissionParams` and hoist `const sessionId` above the `AgySession` construction so the closure
      no longer reads a later binding (F13); give the three arrow-body assignments statement bodies;
      split the chained assignment in `process.ts:126`; delete the dead `return` in `map-steps.ts:57` by
      rewriting the chain as an early-return guard.
- [ ] **Step 6: Re-record the baseline** — `biome.jsonc` is part of `biomeConfigHash`, so
      `npm run qa:baseline -- --write --reason "enable noShadow, noReturnAssign, noMultiAssign, useErrorCause and useBlockStatements on agy-acp after fixing all 195 hits; rejected rules recorded with counts"`
- [ ] **Step 7: Verify** — `npm run qa`. Expected: every gate clean.
- [ ] **Step 8: Commit**

## Task 5: `truncate()` stops cutting valid characters in half (F1)

**Files:** Modify `agy-acp/src/update-map.ts:96-102`
**Test:** `agy-acp/test/test-sessions.ts`

**Interfaces:** `truncate(text: string, maxChars: number): string` — unchanged signature; the output is
now always well-formed UTF-16.

- [ ] **Step 1: Write the failing test** in `test-sessions.ts`:

```ts
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
test("truncate never emits a lone surrogate, at or around a pair boundary", () => {
  // "ab😀cd": a b D83D DE00 c d — the pair ends exactly at maxChars 4
  assert.strictEqual(truncate("ab\u{1F600}cd", 4), "ab\u{1F600}\n… [truncated, 6 characters total]");
  assert.strictEqual(truncate("ab\u{1F600}cd", 3), "ab\n… [truncated, 6 characters total]");
  for (let max = 1; max <= 6; max++) assert.strictEqual(LONE_SURROGATE.test(truncate("ab\u{1F600}cd", max)), false, `maxChars ${max}`);
  assert.strictEqual(truncate("abc", 3), "abc", "a string at the limit is returned untouched");
});
```

- [ ] **Step 2: Run it** — `node --test agy-acp/test/test-sessions.ts`. Expected: FAIL at `maxChars 4` —
      `"ab\ud83d\n… [truncated, 6 characters total]"`.
- [ ] **Step 3: Fix the range** — test the last code unit against the **high** surrogate range
      (`0xD800–0xDBFF`) only, using `charCodeAt`, not `codePointAt`, so the intent is unambiguous; keep
      the comment but say which half it drops and why the other half is already whole.
- [ ] **Step 4: Verify** — `node --test agy-acp/test/test-sessions.ts`. Expected: PASS.
- [ ] **Step 5: Commit**

## Task 6: the hook's decision reaches agy before the process ends (F2)

**Files:** Modify `agy-acp/src/bridge-hook.ts:26-42`, `scripts/check-quality.mjs` (new invariant
`stdoutExitDrain`), `test/quality-gate-fixtures.sh`
**Test:** `agy-acp/test/test-bridge.ts`

**Interfaces:** Produces: no API change. The invariant: in `agy-acp/src/**`, a `process.exit` may not be
reached from a function that also calls `process.stdout.write` unless the write passes a callback or the
file is `flush-stdout.ts`.

- [ ] **Step 1: Write the failing test** in `test-bridge.ts` — run the real hook as a child with its
      stdout on a **pipe**, a decision large enough to exceed one write (pad the deny reason to 256 KiB
      via the bridge reply), and assert the parent reads the whole JSON line:

```ts
test("the hook's decision is not truncated by its own exit, even when it does not fit one write", async () => {
  const reason = `denied by agy-acp: ${"x".repeat(256 * 1024)}. Do not retry this call.`;
  const { stdout, code } = await runHookAgainstBridge({ reply: { decision: "deny", reason } });
  assert.strictEqual(code, 0);
  const decision = JSON.parse(stdout);
  assert.strictEqual(decision.decision, "deny");
  assert.strictEqual(decision.reason.length, reason.length, "the whole reason reached agy");
});
```

- [ ] **Step 2: Run it** — `node --test agy-acp/test/test-bridge.ts`. Expected: FAIL (truncated JSON /
      `SyntaxError`) on a platform with async pipe writes, and on Linux it passes for the wrong reason —
      which is why Step 3 is a structural fix and Step 5 is an invariant, not just this test.
- [ ] **Step 3: Fix `finish()`** — write with a completion callback and exit from it, with a bounded
      fallback timer (reuse `FLUSH_TIMEOUT_MS` from `flush-stdout.ts`, or `flushStdout()` directly) so a
      wedged stdout still exits. Keep every other property: idempotent, one JSON object, always exit 0.
      Update the file header to name the drain as part of the fail-closed guarantee.
- [ ] **Step 4: Verify** — `node --test agy-acp/test/test-bridge.ts`. Expected: PASS.
- [ ] **Step 5: Add the `stdoutExitDrain` invariant** to the `INVARIANTS` array in
      `scripts/check-quality.mjs` (shape: `{ name, description, measure: () => ({ count, hits }) }`,
      hits as `file:line`), scanning `agyAcpSrcFiles()`.
- [ ] **Step 6: Prove the invariant bites** — add two cases to `test/quality-gate-fixtures.sh`:
      `qa fail "a stdout write followed by process.exit without a drain fails stdoutExitDrain" --only stdoutExitDrain --full`
      against a minimal violation, and `qa pass "flush-stdout.ts is exempt" --only stdoutExitDrain --full`.
- [ ] **Step 7: Verify** — `bash test/run.sh quality-fixtures && npm run check`. Expected: both pass.
- [ ] **Step 8: Commit**

## Task 7: the permission policy says what it means (F3, F4)

**Files:** Modify `agy-acp/src/bridge-server.ts:171-178`, `agy-acp/src/permission.ts:49-85,167`
**Test:** `agy-acp/test/test-permission-policy.ts`, `agy-acp/test/test-bridge.ts`

**Interfaces:** Produces: `STATE_CHANGING_TOOLS` exported for the containment assertion.

- [ ] **Step 1: Write the failing tests.** In `test-permission-policy.ts`:

```ts
test("every state-changing tool is a known tool (the two lists cannot drift apart)", () => {
  const unknown = [...STATE_CHANGING_TOOLS].filter((t) => !KNOWN_TOOLS.has(t));
  assert.deepStrictEqual(unknown, [], "a state-changing tool missing from KNOWN_TOOLS stops being denied in plan mode");
});
test("plan mode denies a state-changing tool even if it is not in KNOWN_TOOLS", () => {
  const decision = decidePolicy({ mode: "plan", toolName: "run_command", args: { CommandLine: "rm -rf /" }, workspaceRoots: ["/ws"], baseDir: "/ws", bridgeDir: "/b", socketPath: "/b/socket" });
  assert.deepStrictEqual(decision, { kind: "deny", reason: PLAN_DENY_REASON });
});
```

  In `test-bridge.ts`:

```ts
test("the bridge serves a subagent's own conversation id and refuses only an empty one", async () => {
  assert.strictEqual(await askBridge({ conversationId: "sub-conversation-42" }), "answered", "a subagent's id is served (the token is the boundary)");
  assert.strictEqual(await askBridge({ conversationId: "" }), "closed", "an empty id is refused without a reply");
});
```

- [ ] **Step 2: Run them** — `node --test agy-acp/test/test-permission-policy.ts agy-acp/test/test-bridge.ts`.
      Expected: the containment test PASSES (it is the regression guard), the plan-mode and subagent
      tests PASS against today's behaviour — they are what makes Step 3 safe to do.
- [ ] **Step 3: Remove the dead terms** — drop `KNOWN_TOOLS.has(toolName) &&` from `permission.ts:167`,
      and rewrite `bridge-server.ts:172` as `if (expected === null || req.conversationId === "")` with the
      comment kept and sharpened: an empty id is the unprobed/unknown case; a *different* non-empty id is
      a subagent and is served on purpose, so this is not a mismatch test and must not become one.
- [ ] **Step 4: Verify** — `node --test agy-acp/test/test-permission-policy.ts agy-acp/test/test-bridge.ts`.
      Expected: PASS, unchanged behaviour.
- [ ] **Step 5: Commit**

## Task 8: one env door, one one-shot runner (F5, F7, F14)

**Files:** Create `agy-acp/src/agy/one-shot.ts`; modify `agy-acp/src/agy/version.ts`,
`agy-acp/src/agy/models.ts`, `agy-acp/src/spawn-agy.ts:38-39`, `scripts/check-quality.mjs` (new
invariant `envAccessLocation`), `test/quality-gate-fixtures.sh`
**Test:** `agy-acp/test/test-process.ts`

**Interfaces:** Produces:

```ts
export interface OneShotResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; }
/** One bounded `agy <subcommand>`: own process group, watchdog SIGKILL on the group, settles exactly once. */
export function runAgyOneShot(argv: string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<OneShotResult>;
```

  Consumed by `checkAgyVersion` (parses the first token of the first non-empty line) and `listAgyModels`
  (parses the `id<TAB>name` table). Both keep their current error texts, which tests assert on.

- [ ] **Step 1: Write the failing tests** in `test-process.ts`:

```ts
test("AGY_ACP_STRICT_VERSION is read from the env the caller passed, not the process's", async () => {
  const status = await checkAgyVersion([process.execPath, FAKE_AGY, "--version"], 5000, { ...process.env, AGY_ACP_STRICT_VERSION: "1", FAKE_AGY_VERSION: "9.9.9" });
  assert.strictEqual(status.strictRefusal, true, "the injected env must decide the refusal");
});
test("runAgyOneShot kills the process group when the binary ignores SIGTERM", async () => {
  const result = await runAgyOneShot([process.execPath, IGNORES_SIGTERM], 300, process.env);
  assert.notStrictEqual(result.signal, null);
});
```

- [ ] **Step 2: Run them** — `node --test agy-acp/test/test-process.ts`. Expected: FAIL (the first reads
      `process.env`; the second has no such function).
- [ ] **Step 3: Extract `runAgyOneShot`** into `src/agy/one-shot.ts` from the two copies
      (`version.ts:38-89`, `models.ts:67-117`), keeping every property the copies had: `spawnProcessGroup`
      with a named `timeoutMs`, `"close"` not `"exit"`, a single `settled` latch, and a watchdog that
      SIGKILLs `-pid`. Rewrite both callers to parse-and-judge only. The file lives under `src/agy/`, so
      `execLocation` still allows the spawn only through `lib/child-process.ts`.
- [ ] **Step 4: Fix the env sources** — `version.ts` reads the strict flag with `envFlag(env, …)` from
      `config.ts`, and drops the unused `= process.env` default parameters. In `spawn-agy.ts`, keep
      `a.env ?? process.env` but correct the header to say what it does: the session env defaults to this
      process's environment, and `lib/child-process.ts` requires it to be passed explicitly so the
      inherit is a decision made here and nowhere else.
- [ ] **Step 5: Verify** — `node --test agy-acp/test/test-process.ts && npm run typecheck`. Expected:
      PASS, clean.
- [ ] **Step 6: Add the `envAccessLocation` invariant** — `process.env` may be read only in
      `agy-acp/src/config.ts`, `launch.ts`, `main.ts`, `bridge-hook.ts`, `bridge-server.ts` (the config
      door and the two processes that have no caller to be handed one by); everywhere else takes the
      environment as a parameter. 15 reads across 9 files today; the allowlist covers 10, and Steps 3–4
      remove the rest. Count the remainder and ratchet it.
- [ ] **Step 7: Prove it bites** — fixtures: one `qa fail` for a `process.env` read in a non-door file,
      one `qa pass` for `config.ts`.
- [ ] **Step 8: Verify** — `bash test/run.sh quality-fixtures && npm run qa`. Expected: all pass.
- [ ] **Step 9: Commit**

## Task 9: every inbound buffer has a ceiling (F6, F11, F12)

**Files:** Modify `agy-acp/src/agy/process.ts:246-253`, `agy-acp/src/bridge-server.ts:148-156`,
`agy-acp/src/jsonrpc.ts:180-194`, `scripts/check-quality.mjs` (new invariant `inboundBufferCap`),
`test/quality-gate-fixtures.sh`
**Test:** `agy-acp/test/test-process.ts`, `agy-acp/test/test-bridge.ts`, `agy-acp/test/test-jsonrpc.ts`

**Interfaces:** Produces: `BRIDGE_MAX_REQUEST_BYTES` exported from `bridge-server.ts` (64 KiB — a hook
request is a tool name plus its args); `send()` returns `false` when the write threw.

- [ ] **Step 1: Write the failing tests.**

```ts
// test-process.ts — F6: the trim must be linear, not one code point per pass
test("a megabyte of stderr in one chunk is trimmed to the budget promptly", () => {
  const proc = fakeAgyProcess({ stderrBytes: 64 * 1024 });
  const started = Date.now();
  proc.feedStderr("x".repeat(1024 * 1024));
  assert.ok(Buffer.byteLength(proc.stderrTail) <= 64 * 1024);
  assert.ok(Date.now() - started < 250, `trimming took ${Date.now() - started} ms`);
});
// test-bridge.ts — F12: an unauthenticated peer cannot grow the server's memory
test("the bridge drops a request line that exceeds the cap, before any token check", async () => {
  const outcome = await rawBridgeWrite("y".repeat(BRIDGE_MAX_REQUEST_BYTES + 1));
  assert.strictEqual(outcome, "closed");
  assert.match(logs.join("\n"), /oversized request/);
});
// test-jsonrpc.ts — F11: a failed write is not a successful send
test("a result that cannot be written is answered with an internal error, not silence", () => {
  const output = throwingWritable();
  // ... assert send() reported failure and an error response was attempted
});
```

- [ ] **Step 2: Run them** — expect three failures (slow trim; the oversized line is buffered and only
      the hold timer closes it; `send()` returns `true` after a throw).
- [ ] **Step 3: Fix the three readers** — `appendStderr` computes the byte overflow once and slices from
      a single offset, then walks back at most one code point; `handleConnection` counts bytes and
      destroys with a log past `BRIDGE_MAX_REQUEST_BYTES` *before* the token check (the cheapest check
      first, matching `framing.ts`'s overflow path); `send()` returns `false` from its `catch`, and
      `notify`/`sendResult`/`sendError` keep their existing closed-connection guards so a dead
      connection still does not recurse. Also check `output.write`'s return and log backpressure once per
      transition, the way `sendRaw` already does.
- [ ] **Step 4: Verify** — `npm run test:unit`. Expected: all PASS.
- [ ] **Step 5: Add the `inboundBufferCap` invariant** — in `agy-acp/src/**`, a string accumulation of
      stream data inside a `"data"` handler must live in a file that also names a byte ceiling
      (`maxFrameBytes`, `BRIDGE_MAX_REQUEST_BYTES`, `stderrLimit`, …). There are **8 such accumulations
      in 5 files today** (`bridge-server.ts:152`, `bridge-hook.ts:91,118`, `agy/process.ts:247`,
      `agy/version.ts:69,72`, `agy/models.ts:86,89`); only `agy/process.ts` is capped. Step 3 caps
      `bridge-server.ts`; cap `bridge-hook.ts`'s two as well (agy writes that payload, but the hook is
      the security boundary and must not be the one unbounded reader). The four in the one-shot probes
      become two when Task 8 extracts `runAgyOneShot`: cap them there at a named
      `ONE_SHOT_MAX_OUTPUT_BYTES` rather than exempting them on the timeout — a `--version` that prints a
      gigabyte is not a case worth holding memory for. Final count: 0 uncapped.
- [ ] **Step 6: Prove it bites** — fixtures: one `qa fail` for an uncapped accumulator, one `qa pass` for
      `framing.ts`.
- [ ] **Step 7: Verify** — `bash test/run.sh quality-fixtures && npm run qa`.
- [ ] **Step 8: Commit**

## Task 10: one way a turn settles (F8)

**Files:** Modify `agy-acp/src/turn.ts`, `agy-acp/src/session.ts:298-320`, `scripts/check-quality.mjs`
(new invariant `settleOwnership`), `test/quality-gate-fixtures.sh`
**Test:** `agy-acp/test/test-lifecycle.ts`

**Interfaces:** Produces:

```ts
/** Settles the in-flight turn exactly once; false when there was nothing to settle. The only writer of `pending.settled`. */
export function settleOnce(host: TurnSettleHost, settle: (pending: PendingTurn) => void): boolean;
```

  Used by `runTurn`'s two failure paths, `settleCancelled`, `settleTurn`, and `AgySession.onExit`.

- [ ] **Step 1: Write the failing test** in `test-lifecycle.ts`:

```ts
test("a result arriving after a cancel cannot settle the turn twice", async () => {
  const session = await startSession(FIXTURE_CANCEL_THEN_RESULT);
  const turn = session.prompt([{ type: "text", text: "go" }]);
  session.cancel();
  assert.deepStrictEqual(await turn, { stopReason: "cancelled" });
  await deliverResult(session, { status: "SUCCESS" });      // the late result
  assert.strictEqual(updates.filter((u) => u.sessionUpdate === "usage_update").length, 0, "a settled turn emits nothing further");
});
test("a child that exits mid-turn rejects through the same single settle path", async () => { /* … asserts one rejection, tools failed once */ });
```

- [ ] **Step 2: Run it** — `node --test agy-acp/test/test-lifecycle.ts`. Expected: PASS today (the
      `pending === null` invariant holds by hand) — it is the guard that makes the refactor safe.
- [ ] **Step 3: Add `settleOnce` and route all five sites through it**, including `session.ts:onExit`,
      which currently assigns `pending.settled` and `this.pending` itself. State the invariant it
      enforces in the function's doc comment.
- [ ] **Step 4: Verify** — `node --test agy-acp/test/test-lifecycle.ts agy-acp/test/test-sessions.ts`.
      Expected: PASS.
- [ ] **Step 5: Add the `settleOwnership` invariant** — `pending.settled =` (and `.settled = true` on a
      turn) may appear only in `agy-acp/src/turn.ts`. Plus a fixture pair.
- [ ] **Step 6: Verify** — `bash test/run.sh quality-fixtures && npm run qa`.
- [ ] **Step 7: Commit**

## Task 11: the leftovers, each in the file it lives in

**Files:** Modify `agy-acp/src/prompt.ts:26`, `agy-acp/src/agy/contract.ts:242-249,274-287`,
`agy-acp/src/permission-gate.ts:116-122`, `agy-acp/src/agy/process.ts:193-209`, `agy-acp/src/main.ts:84-99`
**Test:** `agy-acp/test/test-contract.ts`, `agy-acp/test/test-bridge.ts`

- [ ] **Step 1: Write the failing tests:**

```ts
// test-contract.ts
test("an unparseable line keeps the text it could not parse", () => {
  const parsed = parseAgyLine("{not json");
  assert.strictEqual(parsed.kind, "unknown");
  assert.strictEqual(parsed.raw, "{not json", "the line is the evidence; undefined is not");
});
test("a cumulative counter that went backwards clamps to zero and logs", () => {
  const delta = resultDeltas({ ...RESULT, usage: { ...ZERO_USAGE, total_tokens: 5 } }, { usage: { ...ZERO_USAGE, total_tokens: 50 }, num_turns: 3, duration_seconds: 9 });
  assert.strictEqual(delta.usage.total_tokens, 0, "a client is never told a turn used negative tokens");
  assert.strictEqual(delta.num_turns, 0);
});
// test-bridge.ts
test("the workspace root is resolved once per session, not once per hook request", async () => {
  const calls = countRealpathCalls(() => askBridgeTwice());
  assert.strictEqual(calls, 1);
});
```

- [ ] **Step 2: Run them** — expect three failures.
- [ ] **Step 3: Fix each** — `parseAgyLine` carries the line as `raw` on the parse-failure branch;
      `resultDeltas` clamps each counter at 0 and the driver logs the backwards jump once;
      `PermissionGate` resolves `workspaceRoots` lazily **once** and caches it (the cwd cannot change
      mid-session), removing the sync `realpathSync` from the per-request async path; `waitThen` declares
      `settle` before the two closures that call it; `main.ts` hoists the server construction above
      `createShutdown` (or passes a getter) so `cleanup` no longer closes over a `const` declared later;
      `prompt.ts:26` says *flattenable*.
- [ ] **Step 4: Verify** — `npm run test:unit`. Expected: all PASS.
- [ ] **Step 5: Commit**

## Task 12: the commit-time gate (`.githooks/`, installed, bypassable only in the open)

**Files:** Create `.githooks/pre-commit`, `.githooks/prepare-commit-msg`, `.githooks/pre-push`,
`scripts/install-hooks.mjs`, `scripts/quality-gate-trailer.mjs`; modify `package.json`, `test/run.sh`
**Test:** `test/test-commit-hooks.ts`

**Interfaces:** Produces:
- `npm run qa:static` = `typecheck && lint && format:check && check && validate` — **measured 5.0 s**, the
  exact command the hook and CI both run (tests are pre-push, not pre-commit: the suites take 14.7 s).
- `npm run hooks:install` → sets `core.hooksPath` to the **relative** `.githooks`; also run from
  `prepare`, so `npm install` installs the hooks.
- Trailer format: `Quality-Gate: v1 <patch-id>` where `<patch-id>` is
  `git diff --cached --no-color HEAD | git patch-id --stable`. Verified: identical to the CI-side
  `git diff-tree -p <sha> | git patch-id --stable`, and **stable across a rebase**.
- Sentinel: `$(git rev-parse --git-dir)/quality-gate-<patch-id>`, written by `pre-commit`, consumed and
  removed by `prepare-commit-msg`. Required because **`--no-verify` skips `pre-commit` but not
  `prepare-commit-msg`** (verified) — without the sentinel the trailer is stamped onto bypassed commits.

- [ ] **Step 1: Write the failing test** `test/test-commit-hooks.ts` — `node:test`, shelling out to
      `git` (the house pattern: `test/test-git-repo.ts`, `test/test-worktree-safety.ts`). It builds
      throwaway repos under `fs.mkdtempSync`, points `core.hooksPath` at this repo's `.githooks`, and
      asserts, each case naming what it proves. A `.ts` file here is deliberate: `wiredTests` only
      governs `test-*.ts`, so the suite cannot be forgotten.

```
1. a normal commit  -> gate ran, trailer present, patch-id matches        -> PASS
2. git commit --no-verify -> no trailer at all                            -> the bypass is visible
3. a trailer copied from another commit -> patch-id mismatch              -> forgery is detectable
4. git commit --amend -> exactly one trailer, matching the new patch-id   -> --if-exists replace
5. git commit <path> and git commit -a -> trailer matches the commit      -> the partial-index paths
6. a commit from a second worktree -> gate ran there too                  -> relative hooksPath
7. a merge commit -> no trailer, and the checker accepts it               -> exempt by parent count
8. a failing gate -> exit non-zero, nothing committed                     -> the hook actually blocks
9. QA_SKIP_HOOKS=1 -> commit succeeds with no trailer                     -> opting out is allowed, and loud
```

- [ ] **Step 2: Run it** — `node --test test/test-commit-hooks.ts`. Expected: FAIL at case 1 (no hooks exist).
- [ ] **Step 3: Write the hooks.**
      `pre-commit`: refuse when `node_modules/.bin/tsc` is missing, naming the reason the way
      `test/run.sh` already does (*"typescript is not installed - run 'npm install' first"*) — a commit
      that cannot be verified must not look verified; honour `QA_SKIP_HOOKS=1` by exiting 0 **without**
      writing the sentinel; otherwise run `npm run qa:static`, and on success write the sentinel for the
      staged patch-id.
      `prepare-commit-msg`: exit 0 unless the sentinel for the current staged patch-id exists; else
      `git interpret-trailers --in-place --if-exists replace --trailer "Quality-Gate: v1 <patch-id>"`.
      `pre-push`: `npm run test:unit` (the 14.7 s suites), skippable the same way.
      All three are `#!/bin/sh`, delegate their logic to `scripts/quality-gate-trailer.mjs` so the shell
      stays trivial, and are `chmod +x`.
- [ ] **Step 4: Write `scripts/install-hooks.mjs`** — sets `core.hooksPath .githooks`, prints what it
      did, and exits **0** when there is no git dir (a tarball install must not fail `npm install`). Add
      `"prepare": "node scripts/install-hooks.mjs"`, `"hooks:install"`, and `"qa:static"` to
      `package.json`.
- [ ] **Step 5: Verify** — `node --test test/test-commit-hooks.ts`. Expected: 9/9 PASS.
- [ ] **Step 6: Wire it into `test/run.sh`** — add `test/test-commit-hooks.ts` to `UNIT_TESTS`, so it
      runs in CI's existing fast `manifests-and-unit-tests` job and needs no new matrix entry.
      `npm run check` fails until it is wired, which is the gate doing its job.
- [ ] **Step 7: Verify** — `npm run test:unit && npm run check`.
- [ ] **Step 8: Commit** — and confirm the commit carries its own `Quality-Gate:` trailer
      (`git log -1 --format='%(trailers:key=Quality-Gate,valueonly)'` is non-empty): the hook's first
      real use is the commit that adds it.

## Task 13: CI fails a branch whose commits skipped the gate

**Files:** Create `scripts/check-commit-hygiene.mjs`; modify `.github/workflows/ci.yml`
**Test:** `test/test-commit-hooks.ts` (cases 10–13)

**Interfaces:** Produces `node scripts/check-commit-hygiene.mjs --base <ref> --head <ref>` → exit 0, or
exit 1 listing every offending commit as `<short-sha> <subject> — <reason>` plus the two ways to fix it
(re-commit with hooks installed, or rebase). Exempt: merge commits (>1 parent), commits whose author is
the version-bump bot, and anything before `--base`.

- [ ] **Step 1: Add the failing cases** to `test/test-commit-hooks.ts`:

```
10. a branch of hooked commits            -> check-commit-hygiene exits 0
11. a branch with one --no-verify commit  -> exits 1, names that commit and no other
12. a branch rebased onto a moved base    -> exits 0 (patch-id survived the rebase)
13. a branch whose only commit is a merge -> exits 0 (exempt)
```

- [ ] **Step 2: Run** — `node --test test/test-commit-hooks.ts`. Expected: FAIL at 10 (no such script).
- [ ] **Step 3: Write `scripts/check-commit-hygiene.mjs`** — walk `git rev-list --no-merges base..head`,
      read each commit's trailer with `git log -1 --format='%(trailers:key=Quality-Gate,valueonly)'`, and
      compare against `git diff-tree -p <sha> | git patch-id --stable`. Zero dependencies, no `JSON.parse`
      of inbound text (the `jsonParseLocation` invariant), and `spawnSync` with an explicit timeout
      (`execTimeout`) — note it lives in `scripts/`, which the source invariants do not scan, but the
      style is the house style.
- [ ] **Step 4: Verify** — `node --test test/test-commit-hooks.ts`. Expected: 13/13 PASS.
- [ ] **Step 5: Add the `commit-hygiene` job to `.github/workflows/ci.yml`** — needs nothing, runs before
      `quality` so a bypass is reported in seconds: `actions/checkout@v4` with `fetch-depth: 0`, then the
      script with `--base ${{ github.event.pull_request.base.sha }} --head ${{ github.sha }}` on a PR, and
      on a push to `main` with `--base ${{ github.event.before }}`. Add a step to the existing `quality`
      job that runs `npm run qa:static` **by that exact name**, so the hook and CI can never diverge —
      one script, two callers, the same idiom as `node scripts/check-quality.mjs --only wiredTests` in
      `test/run.sh`.
- [ ] **Step 6: Verify** — `node scripts/check-commit-hygiene.mjs --base origin/main --head HEAD` on this
      branch. Expected: it names the commits made before Task 12 landed. Decide the cutover in writing:
      pass `--base` as the first commit that carries a trailer (recorded in the workflow with a comment),
      so history before the hook is not retroactively failed.
- [ ] **Step 7: Commit**

## Task 14: the documentation that keeps it true

**Files:** Modify `CLAUDE.md`, `agy-acp/README.md`, `docs/agy-acp-code-quality-review.md`

- [ ] **Step 1: `CLAUDE.md`** — under "Validating changes", add: `npm run qa:static` is what the
      pre-commit hook runs and what CI re-runs; `npm run hooks:install` (automatic via `prepare`); a
      commit without a `Quality-Gate:` trailer fails the `commit-hygiene` job, and `QA_SKIP_HOOKS=1` is
      the supported way to skip — it does not hide the skip. List the four new invariants with the others.
- [ ] **Step 2: `agy-acp/README.md`** — correct the hook paragraph (§"The permission bridge") to say the
      decision is **drained** before the exit, and add the clamped-usage and capped-request-line
      behaviours to the driver and bridge sections.
- [ ] **Step 3: `docs/agy-acp-code-quality-review.md`** — add a "Status" line per finding (fixed in which
      task) so the review stays the record of what was found and what became of it.
- [ ] **Step 4: Re-record the baseline** —
      `npm run qa:baseline -- --write --reason "agy-acp quality pass: four new invariants (stdoutExitDrain, envAccessLocation, inboundBufferCap, settleOwnership) and the strict tsc flags land with the fixes they govern"`
- [ ] **Step 5: Verify** — `npm run qa && bash test/run.sh`. Expected: every suite passes.
- [ ] **Step 6: Commit**

---

## Self-review

**Spec coverage.** F1 → Task 5. F2 → Task 6. F3, F4 → Task 7. F5, F7, F14 → Task 8. F6, F11, F12 →
Task 9. F8 → Task 10. F9 → Task 2. F10 → Task 3. F13 → Task 4. Every minor in the review's table is
named in Task 4 or Task 11. Every gate decision in review §4 is in Task 1 (free flags), Task 2, Task 3,
Task 4 (biome, including the recorded rejects) or the four new invariants (Tasks 6, 8, 9, 10). Review §5's
seven verified git mechanics are each load-bearing in Task 12 or 13.

**Dependencies.** Tasks 1–4 are gate changes and must land first: Task 2 and 3 fix what their flag
exposes, so neither can be split from its flag. Tasks 5–11 are independent of each other and can run in
any order after Task 4 (Task 4's `useBlockStatements` autofix touches many files, so running it before
them avoids conflicts). Task 12 must precede Task 13 (the trailer exists before the check for it), and
Task 14 is last.

**Proportion.** 14 tasks for 14 findings plus 8 gate changes, with no code bodies except three one-line
algorithms the signatures do not determine. Each task ends with a command whose output decides whether it
passed.

**Known residual risks, stated rather than designed around.**
- A local hook is forgeable by anything that can read it. The trailer buys visibility of a skip, not
  prevention; CI re-running `qa:static` on the head is the enforcement.
- `commit-hygiene` is a new way for CI to go red for a reason unrelated to the code. The `QA_SKIP_HOOKS`
  escape, the merge/bot exemptions, the rebase-stable patch-id and the `--base` cutover exist to keep its
  false-positive rate at zero; cases 2–9 and 10–13 of `test-commit-hooks.ts` are what prove that.
- `noUncheckedIndexedAccess` is off for `agy-acp/test/**` by a measured decision (128 errors, fixtures
  only). If a test ever indexes production data, the flag will not catch it.
