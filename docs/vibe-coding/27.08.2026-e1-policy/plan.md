# E1 — policy engine: план

**Clean-code review:** passed (round 1) (2026-08-27)
**Plan review:** раунд 1 — REVISE (7B/11M); раунд 2 — REVISE (6B/16M); раунд 3 — REVISE (5B/15M); всё применено (2026-08-28)

## Goal

Реализовать требования `spec.md`: слой политики в `packages/core/src/policy/**`, который читает
манифест и lock с диска, сверяет их, на расхождении даёт `denied` на стадии `lock_check` с полным
диффом «было / стало», и по явной команде человека — показав дифф, получив подтверждение и
перечитав манифест — записывает новый lock.

## Architecture

E1 — **оркестровка и I/O вокруг замороженных чистых функций** `@mcpproxy/contracts`. Ни одна
формула, ни одна нормализация, ни одна санитизация не пишется заново.

**Первое: вся сверка делается на изменении файлов, на вызове не делается ничего.** `lock_check` —
стадия каждого вызова (`packages/contracts/src/domain.ts:14`) и она **не** входит в
`OVERHEAD_EXCLUDED_STAGES` (`packages/contracts/src/event.ts:149`), то есть попадает в бюджет
≤ 50 мс p95. А сверка в худшем случае стоит секунды: `diffLock` зовёт `normalizeRecipe` на каждый
рецепт (`packages/contracts/src/lock.ts:309`). Прямого замера `diffLock` у нас нет; есть замер
**сопоставимой** работы — `canonicalizeJcs(normalizeManifest(manifest))` в
`packages/contracts/src/validate/index.ts:82`, 2.2 с CPU на манифесте в 258 КБ, то есть на потолке
`MANIFEST_MAX_BYTES = 262_144`. Это худший случай и сопоставимая, а не тождественная работа —
но вывод от этого только крепче: такому на пути вызова места нет.

**Второе: манифест и lock — разные сущности с разным временем жизни.** Lock меняется, когда
человек выполнил команду; манифест — когда его правят.

**Третье: одобрение связывается дайджестом манифеста, и только им.** Счётчик перезагрузок для
этого не годится дважды. Он растёт при каждой успешной загрузке — значит перечитка после ответа
человека всегда меняла бы его, и **всякий законный апрув отвергался бы как устаревший**; ровно
этот дефект прошлая редакция и содержала. И он локален для процесса, тогда как `mcpproxy-lock` —
отдельный процесс от демона. Дайджест переживает границу процесса, счётчик — нет, и дайджест же
есть то, что человек одобрял. `reloadCount` остаётся внутренним наблюдаемым для тестов и **не
участвует** в решении.

```
                     ┌── loadManifest() ── правка mcpproxy.yaml ──────────────┐
mcpproxy.yaml ─────▶ │ stat→предел → parseManifest ─▶ manifest(frozen)+matchers│
                     │ manifestHash ─▶ digest ; recipeHash·N ─▶ recipeDigests │
                     └───────────────────────────┬───────────────────────────┘
                     ┌── loadLock() ── правка mcpproxy.lock ──────────────────┐
mcpproxy.lock ─────▶ │ stat→предел → parseLockFile ─▶ present | missing |     │
                     │                 unreadable | unparsed(+diagnostics)    │
                     └───────────────────────────┬───────────────────────────┘
                                                 ▼ изменилось любое из двух
                      checkLock(): diffLock → verifyLockEntries → digest → вердикт
                                                 ▼
              LoadedPolicy { manifest, lock, verdict }   ← иммутабелен
                                                 │
   на вызове: policy.verdict ── чтение поля ──▶ lockCheckEvent(...)
                                                 │
   mcpproxy lock: render ─▶ человек ─▶ ПЕРЕЧИТАТЬ ─▶ digest тот же? ─▶ writeLock
```

## Tech Stack

Node ≥ 22, TypeScript 5.6, ESM (`module: NodeNext`), Yarn 4.9.1 workspaces, vitest 3.
`packages/core` зависит от `@mcpproxy/contracts` (`workspace:*`); в `devDependencies` добавляется
`es-module-lexer` — им пользуется обход графа в задаче 8.

## Global Constraints

`packages/contracts` не меняется ни одной строкой. Список разрешённых путей и решение владельца
R24a — в `spec.md`, R24; здесь он не переписывается своими словами.

**Строгость (из таблицы 3, не по памяти):** `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noImplicitOverride`. Следствия:

- `exactOptionalPropertyTypes` — `{ argv: undefined }` **не** присваивается в
  `argv?: readonly string[]` (`packages/contracts/src/event.ts:89`); R12 держится типом. Но
  `denyReason?: string | null` (`packages/contracts/src/event.ts:87`) **допускает** `null`
  значением, поэтому прямой перенос записал бы ключ в каждое `allowed`-событие, и он уехал бы в
  `chain.self`. Здесь тип не спасает — спасает условный спред (задача 4).
- `noUncheckedIndexedAccess` — `manifest.tools` это `{ [k: string]: Recipe }`
  (`packages/contracts/src/manifest.generated.ts:36`), поэтому `tools['run_tests']` даёт
  `Recipe | undefined`.
- `verbatimModuleSyntax` — импорты типов через `import type`.

---

## Pre-flight

### 1. Write path

| Field / collection | Producer | Every transform between device and document | Drops or merges data? |
|---|---|---|---|
| `Manifest` | `packages/contracts/src/validate/index.ts:102` | YAML → `parseYaml` → ajv → `refine` → `notHashable` | нет |
| `Manifest.tools[n].description` | `packages/contracts/src/validate/index.ts:102` | хранится **сырым**; чистится только в `packages/contracts/src/tool.ts:136` | да, но только в `toTool` |
| `NormalizedRecipe.own` | `packages/contracts/src/lock.ts:207` | `Recipe` → `own`; **все строки дословно** — `description`, `exec[]`, `cwd`, `params[].description`, `env.allow[]`, строки песочницы | нет |
| `NormalizedRecipe.effective` | `packages/contracts/src/lock.ts:245` | `defaults` ⊕ рецепт с клампингом | **да**: `Math.min`, `\|\|`, пересечение |
| `LockFile` | E1, `lock-write.ts` | `LoadedManifest` → нормализация → хэши → печать → temp+fsync+rename | нет |
| `LockVerdict` | E1, `lock-check.ts` | загруженные манифест и lock → `diffLock` → `verifyLockEntries` → дайджест | нет |

Третья строка — источник R19: сырым лежит **не только** `description`, поэтому свойство рендера
формулируется по всем строкам диффа.

### 2. Consumers

```
$ grep -rn "@mcpproxy/core" --include="*.ts" --include="*.json" . | grep -v node_modules | grep -v "/dist/"
packages/core/package.json:2:  "name": "@mcpproxy/core",
packages/bench/package.json:22:    "@mcpproxy/core": "workspace:*"
packages/mcp-server/package.json:22:    "@mcpproxy/core": "workspace:*"
```

