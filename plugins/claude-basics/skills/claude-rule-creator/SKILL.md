---
name: claude-rule-creator
description: Use when the user asks to create, add, change, update, refactor, split, audit, or optimize a Claude behavioral rule or memory instruction in .claude/rules/ (or "make Claude always/never do X"). Also when rules conflict, a rule file is too large, or instructions aren't being followed.
---

# Claude Rule Creator

## Overview

You maintain the **rule system** that shapes Claude's behavior in a workspace. Every rule is **context that loads into a token budget**, and a rule Claude misreads is worse than no rule. So each rule must be three things at once: **loaded only when needed** (token-aware), **non-conflicting** with what already exists, and **written so precisely that Claude cannot skip or misinterpret it**.

> **Rules live in `.claude/rules/` — never in `CLAUDE.md`.**
> Save every rule as a one-topic markdown file under `.claude/rules/` (project) or `~/.claude/rules/` (global). Do **not** write rules into `CLAUDE.md` or `CLAUDE.local.md`.
> **Why:** `.claude/rules/` is the purpose-built, modular home for rules, and it's the *only* place a rule can carry `paths:` frontmatter so it loads **on demand** when Claude touches matching files. `CLAUDE.md` always loads in full at launch and cannot be path-scoped — leave it for project overview, build commands, and architecture, not rules.

**Core principle:** A rule you write today costs tokens in *every* session where it loads, and shapes behavior only if it's unambiguous. Before writing, always ask: *which paths/globs does this apply to, does a rule for this already exist, and is the wording concrete enough to verify?*

Ground truth for every mechanism below is the official docs: https://code.claude.com/docs/en/memory.md — never invent a mechanism; verify against the docs when unsure.

## Step 1 — Determine scope: global or project? (ask if unclear)

A rule file lives in one of these homes. If the user hasn't made it obvious, **ask before writing**:

> "Should this be a **global** rule (applies to every project you work on) or a **project** rule (only this codebase)?"

| Scope | Where the rule file goes | Use for |
|---|---|---|
| **Global** | `~/.claude/rules/<topic>.md` | Personal preferences that hold across every project |
| **Project** | `./.claude/rules/<topic>.md` (committed to git) | Team standards for this codebase |
| **Project, private** | `./.claude/rules/<topic>.md` added to `.gitignore` | Personal per-project rules, not shared with the team |

- One topic per file; `<topic>.md` is a descriptive name like `testing.md`, `api-design.md`, `security.md`. Files are discovered recursively, so `.claude/rules/frontend/forms.md` is fine.
- Global (`~/.claude/rules/`) loads before project rules, so **project rules override global** on conflict.
- Never use `CLAUDE.md` or `CLAUDE.local.md` as the home for a rule — not even the "private" case; gitignore a rule file instead.

## Step 2 — Does a rule for this already exist? (reuse before you add)

**Before writing anything new**, read what's already there. Adding a rule that overlaps an existing one creates duplicates and paradoxes that make Claude choose arbitrarily. Answer three questions in order:

1. **Does a rule already cover this?** → If yes, prefer to **enhance the existing rule**, not add a second one.
2. **Can that existing rule be changed to satisfy the new requirement?** → Edit in place; keep one authoritative statement per topic.
3. **Does the new requirement contradict or create a paradox with any existing rule?** → Resolve it *now*, before the rule ships.

### How to survey the existing rules

Enumerate every instruction source that could load in this scope, then read the ones touching the same domain (naming, testing, imports, architecture, security, …):

- `~/.claude/rules/**` (global rules)
- `./.claude/rules/**` including subdirectories (project rules)
- `~/.claude/CLAUDE.md`, project `CLAUDE.md` / `.claude/CLAUDE.md`, `CLAUDE.local.md`, and subtree `CLAUDE.md` files — **read these too**, because existing rules may have been placed there before this convention. If you're enhancing a rule that currently lives in a `CLAUDE.md`, **migrate it out** into a `.claude/rules/<topic>.md` file as part of the change.
- managed policy CLAUDE.md, if present

Tools: `/context` shows what actually loaded this session; `/memory` lists the files; the `InstructionsLoaded` hook logs load order (useful for path-scoped rules). Grep the rule files for the keywords of your new rule's domain.

### Definitions — name the case, then fix it

