# E3 — executor и песочница

## Goal

Вторая линия обороны из `docs/03-threat-model.md:17-45`: валидатор контролирует, **что**
запускается, песочница — **что запущенное может сделать**. Реализовать `packages/core/src/exec`:
обёртку над `@anthropic-ai/sandbox-runtime`, доменный allowlist сети, ресурсные ограничители,
cap на вывод, поток violations в шину событий. Требования — `spec.md`, `R1..R56`.

## Architecture

Один модуль `packages/core/src/exec`. Слои — ровно те, что создают задачи, ни одного лишнего:

```
profile.ts      NormalizedSandbox → ResolvedSandboxPolicy   (чистая, R5-R11, R14, R36, R40)
violation.ts    строка лога → ParsedLine                    (чистая, R27-R28, R39)
netpolicy.ts    валидатор шаблонов + конформанс с srt        (чистая, R13)
env.ts          EnvPolicy → ProcessEnv                      (чистая, R23-R25)
limits.ts       spawn + таймаут + cap                       (I/O, R16-R21)
srt-manager.ts  синглтон srt: initialize · subscribe · семафор  (I/O, R21, R29, R37)
sandbox.ts      интерфейс Sandbox + createSandbox            (R1-R4)
modes/          none.ts · seatbelt.ts                        (R26, R31)
events.ts       события четырёх стадий + оверхед             (R32-R35, R38)
index.ts        реэкспорт наружу пакета
```

Четыре модуля — `profile.ts`, `violation.ts`, `netpolicy.ts`, `env.ts` — **чистые**: ни ФС, ни
процессов, ни сети.

`netpolicy.ts` — **валидатор**, а не матчер на пути принуждения. Матчит домены сам srt
(`matchesDomainPatternWithPort`), потому что по пересмотренному D11 принуждение делает
`updateConfig`. Второй матчер с другой семантикой был бы дырой, а не запасом, поэтому модуль
проверяет шаблоны манифеста и **сверяет своё понимание с вендорским** таблицей конформанса.
Резолв реального пути в `violation.ts` инжектируется параметром, а не зовётся из модуля
(иначе «чистая» было бы неправдой: `realpathSync.native` — синхронный сисколл, и он же оказался бы
на горячем пути каждой строки лога живого процесса).

`container.ts` отдельным файлом **не** заводим: по D7 это бросок в одну строку внутри
`createSandbox`, и файл под него — тот самый модуль, который никто не пишет.

`srt` виден только внутри `srt-manager.ts` и `modes/`. Наружу из пакета не торчит ни один его
тип (R1). `srt-manager.ts` существует отдельно от режимов потому, что синглтон **общий**: по D2
режим `none` тоже поднимает прокси, значит делит стор нарушений и семафор с `seatbelt`, и
положив жизненный цикл в `modes/seatbelt.ts`, мы оставили бы `none` ровно с той ошибкой
атрибуции, ради которой R21 и существует.

## Tech Stack

Node 22, TypeScript 5.6, vitest 3, `@anthropic-ai/sandbox-runtime@0.0.74`.
Новое в этой ветке: `@anthropic-ai/sandbox-runtime` в `packages/core/package.json:21` (уже
добавлено), vitest в `packages/core` (Task 1).

**Риск, который надо назвать вслух.** Режиму `none` нужны прокси-переменные и переменные доверия к
CA, а наружу из пакета отдаётся только `getDefaultWritePaths` (`dist/index.d.ts`, 19 строк). У
пакета **нет `exports`-карты**, поэтому `generateProxyEnvVars` и `CA_TRUST_VARS` доступны глубоким
импортом из `dist/sandbox/sandbox-utils.js`. Выбираем глубокий импорт, а не копию списка: у
research-preview с версией в день копия разъезжается молча, а импорт превращает обновление вендора
в ошибку типизации. Путь неподдерживаемый — это записано в границах.

## Global Constraints

Из `tsconfig.base.json`, дословно, потому что каждый пункт меняет форму кода:

- `tsconfig.base.json:9` `"strict": true`
- `tsconfig.base.json:10` `"noUncheckedIndexedAccess": true` — индексация массива даёт
  `T | undefined`. Парсер violations разбирает строку на части индексами, значит каждая часть
  требует проверки, а не `!`.
- `tsconfig.base.json:12` `"exactOptionalPropertyTypes": true` — **компилятор здесь исполняет
  R34**: `{ signal?: string }` не принимает `undefined` как значение. Отсутствие ключа и
  `null` перестают быть взаимозаменяемы на уровне типов, а не соглашения.
- `tsconfig.base.json:13` `"verbatimModuleSyntax": true` — только `import type` для типов.

ESLint в репозитории нет — `ls -a` не находит ни одного конфига. Стиль держат `.editorconfig`
и ревью.

---

## Pre-flight

### 1. Write path

| Поле | Producer | Преобразования | Теряет данные? |
|---|---|---|---|
| `effective.sandbox` | `packages/contracts/src/lock.ts:207` `normalizeRecipe` | `lock.ts:207` → `profile.ts` (Task 3) → `srt customConfig` | нет; `allow` замена по листу, `deny` объединение |
| `effective.timeoutMs` | `packages/contracts/src/lock.ts:207` | `lock.ts:42` `durationToMs` → `limits.ts` (Task 6) | нет; клампится потолком `lock.ts:35` |
| `effective.output.maxBytes` | `packages/contracts/src/lock.ts:207` | → `limits.ts` (Task 6) | **да, намеренно**: вывод обрывается на потолке (R19) |
| `effective.env.allow` | `packages/contracts/src/lock.ts:207` | → `env.ts` (Task 5) | да: пересечение с `defaults`, всё вне списка вырезается (R23) |
| `SandboxViolationEvent.line` | srt, вне репозитория | `violation.ts` (Task 4) → `SandboxViolation` | **да**: шумные операции отбрасываются (R39), неузнанные помечаются |

`effective`, никогда `own` — пол и потолок применены именно в `effective`
(`packages/contracts/src/lock.ts:239-244`).

### 2. Consumers

Символ, который план меняет, ровно один: содержимое `packages/core/src/index.ts:2`.

Команда: `grep -rn "mcpproxy/core" packages/*/package.json packages/*/src`

Полный список попаданий, без фильтра:

```
packages/core/package.json:2:  "name": "@mcpproxy/core",
packages/mcp-server/package.json:22:    "@mcpproxy/core": "workspace:*"
packages/bench/package.json:22:    "@mcpproxy/core": "workspace:*"
```

| Символ | Читатель | Что делает со значением | Тест мокает? |
|---|---|---|---|
| `packages/core/src/index.ts:2` `export {}` | `packages/mcp-server/package.json:22` | объявляет зависимость; `packages/mcp-server/src/index.ts` — заглушка E4, ни одного импорта | нет теста вообще |
| `packages/core/src/index.ts:2` `export {}` | `packages/bench/package.json:22` | то же; `packages/bench/src/index.ts` — заглушка E8 | нет теста вообще |

**Код-потребителей ноль.** Обе зависимости объявлены авансом под E4 и E8, чьи `src/index.ts` —
заглушки. Значит расширение экспорта `core` не может сломать существующего читателя, и
единственный риск — конфликт по файлу с параллельной веткой E2 (см. §5).

### 3. Infrastructure

| Пакет | Тест-команда | `setupFiles` | env из setup | сборка | строгость tsconfig | ESLint |
|---|---|---|---|---|---|---|
| `packages/core` | **нет вообще** — в `packages/core/package.json:16-18` три скрипта: `build`, `typecheck`, `clean` | нет | нет | `tsc -b` | наследует `tsconfig.base.json` целиком | конфига нет |
| `packages/contracts` | `packages/contracts/package.json:28` `"test": "tsc -b && vitest run"` | нет | нет | `tsc -b` перед vitest | то же | конфига нет |

`packages/core` **не имеет тест-раннера**, и корневой `yarn test`
(`package.json:15` `yarn workspaces foreach -Ap run test`) для него выходит с нулём, не запустив
ничего. Это ровно то состояние, ради которого в contracts есть страховка
`packages/contracts/src/domain.test.ts:47-66`. Task 1 заводит раннер и ту же страховку.

Существующий тестовый файл, на который план опирается как на образец:

| Файл | Слой | Цитата |
|---|---|---|
| `packages/contracts/src/domain.test.ts` | прямое инстанцирование, без сети и ФС | `packages/contracts/src/domain.test.ts:62` — `it('не имеет тестов за пределами `src/`, куда не смотрит include', () => {` |

Конфиг раннера, который Task 1 копирует по форме:
`packages/contracts/vitest.config.ts:7-10` — `environment: 'node'`, `include: ['src/**/*.test.ts']`.

### 4. Runtime shape

