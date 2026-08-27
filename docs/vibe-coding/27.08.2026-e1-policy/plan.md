# E1 — policy engine: план

**Clean-code review:** passed (round 1) (2026-08-27)
**Plan review:** раунд 1 — REVISE (7 BLOCKER, 11 MAJOR); раунд 2 — REVISE (6 BLOCKER, 16 MAJOR); всё применено (2026-08-28)

## Goal

Реализовать требования `spec.md`: слой политики в `packages/core/src/policy/**`, который читает
манифест и lock с диска, сверяет их, на расхождении даёт `denied` на стадии `lock_check` с полным
диффом «было / стало», и по явной команде человека — показав дифф, получив подтверждение и
**перечитав манифест** — записывает новый lock.

## Architecture

E1 — **оркестровка и I/O вокруг замороженных чистых функций** `@mcpproxy/contracts`. Ни одна
формула, ни одна нормализация, ни одна санитизация в E1 не пишется заново.

**Первое разделение: вся сверка делается на изменении файлов, на вызове не делается ничего.**
`lock_check` — стадия каждого вызова (`packages/contracts/src/domain.ts:28`) и она **не** входит
в `OVERHEAD_EXCLUDED_STAGES` (`packages/contracts/src/event.ts:149`), то есть попадает в бюджет
≤ 50 мс p95. А сверка в худшем случае стоит секунды: `diffLock` зовёт `normalizeRecipe` на каждый
рецепт (`packages/contracts/src/lock.ts:309`), и ровно эта работа замерена в
`packages/contracts/src/validate/index.ts:82` как 2.2 с CPU на манифесте в 258 КБ — то есть на
самом потолке `MANIFEST_MAX_BYTES = 262_144`. Это худший случай, а не типичный, и именно поэтому
он и важен: бюджет считают по p95, а не по среднему.

**Второе: манифест и lock — разные сущности с разным временем жизни.** Lock меняется, когда
человек выполнил команду; манифест — когда его правят. Слив их в одно значение, мы бы
перечитывали и перехэшировали манифест ради подхвата нового lock.

**Третье: снимок политики иммутабелен и пронумерован.** `generation` — не украшение: это то, чем
команда записи отличает «манифест, который я показал человеку» от «манифест, который лежит на
диске сейчас». Без перечитки после ответа человека проверка вырождается в сравнение снимка с
самим собой.

```
                     ┌── loadManifest() ── правка mcpproxy.yaml ──────────────┐
mcpproxy.yaml ─────▶ │ parseManifest ─▶ manifest(frozen) + matchers           │
                     │ manifestHash  ─▶ digest ; recipeHash·N ─▶ recipeDigests│
                     └───────────────────────────┬───────────────────────────┘
                     ┌── loadLock() ── правка mcpproxy.lock ──────────────────┐
mcpproxy.lock ─────▶ │ parseLockFile ─▶ present | missing | unreadable |      │
                     │                  unparsed(+diagnostics)                │
                     └───────────────────────────┬───────────────────────────┘
                                                 ▼ изменилось любое из двух
                      checkLock(): verifyLockEntries → diffLock → вердикт
                                                 ▼
        LoadedPolicy { manifest, lock, verdict, generation }   ← иммутабелен
                                                 │
   на вызове: policy.verdict ── чтение поля ──▶ lockCheckEvent(...)
                                                 │
   mcpproxy lock: renderLockDiff ─▶ человек ─▶ ПЕРЕЧИТАТЬ ─▶ generation тот же? ─▶ writeLock
```

## Tech Stack

Node ≥ 22, TypeScript 5.6, ESM (`"type": "module"`, `module: NodeNext`), Yarn 4.9.1 workspaces,
vitest 3. `packages/core` зависит от `@mcpproxy/contracts` (`workspace:*`); в `devDependencies`
добавляется `es-module-lexer` — им пользуется обход графа в задаче 9.

## Global Constraints

`packages/contracts` не меняется ни одной строкой. Список путей, которые E1 имеет право трогать,
и решение владельца R24a о пересечении с сиблингами волны 1 — в `spec.md`, R24. Здесь он не
переписывается своими словами: одна из прошлых редакций объявила «из `spec.md` дословно» список,
которого в спеке не было.

**Строгость компилятора (из таблицы 3, а не по памяти):** `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `noImplicitOverride`. Следствия:

- `exactOptionalPropertyTypes` — `{ argv: undefined }` **не** присваивается в
  `argv?: readonly string[]` (`packages/contracts/src/event.ts:89`). Требование R12 держится
  типом. То же касается `denyReason?: string | null` (`packages/contracts/src/event.ts:87`):
  у него **есть** член `null`, поэтому тип пропустит `denyReason: null` ключом в каждое
  `allowed`-событие, и оно уедет в `chain.self`. Здесь тип не спасает — спасает условный спред,
  и это записано в задаче 6.
- `noUncheckedIndexedAccess` — `manifest.tools` объявлен как `{ [k: string]: Recipe }`
  (`packages/contracts/src/manifest.generated.ts:36`), поэтому `tools['run_tests']` даёт
  `Recipe | undefined`, а `exec[0]` — `string | undefined`.
- `verbatimModuleSyntax` — импорты типов пишутся `import type`.

---

## Pre-flight

### 1. Write path

| Field / collection | Producer | Every transform between device and document | Drops or merges data? |
|---|---|---|---|
| `Manifest` | `packages/contracts/src/validate/index.ts:102` | YAML → `parseYaml` → ajv → `refine` → `notHashable` → `Manifest` | нет |
| `Manifest.tools[n].description` | `packages/contracts/src/validate/index.ts:102` | хранится **сырым**; чистится только на проекции в `packages/contracts/src/tool.ts:136` | да — но только в `toTool`, не в `Manifest` |
| `NormalizedRecipe.own` | `packages/contracts/src/lock.ts:207` | `Recipe` → `own`; **все строки дословно** — `description`, `exec[]`, `cwd`, `params[].description`, `env.allow[]`, строки песочницы | нет; `own` несёт объявленные значения |
| `NormalizedRecipe.effective` | `packages/contracts/src/lock.ts:245` | `defaults` ⊕ рецепт с клампингом | **да**: `Math.min`, `\|\|`, пересечение |
| `LockFile` | E1, `lock-write.ts` | `LoadedManifest` → `normalizeDefaults`/`normalizeRecipe` → `recipeHash`/`manifestHash` → печать → temp+fsync+rename | нет; печатается с отступом, хэшируется каноническая форма |
| `LockVerdict` | E1, `lock-check.ts` | загруженные манифест и lock → `verifyLockEntries` → `diffLock` → вердикт | нет |

Третья строка — источник R19: сырым в `own` лежит **не только** `description`, поэтому свойство
рендера формулируется по всем строкам диффа, а не по одному полю.

### 2. Consumers

Меняется один существующий символ: содержимое `packages/core/src/index.ts` (сегодня `export {}`).

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

Три хита, ни одного импорта: у `@mcpproxy/core` сегодня нет ни одного потребителя кода. Но
`index.ts` **входит в граф сборки** сиблингов (`tsc -b` по ссылкам), поэтому `build-test` гоняет
весь воркспейс.

### 3. Infrastructure

| Package | Test command actually used | `setupFiles` | env forced by setup | app built per worker or per test | tsconfig strictness | ESLint severities |
|---|---|---|---|---|---|---|
| `packages/core` | `yarn workspace @mcpproxy/core test` → создаётся задачей 1 | нет | нет | `tsc -b` один раз перед `vitest run` | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` | ESLint отсутствует |
| `packages/contracts` | `yarn workspace @mcpproxy/contracts test` (`packages/contracts/package.json:28` — `"test": "tsc -b && vitest run",`) | нет | нет | `tsc -b` перед прогоном | те же | те же |

