# test-quality review — E7 UI (re-read)

- HEAD: `cad08c39318abcc9ffe47cc8e30d785231ecf18d`
- codeTree: `c86e85bd469ec2b6dad402b020ca02b2dae12a2b`
- Worktree: `/Users/opera_user/Documents/projects/mcpproxy-e7-ui` (branch `v2/e7-ui`)
- Scope: `git diff bc3e9630d99bfd702ae37e73063d88e258424ad5..HEAD -- '*.test.ts' '*.test.tsx'
  '*/fixtures/*' '*/scripts/*' '*vitest*' '*package.json'` — 13 files, +558/-81. Two brand-new
  test files (`guard.test.ts`, `appCss.test.ts`), one new-case file (`jcs.test.ts`), five changed
  test files, `build-fixtures.mjs`/`demo.jsonl`/`marks.json` fixture regeneration, and
  `package.json` (`build:smoke` script, `typescript`/`playwright` declared deps). This is a
  **re-read** of a prior run that reviewed `bc3e963` and returned `TQ-FLAKY` on one MAJOR + two
  MINOR findings; all three are re-verified below against the new code, not re-derived from
  scratch.
- Confirmed by running the suites (read-only): `yarn workspace @mcpproxy/desktop vitest run` →
  **149/149 pass** (13 files, up from 147 — the two new files add 6 tests net); `yarn workspace
  @mcpproxy/contracts vitest run` → **253/253 pass** (up from 251 — the two new `jcs.test.ts`
  cases). `git diff bc3e963..HEAD -- '*.test.ts' '*.test.tsx' | grep -E '\.only\(|\.skip\(|xit\(|xdescribe\('`
  → empty. No new `setTimeout`/`waitForTimeout`/`sleep(`/fixed ports in the delta.

## Verdict: **TQ-SOLID**

All three previously-reported findings were addressed. The MAJOR is resolved to the point of no
longer blocking (the dishonest claim is gone and the primitive is now genuinely demonstrated), but
one narrow gap in it survives and is re-filed as MINOR rather than closed outright. One MINOR
(regex guard) is fully resolved. One MINOR (esbuild.jsx duplication) is untouched — carried
forward unchanged, still non-blocking. Two new VALID-NOT-BLOCKING notes on the two new structural
guards, both unverified-by-mutation for the reason stated in each (read-only reviewer, shared
worktree).

## Findings

### MINOR (downgraded from MAJOR, partially resolved) — smoke.test.ts's positive control now proves the primitive works, but still never exercises the loop the real test depends on
- **File:line**: `packages/desktop/src/e2e/smoke.test.ts:164-186` (test), `:172-178` (the
  cross-package loop it claims to validate)