| Значение | Загрузчик | Тип возврата | Спред допустим? |
|---|---|---|---|
| `NormalizedRecipe` | `packages/contracts/src/lock.ts:207` | plain object, литерал в `return` | да |
| `effective.sandbox.read` | `packages/contracts/src/lock.ts:60` `NormalizedSandbox` | plain object, поля `readonly string[]` | да, но **не присваивается** в `AccessRule` — см. ниже |
| `process.env` | Node | plain object | да |
| `env` из `wrapWithSandboxArgv` | srt | **тождественно равен `process.env`** — проба П1 | **нет**: мутировать нельзя, это глобальный объект процесса |

Ловушка типов, из-за которой R36 существует: `NormalizedSandbox`
(`packages/contracts/src/lock.ts:60`) имеет обязательные `readonly string[]`, а
`SandboxProfile` (`packages/contracts/src/manifest.generated.ts:56`) — необязательные изменяемые
`string[]`. Присвоить первый во второй нельзя ни в одну сторону; событие несёт **сырой**
`SandboxProfile`, поэтому в Task 9 нужна явная конверсия, а не приведение.

### 5. Premises

| Посылка | Команда | Цитата | Где держится | Решение |
|---|---|---|---|---|
| `deny` бьёт `allow` для записи, `allow` бьёт `deny` для чтения | чтение `docs/02-architecture.md` | `docs/02-architecture.md:145` — `| Чтение | разрешено | `allowRead` бьёт `denyRead` — вырезаем читаемые островки внутри запрещённых зон |` | весь `profile.ts` | R7 фиксирует следствие явно: `read.allow` не ограничивает чтение |
| Стадии E3 — четыре | `grep -n "export type Stage" -A 16 packages/contracts/src/domain.ts` | `packages/contracts/src/domain.ts:12` — `export type Stage =` | `build_env`, `build_profile`, `spawn`, `violation` | Task 9 пишет событие на каждой |
| `spawn` и `violation` вне бюджета оверхеда | чтение | `packages/contracts/src/event.ts:149` — `export const OVERHEAD_EXCLUDED_STAGES: readonly Stage[] = ['spawn', 'violation', 'approval', 'complete'] as const;` | Task 9 | измеряется только `build_env` + `build_profile` |
| Потолок длительности — платформенный | чтение | `packages/contracts/src/lock.ts:35` — `export const DURATION_MAX_MS = 2_147_483_647;` | Task 6 | таймер ставится без своей проверки: значение уже проверено на загрузке |
| Потолок вывода по умолчанию | чтение | `packages/contracts/src/lock.ts:20` — `export const OUTPUT_MAX_BYTES_DEFAULT = 65_536;` | Task 6 | своей константы не заводим |
| Ветка E2 идёт параллельно и тронет тот же `index.ts` | `git worktree list` | воркtree `mcpproxy-e2-validate` на `v2/e2-validate`, HEAD `e40b7de` = `main`, дерево чистое | `packages/core/src/index.ts` | **единственная точка конфликта.** E3 добавляет одну строку `export * from './exec/index.js';`; правило волны 1 (`docs/06-epics.md:64`) нарушается формально, конфликт разрешается одной строкой при мерже |

| Посылка | Команда | Цитата | Где держится | Решение |
|---|---|---|---|---|
| `customConfig.network` не действует | проба П5, `probes/p5-percall-net.mjs` | `customConfig.network.allowedDomains = []             exit=0 blocked=false` | вся сетевая политика | D11: принуждение переехало в `updateConfig` под семафором |
| `enableLogMonitor` по умолчанию `false` | проба П6b, `probes/p6b-nologmonitor.mjs` | `БЕЗ enableLogMonitor: чтение отказано=true …, нарушений в сторе=0` | Task 7 | третий аргумент `initialize` обязателен и обязан быть `true` (R37) |
| `filterRequest` знает, чей вызов — **только на plain HTTP** | пробы П7 и П8 | П7: `"proxy-authorization":"Basic c3J0LlNVNVdUME5CVkVsUFRpMUJRVUU9…"`; П8 на HTTPS: `"hasProxyAuth":false` | Task 7 | атрибуция в колбэке негодна; её даёт семафор 1, а не заголовок |
| `NO_PROXY` зашит и включает loopback | проба П1, вывод `argv[2]` | `NO_PROXY=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` | R42, корпус E8 | тесты и корпус ходят на **имя**, не на адрес |

Перечисление к категорическому «четыре стадии»: `build_env`, `build_profile`, `spawn`,
`violation` — и ни одной больше; `redact` принадлежит E6 по решению D4, `complete` пишет тот,
кто закрывает вызов (E4).

### 6. Ordered parameter — таймаут

| Значение | Выход | Ветка |
|---|---|---|
| `timeoutMs − 1` мс после старта | процесс жив, вывод копится | нормальная |
| `timeoutMs` | SIGTERM группе, `verdict: 'denied'` начат | таймаут |
| `timeoutMs + grace` | SIGKILL группе, `exit: {code: null, signal: 'SIGKILL'}` | эскалация |

Монотонно: чем больше прошло времени, тем жёстче ветка, откатов нет.

Второй упорядоченный параметр — байты вывода:

| Значение | Выход | Ветка |
|---|---|---|
| `maxBytes − 1` | всё доехало, `truncated: false` | нормальная |
| `maxBytes` | всё доехало, `truncated: false` | граница включительно |
| `maxBytes + 1` | обрыв на `maxBytes`, `truncated: true` | обрезка |

Монотонно. Граница включительна намеренно: `maxBytes` — «потолок», а не «строго меньше».

### 7. Classifier outputs — `violation.ts`

Вход — реальные строки из проб, не выдуманные.

| Вход | Возврат | Ветка | Что выживает |
|---|---|---|---|
| `cat(10515) deny(1) file-read-data /private/.../secret.txt` | `{type:'file-read', target:'/private/.../secret.txt', action:'denied', bytes:0}` | ядро, известная операция | 1 |
| `bash(12042) deny(1) file-write-data /private/.../p3b/.git/hooks/pre-commit` | `{type:'mandatory-deny', …}` | ядро, цель в нашем списке | 1 |
| `bash(11433) deny(1) file-write-data /Users/…/ordinary.txt` | `{type:'file-write', …}` | ядро, цель вне списка | 1 |
| `deny network-outbound evil.invalid:80 (host is not on the allow list)` | `{type:'network', target:'evil.invalid:80', action:'denied', bytes:0}` | прокси | 1 |
| `cat(10515) deny(1) sysctl-read kern.iossupportversion` | `null` | шум | 0 |
| `curl(11052) deny(1) mach-lookup com.apple.SystemConfiguration.configd` | `null` | шум | 0 |
| строка неизвестной формы | `{type:'process', target:<строка>, action:'denied', bytes:0}` + флаг «неразобрано» | запасная | 1 |

На трёх строках вывода `cat` из пробы П1 выживает **одна**. Именно это число утверждает тест.

### 8. Verified facts

Семь проб прогнаны на этой машине, сырой вывод — в `probes.md`, исходники — `probes/p*.mjs`.
Первые четыре сняли неизвестность до плана; последние три проверили находки ревью первого круга —
и **две из трёх подтвердили, одну опровергли**. Ниже только вывод и то, чего проба не покрывает.

**Ф1 — форма argv и грамматика ядра.** П1: `argv[0] = /bin/bash`, `argv.length = 3`, строка
`cat(10515) deny(1) file-read-data /private/var/.../secret.txt`.
Не покрывает: только macOS; Linux-грамматика seccomp в срез не входит.

**Ф2 — `filterRequest` только для разрешённых.** П2: колбэк увидел единственную запись
`{method:'GET', url:'http://example.com/', bodyBytes:0}`, тогда как `evil.invalid` исполнялся и
был заблокирован. Отсюда D11: если принуждение наше, колбэк видит **всё**, и это уже не
ограничение, а механизм.

**Ф3 — грамматика прокси другая.** П2: `deny network-outbound evil.invalid:80 (host is not on the allow list)`.

**Ф4 — mandatory deny якорится на cwd демона.** П3 против П3b: при cwd демона вне каталога цели
запись в `.git/hooks/pre-commit` прошла с `exit=0`; при `process.chdir(dir)` до `initialize` та же
запись дала `exit=1`. Не покрывает: случай совпадения каталогов маскирует дефект, тест обязан их
развести.

**Ф5 — убийство по pid оставляет потомков.** П4: `выживших sleep после kill(pid): 3` против
`выживших sleep после kill(-pgid): 0`. Не покрывает: процесс, сам меняющий группу (`setsid`).

**Ф6 — заблокированный HTTP не роняет команду.** П2: `exit=0`, тело
`Connection blocked by network allowlist`.

**Ф7 — `env` из srt тождествен `process.env`.** П1: `env identical to process.env? true`.

**Ф8 — `customConfig.network` не действует вовсе.** П5, три строки подряд:
`customConfig.network.allowedDomains = []             exit=0 blocked=false` и
`customConfig.network.deniedDomains = [example.com]   exit=0 blocked=false`.
Это основание пересмотра сетевой архитектуры.