Корневой `package.json:15` — `"test": "yarn workspaces foreach -Ap run test",`; `foreach` молча
пропускает пакет без скрипта, поэтому сегодня корневой `yarn test` гоняет только `contracts`, и
`build-test` был бы зелёным на пустом `core`.

**Бутстрап.** `vitest run` без тест-файлов печатает `No test files found, exiting with code 1`;
`passWithNoTests` не добавляется — он вернул бы «зелёное на пустоте». Задачи 1 и 2 поэтому
**сливаются в один коммит**: их файлы не пересекаются, а порознь первый коммит оставил бы
репозиторий с красным корневым `yarn test`.

**Числа файлов не хардкодятся** — портируется проверка из `packages/contracts/src/domain.test.ts:47`.

Существующих тест-файлов, назначаемых домом новой проверки, нет.

### 4. Runtime shape

| Value | Loader that produced it | Loader's return type | Spread allowed? |
|---|---|---|---|
| `Manifest` | `parseManifest`, `packages/contracts/src/validate/index.ts:102` | plain object из `doc.toJS()` | да; E1 замораживает (R6) |
| `LockFile` | `parseLockFile`, `packages/contracts/src/validate/lock.ts:149` | plain object из `JSON.parse` | да |
| `NormalizedRecipe` | `normalizeRecipe`, `packages/contracts/src/lock.ts:207` | plain object | да |
| `LockDiff` | `diffLock`, `packages/contracts/src/lock.ts:308` | plain object с `readonly` | да, E1 только читает |
| `PatternMatcher` | `parseManifest` → `matchers` | **plain object literal**: `packages/contracts/src/validate/regex.ts:43` — `  return { ok: true, matcher: { test: (value: string) => re.test(value) } };` | да — `test` собственное свойство-замыкание |

**Запись об исправленной ошибке.** В первой редакции здесь стояло, что `PatternMatcher` —
непрозрачная обёртка над RE2, чьё поведение живёт на прототипе, спред её ломает и заморозка
опасна. Неверно: `test` — собственное свойство объектного литерала. Утверждение пришло из
пересказа, а не из чтения `regex.ts:43`, и построенный на нём falsification-след был зелёным при
**обеих** ветках. Граница заморозки не изменилась (замораживается только `manifest`), но
обоснование теперь честное: замораживать `Map` бессмысленно, а не опасно.

### 5. Premises

| Premise | The grep that establishes it | Quoted evidence | Every site where it holds | Decision at each site |
|---|---|---|---|---|
| `LockCheck` не производится ничем | `grep -rn "LockCheck" packages/contracts/src` | `packages/contracts/src/lock.ts:155` — `export type LockCheck =` | одно объявление, ноль производителей | E1 пишет `checkLock` (задача 4) |
| Дрифт не отображается в риск-тир | `grep -n "deriveRiskTier" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:152` — `расхождение с lock не отображается` | один доккомментарий | `lock-check.ts` не импортирует `deriveRiskTier`; проверка в задаче 9 |
| `diffLock` нормализует каждый рецепт | `grep -n "normalizeRecipe" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:309` — `  const current = new Map(` | начало `diffLock` | сверка уходит с пути вызова (задачи 3, 4) |
| Та же работа замерена в 2.2 с на потолке размера | `grep -n "2.2" packages/contracts/src/validate/index.ts` | `packages/contracts/src/validate/index.ts:82` — `форма стоит 2.2 с CPU на манифесте в 258 КБ` | один доккомментарий | то же |
| `lock_check` не исключён из бюджета | `grep -n "OVERHEAD_EXCLUDED" packages/contracts/src/event.ts` | `packages/contracts/src/event.ts:149` — `export const OVERHEAD_EXCLUDED_STAGES` | одно объявление; `lock_check` в нём отсутствует | то же |
| `diffLock` **сам** ловит правку `defaults` | `grep -n "sameDefaults" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:326` — `  const defaults = sameDefaults(lock.defaults, is) ? null : { was: lock.defaults, is };` | объявление на `:294`, единственное применение — здесь, внутри `diffLock` | обоснование R11 сужено; след задачи 3 построен на другом кейсе |
| `redact` включается и не снимается | `grep -n "redact" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:255` — `      redact: (own.output?.redact ?? false) \|\| base.output.redact,` | одно место | характеризация (задача 2) |
| `env.allow` пересекается | тот же греп | `packages/contracts/src/lock.ts:258` — `    env: { allow: (own.env?.allow ?? base.env.allow).filter((one) => base.env.allow.includes(one)) },` | одно место | характеризация (задача 2) |
| `maxBytes` берётся минимумом | тот же греп | `packages/contracts/src/lock.ts:253` — `            : Math.min(own.output.maxBytes, base.output.maxBytes),` | одно место | характеризация (задача 2) |
| Предел длительности — константа | `grep -n "DURATION_MAX_MS" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:35` — `export const DURATION_MAX_MS = 2_147_483_647;` | объявление | §6, тест в задаче 2 |
| `protocolVersion` нельзя брать из константы | `grep -n "protocolVersion" packages/contracts/src/event.ts` | `packages/contracts/src/event.ts:60` — `утверждающая нашу константу вместо согласованного значения` | одно поле | приходит входом (задача 6) |
| `denyReason` допускает `null` как значение | `grep -n "denyReason" packages/contracts/src/event.ts` | `packages/contracts/src/event.ts:87` — `  readonly denyReason?: string \| null;` | одно поле | условный спред (задача 6) |
| `ApprovalDecision` уже экспортирован | `grep -n "approval" packages/contracts/src/index.ts` | `packages/contracts/src/index.ts:25` — `export * from './approval.js';` | один реэкспорт | импорт типа (задача 8) |
| Диагностики lock не несут координат | `grep -n "line: 1" packages/contracts/src/validate/lock.ts` | `packages/contracts/src/validate/lock.ts:62` — `    line: 1,` | один конструктор `at` | ключ лога получает индекс (задача 9) |
| Обход графа не идёт по бэрным спецификаторам | `grep -n "startsWith" packages/contracts/src/deps.test.ts` | `packages/contracts/src/deps.test.ts:33` — `      if (!specifier.startsWith('.')) {` | одно место в `walk` | в `core` спецификаторы `@mcpproxy/*` резолвятся (задача 9) |
| Прецедент против переименования поля | `grep -n "замороженная формула" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:113` — `замороженная формула носит это имя` | один доккомментарий | оба поля апрува зовутся `manifestHash` (задача 8) |
| `core` сегодня пуст | `cat packages/core/src/index.ts` | `packages/core/src/index.ts:2` — `export {};` | один файл | наполняется в задачах 3..9 |

