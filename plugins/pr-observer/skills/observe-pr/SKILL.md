---
name: observe-pr
description: Read a GitHub pull request's CI verdict and review conversation state now, or refresh it.
---

# Observe Pull Request

`observe_pr` answers two questions for a pull request - the current branch's when no number is
given (`42` and `#42` both work):

- **Did CI pass?** From `gh pr checks`: `passed`, `failed`, or `unknown`. `unknown` also covers
  checks still running and an unreadable checks call, so it is never a green light.
- **What do reviewers still want?** Open, blocked, stale and resolved conversation counts, naming
  the conversations that appeared since the last read.

It is a **snapshot**: this plugin has no background watcher. Call it again after pushing, and once
more before finishing, so nothing that arrived in the meantime is missed.

## Next step

- Open conversations: `pr_tasks_list`, then `pr_task_detail` for each one.
- Failed checks: read the log of the failing run (`gh run view <run-id> --log-failed`).
