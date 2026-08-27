# План E0 — заморозка `packages/contracts`

## Goal

Реализовать `R1..R25` из `spec.md`: манифест, событие, риск, lock, IPC, четыре
заглушки, тест-инфраструктура, заморозка, правки доков.

## Architecture

`packages/contracts` разделяется на три входа, потому что у него три разных
потребителя с разными правами на зависимости:

| Вход | Что внутри | Зависимости |
|---|---|---|
| `.` | Типы (`Manifest`, `Recipe`, `AuditEvent`, `Diagnostic`), доменные юнионы, `deriveRiskTier`, `sanitizeDescription`, `toOtlp`, `canonicalizeJcs` | нет |
| `./validate` | `parseManifest` | `ajv`, `yaml`, `re2` |
| `./audit` | `chainHash`, `verifyChain` | `node:crypto` |

Корневой вход обязан остаться без зависимостей, но **не** по той причине, которая
напрашивается. Проверено: собранный design (dist/semantic.js) не содержит ни одного
`import` — там только `import type`, который стирает `verbatimModuleSyntax`. Утечки на
уровне импорта нет.

Настоящая цена — установочная. пакет desktop зависит от `contracts`
напрямую, поэтому зависимость корневого входа становится транзитивной зависимостью
Electron-приложения: `re2` — нативный аддон, который придётся собирать каждому
разработчику и каждому раннеру CI и пересобирать под ABI Electron, причём на платформах,
где он не проверялся (Ф2 честно ограничена macOS arm64). Отсюда правило: `.` без
зависимостей, `./validate` тянет только демон, а Task 4 добавляет исполняемую проверку
этого, а не обещание.

Типы живут в `.` целиком — включая `Manifest`, `Recipe`, `Diagnostic`,
`ParseManifestResult`, `ManifestSource`. `./validate` экспортирует только *функцию*
`parseManifest`. Иначе рендерер, которому надо показать диагностику с координатами
(R4), обязан импортировать `./validate` и притащить нативный аддон — то есть раскол
не выполнит ровно ту работу, ради которой существует.

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
| `AuditEvent` в `chainHash` | вызывающий, литерал по типу контракта | plain object | вопрос снят — см. ниже |
| результат `YAML.parse` | `yaml@2.9.0` | plain object/array/scalar | да |
| `errors` из ajv | `ajv@8.20.0` | массив plain object | да |
| `RE2` инстанс | `re2@1.26.1` | **экземпляр класса** | **нет** — не спредить, не сериализовать |

Пересборки события не будет вообще: вместо неё **разделены типы**. `AuditEvent`
объявляется *без* поля `chain`, а `ChainedEvent = AuditEvent & { chain: { prev: string | null;
self: string } }`. Тогда `chainHash` хэширует свой аргумент целиком, и вопрос «что исключить
перед хэшированием» не возникает.

Это не косметика. Пересборка по списку полей означает, что каждое поле, добавленное в
`AuditEvent` после заморозки, тихо выпадает из хэша, пока кто-нибудь не вспомнит дописать
его в пересборку — и становится подделываемым, причём ни один тест не краснеет. Разделение
типов хэширует новые поля по построению.

### 5. Premises — каждое «потому что здесь верно X»

| Премисса | Грep, который её устанавливает | Quoted evidence | Где держится | Решение |
|---|---|---|---|---|
| P1. `contracts` уже владеет шестью юнионами, их не надо создавать | `grep -n "export type" packages/contracts/src/domain.ts` | `export type Verdict = 'allowed' \| 'denied' \| 'pending_approval' \| 'error';` (`packages/contracts/src/domain.ts:9`) | один файл | переиспользуем, не трогаем |
| P2. 13 стадий уже перечислены и упорядочены | `grep -n "stageOrder" packages/contracts/src/domain.ts` | `export const stageOrder: readonly Stage[] = [` (`packages/contracts/src/domain.ts:28`) | один файл | событие ссылается на `Stage`, список не дублируем |
| P3. Юнионы расширять нельзя без правки `design` | таблица §2 | `export const stageLabel: Readonly<Record<Stage, string>> = {` (`packages/design/src/semantic.ts:48`) | 10 мест + 1 `switch` | **ни один юнион не расширяется** |
| P4. `TODO(E0)` называет ровно объём этой работы | `cat -n packages/contracts/src/index.ts` | `// TODO(E0): JSON Schema манифеста, схема события (OTel GenAI), три рецепта-заглушки.` (`packages/contracts/src/index.ts:6`) | одна строка | снимается в Task 11 |
| P5. Пакет сегодня без зависимостей | `grep -n "dependencies" packages/contracts/package.json` | в `packages/contracts/package.json` секции `dependencies` нет | один файл | корневой вход обязан остаться таким |