### 6. Ordered parameter — граница `durationToMs`

| Parameter value | Output | Branch taken |
|---|---|---|
| `"2147483646ms"` | `2147483646` | разбирается, проходит `checkDuration` |
| `"2147483647ms"` | `2147483647` | разбирается, проходит — **измерено, P4b** |
| `"2147483648ms"` | `2147483648`, отбой в `checkDuration` | разбирается, отвергается по значению |
| `"99999999999ms"` | `TypeError` | не разбирается — **измерено, P4c** |

Выход монотонен по значению. Немонотонен *механизм* отказа — два независимых предела.
**Следствие для задачи 7:** `buildLock` берёт `LoadedManifest`, а не голый `Manifest`, поэтому
предусловие «манифест прошёл `parseManifest`» держится типом, и `durationToMs` внутри
`normalizeRecipe` не встретит непроверенный текст.

### 7. Classifier outputs

| Input in scope | Returned value | Branch taken | Surviving outcome |
|---|---|---|---|
| lock отсутствует | `LoadedLock.reason === 'missing'` | `absent` | `denied`; **единственный** случай, где команда пишет без подтверждения |
| lock не читается | `reason === 'unreadable'` + `code`/`message` | `absent` | `denied`; команда требует подтверждения |
| lock не разобран (битый или `version: 1`) | `reason === 'unparsed'` + диагностики (для `version: 1` их **две**, измерено P5) | `absent` | `denied`; команда требует подтверждения — улика уничтожена, молчать нельзя |
| `verifyLockEntries` → `{ok:false, mismatched}` | — | `drifted` | `denied`; `diffLock` пуст (измерено P1d), поэтому вердикт несёт `mismatched`, и рендер идёт своей веткой |
| `diffLock` вернул четыре пустых слота **и** дайджест сошёлся | `{defaults:null, added:[], removed:[], changed:[]}` | `verified` | `allowed` |
| `defaults` расширен | `defaults` ≠ null, `changed.length === 0` (P2c/P2d) | `drifted` | `denied` + дифф из одного слота. **Ловит `diffLock`, не сверка дайджеста** |
| lock целиком пересчитан, `manifestHash` оставлен старым | `diffLock` чист, `verifyLockEntries` ok | `drifted` | `denied`; **единственный** случай, который видит только сверка дайджеста |

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

Проба вотчера (macOS, Node 22), поставленная после раунда 2 ревью, дословно:

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

- **P1d — источник сразу двух решений.** Lock с честным `snapshot` и совравшим `recipeHash` даёт
  `diffLock` **чистый дифф во всех четырёх слотах**; ловит его только `verifyLockEntries` (P1e).
  Отсюда: вызов `verifyLockEntries` обязателен, и рендер обязан иметь ветку «дрифт есть, показать
  нечего» — иначе на самом враждебном пути человек видит пустую модалку.
- **P2c/P2d — обоснование R11 пришлось сузить.** Расширение `defaults.env.allow` ловит сам
  `diffLock` своим слотом `defaults`; порецептные хэши при этом совпадают (P2a), дайджест
  расходится (P2b), но вердикт был бы `drifted` и без сверки дайджеста. Сверка не избыточна
  ровно на одном сценарии — lock, пересчитанный целиком, но с прежним `manifestHash`, — и
  falsification-след задачи 4 построен именно на нём. Прошлая редакция строила его на расширении
  `defaults` и была поэтому **вакуумной**: наблюдаемое не менялось между ветками.
- **Вотчер: наблюдать можно только каталог.** По пути файла `fs.watch` на macOS пропустил
  обычную запись на месте и замолчал навсегда после первой атомарной подмены (`file` застыл на
  1 через два последующих изменения), тогда как наблюдение за каталогом увидело все шесть
  событий. Подмена — наш собственный способ записи lock, и так же сохраняют файл vim и VSCode.
  Вотчер по пути файла умер бы при первом запуске команды и на первом сохранении манифеста в S7.
- **P3 — клампинг из `0903753` подтверждён исполнением**; `own` сохраняет объявленные значения.
- **P5/P6 — `parseLockFile` во всех проверенных враждебных формах возвращает диагностики и не
  бросает.** Заодно `version: 1` даёт **две** диагностики — это число используется в тесте.
- **`vitest` без тестов выходит с кодом 1** — отсюда слияние задач 1 и 2 в один коммит.

