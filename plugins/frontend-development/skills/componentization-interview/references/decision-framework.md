# Componentization Decision Framework

Detailed heuristics, question templates, and worked examples for the interview.
Consult this for edge cases; the SKILL.md body holds the core flow.

## Component vs embedded — heuristics

Lean **component** when any hold:

- The node is already a real Figma component or component set.
- It appears as more than one instance across the scope.
- It carries variant properties (size/state/type/etc.).
- It has interactive states (hover, pressed, disabled) implying behavior.
- The team intends to reuse it elsewhere (ask if unclear).

Lean **embedded** when all hold:

- It appears exactly once in scope.
- It has no variants and no interactive states.
- It is structurally specific to its parent (e.g., a one-off arrangement of text).
- There is no stated reuse intent.

Ambiguous middle: a node that repeats visually but is NOT a Figma component (a
"candidate"). Surface it explicitly — the user decides whether to promote it to a
component now, leave it embedded, or defer. Never auto-promote.

## Input vs hardcoded — heuristics

A property becomes an **input (prop)** when:

- It is a Figma variant property → almost always a prop (boolean for 2-value,
  enum for multi-value).
- The same layer shows different text across instances → text prop.
- An instance swaps a nested icon/instance → icon/slot prop.
- A layer is shown in some variants and hidden in others → boolean prop.

It stays **hardcoded** when:

- The value is identical across every instance and no variant toggles it.
- It is structural chrome the design never varies.

When unsure, prefer exposing an input — a prop with a sensible default is cheaper
than discovering later the value needed to vary.

## Token source of truth — the rigid axis

For every raw value (from the Raw Values Report), resolve to exactly one of:

1. **Existing token** — user names the token; record the reference.
2. **New token** — user approves creating it; record name + layer
   (primitive/semantic/component) + value. Hand to the token extractor to add.
3. **One-off** — user explicitly confirms it is intentionally not tokenized; add to
   the one-off allowlist so the enforcement gate does not fail it.

If the user cannot choose, it is an **open blocker**: the node it affects does not
get generated with that value hardcoded. The orchestrator reports the blocker and
either waits for the source or ships the rest with that node stubbed/flagged.

Never let "close enough" pick a token automatically. A 15px value is not silently
mapped to a 16px `space.4` token — that mismatch is exactly what the interview
exists to catch. Offer the near token as an option, but the user confirms.

## Slots and boundaries

- A **slot** is where arbitrary child content is passed in (e.g., a Card that
  accepts any body). Expose a slot when the child content is open-ended.
- A **fixed child** is a specific nested component the parent always renders the
  same way — keep it internal, but still import the real child component; do not
  re-implement it.
- When a nested instance varies per parent-instance, expose it as a prop (pass the
  child's variant/overrides up as parent props) rather than freezing it.

## Question templates

Component boundary (per component set):

> "`{ComponentName}` in Figma has variants `{props}`. Build it as a standalone
> reusable component (recommended), or keep it embedded in `{parent}`?"

Inputs (batched per component):

> "For `{ComponentName}`, which of these should be inputs your code can set:
> `{variant props + observed overrides}`? I've pre-selected the ones Figma varies."

Token source (per raw value):

> "`{node}` uses a raw `{property}` of `{literal}` with no bound variable. Map it to
> `{nearestTokenA}` / `{nearestTokenB}`, create a new token, or confirm it's a
> one-off?"

Stack:

> "Target framework, language, and styling approach? (e.g., React + TypeScript with
> CSS variables; Vue with SCSS tokens; Tailwind mapped to your token layer.)"

## Worked example

Figma has a `Button` component set: props `type` (primary/secondary/ghost), `size`
(sm/md/lg), `state` (default/hover/disabled), `hasIcon` (true/false). Two frames use
9 instances with varied labels and two icon swaps. One instance uses a `padding` of
`14px` not bound to any variable.

Interview outcomes:

- `Button` → component (already a component set, reused). 
- Inputs: `type` (enum), `size` (enum), `state` (enum), `hasIcon` (boolean),
  `label` (text, from overrides), `icon` (icon slot, from swaps). `state=hover` maps
  to CSS `:hover` rather than a runtime prop — confirm with user.
- The `14px` padding → open blocker; user maps it to semantic `space.150` (a new
  token) rather than the existing `space.200` (16px). Token extractor adds it.
- Layout frames → assembled by composing `Button` with per-instance props.
