# E1 — policy engine: план

**Clean-code review:** passed (round 1, после применения 2 CRITICAL и 15 MAJOR) (2026-08-27)

## Goal

Реализовать `R1..R24` из `spec.md`: слой политики в `packages/core/src/policy/**`, который читает
манифест и lock с диска, сверяет их, на расхождении даёт `denied` на стадии `lock_check` с полным
диффом «было / стало», и по явной команде человека записывает новый lock.

## Architecture

E1 — **оркестровка и I/O вокруг замороженных чистых функций** `@mcpproxy/contracts`. Ни одна
формула, ни одна нормализация, ни одна санитизация в E1 не пишется заново.

Ключевое разделение, и оно определяет все сигнатуры ниже: **дорогая работа делается один раз на
загрузку, дешёвая — на вызов.** `lock_check` — стадия каждого вызова (`stageOrder`,
`packages/contracts/src/domain.ts:28`), а `manifestHash` идёт через `normalizeManifest`, про
который в `packages/contracts/src/validate/index.ts:82` записано измерение: **2.2 с CPU на
манифесте в 258 КБ** при `MANIFEST_MAX_BYTES = 262_144`. Против бюджета оверхеда ≤ 50 мс p95 это
означает, что ни `parseLockFile`, ни `manifestHash`, ни `diffLock` не имеют права стоять на пути
вызова. Оба входа меняются только при перезагрузке `PolicyStore`.

```
                  ┌─ раз на загрузку (PolicyStore) ──────────────────────────┐
mcpproxy.yaml ──▶ │ parseManifest ──▶ manifest (frozen) + matchers (не тронуты)│
mcpproxy.lock ──▶ │ parseLockFile ──▶ lock | absent(reason) + diagnostics      │
                  │ manifestHash  ──▶ manifestDigest                          │
                  └──────────────────────┬───────────────────────────────────┘
                                         │ LoadedPolicy (одно значение)
                  ┌─ раз на вызов ───────▼───────────────────────────────────┐
                  │ checkLock(loaded) ──▶ LockCheck + diagnostics             │
                  │   verified ⇒ allowed · drifted/absent ⇒ denied            │
                  └──────────────────────┬───────────────────────────────────┘
                                         ▼
                          lockCheckEvent(...) ──▶ AuditEvent (stage lock_check)
                                         │
                      LockApprovalRequest{diff, manifestHash} ──▶ verdict ──▶ writeLock
```

## Tech Stack

Node ≥ 22, TypeScript 5.6, ESM (`"type": "module"`, `module: NodeNext`), Yarn 4.9.1 workspaces,
vitest 3. `packages/core` зависит ровно от `@mcpproxy/contracts` (`workspace:*`).

## Global Constraints

Из `spec.md` дословно: `packages/contracts` не меняется ни одной строкой; ни один файл вне
`packages/core/src/policy/**`, `packages/core/package.json`, `packages/core/vitest.config.ts`,
`packages/core/src/index.ts`, `packages/core/bin/**` и бандла этого рана не трогается;
`packages/core` не импортирует Electron ни прямо, ни транзитивно.

**Строгость компилятора (из таблицы 3 ниже, а не по памяти):** `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
`noImplicitOverride`. Три следствия, меняющих дизайн, а не синтаксис:

- `exactOptionalPropertyTypes` — `{ argv: undefined }` **не** присваивается в `argv?: string[]`.
  Это ровно то, что требует R12 («ключ отсутствует, а не равен `null`»), то есть требование
  держится типом, а не дисциплиной: событие собирается условным спредом.
- `noUncheckedIndexedAccess` — `manifest.tools` объявлен как `{ [k: string]: Recipe }`
  (`packages/contracts/src/manifest.generated.ts:33`), поэтому `tools['run_tests']` имеет тип
  `Recipe | undefined`, а `exec[0]` — `string | undefined`. Каждая индексная выборка в коде **и в
  тестах** проверяется; проверено компилятором, см. §8.
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
| `LockFile` | E1, `lock-write.ts` (новый) | `Manifest` → `normalizeDefaults`/`normalizeRecipe` → `recipeHash`/`manifestHash` → JSON с отступом → temp+rename | нет; **печатается** с отступом, а хэшируется только каноническая форма |
| `LockCheck` | E1, `lock-check.ts` (новый) | предвычисленные `lock` + `manifestDigest` → `verifyLockEntries` → `diffLock` | нет |

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
| `packages/core` | `yarn workspace @mcpproxy/core test` → **создаётся задачей T1**; сегодня скрипта `test` нет (`packages/core/package.json:15` — `"build": "tsc -b"`) | нет | нет | `tsc -b` один раз перед `vitest run` | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` | ESLint в репозитории отсутствует |
| `packages/contracts` | `yarn workspace @mcpproxy/contracts test` (`packages/contracts/package.json:29` — `"test": "tsc -b && vitest run"`) | нет | нет | `tsc -b` перед прогоном, потому что `deps.test.ts` и `api-surface.test.ts` ходят по `dist/` | те же | те же |

