# Figma → Code Orchestrator

A Cowork/Claude Code plugin that converts Figma designs into code with high
fidelity to variants, component inputs, design tokens, spacing, font sizes, and
assets. A lead agent extracts the design truth over the **Figma Dev Mode MCP**,
runs a complete **componentization interview** to decide what becomes a reusable
component versus what stays embedded, dispatches specialized subagents to extract
tokens, export assets, and generate stack-agnostic code with rigid token binding,
then runs a **visual-validation loop** (Playwright MCP + uimatch) that measures the
rendered output against Figma and auto-fixes — without ever hardcoding behavioral CSS.

## How it works

```
figma-to-code-orchestrator  (lead — opus)
├─ Phase 1  Extract (parallel, read-only)
│   ├─ figma-variant-mapper     → variants, derived inputs, instances per layout
│   ├─ figma-token-extractor    → tokens (CSS vars + DTCG) + raw-value flags
│   └─ figma-asset-exporter     → SVG/PNG assets + manifest
├─ Phase 2  Componentization interview  → signed-off plan (component vs embedded,
│                                          inputs vs hardcoded, token sources, stack)
├─ Phase 3  Build (dispatch per plan)
│   ├─ component-builder        → one reusable component per dispatch
│   └─ layout-assembler         → one layout per dispatch (composes components)
├─ Phase 4  Enforce (static gate)
│   └─ figma-token-enforcer-qa  → fails build on raw values / prop drift
└─ Phase 5  Visual validation & auto-fix (bounded loop)
    ├─ visual-validator         → Playwright DOM deltas (primary) + uimatch pixel/ΔE
    │                             + Design Fidelity Score → discrepancy report
    ├─ component-builder / layout-assembler → apply token-only fixes
    └─ figma-token-enforcer-qa  → final gate
```

## Components

**Agents** (`agents/`)

| Agent | Model | Role |
|-------|-------|------|
| `figma-to-code-orchestrator` | opus | Lead: extract → interview → dispatch → enforce |
| `figma-variant-mapper` | sonnet | Variants, derived inputs, instance inventory |
| `figma-token-extractor` | sonnet | Tokens + raw-value flags |
| `figma-asset-exporter` | sonnet | SVG/PNG export + manifest |
| `component-builder` | sonnet | One stack-agnostic component per dispatch (+ token-only fixes) |
| `layout-assembler` | sonnet | Composes layouts from built components (+ token-only fixes) |
| `figma-token-enforcer-qa` | sonnet | Strict token/prop fidelity gate |
| `visual-validator` | sonnet | Playwright DOM deltas + uimatch pixel/ΔE + fidelity score |

**Skills** (`skills/`)

- `componentization-interview` — the required question framework (component vs
  embedded, input vs hardcoded, token source of truth, slots, naming, target stack),
  with a detailed decision framework in `references/`.
- `token-governance` — primitive/semantic/component layers, CSS-variable + W3C DTCG
  formats, and the rigid "every value is a token or a confirmed one-off" rule.
- `figma-dev-mode-extraction` — how to connect to the Dev Mode MCP and what each
  consumer extracts.
- `visual-validation` — the Phase 5 measurement-first loop, tolerance/stop
  conditions, and the strict **token-forcing policy** (force values only at the top
  of the cascade, with comments, after confirming the value belongs at that level).
  Tooling details for Playwright MCP + uimatch live in `references/`.

**MCP** (`.mcp.json`)

- `figma-dev-mode` — Figma Dev Mode MCP server at `http://127.0.0.1:3845/mcp`.
- `playwright` — Playwright MCP (`npx @playwright/mcp@latest`) for Phase 5 rendering
  and DOM measurement.

## Setup

1. Install the Figma **desktop app** and open the file you want to convert.
2. Enable the server: Figma → Preferences → **"Enable Dev Mode MCP Server."** It
   serves at `http://127.0.0.1:3845/mcp`. (If your Figma version uses the SSE
   endpoint `http://127.0.0.1:3845/sse`, update the URL in `.mcp.json`.)
3. Install this plugin. Select the target frame/component in Figma, then ask Claude
   to convert it.

The MCP tool names in the agent frontmatter (`get_code`, `get_variable_defs`,
`get_image`, `get_screenshot`, `get_metadata`, `get_code_connect_map`) follow the
current Dev Mode MCP server. If your version exposes different names, adjust the
`tools:` lists in `agents/*.md` accordingly — unknown names are simply ignored.

### Phase 5 (visual validation) setup

4. The **Playwright MCP** is preconfigured (`npx @playwright/mcp@latest`); the first
   run downloads it. Chromium must be installed for Playwright.
5. Phase 5 reuses **[uimatch](https://github.com/kosaki08/uimatch)** for the pixel/ΔE
   Design Fidelity Score. It runs via `npx` from the project; set a `FIGMA_TOKEN`
   env var if you let uimatch fetch the Figma reference over the REST API (otherwise
   the validator passes it an already-exported reference PNG). If uimatch is
   unavailable, the loop falls back to DOM-measurement only and says so — it never
   silently reports a pass.
6. Phase 5 needs the generated UI running: the orchestrator starts your dev/preview
   server and validates what is served. Validation is optional — skip it and Phases
   1–4 still run fully.

## Usage

Paste a Figma selection/link and ask for a conversion, e.g. *"Turn this frame into
code and be strict about our tokens."* The orchestrator triggers, extracts, and
walks you through the interview before generating anything. It is **stack-agnostic**:
it confirms your framework, language, and styling approach during the interview and
builds to that.

## Design principles

- **One source of truth per value.** Font sizes, spacing, colors, radii, and shadows
  reference a real Figma token or land on an explicit one-off allowlist. A raw value
  with no source is flagged and blocks its node — never silently hardcoded.
- **Variants → documented inputs.** Every variant property, text override, and icon
  swap is evaluated as a component input; the plan records the exact signature and
  the builder must match it, defaults included.
- **Instances → composition.** Layouts import real components and pass overrides as
  props; the QA gate fails inlined duplication.
- **The user decides boundaries.** The interview is mandatory — component vs
  embedded, input vs hardcoded, and token sources are the user's call, not the
  agent's guess.
- **Validation is measurement-first.** DOM deltas (`getComputedStyle` /
  `getBoundingClientRect`) are the primary signal; the pixel/ΔE score is a coarse
  second gate. Numbers drive fixes, not eyeballed screenshots.
- **Auto-fix never breaks the token rule.** A forced value is only ever a commented
  token assignment at the top of the cascade (`:root` / component root scope, or the
  theme layer for non-CSS stacks) — never a literal in a behavioral rule, never deep
  in the CSS. Before forcing, the agent confirms the value belongs at that element's
  level (not its parent/child) and asks when unsure. Responsive differences are
  top-level media-query token overrides; section-specific behavior is a more
  specific scoped token override.

## Prior art / attribution

The methodology is modeled on established open-source Figma-to-code tooling for
Claude and the broader design-token ecosystem:

- Token extraction into W3C DTCG / CTI with CSS/SCSS/Style Dictionary output
  (e.g., `gregorymm/design-tokens`).
- Strict variable/style binding with post-write QA to keep values on-spec
  (e.g., `senlindesign/claude2figma`).
- Universal, stack-agnostic code generation from variant tables and asset export at
  1x/2x/3x (e.g., `nafiurrahmanniloy/figma-skill`) and the curated
  `openai/skills` Figma design-implementation workflow.

This plugin re-expresses those patterns as an orchestrated multi-agent pipeline; it
does not vendor their code. Swap the primitive token values for your brand palette
and keep the semantic/component layers and enforcement intact.
