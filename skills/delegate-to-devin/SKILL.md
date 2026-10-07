---
name: delegate-to-devin
description: Use when handing research, planning, code review, debugging, or coding work to Devin through the devin_delegate, devin_status, devin_message, devin_cancel and devin_restart tools. Covers picking the Devin model per task class, writing the delegation prompt, running tasks in parallel in isolated worktrees, and verifying what comes back.
---

# Delegate to Devin

## Overview

The `devin_*` tools run Devin sessions in the background over its Agent Client Protocol (ACP) server. `devin_delegate` returns immediately; the result arrives later as a follow-up message.

**Core principle: every `devin_delegate` call names its `model` explicitly, and the model follows from the task class.** The tool's default (`swe-2-high`) is only right for simple coding, so omitting `model` quietly under-powers research, review and complex work.

## Tools

| Tool | Use |
| :--- | :--- |
| `devin_delegate` | Start a task. Params: `prompt` (required), `model`, `mode`, `create_worktree`. |
| `devin_status` | Check sessions. No args: last 3 messages of every session. `session_id` + `complete: true`: full transcript. |
| `devin_message` | Send a follow-up to an existing session (`session_id`, `message`). |
| `devin_cancel` | Cancel a running or queued session (session id or queue id). |
| `devin_restart` | Resume a failed, interrupted or stopped session in its original worktree. Optional new `prompt`. |

## Routing table

Pick the model by what a *successful run must do*, not by prompt length.

| Task class | `model` |
| :--- | :--- |
| Research, planning, investigation, diagnosing a bug without fixing it | `glm-5-3-flash-max` |
| Implementation review (diff, branch, module) | `swe-2-max` |
| Complex coding | `swe-2-max` |
| Simple coding / configuration | `swe-2-high` |

- **Simple coding** means all of: 1–2 files, fully specified end state, no new interface or abstraction, mechanical (rename, version bump, add a field, typo, known lint fix).
- **Complex coding** means any of: 3+ files or crossing a module/process boundary, new or changed interface/schema/API, more than one defensible design, new tests needed, concurrency/state machines/migrations/security-relevant code, or the agent must explore to learn what to write.
- Between simple and complex, use the more powerful model. Under-powering wastes a run; over-powering costs nothing.
- A task that mixes classes ("review this, then fix it", "find the bug and fix it") is split into separate delegations, each with its own model.
- Writing or updating tests is complex unless it is a mechanical assertion tweak in one file.
- A spike that must install, execute or measure things is coding class even if the deliverable is a report.

`devin models list | grep Free` lists free models. Use one if a session reports that usage is exhausted.

## Choosing `mode`

`mode` defaults to `dangerous` (mapped to ACP `bypass`), which auto-approves every tool, including destructive shell. It is the only mode that reliably completes an unattended coding run. `auto` and `accept-edits` abort on the first tool call that needs confirmation, and shell calls always need it.

Treat `dangerous` as a decision, not a default: pair it with `create_worktree: true` for anything that writes, and for read-only work say "do not modify any files" in the prompt.

## Workflow

1. Classify the task and pick the model.
2. Write the prompt (below). Devin starts with no memory of this conversation.
3. Call `devin_delegate`. You get either `Your session started with id: …` or a queue position. At most 2 sessions run at once; the rest queue FIFO and report their id when they start.
4. Carry on with other work. **Do not poll `devin_status`.** A follow-up message arrives when a session finishes (including a PR link if one was opened) or fails.
5. On completion, read the result with `devin_status` (`session_id`, `complete: true` for the full transcript).
6. Course-correct with `devin_message`, or resume a failed session with `devin_restart`. Use `devin_cancel` when the task is no longer wanted.
7. Verify the result before reporting it (below).

## Isolating work with `create_worktree`

`create_worktree: true` runs the session in a new worktree on a branch named `<currentBranch>-dt<N>`. Use it for coding runs, and always when several sessions run in parallel.

**The rule: if N sessions would edit the same shared file, forbid all of them from touching it and make those edits yourself.** Task boards, root index files, changelogs and `.gitignore` are the usual suspects. Give each prompt an explicit list of paths the session does not own. Keep bookkeeping (ticket status, PR URLs) in your own session. If a session needs a shared file changed, have it report the needed line and apply it at merge time.

Before opening PRs from parallel branches, dry-run each pair with `git merge-tree --write-tree <branch-a> <branch-b>`.

A research or review run on the current tree does not need a worktree.

## Writing the prompt

Devin cannot see this conversation. Include the goal, the relevant paths, and the expected deliverable. For coding runs, add:

- **Ownership boundary.** Name the directory Devin works in and say not to touch anything outside it. Name paths it must not create when sibling work exists.
- **Corrections to the source material.** If the ticket, plan or spec contains something you know is wrong, say so and override it. Devin follows its source faithfully, including into a mistake.
- **Host capabilities.** State what the machine cannot do and what to do instead ("no Docker here: write the Dockerfile, do not try to build it").
- **An honesty clause.** "A negative result is a valid deliverable. Mark anything you did not verify as unverified. Do not invent findings." This is the highest-leverage sentence in the prompt.
- **Commit policy.** Say "commit nothing — leave changes in the working tree" if you want to review before committing.
- **Verification commands.** Name the exact test, lint and typecheck commands that must pass.

For research and planning, state the question, the scope of the search, and the format of the answer. Ask for risks and caveats first, so a truncated answer loses the least valuable part.

## Verifying what comes back

- **Do not trust a completion report.** "All checks pass" has been observed next to commands that fail on re-run. Re-run the cheap checks yourself.
- **Check git state first.** Devin sometimes runs `git commit` despite "commit nothing", and stages files it never touched. Look at `git log` and `git status` in the worktree before verifying. A premature commit is not itself a problem: verify the diff, then amend with your own message.
- **Independently verify every external constant Devin pins**: package versions, hashes, URLs, config keys. A wrong value survives review and fails later.
- **Match the repo's conventions.** New dependencies may use `^` ranges where the repo pins exactly.
- **Reconcile research with the real tree.** Check its claims about existing files and settled decisions before acting.
- **Test parallel branches against each other.** If one session adds a lint, format or type gate, run the other sessions' output through it.

## Common mistakes

- Omitting `model` and getting `swe-2-high` for a research or review task.
- Polling `devin_status` in a loop instead of waiting for the completion message.
- Delegating a mixed task ("review and fix") in one call.
- Running parallel coding sessions without `create_worktree`, or without telling them which shared files are off limits.
- Reading `status: failed` as a prompt problem before checking `devin_status` with `complete: true`. Prefer `devin_restart` over a fresh delegation when the worktree already holds useful progress.
- Treating `devin_cancel` as undo. It stops the session; it does not revert files already written.
