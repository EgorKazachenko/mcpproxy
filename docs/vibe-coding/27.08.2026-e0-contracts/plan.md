# План E0 — заморозка `packages/contracts`

## Goal

Реализовать `R1..R25` из `spec.md`: манифест, событие, риск, lock, IPC, четыре
заглушки, тест-инфраструктура, заморозка, правки доков.

## Architecture

`packages/contracts` разделяется на три входа, потому что у него три разных
потребителя с разными правами на зависимости:

| Вход | Что внутри | Зависимости |
|---|---|---|
| `.` | Типы, доменные юнионы, `deriveRiskTier`, `sanitizeDescription`, `toOtlp`, JCS | нет |
| `./validate` | `parseManifest` | `ajv`, `yaml`, `re2` |
| `./audit` | `chainHash`, `verifyChain` | `node:crypto` |

Корневой вход обязан остаться без зависимостей: его тянет `packages/design`, а через
неё — рендерер Electron. `./validate` тянет только демон.

## Tech Stack

Node 22.15.0, TypeScript 5.9.3 (диапазон `^5.6.3`), yarn 4.9.1 workspaces, ESM.
Новое: `ajv@8.20.0`, `yaml@2.9.0`, `re2@1.26.1`, `vitest` (dev),
`json-schema-to-typescript@15.0.4` (dev).

## Global Constraints

Из `tsconfig.base.json`, дословно — план обязан им подчиняться, а не упоминать их:

- `"strict": true` (`tsconfig.base.json:9`)
- `"noUncheckedIndexedAccess": true` (`tsconfig.base.json:10`)
- `"exactOptionalPropertyTypes": true` (`tsconfig.base.json:12`)
- `"verbatimModuleSyntax": true` (`tsconfig.base.json:13`)

Следствия, которые ловятся только на компиляции: индексный доступ даёт `T | undefined`,
поэтому разбор `instancePath.split('/')` обязан проверять элементы; `exactOptionalPropertyTypes`
запрещает присваивать `undefined` необязательному полю — опциональные поля события
(`denyReason`, `approval`) строятся через условный спред, а не через `x: undefined`;
`verbatimModuleSyntax` требует `import type` для типов, иначе рантайм-импорт попадёт
в корневой вход и утащит зависимости.

Комментарии — по конвенции репозитория: русские, поясняют «почему», не «что»
(`packages/design/src/semantic.ts:1-19`, `packages/contracts/src/domain.ts:1-6`).
`CLAUDE.md` в репозитории нет — конвенция снята с существующего кода.

---

## Pre-flight

### 1. Write path

**Таблица удалена: план ничего не пишет в хранилище.** `packages/contracts` объявляет
формы и экспортирует чистые функции; единственный ввод-вывод — чтение текста манифеста,
который передаёт вызывающий, и `node:crypto` для хэша. Ни базы, ни файлов, ни сети.

### 2. Consumers — каждый символ, который план меняет

Грep, выполненный целиком:
`grep -rn "@mcpproxy/contracts" . --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.json' --include='*.html' | grep -v node_modules`

Полный список попаданий — восемь строк, из них семь это объявления зависимости в
`package.json` (`design`, `bench`, `core`, `mcp-server`, `desktop`) и имя самого пакета.
Единственный потребитель кода — один файл:

