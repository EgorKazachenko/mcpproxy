# E1 — policy engine: план

**Clean-code review:** passed (round 1) (2026-08-27)
**Plan review:** раунд 1 — REVISE, применено 7 BLOCKER и 11 MAJOR (2026-08-27)

## Goal

Реализовать требования `spec.md`: слой политики в `packages/core/src/policy/**`, который читает
манифест и lock с диска, сверяет их, на расхождении даёт `denied` на стадии `lock_check` с полным
диффом «было / стало», и по явной команде человека — показав дифф и получив подтверждение —
записывает новый lock.

## Architecture

E1 — **оркестровка и I/O вокруг замороженных чистых функций** `@mcpproxy/contracts`. Ни одна
формула, ни одна нормализация, ни одна санитизация в E1 не пишется заново.

Ключевое разделение: **вся сверка делается на изменении файлов, на вызове не делается ничего.**
`lock_check` — стадия каждого вызова (`packages/contracts/src/domain.ts:28`) и она **не** входит
в `OVERHEAD_EXCLUDED_STAGES` (`packages/contracts/src/event.ts:149`), то есть попадает в бюджет
≤ 50 мс p95. А сверка стоит секунды: `diffLock` зовёт `normalizeRecipe` на каждый рецепт
(`packages/contracts/src/lock.ts:309`), и ровно эта работа замерена в
`packages/contracts/src/validate/index.ts:82` как **2.2 с CPU на манифесте в 258 КБ**;
`verifyLockEntries` считает `canonicalizeJcs` + SHA-256 на каждую запись lock
(`packages/contracts/src/audit/lock.ts:43`).

Поэтому `LockVerdict` вычисляется **в момент загрузки**, а на вызове читается как поле. Оба входа
— манифест и lock — меняются только на диске, и оба под наблюдением.

Второе разделение, из которого следует всё остальное: манифест и lock — **разные сущности с
разным временем жизни**. Lock меняется, когда человек выполнил команду; манифест — когда его
правят. Слив их в одно значение, мы получили бы перечитку и перехэширование манифеста (те самые
2.2 с) ради подхвата нового lock.

```
                     ┌── loadManifest() ── при правке mcpproxy.yaml ──────────┐
mcpproxy.yaml ─────▶ │ parseManifest ─▶ manifest(frozen) + matchers           │
                     │ manifestHash  ─▶ digest ; recipeHash·N ─▶ recipeDigests│
                     └───────────────────────────┬───────────────────────────┘
                     ┌── loadLock() ── при правке mcpproxy.lock ──────────────┐
mcpproxy.lock ─────▶ │ parseLockFile ─▶ lock | absent(reason) + diagnostics   │
                     └───────────────────────────┬───────────────────────────┘
                                                 ▼  любое из двух изменилось
                                   recheck(): verifyLockEntries → diffLock
                                                 ▼
                          LoadedPolicy { manifest, lock, verdict, generation }
                                                 │
   на вызове: policy.verdict ── поле, не вычисление ──▶ lockCheckEvent(...)
                                                 │
   mcpproxy lock: renderLockDiff ─▶ человек ─▶ verdict(--expect digest) ─▶ writeLock
```

## Tech Stack

Node ≥ 22, TypeScript 5.6, ESM (`"type": "module"`, `module: NodeNext`), Yarn 4.9.1 workspaces,
vitest 3. `packages/core` зависит ровно от `@mcpproxy/contracts` (`workspace:*`).

## Global Constraints

`packages/contracts` не меняется ни одной строкой. Список путей, которые E1 имеет право трогать,
и решение владельца R24a о том, почему четыре из них пересекаются с сиблингами волны 1, —
в `spec.md`, R24. Здесь он не переписывается своими словами: прошлая редакция этого плана
объявила «из `spec.md` дословно» список, которого в спеке не было.

**Строгость компилятора (из таблицы 3 ниже, а не по памяти):** `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
`noImplicitOverride`. Три следствия, меняющих дизайн:

- `exactOptionalPropertyTypes` — `{ argv: undefined }` **не** присваивается в
  `argv?: readonly string[]` (`packages/contracts/src/event.ts:89`), и `strict` не пустит
  `argv: null`. Требование R12 держится типом, а не дисциплиной: событие собирается условным
  спредом.
- `noUncheckedIndexedAccess` — `manifest.tools` объявлен как `{ [k: string]: Recipe }`
  (`packages/contracts/src/manifest.generated.ts:36`), поэтому `tools['run_tests']` имеет тип
  `Recipe | undefined`, а `exec[0]` — `string | undefined`. Проверено компилятором, см. §8.
- `verbatimModuleSyntax` — все импорты типов пишутся `import type`.

---

## Pre-flight

### 1. Write path — для каждой коллекции или поля, которые план читает или пишет

| Field / collection | Producer | Every transform between device and document | Drops or merges data? |
|---|---|---|---|
| `Manifest` | `packages/contracts/src/validate/index.ts:102` | YAML-текст → `parseYaml` → ajv → `refine` → `notHashable` → `Manifest` | нет; форма документа возвращается как есть |
| `Manifest.tools[n].description` | `packages/contracts/src/validate/index.ts:102` | хранится **сырым**; чистится только на проекции в `packages/contracts/src/tool.ts:136` | да — `sanitizeDescription` режет и обрезает, но только в `toTool`, не в `Manifest` |
| `NormalizedRecipe.own` | `packages/contracts/src/lock.ts:207` | `Recipe` → `own` (описание дословно, `params` в порядке объявления) | нет; `own` несёт **объявленные** значения |
| `NormalizedRecipe.effective` | `packages/contracts/src/lock.ts:245` | `defaults` ⊕ рецепт с клампингом | **да**: `Math.min` по `maxBytes`, `\|\|` по `redact`, пересечение по `env.allow` |
| `LockFile` | E1, `lock-write.ts` (новый) | `Manifest` → `normalizeDefaults`/`normalizeRecipe` → `recipeHash`/`manifestHash` → JSON с отступом → temp+fsync+rename | нет; **печатается** с отступом, а хэшируется только каноническая форма |
| `LockVerdict` | E1, `lock-check.ts` (новый) | загруженные манифест и lock → `verifyLockEntries` → `diffLock` → вердикт | нет |

Ключевая строка — четвёртая: `effective` **сливает и клампит**, `own` — нет, и хэш считается по
`own`. Перепутав их, E1 получил бы дрифт на каждом рецепте при любой правке `defaults`.

### 2. Consumers — для каждого символа, который план меняет

Меняется ровно один существующий символ: содержимое `packages/core/src/index.ts` (сегодня
`export {}`). Паста грепа целиком.

```
$ grep -rn "@mcpproxy/core" --include="*.ts" --include="*.json" . | grep -v node_modules | grep -v "/dist/"
packages/core/package.json:2:  "name": "@mcpproxy/core",
packages/bench/package.json:22:    "@mcpproxy/core": "workspace:*"
packages/mcp-server/package.json:22:    "@mcpproxy/core": "workspace:*"
```

| Symbol | Reader (`file:line`) | What that reader does with the value | Does the reader's test mock it? |
|---|---|---|---|
| `@mcpproxy/core` (весь вход) | `packages/mcp-server/package.json:22` | `"@mcpproxy/core": "workspace:*"` — зависимость объявлена, ни одного `import` нет: `packages/mcp-server/src/index.ts:2` это `export {};` | нет тестов вовсе |
| `@mcpproxy/core` (весь вход) | `packages/bench/package.json:22` | `"@mcpproxy/core": "workspace:*"` — то же самое | нет тестов вовсе |

Три хита, три строки, ни одного импорта: **у `@mcpproxy/core` сегодня нет ни одного потребителя
кода.** Оба пакета объявили зависимость заранее, под E4 и E8. Следствие: наполнение `index.ts` не
может сломать компиляцию сиблинга сегодня, но **войдёт в их граф сборки** (`tsc -b` строит по
ссылкам), поэтому `build-test` обязан гонять весь воркспейс, а не только `core`.

### 3. Infrastructure — по строке на пакет

| Package | Test command actually used | `setupFiles` | env forced by setup | app built per worker or per test | tsconfig strictness | ESLint severities |
|---|---|---|---|---|---|---|
| `packages/core` | `yarn workspace @mcpproxy/core test` → **создаётся задачей 1**; сегодня скрипта `test` нет | нет | нет | `tsc -b` один раз перед `vitest run` | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` | ESLint в репозитории отсутствует |
| `packages/contracts` | `yarn workspace @mcpproxy/contracts test` (`packages/contracts/package.json:28` — `"test": "tsc -b && vitest run",`) | нет | нет | `tsc -b` перед прогоном, потому что `deps.test.ts` и `api-surface.test.ts` ходят по `dist/` | те же | те же |