**Три ошибки, пойманные на мне же.** (1) Проба P5 сначала строила lock объектным литералом
`{ __proto__: {...} }`: литерал задаёт прототип, а не ключ, `tools` уезжал пустым, и проба
отвечала на другой вопрос. Отсюда правило: **тесты на зарезервированные имена строятся из
строк.** (2) §4 про `PatternMatcher` — пересказ вместо чтения и построенный на нём вакуумный
след. (3) Второй след задачи 4 в прошлой редакции — вакуумный по той же схеме, что (2), и
пойманный тем же способом: сверкой утверждения с уже снятым измерением.

**Компиляторная проверка:** `manifest.tools.run_tests` под `noUncheckedIndexedAccess` даёт
`error TS18048: 'm.tools.run_tests' is possibly 'undefined'`. В тестах пишется
`tools['run_tests']?.exec[0]`.

**Чего пробы не покрывают:** поведение `fs.watch` на Linux и Windows (замерено только на macOS —
вывод «наблюдать каталог» от этого только надёжнее, но числа не переносятся); запись события
аудита (райтера нет, это E6); рендер в Electron (E7).

---

## Tasks

### Task 1 — тест-инфраструктура и характеризация `0903753` (R21, R22)

**Files:** `packages/core/package.json` (Modify), `packages/core/vitest.config.ts` (Create), `packages/core/src/policy/contract-characterization.test.ts` (Create), `packages/core/src/policy/runner.test.ts` (Create)

Один коммит, потому что порознь первый оставил бы корневой `yarn test` красным (§3).

Добавить `"test": "tsc -b && vitest run"`; `devDependencies` — `vitest` и `es-module-lexer`
(последний нужен обходу графа в задаче 9); `vitest.config.ts` зеркально `contracts` —
`environment: 'node'`, единственный `include: ['src/**/*.test.ts']`. `passWithNoTests` не
добавляется.

Пять поведений, по одному `describe` на каждое: `redact` не снимается; `maxBytes` минимумом;
`env.allow` пересекается; `durationToMs` принимает `DURATION_MAX_MS` и бросает на одиннадцати
цифрах; `isRecipeName` отвергает `__proto__`, `constructor`, `prototype` — **из сырых строк**.
`runner.test.ts` — порт `packages/contracts/src/domain.test.ts:47`.

**Falsification:** правка отсутствует → `packages/contracts/src/lock.ts:255` заменяется на
`own.output?.redact ?? base.output.redact`, исполнение доходит до
`contract-characterization.test.ts`, наблюдаемое `normalizeRecipe(r, base).effective.output.redact`
равно `false`; правка на месте → `true`.

**Verification:** `yarn install && yarn workspace @mcpproxy/core test` зелёный; затем вручную
применить мутацию, убедиться в красноте, откатить.

**Commit:** `E1: тест-инфраструктура core и пять характеризационных поведений`

### Task 2 — загрузка: две сущности, поколения, отказ старта (R1, R3, R4, R5a, R6, R6a, R6b)

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
  | { readonly present: true; readonly lock: LockFile }
  | { readonly present: false; readonly reason: 'missing' }
  | { readonly present: false; readonly reason: 'unreadable'; readonly code: string; readonly message: string }
  | { readonly present: false; readonly reason: 'unparsed'; readonly diagnostics: readonly Diagnostic[] };

export type StartResult =
  | { readonly outcome: 'started'; readonly policy: LoadedPolicy }
  | { readonly outcome: 'refuse-start'; readonly diagnostics: readonly Diagnostic[] }
  | { readonly outcome: 'refuse-start'; readonly readError: { readonly code: string; readonly message: string } };

export interface LoadedPolicy {
  readonly manifest: LoadedManifest;
  readonly lock: LoadedLock;
  readonly verdict: LockVerdict;
  readonly generation: number;
}

export interface StoreDeps {
  readonly readFile: (path: string) => Promise<string>;
  readonly now: () => string;
}