| Символ | Читатель | Quoted evidence | Мокает ли тест |
|---|---|---|---|
| `Verdict` | `packages/design/src/semantic.ts:31` | `export const verdictRole: Readonly<Record<Verdict, Role>> = {` | тестов нет вообще |
| `Verdict` | `packages/design/src/semantic.ts:39` | `export const verdictLabel: Readonly<Record<Verdict, string>> = {` | тестов нет вообще |
| `Stage` | `packages/design/src/semantic.ts:48` | `export const stageLabel: Readonly<Record<Stage, string>> = {` | тестов нет вообще |
| `RiskTier` | `packages/design/src/semantic.ts:66` | `export const riskRole: Readonly<Record<RiskTier, Role>> = {` | тестов нет вообще |
| `RiskTier` | `packages/design/src/semantic.ts:72` | `export const riskLabel: Readonly<Record<RiskTier, string>> = {` | тестов нет вообще |
| `SandboxMode` | `packages/design/src/semantic.ts:84` | `export const sandboxRole: Readonly<Record<SandboxMode, Role>> = {` | тестов нет вообще |
| `SandboxMode` | `packages/design/src/semantic.ts:90` | `export const sandboxLabel: Readonly<Record<SandboxMode, string>> = {` | тестов нет вообще |
| `ViolationType` | `packages/design/src/semantic.ts:98` | `export const violationRole: Readonly<Record<ViolationType, Role>> = {` | тестов нет вообще |
| `ViolationType` | `packages/design/src/semantic.ts:111` | `export const violationLabel: Readonly<Record<ViolationType, string>> = {` | тестов нет вообще |
| `AnnotationKey` | `packages/design/src/semantic.ts:121` | `export const annotationLabel: Readonly<Record<AnnotationKey, string>> = {` | тестов нет вообще |
| `AnnotationKey` | `packages/design/src/semantic.ts:129` | `export function annotationRole(key: AnnotationKey, value: boolean): Role {` | тестов нет вообще |

**Вывод, определяющий объём:** десять исчерпывающих `Record` и один `switch` без
`default`. Расширение любого из шести юнионов — немедленная ошибка компиляции в
`design`. Поэтому **план не расширяет ни один существующий юнион.** Всё новое —
новые типы. Единственное исключение обосновано в §5, премисса P3.

`CONTRACTS_VERSION` и `stageOrder` потребителей не имеют:
`grep -rn "stageOrder\|CONTRACTS_VERSION" . --include='*.ts' --include='*.mjs' --include='*.html' | grep -v node_modules | grep -v 'packages/contracts/src'` — пусто.

### 3. Infrastructure — по строке на пакет

| Пакет | Команда теста сейчас | `setupFiles` | env от setup | сборка | строгость tsconfig | ESLint |
|---|---|---|---|---|---|---|
| `contracts` | **нет скрипта `test`** | нет | нет | `tsc -b` | наследует базу | ESLint в репозитории отсутствует |
| `design` | **нет скрипта `test`** | нет | нет | `tsc -b` + `generate-css.mjs` | наследует базу | — |

Корневой `package.json:15` — `"test": "yarn workspaces foreach -Ap run test",`.
Проверено: `yarn test` в воркспейсе выходит с кодом 0, не запустив ни одного теста,
потому что ни один пакет скрипта `test` не объявляет. То есть гейт `build-test`
сегодня зелёный на пустоте — это и есть R21.

Существующих тестовых файлов, куда можно было бы положить утверждение, нет ни одного:
`git ls-files packages | grep -c test` → 0. Поэтому таблица «во что бутится
существующий тест» удалена: все тесты плана — новые файлы, и каждый называет свой
рантайм в задаче.

### 4. Runtime shape — всё, что план спредит, клонирует или мутирует

| Значение | Кто произвёл | Тип | Спред допустим |
|---|---|---|---|
| `AuditEvent` в `chainHash` | вызывающий, литерал по типу контракта | plain object | **нет** — вместо спреда делаем `omitChainSelf`, см. ниже |
| результат `YAML.parse` | `yaml@2.9.0` | plain object/array/scalar | да |
| `errors` из ajv | `ajv@8.20.0` | массив plain object | да |
| `RE2` инстанс | `re2@1.26.1` | **экземпляр класса** | **нет** — не спредить, не сериализовать |

