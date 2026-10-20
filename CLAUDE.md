# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **plugin marketplace**: a personal collection of skills, agents, and hooks packaged as installable plugins. There is no application code, build step, or test suite — everything here is JSON configuration and Markdown (skill/agent/command definitions).

## Structure

```
.claude-plugin/marketplace.json     # marketplace manifest — lists every plugin
plugins/<plugin-name>/
  .claude-plugin/plugin.json        # plugin manifest (name, description, version, author)
  skills/<skill-name>/SKILL.md      # skill definitions (frontmatter: name, description)
  agents/<agent-name>.md            # subagent definitions (optional, add as needed)
  commands/<command-name>.md        # slash commands (optional, add as needed)
  hooks/hooks.json                  # hook definitions (optional, add as needed)
test/<name>.ts | test/<name>.sh     # tests; `bash test/run.sh` runs the CI suites
scripts/validate-marketplace.mjs    # manifest validation (`npm run validate`)
.github/workflows/ci.yml            # CI: manifests, unit tests, Pi extension suites
```

- `.claude-plugin/marketplace.json` is the root manifest. Each entry in its `plugins` array has `name`, `source` (relative path to the plugin directory), and `description`, and must match a real plugin under `plugins/`.
- Each plugin is self-contained under `plugins/<plugin-name>/` with its own `.claude-plugin/plugin.json` manifest.
- Pi (not Claude Code) resources live outside `plugins/`: `extensions/*.ts` are Pi extensions and `skills/<skill-name>/SKILL.md` are Pi skills, both declared in the `pi` manifest of the root `package.json`. Skills there may reference Pi-only tools (e.g. `devin_delegate`), so do not move them under `plugins/`.
- Currently one plugin exists: `plugins/claude-basics`, intended to hold agents/skills useful across every project. It has a `skills/claude-rule-creator/` directory scaffolded but not yet populated with a `SKILL.md`.

## Adding to a plugin

- **New skill**: create `plugins/<plugin-name>/skills/<skill-name>/SKILL.md` with YAML frontmatter (`name`, `description`) followed by the skill instructions. The `description` is what Claude uses to decide when to invoke it — be specific about triggering conditions.
- **New agent**: create `plugins/<plugin-name>/agents/<agent-name>.md` with frontmatter describing the agent's purpose and tool access.
- **New plugin**: create `plugins/<new-name>/.claude-plugin/plugin.json`, then add a corresponding entry to the root `.claude-plugin/marketplace.json`.

## Validating changes

- `npm run qa` is the fast loop and the definition of done for any change to `extensions/`: `typecheck && lint && check && validate && test:unit`. It needs `npm install`.
- `npm run typecheck` (`tsc --noEmit`) covers `extensions/**`. `npm run lint` runs biome (`biome.jsonc`) over `extensions/`; `npm run format` applies it everywhere and `npm run format:check` only verifies.
- `npm run check` (`scripts/check-quality.mjs --check`) enforces the invariants a linter cannot express: exec location and timeouts, mutating calls whose result is never read, `globalThis` ownership, where `JSON.parse` may appear, per-file line budgets, `pi.extensions` matching the files on disk, unused libs, frontmatter, and that every test file is wired into a suite. Legacy debt is **ratcheted** by `scripts/quality-baseline.json`: counts may only shrink, `npm run qa:baseline` lowers them, and an increase requires `--write --reason "..."`, which appends a visible line to the baseline's `notes`.
- `npm run validate` (`node scripts/validate-marketplace.mjs`) checks the marketplace/plugin manifests parse, every `source` resolves, names match between `marketplace.json` and `plugin.json`, and no `plugins/*` directory is missing from the manifest.
- `npm test` (`bash test/run.sh`) runs every CI suite; `bash test/run.sh --list` lists suite names and `npm run test:unit` runs only the standalone `node --test` files. Node >= 23.6 is required (it runs TypeScript directly).
- CI (`.github/workflows/ci.yml`) runs on every pull request, on pushes to `main`, and manually: a manifests + unit-test job, plus a matrix job per Pi extension suite (`observe-pr`, `branch-observer`, `startup-notice`, `observe-pr-resume`, `pr-tasks`, `tools`). It installs Pi from npm and needs no model credentials — the suites mock `gh`/Pi APIs and run `--offline`.
- To smoke-test a plugin locally in Claude Code, add this repo as a marketplace (`/plugin marketplace add <path-to-this-repo>`) and install the plugin to confirm skills/agents load correctly.
