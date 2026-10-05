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
- **Interface & Controls**:
  - **Status bar**: Displays live observed metrics in the footer: `<totalPrs>/<runs> observed`.
  - **Slash command `/pr_observer`**: Comprehensive user controls:
    - `/pr_observer` (or `disable` / `enable`): Toggles or explicitly enables/disables the `observe_pr` tool for the agent.
    - `/pr_observer list` (or `status`): Opens an interactive terminal dashboard modal displaying all observed PRs, active run IDs, pass/fail counts, and comment counters.
    - `/pr_observer stop <prNumber>`: Stops observing a specific PR directly from the command line.
  - **Configurable CLI Flag `--pr-observer-interval`**: Customizes the check and polling interval (defaults to 60 seconds):
    ```bash
    pi --pr-observer-interval 30
    ```

#### Prerequisites

- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated (`gh auth login`).
- [Pi coding agent](https://pi.dev) installed.

#### How to Install

##### Option 1: Global Installation (Available across all projects)

Copy [`extensions/observe-pr.ts`](file:///home/lucas/orca/workspaces/claude-marketplace/Pi-Plugin/extensions/observe-pr.ts) into your personal Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/observe-pr.ts ~/.pi/agent/extensions/observe-pr.ts
```

Pi automatically discovers and loads extensions from `~/.pi/agent/extensions/` on startup.

##### Option 2: Project-Level Installation

Place the extension inside the project's `.pi/extensions/` folder:

```bash
mkdir -p .pi/extensions
cp extensions/observe-pr.ts .pi/extensions/observe-pr.ts
```

When running `pi` inside the project, ensure project files are trusted (e.g., `pi --approve` or approving on prompt).

##### Option 3: Direct Load During a Session

Load the extension for a single session without copying:

```bash
pi --extension ./extensions/observe-pr.ts
```