`chainHash` не спредит событие: `{...event, chain: {...}}` при
`exactOptionalPropertyTypes` и вложенном `chain` даёт объект, где `chain.self`
присутствует со значением `undefined`, а JCS обязан отличать отсутствие ключа от
`undefined`. Вместо этого — явная пересборка без `chain.self`.

### 5. Premises — каждое «потому что здесь верно X»

| Премисса | Грep, который её устанавливает | Quoted evidence | Где держится | Решение |
|---|---|---|---|---|
| P1. `contracts` уже владеет шестью юнионами, их не надо создавать | `grep -n "export type" packages/contracts/src/domain.ts` | `export type Verdict = 'allowed' \| 'denied' \| 'pending_approval' \| 'error';` (`packages/contracts/src/domain.ts:9`) | один файл | переиспользуем, не трогаем |
| P2. 13 стадий уже перечислены и упорядочены | `grep -n "stageOrder" packages/contracts/src/domain.ts` | `export const stageOrder: readonly Stage[] = [` (`packages/contracts/src/domain.ts:28`) | один файл | событие ссылается на `Stage`, список не дублируем |
| P3. Юнионы расширять нельзя без правки `design` | таблица §2 | `export const stageLabel: Readonly<Record<Stage, string>> = {` (`packages/design/src/semantic.ts:48`) | 10 мест + 1 `switch` | **ни один юнион не расширяется** |
| P4. `TODO(E0)` называет ровно объём этой работы | `cat -n packages/contracts/src/index.ts` | `// TODO(E0): JSON Schema манифеста, схема события (OTel GenAI), три рецепта-заглушки.` (`packages/contracts/src/index.ts:6`) | одна строка | снимается в T11 |
| P5. Пакет сегодня без зависимостей | `grep -n "dependencies" packages/contracts/package.json` | в `packages/contracts/package.json` секции `dependencies` нет | один файл | корневой вход обязан остаться таким |

### 6. Ordered parameter

**Таблица удалена: ни одно правило плана не ветвится по дате, индексу, версии или
порогу.** `deriveRiskTier` ветвится по булевым флагам — это §7, а не §6. Лимит размера
YAML (R8) — единственный порог, и он не ветвит логику, а отсекает вход до разбора;
его три значения проверены в T4.

### 7. Classifier outputs — `deriveRiskTier`

Вход — аннотации после применения дефолтов спеки. Каждая строка — тест.

| Вход | Возврат | Ветка | Обоснование |
|---|---|---|---|
| `{}` (ничего не задано) | `high` | дефолты `destructive:true`, `openWorld:true` | fail-safe при молчании |
| `{readOnlyHint: true}` | `low` | readOnly | спека: остальные хинты здесь незначимы |
| `{readOnlyHint: true, destructiveHint: true}` | `low` | readOnly | **`destructiveHint` игнорируется** — «meaningful only when `readOnlyHint == false`» |
| `{readOnlyHint: false, destructiveHint: false, openWorldHint: false}` | `medium` | ни то, ни другое | авто + громкая запись |
| `{readOnlyHint: false, destructiveHint: true, openWorldHint: false}` | `high` | destructive | out-of-band апрув |
| `{readOnlyHint: false, destructiveHint: false, openWorldHint: true}` | `high` | openWorld | out-of-band апрув |

Строка 3 — та, которую легко реализовать неверно, и та, которой нет в
`docs/07-contracts.md`. Она приходит из текста спеки и проверена разведкой.

### 8. Verified facts

**Ф1. Катастрофический бэктрекинг не лечится ограничением длины.** Замер, node 22.15.0,
сырой вывод:

```
nested quantifier  (a+)+$      16:1  18:1  20:5  22:18  24:71  26:283  28:1131  30:4539  >3s at n=30
alternation        (a|a)*$     16:2  18:1  20:5  22:21  24:77  26:309  28:1246  30:5019  >3s at n=30
plausible-looking  ^(\w+\s?)*$ 16:1  18:1  20:4  22:16  24:65  26:264  28:1082  30:4235  >3s at n=30
```

