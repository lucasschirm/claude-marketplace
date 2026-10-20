# PR Observer Plugin (Devin CLI & Claude Code)

Cross-platform PR observation and conversation task management plugin for **Devin CLI** and **Claude Code**.

## Features
- **MCP Tools**: `observe_pr`, `pr_tasks_list`, `pr_task_detail`, `pr_task_resolve`, `pr_task_blocked`.
- **Settlement Enforcement**: Intercepts Devin's `Stop` event to prevent premature completion when open review tasks remain.
- **Skills**: `/observe-pr` and `/pr-tasks` procedures.
- **Shared Domain Engine**: Reuses the tested GitHub GraphQL and review reconciliation logic from `extensions/lib/`.

## Installation

### Devin CLI

Install directly from the GitHub repository:

```bash
devin plugins install "lucasschirm/claude-marketplace#plugins/pr-observer"
```

### Claude Code

Add the marketplace from GitHub and install the plugin:

```
/plugin marketplace add lucasschirm/claude-marketplace
/plugin install lsc-pr-observer
```
