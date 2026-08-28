# test-quality review — E7 UI

- HEAD: `bc3e9630d99bfd702ae37e73063d88e258424ad5`
- codeTree: `833bdcd4055ef0ae7209a4d68257e8b2a2ce5fc8`
- Worktree: `/Users/opera_user/Documents/projects/mcpproxy-e7-ui` (branch `v2/e7-ui`)
- Scope: every `.test.ts`/`.test.tsx` added or changed by `59235c3..HEAD` (~150 unit tests across
  `packages/desktop`, `packages/contracts`, `packages/design`, plus the 9-test Electron smoke
  suite `packages/desktop/src/e2e/smoke.test.ts`). All read in full.
- Confirmed by running the suites (read-only): `yarn workspace @mcpproxy/desktop vitest run` →
  147/147 pass; `yarn workspace @mcpproxy/contracts vitest run` → 251/251 pass; `yarn workspace
  @mcpproxy/design vitest run` → 12/12 pass. No `.only`/`.skip`/`xit`/`xdescribe` anywhere in the
  diff (`git diff … | grep -nE '\.only\(|\.skip\('` → empty). No `vi.useFakeTimers`, `setTimeout`,
  `waitForTimeout`, or `sleep(` in any added test. No fixed ports. Unit config (`vitest.config.ts`)
  excludes `src/e2e/**`; smoke config (`vitest.smoke.config.ts`) includes only `src/e2e/**` — no
  overlap, confirmed by reading both files.

## Verdict: **TQ-FLAKY**

One MAJOR finding (vacuous positive control on a security-relevant structural guard) blocks a
clean pass; two MINOR findings are noted for the record but do not block.

## Findings

### MAJOR — smoke.test.ts: the "goes into the dependency" positive control never exercises the code it claims to
- **File:line**: `packages/desktop/src/e2e/smoke.test.ts:164-185`
- **Fails**: Q3 (vacuous / would pass if the feature were deleted)
- **What's claimed**: the comment at line 181 says *"Проверка обязана уметь падать: без входа
  внутрь зависимости она была бы тавтологией"* — i.e. test `'обход действительно доходит до
  зависимостей...'` (182-185) is the positive control proving that the cross-package hop (the
  `for (const specifier of own) { if (!specifier.startsWith('@mcpproxy/')) continue; … }` loop,
  172-176) actually walks into `@mcpproxy/contracts` and would catch `node:crypto`/`ajv`/`re2`/
  `yaml` hiding there.