Рост ×4 на каждые +2 символа. Экстраполяция на 64 символа — 4539 мс × 4^17 ≈ 7.8×10¹³ мс.
64 — это длина из нашего же примера `^[\w./-]{0,64}$`.
**Не покрывает:** замер на одном движке V8 одной версии; поведение под нагрузкой не мерилось.

**Ф2. RE2 закрывает вектор и режет синтаксис.** Сырой вывод, `re2@1.26.1`:

```
OK   "^(a+)+$" 64-char test: 0.009 ms
OK   "^(a|a)*$" 64-char test: 0.003 ms
OK   "^[\\w./-]{0,64}$" 64-char test: 0.012 ms
OK   "^v\\d+\\.\\d+\\.\\d+$" 64-char test: 0.001 ms
THROW "^(?=.*a)b$" -> invalid perl operator: (?=
THROW "(a)\\1" -> invalid escape sequence: \1
```

Оба паттерна из наших доков компилируются. Lookahead и обратные ссылки — нет.
**Не покрывает:** сборку `re2` на Linux/Windows; проверено только macOS arm64.

**Ф3. `yaml@2.9.0` на дефолтах уже отбивает враждебный манифест.** Сырой вывод:

```
billion laughs (9^8)         THROW 4.9ms  Excessive alias count indicates a resource exhaustion attack
duplicate keys               THROW 0.3ms  Map keys must be unique at line 2, column 1
merge keys                   OK    0.4ms  {"base":{"x":1},"d":{"<<":{"x":1},"y":2}}
!!js/function tag            OK    0.2ms  {"f":"function(){}"}
unknown custom tag           OK    0.1ms  {"f":"payload"}
Norway problem               OK    0.4ms  {"allow":"no","deny":"yes","on":"on"}
deep nesting x50000          THROW 85.8ms Maximum call stack size exceeded at line 1, column 669
```

Выводы: алиас-бомба и дубли ключей отбиты дефолтами; `!!js/function` **не исполняется**,
а деградирует в строку с предупреждением `TAG_RESOLVE_FAILED`; `no`/`yes`/`on` остаются
строками (YAML 1.2 core schema), то есть «норвежской проблемы» здесь нет; глубокая
вложенность даёт пойманную ошибку, а не падение процесса. Остаётся закрыть два зазора:
лимит размера до разбора и превращение `TAG_RESOLVE_FAILED` в отказ.
**Не покрывает:** `js-yaml` не проверялся; поведение при потоковом разборе не проверялось.

**Ф4. ajv: именованный импорт обязателен, дефолтный не компилируется.** Сырой вывод
`tsc` под `NodeNext` + `verbatimModuleSyntax` (TS 5.9.3):

```
a.ts(2,17): error TS2351: This expression is not constructable.
  Type 'typeof import(".../ajv/dist/2020")' has no construct signatures.
```
```
import { Ajv2020 } from "ajv/dist/2020.js";   // tsc exit=0
import Ajv2020 from "ajv/dist/2020.js";       // TS2351
```

**Ф5. `discriminator: true` сводит 8 ошибок к одной.** Сырой вывод на союзе из пяти
веток, параметр `type: string` без `pattern`:

```
### RAW ajv errors (allErrors:true, plain oneOf), count = 8
### [strict:true+strictRequired:false | tag=const] valid=false, errors=1 ::
  [{"instancePath":"/tools/run_tests/params/pattern",
    "schemaPath":"#/$defs/StringParam/required","keyword":"required",
    "params":{"missingProperty":"pattern"},
    "message":"must have required property 'pattern'"}]
```

`strict: true` без `strictRequired: false` **не компилирует** схему с дискриминатором:
`strict mode: required property "type" is not defined ... (strictRequired)`.

**Ф6. Zod и TypeBox протекают в `.d.ts` потребителя.** Сырой вывод `tsc` в проекте
без них:

