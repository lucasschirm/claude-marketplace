---
name: claude-rule-creator
description: Use when the user asks to create, add, change, update, refactor, split, audit, or optimize a Claude behavioral rule or memory instruction — CLAUDE.md, .claude/rules/, CLAUDE.local.md, AGENTS.md, or "make Claude always/never do X". Also when a CLAUDE.md is too large, rules conflict, or instructions aren't being followed.
---

# Claude Rule Creator

## Overview

You maintain the instruction system that shapes Claude's behavior in a workspace: `CLAUDE.md` files and `.claude/rules/`. Every rule is **context that loads into a token budget**, and a rule Claude misreads is worse than no rule. So each rule must be three things at once: **loaded only when needed** (token-aware), **non-conflicting** with what already exists, and **written so precisely that Claude cannot skip or misinterpret it**.

**Core principle:** A rule you write today costs tokens in *every* session where it loads, and shapes behavior only if it's unambiguous. Before writing, always ask: *which paths/globs does this apply to, does a rule for this already exist, and is the wording concrete enough to verify?*

Ground truth for every mechanism below is the official docs: https://code.claude.com/docs/en/memory.md — never invent a mechanism; verify against the docs when unsure.

## Step 1 — Determine scope: global or project? (ask if unclear)

A rule lives in exactly one of two homes. If the user hasn't made it obvious, **ask before writing**:

> "Should this be a **global** rule (applies to every project you work on) or a **project** rule (only this codebase)?"

| Scope | Where it lives | Use for |
|---|---|---|
| **Global** | `~/.claude/CLAUDE.md`, or `~/.claude/rules/<topic>.md` | Personal preferences that hold across every project |
| **Project** | `./CLAUDE.md` or `./.claude/CLAUDE.md`, or `./.claude/rules/<topic>.md` | Team standards for this codebase (checked into git) |
| **Local (project, private)** | `./CLAUDE.local.md` (gitignore it) | Personal per-project notes, not shared with the team |

Never put project-specific rules in global config; never bury a universal preference in one project. Project rules override user/global rules on conflict.

## Step 2 — Does a rule for this already exist? (reuse before you add)

**Before writing anything new**, read what's already there. Adding a rule that overlaps an existing one creates duplicates and paradoxes that make Claude choose arbitrarily. Answer three questions in order:

1. **Does a rule already cover this?** → If yes, prefer to **enhance the existing rule**, not add a second one.
2. **Can that existing rule be changed to satisfy the new requirement?** → Edit in place; keep one authoritative statement per topic.
3. **Does the new requirement contradict or create a paradox with any existing rule?** → Resolve it *now*, before the rule ships.

### How to survey the existing rules

Enumerate every instruction source that could load in this scope, then read the ones touching the same domain (naming, testing, imports, architecture, security, …):

- `~/.claude/CLAUDE.md` and `~/.claude/rules/**` (global)
- project `CLAUDE.md` / `.claude/CLAUDE.md`, `CLAUDE.local.md`, and all `.claude/rules/**` (including subdirectories)
- subtree `CLAUDE.md` files in directories the new rule's globs would touch
- managed policy CLAUDE.md, if present

Tools: `/context` shows what actually loaded this session; `/memory` lists the files; the `InstructionsLoaded` hook logs load order (useful for path-scoped rules). Grep the rule files for the keywords of your new rule's domain.

### Definitions — name the case, then fix it

| Case | Definition | How to fix |
|---|---|---|
| **Duplicate** | An existing rule already states this requirement (fully). | Don't add a copy. Leave the existing rule; if wording is weaker, improve it in place. |
| **Overlap / near-duplicate** | An existing rule covers *part* of the domain or the same files with related guidance. | Merge into one authoritative rule, **or** split by scope so each `paths:` glob owns a distinct slice. |
| **Contradiction** | Two rules give incompatible guidance for the same situation (e.g. "use tabs" vs "use spaces"; "always add tests" vs "skip tests for scripts"). Claude picks one arbitrarily. | Choose the winner and delete/rewrite the loser, **or** separate by scope/`paths:` so the two never fire on the same file. Document which won and why. |
| **Paradox / circular** | Following one rule forces violating another, or a rule's condition can never be satisfied (e.g. "always X" + "never X when Y" where Y is always true; two rules that each defer to the other). | Collapse into a **single conditional rule with explicit precedence** ("Do X, except in `src/legacy/**` where Y takes priority"). Eliminate the circular reference. |

