# Design review — the mockup critic (1 round)

Pre-code design QA of a `mockup.html` by an independent **Opus critic that LOOKS at the
rendered screenshots**, not just the source. This is the visual counterpart of
`plan-review` (which critiques the plan's architecture) and is distinct from
a fidelity audit of a *shipped* implementation against the mockup, post-build.
Run it **when the user asks to review/critique the mockup** — one round is enough.

**Why screenshots.** A source read of the mockup HTML is blind to what only exists in the
rendered bitmap: text that overflows its box, a metric that clips, uneven spacing, a
low-contrast label, a control that "поехал" (misaligned) in one theme. The critic must
see the pixels. We already have Playwright (`e2e/`), so rendering is one command.

## When to run

- The user asks: "review the mockup", "покритикуй дизайн", "прогони дизайн-ревью",
  "всё ли ок с макетом", "ничего не поехало?", "is this design good / anything broken?".
- Optionally as the last step before hand-off, if the mockup is non-trivial.

**Skip** for a throwaway 1-variant sketch the user is still actively iterating on live.

## Recipe (1 round)

### 1. Render the mockup to PNGs
Use the reusable shooter — it renders light + dark at full resolution:

```bash
# a rail / multi-card mockup (one PNG per card): pass the card selector
SELECTOR=".story" VIEWPORT=1080x1920 THEME=both DSF=1 \
  node e2e/browser/shot-mockup.mjs <mockup.html> /tmp/design-review/<feature>
# a single full-screen mockup: omit SELECTOR (captures the full page per theme)
THEME=both node e2e/browser/shot-mockup.mjs <mockup.html> /tmp/design-review/<feature>
```

For a **multi-variant** mockup, switch each variant into view and re-shoot (or shoot each
variant's container via `SELECTOR`) so every state the mockup depicts is captured. **Open
the PNGs yourself (vision) first** — a blank/broken render means the mockup itself failed
(font 404, `file://` asset block); fix that before dispatching the critic.

### 2. Dispatch ONE Opus critic
`Agent` tool, `subagent_type:"general-purpose"`, `model:"opus"`. Give it, in the prompt:
- **The rendered PNGs** (attach the file paths so it looks at them) + the **mockup source**.
- The **feature intent / spec** (what this screen must accomplish, its requirements).
- The **design-system contract**: the exact tokens exported by `@mcpproxy/design` +
  `brandColors.ts`, and the `polish-kit.md` non-negotiables (lime `#cafd00` fill both
  themes; olive `#516700` is text/icon accent only; Material Symbols, never emoji;
  Space Grotesk numbers / Inter body; 2-layer shadows; no trailing "→").
- The **design system** in `packages/design/src/` — the mockup must **reuse**
  canonical tokens and primitives (
  filter chips, footer buttons, close-X, Instagram share), not reinvent them.

Frame it like plan-review: *"You are a strict product-designer critic. Your only job is to
find what's visually wrong or weak. Be harsh but fair. Look at the screenshots."* It scores
each finding **Critical / Major / Minor** with a concrete fix. Rubric:

1. **Nothing broken ("не поехало")** — overflow/clipping, text spilling its box, an
   element misaligned or overlapping, a control off in one theme. Layout breakage = Critical.
2. **Visual hierarchy & emphasis** — is the primary metric/action unmistakably dominant?
   load-bearing bold/accent spans present?
3. **Spacing / rhythm / alignment** — consistent scale, no cramped or dead-space areas,
   optical alignment of numbers/labels.
4. **Contrast & legibility in BOTH themes** — text on its background, accent readability,
   the light-mode olive-vs-lime rule.
5. **Design-system fidelity** — exact tokens; Material-Symbols not emoji; correct fonts;
   premium finish (shadow/glow/ring/chip) present, not flattened. Finish-layer misses = Major.
   **Component reuse** — did the mockup reproduce the canonical components from
   `packages/design/src/`, or reinvent a token or primitive the system
   already has? A reinvented component that drifts from the catalogued canonical = Major.
6. **Adaptivity & edge cases** — long text (longest locale), empty / zero / missing-data
   states, N-item overflow, IG safe zones for story cards, small viewport. A state the
   design must handle but the mockup mishandles = Major/Critical.
   **Loading & empty frames are MANDATORY, not optional edge cases:** for every data-driven
   surface, verify the mockup actually depicts a `-loading` (wave-skeleton) frame AND an
   `-empty` frame in `__listStates()`, and that the skeleton mirrors the filled body's
   height (so loading→content has no layout shift). A data-driven surface that ships only
   the filled state = Major — it's the direct cause of the content-flash on first render.
7. **Requirement coverage** — does the mockup satisfy every visual requirement in the spec?

The critic returns a structured list (one line per finding: severity · location · what's
wrong · the fix). It does NOT edit — findings only.

### 3. Apply + re-render (same session, INLINE)
- **Cross-check each finding against the mockup source before acting** — a vision critic
  over-reads (miscounts rows, calls translucent tints "solid", invents dividers). Confirm
  against the HTML/CSS, then fix.
- Apply every **Critical + Major** to the mockup yourself (inline — no fixer subagent).
  Re-run the shooter, re-open the PNGs to confirm the fix landed and nothing new broke.
- **Minor** → list them for the user to accept/skip.
- Then **`open` the updated mockup in the browser** (per the visualizer's open-once-after-review rule) — this review IS the gate that unblocks the single `open`.

One round. Don't loop the critic — if the user still sees issues after the applied round,
that's a normal iterate-with-the-user step, not another automated round.

## Output
A short report: the PNG folder, the findings table (severity / location / resolution:
Fixed-inline / Listed-for-user), and the re-opened mockup. Advisory — never blocks.