```
contracts-dts/zd.d.ts(1,20): error TS2307: Cannot find module 'zod'
contracts-dts/tb.d.ts(1,29): error TS2307: Cannot find module '@sinclair/typebox'
# plain.d.ts (кодогенерация из JSON Schema): ошибок нет
```

Это и решает выбор маршрута: замороженный пакет не может делать мажорный бамп чужой
библиотеки ломающим изменением для семи эпиков.

**Ф7. Ревизия MCP и дефолты аннотаций.** Текущая ревизия — `2026-07-28`; выбрана
`2025-11-25` (D1), потому что `@modelcontextprotocol/sdk@1.30.0` объявляет
`LATEST_PROTOCOL_VERSION = '2025-11-25'` и `2026-07-28` не поддерживает. Дефолты
`ToolAnnotations` подтверждены дословно по `schema/2026-07-28/schema.ts` и идентичны
начиная с `2025-03-26`: `readOnlyHint` `false`, `destructiveHint` `true`,
`idempotentHint` `false`, `openWorldHint` `true`.

**Ф8. OTLP/JSON требует camelCase и запрещает snake_case.** Дословно из спеки OTLP:
«The keys of JSON objects are field names converted to lowerCamelCase. Original field
names are not valid to use as keys for JSON objects.» И: приёмники «MUST ignore message
fields with unknown names», то есть `trace_id` не даёт ошибки — он молча теряется.
Отсюда R14: тест на отсутствие snake_case обязателен, иначе дефект ненаблюдаем.

**`ASSUMED`:** что демо-клиент согласует именно `2025-11-25`. Не проверялось, какой
именно клиент будет на сцене. Если он окажется старее — правится в E4, контракта не
касается, потому что R18 держит поля опциональными.

---

## Tasks

### T1 — тест-раннер, которого нет

**Files:** `package.json` (Modify), `packages/contracts/package.json` (Modify),
`packages/contracts/vitest.config.ts` (Create), `packages/contracts/src/domain.test.ts` (Create)

Шаги: добавить `vitest` в devDependencies корня; в `contracts` скрипт
`"test": "vitest run"`; конфиг с `environment: 'node'`, `include: ['src/**/*.test.ts']`;
первый тест — на `stageOrder`, который сегодня не покрыт ничем.

**Falsification:** удалить `'violation'` из `stageOrder` (`packages/contracts/src/domain.ts:28`)
→ утверждение `expect(stageOrder).toHaveLength(13)` читает 12 и падает; вернуть → зелено.
Тест исполняется в node, без DOM.

**Verification:** `yarn workspace @mcpproxy/contracts test` — падает при мутации, зелен без неё.
Затем `yarn test` из корня и проверка, что он больше не выходит с нулём на пустоте.

**Commit:** `E0: тест-раннер в воркспейсе`

### T2 — аннотации и вывод риск-тира

**Files:** `packages/contracts/src/annotations.ts` (Create),
`packages/contracts/src/annotations.test.ts` (Create), `packages/contracts/src/index.ts` (Modify)

Интерфейс: `ToolAnnotations` (все поля опциональные), `ANNOTATION_DEFAULTS`,
`deriveRiskTier(a: ToolAnnotations): RiskTier`. Функция чистая, `RiskTier` берётся из
`domain.ts:45`, не объявляется заново.

**Falsification:** убрать проверку `readOnlyHint === false` перед чтением
`destructiveHint` → строка 3 таблицы §7 (`{readOnlyHint: true, destructiveHint: true}`)
возвращает `high` вместо `low`, тест падает на этом кейсе и только на нём.
Асcертируется возвращённая строка тира, не порядок вызовов. Рантайм — node.

**Verification:** `vitest run src/annotations.test.ts` — шесть кейсов таблицы §7.

**Commit:** `E0: аннотации MCP и вывод риск-тира`