- **What changed**: the old positive control asserted `own` (the renderer's own bare specifiers)
  contains `'@mcpproxy/contracts'` — a fact true whether or not the cross-package walk exists at
  all (previous finding, confirmed by hand-tracing `@mcpproxy/contracts`'s root entry: zero bare
  imports anywhere in its relative-import closure). The new version instead calls the same
  `bareSpecifiers()` primitive directly on `requireFrom.resolve('@mcpproxy/contracts/audit')` and
  asserts the result contains `'node:crypto'`. Verified this is real: `packages/contracts` docs
  its `./audit` export as importing `node:crypto` on purpose, separate from the dependency-free
  `.` root entry — traced by hand, this claim holds.
- **What this fixes**: the dishonest part of the old claim is gone. `bareSpecifiers()` is now
  shown, on a genuinely leaky input, to actually find the forbidden specifier — so a broken
  recursive-walk implementation (e.g. the `specifier.startsWith('.')` relative-following logic)
  would be caught by this test, which it would not have been caught by the old one.
- **What still isn't proven**: the composition the real test (`'ни рендерер, ни его зависимости не
  тянут…'`, lines 169-186) actually runs is `own` → `for (specifier of own) if
  specifier.startsWith('@mcpproxy/') { reachable.add(...bareSpecifiers([requireFrom.resolve(specifier)]))
  }`. Today `own` contains only `'@mcpproxy/contracts'` (the root specifier), never
  `'@mcpproxy/contracts/audit'` — so the loop, when it runs for real, walks the *root* entry,
  which (confirmed again this run) still has zero bare imports in its relative closure. Traced
  through both tests: **commenting out the body of the `for` loop at lines 173-176 still leaves
  both this test and its positive control green**, exactly as in the prior finding — the positive
  control no longer needs the loop at all, since it drives `bareSpecifiers()` directly on a
  hand-picked known-leaky path instead of going through `own`/`reachable`. The file's own comment
  ("если механизм обхода перестанет заглядывать внутрь зависимости, эта строка покраснеет")
  overclaims this: the "line" in question doesn't touch the loop.
- **Consequence**: the specific regression this whole file's WHY-comment calls out — a future
  refactor making `@mcpproxy/contracts`'s `.` entry relatively reach into `./audit` (e.g. someone
  moves a helper into `index.ts` that imports from `./audit/chain.js`) — still would not be
  demonstrably caught by a test today; it's plausible the real test would catch it live (the loop
  logic looks correct by inspection), but nothing in the suite proves that, only that
  `bareSpecifiers()` itself is not broken.
- **Severity note**: downgraded from MAJOR to MINOR because the practical risk that motivated the
  original finding (a completely inert, false-green security scan) is substantially reduced — the
  core scanning primitive is now under real test — and because closing the remaining gap requires
  either changing `own`'s current contents (which the diff's own author correctly avoided doing
  artificially) or restructuring the test to exercise `own`→loop→`reachable` end-to-end against a
  package whose *root* entry is genuinely leaky, which no in-repo package currently is.
- **Fix (if pursued further)**: assert that `reachable` (from the real test) is a strict superset
  of `own` whenever any walked `@mcpproxy/*` specifier resolves to an entry with bare imports —
  computed generically, not hand-picked — or add a synthetic fixture package under `dist/deps`
  whose root entry relatively imports a leaky path, and confirm the real loop's `reachable` picks
  it up. Either ties the positive control back to the actual glue code.

### RESOLVED — ipc.test.ts's regex-over-raw-text structural guard replaced with an AST guard
- **Prior MINOR**: `ipc.test.ts:94-113`'s three-rule guard scanned whole file text with regex,
  so a comment mentioning `webContents.send` in prose (already present in `dispatch.ts:7`'s own
  JSDoc) could false-positive in a different file; and it called `readdir` without `recursive`,
  so a privileged call moved into a subdirectory (`main/foo/bar.ts`) would go unseen.
- **Now**: that whole `describe('структурный страж границы', …)` block is deleted from
  `ipc.test.ts` (confirmed: `git diff` shows only removal there, no replacement in that file) and
  replaced by `packages/desktop/src/main/guard.test.ts`, which (a) parses each file into a real
  TypeScript AST via `ts.createSourceFile` and matches `ts.isCallExpression`/`ts.isNewExpression`
  nodes — comments cannot match — and (b) calls `readdir(SRC, { recursive: true })` over the
  whole `src` tree, not just `main/`. Both concerns from the prior MINOR are addressed by
  construction; the new file's own docstring explicitly names both as the reasons for the rewrite.
- **Verified live**: re-derived the three rules' owner files independently
  (`grep -rn "ipcMain\." / "new BrowserWindow" / "UI_CHANNEL"` across `packages/desktop/src`,
  excluding tests) — each of the three privileged APIs appears in exactly one production file
  today (`ipc.ts:88`, `window.ts:41`, `dispatch.ts:29`), matching each rule's declared owner, so
  the guard's "offenders must be empty" assertions are non-vacuous today, and its added
  "positive control" (owner file must itself contain the call) is genuine — verified by running
  the suite (`guard.test.ts` — 4/4 pass) and by independently re-deriving the match logic.
- No finding carried forward on this point.

### VALID-NOT-BLOCKING (new file, judged hard per instructions) — guard.test.ts: AST guard is real, `webPreferences`-wholesale rule verified by static reasoning, not by mutation
- **File:line**: `packages/desktop/src/main/guard.test.ts` (whole file, 138 lines)
- **The three `it.each` rules** (`ipcMain.handle/on/handleOnce` → `main/ipc.ts`; UI_CHANNEL send →
  `main/dispatch.ts`; `new BrowserWindow` → `main/window.ts`): each is genuinely non-vacuous today
  — see RESOLVED item above for the independent re-derivation. **Which production line turns it
  red**: adding a second call to any of the three APIs in a file other than its declared owner
  (e.g. a stray `ipcMain.handle(...)` added to `main/window.ts`) turns the "offenders must be
  empty" assertion red; deleting/renaming the call out of its owner file (e.g. renaming
  `ipcMain.handle` usage away from `ipc.ts:88` entirely) turns the paired positive control
  (`ownerHit` must be `true`) red. Both directions are covered, for all three rules.
- **The `webPreferences`-wholesale rule** (`guard.test.ts:104-136`): statically verified against
  `packages/desktop/src/main/window.ts:38-45` — the single `new BrowserWindow({...})` call passes
  `webPreferences: webPreferencesFor(role, preload)` with no spread and no sibling key, matching
  what the test asserts (`options.properties.filter(isSpreadAssignment)` empty; the
  `webPreferences` initializer is a bare `CallExpression` to `webPreferencesFor`). **Line that
  turns it red**: `packages/desktop/src/main/window.ts:44`. The author's claimed mutation — change
  it to `webPreferences: { ...webPreferencesFor(role, preload), webSecurity: false }` — would
  introduce a `ts.SpreadAssignment` into `options.properties`, which
  `expect(options.properties.filter((p) => ts.isSpreadAssignment(p))).toHaveLength(0)` would then
  fail on (length becomes 1). Traced through the AST-matching code by hand; this is plausible and
  I found no gap in the reasoning. **Unverified by mutation**: I am read-only and share this
  worktree with the live gate, so I did not — and could not without violating the read-only
  constraint — actually make that edit and run the suite to see red. Prediction: `guard.test.ts`'s
  last `it(...)` fails at the `toHaveLength(0)` assertion (not at `fromFactory` — the initializer
  is still a `CallExpression`, just wrapped, so `ts.isCallExpression` would be false for the outer
  `ObjectLiteralExpression` initializer instead; either way the test goes red, just possibly at a
  different one of its two assertions depending on exact AST shape of the spread case).

### VALID-NOT-BLOCKING (new file, judged hard per instructions) — appCss.test.ts: id-selector probe verified by static reasoning, not by mutation
- **File:line**: `packages/desktop/src/renderer/appCss.test.ts` (whole file, 53 lines)
- Independently computed `idSelectors()` against the real `app.css` (ran the file's own regex by
  hand in node): today it returns exactly `['root']` — one id selector, matching the file's own
  claim ("Id в этом файле ровно один"). `index.html:8` has `<div id="root"></div>`, so the "every
  id selector exists in markup" assertion is non-vacuous and currently true for a real,
  non-trivial reason (not an empty-list vacuity — the file's own first assertion,
  `expect(ids.length).toBeGreaterThan(0)`, is exactly the guard against that failure mode, and it
  is itself genuinely exercised since `ids` really is non-empty).
- The second test (`'зонд умеет краснеть…'`) is a self-contained positive control using a
  synthetic `'#app{display:flex}'` string against the real `index.html`, independent of the
  first test's live data — confirmed this is a real, distinct code path (calls `idSelectors`
  directly on a literal, not on the file's own `app.css`), so it is not circular.
- **Line that turns the first test red**: `packages/desktop/src/renderer/app.css:18`
  (`#root{height:100%;…}`). The author's claimed mutation — renaming it back to `#app` — would
  make `idSelectors(css)` return `['app']`; `markup.includes('id="app"')` is false today (only
  `id="root"` appears anywhere under `packages/desktop/src/renderer`, confirmed by grep across all
  `.tsx` and `index.html`), so `missing` becomes `['app']` and `expect(missing).toEqual([])` fails.
  This is a complete, mechanical trace of the actual regex/string-match code, not a guess.
- **Unverified by mutation**: same read-only/shared-worktree constraint as above — I did not edit
  `app.css` to confirm red. The reasoning trace above is a full symbolic execution of the test's
  own logic against the file's real current content, so confidence is high, but per the task's
  instruction this is marked unverified-by-mutation rather than claimed as executed.

### MINOR (carried forward, unchanged) — vitest.config.ts's `esbuild.jsx: 'automatic'` still duplicates, without a coupling check, the real build's JSX mode
- **File:line**: `packages/desktop/vitest.config.ts:16` vs `packages/desktop/tsconfig.renderer.json:6`
  and `packages/desktop/electron.vite.config.ts` (renderer block still declares no
  `plugins`/`esbuild.jsx` override).
- **Status**: none of these three files appear in this delta (`git diff bc3e963..HEAD` on them is
  empty) — this finding was not addressed and is not claimed to have been. Carried forward
  verbatim from the prior review for record-keeping; still non-blocking, no evidence of an active
  break (`build-test` gate still records pass; no renderer `.tsx` imports `React` explicitly,
  consistent with automatic-runtime output continuing to build).
- No new fix suggested beyond the prior review's: derive the vitest esbuild option from
  `tsconfig.renderer.json`'s `compilerOptions.jsx` at config-load time, or add one assertion
  comparing the two.

## Explicitly cleared (no finding, re-confirmed this run)

- **jcs.test.ts's two new array-hole cases** (`packages/contracts/src/jcs.test.ts:76-103`):
  traced against `packages/contracts/src/jcs.ts:88-91` (explicit `Object.hasOwn` hole check,
  throws `TypeError`) and the `typeof value === 'undefined'` default-case throw at `jcs.ts:75` for
  the explicit-`undefined`-element case — these are two genuinely different code paths in the
  implementation, both exercised by the two new tests, both real. Non-vacuous, non-tautological.
- **player.test.ts's `MARKS` change** (`{ seatbelt: 0, none: 2 }` → `{ none: 2, seatbelt: 4 }`):
  confirmed against `packages/desktop/src/main/player.ts` — `replay()` uses a closure-local
  `origin` (set at `reset()` time, defaulting to `0` at cold start regardless of default track)
  rather than `marks[track]`. With the old `MARKS.seatbelt: 0`, `origin === marks.seatbelt` at
  cold start by coincidence, so the bug (`replay()` slicing from `marks[track]` instead of
  `origin`) was structurally invisible; with `MARKS.seatbelt: 4`, the new
  `'повтор со свежего старта…'` test (`position` after 2 steps is `2`, less than `marks.seatbelt`
  `4`) would fail under the old buggy `slice(marks[track], position)` implementation (`slice(4,2)`
  → empty) but passes under the real, fixed `slice(origin, position)` (`slice(0,2)` → 2 events).
  Confirmed by reading `player.ts` directly — genuinely regression-shaped, not tautological.
- **trace.test.ts's invariant-walk replacement** for the old `argvFromParams: [3]` per-event
  literal: the new version checks index bounds against each event's own `argv` array (an
  invariant that generalizes beyond the single-recipe fixture the old test was implicitly locked
  to) plus an explicit check that at least one `build_argv` event has no `argvFromParams` key at
  all (the "R13 reverse half" — absent key vs. empty value). Paired with a new, separate
  scenario-coverage test asserting S3/S4/S5/S6/S7/S8 all have rendering-relevant surface in the
  fixture. Not weaker in the way that matters (the deleted per-event `[3]` literal was itself an
  artifact of the fixture having one recipe, not a real contract requirement) — this is a
  legitimate generalization, not a stealth loss of coverage.
- **call.test.ts's `it.each` replacement**: the deleted 13-case `it.each([...stageOrder])('%s
  попадает в одну из трёх групп', ...)` asserted `STAGE_GROUPS.toContain(stageGroup(stage))` for
  every stage — but `STAGE_GROUPS` is the literal enum of all valid `StageGroup` values, so
  `stageGroup()`'s TypeScript return type (`StageGroup`) already guarantees this holds for any
  value the function can return; the 13-case loop could only ever fail via an `as`-cast escape
  hatch, not a real bug. Removing it is not a real loss of coverage. The replacement adds real
  behavior coverage instead (tolerant handling of an unknown/future stage — `stageGroup('quarantine'
  as Stage)` doesn't throw and lands in a real group) plus one positive control confirming a known
  stage (`lock_check`) still lands in its correct, specific group (`'checks'`), not just any
  group. **Residual gap, not a finding**: no test in the delta or the wider suite asserts the
  *other* eleven stages land in their *specific* correct groups (only `lock_check`'s is checked by
  name) — group-membership correctness for the rest is exercised only indirectly via
  `groupBar()`/rendering tests elsewhere in the existing (unchanged) suite. Noted for completeness,
  not filed as a finding since it predates this delta and wasn't introduced or regressed by it.
- **callLine.test.ts's new `rest` and `failed`-outcome cases**: all seven new cases traced against
  `packages/desktop/src/renderer/timeline/callLine.ts`'s `outcomeOf`/`restOf` functions line by
  line — `error` → `failed`/`danger` (the `call.verdict === 'error'` branch, `callLine.ts` WHY
  comment explicitly documents this as the bug being fixed), denied-reason + stage label, awaiting
  note, exit code + overhead, sent-bytes only when `action === 'allowed' && bytes > 0` (confirmed
  the "denied → no volume" test matches this exact condition), and the `andMore` counter for a
  second violation. All seven match real branches, all real regressions if reverted.
- **package.json**: `build:smoke` correctly sets `MCPPROXY_OBSERVE=1` as a build-time env var
  consumed by `electron.vite.config.ts:25`'s `define`, matching the `smoke.test.ts` `beforeAll`
  fix that now checks the built `preload/index.cjs` artifact for `__mcpproxyObserve` before
  launching, instead of the old (silently inert) runtime `env:` override on `electron.launch`.
  `typescript`/`playwright` newly declared at `^5.6.3`/`^1.62.1` — versions consistent with the
  root `package.json`'s `typescript: ^5.6.3`, no version-skew risk found.
- **Q1 (expiry)**: `build-fixtures.mjs` still bakes an absolute `Date.parse('2026-08-27T14:05:12.000Z')`
  clock; no added/changed test compares against `Date.now()`. Clean, unchanged from prior review.
- **Q4/Q5 (clock/network/order/isolation)**: no `.only`/`.skip` in the delta; `vitest.config.ts`
  still excludes `src/e2e/**`, `vitest.smoke.config.ts` still includes only it — re-confirmed no
  overlap. No new fixed ports, no new shared mutable module state asserted on by literal value.