**Почему `test` в `core` отсутствует и почему это дефект.** Корневой `package.json:13` —
`"test": "yarn workspaces foreach -Ap run test"`; `foreach` молча пропускает пакет без такого
скрипта. Значит сегодня корневой `yarn test` гоняет **только** `contracts`, и гейт `build-test`
был бы зелёным на пустом `core`. Это дословно тот отказ, ради которого в E0 существовало R21.

**Ловушка при бутстрапе, измеренная, а не предположенная.** `vitest run` без единого тест-файла
печатает `No test files found, exiting with code 1`. Поэтому T1 **не** имеет собственного
зелёного прогона как приёмки, и `passWithNoTests: true` в конфиг **не** добавляется: он вернул бы
ровно то «зелёное на пустоте», против которого R21 и написан. Приёмка T1 — первый прогон в T2.

**Числа файлов не хардкодятся.** Вместо «после T9 должно быть N файлов» в `core` портируется
исполняемая проверка из `packages/contracts/src/domain.test.ts:47`: рекурсивный обход пакета,
утверждение, что найден хотя бы один `*.test.ts` (защита от пустоты) и что ни один не лежит вне
`src/`, куда `include` не смотрит. Такая проверка не устаревает, когда E2 добавит в `core` свои
файлы.

Существующих тест-файлов, назначаемых домом новой проверки, нет: все тесты E1 создаются заново,
ни один тест `contracts` не редактируется.

### 4. Runtime shape — всё, что план спредит, клонирует, мутирует или переприсваивает

| Value | Loader that produced it | Loader's return type | Spread allowed? |
|---|---|---|---|
| `Manifest` | `parseManifest`, `packages/contracts/src/validate/index.ts:102` | plain object — из `doc.toJS()` библиотеки `yaml` | да; E1 не спредит, а **замораживает** (R6) |
| `LockFile` | `parseLockFile`, `packages/contracts/src/validate/lock.ts:149` | plain object — из `JSON.parse` | да |
| `NormalizedRecipe` | `normalizeRecipe`, `packages/contracts/src/lock.ts:207` | plain object, собран литералами | да |
| `LockDiff` | `diffLock`, `packages/contracts/src/lock.ts:308` | plain object с `readonly`-полями | да, но E1 только читает |
| `PatternMatcher` | `parseManifest` → `matchers` | **непрозрачная обёртка над RE2**, `packages/contracts/src/validate/regex.ts:43` | **нет** — спред потерял бы `test` с прототипа |

Последняя строка — единственная опасная, и она диктует границу заморозки в T3: рекурсивная
заморозка обходит **только** `manifest`, а `Map` матчеров не трогает вовсе. Заморозить нативные
объекты RE2 значило бы сломать ровно то, что §4 запрещает спредить. Тест в T3 после `load()`
дёргает `matchers.get(...)?.test('x')` и убеждается, что обёртка жива.

### 5. Premises — каждое «потому что здесь верно X»

| Premise | The grep that establishes it | Quoted evidence | Every site where it holds | Decision at each site |
|---|---|---|---|---|
| `LockCheck` не производится ничем в контракте | `grep -rn "LockCheck" packages/contracts/src` | `packages/contracts/src/lock.ts:155` — `export type LockCheck =` | единственное объявление, ноль производителей | E1 пишет `checkLock` (T4) |
| Дрифт не отображается в риск-тир | `grep -n "deriveRiskTier" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:152` — `расхождение с lock не отображается` | одно место, доккомментарий над `LockCheck` | `checkLock` не импортирует `deriveRiskTier` (T4); проверка в T10 |
| `redact` включается и не снимается | `grep -n "redact" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:255` — `      redact: (own.output?.redact ?? false) \|\| base.output.redact,` | одно место, `effective` в `normalizeRecipe` | характеризационный тест (T2) |
| `env.allow` пересекается, а не заменяется | тот же греп | `packages/contracts/src/lock.ts:258` — `    env: { allow: (own.env?.allow ?? base.env.allow).filter((one) => base.env.allow.includes(one)) },` | одно место | характеризационный тест (T2) |
| `maxBytes` берётся минимумом | тот же греп | `packages/contracts/src/lock.ts:253` — `            : Math.min(own.output.maxBytes, base.output.maxBytes),` | одно место | характеризационный тест (T2) |
| Предел длительности — константа, а не длина строки | `grep -n "DURATION_MAX_MS" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:35` — `export const DURATION_MAX_MS = 2_147_483_647;` | объявление; применяется в `refine` | таблица D−1/D/D+1 в §6, тест в T2 |
| `normalizeManifest` дорог, поэтому не на пути вызова | `grep -n "2.2" packages/contracts/src/validate/index.ts` | `packages/contracts/src/validate/index.ts:82` — `форма стоит 2.2 с CPU на манифесте в 258 КБ` | одно место, доккомментарий `notHashable` | `manifestHash` считается раз на загрузку (T3), не в `checkLock` |
| `ApprovalDecision` уже экспортирован из корневого входа | `grep -n "approval" packages/contracts/src/index.ts` | `packages/contracts/src/index.ts:25` — `export * from './approval.js';` | один реэкспорт | E1 импортирует **тип**, не объявляет свой (T8); `contracts` при этом не меняется |
| `core` сегодня пуст | `cat packages/core/src/index.ts` | `packages/core/src/index.ts:2` — `export {};` | один файл | наполняется в T3..T10 |

