---
name: componentization-interview
description: >
  This skill should be used by the figma-to-code-orchestrator when it needs to run
  the "complete round of questions" that decides Figma-to-code component boundaries:
  what becomes a reusable component versus what stays embedded, which variant
  properties and overrides become component inputs (props) versus fixed content, and
  where every raw visual value gets its token source. Use it after the variant,
  token, and asset extraction is complete and before any code is generated.
metadata:
  version: "0.1.0"
---

# Componentization Interview

Drive the decisions that turn a Figma extraction into a buildable plan. Run this
after the variant-mapper, token-extractor, and asset-exporter have returned their
reports. Ask questions with AskUserQuestion, grouped and batched — never one at a
time. The output is a signed-off **Componentization Plan**.

Do not generate code during the interview. Do not answer a token-source question on
the user's behalf. When the user does not know an answer, keep the item flagged and
let it block the affected node rather than guessing.

## Inputs you interrogate

- **Variant & Instance Inventory** — component sets, variant properties/values,
  derived inputs, and the instances used inside each layout.
- **Token map + Raw Values Report** — bound tokens by layer, and the list of visual
  values that have no token.
- **Asset Manifest** — exported SVGs/images per node.
- **Candidates (not yet components)** — visually repeated nodes that are not real
  Figma components.

## The decision axes

Work through every candidate against these axes. `references/decision-framework.md`
has the full heuristics, question templates, and worked examples — consult it for
edge cases.

1. **Component vs embedded.** For each variant-bearing node, repeated node, or
   candidate: does it become a standalone reusable component, or stay embedded in
   its parent? Default toward a component when the node is a real Figma component,
   appears more than once, or carries variants; default toward embedded when it
   appears once and has no variants and no reuse intent. Confirm the default with
   the user; never assume silently.

2. **Input vs hardcoded.** For each variant property, text override, icon swap,
   instance override, and visibility toggle on a component: does it become a
   component input (prop), or is it fixed content baked into the component? Every
   variant property is a candidate input; every override observed on an instance is
   evidence that content varies and likely wants a prop.

3. **Token source of truth.** For each entry in the Raw Values Report: does it map
   to an existing token (which one, by name?), become a NEW token (what name/layer?),
   or is it a confirmed one-off (added to an explicit allowlist)? This axis is
   rigid — a raw font-size, spacing, or color with no resolved source stays flagged
   and blocks its node. Do not let the build hardcode it.

4. **Naming and slots.** Component name, each prop's name and type, and which
   children are composition slots (arbitrary content passed in) versus fixed
   structure.

5. **Boundaries between components.** When an instance is nested inside another
   component, decide whether the parent owns it as fixed structure or exposes it as
   a slot/prop. Avoid duplicating a child component's logic inside a parent.

6. **Target stack.** Confirm framework, language, styling approach (CSS variables,
   CSS-in-JS, Tailwind mapped to tokens, utility classes, etc.), and file/naming
   conventions. This pipeline is stack-agnostic; nothing about the plan hardcodes a
   framework until the user confirms one here.

## How to ask

- Batch by component: one AskUserQuestion round per component set covering its
  component-vs-embedded call and its inputs, rather than a separate round per prop.
- Offer the derived default as the recommended option (the value read from Figma's
  default variant, or the "make it a component" call when the node is already a
  Figma component), so the user usually confirms rather than composes.
- For token-source questions, present the specific raw value and the node it is on,
  and offer the nearest existing tokens as options plus "new token" and "one-off" —
  but require the user to pick; do not pre-answer.
- Keep each question tied to a concrete node the user can find in Figma by name.

## Output: the Componentization Plan

Produce and show for sign-off:

- **Components to build** — ordered; each with its final name, documented input
  signature (name, type, allowed values, default, source Figma property), variant
  matrix, resolved token references, and asset entries.
- **Layouts to assemble** — each with its instance list (component + variant
  selection + overrides → props).
- **Resolved token map** — every previously-raw value now mapped to an existing
  token, a new token (with layer and name), or the one-off allowlist.
- **Open blockers** — any token source the user could not resolve, listed with the
  node it blocks.
- **Target stack** — framework, language, styling approach, conventions.

Get explicit user sign-off on this plan before the orchestrator dispatches builders.
Carry the one-off allowlist and open blockers forward so the enforcement gate knows
what is intentionally raw versus what must escalate.