**Почему `test` в `core` отсутствует и почему это дефект.** Корневой `package.json:15` —
`"test": "yarn workspaces foreach -Ap run test",`; `foreach` молча пропускает пакет без такого
скрипта. Значит сегодня корневой `yarn test` гоняет **только** `contracts`, и гейт `build-test`
был бы зелёным на пустом `core`. Это дословно тот отказ, ради которого в E0 существовало R21.

**Ловушка при бутстрапе, измеренная, а не предположенная.** `vitest run` без единого тест-файла
печатает `No test files found, exiting with code 1`. Поэтому задача 1 **не** имеет собственного
зелёного прогона как приёмки, и `passWithNoTests: true` в конфиг **не** добавляется: он вернул бы
ровно то «зелёное на пустоте», против которого R21 и написан. Приёмка задачи 1 — первый прогон
в задаче 2.

**Числа файлов не хардкодятся.** Вместо «после задачи N должно быть M файлов» в `core`
портируется исполняемая проверка из `packages/contracts/src/domain.test.ts:47`: рекурсивный обход
пакета, утверждение, что найден хотя бы один `*.test.ts` (защита от пустоты) и что ни один не
лежит вне `src/`, куда `include` не смотрит. Такая проверка не устаревает, когда E2 добавит в
`core` свои файлы.

Существующих тест-файлов, назначаемых домом новой проверки, нет: все тесты E1 создаются заново,
ни один тест `contracts` не редактируется.

### 4. Runtime shape — всё, что план спредит, клонирует, мутирует или переприсваивает

| Value | Loader that produced it | Loader's return type | Spread allowed? |
|---|---|---|---|
| `Manifest` | `parseManifest`, `packages/contracts/src/validate/index.ts:102` | plain object — из `doc.toJS()` библиотеки `yaml` | да; E1 не спредит, а **замораживает** (R6) |
| `LockFile` | `parseLockFile`, `packages/contracts/src/validate/lock.ts:149` | plain object — из `JSON.parse` | да |
| `NormalizedRecipe` | `normalizeRecipe`, `packages/contracts/src/lock.ts:207` | plain object, собран литералами | да |
| `LockDiff` | `diffLock`, `packages/contracts/src/lock.ts:308` | plain object с `readonly`-полями | да, но E1 только читает |
| `PatternMatcher` | `parseManifest` → `matchers` | **plain object literal**: `packages/contracts/src/validate/regex.ts:43` — `  return { ok: true, matcher: { test: (value: string) => re.test(value) } };` | да — `test` это **собственное** свойство-замыкание, спред и заморозка его сохраняют |

**Исправление прошлой редакции, и оно важнее самой строки.** Здесь было написано, что
`PatternMatcher` — «непрозрачная обёртка над RE2», чьё поведение живёт на прототипе, спредить её
нельзя, а заморозка её ломает. Это неверно: `test` — собственное свойство объектного литерала,
замыкание над `re`. Заморозка ничего не ломает, спред ничего не теряет. Утверждение пришло из
пересказа, а не из чтения `regex.ts:43`, и на нём был построен falsification-след задачи 3,
который поэтому был **зелёным при обеих ветках** — вакуумное отрицание того самого класса, ради
которого в E0 гоняли тридцать мутаций.

Граница заморозки от этого не меняется — замораживается только `manifest`, — но обоснование
теперь честное: замораживать `Map` бессмысленно (это не влияет ни на `get`, ни на вызов `test`),
а не опасно. Отдельного falsification-следа у бессмысленного действия быть не может, и он снят.

### 5. Premises — каждое «потому что здесь верно X»