export declare class PolicyStore {
  static at(manifestPath: string, lockPath: string, deps?: Partial<StoreDeps>): PolicyStore;
  start(): Promise<StartResult>;
  reloadManifest(): Promise<void>;
  reloadLock(): Promise<void>;
  current(): LoadedPolicy;
}
```

**`current()` возвращает `LoadedPolicy`, а не `LoadedPolicy | null`** (R6b). Состояния «политики
ещё нет» в типе не существует: пока `start()` не вернул `'started'`, объекта, у которого можно
спросить политику, у вызывающего нет. Сломанный манифест на старте даёт `'refuse-start'`, и
демон (E4) на этом отказывается стартовать — E1 производит значение, но процесс не завершает.
Это закрывает дыру прошлой редакции, где `current(): … | null` не имел владельца и путь вызова не
знал, что делать до первой загрузки.

`LoadedLock` различает **четыре** формы (R6a). Прошлая редакция имела три и отправляла битый lock
в ту же ветку, что и отсутствующий, — из-за чего R12a требовал трёх различимых причин в аудите,
а тип выражал две, и, хуже, команда записи получала право молча перезаписать испорченный файл.

Ошибка чтения моделируется **данными**: у `Error` поля `message` и `stack` неперечисляемы, и
`JSON.stringify` дал бы `{}` — «нет прав» уехало бы в лог пустым объектом. По той же причине в
публичных типах нет `NodeJS.ErrnoException`: глобал из `@types/node` в публичном `.d.ts` — та
самая протечка, которую `deps.test.ts` в `contracts` и ловит.

`StoreDeps` инъектируется (иначе ветка `'unreadable'` непроверяема: EACCES портабельно не
воспроизвести, под root — тем более). Загрузки **сериализуются**, каждая увеличивает
`generation`.

**Falsification:** правка отсутствует → неуспешная перечитка присваивает `current`, исполнение
доходит до `store.test.ts`, наблюдаемое `store.current().manifest.digest` равно дайджесту,
посчитанному по битому входу — а он невычислим, поэтому наблюдаемое на деле `undefined` и тест
падает по исключению; правка на месте → прежний дайджест. (Прошлая редакция описывала здесь
наблюдаемое «значение из битой правки», которого не бывает: `ParseManifestResult` на `ok:false`
манифеста не несёт вовсе — `packages/contracts/src/types.ts:99`.)
Второй след: правка отсутствует → сериализация снята, две перечитки с задержкой у первой дают
`store.current().generation` равное `1`; правка на месте → `2`.
Третий след: правка отсутствует → `Object.freeze` не рекурсивен, исполнение доходит до кейса
«мутация вложенного массива», наблюдаемое — `manifest.tools['run_tests'].exec[0] = '/bin/sh'`
проходит и значение меняется; правка на месте → бросает `TypeError` в strict-режиме ESM.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; три следа проверены мутацией.

**Commit:** `E1: манифест и lock грузятся порознь, отказ старта имеет форму, поколения считаются`

### Task 3 — `checkLock`: сверка на изменении (R7, R9, R10, R11, R13, R17a)

**Files:** `packages/core/src/policy/lock-check.ts` (Create), `packages/core/src/policy/lock-check.test.ts` (Create)

**Interfaces:**
```ts
export interface LockVerdict {
  readonly check: LockCheck;
  readonly diagnostics: readonly Diagnostic[];
  readonly mismatched: readonly string[];
  readonly denyReason: string | null;
}
export function checkLock(manifest: LoadedManifest, lock: LoadedLock): LockVerdict;
```

Зовётся **только** из `PolicyStore` при изменении любого из двух файлов; результат живёт в
`LoadedPolicy.verdict`. На пути вызова — чтение поля.

Порядок шагов важен и исправлен относительно прошлой редакции: **`diffLock` считается всегда**, а
решение принимается после. Прошлая редакция возвращала `drifted` по расхождению дайджеста
*до* вычисления диффа, и на этой ветке в `LockCheck.drifted` уехал бы пустой дифф — человек
попал бы в ветку «дрифт без диффа» там, где настоящий дифф есть.

Шаги: `lock.present === false` → `absent`; `denyReason` различает `'missing'`, `'unreadable'` и
`'unparsed'`, а диагностики `'unparsed'` переносятся в вердикт (R17a). Иначе считается
`diffLock`, затем `verifyLockEntries`: `!ok` → `drifted`, `mismatched` кладётся в вердикт **и**
синтезируется диагностика `code: 'lock'` с именами записей (P1d — дифф в этом случае пуст).
Затем сверка `lock.manifestHash` с `manifest.digest`. Затем непустые слоты диффа. Иначе
`verified`. `deriveRiskTier` не импортируется.

**Falsification:** правка отсутствует → `verifyLockEntries` не зовётся, исполнение доходит до
кейса «честный snapshot, совравший recipeHash», наблюдаемое `checkLock(...).check.status` равно
`'verified'`; правка на месте → `'drifted'`.
Второй след: правка отсутствует → сверка `manifest.digest` удалена, исполнение доходит до кейса
**«lock пересчитан целиком под новый манифест, `manifestHash` оставлен прежним»** — все
`snapshot` и `recipeHash` соответствуют текущему манифесту, `verifyLockEntries` доволен,
`diffLock` чист по четырём слотам, — наблюдаемое `.check.status` равно `'verified'`; правка на
месте → `'drifted'`. (Кейс «расширен `defaults.env.allow`» для этого следа **не годится**: его
ловит сам `diffLock` слотом `defaults`, измерено P2c, и наблюдаемое не менялось бы.)
Третий след: правка отсутствует → `mismatched` не переносится, в кейсе подделки наблюдаемое
`mismatched.length` равно `0` при `status === 'drifted'`; правка на месте → `1`, значение
`run_tests`.
Четвёртый след: правка отсутствует → `denyReason` не различает три формы `absent`, три кейса
дают одинаковую строку; правка на месте → три разные.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; все четыре следа проверены
мутацией.

**Commit:** `E1: сверка ушла с пути вызова; дифф считается всегда; подделка не даёт пустой модалки`

### Task 4 — наблюдение за каталогом и коалесценция (R5, R5b, R5c)

**Files:** `packages/core/src/policy/watch.ts` (Create), `packages/core/src/policy/watch.fixture.ts` (Create), `packages/core/src/policy/watch.test.ts` (Create)

**Interfaces:**
```ts
export interface PathWatcher { start(onChange: () => void): void; stop(): void }
export interface Debounced { (): void; cancel(): void }
export function debounce(fn: () => void, ms: number): Debounced;
export function dirWatcher(filePath: string, debounceMs: number): PathWatcher;
export function watchPolicy(
  store: PolicyStore,
  paths: { readonly manifestPath: string; readonly lockPath: string },
  options: { readonly debounceMs: number; readonly make: (filePath: string, ms: number) => PathWatcher },
): PathWatcher;
```

`dirWatcher` ставит `fs.watch` на **каталог** файла и фильтрует по имени (R5c) — измерено, что по
пути файла вотчер умирает после первой атомарной подмены, а подмена и есть наш способ записи
lock. Прошлая редакция ставила `fsWatcher(path, …)` на путь и тем самым ломала R5b целиком.

`make` инъектируется, поэтому тесты идут на `manualWatcher` из `watch.fixture.ts` (он не
реэкспортируется из `index.ts`) и не ждут настоящих событий ФС.

`debounce` возвращает вызываемое с `cancel()`: без него `stop()` не гасит висящий таймер, и
загрузка прилетает после остановки, а таймер держит event loop — та самая утечка, ради которой
R5 требует `stop()`.

**Falsification:** правка отсутствует → `debounce` возвращает `fn` без таймера, наблюдаемый
счётчик после двух вызовов и `vi.advanceTimersByTime(ms)` равен `2`; правка на месте → `1`.
Второй след: правка отсутствует → `watchPolicy` наблюдает только манифест, кейс «правка lock при
неизменном манифесте» оставляет `store.current().verdict.check.status` равным `'absent'`; правка
на месте → `'verified'`.
Третий след: правка отсутствует → `stop()` не зовёт `cancel()`, кейс «`stop()` сразу после
события» даёт счётчик перезагрузок `1` после прокрутки таймеров; правка на месте → `0`.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; три следа проверены мутацией.

**Commit:** `E1: наблюдается каталог — по пути файла вотчер умирает после первой подмены`

### Task 5 — событие стадии `lock_check` (R12, R12a, R12b)

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

`protocolVersion` приходит входом (R12b) — захардкодить `MCP_PROTOCOL_VERSION` значило бы ровно
то, что контракт называет ложным утверждением в доказательстве, тем более что поле уезжает в
`chain.self`. `recipeDigest` берётся из `LoadedManifest.recipeDigests`; тип `string | undefined`
честен — имени, которого нет в манифесте, дайджест не соответствует, и `recipe.hash` тогда не
пишется.

`argv` **и** `denyReason` присоединяются условным спредом. Для `argv` это следует из типа; для
`denyReason` — **не следует**: `denyReason?: string | null` допускает `null` как значение
(`packages/contracts/src/event.ts:87`), поэтому прямой перенос записал бы ключ `denyReason: null`
в каждое `allowed`-событие, и он уехал бы в `chain.self`. Тот же побайтовый довод, что и для
`argv`, но здесь его не обеспечивает компилятор.

**Falsification:** правка отсутствует → `argv` пишется как `argv: undefined as never` (голое
`argv: undefined` под `exactOptionalPropertyTypes` не компилируется, и мутация упёрлась бы в
`tsc -b` до `vitest` — поэтому мутация делается через `as`), наблюдаемое
`Object.hasOwn(event, 'argv')` равно `true`; правка на месте → `false`.
Второй след: правка отсутствует → `denyReason` переносится безусловно, кейс `verified` даёт
`Object.hasOwn(event, 'denyReason')` равное `true`; правка на месте → `false`.
Третий след: правка отсутствует → `denyReason` не переносится вовсе, кейс `drifted` даёт
`Object.hasOwn(event, 'denyReason')` равное `false`; правка на месте → `true` со строкой причины.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; событие отказа прогоняется через
`toOtlp`, и проверяется наличие `mcpproxy.deny_reason`.

**Commit:** `E1: событие lock_check — argv и denyReason только когда им есть что сказать`

### Task 6 — сборка и запись lock (R14, R14a)

**Files:** `packages/core/src/policy/lock-write.ts` (Create), `packages/core/src/policy/lock-write.test.ts` (Create)

**Interfaces:**
```ts
export function buildLock(loaded: LoadedManifest, approvedAt: string): LockFile;
export interface WriteDeps {
  readonly tempPath: (lockPath: string) => string;
  readonly rename: (from: string, to: string) => Promise<void>;
}
export function writeLock(lockPath: string, lock: LockFile, deps?: Partial<WriteDeps>): Promise<void>;
```

`tempPath` возвращает **полный путь**, а не суффикс: прошлая редакция объявляла
`tempSuffix: () => string`, и заявленное наблюдаемое `dirname(captured)` захватить было нечем.
Путь создаётся эксклюзивно (`wx`) с уникальным именем — два одновременных запуска команды не
делят путь; содержимое сбрасывается `fsync` до `rename`; при любой ошибке временный файл
удаляется.

**Falsification:** правка отсутствует → `tempPath` по умолчанию строит путь в `os.tmpdir()`,
наблюдаемое `dirname(captured)` не равно `dirname(lockPath)`; правка на месте → равно.
Второй след: правка отсутствует → `buildLock` кладёт в `manifestHash` значение
`sha256(JSON.stringify(manifest))` вместо `manifestHash(...)` из `@mcpproxy/contracts/audit`,
наблюдаемое — построенный `lock.manifestHash` не равен `manifestHash(loaded.manifest)`; правка на
месте → равен. (Прошлая редакция мутировала «печать с другим отступом», но `writeLock` хэша не
считает вовсе — мутация была невыразима в объявленной сигнатуре.)
Третий след: правка отсутствует → удаление временного файла при ошибке снято, инъектированный
`rename` бросает, наблюдаемое `readdirSync(dir).length` равно `2`; правка на месте → `1`.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; три следа проверены мутацией.

**Commit:** `E1: buildLock от проверенного манифеста, запись через temp+fsync+rename`

### Task 7 — формы апрува и связывание с дайджестом (R16, R17)

**Files:** `packages/core/src/policy/approve.ts` (Create), `packages/core/src/policy/approve.test.ts` (Create)

**Interfaces:**
```ts
import type { ApprovalDecision } from '@mcpproxy/contracts';

