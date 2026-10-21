---
name: pr-tasks
description: List, inspect, and resolve pull request review conversations and code suggestions.
---

# PR Review Tasks

Manage review conversations on pull requests.

## Workflow
1. Call `pr_tasks_list` to see all pending conversations.
2. Call `pr_task_detail` with `task_id` to inspect discussion and diff context.
3. Call `pr_task_resolve` with `accept_suggestion: true` to apply suggestions directly to disk and resolve the thread on GitHub.
4. Call `pr_task_blocked` if user clarification is required.
