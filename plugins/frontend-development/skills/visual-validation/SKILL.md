---
name: visual-validation
description: >
  This skill should be used by the Figma-to-code agents during Phase 5 — visual
  validation and auto-fix. It defines the measurement-first hybrid comparison
  (Playwright DOM deltas as primary signal, uimatch pixel/ΔE score as a coarse
  second gate), the bounded auto-fix loop, and the strict token-forcing policy that
  governs how a visual delta may be closed: only by pinning a token value at the top
  of the cascade (:root or component root scope) with a comment, never by hardcoding
  a literal into a behavioral rule — and only after confirming the value belongs at
  that level in the Figma structure.
metadata:
  version: "0.1.0"
---

# Visual Validation & Auto-Fix

Phase 5 of the pipeline. Prove the generated code matches Figma, and close the gaps
without ever violating the token rule. The `visual-validator` agent measures; the
orchestrator routes findings to `component-builder` / `layout-assembler` for fixes;
this loop repeats under a hard bound.

## Comparison model — measurement-first hybrid

Numbers first, picture second. Pure screenshot diffing is fragile (antialiasing,
subpixel rendering, alignment noise) and both misses real defects and invents fake
ones. So:

1. **Primary — DOM measurement.** Render in Playwright at the Figma frame size, read
   `getComputedStyle()` and `getBoundingClientRect()` per element, and diff against
   the Figma spec (tokens + variant table). Produces exact per-property deltas.
   Also catches structural defects (duplicated/missing/hallucinated elements) that a
   picture hides.
2. **Secondary — pixel/ΔE gate.** Screenshot both sides, run **uimatch**
   (Pixelmatch + ΔE2000 → Design Fidelity Score) as a coarse gate for gross layout
   and color problems. Corroborate any pixel flag against the DOM deltas before
   treating it as real.

Trust the DOM numbers over the DFS when they disagree.

## Reusing uimatch (do not reinvent the diff engine)

Invoke uimatch via `npx` from the run directory; it wants the implementation URL/
selector and a Figma reference PNG, and emits a DFS with configurable pass/fail
profiles (`component/strict`, `component/dev`, `page-vs-component`) plus diff
artifacts. Use `component/strict` for design-system components and `component/dev`
during iteration. Save its artifacts under `validation/`. See
`references/tooling.md` for invocation and setup.

## Tolerances and stop conditions

The loop is bounded — never open-ended:

- **Per-property tolerance**: color ΔE ≤ 2 (imperceptible); dimensions/spacing/
  radius within the smaller of 1px or the plan tolerance; font-size exact; DFS ≥ the
  chosen profile's threshold.
- **Stop when**: all deltas within tolerance AND DFS passes, OR a max iteration count
  (default 4 fix rounds) is reached, OR the only remaining deltas are `needs-token-
  source` / `needs-user-decision` items that require the user.
- Log every round (deltas found, fixes applied, new DFS) so a returning user sees
  the convergence trail. If the loop stops on max-iterations with deltas open, report
  them plainly — never claim a pass that measurement does not support.

## The token-forcing policy (how a delta may be closed)

This is the rule that keeps auto-fix from destroying token fidelity. When a delta is
real and the fix requires changing a value, resolve it in this strict order.

### Step 0 — Confirm the delta belongs here (ask first)

Before forcing anything, verify in the Figma structure that the value truly lives on
this element. Ask: should this spacing/size be on THIS node, or on its parent or
child? Re-read `get_metadata` for the node's box model and auto-layout ownership. A
delta is often a symptom of the wrong element owning the space — fix the ownership,
not the number. Only proceed to force a value once you have confirmed this element is
the correct owner. When ambiguous, ask the user rather than guessing.

### Step 1 — Prefer a reference fix

If the element points at the wrong token, repoint it to the correct existing token.
No forcing needed. This resolves most deltas.

### Step 2 — Force at the top of the cascade only

If no existing token fits and the value must be pinned, "hardcoding" means assigning
a hard value **to a token at the top of the cascade**, never a literal on a
behavioral property deep in the CSS:

- **Plain CSS / CSS variables**: set the forced value in `:root { }`, or in the
  component's **root scope** (the component's top-level selector custom-property
  block). Behavioral rules keep referencing `var(--token)` — they are never touched.
- **Responsive**: override the token value inside a **media-query block at that same
  top-level scope** (forced per-breakpoint token values). Never fork the deep rules
  per breakpoint.
- **Section-specific behavior**: if one token must behave differently in different
  sections, create a **more specific scoped token assignment** (a section/component-
  scoped custom-property override at that scope's root), rather than editing the
  deep CSS.
- **Every forced assignment carries a comment** explaining why — the Figma node, the
  measured value, and why no shared token applied. Example:
  `--card-pad-block: 14px; /* forced: Figma "Card/pad-y"=14px; nearest token space-4=16px rejected in interview; one-off */`

### Step 3 — Other stacks (Tailwind / CSS-in-JS / styled-components)

Same spirit, different file: force the value **only at the token/theme definition
layer** (the theme config's root, or a component-scoped theme override), with the
same comment, and keep every usage site referencing the token key. Never inline a
literal at the usage site. If the plan's stack cannot express a top-level token
override cleanly, do not auto-force — report the delta for the user to resolve.

### Never

- Never write a raw literal onto a behavioral property in a rule.
- Never deep-edit CSS to chase a pixel.
- Never force a value to close a ≤1px/ΔE≤2 delta that is within tolerance.
- Never force without the Step 0 confirmation and the explanatory comment.

## Fix routing

Each discrepancy carries a suspected cause from the validator. Route by cause:

- `wrong-token-reference` → builder repoints the reference (Step 1).
- `value-on-wrong-element` → builder moves ownership to parent/child (Step 0
  outcome).
- `needs-token-forcing` → run Step 0 confirmation, then the builder applies the
  top-of-cascade forced token with a comment (Step 2/3), after user sign-off if the
  value was not already a confirmed one-off.
- `missing-token-source` / `needs-user-decision` → escalate to the user; do not
  auto-apply.
- `structure` (hallucinated/missing element) → builder corrects the markup.

After each round, re-run the validator on the touched targets only. Hand the final
result to `figma-token-enforcer-qa`, which permits hard values **only** at commented
top-of-cascade token assignments and fails them anywhere else.
