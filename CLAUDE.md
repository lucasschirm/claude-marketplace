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
```

- `.claude-plugin/marketplace.json` is the root manifest. Each entry in its `plugins` array has `name`, `source` (relative path to the plugin directory), and `description`, and must match a real plugin under `plugins/`.
- Each plugin is self-contained under `plugins/<plugin-name>/` with its own `.claude-plugin/plugin.json` manifest.
- Currently one plugin exists: `plugins/claude-basics`, intended to hold agents/skills useful across every project. It has a `skills/claude-rule-creator/` directory scaffolded but not yet populated with a `SKILL.md`.

## Adding to a plugin

- **New skill**: create `plugins/<plugin-name>/skills/<skill-name>/SKILL.md` with YAML frontmatter (`name`, `description`) followed by the skill instructions. The `description` is what Claude uses to decide when to invoke it — be specific about triggering conditions.
- **New agent**: create `plugins/<plugin-name>/agents/<agent-name>.md` with frontmatter describing the agent's purpose and tool access.
- **New plugin**: create `plugins/<new-name>/.claude-plugin/plugin.json`, then add a corresponding entry to the root `.claude-plugin/marketplace.json`.

## Validating changes

There's no build/lint/test tooling — validate manually:
- Check JSON manifests parse: `jq . .claude-plugin/marketplace.json` and `jq . plugins/*/.claude-plugin/plugin.json`
- Confirm every `source` path in `marketplace.json` resolves to a directory containing a `.claude-plugin/plugin.json`.
- To smoke-test a plugin locally in Claude Code, add this repo as a marketplace (`/plugin marketplace add <path-to-this-repo>`) and install the plugin to confirm skills/agents load correctly.