**Ф9 — лаг violations равен нулю.** П6a: `выход 21 мс, найдено 21 мс, лаг после выхода 0 мс`.
Ревью первого круга утверждало секунды и требовало снять R29 — **опровергнуто**. Не покрывает:
одна ненагруженная машина; путь через unified log асинхронен по природе, поэтому R46 всё же
требует drain-окна как страховки, а не как признания задержки.

**Ф10 — без `enableLogMonitor` наблюдаемость мертва.** П6b:
`чтение отказано=true …, нарушений в сторе=0`. Граница цела, поток нарушений пуст.

**Ф11 — `filterRequest` может атрибутировать вызов.** П7: заголовок `proxy-authorization` несёт
`Basic base64("srt.<base64(commandId)>:<token>")`, и декодирование дало ровно переданный
`INVOCATION-AAA`. Не покрывает: SOCKS-путь до колбэка не доходит; HTTPS — только при `tlsTerminate`
(D12).

**Ф12 — атрибуция на TLS-терминированном пути невозможна.** П8: на HTTPS
`"hasProxyAuth":false`, заголовков всего три. Клиент шлёт `Proxy-Authorization` на `CONNECT`, а не
внутрь туннеля. Первая редакция D11 — принуждение per-recipe политики в `filterRequest` — на этом
ломается для единственного протокола, который нужен S5.

**Ф13 — `updateConfig` принуждает HTTPS и атрибутирует.** П9:
`allow=[example.com] → 200`, `allow=[example.org] → exit=56`, `allow=[] → exit=56`, и нарушения
приезжают с `encodedCommand` = `Yg==`/`Yw==`, то есть с правильным `commandId`. Отсюда
пересмотренный D11: принуждает `updateConfig` под семафором 1, `filterRequest` остаётся
телеметрией. Не покрывает: нога с сырым TCP (`nc`) неинформативна — `nc` не ходит через
прокси-переменные, и его код возврата не доказывает соединение.

**`ASSUMED`** — три, и все помечены для ревьюера:
- поведение SOCKS-пути под `updateConfig` пробой не закрыто (нога `nc` в П9 неинформативна);
- накладные расходы `build_env` + `build_profile` укладываются в бюджет ≤50 мс p95. Не измерялось;
  Task 9 добавляет измерение серией, а не одним замером;
- байты тела для HTTPS под `tlsTerminate`: П8 показала, что запрос до колбэка **доходит**, но
  величину `bodyBytes` для HTTPS не мерили. Task 7 начинается с пробы на это.

Почему не пишем свои SBPL, хотя зрелая экосистема так делает: Chrome и Firefox ведут собственные
seatbelt-профили годами силами отдельной команды. ADR-0002:12-14 это взвесил и выбрал `srt`; пробы
Ф4 и Ф8 показали цену — за чужой библиотекой приходится доделывать и привязку к каталогу, и
принуждение сети.

---

## Tasks

### Task 1 — тест-раннер для `core`, которого нет

**Files:** `packages/core/package.json` (Modify), `packages/core/vitest.config.ts` (Create),
`packages/core/src/exec/runner.test.ts` (Create)

Шаги: скрипт `"test": "tsc -b && vitest run"` по образцу
`packages/contracts/package.json:28`; `vitest` в devDependencies пакета; конфиг с
`environment: 'node'` и `include: ['src/**/*.test.ts']` по образцу
`packages/contracts/vitest.config.ts:7-10`; страховка от возврата в нынешнее состояние —
копия формы `packages/contracts/src/domain.test.ts:47-66`, то есть «обнаружен хотя бы один
тестовый файл» и «нет тестов за пределами `src/`».

**Falsification:** страховка сторожит **раннер**, а не `include`, и мутация обязана быть той же
природы. Утверждение — `expect(testFiles.length).toBeGreaterThan(0)`, где `testFiles` берётся
`readdirSync` с диска, независимо от того, что нашёл vitest. Мутация: убрать скрипт `test` из
`packages/core/package.json` → корневой `yarn test` для пакета выходит с нулём, не запустив
ничего, и ни одно утверждение не исполняется — именно это состояние страховка и ловит, потому что
на следующем прогоне файл найден не будет. Второе утверждение —
`expect(outside).toEqual([])`: положить тест в каталог пакета за пределами `src/` → файл есть на
диске, но `include: ['src/**/*.test.ts']` его не видит, краснеет.
Рантайм: node, без DOM и без таймзонной зависимости.

**Verification:** `yarn workspace @mcpproxy/core test`, затем `yarn test` из корня — второй
обязан перестать быть тихим.

**Commit:** `E3: тест-раннер для core`

### Task 2 — интерфейс `Sandbox` и выбор режима

**Files:** `packages/core/src/exec/sandbox.ts` (Create),
`packages/core/src/exec/sandbox.test.ts` (Create)

Идентичности — брендированные, а не голые строки. `RecipeName` берём из контрактов
(`packages/contracts/src/ipc.ts:45` `asRecipeName`), это уже идиома пакета; `CommandId` заводим
свой той же формы. Без этого `run({recipeName: id, commandId: name, …})` проходит проверку типов
— а R30 существует ровно потому, что идентичность вызова путают.

```ts
export type CommandId = string & { readonly __brand: 'CommandId' };

export interface ExecRequest {
  readonly recipeName: RecipeName;
  readonly command: readonly [string, ...string[]];
  /** Каталог РЕЦЕПТА, не демона. Различие несущее: см. Ф4. Здесь — авторитетное значение. */
  readonly recipeCwd: string;
  readonly effective: NormalizedDefaults;
  readonly commandId: CommandId;
}

export type Termination = 'exited' | 'timeout' | 'output-cap';

export interface StreamOutcome {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface ExecOutcome {
  readonly termination: Termination;
  readonly exit: { readonly code: number | null; readonly signal: string | null };
  readonly stdout: StreamOutcome;
  readonly stderr: StreamOutcome;
  /** Полный набор, включая каждое уже отданное в `onViolation` — если `violationsLost` ложно. */
  readonly violations: readonly SandboxViolation[];
  /** Сколько нарушений вытеснило кольцо стора. Ненуль означает, что `violations` неполны (R45). */
  readonly violationsLost: number;
  /** Хэш JCS применённой политики — материал для сверки согласия в E5 (R47). */
  readonly policyHash: string;
}

export interface Sandbox {
  readonly mode: SandboxMode;
  run(request: ExecRequest, onViolation: (violation: SandboxViolation) => void): Promise<ExecOutcome>;
  dispose(): Promise<void>;
}

export function createSandbox(mode: SandboxMode): Sandbox;
```

Почему `termination` отдельным полем, а не выводом из `signal`: R18 требует, чтобы таймаут дал
`verdict: 'denied'`, и D6 обосновывает это как решение политики. Единственная улика в
`exit` — `signal === 'SIGKILL'`, неотличимый от убийства чем угодно ещё на машине. Без
дискриминатора E4 выводил бы политику из артефакта ОС.

Почему учёт байт по потокам, а не общим числом: R19 режет **байты**, а `stdout: string` меряется
в единицах UTF-16. Для не-ASCII вывода числа разойдутся, а обрезка ровно на `maxBytes` способна
разрубить многобайтовую последовательность. Единое поле `bytes` вдобавок не говорило бы, чей
это счёт — stdout, stderr или сумма.

`dispose()` — потому что `createSandbox` теперь владеет прокси, подпиской и синглтоном на
время жизни демона; без явного шва каждый тест их течёт.

`createSandbox(mode: SandboxMode): Sandbox` — `container` бросает (R3, D7), `seatbelt` на
не-macOS бросает (R2).

**Falsification:** утверждение — `expect(() => createSandbox('container')).toThrow(/container/)`.
Заменить бросок на `return createSandbox('seatbelt')` → тихий откат, утверждение краснеет.
Тест на изоляцию `srt` (R1) живёт **в Task 9**, а не здесь: он обходит граф `.d.ts` от публичного
входа, а публичный вход до Task 9 — это `export {}` (`packages/core/src/index.ts:2`), то есть здесь
он был бы красным по причине, не имеющей отношения к R1.

**Verification:** `vitest run src/exec/sandbox.test.ts`

**Commit:** `E3: интерфейс Sandbox, брендированные идентичности, выбор режима`

### Task 3 — политика: профиль ФС, доменный матчер, mandatory deny

**Files:** `packages/core/src/exec/profile.ts` (Create),
`packages/core/src/exec/profile.test.ts` (Create),
`packages/core/src/exec/netpolicy.ts` (Create),
`packages/core/src/exec/netpolicy.test.ts` (Create)

`buildProfile(sandbox: NormalizedSandbox, writeRoots: readonly string[], recipeCwd: string): ResolvedSandboxPolicy`
— чистая. Вход — **лист**, а не агрегат: R5 и §1 требуют `effective`, никогда `own`, и передача
целого `NormalizedRecipe` оставила бы это правилом ревью вместо ошибки компиляции.

