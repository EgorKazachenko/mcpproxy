# Test-quality / anti-flake — E3 executor and sandbox

codeTree: `6db5a00a0b4670b0c2c4c2cd3d96de6eb09c9cbb`

Verdict: **TQ-FLAKY** — 10 findings (4 Major, 4 Medium, 2 Low).

Surface reviewed: `git diff e40b7de..HEAD -- packages/core/src/exec/*.test.ts packages/core/src/exec/modes/*.test.ts packages/core/vitest.config.ts` — 12 test files, 2299 added lines, every added test read in full. Baseline `yarn test` in `packages/core`: 146 passed / 2 skipped in 19 s on macOS 25.5.0, node v22.15.0, vitest 3.2.7. Every mutation below was reverted with `git checkout --` and verified: at 02:42:03 `git diff --stat packages/` was empty, i.e. this pass left nothing behind.

> Provenance note. Starting 02:43, `packages/core/src/exec/sandbox.ts` (+81) and `limits.ts` (`markErrored` / `truncated` on stream error) began changing under a concurrently running agent — an `ExecErrorCode` union and stream-error accounting, neither of them mine. A `yarn test` launched across that edit reported 1 failure; it is a mid-write artefact of that work, not a finding of this pass and not a residue of any mutation here. All findings below were established against the clean tree.

## Findings

- **`packages/core/src/exec/modes/none.test.ts:240-263` — Q5 (order dependence) — Major.** The R50 lifecycle test consumes the suite-level `sandbox` (`await sandbox.dispose()` at :251) as one of its "two references". Every other test in the suite calls `run()`, which goes through that same instance, so the suite is green only because vitest happens to run declaration order. Verified: `vitest run src/exec/modes/none.test.ts --sequence.shuffle.tests --sequence.seed=1` → **7 failures**, seed 3 → 3 failures, all `Error: песочница уже освобождена: run() после dispose() запрещён … (R50)`; one collateral `AssertionError: expected [] to include 'spawn'`. The other five suites (`seatbelt`, `limits`, `events`, `violation`, `profile`) pass shuffled — this file is the sole offender, and the "последний тест набора намеренно" comment is load-bearing production-of-green rather than documentation. Fix: allocate both references inside the test — `const first = createNoneSandbox(); const second = createNoneSandbox();` — dispose `first`, assert `second.run()` still resolves, dispose `second`, assert it throws, then the fresh-`third` half unchanged. The suite-level `sandbox` is never touched, the ordering comment is deleted, and the suite's `afterAll` stops double-disposing an already-released instance.

- **`packages/core/src/exec/limits.test.ts:32-43` — Q4/Q5 (cleanup cannot clean the fixture it created) — Major.** `cleanupMarkers` kills with `/usr/bin/pkill -f` — SIGTERM — while the suite deliberately spawns `trap '' TERM; sleep ${MARKER_SECONDS}` at :75. When the production kill path regresses, the cleanup is powerless against exactly the fixture that proves the regression. Verified by mutating `limits.ts:225` to `detached: false`: the suite went red (3 failures, 212 s) and left `/bin/sh -c trap '' TERM; sleep 29387` plus its child alive; the 40×25 ms wait at :40 expired silently, `pkill -f` could not remove them on a second attempt, and only `pkill -9 -f` cleared them. Because `beforeAll(cleanupMarkers)` uses the same SIGTERM, the machine stays poisoned: `expect(survivors()).toBe(0)` at :53 is red on every subsequent run *even after the production bug is fixed*, and the message points at the wrong thing. Fix: two changes in `cleanupMarkers` — send `['-9', '-f', …]` (a signal the fixture cannot trap), and replace the silent give-up loop with a throw naming the surviving pids from `ps -A -o pid=,args=`, so an uncleanable orphan reports itself as a failed precondition instead of surfacing as a mystery red inside the next test.

