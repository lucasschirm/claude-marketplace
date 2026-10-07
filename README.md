# claude-marketplace

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

### Devin Delegate (`devin_delegate`)

A [Pi Extension](https://pi.dev/docs/latest/extensions) that allows the coding agent to delegate tasks asynchronously to Devin via Devin's native Agent Client Protocol (ACP) server. Supports concurrency throttling, FIFO queueing, worktree isolation, multi-turn follow-ups, disk-backed logging, and arrow-key TUI navigation.

#### Features

- **Agent Tools**:
  - **`devin_delegate`**:
    - `prompt` (mandatory): Task instructions.
    - `model` (optional, default `"swe-2-high"`): Devin model to run.
    - `mode` (optional, default `"dangerous"`): Permission mode (`dangerous` maps to ACP `bypass` mode).
    - `create_worktree` (optional, default `false`): Spin up an isolated worktree branch (`${currentBranch}-dt${N}`).
    - Runs asynchronously: returns immediately with session ID or queue position.
  - **`devin_status`**:
    - `session_id` (optional): Specific session to check.
    - `complete` (optional boolean, requires `session_id`): Returns complete message transcript from disk.
    - If `session_id` omitted: returns recent 3 messages, status, and last message time for each session.
  - **`devin_message`**:
    - `session_id` (mandatory) and `message` (mandatory): Sends follow-up instructions to an active or idle session via ACP.
  - **`devin_cancel`**:
    - `session_id` (mandatory): Cancels an active or queued session and automatically advances the queue.
  - **`devin_restart`**:
    - `session_id` (mandatory), `prompt` (optional): Resumes or restarts a failed, interrupted, or stopped session in its existing worktree.
- **Bash Guard**:
  - Blocks the agent from running the `devin` CLI through the `bash`/`powershell` tools (including nested calls from codemode scripts), so all delegation goes through the tracked, queued `devin_*` tools. The block message points the agent to `devin_delegate`.
  - Detects direct calls, pipelines and lists, `$(...)`/backtick substitutions, `bash -c`/`eval` strings, wrappers (`sudo`, `env`, `timeout`, `xargs`, ...) and `find -exec`.
  - Read-only commands stay allowed: `devin models list`, `devin ls`/`list`, `devin version`, `devin help`, and `--help`/`--version`.
  - Static analysis has limits: variable expansion (`$CMD -p x`), scripts run from a file and heredocs fed to a shell are not inspected.
  - **Slash command `/devin allow_bash [on|off|status]`** lifts or restores the block for the current session (no argument toggles). The block is on by default and resets when pi restarts.
- **Concurrency & FIFO Queueing**:
  - Default limit of 2 concurrent running sessions.
  - Automatically queues additional requests in FIFO order and dequeues them as runs finish.
  - **CLI Flag `--devin-max-runs <n>`**: Configures the concurrency limit on startup.
  - **Slash Command `/devin limit [n]`**: Inspects or modifies the concurrency limit interactively.
- **Worktree Isolation**:
  - Uses `orca worktree create` when Orca is available; falls back to Git worktree following Orca conventions (`~/orca/workspaces/<repo>/<branch>`).
  - Automatically discovers next unused branch index `${currentBranch}-dt${N}`.
- **Completion & PR Notifications**:
  - When Devin finishes, automatically detects whether a GitHub PR was opened for the branch and notifies the agent.
- **Zero-Memory & Crash Durability**:
  - Message transcripts are never retained in RAM; streamed directly to `~/.pi/agent/devin_delegate/<pi-session-id>/<devin-session-id>/events.jsonl`.
  - Queue and state are persistently saved to `state.json` on disk, allowing complete recovery across crashes or power outages.
- **Interface & Controls**:
  - **Status bar**: Displays live metrics in the footer: `Devin <running>/<queued>/<completed>`.
  - **Interactive TUI Dashboard (`/devin list` or `/devin sessions`)**:
    - Use `Up` / `Down` arrow keys to browse sessions.
    - Use `Right` / `Enter` to view message details streamed directly from disk.
    - Use `Left` to return to the session list and `q` / `Esc` to close.

#### Tests

The bash guard has standalone unit tests: `node --test test/test-devin-bash-guard.ts`. `test/test-devin-delegate.ts` runs inside Pi and starts real Devin sessions, so run it only deliberately.

#### Skill: `delegate-to-devin`

The package ships a Pi skill (`skills/delegate-to-devin/SKILL.md`) that teaches the agent how to use the `devin_*` tools: which Devin model to pick per task class, how to write the delegation prompt, when to use `create_worktree`, and how to verify the result. It is loaded on demand when a task matches, or explicitly with `/skill:delegate-to-devin`. It is installed together with the extension, so no extra setup is needed; run `pi update` and `/reload` to pick up changes.

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