### 6. Ordered parameter

**Таблица удалена: ни одно правило плана не ветвится по дате, индексу, версии или
порогу.** `deriveRiskTier` ветвится по булевым флагам — это §7, а не §6. Лимит размера
YAML (R8) — единственный порог, и он не ветвит логику, а отсекает вход до разбора;
его три значения проверены в Task 4.

### 7. Classifier outputs — `deriveRiskTier`

Вход — аннотации **как заданы в манифесте**; дефолты спеки применяются внутри
`deriveRiskTier`, поэтому параметр остаётся со всеми полями опциональными и строка 1
(пустой объект) достижима. Каждая строка — тест.

Сигнатура — `deriveRiskTier(annotations: ToolAnnotations, lockVerified: boolean)`, и при
`lockVerified === false` возвращается `high` независимо от аннотаций. Причина в том, что
таблица ниже верна только для рецепта, чью нормализованную форму одобрил lock: спека MCP
требует считать аннотации недоверенными, а `analyze_logs` с одним лишь
`readOnlyHint: true` даёт `low` и авто-исполнение. Между rug pull'ом, дописавшим
`readOnlyHint: true`, и молчаливым запуском стоит только lock — поэтому правило вносится
в сигнатуру, а не в комментарий, и забыть его вниз по течению нельзя.

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

Выводы по дефолтам: алиас-бомба и дубли ключей отбиты; `!!js/function` **не
исполняется**, а деградирует в строку с предупреждением `TAG_RESOLVE_FAILED`; глубокая
вложенность даёт пойманную ошибку, а не падение процесса.

**Ф3-бис. Вывод «норвежской проблемы здесь нет» был неверен — он верен только для
дефолтных опций.** Манифест недоверенный, а значит директиву в первой строке выбирает
атакующий. Замер:

```
default (1.2) norway               {"allow":"no","deny":"yes","flag":"on"}
%YAML 1.1 norway                   {"allow":false,"deny":true,"flag":true}
default (1.2) merge                {"base":{"x":1},"d":{"<<":{"x":1},"y":2}}
%YAML 1.1 merge                    {"base":{"x":1},"d":{"x":1,"true":2}}
explicit version:1.2 vs directive  {"allow":false,"deny":true,"flag":true}
octal 1.1                          {"m":493}
```

`%YAML 1.1` возвращает и слияние по `<<`, и булев разбор `no`/`yes`/`on`, и восьмеричные
литералы. `sandbox.network.allow: [no]` превращается в `[false]`; ключ `y` превращается
в `true`. И главное — **передача `{version: '1.2'}` директиву не перебивает**: последняя
строка замера показывает тот же испорченный разбор. Поэтому единственная работающая мера
— отказывать документу, несущему директиву `%YAML`, а не пытаться задать версию опцией.

Закрыть остаётся три зазора: лимит размера до разбора, `TAG_RESOLVE_FAILED` как отказ,
и отказ при наличии `%YAML`-директивы.
**Не покрывает:** `js-yaml` не проверялся; потоковый разбор не проверялся; поведение
директивы `%YAML 1.3` (не существует) не проверялось.

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

**Ф9. Имена атрибутов OTel — откуда они взяты.** Task 6 эмитит `gen_ai.tool.name`,
`jsonrpc.request.id`, `network.transport` и не эмитит `mcp.tool.name`,
`mcp.request.id`, `mcp.transport`. Основание — не npm-пакет, а репозиторий конвенций:
`model/mcp/registry.yaml` проверен на каждом теге и отсутствует до v1.39.0, присутствует
на v1.39.0–v1.41.x и **отсутствует начиная с v1.42.0**; релизная заметка v1.42.0 гласит,
что всё `gen_ai.*` и `model/mcp/` переехало в `open-telemetry/semantic-conventions-genai`.
В самом реестре MCP всего четыре атрибута — `mcp.method.name`, `mcp.session.id`,
`mcp.resource.uri`, `mcp.protocol.version`; имя инструмента переиспользует
`gen_ai.tool.name`, идентификатор запроса — `jsonrpc.request.id` из основного репозитория,
транспорт — `network.transport` плюс `network.protocol.*`.
**Не покрывает:** новый репозиторий не имеет ни одного тега и ни одного релиза, поэтому
закрепиться можно только на коммит; статус всего `gen_ai.*` — Development, и дрейф уже
наблюдался (`gen_ai.agent.name` появился на спане `execute_tool` после v1.41.0 без релиза).
Это и есть довод за экспортёр вместо нативной схемы (D2).

**`ASSUMED`:** что демо-клиент согласует именно `2025-11-25`. Не проверялось, какой
именно клиент будет на сцене. Если он окажется старее — правится в E4, контракта не
касается, потому что R18 держит поля опциональными.

---

