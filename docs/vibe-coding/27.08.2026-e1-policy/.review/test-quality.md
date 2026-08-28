# Test-quality / anti-flake pass — E1 policy

codeTree: `05bbd0ce8611a2fbd63aab8b1c79a62498bdc3a7`

**Verdict: TQ-FLAKY** — two proven environment-coupled flake vectors and one test proven to be
decoration. Everything else in the twelve files is genuinely load-bearing; the mutations I ran
are recorded below.

## Gate

Fires. `git diff --name-only origin/main...HEAD` lists twelve new `*.test.ts` under
`packages/core/src/policy/`, two fixture modules (`policy.fixture.ts`, `watch.fixture.ts`) and
`packages/core/vitest.config.ts`. All read in full.

Baseline: `yarn workspace @mcpproxy/core test` → 13 files, 138 tests, green, 1.10 s.

## Mutations I ran (production edited, suite run, file reverted with `git checkout --`)

- **M1 — `packages/core/src/policy/watch.ts:97`, dropped `coalesced?.cancel();`** → RED, exactly one
  test: `watch.test.ts:144` (`expected 1 to be +0`). This is the calibration proof for `settle()`,
  see Q4 below.
- **M2 — `packages/core/src/policy/lock-check.ts:122`, neutered the input to `verifyLockEntries`
  (`{ ...lock.lock, tools: {} }`, always `ok`)** → RED, three tests, the whole
  `checkLock: verifyLockEntries обязателен` block (`lock-check.test.ts:89, 96, 110`). The
  contracts-built lock fixtures are inputs, not expectations; the block is not tautological.
- **M3 — `packages/core/vitest.config.ts`, deleted the `include: ['src/**/*.test.ts']` line** →
  still 138/138 GREEN. This is the R21 finding below.
- **M4 — probe, not a mutation: `touch stray-review-probe.txt` at the repo root** → RED,
  `boundary.test.ts:245` (`expected [ 'stray-review-probe.txt' ] to deeply equal []`). Probe file
  removed.

Working tree restored after each; see the closing note.

## Findings

### F1 — MAJOR · `boundary.test.ts:241-246` · Q5 (shared registry / real working tree) + Q6

```ts
it('рабочее дерево ветки не выходит за список', () => {
  const changed = changedPaths(repoRoot, 'origin/main');
  expect(changed.length).toBeGreaterThan(0);
  expect(pathViolations(changed, ALLOW_LIST)).toEqual([]);
});
```

`changedPaths` (`scan.ts:190`) runs `git status --porcelain --untracked-files=all` against the
**real repository**, so the entire `@mcpproxy/core` unit suite is a function of the developer's
uncommitted working tree and of the local ref store. Proven by M4: one untracked, non-ignored
file anywhere in the repo turns the suite red. The same test also goes red, not skipped, when:

- `origin/main` is not present — `scan.ts:184-187` deliberately throws, and a CI checkout with
  `fetch-depth: 1` (or any fetch of only the PR ref) has no `origin/main`;
- `origin/main` moves under a background `git fetch` while the suite runs, changing the merge
  base and therefore `changed`;
- another process holds `.git/index.lock` (an editor's git integration, a concurrent
  `git status`) — `execFileSync` gets a non-zero exit and the throw propagates.

