# E3 — executor и песочница

## Goal

Вторая линия обороны из `docs/03-threat-model.md:21-32`: валидатор контролирует, **что**
запускается, песочница — **что запущенное может сделать**. Реализовать `packages/core/src/exec`:
обёртку над `@anthropic-ai/sandbox-runtime`, доменный allowlist сети, ресурсные ограничители,
cap на вывод, поток violations в шину событий. Требования — `spec.md`, `R1..R42`.

## Architecture

Один модуль `packages/core/src/exec`, шесть слоёв, каждый — чистая функция или тонкая обёртка:

```
profile.ts    NormalizedSandbox → SrtConfig      (чистая, R5-R11, R40)
violation.ts  строка лога       → SandboxViolation | null  (чистая, R26-R28, R39-R40)
env.ts        EnvPolicy         → ProcessEnv      (чистая, R23-R25)
limits.ts     spawn + таймаут + cap              (I/O, R16-R21)
sandbox.ts    интерфейс Sandbox + выбор режима   (R1-R4)
modes/        none.ts · seatbelt.ts · container.ts
```

Четыре из шести — чистые, то есть тестируются без запуска процессов. `srt` виден только внутри
`modes/seatbelt.ts` и `modes/none.ts`; наружу из пакета не торчит ни один его тип (R1).

## Tech Stack

Node 22, TypeScript 5.6, vitest 3, `@anthropic-ai/sandbox-runtime@0.0.74`.
Новое в этой ветке: `@anthropic-ai/sandbox-runtime` в `packages/core/package.json:22` (уже
добавлено), vitest в `packages/core` (Task 1).

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
| `packages/core` | **нет вообще** — в `packages/core/package.json:14-18` три скрипта: `build`, `typecheck`, `clean` | нет | нет | `tsc -b` | наследует `tsconfig.base.json` целиком | конфига нет |
| `packages/contracts` | `packages/contracts/package.json:24` `"test": "tsc -b && vitest run"` | нет | нет | `tsc -b` перед vitest | то же | конфига нет |

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

Четыре пробы прогнаны на этой машине, сырой вывод — в `probes.md`, исходники — `probes/p*.mjs`.
Ниже только вывод и то, чего проба не покрывает.

**Ф1 — форма argv и грамматика ядра.** `probes.md`, П1:
`argv[0] = /bin/bash`, `argv.length = 3`, строка вида
`cat(10515) deny(1) file-read-data /private/var/.../secret.txt`.
Не покрывает: только macOS; Linux-грамматика seccomp не проверялась и в срез не входит.

**Ф2 — `filterRequest` только для разрешённых.** `probes.md`, П2: колбэк увидел единственную
запись `{method:'GET', url:'http://example.com/', bodyBytes:0}`, тогда как `evil.invalid`
исполнялся и был заблокирован. Не покрывает: HTTPS с `tlsTerminate`; чанкованное тело.

**Ф3 — грамматика прокси другая.** `probes.md`, П2:
`deny network-outbound evil.invalid:80 (host is not on the allow list)` — без `proc(pid)` и без
`deny(n)`.

**Ф4 — mandatory deny якорится на cwd демона.** `probes.md`, П3 против П3b: при cwd демона вне
каталога цели запись в `.git/hooks/pre-commit` прошла с `exit=0`; при `process.chdir(dir)` до
`initialize` та же запись дала `exit=1` и violation. Не покрывает: случай, когда cwd рецепта
совпадает с cwd демона — он маскирует дефект, и тест обязан их развести.

**Ф5 — убийство по pid оставляет потомков.** `probes.md`, П4: `выживших sleep после kill(pid): 3`
против `выживших sleep после kill(-pgid): 0`. Не покрывает: процесс, сам меняющий группу
(`setsid`) — признанная граница.

**Ф6 — заблокированный HTTP не роняет команду.** `probes.md`, П2: `exit=0`, тело
`Connection blocked by network allowlist`.

**Ф7 — `env` из srt тождествен `process.env`.** `probes.md`, П1: `env identical to process.env? true`.

**`ASSUMED`** — ровно два, и оба помечены для ревьюера:
- накладные расходы `build_profile` укладываются в бюджет ≤50 мс p95. Не измерялось; Task 9
  добавляет измерение, а не предположение;
- поведение при одновременных вызовах через глобальный синглтон `SandboxManager`. Проба гоняла
  вызовы последовательно. Task 7 вводит потолок параллелизма (R21) именно потому, что это
  не проверено.

