# Visualizer Polish Kit

Portable, copy-paste CSS/markup that makes a hand-built single-file mockup read as
production-grade instead of "generic AI". Distilled from a Claude Design teardown of
its own output (2026-06). Lift these verbatim; adjust only the tokens.

**The 80/20:** most of the "polish" is fidelity + restraint, not more code —
(1) lift exact hexes/radii/shadows from the real source, (2) build the hero as
glow + rings + tile with a *tinted* shadow, (3) use an icon font instead of drawing
or emoji. The 4th, least-obvious win is the safe-entrance-animation rule (§Motion) —
it prevents "my mockup rendered blank".

## Icons — Material Symbols font, never emoji

Emoji as UI icons is the #1 tell (and the user rejects it outright). Never hand-draw
SVG paths either — that's where mangled icons come from. Use the Material Symbols
font, rendered by ligature name. The glyphs match `@mui/icons-material` (both derive
from Google Material), so the mockup matches production for free.

```html
<link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0" />
<style>
  .material-symbols-outlined{
    font-family:'Material Symbols Outlined';
    font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24;
  }
</style>
<span class="material-symbols-outlined">notifications_active</span>
```
Rules: FILL 0 (outline) everywhere for the Linear/Strava feel; `opsz` tracks render
size (24 bullets, 48 hero); colour is always a token. Icon name = the MUI name
lower-snake-cased (`NotificationsActiveOutlined` → `notifications_active`).

## Remote fonts MUST never break the mockup — the #1 recurring failure

The single most common way a hand-built mockup ships broken: **a Google-Fonts URL
that never loads**, so Material-Symbols icons render as the raw ligature WORD
("campaign", "info", "speed") and headings fall back to **serif**. It looks
catastrophic and the user rejects it on sight. Root causes and the belt-and-suspenders
fix (lift the whole head block verbatim):

**1. The icon `css2` URL must have EXACTLY 4 values for the 4 axes — never more.**
The axes are `opsz,wght,FILL,GRAD`; a fixed instance is `@24,400,0,0` (four numbers).
Passing extra values (e.g. a size range `@20,24,48,400,0,0` = six numbers) makes Google
return **HTTP 400**, the font never loads, and every icon renders as its ligature name.
Verify BEFORE opening the mockup:
```bash
curl -s -o /dev/null -w "%{http_code}\n" "<the exact icon URL>"   # must be 200, not 400
```

**2. Every `font-family` / `font:` shorthand MUST end in a generic fallback.**
A `font:` shorthand *resets* font-family to only what you list, so
`font:700 30px 'Space Grotesk'` with no fallback renders the **browser-default serif**
during the swap window (or forever, if the font is blocked). Always write
`'Space Grotesk', sans-serif` and `... Inter, sans-serif` — never a bare family name.

**3. Gate the icons on confirmed font-load so a ligature name never flashes as text.**
Hide `.material-symbols-outlined` until the font is actually available, reveal via
`document.fonts`, with a hard failsafe timer. Add `&display=block` to the icon URL so
the glyph slot stays blank (not a word) during load.

**4. `preconnect` to both font hosts** — trims the load and makes the gate resolve fast.

Copy-paste head (the tested, working block):
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0&display=block" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" />
<style>
  .material-symbols-outlined{
    font-family:'Material Symbols Outlined';
    font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24;
    visibility:hidden;                              /* never show the ligature WORD */
  }
  html.ms-ready .material-symbols-outlined{ visibility:visible; }
</style>
<script>
  (function () {
    function reveal(){ document.documentElement.classList.add('ms-ready'); }
    if (document.fonts && document.fonts.load) {
      document.fonts.load("24px 'Material Symbols Outlined'")
        .then(function () { return document.fonts.ready; })
        .then(reveal).catch(reveal);
      setTimeout(reveal, 2500);                     /* failsafe: never stay hidden forever */
    } else { reveal(); }
  })();