### 6. Ordered parameter — граница `durationToMs`

Ось — число цифр и значение длительности. Регулярка `/^([0-9]{1,10})(ms\|s\|m\|h)$/`
(`packages/contracts/src/lock.ts:45`) режет по **цифрам**, `DURATION_MAX_MS` — по **значению**.

| Parameter value | Output | Branch taken |
|---|---|---|
| `"2147483646ms"` (10 цифр, < max) | `2147483646` | разбирается, проходит `checkDuration` |
| `"2147483647ms"` (10 цифр, = max) | `2147483647` | разбирается, проходит — **измерено, P4b** |
| `"2147483648ms"` (10 цифр, > max) | `2147483648`, затем отбой в `checkDuration` | разбирается, отвергается по значению |
| `"99999999999ms"` (11 цифр) | `TypeError` | не разбирается вовсе — **измерено, P4c** |

Выход монотонен по значению: до `DURATION_MAX_MS` включительно принимается, выше — нет.
Немонотонен только *механизм* отказа (значение против цифр), и это не баг, а два независимых
предела: до `0903753` они расходились и оставляли мёртвую полосу, в которой сама экспортируемая
константа отвергалась как «десять цифр». E1 обязан **ловить** `TypeError` из `durationToMs`,
если когда-либо зовёт её на непроверенном тексте.

### 7. Classifier outputs — ветвление по возвращаемому значению

| Input in scope | Returned value | Branch taken | Surviving outcome |
|---|---|---|---|
| lock отсутствует (ENOENT) | `LockSource.present === false`, `reason: 'missing'` | `absent` | `denied`; апрув не запрашивается — нечего диффать |
| lock не читается (EACCES) | `LockSource.present === false`, `reason: ErrnoException` | `absent` | `denied`; в логе — причина, а не «файла нет» |
| lock не JSON | `parseLockFile` → `{ok:false, diagnostics:[lock]}` | `absent` | `denied` + диагностики в лог |
| lock `version: 1` | `{ok:false}`, **2 диагностики** — измерено, P5 | `absent` | `denied` + обе диагностики в лог |
| lock валиден, `verifyLockEntries` → `{ok:false, mismatched:[…]}` | — | `drifted` | `denied` + дифф; **без этой ветки дифф был бы пуст, см. P1d** |
| lock валиден, `diffLock` вернул четыре пустых слота | `{defaults:null, added:[], removed:[], changed:[]}` | `verified` | `allowed`, вызов идёт на стадию `validate` |
| lock валиден, `defaults` расширен, рецепты не тронуты | `defaults` ≠ null, `changed.length === 0` — измерено, P2c/P2d | `drifted` | `denied` + дифф из одного слота, не размноженный по рецептам |

### 8. Verified facts this plan is built on

Пробы написаны против **настоящего** `dist` (`import { … } from '@mcpproxy/contracts'`), прогнаны
2026-08-27 и удалены. Сырой вывод дословно:

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

Две проверки, прогнанные отдельно после ревью плана, тоже дословно:

```
$ npx vitest run --dir /nonexistent-dir-probe
No test files found, exiting with code 1

$ grep -n "approval" packages/contracts/src/index.ts
25:export * from './approval.js';
```

Что из этого следует:

- **P1d — самый важный результат разведки.** Lock, у которого `snapshot` честен, а `recipeHash`
  соврал, даёт `diffLock` **полностью чистый дифф во всех четырёх слотах**. Ловит его только
  `verifyLockEntries` (P1e). R10 — не перестраховка: `checkLock` без этого вызова вернул бы
  `verified` на подделанном lock. Измерено, а не выведено.