```ts
export interface ResolvedSandboxPolicy {
  readonly read: { readonly allow: readonly string[]; readonly deny: readonly string[] };
  readonly write: { readonly allow: readonly string[]; readonly deny: readonly string[] };
  readonly weakened: boolean;
}
```

Поля доменные — `read`/`write` с `allow`/`deny`, — а не словарь вендора. Отображение в
`filesystem.denyRead` / `allowRead` / `allowWrite` / `denyWrite` (R6, это **пользовательские**
имена конфига srt, не внутренние `allowedHosts`) делает `modes/seatbelt.ts`, и там же стоит
единственное тайп-левел утверждение против настоящего `SandboxRuntimeConfig` — тогда дрейф формы
вендора краснеет в одном месте.

Сети в `ResolvedSandboxPolicy` **нет**: по пересмотренному D11 её принуждает `updateConfig`
(Task 7), а `netpolicy.ts` — валидатор шаблонов манифеста плюс таблица конформанса с матчером
вендора:

```ts
export function isValidDomainPattern(pattern: string): boolean;         // R13
export function isWeakened(allow: readonly string[]): boolean;          // R14
```

Конформанс закрепляет три известных расхождения, а не предполагает совпадение: `*.example.com`
матчит **строго поддомены** и не матчит apex; шаблон может нести `:port`; `deniedDomains`
проверяется раньше `allowedDomains`. Своего матчера на пути принуждения нет — второй матчер с
другой семантикой это дыра, а не запас.

Шаги `profile.ts`: маппинг узлов R6; резолв `~` в `os.homedir()` и относительных путей от
`recipeCwd` (R8); mandatory-deny **глобами на поддерево, якорёнными на каждом корне `write.allow`**
(R9) — `<корень>/**/.git/hooks`, `<корень>/**/.zshrc`, …, включая `<корень>/**/.git/config`;
флаг `weakened` из `*` в `network.allow` (R14); конверсия `NormalizedSandbox` → `SandboxProfile`
для события (R36); `policyHash(policy, net)` — хэш JCS применённой политики **вместе с доменными списками**, который
уезжает в `ExecOutcome`, а не в `AuditEvent`: слота под него в замороженном событии нет (R47).
Без сетевой части два вызова с `network.allow: []` и `['*']` дали бы один хэш, и материал для
сверки согласия оказался бы бесполезен там, где решение человека важнее всего.

**Не** утверждаем, что `ResolvedSandboxPolicy` едет в модалку E5: `ApprovalRequest.profile`
заморожен как сырой `SandboxProfile`, и провезти туда резолвнутую политику нельзя без правки
contracts. E5 получает хэш и может сверить.

**Falsification:** утверждение — `expect(buildProfile(s, ['/tmp/x'], '/other').write.deny).toContain('/tmp/x/**/.git/hooks')`.
Якорить на `recipeCwd` вместо корней `write.allow` → при несовпадении каталогов список пуст,
краснеет; брать литерал вместо глоба → `sub/.git/hooks` остаётся записываемым, и второе
утверждение `expect(...).toContain('/tmp/x/**/.git/config')` ловит пропуск `.git/config`.
Второе — `expect(buildProfile(s, roots, cwd).read.deny).toContain(homedir() + '/.ssh')` при входе
`~/.ssh`: убрать разворачивание тильды → остаётся литерал, краснеет.
Эти два — про **состав списка**. Что srt его действительно исполняет, проверяет интеграционный
тест R10 в Task 7: проверка «строка лежит в массиве» зелёная и тогда, когда вендор наш `denyWrite`
игнорирует, а глоб с несуществующим префиксом молча не матчит ничего.
Третье, в `netpolicy.test.ts` — таблица конформанса, и порядок аргументов у вендора именно
`matchesDomainPattern(hostname, pattern)`, а не наоборот: перепутав их, утверждение проваливается
в ветку точного сравнения и всегда даёт `false`, то есть не проверяет ничего.
`expect(matchesDomainPattern('github.com', '*.github.com')).toBe(false)` — апекс звёздочкой не
покрыт — против `expect(matchesDomainPattern('api.github.com', '*.github.com')).toBe(true)`.
Плюс строка про порт: `expect(matchesDomainPatternWithPort('api.github.com', 443, 'api.github.com:8443')).toBe(false)`.
Плюс строка про приоритет: хост, лежащий и в `deny`, и в `allow`, отказан.
R13 называет три расхождения, и все три обязаны быть написаны, а не одно.
Четвёртое, покрытие R14 — `expect(isWeakened(['*'])).toBe(true)` против
`expect(isWeakened(['*.github.com'])).toBe(false)`: пометить звёздочкой **любое** правило →
бейдж носят `*.github.com` и `*.npmjs.org`, то есть обычные рабочие рецепты, и на слайде S5 он
перестаёт что-либо значить.
Пятое, покрытие R7 — `expect(buildProfile(analyzeLogs, roots, cwd).read.deny).toContain(homedir() + '/.ssh')`
при рецепте с `read.allow: ['./logs']`: замена `allow` **не** сужает чтение, и тест закрепляет
фактическое поведение против того, как манифест читается.
Рантайм: node; `homedir()` читается, файлы не трогаются.

**Verification:** `vitest run src/exec/profile.test.ts src/exec/netpolicy.test.ts`

**Commit:** `E3: политика ФС и доменный матчер`

### Task 4 — парсер violations: грамматика отдельно от политики

**Files:** `packages/core/src/exec/violation.ts` (Create),
`packages/core/src/exec/violation.test.ts` (Create)

Две функции, а не одна. У прежней единой было четыре причины меняться — грамматика лога,
список шума, семантика путей, бейдж S6, — и тест любой из них строил бы вход, удовлетворяющий
всем четырём.

```ts
export interface RawViolationRecord {
  readonly source: 'kernel' | 'proxy';
  readonly operation: string;
  readonly target: string;
}

export type ParsedLine =
  | { readonly kind: 'violation'; readonly violation: SandboxViolation }
  | { readonly kind: 'suppressed'; readonly operation: string }
  | { readonly kind: 'unrecognized'; readonly line: string };

export function parseLine(line: string): RawViolationRecord | null;   // три грамматики, R27
export function classify(
  record: RawViolationRecord,
  policy: { readonly mandatoryPaths: readonly string[]; readonly resolvePath: (path: string) => string },
): ParsedLine;
```

`ParsedLine` — размеченное объединение, потому что `SandboxViolation` заморожен на четырёх полях
(`packages/contracts/src/event.ts:116`) и слота под «неразобрано» не имеет. Складывать
неузнанные строки в `type: 'process'` нельзя: это **настоящий** член `ViolationType`, означающий
нарушение процесса, и, разделив с ним тег, ни то ни другое больше не посчитать и не отфильтровать
— то есть R27 («явный „неразобрано“, а не молча роняет») был бы побеждён классификацией.
`null` при этом перестаёт значить две разные вещи разом: «шум, отброшен намеренно» — это
`kind: 'suppressed'`.

`resolvePath` **инжектируется** (R40): `realpathSync.native` — синхронный сисколл, и модуль,
зовущий его сам, не чист, а его тест требует настоящих путей на диске вместо стаба.

**Три** грамматики (R27, факты Ф1 и Ф3): ядро, транспортный отказ прокси и
`deny http-request <method> <url> (<reason>)`.

Третья при нашем дизайне возникает **только** на некорректном URL: её пишет `onFilterRequestDenied`,
который срабатывает, когда колбэк отказал или бросил, а наш колбэк всегда разрешает (R26).
Дедупликации **нет** и быть не должно: дедуплицировать нечего, а правило «commandId плюс хост плюс
близость по времени» было бы вредным — под семафором `commandId` постоянен на весь вызов, и цикл,
стучащийся на один хост пятьдесят раз, схлопнулся бы в одно событие, занизив ровно ту цифру,
которую показывает S5.

Список подавляемых операций именованной константой (R39), классификация в `mandatory-deny` против
`file-write` (R28). Таблица §7 разделяется по шву: строки грамматики проверяют `parseLine`,
счётчик «выживает одна» — `classify`.

**Falsification:** утверждение — `expect(lines.map(parseLine).filter(Boolean).map((r) => classify(r, policy)).filter((p) => p.kind === 'violation')).toHaveLength(1)` на трёх строках из П1.
Убрать список подавляемых операций → выживают три, утверждение краснеет. Второе —
`expect(classify(hooksRecord, policy)).toMatchObject({kind: 'violation', violation: {type: 'mandatory-deny'}})`;
убрать сверку со списком → `file-write`, краснеет, и вместе с ним разваливается бейдж S6.
Третье — `expect(classify(rec, {mandatoryPaths: ['/private/tmp/x/**/.git/hooks'], resolvePath: () => { throw new Error('нет пути'); }}).kind).toBe('violation')`.
`mandatoryPaths` здесь **непустой** намеренно: с пустым списком любая реализация закоротит до
вызова резолвера, и ветка его падения не исполнится.

