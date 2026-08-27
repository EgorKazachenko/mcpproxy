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