## Tasks

### Task 1 — тест-раннер, которого нет

**Files:** `package.json` (Modify), `packages/contracts/package.json` (Modify), `packages/contracts/vitest.config.ts` (Create), `packages/contracts/src/domain.test.ts` (Create)

Шаги: добавить `vitest` в devDependencies корня; в `contracts` скрипт
`"test": "vitest run"`; конфиг с `environment: 'node'`, `include: ['src/**/*.test.ts']`;
первый тест — на `stageOrder`, который сегодня не покрыт ничем.

Утверждение проверяет объявленный инвариант, а не длину массива: `stageOrder` поэлементно
равен задокументированной последовательности, и каждая `Stage` встречается ровно один раз
(через построенный из массива `Record<Stage, true>`, чтобы полноту проверял и компилятор).
Проверка длины прошла бы при перестановке двух стадий.

Отдельное утверждение — что раннер обнаружил ненулевое число файлов: иначе тест, положенный
мимо `include`, исчезает молча, а это ровно дефект R21.

**Falsification:** утверждение — `expect(stageOrder).toEqual(EXPECTED_STAGES)`. Удалить
`'violation'` из `stageOrder` (`packages/contracts/src/domain.ts:28`) → сравнение расходится
на индексе 10 и падает; поменять местами `spawn` и `redact` → падает там же; вернуть → зелено.
Рантайм — node, без DOM.

**Verification:** `yarn workspace @mcpproxy/contracts test`, затем `yarn test` из корня —
он больше не выходит с нулём на пустоте.

**Commit:** `E0: тест-раннер в воркспейсе`

### Task 2 — аннотации и вывод риск-тира

**Files:** `packages/contracts/src/annotations.ts` (Create), `packages/contracts/src/annotations.test.ts` (Create), `packages/contracts/src/index.ts` (Modify)

`ToolAnnotations = Partial<Record<AnnotationKey, boolean>>`,
`ANNOTATION_DEFAULTS: Readonly<Record<AnnotationKey, boolean>>` (`as const`, по стилю
`packages/design/src/semantic.ts:31`),
`deriveRiskTier(annotations: ToolAnnotations, lockVerified: boolean): RiskTier`.
Функция чистая; дефолты применяет сама.

Имена хинтов **не перечисляются заново**: `AnnotationKey` уже владеет ими
(`packages/contracts/src/domain.ts:57`), и `design` строит по нему исчерпывающий
`Readonly<Record<AnnotationKey, string>>` (`packages/design/src/semantic.ts:121`).

**Falsification:** утверждение — `expect(deriveRiskTier({readOnlyHint: true, destructiveHint: true}, true)).toBe('low')`.
Убрать проверку `readOnlyHint === false` перед чтением `destructiveHint` → возвращается
`high`, падает только этот кейс. Второе утверждение —
`expect(deriveRiskTier({readOnlyHint: true}, false)).toBe('high')`: убрать `lockVerified`
из ветвления → возвращается `low`, и неодобренный рецепт исполняется молча.

**Verification:** `vitest run src/annotations.test.ts` — шесть кейсов таблицы §7 плюс два
кейса `lockVerified`.

**Commit:** `E0: аннотации MCP и вывод риск-тира`

### Task 3 — JSON Schema манифеста как публикуемый артефакт

**Files:** `packages/contracts/schema/mcpproxy.schema.json` (Create), `packages/contracts/scripts/gen-types.mjs` (Create), `packages/contracts/src/manifest.generated.ts` (Create), `packages/contracts/package.json` (Modify), `packages/contracts/src/index.ts` (Modify), `packages/contracts/src/schema.test.ts` (Create)

Схема 2020-12 с `$id`, `$defs`, `oneOf` из `$ref` на самодостаточные ветки,
`const`-дискриминатор `type`, `additionalProperties: false` везде. Ветки: `StringParam`
(требует `pattern`), `EnumParam` (непустой `values`), `NumberParam`, `BooleanParam`,
`PathParam` (требует `root`). Плюс `version: {const: 1}` и блок `defaults` из
`docs/07-contracts.md` — без него Task 9 нечего нормализовывать.

`propertyNames: {pattern: "^[a-z][a-z0-9_]{0,63}$"}` на `tools` и на `params`: иначе
`__proto__` и `constructor` — валидные имена рецепта и параметра, что даёт и
prototype-pollution на каждом `manifest.tools[name]` вниз по течению, и свободный слот
инъекции в `tools/list`.

Ветки обязаны остаться без соседних `properties` рядом с `oneOf`, без `if/then` и без
`prefixItems`: в `json-schema-to-typescript@15.0.4` все три сломаны или игнорируются.