| Case | Definition | How to fix |
|---|---|---|
| **Duplicate** | An existing rule already states this requirement (fully). | Don't add a copy. Leave the existing rule; if wording is weaker, improve it in place. |
| **Overlap / near-duplicate** | An existing rule covers *part* of the domain or the same files with related guidance. | Merge into one authoritative rule, **or** split by scope so each `paths:` glob owns a distinct slice. |
| **Contradiction** | Two rules give incompatible guidance for the same situation (e.g. "use tabs" vs "use spaces"; "always add tests" vs "skip tests for scripts"). Claude picks one arbitrarily. | Choose the winner and delete/rewrite the loser, **or** separate by scope/`paths:` so the two never fire on the same file. Document which won and why. |
| **Paradox / circular** | Following one rule forces violating another, or a rule's condition can never be satisfied (e.g. "always X" + "never X when Y" where Y is always true; two rules that each defer to the other). | Collapse into a **single conditional rule with explicit precedence** ("Do X, except in `src/legacy/**` where Y takes priority"). Eliminate the circular reference. |

Rule of thumb: **one topic → one authoritative rule file.** If you can't state which rule wins for a given file, you have a conflict to resolve before shipping. Leave a brief `<!-- resolved: merged old testing rule; project wins over global -->` note (HTML comments cost zero context).

## Step 3 — Is a rule even the right tool? (placement decision)

Route the requirement to the layer that fits. A rule is for **judgment-based, context-dependent behavior an LLM must evaluate** — not for things a deterministic tool enforces better.

| The requirement is… | Route to |
|---|---|
| Behavior needed in **every** session, all files | Unscoped `.claude/rules/<topic>.md` (no `paths:`) |
| Behavior that only matters for **specific file types / directories** | Path-scoped `.claude/rules/<topic>.md` with `paths:` (Step 5) |
| A **multi-step procedure** or reference only sometimes relevant | A **skill** (loads on demand — strongest context savings) |
| Must run/block **deterministically** at a fixed moment (pre-commit, post-edit) | A **hook** (the only guaranteed enforcement) |
| A command/path **must be blocked**; env vars; model | `.claude/settings.json` (`permissions.deny`, `env`, …) |
| Formatting, lint, import order | ESLint/Prettier — not a rule |
| Branch naming, secret scanning, coverage gates | git hooks / CI |

> If a deterministic tool can enforce it reliably, **do not write a Claude rule.** Rules are context, not enforcement — the docs are explicit that instruction files are not a hard enforcement layer.

## Step 4 — Be token-aware: load-at-launch vs load-on-demand

This is the single most important distinction. Know which mechanisms cost context at launch:

| Mechanism | When it loads | Context cost |
|---|---|---|
| `.claude/rules/*.md` **with** `paths:` | **On demand**, only when Claude reads a matching file | Paid only when relevant ✅ |
| `.claude/rules/*.md` **without** `paths:` | **Launch**, same priority as `.claude/CLAUDE.md` | Always paid |
| Subtree `CLAUDE.md` (dirs *below* working dir) | **On demand**, when Claude reads a file in that dir | Reference only — not where rules go |
| Skills | On invocation/relevance | Strongest progressive disclosure ✅ |
| `CLAUDE.md` (working dir and ancestors) | **Launch**, in full, every session — **cannot be path-scoped** | This is *why* rules go in `.claude/rules/` instead |
| `@path` imports in a CLAUDE.md | **Launch**, expanded inline | Always paid — does **not** defer loading |

**Consequences for how you write rules:**
- Default to a `paths:`-scoped rule file so it loads only when Claude touches matching files. Leave a rule unscoped only when it genuinely applies to *every* session.
- Never reach for `@imports` to "save tokens" — imported content loads at launch just the same.
- `<!-- HTML comments -->` are stripped before injection — use them for maintainer notes that cost zero context.

## Step 5 — Always ask: what paths/globs does this rule apply to?

Before finalizing any rule, answer explicitly: *"What files in this project does this govern?"* Then pick the **minimal correct glob** in the rule file's `paths:` frontmatter so it loads only when Claude touches those files.

```markdown
---
paths:
  - "src/api/**/*.ts"
---

# API Development Rules
- All API endpoints must include input validation.
- Use the standard error response format.
```

Glob patterns (`paths:` supports multiple entries and brace expansion):

| Pattern | Matches |
|---|---|
| `**/*.ts` | All TypeScript files, any directory |
| `src/**/*` | Everything under `src/` |
| `*.md` | Markdown in the project root only |
| `src/components/*.tsx` | React components in one directory |
| `src/**/*.{ts,tsx}` | Multiple extensions via brace expansion |

- **Too broad** → the rule loads as noise on unrelated work. **Too narrow** → it misses files it should govern.
- A rule file with **no** `paths:` loads unconditionally at launch — only leave it unscoped if it genuinely applies to *every* session.
- Escape a literal `[` in a filename as `\[`; an unparseable bracket pattern matches nothing.
- State the chosen glob and *why it's the minimal correct match* when you present the rule.

## Step 6 — Write the rule so Claude can't skip or misread it