export interface LockApprovalRequest {
  readonly diff: LockDiff;
  readonly mismatched: readonly string[];
  readonly manifestHash: string;
  readonly generation: number;
  readonly requestedAt: string;
}
export interface LockApprovalVerdict {
  readonly manifestHash: string;
  readonly generation: number;
  readonly decision: ApprovalDecision;
  readonly decidedAt: string;
}
export type VerdictApplicability = 'applies' | 'stale' | 'denied';
export function requestFor(policy: LoadedPolicy, requestedAt: string): LockApprovalRequest;
export function verdictApplicability(verdict: LockApprovalVerdict, policy: LoadedPolicy): VerdictApplicability;
```

Оба поля зовутся `manifestHash` — это один дайджест, и весь механизм R16 в их сравнении;
прецедент против переименования — `packages/contracts/src/lock.ts:113`. `ApprovalDecision`
импортируется типом. Запрос несёт `mismatched`, иначе рендер не сможет объяснить подделку
(в прошлой редакции `renderLockDiff` требовал `mismatched`, а получить его было неоткуда).

`generation` в обеих формах — то, что делает сравнение непустым: вердикт выдан против
пронумерованного снимка, и применим он только к нему.

**Falsification:** правка отсутствует → `verdictApplicability` возвращает `'applies'` при
`decision === 'approved'` без сверки, наблюдаемое на снимке с другим `generation` равно
`'applies'`; правка на месте → `'stale'`.
Второй след: правка отсутствует → `'stale'` и `'denied'` сливаются, кейс «человек отказал» и
кейс «вердикт устарел» дают одинаковый результат; правка на месте → разные.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный.

**Commit:** `E1: вердикт привязан к дайджесту и поколению, устаревший отличим от отказа`

### Task 8 — команда: показать, спросить, ПЕРЕЧИТАТЬ, записать (R15, R15a, R15b, R18, R19, R19a, R20)

**Files:** `packages/core/src/policy/render-diff.ts` (Create), `packages/core/src/policy/render-diff.test.ts` (Create), `packages/core/src/policy/lock-command.ts` (Create), `packages/core/src/policy/lock-command.test.ts` (Create), `packages/core/src/policy/confirm-tty.ts` (Create), `packages/core/bin/mcpproxy-lock.mjs` (Create), `packages/core/package.json` (Modify)

**Interfaces:**
```ts
export function renderVisible(raw: string): string;
export function renderLockDiff(request: LockApprovalRequest): string;

