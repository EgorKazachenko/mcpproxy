# E1 — policy engine: план

## Goal

Реализовать `R1..R24` из `spec.md`: слой политики в `packages/core/src/policy/**`, который читает
манифест с диска, сверяет его с `mcpproxy.lock`, на расхождении даёт `denied` на стадии
`lock_check` с полным диффом «было / стало», и по явной команде человека записывает новый lock.

## Architecture

E1 — **оркестровка и I/O вокруг замороженных чистых функций** `@mcpproxy/contracts`. Ни одна
формула, ни одна нормализация, ни одна санитизация в E1 не пишется заново: `parseManifest`,
`parseLockFile`, `diffLock`, `verifyLockEntries`, `recipeHash`, `manifestHash`, `normalizeRecipe`,
`normalizeDefaults`, `toTool`, `sanitizeDescription` уже существуют и заморожены. E1 добавляет то,
чего в контракте нет по построению: чтение файлов, композицию `LockCheck`, запись lock, формы
апрува и рендер диффа.

```
mcpproxy.yaml ──▶ PolicyStore.load ──▶ parseManifest ──▶ Manifest (deep-frozen)
                       │                                      │
                       │ diagnostics ──▶ diagnostics-log      │
                       ▼                                      ▼
mcpproxy.lock ──▶ parseLockFile ──▶ verifyLockEntries ──▶ diffLock ──▶ LockCheck
                       │ !ok ⇒ absent          │ !ok ⇒ drifted            │
                       └───────────────────────┴─────────────────────────┘
                                               ▼
                                    lock_check stage event
                                    verified ⇒ allowed · drifted/absent ⇒ denied
                                               │
                                    LockApprovalRequest{diff, manifestHash}
                                               ▼
                                    verdict (привязан к manifestHash) ⇒ writeLock
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
`noImplicitOverride`. Два из них меняют дизайн, а не только синтаксис:

- `exactOptionalPropertyTypes` — `{ argv: undefined }` **не** присваивается в `argv?: string[]`.
  Это ровно то, что требует R12 («ключ отсутствует, а не равен `null`»), и значит требование
  держится типом, а не дисциплиной: событие `lock_check` собирается через условный спред.
- `noUncheckedIndexedAccess` — `lock.tools[name]` имеет тип `LockEntry | undefined`, и каждый
  доступ по имени рецепта проверяется. Плюс `verbatimModuleSyntax` — все импорты типов
  пишутся `import type`.

---

## Pre-flight

### 1. Write path — для каждой коллекции или поля, которые план читает или пишет

| Field / collection | Producer | Every transform between device and document | Drops or merges data? |
|---|---|---|---|
| `Manifest` | `packages/contracts/src/validate/index.ts:102` | YAML-текст → `parseYaml` → ajv → `refine` → `notHashable` → `Manifest` | нет; `parseManifest` возвращает форму документа как есть |
| `Manifest.tools[n].description` | `packages/contracts/src/validate/index.ts:102` | хранится **сырым**; чистится только на проекции в `packages/contracts/src/tool.ts:136` | да — `sanitizeDescription` режет и обрезает, но только в `toTool`, не в `Manifest` |
| `NormalizedRecipe.own` | `packages/contracts/src/lock.ts:207` | `Recipe` → `own` (описание дословно, `params` в порядке объявления) | нет; `own` несёт **объявленные** значения |
| `NormalizedRecipe.effective` | `packages/contracts/src/lock.ts:245` | `defaults` ⊕ рецепт с клампингом | **да**: `Math.min` по `maxBytes`, `\|\|` по `redact`, пересечение по `env.allow` |
| `LockFile` | E1, `lock-write.ts` (новый) | `Manifest` → `normalizeDefaults`/`normalizeRecipe` → `recipeHash`/`manifestHash` → JSON с отступом → temp+rename | нет; но **печатается** с отступом, а хэшируется только каноническая форма |
| `LockCheck` | E1, `lock-check.ts` (новый) | `parseLockFile` → `verifyLockEntries` → `diffLock` | нет |

Ключевая строка этой таблицы — четвёртая: `effective` **сливает и клампит**, `own` — нет, и
хэш считается по `own`. Перепутав их, E1 получил бы дрифт на каждом рецепте при любой правке
`defaults`.

### 2. Consumers — для каждого символа, который план меняет

Меняется ровно один существующий символ: содержимое `packages/core/src/index.ts` (сегодня
`export {}`). Пасту грепа привожу целиком.

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
кода.** Оба пакета объявили зависимость заранее, под E4 и E8. Практическое следствие для плана:
наполнение `index.ts` не может сломать компиляцию сиблинга сегодня, но **войдёт в их граф сборки**
(`tsc -b` строит по ссылкам), поэтому `build-test` обязан гонять весь воркспейс, а не только
`core`.

### 3. Infrastructure — по строке на пакет

| Package | Test command actually used | `setupFiles` | env forced by setup | app built per worker or per test | tsconfig strictness | ESLint severities |
|---|---|---|---|---|---|---|
| `packages/core` | `yarn workspace @mcpproxy/core test` → **создаётся задачей T1**; сегодня скрипта `test` нет (`packages/core/package.json:15` — `"build": "tsc -b"`, и весь блок это `build`/`typecheck`/`clean`) | нет | нет | `tsc -b` один раз перед `vitest run` | `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` | ESLint в репозитории отсутствует |
| `packages/contracts` | `yarn workspace @mcpproxy/contracts test` (`packages/contracts/package.json:29` — `"test": "tsc -b && vitest run"`) | нет | нет | `tsc -b` перед прогоном, потому что `deps.test.ts` и `api-surface.test.ts` ходят по `dist/` | те же | те же |

**Почему `test` в `core` отсутствует и почему это дефект, а не пропуск.** Корневой
`package.json:13` — `"test": "yarn workspaces foreach -Ap run test"`; `foreach` молча пропускает
пакет без такого скрипта. Значит сегодня корневой `yarn test` гоняет **только** `contracts`, и
гейт `build-test` был бы зелёным на пустом `core`. Это дословно тот отказ, ради которого в E0
существовало R21.

Проверка команд: `vitest list --filesOnly` в `packages/core` сегодня вернуть ничего не может —
конфига нет. Числа файлов проставляются в задачах T1→T9 по мере создания; после T9 команда
обязана показывать **9** файлов, и это записано в критерий готовности.

Для каждого существующего тест-файла, который план называет домом новой проверки: таких нет —
все тесты E1 создаются заново, ни один тест `contracts` не редактируется.

### 4. Runtime shape — всё, что план спредит, клонирует, мутирует или переприсваивает

| Value | Loader that produced it | Loader's return type | Spread allowed? |
|---|---|---|---|
| `Manifest` | `parseManifest`, `packages/contracts/src/validate/index.ts:102` | plain object — приходит из `doc.toJS()` библиотеки `yaml` | да, но E1 не спредит: он **замораживает** (R6) |
| `LockFile` | `parseLockFile`, `packages/contracts/src/validate/lock.ts:149` | plain object — из `JSON.parse` | да |
| `NormalizedRecipe` | `normalizeRecipe`, `packages/contracts/src/lock.ts:207` | plain object, собран литералами | да |
| `LockDiff` | `diffLock`, `packages/contracts/src/lock.ts:308` | plain object с `readonly`-полями | да, но E1 только читает |
| `PatternMatcher` | `parseManifest` → `matchers` | **непрозрачная обёртка над RE2**, `packages/contracts/src/validate/regex.ts:43` | **нет** — спред потерял бы `test` с прототипа. E1 передаёт `Map` как есть, в E2 |

Последняя строка — единственная опасная: `matchers` это `ReadonlyMap<string, PatternMatcher>`, и
значения в ней не plain-объекты. E1 не разбирает и не пересобирает эту карту.

### 5. Premises — каждое «потому что здесь верно X»

| Premise | The grep that establishes it | Quoted evidence | Every site where it holds | Decision at each site |
|---|---|---|---|---|
| `LockCheck` не производится ничем в контракте — композиция это долг E1 | `grep -rn "LockCheck" packages/contracts/src` | `packages/contracts/src/lock.ts:155` — `export type LockCheck =` | единственное объявление, ноль производителей | E1 пишет `checkLock` (T4) |
| Дрифт не отображается в риск-тир | `grep -n "deriveRiskTier" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:152` — `расхождение с lock не отображается` | одно место, доккомментарий над `LockCheck` | `checkLock` не зовёт `deriveRiskTier` (T4); тест границы в T9 |
| `redact` включается и не снимается | `grep -n "redact" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:255` — `      redact: (own.output?.redact ?? false) \|\| base.output.redact,` | одно место, `effective` в `normalizeRecipe` | закрепляется характеризационным тестом (T2) |
| `env.allow` пересекается, а не заменяется | тот же греп | `packages/contracts/src/lock.ts:258` — `    env: { allow: (own.env?.allow ?? base.env.allow).filter((one) => base.env.allow.includes(one)) },` | одно место | закрепляется характеризационным тестом (T2) |
| `maxBytes` берётся минимумом | тот же греп | `packages/contracts/src/lock.ts:253` — `            : Math.min(own.output.maxBytes, base.output.maxBytes),` | одно место | закрепляется характеризационным тестом (T2) |
| Предел длительности — константа, а не длина строки | `grep -n "DURATION_MAX_MS" packages/contracts/src/lock.ts` | `packages/contracts/src/lock.ts:35` — `export const DURATION_MAX_MS = 2_147_483_647;` | объявление; применяется в `refine` | таблица D−1/D/D+1 в §6, тест в T2 |
| `core` сегодня пуст | `cat packages/core/src/index.ts` | `packages/core/src/index.ts:2` — `export {};` | один файл | наполняется в T3..T8 |

### 6. Ordered parameter — граница `durationToMs`

Ось — число цифр и значение длительности. Регулярка `/^([0-9]{1,10})(ms\|s\|m\|h)$/`
(`packages/contracts/src/lock.ts:45`) режет по **цифрам**, `DURATION_MAX_MS` — по **значению**.

| Parameter value | Output | Branch taken |
|---|---|---|
| `"2147483646ms"` (10 цифр, < max) | `2147483646` | разбирается, проходит `checkDuration` |
| `"2147483647ms"` (10 цифр, = max) | `2147483647` | разбирается, проходит — **измерено, P4b** |
| `"2147483648ms"` (10 цифр, > max) | `2147483648`, затем отбой в `checkDuration` | разбирается, но отвергается по значению |
| `"99999999999ms"` (11 цифр) | `TypeError` | не разбирается вовсе — **измерено, P4c** |

Выход монотонен по значению: до `DURATION_MAX_MS` включительно принимается, выше — нет.
Немонотонен только *механизм* отказа (значение против цифр), и это не баг, а два независимых
предела: до `0903753` они расходились и оставляли мёртвую полосу, в которой сама экспортируемая
константа отвергалась как «десять цифр». E1 обязан **ловить** `TypeError` из `durationToMs`,
если когда-либо зовёт её на непроверенном тексте.

### 7. Classifier outputs — ветвление по возвращаемому значению

`checkLock` ветвится по двум существующим классификаторам.

| Input in scope | Returned value | Branch taken | Surviving outcome |
|---|---|---|---|
| lock отсутствует на диске | — (ENOENT) | `absent` | `verdict: 'denied'`, апрув не запрашивается — нечего диффать |
| lock не JSON | `parseLockFile` → `{ok:false, diagnostics:[lock]}` | `absent` | `denied`, повторный апрув |
| lock `version: 1` | `{ok:false}`, **2 диагностики** — измерено, P5 | `absent` | `denied`, повторный апрув |
| lock валиден, `verifyLockEntries` → `{ok:false, mismatched:[…]}` | — | `drifted` | `denied` + дифф; **см. P1d — без этой ветки дифф был бы пуст** |
| lock валиден, `diffLock` вернул все четыре слота пустыми | `{defaults:null, added:[], removed:[], changed:[]}` | `verified` | `allowed`, вызов идёт на стадию `validate` |
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

Что из этого следует, по пунктам:

- **P1d — самый важный результат разведки.** Lock, у которого `snapshot` честен, а `recipeHash`
  соврал, даёт `diffLock` **полностью чистый дифф во всех четырёх слотах**. Ловит его только
  `verifyLockEntries` (P1e). То есть R10 — не перестраховка: `checkLock` без этого вызова вернул
  бы `verified` на подделанном lock. Это измерено, а не выведено.
- **P2 — обоснование R11 целиком.** Расширение `defaults.env.allow` оставляет **все** порецептные
  хэши совпадающими (P2a), при этом `manifestHash` расходится (P2b), а `diffLock` кладёт правку в
  слот `defaults` и **не размножает** её по `changed` (P2c/P2d, длина 0).
- **P3 — клампинг из `0903753` подтверждён исполнением**, и `own` при этом сохраняет объявленные
  значения (P3d) — то есть хэш считается по объявленному, а политика применяется по вычисленному.
- **P5/P6 — `parseLockFile` во всех проверенных враждебных формах возвращает диагностики и не
  бросает.** Включая одиночный суррогат внутри `snapshot` (P6).

**Ошибка, которую эта проба поймала у меня же.** Первая версия P5 строила lock объектным
литералом `{ __proto__: {...} }` и получила `ok`, из чего напрашивался вывод «`parseLockFile`
пропускает зарезервированные имена». Вывод ложный: литерал `{__proto__: x}` задаёт прототип, а не
ключ, поэтому `tools` уезжал пустым и проба отвечала на другой вопрос. Переписано на сырую
JSON-строку — контракт держится (`keyReallyPresent` подтверждает, что ключ реально есть).
В план это попадает намеренно: тесты E1 на зарезервированные имена обязаны строиться из строк,
иначе они вакуумны.

**Чего пробы не покрывают:** ничего про `fs.watch` (T5 проверяется ручным триггером, не таймером);
ничего про запись события аудита (райтера нет, это E6 — E1 отдаёт форму события, а не пишет её);
ничего про рендер в Electron (E7).

**`ASSUMED`** — ровно одно: что `writeLock` + `rename` атомарен в пределах одной файловой системы
на macOS и Linux. Это свойство POSIX `rename(2)`, а не нашего кода, и на разных ФС оно не
проверялось. Ревьюеру: атакуйте это первым.

---

## Tasks

### T1 — тест-инфраструктура `packages/core`

**Files:** `packages/core/package.json` (Modify), `packages/core/vitest.config.ts` (Create)

**Interfaces:** нет.

Шаги: добавить `"test": "tsc -b && vitest run"` в `scripts` рядом с существующим
`"typecheck"`; добавить `"vitest": "^3"` в новый блок `devDependencies`; создать
`vitest.config.ts` зеркально `packages/contracts/vitest.config.ts` — `environment: 'node'`,
единственный `include: ['src/**/*.test.ts']`.

**Verification:** `yarn install && yarn workspace @mcpproxy/core test` — команда существует и
завершается успехом на нуле тестов; после T2 показывает ≥ 1 файл.

**Commit:** `E1: тест-инфраструктура core — без неё build-test зелен на пустоте`

### T2 — характеризационные тесты на `0903753` (R22)

**Files:** `packages/core/src/policy/contract-characterization.test.ts` (Create)

Закрепить четыре поведения, каждое литеральным ожиданием, а не выводом из кода под тестом:
`redact` не снимается рецептом; `maxBytes` берётся минимумом; `env.allow` пересекается;
`durationToMs` принимает `DURATION_MAX_MS` и бросает на одиннадцати цифрах; `isRecipeName`
отвергает `__proto__`, `constructor`, `prototype`.

**Falsification:** правка отсутствует → `redact: (own.output?.redact ?? false) || base.output.redact`
в `packages/contracts/src/lock.ts:255` заменяется на `own.output?.redact ?? base.output.redact`,
исполнение доходит до `contract-characterization.test.ts`, наблюдаемое `effective.output.redact`
равно `false`; правка на месте → `true`. Ассертится именно `n.effective.output.redact`, не
позиционный элемент.

**Verification:** `yarn workspace @mcpproxy/core test` — 1 файл, все кейсы зелёные; затем
вручную применить мутацию выше и убедиться, что тест краснеет, и откатить.

**Commit:** `E1: характеризация трёх поведений из ungated 0903753`

### T3 — `PolicyStore`: загрузка, перечитка, заморозка (R1, R3, R4, R6)

**Files:** `packages/core/src/policy/store.ts` (Create), `packages/core/src/policy/store.test.ts` (Create)

**Interfaces:**
```ts
export type LoadResult =
  | { readonly ok: true; readonly manifest: Manifest; readonly matchers: ReadonlyMap<string, PatternMatcher> }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