Фикстура несёт **глоб и вложенную цель**, а не литерал: после R9 наши пути — глобы, цель из лога
ядра приходит реальным путём, и srt резолвит статический префикс шаблона тоже. Реализация через
`mandatoryPaths.includes(target)` зеленеет на литеральной фикстуре и вырождается в `file-write` в
продакшене — бейдж S6 умирает молча. Шестое утверждение это и ловит:
`expect(classify({source: 'kernel', operation: 'file-write-data', target: '/private/tmp/x/sub/.git/hooks/pre-commit'}, {mandatoryPaths: ['/tmp/x/**/.git/hooks'], resolvePath: realpathStub}).violation.type).toBe('mandatory-deny')`,
где `realpathStub` моделирует `/tmp` → `/private/tmp` на обеих сторонах.
Четвёртое — `expect(parseLine('deny http-request GET https://h/p (bad url)')).toMatchObject({source: 'proxy'})`:
третья грамматика разбирается, а не уезжает в «неразобрано».
Пятое — `expect(fifty.map(parseLine).filter(Boolean)).toHaveLength(50)` на пятидесяти отказах к
одному хосту: схлопнуть повторы → краснеет, и вместе с ним занижается цифра S5.

**Verification:** `vitest run src/exec/violation.test.ts`

**Commit:** `E3: грамматика нарушений отдельно от политики классификации`

### Task 5 — сборка окружения

**Files:** `packages/core/src/exec/env.ts` (Create), `packages/core/src/exec/env.test.ts` (Create)

`buildEnv(allow: readonly string[], base: NodeJS.ProcessEnv, injected: NodeJS.ProcessEnv): NodeJS.ProcessEnv` — чистая,
`base` не мутируется (факт Ф7: srt отдаёт `process.env` тождественно, мутация испортила бы
процесс демона).

Только имена из `allow` **плюс минимальный `PATH` именованной константой** (R23), плюс `injected`.

Третий параметр существует потому, что два режима устроены по-разному, и без него Task 5 и Task 8
противоречили бы друг другу: в `seatbelt` прокси-переменные вшиты в строку команды (факт Ф7),
значит `injected` пуст; в `none` seatbelt-обёртки нет вовсе, и переменные обязан передать режим
(D2, R31). Слот держит фильтр честным в обоих случаях — `injected` проходит мимо `allow`
намеренно, и это записано здесь, а не выводится читателем.

**Falsification:** утверждение — `expect(buildEnv(['PATH'], {PATH: '/usr/bin', SECRET: 'x'}, {})).toEqual({PATH: MINIMAL_PATH})`.
У R23 две половины, и фикстура обязана разводить их, иначе вторая уезжает непроверенной.
Первое:
заменить фильтр на `{...base, ...picked}` → `SECRET` доезжает, краснеет. Второе, изолирующее
инъекцию — `expect(buildEnv([], {}, {}).PATH).toBe(MINIMAL_PATH)`: убрать инъекцию → `PATH`
отсутствует, ребёнок не резолвит `exec[0]`, краснеет. Третье, самое важное по последствиям —
`expect(buildEnv([], {PATH: '/attacker/bin'}, {}).PATH).toBe(MINIMAL_PATH)`: вернуть унаследованный
`PATH` вместо константы → рецепт с `allow: []` молча получает путь поиска демона, краснеет.
Четвёртое — `expect(base).toEqual(snapshot)` после вызова: мутация `base` краснеет.

**Verification:** `vitest run src/exec/env.test.ts`

**Commit:** `E3: сборка окружения по allowlist`

### Task 6 — запуск, таймаут по группе, cap с hold-back

**Files:** `packages/core/src/exec/limits.ts` (Create),
`packages/core/src/exec/limits.test.ts` (Create)

```ts
export interface ProcessLimits {
  readonly timeoutMs: number;
  readonly graceMs: number;
  readonly maxBytes: number | null;
  /** Запас сверх потолка, чтобы E6 увидел секрет на границе целиком (D13, R19). */
  readonly holdBackBytes: number;
  /** Шов с E6, объявленный сейчас (R20). По умолчанию тождественный, пока E6 нет. */
  readonly redact?: (window: Buffer) => Buffer;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export function runProcess(
  command: readonly [string, ...string[]],
  limits: ProcessLimits,
): Promise<RawRun>;

export interface RawStream { readonly buffer: Buffer; readonly producedBytes: number; readonly truncated: boolean }
export interface RawRun {
  readonly termination: Termination;
  readonly exit: { readonly code: number | null; readonly signal: string | null };
  readonly stdout: RawStream;
  readonly stderr: RawStream;
}
```

Кортеж, а не массив: под `noUncheckedIndexedAccess` (`tsconfig.base.json:10`) `argv[0]` — это
`string | undefined`, и `spawn(argv[0], …)` потребовал бы `!` ровно в security-значимой точке.
Непустой кортеж — уже идиома репозитория: `packages/contracts/src/manifest.generated.ts:75`
объявляет `exec: [string, ...string[]]`.

`spawn(command[0], command.slice(1), { shell: false, detached: true })`, таймаут SIGTERM → grace →
SIGKILL по `process.kill(-pid)` (R16, факт Ф5), grace именованной константой (R17).

**Чтение не прекращается на потолке и процесс не убивается.** Останов чтения при живом процессе
заполняет pipe-буфер и блокирует ребёнка до таймаута — то есть ветка «превысил вывод» тихо
превратилась бы в ветку «таймаут», а таблица §6 обещает монотонность. Убийство же превратило бы
многословную, но безобидную команду в отказ и сдвинуло бы Utility under Attack (R49). Поэтому:
читаем и **считаем** всё, храним только `maxBytes + holdBackBytes`, выставляем
`termination: 'output-cap'` и сливаем остаток в никуда до **штатного** выхода.
`maxBytes === null` — без потолка (D8).

Счёт ведётся по **байтам** буфера до декодирования, отдельно на поток; `text` декодируется из
буфера после того, как E6 отредактировал его и мы обрезали до `maxBytes` (R20). Обрезка на границе
многобайтовой последовательности даёт U+FFFD в последнем символе — признанное поведение, и его
закрепляет тест.

`exit.signal` при штатной смерти от SIGTERM в grace-окне — `'SIGTERM'`, а не `'SIGKILL'`. Это
частый путь, и R18 говорит про исход политики, а не про конкретный сигнал; различает их
`termination`, а не строка сигнала.

**Приоритет исходов задан:** сработали и потолок, и таймаут → `termination: 'timeout'` (R49).
Без правила поле одно, а исходов два, и вердикт зависел бы от порядка проверок.

**Группа убивается на каждом пути выхода**, а не только по таймауту (R52), и пустота группы
подтверждается — иначе фоновый потомок переживает вызов и попадает под политику следующего.

Два счётчика с разными именами (R20): `producedBytes` — сколько процесс произвёл, `bytes` —
сколько доехало после редакции и обрезки. Одно поле публиковало бы в событии не то число.

**Falsification:** утверждение — `expect(await countSurvivors()).toBe(0)` после таймаута на команде,
порождающей трёх потомков. Убрать `detached: true` и бить по `pid` → выживают трое, что проба Ф5 и
показала, краснеет. Второе — `expect(raw.stdout.producedBytes).toBe(100)` и `expect(raw.stdout.bytes).toBe(64)` при
`maxBytes: 64` на выводе в 100 байт: слить два счётчика в один → одно из двух краснеет, и событие
опубликовало бы не ту величину. Третье, многобайтовое —
`expect(truncateToBytes('ЖЖЖ', 5).byteLength).toBe(5)`: считать `text.length` вместо байт →
краснеет. Четвёртое — `expect(raw.termination).toBe('output-cap')` при превышении потолка против
`'timeout'`: без отдельного члена оба исхода слились бы в один, и §6 перестала бы быть монотонной.
Пятое — `expect(raw.stdout.buffer.byteLength).toBe(maxBytes + holdBackBytes)` на выводе заведомо длиннее
суммы, **при `holdBackBytes` строго больше нуля в фикстуре**: с `toBeLessThanOrEqual` или с нулевым
запасом утверждение вырождается в `maxBytes === maxBytes` и проверяет ровно ничего.
Седьмое — `expect(redactCalledWith.byteLength).toBe(maxBytes + holdBackBytes)` — параметр назван `window`, а не `chunk`, потому что «chunk» приглашает редактировать по кусочкам, а это ровно тот баг, против которого hold-back и заведён:: редактор обязан
получить окно **до** обрезки, иначе порядок R20 остаётся фразой, которую некому исполнить.
Шестое — `expect(raw.exit.code).toBe(0)` при превышении потолка на команде, выходящей самостоятельно:
убить процесс на cap → `code: null`, краснеет (R49). Восьмое — `expect(raw.termination).toBe('timeout')`, когда сработали оба: приоритет задан, а не
выведен из порядка проверок. Девятое, покрытие R18 — `expect(raw.exit.signal).toBe('SIGTERM')` на
процессе, умирающем в grace-окне, против `'SIGKILL'` на игнорирующем SIGTERM: вердикт не выводится
из сигнала, но само различие обязано быть наблюдаемым.
Рантайм: node на macOS; тест порождает реальные процессы и подчищает их в `afterEach`.

