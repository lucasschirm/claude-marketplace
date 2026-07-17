---
name: agents-md-maintainer
description: Use when creating, adding, renaming, moving, or deleting files in a folder, or when a folder's structure/responsibilities change — to create or update that folder's AGENTS.md map. Also when asked to document a directory for AI/agent discovery, or when an AGENTS.md has gone stale.
---

# AGENTS.md Maintainer

## Overview

`AGENTS.md` is a **per-folder quick-reference map** that lets an AI agent (or a new developer) understand a directory's purpose, its files, and how they relate — without reading every file. One `AGENTS.md` lives at the root of each documented folder.

**Core principle:** `AGENTS.md` is a *map, not documentation*. It says what each file is in one line and how the files connect — nothing more. Its single job is to stay an accurate mirror of the folder. A stale `AGENTS.md` is worse than none, because it misleads.

## When to create or update it

Whenever you create or modify files inside a folder, check that folder for an `AGENTS.md`:

- **It doesn't exist** → create it (unless the folder is exempt — see below). First check whether a project scaffolding tool or a post-commit hook already generated a stub; if a stub exists, **fill it in, don't overwrite it**.
- **It exists** → update it to reflect every new, renamed, or removed file and any change to the folder's structure or responsibilities. Update it in the *same* change that touched the files — never leave it for later.

## Where NOT to create it (exemptions)

Do **not** create a new `AGENTS.md` in:

- Tooling/config directories: any folder under `./.claude`, `./.windsurf`, `./.cursor`, `./.vscode` (config, not source).
- Generated or vendored output: `node_modules`, `dist`, `build`, `coverage`, `.next`, and similar.

> An `AGENTS.md` that *already* exists in an exempt folder may be updated when needed — but don't add new ones there.

## Required contents

Every `AGENTS.md` must contain at minimum:

1. **Purpose** — one or two sentences on what the folder is for.
2. **File list** — each file with a one-line summary of what it does.
3. **Key relationships** — how files/dirs depend on each other (e.g. which service a controller uses), when non-obvious.

Keep it concise. It is a quick-reference map, not full documentation — no API dumps, no code walkthroughs, no changelog.

## Format

Mirror this structure (headings scale to the folder — a test dir may add `## Test files`, a small dir may list files directly):

```md
# services/

Providers for the database-definition feature.

## Files

- **create-column.service.ts** — Creates a new column (validation + persistence).
- **create-column.service.spec.ts** — Unit tests for CreateColumnService.
- **column.factory.ts** — Builds column definitions from raw table metadata.

## Key relationships

- `create-column.service.ts` uses `column.factory.ts` and persists via the `DbmColumns` model.
```

Format rules:
- **Title** — `# <foldername>/` (the folder's own name with a trailing slash), first line.
- **Purpose** — a plain sentence directly under the title, no heading.
- **File entries** — a bullet per file: `- **filename.ext** — summary.` Bold the exact filename; follow it with ` — ` and a single, specific sentence. Sort in a stable order (as they appear on disk or grouped by role).
- **Subdirectories** — list a child dir as `- **subdir/**` and let its own `AGENTS.md` describe its contents; don't duplicate the child's file list here.
- **Group with `##` headings** only when the file count warrants it (e.g. `## Files`, `## Support files`, `## Test files`).

## Do / Don't

**Do**
- Write each file summary so a reader knows *why the file exists and when they'd open it* — not just a restatement of the filename.
- Update the summary line when a file's behavior changes, not only when files are added or removed.
- Keep every entry to one line; if a file needs more, that detail belongs in the file's own header comment, not here.

**Don't**
- Don't let it go stale — an `AGENTS.md` that lists deleted files or misses new ones is a defect.
- Don't restate the filename ("`user.service.ts` — the user service"). Say what it *does*.
- Don't paste full documentation, code, or exhaustive option lists — this is a map.
- Don't create one in an exempt folder (`.claude`, `node_modules`, `dist`, …).
- Don't overwrite a generated stub — fill in its TODO placeholders instead.

## Common mistakes

| Mistake | Fix |
|---|---|
| Added/removed a file but didn't touch `AGENTS.md` | Update it in the same change; the map must match the folder |
| Summary just repeats the filename | Describe purpose/behavior — what it does and when you'd read it |
| Turned `AGENTS.md` into full docs | Trim to purpose + one-line-per-file + key relationships |
| Created `AGENTS.md` in `node_modules`/`dist`/`.claude` | Remove it; those folders are exempt |
| Overwrote a scaffolded stub | Fill in the TODO placeholders instead of replacing the file |
| Re-listed a subdirectory's files in the parent | Reference the subdir; let its own `AGENTS.md` own those files |