</script>
```

**5. Pre-show eyeball check (mandatory).** After `open`, actually LOOK at the page:
if you see a ligature word ("campaign") where an icon belongs, or a **serif** heading,
the fonts failed — fix the URL / fallback and re-`open` BEFORE handing off. A screenshot
that shows raw ligature words is the tell.

## Tokens (set on a wrapper; swap the block for light)

```css
.ui{ --bg:#0e0e0e; --text:#fff; --text2:#adaaaa; --divider:#484847;
     --chip:rgba(202,253,0,.10); --accent:#cafd00;
     --glow:rgba(202,253,0,.30); --ring:rgba(202,253,0,.14);
     --shadow-amb:0 40px 80px rgba(0,0,0,.18);
     --shadow-hair:0 0 0 1px rgba(0,0,0,.12); }
/* light: --bg:#f9f6f5; --text:#0e0e0e; --text2:#666; --divider:#e0e0e0;
   --chip:#f3ffca; --accent:#516700; --glow:rgba(202,253,0,.45); --ring:rgba(81,103,0,.10) */
```
The CTA stays lime `#cafd00` + ink `#0e0e0e` in BOTH modes — bullet glyphs follow
`--accent` (lime dark / olive light), the brand CTA never does.

## Type scale (exact)

| role | font | size | weight | line-height | extra |
|---|---|---|---|---|---|
| hero title | Space Grotesk | 31px | 700 | 1.08 | `letter-spacing:-.6px; text-wrap:balance` |
| subhead | Inter | 16px | 400 | 1.45 | `color:var(--text2); max-width:310px; text-wrap:pretty` |
| bullet | Inter | 15px | 500 | 1.3 | `text-wrap:pretty` |
| CTA | Inter | 17px | 700 | — | height 54, radius 14 |
| skip | Inter | 15px | 600 | — | low-emphasis colour |

The **310px subhead max-width** is the single most important number — it forces a
~38-char measure so the subhead wraps to 2 short lines, not a full-width paragraph.

## Device frame + hero (glow → rings → tile)

```css
.device{ width:390px; height:844px; border-radius:48px; overflow:hidden;
  position:relative; background:#000;
  box-shadow:var(--shadow-amb),var(--shadow-hair); }
.island{ position:absolute; top:11px; left:50%; transform:translateX(-50%);
  width:126px; height:37px; border-radius:24px; background:#000; z-index:50; }
.home{ position:absolute; bottom:8px; left:50%; transform:translateX(-50%);
  width:139px; height:5px; border-radius:100px; background:rgba(255,255,255,.7); }

/* radial glow — hits transparent BEFORE the edge + a small blur (no banding) */
.glow{ position:absolute; width:340px; height:340px; border-radius:50%;
  background:radial-gradient(circle,var(--glow) 0%,transparent 62%); filter:blur(8px); }
/* app-icon tile — coloured (matching-fill) drop shadow + 1px inset top highlight */
.tile{ width:96px; height:96px; border-radius:26px; background:var(--accent);
  display:grid; place-items:center;
  box-shadow:0 16px 44px rgba(202,253,0,.4), inset 0 1px 0 rgba(255,255,255,.5); }
/* rings: an <svg 320×320> with 3 hairline circles r=150/110/70,
   fill=none stroke=var(--ring) stroke-width=1 — NOT divs with borders */
```
What makes the tile read as a real iOS app icon: the **coloured** drop shadow
(matching the fill, not black) + the **1px inset top highlight**.