**Verification:** `vitest run src/exec/limits.test.ts`

**Commit:** `E3: таймаут по группе и cap вывода с hold-back окном`

### Task 7 — синглтон srt, принуждение сети и режим `seatbelt`

**Files:** `packages/core/src/exec/srt-manager.ts` (Create),
`packages/core/src/exec/srt-manager.test.ts` (Create),
`packages/core/src/exec/modes/seatbelt.ts` (Create),
`packages/core/src/exec/modes/seatbelt.test.ts` (Create)

**Задача начинается с пробы** — третий `ASSUMED` из §8: величина `bodyBytes` для HTTPS под
`tlsTerminate`. П8 доказала, что запрос до колбэка доходит; сколько байт он показывает для POST —
не мерили. Если проба покажет, что байт нет, — остановиться и вернуться к владельцу: от этого
зависит цифра S5, а не только тест.

`srt-manager.ts` владеет всем глобальным, потому что синглтон **общий для обоих режимов** (D2).

- `initialize(config, undefined, true)` однократно на демон. **Третий аргумент обязателен**
  (R37, факт Ф10): по умолчанию он `false`, и тогда отказы происходят, а нарушений ноль.
- `strictAllowlist: true` (R43). `sandboxAskCallback` **не регистрируем** — это решение E5.
- **Принуждение — `updateConfig` под семафором с потолком 1** (D11, факт Ф13). Порядок задан
  целиком, а не перечислением (R46): **занять семафор → `updateConfig` политикой вызова →
  обернуть → запустить → дождаться → убить группу и подтвердить её пустоту ограниченным опросом
  (R52) → drain-окно → `updateConfig` пустым списком → освободить семафор.**
  `updateConfig` заменяет конфиг **целиком** (`structuredClone`, без слияния), поэтому
  пер-вызовный конфиг — это сохранённая база с заменой ровно двух доменных списков (R56). Литерал
  из двух полей проходит проверку типов и молча роняет `strictAllowlist`, `tlsTerminate` и
  `credentials`: телеметрия обнуляется, S5 показывает «0 KB», тесты зелёные. Освобождение **после** drain: иначе
  утверждение «под семафором всё, что видит колбэк, принадлежит текущему вызову» ложно ровно в том
  окне, ради которого drain заведён. Идловое состояние allowlist — **пустой список** (R52).
- `network.deny` рецепта едет в `deniedDomains` (R53). Он есть в `NormalizedAccess`
  (`packages/contracts/src/lock.ts:56`) и проверяется srt раньше allow-списка; терять его молча
  нельзя — это явный запрет автора рецепта.
- `filterRequest` — **телеметрия**: байты тела, URL, метод, violation с `action: 'allowed'`
  (R26, факт Ф12). Регистрируется **только в `initialize`**: прокси захватывает колбэк по значению
  при создании, и установка позже через `updateConfig` не действует, причём тихо — байты станут
  нулём, а S5 покажет «0 KB» при зелёных тестах. Тело читается не более N байт, после чего
  читатель **явно отменяется**: без отмены ветка tee продолжает буферизовать остаток для брошенного
  читателя, то есть «прочитали до потолка и перестали» хуже, чем не читать вовсе. Под семафором 1 запросы принадлежат ровно одному вызову, поэтому атрибуция
  бесплатна и невозможность прочитать `commandId` на HTTPS перестаёт мешать. Тело — в `try/catch`,
  ошибка даёт `allow`, а не `deny`: политика уже применена `updateConfig`, и бросок здесь резал бы
  разрешённый трафик. Чтение тела ограничено потолком, сверх него байты считаются как «≥ N».
- Курсор по `getTotalCount()`, **не по индексу в отданном массиве** (R44): массив насыщается на
  100 и перестаёт расти, индексный курсор молча остановился бы. При
  `getTotalCount() − lastSeen > 100` исход помечается потерявшим нарушения, громко (R45).
- **Атрибуция — окно семафора, а не `encodedCommand`** (R45): всё, что стор набрал между захватом
  и освобождением, принадлежит текущему вызову. `encodedCommand` — только подтверждение, и его
  расхождение или отсутствие считается и докладывается громко, но нарушение **не отбрасывает**.
  Иначе процесс внутри песочницы, сохранивший токен и переписавший имя пользователя прокси —
  а оно вшито в его же env, — порождал бы отказы под чужим ключом: граница выстояла бы, а из нашей
  корзины нарушения исчезли, и счётчик S5 показал бы ноль при работающей защите. Со стороны ядра
  ключ отсутствует всякий раз, когда строка `CMD64_` не попала в тот же чанк `log stream`, что и
  строка отказа, и когда имя вышло за 255 байт.
  Стор при `initialize` не считается чистым — `reset()` его не очищает.
- Drain-окно после выхода процесса перед resolve (R46).
- `dispose()` считает ссылки и **выставляет флаг, после которого любой `run()` бросает** (R50):
  `reset()` чистит `initializationPromise`, но не `config`, а `initialize` возвращается сразу при
  выставленном промисе. Значит повторный `initialize` — тихий no-op, а вызов после `reset()` идёт
  со старым конфигом и `getProxyPort() === undefined`, то есть прокси-переменные не эмитятся вовсе:
  сеть тихо **открыта** в `none` и тихо **мертва** в `seatbelt`.
- Громкая проверка на старте (R54): под конфигом `none` пробный хост обязан быть разрешён.
  `allowedDomains: ['*']` схема вендора объявляет недопустимым и пропускает лишь потому, что
  `updateConfig` — голый `structuredClone` без валидации.
- `commandId` — высокоэнтропийный, энтропия в первых 100 символах (R48).

`modes/seatbelt.ts` даёт своё: отображение `ResolvedSandboxPolicy` в
`filesystem.denyRead/allowRead/allowWrite/denyWrite`, тайп-левел утверждение против настоящего
`SandboxRuntimeConfig`, `quote(argv)` для входной строки.

**Falsification:** утверждение — `expect(await writeFails(hooksPath)).toBe(true)`, и это
**интеграционный тест R10**, которого не было ни в одной задаче. Каталог рецепта **отличен** от cwd
демона, `write.allow` стоит на весь этот каталог, и то же утверждается для вложенного
`sub/.git/hooks/pre-commit`, для `.zshrc` и для `.git/config`. Убрать наш mandatory-deny и
положиться на srt → все четыре записи проходят, что проба Ф4 показала живым.
Проверка состава списка в Task 3 этого не заменяет: она зелёная и когда вендор список игнорирует,
и когда глоб с несуществующим префиксом не матчит ничего.

Второе, детектор дрейфа R10 — и он обязан гонять **вендорскую** защиту, а не нашу.
`expect(await vendorOnlyDenials(fixture)).toEqual(RECORDED_VENDOR_SET)`, где прогон идёт с
**пустым** `denyWrite` и cwd, равным фикстуре, в дочернем процессе (техника П3b, чтобы не трогать
cwd демона). Формулировка «наш список отказан» тавтологична: он отказан потому, что мы его
запретили, и покраснеть при сужении апстрима не может.

Третье — `expect(await reachable(recipeA)).toBe(true)` и `expect(await reachable(recipeB)).toBe(false)`
для двух **последовательных** вызовов с разными `network.allow`, **по HTTPS на публичный хост**,
а не на локальный listener: у последнего самоподписанный сертификат, и соединение прокси наверх
упало бы по проверке (R55), покрасив разрешённую ногу по причине, не имеющей отношения к allowlist. Оставить принуждение
в `filterRequest` → атрибуции нет (Ф12), политика не применяется, оба одинаковы, краснеет.

Четвёртое — `expect(violations).not.toHaveLength(0)` на `read.deny` и `cat`: потерять третий
аргумент `initialize` → отказ происходит, нарушений ноль, краснеет (Ф10).

Пятое — на команде, дающей **ровно 250 отказов прокси** (не ядра): `expect(outcome.violations).toHaveLength(250)`.
Источник важен: каждый отказ прокси — одно `addViolation` без дедупликации, то есть число
детерминировано, а монитор ядра отдаёт **не более одного нарушения на чанк** вывода `log stream`,
и ядерная фикстура была бы флакающей — она научила бы реализатора ослабить число вместо того,
чтобы починить учёт.
Число независимое, а не взятое из накопителя: сравнение накопителя со стримом, который его же и
кормит, одинаково усечено с обеих сторон и зелено при потере.
Шестое, ветка потери — `expect(cursor.advance({totalCount: 400, lastSeen: 100}).lost).toBe(200)`
подачей синтетического скачка в функцию курсора: воспроизводить гонку бессмысленно,
`notifyListeners` синхронен внутри `addViolation`, и в продакшене ветка почти недостижима — именно
поэтому её легко написать неправильно и не узнать.
Седьмое, покрытие R48 — `expect(new Set(Array.from({length: 1000}, newCommandId)).size).toBe(1000)`
и `expect(newCommandId().slice(0, 100)).not.toEqual(newCommandId().slice(0, 100))`: энтропия обязана
лежать в первых ста символах, дальше идентификатор обрезается.
Восьмое, покрытие R32 — `expect(eventsOf(deniedRun).map((e) => e.stage)).toContain('build_profile')`
на вызове, остановленном отказом: «событие пишется на каждой стадии, включая отказ» иначе остаётся
цитатой без проверки.
Девятое, покрытие R29 — `expect(seenWhileAlive).toBe(true)`: нарушение доехало до колбэка **до**
выхода процесса, что и есть живая красная строка S5.
Десятое, покрытие R55 — `expect(upstreamTlsFails).toBe(false)` на локальном listener: прокси делает
своё соединение наверх с проверкой сертификата, и самоподписанный listener даёт ребёнку 502, а не
успех. Тест на байты этого не поймает — колбэк отрабатывает **до** соединения наверх.

