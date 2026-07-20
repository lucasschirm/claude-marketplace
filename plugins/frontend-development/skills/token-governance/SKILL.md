---
name: token-governance
description: >
  This skill should be used by the Figma-to-code agents whenever design-token
  fidelity matters — extracting tokens, generating component or layout code, or
  auditing generated code. It defines the primitive/semantic/component token layers,
  the CSS-variable and W3C DTCG output formats, and the rigid rule that every
  visual value (font size, spacing, color, radius, shadow) must reference a token or
  be an explicitly confirmed one-off, never a silent hardcoded literal.
metadata:
  version: "0.1.0"
---

# Token Governance

The single source of truth for how design values are represented and enforced
across this pipeline. Every agent that reads, writes, or audits visual values
follows this.

## The one rule

Every visual value in generated code references a design token, OR is on the
explicit one-off allowlist the interview produced. There is no third option. A raw
hex color, a raw px/rem font size, or a raw spacing value that is not on the
allowlist is a defect, not a style choice.

Values this governs: color (fill, text, border, background), typography (font
family, size, weight, line-height, letter-spacing), spacing (padding, margin, gap),
border radius, border width, and shadow/effects.

## Three-layer token model

1. **Primitive** — raw, context-free values. `color.blue.500`, `space.4` (=16px),
   `font.size.14`, `radius.2`. These hold literals.
2. **Semantic** — role-based aliases that point at primitives, never at literals.
   `color.bg.surface` → `color.blue.500`; `color.text.default`; `space.inline.sm`.
   Code should prefer semantic tokens.
3. **Component** — per-component overrides that point at semantic (or primitive)
   tokens. `button.primary.bg` → `color.bg.brand`.

Preserve alias chains. A semantic token stores a reference (`{color.blue.500}`), not
the inlined literal, so a theme change at the primitive layer propagates.

## Output formats

### CSS custom properties (`tokens.css`)

```css
:root {
  --color-blue-500: #2563eb;          /* primitive */
  --color-bg-brand: var(--color-blue-500);  /* semantic → primitive */
  --button-primary-bg: var(--color-bg-brand); /* component → semantic */
  --space-4: 16px;
  --font-size-14: 0.875rem;
}
[data-theme="dark"] {
  --color-blue-500: #3b82f6;
}
```

Code consumes tokens as `var(--…)`. Multi-mode themes are expressed as selector
blocks (`[data-theme="dark"]`, `.theme-hc`, etc.), one per Figma mode.

### W3C DTCG (`tokens.json`)

```json
{
  "color": {
    "blue": { "500": { "$type": "color", "$value": "#2563eb" } },
    "bg": { "brand": { "$type": "color", "$value": "{color.blue.500}" } }
  },
  "space": { "4": { "$type": "dimension", "$value": "16px" } }
}
```

Use `$value`/`$type`; express aliases as `{group.token}` references. This is the
interchange format for Style Dictionary v4+ and design-token tooling.

## Extraction rules

- Read tokens from Figma variables and styles via `get_variable_defs`. Capture every
  mode/theme value per token.
- Keep font-size, line-height, and letter-spacing as separate tokens; never collapse
  a type ramp into one value.
- Preserve units and precision exactly as Figma reports them.
- Any visual value in scope with no bound variable/style goes to the **Raw Values
  Report** for the interview — it is never assigned a token automatically, and never
  hardcoded into code.

## Binding rules (code generation)

- Reference the resolved token the plan assigned. Prefer the semantic layer; use a
  component token when the plan defined one.
- Never inline a literal for a governed value. If the plan left a value without a
  token (an open blocker), do not hardcode it — surface it and let it block the node.
- Icon colors that should follow theme use `currentColor` or a color token, per the
  asset manifest flag — not a baked hex.
- Layout spacing (container gap/padding) is governed too; tokenize it like component
  spacing.

## Forced token overrides (the only permitted hard value)

Visual validation (Phase 5) sometimes needs to pin a value that has no shared token.
The one and only permitted form of a hard value is a **commented token assignment at
the top of the cascade** — never a literal on a behavioral property, never deep in a
rule. See the `visual-validation` skill for the full policy. In brief:

- Plain CSS / CSS variables: assign the forced value in `:root { }` or the
  component's root-scope custom-property block. Responsive: override the token inside
  a top-level media-query block. Section-specific: a more specific scoped token
  override. Behavioral rules keep referencing `var(--token)`.
- Tailwind / CSS-in-JS / styled-components: force only at the theme/token definition
  layer (root or component-scoped theme override); usage sites keep referencing the
  token key.
- Every forced assignment carries a comment naming the Figma node, the measured
  value, and why no shared token applied. A forced assignment without that comment is
  a violation.
- Only force after confirming the value belongs at that element's level (not its
  parent/child), and never to close a delta already within tolerance.

## Enforcement rules (QA gate)

A finding (build-failing) is any of:

- A governed literal (hex/rgb/hsl/named color, raw px/rem type size, raw spacing,
  raw radius/shadow) that is NOT on the one-off allowlist AND is NOT a commented
  top-of-cascade forced token assignment. A hard literal on a behavioral property or
  deep in a rule is always a finding.
- A token reference that does not resolve to a token in the map.
- A "near miss" substitution the code made on its own (e.g., mapping a 15px value to
  a 16px token without interview approval).

Default to flagging on ambiguity. A value whose source genuinely does not exist is
labeled `needs-token-source` and escalated to the user, not to a builder — builders
never invent tokens.

## Attribution

The layering model and formats here follow established open practice — W3C DTCG,
CTI/Style Dictionary conventions, and the "bind every value, no raw literals"
enforcement stance popularized by community Figma token tooling. Swap primitive
values for the project's own brand palette; keep the semantic/component layers and
the enforcement rule intact.
