# Test-quality / anti-flake pass — E0 `packages/contracts`

codeTree anchor: `b22e0e3403f5617eeecf45230738961c4d616da5`

Diff reviewed: `c65f71eafc0a230cb4227e8ec6f49eea21b3b6c6...HEAD`, branch `v2/e0-contracts`.
15 added test files / 184 tests, all green. Every file was read in full and scored against the
six questions of `dual-review` section 4. No production file was mutated: where a mutation is the
decisive evidence the exact line to break is named below, and the two claims I could settle
without touching the tree were settled by running an independent copy of the test's own logic
against the real `dist/` and the real schema.

## What is clean, stated once so it is not re-derived

- **Q1 (expiry) — clean.** `grep` over `packages/contracts/src` finds **zero** `Date.now()` and
  zero `new Date(` in production code. Every absolute ISO literal in the suite
  (`chain.test.ts:12-13`, `otlp.test.ts:14-15`, `approval.test.ts:66,83`, `lock.test.ts:46`) is
  pure input data to a pure function. No time bomb exists in this diff.
- **Q4 (clock/network) — clean.** No `vi.useFakeTimers`, no `setSystemTime`, no `sleep`, no
  `waitForTimeout`, no network. The single wall-clock assertion is
  `validate/parse.test.ts:241` (`elapsedMs < 50` for an RE2 match measured at ~0.009 ms); the
  margin is five orders and, if the RE2 wiring were removed, the test does not merely exceed
  50 ms — it hangs and dies on the vitest timeout, still red. Below the reporting bar.
- **Q5 (order / shared state) — clean at file granularity.** `vitest.config.ts` sets only
  `environment: 'node'` and `include: ['src/**/*.test.ts']`; `isolate` is left at its default
  `true`, so each test file gets its own module registry. No `vi.mock` anywhere. The one piece of
  cross-test shared state is module-level and inside a single file (`recipes.test.ts:10`) — that
  is finding TQ-2 below, and it is a false-green defect, not an ordering defect.
- **Q6 — no `.only`, no `.skip`, no `it.todo`, no commented-out test** in the diff.
- **`api-surface.test.ts` quote normalization does NOT hide real changes.** The regex
  `/"([^"\\\n]*)"/g → '$1'` (api-surface.test.ts:58) rewrites only quote style. I checked the
  committed snapshot: after the declaration section is split off, **zero** double quotes survive
  and the only backslash is inside a JSDoc sentence, not inside a string literal — so no two
  distinct declarations currently collapse onto one normalized form. The schema half
  (`api-surface.test.ts:63`) is appended **unnormalized**, so schema strings are still compared
  byte for byte. The normalization is a correct fix for the real non-determinism described in
  handoff row 12. (One latent caveat, below the reporting bar: the character class excludes `\`
  and `"`, so the day a string constant containing a backslash — e.g. a frozen `pattern` — joins
  the public surface, that literal is *not* normalized and the original flake returns for it.)
- **`deps.test.ts` really builds a graph on the `.js` side.** `deps.test.ts:62-67` is a genuine
  emptiness guard, and `deps.test.ts:81-93` are genuine paired positive controls for the walker.
  The `.d.ts` side is not — see TQ-4.
- **`audit/chain.test.ts:76-89` is the real thing.** The competent-attacker case does distinguish
  a chain predicate from a per-record self-consistency check, exactly as its comment claims, and
  `chain.test.ts:45` pins a frozen digest vector rather than deriving one. This is the strongest
  test in the diff. Its two weaker siblings are TQ-5.
- **Handoff mutation table — 11 of 12 rows audited as truthful.** Row-by-row audit is the last
  section; the one row that overstates is called out there, and rows 9 and 11 are true but
  reveal the gap in TQ-5.

## Findings

- **TQ-1 · `packages/contracts/src/tool.test.ts:108-121` · fails Q6 (and Q3) · Major.**
  The test named «форма совпадает с propertyNames схемы — **две копии не разъехались**» compares
  only `RECIPE_NAME_PATTERN.source` against `schema.properties.tools.propertyNames.pattern`
  (line 113). The schema's `propertyNames` has **two** halves — the pattern *and*
  `not: { enum: ["constructor", "prototype", "__proto__"] }`
  (`schema/mcpproxy.schema.json:18-21`). The second half is never read, and **the two copies have
  already drifted**: I ran the committed regex against the committed enum —
  `/^[a-z][a-z0-9_]{0,63}$/.test('constructor') === true` and `('prototype') === true`, while
  ajv on the real schema rejects both (`v(withTools('{"constructor": …}')) === false`). So
  `asRecipeName('constructor')` returns a `RecipeName` for a name the manifest loader refuses,
  and the sibling test at line 116-121 — «asRecipeName отвергает то, что отвергает схема» —
  asserts a claim that is false, by picking the three inputs (`__proto__`, `Publish`, `''`) that
  the pattern alone already rejects. `__proto__` in particular tests nothing about `not.enum`: it
  fails on the leading `_`. This matters more than it looks because
  `api-surface.snapshot.txt:441` freezes `RECIPE_NAME_PATTERN` only as `: RegExp` — the pattern's
  *value* is frozen by nothing else in the suite.
  **Fix (restructured test, not a comment):** derive the rejection set from the schema and assert
  the branded constructor against it, so drift in either half is red:
  ```ts
  const names = schema.properties.tools.propertyNames as { pattern: string; not: { enum: string[] } };
  it('форма совпадает с propertyNames схемы — обе половины', () => {
    expect(RECIPE_NAME_PATTERN.source).toBe(names.pattern);
  });
  it.each(names.not.enum)('asRecipeName отвергает %s, как отвергает схема', (reserved) => {
    expect(() => asRecipeName(reserved)).toThrow(TypeError);   // red TODAY on constructor/prototype
  });
  ```
  The second block is red on the current code — which is the point; it reports a real defect
  (`src/ipc.ts:21-26` must add the reserved-name check, or the schema's `not.enum` must be
  restated there) rather than a test-only complaint.

- **TQ-2 · `packages/contracts/src/recipes.test.ts:10` + guards at `:19, :30, :36, :48, :56, :63` ·
  fails Q3 · Major.** `parseManifest` runs **once at module level** (line 10) and six of the
  seven cases open with `if (!result.ok) return;`. A test that `return`s having asserted nothing
  **passes** under vitest. So a broken `recipes/mcpproxy.yaml` — or a regression in
  `parseManifest`, `refine`, or the schema that makes the shipped recipe set stop loading —
  produces **one** red test (line 14, which throws) and **six silently green** ones. The suite
  reports 1/184 failing for a defect that voids the entire recipe contract, and the six cases
  that carry the actual invariants (И2 argv splitting, the risk-tier table, exactly-one-high-risk,
  the matcher map, the `toTool` projection) report success while having executed no assertion.
  This is the guard-clause-as-silent-skip pattern verbatim.
  **Fix:** parse once in a `beforeAll` and *narrow by throwing*, so the type-narrowing that the
  guards exist to provide comes from a failing assertion rather than from an early return:
  ```ts
  function loaded(): { manifest: Manifest; matchers: ReadonlyMap<string, PatternMatcher> } {
    if (!result.ok) {
      throw new Error(result.diagnostics.map((d) => `${d.pointer}: ${d.message}`).join('\n'));
    }
    return result;
  }
  it('argv параметра pattern — два отдельных элемента', () => {
    expect(loaded().manifest.tools.run_tests?.params?.pattern?.argv).toEqual(['--testPathPattern', '{}']);
  });
  ```
  Every case then goes red on a broken manifest, and each still names its own invariant in the
  failure. (The same `if (!result.ok) return;` shape appears in `validate/parse.test.ts` and
  `validate/regex.test.ts` — there it is **fine**, because in every instance it is preceded by an
  `expect(result.ok).toBe(true/false)` on the same line-adjacent statement, so the failure is
  already loud before the return. `recipes.test.ts` is the only file where the guard stands alone.)