| Premise | The grep that establishes it | Quoted evidence | Every site where it holds | Decision at each site |
|---|---|---|---|---|
| `LockCheck` не производится ничем в контракте | `grep -rn "LockCheck" packages/contracts/src` | `packages/contracts/src/lock.ts:155` — `export type LockCheck =` | единственное объявление, ноль производителей | E1 пишет `recheck` (задача 4) |
| Дрифт не отображается в риск-тир | `grep -n "deriveRiskTier" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:152` — `расхождение с lock не отображается` | одно место, доккомментарий над `LockCheck` | `lock-check.ts` не импортирует `deriveRiskTier`; проверка в задаче 10 |
| `diffLock` нормализует каждый рецепт | `grep -n "normalizeRecipe" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:309` — `  const current = new Map(` | одно место, начало `diffLock` | сверка уходит с пути вызова (задачи 3, 4) |
| Та же работа замерена в 2.2 с | `grep -n "2.2" packages/contracts/src/validate/index.ts` | `packages/contracts/src/validate/index.ts:82` — `форма стоит 2.2 с CPU на манифесте в 258 КБ` | одно место, доккомментарий `notHashable` | то же |
| `lock_check` не исключён из бюджета оверхеда | `grep -n "OVERHEAD_EXCLUDED_STAGES" packages/contracts/src/event.ts` | `packages/contracts/src/event.ts:149` — `export const OVERHEAD_EXCLUDED_STAGES` | одно объявление; `lock_check` в списке отсутствует | то же |
| `redact` включается и не снимается | `grep -n "redact" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:255` — `      redact: (own.output?.redact ?? false) \|\| base.output.redact,` | одно место | характеризационный тест (задача 2) |
| `env.allow` пересекается, а не заменяется | тот же греп | `packages/contracts/src/lock.ts:258` — `    env: { allow: (own.env?.allow ?? base.env.allow).filter((one) => base.env.allow.includes(one)) },` | одно место | характеризационный тест (задача 2) |
| `maxBytes` берётся минимумом | тот же греп | `packages/contracts/src/lock.ts:253` — `            : Math.min(own.output.maxBytes, base.output.maxBytes),` | одно место | характеризационный тест (задача 2) |
| Предел длительности — константа, а не длина строки | `grep -n "DURATION_MAX_MS" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:35` — `export const DURATION_MAX_MS = 2_147_483_647;` | объявление; применяется в `refine` | таблица D−1/D/D+1 в §6, тест в задаче 2 |
| `protocolVersion` нельзя брать из константы сборки | `grep -n "protocolVersion" packages/contracts/src/event.ts` | `packages/contracts/src/event.ts:60` — `утверждающая нашу константу вместо согласованного значения` | одно поле, один доккомментарий | приходит входом в `lockCheckEvent` (задача 6) |
| `ApprovalDecision` уже экспортирован из корневого входа | `grep -n "approval" packages/contracts/src/index.ts` | `packages/contracts/src/index.ts:25` — `export * from './approval.js';` | один реэкспорт | импортируется типом (задача 8); `contracts` не меняется |
| Диагностики lock не несут координат | `grep -n "line: 1" packages/contracts/src/validate/lock.ts` | `packages/contracts/src/validate/lock.ts:62` — `    line: 1,` | один конструктор `at`, все диагностики lock | ключ логa для них строится иначе, см. задачу 10 |
| Прецедент против переименования поля | `grep -n "замороженная формула" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:113` — `замороженная формула носит это имя` | один доккомментарий | оба поля апрува зовутся `manifestHash` (задача 8) |
| `core` сегодня пуст | `cat packages/core/src/index.ts` | `packages/core/src/index.ts:2` — `export {};` | один файл | наполняется в задачах 3..10 |

### 6. Ordered parameter — граница `durationToMs`

Регулярка `packages/contracts/src/lock.ts:46` режет по **цифрам**, `DURATION_MAX_MS` — по
**значению**.

| Parameter value | Output | Branch taken |
|---|---|---|
| `"2147483646ms"` (10 цифр, < max) | `2147483646` | разбирается, проходит `checkDuration` |
| `"2147483647ms"` (10 цифр, = max) | `2147483647` | разбирается, проходит — **измерено, P4b** |
| `"2147483648ms"` (10 цифр, > max) | `2147483648`, затем отбой в `checkDuration` | разбирается, отвергается по значению |
| `"99999999999ms"` (11 цифр) | `TypeError` | не разбирается вовсе — **измерено, P4c** |

Выход монотонен по значению: до `DURATION_MAX_MS` включительно принимается, выше — нет.
Немонотонен только *механизм* отказа, и это два независимых предела: до `0903753` они расходились
и оставляли мёртвую полосу, в которой сама экспортируемая константа отвергалась как «десять
цифр».

**Следствие для задачи 7:** `buildLock` зовёт `normalizeRecipe`, а тот — `durationToMs`, который
**бросает** `TypeError`. `buildLock` принимает `Manifest` и обязан либо объявить предусловие
«манифест пришёл из `parseManifest`», либо ловить. План выбирает предусловие и закрепляет его
типом входа: `buildLock` берёт `LoadedManifest`, который иначе как из `loadManifest()` не
получить.

### 7. Classifier outputs — ветвление по возвращаемому значению

| Input in scope | Returned value | Branch taken | Surviving outcome |
|---|---|---|---|
| lock отсутствует (ENOENT) | `LoadedLock.present === false`, `reason: 'missing'` | `absent` | `denied`, `denyReason: 'lock отсутствует'` |
| lock не читается (EACCES) | `present === false`, `reason: 'unreadable'` + `code`/`message` | `absent` | `denied`, `denyReason` называет права, а не отсутствие |
| lock не JSON | `parseLockFile` → `{ok:false, diagnostics:[lock]}` | `absent` | `denied` + диагностики в лог |
| lock `version: 1` | `{ok:false}`, **2 диагностики** — измерено, P5 | `absent` | `denied` + обе диагностики |
| `verifyLockEntries` → `{ok:false, mismatched:[…]}` | — | `drifted` | `denied`; `diffLock` при этом **пуст** (измерено, P1d), поэтому синтезируется диагностика с именами записей, и рендер идёт по ветке «дрифт без диффа» |
| `diffLock` вернул четыре пустых слота | `{defaults:null, added:[], removed:[], changed:[]}` | `verified` | `allowed`, вызов идёт на стадию `validate` |
| `defaults` расширен, рецепты не тронуты | `defaults` ≠ null, `changed.length === 0` — измерено, P2c/P2d | `drifted` | `denied` + дифф из одного слота |

### 8. Verified facts this plan is built on