export type LockCommandOutcome =
  | { readonly kind: 'written' }
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'refused'; readonly why: 'stale' | 'denied' };
export function runLockCommand(
  store: PolicyStore,
  confirm: (request: LockApprovalRequest, rendered: string) => Promise<LockApprovalVerdict>,
  expectDigest: string | null,
): Promise<LockCommandOutcome>;
```

**Это задача, закрывающая дыру раунда 2, и дыра была в моём же исправлении раунда 1.** Тогда
`runLockCommand` брала `policy: LoadedPolicy` — один неизменяемый снимок — и сравнивала его
дайджест с его же дайджестом. `'stale'` был недостижим на продакшн-пути, а объявленное окно
CVE-2025-54136 закрывалось не проверкой, а побочно. Теперь функция берёт **store** и после ответа
человека **перечитывает манифест**: `reloadManifest()`, затем `verdictApplicability` против
нового снимка. Разошлось `generation` — `refused: 'stale'`, и дифф показывается заново.

Ветвление (R15, R15b): `lock.reason === 'missing'` → писать без подтверждения, диффать нечего.
`'unreadable'` и `'unparsed'` → **через показ и подтверждение**, с текстом о том, что прежнее
одобрение непригодно; молчаливая перезапись довершила бы работу атакующего, которому хватило
испортить один байт. `verified` → `up-to-date`. `drifted` → показ, подтверждение, перечитка,
запись только при `'applies'`.

`renderVisible` применяется **к каждой строке рендера**, а не только к `description` (R19):
сырыми в `own` лежат и `exec[]`, и `cwd`, и `params[].description`, и `env.allow[]`, и строки
песочницы (§1), и `\n` в `exec[0]` подделывает структуру диффа ровно так же. Свойство
формулируется независимо от санитайзера: каждый кодпойнт `\p{Cc}`/`\p{Cf}` в любой строке
переживает рендер видимым. Формулировка «показываем всё, что вырезает `sanitizeDescription`»
пропустила бы `\r \n \t \v \f` — их санитайзер заменяет пробелом раньше прохода `INVISIBLE`
(`packages/contracts/src/tool.ts:52` — `const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;`). Длина мерой
против инъекции не называется (R20).

`renderLockDiff` имеет отдельную ветку для «дрифт есть, дифф пуст» (R19a), опираясь на
`request.mismatched`.

**R18 в объёме E1 — это закрепление допущения, а не реализация:** тест утверждает, что
`toTool(recipe).description` не содержит подставленный U+202E, тогда как рендер диффа его
показывает. Пара «сырое человеку, чистое модели» и есть содержание решения владельца; саму
поверхность `tools/list` строит E4.

**Про имя и про `.mjs`.** `bin` в `@mcpproxy/core` даёт отдельный исполняемый файл, а не
подкоманду `mcpproxy lock`: единая CLI живёт в `packages/mcp-server`, вне объёма E1. Пока это
`mcpproxy-lock`; сшивку делает E4. Реализация `confirm` — TTY-промпт, разбор `--expect`,
интерпретация ответа — лежит в `confirm-tty.ts` и покрыта тестами; `bin/mcpproxy-lock.mjs` — три
строки `import` плюс `process.argv`. Гейт безопасности не может жить в единственном файле, до
которого не доходят ни `tsc`, ни тесты, ни скан задачи 9.

**Falsification:** правка отсутствует → `runLockCommand` пишет при `drifted`, не зовя `confirm`,
наблюдаемое — `confirm` не вызван и `kind` равен `'written'`; правка на месте → вызван, и при
`decision: 'denied'` файл не изменён, `kind` равен `'refused'`.
Второй след: правка отсутствует → перечитка после `confirm` снята, исполнение доходит до кейса
«инъектированный `confirm` правит манифест на диске прежде чем ответить», наблюдаемое `kind`
равно `'written'`; правка на месте → `'refused'` с `why: 'stale'`. **Этот кейс и есть окно
CVE-2025-54136, воспроизведённое тестом.**
Третий след: правка отсутствует → `'unparsed'` попадает в ветку «писать без подтверждения», кейс
«битый lock» даёт `'written'` без вызова `confirm`; правка на месте → `confirm` вызван.
Четвёртый след: правка отсутствует → `renderVisible` применяется только к `description`, кейс
«`‮` в `exec[0]`» даёт рендер без `<U+202E>`; правка на месте → с ним.
Пятый след: правка отсутствует → ветка «дрифт без диффа» снята, кейс подделанного lock рендерит
текст, не содержащий `run_tests`; правка на месте → содержит.

**Verification:** `yarn workspace @mcpproxy/core test` зелёный; пять следов проверены мутацией.
Плюс ручной прогон во временном каталоге с фикстурой манифеста, лежащей в
`packages/core/src/policy/` (не в `packages/contracts/recipes/`: тот путь не объявлен в `exports`
пакета): без lock команда пишет его и `checkLock` даёт `verified`; после правки манифеста команда
показывает дифф и без подтверждения не пишет.

**Commit:** `E1: команда перечитывает манифест после ответа человека, а не сравнивает снимок с собой`

### Task 9 — лог диагностик, границы, публичная поверхность (R2, R8, R23, R24)

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
export function toLogRecords(diagnostics: readonly Diagnostic[], origin: 'manifest' | 'lock'): readonly DiagnosticRecord[];
```

Модуль **строит записи, а не пишет их**: писателя даёт демон (E4). `pointer` сохраняется
отдельным полем помимо `key` — по нему ищут в логе.

Функция принимает **пачку**, а не одну диагностику, и это не стиль. Ключ обязан быть уникален, а
у диагностик lock координат нет: `at()` ставит `line: 1, column: 1` всем
(`packages/contracts/src/validate/lock.ts:62` — `    line: 1,`), и `pointer` у них — это
`tools.${name}` с именем, которым управляет атакующий, пропущенным через `sanitizeDescription`,
который схлопывает пробелы и вырезает невидимое. Две враждебные записи в одном lock дают
**одинаковый** `pointer`, одинаковые координаты и, значит, одинаковый ключ. Развести их может
только порядковый номер в пределах разбора — а его из одной диагностики не вычислить. Прошлая
редакция брала `origin` константным префиксом и коллизию не разводила: её первый след был
вакуумен в обе стороны.