A rule is only as good as its wording. Rule files are context, not enforced config — vague or conflicting phrasing is the #1 reason instructions get ignored. Write every rule to these standards:

1. **Imperative and directive.** Start with a verb or `Always`/`Never`: "Run `npm test` before committing." Not "Testing is important."
2. **Specific and verifiable, never aspirational.** "Use 2-space indentation" — not "format code properly." If you can't check whether it was followed, rewrite it.
3. **One instruction per line.** Split multi-action sentences; "do X and also Y" lets Claude merge or drop half. One bullet = one action.
4. **Pair every prohibition with a direction.** "Never use `--legacy-peer-deps`; resolve the conflict by pinning the dependency in `package.json`." A bare "never" leaves Claude stuck with no path forward.
5. **State the *why* for judgment calls.** A one-line reason ("…because mocked tests hid a prod migration failure") lets Claude apply the rule correctly to edge cases instead of guessing.
6. **Give a concrete example when a term is ambiguous.** Show the expected shape ("error envelope: `{ error: { code, message } }`") rather than describing it abstractly.
7. **Group with markdown headers + bullets.** Claude scans structure like a reader; dense paragraphs bury the rule.
8. **Say nothing Claude already knows or can read from the code.** Standard language conventions, directory layouts, dependency lists — omit them; they dilute the rules that matter.

**Before → after** (contents of a `.claude/rules/<topic>.md` file, below its `paths:` frontmatter)

```markdown
<!-- ❌ Vague, aspirational, multi-intent, no direction -->
- Handle errors properly and make sure the code is tested and clean.

<!-- ✅ Directive, specific, one-per-line, with a reason -->
- Wrap every external API call in try/catch; return the standard `{ error: { code, message } }` envelope.
- Run `npm test` before committing — CI rejects untested handlers.
- Validate request bodies at the route boundary with the shared `zod` schema.
```

**Verify it lands:** after writing, open a fresh session, read a file the rule's `paths:` targets, and ask Claude to *"summarize the rules that apply to this file."* If the summary misses or garbles your rule, the wording — not Claude — is the problem. Tighten it.

## Step 7 — Keep each rule file focused and short

**Target under 200 lines per rule file that loads at launch.** Longer files consume more context and *reduce adherence*. One topic per file is the norm — split before a file sprawls.

- **Prune ruthlessly:** if rule B implies rule A, delete A. Remove dead rules.
- **When a file grows or a section only matters for some files:** split it into a new `.claude/rules/<topic>.md`; if that section is file-type/subtree-specific, add `paths:`; if it's a procedure, make it a skill instead.

## Finalize — self-check before you're done

- [ ] Scope decided (global vs project) — asked the user if it was unclear.
- [ ] Rule saved to `.claude/rules/<topic>.md` (or `~/.claude/rules/`) — **never** `CLAUDE.md`/`CLAUDE.local.md`; any rule found in a CLAUDE.md was migrated out.
- [ ] Checked existing rules — no duplicate/overlap; enhanced an existing rule instead of adding one where possible.
- [ ] No contradiction or paradox with any rule across all scopes; any conflict resolved and noted.
- [ ] Right layer — a rule, not something better served by a skill, hook, settings, or linter/CI.
- [ ] Path-scoped if file-type/subtree-specific; `paths:` is the minimal correct glob. Load behavior is intentional.
- [ ] Wording is imperative, specific, one-instruction-per-line, prohibitions paired with a direction (Step 6).
- [ ] Rule file stays under 200 lines; one topic per file.
- [ ] Fresh-session summary test passes — Claude restates the rule accurately.

## Common mistakes

| Mistake | Fix |
|---|---|
| Writing rules into `CLAUDE.md` | Put them in `.claude/rules/<topic>.md`; CLAUDE.md is for project overview/build/architecture, not rules |
| Adding a new rule without reading existing ones | Survey first; enhance the existing rule instead of creating a duplicate or contradiction |
| Two rules that disagree on the same files | Merge into one authoritative rule, or split by `paths:` so they never both fire |
| Vague/aspirational wording ("write clean code") | Make it specific and verifiable; one directive per line |
| A bare prohibition with no alternative | Pair every "never" with the "do this instead" path |
| Cramming many topics into one unscoped rule file | One topic per file; add `paths:` so file-type/subtree rules load on demand |
| Using `@imports` to "save context" | Imports load at launch — path-scope the rule or move it to a skill instead |
| Writing a procedure as a long rule | Make it a skill; skills load only when relevant |
| Writing a rule for something a linter/hook enforces | Use the deterministic tool; rules are context, not enforcement |
| Restating language conventions or directory layout | Delete — Claude already knows or can read it from the code |