Почему не пишем свои SBPL, хотя зрелая экосистема так делает: Chrome и Firefox поддерживают
собственные seatbelt-профили, и платят за это командой, которая ведёт их годами. ADR-0002:12-14
уже взвесил это и выбрал `srt`; проба Ф4 показывает цену — за чужой список приходится
доделывать привязку к каталогу.

---

## Tasks

### Task 1 — тест-раннер для `core`, которого нет

**Files:** `packages/core/package.json` (Modify), `packages/core/vitest.config.ts` (Create),
`packages/core/src/exec/runner.test.ts` (Create)

Шаги: скрипт `"test": "tsc -b && vitest run"` по образцу
`packages/contracts/package.json:24`; `vitest` в devDependencies пакета; конфиг с
`environment: 'node'` и `include: ['src/**/*.test.ts']` по образцу
`packages/contracts/vitest.config.ts:7-10`; страховка от возврата в нынешнее состояние —
копия формы `packages/contracts/src/domain.test.ts:47-66`, то есть «обнаружен хотя бы один
тестовый файл» и «нет тестов за пределами `src/`».

**Falsification:** утверждение — `expect(testFiles.length).toBeGreaterThan(0)`. Убрать
`include` из конфига → vitest не находит ни одного файла, раннер выходит с нулём молча,
утверждение краснеет. С конфигом — зелёное. Рантайм: node, без DOM и без таймзонной
зависимости.

**Verification:** `yarn workspace @mcpproxy/core test`, затем `yarn test` из корня — второй
обязан перестать быть тихим.

**Commit:** `E3: тест-раннер для core`

### Task 2 — интерфейс `Sandbox` и выбор режима

**Files:** `packages/core/src/exec/sandbox.ts` (Create),
`packages/core/src/exec/sandbox.test.ts` (Create)

Интерфейс:

```ts
export interface ExecRequest {
  readonly recipeName: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly normalized: NormalizedRecipe;
  readonly commandId: string;
}

export interface ExecOutcome {
  readonly exit: { readonly code: number | null; readonly signal: string | null };
  readonly output: { readonly bytes: number; readonly truncated: boolean };
  readonly stdout: string;
  readonly stderr: string;
  readonly violations: readonly SandboxViolation[];
}

export interface Sandbox {
  readonly mode: SandboxMode;
  run(request: ExecRequest, onViolation: (v: SandboxViolation) => void): Promise<ExecOutcome>;
}
```

`createSandbox(mode: SandboxMode): Sandbox` — `container` бросает (R3, D7), `seatbelt` на не-macOS
бросает (R2). Ни один тип srt в сигнатурах не появляется (R1).

**Falsification:** утверждение — `expect(() => createSandbox('container')).toThrow(/container/)`.
Заменить бросок на `return createSandbox('seatbelt')` → тихий откат, утверждение краснеет.
Второе утверждение — на `.d.ts`: `expect(dts).not.toContain('sandbox-runtime')`; добавить
`import type { SandboxRuntimeConfig }` в публичную сигнатуру → краснеет.

**Verification:** `vitest run src/exec/sandbox.test.ts`

**Commit:** `E3: интерфейс Sandbox и выбор режима`

### Task 3 — профиль: маппинг, резолв путей, mandatory deny

**Files:** `packages/core/src/exec/profile.ts` (Create),
`packages/core/src/exec/profile.test.ts` (Create)

`buildProfile(normalized: NormalizedRecipe, cwd: string): SrtFilesystemAndNetwork` — чистая.

Шаги: маппинг шести узлов по R6; резолв `~` в `os.homedir()` и относительных путей от `cwd`
**рецепта** (R8); список mandatory-deny, якорённый на `cwd` рецепта, добавляется в `denyWrite`
(R9, факт Ф4); флаг «ослабленный» из `*` в `network.allow` (R14, D9).

Список mandatory-deny — именованная константа, содержимое из `docs/02-architecture.md:150-151`,
расширенное до фактического набора srt: `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`,
`.zshrc`, `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`, каталоги `.vscode`, `.idea`,
`.claude/commands`, `.claude/agents`, плюс `.git/hooks`.

**Falsification:** утверждение — `expect(buildProfile(r, '/tmp/x').denyWrite).toContain('/tmp/x/.git/hooks')`. Убрать якорение на
`cwd` рецепта и положиться на srt → в `denyWrite` пусто, утверждение краснеет; именно этот
дефект проба Ф4 показала живым. Второе — `expect(buildProfile(r, cwd).denyRead).toContain(homedir() + '/.ssh')`
при входе `~/.ssh`; убрать разворачивание тильды → в списке остаётся литерал `~/.ssh`, краснеет.
Рантайм: node; `homedir()` читается, но файлы не трогаются.