`src/manifest.generated.ts` — **коммитится**: корневой вход обязан собираться `tsc -b`
без запуска dev-генератора. `index.ts` реэкспортирует `Manifest`, `Recipe` и типы веток.

**Falsification:** утверждение — `expect(validate(manifestWithProtoKey)).toBe(false)`.
Убрать `propertyNames` → манифест с рецептом `__proto__` грузится, утверждение читает
`true` и падает. Второе — `expect(schema).toMatchObject({$defs: {StringParam: {required: ['type','pattern']}}})`:
убрать `pattern` из `required` → падает. Третье — сгенерированный файл совпадает с текущим
выводом генератора, иначе закоммиченная копия молча разъезжается со схемой.

**Verification:** `vitest run src/schema.test.ts` + валидация схемы по мета-схеме 2020-12.

**Commit:** `E0: JSON Schema манифеста и кодогенерация типов`

### Task 4 — `parseManifest`: YAML, ajv, диагностика

**Files:** `packages/contracts/src/types.ts` (Create), `packages/contracts/src/validate/index.ts` (Create), `packages/contracts/src/validate/yaml.ts` (Create), `packages/contracts/src/validate/parse.test.ts` (Create), `packages/contracts/src/deps.test.ts` (Create), `packages/contracts/package.json` (Modify)

Именованные формы объявляются в **корневом** входе (`src/types.ts`), не в `./validate`:
`ManifestSource = {path: string; maxBytes?: number}`,
`Diagnostic = {path: string; line: number; column: number; message: string}`,
`ParseManifestResult = {ok: true; manifest: Manifest} | {ok: false; diagnostics: Diagnostic[]}`.
`./validate` экспортирует только функцию.

`parseManifest(yamlText: string, source: ManifestSource): ParseManifestResult`.
Разбор `yaml@2.9.0` с `LineCounter`. Три меры сверх дефолтов (Ф3, Ф3-бис):
`MANIFEST_MAX_BYTES` — экспортируемая константа, `maxBytes` может её только **понижать**;
`TAG_RESOLVE_FAILED` — отказ; **документ с директивой `%YAML` отвергается целиком**,
потому что замер показал, что опция `version: '1.2'` директиву не перебивает.

Валидация — `new Ajv2020({allErrors: true, discriminator: true, strict: true,
strictRequired: false})`, **именованный импорт** (Ф4). `instancePath` → точечный путь +
`строка:колонка`.

`deps.test.ts` — исполняемая проверка архитектурного заявления: собранный `dist/index.js`
и его граф не содержат `ajv`, `yaml`, `re2`. Сегодня это утверждение живёт только в прозе.

**Falsification:** утверждение — `expect(parseManifest(yaml11Directive, src).ok).toBe(false)`.
Снять отказ по директиве → `%YAML 1.1` разбирается, `sandbox.network.allow: [no]` даёт
`[false]`, утверждение читает `true` и падает. Второе —
`expect(diagnostics).toHaveLength(1)`: убрать `discriminator: true` → 8 диагностик вместо 1.
Третье — `deps.test.ts` падает, если `ajv` попал в граф корневого входа.

**Verification:** `vitest run src/validate/parse.test.ts src/deps.test.ts` — кейсы: валидный
манифест; `string` без `pattern`; `path` без `root`; неизвестный `type`; дубль ключа;
алиас-бомба; неизвестный тег; директива `%YAML 1.1`; размер ровно на лимите, на байт больше,
на байт меньше (три значения §6).

**Commit:** `E0: parseManifest — YAML, ajv, диагностика с координатами`

### Task 5 — RE2 и скомпилированный матчер

**Files:** `packages/contracts/src/validate/regex.ts` (Create), `packages/contracts/src/validate/regex.test.ts` (Create), `packages/contracts/src/validate/index.ts` (Modify), `packages/contracts/src/types.ts` (Modify)

Компиляция каждого `pattern` через `re2` на загрузке; отказ с причиной, если RE2 не
принимает. Тот же движок передаётся в ajv через `code.regExp` — это нужно не для
пользовательской строки (её ajv видит как данные), а для схем, которые E2 будет
компилировать из параметров рецепта.

**Главное:** через границу пакета едет не голая строка. `parseManifest` возвращает параметр,
несущий `PatternMatcher {test(value: string): boolean}` рядом с исходным `pattern`.
Иначе E2 вправе вызвать `new RegExp(pattern)` и вернуть ReDoS, который здесь закрыт только
на загрузке: манифест поставляет и выражение, и — через модель — проверяемую строку.

**Falsification:** утверждение — `expect(parseManifest(withLookahead, source).ok).toBe(false)`.
Убрать компиляцию через RE2 → манифест с `pattern: "^(?=.*a)b$"` грузится, утверждение
читает `true` и падает. Второе — `expect(elapsedMs).toBeLessThan(50)` на `(a+)+$` и входе
в 64 символа: краснеет, если движок вернулся к встроенному `RegExp` (Ф1 против Ф2). Запас
пять порядков (0.009 мс против геологического времени), поэтому порог не флакает.

