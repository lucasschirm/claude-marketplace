# Plan: `devin_delegate` → `delegate_task` with pluggable ACP drivers

Status: **implemented on this branch** — both drivers (`devin`, `claude`), the deprecated `devin_*`
aliases, the new storage root with legacy reads, and the suites are in. The removal PR that drops the
old names is a separate change, per **§11**. Research run `aquamarine-thunbergia` (devin) is reconciled
against the real tree in **§16**, which also records one research claim that did not survive checking
and one **security incident that needs your action**.

Tool versions this plan was written against: `devin` 3000.11.234, Claude Code 2.1.317,
`@agentclientprotocol/claude-agent-acp` 0.100.0, `agy` 1.4.12 (`agy-acp` was spike-tested against
1.4.2 — the version gate warns, it only refuses under `AGY_ACP_STRICT_VERSION=1`).

Date of investigation: 2026-11-06. Branch: `Delegate`.

---

## 1. Goal

Turn the single-agent `devin_*` tool family into a generic `delegate_task` family that talks to any
Agent Client Protocol (ACP) agent through a **driver**, starting with Devin and Claude Code (and with
this repo's own `agy-acp` as the third test case, because it is a server we control).

`delegate_task` takes `agent`, `model`, `thinking`, `mode`, `prompt` (+ `create_worktree`).

### Non-goals

- Not a general job runner, not a replacement for `orca_orchestration_dispatch` (that spawns *pi
  workers in Orca*; this spawns *ACP agents*). The two stay separate tools with separate docs.
- Not a rewrite of the reliability work already shipped (`docs/devin-delegate-reliability-plan.md`).
  Behaviour that is tested today must survive the move; this is a seam refactor, not a redesign.
- Not renaming the **Devin CLI plugins** under `plugins/*` (`.devin-plugin/` manifests,
  `plugins/multiagent-development/skills/delegating-to-devin/`). Those target the Devin CLI product,
  not the Pi extension, and are out of scope.
- No third-party driver *plugin loading* (dynamic import of user code). Drivers are compiled in;
  "plug and play" means a declarative descriptor, see §8.

---

## 2. As-is map (what exists today)

| Concern | Where | Agent-specific? |
|---|---|---|
| Spawn ACP server, JSON-RPC correlation, JSONL wire log, process-group kill | `extensions/lib/acp-client.ts` | **Yes, in 4 places**: `spawn("devin", args)` (`:67`) with `args = ["acp", "--model", model]` (`:61-63`), `DEVIN_MODEL` env (`:73`), error text `"devin acp …"` (`:124`, `:171`, `:184`), `initialize.clientInfo.name = "pi-devin-delegate"` (`:131`) |
| Inbound-request contract (must answer or method-not-found) | `acp-client.ts:200-215` | No — generic, and load-bearing (an unanswered request froze every session, see file header) |
| Update vocabulary handling | `devin-delegate.ts:1136-1181` (`wireClientEvents`) | Partly: `agent_message_chunk`, `tool_call(_update)`, `usage_update`, `config_option_update` are ACP-standard; the *set* handled is Devin's |
| Permission round-trip (modes, aliases, option picking, 5-min timeout) | `extensions/lib/devin-permissions.ts` | Vocabulary yes (`bypass, smart, accept-edits, plan, ask`), mechanism no |
| Concurrency slots / FIFO queue | `devin-delegate.ts` + `lib/devin-slots.ts` | No |
| Worktree provisioning (Orca → `git worktree` fallback), `-dt<N>` naming | `devin-delegate.ts:979-1090` | No — host-side, agent-agnostic |
| PR detection on branch (`gh`) | `devin-delegate.ts:1092-1122` | No |
| Session meta + persistence + recovery, `~/.pi/agent/devin_delegate/<piSession>/` | `devin-delegate.ts:778-978`, `:1412-1628` | No (path name yes) |
| Stall watchdog, permission timeout, agent-facing follow-up messages | `devin-delegate.ts:545-640`, `:1278-1400` | No |
| TUI dashboard + status bar | `devin-delegate.ts:131-289`, `:860-900` | No (labels/wording yes) |
| 7 tools + `/devin` slash command | `devin-delegate.ts:1632-2580`, `:2584` | Wording yes, mechanism no |
| Block `devin` CLI from bash so all delegation is tracked | `lib/devin-bash-guard.ts` | **Yes** |
| `globalThis` handoffs (`__PI_ON_PR_CLOSED_DEVIN__`, `__PI_DEVIN_FLUSH__`) | `devin-delegate.ts:1558`, `:2540` | No (key names yes) |
| CLI flags `--devin-max-runs`, `--devin-turn-stall`, `--devin-permission-timeout` | `devin-delegate.ts:390-405` | No |

**Key structural fact:** `extensions/devin-delegate.ts` is 2 677 lines in one closure that owns the
transport *and* the queue *and* the wire vocabulary *and* the tools. The refactor's real work is
extracting layers, not inventing them. The wire vocabulary is handled *inside* the update callback
(`wireClientEvents`), which is where the Devin coupling leaks into otherwise-generic code.

**Second key fact:** this repo already contains an ACP **server** (`agy-acp/`) that implements the
same selection surface a driver must consume — first-class `modes` + `session/set_mode`, and
`configOptions` selectors (`model`, `thought_level`) set via `session/set_config_option` and echoed
as `config_option_update` (`agy-acp/src/config-options.ts:1-45`). It is the reference for what a
non-Devin agent looks like, and it is the third conformance target.

---

## 3. Where agents differ (the actual seam)

Measured against the three servers in scope, everything that varies falls in five buckets:

| # | Variation point | Devin | agy-acp (repo) | Claude ACP |
|---|---|---|---|---|
| V1 | **Launch** | `devin acp --model X` + `DEVIN_MODEL` | `agy-acp` (node bin) | *see §10* |
| V2 | **Model selection** | spawn flag only — `session/set_config_option(model)` **fails `-32602`** for ids outside its vocabulary (`swe-2-max`), see `devin-delegate.ts:1255-1260` | `configOptions.model` selector + `models` block; a change relaunches the child (`launchKey()`) | *see §10* |
| V3 | **Thinking / reasoning effort** | **baked into the model id** (`swe-2-high`, `swe-2-max`, `glm-5-3-flash-max`); no in-band effort knob found — see the correction in §16.2 | `configOptions` selector, `category: "thought_level"`, values `low｜medium｜high｜xhigh｜max` + `default` (`agy-acp/src/config-options.ts:268`, `agy/models.ts:21-24`) | config option `effort`, per-model (§10) |
| V4 | **Permission mode** | `session/set_mode`, ids `bypass, smart, accept-edits, plan, ask`; aliases `dangerous→bypass`, `auto→smart` | `modes` + `session/set_mode`; `bypass` withheld unless `AGY_ACP_ALLOW_BYPASS=1` | *see §10* |
| V5 | **Update vocabulary & permission options** | `agent_message_chunk`, `tool_call(_update)`, `usage_update`, `config_option_update`; option ids include project-wide/global/"switch to bypass" (deliberately never chosen, `lib/devin-permissions.ts:115-135`) | same ACP update kinds mapped from agy steps; `session/request_permission` only when the gate is armed | *see §10* |

Everything else — process lifecycle, queue, slots, watchdog, persistence, recovery, worktrees, PR
detection, dashboard, notifications — is agent-independent and must not learn about any agent.

Three consequences for the design:

1. **Selection is not one ACP call.** "Set the model" is a spawn flag on Devin and a config-option on
   agy. So the driver owns *how* a selection is applied, including "before the process starts".
2. **`thinking` has no common wire representation.** On Devin it is part of the model id; on agy it is
   a `thought_level` selector (`low｜medium｜high｜xhigh｜max`); on Claude it is an `effort` config option
   whose legal values depend on the model. The tool exposes a **canonical vocabulary**
   (`off | minimal | low | medium | high | xhigh | max`) — the union, so `xhigh` exists for agy and
   Claude but must be refused for Devin — and the driver maps, rewrites the model, or refuses.
3. **Capabilities must be advertised, not guessed.** The generic layer needs to know *before* the
   session starts whether the agent supports thinking, resume, cancel, permissions — so the tool can
   validate params and error messages can name the agent's real vocabulary.

---

## 4. Target architecture

Four layers; each may depend only on the one below it.

```
extensions/delegate-task.ts          tools + slash command + TUI  (thin: params → engine → text)
        │
        ▼
extensions/lib/delegate/engine.*     queue, slots, meta, persistence, recovery, watchdog,
                                     permission round-trip, notifications, dashboard model
        │  consumes canonical events (§6), calls driver methods (§5)
        ▼
extensions/lib/delegate/drivers/     one module per agent: devin.ts, claude.ts, agy.ts, generic.ts
        │  declares capabilities + launch plan + selection + mapping
        ▼
extensions/lib/delegate/transport.ts JSON-RPC over a spawned child (today's AcpClient, de-Devin'd)
```

### 4.1 `transport.ts` — the ACP child, with no opinion about who it is

`AcpClient` minus the Devin constants: constructor takes a **`LaunchPlan`** instead of `(cwd, model)`.

```ts
export interface LaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;   // merged over process.env by the transport, never replacing it
  /** Names the agent in errors and the wire log ("devin acp exited with code 42"). */
  label: string;
  /** Sent as initialize.clientInfo; drivers may brand it. */
  clientInfo: { name: string; version: string };
  /** Extra initialize capabilities the agent needs (e.g. fs read/write, terminal). */
  clientCapabilities?: unknown;
}
```

Everything else stays byte-for-byte: the `pendingRequests` correlation, `timeoutMs <= 0` for
`session/prompt`, the "never leave a request unanswered" contract, process-group `SIGTERM`→`SIGKILL`,
the reference-breaking in `dispose()` (memory-leak review, `docs/memory-leak-review.md`), stdin error
swallowing. **These are tested invariants; the refactor must not "improve" them.**

### 4.2 `drivers/` — declarative descriptor + a few pure functions

A driver is **data plus pure-ish functions**, never a control-flow owner. The engine keeps owning
process lifecycle, slots, timers and persistence, because those are exactly where the repo's
invariants live (`settleOwnership`, `inboundBufferCap`, `stdoutExitDrain`, the leak review). A driver
that owns its own loop would make each of those re-auditable per agent.

```ts
// extensions/lib/delegate/drivers/types.ts

/** Canonical thinking vocabulary the tool accepts; drivers map it to whatever their agent has. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "max";

export interface DriverCapabilities {
  thinking: boolean;          // false ⇒ delegate_task refuses `thinking` for this agent
  resume: boolean;            // session/load or equivalent (drives delegate_restart)
  cancel: boolean;            // session/cancel
  permissions: boolean;       // asks session/request_permission
  plans: boolean;             // `plan` / `plan_update` updates
  worktree: "host" | "agent" | "none";   // who isolates; today everything is "host"
  blocksOwnCli: boolean;      // §12: block the agent's CLI through bash
}

/** A value the agent will actually accept, plus how to show it. Catalogues drive validation
 *  AND the tool description, so the description can never drift from the agent. */
export interface Catalogue<T extends string = string> {
  default: T;
  values: readonly { id: T; label?: string; note?: string }[];
  /** Unknown values: "reject" hard-fails, "warn" accepts with a line in the result. Modes are
   *  reject (Devin silently ignores an unknown mode); models are warn (its advertised vocabulary
   *  omits swe-2-max, see devin-delegate.ts:1255). */
  onUnknown: "reject" | "warn";
}

export interface Selection {
  model?: string;
  thinking?: ThinkingLevel;
  /** Canonical permission intent, tool-facing: dangerous | smart | accept-edits | plan | ask. */
  mode: string;
}

export interface AgentDriver {
  readonly id: string;                       // "devin" | "claude" | "agy"
  readonly title: string;                    // "Devin" — for UI/notifications
  capabilities(ctx): Promise<DriverCapabilities> | DriverCapabilities;
  /** Preflight before a slot is spent: binary present, logged in, version acceptable. */
  preflight(): Promise<{ ok: true } | { ok: false; error: string; hint?: string }>;
  /** How to spawn the ACP server. Called before selection is applied. */
  launchPlan(sel: Selection, cwd: string): LaunchPlan;
  /** Mode/model/thinking after session/new, for agents that set them in-band (config options,
   *  set_mode). Returns warnings the tool surfaces. Devin: set_mode only. */
  applySelection?(client, sessionId, sel): Promise<string[]>;
  /** Wire mode id for session/set_mode; driver owns aliases (dangerous→bypass). */
  resolveMode(mode: string): { ok: true; modeId: string } | { ok: false; error: string };
  /** One ACP session/update → zero or more canonical events (§6). */
  mapUpdate(u: AcpUpdate): DelegateEvent[];
  /** session/request_permission payload → what to show the agent + which option answers a decision. */
  permission?: {
    parse(reqId, params): PermissionRequest;
    pickOption(options, decision: PermissionDecision): string | undefined;
  };
  /** Reuse of an existing session id on restart/message (agy: --conversation; devin: re-attach). */
  reattach?(sessionId, sel, cwd): LaunchPlan | undefined;
}
```

`permission.parse` defaults to today's `lib/devin-permissions.ts:parsePermissionRequest` (it already
tolerates bare-string vs `{value,name}` options), so most drivers only override `pickOption`.