### T3 — JSON Schema манифеста как публикуемый артефакт

**Files:** `packages/contracts/schema/mcpproxy.schema.json` (Create),
`packages/contracts/scripts/gen-types.mjs` (Create), `packages/contracts/package.json` (Modify),
`packages/contracts/schema.test.ts` (Create)

Схема 2020-12 с `$id`, `$defs`, `oneOf` из `$ref` на самодостаточные ветки,
`const`-дискриминатор `type`, `additionalProperties: false` везде. Ветки:
`StringParam` (требует `pattern`), `EnumParam` (требует непустой `values`),
`NumberParam`, `BooleanParam`, `PathParam` (требует `root`).

Ветки обязаны остаться без соседних `properties` рядом с `oneOf`, без `if/then` и без
`prefixItems`: в `json-schema-to-typescript@15.0.4` все три сломаны или игнорируются,
и соседние `properties` тихо делают дискриминатор опциональным.

**Falsification:** убрать `"pattern"` из `required` ветки `StringParam` → тест
«манифест с `type: string` без `pattern` отвергается» видит `valid=true` и падает.

**Verification:** `vitest run schema.test.ts` + проверка схемы по мета-схеме 2020-12.

**Commit:** `E0: JSON Schema манифеста и кодогенерация типов`

### T4 — `parseManifest`: YAML, ajv, диагностика

**Files:** `packages/contracts/src/validate/index.ts` (Create),
`packages/contracts/src/validate/yaml.ts` (Create),
`packages/contracts/src/validate/parse.test.ts` (Create),
`packages/contracts/package.json` (Modify — `exports`, `dependencies`)

`parseManifest(yamlText, opts)` → `{ok: true, manifest} | {ok: false, diagnostics}`.
Разбор `yaml@2.9.0` с `LineCounter`; лимит размера до разбора; `TAG_RESOLVE_FAILED`
превращается в отказ. Валидация — `new Ajv2020({allErrors: true, discriminator: true,
strict: true, strictRequired: false})`, **именованный импорт** (Ф4).
`instancePath` → точечный путь + `строка:колонка`.

**Falsification:** убрать `discriminator: true` → тест «одна ошибка на один дефект»
читает 8 ошибок вместо 1 и падает; утверждение пинует `diagnostics.length` и текст
первой диагностики, а не индекс в массиве.

**Verification:** `vitest run src/validate/parse.test.ts` — кейсы: валидный манифест;
`string` без `pattern`; `path` без `root`; неизвестный `type`; дубль ключа;
алиас-бомба; неизвестный тег; превышение лимита размера.

**Commit:** `E0: parseManifest — YAML, ajv, диагностика с координатами`

### T5 — RE2 как контракт на регулярные выражения

**Files:** `packages/contracts/src/validate/regex.ts` (Create),
`packages/contracts/src/validate/regex.test.ts` (Create),
`packages/contracts/src/validate/index.ts` (Modify)

Компиляция каждого `pattern` через `re2`; отказ с причиной, если RE2 не принимает;
тот же движок передаётся в ajv через `code.regExp`.

**Falsification:** убрать вызов компиляции через RE2 → тест, подающий манифест с
`pattern: "^(?=.*a)b$"`, ожидает диагностику и получает успешную загрузку; падает.
Отдельный тест меряет, что `(a+)+$` на 64 символах отрабатывает быстрее 50 мс —
он падает, если движок вернулся к встроенному `RegExp` (Ф1 против Ф2).

**Verification:** `vitest run src/validate/regex.test.ts`

**Commit:** `E0: RE2 для паттернов манифеста`

### T6 — событие аудита и экспорт в OTLP

**Files:** `packages/contracts/src/event.ts` (Create), `packages/contracts/src/otlp.ts` (Create),
`packages/contracts/src/otlp.test.ts` (Create), `packages/contracts/src/index.ts` (Modify)

