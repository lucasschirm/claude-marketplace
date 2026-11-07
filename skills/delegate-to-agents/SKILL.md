---
name: delegate-to-agents
description: Use when handing research, planning, code review, debugging, or coding work to a background agent through the delegate_task, delegate_status, delegate_message, delegate_permission, delegate_cancel and delegate_restart tools. Covers picking the agent (`devin`, `claude`), its model and thinking level per task class, writing the delegation prompt, running tasks in parallel in isolated worktrees, and verifying what comes back.
---

# Delegate a task to another agent

## Overview

The `delegate_*` tools run another agent's session in the background over its Agent Client Protocol (ACP) server. `delegate_task` returns immediately; the result arrives later as a follow-up message.

**Core principle: name the `agent`, the `model`, and the reason. Both defaults are deliberately modest.** `agent` defaults to `devin` (for one release — say it explicitly anyway), Devin's default model is `swe-2-high` (right only for simple coding) and Claude's is `sonnet`, so omitting `model` quietly under-powers research, review and complex work.

## Tools

| Tool | Use |
| :--- | :--- |
| `delegate_task` | Start a task. Params: `prompt` (required), `agent`, `model`, `thinking`, `mode`, `create_worktree`. |
| `delegate_status` | Check sessions. No args: every session and the queue. `session_id`: state plus recent messages; `full: true` for the whole transcript. |
| `delegate_message` | Send a follow-up to an idle session (`session_id`, `message`). It is a turn of work: it holds a slot, or queues. A session whose process died is continued when the agent re-accepts its id (Devin), and refused with a pointer to `delegate_restart` when it does not (Claude) — a new conversation wearing an old id is not a follow-up. |
| `delegate_cancel` | Cancel a running, queued or blocked session (session id or queue id). A session that already finished is an error, not a cancellation — it holds no slot, and its result stands. |
| `delegate_permission` | Answer a session's pending permission request (`session_id`, `decision`: `allow`, `allow_session` or `reject`; `request_id` when several are pending). |
| `delegate_restart` | Resume a failed, interrupted or stopped session in its original worktree. Optional new `prompt`, `agent`, `mode`. |
| `delegate_clean_worktree` | Release and delete the worktree of a settled session (`session_id`), or of every settled session whose PRs are merged/closed (`all_settled: true`). Optional `force`. |

`/delegate` is the slash command: `list`, `agents`, `limit [n]`, `cancel <id>`, `allow-bash [on|off|status]`.

The `devin_*` tool names and `/devin` still work for one minor version and always mean `agent: "devin"`; each call says it is renamed. Write new work with the `delegate_*` names.

Do not run an agent's own CLI through bash. The guarded agents (currently Devin) are blocked there and the call fails with a message pointing back to these tools; only read-only commands are allowed (`devin models list`, `devin ls`, `devin version`, `devin --help`). If a direct CLI run is truly needed, ask the user to run `/delegate allow-bash on`.

## Choosing an agent

`/delegate agents` lists what is installed on this machine and what each agent supports.

| Agent | Use it when |
| :--- | :--- |
| `devin` (default) | Default for coding, review and research runs. Models are picked per task class (table below). |
| `claude` | You want Claude rather than Devin: a second opinion from a different model family, or work where Claude's own tooling and habits fit better. Defaults to `sonnet`, with effort through `thinking`. Its catalogue is the machine's — the adapter lists whatever that install allows — so pass `model` only when you know this one carries the value. |

A second agent is a real second opinion, not a retry: when you ask for a review of work the first agent did, delegate to the *other* one. Capacity is limited per agent **and** in total, so a busy Devin does not block a Claude run.

## Routing table (Devin)

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

`devin models list | grep Free` lists the models that do not bill per token — the `swe-2-*` and `swe-2-flash-*` ids. The rest do, and they are what exhausts an account: `*-lightning` and `fusion-*` ids burned a whole day's quota on two review sessions here, and every delegation after them failed with "daily usage quota has been exhausted" while the `swe-2-*` ids kept running. Name a paid id only when the task needs its speed or context, and drop to a free `swe-2-*` id when a session reports usage exhausted.

## Choosing `thinking`

`thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) is a per-agent control, not a universal dial:

- **Devin has no thinking control.** Its reasoning effort is baked into the model id (`swe-2-high` vs `swe-2-max`), so `thinking` on a Devin task is *refused*, not ignored. To get more thinking from Devin, change `model`.
- **Claude has one.** Use `high` for review and debugging where the extra reasoning changes the findings, and leave it unset for mechanical work.

An unknown level is refused. Ask for it only when the task's quality depends on reasoning depth; otherwise the model id and the prompt are the levers.

## Choosing `mode`

`mode` defaults to `dangerous`, which auto-approves every tool the agent asks for, including destructive shell. It is the only mode that completes an unattended run without your involvement.

In every other mode the agent asks before running tools it may not run on its own, and its turn **blocks until you answer**. You get a message naming the session and the command; answer it with `delegate_permission`. `accept-edits` asks before every shell command. An unanswered request is rejected automatically after the permission timeout (5 minutes by default); the agent continues without that command and tells you it did. A blocked session holds one of the slots, so answer promptly or the queue stalls behind it. Unknown modes are refused, and each agent maps the canonical names (`dangerous`, `auto`, `accept-edits`, `plan`, `ask`) into its own vocabulary.

Treat `dangerous` as a decision, not a default: pair it with `create_worktree: true` for anything that writes, and for read-only work say "do not modify any files" in the prompt. On Claude, `bypassPermissions` is unavailable when running as root outside a sandbox, and an `allow_session` answer has no session-scoped option to map to, so it approves one call and says so.

## Workflow

1. Pick the agent, classify the task, pick the model (and `thinking` where the agent supports it).
2. Write the prompt (below). The agent starts with no memory of this conversation.
3. Call `delegate_task`. You get a session id, or a queue position with a queue id. Capacity is limited per agent and in total; the rest queue in order and report their id when they start.
4. Carry on with other work. **Do not poll `delegate_status`.** A follow-up message arrives when a session finishes (including a PR link if one was opened) or fails.
5. On completion, read the result with `delegate_status`. **Read how the turn ended.** "ended early: it hit its token limit" means the work is incomplete; "is done" is the only phrase that means it finished.
6. Answer permission requests with `delegate_permission` as they arrive (any mode but `dangerous`).
7. Course-correct with `delegate_message`, or resume a failed session with `delegate_restart`. Use `delegate_cancel` when the task is no longer wanted.
8. Verify the result before reporting it (below).

## Isolating work with `create_worktree`

`create_worktree: true` runs the session in a new worktree on a branch named `<currentBranch>-dt<N>`. Use it for coding runs, and always when several sessions run in parallel.

**Worktree lifecycle & cleanup:**

- Orca registers the worktree as a child workspace of the parent session.
- When an associated PR is merged or closed, the PR observer automatically deletes the worktree and releases the child workspace from Orca.
- When a clean session is cancelled, its worktree is cleaned up automatically.
- To manually clean a finished session's worktree, call `delegate_clean_worktree({ session_id })` or `delegate_clean_worktree({ all_settled: true })`.
- Uncommitted or unpushed work is protected by default; pass `force: true` only if you intentionally wish to discard changes.

**The rule: if N sessions would edit the same shared file, forbid all of them from touching it and make those edits yourself.** Task boards, root index files, changelogs and `.gitignore` are the usual suspects. Give each prompt an explicit list of paths the session does not own. Keep bookkeeping (ticket status, PR URLs) in your own session. If a session needs a shared file changed, have it report the needed line and apply it at merge time.

Before opening PRs from parallel branches, dry-run each pair with `git merge-tree --write-tree <branch-a> <branch-b>`.

A research or review run on the current tree does not need a worktree.

## Writing the prompt

The agent cannot see this conversation. Include the goal, the relevant paths, and the expected deliverable. For coding runs, add:

- **Ownership boundary.** Name the directory the session works in and say not to touch anything outside it. Name paths it must not create when sibling work exists.
- **Corrections to the source material.** If the ticket, plan or spec contains something you know is wrong, say so and override it. An agent follows its source faithfully, including into a mistake.
- **Host capabilities.** State what the machine cannot do and what to do instead ("no Docker here: write the Dockerfile, do not try to build it").
- **An honesty clause.** "A negative result is a valid deliverable. Mark anything you did not verify as unverified. Do not invent findings." This is the highest-leverage sentence in the prompt.
- **Commit policy.** Say "commit nothing — leave changes in the working tree" if you want to review before committing.
- **Verification commands.** Name the exact test, lint and typecheck commands that must pass.

For research and planning, state the question, the scope of the search, and the format of the answer. Ask for risks and caveats first, so a truncated answer loses the least valuable part.

## Verifying what comes back

- **Do not trust a completion report.** "All checks pass" has been observed next to commands that fail on re-run. Re-run the cheap checks yourself.
- **Check git state first.** An agent sometimes runs `git commit` despite "commit nothing", and stages files it never touched. Look at `git log` and `git status` in the worktree before verifying. A premature commit is not itself a problem: verify the diff, then amend with your own message.
- **Independently verify every external constant it pins**: package versions, hashes, URLs, config keys. A wrong value survives review and fails later.
- **Match the repo's conventions.** New dependencies may use `^` ranges where the repo pins exactly.
- **Reconcile research with the real tree.** Check its claims about existing files and settled decisions before acting.
- **Test parallel branches against each other.** If one session adds a lint, format or type gate, run the other sessions' output through it.

## Common mistakes

- Omitting `model` and getting `swe-2-high` for a research or review task.
- Passing `thinking` to a Devin run: it is refused. Devin's effort is the model id.
- Asking a second agent to review an agent's work without saying which agent ran, or what it claimed.
- Polling `delegate_status` in a loop instead of waiting for the completion message.
- Delegating a mixed task ("review and fix") in one call.
- Running parallel coding sessions without `create_worktree`, or without telling them which shared files are off limits.
- Reading a failed session as a prompt problem before reading `delegate_status` with `full: true`. Prefer `delegate_restart` over a fresh delegation when the worktree already holds useful progress.
- Cancelling and restarting a session that is waiting for permission: the restart repeats its mode and blocks again. Answer with `delegate_permission`, or restart with `mode: "dangerous"`.
- Treating `delegate_cancel` as undo. It stops the session; it does not revert files already written.
