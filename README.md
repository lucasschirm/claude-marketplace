# claude-marketplace

My collection of Claude Code plugins — skills, agents, and hooks I reuse across projects.

## Add this marketplace to Claude Code

In a Claude Code session, add the marketplace by its GitHub repo:

```
/plugin marketplace add lucasschirm/claude-marketplace
```

Then browse and install plugins interactively:

```
/plugin
```

Pick **LSC Marketplace → claude-basics → Install**. This is the simplest path and doesn't require typing the marketplace identifier.

To update later, refresh the marketplace and Claude picks up new versions the next time you install or restart:

```
/plugin marketplace update lucasschirm/claude-marketplace
```

## Plugins

| Plugin | Description |
|---|---|
| `claude-basics` | A collection of agents and skills for every project. Includes the `claude-rule-creator` skill for authoring and maintaining CLAUDE.md / `.claude/rules/` rules. |