This is the one thing the plan explicitly argued against for the pure half
(`plan.md:809-812`: "гонка между воркерами vitest, мусор после падения и транзиторное нарушение
R24 ровно в тот момент, когда R24 проверяется"), applied at repo scope by the thick half. It is
also a repo-policy assertion, not a unit invariant (Q6) — R24 is a property of the *branch*, and
it is checked on every `vitest run`, including the ones a developer runs mid-edit.

**Fix (restructure, not a retry):** keep `pathViolations`/`fixtureRepo` cases in vitest — they are
hermetic and good — and move the whole-repo assertion out of the unit suite into the executable
gate that already owns branch-scope checks (`docs/vibe-coding/27.08.2026-e1-policy/.gates/`,
i.e. a `gate-run` step invoking a tiny script that imports `changedPaths`/`pathViolations` from
`dist/policy/scan.js`). Concretely: delete `boundary.test.ts:241-246`, add
`packages/core/bin/mcpproxy-r24.mjs` (already inside the R24 allow list under
`packages/core/bin/**`) that exits non-zero on violations, and wire it into the gate. R24 keeps
its executable check, and `yarn test` stops depending on `git status`.

### F2 — MAJOR · `boundary.test.ts:177-198` (`fixtureRepo`) · Q5 (ambient shared config)

```ts
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
```

The fixture repo inherits the machine's **global and system** git config. `git commit` there
picks up `commit.gpgsign`, `gpg.format`, `core.hooksPath`, `commit.template`, `core.autocrlf`
and `init.templateDir`. On a developer with `commit.gpgsign = true` this either fails outright or
blocks on a passphrase prompt — and because `execFileSync` is **synchronous**, vitest cannot
apply its test timeout to it: the worker thread blocks and the whole run hangs rather than
failing. `commit.template` and a `core.hooksPath` pre-commit hook produce the same class of
failure. Four tests (`boundary.test.ts:211, 220, 232` plus the shared helper) sit on this.

**Fix:** isolate the fixture repo from ambient config by pinning the config files, in the helper:

```ts
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
```

`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` remove the whole class at once; the `timeout` converts a
hang into a red test. The existing `git('config', 'user.email', …)` calls stay and become the
*only* identity source, which is what the test already intends. Note this is not a "longer
timeout" — it is a bound where there is currently none.

### F3 — MAJOR · `runner.test.ts:23-25` · Q3 (passes if the feature is deleted)

```ts
it('обнаружил хотя бы один тестовый файл', () => {
  expect(testFiles.length).toBeGreaterThan(0);
});
```

`testFiles` is built by `readdirSync` over `packages/core` at module scope, and `runner.test.ts`
itself matches the filter. The assertion is therefore true whenever the file executes, and false
never — if the include pattern broke so badly that nothing ran, this file would not run either
and the test would vanish silently rather than fail. Vitest's own "no test files found" exit code
is the actual guard, not this `it`.

The file's docstring claims it catches "пустой набор файлов и файл, положенный мимо `include`",
and the spec (R21, `spec.md:302`) names the single `include` as the deliverable. **M3 falsifies
the first half**: deleting `include: ['src/**/*.test.ts']` from `vitest.config.ts` — the very
line this test is documented to guard — leaves all 138 tests green, because vitest's default
include still matches `src/**/*.test.ts`. Which line of production code, deleted, turns
`runner.test.ts:23` red? None.

The second `it` (`runner.test.ts:27-30`, "нет тестов за пределами `src/`") is real and should stay:
it fails for a file placed at `packages/core/tests/x.test.ts`.

**Fix:** replace the vacuous count with an assertion that actually reads the config, so the
deliverable is pinned rather than restated:

```ts
import config from '../../vitest.config.js';

it('include покрывает весь src и объявлен явно', () => {
  expect(config.test?.include).toEqual(['src/**/*.test.ts']);
});

it('каждый .test.ts на диске попадает под include', () => {
  expect(testFiles.filter((parts) => parts[0] !== 'src')).toEqual([]);
});
```

The first now goes red under M3; the second keeps the existing (genuine) coverage.

### F4 — MINOR · `boundary.test.ts:148-158` · Q3 (negative space with no calibration)

```ts
const rule: ScanRule = { pattern: new RegExp(`derive${'RiskTier'}`), roots: [POLICY_ROOT], allow: [] };
expect(scanSources(repoRoot, rule)).toEqual([]);
```

Both sibling rules in this file are calibrated on a fixture tree before being pointed at the real
repo — `noParseManifest` at `:98-109`, `noJsonParseOfLock` at `:111-123`. The R13 rule is not. A
future edit to the string-splicing trick (or a rename of the forbidden symbol in contracts) makes
this rule match nothing, and the test stays green forever while R13 is silently unguarded. The
regex is correct *today*; nothing in the suite says so.

**Fix:** calibrate the same `rule` object on a fixture before the real-repo assertion:

```ts
const root = fixtureTree({ 'packages/core/src/policy/x.ts': `export const t = derive${'RiskTier'}(v);\n` });
try {
  expect(scanSources(root, rule)).toEqual(['packages/core/src/policy/x.ts']);
} finally {
  rmSync(root, { recursive: true, force: true });
}
expect(scanSources(repoRoot, rule)).toEqual([]);
```

### F5 — MINOR · `lock-write.test.ts:60-73` · Q2 (boundary compared with itself)

```ts
expect(lock.manifestHash).toBe(manifestHash(loaded.manifest));
…
expect(verifyLockEntries(buildLock(loaded, APPROVED_AT))).toEqual({ ok: true });
```

`buildLock` computes `manifestHash(manifest)` and `recipeHash(normalizeRecipe(…))`; the test
computes the same call on the same input. The contrast at `:66-67` rules out a constant-returning
implementation, and the round-trip at `:148-158` (`writeLock` → `store.reloadLock` → `checkLock`
→ `verified`) is a genuine independent check — so this is *not* the pure tautology the shape
suggests, and I am not asking for it to be rewritten. But `verifyLockEntries` at `:72` compares
`recipeHash(snapshot)` with `recipeHash(snapshot)` and cannot fail for any `buildLock` that is
internally consistent, including one that normalizes against the wrong `defaults`.

Note the contrast with the rest of the suite: `contract-characterization.test.ts:92` pins
`DURATION_MAX_MS` to the literal `2_147_483_647` rather than restating it, which is exactly the
right instinct.

**Fix:** pin one golden digest for the frozen fixture manifest, so the pair is anchored outside
the contracts implementation. JCS + SHA-256 over `MANIFEST_YAML` is deterministic, so this is a
stable literal, not a brittle snapshot:

```ts
// Дайджест канонической формы MANIFEST_YAML, снят один раз и записан литералом:
// сверка `manifestHash(x)` с `manifestHash(x)` прошла бы и у сломанного `manifestHash`.
const GOLDEN_MANIFEST_HASH = '<64 hex>';
expect(buildLock(loaded, APPROVED_AT).manifestHash).toBe(GOLDEN_MANIFEST_HASH);
```

For the record, the shared `policy.fixture.ts:114 lockTextFor` and `lock-check.test.ts:48 lockOf`
are **legitimate**: both build a lock file that is fed to the subject as an *input* (written to
the memory disk, or passed to `checkLock`), never used as an expected output. M2 confirms the
`checkLock` block around them is falsifiable.

### F6 — MINOR · `store.test.ts:13, 45` · Q2

```ts
import { LOCK_MAX_BYTES, startStore } from './store.js';
disk.pretendSize(LOCK_PATH, LOCK_MAX_BYTES + 1);
```

The limit is imported from the module under test, so the test moves with any change to
`store.ts:35` (`LOCK_MAX_BYTES = 4 * MANIFEST_MAX_BYTES`) — including a change to `400 *`. The
*ordering* observable (`disk.reads).toEqual([MANIFEST_PATH])`) is excellent and unaffected; only
the magnitude is unpinned. The manifest-side sibling at `:33` is fine because
`MANIFEST_MAX_BYTES` comes from contracts, i.e. across the boundary.

**Fix:** one literal pin next to the existing assertions, same shape as `DURATION_MAX_MS`:
`expect(LOCK_MAX_BYTES).toBe(4 * MANIFEST_MAX_BYTES)` with `MANIFEST_MAX_BYTES` imported from
contracts — that keeps the relation, not the number, under test and is not self-referential.

### F7 — MINOR · coverage gap · `lock-command.ts:83-116` (`mainLockCommand`, `describeStartFailure`)

Production code in `packages/core/src/policy/` with nothing in its blast radius. `mainLockCommand`
carries the exit-code contract that `bin/mcpproxy-lock.mjs:4` turns into `process.exitCode` —
`0` written / `0` up-to-date / `1` refused / `2` manifest not loaded — plus the R3 asymmetry
("сломанный манифест — отказ, а не повод записать lock"). The exit code is the entire observable
for any script or CI step that calls the command. `lock-command.test.ts` covers `runLockCommand`
only.

The `refused`/`written` arms need a TTY (`confirmTty` defaults to real stdin) and are reasonably
left alone. The **exit-2 arm needs no stdin at all** and is the safety-relevant one:

```ts
it('манифест не загружен — код 2 и никакого lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpproxy-main-'));
  try {
    writeFileSync(join(dir, 'mcpproxy.yaml'), BROKEN_YAML);
    expect(await mainLockCommand([], dir)).toBe(2);
    expect(existsSync(join(dir, 'mcpproxy.lock'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

`lock-write.test.ts` already carries the `mkdtemp`/`rmSync` harness this needs. Not invented
coverage: without it, a `return 0` slipped into the failure branch would ship green.

## What I checked and found solid

- **Q1 — does anything expire?** No. Every absolute ISO literal (`APPROVED_AT`, `REQUESTED_AT`,
  `NOW`, `event.test.ts:33-34`) is an *input* to a pure function, never compared against an
  ambient clock. The three production sites that read a real clock (`confirm-tty.ts:64`,
  `lock-command.ts:97`, and `confirmTty`'s default deps) are injected in every test that asserts a
  timestamp; `confirm-tty.test.ts:67` runs on the ambient default but asserts only `decision`.
  Nothing here fails on a future date.
- **Q4 — `settle()` (`policy.fixture.ts:139`) is a condition-wait in practice, not a disguised
  sleep.** It drains microtasks on an in-memory disk where every `await` is already resolved, so
  it advances no wall clock and cannot race a real I/O completion. Its adequacy is *empirically
  calibrated*: M1 shows the reload does complete and become observable within the same 20 ticks
  that `watch.test.ts:144` asserts a zero over — so the `toBe(0)` there is a real negative, not an
  under-settled false green. The one structural weakness is that the calibration lives in a
  *sibling* `it` (`:107`); if that test is ever deleted, `:144`'s zero silently loses its control.
  Worth keeping the two together as a pair.
- **Q4 — fake timers.** `watch.test.ts` uses `vi.useFakeTimers()` on `debounce`, whose entire
  subject *is* a timer, with `beforeEach`/`afterEach` restore. That is the correct use, not a
  substitute for awaiting a condition. No `sleep`, no `waitForTimeout`, no `retry`, no
  `testTimeout` overrides anywhere in the diff.
- **Q5 — temp-dir hygiene.** `fixtureTree` and `lock-write.test.ts` both use `mkdtempSync` (no key
  collisions under parallel workers) with `rmSync` in `finally`/`afterEach`. All temp trees live
  under `os.tmpdir()`, so they never race the R24 check on the real repo. `memoryDisk()` and
  `manualWatch()` construct fresh state per call — no module-level mutable state in either fixture.
- **Q6 — no skipped, `.only`, `.todo` or commented-out tests** anywhere in the twelve files.
- The negative-space assertions elsewhere are correctly paired with positive controls:
  `render-diff.test.ts:63` (`toEqual([])` on invisible chars) is calibrated by `:70-71`;
  `boundary.test.ts:49` (`electron` unreachable) by the fixture at `:52-69`;
  `boundary.test.ts:32-34` is an explicit anti-vacuity guard for it. `lock-command.test.ts:115-129`
  is the deliberate positive control against an implementation that never writes.
- Two smaller things I looked at and am **not** raising as findings: `watch.test.ts:127` calls
  `watching.stop()` outside a `finally`, so an earlier assertion failure leaks the watcher — but
  fake timers are reset in `afterEach` and `manualWatch` is in-memory, so the leak cannot reach
  another test. And `lock-check.test.ts:192-201` evaluates three `checkLock` calls at collection
  time, shared read-only across three `it`s — pure function, no leakage, only a coarser failure
  mode.

## Working tree

`git status --porcelain` shows no modification of mine. The two paths present are not this
review's: `docs/vibe-coding/27.08.2026-e1-policy/.gates/build-test.json` (staged before I started)
and `docs/vibe-coding/27.08.2026-e1-policy/.review/error-observability.md` (a sibling reviewer,
written concurrently). All four mutations were reverted with `git checkout -- <path>`;
`git diff --stat` is empty.

---

## Разрешение (владелец ветки), codeTree 5cb79aae92b2de5e79f878688ff6b23501fbc1a8

- **F1 Major, `boundary.test.ts` читает рабочее дерево** — принято ровно предложенным способом:
  утверждение о ветке переехало в `packages/core/bin/mcpproxy-r24.mjs` (внутри списка R24),
  чистая половина и фикстурные кейсы остались в vitest. `yarn test` больше не зависит от
  `git status` по настоящему репозиторию.
- **F2 Major, фикстурный репозиторий наследует конфиг машины** — принято,
  `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` отрезаны, `commit.gpgsign=false`, `core.hooksPath=`
  и `timeout: 15_000` на каждом вызове.
- **F3 Major, `runner.test.ts` — декорация** — принято. Счётчик заменён проверкой самого
  `include`; мутация M3 (удаление строки `include`) теперь краснеет. Конфиг читается текстом,
  а не импортом: `rootDir` пакета — `src`, и `tsc -b` файл выше не компилирует.
- **F4 Minor, правило R13 не калибровано** — принято, калибруется на фикстуре перед прогоном
  по репозиторию.
- **F5 Minor, `verifyLockEntries` сверяет `buildLock` сам с собой** — принято по существу, но
  закрыто иначе, чем предложено: вместо золотого литерала добавлен инвариант «потолок писателя
  ≡ потолок читателя» и раунд-трип, а само утверждение оставлено как проверка внутренней
  согласованности. Золотой дайджест не заводился намеренно: он привязал бы тест E1 к
  реализации JCS в замороженном пакете, чей собственный набор тестов эту формулу и держит.
- **F6 Minor, `LOCK_MAX_BYTES` из модуля под тестом** — принято, соотношение закреплено через
  `MANIFEST_MAX_BYTES` из контрактов.
- **F7 Minor, `mainLockCommand` без покрытия** — принято, добавлены обе ветки без stdin:
  код 2 на сломанном манифесте и код 2 на битом `--expect`.
- Замечание про парность `settle()` и его калибровку в соседнем `it` — учтено: оба теста
  остались рядом, и к ним добавлены два новых на `onReload`, использующих ту же прокрутку.

### После слияния с main, codeTree 373e57650ab977937bf39907c1937c145c925c30

Ветка слита с `main`, куда E6 попала раньше E1. Находки выше и их разрешение относятся к коду
E1 и слиянием не затронуты; изменились только сведение барреля, `package.json`, конфиг vitest и
два правила E6 (обоснование — `spec.md`, R24). Прогон после слияния: 243 теста contracts,
380 core, все зелёные.