Пробы написаны против **настоящего** `dist`, прогнаны 2026-08-27 и удалены. Сырой вывод дословно:

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

Проверки, прогнанные отдельно после ревью, тоже дословно:

```
No test files found, exiting with code 1
25:export * from './approval.js';
```

Что из этого следует:

- **P1d — самый важный результат разведки, и он же источник ветки «дрифт без диффа».** Lock, у
  которого `snapshot` честен, а `recipeHash` соврал, даёт `diffLock` **полностью чистый дифф во
  всех четырёх слотах**; ловит его только `verifyLockEntries` (P1e). Отсюда два разных вывода:
  вызов `verifyLockEntries` обязателен (иначе вердикт был бы `verified` на подделанном lock), и
  рендер обязан иметь текст для случая «дрифт есть, показать нечего» — иначе на самом враждебном
  пути человек видит пустую модалку.
- **P2 — обоснование сверки `manifestHash` целиком.** Расширение `defaults.env.allow` оставляет
  **все** порецептные хэши совпадающими (P2a), `manifestHash` расходится (P2b), а `diffLock`
  кладёт правку в слот `defaults` и **не размножает** её по `changed` (P2c/P2d, длина 0).
- **P3 — клампинг из `0903753` подтверждён исполнением**, и `own` сохраняет объявленные значения
  (P3d): хэш считается по объявленному, политика применяется по вычисленному.
- **P5/P6 — `parseLockFile` во всех проверенных враждебных формах возвращает диагностики и не
  бросает**, включая одиночный суррогат внутри `snapshot` (P6).
- **`vitest` без тестов выходит с кодом 1** — отсюда бутстрап-порядок задач 1→2.
- **`ApprovalDecision` уже в корневом входе** — отсюда импорт типа вместо переобъявления.

**Две ошибки, пойманные на мне же.** Первая: проба P5 сначала строила lock объектным литералом
`{ __proto__: {...} }` и получила `ok`, из чего напрашивался вывод «`parseLockFile` пропускает
зарезервированные имена». Литерал `{__proto__: x}` задаёт прототип, а не ключ, поэтому `tools`
уезжал пустым и проба отвечала на другой вопрос. Переписано на сырую JSON-строку — контракт
держится. Отсюда правило: **тесты E1 на зарезервированные имена строятся из строк.**
Вторая — в §4 выше, про `PatternMatcher`: пересказ вместо чтения, и построенный на нём вакуумный
тест.

**Компиляторная проверка:** `manifest.tools.run_tests` под `noUncheckedIndexedAccess` даёт
`error TS18048: 'm.tools.run_tests' is possibly 'undefined'`. Все обращения в тестах пишутся
`tools['run_tests']?.exec[0]`.

**Чего пробы не покрывают:** ничего про `fs.watch` (задача 5 проверяется на чистой функции
коалесценции и ручном триггере); ничего про запись события аудита (райтера нет, это E6 — E1
отдаёт форму события, а не пишет её); ничего про рендер в Electron (E7).

**Снятое `ASSUMED`.** Прошлая редакция объявляла допущением атомарность `rename` между файловыми
системами и предлагала её проверять. Допущение верное, проверять его незачем, и риск не в нём.
Реальные риски записи перечислены в задаче 7 и закрыты: `fsync` до `rename` (иначе обрыв питания
оставляет lock нулевой длины), эксклюзивное создание уникального временного имени (иначе два
одновременных запуска команды пишут в один путь), удаление временного файла при ошибке.

---

## Tasks

### Task 1 — тест-инфраструктура `packages/core` (R21)

**Files:** `packages/core/package.json` (Modify), `packages/core/vitest.config.ts` (Create)

**Interfaces:** нет.

Добавить `"test": "tsc -b && vitest run"` в `scripts`; добавить `"vitest": "^3"` в новый блок
`devDependencies`; создать `vitest.config.ts` зеркально `packages/contracts/vitest.config.ts` —
`environment: 'node'`, единственный `include: ['src/**/*.test.ts']`. `passWithNoTests` **не**
добавляется, причина в §3.

**Verification:** `yarn install` проходит; `yarn workspace @mcpproxy/core run build` зелёный.
Собственного зелёного прогона тестов у задачи нет по построению — приёмка в задаче 2.

**Commit:** `E1: тест-инфраструктура core — без неё build-test зелен на пустоте`

### Task 2 — характеризация `0903753` и защита раннера (R21, R22)

**Files:** `packages/core/src/policy/contract-characterization.test.ts` (Create), `packages/core/src/policy/runner.test.ts` (Create)

Пять поведений, по одному `describe` на каждое, чтобы число в тексте и число блоков совпадали:
`redact` не снимается рецептом; `maxBytes` берётся минимумом; `env.allow` пересекается;
`durationToMs` принимает `DURATION_MAX_MS` и бросает на одиннадцати цифрах; `isRecipeName`
отвергает `__proto__`, `constructor`, `prototype` — **из сырых строк**, см. §8.

`runner.test.ts` — порт `packages/contracts/src/domain.test.ts:47`: обход пакета, утверждение о
непустоте найденных `*.test.ts` и об отсутствии тест-файлов вне `src/`.

**Falsification:** правка отсутствует → `redact: (own.output?.redact ?? false) || base.output.redact`
в `packages/contracts/src/lock.ts:255` заменяется на `own.output?.redact ?? base.output.redact`,
исполнение доходит до `contract-characterization.test.ts`, наблюдаемое
`normalizeRecipe(r, base).effective.output.redact` равно `false`; правка на месте → `true`.

**Verification:** `yarn workspace @mcpproxy/core test` — первый зелёный прогон в пакете; затем
вручную применить мутацию, убедиться, что тест краснеет, откатить.

**Commit:** `E1: пять характеризационных поведений из ungated 0903753 плюс защита раннера`

### Task 3 — загрузка манифеста и lock как две независимые сущности (R1, R3, R4, R5a, R6, R6a)

**Files:** `packages/core/src/policy/store.ts` (Create), `packages/core/src/policy/store.test.ts` (Create)