### 4.3 `engine.ts` — everything that is not the wire

Mechanical extraction from `devin-delegate.ts`, keeping the section boundaries the file already
documents (`:545` permissions, `:979` worktree, `:1092` PR detection, `:1209` execution, `:1412`
recovery). The engine consumes canonical events and never sees an ACP payload:

```ts
engine.onEvent((e: DelegateEvent) => { /* JSONL append, dashboard counters, stall watchdog ping */ });
engine.delegate({ agent, selection, prompt, createWorktree }): Promise<{ sessionId } | { queued }>;
```

Slots become **per-agent** with a global ceiling (two `swe-2-high` Devin runs and one Claude run must
not be counted as three of the same limit, and one chatty agent must not starve the other):
`maxRunsPerAgent = 2`, `maxRunsTotal = 3`, both flag-tunable. Persisted `state.json` keeps its shape
plus `agent` per session.

### 4.4 `delegate-task.ts` — tools

Thin. Today's tool bodies are already mostly validation + engine calls; the change is that validation
is asked of the driver registry instead of hardcoded constants.

---

## 5. Renames and the new tool surface

### 5.1 Family rename

| Today | New | Notes |
|---|---|---|
| `devin_delegate` | **`delegate_task`** | adds `agent`, `thinking` |
| `devin_status` | `delegate_status` | gains `agent` column; `session_id` unchanged |
| `devin_message` | `delegate_message` | |
| `devin_permission` | `delegate_permission` | |
| `devin_cancel` | `delegate_cancel` | |
| `devin_restart` | `delegate_restart` | |
| `devin_clean_worktree` | `delegate_clean_worktree` | worktrees are host-side, already agent-neutral |
| `/devin` | `/delegate` | `/devin` stays as an alias |