**Verification:** `vitest run src/exec/profile.test.ts`

**Commit:** `E3: профиль песочницы, резолв путей и mandatory deny`

### Task 4 — парсер violations

**Files:** `packages/core/src/exec/violation.ts` (Create),
`packages/core/src/exec/violation.test.ts` (Create)

`parseViolation(line: string, mandatoryPaths: readonly string[]): SandboxViolation | null`.

Две грамматики (R27, факты Ф1 и Ф3), список подавляемых операций именованной константой (R39),
нормализация `target` через `realpathSync.native` с падением обратно на исходную строку, если
пути уже нет (R40), классификация в `mandatory-deny` против `file-write` (R28).

Таблица §7 — это и есть набор кейсов теста, включая счётчик «из трёх строк `cat` выживает одна».

**Falsification:** утверждение — `expect(lines.map((l) => parseViolation(l, [])).filter(Boolean)).toHaveLength(1)` на трёх строках
из П1. Убрать список подавляемых операций → выживают три, утверждение краснеет. Второе —
`expect(parseViolation(hooksLine, [hooks]).type).toBe('mandatory-deny')`; убрать сверку со
списком → `file-write`, краснеет, и вместе с ним разваливается бейдж S6.

**Verification:** `vitest run src/exec/violation.test.ts`

**Commit:** `E3: парсер нарушений, две грамматики и подавление шума`

### Task 5 — сборка окружения

**Files:** `packages/core/src/exec/env.ts` (Create), `packages/core/src/exec/env.test.ts` (Create)

`buildEnv(allow: readonly string[], base: NodeJS.ProcessEnv): NodeJS.ProcessEnv` — чистая,
`base` не мутируется (факт Ф7: srt отдаёт `process.env` тождественно, мутация испортила бы
процесс демона).

Только имена из `allow` плюс минимальный `PATH` (R23). Прокси-переменные srt вшиты в строку
команды, а не в `env` (факт Ф7), поэтому фильтрация их не сбивает — и это утверждает тест (R24).

**Falsification:** утверждение — `expect(buildEnv(['PATH'], {PATH: '/usr/bin', SECRET: 'x'})).toEqual({PATH: '/usr/bin'})`.
Заменить фильтр на `{...base, ...picked}` → `SECRET` доезжает, краснеет. Второе —
`expect(base).toEqual(snapshot)` после вызова: мутация `base` краснеет.

**Verification:** `vitest run src/exec/env.test.ts`

**Commit:** `E3: сборка окружения по allowlist`

### Task 6 — запуск, таймаут по группе, cap вывода

**Files:** `packages/core/src/exec/limits.ts` (Create),
`packages/core/src/exec/limits.test.ts` (Create)

`runProcess(argv, opts)` — `spawn(argv[0], argv.slice(1), { shell: false, detached: true })`,
таймаут SIGTERM → grace → SIGKILL по `process.kill(-pid)` (R16, факт Ф5), grace именованной
константой (R17), обрыв чтения на `maxBytes` (R19, граница включительна по §6),
`maxBytes === null` — без потолка (R19, D8).

**Falsification:** утверждение — `expect(await countSurvivors()).toBe(0)` после таймаута на
команде, порождающей трёх потомков. Убрать `detached: true` и бить по `pid` → выживают трое,
что проба Ф5 и показала, утверждение краснеет. Второе —
`expect(outcome.output).toEqual({bytes: 64, truncated: true})` на выводе в 100 байт при
`maxBytes: 64`; снять обрыв → `bytes: 100`, `truncated: false`, краснеет.
Рантайм: node на macOS; тест порождает реальные процессы и обязан подчищать их в `afterEach`,
иначе он оставляет мусор на машине разработчика.

**Verification:** `vitest run src/exec/limits.test.ts`

**Commit:** `E3: таймаут по группе процессов и потолок вывода`

### Task 7 — режим `seatbelt`

**Files:** `packages/core/src/exec/modes/seatbelt.ts` (Create),
`packages/core/src/exec/modes/seatbelt.test.ts` (Create)

`SandboxManager.initialize` однократно на демон (R37); политика рецепта per-invocation через
`customConfig`; `commandId` = уникальный идентификатор вызова, не текст команды (R30);
`quote(argv)` из srt для входной строки; `subscribe` для стрима нарушений (R29);
`cleanupAfterCommand()` после каждого вызова; потолок параллелизма (R21, `ASSUMED` из §8);
`filterRequest` даёт разрешённые соединения с байтами тела (R26, факт Ф2), отказы приезжают
строкой прокси.