**Interfaces:**
```ts
export interface LoadedManifest {
  readonly manifest: Manifest;
  readonly matchers: ReadonlyMap<string, PatternMatcher>;
  readonly digest: string;
  readonly recipeDigests: ReadonlyMap<string, string>;
}

export type LoadedLock =
  | { readonly present: true; readonly lock: LockFile; readonly diagnostics: readonly Diagnostic[] }
  | { readonly present: false; readonly reason: 'missing'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly present: false; readonly reason: 'unreadable'; readonly code: string; readonly message: string; readonly diagnostics: readonly Diagnostic[] };

export type ManifestLoad =
  | { readonly outcome: 'loaded'; readonly loaded: LoadedManifest }
  | { readonly outcome: 'invalid'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly outcome: 'unreadable'; readonly code: string; readonly message: string };

export interface LoadedPolicy {
  readonly manifest: LoadedManifest;
  readonly lock: LoadedLock;
  readonly verdict: LockVerdict;
  readonly generation: number;
}

export declare class PolicyStore {
  static at(manifestPath: string, lockPath: string): PolicyStore;
  loadManifest(): Promise<ManifestLoad>;
  loadLock(): Promise<LoadedLock>;
  current(): LoadedPolicy | null;
}
```

`LoadedManifest` — одно неделимое значение (R5a): манифест, матчеры, дайджест и **порецептные
дайджесты**, посчитанные здесь же. Последние нужны задаче 6 готовыми, иначе `recipeHash` вернулся
бы на путь вызова.

`LoadedLock` и `LoadedManifest` загружаются **порознь**: у них разные файлы и разное время жизни.
Обновление lock не влечёт перечитку манифеста, а значит и его перехэширование в 2.2 с.

Ошибка чтения моделируется **данными**, а не объектом `Error`: у `Error` поля `message` и `stack`
неперечисляемы, поэтому `JSON.stringify` даёт `{}` — и «нет прав» уехало бы в структурный лог
пустым объектом, ровно потеряв то различие, ради которого R6a написан. По той же причине в
публичных типах нет `NodeJS.ErrnoException`: это глобал из `@types/node`, а протечка типов из
корневого входа — то, что `deps.test.ts` в `contracts` и ловит.

`ManifestLoad` — три ветки с **собственным дискриминантом** `outcome`, а не два члена с общим
`ok: false`: прецедент — `ParseManifestResult` (`packages/contracts/src/types.ts:99`).

Каждая загрузка увеличивает `generation` и **сериализуется**: две параллельные загрузки
(инициализация и срабатывание вотчера, или два срабатывания по краям debounce) иначе завершаются
в произвольном порядке и ставят более старый манифест. Debounce окно сужает, но не закрывает.

**Falsification:** правка отсутствует → неуспешная загрузка присваивает `current`, исполнение
доходит до `store.test.ts`, наблюдаемое
`store.current()?.manifest.manifest.tools['run_tests']?.exec[0]` равно значению из битой правки;
правка на месте → прежнее значение.
Второй след: правка отсутствует → сериализация загрузок снята, две загрузки запускаются с
задержкой у первой, наблюдаемое `store.current()?.generation` после обеих равно `1`; правка на
месте → `2`, и `current().manifest.digest` соответствует последней записи.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный.

**Commit:** `E1: манифест и lock грузятся порознь, поколения сериализованы`

### Task 4 — сверка на изменении, не на вызове (R7, R9, R10, R11, R13, R17a)

**Files:** `packages/core/src/policy/lock-check.ts` (Create), `packages/core/src/policy/lock-check.test.ts` (Create)

**Interfaces:**
```ts
export interface LockVerdict {
  readonly check: LockCheck;
  readonly diagnostics: readonly Diagnostic[];
  readonly denyReason: string | null;
}
export function recheck(manifest: LoadedManifest, lock: LoadedLock): LockVerdict;
```

`recheck` зовётся **только** из `PolicyStore` при изменении любого из двух файлов, и её результат
кладётся в `LoadedPolicy.verdict`. На пути вызова остаётся чтение поля — ни `parseLockFile`, ни
`manifestHash`, ни `verifyLockEntries`, ни `diffLock`.

Шаги: `lock.present === false` → `absent`, `denyReason` называет причину (`'missing'` и
`'unreadable'` дают **разный** текст). Иначе `verifyLockEntries`; `!ok` → `drifted` **плюс
синтезированная диагностика** `code: 'lock'` с именами из `mismatched`: `diffLock` в этом случае
пуст (измерено, P1d), и без диагностики человеку нечего показать. Затем сверка
`lock.manifestHash` с `manifest.digest`; расхождение → `drifted` (R11). Затем `diffLock`; любой
непустой слот → `drifted`; четыре пустых → `verified`. `deriveRiskTier` не импортируется.

**Falsification:** правка отсутствует → вызов `verifyLockEntries` удалён, исполнение доходит до
кейса «lock с честным snapshot и совравшим recipeHash», наблюдаемое `recheck(...).check.status`
равно `'verified'`; правка на месте → `'drifted'`.
Второй след: правка отсутствует → сверка `manifest.digest` удалена, кейс «расширен
`defaults.env.allow`» даёт `'verified'`; правка на месте → `'drifted'`.
Третий след: правка отсутствует → синтез диагностики на провал `verifyLockEntries` удалён, в том
же кейсе наблюдаемое `diagnostics.length` равно `0` при `check.status === 'drifted'`; правка на
месте → `1`, и её `message` содержит `run_tests`.
Четвёртый след: правка отсутствует → `denyReason` не различает `'missing'` и `'unreadable'`, два
кейса дают одинаковую строку; правка на месте → разные.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный.

**Commit:** `E1: сверка ушла с пути вызова; подделанный lock больше не даёт пустой дифф`

### Task 5 — наблюдение за обоими файлами и коалесценция (R5, R5b)

**Files:** `packages/core/src/policy/watch.ts` (Create), `packages/core/src/policy/watch.fixture.ts` (Create), `packages/core/src/policy/watch.test.ts` (Create)

**Interfaces:**
```ts
export interface PathWatcher { start(onChange: () => void): void; stop(): void }
export function debounce(fn: () => void, ms: number): () => void;
export function fsWatcher(path: string, debounceMs: number): PathWatcher;
export function watchPolicy(store: PolicyStore, manifestPath: string, lockPath: string, debounceMs: number): PathWatcher;
```

`watchPolicy` наблюдает **оба** файла (R5b): правка манифеста зовёт `loadManifest`, правка lock —
`loadLock`, и каждая пересчитывает вердикт. Без наблюдения за lock команда `mcpproxy lock` не
расклинивает работающий демон, и критерий готовности «`mcpproxy lock` его чинит» невыполним.