`AuditEvent` — вложенный, ISO-время, строковые enum'ы, `stage: Stage` из `domain.ts:12`.
`toOtlp` — `traceId`/`spanId` hex, числовой `kind`, `startTimeUnixNano` десятичной
строкой, атрибуты под именами, подтверждёнными Ф7 (`gen_ai.tool.name`,
`jsonrpc.request.id`, `network.transport`; `mcp.tool.name`/`mcp.request.id`/
`mcp.transport` не существуют и не эмитятся).

**Falsification:** вернуть в `toOtlp` ключ `trace_id` вместо `traceId` → тест обхода
всех ключей вывода находит snake_case и падает. Утверждение проверяет **отсутствие**
любого ключа с `_`, а не наличие конкретного, потому что дефект класса «молча
потеряно приёмником» иначе ненаблюдаем (Ф8).

**Verification:** `vitest run src/otlp.test.ts`

**Commit:** `E0: схема события и экспортёр OTLP`

### T7 — хэш-цепочка по каноничному JSON

**Files:** `packages/contracts/src/audit/jcs.ts` (Create),
`packages/contracts/src/audit/chain.ts` (Create),
`packages/contracts/src/audit/chain.test.ts` (Create),
`packages/contracts/package.json` (Modify — `./audit`)

JCS по RFC 8785 (сортировка ключей по кодовым единицам UTF-16, без пробелов);
`chainHash(event, prev)` считает по событию **без** `chain.self`, пересборкой, не
спредом (§4); `verifyChain(events)` возвращает индекс первого расхождения.

**Falsification:** изменить один байт в `output.bytes` третьей записи синтетического
лога → `verifyChain` обязан вернуть `2`; при семиполевой схеме хэша он вернул бы
`null`, и тест на это падает — это ровно тот дефект, который ломает сценарий S9.

**Verification:** `vitest run src/audit/chain.test.ts`, включая векторы RFC 8785.

**Commit:** `E0: JCS и хэш-цепочка аудита`

### T8 — lock-файл и нормализованное представление рецепта

**Files:** `packages/contracts/src/lock.ts` (Create), `packages/contracts/src/lock.test.ts` (Create)

Схема `mcpproxy.lock`; `normalizeRecipe(recipe)` — детерминированное представление
(`exec`, `cwd`, схемы параметров, аннотации, профиль песочницы, `description`),
пригодное и для хэша, и для показа диффа целиком.

**Falsification:** исключить `description` из нормализации → тест «изменение только
`description` меняет хэш» видит равные хэши и падает. Это класс CVE-2025-54136:
одобрение не должно переживать правку описания.

**Verification:** `vitest run src/lock.test.ts`

**Commit:** `E0: lock-файл и нормализация рецепта`

### T9 — IPC, проекция в `Tool`, санитизация описания

**Files:** `packages/contracts/src/ipc.ts` (Create), `packages/contracts/src/tool.ts` (Create),
`packages/contracts/src/tool.test.ts` (Create)

`IpcRequest = {recipe, params, sessionId}` — форма, в которой argv, путь к бинарю,
`cwd` и профиль невыразимы. `toTool(recipe)` — проекция ревизии `2025-11-25` с
опциональными `resultType`/`ttlMs`/`cacheScope`. `sanitizeDescription`.

**Falsification:** пропустить `sanitizeDescription` в `toTool` → тест, подающий
описание с встроенной инструкцией и переводами строк, находит её в выводе и падает.

**Verification:** `vitest run src/tool.test.ts`

**Commit:** `E0: IPC-контракт, проекция tools/list, санитизация`

### T10 — четыре рецепта-заглушки

**Files:** `packages/contracts/recipes/mcpproxy.yaml` (Create),
`packages/contracts/src/recipes.test.ts` (Create)

`run_tests`, `build_project`, `analyze_logs`, `publish_release`. Последний —
`destructiveHint: true`, `openWorldHint: true`, то есть единственный `high` (нужен S8).