- **P2 — обоснование R11 целиком.** Расширение `defaults.env.allow` оставляет **все** порецептные
  хэши совпадающими (P2a), `manifestHash` при этом расходится (P2b), а `diffLock` кладёт правку в
  слот `defaults` и **не размножает** её по `changed` (P2c/P2d, длина 0).
- **P3 — клампинг из `0903753` подтверждён исполнением**, и `own` сохраняет объявленные значения
  (P3d): хэш считается по объявленному, политика применяется по вычисленному.
- **P5/P6 — `parseLockFile` во всех проверенных враждебных формах возвращает диагностики и не
  бросает**, включая одиночный суррогат внутри `snapshot` (P6).
- **`vitest` без тестов выходит с кодом 1** — отсюда бутстрап-порядок T1→T2 в §3.
- **`ApprovalDecision` уже в корневом входе** — отсюда импорт типа вместо повторного объявления.

**Ошибка, которую проба поймала у меня же.** Первая версия P5 строила lock объектным литералом
`{ __proto__: {...} }` и получила `ok`, из чего напрашивался вывод «`parseLockFile` пропускает
зарезервированные имена». Вывод ложный: литерал `{__proto__: x}` задаёт прототип, а не ключ,
поэтому `tools` уезжал пустым и проба отвечала на другой вопрос. Переписано на сырую
JSON-строку — контракт держится (`keyReallyPresent` подтверждает, что ключ реально есть).
В план это попадает намеренно: **тесты E1 на зарезервированные имена обязаны строиться из
строк**, иначе они вакуумны.

**Компиляторная проверка, сделанная ревьюером и воспроизведённая:** `manifest.tools.run_tests`
под `noUncheckedIndexedAccess` даёт `error TS18048: 'm.tools.run_tests' is possibly 'undefined'`.
Поэтому все обращения в тестах пишутся `tools['run_tests']?.exec[0]`.

**Чего пробы не покрывают:** ничего про `fs.watch` (T5 проверяется на чистой функции коалесценции
и ручном триггере, не таймером); ничего про запись события аудита (райтера нет, это E6 — E1
отдаёт форму события, а не пишет её); ничего про рендер в Electron (E7).

**`ASSUMED`** — ровно одно: что `rename` в пределах одной файловой системы атомарен на macOS и
Linux. Это свойство POSIX `rename(2)`, а не нашего кода. Плана проверять его нет: тест вместо
этого утверждает **наблюдаемое** свойство, из которого атомарность следует, — что временный файл
лежит в том же каталоге, что и цель (T7). Ревьюеру: атакуйте это первым.

---

## Tasks

### Task 1 — тест-инфраструктура `packages/core` (R21)

**Files:** `packages/core/package.json` (Modify), `packages/core/vitest.config.ts` (Create)

**Interfaces:** нет.

Шаги: добавить `"test": "tsc -b && vitest run"` в `scripts` рядом с существующим `"typecheck"`;
добавить `"vitest": "^3"` в новый блок `devDependencies`; создать `vitest.config.ts` зеркально
`packages/contracts/vitest.config.ts` — `environment: 'node'`, единственный
`include: ['src/**/*.test.ts']`. `passWithNoTests` **не** добавляется, причина в §3.

**Verification:** `yarn install` проходит; `yarn workspace @mcpproxy/core run build` зелёный.
Собственного зелёного прогона тестов у T1 нет по построению — приёмка в T2.

**Commit:** `E1: тест-инфраструктура core — без неё build-test зелен на пустоте`

### Task 2 — характеризация `0903753` и защита раннера (R21, R22)

**Files:** `packages/core/src/policy/contract-characterization.test.ts` (Create),
`packages/core/src/policy/runner.test.ts` (Create)

Пять поведений, каждое литеральным ожиданием, а не выводом из кода под тестом — по одному
`describe` на поведение, чтобы число в тексте и число блоков совпадали:
`redact` не снимается рецептом; `maxBytes` берётся минимумом; `env.allow` пересекается;
`durationToMs` принимает `DURATION_MAX_MS` и бросает на одиннадцати цифрах; `isRecipeName`
отвергает `__proto__`, `constructor`, `prototype` — **из сырых строк**, см. §8.

`runner.test.ts` — порт `packages/contracts/src/domain.test.ts:47`: обход пакета, утверждение о
непустоте найденных `*.test.ts` и об отсутствии тест-файлов вне `src/`.

**Falsification:** правка отсутствует → `redact: (own.output?.redact ?? false) || base.output.redact`
в `packages/contracts/src/lock.ts:255` заменяется на `own.output?.redact ?? base.output.redact`,
исполнение доходит до `contract-characterization.test.ts`, наблюдаемое
`normalizeRecipe(r, base).effective.output.redact` равно `false`; правка на месте → `true`.
Ассертится именно это выражение, не позиционный элемент.