**COMPACT hero band — the decorative block MUST fit inside its band, or it clips/overlaps (recurring bug).**
The glow+rings+tile above assume a **full-flex** hero (`flex:1`, ~340px of vertical room). When you instead
put a hero in a **short fixed-height band** (e.g. a 150px strip at the top of a content-heavy slide so the
screen isn't empty-black), you MUST shrink the decoration to fit — otherwise the 340px glow / 320px rings
overflow the band and get **clipped by the status bar above** and **bleed onto the heading below** (a real,
twice-hit incident). Rules for a compact band:
- Size **glow ≤ band height** and **rings (svg display width/height) ≤ band height** — e.g. band 164px → glow ~150px, rings ~158px, tile ~74px. The radial glow already fades to transparent, so once it fits it needs no clipping.
- Give the band **top AND bottom margin** (`margin:10px 0 8px`) so the glow clears the status bar/notch and leaves a clear gap before the title. Never let the heading sit against the glow.
- **Do NOT rely on `overflow:hidden`** to hide an oversized glow/rings — it produces a hard flat cut-off edge (looks broken). Fit the decoration instead; drop `overflow:hidden`.
- Scale the whole set down together (tile radius scales with size, per the bullet-row note below) — don't keep a 96px tile in a 150px band.

## Icon-tile bullet row

```css
.row{ display:flex; align-items:center; gap:14px; }      /* flex+gap, never margins */
.row-i{ width:42px; height:42px; border-radius:12px; background:var(--chip);
  display:grid; place-items:center; color:var(--accent); }   /* glyph 23px */
.row-t{ font:500 15px/1.3 Inter; text-wrap:pretty; }
```
Tile radius (12) is smaller than the hero (26) on purpose — radius scales with the element.

## Elevation — always 2 layers, tint accent surfaces

A single `box-shadow:0 4px 8px` is a tell. Use ambient + contact/hairline:
- Device: `0 40px 80px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.12)`
- Tile: coloured glow + inset highlight (above)
- Bottom sheet: `0 -8px 40px rgba(0,0,0,.4)` (negative-y casts upward)

## Brand CTA (hardcoded, theme-independent)

```css
.cta{ width:100%; height:54px; border:0; border-radius:14px;
  background:#cafd00; color:#0e0e0e; font:700 17px Inter; cursor:pointer; }
.cta:hover{ background:#beee00; }
```

## Motion — base state must be VISIBLE; animate transform only

Preview harnesses (and `prefers-reduced-motion`) pause animations at the first
keyframe. A `@keyframes{from{opacity:0}}` then renders the element **invisible**.
Never gate visibility on an animation. Animate transform only (scale/translate),
keep the un-animated base state visible.

```css
@media (prefers-reduced-motion:no-preference){
  .pop{ animation:pop .6s cubic-bezier(.2,.8,.2,1) both; }
}
@keyframes pop{ from{transform:scale(.6)} to{transform:scale(1)} }   /* NOT opacity */
```

## Pre-show polish checklist (the 8 anti-"generic-AI" tells)

Before opening the mockup for the user, verify NONE of these:
1. Invented colours instead of lifted ones → open the token file, copy hexes.
2. Single flat box-shadow → 2 layers (ambient + contact/hairline); tint accent surfaces.
3. Bare gradient disc for "glow" → radial that hits transparent before the edge + `blur()` + hairline rings behind.
4. Emoji or hand-drawn SVG icons → Material Symbols font, outline weight.
5. Full-measure body text → cap subhead at ~310px / ~38ch (wraps to 2 lines).
6. Uniform spacing / no focal point → commit a 3-zone flex split, let the hero hold empty space; vary radii by element size.
7. Margins + inline-block for rows → `display:flex; gap:` everywhere.
8. Opacity-0 entrance animations → transform-only; base state visible (see Motion).

## Gotcha — multi-file prototypes don't open from `file://`

A self-contained single HTML file opens fine by double-click. But a prototype split
across files (e.g. Claude Design's React + Babel `<script src="x.jsx">`) is blocked
by the browser from fetching local `.jsx` over `file://` → blank screen. Serve the
folder over http instead:
```bash
cd <folder> && python3 -m http.server 8011 --bind 127.0.0.1
# open http://localhost:8011/<file>.html
```
The visualizer's own output is single-file vanilla HTML, so this only bites when you
download/open a Claude Design multi-file bundle.