**Falsification:** заменить в `run_tests` `argv: ["--testPathPattern", "{}"]` на
одну строку `"--testPathPattern={}"` → тест «каждый элемент argv — отдельный литерал»
падает. Это инвариант И2, и без теста он держится только на внимательности.

**Verification:** `vitest run src/recipes.test.ts` — все четыре грузятся через
`parseManifest` без диагностик; тиры выходят `medium/medium/low/high`.

**Commit:** `E0: четыре рецепта-заглушки`

### T11 — заморозка и правки доков

**Files:** `packages/contracts/src/index.ts` (Modify), `docs/04-research-findings.md` (Modify),
`docs/07-contracts.md` (Modify), `docs/10-honest-limitations.md` (Modify),
`docs/adr/0003-otel-event-schema.md` (Modify), `docs/adr/0004-mcp-tool-annotations.md` (Modify)

Снять `TODO(E0)` (`packages/contracts/src/index.ts:6`); зафиксировать заморозку.
Правки доков — R24 и R25: направление переезда OTel, несуществующие атрибуты,
переехавшие URL, атрибуция tool poisoning, ReDoS в честных границах, смягчение
«fail-safe by construction» до границы из R11.

**Verification:** `yarn typecheck && yarn build && yarn test` из корня — зелено на
всём графе, включая `design`.

**Commit:** `E0: заморозка контракта и правки документации`

---

## Requirement diff

| R | Строка плана, которая его реализует |
|---|---|
| R1 | T3: «Схема 2020-12 с `$id`, `$defs`, `oneOf` из `$ref`…» |
| R2 | T3: «Ветки: `StringParam` (требует `pattern`)… `PathParam` (требует `root`)» |
| R3 | T3: `scripts/gen-types.mjs`; Ф6 обосновывает маршрут |
| R4 | T4: «`parseManifest(yamlText, opts)` → `{ok: true, manifest} \| {ok: false, diagnostics}`» |
| R5 | T5 целиком + T4 «лимит размера до разбора» |
| R6 | T3 Falsification + таблица веток; тест на соответствие веток и проверок |
| R7 | T5: «Компиляция каждого `pattern` через `re2`» |
| R8 | T4: «лимит размера до разбора; `TAG_RESOLVE_FAILED` превращается в отказ» |
| R9 | T2: «`ToolAnnotations` (все поля опциональные), `ANNOTATION_DEFAULTS`» |
| R10 | T2: «`deriveRiskTier(a: ToolAnnotations): RiskTier`» + таблица §7 |
| R11 | T2 Falsification (строка 3 таблицы §7) + T11 правка формулировки |
| R12 | T6: «`AuditEvent` — вложенный, ISO-время, строковые enum'ы» |
| R13 | T6: «`toOtlp` — `traceId`/`spanId` hex, числовой `kind`…» |
| R14 | T6 Falsification: «утверждение проверяет **отсутствие** любого ключа с `_`» |
| R15 | T7: «`chainHash(event, prev)` считает по событию **без** `chain.self`» |
| R16 | T8: «`normalizeRecipe(recipe)` — детерминированное представление» |
| R17 | T9: «`IpcRequest = {recipe, params, sessionId}`» |
| R18 | T9: «проекция ревизии `2025-11-25` с опциональными `resultType`/`ttlMs`/`cacheScope`» |
| R19 | T9: «`sanitizeDescription`» |
| R20 | T10: «`run_tests`, `build_project`, `analyze_logs`, `publish_release`» |
| R21 | T1 целиком |
| R22 | T11 Verification: «зелено на всём графе, включая `design`» |
| R23 | T11: «Снять `TODO(E0)`; зафиксировать заморозку» |
| R24 | T11: «направление переезда OTel, несуществующие атрибуты, переехавшие URL» |
| R25 | T11: «ReDoS в честных границах» |