**Verification:** `yarn workspace @mcpproxy/core test` — первый зелёный прогон в пакете, ≥ 2
файла; затем вручную применить мутацию выше, убедиться, что тест краснеет, откатить.

**Commit:** `E1: характеризация трёх поведений из ungated 0903753 плюс защита раннера`

### Task 3 — `PolicyStore`: одна загрузка, одно значение наружу (R1, R3, R4, R5a, R6, R6a)

**Files:** `packages/core/src/policy/store.ts` (Create), `packages/core/src/policy/store.test.ts` (Create)

**Interfaces:**
```ts
export interface LoadedPolicy {
  readonly manifest: Manifest;
  readonly matchers: ReadonlyMap<string, PatternMatcher>;
  readonly manifestDigest: string;
  readonly lock: LockSource;
  readonly lockDiagnostics: readonly Diagnostic[];
}

export type LockSource =
  | { readonly present: true; readonly lock: LockFile }
  | { readonly present: false; readonly reason: 'missing' | NodeJS.ErrnoException };

export type LoadResult =
  | { readonly ok: true; readonly policy: LoadedPolicy }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
  | { readonly ok: false; readonly readError: NodeJS.ErrnoException };

export declare class PolicyStore {
  static at(manifestPath: string, lockPath: string): PolicyStore;
  load(): Promise<LoadResult>;
  current(): LoadedPolicy | null;
}
```

Одна операция загрузки, одно имя: `load()`. Вотчер (T5) зовёт её же. Успех — заморозка **только**
`manifest` и замена `current`. Неуспех — `current` не трогается (R4).

Ошибка чтения манифеста едет **отдельным полем** `readError`, а не диагностикой: `DiagnosticCode`
это закрытый union `'size-limit' | 'yaml' | 'schema' | 'invariant' | 'pattern' | 'lock'`
(`packages/contracts/src/types.ts:26`), и ни один его член не описывает «файл не читается».
Подобрать ближайший по смыслу значило бы соврать потребителю, который по контракту обязан
ветвиться на `code`.

Lock читается **здесь же** (R6a) и разбирается `parseLockFile` один раз на загрузку; его
диагностики едут в `lockDiagnostics`, а не выбрасываются (R17a). `manifestDigest` считается
`manifestHash(manifest)` тоже один раз — обоснование в «Architecture» и §5.

**Falsification:** правка отсутствует → неуспешная загрузка присваивает `current`, исполнение
доходит до `store.test.ts`, наблюдаемое `store.current()?.manifest.tools['run_tests']?.exec[0]`
равно `'/bin/sh'` (значение из битой правки); правка на месте → прежнее значение.
Второй след: правка отсутствует → заморозка рекурсивная по всему `LoadedPolicy`, кейс «матчер
жив после load» падает, наблюдаемое `matchers.get(matcherKey('publish_release','tag'))?.test('v1.0.0')`
бросает; правка на месте → `true`.

**Verification:** `yarn workspace @mcpproxy/core test` — ≥ 3 файла.

**Commit:** `E1: PolicyStore — одна загрузка, манифест и матчеры выдаются вместе`

### Task 4 — `checkLock`: композиция `LockCheck` на дешёвом пути (R7, R9, R10, R11, R13, R17a)

**Files:** `packages/core/src/policy/lock-check.ts` (Create), `packages/core/src/policy/lock-check.test.ts` (Create)

**Interfaces:**
```ts
export interface LockVerdict {
  readonly check: LockCheck;
  readonly diagnostics: readonly Diagnostic[];
}
export function checkLock(policy: LoadedPolicy): LockVerdict;
```

Аргумент — уже загруженная политика, поэтому на пути вызова не остаётся ни `JSON.parse`, ни
`manifestHash`, ни повторного разбора lock. Шаги: `policy.lock.present === false` → `absent`
(с `policy.lockDiagnostics` наружу). Иначе `verifyLockEntries`; `!ok` → `drifted` с `diffLock`
(R10, обоснование P1d). Затем сверка `lock.manifestHash` с `policy.manifestDigest`; расхождение →
`drifted` (R11). Затем `diffLock`; любой непустой слот → `drifted`; четыре пустых → `verified`.
`deriveRiskTier` в этом файле не импортируется вовсе (R13).