- **`packages/core/src/exec/env.test.ts:10,11,15,21,22,40` — Q2 (tautology) — Major.** Every PATH assertion compares `buildEnv(...)['PATH']` against `MINIMAL_PATH` imported from the module under test, so the expectation moves with the implementation. Verified: setting `env.ts:18` to `MINIMAL_PATH = '/attacker/bin'` leaves all 8 tests **green** — including the one titled "минимальный PATH побеждает унаследованный … отдать рецепту с `allow: []` путь поиска демона". The literal is pinned exactly once in the whole branch, at `seatbelt.test.ts:444` (`path=/usr/bin:/bin:/usr/sbin:/sbin`), inside a `describe.skipIf(!IS_MACOS)` suite — so on any Linux runner the value of the constant R23 exists to protect is asserted nowhere. (The meaningful behavioural mutation *is* caught: `env['PATH'] = base['PATH'] ?? MINIMAL_PATH` reddens 2 tests. Only the constant's value is unguarded.) Fix: add one literal assertion in `env.test.ts` — `expect(MINIMAL_PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin')` — or, better, spell the literal directly in the "побеждает унаследованный" test and keep the symbol only where the shape rather than the value is under test.

- **`packages/core/src/exec/violation.test.ts:104-115` — Q3 (assertion narrower than the claim) — Major.** The title claims a universal property — "в ней нет ни одной операции с типом нарушения" — and the body asserts two hand-picked names (`file-write-data`, `network-outbound`). The `for` loop above them is tautological in a second way: none of the 16 entries of `SUPPRESSED_OPERATIONS` matches any prefix in `violation.ts:86` `TYPE_BY_PREFIX`, so it passes whichever order `classify` checks suppression and typing, and no mutation of that order can redden it. Verified: adding `'file-write-create'` (a real seatbelt write-family name, `violation.ts:83` documents the family explicitly) to `SUPPRESSED_OPERATIONS` leaves `violation.test.ts` **16/16 green**; the only red is `seatbelt.test.ts:130` "отказ классифицирован как mandatory-deny" — macOS-only, i.e. invisible on a Linux runner. The S6 badge can be switched off silently by a one-line list edit. Fix: export the prefix table (or a `typeForOperation(operation): ViolationType | undefined` helper) from `violation.ts` and assert the property the title states — `expect(SUPPRESSED_OPERATIONS.filter((op) => typeForOperation(op) !== undefined)).toEqual([])` — which covers every present and future family name instead of two.

- **`packages/core/src/exec/modes/seatbelt.test.ts:325` and `:348` — Q4 (fixed sleep instead of a condition) — Medium.** The R29 test keeps the child alive with `sleep 2` and infers "the callback fired while the process lived" from the absence of a marker file; the stage-order test pads with `sleep 1` to give the kernel `log stream` time to deliver. Delivery latency of `log stream` is unbounded — it is a separate process piping through a chunked stdout handler — so under a loaded machine or a slower macOS build the 2 s window closes before the violation arrives and `expect(seenWhileAlive).toBe(true)` fails for a reason unrelated to R29. Observed runtimes are 2227 ms and 1205 ms, i.e. the tests spend their whole duration waiting on a guess. Fix: invert the wait — child script becomes `cat secret.txt 2>/dev/null; touch started; while [ ! -f release ]; do sleep 0.05; done`, the violation callback does `writeFileSync(release, '')` on first call, and the assertion becomes "the callback ran, and it ran before `release` existed". The child then lives exactly as long as it takes for the condition to hold, bounded by the existing 60 s `testTimeout`, and the test cannot fail for being 50 ms slow.

- **`packages/core/src/exec/limits.test.ts:14-18,34` — Q5 (machine-global shared registry) — Medium.** `MARKER_SECONDS = '29387'` is a file constant, `survivors()` greps `/bin/ps -A -o args=` across the entire machine, and `pkill -f "sleep 29387"` kills across the entire machine. Two checkouts of this repo running `yarn test` at once — routine while a multi-dimension review runs in parallel worktrees, and this branch *is* a worktree — cross-count in `expect(survivors()).toBe(0)` (:53, :63) and cross-kill each other's live fixtures mid-assertion. `fileParallelism: false` serialises only within one vitest process and gives no protection here. Fix: derive the marker per process — `const MARKER_SECONDS = String(20_000 + (process.pid % 9_000));` — so both the `ps` predicate and the `pkill` pattern can match only this run's own children; the `sleep <n>` token stays visible in `ps` for the shell and the sleep alike, so nothing else in the file changes.

- **`packages/core/src/exec/modes/none.test.ts:57-64,126-133` and `modes/seatbelt.test.ts:68-76,177,186,193,424` — Q4 (network dependency guarded only halfway) — Medium.** Both `beforeAll`s establish exactly one precondition — that `127-0-0-1.nip.io` resolves — and do it well: the throw text says "условие прогона не выполнено … Проверьте доступность сети", so a DNS outage reads as an unmet precondition. `PUBLIC_HOST = 'example.com'` gets no such treatment, yet at least five assertions demand a live `200` from it (`none.test.ts:131-132`, `seatbelt.test.ts:179`, `:189`, `:198`, `:441`). A blocked egress, a captive portal, or an `example.com` hiccup surfaces as `expected '000' to be '200'` inside "разные network.allow дают разные решения" — which reads as *the sandbox denied a request it should have allowed*, the precise wrong diagnosis, and on the deny-side legs an outage makes the test pass for the wrong reason. Fix: extend both `beforeAll`s with the same shape already used for DNS — fetch `https://${PUBLIC_HOST}/` from the daemon itself (outside any sandbox) and throw `условие прогона не выполнено: ${PUBLIC_HOST} обязан отвечать 200 …` when it does not, so an outage is a precondition failure and never a sandbox regression.