**Falsification:** утверждение — `expect(violations.map((v) => v.type)).toContain('file-read')`, интеграционное: при `read.deny` на временный файл
и `cat` по нему. Снять передачу `customConfig` → чтение проходит, нарушений нет, краснеет.
Второе — `expect(store.getViolationsForCommand(id)).not.toHaveLength(0)` при двух вызовах с
разными id: передать текст команды вместо id → атрибуция схлопывается по первым 100 символам,
краснеет.
Рантайм: node на macOS с рабочим `sandbox-exec`; на другой платформе тест обязан быть пропущен
явно, а не молча зелёным.

**Verification:** `vitest run src/exec/modes/seatbelt.test.ts`

**Commit:** `E3: режим seatbelt`

### Task 8 — режим `none` и наблюдение без принуждения

**Files:** `packages/core/src/exec/modes/none.ts` (Create),
`packages/core/src/exec/modes/none.test.ts` (Create)

Прокси поднят, переменные отданы ребёнку, seatbelt-профиля нет (D2, R31). Нарушения пишутся с
`action: 'allowed'` и реальными байтами. Граница — процесс, игнорирующий proxy-переменные, —
уезжает в `10-honest-limitations.md` в Task 10.

**Falsification:** утверждение — `expect(v).toMatchObject({type: 'network', action: 'allowed'})` при обращении на разрешённый
хост в режиме `none`. Убрать проброс proxy-переменных → нарушений ноль, краснеет, и вместе с ним
разваливается левая половина таблицы S5.

**Verification:** `vitest run src/exec/modes/none.test.ts`

**Commit:** `E3: режим none как наблюдающий baseline`

### Task 9 — события стадий, оверхед и экспорт

**Files:** `packages/core/src/exec/events.ts` (Create),
`packages/core/src/exec/events.test.ts` (Create),
`packages/core/src/exec/index.ts` (Create), `packages/core/src/index.ts` (Modify)

Событие на каждой из четырёх стадий, включая отказ (R32); поле не раньше своей стадии (R33);
отсутствие ключа против `null` (R34, исполняется `exactOptionalPropertyTypes`);
`durationUs` из `process.hrtime.bigint()` (R35); конверсия `NormalizedSandbox` → `SandboxProfile`
явной функцией, не приведением (R36, ловушка из §4); измерение бюджета (R38, снимает первый
`ASSUMED`).

`packages/core/src/index.ts:2` — заменить `export {}` на `export * from './exec/index.js';`.
Это единственная строка, конфликтующая с веткой E2 (§5).

**Falsification:** утверждение — `expect(Object.keys(eventAt('build_argv'))).not.toContain('sandbox')`. Заполнять `sandbox.mode`
с первой стадии → ключ появляется раньше `spawn`, краснеет. Второе —
`expect(eventAt('complete').exit).toEqual({code: 0, signal: null})`: заменить `signal: null` на
пропуск ключа → краснеет, потому что `null` здесь означает «известно и пусто».

**Verification:** `vitest run src/exec/events.test.ts`, затем
`yarn workspace @mcpproxy/contracts test` — снапшот публичной поверхности contracts обязан
остаться зелёным **без** обновления.

**Commit:** `E3: события стадий, измерение оверхеда и экспорт из core`

### Task 10 — доки: убрать то, что разведка и пробы опровергли

**Files:** `docs/03-threat-model.md` (Modify), `docs/10-honest-limitations.md` (Modify),
`docs/02-architecture.md` (Modify)

- `docs/03-threat-model.md:63` — строка A13 перестаёт обещать `rlimits`; остаётся то, что
  реально стоит: таймаут, SIGKILL по группе, cap на stdout (D1, R22).
- `docs/10-honest-limitations.md` — четыре новые строки: настоящих rlimits нет; в цепочке на
  macOS есть `sh -c` внутри обёртки srt; в режиме `none` процесс, игнорирующий proxy-переменные,
  проходит мимо наблюдения (R31); loopback закрыт по умолчанию, и корпус E8 обязан разрешать
  свой listener явно (R42).
- `docs/10-honest-limitations.md:97` — «не включаем ослабляющие флаги по умолчанию» меняется на
  «не поддерживаем»: в замороженном `SandboxProfile` их нечем выразить (D9).
- `docs/02-architecture.md:154-163` — таблица режимов получает строку о том, что `none`
  наблюдает через прокси, а не слеп.