**Falsification:** правка отсутствует → вызов `verifyLockEntries` удалён, исполнение доходит до
кейса «lock с честным snapshot и совравшим recipeHash» в `lock-check.test.ts`, наблюдаемое
`checkLock(policy).check.status` равно `'verified'`; правка на месте → `'drifted'`.
Второй след: правка отсутствует → сверка `manifestDigest` удалена, кейс «расширен
`defaults.env.allow`» даёт `'verified'`; правка на месте → `'drifted'`.
Третий след: правка отсутствует → `lockDiagnostics` не прокидываются, кейс «lock version 1» даёт
`diagnostics.length` равное `0`; правка на месте → `2` (число измерено, P5).

**Verification:** `yarn workspace @mcpproxy/core test` — ≥ 4 файла.

**Commit:** `E1: checkLock на предвычисленном входе — и без второго шага дифф чист на подделке`

### Task 5 — вотчер и коалесценция (R5)

**Files:** `packages/core/src/policy/watch.ts` (Create), `packages/core/src/policy/watch.fixture.ts` (Create), `packages/core/src/policy/watch.test.ts` (Create)

**Interfaces:**
```ts
export interface ManifestWatcher { start(onChange: () => void): void; stop(): void }
export function debounce(fn: () => void, ms: number): () => void;
export function fsWatcher(path: string, debounceMs: number): ManifestWatcher;
```
`manualWatcher` живёт в `watch.fixture.ts` и **не** реэкспортируется из `index.ts`: `fire()`
существует только для тестов, а публичная поверхность пакета — не место для тест-аффорданса.

`debounce` — единственный носитель коалесценции, и `fsWatcher` её единственный продакшн-вызыватель.
Тест бьёт прямо в `debounce`, а не в копию логики внутри тестового двойника: иначе он был бы
зелёным ровно тогда, когда коалесценция в `fsWatcher` сломана.

**Falsification:** правка отсутствует → тело `debounce` возвращает `fn` без таймера, исполнение
доходит до `watch.test.ts`, наблюдаемый счётчик вызовов после двух подряд обёрнутых вызовов и
`vi.advanceTimersByTime(ms)` равен `2`; правка на месте → `1`. Тест исполняется под
`vi.useFakeTimers()` в окружении `node` — **ни один кейс не ждёт настоящего события ФС**.

**Commit:** `E1: коалесценция вынесена в чистую функцию, тестируется прямо на ней`

### Task 6 — событие стадии `lock_check` (R12)

**Files:** `packages/core/src/policy/event.ts` (Create), `packages/core/src/policy/event.test.ts` (Create)

**Interfaces:**
```ts
export interface LockCheckEventInput {
  readonly check: LockCheck;
  readonly recipeName: RecipeName;
  readonly recipeDigest: string;
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
(`packages/contracts/src/event.ts:42`), и ни одно из них не выводится из `LockCheck`.
`recipeDigest` приходит **готовым** — считать `recipeHash(normalizeRecipe(...))` внутри значило бы
вернуть порецептную работу на путь вызова, ровно то, от чего уходит T4. `sessionId` типизирован
брендом `SessionId` из `packages/contracts/src/ipc.ts:14` на этом шве, хотя замороженное поле
события объявлено как `string`. `verdict` = `'allowed'` при `verified`, иначе `'denied'`;
`argv` присоединяется **условным спредом**, поэтому при отказе ключа нет.

**Falsification:** правка отсутствует → `argv` пишется как `argv: undefined`, исполнение доходит
до `event.test.ts`, наблюдаемое `Object.hasOwn(event, 'argv')` равно `true`; правка на месте →
`false`. Ассертится `Object.hasOwn`, не `event.argv === undefined` — второе не различает эти два
случая, а JCS различает их побайтово.

**Commit:** `E1: событие lock_check — отказ пишется, argv отсутствует как ключ`

### Task 7 — сборка и запись lock, команда (R14, R15)

**Files:** `packages/core/src/policy/lock-write.ts` (Create), `packages/core/src/policy/lock-write.test.ts` (Create), `packages/core/bin/mcpproxy-lock.mjs` (Create), `packages/core/package.json` (Modify)

**Interfaces:**
```ts
export function buildLock(manifest: Manifest, approvedAt: string): LockFile;
export function writeLock(lockPath: string, lock: LockFile, tempName?: () => string): Promise<void>;
```

`buildLock` — `version: 2`, `manifestHash`, `normalizeDefaults`, порецептно
`{recipeHash, approvedAt, snapshot}`. `writeLock` — запись во временный файл в **том же** каталоге
плюс `rename`, с удалением временного файла при любой ошибке. Атомарность объясняется в
доккомментарии, а не в имени функции. Печать с отступом 2; хэши считаются до печати, по
канонической форме. `bin` добавляется в `package.json`.

**Falsification:** правка отсутствует → временный файл создаётся в `os.tmpdir()`, исполнение
доходит до кейса «временный файл лежит рядом с целью» в `lock-write.test.ts`, наблюдаемое
`dirname(captured)` не равно `dirname(lockPath)`; правка на месте → равно. Путь перехватывается
через инъектируемый `tempName`, а не через две настоящие файловые системы, которых в CI нет.
Второй след: правка отсутствует → `manifestHash` считается по напечатанным байтам, кейс «один и
тот же `LockFile`, напечатанный с отступом 2 и с отступом 0» даёт
`JSON.parse(a).manifestHash !== JSON.parse(b).manifestHash`; правка на месте → равны.

**Verification:** `yarn workspace @mcpproxy/core test`; плюс прогон
`node packages/core/bin/mcpproxy-lock.mjs` во временном каталоге с копией
`packages/contracts/recipes/mcpproxy.yaml`, после которого `checkLock` на результате даёт
`verified`.

**Commit:** `E1: buildLock, запись через temp+rename и команда mcpproxy lock`

### Task 8 — формы апрува и привязка к дайджесту (R16, R17)

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
export function verdictApplicability(verdict: LockApprovalVerdict, policy: LoadedPolicy): VerdictApplicability;
```