- **TQ-3 · `packages/contracts/src/otlp.test.ts:132-137` · fails Q3 · Major.**
  Three negative assertions — `keys` must not contain `mcpproxy.argv`, `mcpproxy.cwd`,
  `mcpproxy.risk.tier` — with **no paired positive control anywhere in the file**. `grep` for
  `mcpproxy\.` across `otlp.test.ts` returns exactly four hits: line 129 (`output.bytes`) and
  these three negatives. So of the eighteen conditional attributes emitted by
  `src/otlp.ts:92-116`, only `mcpproxy.output.bytes` is ever asserted **present**. Delete
  `src/otlp.ts:94` (`mcpproxy.argv`), `:95` (`mcpproxy.cwd`) and `:103` (`mcpproxy.risk.tier`)
  and the entire 184-test suite stays green — the exporter would silently stop emitting the argv
  that scenario S8's approval UI and the audit log depend on, and nothing reports it. That is the
  literal answer to "which line of production code, if deleted, turns this test red?" — none.
  **Fix:** give the negatives their control in the same describe, asserting the *values* so a
  rename is caught too:
  ```ts
  it('полный вызов несёт argv, cwd и тир — контроль к проверке ниже', () => {
    const attrs = toOtlp(FULL).attributes;
    expect(attrs.find((a) => a.key === 'mcpproxy.argv')?.value.arrayValue?.values.map((v) => v.stringValue))
      .toEqual(['/opt/homebrew/bin/pnpm', 'test', '--testPathPattern', 'auth']);
    expect(attrs.find((a) => a.key === 'mcpproxy.cwd')?.value.stringValue).toBe('/Users/u/proj');
    expect(attrs.find((a) => a.key === 'mcpproxy.risk.tier')?.value.stringValue).toBe('medium');
  });
  ```
  Ideally extend the same treatment to `mcpproxy.env.allowed`, `sandbox.mode`,
  `sandbox.violations`, `approval.*`, `exit.*`, `redactions` and `duration.overhead_ms`, none of
  which any test asserts present today.

- **TQ-4 · `packages/contracts/src/deps.test.ts:74-79` · fails Q3 · Major.**
  «не ссылается на них и в `.d.ts`» is a negative assertion over `walk(dist/index.d.ts, '.d.ts')`,
  and the `.d.ts` branch of `specifiersOf` (`deps.test.ts:50-54`, the regex fallback — a *second*
  copy of the extraction logic, distinct from the `es-module-lexer` path) has **no positive
  control**. The `.js` branch has two (`deps.test.ts:81-93`, asserting `yaml`/`re2`/`ajv` and
  `['node:crypto']` are actually found) plus an emptiness guard at `:66`; the `.d.ts` branch has
  neither. I verified this by running an exact copy of the test's `walk` against the real
  `dist/`, once intact and once with the `.d.ts` branch stubbed to `return []`:
  ```
  mode=real    files=13 bare=[] forbiddenHits=[]
  mode=broken  files=1  bare=[] forbiddenHits=[]   ← test still passes
  ```
  With the extractor dead the walk visits a single file and the filter is still `[]`, so the
  R3/Ф6 guarantee for declarations — a consumer without the validator installed must still
  compile — is asserted by nothing. A leaked `import type { ErrorObject } from 'ajv'` in a
  root-reachable `.d.ts` would ship green.
  **Fix:** add the missing emptiness control next to the existing `.js` one, so the `.d.ts`
  traversal must demonstrably reach the graph before its negative means anything:
  ```ts
  it('граф деклараций тоже собран — иначе проверка ниже пуста', () => {
    expect(walk(resolve(distRoot, 'index.d.ts'), '.d.ts').files.length).toBeGreaterThan(10);
  });
  ```
  (13 today; `>10` leaves room for growth while still failing on a dead extractor.)