Рантайм: node на macOS с рабочим `sandbox-exec`. На другой платформе набор пропускается
`describe.skipIf`, и пропуск обязан быть **громким** — эти тесты видят дефекты, которых
юнит-тесты на литеральных строках увидеть не могут, и молчаливо зелёный Linux-CI при мёртвой
песочнице — худший из возможных исходов.

**Verification:** `vitest run src/exec/srt-manager.test.ts src/exec/modes/seatbelt.test.ts`

**Commit:** `E3: синглтон srt, принуждение сети через updateConfig, режим seatbelt`

### Task 8 — режим `none` и наблюдение без принуждения

**Files:** `packages/core/src/exec/modes/none.ts` (Create),
`packages/core/src/exec/modes/none.test.ts` (Create)

Прокси тот же, из `srt-manager.ts`. Seatbelt-обёртки нет вовсе (D2, R31), поэтому переменные
обязан передать режим третьим параметром `buildEnv` (Task 5), и их **две группы**:

1. прокси — из `getProxyPort()`, `getProxyAuthToken()` и имени `srt.<base64(commandId)>`;
2. **доверие к CA** — из `getMitmCA()`, разложенное по переменным трастовых хранилищ.

Вторая группа обязательна из-за D12: с включённым `tlsTerminate` и без неё любой HTTPS падает с
ошибкой сертификата — то есть baseline ломается как **сетевая ошибка**, неотличимая в таймлайне
от «песочница заблокировала». Это худший вид отказа из возможных.

Обе группы — повторение недокументированной схемы вендора: ни `generateProxyEnvVars`, ни список
CA-переменных наружу не экспортируются (`index.d.ts`, 19 строк). Риск записан в Tech Stack.

Пока `none` держит семафор, его `allowedDomains` — `*`: это не открывает сеть остальным, потому
что потолок 1, и именно это делает `evil.io` из S5 достижимым в baseline.

**Falsification:** первое — `expect(violation).toMatchObject({type: 'network', action: 'allowed'})`
при обращении на разрешённый хост в `none`. Убрать проброс proxy-переменных → нарушений ноль,
краснеет, и разваливается левая половина таблицы S5.
Второе, и оно ловит именно пропуск CA-группы — `expect(exitCode).toBe(0)` на `https://` в `none`:
без CA-переменных `curl` даёт `exit=60`, `SSL certificate problem: self signed certificate`,
краснеет.
Третье — `expect(outcome.termination).toBe('exited')` при чтении файла, который в `seatbelt` был бы
закрыт: если `none` начнёт применять профиль, baseline перестанет быть baseline.
Четвёртое — `expect(bytes).toBeGreaterThan(0)` на POST с телом: это «1.2 KB» из S5.
Рантайм: цель — **имя** хоста, не `127.0.0.1` (R42, R51), и имя берётся из публичного
wildcard-DNS (`*.localtest.me`, `*.nip.io`), а не из правки `/etc/hosts`: последняя требует root,
мутирует машину глобально и в CI не ставится. Имя не совпадает с `NO_PROXY`, поэтому запрос уходит
в прокси, а прокси работает вне песочницы и его соединение на loopback не ограничено — ради чего
R42 и R51 и существуют. Зависимость от внешнего DNS — объявленное условие прогона.

**Verification:** `vitest run src/exec/modes/none.test.ts`

**Commit:** `E3: режим none как наблюдающий baseline`

### Task 9 — события четырёх стадий, оверхед, изоляция вендора и экспорт

**Files:** `packages/core/src/exec/events.ts` (Create),
`packages/core/src/exec/events.test.ts` (Create),
`packages/core/src/exec/index.ts` (Create), `packages/core/src/index.ts` (Modify)

Событие на каждой из четырёх стадий E3 — `build_env`, `build_profile`, `spawn`, `violation` —
включая отказ (R32); `durationUs` из `process.hrtime.bigint()` (R35); `env: {allowed}` только
именами, без значений (R25); схлопывание двух `StreamOutcome` в одну пару события — `bytes` сумма,
`truncated` дизъюнкция (R20).

**`sandbox.mode` приезжает уже на `build_profile`**, а не на `spawn`: в замороженном типе `mode`
обязателен всегда, когда присутствует `sandbox` (`packages/contracts/src/event.ts:92`), поэтому
событие с `sandbox.profile` обязано нести и его. Таблица в комментарии `event.ts` относит `mode` к
`spawn`, но комментарий проигрывает типу, а режим на этой стадии уже известен — его выбрал
вызывающий (R33, R4).

`packages/core/src/index.ts:2` — заменить `export {}` на `export * from './exec/index.js';`.
Единственная строка, конфликтующая с веткой E2 (§5).

**Изоляция вендора (R1) проверяется здесь**, а не в Task 2: тест обходит граф `.d.ts` от
публичного входа, а до этой задачи вход — `export {}`. Пара утверждений:
`expect(reachable.length).toBeGreaterThan(3)` — граф действительно обойдён, иначе всё последующее
вакуумно — и `expect(reachable.filter((f) => f.text.includes('sandbox-runtime'))).toEqual([])`.
`dist/exec/modes/seatbelt.d.ts` в граф не входит: наружу режимы уезжают только через типы,
объявленные нами.

Измерение бюджета (R38) — **серией и с осмысленным порогом**. `overheadMs`
(`packages/contracts/src/event.ts:156`) делает `Math.round(total / 1000)`, а `build_env` и
`build_profile` — чистые функции на десятки микросекунд: утверждение по нему не может покраснеть.
Но и `p95 < 50_000` мкс не годится — порог втрое-тысячекратно выше ожидаемого тоже неспособен
упасть. Утверждаем `expect(p95(durationsUs)).toBeLessThan(5_000)` по серии из ста прогонов: пять
миллисекунд — десятая доля бюджета и всё ещё на порядок выше измеренного, то есть порог ловит
регрессию, а не шум. И записываем честно: стоимость генерации SBPL и запуска `sandbox-exec` лежит
внутри стадии `spawn`, из бюджета **исключённой** (`event.ts:149`), а `initialize` не входит
вовсе — метрика меряет наш оверхед, а не полную цену песочницы, и на слайд идёт с этой оговоркой.

**Falsification:** первое — `expect(Object.keys(eventAt('build_env'))).not.toContain('sandbox')`:
заполнять `sandbox` с первой стадии → ключ появляется раньше `build_profile`, краснеет.
Второе — `expect('violations' in eventAt('build_profile').sandbox).toBe(false)` против
`expect(eventAt('violation').sandbox.violations).toHaveLength(1)`: приезжать с `violations: null`
→ краснеет, потому что JCS различает отсутствие ключа и `null` побайтово.
Третье — `expect(eventAt('build_env').env.allowed).toEqual(['PATH'])` и
`expect(JSON.stringify(eventAt('build_env'))).not.toContain(secretValue)`: положить значения
вместо имён → краснеет (R25).
Четвёртое — `expect(p95(durationsUs)).toBeLessThan(5_000)`; считать через `overheadMs` → всегда
`0`, утверждение неспособно покраснеть, и `ASSUMED` маскируется вместо снятия.
Пятое — `expect(reachable.length).toBeGreaterThan(3)` перед отрицанием про `sandbox-runtime`.

**Verification:** `vitest run src/exec/events.test.ts`, затем
`yarn workspace @mcpproxy/contracts test` — снапшот поверхности contracts зелёный **без** обновления.

**Commit:** `E3: события стадий, оверхед серией, изоляция вендора, экспорт из core`

### Task 10 — доки: убрать то, что пробы опровергли

**Files:** `docs/03-threat-model.md` (Modify), `docs/10-honest-limitations.md` (Modify),
`docs/02-architecture.md` (Modify)

- `docs/03-threat-model.md:63` — строка A13 перестаёт обещать `rlimits`; остаётся то, что реально
  стоит: таймаут, SIGKILL по группе, cap на stdout (D1, R22).
