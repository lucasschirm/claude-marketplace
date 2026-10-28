# PR Observer & Conversation Tasks

When working on a branch with a GitHub pull request:

- `observe_pr` reads CI and the conversation counts of a PR. It is a snapshot - call it again after
  pushing, and once more before finishing.
- `pr_tasks_list` discovers the open review conversations; `pr_task_detail` shows one in full,
  including its code suggestion.
- `pr_task_resolve` posts your message and resolves the thread; with `accept_suggestion` it also
  writes the suggestion, which it only does after that suggestion was shown to you.
- When a conversation needs a human decision, `pr_task_blocked` posts the reason and holds it.
- Do not conclude your work while unresolved conversations remain.
- The plugin's Stop hook holds your stop while the PR cannot land (conflict, base ahead, failing or
  running CI) and injects PR transitions after tool calls. When the stop is blocked with a
  "still running" heartbeat, end your turn again without starting other work; when it is blocked
  with a problem (conflict, failing CI), act on it. The user can always press Esc to end the wait.