**Verification:** `vitest run src/validate/regex.test.ts`

**Commit:** `E0: RE2 и скомпилированный матчер вместо голого паттерна`

### Task 6 — пять проверок R5 и таблица «ветка ↔ проверка»

**Files:** `packages/contracts/src/validate/refine.ts` (Create), `packages/contracts/src/validate/refine.test.ts` (Create), `packages/contracts/src/validate/branch-checks.ts` (Create), `packages/contracts/src/validate/index.ts` (Modify)

JSON Schema не выражает эти пять правил, поэтому они живут здесь и вызываются
`parseManifest` — не вызывающим:

1. `root` абсолютен либо резолвится относительно `source.path`; `root: "/"` и `"../.."` — отказ;
2. `exec[0]` без метасимволов оболочки, и либо абсолютный путь, либо голое имя без разделителя;
3. элемент `argv` содержит `{}` не более одного раза;
4. ни один параметр не подставляется в `exec[0]`, `cwd` или профиль песочницы;
5. `pattern` компилируется через RE2 (Task 5).

`branch-checks.ts` — экспортируемый `Record<BranchName, CheckId[]>`, где ветка без проверок
помечена явно. Это и есть R6.

**Falsification:** утверждение — `expect(parseManifest(execWithSlot, source).ok).toBe(false)`.
Убрать правило 4 → манифест с `exec: ["./run-{}.sh"]` грузится, утверждение читает `true`
и падает — это И1/И2 и атаки A1/A4 на границе загрузки. Второе утверждение —
`expect(Object.keys(branchChecks)).toEqual(Object.keys(schema.$defs))`: добавить ветку в
схему без записи в таблицу → множества расходятся и тест падает.

**Verification:** `vitest run src/validate/refine.test.ts` — по кейсу на каждое из пяти
правил плюс сверка множеств веток.

**Commit:** `E0: проверки, которых схема не выражает, и таблица веток`

### Task 7 — событие аудита и экспорт в OTLP

**Files:** `packages/contracts/src/event.ts` (Create), `packages/contracts/src/otlp.ts` (Create), `packages/contracts/src/otlp.test.ts` (Create), `packages/contracts/src/index.ts` (Modify)

`AuditEvent` — вложенный, ISO-время, строковые enum'ы, `stage: Stage` из `domain.ts:12`,
**без поля `chain`** (его добавляет `ChainedEvent` в Task 8, см. §4).

Рядом с ISO-временем стены — `durationUs: number`, монотонная длительность стадии из
`process.hrtime.bigint()`, целым числом. Без неё оверхед, который публикуют S2 и
09-metrics-and-eval (p50 9 мс при цели ≤50 мс p95), не выводится: метки,
квантованные до миллисекунды, дают ошибку порядка самого измерения, а часы стены ещё и
прыгают по NTP. На `complete` фиксируется правило
`overheadMs = Σ durationUs стадий − длительность spawn→exit`.

`toOtlp` — `traceId`/`spanId` hex, числовой `kind`, `startTimeUnixNano`/`endTimeUnixNano`
десятичными строками, атрибуты под именами из **Ф9** (`gen_ai.tool.name`,
`jsonrpc.request.id`, `network.transport`; `mcp.tool.name`, `mcp.request.id`,
`mcp.transport` не существуют и не эмитятся).

**Falsification:** утверждение — `expect(Object.keys(flatten(toOtlp(e))).filter(k => k.includes('_'))).toEqual([])`.
Вернуть ключ `trace_id` вместо `traceId` → находится snake_case, тест падает. Проверяется
**отсутствие** любого ключа с `_`, а не наличие конкретного: приёмник OTLP обязан молча
игнорировать неизвестные поля (Ф8), поэтому иначе дефект ненаблюдаем вообще.

**Verification:** `vitest run src/otlp.test.ts`

**Commit:** `E0: схема события, длительности стадий, экспортёр OTLP`

### Task 8 — JCS и хэш-цепочка

**Files:** `packages/contracts/src/jcs.ts` (Create), `packages/contracts/src/jcs.test.ts` (Create), `packages/contracts/src/audit/chain.ts` (Create), `packages/contracts/src/audit/chain.test.ts` (Create), `packages/contracts/package.json` (Modify)

`canonicalizeJcs` живёт в **корневом** входе (`src/jcs.ts`): у неё нет зависимостей,
включая `node:crypto`. `./audit` берёт только то, что действительно требует `node:crypto`.