Оба поля называются `manifestHash` — это один и тот же дайджест, и весь механизм R16 состоит в их
сравнении. Прецедент против переименования записан в `packages/contracts/src/lock.ts:110`.
`ApprovalDecision` импортируется типом из уже существующего экспорта, а не объявляется заново;
`contracts` при этом не меняется.

Результат — три состояния, а не булево: `stale` требует **показать дифф заново** (R16), `denied` —
отказать и не спрашивать. Одним `boolean` эта ветка невыразима.

`isHeadless` отсутствует намеренно. R17 выполняется структурно: `checkLock` отказывает на
`drifted`/`absent` безусловно, канала апрува в E1 нет как класса. Предикат без потребителя был бы
спекулятивной поверхностью.

**Falsification:** правка отсутствует → `verdictApplicability` возвращает `'applies'` при
`decision === 'approved'` без сверки дайджеста, исполнение доходит до кейса «манифест изменился
после выдачи вердикта» в `approve.test.ts`, наблюдаемое равно `'applies'`; правка на месте →
`'stale'`. Отдельный кейс закрепляет, что отказ по устареванию и отказ человека **различимы**:
`'stale'` против `'denied'`.

**Commit:** `E1: вердикт привязан к дайджесту, и устаревший отличим от отказа`

### Task 9 — рендер диффа (R18, R19, R20)

**Files:** `packages/core/src/policy/render-diff.ts` (Create), `packages/core/src/policy/render-diff.test.ts` (Create)

**Interfaces:**
```ts
export function renderDescription(raw: string): string;
export function renderLockDiff(diff: LockDiff): string;
```

`renderDescription` приводит невидимое к **видимой** форме (`ESC` литералом, `<U+200B>`,
`<U+202E>`), не вырезая и не усекая. Класс символов объявляется в этом файле один раз, с
доккомментарием, называющим `INVISIBLE` из `packages/contracts/src/tool.ts:54` своим двойником.
Длина в доккомментарии **не** называется мерой против инъекции (R20).

Двойник держится тестом, а не обещанием: для выборки кодпойнтов из `\p{Cc}`/`\p{Cf}` тест
утверждает, что всё, что `sanitizeDescription` **удаляет**, `renderDescription` **показывает**.
Разъедется `INVISIBLE` — покраснеет здесь, а не в S7 на сцене. Прецедент такой связки —
`packages/contracts/src/validate/lock.ts:43`.

Проекция в `tools/list` идёт через `toTool` (R18); своей санитизации E1 не пишет.

**Falsification:** правка отсутствует → `renderDescription` зовёт `sanitizeDescription` и
вырезает, исполнение доходит до кейса «описание с bidi-override» в `render-diff.test.ts`,
наблюдаемая строка не содержит `<U+202E>`; правка на месте → содержит.

**Commit:** `E1: рендер делает невидимое видимым, и связка с санитайзером под тестом`

### Task 10 — лог диагностик, границы, публичная поверхность (R2, R23, R24)

**Files:** `packages/core/src/policy/diagnostics-log.ts` (Create), `packages/core/src/policy/diagnostics-log.test.ts` (Create), `packages/core/src/policy/boundary.test.ts` (Create), `packages/core/src/index.ts` (Modify)

**Interfaces:**
```ts
export interface DiagnosticRecord {
  readonly key: string;
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly line: number;
  readonly column: number;
}
export function diagnosticKey(diagnostic: Diagnostic): string;
export function toLogRecord(diagnostic: Diagnostic): DiagnosticRecord;
```