Правки `06-epics.md` и `07-contracts.md` **не** делаем: первый — план работ, второй — контракт,
и расхождение в строке merge-таблицы `07-contracts.md:154` зафиксировано требованием R7 в
`spec.md`, а не переписыванием замороженного документа.

**Falsification:** тестов нет — это документация. Проверка: `grep -c "rlimits" docs/03-threat-model.md`
обязан дать 0 в строке A13.

**Verification:** `yarn typecheck && yarn build && yarn test` из корня — весь граф зелёный.

**Commit:** `E3: доки приведены в соответствие с тем, что реально работает`

---

## Requirement diff

| R | Строка плана |
|---|---|
| R1 | Task 2: «Ни один тип srt в сигнатурах не появляется (R1)» + утверждение на `.d.ts` |
| R2 | Task 2: «`seatbelt` на не-macOS бросает (R2)» |
| R3 | Task 2: «`container` бросает (R3, D7)» |
| R4 | Task 2: `createSandbox(mode: SandboxMode)` — режим параметром |
| R5 | Task 3: `buildProfile(normalized: NormalizedRecipe, cwd: string)` |
| R6 | Task 3: «маппинг шести узлов по R6» |
| R7 | §5 Premises, строка про приоритет чтения; Task 10 не трогает `07-contracts.md` |
| R8 | Task 3: «резолв `~` в `os.homedir()` и относительных путей от `cwd` рецепта (R8)» |
| R9 | Task 3: «список mandatory-deny, якорённый на `cwd` рецепта, добавляется в `denyWrite`» |
| R10 | Task 3 Falsification, первое утверждение; Task 4 второе |
| R11 | §1 Write path: профиль строится из `effective`, параметров в нём нет |
| R12 | Task 3: маппинг `network.allow → allowedHosts`, пустой список = сети нет |
| R13 | Task 3: доменный матчер с ведущей звёздочкой |
| R14 | Task 3: «флаг „ослабленный“ из `*` в `network.allow` (R14, D9)» |
| R15 | Task 7: `filterRequest` + строка прокси; Task 8 для `none` |
| R16 | Task 6: «таймаут SIGTERM → grace → SIGKILL по `process.kill(-pid)`» |
| R17 | Task 6: «grace именованной константой (R17)» |
| R18 | Task 6 + Task 9: `verdict: 'denied'`, `exit: {code: null, signal: 'SIGKILL'}` |
| R19 | Task 6: «обрыв чтения на `maxBytes`»; §6 таблица границы |
| R20 | Task 6 Falsification, второе утверждение |
| R21 | Task 7: «потолок параллелизма (R21)» |
| R22 | Task 10: строка A13 в `03-threat-model.md` |
| R23 | Task 5: «Только имена из `allow` плюс минимальный `PATH`» |
| R24 | Task 5: «фильтрация их не сбивает — и это утверждает тест (R24)» |
| R25 | Task 9: событие несёт `env: {allowed: string[]}`, значений нет |
| R26 | Task 7: «`filterRequest` даёт разрешённые соединения с байтами тела (R26, факт Ф2)» |
| R27 | Task 4: «Две грамматики (R27, факты Ф1 и Ф3)» |
| R28 | Task 4: «классификация в `mandatory-deny` против `file-write` (R28)» |
| R29 | Task 7: «`subscribe` для стрима нарушений (R29)» |
| R30 | Task 7: «`commandId` = уникальный идентификатор вызова, не текст команды (R30)» |
| R31 | Task 8: «Нарушения пишутся с `action: 'allowed'` и реальными байтами» |
| R32 | Task 9: «Событие на каждой из четырёх стадий, включая отказ (R32)» |
| R33 | Task 9: «поле не раньше своей стадии (R33)» + Falsification |
| R34 | Task 9: «отсутствие ключа против `null` (R34)»; Global Constraints, `exactOptionalPropertyTypes` |
| R35 | Task 9: «`durationUs` из `process.hrtime.bigint()` (R35)» |
| R36 | Task 9: «конверсия явной функцией, не приведением (R36)»; §4 ловушка типов |
| R37 | Task 7: «`SandboxManager.initialize` однократно на демон (R37)» |
| R38 | Task 9: «измерение бюджета (R38, снимает первый `ASSUMED`)» |
| R39 | Task 4: «список подавляемых операций именованной константой (R39)» |
| R40 | Task 4: «нормализация `target` через `realpathSync.native`» |
| R41 | Task 10: строка про loopback и E8; §8 факт Ф6 |
| R42 | Task 10: «loopback закрыт по умолчанию, и корпус E8 обязан разрешать свой listener явно (R42)» |