**Compatibility policy (decided):** the old tool names register as **deprecated aliases for one minor
version**. An alias call runs the new path and prepends
`Note: devin_status is renamed delegate_status.` to its output. Rationale: `prompts/task-with-devin-reviewer.md`,
`skills/delegate-to-devin/SKILL.md` and any user-level skill/agent copy in `~/.pi/` all name the old
tools, and a rename that silently breaks them fails at the worst moment (mid-PR-loop). Removal is a
separate PR after one release; the aliases are a list in one file so removal is one commit.

Storage: new writes go to `~/.pi/agent/delegate_task/<piSession>/<sessionId>/`; recovery *also* reads
`~/.pi/agent/devin_delegate/` read-only for sessions that were live across the upgrade
(`devin acp` sessions outlive a pi restart), and reports in the recovered line which root it came
from. No destructive migration.

### 5.2 `delegate_task` parameters

```ts
Type.Object({
  agent:    Type.Optional(Type.String({ description: <from registry: "devin (default) | claude | agy"> })),
  model:    Type.Optional(Type.String({ description: <per-agent catalogue, default per agent> })),
  thinking: Type.Optional(Type.String({ enum: ["off","minimal","low","medium","high","xhigh","max"],
              description: "Reasoning effort. Supported by: <agents advertising it>. For Devin this "
                         + "rewrites the model (swe-2-high/swe-2-max encode effort); refused for "
                         + "agents with no effort knob." })),
  mode:     Type.Optional(Type.String({ description: <union of driver mode catalogues, default dangerous> })),
  prompt:   Type.String({ description: "Self-contained instructions: the agent sees no part of this conversation" }),
  create_worktree: Type.Optional(Type.Boolean({ description: "New worktree on <branch>-dt<N> (default false)" })),
})
```

Validation order, all before a slot is reserved (so a bad call never occupies one of the two slots):

1. `agent` → registry lookup. Unknown ⇒ error listing every registered id and its health.
2. `driver.preflight()` ⇒ fail fast with the hint ("claude: not logged in — run `claude /login`").
3. `mode` → `driver.resolveMode()`; **reject** (unchanged behaviour: Devin silently ignores unknown modes).
4. `thinking` → `capabilities.thinking` false ⇒ reject naming the agent; true ⇒ driver maps.
5. `model` → catalogue; **warn, don't reject** (Devin's advertised vocabulary omits `swe-2-max`).
6. capability intersection: `mode: dangerous` on an agent that withholds bypass (agy) ⇒ reject with
   the agent's own reason rather than silently degrading.

> **Naming collision to decide before P4, found during research.** All three servers have a *second*
> "agent" concept: `devin acp --agent-type review｜summarizer` (a read-only code-review agent, and a
> no-tools summarizer), Claude's `agent` config option (`AGENT_CONFIG_ID`, custom subagents), agy's
> `agent` selector (`agy-acp/src/acp.ts` / `BUILTIN_AGENT_NAMES`). The requested `agent` parameter means
> *which driver*, and that is the right meaning for the tool — but it must not later be reused for the
> role. If the role is ever exposed, name it `agent_role` (or `subagent`) and document the distinction
> in the tool description. Deferred out of v1 scope (§15), recorded here so it is not "discovered" by
> whoever adds it and reaches for `agent`.

`description` strings are **generated from the registry at activate() time**. That is the mechanism
that keeps the tool description honest when a driver is added — the alternative (hand-written prose)
drifted once already: the current `MODE_DESCRIPTION` (`devin-delegate.ts:57`) hardcodes Devin's mode
vocabulary in a sentence.

---

## 6. The main events, and the canonical taxonomy

This is the abstraction the plug-and-play claim rests on: the driver's `mapUpdate` is the *only*
place that knows a wire format, and everything downstream consumes this closed set.

| Canonical event | ACP source (client→server / server→client) | Consumed by | Today |
|---|---|---|---|
| `driver.ready` | `initialize` result (capabilities, auth methods) | preflight cache, capability negotiation | discarded |
| `session.started` | `session/new` result: `sessionId`, `modes`, `models`, `configOptions` | meta, JSONL, capability re-read | only `sessionId` used (`:1218-1222`) |
| `turn.started` | engine, on `session/prompt` dispatch | watchdog start, status bar | implicit |
| `assistant.delta` | `session/update: agent_message_chunk` (+ `agent_message`) | 2 KB-buffered transcript append | handled (`:1148-1160`) |
| `assistant.completed` | `agent_message` / turn end | flush | handled |
| `thought.delta` | `session/update: agent_thought_chunk` | transcript, dashboard "thinking" | **not handled — dropped today** |
| `tool.started` / `tool.updated` | `tool_call`, `tool_call_update` (`status: pending｜in_progress｜completed｜failed`) | JSONL, dashboard progress, stall watchdog | handled (title only) |
| `plan.updated` | `plan`, `plan_update` | status ("N/M steps"), `delegate_status` | **not handled** |
| `usage.updated` | `usage_update` (`used`/`size`/token counts) — **an agent extension, not core ACP**: Devin and this repo's `agy-acp` both send it, Claude's presence is UNVERIFIED | context-pressure warnings | handled (`:1165-1172`) |
| `selection.updated` | `config_option_update` | catalogues refresh (validates mode/thinking vocab) | partial: only `mode` values cached |
| `mode.changed` | `current_mode_update` | status line, permission behaviour | **not handled** |
| `commands.updated` | `available_commands_update` | ignored (no slash-command surface) | ignored |
| `permission.requested` | **request** `session/request_permission` (turn blocks) | agent-facing message + 5-min timer → `delegate_permission` answer | handled (`:1131-1134`) |
| `permission.timeout` | engine timer (default 5 min, `--delegate-permission-timeout`) | auto-reject + notice | handled |
| `request.unhandled` | any other inbound **request** | answer `-32601` — never leave unanswered | handled (`acp-client.ts:206-212`) |
| `turn.completed` | `session/prompt` response — **`stopReason`: `end_turn｜max_tokens｜max_turn_requests｜refusal｜cancelled`** | completion notice, PR detection, slot release, `drainQueue` | handled, **`stopReason` ignored** |
| `turn.failed` | `session/prompt` rejection / JSON-RPC error | failure notice | handled |
| `turn.stalled` | watchdog (`--delegate-turn-stall`) | status bar, notice | handled |
| `process.exited` | child exit (`code`, `signal`) | interrupted vs idle (`:1184-1207`) | handled |
| `queue.promoted` | `drainQueue()` | "your session started" message | handled |
| `pr.detected` | `gh pr list` for the branch | notification, observe-pr handoff | handled (`:1092-1122`) |
| `pr.closed` | `globalThis.__PI_ON_PR_CLOSED_*__` from observe-pr | worktree release | handled (`:2540`) |

