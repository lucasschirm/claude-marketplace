---
name: pr-tasks
description: List, inspect, and resolve pull request review conversations and code suggestions.
---

# PR Review Tasks

Review conversations are the work a pull request still owes. Each one is identified by its
**Conversation Id**, which is what every tool below takes as `task_id`.

## Workflow

1. `pr_tasks_list` - the conversations of a PR (the current branch's by default). It fetches the
   threads from GitHub first, so the listing is current. `show_all: true` includes resolved ones.
2. `pr_task_detail` - the comment, its file and lines, every reply, and its ```suggestion block.
3. `pr_task_resolve` with a `message` - posts the message as the reply and resolves the thread.
   With `accept_suggestion: true` the suggestion is also written to the file, but only after
   `pr_task_detail` (or a listing) has shown it, and only once: a suggestion whose reviewed lines
   moved, were deleted, or changed on GitHub after an earlier apply is refused, not guessed at.
4. `pr_task_blocked` with a `reason` - posts the reason and keeps the conversation out of the open
   work until the reviewer answers it. Use it when the change needs a human decision, not as a way
   to close a turn.

## Rules

- Resolve only what was actually addressed, and say in `message` what changed.
- A blocked conversation is still open work: it returns when the reviewer replies, and stays listed
  as `BLOCKED` meanwhile.
- Finish a pull request with no open conversations - resolved or explicitly blocked.
