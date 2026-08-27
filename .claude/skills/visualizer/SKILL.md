---
name: visualizer
description: The design family — deciding a UI direction and pressure-testing it before code. Default (this file) — build a self-contained interactive HTML mockup so the user can SEE and pick before code is planned. Also carries `design-review.md` (a strict critic pass over the mockup) and `polish-kit.md` (finish-layer recipes). Trigger (RU) — "помоги определиться с дизайном", "покажи варианты", "сделай визуализатор", "покритикуй дизайн", "проверь дизайн", "сверь с макетом", "дизайн чек", "напиши текст", "какой текст на кнопке", "поправь формулировку". Trigger (EN) — "show me options", "what should this look like", "make a visualizer", "review the mockup", "check design", "compare to mockup", "write the copy", "microcopy".
---

# Visualizer

## Route first

| The ask | Where |
|---|---|
| Decide a visual direction before code — variants, motion, layout, theme | **this file** |
| Same, but the "mockup" is a multi-screen Claude-Design JSX prototype, not one HTML file | `check-claude-code-tsx-design/` |
| Critique THIS mockup before it is handed off (1 round, screenshot-based) | `design-review.md` in this folder |

## Overview

A **visualizer** is a single self-contained interactive HTML mockup you build **during brainstorming** so the user can *see and pick* a visual direction before any code is planned. It is faithful to the **shipped** `@mcpproxy/design` design system (it's a redesign of real UI, not a greenfield aesthetic) and lets the user A/B the choice that words can't settle: animation feel, 2–4 design variants, light vs dark.

This is NOT the external Claude Design environment (`claude-design-prompt`).  Here YOU build a quick local decision-aid yourself, with `frontend-design` quality.

## When to use

- A UI feature/redesign where the decisive question is *visual* (motion, variant, emphasis, theme), not conceptual.
- Inside `superpowers:brainstorming` for a UI feature — build the visualizer instead of describing options in prose.

**Skip** for: pure backend/logic work, conceptual/scope decisions (use the terminal), or features with no visual state.

## Recipe

1. **Brainstorm first.** Run `superpowers:brainstorming` to fix intent/scope/constraints. The visualizer answers the *visual* sub-questions that surface — not the whole brainstorm.
2. **Read the real source, derive EXACT tokens.** Open the actual files the feature touches plus the `@mcpproxy/design` token source (`packages/design/src/tokens.ts`, `palette.ts`, `semantic.ts`) . Copy hex/font/spacing values **verbatim** — never approximate from memory or eyeball a screenshot.

   **Then read the design system — reuse, don't reinvent. THIS IS A GATE, not a nice-to-have: open `packages/design/src/`  and map EVERY token and primitive the mockup needs to a real export BEFORE you write a line of markup.**

   **Form fields and inputs are the #1 place this rule gets skipped — do NOT hand-roll them.** A text field, a number-with-unit field, a labeled input, a picker, a toggle, a field label — these are components, not raw `<input>`s you style by eye. Before drawing ANY field, map it: numeric/unit input → **`LabeledValueCard`** (card surface, uppercase 10/800/.1em label top-left, `UnitPill` top-right, big Space Grotesk value, lime focus-border, `caretColor` lime, placeholder `—`); text input → `LabeledValueCard` `valueVariant="text"`; the micro-label above a control group → **`FieldEyebrow`** (12/600/.05em uppercase `text.secondary`); unit chip → **`UnitPill`**; search → `SearchPillInput`; birthday wheel → `ValuePicker`; other dates → `InlineDateField`. A row-style `<input>` with an inline icon+unit is NOT our input canon — if you drew one, you skipped the catalog. Split of concerns: the tokens/CTA/polish rules below are **always-on**; the catalog is the **on-demand** "which component already exists" layer — consult it before drawing any composite control OR field, so you don't fetch a token and hallucinate the surrounding component.
3. **Build one self-contained `mockup.html`** with `frontend-design` quality, replicating the real component(s) so the comparison is honest. **Reach for `polish-kit.md`** (in this skill folder) — copy-paste recipes for the device frame, hero glow+rings+tile, icon-tile rows, the 2-layer shadow system, the exact type scale, and the safe entrance-animation rule. That kit is what separates production-grade from "generic AI".
4. **Open it in the user's browser yourself — ONCE, after the mockup is finalized and reviewed.** Do NOT open the moment each iteration renders, and do NOT re-`open` after every edit — the owner was drowning in tabs and couldn't tell when to look. Instead: finish the mockup, run the design-review pass (`design-review.md`) and apply its Critical+Major fixes, and ONLY THEN run `open <path>` (macOS) a **single** time, right before you write the summary. When the user later requests changes and you produce a genuinely new version, you may `open` again — **once per delivered version, never per intermediate edit**. Don't just hand them a path or rely on `SendUserFile`/inline screenshots as a substitute — the owner wants the real interactive page, but exactly one clear time per version. Then tell the user what to click and **iterate** on their feedback until they pick.
5. **Hand off.** Save it as the spec folder's `mockup.html` — the spec and plan reference it. 

## Author for 1:1 reproduction + machine audit (kills the redraw pain)

The single biggest source of "the impl doesn't match the mockup" (and the token blowout of re-eyeballing) is a mockup that (a) hides its states behind bespoke toggles a screenshot can't reach, (b) is drawn in a fantasy width the real screen never has, and (c) encodes layout as magic-px CSS that fights MUI. Author against all three so a deterministic audit can drive and diff the mockup cheaply.

- **Expose the state contract so the auditor can drive EVERY screen×state.** A dynamic multi-screen mockup MUST expose two globals (the auditor reads them via `drive-mockup.mjs`; without them a static screenshot shows one state out of dozens and every per-state deviation ships unseen):
  ```js
  window.__listStates = () => [
    { id: 'diary-default',      label: 'Diary · default',        viewport: 'mobile' },
    { id: 'diary-water-sheet',  label: 'Diary · water sheet open', viewport: 'mobile' },
    { id: 'onboarding-goal-cut', label: 'Onboarding · goal=cut',  viewport: 'mobile' },
    // …every screen × meaningful state combo × any OPEN dialog/sheet
  ];
  window.__setState = (id) => { /* flip the toolbar toggles + call the nav fn + open the sheet for `id`, then it's painted */ };
  window.__setTheme = (t) => ui.classList.toggle('light', t === 'light');
  ```
  Enumerate dialog/sheet-OPEN states too — real bugs (a double-✕, a native control) hide only in the open dialog. If the mockup is trivially single-screen, `__listStates` returns one entry; still expose it.
- **Every data-driven surface MUST declare its `-loading` (skeleton) AND `-empty` frame — not just the happy/filled state.** Any card/screen/list that renders fetched data exists in three states — loading, empty, filled — and the mockup that draws only the filled one is *the* root cause of the first-render content flash: the impl gets no skeleton to reproduce and no empty frame to distinguish from loading, so it paints zero-data-as-content for a frame. So for each such surface add BOTH `{ id: '<x>-loading', … }` (the wave-skeleton body, static chrome around it) and `{ id: '<x>-empty', … }` (the loaded-but-no-data copy) to `__listStates()`, alongside `<x>-default`/filled. This is not optional polish — because a fidelity audit asserts mockup-states ↔ impl-fixtures **equality** (a mockup state with no impl fixture is a COVERAGE FAIL), declaring these two frames is what *forces* the impl to build and audit the skeleton and empty state. Draw the skeleton to mirror the content body's exact height so the loading→content swap has zero layout shift.
- **Draw the DESKTOP mockup at the REAL shell width, not a stylized 720px browser-chrome panel.** The real screen renders inside `Container maxWidth="lg"` (~1200px at `theme.ts`'s `lg`) **minus the ~240px nav sidebar** — cap the desktop content region to that, or you design the two-column layout blind and it overlaps/clips on the real 1366px app (a shipped bug: a `minmax(280,320) 1fr` grid never validated against the real width). Mobile = 390px content. Provide a `?mode=raw` that strips the device-frame/toolbar and renders each screen as a bare content div at its target width, so `pixel-diff.mjs` can align mockup↔app 1:1.
- **Author layout with MUI-translatable semantics** — flexbox/grid + the 8px spacing scale, and put **`minWidth: 0`** on every flex/grid child that holds shrinkable content (long labels, code, a `1fr` column). Literal magic-px copied into `sx` is *the* cause of "поехало"; a mockup whose layout maps 1:1 onto `Stack`/`Grid`/`minWidth:0` reproduces without a re-derivation fight.
- **Freeze the mockup once approved.** A moving mockup re-triggers the whole audit loop. Pin it; re-baseline deliberately.

## Design review (on request)

When the user asks to review/critique the mockup, run a **1-round Opus design critic that
LOOKS at the rendered screenshots** (via Playwright — `e2e/browser/shot-mockup.mjs`), not
just the source: it catches overflow/clipping, misalignment ("поехало"), weak hierarchy,
contrast, edge cases, and design-system drift, scores each Critical/Major/Minor, and you
apply Critical+Major to the mockup inline, re-render, and re-open. This is the visual
counterpart of `plan-review` (distinct from a fidelity audit of the *shipped*
build post-implementation). **Full recipe: `design-review.md`** (in this skill folder). One
round is enough.

## Fidelity rules (non-negotiable)

- **The mockup IS the source of truth for copy — so its copy must be RIGHT THE FIRST TIME.** The mockup gets copied 1:1 into the impl and into the i18n files: whatever string you type here IS the string that ships. There is no later copy-editing pass that saves you — a fidelity audit diffs *pixels*, so it will faithfully confirm that slop was reproduced perfectly. Lorem at least announced itself as fake; AI-written filler reads like real copy, so nobody flags it and it goes to production. Therefore **every user-facing string in the mockup is written as if it ships**, because it does.
- **Reuse canonical components — never reinvent.** Before drawing any composite control, consult `packages/design/src/`; if it lists the component (dialog, back button, PRO badge/gate, labeled input, date field, filter chips, footer buttons, close-X, Instagram share…), reproduce that canonical component's real `.tsx` exactly. Inventing a fresh variant of something the catalog already has is the top fidelity failure — it's what makes a redesign drift from shipped UI.
- **Exact tokens, no approximation.** Lime fill is `#cafd00` in *both* themes; the text/icon accent is `#cafd00` (dark) / `#516700` (light) — never fill light-mode with olive. Warmup amber is `#FFD54F` (dark) / `#B45309` (light). Fonts: Space Grotesk (numbers/headings), Inter (body). Pull every value from `theme.ts`/`brandColors.ts`, not guesswork.
- **Filled CTAs / primary buttons are ALWAYS lime + black ink, in BOTH themes — NEVER olive fill.** The global `MuiButton.containedPrimary` override in `theme.ts` is `backgroundColor: #cafd00` (`BRAND_LIME`), `color: #000`, `&:hover { #beee00 }` — it is theme-INDEPENDENT, so the default contained button is lime-with-black in light AND dark. Do NOT fill a primary button with `theme.palette.primary.main` (that token is olive `#516700` in light mode → a dark-green button the app stopped using long ago). The olive `#516700` is a **text/icon accent only**, never a fill. When you build a CTA in a mockup, hardcode `background:#cafd00; color:#000` (hover `#beee00`) for both themes — match the real button, not the palette token.
- **Icons = Material Symbols font, NEVER emoji, never hand-drawn SVG paths.** Emoji-as-icon is the loudest "generic AI" tell and the user rejects it outright; hand-drawn paths come out mangled. Load the Material Symbols Outlined font and render glyphs by ligature name (`<span class="material-symbols-outlined">notifications_active</span>`) — they match `@mui/icons-material` (both are Google Material), so the mockup matches production. FILL 0 outline weight; `opsz` tracks size (24 bullets / 48 hero); colour is always a token. See `polish-kit.md` for the exact `<link>` + rule.
- **Theme toggle always.** The app ships light + dark — include a light/dark switch and verify the accent reads correctly in both.
- **2–4 variants + the current state as "before".** Offer a switcher (or side-by-side). Always include V0 = today's behaviour as the baseline; for a timing/animation fix add a before/after. More than ~4 variants is noise — curate.
- **Data-driven surfaces ship THREE frames: loading-skeleton, empty, filled — never just the happy path.** The single filled state is what breeds the content-flash: draw the wave-skeleton (mirroring the filled body's height, static chrome around it) and the empty-state copy as their own frames in `__listStates()` (see the state-contract rule above). A mockup missing the loading or empty frame is an incomplete spec, not a finished one.
- **Full document + `<meta charset="utf-8">`.** Standalone HTML with Cyrillic mojibakes without a full `<!DOCTYPE>` + charset meta.
- **Interactive, not static.** Clickable controls, replay buttons, real hover/animation — the user is deciding on *feel*, which a screenshot can't convey.
- **Faithful, not novel.** Match the existing design system precisely; bold/emphasis spans from the design are load-bearing — render them, don't flatten.
- **Precision components: author in the SAME primitive the impl will use, and copy literal px — never a scale trick the impl must reverse-engineer.** A ring/gauge/meter/numeric-display is a "precision component" — its fidelity is measured, not eyeballed. If the impl will render a ring as an **SVG stroked arc**, author the mockup ring as that same SVG (not a `conic-gradient` disc + inset hole): a `conic-gradient` and an SVG arc rasterize *differently by construction*, so the impl can never match a conic mockup pixel-for-pixel and a re-derivation-by-eye is forced. Express geometry impl-neutrally — `outerRadius / strokeWidth / innerRadius / gap` and literal `font-size:38px` — so the impl copies numbers, not ratios. The impl's `size * 0.317`-style magic ratios are *caused* by a mockup that hides its geometry inside a rendering trick. (Consequence in `client/CLAUDE.md`: precision components take no `size`/scale prop and no optional booleans.)
- **Anchor precision elements with `data-spec` + `data-spec-primitive` for the measured gate.** On each measured element put `data-spec="ring.center-number"` (a stable id shared with the impl node) and, on the component root, `data-spec-primitive="svg-arc"` (which rendering primitive the impl must match). This is the contract a fidelity audit diffs — computed styles of the mockup DOM vs the impl DOM, joined on the anchor. It is "Figma Code Connect for HTML mockups": the anchor is the prop-mapping, pointed the other way. (The measured collector `spec-collect.mjs` is tracked in `docs/vibe-coding/09.07.2026-design-spec-contract/`.)

## Common mistakes

| Mistake | Fix |
|---|---|
| Reinventing a token, primitive or composite the design system already exports | Consult `packages/design/src/` first; reproduce the canonical component's real `.tsx` — never draw a fresh variant |
| Hand-rolling a **form field** (row `<input>` + inline icon + unit) instead of the input canon | Map every field to the catalog BEFORE drawing: numeric/unit → `LabeledValueCard`+`UnitPill`, text → `LabeledValueCard valueVariant="text"`, group label → `FieldEyebrow`, birthday → `ValuePicker`, search → `SearchPillInput`. Reproduce its real `.tsx` (card surface, exact label/value type scale, lime focus-border), not an eyeballed row |
| Eyeballing a token (`#fce047` instead of real `#FFD54F`) | Read `brandColors.ts`/`theme.ts`, copy the exact value |
| Dark-theme-only mockup | Always add a light/dark toggle; the app has both |
| 6 variants dumped at once | Curate to 2–4 + the V0 baseline |
| Describing options in prose | If it's a visual decision, build it — that's the whole point |
| Static screenshot for an animation question | Make it interactive with replay controls |
| Drawing only the filled state of a data-driven card/list | Add a `-loading` (skeleton) and `-empty` frame to `__listStates()` — the missing skeleton is what makes the impl flash zero-data |
| Inventing a fresh aesthetic for a redesign | Replicate the shipped design system exactly |
| Filling a light-mode CTA with olive `#516700` (the old dark-green button) | Primary/filled buttons are `#cafd00` bg + `#000` text in BOTH themes (hover `#beee00`) — never the `primary.main` token, which is olive in light mode |
| Trailing "→" arrow glyph on a CTA/link/teaser ("Подробнее о PRO →") | BANNED — the user finds it ugly. Affordance comes from the element: filled lime button, or lime text color, or a `›` `<ChevronRightIcon>` on a nav row, or a "PRO" pill for upsells. Keep data arrows ("102→87 кг"). See memory `feedback_no_arrow_glyph_in_ui`. |
| Emoji or hand-drawn SVG as icons | Material Symbols font, ligature names, outline weight — see `polish-kit.md` |
| Flat single `box-shadow` / bare gradient-disc "glow" | 2-layer shadow (ambient + hairline), tint accent surfaces; glow = radial-to-transparent + `blur()` + hairline rings behind |
| Compact hero (glow+rings+tile) in a short fixed band clips on the status bar / bleeds onto the title (recurring bug) | Size glow+rings ≤ band height, give the band top+bottom margin, drop `overflow:hidden` (it hard-cuts) — see polish-kit "COMPACT hero band". A full-flex hero's 340px glow does NOT fit a 150px band; scale the whole set down together |
| Full-width subhead paragraph | Cap at `max-width:310px` (~38ch) so it wraps to 2 short lines |
| `@keyframes{from{opacity:0}}` entrance → mockup renders blank | Animate transform only; keep the un-animated base state visible (preview harness pauses at frame 0) |
| Multi-file prototype blank from `file://` | Browser blocks local `.jsx`/fetch over `file://`; serve over `python3 -m http.server` and open via `localhost` (see `polish-kit.md`) |
| Icons render as ligature WORDS ("campaign", "info") / headings turn **serif** | The Google-Fonts URL 400'd or has no fallback. Icon `css2` must be exactly 4 axis values (`@24,400,0,0`) — `curl` it, expect 200; every `font:`/`font-family` ends in `, sans-serif`; gate icons on `document.fonts`. Full head block + checklist in `polish-kit.md` §"Remote fonts MUST never break the mockup" |

## Output location

`docs/superpowers/specs/{YYYY-MM-DD}-{feature-slug}/mockup.html` (the `docs/superpowers/` tree is gitignored, local-only scratch — the visualizer is a decision aid, not a shipped artifact).