- `docs/10-honest-limitations.md` — новые строки: настоящих rlimits нет; в цепочке на macOS есть
  `sh -c` внутри обёртки srt; в `none` процесс, игнорирующий proxy-переменные, проходит мимо
  наблюдения (R31); **сырой TCP через SOCKS не доходит до нашего колбэка и ограничен только
  объединением доменов манифеста** (R15) — это ослабление относительно обещанного; **мы
  терминируем TLS дочернего процесса** (D12), то есть видим содержимое его HTTPS; loopback закрыт
  и адресами не открывается, корпус ходит на имя (R42).
- `docs/10-honest-limitations.md` — ещё две строки: **заблокированный HTTP не роняет команду**
  (`exit=0` и тело `Connection blocked by network allowlist`, факт Ф6), поэтому корпус E8 обязан
  отличать «команда отработала» от «команду резали» по violations, а не по коду возврата (R41); и
  **сетевая политика применяется по одному вызову за раз** — семафор 1 из D11 — то есть демон не
  исполняет два рецепта параллельно, пока действует сетевое ограничение (R21).
- `docs/10-honest-limitations.md` — ещё две: srt при каждой обёртке доливает
  `getDefaultWritePaths()` (`/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`, `/dev/*`), то есть
  **исполненный набор записи всегда шире манифестного**, а модалка E5 показывает манифестный; и
  монитор ядра отдаёт не более одного нарушения на чанк вывода, поэтому всплеск файловых нарушений
  коалесцируется вендором и счётчик в таймлайне — **нижняя оценка**, а не точное число.
- `docs/10-honest-limitations.md:97` — «не включаем ослабляющие флаги по умолчанию» меняется на
  «не поддерживаем»: в замороженном `SandboxProfile` их нечем выразить (D9).
- `docs/02-architecture.md:154-163` — таблица режимов получает строку о том, что `none` наблюдает
  через прокси, а не слеп.

Правки `06-epics.md` и `07-contracts.md` **не** делаем: первый — план работ, второй — контракт.
Неточность строки `07-contracts.md:154` («сужает **или расширяет** свой blast radius» — для узла
`read` замена `allow` не ограничивает чтение) зафиксирована требованием R7 в `spec.md`, а не
переписыванием замороженного документа.

**Falsification:** тестов нет — это документация. Проверка: `grep -n "rlimits" docs/03-threat-model.md`
не находит их в строке A13, и `grep -c "tlsTerminate\|терминируем TLS" docs/10-honest-limitations.md`
даёт не ноль.

**Verification:** `yarn typecheck && yarn build && yarn test` из корня — весь граф зелёный.

**Commit:** `E3: доки приведены в соответствие с тем, что реально работает`

---

## Requirement diff

| R | Строка плана, которая его исполняет |
|---|---|
| R1 | Task 9: «Изоляция вендора (R1) проверяется здесь», пятое утверждение |
| R2 | Task 2: «`seatbelt` на не-macOS бросает», утверждение `expect(() => createSandbox('seatbelt')).toThrow()` под `skipIf` на macOS |
| R3 | Task 2, первое утверждение — `expect(() => createSandbox('container')).toThrow(/container/)` |
| R4 | Task 2: `createSandbox(mode: SandboxMode)` — режим параметром вызова |
| R5 | Task 3: `buildProfile(sandbox: NormalizedSandbox, …)` — вход лист, а не агрегат |
| R6 | Task 7: отображение ФС в `filesystem.*`; сеть — через `updateConfig`, не `customConfig` |
| R7 | Task 3, **пятое** утверждение — `read.allow: ['./logs']` чтение не сужает; Task 10 не правит контракт |
| R8 | Task 3, второе утверждение — разворачивание `~` |
| R9 | Task 3: «mandatory-deny глобами на поддерево, якорёнными на каждом корне `write.allow`» |
| R10 | Task 7, **первое и второе** утверждения — интеграционный отказ и детектор дрейфа |
| R11 | Ничего не делаем: слот `{}` в профиле — ошибка загрузки ещё в E0 (`refine.ts:80`). Строка есть, чтобы отсутствие работы было видно |
| R12 | Task 7: «Принуждение — `updateConfig` под семафором», третье утверждение (последовательные вызовы, HTTPS) |
| R13 | Task 3, третье утверждение — таблица конформанса с верным порядком `matchesDomainPattern(hostname, pattern)`; перевалидация в `run()` — Task 7 |
| R14 | Task 3, четвёртое утверждение — `isWeakened(['*'])` против `['*.github.com']`: бейдж на голой звёздочке |
| R15 | Task 7: `filterRequest` эмитит violation; Task 10 — строка про сырой TCP |
| R16 | Task 6: «SIGTERM → grace → SIGKILL по `process.kill(-pid)`», первое утверждение |
| R17 | Task 6: «grace именованной константой» |
| R18 | Task 6, **девятое** утверждение — `SIGTERM` в grace-окне против `SIGKILL`; вердикт пишет E4 |
| R19 | Task 6: «храним только `maxBytes + holdBackBytes`», пятое утверждение (равенство, не неравенство) |
| R20 | Task 6: `redact` в `ProcessLimits`, два счётчика `producedBytes`/`bytes`, седьмое утверждение; Task 9 — схлопывание пары |
| R21 | Task 7: «потолок 1 здесь несущий, а не нагрузочный», третье утверждение проверяет разные политики |
| R22 | Task 10: строка A13 в `03-threat-model.md:63` |
| R23 | Task 5, второе, третье и **пятое** утверждения — минимальный `PATH` побеждает даже названный в `allow` |
| R24 | Task 5, четвёртое утверждение — `expect(buildEnv([], {}, {HTTP_PROXY: 'http://x'}).HTTP_PROXY).toBe('http://x')` |
| R25 | Task 9, **третье** утверждение — `env.allowed` именами, секрет не сериализуется |
| R26 | Task 7: «`filterRequest` — телеметрия», `try/catch` и потолок чтения тела |
| R27 | Task 4: три грамматики, **дедупликации нет**; четвёртое и пятое утверждения |
| R28 | Task 4, второе и **шестое** утверждения — глоб против реального пути, а не строка со строкой |
| R29 | Task 7, **девятое** утверждение — нарушение доехало до колбэка до выхода процесса |
| R30 | Task 7: `commandId` — идентификатор вызова, не текст команды |
| R31 | Task 8, первое и второе утверждения — прокси-переменные и CA-группа |
| R32 | Task 7, **восьмое** утверждение — событие есть на вызове, остановленном отказом |
| R33 | Task 9: «`sandbox.mode` приезжает уже на `build_profile`», первое утверждение |
| R34 | Task 9, второе утверждение; Global Constraints, `exactOptionalPropertyTypes` |
| R35 | Task 9: «`durationUs` из `process.hrtime.bigint()`» |
| R36 | Task 3: «конверсия `NormalizedSandbox` → `SandboxProfile`»; §4 ловушка типов |
| R37 | Task 7: «Третий аргумент обязателен», четвёртое утверждение |
| R38 | Task 9: «`expect(p95(durationsUs)).toBeLessThan(5_000)` по серии из ста прогонов» |
| R39 | Task 4: «список подавляемых операций именованной константой», первое утверждение |
| R40 | Task 4: «`resolvePath` инжектируется», третье утверждение |
| R41 | Task 10: строка «заблокированный HTTP не роняет команду»; §8 факт Ф6 |
| R42 | Task 8: «цель — имя хоста, не `127.0.0.1`»; Task 10 — строка про loopback |
| R43 | Task 7: «`strictAllowlist: true`. `sandboxAskCallback` не регистрируем» |
| R44 | Task 7: «Курсор по `getTotalCount()`, не по индексу», пятое утверждение |
| R45 | Task 7: «Атрибуция — окно семафора, а не `encodedCommand`», шестое утверждение |
| R46 | Task 7: порядок задан целиком, освобождение семафора **после** drain |
| R47 | Task 2: поле `policyHash` в `ExecOutcome`; Task 3: `policyHash(policy, net)` — **вместе с доменными списками** |
| R48 | Task 7, **седьмое** утверждение — тысяча уникальных, различие в первых ста символах |
| R49 | Task 6: «процесс не убивается», шестое утверждение — `expect(raw.exit.code).toBe(0)` |
| R50 | Task 7: «выставляет флаг, после которого любой `run()` бросает» |
| R51 | Task 8: имя из публичного wildcard-DNS, не `/etc/hosts`; зависимость объявлена условием прогона |
| R52 | Task 7: «убить группу и подтвердить её пустоту», идловый allowlist — пустой список |
| R53 | Task 7: «`network.deny` рецепта едет в `deniedDomains`» |
| R54 | Task 7: «Громкая проверка на старте: под конфигом `none` пробный хост обязан быть разрешён» |
| R55 | Task 7, десятое утверждение; третье утверждение бьёт по публичному хосту, чтобы не смешать причины |
| R56 | Task 7: «`updateConfig` заменяет конфиг целиком … сохранённая база с заменой ровно двух доменных списков» |
