---
name: agents-md-maintainer
description: Use when creating, modifying, or auditing architectural boundaries (workspace root, package roots, major domains/subsystems) — to create or maintain that boundary's AGENTS.md guide. Also when establishing operational conventions, layer rules, or targeted verification commands, or when retiring granular leaf AGENTS.md files into an enclosing boundary guide. Do not use for routine file additions or edits inside existing boundaries.
---

# AGENTS.md Maintainer

## Overview

`AGENTS.md` is an **architectural boundary guide and operational runbook** that lets an AI agent (or a new developer) immediately understand a boundary's scope, layer conventions, invariants, and targeted verification commands — without reading every file.

**Core principle:** `AGENTS.md` is an *operational boundary guide, not a file catalog*. It establishes domain responsibilities, layer architecture, conventions, and runnable verification commands. It belongs strictly at architectural boundaries (workspace root, package roots, major functional subsystems), NOT in granular leaf directories.

## Boundary Placement Rules

`AGENTS.md` files belong **only** at architectural boundaries:

- **Root monorepo / project root** (e.g., repository root).
- **Package / Subsystem roots** (e.g., `packages/backend/`, `apps/web/`, `shared/`, `tools/<pkg>/`).
- **Distinct operational or functional boundaries** (e.g., `docs/`, `help/`, `scripts/review-deploy/`).

### Prohibited Placements (Retire Granular Leaf Files)

- **Strictly prohibit leaf-level or granular subfolder `AGENTS.md` files** (e.g., `controllers/AGENTS.md`, `services/AGENTS.md`, `components/AGENTS.md`, `utils/AGENTS.md`, `hooks/AGENTS.md`).
- **Subdirectory responsibilities:** Subdirectories belong to their enclosing boundary guide. Describe their architectural roles in the boundary `AGENTS.md`, never in separate leaf files.
- **Retirement / Consolidation:** When encountering existing leaf-level `AGENTS.md` files during maintenance, consolidate their useful context into the parent boundary `AGENTS.md` and delete the leaf files.
- **Exempt directories:** Never create `AGENTS.md` in tooling/config dirs (`.claude`, `.cursor`, `.vscode`) or build/generated/vendored output (`node_modules`, `dist`, `build`, `coverage`, `.next`).
- **Domain data & fixtures:** For domain-specific datasets, seed data, or test fixtures, use dedicated `README.md` documentation rather than `AGENTS.md`.

## Sizing & Scope

- **Target length:** Concise, operational guides between **30 and 150 lines**.
- Focus on high-signal developer operations and architectural boundaries, avoiding exhaustive prose or API dumps.

## What to Include (No Per-File Inventories)

Do **not** enumerate files in bullet lists (`- **foo.ts** — does bar`). File catalogs go stale immediately, waste context window, and duplicate what filesystem tools already provide.

Instead, every boundary `AGENTS.md` should cover:

1. **Scope & Layer Responsibilities:**
   - Boundary purpose and scope.
   - Key architectural layers/subdirectories and their roles.
2. **Architectural Conventions & Invariants:**
   - Invariants, design patterns, and coding standards.
   - Boundary rules: purity rules, dependency directions (what can import what), lifecycle patterns.
3. **Targeted Operational Commands:**
   - Exact runnable commands for building, typechecking, linting, and testing this specific boundary (avoiding slow full-repo runs where scoped commands exist).
4. **Boundary Dependencies & Related Documentation:**
   - Inbound and outbound dependencies (internal packages or external services).
   - Links or references to authoritative specs, guides, or shared libraries.

## Template

Mirror this structure for an architectural boundary guide:

```md
# <boundary-name> / <path>

Brief (1–2 sentence) overview of the architectural boundary and its core responsibility.

## Architecture & Subdirectories

- `api/` — HTTP endpoints, request schemas, and route handlers.
- `domain/` — Core business logic, domain models, and invariants (pure, no I/O).
- `infra/` — Database repositories, external API clients, and telemetry adapters.

## Invariants & Conventions

- **Dependency direction:** `api` -> `domain` <- `infra`. Domain never imports from `api` or `infra`.
- **Validation:** All incoming payloads must be validated at the boundary via schemas before reaching domain logic.
- **Error handling:** Throw domain-specific exceptions; map to HTTP status codes exclusively in the `api/` layer.

## Operational Commands

- Build: `pnpm --filter @scope/package build`
- Typecheck: `pnpm --filter @scope/package typecheck`
- Lint: `pnpm --filter @scope/package lint`
- Test (unit): `pnpm --filter @scope/package test`
- Test (targeted): `pnpm vitest run path/to/test.spec.ts`

## Boundary Dependencies

- Consumes: `@scope/shared-types`, `@scope/database-client`
- Consumed by: `apps/web`, `apps/api-gateway`
- Documentation: Refer to `docs/architecture/domain-model.md` for entity relationship details.
```

## Do / Don't

**Do**
- Place `AGENTS.md` only at architectural boundaries (workspace root, package root, distinct subsystem).
- Summarize layer and subdirectory responsibilities rather than cataloging individual files.
- Provide concrete, runnable verification and operational commands specific to the boundary.
- Keep the guide concise and operational (30–150 lines).
- Consolidate and delete leaf-level `AGENTS.md` files into the parent boundary guide when encountered.
- Direct domain data and fixture documentation to a `README.md`.

**Don't**
- Don't create `AGENTS.md` in leaf directories (`controllers/`, `services/`, `components/`, etc.).
- Don't list individual files or maintain per-file bullet inventories.
- Don't invoke this skill for routine file additions/edits inside an existing architectural boundary.
- Don't dump full API reference docs, full code samples, or changelogs.
- Don't create `AGENTS.md` in exempt directories (`.claude`, `node_modules`, `dist`, `.vscode`).

## Common Mistakes

| Mistake | Fix |
|---|---|
| Created `AGENTS.md` in a leaf subdirectory (e.g., `controllers/AGENTS.md`) | Remove it; summarize controller responsibilities in the package-level boundary `AGENTS.md` |
| Listed every file with a one-line bullet | Replace with layer/subdirectory responsibilities and architectural invariants |
| Created `AGENTS.md` for seed data or test fixtures | Document data and fixtures in a local `README.md` instead |
| Exceeded 150 lines or dumped complete API specs | Trim to actionable operational commands, invariants, and architectural boundaries (30–150 lines) |
| Running full-repo test/build commands | Include targeted commands scoped specifically to this boundary |
| Left obsolete leaf `AGENTS.md` files in subdirectories | Consolidate useful rules into the boundary `AGENTS.md` and delete the leaf files |