Rule of thumb: **one topic → one authoritative rule.** If you can't state which rule wins for a given file, you have a conflict to resolve before shipping. Leave a brief `<!-- resolved: merged old testing rule, project wins over global -->` note (HTML comments cost zero context).

## Step 3 — Is a rule even the right tool? (placement decision)

Route the requirement to the layer that fits. A rule is for **judgment-based, context-dependent behavior an LLM must evaluate** — not for things a deterministic tool enforces better.

| The requirement is… | Route to |
|---|---|
| Behavior needed in **every** session, all files | `CLAUDE.md` (or unscoped `.claude/rules/<topic>.md`) |
| Behavior that only matters for **specific file types / directories** | Path-scoped `.claude/rules/<topic>.md` with `paths:` (Step 5) |
| A **multi-step procedure** or reference only sometimes relevant | A **skill** (loads on demand — strongest context savings) |
| Must run/block **deterministically** at a fixed moment (pre-commit, post-edit) | A **hook** (the only guaranteed enforcement) |
| A command/path **must be blocked**; env vars; model | `.claude/settings.json` (`permissions.deny`, `env`, …) |
| Formatting, lint, import order | ESLint/Prettier — not a rule |
| Branch naming, secret scanning, coverage gates | git hooks / CI |

> If a deterministic tool can enforce it reliably, **do not write a Claude rule.** Rules are context, not enforcement — the docs are explicit that CLAUDE.md is not a hard enforcement layer.

## Step 4 — Be token-aware: load-at-launch vs load-on-demand

This is the single most important distinction. Know which mechanisms cost context at launch:

| Mechanism | When it loads | Context cost |
|---|---|---|
| `CLAUDE.md` (working dir and ancestors) | **Launch**, every session | Always paid |
| `.claude/rules/*.md` **without** `paths:` | **Launch**, same priority as `.claude/CLAUDE.md` | Always paid |
| `.claude/rules/*.md` **with** `paths:` | **On demand**, only when Claude reads a matching file | Paid only when relevant ✅ |
| Subtree `CLAUDE.md` (dirs *below* working dir) | **On demand**, when Claude reads a file in that dir | Paid only when relevant ✅ |
| `@path` imports in CLAUDE.md | **Launch**, expanded inline | Always paid — **does NOT defer loading** |
| Skills | On invocation/relevance | Strongest progressive disclosure ✅ |

**Consequences for how you write rules:**
- To reduce context, **path-scope the rule or move it to a skill** — never reach for `@imports` thinking they save tokens. They are for *organization* only; imported content loads at launch just the same.
- `<!-- HTML comments -->` in CLAUDE.md are stripped before injection — use them for maintainer notes that cost zero context.
- Project-root CLAUDE.md survives `/compact`; nested subtree files reload when their dir is next touched.

## Step 5 — Always ask: what paths/globs does this rule apply to?

Before finalizing any rule, answer explicitly: *"What files in this project does this govern?"* Then pick the **minimal correct glob** so the rule loads only when Claude touches those files.

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
- A rule with **no** `paths:` loads unconditionally at launch — only leave it unscoped if it genuinely applies to *every* session.
- Escape a literal `[` in a filename as `\[`; an unparseable bracket pattern matches nothing.
- State the chosen glob and *why it's the minimal correct match* when you present the rule.

## Step 6 — Write the rule so Claude can't skip or misread it

A rule is only as good as its wording. CLAUDE.md is context, not enforced config — vague or conflicting phrasing is the #1 reason instructions get ignored. Write every rule to these standards:

1. **Imperative and directive.** Start with a verb or `Always`/`Never`: "Run `npm test` before committing." Not "Testing is important."
2. **Specific and verifiable, never aspirational.** "Use 2-space indentation" — not "format code properly." If you can't check whether it was followed, rewrite it.
3. **One instruction per line.** Split multi-action sentences; "do X and also Y" lets Claude merge or drop half. One bullet = one action.
4. **Pair every prohibition with a direction.** "Never use `--legacy-peer-deps`; resolve the conflict by pinning the dependency in `package.json`." A bare "never" leaves Claude stuck with no path forward.
5. **State the *why* for judgment calls.** A one-line reason ("…because mocked tests hid a prod migration failure") lets Claude apply the rule correctly to edge cases instead of guessing.
6. **Give a concrete example when a term is ambiguous.** Show the expected shape ("error envelope: `{ error: { code, message } }`") rather than describing it abstractly.
7. **Group with markdown headers + bullets.** Claude scans structure like a reader; dense paragraphs bury the rule.
8. **Say nothing Claude already knows or can read from the code.** Standard language conventions, directory layouts, dependency lists — omit them; they dilute the rules that matter.

**Before → after**

```markdown
<!-- ❌ Vague, aspirational, multi-intent, no direction -->
- Handle errors properly and make sure the code is tested and clean.

<!-- ✅ Directive, specific, one-per-line, with a reason -->
- Wrap every external API call in try/catch; return the standard `{ error: { code, message } }` envelope.
- Run `npm test` before committing — CI rejects untested handlers.
- Validate request bodies at the route boundary with the shared `zod` schema.
```

**Verify it lands:** after writing, open a fresh session and ask Claude to *"summarize the rules in CLAUDE.md."* If the summary misses or garbles your rule, the wording — not Claude — is the problem. Tighten it.

## Step 7 — Keep it compact: the 200-line ceiling

**Target under 200 lines per CLAUDE.md file.** Longer files consume more context and *reduce adherence*. When a file approaches the limit, split before you cross it.

- **Prune ruthlessly:** if rule B implies rule A, delete A. Remove dead rules.
- **When a file nears 200 lines or a section only matters for some files:** move that section into `.claude/rules/<topic>.md`; if it's file-type/subtree-specific, add `paths:`; if it's a procedure, make it a skill instead.

## Finalize — self-check before you're done

- [ ] Scope decided (global vs project) — asked the user if it was unclear.
- [ ] Checked existing rules — no duplicate/overlap; enhanced an existing rule instead of adding one where possible.
- [ ] No contradiction or paradox with any rule across all scopes; any conflict resolved and noted.
- [ ] Right layer — a rule, not something better served by a skill, hook, settings, or linter/CI.
- [ ] Path-scoped if file-type/subtree-specific; `paths:` is the minimal correct glob. Load behavior is intentional.
- [ ] Wording is imperative, specific, one-instruction-per-line, prohibitions paired with a direction (Step 6).
- [ ] Host CLAUDE.md stays under 200 lines.
- [ ] Fresh-session summary test passes — Claude restates the rule accurately.

## Common mistakes

| Mistake | Fix |
|---|---|
| Adding a new rule without reading existing ones | Survey first; enhance the existing rule instead of creating a duplicate or contradiction |
| Two rules that disagree on the same files | Merge into one authoritative rule, or split by `paths:` so they never both fire |
| Vague/aspirational wording ("write clean code") | Make it specific and verifiable; one directive per line |
| A bare prohibition with no alternative | Pair every "never" with the "do this instead" path |
| Dumping everything into one unscoped CLAUDE.md | Path-scope file-type/subtree rules into `.claude/rules/` so they load on demand |
| Using `@imports` to "save context" | Imports load at launch — path-scope or move to a skill instead |
| Writing a procedure as a long rule | Make it a skill; skills load only when relevant |
| Writing a rule for something a linter/hook enforces | Use the deterministic tool; rules are context, not enforcement |
| Restating language conventions or directory layout | Delete — Claude already knows or can read it from the code |