- **`packages/core/src/exec/events.test.ts:148` — Q6 (silent skip) — Medium.** This is the branch's third integration suite and the only one that skips without announcing it: `none.test.ts:27-33` and `seatbelt.test.ts:33-39` both carry a `describe('громкость пропуска')` block whose `it.skipIf(IS_MACOS)` fails loudly on a non-macOS runner unless `MCPPROXY_SKIP_SANDBOX_TESTS=1` is set — that mechanism is genuinely loud, I verified the assertion cannot pass off macOS without the opt-out. `events.test.ts` has `describe.skipIf(!IS_MACOS)` and nothing else, so on Linux the entire R32/R33/R34 event-ordering contract (7 tests: stage coverage, field ordering, secret non-serialisation, key-absent-vs-null, raw profile) vanishes and the file reports 7 green. Fix: copy the same `громкость пропуска` block verbatim into `events.test.ts`, so all three integration suites announce a skipped platform through a red test rather than through an absence.

- **`packages/core/src/exec/srt-manager.test.ts:43-48` — Q2 (tautology) — Low.** `expect(STORE_RING_SIZE).toBe(100)` asserts a constant against the literal one line of source away. It is worse than the usual case: `STORE_RING_SIZE` is not used by production at all — `srt-manager.ts:25` defines it, `:63` mentions it in a comment, and the live code passes `available: all.length` at `:255`. So the value exists only to shape the loss-branch fixture at `srt-manager.test.ts:24`, and the stated cross-check is false in one direction by the comment's own admission ("при большем кольце он остался бы зелёным"). A vendor bump of `maxSize` therefore makes that fixture silently unrepresentative of the branch it claims to cover. The correct shape already exists two files over, at `netpolicy.test.ts:44-57`, which reads the vendor source to detect drift. Fix: `createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-violation-store.js')`, parse `this.maxSize = <n>` out of it, and assert `STORE_RING_SIZE` equals that number — red in both directions on a vendor change, as the deny/allow-order detector already is.

- **`packages/core/src/exec/events.test.ts:39-49` — Q3 (title claims a property nothing asserts) — Low.** "меряет монотонными часами и отдаёт целые микросекунды" — the assertions cover integrality and `> 0`, nothing about the clock. Verified: replacing `process.hrtime.bigint()` in `events.ts:40,42,47,49` with a `Date.now()`-derived nanosecond value leaves all 14 tests **green**, i.e. the regression `events.ts:36` was written to prevent ("прыгает по NTP") is undetectable. It also seeds a future flake: the 200 000-iteration body runs in well under a millisecond, so a wall-clock implementation would return `durationUs === 0` most of the time and `toBeGreaterThan(0)` would fail intermittently rather than deterministically. Fix: assert the resolution the monotonic clock provides and a millisecond clock cannot — call `measure` on a short body ~20 times and require `durations.some((us) => us % 1000 !== 0)`.

## Mutation spot-checks of the branch's own claims (4 of 4 reproduced)

- **`dc21df1` "наследование PATH … краснеет"** — `env.ts:47` → `base['PATH'] ?? MINIMAL_PATH`: **RED**, 2 failures in `env.test.ts`. Confirmed. (The neighbouring `if (name === 'PATH') continue;` at `:42` is an equivalent mutant — the post-loop assignment already dominates — so its removal is correctly undetectable; behaviour is identical and this is not a test defect.)
- **`dbf4ce2` "collapseOutput только по stdout"** — `events.ts:65` → `{ bytes: stdout.bytes, truncated: stdout.truncated }`: **RED**, 1 failure. Confirmed.
- **`9d274ab` "снятый detached"** — `limits.ts:225` → `detached: false`: **RED**, 3 failures (and 212 s, versus 2.2 s green — see the cleanup finding above). Confirmed.
- **`1951daf` "литерал из двух полей" (the mutation that initially survived)** — dropping `...base.network` from `applyNetwork` at `srt-manager.ts:492-499`: **RED**, and red in exactly the two applied-config assertions the commit says were added for it (`seatbelt.test.ts:239` R56/R43/D12 and `:250` R52/R56); all 20 behavioural tests in the file stayed green, which is precisely the blind spot the commit describes. Confirmed.

## Claims of non-tautology, checked rather than trusted

- **`RECORDED_VENDOR_DENIALS` (`seatbelt.test.ts:466-486`) — genuine.** The expected list is the *vendor's* 18-path set, produced by a live child-process probe (`DRIFT_PROBE`, `:489-548`) that runs `SandboxManager.wrapWithSandboxArgv` with `denyWrite: []`. It is disjoint from our own `MANDATORY_DENY_FILES`/`_DIRECTORIES`/`_GIT_PATHS` (`profile.ts:37,55,68`), and the probe's `CANDIDATES` include `ordinary.txt` as a negative control that must *not* appear. Red in both directions on an upstream change, as claimed.
- **Vendor conformance tables (`netpolicy.test.ts:21-94`, `violation.test.ts:203-242`) — genuine.** They call the real `matchesDomainPattern`, `matchesDomainPatternWithPort`, `NetworkConfigSchema` and `globToRegex`, and every table carries `toBe(true)` cases alongside the `toBe(false)` ones, so the argument-order trap the header warns about (a swap collapsing everything to `false`) cannot go green.
- **Drift detector on deny/allow ordering (`netpolicy.test.ts:44-57`) — genuine**, and it guards itself: `expect(start).toBeGreaterThan(-1)` and both `indexOf` results are asserted `> -1` before the ordering comparison, so a vendor rename cannot make the check vacuous.
- **Vendor-isolation graph walk (`events.test.ts:98-146`) — genuine.** The negative (`bare.filter(sandbox-runtime)` is `[]`) is braced on both sides: a non-empty-graph guard at :126-131 and a positive control at :138-145 asserting the vendor *is* reachable from `seatbelt.d.ts` and that `seatbelt.d.ts` is *not* in the public graph. Best-constructed negative assertion in the branch.
- **Public-surface snapshot (`surface.test.ts`) — genuine**, and not stale: `packages/core/package.json` runs `tsc -b && vitest run`, so `dist/` is rebuilt before the snapshot is compared. The "собрана — иначе снапшот сверяется с пустотой" guard at :49 covers the remaining case.

## Questions with nothing to report

- **Q1 (expiry):** clean. No absolute date or timestamp is pinned anywhere in the added tests; the only certificate is minted at runtime by `startSelfSignedListener` with `-days 1`, and no assertion compares against a wall-clock window.
- **Q6 (`.only` / commented-out):** clean. No `.only`, `.todo`, `xit`, or commented-out test in the diff; the only skips are the platform gates discussed above.
- Not flagged by design: the R38 overhead budget (`events.test.ts:64-80`) takes p95 over 100 samples against a 5 ms threshold with roughly two orders of magnitude of headroom and tolerates 5 outliers — it is a threshold that can fail on regression and will not fail on jitter. The 250-denial test (`seatbelt.test.ts:214`) runs in 1.8 s against a 60 s timeout, so its 250 sequential `curl` spawns have ample margin.

---

## Резолюция

Правки — коммит `660a4fe`. codeTree на момент резолюции: `769da6b0b4b23cded1b0b5c0bf7782ce500f47d8`
(ревью читало `6db5a00a0b4670b0c2c4c2cd3d96de6eb09c9cbb`; анкер выше сохранён).

**Все десять находок приняты.** Четыре Major ревьюер воспроизвёл замером — каждый
воспроизведён и здесь перед правкой.

- **Major, порядковая зависимость R50-теста** — принят. Обе ссылки теперь свои
  (`createNoneSandbox()` дважды), suite-level песочница не трогается, комментарий
  «последний тест набора намеренно» удалён — он производил зелёный, а не описывал его.
  Проверено: `--sequence.shuffle.tests` на семенах 1, 3, 7 и 11 — 160 зелёных.

- **Major, уборка бессильна против своей же фикстуры** — принят целиком, обе половины.
  `pkill -9`, потому что набор намеренно порождает `trap '' TERM`, и громкий отказ с
  перечислением выживших pid вместо тихой сдачи. Диагноз про «машина отравлена навсегда»
  точен: `beforeAll` тем же SIGTERM не убирал сирот, и предусловие краснело бы на каждом
  последующем прогоне, указывая не на тот код.

- **Major, тавтология `MINIMAL_PATH`** — принят. Значение пинуется литералом отдельным
  утверждением; замер воспроизведён — с `'/attacker/bin'` файл был полностью зелёным,
  включая тест про «путь поиска демона». Довод про Linux-раннер верен: единственный литерал
  ветки жил под `skipIf(!IS_MACOS)`.

- **Major, список шума проверялся двумя именами** — принят, с предложенной формой.
  `typeForOperation` экспортирована, утверждается универсальное свойство
  `SUPPRESSED_OPERATIONS.filter(typeForOperation) === []` плюс положительный контроль на
  четырёх настоящих именах. Замер воспроизведён: с `file-write-create` в списке файл
  оставался 16/16 зелёным, а краснел только macOS-набор.

- **Medium, фиксированные `sleep`** — принят, ожидание перевёрнуто ровно как предложено:
  ребёнок крутится на `while [ ! -f release ]`, колбэк создаёт файл, утверждение —
  «колбэк сработал, и сработал до того, как файл появился». Оба теста перестали платить
  секунду за прогон и перестали зависеть от везения.

- **Medium, машинно-глобальный маркер** — принят. `MARKER_SECONDS` выводится из `process.pid`.

- **Medium, `PUBLIC_HOST` без предусловия** — принят. Оба сетевых набора теперь проверяют
  доступность `example.com` напрямую с машины демона и падают с текстом «условие прогона не
  выполнено». Довод точен и в обе стороны: на allow-ногах сбой читался как отказ песочницы,
  на deny-ногах делал тест зелёным по неверной причине.

- **Medium, молчаливый пропуск в `events.test.ts`** — принят, блок скопирован.

- **Low, тавтология `STORE_RING_SIZE`** — принят, с предложенной формой: значение читается
  из исходника вендорского стора и краснеет в обе стороны, как детектор порядка deny/allow.
  Замечание, что прежний перекрёстный довод ложен в одну сторону, справедливо — комментарий
  сам это признавал.

- **Low, `measure` не утверждала часы** — принят. Утверждается разрешение тоньше
  миллисекунды; замер воспроизведён — подмена `hrtime` на `Date.now()` оставляла набор
  зелёным.

**Про раздел «Claims of non-tautology, checked rather than trusted».** Он ничего не требовал
исправить, но полезнее половины находок: пять утверждений, про которые ветка сама заявляла
«это не тавтология», проверены независимо и подтверждены. Заявление, проверенное чужими
руками, стоит больше заявления, и это ровно тот случай.

**Замечание о мутации в дереве.** Проба `detached: false` действительно пересеклась с
работой параллельной размерности error-observability, которая её заметила и не тронула.
Файл восстановлен, дерево проверено чистым, в коммит мутация не попала.