Two gaps worth fixing while the taxonomy is being written down, because they are cheap and they are
exactly the places where a second agent will differ:

- **`stopReason` is discarded.** A Devin turn that ended in `max_tokens` currently reports the same
  "session is done" line as `end_turn`. On Claude, `max_tokens` and `refusal` are ordinary outcomes.
  Canonical `turn.completed` carries `stopReason`; the notice text branches on it.
- **`agent_thought_chunk` is dropped.** Once `thinking` is a first-class tool parameter, the caller
  needs evidence it had an effect — thoughts get their own (bounded, off-by-default in the log) stream.

Engine rules that must stay where they are, independent of driver: the stall watchdog restarts on any
event (`:1139-1144`); the assistant buffer flushes before every append of a non-chunk event; the
client is dropped from `activeClients` on exit even between turns; the slot is released in a
`finally`, before `drainQueue()`.

---

## 7. Per-driver mapping table (the abstraction's test cases)

| Canonical call | devin driver | agy driver | claude driver |
|---|---|---|---|
| `launchPlan` | `devin acp --model <model>` + `DEVIN_MODEL` | `agy-acp` + `AGY_ACP_*` env | `claude-agent-acp`, **no flags**, `CLAUDE_AGENT_ACP_PROTOCOL=v1` |
| apply model | spawn flag **only** (never `set_config_option` — `-32602`) | `session/set_config_option(model)` → relaunch on change | `session/set_config_option("model")` after `session/new` |
| apply thinking | rewrite model id (`swe-2-high`/`swe-2-max`) — no in-band knob verified | `session/set_config_option` on the `thought_level` selector (+ `session/set_model`) | `session/set_config_option("effort")`, **after** the model, absent for effort-less models |
| apply mode | `session/set_mode`, `dangerous→bypass`, `auto→smart` | `session/set_mode`, bypass withheld unless `AGY_ACP_ALLOW_BYPASS=1` | `session/set_mode` with camelCase ids, `dangerous→bypassPermissions`, withheld under root (`permissions/modes.js:3`) |
| `mapUpdate` | default table (§6) | default + agy step shapes (`agy-acp/src/update-map.ts`) | default + `_auth/status_update`/`subagent_update` ignored by design |
| `permission.pickOption` | never `allow_always` / global / switch-to-bypass (`lib/devin-permissions.ts:115-135`) | gate options | `allow_once`/`reject_once`; `allow_session` degrades to `allow_once` **with a notice** (§10.3) |
| `reattach` | re-spawn `devin acp` + `session/prompt` on the old id (`:1982-2015`) | `--conversation <id>` | `session/load` / `session/resume` (capability-gated) |
| `blocksOwnCli` | true (`devin` blocked in bash) | false today | **false** — see §12 |
| `preflight` | `devin --version` + auth check | `agy --version` + `checkAgyVersion` (`agy-acp/src/agy/version.ts`) | `claude auth status --json` — **exit 1 while logged out still prints valid JSON** (§10.4) |

`agy` is deliberately in the table even if we ship only two drivers: it is the only agent whose server
we own, so it is the conformance test that proves the interface is not secretly Devin-shaped.

---

## 8. Registry, and what "plug and play" actually means

```ts
// extensions/lib/delegate/drivers/index.ts
export const DRIVERS: Record<string, AgentDriver> = { devin, agy, claude };
```

Plus one **descriptor-driven** driver so a new ACP agent needs no code, only data:

```jsonc
// ~/.pi/agent/delegate/agents.json  (read through one "door" file, see §12)
{
  "my-agent": {
    "title": "My Agent",
    "launch": { "command": "my-agent", "args": ["acp"], "env": {} },
    "capabilities": { "thinking": false, "resume": false, "cancel": true, "permissions": true },
    "modeArgs": { "dangerous": "--yolo" },
    "models": { "default": "fast", "values": ["fast", "smart"], "onUnknown": "warn" },
    "health": { "command": "my-agent", "args": ["--version"] }
  }
}
```

`genericDriver(descriptor)` implements the §6 default mapping (which is plain ACP) and applies mode
and model as `session/set_mode` + `session/set_config_option` when advertised. That covers "any
spec-compliant ACP server" honestly; it does **not** claim to cover servers with bespoke launch
handshakes or non-standard update vocabularies — those get a real driver module. Saying which is
which is the difference between an abstraction and a fiction, so `delegate_status --agents` output
marks each agent `built-in` or `descriptor` and lists the capabilities it declared.

---

## 9. What is *not* abstracted (and why)

- **Worktrees.** Provisioned by the host (Orca, `git worktree` fallback) before the session starts,
  because the isolation must exist regardless of whether the agent can branch. `capabilities.worktree`
  records who owns it; today every driver returns `"host"`.
- **PR detection, `gh`, review-thread tracking.** Owned by `observe-pr`/`pr-tasks`; the engine only
  emits `pr.detected`.
- **Notifications into the parent pi session** (`sendAgentMessage`). One implementation; the *text* is
  parameterized by `driver.title` and the new tool names. Today ~9 user-visible strings
  (`:1196, :1313, :1332, :1394, :2039, …`) name `devin_status`/`devin_delegate` inline — those become
  templates over `TOOL_NAMES`, or the aliases in §5.1 will be load-bearing forever.
- **The TUI dashboard.** Same component, gains an agent column and per-agent slot lines.

---

## 10. Claude ACP driver

_Evidence: the adapter installed on this machine, read directly at
`/usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist` (v`0.100.0`), reconciled with the
`aquamarine-thunbergia` research run. Anything not read from a file is marked UNVERIFIED._

### 10.1 What is installed, and how it was installed

| Fact | Evidence |
|---|---|
| The adapter is **`@agentclientprotocol/claude-agent-acp` v0.100.0**, "An ACP-compatible coding agent powered by the Claude Agent SDK (TypeScript)" | `package.json` of that tree |
| Installed **system-wide into `/usr/lib/node_modules`**, not via the active nvm prefix — `npm ls -g --depth=0` (nvm node v24.22.2) does **not** list it | `readlink -f $(which claude-agent-acp)` → `/usr/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js`; `npm ls -g` output |
| On `PATH` as `claude-agent-acp` (`/usr/bin` and `/bin` — the same file) | `which -a` |
| It is a **thin adapter over the Claude Agent SDK**, which drives the `claude` CLI (`/usr/bin/claude`) | `README.md`; `claudeCliPath()` (`acp-agent.d.ts:1037`); `CLAUDE_CODE_EXECUTABLE` env override |
| Serves **ACP v1 and a draft v2**, chosen by the client's `initialize` | `serve.d.ts` (`AcpProtocols = "auto"｜"v1"｜"v2"`, env `CLAUDE_AGENT_ACP_PROTOCOL`) |
| `agy` (`/usr/local/bin/agy`) and `devin` (`/home/lucas/.local/bin/devin`) are also present; `agy-acp` in this repo is **not registered anywhere on this machine** — nothing in `~/.config/orca` or `~/.pi` references it | `which -a`; grep of those trees (only shell-wrapper/binary-cache noise matched) |