`boundary.test.ts` — три проверки:
1. **R23, транзитивно.** Обход графа с **резолвом workspace-спецификаторов**: в `contracts`
   `walk` бэрные записывает и не идёт по ним (`packages/contracts/src/deps.test.ts:33` —
   `      if (!specifier.startsWith('.')) {`), а в `core` все межпакетные импорты бэрные, поэтому
   прямой порт был бы тем же грепом. `@mcpproxy/*` резолвится в `dist` соответствующего пакета и
   обход продолжается. Плюс непустая проверка графа.
2. **R8 и вторая половина R1, сканом исходника.** Скан `packages/core/src/policy/**` **и**
   `packages/core/bin/**`, исключая `*.test.ts` и `*.fixture.ts`: ни одного `JSON.parse` над
   текстом lock и ни одного вызова `parseManifest` вне `store.ts`. Скан ограничен `policy/**`
   намеренно — по R24a на эту ветку ребейзятся E2, E3 и E6, которые будут законно парсить JSON в
   своих подкаталогах, и запрет по всему `core/src` достался бы им в наследство. Список
   разрешённых мест — настоящий механизм (массив путей), а не ноль: сегодня он пуст, но
   расширяется без правки теста. Обход графа этого доказать не может — он говорит про
   достижимость, а не про поведение.
3. `lock-check.ts` не импортирует `deriveRiskTier` (R13).

`index.ts` — реэкспорт публичной поверхности E1; `watch.fixture.ts` в него не входит.

**Falsification:** правка отсутствует → `toLogRecords` строит ключ без порядкового номера,
исполнение доходит до кейса «две враждебные записи в одном lock, чьи имена схлопываются
санитизацией в один `pointer`», наблюдаемое `new Set(records.map(r => r.key)).size` равно `1`;
правка на месте → `2`.
Второй след: правка отсутствует → скан смотрит только в корень `policy/`, подсаженный
`JSON.parse(text) as LockFile` в `policy/nested/x.ts` не обнаруживается, наблюдаемое число
нарушений равно `0`; правка на месте → `1`.
Третий след: правка отсутствует → резолв `@mcpproxy/*` снят, подсаженный в `contracts`-граф
импорт `electron` не обнаруживается, наблюдаемое число нарушений равно `0`; правка на месте →
`1`. (Проверяется на подставном графе в temp-каталоге, не правкой `contracts`.)

**Verification:** `yarn typecheck && yarn build && yarn test` зелёные на всём воркспейсе.
R24 проверяется **включением**: `git diff --name-only origin/main` — каждый путь обязан лежать в
списке R24 из `spec.md`.

**Commit:** `E1: ключ лога уникален по построению, границы проверяются по-настоящему`

---

## Requirement diff

| Требование | Строка плана |
|---|---|
| R1 | Задача 2: `PolicyStore` — единственная загрузка; запрет обхода — скан в задаче 9, п. 2 |
| R2 | Задача 9: «Функция принимает **пачку**… Развести их может только порядковый номер» |
| R3 | Задачи 2 и 3: сломанный манифест на старте → `'refuse-start'`; при перечитке `current` не заменяется; сломанный lock → `absent` |
| R4 | Задача 2: первый falsification-след |
| R5 | Задача 4: `debounce` с `cancel()`; `start`/`stop` |
| R5a | Задача 2: `LoadedManifest` несёт манифест и матчеры одним значением |
| R5b | Задача 4: «`watchPolicy` … оба файла» + второй след |
| R5c | Задача 4: «`dirWatcher` ставит `fs.watch` на **каталог**» + проба в §8 |
| R6 | Задача 2: третий след (мутация вложенного массива) |
| R6a | Задача 2: `LoadedLock` различает **четыре** формы |
| R6b | Задача 2: «`current()` возвращает `LoadedPolicy`, а не `LoadedPolicy \| null`» |
| R7 | Задача 3: `checkLock`; `parseLockFile` живёт в загрузке — распределение записано в spec R7 |
| R8 | Задача 9, п. 2: скан исходника |
| R9 | Задача 3: «`lock.present === false` → `absent`» |
| R10 | Задача 3: «`verifyLockEntries`: `!ok` → `drifted`» + первый и третий следы |
| R11 | Задача 3: второй след — кейс «lock пересчитан целиком, дайджест прежний» |
| R12 | Задача 5: `argv` условным спредом + первый след |
| R12a | Задача 5: `denyReason` условным спредом + второй и третий следы |
| R12b | Задача 5: «`protocolVersion` приходит входом» |
| R13 | Задача 3: `deriveRiskTier` не импортируется + проверка в задаче 9, п. 3 |
| R14 | Задача 6: `buildLock` от `LoadedManifest`; temp+rename |
| R14a | Задача 6: «эксклюзивно (`wx`)… `fsync` до `rename`… удаляется» + первый и третий следы |
| R15 | Задача 8: «`'missing'` → писать без подтверждения» |
| R15a | Задача 8: «после ответа человека **перечитывает манифест**» + второй след |
| R15b | Задача 8: «`'unreadable'` и `'unparsed'` → через показ и подтверждение» + третий след |
| R16 | Задача 7: оба поля `manifestHash` + `generation`; потребитель — `runLockCommand` |
| R17 | Задача 7: `isHeadless` отсутствует; отказ безусловен в задаче 3 |
| R17a | Задача 3: диагностики `'unparsed'` переносятся в вердикт |
| R18 | Задача 8: «тест утверждает, что `toTool(recipe).description` не содержит подставленный U+202E» |
| R19 | Задача 8: «`renderVisible` применяется **к каждой строке**» + четвёртый след |
| R19a | Задача 8: ветка «дрифт есть, дифф пуст» + пятый след |
| R20 | Задача 8: «Длина мерой против инъекции не называется» |
| R21 | Задача 1: скрипт, конфиг, `runner.test.ts` |
| R22 | Задача 1: «Пять поведений, по одному `describe`» |
| R23 | Задача 9, п. 1: обход с резолвом workspace-спецификаторов + третий след |
| R24 | Задача 9: «`git diff --name-only origin/main` — каждый путь обязан лежать в списке R24» |
| R24a | Записано в `spec.md` как решение владельца |