`manualWatcher` живёт в `watch.fixture.ts` и **не** реэкспортируется из `index.ts`: `fire()`
существует только для тестов.

`debounce` — единственный носитель коалесценции, `fsWatcher` её единственный продакшн-вызыватель.
Тест бьёт прямо в `debounce`, а не в копию логики внутри тестового двойника.

**Falsification:** правка отсутствует → тело `debounce` возвращает `fn` без таймера, исполнение
доходит до `watch.test.ts`, наблюдаемый счётчик после двух подряд вызовов и
`vi.advanceTimersByTime(ms)` равен `2`; правка на месте → `1`.
Второй след: правка отсутствует → `watchPolicy` наблюдает только манифест, кейс «правка lock при
неизменном манифесте» оставляет `store.current()?.verdict.check.status` равным `'absent'`; правка
на месте → `'verified'`. Кейс исполняется на `manualWatcher`, не на настоящей ФС.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; оба следа проверены мутацией.

**Commit:** `E1: наблюдаются оба файла, иначе mcpproxy lock не расклинивает демон`

### Task 6 — событие стадии `lock_check` (R12, R12a, R12b)

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

Именованный объект, а не позиционный список: у `AuditEvent` четырнадцать обязательных полей
(`packages/contracts/src/event.ts:42`), и ни одно не выводится из `LockCheck`.

`protocolVersion` приходит **входом** (R12b). Захардкодить `MCP_PROTOCOL_VERSION` было бы
единственной альтернативой — и ровно тем, что контракт называет ложным утверждением в
доказательстве, тем более что поле попадает в `chain.self`.

`recipeDigest` берётся готовым из `LoadedManifest.recipeDigests`; считать его здесь значило бы
вернуть порецептную работу на путь вызова. Тип `string | undefined` честен: имя рецепта, которого
нет в манифесте, дайджеста не имеет, и `recipe.hash` тогда не пишется вовсе.

`verdict` = `'allowed'` при `verified`, иначе `'denied'`; `denyReason` берётся из `LockVerdict`
(R12a). `argv` присоединяется условным спредом.

**Falsification:** правка отсутствует → `argv` пишется как `argv: undefined`, исполнение доходит
до `event.test.ts`, наблюдаемое `Object.hasOwn(event, 'argv')` равно `true`; правка на месте →
`false`. Ассертится `Object.hasOwn`, не `event.argv === undefined` — второе не различает эти
случаи, а JCS различает их побайтово.
Второй след: правка отсутствует → `denyReason` не переносится, кейс «дрифт» даёт
`event.denyReason` равное `undefined`; правка на месте → строку, содержащую причину.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; событие отказа прогоняется через
`toOtlp` и проверяется, что `mcpproxy.deny_reason` присутствует.

**Commit:** `E1: событие lock_check — argv отсутствует как ключ, причина отказа доезжает`

### Task 7 — сборка и запись lock (R14, R14a)

**Files:** `packages/core/src/policy/lock-write.ts` (Create), `packages/core/src/policy/lock-write.test.ts` (Create)

**Interfaces:**
```ts
export function buildLock(loaded: LoadedManifest, approvedAt: string): LockFile;
export function writeLock(lockPath: string, lock: LockFile, tempSuffix?: () => string): Promise<void>;
```

`buildLock` берёт `LoadedManifest`, а не голый `Manifest`: так предусловие «манифест прошёл
`parseManifest`» держится типом, а не комментарием, и `durationToMs` внутри `normalizeRecipe` не
может встретить непроверенный текст (§6).

`writeLock`: временный файл **в том же каталоге**, создаётся эксклюзивно с уникальным суффиксом
(два одновременных запуска команды не должны делить путь), содержимое сбрасывается `fsync` до
`rename`, при любой ошибке временный файл удаляется. Печать с отступом 2; хэши считаются до
печати, по канонической форме.

**Falsification:** правка отсутствует → временный файл создаётся в `os.tmpdir()`, исполнение
доходит до кейса «временный файл рядом с целью», наблюдаемое `dirname(captured)` не равно
`dirname(lockPath)`; правка на месте → равно. Путь перехватывается инъектируемым `tempSuffix`.
Второй след: правка отсутствует → `manifestHash` считается по напечатанным байтам, кейс «один
`LockFile`, напечатанный с отступом 2 и с отступом 0» даёт разные `JSON.parse(...).manifestHash`;
правка на месте → равные.
Третий след: правка отсутствует → удаление временного файла при ошибке снято, кейс «`rename`
брошен подменённым модулем» оставляет временный файл на диске, наблюдаемое
`readdirSync(dir).length` равно `2`; правка на месте → `1`.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; все три следа проверены мутацией.

**Commit:** `E1: buildLock от проверенного манифеста, запись через temp+fsync+rename`

### Task 8 — апрув дрифта: формы и связывание с дайджестом (R16, R17)

**Files:** `packages/core/src/policy/approve.ts` (Create), `packages/core/src/policy/approve.test.ts` (Create)

**Interfaces:**
```ts
import type { ApprovalDecision } from '@mcpproxy/contracts';

export interface LockApprovalRequest {
  readonly diff: LockDiff;
  readonly manifestHash: string;
  readonly requestedAt: string;
}
export interface LockApprovalVerdict {
  readonly manifestHash: string;
  readonly decision: ApprovalDecision;
  readonly decidedAt: string;
}
export type VerdictApplicability = 'applies' | 'stale' | 'denied';
export function requestFor(policy: LoadedPolicy, requestedAt: string): LockApprovalRequest | null;
export function verdictApplicability(verdict: LockApprovalVerdict, manifest: LoadedManifest): VerdictApplicability;
```

Оба поля зовутся `manifestHash` — это один дайджест, и весь механизм R16 в их сравнении.
Прецедент против переименования — `packages/contracts/src/lock.ts:113`. `ApprovalDecision`
импортируется типом; `contracts` не меняется.

Результат — три состояния: `stale` требует показать дифф заново, `denied` — отказать и не
спрашивать. Одним `boolean` эта ветка невыразима.

`isHeadless` отсутствует намеренно (R17): `recheck` отказывает на `drifted`/`absent` безусловно,
канала апрува в E1 нет как класса. Предикат без потребителя был бы спекулятивной поверхностью —
и по этому же критерию задача 9 обязана иметь потребителя у самих этих форм, см. ниже.