Скаляры делегируются `JSON.stringify` — он уже даёт кратчайшее round-trip представление
чисел и well-formed экранирование; руками пишутся только порядок ключей и структура.
Нефинитные числа и одиночные суррогаты — явный отказ, а не тихий `null`/`\udXXX`.

**Формула замораживается явно**, потому что «хэшировать аргумент целиком» её не задаёт:

```
self = sha256(utf8(canonicalizeJcs({ prev, event })))
```

`prev` — `string | null`, `null` означает генезис. Ссылка на предыдущую запись входит
**внутрь** каноничной формы, поэтому исключать нечего. Без этого возможна реализация
`sha256(jcs(event))`, где цепочки нет вовсе, каждая запись самостоятельна, и тезис
`docs/02-architecture.md:171` («изменение любой прошлой записи ломает все последующие»)
ложен — при этом тест на порчу записи 3 всё ещё проходит.

`chainHash(event: AuditEvent, prevHash: string | null): string`. Так как TypeScript
структурен и `ChainedEvent` присваиваем к `AuditEvent`, хэшировать `ChainedEvent` напрямую
нельзя — самоссылочно. Поэтому экспортируется один `unchain(e: ChainedEvent): AuditEvent`,
и `verifyChain` обязан ходить через него.

`verifyChain(events: ChainedEvent[]): {ok: true} | {ok: false; brokenAt: number}` — форма
та же, что у `ParseManifestResult`: `number | null` сделал бы `0` ложным, то есть подделка
**первой** записи прошла бы и через `if (!verifyChain(...))`, и через `if (verifyChain(...))`.

**Falsification:** утверждение — `expect(verifyChain(tampered)).toEqual({ok: false, brokenAt: 2})`.
Изменить один байт в `output.bytes` третьей записи → при семиполевой схеме хэша вернулось бы
`{ok: true}`, тест падает — это дефект, ломающий S9. Второе утверждение —
`expect(verifyChain(tamperedAtZero)).toEqual({ok: false, brokenAt: 0})`. Третье, которое
не проходит реализация «цепочки нет вовсе»: поменять местами `prev` двух соседних записей и
потребовать `ok: false`.

**Verification:** `vitest run src/audit/chain.test.ts src/jcs.test.ts`, включая векторы
RFC 8785, в том числе числовой файл.

**Commit:** `E0: JCS и хэш-цепочка аудита`

### Task 9 — lock: манифест целиком, дифф, снапшот

**Files:** `packages/contracts/src/lock.ts` (Create), `packages/contracts/src/lock.test.ts` (Create)

`normalizeRecipe(recipe: Recipe): NormalizedRecipe` — детерминированное представление
(`exec`, `cwd`, схемы параметров, аннотации, **эффективный** профиль песочницы и env, то
есть `defaults`, слитый с блоком рецепта, `description`). Порядок параметров **сохраняется
и входит в форму**: из него собирается argv, поэтому сортировка «для детерминизма» изменила
бы команду, не изменив хэш.

`normalizeManifest(manifest)` и `manifestHash` в `LockFile` — потому что
`defaults.env.allow: [..., "AWS_SECRET_ACCESS_KEY"]` или опустошённый `defaults.sandbox.read.deny`
не меняют ни одного объекта `Recipe`: все пер-рецептные хэши совпадают, `lock_check` зелёный,
а И4 и атака A10 сняты молча.

`LockEntry = {hash, approvedAt, snapshot: NormalizedRecipe}` — снапшот обязателен: SHA-256
необратим, и без него сторону «было» для диффа S7 построить не из чего, а ADR-0006 требует
показать дифф целиком и без усечения. Дописывать снапшот после E1/E7 — инвалидировать
все существующие lock-файлы.

`diffLock(lock, manifest): {added: string[]; removed: string[]; changed: Array<{name, was, is}>}`
— добавление и удаление рецепта становятся обязательством формы возврата, а не дисциплиной
реализации.

**Falsification:** утверждение — `expect(diffLock(lock, withNewRecipe).added).toEqual(['exfil'])`.
Реализация, которая обходит записи lock и сверяет хэши, добавленный рецепт не заметит —
утверждение читает `[]` и падает. Второе — `expect(diffLock(lock, defaultsWidened).changed).not.toHaveLength(0)`:
изменить только `defaults.env.allow`, не трогая рецепты; без `normalizeManifest` вернётся
пусто. Третье — `expect(normalizeRecipe(a)).not.toEqual(normalizeRecipe(b))` при разнице
только в `description` (класс CVE-2025-54136) и при разном порядке параметров.

**Verification:** `vitest run src/lock.test.ts`

**Commit:** `E0: lock уровня манифеста, дифф и снапшот`

### Task 10 — IPC, подтверждения, проекция в `Tool`, санитизация