So the answer to "how was claude acp installed" is: **as a system npm package providing one stdio
binary**, exactly parallel to how `devin acp` is a subcommand of the `devin` binary. Nothing registers
ACP servers on this machine; each client spawns them. That means the Pi driver's job is only
"spawn this command" — there is no registry to integrate with.

### 10.2 Why this driver justifies the whole abstraction

Claude's selection channels are the **inverse of Devin's**, and this is the strongest argument that a
driver seam is real rather than cosmetic:

| | Devin | Claude ACP |
|---|---|---|
| Model | **spawn flag only** (`devin acp --model X`); `session/set_config_option(model)` answers `-32602` for ids outside its vocabulary (`swe-2-max`) | **no model flag at all**; `session/set_config_option` on config id `model` (`session-model.d.ts:3` `MODEL_CONFIG_ID = "model"`) |
| Thinking | inside the model id (`swe-2-high`/`swe-2-max`) | config id `effort` (`session-config-ids.d.ts:5`), built **per model** by `buildEffortConfigOption(modelInfos, currentModelId, currentEffortLevel, …)`; a model switch recomputes it (`SessionModeManager.reconcileForModel`) |
| Mode ids | kebab-case: `bypass`, `smart`, `accept-edits`, `plan`, `ask` | camelCase, **case-sensitive on the wire**: `default`(="Manual"), `acceptEdits`, `plan`, `auto`, `bypassPermissions` (`session-mode.js:229-266`) |
| Bypass availability | always | `bypassPermissions` only when `ALLOW_BYPASS = !IS_ROOT || IS_SANDBOX` (`permissions/modes.js:3`); when false it **clamps to `default` and logs** — the silent-degradation bug class again |
| Resume | re-attach = fresh spawn + `session/prompt` on the old id | first-class `session/load`, `session/resume`, `session/fork`, `session/list`, `loadSession: true` |
| Stop reasons | `end_turn`, … | `end_turn`, `cancelled`, **`error`** (present in `dist/*.js`; full SDK set UNVERIFIED) |
| Permission options | `allow_once`, `allow_session`, `allow_always`, switch-to-bypass, `reject_once` | `allow_once`, `allow_always`, `reject_once`, `reject_always`; the set is **built per tool** (Bash/Edit/Read/Grep/WebFetch/…) and **order is load-bearing** — with `defaultToNo` the decline option is led with, because ACP has no "pre-selected option" field (`permissions/options.js:8-15`) |

A single hardcoded `session/set_mode(modeId)` + spawn-flag-model implementation cannot serve both.
With the §4.2 interface it is two catalogues and two `applySelection`s.

### 10.3 The claude driver, concretely

```ts
// extensions/lib/delegate/drivers/claude.ts
const CONFIG_IDS = { model: "model", effort: "effort", mode: "mode", agent: "agent", fast: "fast", ultracode: "ultracode" };

launchPlan(sel) => ({
  command: "claude-agent-acp",            // no model/mode flags exist
  args: [],
  env: { CLAUDE_AGENT_ACP_PROTOCOL: "v1", ...(sel.thinking ? {} : {}) },
  label: "claude-agent-acp",
  clientInfo: { name: "pi-delegate-task", version: "1.0" },
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});

resolveMode(m) // dangerous→bypassPermissions, smart→auto, accept-edits→acceptEdits,
               // plan→plan, ask→default. Reject anything else: parseMode() throws
               // invalidParams on an unknown id, and `dontAsk` is accepted by parseMode
               // but never advertised — offering it would be a lie about the catalog.

async applySelection(client, sessionId, sel) {
  // ORDER MATTERS: effort is derived from the model, so model first, then effort.
  if (sel.model)    await setConfig("model", sel.model);
  if (sel.thinking) await setConfig(CONFIG_IDS.effort, claudeEffort(sel.thinking));
  // mode is applied by the engine via session/set_mode for every driver
}
```

Notes that the code above cannot express but the driver file must document:

- **`session/new` first, config options after.** The advertised `effort` option and its legal values
  exist only once a model is resolved, so a driver that sets `effort` before `model` is setting a
  value the next model change will overwrite.
- **The catalogue must be read from the wire, not hardcoded.** `session/new` returns `modes` +
  `models` + `configOptions`; the Claude driver's `selection.updated` handler should refresh the
  per-session catalogue, and `delegate_task` should validate `model`/`thinking` against the
  **agent-wide** catalogue at call time (from `preflight`/cache) since no session exists yet.
- **`effort` may be absent** for models with no effort levels (`buildEffortConfigOption` returns
  `undefined`). Then `thinking` must be refused per-call with "this model has no effort levels", not
  silently dropped.
- **Second thinking channel**: `MAX_THINKING_TOKENS` env (`dist` grep). Not used by P5 — the config
  option is the per-session, switchable one; the env is process-wide and would fight it.
- **`ultracode` / `fast` / `agent` config options exist and are deliberately out of scope** for
  `delegate_task` v1. They stay untouched (server defaults) and `delegate_status` can show them.
- **`allow_session` has no Claude equivalent.** `allow_always` is a *durable widening*, which the
  existing policy forbids for Devin (`lib/devin-permissions.ts:115-135`) and which must stay forbidden
  here. So for Claude: `allow`→`allow_once`, `reject`→`reject_once`, and `allow_session`→`allow_once`
  **with a visible line** ("claude has no session-scoped approval; approved once"). Choosing
  `allow_always` because it is convenient would silently change the safety posture of the tool family.

### 10.4 Auth, and whether it runs headless here