- **TQ-5 · `packages/contracts/src/audit/chain.test.ts:110-117` and `:119-128` · fails Q6 · Major.**
  Both cases claim to test the **prev-link** half of the frozen predicate — «генезис обязан иметь
  `prev: null`» and «перестановка `prev` двух соседних записей ловится» — but neither recomputes
  `self` after moving `prev`. Since `chainHash` takes `prev` as an argument
  (`src/audit/chain.ts:35-37`), changing `chain.prev` while leaving `chain.self` alone breaks the
  **second** half of the predicate (`chain.ts:75`), and that is what actually produces the
  expected `brokenAt`. Delete `src/audit/chain.ts:72-73` (the `expectedPrev` comparison) and both
  tests stay **green** — as does the whole file except line 88. The handoff table's row 9 says
  exactly this («предикат цепочки сведён к самосогласованности → **только** кейс "компетентный
  атакующий"»), which is honest, but it means these two cases are decoration dressed as coverage:
  they assert a generic invariant (the digest binds `prev`) instead of the scenario their names
  promise (the ordering rule). The one test that is genuinely load-bearing here is line 76-89,
  and it should not be alone.
  **Fix:** recompute `self` so only the link rule can fail:
  ```ts
  it('генезис обязан иметь prev: null', () => {
    const events = chainOf(2);
    const target = events[0];
    if (target === undefined) throw new Error('фикстура пуста');
    const forged = 'b'.repeat(64);
    // self пересчитан под подменённый prev: краснеет ТОЛЬКО правило «genesis.prev === null».
    events[0] = { ...target, chain: { prev: forged, self: chainHash(unchain(target), forged) } };
    expect(verifyChain(events)).toEqual({ ok: false, brokenAt: 0 });
  });
  ```
  and, for the permutation case, rebuild both records' `self` from their swapped `prev` the same
  way, so it fails on the link rather than on the digest.

- **TQ-6 · `packages/contracts/src/otlp.test.ts:65` · fails Q2 · Medium.**
  `expect(span.startTimeUnixNano).toBe(isoToUnixNano('2026-08-27T10:00:00.000000Z'))` compares
  `toOtlp`'s output against the very function `toOtlp` calls to produce it
  (`src/otlp.ts:124`). Any epoch bug in `isoToUnixNano` moves both sides together. The sibling at
  line 69 checks only the *difference* of the two timestamps, so it catches a scale error but not
  an offset one: mutate `src/otlp.ts:58` to `const seconds = BigInt(Math.floor(ms / 1000)) + 1n;`
  and every test in the file stays green while every exported span is a second off — invisible in
  OTLP, where the receiver has no second opinion about the timestamp.
  **Fix:** pin the absolute value as an independent literal (computed here from the epoch, not
  from the function under test):
  ```ts
  expect(span.startTimeUnixNano).toBe('1787824800000000000');
  expect(span.endTimeUnixNano).toBe('1787824812412500000');
  ```
  Keep line 69 as-is — with an absolute anchor it becomes a genuine second check.

- **TQ-7 · `packages/contracts/src/lock.test.ts:207-211` · fails Q2 · Medium.**
  «снапшот в lock — это то, из чего строится сторона "было"» compares
  `lock.tools.publish_release.snapshot.own` with `normalizeRecipe(PUBLISH, DEFAULTS).own` — but
  `lock` comes from the test's own `lockOf` helper, whose line 45 *is*
  `normalizeRecipe(recipe, manifest.defaults)`. The assertion is `f(x) === f(x)` routed through a
  local helper. It passes if `normalizeRecipe` returns `{}`, and it says nothing about the real
  invariant, which is that `diffLock`'s `was` side is read from the lock's stored snapshot rather
  than reconstructed from the current manifest.
  **Fix:** assert the invariant that is actually at risk — that `was` survives when the current
  manifest can no longer produce it — by handing `diffLock` a lock whose snapshot differs from
  anything derivable from the new manifest:
  ```ts
  it('сторона «было» читается из снапшота lock, а не пересобирается из манифеста', () => {
    const stale = lockOf(manifestOf({ ...BASE.tools, publish_release: { ...PUBLISH, description: 'СТАРОЕ' } }));
    const diff = diffLock(stale, BASE);
    expect(diff.changed[0]?.was.own.description).toBe('СТАРОЕ');       // only the snapshot has this
    expect(diff.changed[0]?.is.own.description).toBe('Опубликовать релиз');
  });
  ```

- **TQ-8 · `packages/contracts/src/approval.test.ts:49-52`, `:59-70`, `:76-103` · fails Q3 · Medium.**
  Three cases assert properties of their own literal fixture. `expect(request.argv).toHaveLength(3)`
  (line 50) and `expect(request.profile.network?.allow).toEqual([...])` (line 51) restate the
  object declared at lines 38-47. `expect(() => new Date(verdict.expiresAt ?? '')).not.toThrow()`
  (line 68) can never fail — `new Date('')` returns Invalid Date, it does not throw — and line 69
  parses a literal the test itself wrote. `expect(event.approval?.sessionId).toBe(event.sessionId)`
  (line 102) compares two fields the fixture assigned from the same `sessionId` const, so it
  proves the fixture is self-consistent, not that any production code keeps them so. For all
  three, no production line's deletion turns them red — `approval.ts` contains only type
  declarations, and those are enforced by `tsc -b` (which does cover `*.test.ts`, since
  `packages/contracts/tsconfig.json` includes `src/**/*.ts`), not by these `expect`s.
  **Fix:** either delete the runtime `expect`s and keep the type-level guarantee — the file
  already does this correctly at lines 55-56, 73 (`expectTypeOf`) and 114, 120
  (`@ts-expect-error`), which *are* load-bearing under `tsc -b` — or make them assert something
  executable. The И8 case at line 76-103 is the one worth converting: it is currently the only
  place «`approval.sessionId` равен `sessionId` события» is stated, and nothing enforces it. Add
  the executable form:
  ```ts
  it('argsHash вердикта покрывает ту же пару, что показали человеку', () => {
    expect(argsHash(recipeName, { tag: 'v1.0.0' })).toBe(request.argsHash);
    expect(argsHash(asRecipeName('run_tests'), { tag: 'v1.0.0' })).not.toBe(request.argsHash);
  });
  ```
  and leave the session-scoping claim to E5, where a predicate will exist to test.

- **TQ-9 · `packages/contracts/src/lock.test.ts:104-106` (and the file's hash assertions generally) ·
  fails Q3 · Medium.** `audit/chain.ts` has its formula frozen by a golden vector
  (`chain.test.ts:45`, a literal 64-hex digest). `recipeHash` and `manifestHash` — the other two
  digests the module doc calls «замороженные», and the ones that decide whether a lock drift is a
  hard stop — have **none**. Every assertion about them in `lock.test.ts` is *relative*: shape
  (`:105`, `/^[0-9a-f]{64}$/`), equality between two computed hashes (`:65`, `:101`, `:143`,
  `:151`), or inequality between two computed hashes (`:73`, `:95`, `:158`, `:163`). Reorder the
  keys inside the `own` block of `src/lock.ts`'s `normalizeRecipe`, or change what
  `manifestHash` feeds into `canonicalizeJcs`, and every relation still holds — the whole file
  stays green while every previously issued lock file in the wild becomes unverifiable. For an
  epic whose entire deliverable is a freeze, that is the freeze not actually being frozen.
  **Fix:** add the same kind of vector `chain.test.ts:45` already has, one per formula:
  ```ts
  it('recipeHash — замороженный вектор, а не «какой получился»', () => {
    expect(recipeHash(normalizeRecipe(PUBLISH, DEFAULTS))).toBe('<64 hex, вписать из первого прогона>');
  });
  it('manifestHash — замороженный вектор', () => {
    expect(manifestHash(BASE)).toBe('<64 hex>');
  });
  ```
  The literal must be pasted from a run and then treated like `api-surface.snapshot.txt` — changed
  only with an explicit owner decision and a `CONTRACTS_VERSION` bump.

- **TQ-10 · `packages/contracts/src/schema.test.ts:87-128` · fails Q3 · Minor (50).**
  Five rejection cases run their manifest through `withTools` (`schema.test.ts:33-36`, a regex
  substitution into `VALID_MANIFEST`), and each asserts only `validate(manifest) === false`. The
  only positive control in the file (`:82-85`) bypasses `withTools` entirely. Nothing proves that
  a *benign* substitution through that path still validates, so a future tightening of the schema
  that made the shared `{"ok": {"description": "x", "exec": ["true"], …}}` skeleton invalid would
  turn all five into false greens that pass for the wrong reason. I checked it is **not** vacuous
  today — I ran ajv on the real schema with
  `withTools('{"ok": {"description": "x", "exec": ["true"], "params": {"p": {"type": "boolean"}}}}')`
  and got `true` with no errors — which is why this is Minor rather than Major.
  **Fix:** one line, in the same describe, so the skeleton is verified rather than assumed:
  ```ts
  it('скелет подстановки сам по себе валиден — контроль к пяти отказам ниже', () => {
    const manifest = withTools('{"ok": {"description": "x", "exec": ["true"], "params": {"p": {"type": "boolean"}}}}');
    expect(ajv().compile(schema)(manifest)).toBe(true);
  });
  ```

- **`api-surface.test.ts:83-86` · fails Q3 · Minor (50), noted deliberately without a Major
  score.** The freeze gate contains an env-var escape hatch: `if (process.env.UPDATE_API_SURFACE === '1') { writeFileSync(SNAPSHOT, current); return; }`.
  A test that returns having asserted nothing passes. So with that variable exported in a shell —
  or set once in a CI job that later runs the suite — the freeze gate rewrites the snapshot to
  match whatever the surface has become and reports green, which is precisely the failure mode
  the file's own header calls «фраза в документе». The mechanism is documented and intentional,
  and today nothing sets the variable, hence Minor; but a gate that can self-approve from the
  environment is not a gate.
  **Fix:** move the update out of the test runner, into a script that cannot be reached by
  `vitest run` — `node scripts/update-api-surface.mjs`, importing the same `currentApiSurface()`
  from a plain module that both the script and the test consume — and delete the branch from the
  test. If the branch must stay, make it assert rather than return:
  `expect(process.env.CI).toBeUndefined();` before writing, so a CI run with the variable set is
  red instead of silently self-approving.

## Audit of the twelve-row mutation table in `handoff-notes.md:78-91`

Each row was checked against the test it names; the question asked was "would that test really
go red under that mutation", not "is the claim plausible".

| # | Claimed mutation → red | Verdict |
|---|---|---|
| 1 | `'violation'` out of `stageOrder` → `domain.test.ts`, 2 cases | **Holds.** `Stage` (`domain.ts:12-24`) is a hand-written union independent of `stageOrder`, so the mutation compiles; `domain.test.ts:35` and `:42-43` both go red. Exactly 2. |
| 2 | `readOnly` stops overriding `destructiveHint` → exactly one tier case | **Holds only for a narrow mutation.** Guarding line 40 of `annotations.ts` as `if (readOnly && !annotations.destructiveHint)` reddens exactly one case (`annotations.test.ts:8`). The coarser mutation — moving the `readOnly` check below the destructive/openWorld read — reddens **two** (`:7` and `:8`). The row is true as written but is not the general statement it reads as. Not a finding. |
| 3 | `not/enum` removed from `propertyNames` → the `constructor` case | **Holds, for both copies.** The schema has two such nodes (`:18-21` tools, `:56-59` params); removing the params one reddens `schema.test.ts:95`, removing the tools one reddens `validate/parse.test.ts:124`. Worth knowing: `schema.test.ts:87` («отвергает рецепт с именем `__proto__`») is **not** a test of `not/enum` — `__proto__` fails the leading-`[a-z]` pattern anyway — so that case would stay green. See TQ-1. |
| 4 | `%YAML` directive refusal removed → the `%YAML 1.1` case | **Holds.** `validate/parse.test.ts:137-143` asserts both `ok === false` and that the message contains `%YAML`. |
| 5 | `discriminator: false` → 8 diagnostics instead of 1 | **Holds.** `validate/parse.test.ts:74` is `toHaveLength(1)`. |
| 6 | `code.regExp` removed → the RE2-wiring case, and **nothing** before `AJV_OPTIONS` was extracted | **Holds.** `validate/regex.test.ts:85-88` compiles a lookahead schema through the real `AJV_OPTIONS` and requires a throw; `parse.test.ts:221` goes through `compilePattern`, not ajv, so it would indeed stay green. The stated reason for the extraction is sound. |
| 7 | empty-`deny` rule removed → the `read: {deny: []}` case | **Holds.** `validate/refine.test.ts:151-162`, message-asserted. |
| 8 | `trace_id` instead of `traceId` → the R14 test | **Holds, twice over.** `otlp.test.ts:88` (no field name may contain `_`) and `otlp.test.ts:56` both go red. |
| 9 | chain predicate reduced to self-consistency → **only** the competent-attacker case | **Holds — and that is the finding.** I traced all six `verifyChain` cases under the mutation: `:71` green, `:76` **red**, `:91` green, `:100` green, `:110` green, `:119` green. The row is accurate; what it exposes is that `:110` and `:119` do not test the rule they are named for. See TQ-5. |
| 10 | `deny` merged by replacement → the additional-`deny` case | **Holds** for `lock.test.ts:121-129`. The row understates slightly: `lock.test.ts:110-114` and `:116-119` would very likely go red too, since `ANALYZE_LOGS` declares no `deny` and replacement would drop the three default entries. Understating what goes red is not a defect. |
| 11 | `argv` collapsed into one element → the И2 case in the recipes | **Holds** — `recipes.test.ts:31` fails on `toEqual(['--testPathPattern', '{}'])`, because the manifest still parses and the guard at `:30` therefore does not fire. Note this row is only true *because* the mutation leaves the manifest loadable; a mutation that broke loading would be reported by one test instead of seven (TQ-2). |
| 12 | an export added to `mcp.ts` → the surface snapshot | **Holds.** `mcp.d.ts` is reachable from `index.d.ts` (`MCP_PROTOCOL_VERSION` appears at `api-surface.snapshot.txt:773`), so `api-surface.test.ts:87` goes red. |

**Row to flag: none is false.** The two rows worth reading with an asterisk are **2** (true only
for the narrower of two obvious mutations) and **9** (true, and its truth is the evidence for
TQ-5). Everything else I could verify without touching the tree checks out.

## Verdict

Nine of the fifteen files are, on these six questions, better than what this pass usually sees:
literal expectations instead of derived ones (`domain.test.ts:11-25`, `otlp.test.ts:158`),
explicit emptiness guards written *because* an empty graph would be green
(`deps.test.ts:62-67`, `api-surface.test.ts:71-73`), a frozen digest vector
(`chain.test.ts:45`), the RFC trap documented in the test that pins it
(`jcs.test.ts:88-95`), a deliberate paired positive control for a negative
(`otlp.test.ts:91-95`, `regex.test.ts:81-89`), and a compiler-enforced exhaustiveness check that
fails before vitest starts (`domain.test.ts:29-31`). Q1, Q4 and Q5 are clean outright.

But five Major findings are false-green surfaces on exactly the code E0 exists to freeze: the
`.d.ts` half of the dependency firewall asserts nothing (TQ-4, proven by execution), three of the
exporter's conditional attributes are only ever asserted *absent* (TQ-3), the recipe suite
degrades to one red test out of seven (TQ-2), two of the six chain cases are decoration (TQ-5),
and the drift check that gives the two copies of `RECIPE_NAME_PATTERN` permission to exist is
blind to the half where they have **already drifted** (TQ-1). TQ-1 is not a hypothetical: the
freeze ships with `asRecipeName('constructor')` accepting a name the loader rejects, under a
green test named «две копии не разъехались».

TQ-FLAKY

## Раунд 2 — дельта bf386fc

codeTree anchor: `0e6741babdd7a716f6ed71d6c607898f6f4f2f00`

Дифф: `def7d01..bf386fc`. Прогон: 16 файлов / **213 тестов**, все зелёные (было 184 — то есть
дельта добавила 29 кейсов). Проверялось два вопроса: закрыты ли одиннадцать замечаний раунда 1
**по коду**, а не по формулировке коммита, и выдерживают ли шесть вопросов сами добавленные и
изменённые кейсы, которых не видел ни один ревьюер.

### Раунд 1 — что закрыто и чем это доказано

- **TQ-1 — закрыто, и закрыто глубже, чем просилось.** `tool.test.ts:130-147` читает **обе**
  половины `propertyNames` прямо из файла схемы, сверяет паттерн (`:138`), сверяет множество
  зарезервированных имён (`:142`) и гоняет `it.each(names.not.enum)` (`:145`). Дефект,
  который тест раньше не видел, действительно починен в продакшене: `src/ipc.ts:31`
  (`RESERVED_RECIPE_NAMES`) и `src/ipc.ts:35-37` — теперь `asRecipeName('constructor')`
  бросает. Удалите `src/ipc.ts:35-37` — краснеют два кейса из трёх в `it.each`; удалите
  `RESERVED_RECIPE_NAMES` — краснеет ещё и `:141`. Кейс `__proto__` по-прежнему падает на
  паттерне, но он больше не единственный.
- **TQ-2 — закрыто.** `recipes.test.ts:22-27` — `loaded()`, бросающий с конкатенацией
  диагностик; все семь кейсов дёргают его. Поломка `recipes/mcpproxy.yaml` теперь даёт 7
  красных, а не 1 красный и 6 молча зелёных. (`recipes.test.ts:31` — `expect(loaded().ok)` —
  тавтология после сужения, но несущий тут бросок, а не `expect`; ниже порога.)
- **TQ-3 — закрыто с запасом.** `otlp.test.ts:161-182` утверждает **значения** одиннадцати
  атрибутов, включая все три, которые раньше проверялись только на отсутствие, плюс
  `env.allowed`, `sandbox.mode`, `sandbox.violations.count`, `approval.channel`, `exit.code`,
  `redactions.count`, `duration.overhead_ms`. Удалите `src/otlp.ts:115` — красный.
- **TQ-4 — закрыто.** `deps.test.ts:74-79`, `files.length > 10` (сегодня 13).
- **TQ-5 — закрыто, и проверено на обе стороны.** `chain.test.ts:121` и `:131-132`
  пересчитывают `self` через `chainHash(unchain(...), forged)`. Я прогнал предикат по обоим
  кейсам: с удалённой `src/audit/chain.ts:72-73` оба возвращают `{ok: true}` вместо
  ожидаемого `brokenAt` — то есть теперь красным их делает **только** правило связи, чего и
  требовалось.
- **TQ-6 — закрыто, литералы верны.** Пересчитал от эпохи независимо от кода:
  `2026-08-27T10:00:00.000000Z` → `1787824800000000000`, `2026-08-27T10:00:12.412500Z` →
  `1787824812412500000`. Совпадает с `otlp.test.ts:71-72` посимвольно. Сдвиг на секунду в
  `src/otlp.ts:78` теперь красный.
- **TQ-7 — закрыто.** `lock.test.ts:233-244`: `stale` собран из манифеста, которого больше нет,
  и `was.own.description === 'СТАРОЕ ОПИСАНИЕ'` из текущего манифеста невыводимо.
- **TQ-8 — закрыто частично (см. TQ-14).** `approval.test.ts:49-57` стал исполняемым и
  различает и аргументы, и имя рецепта. Кейс `:64-78` — нет.
- **TQ-9 — закрыто, и векторы настоящие.** Это единственное, что стоило проверять руками, и я
  проверил не «проходит ли тест», а «совпадает ли литерал с ФОРМУЛОЙ». Написал с нуля RFC 8785
  на Python (сортировка по кодовым единицам, `JSON.stringify`-совместимые числа) и сложил
  `own` / `normalizeManifest` по документации `lock.ts`, не запуская пакетный код:

  | вектор | независимый пересчёт | литерал в тесте |
  |---|---|---|
  | `recipeHash(normalizeRecipe(PUBLISH, DEFAULTS))` | `e3ce3979…80a7bc` | `lock.test.ts:262` — совпал |
  | `manifestHash(BASE)` | `8ac47ac8…ae22f6` | `lock.test.ts:266` — совпал |
  | `chainHash(event(0), null)` | `ba1bb478…a0c98b` | `chain.test.ts:47` — совпал |

  Векторы вписаны из настоящего прогона и соответствуют задокументированной формуле, а не
  «тому, что вернул код». Заморозка стала заморозкой.
- **Замечание про api-surface — закрыто ровно так, как предлагалось.** Ветки
  `UPDATE_API_SURFACE` в дереве больше нет (`grep` — ноль вхождений); `currentApiSurface()`
  живёт в `src/api-surface.ts`, запись — в `scripts/update-api-surface.mjs`, который
  импортирует `dist/api-surface.js` и до которого `vitest run` не дотягивается. Модуль не
  экспортируется ни одним из трёх входов, поэтому в снапшот себя не добавил.
- **TQ-10 — закрыто.** `schema.test.ts:87-95`.

### Два замороженных артефакта (вопрос 3) — сдвинулись по форме, а не под красный тест

Это единственное место, где «регенерировали, пока не позеленело» неотличимо от честного
обновления на глаз, поэтому проверялось исполнением, а не чтением.

- **Золотой вектор `chainHash`.** Скормил своей независимой реализации JCS **старую** фикстуру
  `event(0)` — ту же, но без `schema` и `protocolVersion`, — и получил
  `e3c9b24988339f0edd262b826e339cf58fc33296a08f3a63569239bd19008197`, то есть **ровно тот
  вектор, что стоял до коммита**; новая фикстура с двумя полями даёт `ba1bb478…`. Формула
  `sha256(utf8(jcs({prev, event})))` не менялась: сдвинулась форма `AuditEvent`, и вектор
  сдвинулся строго на неё. Регрессию в базовую линию не нормализовали.
- **`api-surface.snapshot.txt`.** Дифф снапшота — это ровно новые экспорты и изменённые формы:
  `verifyLockEntries`, `RESERVED_RECIPE_NAMES`, `JCS_MAX_DEPTH = 128`,
  `OUTPUT_MAX_BYTES_DEFAULT = 65536`, `parseLockFile` / `ParseLockResult`, `DiagnosticCode`,
  `Diagnostic.code`, `AuditEvent.schema` / `.protocolVersion`, `LockFile.version: 2`,
  `OtlpSpan.status`, `Redaction.stream` расширенный до четырёх членов. Ни одно **удаление**
  экспорта в дифф не попало, кроме одного JSDoc-блока над `isoToUnixNano` (у него теперь два
  стоящих подряд комментария, а declaration emit печатает последний) — сама декларация на
  месте, `api-surface.snapshot.txt:910`. Ничего не «уехало тихо».

### Находки по добавленным и изменённым кейсам

- **TQ-11 · `packages/contracts/src/types.ts:41-52` (`DiagnosticCode`) и все пять мест его
  присвоения · fails Q3 · Major.** Коммит добавляет обязательное поле `Diagnostic.code` и
  замораживает пятичленный юнион, объяснив его так: «Ветвиться потребитель обязан по нему»,
  «без кода семь эпиков ветвились бы `String.includes` по прозе». Исполняемо это утверждение
  **нигде**. `grep` по всем `*.test.ts` даёт ровно одну проверку кода —
  `validate/lock.test.ts:69`, `expect(result.diagnostics[0]?.code).toBe('schema')`, — и она
  вакуумна: в `validate/lock.ts:37` `code: 'schema'` зашит в единственный хелпер `at`, то есть
  утверждается константа, а не выбор ветки. Коды `'yaml'`, `'size-limit'`, `'invariant'` и
  `'pattern'` не встречаются в тестах ни разу.
  **Мутации, которые оставляют все 213 тестов зелёными** (главной сессии — сломать любую одну):
  `src/validate/yaml.ts:22` `'size-limit'` → `'yaml'`; `src/validate/index.ts:23`
  `code: 'schema'` → `'invariant'`; `src/validate/refine.ts:177` `'invariant'` → `'schema'`;
  `src/validate/index.ts:53` `'pattern'` → `'schema'`. Ни одна не краснеет. Замороженный
  контракт, по которому семь эпиков будут ветвить решения, не имеет ни одного кейса, и первая
  же перестановка кодов при рефакторинге уедет молча — ровно тот дефект, от которого поле и
  заводилось.
  **Fix (по кейсу на код, в `validate/parse.test.ts`, где все четыре пути уже воспроизводятся
  существующими фикстурами — добавляется одна строка к каждому):**
  ```ts
  it.each([
    // [что подаём, ожидаемый код] — таблица и есть замороженный контракт ветвления
    [oversized, 'size-limit'],
    ['%YAML 1.1\n---\nversion: 1\n', 'yaml'],
    [missingRequiredProperty, 'schema'],
    [execWithSlot, 'invariant'],
    [lookaheadPattern, 'pattern'],
  ])('диагностика несёт код %#, по которому ветвится потребитель', (text, code) => {
    const result = parseManifest(text, SOURCE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('фикстура обязана быть отвергнута');
    expect(result.diagnostics.map((one) => one.code)).toContain(code);
  });
  ```
  Отдельно: `parseLockFile` метит **любую** диагностику как `'schema'`, включая «lock не
  разобран как JSON» и несовпадение версии, — то есть на пути `lock_check` потребитель по коду
  не отличит битый файл от файла прежней ревизии. Это и делает `validate/lock.test.ts:69`
  бессмысленным. Либо `validate/lock.ts:37` обязан принимать код параметром (`'yaml'` для
  непарсящегося JSON), либо кейс `:69` должен утверждать что-то другое.

- **TQ-12 · `packages/contracts/src/validate/index.ts:53-59` · fails Q3 · Major.** Коммит
  добавляет санитизацию сообщения RE2 — `sanitizeDescription(compiled.reason).text` — с
  явно записанным доводом: `reason` дословно эхоит фрагмент недоверенного паттерна, и без
  санитизации bidi-override и ANSI-escape «доехали бы до глаз и до терминала». Тестом эта
  правка не сопровождена ни одним. `validate/refine.test.ts:139-147` и
  `validate/regex.test.ts` подают паттерн `^(?=.*a)b$` — чистый ASCII, — и утверждают только,
  что сообщение содержит `RE2`. Уберите `sanitizeDescription(...)` из строки 58, оставив
  `${compiled.reason}` — 213 тестов зелёные, а защита, ради которой в `./validate` заведён
  импорт из `../tool.js`, держится ни на чём. Это та же категория, что TQ-3 в раунде 1:
  правка сделана, поведение не утверждено.
  **Fix — паттерн, который RE2 отвергнет, с ядом внутри самого фрагмента:**
  ```ts
  it('сообщение RE2 санитизировано — фрагмент паттерна недоверенный', () => {
    const result = load(`  x:
    description: "x"
    exec: ["./s.sh"]
    params: { p: { type: string, pattern: "^(?=${ch(0x202e)}\\u001b[31mA)b$" } }
`);
    expect(result.ok).toBe(false);
    const message = messagesOf(result).join('\n');
    expect(message).toContain('RE2');                    // контроль: путь тот самый
    expect(message).not.toContain(ch(0x202e));           // краснеет при удалении строки 58
    expect(message).not.toContain(ch(27));
  });
  ```
  (Если схемный `SafeText` отобьёт такой `pattern` раньше RE2 — тогда находка меняет адрес,
  но утверждение всё равно обязано быть: сегодня ни один кейс не отвечает на вопрос, какой
  из двух рубежей ловит яд в паттерне.)

- **TQ-13 · `packages/contracts/src/jcs.test.ts:120-122` · fails Q2/Q6 · Minor (50).**
  Кейс называется «на потолке ещё канонизирует» и подаёт `nest(JCS_MAX_DEPTH - 1)`, то есть
  **не** потолок: настоящий последний проходящий вход — `nest(128)`, первый бросающий —
  `nest(129)`. Замерил независимой копией логики (продакшен не трогал):
  ```
  op='>'   первое n, на котором бросает = 129 | nest(127)=ok nest(128)=ok    nest(133)=THROW
  op='>='  первое n, на котором бросает = 128 | nest(127)=ok nest(128)=THROW nest(133)=THROW
  ```
  То есть замена `src/jcs.ts:51` `depth > JCS_MAX_DEPTH` на `depth >= JCS_MAX_DEPTH` — сдвиг
  границы на единицу — оставляет **оба** кейса про глубину зелёными: нижний вход на два ниже
  границы, верхний на пять выше. Пара тестов, поставленная именно ради границы, границу не
  пиннит. (Соседний кейс `:139-142` про массивы при этом настоящий: он краснеет на удалении
  `depth + 1` в `src/jcs.ts:81`.)
  **Fix — два соседних входа, а не два далёких:**
  ```ts
  it('ровно на потолке ещё канонизирует, на потолке+1 — уже нет', () => {
    expect(() => canonicalizeJcs(nest(JCS_MAX_DEPTH))).not.toThrow();
    expect(() => canonicalizeJcs(nest(JCS_MAX_DEPTH + 1))).toThrow(TypeError);
  });
  ```

- **TQ-14 · `packages/contracts/src/approval.test.ts:64-78` · fails Q3 · Minor (50), перенос
  из TQ-8.** Раунд 1 предлагал по этим кейсам развилку: либо убрать рантайм-`expect`ы и
  оставить типовую гарантию, либо сделать их исполняемыми. Для кейса `:49` выбрано второе и
  сделано хорошо. Кейс `:64-78` не сделал ни того, ни другого: недоказуемое
  `expect(() => new Date(…)).not.toThrow()` заменено на `Date.parse` и `toMatch(/Z$|…/)` —
  оба над строкой `'2026-08-27T10:10:00.000Z'`, которую тест сам написал шестью строками выше.
  Ни одна строка продакшена, будучи удалённой, их не краснит: `approval.ts` — только
  объявления типов. Кейс `:84-113` (`event.approval?.sessionId === event.sessionId`) остался
  как был — и это согласовано с раундом 1, где предикат отдан в E5; претензии к нему нет.
  **Fix — либо удалить оба `expect` (форму держит `tsc -b`, который видит `*.test.ts`), либо
  привязать к коду, который уже есть в пакете и умеет отличать абсолютное время от
  относительного:**
  ```ts
  it('вердикт со скоупом until несёт абсолютное время, а не TTL', () => {
    // `isoToUnixNano` — единственная в пакете исполняемая проверка «ISO с зоной».
    expect(() => isoToUnixNano(verdict.expiresAt ?? '')).not.toThrow();
    expect(() => isoToUnixNano('600s')).toThrow(TypeError);  // TTL формой невыразим
  });
  ```

### Ниже порога, названо один раз, чтобы не переоткрывали

- `lock.test.ts:163` сверяет `silent.output.maxBytes` с `OUTPUT_MAX_BYTES_DEFAULT`, то есть с
  константой из тестируемого модуля: смена `65_536` на `1` кейс не роняет. Спасает то, что
  значение вморожено в `api-surface.snapshot.txt` как
  `export declare const OUTPUT_MAX_BYTES_DEFAULT = 65536;` — но пиннит его гейт поверхности, а
  не тест про дефолты. Половина `redact: true` — настоящий литерал и настоящая проверка.
- `src/tool.ts:93` `.trimEnd()` после среза по кодовым точкам не покрыт: ни одна фикстура не
  даёт пробел ровно на границе `DESCRIPTION_MAX_LENGTH`.
- `validate/refine.test.ts:228-242` («пустой `defaults.deny` остаётся законным») ни одной
  строкой продакшена не краснеет — это забор против будущего расширения правила на defaults, и
  как парный контроль к кейсу `:206` он уместен. Не находка.
- Q1, Q4, Q5, Q6 по дельте чисты: ни `Date.now()`, ни таймеров, ни `.only`/`.skip`; единственное
  новое модульное состояние — `recipes.test.ts:10`, и оно как раз перестало быть дефектом.

### Вердикт дельты

Одиннадцать из одиннадцати замечаний раунда 1 закрыты кодом, а не формулировкой; три из них —
те, где «выглядит исправленным» и «исправлено» различимы только исполнением (эпохальные
литералы, три золотых вектора, сдвинувшийся `chainHash`) — проверены независимым пересчётом с
нуля и сошлись до символа. Оба замороженных артефакта сдвинулись строго по изменению формы:
старая фикстура `AuditEvent` даёт ровно прежний вектор `e3c9b249…`, то есть формула цепочки не
трогалась. Двадцать девять новых кейсов в среднем держат свои утверждения на реальных строках
продакшена, а два из них — паритет `propertyNames` и `mcp.protocol.version` из события —
сильнее, чем просилось.

Открытыми остаются два Major, и оба одного класса: правка сделана, поведение не утверждено.
Новый замороженный `DiagnosticCode`, чья заявленная цель — ветвление семи эпиков, не имеет ни
одного исполняемого кейса и переживает перестановку любых двух кодов (TQ-11); санитизация
сообщения RE2, заведённая ради bidi и ANSI в глазах человека, снимается одной правкой при 213
зелёных тестах (TQ-12). Плюс два Minor: граница глубины JCS не пиннится своим же тестом
(TQ-13) и один перенос из TQ-8 (TQ-14).

TQ-FLAKY

## Финальный проход — дерево b2a14a71

codeTree anchor: `b2a14a71e3176685b26e34e71ffe03713d531391`

Diff reviewed: `9efb749..de72b28` (`c0ff75d`, `bcf50c8`, `de72b28`), ветка `v2/e0-contracts`.
226 → 236 тестов, 16 файлов, все зелёные. Продакшен в рабочем дереве не тронут ни разу: все
мутации прогнаны на копии вне дерева (архив `HEAD` + симлинк на `node_modules`), после каждой
мутации файл возвращался и пересобирался. Ниже каждое «покраснело / не покраснело» — замер, а не
рассуждение; мутации названы точно, чтобы их можно было повторить.

### Четыре находки раунда 2 — что с ними стало

- **TQ-11 (`DiagnosticCode` без единого исполняемого кейса) — закрыто, и сильнее, чем просилось.**
  Блок `validate/refine.test.ts:262-300` даёт по кейсу на каждый из пяти манифестных кодов, и
  четыре из пяти утверждают `toEqual(['<код>'])` — то есть заодно и «ровно одна диагностика».
  Замер, каждая мутация по отдельности:
  `yaml.ts:30` `'size-limit'`→`'yaml'` — красный; `yaml.ts:49` `'yaml'`→`'invariant'` — красный;
  `validate/index.ts:25` `'schema'`→`'invariant'` — красный; `refine.ts:238` `'invariant'`→`'schema'`
  — красный; `validate/index.ts:53` `'pattern'`→`'schema'` — красный. Шестой член юниона —
  новый `'lock'`, и отдельная претензия раунда 2 («`parseLockFile` метит всё как `schema`, и
  потому `lock.test.ts:69` бессмыслен») закрыта в источнике: `validate/lock.ts:64` теперь
  выдаёт `'lock'`, а `lock.test.ts:71` это утверждает. Мутация `'lock'`→`'schema'` — красная.
- **TQ-12 (санитизация сообщения RE2 ни на чём не держалась) — закрыто, и правильным способом.**
  Санитизация переехала из точки вызова в единственный конструктор `diagnosticAt`
  (`validate/locate.ts:61`). Мутация `message: sanitizeDescription(message).text` → `message` роняет
  сразу два кейса: `refine.test.ts:308` (RE2) и `refine.test.ts:349` (имя переменной окружения).
  Проверил отдельно, что путь тот самый, а не подменённый схемой: `pattern` в `$defs.StringParam`
  объявлен голым `type: string`, и замер даёт `code=pattern`, `msg="pattern не компилируется
  движком RE2: invalid character class range: a-"` — то есть яд действительно доходит до RE2,
  оговорка раунда 2 про `SafeText` не сработала.
- **TQ-13 (граница глубины JCS не пиннилась своим же тестом) — закрыто.** `jcs.test.ts:120-126`
  теперь берёт `nest(JCS_MAX_DEPTH)` и `nest(JCS_MAX_DEPTH + 1)`. Мутация `jcs.ts:51`
  `depth > JCS_MAX_DEPTH` → `depth >= JCS_MAX_DEPTH` — красная. Ровно то, что раньше выживало.
- **TQ-14 (`approval.test.ts`, недоказуемые `expect` над собственным литералом) — закрыто
  наполовину.** Развилка раунда 2 была: убрать рантайм-`expect`ы или привязать к исполняемому
  коду. Привязка появилась — `isoToUnixNano(verdict.expiresAt)` в строке 83, — а вот вторая
  половина той же пары, `expect(() => isoToUnixNano('600s')).toThrow(TypeError)`, не появилась;
  вместо неё встала строка 80. Она и остаётся находкой — TQ-19 ниже.

### Находки прохода

- **TQ-15 · `packages/contracts/src/schema.test.ts:73-92` · fails Q3/Q6 · Minor (50).**
  Кейс называется «паттерн Duration и `durationToMs` согласованы — связку держит тест, а не
  совпадение». В одну сторону он её держит: мутация `src/lock.ts:37` до
  `^([0-9]{1,3})(ms|s|m|h)$` красная (`'999999999h'` из списка законных перестаёт разбираться),
  мутация схемы до `(ms|s|m)` тоже красная. В другую сторону — нет, и именно там, куда этот
  диапазон коммитов и правил. В списке отвергаемых `['120', '120sec', 's', '1.5s', '-1s', '', '1d']`
  нет ни одного входа, который разделял бы **только** предел цифр, а он и есть новинка `{1,9}`.
  Замер на реальном `dist/`: `durationToMs('9999999999s')` → `9999999999000` **без броска**, при
  `re.test('9999999999s') === false`. То есть две формы уже разошлись — сегодня, в этом дереве, —
  а тест, поставленный ровно ради «не разойдись», зелёный. Подтверждено и мутацией: откат схемы
  `{1,9}` → `+` этот кейс НЕ роняет (краснеет только соседний, про предел длины).
  Ущерб ограничен: опасное направление — «схема пропустила, `durationToMs` бросил», и оно как раз
  покрыто (`'999999999h'`), плюс в `refine.ts:161` стоит `catch`. Поэтому Minor, а не Major, — но
  утверждение теста строго сильнее того, что он держит.
  **Fix — сузить `durationToMs` до того же предела и внести разделяющий вход в список:**
  ```ts
  // src/lock.ts:37 — предел цифр обязан стоять по обе стороны связки, иначе «согласованы» ложь
  const match = /^([0-9]{1,9})(ms|s|m|h)$/.exec(duration);
  ```
  ```ts
  // schema.test.ts — вход, который разделяет ИМЕННО предел цифр, а не форму
  for (const value of ['120', '120sec', 's', '1.5s', '-1s', '', '1d', '9999999999s']) {
  ```
  Если сужать `durationToMs` не хотят — тогда кейс обязан перестать называться «согласованы» и
  утверждать асимметрию явно: `expect(re.test('9999999999s')).toBe(false)` рядом с
  `expect(durationToMs('9999999999s')).toBe(9_999_999_999_000)` и комментарием, почему схема строже.

- **TQ-16 · `packages/contracts/src/validate/refine.test.ts:308-319`, `:321-328`, `:349-357` ·
  fails Q3/Q6 · Minor (50).** Три кейса блока «текст диагностики безопасен для отрисовки» состоят
  **только** из утверждений об ОТСУТСТВИИ (`not.toContain(ESC)`, `not.toContain(BIDI)`) и не несут
  ни одного контроля, что ожидаемая диагностика вообще произведена. Сегодня они не вакуумны —
  замерил все три пути на реальном `dist/`: `code=pattern` с фрагментом паттерна в сообщении,
  `code=yaml` с вклеенной исходной строкой, `code=invariant` с именем `AB` в сообщении; мутации
  санитизации роняют все три. Но живут они на том, что путь не переехал: стоит `pattern` или
  `env.allow[]` получить в схеме `$ref: SafeText` — и яд отобьётся раньше, диагностика придёт от
  ajv (её текст данных не эхоит), а три кейса станут зелёными, ничего не проверяя. Это буквально
  тот дефект, который главная сессия уже поймала у себя в четвёртом кейсе этого же блока
  (`:330`, ajv-указатель) — и `:330` единственный, у кого контроль есть (`pointers.some((one) =>
  one.startsWith('tools.'))`). Соседям по блоку он положен по той же причине.
  **Fix — по одной строке на кейс, контроль ПЕРЕД отрицанием:**
  ```ts
  expect(unsafe(result)).toContain('RE2');            // :308 — путь тот самый, а не схемный
  expect(unsafe(result)).toContain('MISSING_CHAR');   // :321 — диагностика от doc.errors
  expect(unsafe(result)).toContain('AB');             // :349 — имя доехало, но уже без ESC
  ```

- **TQ-17 · `packages/contracts/src/validate/lock.test.ts:74-94` · fails Q3 · Minor (50).**
  Цикл по четырём крафтовым lock утверждает только `expect(result.ok, label).toBe(false)`, тогда
  как весь смысл кейса — в ПРИЧИНЕ: комментарий сам говорит, что каждый вход «проходил первую
  версию парсера и ронял `diffLock`», а у `canonicalizeJcs` пять разных оснований для `TypeError`.
  Сегодня причина верная — замерил, каждый вход даёт ровно одну диагностику:
  `defaults` → `defaults не канонизируется: вложенность глубже 128` / `…одиночный суррогат`,
  `tools.publish_release.snapshot.own` → `собственный блок не канонизируется: …`. И мутация
  «выкинуть `canonicalizable(value.snapshot.own)`» (`validate/lock.ts:105`) цикл роняет. Но
  утверждение к этому не привязано: добавьте завтра в `checkEntry` любое структурное требование к
  `snapshot.own` (скажем, «обязан нести `description`») — все четыре входа начнут падать по нему,
  цикл останется зелёным, и защиту от `TypeError` можно будет удалить незаметно.
  **Fix — таблица «вход → чем обязан быть отвергнут», а не таблица входов:**
  ```ts
  const crafted: Array<[string, unknown, string]> = [
    ['snapshot.own глубокий', {/* … */}, 'собственный блок не канонизируется: вложенность глубже'],
    ['defaults глубокий',     {/* … */}, 'defaults не канонизируется: вложенность глубже'],
    ['defaults суррогат',     {/* … */}, 'defaults не канонизируется: строка содержит одиночный суррогат'],
    ['snapshot.own суррогат', {/* … */}, 'собственный блок не канонизируется: строка содержит одиночный суррогат'],
  ];
  for (const [label, lock, reason] of crafted) {
    const result = parseLockFile(JSON.stringify(lock));
    expect(result.ok, label).toBe(false);
    if (result.ok) continue;
    expect(result.diagnostics.map((one) => one.message).join('\n'), label).toContain(reason);
  }
  ```
  Тот же дефект в двух местах помельче, чинится тем же движением и отдельными номерами не стоит:
  `validate/lock.test.ts:117` утверждает отсутствие `ESC` в указателях, но не утверждает, что
  указатель под отравленным ключом вообще произведён (замер даёт `tools.ab` — просится
  `toContain('tools.ab')`, как у брата `refine.test.ts:344`); `refine.test.ts:208` утверждает
  только `.ok === false`, тогда как его сосед `:192` утверждает сообщение.

- **TQ-18 · `packages/contracts/src/validate/refine.test.ts:238` · fails Q6 · Minor (50).**
  `expect(new RegExp('^[0-9]{1,9}(ms|s|m|h)$').test('999999999h')).toBe(true)` — литеральная копия
  паттерна схемы, а не чтение `$defs.Duration.pattern` из файла (как это правильно сделано в
  `schema.test.ts:65`). Строка стоит ради подзаголовка кейса «схема её пропускает», но проверяет
  собственную копию: сдвинется схема — строка продолжит утверждать регулярку, которой в схеме уже
  нет, и подзаголовок станет декоративным. Вдобавок она избыточна — то, что схема вход пропустила,
  уже доказано тем, что диагностика приходит с текстом «таймера платформы», а не схемная.
  **Fix — либо удалить строку, либо читать паттерн оттуда же, откуда его читает `schema.test.ts`.**

- **TQ-19 · `packages/contracts/src/approval.test.ts:80` · fails Q3 · Minor (50), перенос TQ-14.**
  `expect(verdict.expiresAt).not.toMatch(/^\d+(ms|s|m|h)$/)` — утверждение над строкой
  `'2026-08-27T10:10:00.000Z'`, которую тест сам написал восемью строками выше. Ни одна строка
  продакшена, будучи удалённой или изменённой, её не покраснит: `approval.ts` — только объявления
  типов. Раунд 2 предлагал ровно эту мысль, но исполнимой парой к строке 83; пара не поставлена.
  Строка 83 (`isoToUnixNano(verdict.expiresAt)`) при этом хороша и остаётся.
  **Fix — вторая половина пары, она и есть «TTL этой формой невыразим»:**
  ```ts
  expect(() => isoToUnixNano(verdict.expiresAt ?? '')).not.toThrow();
  expect(() => isoToUnixNano('600s')).toThrow(TypeError);  // проверено: ISO_WITH_ZONE отбивает
  ```

### Ниже порога, названо один раз, чтобы не переоткрывали

- `refine.ts:170` `ms > DURATION_MAX_MS` → `>=` выживает все 236 тестов. Это НЕ дефект кейса
  «граница пиннится соседними входами»: `2147483647ms` — десять цифр, а схема даёт девять, то
  есть точная граница через `parseManifest` невыразима вообще, и мутант эквивалентен по
  наблюдаемому поведению. Соседи в секундах отстоят на 1000 мс потому, что ближе взять неоткуда.
  Сам констант при этом пиннится: сдвиг `DURATION_MAX_MS` на +1000 роняет и этот кейс, и
  `api-surface.test.ts`.
- Ветка `catch` в `checkDuration` («не длительность: …») через `parseManifest` недостижима и не
  покрыта — это осознанная страховка на случай расхождения схемы с `durationToMs`, и комментарий
  говорит именно это. Краснеет только под мутацией (сужение `durationToMs` до трёх цифр).
- Блок «код диагностики» покрывает пять членов из шести, шестой (`'lock'`) — в `lock.test.ts:71`.
  Перечисления юниона нет, поэтому седьмой член приехал бы без кейса; спасает то, что добавление
  члена двигает `api-surface.snapshot.txt`, а это осознанное действие.
- Производитель кода `'yaml'` для директивы `%YAML` (`yaml.ts:41`) не покрыт: мутация его кода на
  `'schema'` зелёная. Член юниона при этом покрыт другим производителем (`doc.errors`).
- `durationToMs`, расширенный до единицы `d`, выживает — но всё равно бросает `TypeError` через
  `UNIT_MS`, то есть мутант поведенчески эквивалентен.
- Q1/Q4/Q5 по дельте чисты: ни `Date.now()`, ни таймеров, ни сна, ни сети; ни `.only`, ни `.skip`,
  ни `.todo`, ни `.fails` во всём пакете. Прогон с `--sequence.shuffle` на сидах 7 и 99 — 236
  зелёных оба раза; новое модульное состояние в изменённых файлах не заводится.

### Три замороженных артефакта — каждый сдвиг умышленный

- `c0ff75d` · схема и её копия внутри снапшота: `Duration.pattern` `^[0-9]+(ms|s|m|h)$` →
  `^[0-9]{1,9}(ms|s|m|h)$`. Изменение поведенческое и покрыто: `schema.test.ts:59-72` краснеет на
  откате. Оба места (файл схемы и врезка в `api-surface.snapshot.txt`) сдвинулись согласованно.
- `bcf50c8` · снапшот: добавлен `export declare const DURATION_MAX_MS = 2147483647` — прямое
  следствие нового экспорта в `src/lock.ts:29`. Покрыт: сдвиг константы роняет и снапшот, и
  `refine.test.ts:254-259`.
- `de72b28` · снапшот: только комментарии — контрактная заметка про `Diagnostic.pointer`
  («санитизирован, лоссовый, для поиска, не для `doc.getIn`») и исправление показателя степени
  `3.6·10¹²` → `3.6·10¹⁵`. Пересчитал: `999999999 × 3.6·10⁶ = 3.6·10¹⁵` — исправленное значение
  верное, прежнее было опечаткой. Поведения нет, форма поверхности не менялась.

### Вердикт дельты

Все четыре находки раунда 2 закрыты кодом; три из них — исполнением, а не формулировкой, и это
проверено мутациями, каждая из которых даёт именно тот красный, который раунд 2 предсказывал.
TQ-12 закрыт лучше, чем просилось: санитизация ушла в единственный конструктор диагностики, где её
нельзя забыть следующему производителю, и вместе с сообщением накрыла `pointer` — поле, которое
контракт называет ключом поиска в логе. TQ-14 закрыт наполовину и переносится как TQ-19.

Ни одного Major. Ни одного вакуумного кейса в дереве: все три подозрительных «утверждаю отсутствие»
проверены на реальном `dist/` и сегодня утверждают что-то настоящее. Пять Minor — все одного
класса: утверждение слабее заголовка. Кейс «согласованы» зелёный над реально существующим
расхождением (TQ-15); три кейса про яд держатся на том, что путь до них не переехал (TQ-16); цикл
про четыре крафтовых lock не привязан к причине, ради которой заведён (TQ-17); плюс копия паттерна
вместо чтения схемы (TQ-18) и один перенос (TQ-19). Ни одно из пяти не даёт ложного зелёного
сегодня — все пять дают его после первой же правки по соседству.

TQ-SOLID