- **What it actually does**: the positive control recomputes `own` (`bareSpecifiers` over the
  package's own emitted files) and asserts `own` contains the string `'@mcpproxy/contracts'`.
  `own` is computed *before* the cross-package loop runs and does not depend on it in any way.
  Traced by hand: `packages/contracts/src/index.ts` (the `.` entry resolved by
  `requireFrom.resolve('@mcpproxy/contracts')`) re-exports only relative files — `domain.ts`,
  `annotations.ts`, `manifest.generated.ts`, `types.ts`, `mcp.ts`, `approval.ts`, `event.ts`,
  `otlp.ts`, `jcs.ts`, `lock.ts`, `ipc.ts`, `tool.ts` — and
  `grep -n "^import" <those files> | grep -v "from '\./"` returns **zero** lines: this whole
  closure has no bare imports at all (this is the package's own documented invariant: *"`.` —
  типы и чистые функции, без зависимостей вообще"*). The same is true of `@mcpproxy/design`'s
  entry (`palette.ts`/`tokens.ts`/`semantic.ts`, only `semantic.ts` has a `type`-only import from
  `@mcpproxy/contracts`, still zero *bare* runtime deps beyond that). So today, walking into
  either `@mcpproxy/` dependency adds **nothing** to `reachable` beyond `own`.
- **Consequence**: delete the entire loop at lines 172-176 (or replace its body with a no-op) and:
  - test `'ни рендерер, ни его зависимости не тянут…'` (164-179) still passes — `reachable`
    still equals `own`, and none of the forbidden specifiers are in `own` either way, today.
  - the positive control (182-185) still passes unchanged — it never touched `reachable`.
  Both tests stay green while the one piece of machinery this file exists to add (crossing the
  package boundary to check what a dependency itself imports, called out explicitly in the
  file's own WHY comment as "первая редакция ... находила `re2`, `yaml` и `node:crypto` ... но
  видела входы `validate` и `audit`, которых корневой вход не импортирует") goes untested. If a
  future change ever makes the `.` entry of `@mcpproxy/contracts` transitively reach `./audit`'s
  `node:crypto` (a one-line refactor mistake, e.g. someone moves a helper into `index.ts` that
  imports from `./audit/chain.js`), this guard would not reliably have proven it *would* have
  caught it — the "it can fail" claim is unverified for the actual failure mode it exists to
  catch.
- **Unverified by mutation** (read-only reviewer, cannot edit the shared worktree). Prediction if
  you break it: comment out (or `continue`-skip unconditionally) the body of the
  `for (const specifier of own)` loop at smoke.test.ts:173-176 → **both** the forbidden-deps test
  and its "positive control" stay green. That is the mutation to run to confirm this finding.
- **Fix (concrete restructure, not a comment)**: point the positive control at a target that is
  *known*, by the package's own contract, to require crossing the boundary — e.g.
  ```ts
  it('обход действительно доходит до зависимостей, а не только до своих файлов', async () => {
    const auditEntry = requireFrom.resolve('@mcpproxy/contracts/audit');
    const nested = await bareSpecifiers([auditEntry]);
    expect(nested).toContain('node:crypto'); // ./audit is documented to import it
  });
  ```
  and, separately, assert that the *real* `reachable` set used by the forbidden-deps test is a
  strict superset of `own` whenever the walked dependency has bare imports — or, simplest: add a
  fixture case exercising `@mcpproxy/contracts/audit` (which does import `node:crypto`) through
  the exact same `own`/`reachable` computation used by the real test, and assert it *is* flagged
  when the entry point under test is swapped to `./audit` instead of `.`. Any of these ties the
  "positive control" to the mechanism it claims to validate instead of to an unrelated fact about
  `own`.

### MINOR — vitest.config.ts's `esbuild.jsx: 'automatic'` duplicates, but nothing keeps it tied to, the real build's JSX mode
- **File:line**: `packages/desktop/vitest.config.ts:16` vs `packages/desktop/tsconfig.renderer.json:6`
  and `packages/desktop/electron.vite.config.ts` (renderer block, no `plugins`/`esbuild.jsx` at all)
- **Fails**: adjacent to Q2 (hand-duplicated constant, not the boundary itself, but a config value
  the diff's own comment says "should" track the app's build)
- The added comment in `vitest.config.ts` justifies the literal `'automatic'` by saying *"Значение
  повторяет `jsx: react-jsx` из `tsconfig.renderer.json`, то есть сборка и тест трансформируют
  JSX одинаково"* — but that's an assertion about two independently-maintained config files, and
  nothing in the diff checks they still agree. `electron.vite.config.ts`'s renderer build declares
  no `plugins` and no `esbuild.jsx` override, so the real bundle's JSX handling depends entirely on
  Vite/esbuild's own tsconfig discovery for `.tsx` files — a different code path than the literal
  vitest override. I did not find evidence this is *currently* broken (`build-test` gate in
  `docs/vibe-coding/27.08.2026-e7-ui/.gates/build-test.json` records `"status": "pass"`, and no
  renderer `.tsx` file imports `React` explicitly, consistent with automatic-runtime output that
  did build), so this is not asserted as an active break — but it is an untested coupling: change
  `tsconfig.renderer.json`'s `jsx` mode, or add a React plugin to `electron.vite.config.ts` later,
  and `vitest.config.ts`'s hardcoded `'automatic'` will not notice either way.
- **Fix**: derive the vitest esbuild option from the same source instead of restating it, e.g.
  read `tsconfig.renderer.json`'s `compilerOptions.jsx` at config-load time and map it to the
  esbuild value, so a future change to the renderer's JSX mode changes both together; or add one
  assertion (in an existing config/meta test) that parses both files and compares the two values.

### MINOR — ipc.test.ts's structural guard scans raw source text, including comments
- **File:line**: `packages/desktop/src/main/ipc.test.ts:94-113`
- **Fails**: adjacent to Q3/Q6 — not vacuous (verified the three patterns really match their
  three owner files: `ipcMain.handle` in `ipc.ts:78`, `.send(UI_CHANNEL` in `dispatch.ts:29`,
  `new BrowserWindow` in `window.ts:41` — the guard genuinely fires today), but it is a plain
  regex over full file text, not an AST walk (unlike `strings.test.ts`'s Cyrillic guard in the
  same diff, which explicitly does the AST version for exactly this reason). `dispatch.ts:7`
  already carries a JSDoc comment containing the literal substring `webContents.send` in prose;
  it doesn't false-positive today only because the match happens to land inside the designated
  owner file (`dispatch.ts`), which is excluded outright by `name !== owner`. Any *other* file
  under `src/main` that later references one of these three APIs in a comment (a common thing to
  do when explaining "don't do what module X does") would fail this guard for a documentation
  change, not a privilege-boundary regression.
- **Fix**: strip comments before scanning (e.g. reuse the `typescript` AST-walk pattern already
  used in `strings.test.ts` — `ts.isCallExpression`/`ts.isNewExpression` on the identifier), so
  the guard can only fire on actual call/constructor expressions, matching what its own docstring
  claims ("здесь проверяется то, что действительно важно").

## Explicitly cleared (no finding)

- **Q1 (expiry)**: `packages/desktop/scripts/build-fixtures.mjs` bakes an absolute clock
  (`Date.parse('2026-08-27T14:05:12.000Z')`) into the committed `demo.jsonl`/`marks.json`
  fixtures, but none of `trace.test.ts`, `player.test.ts`, or any other added test compares those
  timestamps against `Date.now()` or any live clock — every assertion is on structural properties
  (`verifyChain`, `foldCalls`, presence/absence of `argv`, `argvFromParams`). Confirmed no
  `Date.now()` in the diff at all. Clean.
- **Q2 (tautology) / Q3 (vacuous) elsewhere**: `packages/contracts/src/approval.test.ts`'s two new
  cases (`bc3e963`) both rely on `tsc -b` (chained before `vitest run` in `package.json`'s `test`
  script) to enforce: `expectTypeOf<ApprovalRequest['argvFromParams']>().toEqualTypeOf<
  AuditEvent['argvFromParams']>()` fails to compile if the two field declarations diverge, and the
  `@ts-expect-error` cases fail to compile (TS's built-in "Unused '@ts-expect-error' directive")
  if the expected error stops occurring. Deleting `argvFromParams` from either type, or removing
  the `IpcRequest`/`ApprovalRequest` field restrictions, breaks `tsc -b`. Not vacuous under the
  authoritative gate (`yarn test` from repo root, per the task's own scope note).
- `packages/desktop/src/renderer/timeline/Skeleton.test.ts` (`bc3e963`): the class-set diff
  (`boxesOf(filled)` vs `classesOf(skeleton)`) was traced by hand against `CallList.tsx` and
  `Skeleton.tsx` — filled markup's non-colour box classes are exactly `call, call-top, call-name,
  mono, badge, call-time, call-line, call-icon, groupbar, grp`, and the skeleton renders every one
  of them (confirmed by re-running the suite: 4/4 pass). The paired "positive control"
  (`boxesOf(filled)` vs `classesOf(empty)`) genuinely demonstrates the assertion style can fail,
  and a mutation on `Skeleton.tsx` (e.g. dropping the `call-icon` span) would be caught by the
  first test since that class would disappear from `classesOf(skeleton)`. This one works as
  claimed — no finding.
- **Q4 (clock/network fights)**: the smoke suite waits on `page.waitForSelector('.chrome')` for
  readiness (condition-based), not a fixed `sleep`/`waitForTimeout`. `testTimeout`/`hookTimeout`
  of 60s in `vitest.smoke.config.ts` are budget ceilings, not synchronisation. Clean.
- **Q5 (order/registry/isolation)**: `vitest.config.ts` excludes `src/e2e/**`;
  `vitest.smoke.config.ts` includes only `src/e2e/**/*.test.ts` — no overlap, read directly from
  both files. Per-file module-scoped `let tick = 0` counters (`callLine.test.ts`,
  `commandView.test.ts`, `call.test.ts`, `Skeleton.test.ts`) are only used to generate unique
  span/time values, never asserted on by literal value, and vitest isolates modules per test file
  by default — no cross-file leakage, no test asserts on a tick-derived literal.
- **Q6 (skip/only/generic vs scenario)**: no `.only`/`.skip`/`xit`/`xdescribe` anywhere in the
  diff. `packages/design/src/semantic.test.ts` and `callLine.test.ts` both assert the specific
  S5 scenario contrast (`violationRole('network','denied') !== violationRole('network','allowed')`,
  `mandatory-deny`+`denied` → `danger`), not just a generic invariant table.
