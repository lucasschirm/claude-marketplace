---
name: figma-dev-mode-extraction
description: >
  This skill should be used by the Figma-to-code agents to connect to the Figma Dev
  Mode MCP server and extract structured design data: component sets and variants,
  derived component inputs, component instances used inside layouts, bound variables
  and styles (tokens), and image/SVG assets. Use it whenever the pipeline needs to
  read fidelity-critical detail (font size, spacing, variant properties, instance
  overrides) out of a Figma selection.
metadata:
  version: "0.1.0"
---

# Figma Dev Mode Extraction

How this pipeline reads truth out of Figma. Extraction is always read-only — never
mutate the file.

## Connection

The Figma **Dev Mode MCP server** runs locally from the Figma desktop app. Enable
it under Figma → Preferences → "Enable Dev Mode MCP Server". This plugin points at
`http://127.0.0.1:3845/mcp`. Before extracting, verify one MCP tool call succeeds.
If it fails, stop and instruct the user to open the desktop app, enable the server,
and select the target frame — do not substitute a screenshot-only guess for real
structural data.

Work from the user's current Figma selection or a node link. Node links carry a
file key and `node-id`; pass the node id to the MCP tools that accept one.

## Tools (names may vary by Figma version)

The Dev Mode MCP server typically exposes:

- **get_metadata** — structure/hierarchy of the selection: node ids, names, types,
  nesting. Start here to map the tree.
- **get_variable_defs** — the variables and styles bound to the selection, with
  resolved values per mode/theme. This is the token source.
- **get_code** — a code representation of the selection (framework varies). Treat it
  as a representation of layout/behavior, NOT as final output — re-express it in the
  target stack with tokenized values.
- **get_code_connect_map** — any Code Connect mappings linking Figma components to
  existing code components. When present, honor these mappings rather than inventing
  new components.
- **get_image / get_screenshot** — a rendered image of the selection for visual
  reference and asset export.

If a tool name differs in the installed version, discover the available tools and
map them to these roles. Do not assume a tool exists without checking.

## What each consumer extracts

**Variant mapper** — from `get_metadata` + `get_code`: component sets, variant
properties and their value sets, the defined variant matrix (and gaps), and every
instance inside each layout with its master, variant selection, and overrides.
Distinguish real components/instances from plain frames that merely look repeated.
Cross-check bound properties with `get_variable_defs` to note which values already
have a token source.

**Token extractor** — from `get_variable_defs`: every bound variable across all
modes, plus text/effect/grid styles. Classify into primitive/semantic/component
layers (see the `token-governance` skill). Anything visual in scope with NO binding
becomes a Raw Values Report entry.

**Asset exporter** — from `get_metadata` + `get_image`: vector/icon nodes exported
as SVG, raster nodes exported as PNG at 1x/2x/3x. Honor per-node Figma export
settings when set. Return a manifest keyed by node id.

## Fidelity notes

- Read exact values: font size, line-height, letter-spacing, padding, gap, radius,
  and effects — do not round or infer. If the MCP returns a value, use it verbatim;
  if it does not, flag it rather than estimating from the rendered image.
- Prefer variable bindings over literals: when a property is bound to a variable,
  record the variable name, not just the resolved number.
- Honor Code Connect: an existing mapped component is reused, not regenerated.
- Keep every extracted value traceable to a node id, so later decisions and QA can
  point back to the exact Figma source.

## Related tooling and prior art

This extraction + governance approach follows the pattern established by community
Figma-to-code tooling for Claude — token extraction into DTCG/CTI with CSS/SCSS
output, strict variable binding with post-write QA, and universal (stack-agnostic)
code generation from variant tables. See the plugin README for the specific
open-source projects this pipeline is modeled on.