| Item | Finding |
|---|---|
| Identity source | The adapter probes `claude auth status --json` (5s cap, `AUTH_STATUS_PROBE_TIMEOUT_MS`) and pushes `_auth/status_update` (`auth-status.d.ts`). Kinds: `account｜api_key｜gateway｜external｜none`; "cannot determine" is silence, logged-out is `kind: "none"` |
| Logged-out signal | `isLoginRequiredText()` matches "Not logged in · Please run /login", "Login expired · Run /login…" (`acp-agent.d.ts:1048-1075`). **A logged-out `claude auth status --json` exits 1 and still prints valid JSON** — a `preflight` that trusts exit code alone reports "logged out" on every healthy machine |
| `preflight()` for this driver | `claude auth status --json` → `{loggedIn, authMethod, apiProvider, apiKeySource, subscriptionType}`; on `loggedIn !== true` fail with "run `claude /login` (or set `ANTHROPIC_API_KEY`)". Read through the env/exec doors, not ad-hoc |
| Alternative auth paths | `authenticate` with methods `gateway` / `gateway-bedrock`, offered only if the client advertises `clientCapabilities.auth._meta.gateway`; terminal auth behind `clientCapabilities.auth.terminal`. **P5 does not implement either** — it declares neither, so those methods are simply not offered |
| Env it reads (for the door list) | `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_API_KEY`*, `ANTHROPIC_CUSTOM_MODEL_OPTION`, `ANTHROPIC_USE_BEDROCK`/`_VERTEX` (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`), `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_EXECUTABLE`, `CLAUDE_MODEL_CONFIG`, `MAX_THINKING_TOKENS`, `CLAUDE_AGENT_ACP_PROTOCOL`, `CLAUDE_AGENT_LOGS` (*not grepped directly; passed through) |
| Auth on this machine | **Present**: `claude auth status` → `loggedIn: true`, claude.ai OAuth, subscription `max` (Claude Code 2.1.317). No API key needed for the first-party path (research probe; email/org not recorded) |
| Live handshake | **Verified**: a stdio `initialize` against `claude-agent-acp` answered `protocolVersion: 1` with `authMethods: []` (no auth gate at handshake) and advertised `loadSession: true`, session fork/resume/list/close/delete, image prompts, MCP http/sse, steering, subagents |
| Headless here | **Not proven.** A `session/new` + `session/prompt` round-trip was never executed (it would spend tokens and write session state). Auth prerequisites are satisfied, so the expectation is "it works", but P5 acceptance must gate on **a real Claude turn**, not on a conformance-suite run against a fake |
| Sandbox note | If the container runs as root, `bypassPermissions` is unavailable (`ALLOW_BYPASS`), so `mode: dangerous` would clamp to `default` and the session would block on every tool. `capabilities()` must therefore be **probed, not assumed** — this is exactly why `capabilities()` is a method in §4.2 |

### 10.5 What Claude adds that the taxonomy must absorb

- `current_mode_update`: **all three servers send it**; the extension ignores it today. Claude also
  sends it on its own initiative when it clamps a mode (plan-mode entry/exit, `exit-plan.js:144`,
  `session-mode.js:170`) — so ignoring it means the engine can believe a session is in
  `bypassPermissions` while the agent fell back to `default`. Wire it as `mode.changed` in P3.
- `subagent_update` + child sessions, offered only when the client declares
  `clientCapabilities.subagents`. The transport must **not** declare it in P5 (a child session is an
  unbounded fan-out the queue does not count). Recorded as a possible later feature.
- `_auth/status_update` is a connection-scoped notification with no session id — the transport
  currently forwards only `session/update` to the update callback, so this would be silently dropped.
  Acceptable: `preflight()` covers the need. Note it so it isn't mistaken for a leak later.
- `AskUserQuestion` is routed through **ACP elicitation**, explicitly not through permission options
  (`permissions/options.js:18-20`). The transport answers any unhandled inbound request with `-32601`,
  so an agent asking the user a question gets an error. That is the current, correct-for-now behaviour
  (an unattended delegate has no user), but it must be a **documented** decision in the driver notes,
  because the failure mode is "Claude tried to ask and was refused".
- Claude's own knobs beyond model/effort/mode — `session/steering` (mid-turn user input),
  `session/fork`, `session/list`, `session/rename`, `session/archive`, `session/goal`, `session/replay`
  — are all reachable on this adapter and none of them are in `delegate_task` v1. The driver interface
  needs no hook for them; if a later feature wants steering or fork, it is a new engine method plus a
  capability check, not a new seam.
- **Still UNVERIFIED about the Claude adapter** (P5 spike, in priority order): the exact `effort` value
  list and whether it accepts the canonical vocabulary (`session-effort.js` maps to the SDK's
  `EffortLevel`); whether a `session/prompt` actually completes headless on the existing OAuth login;
  `usage_update` emission; the `session/new` result shape for `configOptions` in v1 vs the
  `_meta.claudeCode.options.effort` path; error-code mapping.

### 10.6 An alternative worth pricing before P5: don't write a claude driver

`delegate_task` gains a Claude by *configuring* the descriptor driver of §8, because the Claude adapter
is spec-conformant on exactly the channels `genericDriver` implements — `session/set_config_option` with
`model` / `effort` config ids and `session/set_mode` with advertised mode ids. What a bespoke driver
would still be needed for is: canonical `thinking`→`effort` mapping, the mode-alias table
(`dangerous→bypassPermissions`), the `allow_session`→`allow_once` degradation, and `session/load`
resume — i.e. four behaviours of a dozen lines each.

So P5 has two acceptable shapes, and the spike should pick in this order:

1. **Descriptor + a small "selection profile"** (`thinkingConfigId: "effort"`,
   `modeAliases: {...}`, `permissionDegrade: {...}` in `agents.json`): Claude ships with no driver
   module, and the profile keys are the reusable part for the *next* agent too.
2. **A `claude.ts` driver module**, if the spike finds behaviour the descriptor cannot express (likely
   candidates: effort-vs-model ordering, the `ultracode`/`fast` options, `session/load` on restart).

Option 1 is the honest test of whether the abstraction is real. Option 2 is the fallback when it isn't.
Either way §14 stays: an `agy` driver is worth building regardless, because it is the agent whose server
this repo owns.

---

## 11. Tests, and the quality gate

### 11.1 Test seams to keep and extend

- `test/fake-acp-server.mjs` (233 lines) mimics `devin acp` and is env-driven (`FAKE_PERMISSION`,
  `FAKE_UNKNOWN_REQUEST`, `FAKE_NEW_FAIL_FILE`, `FAKE_DELAY_MS`…). It is injected by a shim named
  `devin` on `PATH` (`test/test-devin-delegate-queue.ts:54-70`).
  → parametrize with `FAKE_AGENT_KIND=devin|claude|agy` (different advertised modes/models, different
  permission option ids, `stopReason` variants) and rename the suite `devin-queue` → `delegate-queue`.
- **New: driver conformance suite** (`test/test-driver-conformance.ts`). One scenario matrix, run
  against every fake kind: happy turn, `stopReason: max_tokens`, permission round-trip, unknown
  inbound request, early exit, `session/new` failure, mode rejected by the agent. Every driver must
  pass the same matrix — this is what makes "plug and play" verifiable instead of aspirational.
  Add it in the same commit as the driver that needs it (repo rule: an invariant with no failing
  fixture measures nothing).
- **Two assertions the fake must make, both from real failure modes found in research:**
  (a) the spawned child's env carries the *requested* model (`DEVIN_MODEL=glm-5-3-flash-max` is live in
  this shell today, and a merge-order bug in `LaunchPlan.env` would make every delegation silently run
  the parent's model — §16.4); (b) a mode the agent does not advertise is **refused, not accepted**, so
  the `auto`→silently-`accept-edits` class of bug cannot come back through a new driver (§14.2).
- Keep `test-devin-permissions.ts` (rename `test-delegate-permissions.ts`) as the pure-function tests,
  and add per-driver mode/thinking mapping tests.
- `test-devin-delegate.ts` / `-lifecycle.ts` stay real-Devin, out of CI; add a real-Claude equivalent
  only once §10 says it can run headless here.

### 11.2 Gate impact (plan for it, don't discover it)

| Gate | Effect of this refactor |
|---|---|
| `fileLineBudget` (`scripts/quality-baseline.json` pins `extensions/devin-delegate.ts` at 2677) | Splitting lowers counts. Ratchet only shrinks with `npm run qa:baseline` — which is the intended direction |
| `noUnusedLibs` | New `extensions/lib/delegate/*.ts` must be imported from a top-level entry (the gate only follows lib imports from entries — same reason `agy-acp/src/agy-driver.ts` exists) |
| `envAccessLocation` (baseline 2; "only the five files that are doors") | Drivers need env (`DEVIN_MODEL`, `AGY_*`, `ANTHROPIC_*`, descriptor path). Route all of it through the existing door files or run `npm run qa:baseline -- --write --reason "<sentence>"` — a config change to the gate is a decision, and it lands in the baseline's visible `notes` |
| `jsonParseLocation` (baseline 8) | Descriptor reading adds a `JSON.parse` site → same treatment |
| `piExtensionsMatchDisk` | If `devin-delegate.ts` is renamed to `delegate-task.ts`, update `package.json → pi.extensions` in the same commit |
| `wiredTests` | Renamed suites must stay listed in `test/run.sh ALL_SUITES`; new test files must be wired |
| `frontmatter` | `skills/*/SKILL.md` frontmatter (`name`, `description`) must match the rename |
| `quality-fixtures` (`bash test/run.sh quality-fixtures`) | Add fixtures for any new invariant (e.g. "no driver module may import another driver", "engine must not import ACP payload types") |
| `.githooks/*` | No change: `qa:static` on the staged tree is exactly the loop to run per phase |

**Definition of done per phase: `npm run qa` green.**

### 11.3 `biome.jsonc` is not part of this refactor

Changing it moves every debt figure the same way fixing a file does. If a rule needs an exemption for
a driver file, that is a separate commit with `--write --reason`.

---

## 12. Skill, prompt and doc surface to update

| File | What changes |
|---|---|
| `skills/delegate-to-devin/SKILL.md` (**31** `devin_*` occurrences — the whole page is written against the old names) | Becomes **`skills/delegate-task/SKILL.md`**: one page, agent-agnostic core + a per-agent section. Keep the routing table (it is Devin's, and it is the most valuable part) under "Devin". Add: how to pick an `agent`, what `thinking` does per agent (and that on Devin it rewrites the model), per-agent preflight/login notes. `name:`/`description:` frontmatter updated so the trigger still fires |
| `prompts/task-with-devin-reviewer.md` (**6** `devin_*` occurrences + the workflow text) | Update tool names and add the reviewer-agent choice. The exact review-task text block stays byte-identical (the prompt insists on it); only the tool names around it change. Rename file → `prompts/task-with-agent-reviewer.md`, keep the old name as a one-line alias prompt for one release |
| `README.md` (§"Devin Delegate (`devin_delegate`)", **13** `devin_*` occurrences plus the flag names `--devin-max-runs` / `--devin-permission-timeout`, the `~/.pi/agent/devin_delegate/` storage path, the `/devin` command, and the `devin-queue` suite name) | New section "Delegate tasks to ACP agents (`delegate_task`)" + a driver table; keep a short "renamed from `devin_delegate`" note with the alias window |
| `CLAUDE.md:31` | `e.g. devin_delegate` → `e.g. delegate_task` |
| `extensions/lib/devin-bash-guard.ts` + `test/test-devin-bash-guard.ts` | The guard becomes **per-driver data**, not a hardcoded CLI name. **Decision: `blocksOwnCli` stays true only for Devin.** Blocking `claude` in bash would break the host in exactly the setups where Claude Code is the operator, and pi's own tool surface is not the only legitimate user of that CLI. This is a deliberate asymmetry, and the driver comment must say so |
| `docs/*.md` (7 plans mention `devin_*`) | Add a one-line header "superseded naming: `devin_*` → `delegate_*`" instead of rewriting history |
| `plugins/*` | **No change — verified, not assumed**: `grep -o "devin_[a-z_]*"` over `plugins/multiagent-development/` (the `delegating-to-devin` skill and all three agents) returns **zero** hits. Those files address the Devin CLI's own Task/subagent surface, and the `.devin-plugin` manifests belong to the version-bump bot |
| user-level copies `~/.pi/agent/skills/`, `~/.pi/agent/git/…/skills/` | Installed package copies; picked up by `pi update` + `/reload`. Note it in the PR body so the operator isn't left with the old skill loaded |

---

## 13. Phasing

Each phase is a PR, each ends with `npm run qa` green, and no phase ships a broken delegation.

| Phase | Content | Acceptance |
|---|---|---|
| **P0 — characterization** | No behaviour change. Extend `test/fake-acp-server.mjs` markers, add `test/test-driver-conformance.ts` running the matrix against today's Devin path only | Conformance suite exists and passes; it is the safety net for P1-P4 |
| **P1 — transport** | `AcpClient` → `transport.ts` taking a `LaunchPlan`; `drivers/types.ts` + `drivers/devin.ts` holding the four Devin constants; error text comes from `plan.label` | P0 green, `pi.extensions` unchanged, wire log byte-identical on a real delegation |
| **P2 — engine extraction** | Pull queue/slots/meta/persistence/recovery/worktree/PR/watchdog/permission out of the 2 677-line closure into `lib/delegate/*`; extension entry keeps tools+TUI | Line budgets drop (record with `qa:baseline`), all suites green, real Devin smoke: delegate → status → message |
| **P3 — canonical events** | `mapUpdate` per driver; engine consumes `DelegateEvent` only; add `stopReason` handling and `thought.delta` | Conformance matrix green for Devin; `max_tokens` visibly differs from `end_turn` in `delegate_status` |
| **P4 — rename + `agent` param** | `delegate_*` tools + deprecated aliases, `/delegate`, `~/.pi/agent/delegate_task/` with read-old fallback, generated tool descriptions, per-agent slots | Old names still work and print the rename note; skills/prompt/README/CLAUDE.md updated in this same PR (§12) |
| **P5 — second driver** | Claude, via **§10.6 option 1 (descriptor + selection profile) unless the spike proves it cannot work**, plus its fake kind and conformance rows | Two agents delegating in parallel, each with its own catalogue and limit; no Devin-only string left in engine code; **one real Claude turn completed end to end** (§10.4) |
| **P6 — descriptor driver** | `agents.json` + `genericDriver` + `--agents` listing + fixtures for the new invariants | A descriptor-only agent passes the conformance matrix with no code change |

Suggested cut: **P0+P1+P2 as one PR** (pure extraction, zero user-visible change), **P3+P4 as the
behaviour/naming PR**, **P5+P6** as the feature PRs. That is three reviews instead of seven.

---

## 14. Risks and open questions

1. **Two agents, one slot model.** Per-agent limits need a global ceiling or 4 agents × 2 slots = a
   machine full of children. *(Decision: 2 per agent, 3 total.)*
2. **Silent mode degradation.** The class of bug already fixed once (`auto` → Devin stayed in
   `accept-edits`): a driver that accepts a mode it doesn't implement. Guardrail: `resolveMode` must
   reject, and the conformance suite asserts a marker for every accepted mode.
3. **Model catalogue churn.** Devin's advertised vocabulary already disagrees with its accepted
   `--model` values. Catalogues are warn-only, and the tool must never hard-fail on an unknown model
   or a new upstream model breaks delegation.
4. **`thinking` on Devin is a model rewrite**, which means the reported model in `delegate_status`
   must show both what was asked (`thinking: high`) and what ran (`model: swe-2-max`). Otherwise the
   tool lies about the run.
5. **Aliases are a foot-gun window.** If `devin_status` and `delegate_status` are both live, a model
   may mix them in one turn. Aliases return the rename note as the first line of output for exactly
   this reason.
6. **In-flight sessions across the upgrade.** Live `devin acp` sessions outlive pi; recovery must find
   the old storage root or they are reported lost. Read-only fallback (§5.1), not a migration.
7. **`memory-leak-review.md` constraints** — the `dispose()` reference-breaking and the delayed
   `SIGKILL` must survive P1 verbatim; a driver layer that keeps a reference to a client is a new
   leak path. Conformance suite should assert child-process count returns to baseline after N turns.
8. **`envAccessLocation` / `jsonParseLocation` ratchets** will fail on the new doors. Plan for a
   deliberate `--write --reason` commit rather than an ad-hoc one mid-refactor.
9. **Open question:** does `delegate_task` need an `async: false` mode (wait for the turn and return
   the result)? Today everything is fire-and-forget + follow-up message. Recommendation: **no** — the
   follow-up-message model is what makes the queue and the 2-slot limit work, and a blocking variant
   invites wall-clock timeouts. Revisit if §10 finds Claude turns are short enough to want it.
10. **Open question:** should `agent` default to `devin`? Yes for one release (every existing prompt
    relies on it), then consider making it required or config-driven once no caller depends on it.

---

## 15. Out of scope, recorded so it doesn't get re-litigated

- Making `orca_orchestration_dispatch` a driver (different mechanism: Orca terminals, not ACP).
- Serving ACP *out* of pi (`agy-acp` is the server-side project; this is the client side).
  Adjacent prior art: **`pi-acp`** (`https://github.com/svkozak/pi-acp`) is already installed as a Pi
  package on this machine and wraps `pi --mode rpc` as an ACP **server** — useful as a reading
  reference, and the reason a `pi` driver (delegate to *another pi session*, via its own ACP server)
  is a plausible later agent. Still out of scope for v1.
- Multi-agent graphs / chaining delegates inside the tool. Composition stays in the parent agent.
- The per-server "agent role" (`--agent-type`, `agent` config option) — see the naming note in §5.2.

---

## 16. Reconciliation of the research run (`aquamarine-thunbergia`)

Every claim below was re-checked against the tree/before acting on it, per the repo's rule that research
findings must be reconciled with the real tree.

### 16.1 Security incident — needs your action

The research session ran `cat ~/.pi/agent/models.json` and **printed the plaintext provider API keys
that file stores to its terminal transcript** (which leaves the machine, to Devin). The session
disclosed this itself and stopped reading secret-bearing files afterwards. Recommended: **rotate the
keys in `~/.pi/agent/models.json`**. Not a repo problem, and nothing in this plan changes because of
it — but it is the highest-value finding of the run, and it argues for keeping future read-only agents
off `$HOME` config paths unless they are specifically about them.

### 16.2 One research claim did not survive checking

> "Devin advertises a `thought_level` config option (`medium/high/max`) that the extension never uses"
> — attributed to `test/fake-acp-server.mjs:90`.

**False.** `test/fake-acp-server.mjs:84-85` advertises only two vocabularies, `MODEL_VOCAB` and
`MODE_VOCAB`; there is no `thought_level` in it, and `grep -rn thought_level extensions/` returns
nothing (`extensions/` was searched; the only matches in the repo are in `agy-acp/`). The research run
appears to have carried agy-acp's `category: "thought_level"` (`agy-acp/src/config-options.ts:268`) over
to Devin.

**Why it matters, and what it changes:** if it were true, `thinking` would be an in-band ACP selector on
Devin and the tool could set it directly. It is not, so §7's Devin row stands — **`thinking` on Devin is
a model-id rewrite** — which drags §14.4 with it (report both the requested thinking and the model that
actually ran). If someone later proves the real `devin acp` advertises an effort selector, that is a
change to the Devin driver only, and §14.4's reporting rule stays worth having anyway.

### 16.3 Confirmed, with corrected line numbers

| Claim | Status | Corrected citation |
|---|---|---|
| `spawn("devin", ["acp", "--model", model])`, `DEVIN_MODEL` env, `clientInfo: "pi-devin-delegate"`, `"devin acp …"` error strings | confirmed (line numbers were mine ±2–4) | `acp-client.ts:61-63`, `:67`, `:73`, `:131`, `:124/:171/:184` |
| `initialize` result discarded; `session/new` only `sessionId` read; `set_mode` best-effort; `session/prompt` timeout `0`; `stopReason` ignored; `session/cancel` as notification | confirmed | `acp-client.ts:129-133`; `devin-delegate.ts:1218-1222`, `:1262-1272`, `:1278-1288`, `:745` |
| Handled vs dropped updates (`agent_thought_chunk`, `plan`, `current_mode_update`, `available_commands_update` all dropped) | confirmed | `devin-delegate.ts:1136-1181` |
| Durable Devin session ids: re-attach is a fresh spawn + `session/prompt` on the old id, **no `session/new`** | confirmed — and it is the load-bearing difference vs Claude's `session/load` | `devin-delegate.ts:1977-2017` |
| Devin permission payload `_meta["cognition.ai/editableCommand"]`, option set `allow_once｜allow_session｜allow_always｜switch_bypass｜reject_once` | confirmed | `test/fake-acp-server.mjs:96-110`, `lib/devin-permissions.ts:79-135` |
| Nothing on this machine registers an ACP server; `agy-acp` is launched manually and referenced nowhere | confirmed (I re-checked `~/.config/orca`, `~/.pi`) | §10.1 |
| Slot limit 2, stall 30 min, permission timeout 5 min | confirmed | `devin-delegate.ts:390-418` |

### 16.4 New findings folded into the plan

- **Devin `--agent-type review｜summarizer`** (`devin acp --help`, verified on this machine): a read-only
  review agent and a no-tools summarizer. Folded into §5.2 as the naming warning, and it is a strong
  candidate for a later `agent_role` parameter — a "review" agent is exactly the
  `prompts/task-with-devin-reviewer.md` use case, done with a launch flag instead of prompt discipline.
- **`--model` accepts fuzzy names** ("family slug, alias, or partial name, e.g. `--model opus`",
  `devin acp --help`) — hard evidence for §5.2 step 5: model validation must stay **warn-only**.
- **`--refusal-fallback` / `DEVIN_REFUSAL_FALLBACK`** — a Devin-specific launch knob with no analogue.
  Not exposed by `delegate_task`; a driver's `launchPlan` is where it would go if it ever is.
- **`DEVIN_MODEL` is present in this shell's environment** (`glm-5-3-flash-max`). Harmless today —
  `acp-client.ts:71-74` merges `process.env` *then* sets `DEVIN_MODEL`, so the per-task model wins —
  but it is a trap for the transport refactor: a `LaunchPlan.env` implementation that merges in the
  other order, or that stops setting the key explicitly, would silently make **every** Devin
  delegation run whatever model the parent shell happens to export. Worth a comment at the seam and a
  conformance assertion ("spawn env `DEVIN_MODEL` equals the requested model").
- **`pi-acp` is installed as a Pi package** (`~/.pi/agent/settings.json → packages`) — recorded in §15.
- **Claude Code 2.1.317 / devin 3000.11.234 / agy 1.4.12** and the active claude.ai OAuth login —
  recorded at the top of the doc and in §10.4.
- **`claude-agent-acp` advertises `loadSession: true`, fork/resume/list, steering and subagents at
  handshake** — recorded in §10.4/§10.5, and the basis for the `resume` capability in §4.2 being real
  rather than speculative.
