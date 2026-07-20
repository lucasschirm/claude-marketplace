# Visual Validation Tooling

Setup and invocation details for the Playwright MCP and the reused uimatch diff
tool. The SKILL.md body holds the loop and policy; this file holds the mechanics.

## Playwright MCP

Configured in the plugin's `.mcp.json` as the `playwright` server
(`npx @playwright/mcp@latest`). Tools used by `visual-validator`:

- `browser_navigate` — open the implementation route/URL.
- `browser_resize` — set the viewport to the Figma frame's width/height (and to each
  responsive breakpoint the plan lists).
- `browser_evaluate` — read the live DOM. Pass **plain JavaScript strings only**.
  Passing a TSX/TypeScript function injects `__name` helpers that crash in the page
  context — a known failure mode. Example measurement snippet (as a string):

  ```js
  () => {
    const el = document.querySelector('[data-testid="card"]');
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      w: r.width, h: r.height, x: r.x, y: r.y,
      fontSize: cs.fontSize, lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing, fontWeight: cs.fontWeight,
      color: cs.color, background: cs.backgroundColor,
      paddingTop: cs.paddingTop, paddingLeft: cs.paddingLeft,
      gap: cs.gap, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow
    };
  }
  ```

- `browser_take_screenshot` — capture the target element/region for the pixel gate.
- `browser_snapshot` — accessibility-tree snapshot; useful for locating elements and
  catching structural defects without vision.

Prefer stable selectors. If the generated components lack test ids, the builder can
add non-visual hooks (e.g. `data-testid`) so measurement targets are stable; these
are structural, not visual, and do not affect the token rule.

## uimatch (reused pixel/ΔE + DFS)

Repository: https://github.com/kosaki08/uimatch — a Playwright-based visual
regression and design-QA tool. It fetches the Figma frame PNG (API/MCP), screenshots
the implementation, runs Pixelmatch + ΔE2000, and computes a Design Fidelity Score
(0–100) against pass/fail profiles.

- Run via `npx` from the run directory; do not vendor its source.
- Provide it the implementation URL/selector and a Figma reference PNG (the
  validator already pulls the reference via `get_screenshot`/`get_image`).
- Profiles: `component/strict` (final gate for design-system components),
  `component/dev` (iteration), `page-vs-component` (page context).
- A `FIGMA_TOKEN` env var is needed if uimatch fetches the reference itself via the
  Figma REST API; otherwise pass the already-exported reference PNG.
- Save its diff artifacts and score JSON under the run's `validation/` directory and
  cite the paths in the report.

If uimatch is unavailable in the environment, fall back to the DOM-measurement pass
alone and clearly note that the pixel/ΔE gate did not run — never silently skip it
and report a pass.

## Dev server

The orchestrator is responsible for starting the target's dev/preview server and
handing the validator the URL and route(s). The validator does not choose or install
the stack — it validates what is running. If nothing is serving, it reports a blocker.

## Artifacts

Everything the validation produces (implementation screenshots, Figma references,
diff images, per-node delta JSON, DFS scores, and the round-by-round log) is written
to `validation/` so the run is auditable and a returning user can inspect exactly
what changed and why a token was forced.