Модуль **строит запись, а не пишет её**: писателя предоставляет демон (E4), и побочному эффекту в
доменном слое политики места нет. `diagnosticKey` — тройка `pointer` + `line` + `column`, а не
один `pointer`: указатель лоссовый, `tools.a<U+200B>b` и законный `tools.ab` схлопываются в него
одинаково (`packages/contracts/src/types.ts:57`).

`boundary.test.ts` — порт обхода графа из `deps.test.ts` пакета `contracts` (файл читается как
образец и **не** правится), а не греп по исходнику: R23 требует «ни прямо, ни транзитивно», а
греп видит только прямые спецификаторы.
Обход идёт от `dist/index.js` и `dist/index.d.ts`, утверждает отсутствие `electron` среди голых
спецификаторов и **несёт непустую проверку графа** — иначе тест зелен ровно тогда, когда проверять
нечего. Отдельным кейсом: `lock-check.ts` не импортирует `deriveRiskTier` (R13).

**Falsification:** правка отсутствует → `diagnosticKey` ключует одним `pointer`, исполнение
доходит до кейса с двумя диагностиками на `tools.a<U+200B>b` и `tools.ab` в
`diagnostics-log.test.ts`, наблюдаемый `new Set(keys).size` равен `1`; правка на месте → `2`.
Второй след: правка отсутствует → непустая проверка графа снята, кейс «граф не пуст» проходит на
пустом графе, наблюдаемое число посещённых файлов равно `0`; правка на месте → больше нуля.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; `yarn typecheck && yarn build &&
yarn test` зелёные на всём воркспейсе; `git diff --stat origin/main -- packages/contracts` пуст.

**Commit:** `E1: лог ключует тройкой, границы проверяются обходом графа, поверхность закрыта`

---

## Requirement diff — каждое `Rn` и строка плана, которая его реализует

| Rn | Строка плана |
|---|---|
| R1 | T3: «Одна операция загрузки, одно имя: `load()`» |
| R2 | T10: «`diagnosticKey` — тройка `pointer` + `line` + `column`, а не один `pointer`» |
| R3 | T3 + T4: битый манифест — `current` не заменяется; битый lock — `absent` ⇒ повторный апрув |
| R4 | T3: «Неуспех — `current` не трогается (R4)» + первый falsification-след |
| R5 | T5: «`debounce` — единственный носитель коалесценции»; интерфейс `start`/`stop` (отступление от «одного метода» в спеке: без `stop` утекает дескриптор ФС) |
| R5a | T3: `LoadedPolicy` несёт `manifest` и `matchers` одним значением; второй falsification-след |
| R6 | T3: «заморозка **только** `manifest`», граница объяснена в §4 |
| R6a | T3: «Lock читается **здесь же**… `LockSource`» с разделением `'missing'` и `ErrnoException` |
| R7 | T4: «`checkLock`: композиция `LockCheck`» |
| R8 | T10: обход графа утверждает, что lock-текст потребляется только через `parseLockFile` |
| R9 | T4: «`policy.lock.present === false` → `absent`» |
| R10 | T4: «`verifyLockEntries`; `!ok` → `drifted`», обоснование P1d |
| R11 | T4: «сверка `lock.manifestHash` с `policy.manifestDigest`» |
| R12 | T6: «`argv` присоединяется условным спредом» |
| R13 | T4: «`deriveRiskTier` в этом файле не импортируется вовсе» + кейс в T10 |
| R14 | T7: «`writeLock` — запись во временный файл в том же каталоге плюс `rename`» |
| R15 | T7: «`bin` добавляется в `package.json`» |
| R16 | T8: «Оба поля называются `manifestHash`… весь механизм R16 состоит в их сравнении» |
| R17 | T8: «`isHeadless` отсутствует намеренно. R17 выполняется структурно» |
| R17a | T3 `lockDiagnostics` + T4 «`LockVerdict.diagnostics`» + третий falsification-след T4 |
| R18 | T9: «Проекция в `tools/list` идёт через `toTool`; своей санитизации E1 не пишет» |
| R19 | T9: «приводит невидимое к **видимой** форме… не вырезая и не усекая» + парный тест с `sanitizeDescription` |
| R20 | T9: «Длина в доккомментарии **не** называется мерой против инъекции» |
| R21 | T1 + T2: скрипт и конфиг создаются в T1, первый зелёный прогон и защита раннера — в T2 |
| R22 | T2: «Пять поведений, каждое литеральным ожиданием» |
| R23 | T10: «обход идёт от `dist/index.js` и `dist/index.d.ts`, утверждает отсутствие `electron`» |
| R24 | T10: «`git diff --stat origin/main -- packages/contracts` пуст» |