**Files:** `packages/contracts/src/ipc.ts` (Create), `packages/contracts/src/approval.ts` (Create), `packages/contracts/src/tool.ts` (Create), `packages/contracts/src/tool.test.ts` (Create), `packages/contracts/src/approval.test.ts` (Create)

`IpcRequest = {recipeName: RecipeName; params: Readonly<Record<string, unknown>>; sessionId: SessionId}`
— форма, в которой argv, путь к бинарю, `cwd` и профиль невыразимы. Поле называется
`recipeName`, потому что в `normalizeRecipe`/`toTool` слово `recipe` означает объект.
Оба идентификатора брендируются (`type RecipeName = string & {readonly __brand: 'RecipeName'}`),
чтобы перестановка аргументов на границе доверия была ошибкой компиляции.

**Подтверждения** (R26): `ApprovalChannel = 'electron' | 'elicitation'`, `ApprovalDecision`,
`ApprovalScope = 'once' | 'until' | 'recipe_and_args'`, `expiresAt: string | null` —
**абсолютное** ISO-время, потому что относительный TTL в append-only записи нельзя оценить
при повторном чтении через год, — и `argsHash`, считаемый `canonicalizeJcs` от параметров.
Плюс `ApprovalRequest`/`ApprovalVerdict` с непрозрачным `requestId`: без него сообщение из
рендерера может одобрить не тот ожидающий вызов, который человеку показали. Это И8 и самая
дорогая граница доверия в продукте, и оставлять её на E7 после заморозки нельзя.

`toTool(recipe: Recipe)` — проекция ревизии `2025-11-25` с опциональными
`resultType`/`ttlMs`/`cacheScope`.

`sanitizeDescription(text: string): {text: string; removedRuns: number}` задаётся
**структурно, а не блоклистом**: лимит длины, вырезание C0/C1, ANSI-escape, zero-width и
bidi-override, схлопывание переводов строки. В контракте записывается, что результат
*уменьшен*, а не *безопасен*. Применяется ко **всем** недоверенным строкам, которые
эмитит `toTool`: описание рецепта, имена параметров (они становятся ключами
`inputSchema.properties`), описания параметров, значения `enum` и само имя рецепта.

**Falsification:** утверждение — `expect(toTool(poisoned).description).not.toContain('IGNORE PREVIOUS')`.
Пропустить `sanitizeDescription` → строка доезжает до вывода и падает. Второе —
`expect(toTool(poisonedParamName).inputSchema.properties).not.toHaveProperty('\u202e')`:
санитизация только описания оставляет line jumping через имя параметра. Третье —
`expect(approvalVerdictFor(otherRequestId)).toBe(null)`: убрать сверку `requestId` → вердикт
применяется к чужому вызову.

**Verification:** `vitest run src/tool.test.ts src/approval.test.ts`

**Commit:** `E0: IPC, контракт подтверждений, проекция tools/list, санитизация`

### Task 11 — четыре рецепта-заглушки

**Files:** `packages/contracts/recipes/mcpproxy.yaml` (Create), `packages/contracts/src/recipes.test.ts` (Create)

`run_tests`, `build_project`, `analyze_logs`, `publish_release`. Последний —
`destructiveHint: true`, `openWorldHint: true`, единственный `high` (нужен S8).

**Falsification:** утверждение — `expect(recipe.params.pattern.argv).toEqual(['--testPathPattern', '{}'])`.
Заменить на одну строку `"--testPathPattern={}"` → падает. Это инвариант И2, и без теста он
держится только на внимательности. Второе —
`expect(tiers).toEqual({run_tests: 'medium', build_project: 'medium', analyze_logs: 'low', publish_release: 'high'})`.

**Verification:** `vitest run src/recipes.test.ts` — все четыре грузятся через `parseManifest`
без диагностик.

**Commit:** `E0: четыре рецепта-заглушки`

### Task 12 — заморозка с исполняемой проверкой и правки доков

**Files:** `packages/contracts/src/index.ts` (Modify), `packages/contracts/src/api-surface.test.ts` (Create), `docs/04-research-findings.md` (Modify), `docs/07-contracts.md` (Modify), `docs/08-demo-scenarios.md` (Modify), `docs/10-honest-limitations.md` (Modify), `docs/adr/0003-otel-event-schema.md` (Modify), `docs/adr/0004-mcp-tool-annotations.md` (Modify)

Снять `TODO(E0)` (`packages/contracts/src/index.ts:6`). Заморозка получает исполняемую
проверку: снапшот публичной поверхности `.d.ts` всех трёх входов, падающий при любом
изменении, плюс записанное правило, когда двигается `CONTRACTS_VERSION`. Иначе R23 — это
удалённый комментарий и фраза в доке.