**Falsification:** правка отсутствует → `verdictApplicability` возвращает `'applies'` при
`decision === 'approved'` без сверки дайджеста, исполнение доходит до кейса «манифест изменился
после выдачи вердикта», наблюдаемое равно `'applies'`; правка на месте → `'stale'`.
Второй след: правка отсутствует → `'stale'` и `'denied'` сливаются в одно значение, кейс «человек
отказал» и кейс «вердикт устарел» дают одинаковый результат; правка на месте → разные.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный.

**Commit:** `E1: вердикт привязан к дайджесту, устаревший отличим от отказа`

### Task 9 — команда `mcpproxy lock` и рендер (R15, R15a, R18, R19, R19a, R20)

**Files:** `packages/core/src/policy/render-diff.ts` (Create), `packages/core/src/policy/render-diff.test.ts` (Create), `packages/core/src/policy/lock-command.ts` (Create), `packages/core/src/policy/lock-command.test.ts` (Create), `packages/core/bin/mcpproxy-lock.mjs` (Create), `packages/core/package.json` (Modify)

**Interfaces:**
```ts
export function renderDescription(raw: string): string;
export function renderLockDiff(diff: LockDiff, mismatched: readonly string[]): string;

export type LockCommandOutcome =
  | { readonly kind: 'written' }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'refused'; readonly why: 'stale' | 'denied' | 'unconfirmed' };
export function runLockCommand(policy: LoadedPolicy, confirm: (request: LockApprovalRequest) => Promise<LockApprovalVerdict>, expectDigest: string | null): Promise<LockCommandOutcome>;
```

**Это задача, закрывающая дыру, найденную ревью.** Прошлая редакция давала команде право писать
lock из того, что лежит на диске, без диффа и без подтверждения — то есть blank-чек на любой
дрифт. Она воспроизводила антипаттерн, который наша же разведка вменяет `mcp-scan`
(предупредить и тут же переписать эталон), и открывала окно формы CVE-2025-54136: человек читает
дифф в T₀, атакующий правит манифест в T₁, команда подписывает T₁, не показав его. Одновременно
формы задачи 8 не имели ни одного потребителя.

`runLockCommand`: если lock отсутствует — писать (первый lock, диффать нечего, R15). Если
`verified` — `up-to-date`, ничего не писать. Если `drifted` — построить `LockApprovalRequest`,
показать `renderLockDiff` целиком и без усечения, получить вердикт через `confirm`, прогнать
`verdictApplicability`, и писать **только** при `'applies'`. `expectDigest`, если задан, обязан
совпасть с `policy.manifest.digest` — иначе `refused: 'stale'` (шаблон сохранённого плана
terraform).

`renderDescription` приводит невидимое к **видимой** форме, не вырезая и не усекая. Свойство
формулируется независимо от санитайзера (R19): **каждый** кодпойнт `\p{Cc}` и `\p{Cf}` переживает
рендер видимым. Формулировка «показываем всё, что вырезает `sanitizeDescription`» пропустила бы
`\r \n \t \v \f`: их санитайзер заменяет пробелом раньше прохода по невидимым
(`packages/contracts/src/tool.ts:52` — `const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;` — работает уже
после), и именно перевод строки позволяет подделать структуру диффа в терминале.
Длина в доккомментарии **не** называется мерой против инъекции (R20).

`renderLockDiff` принимает `mismatched` и имеет отдельную ветку для «дрифт есть, дифф пуст»
(R19a) — случай подделанного lock, измеренный в P1d.

Проекция в `tools/list` идёт через `toTool` (R18); своей санитизации E1 не пишет.

**Оговорка про имя.** `bin` в `@mcpproxy/core` даёт отдельный исполняемый файл, а не подкоманду
`mcpproxy lock`: единая CLI живёт в `packages/mcp-server`, который вне объёма E1. Пока это
`mcpproxy-lock`; сшивку в подкоманду делает E4. Файл `bin/mcpproxy-lock.mjs` — тонкая обёртка без
логики, потому что `.mjs` вне `include` у `tsc` и строгости не получает; вся логика в
`lock-command.ts` и покрыта тестами.

**Falsification:** правка отсутствует → `runLockCommand` пишет lock при `drifted`, не спросив
`confirm`, исполнение доходит до кейса «дрифт, `confirm` не вызван» в `lock-command.test.ts`,
наблюдаемое — файл записан и `kind` равен `'written'`; правка на месте → `confirm` вызван, и при
`decision: 'denied'` файл **не** изменён, `kind` равен `'refused'`.
Второй след: правка отсутствует → `expectDigest` не сверяется, кейс «манифест изменился между
показом и записью» даёт `'written'`; правка на месте → `'refused'` с `why: 'stale'`.
Третий след: правка отсутствует → `renderDescription` зовёт `sanitizeDescription` и вырезает, кейс
«описание с bidi-override» даёт строку без `<U+202E>`; правка на месте → с ним.
Четвёртый след: правка отсутствует → ветка «дрифт без диффа» снята, кейс подделанного lock
рендерит пустой текст, наблюдаемая длина рендера равна `0`; правка на месте → текст называет
`run_tests`.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; плюс ручной прогон во временном
каталоге с копией `packages/contracts/recipes/mcpproxy.yaml`: без lock команда пишет его и
`recheck` даёт `verified`; после правки манифеста команда показывает дифф и без подтверждения
ничего не пишет.

**Commit:** `E1: команда показывает дифф и требует подтверждения, а не подписывает молча`

### Task 10 — лог диагностик, границы, публичная поверхность (R2, R8, R23, R24)