export declare class PolicyStore {
  static open(manifestPath: string): PolicyStore;
  load(): Promise<LoadResult>;
  reload(): Promise<LoadResult>;
  current(): Manifest | null;
}
```

Шаги: `load` читает файл и зовёт `parseManifest`. Успех — глубокая заморозка результата и замена
`current`. Неуспех — `current` **не** трогается (R4).

Ошибка чтения (ENOENT, права) возвращается **отдельным полем** `readError`, а не диагностикой:
`DiagnosticCode` это закрытый union `'size-limit' | 'yaml' | 'schema' | 'invariant' | 'pattern' | 'lock'`
(`packages/contracts/src/types.ts:26`), и ни один его член не описывает «файл не читается».
Подобрать ближайший по смыслу значило бы соврать потребителю, который по контракту обязан
ветвиться на `code`, а не на текст сообщения.

**Falsification:** правка отсутствует → `reload()` с битым манифестом присваивает `current`,
исполнение доходит до `store.test.ts`, наблюдаемое `store.current()` равно `null`; правка на
месте → прежний манифест. Ассертится `store.current()?.tools.run_tests.exec[0]`.

**Verification:** `yarn workspace @mcpproxy/core test` — 2 файла.

**Commit:** `E1: PolicyStore — загрузка не бросает, битая перечитка не разоружает`

### T4 — `checkLock`: композиция `LockCheck` (R7, R8, R9, R10, R11, R13)

**Files:** `packages/core/src/policy/lock-check.ts` (Create), `packages/core/src/policy/lock-check.test.ts` (Create)

**Interfaces:**
```ts
export function checkLock(lockText: string | null, manifest: Manifest): LockCheck;
```

Шаги: `lockText === null` → `absent`. Иначе `parseLockFile`; `!ok` → `absent` (R9).
Затем `verifyLockEntries`; `!ok` → `drifted` с `diffLock` (R10 — обоснование в P1d).
Затем сверка `lock.manifestHash` с `manifestHash(manifest)`; расхождение → `drifted` (R11).
Затем `diffLock`; любой непустой слот → `drifted`; все четыре пустые → `verified`.
`deriveRiskTier` не импортируется в этом файле вовсе.

**Falsification:** правка отсутствует → вызов `verifyLockEntries` удалён, исполнение доходит до
кейса «lock с честным snapshot и совравшим recipeHash» в `lock-check.test.ts`, наблюдаемое
`checkLock(...).status` равно `'verified'`; правка на месте → `'drifted'`. Ассертится `.status`.
Второй след: правка отсутствует → сверка `manifestHash` удалена, кейс «расширен
`defaults.env.allow`» даёт `'verified'`; правка на месте → `'drifted'`.

**Verification:** `yarn workspace @mcpproxy/core test` — 3 файла.

**Commit:** `E1: checkLock — три шага, и без второго дифф чист на подделке`

### T5 — вотчер за интерфейсом (R5)

**Files:** `packages/core/src/policy/watch.ts` (Create), `packages/core/src/policy/watch.test.ts` (Create)

**Interfaces:**
```ts
export interface ManifestWatcher { start(onChange: () => void): void; stop(): void }
export function fsWatcher(path: string, debounceMs: number): ManifestWatcher;
export function manualWatcher(): ManifestWatcher & { fire(): void };
```

**Falsification:** правка отсутствует → debounce снят, два `fire()` подряд дают два вызова
`onChange`, исполнение доходит до `watch.test.ts`, наблюдаемый счётчик равен `2`; правка на
месте → `1`. Тест исполняется на `manualWatcher` с поддельными таймерами vitest — **ни один
кейс не ждёт настоящего события файловой системы**.

**Verification:** `yarn workspace @mcpproxy/core test` — 4 файла.

**Commit:** `E1: вотчер за интерфейсом, тесты без настоящей ФС`

### T6 — событие стадии `lock_check` (R12)

**Files:** `packages/core/src/policy/event.ts` (Create), `packages/core/src/policy/event.test.ts` (Create)

Собрать `AuditEvent` стадии `lock_check` из `LockCheck`: `verdict` = `'allowed'` при `verified`,
иначе `'denied'`. `argv` присоединяется **условным спредом**, поэтому при отказе ключа нет.
`recipe.hash` появляется именно на этой стадии.

**Falsification:** правка отсутствует → `argv` пишется как `argv: undefined`, исполнение доходит
до `event.test.ts`, наблюдаемое `Object.hasOwn(event, 'argv')` равно `true`; правка на месте →
`false`. Ассертится `Object.hasOwn`, не `event.argv === undefined` — второе не различает эти два
случая, а JCS различает их побайтово.

**Verification:** `yarn workspace @mcpproxy/core test` — 5 файлов.

**Commit:** `E1: событие lock_check — отказ пишется, argv отсутствует как ключ`

### T7 — запись lock и команда (R14, R15)

**Files:** `packages/core/src/policy/lock-write.ts` (Create), `packages/core/src/policy/lock-write.test.ts` (Create), `packages/core/bin/mcpproxy-lock.mjs` (Create), `packages/core/package.json` (Modify)

**Interfaces:**
```ts
export function buildLock(manifest: Manifest, approvedAt: string): LockFile;
export function writeLockAtomic(lockPath: string, lock: LockFile): Promise<void>;
```

`buildLock` — `version: 2`, `manifestHash`, `normalizeDefaults`, порецептно
`{recipeHash, approvedAt, snapshot}`. `writeLockAtomic` — запись во временный файл в **том же**
каталоге плюс `rename`. Печать с отступом 2; хэши считаются до печати, по канонической форме.
`bin` добавляется в `package.json` полем `bin`.

**Falsification:** правка отсутствует → временный файл создаётся в `os.tmpdir()`, исполнение
доходит до кейса «temp и цель на разных ФС» в `lock-write.test.ts`, наблюдаемое — `rename`
бросает `EXDEV`; правка на месте → файл записан. Второй след: правка отсутствует → хэш считается
по напечатанным байтам, кейс «два `buildLock` с разным отступом» даёт разные `manifestHash`;
правка на месте → одинаковые.

**Verification:** `yarn workspace @mcpproxy/core test` — 6 файлов; плюс прогон
`node packages/core/bin/mcpproxy-lock.mjs` во временном каталоге с копией
`packages/contracts/recipes/mcpproxy.yaml`, и `checkLock` на результате даёт `verified`.

**Commit:** `E1: buildLock, атомарная запись и команда mcpproxy lock`

### T8 — формы апрува и привязка к `manifestHash` (R16, R17)

**Files:** `packages/core/src/policy/approve.ts` (Create), `packages/core/src/policy/approve.test.ts` (Create)

**Interfaces:**
```ts
export interface LockApprovalRequest { readonly diff: LockDiff; readonly manifestHash: string; readonly requestedAt: string }
export interface LockApprovalVerdict { readonly approvedHash: string; readonly decision: 'approved' | 'denied'; readonly decidedAt: string }
export function verdictApplies(verdict: LockApprovalVerdict, manifest: Manifest): boolean;
export function isHeadless(env: NodeJS.ProcessEnv): boolean;
```

`verdictApplies` сверяет `approvedHash` с `manifestHash(manifest)` — вердикт, выданный на прежний
манифест, не действует на изменившийся (R16, шаблон terraform saved plan).

**Falsification:** правка отсутствует → `verdictApplies` возвращает `verdict.decision === 'approved'`
без сверки хэша, исполнение доходит до кейса «манифест изменился после выдачи вердикта» в
`approve.test.ts`, наблюдаемое равно `true`; правка на месте → `false`.

**Verification:** `yarn workspace @mcpproxy/core test` — 7 файлов.

**Commit:** `E1: вердикт привязан к дайджесту, а не к факту нажатия`

### T9 — рендер диффа, проекция и границы (R2, R18, R19, R20, R23, R24)

**Files:** `packages/core/src/policy/render-diff.ts` (Create), `packages/core/src/policy/render-diff.test.ts` (Create), `packages/core/src/policy/diagnostics-log.ts` (Create), `packages/core/src/policy/boundary.test.ts` (Create), `packages/core/src/index.ts` (Modify)

`render-diff.ts` — приводит невидимое к видимой форме (`ESC` литералом, `<U+200B>`, `<U+202E>`),
**не вырезая**, и не усекает. `diagnostics-log.ts` — структурная запись, ключ
`pointer` + `line` + `column`. `boundary.test.ts` — три проверки по исходнику: в `core/src`
нет строки `JSON.parse` рядом с `LockFile`; нет импорта `electron`; нет импорта
`deriveRiskTier` в `lock-check.ts`. `index.ts` — реэкспорт публичной поверхности E1.

**Falsification:** правка отсутствует → `renderDescription` зовёт `sanitizeDescription` и
вырезает, исполнение доходит до кейса «описание с bidi-override» в `render-diff.test.ts`,
наблюдаемая строка не содержит `<U+202E>`; правка на месте → содержит. Второй след: правка
отсутствует → `diagnostics-log` ключует одним `pointer`, кейс с двумя диагностиками на
`tools.a<U+200B>b` и `tools.ab` схлопывает их в одну запись, наблюдаемая длина `1`; правка на
месте → `2`.

**Verification:** `yarn workspace @mcpproxy/core test` — 9 файлов; `yarn typecheck && yarn build
&& yarn test` зелёные на всём воркспейсе; `git diff --stat origin/main -- packages/contracts`
пуст.

**Commit:** `E1: рендер делает невидимое видимым, лог ключует тройкой, границы под тестом`

---

## Requirement diff — каждое `Rn` и строка плана, которая его реализует

| Rn | Строка плана |
|---|---|
| R1 | T3: «`PolicyStore`: загрузка, перечитка, заморозка», `load()` зовёт `parseManifest` и не бросает |
| R2 | T9: «`diagnostics-log.ts` — структурная запись, ключ `pointer` + `line` + `column`» |
| R3 | T3 + T4: битый манифест — `current` не заменяется; битый lock — `absent` ⇒ повторный апрув |
| R4 | T3: «Неуспех — `current` **не** трогается (R4)» + его falsification-след |
| R5 | T5: «вотчер за интерфейсом», `manualWatcher` в тестах |
| R6 | T3: «Успех — глубокая заморозка результата» |
| R7 | T4: «`checkLock` — композиция `LockCheck`» |
| R8 | T9: «в `core/src` нет строки `JSON.parse` рядом с `LockFile`» |
| R9 | T4: «`!ok` → `absent` (R9)» |
| R10 | T4: «Затем `verifyLockEntries`; `!ok` → `drifted`», обоснование P1d |
| R11 | T4: «сверка `lock.manifestHash` с `manifestHash(manifest)`» |
| R12 | T6: «событие стадии `lock_check`», `argv` условным спредом |
| R13 | T4: «`deriveRiskTier` не импортируется в этом файле вовсе» + проверка в T9 |
| R14 | T7: «`buildLock`… `writeLockAtomic` — временный файл в том же каталоге плюс `rename`» |
| R15 | T7: «`bin` добавляется в `package.json` полем `bin`» |
| R16 | T8: «`verdictApplies` сверяет `approvedHash` с `manifestHash(manifest)`» |
| R17 | T8: «`isHeadless`» — нет канала, дрифт `denied` |
| R18 | T9: проекция идёт через `toTool`; E1 не пишет своей санитизации |
| R19 | T9: «приводит невидимое к видимой форме… **не вырезая**, и не усекает» |
| R20 | T9: в доккомментарии `render-diff.ts` длина не называется мерой против инъекции |
| R21 | T1: «тест-инфраструктура `packages/core`» |
| R22 | T2: «характеризационные тесты на `0903753`» |
| R23 | T9: «нет импорта `electron`» в `boundary.test.ts` |
| R24 | T9: «`git diff --stat origin/main -- packages/contracts` пуст» |