| Symbol | Reader (`file:line`) | What that reader does with the value | Does the reader's test mock it? |
|---|---|---|---|
| `@mcpproxy/core` | `packages/mcp-server/package.json:22` | зависимость объявлена, импорта нет: `packages/mcp-server/src/index.ts:2` это `export {};` | нет тестов вовсе |
| `@mcpproxy/core` | `packages/bench/package.json:22` | то же самое | нет тестов вовсе |

Ни одного потребителя кода. Но `index.ts` входит в граф сборки сиблингов, поэтому `build-test`
гоняет весь воркспейс.

### 3. Infrastructure

| Package | Test command actually used | `setupFiles` | env forced by setup | app built per worker or per test | tsconfig strictness | ESLint severities |
|---|---|---|---|---|---|---|
| `packages/core` | `yarn workspace @mcpproxy/core test` → создаётся задачей 1 | нет | нет | `tsc -b` один раз перед `vitest run` | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` | ESLint отсутствует |
| `packages/contracts` | `yarn workspace @mcpproxy/contracts test` (`packages/contracts/package.json:28` — `"test": "tsc -b && vitest run",`) | нет | нет | `tsc -b` перед прогоном | те же | те же |

**Гонка, которую задача 1 иначе внесла бы.** Корневой `package.json:15` —
`"test": "yarn workspaces foreach -Ap run test",` — это **параллельный** прогон, тогда как
`build` на строке 13 идёт `-Apt`, топологически. Сегодня скрипт `test` есть только у `contracts`,
и гонки нет. Как только он появится у `core`, `tsc -b` в `core` начнёт строить `contracts` по
project reference **одновременно** с собственным `tsc -b` пакета `contracts` — общий `dist/` и
общий `tsconfig.tsbuildinfo`. Поэтому задача 1 меняет корневой скрипт на `-Apt`; это правка
корневого `package.json`, и она попадает в список R24.

**Бутстрап.** `vitest run` без тест-файлов печатает `No test files found, exiting with code 1`;
`passWithNoTests` не добавляется. Задачи «инфраструктура» и «характеризация» слиты в одну (1),
иначе первый коммит оставил бы корневой `yarn test` красным.

**Числа файлов не хардкодятся** — портируется проверка из `packages/contracts/src/domain.test.ts:47`.

Существующих тест-файлов, назначаемых домом новой проверки, нет.

### 4. Runtime shape

| Value | Loader that produced it | Loader's return type | Spread allowed? |
|---|---|---|---|
| `Manifest` | `parseManifest`, `packages/contracts/src/validate/index.ts:102` | plain object из `doc.toJS()` | да; E1 замораживает (R6) |
| `LockFile` | `parseLockFile`, `packages/contracts/src/validate/lock.ts:149` | plain object из `JSON.parse` | да |
| `NormalizedRecipe` | `normalizeRecipe`, `packages/contracts/src/lock.ts:207` | plain object | да |
| `LockDiff` | `diffLock`, `packages/contracts/src/lock.ts:308` | plain object с `readonly` | да, только чтение |
| `PatternMatcher` | `parseManifest` → `matchers` | **plain object literal**: `packages/contracts/src/validate/regex.ts:43` — `  return { ok: true, matcher: { test: (value: string) => re.test(value) } };` | да — `test` собственное свойство-замыкание |

**Запись об исправленной ошибке.** В первой редакции здесь стояло, что `PatternMatcher` —
непрозрачная обёртка над RE2, чьё поведение живёт на прототипе. Неверно: `test` — собственное
свойство объектного литерала. Утверждение пришло из пересказа, а не из чтения `regex.ts:43`, и
построенный на нём falsification-след был зелёным при **обеих** ветках.

### 5. Premises

| Premise | The grep that establishes it | Quoted evidence | Every site where it holds | Decision at each site |
|---|---|---|---|---|
| `LockCheck` не производится ничем | `grep -rn "LockCheck" packages/contracts/src` | `packages/contracts/src/lock.ts:155` — `export type LockCheck =` | одно объявление | E1 пишет `checkLock` (задача 2) |
| Дрифт не отображается в риск-тир | `grep -n "deriveRiskTier" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:152` — `расхождение с lock не отображается` | один доккомментарий | скан `policy/**` в задаче 8 |
| `diffLock` нормализует каждый рецепт | `grep -n "normalizeRecipe" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:309` — `  const current = new Map(` | начало `diffLock` | сверка уходит с пути вызова (задача 2) |
| Замер сопоставимой работы | `grep -n "2.2" packages/contracts/src/validate/index.ts` | `packages/contracts/src/validate/index.ts:82` — `форма стоит 2.2 с CPU на манифесте в 258 КБ` | один доккомментарий | то же; сопоставимая, не тождественная — оговорено в §Architecture |
| `lock_check` не исключён из бюджета | `grep -n "OVERHEAD_EXCLUDED" packages/contracts/src/event.ts` | `packages/contracts/src/event.ts:149` — `export const OVERHEAD_EXCLUDED_STAGES` | одно объявление; `lock_check` отсутствует | то же |
| `diffLock` **сам** ловит правку `defaults` | `grep -n "sameDefaults" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:326` — `  const defaults = sameDefaults(lock.defaults, is) ? null : { was: lock.defaults, is };` | единственное применение, внутри `diffLock` | обоснование R11 сужено; след задачи 2 построен на другом кейсе |
| `redact` включается и не снимается | `grep -n "redact" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:255` — `      redact: (own.output?.redact ?? false) \|\| base.output.redact,` | одно место | характеризация (задача 1) |
| `env.allow` пересекается | тот же греп | `packages/contracts/src/lock.ts:258` — `    env: { allow: (own.env?.allow ?? base.env.allow).filter((one) => base.env.allow.includes(one)) },` | одно место | характеризация (задача 1) |
| `maxBytes` берётся минимумом | тот же греп | `packages/contracts/src/lock.ts:253` — `            : Math.min(own.output.maxBytes, base.output.maxBytes),` | одно место | характеризация (задача 1) |
| Предел длительности — константа | `grep -n "DURATION_MAX_MS" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:35` — `export const DURATION_MAX_MS = 2_147_483_647;` | объявление | §6, тест в задаче 1 |
| `protocolVersion` нельзя брать из константы | `grep -n "protocolVersion" packages/contracts/src/event.ts` | `packages/contracts/src/event.ts:60` — `утверждающая нашу константу вместо согласованного значения` | одно поле | приходит входом (задача 4) |
| `denyReason` допускает `null` значением | `grep -n "denyReason" packages/contracts/src/event.ts` | `packages/contracts/src/event.ts:87` — `  readonly denyReason?: string \| null;` | одно поле | условный спред (задача 4) |
| `ApprovalDecision` уже экспортирован | `grep -n "approval" packages/contracts/src/index.ts` | `packages/contracts/src/index.ts:25` — `export * from './approval.js';` | один реэкспорт | импорт типа (задача 6) |
| Диагностики lock не несут координат | `grep -n "line: 1" packages/contracts/src/validate/lock.ts` | `packages/contracts/src/validate/lock.ts:62` — `    line: 1,` | один конструктор `at` | ключ лога получает индекс (задача 8) |
| **Ключи lock уже проверены на имя рецепта** | `grep -n "isRecipeName" packages/contracts/src/validate/lock.ts` | `packages/contracts/src/validate/lock.ts:124` — `if (!isRecipeName(name)) report(pointer,` | один вызов, в `checkEntry` | синтезированная диагностика задачи 2 может не звать `sanitizeDescription` — имена уже сужены до `^[a-z][a-z0-9_]{0,63}$`. Премиса записана здесь, потому что без неё синтез был бы дырой |
| Обход графа не идёт по бэрным спецификаторам | `grep -n "startsWith" packages/contracts/src/deps.test.ts` | `packages/contracts/src/deps.test.ts:33` — `      if (!specifier.startsWith('.')) {` | одно место в `walk` | в `core` резолвятся и **подпути** `@mcpproxy/contracts/validate` (задача 8) |
| Прецедент против переименования поля | `grep -n "замороженная формула" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:113` — `замороженная формула носит это имя` | один доккомментарий | оба поля апрува зовутся `manifestHash` (задача 6) |
| `toTool` берёт имя отдельным аргументом | `grep -n "export function toTool" packages/contracts/src/tool.ts` | `packages/contracts/src/tool.ts:129` — `export function toTool(name: RecipeName, recipe: Recipe): Tool {` | одно объявление | тест R18 зовёт `toTool(asRecipeName('run_tests'), recipe)` (задача 7) |
| `core` сегодня пуст | `cat packages/core/src/index.ts` | `packages/core/src/index.ts:2` — `export {};` | один файл | наполняется в задачах 2..8 |

### 6. Ordered parameter — граница `durationToMs`

| Parameter value | Output | Branch taken |
|---|---|---|
| `"2147483646ms"` | `2147483646` | разбирается, проходит `checkDuration` |
| `"2147483647ms"` | `2147483647` | разбирается, проходит — **измерено, P4b** |
| `"2147483648ms"` | `2147483648`, отбой в `checkDuration` | разбирается, отвергается по значению |
| `"99999999999ms"` | `TypeError` | не разбирается — **измерено, P4c** |

Монотонен по значению; немонотонен *механизм* отказа — два независимых предела.
**Следствие для задачи 5:** `buildLock` берёт `LoadedManifest`, поэтому предусловие «манифест
прошёл `parseManifest`» держится типом, и `durationToMs` не встретит непроверенный текст.

### 7. Classifier outputs

| Input in scope | Returned value | Branch taken | Surviving outcome |
|---|---|---|---|
| lock отсутствует | `reason === 'missing'` | `absent` | `denied`; **единственный** случай записи без подтверждения |
| lock не читается | `reason === 'unreadable'` + `code`/`message` | `absent` | `denied`; команда требует подтверждения, запрос вида `unusable` |
| lock не разобран | `reason === 'unparsed'` + диагностики (для `version: 1` их **две**, P5) | `absent` | `denied`; то же, запрос вида `unusable` |
| `verifyLockEntries` → `{ok:false, mismatched}` | — | `drifted` | `denied`; `diffLock` пуст (P1d), вердикт несёт `mismatched`, рендер идёт веткой «дрифт без диффа» |
| четыре пустых слота **и** дайджест сошёлся | `{defaults:null, added:[], removed:[], changed:[]}` | `verified` | `allowed` |
| `defaults` расширен | `defaults` ≠ null, `changed.length === 0` (P2c/P2d) | `drifted` | `denied` + дифф. **Ловит `diffLock`, не сверка дайджеста** |
| lock пересчитан целиком, `manifestHash` прежний | `diffLock` чист, `verifyLockEntries` ok | `drifted` | `denied`; **единственный** случай, который видит только сверка дайджеста |

### 8. Verified facts this plan is built on

Пробы против настоящего `dist`, прогнаны 2026-08-27/28 и удалены. Сырой вывод дословно:

```
P0 manifest loads :: true
P1a clean diff :: {"defaults":null,"added":[],"removed":[],"changed":[]}
P1b diff sees the swap :: ["run_tests"]
P1c verifyLockEntries on tampered :: {"ok":false,"mismatched":["run_tests"]}
P1d diff on lying recipeHash :: {"defaults":null,"added":[],"removed":[],"changed":[]}
P1e verifyLockEntries on lying :: {"ok":false,"mismatched":["run_tests"]}
P2a per-recipe hashes identical :: true
P2b manifestHash differs :: true
P2c diffLock defaults slot non-null :: true
P2d diffLock changed slot length :: 0
P3a redact cannot be turned off :: true
P3b maxBytes is min :: 1000
P3c env.allow is intersection :: ["PATH"]
P3d own keeps declared values :: {"maxBytes":999999,"redact":false}
P4a DURATION_MAX_MS :: 2147483647
P4b at boundary :: 2147483647
P4c 11 digits throws :: "TypeError"
P5 version 1 :: ["lock:версия lock 1, а эта сборка читает 2","lock:слот defaults обязателен и обязан быть в нормализованной фор"]
P5 not json :: ["lock:lock не разобран как JSON: Expected property name or '}' in "]
P5 defaults missing :: ["lock:слот defaults обязателен и обязан быть в нормализованной фор"]
P5 __proto__ :: {"keyReallyPresent":["__proto__"],"ok":false,"diag":["lock:не имя рецепта: __proto__"]}
P5 constructor :: {"keyReallyPresent":["constructor"],"ok":false,"diag":["lock:не имя рецепта: constructor"]}
P5 Bad-Name :: {"keyReallyPresent":["Bad-Name"],"ok":false,"diag":["lock:не имя рецепта: Bad-Name"]}
P5 legal :: {"keyReallyPresent":["run_tests"],"ok":true,"diag":null}
P6 lone surrogate in snapshot :: ["lock"]
```

Проба вотчера (macOS, Node 22), дословно:

```
after in-place write   :: file=0 dir=1
after atomic rename    :: file=1 dir=3
after write post-rename:: file=1 dir=4
after 2nd atomic rename:: file=1 dir=6
VERDICT file-watch survives atomic replace :: false
VERDICT dir-watch  survives atomic replace :: true
```

И две проверки поменьше:

```
No test files found, exiting with code 1
25:export * from './approval.js';
```

Что из этого следует:

- **P1d даёт два решения сразу.** Lock с честным `snapshot` и совравшим `recipeHash` даёт
  `diffLock` чистый дифф во всех четырёх слотах; ловит только `verifyLockEntries` (P1e). Значит
  вызов обязателен, и рендер обязан иметь ветку «дрифт есть, показать нечего».
- **P2c/P2d сузили обоснование R11.** Расширение `defaults.env.allow` ловит сам `diffLock`
  слотом `defaults`; вердикт был бы `drifted` и без сверки дайджеста. Сверка не избыточна ровно
  на одном сценарии — lock пересчитан целиком, дайджест прежний, — и след задачи 2 построен на нём.
- **Вотчер: наблюдать можно только каталог.** По пути файла `fs.watch` на macOS пропустил запись
  на месте и замолчал навсегда после первой атомарной подмены; каталог увидел все шесть событий.
  Подмена — наш способ записи lock, и так же сохраняют vim и VSCode.
- **P3 подтверждает клампинг `0903753`**; `own` хранит объявленное.
- **P5/P6:** `parseLockFile` во всех проверенных враждебных формах возвращает диагностики и не
  бросает; `version: 1` даёт **две** — число используется в тесте.
- **`vitest` без тестов выходит с кодом 1** — отсюда слияние задач.

**Четыре ошибки, пойманные на мне же, и все одного рода — пересказ вместо чтения.** (1) Проба P5
строила lock объектным литералом `{ __proto__: {...} }`: литерал задаёт прототип, а не ключ.
Отсюда правило: **тесты на зарезервированные имена строятся из строк.** (2) §4 про
`PatternMatcher`. (3) След задачи 2 на «расширили `defaults`» — вакуумен, потому что это ловит
`diffLock`, что показывала моя же проба P2c. (4) `toTool(recipe)` вместо
`toTool(name, recipe)` — арность взята из пересказа, реальная сигнатура в §5.

Отдельно — **дефект, внесённый исправлением**: во второй редакции одобрение связывалось счётчиком
перезагрузок, который растёт при каждой загрузке. Перечитка после ответа человека всегда меняла
бы его, то есть команда отвергала бы **каждый** законный апрув, а S7 не имел бы работающей второй
половины. Связывание переведено на дайджест (§Architecture, третий пункт).

**Компиляторная проверка:** `manifest.tools.run_tests` под `noUncheckedIndexedAccess` даёт
`error TS18048: 'm.tools.run_tests' is possibly 'undefined'`.

**Чего пробы не покрывают:** `fs.watch` на Linux и Windows (замерено только на macOS — вывод
«наблюдать каталог» от этого надёжнее, но числа не переносятся); запись события аудита (E6);
рендер в Electron (E7).

---

## Tasks

### Task 1 — тест-инфраструктура, характеризация `0903753`, топологический прогон (R21, R22)

**Files:** `packages/core/package.json` (Modify), `packages/core/vitest.config.ts` (Create), `package.json` (Modify), `packages/core/src/policy/contract-characterization.test.ts` (Create), `packages/core/src/policy/runner.test.ts` (Create)

Один коммит: порознь первый оставил бы корневой `yarn test` красным (§3).

В `core` — `"test": "tsc -b && vitest run"`, `devDependencies` с `vitest` и `es-module-lexer`,
`vitest.config.ts` зеркально `contracts`. В **корневом** `package.json` скрипт `test` меняется на
`yarn workspaces foreach -Apt run test` — топологически, иначе `tsc -b` двух пакетов сойдутся на
общем `dist/` и `tsconfig.tsbuildinfo` (§3).

Пять поведений, по одному `describe`: `redact` не снимается; `maxBytes` минимумом; `env.allow`
пересекается; `durationToMs` на границе и на одиннадцати цифрах; `isRecipeName` отвергает
`__proto__`, `constructor`, `prototype` — **из сырых строк**. `runner.test.ts` — порт
`packages/contracts/src/domain.test.ts:47`.

**Falsification:** правка отсутствует → `packages/contracts/src/lock.ts:255` заменяется на
`own.output?.redact ?? base.output.redact`, наблюдаемое
`normalizeRecipe(r, base).effective.output.redact` равно `false`; правка на месте → `true`.

**Verification:** `yarn install && yarn test` зелёный на всём воркспейсе; мутация выше краснеет и
откатывается.

**Commit:** `E1: тест-инфраструктура core, пять характеризаций, топологический корневой test`

**Falsification** — ассертится `check.status`, `check.diff.changed.length`, `mismatched.length`, `denyReason` и `store.current().manifest.digest`:

**Files:** `packages/core/src/policy/lock-check.ts` (Create), `packages/core/src/policy/lock-check.test.ts` (Create), `packages/core/src/policy/store.ts` (Create), `packages/core/src/policy/store.test.ts` (Create)

Загрузка и сверка **в одной задаче**, потому что `LoadedPolicy` несёт `LockVerdict`, а `start()`
его производит: разнеси их — и `tsc -b` первой задачи упадёт на отсутствующем `./lock-check.js`
раньше, чем запустится `vitest`. Порядок внутри задачи: сначала `lock-check.ts`, потом `store.ts`.

**Interfaces:**
```ts
export interface LockVerdict {
  readonly check: LockCheck;
  readonly diagnostics: readonly Diagnostic[];
  readonly mismatched: readonly string[];
  readonly denyReason: string | null;
}
export function checkLock(manifest: LoadedManifest, lock: LoadedLock): LockVerdict;

export interface LoadedManifest {
  readonly manifest: Manifest;
  readonly matchers: ReadonlyMap<string, PatternMatcher>;
  readonly digest: string;
  readonly recipeDigests: ReadonlyMap<string, string>;
}
export type LoadedLock =
  | { readonly present: true; readonly lock: LockFile }
  | { readonly present: false; readonly reason: 'missing' }
  | { readonly present: false; readonly reason: 'unreadable'; readonly code: string; readonly message: string }
  | { readonly present: false; readonly reason: 'unparsed'; readonly diagnostics: readonly Diagnostic[] };

export type StartResult =
  | { readonly outcome: 'started'; readonly store: StartedStore }
  | { readonly outcome: 'invalid-manifest'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly outcome: 'unreadable-manifest'; readonly code: string; readonly message: string };

export type ReloadResult =
  | { readonly outcome: 'reloaded'; readonly policy: LoadedPolicy }
  | { readonly outcome: 'invalid'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly outcome: 'unreadable'; readonly code: string; readonly message: string };

export interface LoadedPolicy {
  readonly manifest: LoadedManifest;
  readonly lock: LoadedLock;
  readonly verdict: LockVerdict;
}

export interface StoreDeps {
  readonly statSize: (path: string) => Promise<number>;
  readonly readFile: (path: string) => Promise<string>;
  readonly now: () => string;
}

export declare function startStore(manifestPath: string, lockPath: string, deps?: Partial<StoreDeps>): Promise<StartResult>;

export interface StartedStore {
  current(): LoadedPolicy;
  reloadManifest(): Promise<ReloadResult>;
  reloadLock(): Promise<ReloadResult>;
  reloadCount(): number;
}
```

**`current()` без `null` теперь действительно недостижим до старта** (R6b): объект `StartedStore`
выдаётся **только** внутри `{outcome:'started'}`. Прошлая редакция объявляла `PolicyStore.at()`,
возвращавший объект с `current()` до всякого `start()`, — гарантия была словом, а не типом.
`StartResult` даёт двум отказам **разные теги**, иначе E4 не сможет сузить тип и узнать причину.

`reloadManifest`/`reloadLock` возвращают `ReloadResult`, а не `void` (R2a): иначе диагностики
перечитки некуда деть, и вызывающий не отличает «перечитка не удалась» от «перечитка удалась,
ничего не изменилось» — молчаливый fail-open на пути решения.

Размер обоих файлов проверяется `statSize` **до** `readFile` (R1a): предел манифеста иначе
срабатывает уже после чтения строки, а у lock его нет вовсе.

`checkLock` считает `diffLock` **всегда**, до всякого ветвления; решение принимается после. Шаги:
`lock.present === false` → `absent`, `denyReason` различает три формы, диагностики `'unparsed'`
переносятся (R17a). Иначе `diffLock`; затем `verifyLockEntries` — `!ok` → `drifted`, `mismatched`
в вердикт **и** синтезированная диагностика `code: 'lock'` (P1d: дифф в этом случае пуст). Затем
дайджест. Затем непустые слоты. Иначе `verified`. `deriveRiskTier` не импортируется.

**Falsification:**
1. правка отсутствует → `verifyLockEntries` не зовётся; кейс «честный snapshot, совравший
   recipeHash»: `checkLock(...).check.status` равно `'verified'`; правка на месте → `'drifted'`.
2. правка отсутствует → сверка дайджеста удалена; кейс **«lock пересчитан целиком под новый
   манифест, `manifestHash` оставлен прежним»** (`verifyLockEntries` доволен, `diffLock` чист):
   `.check.status` равно `'verified'`; правка на месте → `'drifted'`. Кейс «расширен
   `defaults.env.allow`» для этого следа **не годится** — его ловит сам `diffLock` (P2c).
3. правка отсутствует → `diffLock` считается только в ветке слотов, после дайджеста; кейс
   «дайджест разошёлся **и** рецепт изменён»: `check.status === 'drifted'` в обеих ветках, но
   наблюдаемое `check.diff.changed.length` равно `0`; правка на месте → `1`. (След, которого не
   было у этого исправления в прошлой редакции.)
4. правка отсутствует → `mismatched` не переносится; в кейсе подделки `mismatched.length` равно
   `0` при `status === 'drifted'`; правка на месте → `1`, значение `run_tests`.
5. правка отсутствует → `denyReason` не различает три формы `absent`; три кейса дают одинаковую
   строку; правка на месте → три разные.
6. правка отсутствует → неуспешная перечитка заменяет снимок; кейс «первая загрузка успешна,
   вторая возвращает `invalid`»: наблюдаемое `store.current().manifest.digest` **не равно** `d0`;
   правка на месте → равно `d0`, а `reloadManifest()` вернул `{outcome:'invalid'}` с непустыми
   диагностиками. (Прошлая редакция описывала здесь «значение из битой правки», которого не
   бывает: `ParseManifestResult` на `ok:false` манифеста не несёт — `packages/contracts/src/types.ts:99`.)
7. правка отсутствует → `Object.freeze` не рекурсивен; `manifest.tools['run_tests'].exec[0] = '/bin/sh'`
   проходит и значение меняется; правка на месте → бросает `TypeError` в strict-режиме ESM.
8. правка отсутствует → `statSize` не проверяется до чтения; `readFile` вызывается для файла
   размером `MANIFEST_MAX_BYTES + 1`; правка на месте → `readFile` не вызван вовсе.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; все восемь следов проверены
мутацией.

**Commit:** `E1: загрузка и сверка — предел до чтения, перечитка отдаёт диагностики, дифф всегда`

**Falsification** — ассертится счётчик вызовов `onChange` и первый аргумент `WatchPrimitive`:

**Files:** `packages/core/src/policy/watch.ts` (Create), `packages/core/src/policy/watch.fixture.ts` (Create), `packages/core/src/policy/watch.test.ts` (Create)

**Interfaces:**
```ts
export interface PathWatcher { start(onChange: () => void): void; stop(): void }
export interface Debounced { (): void; cancel(): void }
export function debounce(fn: () => void, ms: number): Debounced;
export type WatchPrimitive = (dir: string, listener: (event: string, filename: string | null) => void) => { close(): void };
export function dirWatcher(filePath: string, debounceMs: number, watch?: WatchPrimitive): PathWatcher;
export function watchPolicy(
  store: StartedStore,
  paths: { readonly manifestPath: string; readonly lockPath: string },
  options: { readonly debounceMs: number; readonly make?: (filePath: string, ms: number) => PathWatcher },
): { stop(): void };
```

`dirWatcher` ставит наблюдение на **каталог** файла и фильтрует по имени (R5c) — измерено, что по
пути файла вотчер умирает после первой атомарной подмены, а подмена и есть наш способ записи
lock. `WatchPrimitive` инъектируется, чтобы это свойство было **под тестом**, а не только под
пробой: иначе будущая правка тихо вернёт `fs.watch(filePath)` и сломает R5b/R5c.

`watchPolicy` возвращает `{stop()}`, а не `PathWatcher`: он уже владеет `store` и сам делает
перезагрузку, поэтому `start(onChange)` у него не имеет смысла.

`debounce` возвращает вызываемое с `cancel()`: без него `stop()` не гасит висящий таймер.

**Falsification:**
1. правка отсутствует → `debounce` возвращает `fn` без таймера; счётчик после двух вызовов и
   `vi.advanceTimersByTime(ms)` равен `2`; правка на месте → `1`.
2. правка отсутствует → `dirWatcher` зовёт примитив с `filePath`; наблюдаемый первый аргумент
   равен `filePath`; правка на месте → `dirname(filePath)`.
3. правка отсутствует → фильтр по имени снят; событие с `filename` `'other.txt'` вызывает
   `onChange`, счётчик равен `1`; правка на месте → `0`.
4. правка отсутствует → `watchPolicy` наблюдает только манифест; правка lock при неизменном
   манифесте оставляет `store.current().verdict.check.status` равным `'absent'`; правка на месте
   → `'verified'`.
5. правка отсутствует → `stop()` не зовёт `cancel()`; `stop()` сразу после события даёт счётчик
   перезагрузок `1` после прокрутки таймеров; правка на месте → `0`.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; пять следов проверены мутацией.

**Commit:** `E1: наблюдается каталог, и это под тестом, а не только под пробой`

**Falsification** — ассертится `Object.hasOwn(event, 'argv')` и `Object.hasOwn(event, 'denyReason')`:

**Files:** `packages/core/src/policy/event.ts` (Create), `packages/core/src/policy/event.test.ts` (Create)

**Interfaces:**
```ts
export interface LockCheckEventInput {
  readonly verdict: LockVerdict;
  readonly recipeName: RecipeName;
  readonly recipeDigest: string | undefined;
  readonly protocolVersion: string;
  readonly sessionId: SessionId;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly startTime: string;
  readonly endTime: string;
  readonly durationUs: number;
}
export function lockCheckEvent(input: LockCheckEventInput): AuditEvent;
```

`protocolVersion` приходит входом (R12b). `recipeDigest` берётся из `recipeDigests`.
`argv` **и** `denyReason` присоединяются условным спредом — для `argv` это следует из типа, для
`denyReason` **не следует** (§Global Constraints).

**Falsification:**
1. правка отсутствует → `argv` пишется как `argv: undefined as never` (голое `argv: undefined`
   не компилируется под `exactOptionalPropertyTypes`, поэтому мутация делается через `as`);
   `Object.hasOwn(event, 'argv')` равно `true`; правка на месте → `false`.
2. правка отсутствует → `denyReason` переносится безусловно; кейс `verified`:
   `Object.hasOwn(event, 'denyReason')` равно `true`; правка на месте → `false`.
3. правка отсутствует → `denyReason` не переносится вовсе; кейс `drifted`: `Object.hasOwn` равно
   `false`; правка на месте → `true` со строкой причины.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; событие отказа прогоняется через
`toOtlp`, проверяется наличие `mcpproxy.deny_reason`.

**Commit:** `E1: событие lock_check — argv и denyReason только когда им есть что сказать`

**Falsification** — ассертится `dirname(captured)`, флаг `open`, порядок вызовов и `readdirSync(dir).length`:

**Files:** `packages/core/src/policy/lock-write.ts` (Create), `packages/core/src/policy/lock-write.test.ts` (Create)

**Interfaces:**
```ts
export function buildLock(loaded: LoadedManifest, approvedAt: string): LockFile;
export interface WriteDeps {
  readonly tempPath: (lockPath: string) => string;
  readonly open: (path: string, flags: string) => Promise<FileHandleLike>;
  readonly rename: (from: string, to: string) => Promise<void>;
}
export interface FileHandleLike {
  write(text: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
export function writeLock(lockPath: string, lock: LockFile, deps?: Partial<WriteDeps>): Promise<void>;
```

`tempPath` возвращает **полный путь**. `open` и `sync` инъектируются именно для того, чтобы `wx`
и `fsync` были **фальсифицируемы**: прошлая редакция заявляла их в тексте и не имела ни точки
внедрения, ни следа. Каталог тоже синхронизируется после `rename` — сам `rename` не долговечен.

**Falsification:**
1. правка отсутствует → `tempPath` строит путь в `os.tmpdir()`; `dirname(captured)` не равно
   `dirname(lockPath)`; правка на месте → равно.
2. правка отсутствует → `open` зовётся с `'w'` вместо `'wx'`; наблюдаемый флаг равен `'w'`;
   правка на месте → `'wx'`.
3. правка отсутствует → `sync()` не зовётся перед `rename`; наблюдаемый порядок вызовов не
   содержит `sync` до `rename`; правка на месте → содержит.
4. правка отсутствует → `buildLock` кладёт в `manifestHash` значение
   `sha256(JSON.stringify(manifest))`; построенный `lock.manifestHash` не равен
   `manifestHash(loaded.manifest)` из `@mcpproxy/contracts/audit`; правка на месте → равен.
5. правка отсутствует → удаление временного файла при ошибке снято; инъектированный `rename`
   бросает; `readdirSync(dir).length` равно `2`; правка на месте → `1`.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; пять следов проверены мутацией.

**Commit:** `E1: buildLock от проверенного манифеста; wx, fsync и уборка — под следами`

**Falsification** — ассертится `verdictApplicability(...)` и `request.kind`:

**Files:** `packages/core/src/policy/approve.ts` (Create), `packages/core/src/policy/approve.test.ts` (Create)

**Interfaces:**
```ts
import type { ApprovalDecision } from '@mcpproxy/contracts';

export type LockApprovalRequest =
  | { readonly kind: 'drift'; readonly diff: LockDiff; readonly mismatched: readonly string[]; readonly manifestHash: string; readonly requestedAt: string }
  | { readonly kind: 'unusable'; readonly reason: 'unreadable' | 'unparsed'; readonly diagnostics: readonly Diagnostic[]; readonly manifestHash: string; readonly requestedAt: string };

export interface LockApprovalVerdict {
  readonly manifestHash: string;
  readonly decision: ApprovalDecision;
  readonly decidedAt: string;
}
export type VerdictApplicability = 'applies' | 'stale' | 'denied';
export function requestFor(policy: LoadedPolicy, requestedAt: string): LockApprovalRequest | null;
export function verdictApplicability(verdict: LockApprovalVerdict, manifest: LoadedManifest): VerdictApplicability;
```

Запрос — **размеченное объединение** (R15b). Прошлая редакция объявляла его тотальным с
обязательным `diff: LockDiff`, но у `'unreadable'` и `'unparsed'` `LockFile` нет вовсе, диффа
взять негде, а подстановка пустого диффа столкнулась бы с веткой R19a: «дрифт есть, показать
нечего» стало бы означать и подделку, и ошибку прав, и человек получил бы текст про подделку на
ошибке доступа. `null` — для `verified`, где спрашивать нечего.

Сверка идёт по `manifestHash` и только по нему (§Architecture, третий пункт). Оба поля названы
одинаково; прецедент — `packages/contracts/src/lock.ts:113`.

**Falsification:**
1. правка отсутствует → `verdictApplicability` возвращает `'applies'` при
   `decision === 'approved'` без сверки дайджеста; на манифесте с другим дайджестом наблюдаемое
   равно `'applies'`; правка на месте → `'stale'`.
2. правка отсутствует → `'stale'` и `'denied'` сливаются; кейс «человек отказал» и кейс «вердикт
   устарел» дают одинаковый результат; правка на месте → разные.
3. правка отсутствует → `requestFor` строит `kind: 'drift'` для `'unparsed'`; наблюдаемое
   `request.kind` равно `'drift'` и `request.diff` пуст; правка на месте → `'unusable'` с
   непустыми `diagnostics`.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; три следа проверены мутацией.

**Commit:** `E1: запрос апрува размечен, вердикт связан дайджестом`

**Falsification** — ассертится `outcome.kind`, `outcome.why` и факт вызова `confirm`:

**Files:** `packages/core/src/policy/render-diff.ts` (Create), `packages/core/src/policy/render-diff.test.ts` (Create), `packages/core/src/policy/lock-command.ts` (Create), `packages/core/src/policy/lock-command.test.ts` (Create), `packages/core/src/policy/confirm-tty.ts` (Create), `packages/core/src/policy/confirm-tty.test.ts` (Create), `packages/core/bin/mcpproxy-lock.mjs` (Create), `packages/core/package.json` (Modify)

**Interfaces:**
```ts
export function renderVisible(raw: string): string;
export function renderRequest(request: LockApprovalRequest): string;

export type LockCommandOutcome =
  | { readonly kind: 'written' }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'refused'; readonly why: 'stale' | 'denied' | 'expect-mismatch' | 'reload-failed' };

export function runLockCommand(
  store: StartedStore,
  confirm: (request: LockApprovalRequest, rendered: string) => Promise<LockApprovalVerdict>,
  expectDigest: string | null,
): Promise<LockCommandOutcome>;

export function parseExpect(argv: readonly string[]): string | null;
export function confirmTty(request: LockApprovalRequest, rendered: string): Promise<LockApprovalVerdict>;
```

Ветвление: `lock.reason === 'missing'` → писать без подтверждения (R15). `verified` →
`up-to-date`. Иначе — `requestFor`, `renderRequest`, `confirm`, затем **`reloadManifest()`**;
`{outcome:'invalid'|'unreadable'}` → `refused: 'reload-failed'` (перечитка, упавшая молча, была бы
fail-open); затем `verdictApplicability` против **нового** снимка; `'applies'` → писать.

**`expectDigest` — это межпроцессная половина R15a, и у неё теперь есть смысл.** `mcpproxy-lock` —
отдельный процесс от демона, поэтому связать «дайджест, на котором демон отказал» с «манифестом,
который команда подписывает», может только значение, переживающее границу процесса. Если
`expectDigest` задан и не равен `policy.manifest.digest` — `refused: 'expect-mismatch'`, до
всякого показа. Прошлая редакция объявляла параметр и не использовала его нигде.

`renderVisible` применяется **к каждой строке рендера** (R19): сырыми лежат и `exec[]`, и `cwd`,
и `params[].description`, и `env.allow[]`, и строки песочницы (§1). Свойство формулируется
независимо от санитайзера — каждый кодпойнт `\p{Cc}`/`\p{Cf}` в любой строке переживает рендер
видимым; формулировка «показываем всё, что вырезает `sanitizeDescription`» пропустила бы
`\r \n \t \v \f` (`packages/contracts/src/tool.ts:52` — `const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;`
работает уже после их замены пробелом). Длина мерой против инъекции не называется (R20).

`renderRequest` ветвится по `kind`, и у `'drift'` с пустым диффом свой текст, опирающийся на
`mismatched` (R19a).

**R18 в объёме E1 — закрепление допущения:** тест утверждает, что
`toTool(asRecipeName('run_tests'), recipe).description` не содержит подставленный U+202E, тогда
как `renderVisible` его показывает. Имя идёт **отдельным аргументом** — сигнатура в §5.

`confirm-tty.ts` несёт разбор `--expect` и чтение ответа человека и **покрыт своим тестом**: это
два входа, на которых держится весь гейт, и жить им в непроверяемом `.mjs` нельзя.
`bin/mcpproxy-lock.mjs` — три строки. `package.json` получает `bin` **и** `bin` в `files`, иначе
`files: ["dist"]` его не отгрузит.

**Falsification:**
1. правка отсутствует → команда пишет при `drifted`, не зовя `confirm`; `confirm` не вызван,
   `kind` равен `'written'`; правка на месте → вызван, и при `decision: 'denied'` файл не
   изменён, `kind` равен `'refused'`.
2. **правка на месте → `kind` равен `'written'`.** Кейс: `drifted`, `confirm` отвечает
   `approved`, манифест на диске не меняется. Правка отсутствует (связывание по счётчику
   перезагрузок вместо дайджеста) → `kind` равен `'refused'` с `why: 'stale'`, потому что
   перечитка всегда двигала бы счётчик. Это след на **успешный** путь: прошлая редакция имела
   только следы на отказ, и поэтому реализация, не умеющая писать вообще никогда, проходила их все.
3. правка отсутствует → перечитка после `confirm` снята; кейс «инъектированный `confirm` правит
   манифест на диске прежде чем ответить»: `kind` равен `'written'`; правка на месте →
   `'refused'` с `why: 'stale'`. **Это окно CVE-2025-54136, воспроизведённое тестом.**
4. правка отсутствует → результат `reloadManifest()` игнорируется; кейс «перечитка возвращает
   `invalid`»: `kind` равен `'written'`; правка на месте → `'refused'` с `why: 'reload-failed'`.
5. правка отсутствует → `expectDigest` не сверяется; кейс «задан чужой дайджест»: `confirm`
   вызван и `kind` равен `'written'`; правка на месте → `confirm` не вызван, `kind` равен
   `'refused'` с `why: 'expect-mismatch'`.
6. правка отсутствует → `'unparsed'` попадает в ветку записи без подтверждения; кейс «битый
   lock»: `'written'` без вызова `confirm`; правка на месте → `confirm` вызван с
   `kind: 'unusable'`.
7. правка отсутствует → `renderVisible` применяется только к `description`; кейс «U+202E в
   `exec[0]`»: рендер не содержит `<U+202E>`; правка на месте → содержит.
8. правка отсутствует → ветка «дрифт без диффа» снята; кейс подделанного lock: рендер не
   содержит `run_tests`; правка на месте → содержит.
9. правка отсутствует → `parseExpect` берёт `argv[1]` вместо значения после `--expect`; кейс
   `['--expect','abc']` даёт `'--expect'`; правка на месте → `'abc'`.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; девять следов проверены мутацией.
Плюс ручной прогон во временном каталоге с фикстурой манифеста, лежащей в
`packages/core/src/policy/` (не в `packages/contracts/recipes/`: тот путь не объявлен в `exports`
пакета): без lock команда пишет его и `checkLock` даёт `verified`; после правки манифеста команда
показывает дифф, при отказе не пишет, **при подтверждении пишет**, и повторный `checkLock` снова
даёт `verified`.

**Commit:** `E1: команда перечитывает манифест после ответа, expectDigest связывает процессы`

**Falsification** — ассертится `new Set(records.map((r) => r.key)).size` и число находок `scanSources`:

**Files:** `packages/core/src/policy/diagnostics-log.ts` (Create), `packages/core/src/policy/diagnostics-log.test.ts` (Create), `packages/core/src/policy/boundary.test.ts` (Create), `packages/core/src/policy/scan.ts` (Create), `packages/core/src/index.ts` (Modify)

**Interfaces:**
```ts
export interface DiagnosticRecord {
  readonly key: string;
  readonly pointer: string;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}
export function toLogRecords(diagnostics: readonly Diagnostic[], origin: 'manifest' | 'lock'): readonly DiagnosticRecord[];

export interface ScanRule { readonly pattern: RegExp; readonly roots: readonly string[]; readonly allow: readonly string[] }
export function scanSources(repoRoot: string, rule: ScanRule): readonly string[];
```

`toLogRecords` берёт **пачку**, потому что ключ обязан быть уникален, а у диагностик lock
координат нет (`packages/contracts/src/validate/lock.ts:62` — `    line: 1,`), и `pointer` у них
это `tools.${name}`, пропущенный через `sanitizeDescription`. Развести две враждебные записи
может только порядковый номер в пределах разбора — из одной диагностики его не вычислить.

`scanSources` принимает `repoRoot`, поэтому тесты гоняют его на **фикстурном дереве** в temp, а не
подсаживают нарушение в рабочий код (`tsc -b` компилирует `src/**/*.ts`, и подсадка сделала бы
продакшн-скан вечно красным).

`boundary.test.ts` — четыре проверки:
1. **R23, транзитивно.** Обход графа с резолвом workspace-спецификаторов, **включая подпути**:
   `core` импортирует `@mcpproxy/contracts/validate` и `.../audit`, и это именно те входы, что
   тянут `ajv`/`re2`/`node:crypto`. Отображение по базовому имени пакета их бы не прошло —
   слепое пятно, ради которого правка и делается. Подпуть резолвится через `exports` в
   `packages/contracts/package.json` в конкретный `dist/<sub>/index.js`. Плюс непустая проверка
   графа.
2. **R8 и вторая половина R1.** Два **разных** правила, а не одно: `parseManifest` не зовётся вне
   `store.ts` — корень `packages/core/src/**`, как и написано в R1; `JSON.parse` над текстом
   lock — корень `packages/core/src/policy/**` и `packages/core/bin/**`, сужено намеренно, потому
   что по R24a на эту ветку ребейзятся E2/E3/E6, которые будут законно парсить JSON у себя.
   Прошлая редакция сводила оба правила к одному корню и тем самым молча отдавала меньше, чем
   заявляет R1. `allow` — настоящий список (сегодня пуст), а не ноль.
3. `deriveRiskTier` не встречается **нигде в `policy/**`** — не только в `lock-check.ts`: у
   `AuditEvent` есть слот `risk` (`packages/contracts/src/event.ts:96`), и `event.ts` — как раз то
   место, где отображение могло бы всплыть заново.
4. **R24, исполняемо.** Множество изменённых путей ⊆ списка R24. Берётся
   `git diff --name-only origin/main...HEAD` (**три точки** — от точки ветвления, иначе коммиты,
   попавшие в `main` после ответвления, читаются как наши нарушения) **и**
   `git status --porcelain --untracked-files=all`, потому что `git diff` не видит неотслеживаемых
   файлов, а все поставки E1 — новые файлы: без второй половины проверка молчала бы ровно там,
   где должна говорить.

`index.ts` — реэкспорт публичной поверхности; `watch.fixture.ts` в него не входит.

**Falsification:**
1. правка отсутствует → `toLogRecords` строит ключ без порядкового номера; кейс «две враждебные
   записи в одном lock, чьи имена схлопываются санитизацией в один `pointer`»:
   `new Set(records.map(r => r.key)).size` равно `1`; правка на месте → `2`.
2. правка отсутствует → `scanSources` не спускается в подкаталоги; фикстурное дерево с
   нарушением в `policy/nested/x.ts` даёт `0` находок; правка на месте → `1`.
3. правка отсутствует → правило `parseManifest` ограничено `policy/**`; фикстура с вызовом в
   `core/src/other/y.ts` даёт `0`; правка на месте → `1`.
4. правка отсутствует → резолв подпутей снят; фикстурный граф, где `electron` достижим только
   через `@mcpproxy/contracts/validate`, даёт `0` нарушений; правка на месте → `1`.
5. правка отсутствует → R24-проверка использует две точки и опускает `git status`; кейс
   «неотслеживаемый файл вне списка» даёт `0` нарушений; правка на месте → `1`.

**Verification:** `yarn typecheck && yarn build && yarn test` зелёные на всём воркспейсе; пять
следов проверены мутацией.

**Commit:** `E1: ключ лога уникален, скан разделён на два правила, R24 проверяется исполняемо`

---

## Requirement diff

| Требование | Строка плана |
|---|---|
| R1 | Задача 2: `startStore` — единственная загрузка; запрет обхода — правило `parseManifest` по `core/src/**` в задаче 8, п. 2 |
| R1a | Задача 2: «Размер обоих файлов проверяется `statSize` **до** `readFile`» + след 8 |
| R2 | Задача 8: «`toLogRecords` берёт **пачку**» + след 1 |
| R2a | Задача 2: `ReloadResult` вместо `void` + след 6 |
| R3 | Задача 2: `invalid-manifest`/`unreadable-manifest` на старте; при перечитке снимок не заменяется; сломанный lock → `absent` |
| R4 | Задача 2: след 6 |
| R5 | Задача 3: `debounce` с `cancel()` + след 5 |
| R5a | Задача 2: `LoadedManifest` одним значением |
| R5b | Задача 3: след 4 |
| R5c | Задача 3: следы 2 и 3 — примитив зовётся с `dirname`, фильтр по имени работает |
| R6 | Задача 2: след 7 |
| R6a | Задача 2: четыре формы `LoadedLock` |
| R6b | Задача 2: «`StartedStore` выдаётся **только** внутри `{outcome:'started'}`» |
| R7 | Задача 2: `checkLock`; распределение шагов записано в spec R7 |
| R8 | Задача 8, п. 2: правило `JSON.parse` + след 2 |
| R9 | Задача 2: «`lock.present === false` → `absent`» |
| R10 | Задача 2: следы 1 и 4 |
| R11 | Задача 2: след 2 — «lock пересчитан целиком, дайджест прежний» |
| R12 | Задача 4: след 1 |
| R12a | Задача 4: следы 2 и 3 |
| R12b | Задача 4: «`protocolVersion` приходит входом» |
| R13 | Задача 8, п. 3: скан всего `policy/**` |
| R14 | Задача 5: след 4 |
| R14a | Задача 5: следы 2 (`wx`), 3 (`fsync` до `rename`), 5 (уборка) |
| R15 | Задача 7: «`missing` → писать без подтверждения» |
| R15a | Задача 7: следы 3 (перечитка) и 5 (`expectDigest`) |
| R15b | Задача 7: след 6; форма запроса — задача 6, след 3 |
| R16 | Задача 6: следы 1 и 2 |
| R17 | Задача 6: `isHeadless` отсутствует; отказ безусловен в задаче 2 |
| R17a | Задача 2: след 5 |
| R18 | Задача 7: «`toTool(asRecipeName('run_tests'), recipe).description` не содержит подставленный U+202E» |
| R19 | Задача 7: след 7 |
| R19a | Задача 7: след 8 |
| R20 | Задача 7: «Длина мерой против инъекции не называется» |
| R21 | Задача 1: скрипт, конфиг, `runner.test.ts`, топологический корневой `test` |
| R22 | Задача 1: пять `describe` |
| R23 | Задача 8, п. 1 + след 4 |
| R24 | Задача 8, п. 4 + след 5 |
| R24a | Записано в `spec.md` как решение владельца |