**Files:** `packages/core/src/policy/diagnostics-log.ts` (Create), `packages/core/src/policy/diagnostics-log.test.ts` (Create), `packages/core/src/policy/boundary.test.ts` (Create), `packages/core/src/index.ts` (Modify)

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
export function diagnosticKey(diagnostic: Diagnostic, origin: 'manifest' | 'lock'): string;
export function toLogRecord(diagnostic: Diagnostic, origin: 'manifest' | 'lock'): DiagnosticRecord;
```

Модуль **строит запись, а не пишет её**: писателя предоставляет демон (E4), и побочному эффекту в
доменном слое политики места нет. `pointer` сохраняется отдельным полем помимо `key` — по нему
ищут в логе.

`diagnosticKey` берёт тройку `pointer` + `line` + `column`, но принимает `origin`, и вот почему:
все диагностики lock несут `line: 1, column: 1` (`packages/contracts/src/validate/lock.ts:62` —
`    line: 1,`), поэтому для них тройка вырождается в один `pointer`, а указатели lock — это
`tools.${name}` с именами, которыми управляет атакующий. Две враждебные записи в одном lock дали
бы одинаковый ключ. `origin` разделяет пространства ключей и вводит порядковый номер диагностики
в пределах разбора для lock-ветки.

`boundary.test.ts` — три проверки:
1. **R23, транзитивно.** Обход графа с **разрешением workspace-спецификаторов**: `deps.test.ts` в
   `contracts` бэрные спецификаторы записывает и **не идёт по ним**
   (`packages/contracts/src/deps.test.ts:32` — `      if (!specifier.startsWith('.')) {`), а в
   `core` все межпакетные импорты бэрные, поэтому прямой порт был бы тем же грепом. Поэтому
   `@mcpproxy/*` резолвится в `dist` соответствующего пакета и обход продолжается. Плюс непустая
   проверка графа — иначе тест зелен ровно тогда, когда проверять нечего.
2. **R8, сканом исходника.** Ни один непокрытый `JSON.parse` над текстом lock: скан
   `packages/core/src` **вне** `*.test.ts` на `JSON.parse`, с явным списком разрешённых мест
   (их ноль). Обход графа этого доказать не может — он говорит, какие модули достижимы, а не что
   они делают. Тем же сканом закрывается вторая половина R1: `parseManifest` не зовётся нигде,
   кроме `store.ts`.
3. `lock-check.ts` не импортирует `deriveRiskTier` (R13).

`index.ts` — реэкспорт публичной поверхности E1; `watch.fixture.ts` в него не входит.

**Falsification:** правка отсутствует → `diagnosticKey` игнорирует `origin` и ключует одним
`pointer`, исполнение доходит до кейса с двумя враждебными записями lock в
`diagnostics-log.test.ts`, наблюдаемый `new Set(keys).size` равен `1`; правка на месте → `2`.
Второй след: правка отсутствует → непустая проверка графа снята, кейс «граф не пуст» проходит на
пустом графе, наблюдаемое число посещённых файлов равно `0`; правка на месте → больше нуля.
Третий след: правка отсутствует → скан R8 не смотрит в подкаталоги, подсаженный
`JSON.parse(text) as LockFile` в `store.ts` не обнаруживается, наблюдаемое число нарушений равно
`0`; правка на месте → `1`.

**Verification:** `yarn typecheck && yarn build && yarn test` зелёные на всём воркспейсе.
R24 проверяется **включением**, а не одной проверкой contracts:
`git diff --name-only origin/main` — каждый путь обязан лежать в списке R24 из `spec.md`.

**Commit:** `E1: лог различает происхождение диагностики, границы проверяются по-настоящему`

---

## Requirement diff — каждое требование и строка плана, которая его реализует

| Требование | Строка плана |
|---|---|
| R1 | Задача 3: `PolicyStore` — единственная загрузка; запрет обхода — скан исходника в задаче 10, п. 2 |
| R2 | Задача 10: «`diagnosticKey` берёт тройку… но принимает `origin`» |
| R3 | Задачи 3 и 4: битый манифест — `current` не заменяется; битый lock — `absent` ⇒ повторный апрув |
| R4 | Задача 3: первый falsification-след |
| R5 | Задача 5: «`debounce` — единственный носитель коалесценции»; `start`/`stop` |
| R5a | Задача 3: `LoadedManifest` несёт манифест и матчеры одним значением |
| R5b | Задача 5: «`watchPolicy` наблюдает **оба** файла» + второй falsification-след |
| R6 | Задача 3 + §4: замораживается только `manifest`; обоснование исправлено |
| R6a | Задача 3: `LoadedLock` с `'missing'` и `'unreadable'`, смоделированными данными |
| R7 | Задача 4: `recheck` |
| R8 | Задача 10, п. 2: скан исходника вне тестов |
| R9 | Задача 4: «`lock.present === false` → `absent`» |
| R10 | Задача 4: «`verifyLockEntries`; `!ok` → `drifted` плюс синтезированная диагностика» |
| R11 | Задача 4: «сверка `lock.manifestHash` с `manifest.digest`» |
| R12 | Задача 6: «`argv` присоединяется условным спредом» |
| R12a | Задача 6: «`denyReason` берётся из `LockVerdict`» + второй след |
| R12b | Задача 6: «`protocolVersion` приходит **входом**» |
| R13 | Задача 4: `deriveRiskTier` не импортируется + проверка в задаче 10, п. 3 |
| R14 | Задача 7: `buildLock` от `LoadedManifest`, запись temp+rename |
| R14a | Задача 7: «эксклюзивно с уникальным суффиксом… `fsync` до `rename`… удаляется при ошибке» + третий след |
| R15 | Задача 9: «если lock отсутствует — писать (первый lock, диффать нечего)» |
| R15a | Задача 9: «показать `renderLockDiff`… писать **только** при `'applies'`» + первые два следа |
| R16 | Задача 8: оба поля `manifestHash`; потребитель — `runLockCommand` в задаче 9 |
| R17 | Задача 8: «`isHeadless` отсутствует намеренно» |
| R17a | Задача 4: `LockVerdict.diagnostics` + третий след |
| R18 | Задача 9: «Проекция в `tools/list` идёт через `toTool`» |
| R19 | Задача 9: «**каждый** кодпойнт `\p{Cc}` и `\p{Cf}` переживает рендер видимым» + третий след |
| R19a | Задача 9: «отдельная ветка для „дрифт есть, дифф пуст“» + четвёртый след |
| R20 | Задача 9: «Длина… **не** называется мерой против инъекции» |
| R21 | Задачи 1 и 2: скрипт и конфиг в 1, первый зелёный прогон и защита раннера в 2 |
| R22 | Задача 2: «Пять поведений, по одному `describe` на каждое» |
| R23 | Задача 10, п. 1: «обход графа с **разрешением workspace-спецификаторов**» |
| R24 | Задача 10: «`git diff --name-only origin/main` — каждый путь обязан лежать в списке R24» |
| R24a | Записано в `spec.md` как решение владельца; план его не переписывает |
