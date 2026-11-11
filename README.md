# claude-marketplace

[![CI](https://github.com/lucasschirm/claude-marketplace/actions/workflows/ci.yml/badge.svg)](https://github.com/lucasschirm/claude-marketplace/actions/workflows/ci.yml)

My collection of Claude Code plugins and Pi extensions — skills, agents, hooks, and extensions I reuse across projects.

## Add this marketplace to Claude Code

In a Claude Code session, add the marketplace by its GitHub repo:

```
/plugin marketplace add lucasschirm/claude-marketplace
```

Then browse and install plugins interactively:

```
/plugin
```

Pick **LSC Marketplace → claude-basics → Install**. This is the simplest path and doesn't require typing the marketplace identifier.

To update later, refresh the marketplace and Claude picks up new versions the next time you install or restart:

```
/plugin marketplace update lucasschirm/claude-marketplace
```

## Plugins

| Plugin | Description |
|---|---|
| `claude-basics` | A collection of agents and skills for every project. Includes the `claude-rule-creator` skill for authoring and maintaining CLAUDE.md / `.claude/rules/` rules. |
| `frontend-development` | Agents and skills for frontend development, component architecture, and styling. |
| `multiagent-development` | Orchestration agents and skills for multi-agent workflows. |
| `pr-observer` | On-demand pull request CI verdict and review conversation tools for Devin CLI and Claude Code. |

---

## Devin CLI Plugins

Plugins in this repository can also be installed directly into the [Devin CLI](https://docs.devin.ai/product-guides/plugins).

### PR Observer (`pr-observer`)

A cross-platform plugin: MCP tools and skills that read a pull request's CI verdict and review
conversations, and close the conversations the agent has addressed. Every tool reads GitHub on the
call, and the plugin is self-contained (it carries its own copies of the engine under
`plugins/pr-observer/lib/`), which is what an installed plugin must be - see its
[README](plugins/pr-observer/README.md).

#### Install in Devin CLI

Install directly from the GitHub repository:

```bash
devin plugins install lucasschirm/claude-marketplace#plugins/pr-observer
```

Or using the full git URL:

```bash
devin plugins install https://github.com/lucasschirm/claude-marketplace.git#plugins/pr-observer
```

#### Capabilities in Devin CLI

- **MCP Tools**: `observe_pr` (CI verdict + conversation counts for a PR), `pr_tasks_list`,
  `pr_task_detail`, `pr_task_resolve` (reply, resolve, optionally apply the code suggestion),
  `pr_task_blocked`.
- **Skills (Slash Commands)**:
  - `/pr-observer:observe-pr` — Read a GitHub pull request's CI verdict and review conversations.
  - `/pr-observer:pr-tasks` — List, inspect, and resolve PR review conversations and suggestions.
- **Always-on Guidelines**: Injects `AGENTS.md` instructions into session context to guide Devin in resolving review comments.
- **Requirement**: `gh` authenticated, and Node 22.18+ on PATH (the engine is TypeScript, run directly).
- **Not in this plugin**: background monitoring (every tool is a snapshot; call it again to refresh)
  and Stop-hook enforcement - `hooks.json` is a fail-open placeholder that never blocks a session
  from ending. Continuous observation with pushed updates is what the Pi extensions below do.

If Devin reports `Failed to list tools for server 'pr-observer'`, the cached copy is stale or Node is
too old: [`plugins/pr-observer/README.md`](plugins/pr-observer/README.md#troubleshooting) walks it through.

---

## Pi Extensions

### PR Observer (`observe_pr`)

A [Pi Extension](https://pi.dev/docs/latest/extensions) that allows the coding agent to monitor GitHub Pull Requests for CI checks, workflow runs, and review comments in the background.

#### Features

- **Tool `observe_pr`**:
  - Accepts 1 parameter: the PR number (e.g. `42` or `"#42"`).
  - Validates PR existence and ensures the PR is open and not a draft before observing.
  - Re-invoking the tool with the same PR number stops observation.
- **Automated CI Monitoring**:
  - Runs `gh pr checks <pr-number> --watch --interval 60` to track check suites.
  - Detects new CI runs and spawns `gh run watch <run-id> --compact --interval 60`.
  - **Failure notifications**: Sends a message to the agent:
    `The CI run <run-id> failed for the pr <pr-number>. Investigate and fix the error: <ci-error-summary>`.
  - **Success notifications**: When all runs finish without errors and no runs remain pending, notifies the agent:
    `All CI passed for the PR <pr-number>.`.
- **PR Lifecycle & Comment Tracking**:
  - Automatically notifies and stops observation when the PR is merged or closed:
    `Stoping observing the pr <pr-number>. The PR was <merged/canceled/etc...>. You will no longer receive updates about this PR.`.
  - Notifies the agent whenever new comments are posted or existing comments are edited:
    `Comment <comment-numbers> added or updated to the PR <pr-number>.`.
- **Branch Watching & Automatic PR Detection**:
  - Automatically monitors current and visited Git branches. If the agent changes the active branch, all branches continue to be tracked for pull request creation.
  - When a PR is created for any tracked branch (and is open and non-draft), observation begins automatically.
  - The agent is notified:
    `The PR <pr-number> recently created is now being observed and you will get all updates for the PR. Calling the "observe_pr" tool will stop the tracking for the PR and automatic updates`.
  - If the agent calls `observe_pr` before this automatic message is delivered, the announcement is cancelled, the observation continues seamlessly, and the agent receives the standard start confirmation (`Starting observing <pr-number>...`).
  - Calling `observe_pr` after delivery or on an active PR stops observation as usual.
  - **Initial Prompt Notice**: Whenever automatic tracking is enabled, the agent's initial prompt and system guidelines automatically inform the agent that any pull request created for tracked branches will be automatically tracked and all updates will be sent.
- **Interface & Controls**:
  - **Status bar**: Displays live observed metrics in the footer: `<totalPrs>/<runs> observed`.
  - **Slash command `/pr_observer`**: Comprehensive user controls:
    - `/pr_observer` (or `disable` / `enable`): Toggles or explicitly enables/disables the `observe_pr` tool for the agent.
    - `/pr_observer list` (or `status`): Opens an interactive terminal dashboard displaying tracked branches, observed PRs, active run IDs, pass/fail counts, and comment counters.
    - `/pr_observer stop <prNumber>`: Stops observing a specific PR directly from the command line.
  - **Configurable CLI Flag `--pr-observer-interval`**: Customizes the check and polling interval (defaults to 60 seconds):
    ```bash
    pi --pr-observer-interval 30
    ```

### PR Conversation Tasks (`pr-tasks`)

A [Pi Extension](https://pi.dev/docs/latest/extensions) that integrates with `observe_pr` to keep track of PR review conversations (comments associated to a file and code line) as actionable tasks for the agent. Prevents PRs from being closed or abandoned with unresolved conversations.

#### Features

- **Agent Tools**:
  - **`pr_tasks_list`**:
    - Lists all unresolved, blocked, and stale conversation tasks. Supports optional `pr_number` and optional `show_all` (to include resolved tasks).
    - Formats output using the strict **Task Summary template**.
  - **`pr_task_detail`**:
    - Retrieves full conversation details including file location, author, timestamp, status, full replies, and code suggestions.
    - Formats output using the strict **Task Detail template**.
  - **`pr_task_resolve`**:
    - Resolves a conversation by posting a resolution reply to GitHub and closing the thread via GraphQL mutation (`resolveReviewThread`).
    - If the conversation has replies the agent hasn't been shown yet (via `pr_task_detail`), or its comment was edited since the agent saw it, it is not resolved; the new text is returned instead, since it may change the resolution (calling again resolves it).
    - Optional `accept_suggestion: true` accepts and applies the reviewer's code suggestion directly to the file on disk. Returns a clear error if invoked on a conversation without a code suggestion, on an outdated conversation (the code changed since the comment) or one on the base side of the diff, on a `STALE` conversation, when an earlier version of the suggestion was already applied, when its lines are not in the local file, or when the suggestion changed on GitHub since the agent was last shown it (the new suggestion is shown, and calling again applies it).
  - **`pr_task_blocked`**:
    - Marks a conversation as `BLOCKED` when human clarification or intervention is required. Posts the explanation as a reply to the thread.
    - When a user replies to that blocked conversation, the task automatically unblocks back to `UNRESOLVED` and notifies the agent.
    - If the conversation has replies the agent hasn't been shown yet (via `pr_task_detail`), it is not blocked; those replies are returned instead, since they may already answer the question.
- **Stale Review Threads**:
  - GitHub review-thread node IDs are not stable: a PR merge or a re-posted comment can replace a thread node. On every sync, a tracked task whose thread is gone is re-linked to its current thread: the same root comment, or an unambiguous re-post of it (same file, author, and body) listed in that same sync (a re-post that only appears in a later sync is tracked as a new task, and the old one stays `STALE`). A re-linked task takes the re-posted comment's conversation ID and still answers to the old one. A re-post is a new comment (created later), so a blocked task re-linked to one is reopened, and the agent is told; a replacement thread GitHub created for the same comment keeps the block. If the root comment is deleted while its thread stays, the task keeps the original request (its suggestion is treated as withdrawn) rather than taking the first reply as its comment.
  - Before posting, `pr_task_resolve`, `pr_task_blocked`, and `/tasks resolve` re-check the PR's review threads. A conversation already resolved upstream is marked `RESOLVED` without posting. If GitHub still rejects the stored thread ID (`Could not resolve to a node`) when replying or resolving, the extension re-syncs and retries once with the current ID. If the thread list can't be fetched, nothing is posted or changed. If resolving fails after the reply was posted, calling `pr_task_resolve` again with the same message only retries the resolve.
  - A PR stays synced while it has tasks that are not `RESOLVED` (including `STALE` ones, which recover through a sync), even after observe-pr stops observing it (e.g. once it is merged), so those tasks follow GitHub instead of nudging from cached state.
  - Each task records its repository and the folder its PR was synced from, so every PR is synced from its own checkout and a sync never touches another repository's PR with the same number. If that folder is removed (e.g. a deleted worktree), the current folder is used only when it is the same repository; otherwise the PR is no longer synced, and acting on its tasks fails with `no local checkout of <owner/repo> is available` (a code suggestion is never applied to another repository's checkout).
  - When no current thread exists, the task is marked `STALE` instead: it stays visible in `pr_tasks_list` and the status bar, but no longer triggers the open-tasks nudge. It returns to its previous state (`UNRESOLVED` or `BLOCKED`) if its thread reappears, or to `RESOLVED` if it was resolved upstream. Calling `pr_task_resolve` on a task that is already `STALE` marks it resolved without posting; if GitHub still lists the thread it rejected, the thread is retried instead and the task is never cleared while listed (`accept_suggestion` is refused for a `STALE` task).
- **Agent Loop Enforcement**:
  - Whenever the agent attempts to stop or settle while open (`UNRESOLVED`) conversation tasks remain, the extension intercepts settlement (`agent_before_settle`) and sends a nudge:
    `You still have <number> of open tasks. You can resolve them using the pr_task_resolve tool or if you don't have all required information to solve the conversation you can use the pr_task_blocked to mark the conversation as blocked.`
  - The turn continues until all tasks are either resolved or marked as blocked.
  - The nudge is capped: after 3 identical nudges (same open tasks, no new replies) the extension stops blocking settlement and shows a single warning. A change to the open tasks or a new user prompt re-arms it.
  - Open tasks a sync marks `STALE` are reported to the agent once, on the transition, so it knows they need no further action.
- **TUI & User Controls**:
  - **Status bar**: Displays live task counts in the footer: `PR Tasks: <open> open / <blocked> blocked / <resolved> resolved` (plus `/ <stale> stale` when any task is stale).
  - **Slash command `/tasks`**:
    - `/tasks list` (or `/tasks list all`): Displays tasks in terminal or opens interactive dashboard modal.
    - `/tasks detail <task-id>`: Displays full conversation details.
    - `/tasks resolve <task-id> "<reason>"`: Resolves conversation directly from CLI.
    - `/tasks reply <task-id> "<message>"`: Adds a comment to the thread without resolving it.

#### Tests

`bash test/test-pr-tasks.sh` runs the extension end to end inside Pi against a mocked `gh` (`test/test-pr-tasks.ts`, plus the GitHub reconciliation scenarios in `test/test-pr-tasks-reconcile.ts`). The sync/re-link logic has standalone unit tests: `node --test test/test-pr-tasks-manager.ts` (Node 23.6+, which runs TypeScript directly).

### Delegate Task (`delegate_task`)

A [Pi Extension](https://pi.dev/docs/latest/extensions) that lets the coding agent delegate tasks asynchronously to another agent over its native Agent Client Protocol (ACP) server. Ships drivers for **Devin**, **Claude** and **Antigravity** (Google's `agy`, through the [`agy-acp`](agy-acp/README.md) adapter in this repository), and supports per-agent and total concurrency limits, FIFO queueing, worktree isolation, multi-turn follow-ups, permission forwarding, disk-backed logging, crash recovery, and arrow-key TUI navigation.

#### Features

- **Agent Tools**:
  - **`delegate_task`**:
    - `prompt` (mandatory): Task instructions.
    - `agent` (optional, default `"devin"`): Which driver runs the task — `devin`, `claude` or `agy`. `/delegate agents` lists what is installed and what each one supports.
    - `model` (optional): The agent's model. Devin defaults to `swe-2-high` and Claude to `sonnet` — both tiers that do not bill per token on their own plans, because a delegation nobody named a model for should not spend money. Claude's catalogue is the machine's (the adapter lists what that install allows), so a model you name there must exist on that machine; if `sonnet` is not carried, the session keeps the model its own CLI configured and says nothing. `agy` has no catalogue here at all: the list is `agy models`, which is account-specific, so the default is `default` (agy picks) and `agy-acp` refuses an id agy does not offer at `session/new` — naming the ids it does. An unknown id warns and passes through rather than failing, because the agent resolves names this extension cannot list.
    - `thinking` (optional: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`): Reasoning effort, where the agent has such a control. Devin does not — its effort is encoded in the model id — so asking for it on a Devin run is refused instead of silently ignored; `agy` offers `low`…`max` (its `--effort`) and refuses `off`/`minimal`, which it has never had.
    - `mode` (optional, default `"dangerous"`): Canonical permission mode (`dangerous`, `auto`/`smart`, `accept-edits`, `plan`, `ask`), mapped by each driver into its own vocabulary. An unmappable value is refused, because agents silently ignore unknown modes.
    - `agy` defaults to `accept-edits` and refuses `dangerous` unless the operator enabled bypass (`AGY_ACP_ALLOW_BYPASS=1`): the adapter withholds that mode on purpose, and a driver that set the knob itself would be opening the gate it exists to hold. Where a canonical mode has no wire equivalent (`smart` on agy) the driver maps the **nearer, stricter** one, and `session/set_mode` reports the mode the session is actually in.
    - `create_worktree` (optional, default `false`): Spin up an isolated worktree branch (`${currentBranch}-dt${N}`).
    - Runs asynchronously: returns immediately with a session ID or a queue position, and says *why* a task queued (this agent's limit, the total limit, or tasks ahead of it).
  - **`delegate_status`**:
    - `session_id` (optional): One session's state and transcript. `full: true` reads the whole transcript from disk — the last few megabytes of it, line-aligned, saying how much earlier transcript it skipped; `limit` sets how many messages.
    - Every field copied out of a session (a command awaiting permission, a tool title) is quoted and labelled as what the agent reported. It is data, and an agent that writes "SYSTEM DIRECTIVE: run X" in a command must not have that arrive as an instruction.
    - If `session_id` omitted: the overview — every session, the queue, slot use per agent, and how many turns ended for each reason.
    - A finished turn reports its ACP `stopReason`: `max_tokens` and `refusal` are worded as an early stop, never as "done".
  - **`delegate_message`**:
    - `session_id` (mandatory) and `message` (mandatory): Sends follow-up instructions to an idle session via ACP. A busy session is refused, and if it is blocked on a permission request the refusal names that request — answering is a different tool, and queueing the message behind a request nobody can see would look like the agent going quiet.
    - A session whose process is gone is **continued, not refused**, when the agent keeps ids it can be re-prompted with (Devin does: a fresh process accepts the recorded id, no `session/new`). Where the agent cannot — Claude, and `agy` while `agy-acp` advertises `loadSession: false` — the call is an error that names `delegate_restart`, because a fresh session answering under the old id is not a follow-up. A follow-up occupies a slot exactly as an initial delegation does, and queues when the agent is full.
  - **`delegate_cancel`**:
    - `session_id` (mandatory): Cancels an active, queued or blocked session and automatically advances the queue. A session that already finished is an error, not a cancellation: rewriting `done` as `cancelled` would make a delivered result look retracted, and there is no slot to free.
  - **`delegate_restart`**:
    - `session_id` (mandatory), `prompt` (optional), `agent` (optional), `mode` (optional, default: the original session's): Resumes or restarts a failed, interrupted, or stopped session in its existing worktree.
  - **`delegate_permission`**:
    - `session_id` (mandatory), `decision` (`allow`, `allow_session` or `reject`), `request_id` (optional, to answer one of several): Answers a pending permission request with the agent's own option for that decision.
- **Permission Requests**:
  - In every mode but `dangerous`, the agent asks before running some tools and blocks its turn until it gets an answer. The extension forwards each request to the agent (with the command it wants to run, quoted and framed as data, not instructions), shows it in `delegate_status` and the status bar, and answers it with the agent's `delegate_permission` decision.
  - An unanswered request is rejected automatically after 5 minutes and the agent is told, so a session never hangs on it. **CLI Flag `--delegate-permission-timeout <minutes>`** changes the wait.
  - `allow_session` never picks a durable widening option: Devin's project-wide/global "always allow" or "switch to bypass", or Claude's `allow_always`. Claude has no session-scoped option at all, so the answer is one call and the reply says so. `agy`'s `allow_always` *is* session-scoped (a grant in a `Set` inside that session's gate, never written to disk), so there it is the answer, and the driver says so in its own file.
  - **Options are matched by exact `optionId`, never by `kind`.** `kind` is a label the agent chooses for its own UI — the payload real Devin sent in the 2026-10-22 incident carries `optionId: "allow_session"` under `kind: "allow_always"` — so a picker that reads it cannot tell a one-time approval from a durable rule, or from a "trust this workspace" prompt wearing an `allow_once` label. An agent that offers none of the ids the policy knows gets `cancelled`, which every agent reads as a rejection: failing closed.
- **Frame Decoder**:
  - stdout is read byte-wise and split on `\n` only, with an 8 MiB ceiling per frame. `node:readline` — what this replaced — also splits on U+2028/U+2029, and `JSON.stringify` leaves both raw in a stream, so an agent quoting a line of a file used to have its frame torn in half: both halves failed `JSON.parse`, and the session went silent mid-sentence with nothing but two dropped lines in the log.
  - A frame the reader cannot decode (over the ceiling, or not valid UTF-8) is dropped and recorded as `[framing]: <why>` in the session transcript, then reported through the runtime's warning channel — a hole in the record says so, and only the stream stops. The reader keeps going: one bad frame is not a dead session.
- **Bash Guard**:
  - Blocks the agent from running a guarded agent's own CLI through the `bash`/`powershell` tools (including nested calls from codemode scripts), so delegation goes through the tracked, queued `delegate_*` tools. The block message points the agent to `delegate_task`.
  - Which binaries are guarded comes from the drivers: Devin is (`devin`), Antigravity is (`agy` **and** its `agy-acp` adapter, because the adapter starts the same work behind a name a guard watching `agy` would not match), and Claude deliberately is not (blocking `claude` would block the operator's own CLI in unrelated sessions).
  - The read-only exceptions belong to each binary, because "just asking" is a fact about one CLI: Devin's listing is `devin models list` while a bare `devin models` is a usage error, and `agy models` *is* the listing. `--help`/`--version` are allowed everywhere, and a help flag next to a work flag (`-p`, `--conversation`, `--input-format`) is still blocked.
  - Detects direct calls, pipelines and lists, `$(...)`/backtick substitutions, `bash -c`/`eval` strings, wrappers (`sudo`, `env`, `timeout`, `xargs`, ...) and `find -exec`.
  - Static analysis has limits: variable expansion (`$CMD -p x`), scripts run from a file and heredocs fed to a shell are not inspected.
  - **Slash command `/delegate allow-bash [on|off|status]`** lifts or restores the block for the current session (no argument toggles). The block is on by default and resets when pi restarts.
- **Concurrency & FIFO Queueing**:
  - Default limit of 2 concurrent sessions **per agent** and 3 **in total**. A session holds its slot from the moment it is admitted — while its turn runs, stalls, or waits on a permission — so parallel calls and queue drains cannot overshoot either limit.
  - Additional requests queue in FIFO order per agent, and a drain serves the first task whose agent has capacity, so a busy Devin does not hold a Claude run behind it.
  - **CLI Flags `--delegate-max-runs <n>` and `--delegate-max-runs-total <n>`**: Configure both ceilings on startup.
  - **Slash Command `/delegate limit [n]`**: Inspects or modifies the per-agent limit interactively.
- **Worktree Isolation**:
  - Uses `orca worktree create` when Orca is available; falls back to Git worktree following Orca conventions (`~/orca/workspaces/<repo>/<branch>`).
  - Automatically discovers next unused branch index `${currentBranch}-dt${N}`.
- **Completion & PR Notifications**:
  - When a session finishes, automatically detects whether a GitHub PR was opened for the branch and notifies the agent.
- **Zero-Memory & Crash Durability**:
  - Message transcripts are never retained in RAM: streamed straight to `~/.pi/agent/delegate_task/<pi-session-id>/<session-id>/events.jsonl`, and read back bounded, so neither a 350 MiB turn nor a week-long session puts text in memory that no context window could hold anyway.
  - Queue and state are persistently saved to `state.json` on disk, allowing complete recovery across crashes or power outages. Records written by the pre-rename `devin_delegate` extension are still read (from `~/.pi/agent/devin_delegate/`), and a session that finished while pi was down is recovered from the driver's own session store.
- **Interface & Controls**:
  - **Status bar**: Displays live metrics in the footer: `Delegate <in flight>/<total> · <queued> queued · <completed> done`, with `(devin 2/2, N stalled, M awaiting permission)` so the per-agent figure that actually decides the next start is visible.
  - **Interactive TUI Dashboard (`/delegate list` or `/delegate sessions`)**:
    - Use `Up` / `Down` arrow keys to browse sessions.
    - Use `Right` / `Enter` to view message details streamed directly from disk.
    - Use `Left` to return to the session list and `q` / `Esc` to close.

#### Renamed from `devin_*`

The tool family was `devin_delegate`, `devin_status`, `devin_message`, `devin_permission`, `devin_cancel`, `devin_restart`, `devin_clean_worktree` and `/devin`. Every one of those names still works and always means `agent: "devin"`; each call replies that it is renamed. They are kept for one minor version and removed in a separate PR. `--devin-max-runs`, `--devin-turn-stall` and `--devin-permission-timeout` are read when the `--delegate-*` flag is absent, and old on-disk state is read from the old storage root. `docs/delegate-task-drivers-plan.md` is the design and the removal plan.

#### Tests

The CLI guard, permissions, slots, event mapping, driver registry, storage, recovery, runtime, rename layer, frame decoder (`test-delegate-framing.ts`), stall verdict (`test-delegate-liveness.ts`) and the `agy` driver (`test-delegate-agy.ts`, including the assertion that its tested agy version is the one `agy-acp` claims) each have unit tests (`node --test test/test-delegate-*.ts`). Two claims are checked against a real child process rather than a mock: a frame carrying U+2028 or U+2029 arrives whole (`test/helpers/fake-framing-agent.mjs`), and a driver's launch flags arrive as the argv the child sees. The `delegate-queue` suite (`bash test/run.sh delegate-queue`) drives the extension inside Pi against a fake ACP agent (`test/fake-acp-server.mjs`, behind both a `devin` and a `claude-agent-acp` shim): concurrency under parallel calls, permission forwarding and timeout, mode validation, stop reasons, the retired aliases, and two agents sharing one queue. `test/test-delegate-live.ts` and `test/test-delegate-live-lifecycle.ts` run inside Pi and start real agent sessions, so run them only deliberately.

#### Skill: `delegate-to-agents`

The package ships a Pi skill (`skills/delegate-to-agents/SKILL.md`) that teaches the agent how to use the `delegate_*` tools: which agent to pick, which Devin model per task class, where `thinking` applies, how to write the delegation prompt, when to use `create_worktree`, and how to verify the result. It is loaded on demand when a task matches, or explicitly with `/skill:delegate-to-agents`. It is installed together with the extension, so no extra setup is needed; run `pi update` and `/reload` to pick up changes.

### Orca Orchestration Observer (`orca_orchestration_*`)

A [Pi Extension](https://pi.dev/docs/latest/extensions) that enables coding agents to dispatch and supervise Orca workers without writing manual shell polling scripts or blocking loops.

#### Features

- **Tools**:
  - `orca_orchestration_dispatch`: Dispatches a supervised worker (`spec`, `objective`, `agent`, `worktree`, `task_title`, `model`, `effort`), binds a Run automatically, and begins background observation.
  - `orca_orchestration_observe`: Checks or toggles background observation for the current Run or specific dispatch.
  - `orca_orchestration_status`: Checks active workers, attention states, and bounded output lines (`read_output`, `complete`) without polling bash.
  - `orca_orchestration_reply`: Directly answers blocking worker questions or escalations (`message_id`, `answer`).
  - `orca_orchestration_release`: Cleans up settled worker terminals (`action: "release"`) or fences/stops runaway workers (`action: "stop"`).
- **Asynchronous Background Check Loop**:
  - Automatically runs `orca orchestration check --wait` in the background.
  - Intercepts keepalive pulses and delivers steer notifications directly to the coordinator agent upon `worker_done`, `question`, or `escalation`.
- **Periodic Reconciliation**:
  - Periodically inspects `orca orchestration worker-list` to detect unprompted process exits, attention requirements, or human prompts (`agentWait`).
- **Prompt Guidelines**:
  - Automatically augments the coordinator prompt in `before_agent_start` instructing it not to write polling scripts or bash loops, but to end its turn and await steering notifications.
- **TUI Dashboard & Controls**:
  - Live status indicator: `Orca: <running> running / <settled> settled`.
  - Slash command `/orchestration` with interactive TUI dashboard (`/orchestration dashboard`), subcommands `list`, `stop`, `release`, `enable`, `disable`.

#### Skill: `orca-orchestration`

The package ships a Pi skill (`skills/orca-orchestration/SKILL.md`) providing instructions on the task-spec contract, dispatch workflows, question answering, and terminal release.

### Test Database Tools (`requestdb` & `destroydb`)

When the system commands `requestdb` and/or `destroydb` are present in the environment (`PATH`), the extension dynamically registers them as agent tools and passes their stdout/stderr output directly to the agent:

- **`requestdb`**:
  - Creates or retrieves an isolated MariaDB/MySQL test database and user tailored deterministically to the current folder.
  - Returns credentials in `.env` format (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).
  - Optional parameter: `new` (boolean) to tear down any existing database for the directory and create a fresh one.
- **`destroydb`**:
  - Tears down the isolated test database and user for the current folder (or prunes deleted directories).
  - Optional parameters: `all` (boolean) to destroy all registered test databases, or `folder` (string) for a target directory.

#### Prerequisites

- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated (`gh auth login`).
- [Pi coding agent](https://pi.dev) installed.

#### How to Install

Install the extension directly from GitHub using Pi's built-in package manager:

##### Option 1: Global Installation (Recommended)

Install the package globally to make `observe_pr` available across all your Pi sessions:

```bash
pi install git:github.com/lucasschirm/claude-marketplace
```

Or using HTTPS:

```bash
pi install https://github.com/lucasschirm/claude-marketplace
```

To install from a specific branch or tag:

```bash
pi install git:github.com/lucasschirm/claude-marketplace@main
```

##### Option 2: Project-Local Installation

To enable the extension only for the current project, add `-l` (or `--local`):

```bash
pi install git:github.com/lucasschirm/claude-marketplace -l
```

This writes the package configuration into the local `.pi/settings.json`.

##### Managing the Package

- **Update**: Pull the latest changes for your installed extensions:
  ```bash
  pi update --extensions
  ```
- **List installed packages**:
  ```bash
  pi list
  ```
- **Remove**:
  ```bash
  pi remove git:github.com/lucasschirm/claude-marketplace
  ```

##### One-Off Trial

Try the extension for a single session without installing it into settings:

```bash
pi -e git:github.com/lucasschirm/claude-marketplace
# or locally:
pi -e ./extensions/observe-pr.ts
```

---

## Tests & CI

Every pull request runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml), which also runs on pushes to `main` and can be triggered manually from the Actions tab.

| Job | What it runs |
|---|---|
| **Manifests & unit tests** | `node scripts/validate-marketplace.mjs` (marketplace/plugin/Pi manifests + skill & agent frontmatter) and `node --test` on the standalone unit tests |
| **Pi extension tests** | one matrix job per suite: `observe-pr`, `branch-observer`, `startup-notice`, `observe-pr-resume`, `pr-tasks`, `tools`, `delegate-queue` — each installs Pi (`@earendil-works/pi-coding-agent`) and runs the suite inside the Pi runtime with mocked `gh` and `--offline`, so no model credentials are needed |

Run the same suites locally (Node >= 23.6 is required — `node --test` runs the TypeScript tests directly):

```bash
npm test                     # every CI suite
npm run validate             # manifests only
npm run test:unit            # standalone node:test suites only
bash test/run.sh --list      # list suite names
bash test/run.sh pr-tasks    # run one suite
```

Suites deliberately **not** in CI: `test/test-delegate-live.ts` and `test/test-delegate-live-lifecycle.ts` start real delegated-agent sessions, and `test/test-orca-orchestration.sh` needs a live Orca backend. Run those by hand.
