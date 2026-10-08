---
name: orca-orchestration
description: Use when supervising, coordinating, or dispatching tasks to Orca workers using the orca_orchestration_dispatch, orca_orchestration_observe, orca_orchestration_status, orca_orchestration_reply, and orca_orchestration_release tools. Covers automated background observation, answering blocking worker questions, and releasing settled terminals without writing polling scripts.
---

# Orca Orchestration

## Overview

The `orca_orchestration_*` tools provide automated, asynchronous dispatch and background observation for supervised Orca workers. 

**Core principle: Do not write shell scripts or poll loops in bash.** The extension automatically monitors the Run, watches for worker completion, blocks/relays questions, and steers notifications directly to your turn.

## Tools

| Tool | Use |
| :--- | :--- |
| `orca_orchestration_dispatch` | Dispatch a supervised worker. Params: `spec` (required), `objective`, `agent`, `worktree`, `task_title`, `model`, `effort`. Automatically binds Run and activates background observation. |
| `orca_orchestration_observe` | Check or toggle observation state for the Run or a specific dispatch. Params: `run_id` (bind/adopt Run from another session), `dispatch_id` (observe specific dispatch), `all` (list all active workers/runs across sessions), `action` (`status`, `start`, `stop`). |
| `orca_orchestration_status` | Query active workers, attention states, and bounded output without polling bash. Params: `dispatch_id`, `run_id` (adopt/inspect Run from another session), `all` (list all active workers/runs across sessions), `read_output`, `complete`. |
| `orca_orchestration_reply` | Answer a worker's blocking question or escalation without manual CLI piping (`message_id`, `answer`). |
| `orca_orchestration_release` | Release settled worker terminals (`action: "release"`, default) or fence/stop a runaway worker (`action: "stop"`). |

## Workflow

1. **Decompose & Dispatch**:
   Break down the objective into small, well-bounded tasks following the task-spec contract:
   - **Target**: Files or component in scope.
   - **Change**: Concrete deliverable to produce.
   - **Constraints**: Invariants and boundaries.
   - **Ownership**: Boundaries and off-limit files.
   - **Acceptance criteria**: Verifiable tests/commands.
2. **Invoke `orca_orchestration_dispatch`**:
   Call `orca_orchestration_dispatch` with the task spec. It returns a receipt with `dispatch_id`, `task_id`, and `terminal_handle`.
3. **End turn and wait**:
   You do **not** need to poll `orca_orchestration_status` or run bash commands. When the worker:
   - Completes (`worker_done`): You receive a steer notification with outcome, summary, and modified files.
   - Asks a question: You receive a steer notification with the question text and `message_id`.
   - Escalates: You receive a steer alert.
4. **Answer questions**:
   If a worker asks a question, call `orca_orchestration_reply` with the `message_id` and your answer.
5. **Verify and release**:
   Once `worker_done` is reported, inspect changes if needed, and call `orca_orchestration_release` to clean up the worker terminal.

## Observing Work Dispatched from Another Session

If a task or worker was dispatched from bash or a separate terminal, the current session is not automatically bound to that Run. To observe it:
1. **List all active workers and runs**:
   Call `orca_orchestration_status({ all: true })` or `orca_orchestration_observe({ all: true })` to inspect live workers and runs across all sessions.
2. **Adopt and observe**:
   - Call `orca_orchestration_observe({ run_id: "<run_id>" })` to adopt the Run and start background monitoring.
   - Or call `orca_orchestration_status({ dispatch_id: "<dispatch_id>" })` to inspect and observe a specific worker dispatch.

## Slash Command & Dashboard

Run `/orchestration dashboard` in the Pi TUI to view the live dashboard component with keyboard navigation, active worker statuses, and outcomes.