Правки доков: направление переезда OTel по **Ф9**; несуществующие `mcp.tool.name`,
`mcp.request.id`, `mcp.transport`; переехавшие URL спеки MCP; атрибуция «tool poisoning»
на Invariant Labs, а не на спеку; ReDoS в честных границах вместе с тем, что закрыто на
загрузке, а что — матчером; смягчение «fail-safe by construction» до границы R11 плюс
оговорка про `lockVerified`.

Отдельно — сверка набора рецептов: `WORK.md`, `docs/07-contracts.md:25-76` и
`docs/08-demo-scenarios.md:36` называют три разных набора. Приводятся к четырём из Task 11,
иначе слайд S1 противоречит поставленной фикстуре.

**Falsification:** утверждение — `expect(currentApiSurface()).toEqual(SNAPSHOT)`. Добавить
экспорт в любой из трёх входов → снапшот расходится и тест падает, то есть заморозка
перестаёт быть обещанием.

**Verification:** `yarn typecheck && yarn build && yarn test` из корня — зелено на всём
графе, включая `design`.

**Commit:** `E0: заморозка контракта и правки документации`

---

## Requirement diff

| R | Строка плана, которая его реализует |
|---|---|
| R1 | Task 3: «Схема 2020-12 с `$id`, `$defs`, `oneOf` из `$ref`…» |
| R2 | Task 3: «Ветки: `StringParam` (требует `pattern`)… `PathParam` (требует `root`)» |
| R3 | Task 3: `scripts/gen-types.mjs` + `src/manifest.generated.ts`, коммитится; Ф6 обосновывает маршрут |
| R4 | Task 4: «`parseManifest(yamlText: string, source: ManifestSource): ParseManifestResult`» |
| R5 | Task 6: пять пронумерованных правил, по кейсу на каждое |
| R6 | Task 6: «`branch-checks.ts` — экспортируемый `Record<BranchName, CheckId[]>`» + сверка множеств |
| R7 | Task 5: «Компиляция каждого `pattern` через `re2` на загрузке» |
| R8 | Task 4: «Три меры сверх дефолтов… документ с директивой `%YAML` отвергается целиком» |
| R9 | Task 2: «`ToolAnnotations = Partial<Record<AnnotationKey, boolean>>`» |
| R10 | Task 2: «`deriveRiskTier(annotations, lockVerified): RiskTier`» + таблица §7 |
| R11 | Task 2 Falsification (строка 3 §7) + §7 про `lockVerified` + Task 12 правка формулировки |
| R12 | Task 7: «`AuditEvent` — вложенный, ISO-время, строковые enum'ы» |
| R13 | Task 7: «`toOtlp` — `traceId`/`spanId` hex, числовой `kind`…» |
| R14 | Task 7 Falsification: «проверяется **отсутствие** любого ключа с `_`» |
| R15 | Task 8: «`self = sha256(utf8(canonicalizeJcs({ prev, event })))`» |
| R16 | Task 9: «`normalizeRecipe(recipe: Recipe): NormalizedRecipe`» + порядок параметров |
| R17 | Task 10: «`IpcRequest = {recipeName; params; sessionId}`» |
| R18 | Task 10: «проекция ревизии `2025-11-25` с опциональными `resultType`/`ttlMs`/`cacheScope`» |
| R19 | Task 10: «`sanitizeDescription` задаётся структурно, а не блоклистом» |
| R20 | Task 11: «`run_tests`, `build_project`, `analyze_logs`, `publish_release`» |
| R21 | Task 1 целиком |
| R22 | Task 12 Verification: «зелено на всём графе, включая `design`» |
| R23 | Task 12: «Снять `TODO(E0)`» + снапшот поверхности |
| R24 | Task 12: «направление переезда OTel по **Ф9**; несуществующие… переехавшие URL» |
| R25 | Task 12: «ReDoS в честных границах вместе с тем, что закрыто на загрузке, а что — матчером» |
| R26 | Task 10: «`ApprovalScope = 'once' \| 'until' \| 'recipe_and_args'`… `ApprovalRequest`/`ApprovalVerdict` с непрозрачным `requestId`» |
| R27 | Task 9: «`normalizeManifest(manifest)` и `manifestHash`» + `diffLock` с `added`/`removed`/`changed` |
| R28 | Task 9: «`LockEntry = {hash, approvedAt, snapshot: NormalizedRecipe}` — снапшот обязателен» |
| R29 | Task 5: «через границу пакета едет не голая строка… `PatternMatcher`» |
| R30 | Task 7: «`durationUs: number`, монотонная длительность стадии» |
| R31 | Task 12: «снапшот публичной поверхности `.d.ts` всех трёх входов» + `version: {const: 1}` в Task 3 |
| R32 | Task 3: «`propertyNames: {pattern: "^[a-z][a-z0-9_]{0,63}$"}` на `tools` и на `params`» |
