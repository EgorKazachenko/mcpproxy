# E7 — Electron UI на моках событий

**Ветка:** `v2/e7-ui` · **Спека:** `docs/vibe-coding/27.08.2026-e7-ui/spec.md` ·
**Макет:** `docs/vibe-coding/27.08.2026-e7-ui/mockup.html` (заморожен, источник истины для строк) ·
**Разведка:** `docs/vibe-coding/27.08.2026-e7-ui/research.md`

## Goal

Отгрузить семь наблюдательных поверхностей прокси и authoritative-канал подтверждений,
работающие на воспроизведении записанного трейса, не дожидаясь ядра. Готовность означает:
приложение запускается, трейс сценариев S1–S9 проигрывается шагами, и каждое требование
`R1`–`R60` отмечено реализованным.

## Architecture

Три раздельных входа в одном пакете. Граница между ними — граница безопасности, а не
модульности.

```
packages/desktop/
  src/main/       Node. Окно, схема app://, CSP, проигрыватель трейса, verifyChain
  src/preload/    CJS, песочница. Один замороженный объект через contextBridge
  src/renderer/   React. DOM. Ни одного узла Node, ни одного импорта из main
  src/shared/     Типы канала и схемы разбора. Импортируются всеми тремя
```

Поток данных односторонний: main читает JSONL, отдаёт события в рендерер по одному каналу;
рендерер отправляет обратно три сообщения — вердикт апрува, команду проигрывателя и запрос
на экспорт лога. Файл пишет main: у рендерера доступа к диску нет и не будет.

## Tech Stack

`electron-vite@5`, `electron-builder`, Electron 43, React 19, TypeScript 5.6, vitest 3,
Playwright (уже установлен для съёмки макета). Зависимости пакета остаются
`@mcpproxy/contracts` и `@mcpproxy/design`.

## Global Constraints

Скопированы из спеки и дополнены фактами строгости из таблицы 3.

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
  Последний означает, что каждый импорт типа пишется через `import type`.
- `module: NodeNext` — относительные импорты несут расширение `.js`.
- `lib: ["ES2023"]` без DOM. Рендерер расширяет `lib` своим tsconfig; главный и preload — нет.
- ESM в main, **CJS в preload**. Это не вкус: preload игнорирует поле `"type": "module"`,
  и именно это позволяет держать `sandbox: true`.
- `packages/core` не импортируется отсюда никогда.
- Необязательное поле в событии — отсутствующий ключ, не `null` и не пустой массив.
- Дайджесты — голый нижний регистр, 64 hex, без префикса.

---

## Pre-flight

### 1. Write path

**Удалена.** E7 не пишет ни одного поля ни в одну коллекцию: аудит односторонний, лог пишет
E6, приложение только читает. Единственная запись наружу — экспорт JSONL, который копирует
файл, уже лежащий на диске.

### 2. Consumers — для каждого символа, который план меняет

Меняется ровно один отгруженный символ.

| Symbol | Reader (`file:line`) | What that reader does with the value | Does the reader's test mock it? |
|---|---|---|---|
| `violationRole` | `packages/design/README.md:76` | перечисляет имя в списке экспортов, значение не читает | тестов у пакета нет вообще |

Паттерн: `grep -rn "violationRole" packages docs`, вывод целиком, за вычетом `node_modules`
и `dist`. Попаданий в коде — одно, и это само определение
(`packages/design/src/semantic.ts:98`). Остальные попадания — `README.md:76`, бандл этого рана
(`spec.md`, `research.md`, `mockup.html`) и таблица потребителей плана E0
(`docs/vibe-coding/27.08.2026-e0-contracts/plan.md:95`), где зафиксировано «тестов нет вообще».

**Параллельные ветки.** `WORK.md` запрещает пересечения по файлам между ветками волны 1.
На момент планирования живы воркtree `v2/e1-policy`, `v2/e2-validate`, `v2/e3-sandbox` и
`v2/e6-audit`; все четыре по таблице работ трогают `packages/core`, тогда как эта ветка
трогает `packages/desktop`, `packages/design` и `docs/`. Пересечение возможно ровно в двух
файлах — `packages/design/src/semantic.ts` и `docs/08-demo-scenarios.md`; перед слиянием
их надо перечитать, а не полагаться на разведение по каталогам.

Потребителей в исполняемом коде нет, поэтому расширение сигнатуры вторым аргументом никого
не ломает. Это установлено грепом, а не рассуждением: пакет `design` собран, но ещё никем
не потреблён — `packages/desktop/src/index.ts:1` пуст.

### 3. Infrastructure — по строке на пакет, который план трогает

| Package | Test command actually used | `setupFiles` | env forced by setup | app built per worker or per test | tsconfig strictness | ESLint severities that constrain the design |
|---|---|---|---|---|---|---|
| `@mcpproxy/desktop` | `yarn workspace @mcpproxy/desktop test` | нет | нет | не собирается: юниты бьют по чистым функциям и по фабрике настроек окна | наследует `tsconfig.base.json`; рендерер добавляет `lib: DOM` | ESLint в репозитории отсутствует |
| `@mcpproxy/design` | `yarn workspace @mcpproxy/design test` | нет | нет | не применимо | наследует базовый | ESLint отсутствует |
| `@mcpproxy/contracts` | `yarn workspace @mcpproxy/contracts test` | нет | нет | не применимо | наследует базовый | ESLint отсутствует |

Скрипты прочитаны в `package.json` каждого пакета перед записью команд. У `@mcpproxy/design`
и `@mcpproxy/desktop` скрипта `test` сегодня нет — Task 1 и Task 5 его заводят, поэтому
команда проверяется впервые в конце тех же задач, а не берётся на веру.

Корневой прогон — `yarn typecheck && yarn build && yarn test`, он обходит весь граф
воркспейса. Это существенно: правка `packages/design` ломает компиляцию `packages/desktop`,
и направление зависимости из путей не выводится.

Существующих тестовых файлов, в которые план дописывает утверждения, нет: все тесты E7 —
новые файлы. Таблица «какой слой поднимает существующий тест» поэтому пуста.

### 4. Runtime shape

**Удалена.** План не расширяет и не клонирует ни одного значения, пришедшего из загрузчика.
Единственные объекты, пересекающие границу, — разобранные из JSONL простые объекты и
литералы настроек; ни один не является инстансом класса или прокси.

Одна оговорка, которая делает эту таблицу неприменимой по другой причине: объекты, приходящие
**из** рендерера, спред запрещён не потому, что у них прототип, а потому что прототип у них
может быть **подконтролен атакующему** — см. премиссу P4.

### 5. Premises — каждое «потому что здесь верно X»

| Premise | The grep that establishes it | Quoted evidence | Every site where it holds | Decision at each site |
|---|---|---|---|---|
| P1. Необязательное поле события отсутствует как ключ | `sed -n '14,20p' packages/contracts/src/event.ts` | `**Необязательное поле отсутствует как ключ**, а не присутствует со значением `null`.` (`packages/contracts/src/event.ts:16`) | все фикстуры трейса; рендер команды; рендер стадий | фикстура не пишет ключ; рендер ветвится по наличию ключа, а не по истинности значения |
| P2. `violation` может повторяться в одном вызове | `grep -n "может повторяться" packages/contracts/src/domain.ts` | `/** Порядок в таймлайне. `violation` может повторяться. */` (`packages/contracts/src/domain.ts:27`) | свёрнутая полоса групп; список стадий | группа красится по худшему из повторов, а не по первому |
| P3. `destructiveHint` и `idempotentHint` значимы только при `readOnlyHint == false` | `sed -n '36,40p' packages/contracts/src/annotations.ts` | `// Оговорка спеки: `destructiveHint` и `idempotentHint` значимы только при` (`packages/contracts/src/annotations.ts:37`) | policy viewer, бейджи аннотаций | при `readOnlyHint: true` оба бейджа рисуются неприменимыми |
| P4. Объект из недоверенного содержимого проносит прототип через `contextBridge` | адвайзори GHSA-ff2p-hmqr-hxm4, проверено разведкой | «objects copied across the contextBridge boundary from untrusted content could carry an attacker-influenced prototype … despite context isolation being enabled» | оба входящих сообщения рендерера | разбор схемой на объект с нулевым прототипом; `Object.hasOwn` вместо чтения свойств |
| P5. `sandbox: none` красится опасным всегда | `grep -n "красится опасным" packages/design/README.md` | `- **`sandbox: none` красится опасным всегда**, включая баннер `.unsandboxed-banner`.` (`packages/design/README.md:89`) | баннер; бейдж режима в строке; стадия `build_profile` | все три получают роль `danger`, включая стадию, которая «успешно» ничего не применила |
| P6. И8 требует четырёх флагов и жёсткого CSP | `sed -n '98,102p' docs/02-architecture.md` | `` `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, жёсткий CSP.`` (`docs/02-architecture.md:100`) | фабрика настроек окна; оба окна — главное и окно апрува | одна фабрика на оба окна, тест читает результат фабрики |

`grep -rn "new BrowserWindow" packages` сегодня не даёт ни одного попадания: окон в репозитории
нет вовсе, поэтому «все места» для P6 — это места, которые создаёт этот план, а не найденные.

### 6. Ordered parameter

**Удалена.** Ни одно правило плана не ветвится по дате, индексу, версии или порогу.
Ближайший кандидат — `ChainVerification.brokenAt` — не порог, а точка: ветвление идёт по
дискриминанту `ok`, и именно поэтому сравнение с нулём здесь запрещено (см. таблицу 7).

### 7. Classifier outputs — когда план ветвится по возврату существующей функции

`violationRole(type, action)` после правки. Строки — все пять значений `ViolationType`
на обоих значениях `action`.

| Input in scope | Returned value | Branch taken | Surviving outcome / count |
|---|---|---|---|
| `network`, `denied` | `warn` | янтарь, слово «Отбито» | нарушение остаётся в панели, вызов не краснеет |
| `network`, `allowed` | `danger` | красный, слово «Прошло» | строка вызова получает роль `danger`, бейдж вердикта глушится |
| `file-read`, `denied` | `warn` | янтарь | как `network`/`denied` |
| `file-read`, `allowed` | `danger` | красный | как `network`/`allowed` |
| `file-write`, `denied` | `warn` | янтарь | — |
| `file-write`, `allowed` | `danger` | красный | — |
| `process`, `denied` | `warn` | янтарь | — |
| `process`, `allowed` | `danger` | красный | — |
| `mandatory-deny`, `denied` | `danger` | красный, слово «Отбито» | единственная пара, где отбитая попытка красная |
| `mandatory-deny`, `allowed` | `danger` | красный | — |

`ChainVerification` из `packages/contracts/src/event.ts` не участвует: он живёт за входом
`./audit`. Его две ветки:

| Input in scope | Returned value | Branch taken | Surviving outcome / count |
|---|---|---|---|
| цепочка цела | `{ ok: true }` | бейдж «самосогласована» + чеклист из трёх пунктов | ни одна запись не помечена |
| подделана запись №0 | `{ ok: false, brokenAt: 0 }` | бейдж «цепочка разошлась» | ветвление по `ok`; `brokenAt: 0` ложен как число и обязан не участвовать в условии |
| подделана запись №1102 | `{ ok: false, brokenAt: 1102 }` | бейдж разрыва + якорение списка | записи выше точки — штриховка «утверждать нельзя» |

### 8. Verified facts this plan is built on

**F1. `@mcpproxy/contracts` в корневом входе не имеет зависимостей, а `./audit` тянет
`node:crypto`.** Проверено чтением `packages/contracts/package.json`: `exports` объявляет
четыре входа, `dependencies` содержит `ajv`, `re2`, `yaml`, и все три нужны только входу
`./validate`. Следствие: рендерер импортирует корневой вход и ничего нативного не тянет;
`verifyChain` вызывается в main. Чего проверка **не** покрывает: она не доказывает, что
бандлер действительно вытрясет неиспользуемые ветки — это проверяется первой сборкой.

**F2. У `file:`-URL непрозрачный origin, сериализуемый строкой `"null"`.** Проба разведки:

```
file:///Users/x/app/index.html            origin "null", host ""
file://evil.example.com/Users/x/app/...   origin "null", host "evil.example.com"
```

Оба URL дают одинаковый origin при одинаковом pathname. Следствие: проверка отправителя по
origin в сборке на `loadFile()` не проверяет ничего, и схема `app://` становится несущей, а
не удобством. Чего проба **не** покрывает: она выполнена парсером Node, а он не знает, что
схема стандартная; итоговое значение для `app://` обязано проверяться в рендерере.

**F3. `.btn-danger` ссылался на несуществующую переменную.** Проверено запуском:
`grep -n "brand" packages/design/dist/css/tokens.css` объявляет `--brand`, а не `--brand-base`,
потому что генератор схлопывает ключ `base` в имя группы. Уже исправлено в этом ране —
`packages/design/src/css/base.css:109` теперь читается `  background: var(--brand);`.

**F4. Белый на брендовом красном даёт 3.86:1.** Посчитано по формуле WCAG для `#FFFFFF` на
`#FF1B2D`. Ниже порога AA для 14px. Следствие: кнопка «Разрешить» красится `.btn-primary`,
и это совпадает с правилом, записанным в `packages/design/src/palette.ts:17`.

**F5. `--text-tertiary` даёт 4.01:1 на `--bg-surface` в тёмной теме.** Посчитано там же.
Следствие: данные (длительности, время, хэши) не живут на этом токене.

**F6. `ASSUMED` — точное имя файла preload при принудительном CJS.** Разведка оставила это
открытым и сказала, что вопрос закрывается запуском за десять минут. Task 1 закрывает его
первой сборкой и записывает результат сюда же. Ревьюерам атаковать это первым.

**F7. `ASSUMED` — виртуализация таймлайна не нужна.** Арифметика: 13 стадий на вызов,
демо-трейс порядка десятков вызовов. Порог не измерен, потому что мерить нечего до первой
сборки. Если профиль покажет иное, это правка Task 7, а не архитектуры.

### 9. Поток данных — по строке на каждую полезную нагрузку

Этой таблицы не было три раунда, и пять блокеров из одиннадцати в последнем — прямые
следствия её отсутствия: тип объявлялся без отправителя, отправитель без источника,
поверхность без маршрута. Списки `Files` каждой задачи выводятся отсюда, а не наоборот.

| Полезная нагрузка | Производит | Вариант канала | Потребляет | Источник |
|---|---|---|---|---|
| `ChainedEvent` | `src/main/player.ts` | `UiEvent` · `trace-event` | `src/shared/call.ts` → `CallList`, `CallDetail` | `fixtures/trace-seatbelt.jsonl`, `fixtures/trace-none.jsonl` |
| `PlayerState` | `src/main/player.ts` | `UiEvent` · `player-state` | `Chrome.tsx` — кнопка паузы и позиция | состояние проигрывателя |
| `ChainVerification` + счётчик | `src/main/chain.ts` | `UiEvent` · `chain` | `AuditView.tsx` через `shared/chainBadge.ts` | пересчёт по загруженному трейсу |
| `PolicyRow[]` | `src/main/policy.ts` | `UiEvent` · `policy` | `PolicyView.tsx` через `registers.ts` | `fixtures/policy.json` |
| `LockDiff` | `src/main/policy.ts` | `UiEvent` · `lock-diff` | `LockDiffModal.tsx` через `diffSlots.ts` | `fixtures/lockdiff.json` |
| `ApprovalRequest` | `src/main/approvals.ts` | `UiEvent` · `approval-request` | `ApprovalInbox.tsx`, `ApprovalWindow.tsx` | `fixtures/approvals.json` |
| `RequestId` закрытого запроса | `src/main/approvals.ts` | `UiEvent` · `approval-closed` | `ApprovalInbox.tsx` | решение человека либо отказ по умолчанию |
| `ApprovalVerdict` | `ApprovalWindow.tsx` | `UiRequest` · `approval-verdict` | `src/main/approvals.ts` | ввод человека |
| `PlayerCommand` | `Chrome.tsx` | `UiRequest` · `player-command` | `src/main/player.ts` | ввод человека |
| запрос экспорта | `AuditView.tsx` | `UiRequest` · `export-log` | `src/main/export.ts` | — |

Три следствия, которые из таблицы видны сразу и которых план не имел:

- **`ApprovalRequest` из трейса не выводится.** `packages/contracts/src/approval.ts:57` требует
  `requestId` и `argsHash`; `AuditEvent` не несёт ни того, ни другого, а `ApprovalRecord`
  появляется только **после** решения, то есть ожидающий запрос им непредставим. Нужна
  отдельная фикстура.
- **`PolicyRow` и `LockDiff` из событий не выводятся тоже** — событие несёт только
  `recipe.name` и `recipe.hash`. Отсюда `src/main/policy.ts`, которого в плане не было.
- **`PlayerState` и `PolicyRow` объявляются в `shared/`**, а не в `main/` и `renderer/`.
  Иначе `shared/channel.ts` импортирует из обоих, а рендерер через него транзитивно
  импортирует `main` — ровно тот запрет, который план формулирует для `PlayerCommand` и
  дважды не применил к соседям.

---

## Tasks

### Task 1 — тулчейн, окно и четыре флага

Реализует `R1`, `R55`.

**Files:**
- Create: `packages/desktop/electron.vite.config.ts`
- Create: `packages/desktop/tsconfig.main.json`
- Create: `packages/desktop/tsconfig.renderer.json`
- Create: `packages/desktop/vitest.config.ts`
- Create: `packages/desktop/src/main/index.ts`
- Create: `packages/desktop/src/main/window.ts`
- Create: `packages/desktop/src/preload/index.ts`
- Create: `packages/desktop/src/renderer/index.html`
- Create: `packages/desktop/src/renderer/main.tsx`
- Modify: `packages/desktop/package.json`
- Delete: `packages/desktop/src/index.ts`
- Test: `packages/desktop/src/main/window.test.ts`

**Interfaces.** Настройки окна выносятся в чистую фабрику, чтобы их можно было прочитать
тестом без запуска Electron:

```ts
export type WindowRole = 'main' | 'approval';

export function webPreferencesFor(role: WindowRole, preload: string): Electron.WebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    preload,
  };
}
```

`spellcheck: false` — не косметика. Проверка орфографии включена по умолчанию и тянет
словари **из главного процесса по сети**, то есть мимо CSP рендерера. Окно апрува по `R41`
содержит текстовое поле, в которое человек набирает опасный токен, — это ровно то место,
где оно бы сработало. Чек-лист приватности спеки утверждает, что данные машину не покидают;
пока `spellcheck` по умолчанию включён, это утверждение ложно.

Путь к preload — вход, а не вычисление внутри. Ценность фабрики в том, что четыре флага
читаются как данные без запуска Electron; композиция с резолвом раскладки сборки эту
читаемость обнуляет, а имя эмитированного файла план сам помечает `ASSUMED` в F6.

**Шаги.**

1. `yarn workspace @mcpproxy/desktop add -D electron electron-vite electron-builder` и
   `add react react-dom`. Версии закрепить точно: разведка нашла, что Electron 42 и выше
   больше не скачивает бинарь на установке, поэтому после установки нужен явный
   шаг доустановки бинаря, иначе `electron-vite` падает с `Error('Electron uninstall')`.
   Точное имя команды — `ASSUMED`: разведка зафиксировала появление отдельного бина, но не
   его вызов, и это закрывается первой установкой.
2. `electron.vite.config.ts`: три сборки. В сборке preload задать
   `build.rollupOptions.output.format` равным `cjs` **и `entryFileNames` равным
   `'[name].cjs'`**. Одного `format` мало: расширение определяет `entryFileNames`, а его
   `electron-vite` выводит из поля `"type": "module"` пакета, которое здесь остаётся ради
   ESM в main. Файл `.mjs` с CJS-содержимым Electron грузит как ESM, а ESM-preload требует
   `sandbox: false` — единственное, чем этот продукт торговать не может. Расширение
   закрепляется конструкцией, а не наблюдается после сборки. В `build.target` задать цель
   явно — таблица версий `electron-vite` кончается на Electron 39 и промах молча отдаёт
   последнюю запись, то есть `chrome108`.
3. Разделить tsconfig: главный и preload остаются на `lib: ["ES2023"]`, рендерер добавляет
   `DOM` и `DOM.Iterable`, `"jsx": "react-jsx"` и объявление модуля для
   `@mcpproxy/design/css` — при `moduleResolution: NodeNext` спецификатор CSS иначе не
   резолвится. Ссылки на `../contracts` и `../design`, живущие сегодня в
   `packages/desktop/tsconfig.json`, обязаны остаться в том под-конфиге, который
   компилирует TS, иначе граф проекта рвётся. Корневой конфиг пакета становится ссылочным.
4. `window.ts` с фабрикой выше. Обе роли окна ходят через неё; путь к preload резолвится
   в `main/index.ts`, где Electron и так присутствует.
5. `main/index.ts` создаёт главное окно из фабрики.
6. Удалить заглушку `packages/desktop/src/index.ts`, снять её из `exports` пакета и задать
   `main` — точку входа собранного главного процесса. Каталог `fixtures/` попадает в сборку,
   а путь к нему резолвится от `app.getAppPath()`, а не относительно исходников: в
   упакованном виде исходников рядом нет.
7. Переписать скрипты пакета: `build` — `electron-vite build`, `test` — `tsc -b && vitest run`
   (префикс обязателен: корневой прогон идёт `-Ap`, без топологии, а тесты десктопа читают
   `dist` пакета `design`, который Task 5 меняет — так же защищается `contracts`),
   `typecheck` — `tsc -b --noEmit false --emitDeclarationOnly`, ровно как у соседних пакетов.
   Форма `tsc -b --noEmit` в этом репозитории падает с `TS6310`: ссылочный проект не имеет
   права отключать эмит, а `contracts` и `design` его не отключают. Сегодня `build` это `tsc -b`, а `test` отсутствует
   вовсе, поэтому корневой `yarn build` собирал бы типы вместо приложения, а `yarn test`
   молча пропускал бы пакет — и проверки трёх задач оказались бы пусто-зелёными.
8. Обновить раздел F6: расширение теперь закреплено `entryFileNames`, и факт перестаёт быть
   `ASSUMED` по построению, а не по наблюдению.

**Falsification:** утверждение — `expect(webPreferencesFor(role, '/p')).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, preload: '/p' })`,
прогнанное `it.each` по обоим значениям `WindowRole`. Именно `toEqual`, а не `toMatchObject`:
второй игнорирует лишние ключи, и добавленный позже `webviewTag: true` прошёл бы молча.
Оба окна обязательны: премисса P6 объявляет гарантию для главного окна и окна апрува,
а Task 13 переиспользует ту же фабрику — послабление по роли иначе осталось бы незамеченным.
Заменить `sandbox: true` на `sandbox: false` в `window.ts` → оба случая расходятся.
Тест в Node, Electron не запускается: фабрика чистая.

**Проверка:** `yarn workspace @mcpproxy/desktop test` и `yarn build` из корня.

**Коммит:** «E7: оболочка Electron; четыре флага И8 читаются тестом, а не соглашением».

### Task 2 — схема `app://`, CSP, запрет навигации

Реализует `R3`, `R9`, `R10`, `R55`.

**Files:**
- Create: `packages/desktop/src/main/protocol.ts`
- Create: `packages/desktop/src/main/csp.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Test: `packages/desktop/src/main/csp.test.ts`

**Interfaces.**

```ts
export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

export const APP_SCHEME_PRIVILEGES: Electron.Privileges = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
};

export function cspFor(mode: 'development' | 'production', nonce: string): string;
```

**Шаги.**

1. Зарегистрировать схему через `registerSchemesAsPrivileged` с константой
   `APP_SCHEME_PRIVILEGES` — **до `app.whenReady()`**, тогда как `protocol.handle`
   вызывается после. Перепутанный порядок — самый частый способ сломать ровно эту связку. Origin выводится из схемы и хоста, а не повторяется вторым
   литералом: два независимых источника одного значения расходятся молча.
   `corsEnabled` обязателен: `supportFetchAPI` без него — это CVE-2026-70604. `standard`
   обязателен отдельно: без него отключены `localStorage` и относительные ссылки
   разрешаются как у `file:`, что ломает пути `/assets/` из сборки.
2. `protocol.handle` читает файл сборки, генерирует nonce на каждый ответ и подставляет его
   и в заголовок, и в `<meta property="csp-nonce">`, который читает рантайм Vite.
3. Отгружать **один** механизм доставки CSP — заголовок. Статического `<meta>` с политикой
   в `index.html` нет: заголовок и `meta` пересекаются, и забытый `meta` молча ужесточает
   политику.
4. `cspFor` задаёт `base-uri`, `form-action` и `frame-ancestors` явно — от `default-src`
   они не наследуются. Ни `unsafe-eval`, ни `unsafe-inline` не появляются ни в одном режиме.
5. Ветка режима — по `NODE_ENV`, не по `app.isPackaged`: собранное приложение под e2e идёт
   с `isPackaged` равным false и получило бы мягкую политику в единственной автоматической
   проверке, которая вообще поднимает настоящий рендерер.
6. `will-navigate` и `setWindowOpenHandler` отклоняют всё, и вешаются на единую точку
   `app.on('web-contents-created')`, которую заводит эта же задача. Обработчики,
   привешенные к главному окну, не покрыли бы окно апрува из Task 13.
7. **Обработчик схемы резолвит запрошенный путь, берёт `realpath` и отклоняет всё, что не
   под корнем сборки, возвращая 404.** Стандартная схема нормализует точечные сегменты в
   URL, но `%2e%2e%2f` доживает до обработчика, и любое декодирование перед чтением с диска
   открывает обход. Инвариант И3 этого же проекта говорит, что проверка «строка не содержит
   `..`» защитой не является; применить его к демону и не применить к собственному
   загрузчику рендерера — ровно тот случай, когда UI продукта становится аргументом против
   его же тезиса.
8. **Режим разработки назван явно.** Рендерер в dev грузится с `http://localhost:5173`, где
   обработчик схемы `app://` не выполняется вовсе — значит, dev-ветка `cspFor` была бы
   мёртвым кодом, а `senderRejection` отклонял бы каждое сообщение, потому что origin там
   другой. Решение: в dev множество принимаемых origin расширяется адресом dev-сервера, а
   CSP в dev доставляется тем же способом через dev-middleware и разрешает `connect-src`
   на веб-сокет HMR. Одно решение, из которого выводятся и доставка политики, и множество
   принимаемых origin.

**Falsification:** первое утверждение — `expect(cspFor('production', 'n0')).not.toMatch(/unsafe-(eval|inline)/)`
и второе — `expect(cspFor('production', 'n0')).toMatch(/frame-ancestors 'none'/)`. Убрать
директиву `frame-ancestors` из `cspFor` → второе падает, первое остаётся зелёным, то есть
тест различает две независимые ошибки.

Третье, на обход путей: `expect(resolveBundlePath('/%2e%2e/%2e%2e/etc/passwd')).toBe(null)`.
Убрать проверку вхождения в корень сборки → функция вернёт путь наружу, и утверждение
расходится. Тесты в Node: обе функции чистые, файловая система нужна только для `realpath`,
и корень подставляется аргументом.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: схема app:// вместо file://, у которого origin непрозрачен».

### Task 3 — граница IPC

Реализует `R4`, `R5`, `R6`, `R7`, `R8`, `R55`.

**Files:**
- Create: `packages/desktop/src/shared/channel.ts`
- Create: `packages/desktop/src/shared/result.ts`
- Create: `packages/desktop/src/shared/parse.ts`
- Create: `packages/desktop/src/shared/playerCommand.ts`
- Create: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Test: `packages/desktop/src/main/ipc.test.ts`
- Test: `packages/desktop/src/shared/parse.test.ts`

**Interfaces.**

```ts
export type UiErrorCode =
  | 'sender-absent'
  | 'sender-detached'
  | 'sender-subframe'
  | 'sender-origin'
  | 'sender-window'
  | 'bad-payload';

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: UiErrorCode; readonly message: string } };

export const UI_CHANNEL = 'mcpproxy.ui/1';

export type UiRequest =
  | { readonly kind: 'approval-verdict'; readonly verdict: ApprovalVerdict }
  | { readonly kind: 'player-command'; readonly command: PlayerCommand }
  | { readonly kind: 'export-log' };

export type UiEvent =
  | { readonly kind: 'trace-event'; readonly event: ChainedEvent }
  | { readonly kind: 'player-state'; readonly state: PlayerState }
  | { readonly kind: 'chain'; readonly verification: ChainVerification; readonly total: number }
  | { readonly kind: 'policy'; readonly rows: readonly PolicyRow[] }
  | { readonly kind: 'lock-diff'; readonly diff: LockDiff | null }
  | { readonly kind: 'approval-request'; readonly request: ApprovalRequest }
  | { readonly kind: 'approval-closed'; readonly requestId: RequestId };
```

Направление main→renderer до этой ревизии типа не имело вовсе, хотя по нему ходят шесть
разных полезных нагрузок: события трейса, состояние проигрывателя, результат проверки
цепочки, строки политики, дифф lock и запросы апрува. Тот же диагноз, который план поставил
экспорту — «механизма не существовало», — относился и к ним, просто менее заметно: не
хватало не канала, а формы.

`UiEvent` объявлен здесь же, в `shared/`, и импортируется обеими сторонами через
`import type`.

```ts
export type TrackId = 'seatbelt' | 'none';

export interface PlayerState {
  readonly track: TrackId;
  readonly position: number;
  readonly total: number;
  readonly playing: boolean;
}

export type PlayerCommand =
  | { readonly kind: 'step' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'play'; readonly speed: number }
  | { readonly kind: 'reset' }
  | { readonly kind: 'select-track'; readonly track: TrackId };
```

`PlayerCommand` объявляется в `src/shared/playerCommand.ts`, а не в `src/main/player.ts`.
Иначе `shared/channel.ts` ссылался бы на модуль, который создаёт следующая задача, — тайпчек
Task 3 падал бы, а её коммит был бы красным. Починить это импортом из `main` нельзя: строка
архитектуры запрещает рендереру импортировать из `main`, а `shared` импортирует рендерер.

`code` — закрытый union, а не `string`. Каждый дискриминатор в контрактах закрыт
(`LockStatus`, `Verdict`, `Stage`, `ApprovalDecision`), и именно это делает возможным
исчерпывающий `switch` и тест на опечатку в литерале. Четыре причины отказа отправителю
— это четыре независимых атаки, и сваливать их в один код значит лишить тест возможности
сказать, какая проверка сработала.

`UiRequest` — настоящий размеченный union, как отгруженный `LockCheck`, а не тег рядом с
нетипизированным мешком: тег, который ничего не сообщает о полезной нагрузке, не покупает
никакой типовой безопасности.

Имя `IpcRequest` здесь не используется: оно занято границей shim↔демон
(`packages/contracts/src/ipc.ts:70`), и переиспользование слило бы два разных периметра
безопасности в одно имя.

```ts
export interface SenderFacts {
  readonly detached: boolean;
  readonly parent: unknown;
  readonly origin: string;
}

export function senderRejection(
  frame: SenderFacts | null,
  allowedOrigins: ReadonlySet<string>,
): UiErrorCode | null {
  if (frame === null) return 'sender-absent';
  if (frame.detached) return 'sender-detached';
  if (frame.parent !== null) return 'sender-subframe';
  if (!allowedOrigins.has(frame.origin)) return 'sender-origin';
  return null;
}

export interface Sender {
  readonly frame: SenderFacts | null;
  readonly webContentsId: number;
}

export function guarded<T>(
  run: (payload: unknown, sender: Sender) => Result<T> | Promise<Result<T>>,
  allowedOrigins: ReadonlySet<string>,
): (event: Electron.IpcMainInvokeEvent, payload: unknown) => Result<T> | Promise<Result<T>> {
  return (event, payload) => {
    const frame = event.senderFrame;
    const sender = { frame, webContentsId: event.sender.id };
    const rejection = senderRejection(frame, allowedOrigins);
    return rejection === null ? run(payload, sender) : denied(rejection);
  };
}
```

`senderRejection` берёт структурный тип, а не `WebFrameMain`: так каждую ветку можно
проверить литералом, не подделывая `IpcMainInvokeEvent`.

Три вещи в этой сигнатуре — следствия, а не украшения.

`allowedOrigins` — параметр, потому что в dev рендерер грузится с адреса dev-сервера
(Task 2, шаг 8), и жёсткая сверка с единственной константой отклоняла бы там каждое
сообщение. Множество известно при запуске и от запроса не зависит.

`Sender` передаётся обработчику, потому что тождество окна структурно невидимо
`senderRejection`: оба окна грузятся с одного origin, и различает их только
`webContents.id`. Обработчик вердикта сверяет его с окном апрува и отклоняет кодом
`sender-window` (Task 13, шаг 9).

Возврат допускает промис, потому что `dialog.showSaveDialog` асинхронен, а обработчик
экспорта по правилу Task 3 обязан жить внутри `ipc.ts`. Это безопасно: `senderFrame`
читается **до** вызова `run`, то есть до любого `await`.

```ts
export function parseVerdict(payload: unknown): Result<Omit<ApprovalVerdict, 'channel'>>;
export function parsePlayerCommand(payload: unknown): Result<PlayerCommand>;
```

`ApprovalVerdict` — это `requestId`, `sessionId`, `channel`, `decision`, `scope`,
`expiresAt` (`packages/contracts/src/approval.ts:73`). Поля `recipeName` там **нет**, и
конструктор `asRecipeName` к нему отношения не имеет.

Брендируются два поля — `requestId` и `sessionId` — через `asRequestId` и `asSessionId`,
а брошенное конструктором превращается в конверт `{ ok: false }`. Приведение
`as ApprovalVerdict` запрещено: `packages/contracts/src/approval.ts:52` объявляет, что
брендирование делает подстановку `sessionId` вместо `requestId` ошибкой компиляции, и
приведение на границе стёрло бы ровно ту гарантию, ради которой существует `R43`.

Остальные четыре поля брендов не имеют и потому нуждаются в проверке значений, а не типов:

- `channel` **не парсится вовсе** — main перезаписывает его значением `'electron'`.
  Единственный, кто знает, каким каналом человек ответил, — это main; принять это поле от
  рендерера значит позволить ему записать ложь в append-only лог аудита.
- `decision` — закрытый союз из двух значений, и именно он решает, запустится ли
  `publish_release`.
- `scope` — закрытый союз из трёх; непроверенный расширяет грант за пределы показанного.
- `expiresAt` — строка ISO либо `null`, и непустой ровно тогда, когда `scope` равен
  `'until'`. При `exactOptionalPropertyTypes` различие отсутствия и `null` несущее.

`unwrap` — тестовый помощник, сужающий конверт до значения: обращаться к `.value` напрямую
`strict` не даёт, потому что у ветки `ok: false` этого поля нет.

`parsePlayerCommand` отдельно ограничивает `speed`: конечное число в закрытом диапазоне.
Неограниченное число из рендерера уезжает прямо в таймер, и модель угроз, где рендерер
считается компрометируемым, покупала бы главному процессу занятый цикл.

`const frame = event.senderFrame` — **первый оператор**. Геттер ленивый и заново резолвит
фрейм в момент обращения, поэтому любой `await` перед ним обнуляет значение; типы Electron
перевели его в `WebFrameMain | null` именно из-за этого.

**Шаги.**

1. `result.ts` и `channel.ts` — общие типы, без зависимостей.
2. `parse.ts` экспортирует `sanitize(value: unknown): Record<string, unknown>` — **мелкую**
   копию на объект с нулевым прототипом, — и поверх неё парсеры вердикта и команды. Мелкой
   её хватает ровно потому, что обе полезные нагрузки плоские; тест это фиксирует, чтобы
   третье сообщение с вложенным объектом не проехало границу на прежней гарантии. Чтение полей
   только через `Object.hasOwn`. Типы здесь не защита: они стираются, а объект из
   недоверенного содержимого проносит подконтрольный прототип через `contextBridge`
   даже при включённой contextIsolation. Брендированные идентификаторы восстанавливаются
   конструкторами, а не приведением.
3. `ipc.ts` — обёртка `guarded` и регистрация трёх обработчиков через неё: вердикт апрува,
   команда проигрывателя, запрос на экспорт лога.
4. preload экспонирует один замороженный объект с именованными методами — `sendVerdict`,
   `sendCommand`, `requestExport`, `onEvent`. `ipcRenderer` наружу не отдаётся ни целиком,
   ни отдельным методом.
5. **Входящее направление тоже сужается.** `ipcRenderer.on` отдаёт слушателю
   `IpcRendererEvent`, несущий `sender` и `ports`; preload обязан его отбросить и передать
   рендереру только полезную нагрузку. Иначе весь хардненинг исходящего направления
   обходится с другой стороны моста. Это и есть тот набор методов, который проверяет
   Task 15, шаг 3.
6. Обработчики возвращают `Result`, а не бросают: через `ipcMain.handle` наружу проходит
   только свойство `message`, а `contextBridge` срезает пользовательские поля `Error`.
7. Тест-страж запрещает голые `ipcMain.handle` и `ipcMain.on`: читает исходники `src/main`
   и падает на вызове вне `ipc.ts`. Обеспечение структурное, а не линтерное — единственный
   плагин с таким правилом имеет одного мейнтейнера и в своей же документации признаёт, что
   проверяет факт защиты, а не её корректность.

**Falsification:** первое утверждение — `it.each` по пяти случаям
`senderRejection`: `expect(senderRejection(null, ORIGINS)).toBe('sender-absent')`,
`expect(senderRejection({ detached: true, parent: null, origin: APP_ORIGIN }, ORIGINS)).toBe('sender-detached')`,
`expect(senderRejection({ detached: false, parent: {}, origin: APP_ORIGIN }, ORIGINS)).toBe('sender-subframe')`,
`expect(senderRejection({ detached: false, parent: null, origin: 'file://' }, ORIGINS)).toBe('sender-origin')`
и `expect(senderRejection({ detached: false, parent: null, origin: APP_ORIGIN }, ORIGINS)).toBe(null)`,
где `ORIGINS` — множество из одного `APP_ORIGIN`.
Удалить любую одну проверку из `senderRejection` → расходится ровно один случай, и он
называет, какая защита исчезла. Прежняя формулировка сваливала три причины в один код,
и удаление проверки на подфрейм оставляло все утверждения зелёными.

Второе — `expect(Object.getPrototypeOf(sanitize(polluted))).toBe(null)` вместе с
`expect(Object.hasOwn(sanitize(polluted), 'isAdmin')).toBe(false)`: проверяется
объявленное свойство, а не симптом, потому что обход цепочки прототипов матчером —
деталь его реализации, и безопасность границы не может на ней держаться.

Третье — `it.each` по полям вердикта: `expect(parseVerdict({ ...verdict, requestId: '' }).ok).toBe(false)`,
`expect(parseVerdict({ ...verdict, decision: 'maybe' }).ok).toBe(false)`,
`expect(parseVerdict({ ...verdict, scope: 'forever' }).ok).toBe(false)`,
`expect(parseVerdict({ ...verdict, expiresAt: 'вчера' }).ok).toBe(false)` и
`expect(unwrap(parseVerdict(verdict))).not.toHaveProperty('channel')` — последнее
удерживает то, что канал не приходит снаружи. Убрать проверку `decision` → строка `'maybe'`
проезжает границу и решает судьбу `publish_release`. Одного утверждения про пустой
`requestId` было мало: оно не покрывало ни одно из четырёх небрендированных полей.

Четвёртое — `expect(parsePlayerCommand({ kind: 'play', speed: Infinity }).ok).toBe(false)`.

Все тесты в Node: `senderRejection` берёт структурный литерал, настоящий фрейм не нужен.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: граница IPC — конверты вместо исключений, senderFrame до любого await».

### Task 4 — свёртка вызовов, проигрыватель и фикстуры

Реализует `R11`, `R12`, `R13`, `R58`.

**Files:**
- Create: `packages/desktop/src/shared/call.ts`
- Create: `packages/desktop/src/main/player.ts`
- Create: `packages/desktop/src/main/trace.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Create: `packages/desktop/fixtures/trace-seatbelt.jsonl`
- Create: `packages/desktop/fixtures/trace-none.jsonl`
- Create: `packages/desktop/fixtures/policy.json`
- Create: `packages/desktop/fixtures/lockdiff.json`
- Create: `packages/desktop/fixtures/approvals.json`
- Create: `packages/desktop/scripts/build-fixtures.mjs`
- Create: `packages/desktop/src/main/policy.ts`
- Create: `packages/desktop/src/main/approvals.ts`
- Create: `packages/desktop/src/main/export.ts`
- Test: `packages/desktop/src/shared/call.test.ts`
- Test: `packages/desktop/src/main/trace.test.ts`
- Test: `packages/desktop/src/main/player.test.ts`

**Interfaces.**

**Свёртка — недостающее звено.** `AuditEvent` описывает **одну стадию**: он несёт один
`stage`, одну `durationUs` (`packages/contracts/src/event.ts:83` — длительность стадии) и
собирается в вызов только по `traceId` и `spanId` (`packages/contracts/src/event.ts:71`).
Пока такой свёртки нет, ни «худший исход в группе», ни «каких стадий не было», ни «команда
не собиралась» вычислить не из чего: все три — свойства вызова, а не события. Ровно на этом
месте четыре задачи из четырнадцати опирались на функцию, которой не существует.

```ts
import type { ChainedEvent, Stage, Verdict } from '@mcpproxy/contracts';

export interface Call {
  readonly traceId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly verdict: Verdict;
  readonly stages: readonly ChainedEvent[];
  readonly reached: ReadonlySet<Stage>;
  readonly open: boolean;
}

export function foldCalls(events: readonly ChainedEvent[]): readonly Call[];
```

Правила свёртки заданы явно, иначе три поля из семи остались бы на усмотрение реализующего:

- `stages` **сортируются** по позиции в `stageOrder`, а при равенстве — по `startTime`.
  Хранить «как пришло» нельзя: проигрыватель отдаёт события по одному, порядок прихода не
  гарантирован, а `R17` требует стадии по порядку, `stagePresence` — знания о достигнутом,
  `commandView.stoppedAt` — последней достигнутой стадии.
- `verdict` берётся из **последнего** события вызова по этому же порядку: вердикт вызова —
  его исход, а не вердикт промежуточной стадии.
- `startedAt` — `startTime` события стадии `received`.
- `open` истинно, пока вызов не завершён **и** не отказан: нет ни события `complete`, ни
  вердикта `denied` или `error`. Вызов, остановленный на `validate`, до `complete` не
  доходит никогда, и правило «нет `complete` — значит открыт» держало бы его в списке
  ждущих вечно. `pending_approval` остаётся открытым — он действительно ждёт.
- Вызовы сортируются по `startedAt` убыванием.

`stages` хранит события как есть, а не выжимку: `violation` может повторяться
(`packages/contracts/src/domain.ts:27`), и схлопывание потеряло бы повторы вместе с
контрастом сценария S5. `reached` — множество, потому что вопрос «дошёл ли вызов до стадии»
задают чаще, чем «какая стадия была N-й». `open` отличает вызов, ждущий продолжения, от
завершённого: проигрыватель отдаёт события по одному, и половина вызовов на экране всегда
незакончена.

```ts
import type { ChainedEvent } from '@mcpproxy/contracts';

export interface Player {
  readonly apply: (command: PlayerCommand) => void;
  readonly state: () => PlayerState;
}

export function createPlayer(
  tracks: Readonly<Record<TrackId, readonly ChainedEvent[]>>,
  emit: (event: ChainedEvent) => void,
): Player;

export function readTrace(text: string): Result<readonly ChainedEvent[]>;
```

`PlayerCommand`, `PlayerState` и `TrackId` объявлены в `src/shared/playerCommand.ts`
(Task 3) и здесь только используются.

Ключ — `TrackId`, а не `traceId` из контракта. Это принципиально: `traceId`
(`packages/contracts/src/event.ts:71`) идентифицирует **вызов**, и `foldCalls` сворачивает
по нему. Ключевать дорожки им означало бы либо слить seatbelt и none в один вызов из
двадцати шести стадий, либо признать, что «тот же вызов» — риторика. Дорожка это запись
прогона, вызовы внутри неё сохраняют свои `traceId`.

Приёмник событий — аргумент, а не спрятанный внутри модуля побочный эффект: иначе тип
умалчивает, куда уходят события, и позиция оказывается сплавлена с транспортом в одном
модуле. `state()` существует, потому что без запроса ни рендерер не нарисует правильную
кнопку паузы, ни тест не проверит, что пауза остановила выдачу.

**Шаги.**

1. `trace.ts` разбирает JSONL построчно, пустые строки пропускает, битую строку отдаёт
   диагностикой в конверте, а не бросает.
2. `player.ts` держит позицию и отдаёт события в приёмник по одному. Шаг, пауза, скорость,
   сброс — одной командой из размеченного union, а не четырьмя методами: команда едет
   через IPC, и её всё равно пришлось бы разбирать как данные. Тот же механизм — и моки,
   и демо со сцены, и план Б, если ядро упадёт: поток событий на сцене не стримят вживую,
   а воспроизводят под управлением клавиши.
3. Две дорожки трейса покрывают сценарии S1–S9. Формы полей берутся из
   `packages/contracts/src/event.ts:42`; ключ `argv` у вызова, остановленного на `lock_check`,
   **отсутствует**, а не приезжает пустым массивом.
4. Хотя бы одно событие несёт `protocolVersion` старой ревизии: значение принадлежит сессии,
   а не сборке, и UI не имеет права его захардкодить.
5. `fixtures/policy.json` и `fixtures/lockdiff.json` — вторая пара фикстур, без которой
   два экрана не имеют источника данных. Policy viewer показывает колонку «обеспечено
   прокси», которой в `Tool` нет вовсе (`packages/contracts/src/tool.ts:16` — имя, схемы и
   аннотации, никаких осей песочницы и никакого тира). Права живут в нормализованном
   рецепте, тир считает `deriveRiskTier`. Модалка расхождения lock рисует `LockDiff`, а он
   требует и манифест, и lock-файл, тогда как событие несёт только `recipe.name` и
   `recipe.hash` (`packages/contracts/src/event.ts:86`).

   Фикстуры политики, диффа и очереди апрувов кладутся **уже нормализованными**, в JSON.
   Получить из них `NormalizedRecipe` и `LockDiff` можно только через `parseManifest` и
   `parseLockFile`, которые живут за входом `@mcpproxy/contracts/validate` и тянут `yaml`,
   `ajv` и нативный `re2`. Тащить это в приложение ради моков значит противоречить факту
   F1, чей смысл в том, что E7 обходится корневым входом.
6. Проигрыватель создаётся в `main/index.ts` при запуске, а его команда регистрируется
   обработчиком в `ipc.ts`. Без этих двух правок проигрыватель существует как модуль и не
   работает как механизм.
7. Дорожек две — `trace-seatbelt.jsonl` и `trace-none.jsonl`, — и переключатель режима
   отправляет `{ kind: 'select-track' }`. Подмена выделенной строки выглядела бы так же, но
   доказывала бы другое, а S5 держится ровно на том, что команда и её параметры одни и те
   же. Макет подменяет выделение, потому что проигрывателя не имеет; `R58` требует, чтобы
   приложение так не делало, и в приложении смена дорожки меняет весь список, панель
   нарушений и счётчики — а не одну выделенную строку.
8. **Генератор фикстур считает цепочку хэшей.** `chain.self` обязан удовлетворять
   `chainHash(unchain(event), prev)`; написанные руками хэши сделали бы демо-трейс
   постоянно «разошедшимся» — на сцене. Скрипт берёт `chainHash` из
   `@mcpproxy/contracts/audit`, гоняется в сборке фикстур, и его вывод коммитится.
9. **`main/policy.ts` читает `policy.json` и `lockdiff.json` и отправляет их варианты
   канала**; **`main/approvals.ts` читает `approvals.json`**, отправляет `approval-request`
   и закрывает запрос по вердикту либо по отказу; **`main/export.ts`** обслуживает экспорт.
   Без этих трёх модулей четыре варианта `UiEvent` не имеют отправителя, а три фикстуры —
   ни одного читателя.

**Falsification:** первое утверждение — `expect(Object.hasOwn(lockCheckEvent, 'argv')).toBe(false)`.
Дописать `argv: []` в фикстуру остановленного вызова → утверждение расходится, и это ловит
ровно тот дефект, из-за которого UI отрисовал бы выдуманную пустую команду настоящей.

Второе — `expect(readTrace('{ broken').ok).toBe(false)`.

Третье, на свёртку: `expect(foldCalls(shuffled).map((c) => c.traceId)).toEqual(foldCalls(ordered).map((c) => c.traceId))`
при перемешанном порядке прихода, и `expect(call.stages.filter((e) => e.stage === 'violation')).toHaveLength(2)`
на вызове с двумя нарушениями. Свернуть по `spanId` вместо `traceId` → события одного вызова
расползаются по разным вызовам, и оба утверждения расходятся.

Четвёртое, на проигрыватель: `emit` подменяется собирающим массивом, и
`expect(collected).toHaveLength(1)` после одного `step`, затем
`expect(player.state().position).toBe(1)`. Убрать инкремент позиции → второе утверждение
расходится, тогда как первое остаётся зелёным, то есть тест различает две независимые
ошибки. Пятое — шаг за последним событием: `expect(collected).toHaveLength(total)`
после лишнего `step`. Все тесты в Node, IPC не нужен: приёмник — обычная функция.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: проигрыватель трейса — один механизм под моки, демо и фикстуры».

### Task 5 — правки дизайн-системы

Реализует `R51`, `R52`, и закрывает `R50`, сделанный ранее в этом ране.

**Files:**
- Modify: `packages/design/src/semantic.ts`
- Modify: `packages/design/README.md`
- Modify: `packages/design/package.json`
- Test: `packages/design/src/semantic.test.ts`

Русские подписи домена живут здесь и только здесь: `packages/design/src/semantic.ts:15`
объявляет это своей единственной задачей, и пакет уже отгружает `verdictLabel`,
`stageLabel`, `violationLabel`, `sandboxLabel`. Чеканить новые русские слова в
`packages/desktop/src/renderer/` значит развести таблицу подписей по двум пакетам.

**Interfaces.**

```ts
export function violationRole(type: ViolationType, action: 'denied' | 'allowed'): Role {
  if (type === 'mandatory-deny') return 'danger';
  return action === 'denied' ? 'warn' : 'danger';
}
```

Было — `Readonly<Record<ViolationType, Role>>` (`packages/design/src/semantic.ts:98`).
Строки, идущие до и после, — комментарий-разделитель `/* ── Нарушения песочницы ── */`
выше и `violationLabel` ниже; ни один из них не трогается. Локалей, которые определение
использовало, нет: это был литерал.

**Шаги.**

1. Заменить запись-константу функцией с двумя аргументами. Роль нарушения зависит и от
   типа, и от исхода: `network` при `denied` — янтарь, песочница отбила; тот же `network`
   при `allowed` — красный, данные ушли. Это и есть содержание сценария S5, и отгруженная
   версия его не выражает.
2. `mandatory-deny` остаётся красным на обоих исходах: отбито успешно, но сама попытка
   записи в persistence-путь означает, что код пытался закрепиться.
3. Завести пакету скрипт `test` — сегодня его нет, и первый же тест пакета не запустился бы.
   Добавить `vitest` в его `devDependencies`.
4. Добавить союз `CallOutcome` и подпись `outcomeLabel` по **всем пяти** его значениям: `blocked` → «Отбито», `passed` → «Прошло», `denied` → «Отказано»,
   `awaiting` → «Ждёт подтверждения», `clean` → «Выполнено». Союз объявляется здесь, потому
   что `desktop` зависит от `design`, а не наоборот, и второе его объявление в рендерере
   стало бы вторым источником одного значения. Покрыть два значения из пяти
   означало бы, что остальные три всё равно чеканятся в рендерере — то есть правило,
   с которого эта задача начинается, нарушается ею же.

   Подписи осей политики и «не применимо» сюда **не** переезжают: это копия одного экрана
   одного потребителя, и толкать её в пакет, от которого зависят другие эпики, — расширение
   объёма. В `design` живут отображения доменного значения в слово; экранная копия —
   заголовки, пустые состояния, вся проза окна апрува, чеклист цепочки — остаётся
   в `desktop`, где она и есть.
5. Существующий JSDoc про `mandatory-deny` — записанное WHY, а не украшение — переезжает
   на функцию и дополняется новой осью `action`. Он объясняет единственное исключение из
   правила «отбито значит янтарь», и потерять его при переписывании записи в функцию
   означало бы потерять причину.
6. `README.md`: заголовок «Четыре роли, а не три» неверен, и таблица под ним тоже.
   `packages/design/src/semantic.ts:27` объявляет **шесть** значений `Role`; таблица
   перечисляет пять, опуская `muted`, который реально используется в бейджах. Число берётся
   из типа, а не из таблицы — иначе одно неверное число меняется на другое. Плюс строка 73
   обещает `stageOrder` из этого пакета, тогда как он живёт в
   `packages/contracts/src/domain.ts:28`.

**Falsification:** утверждение — `expect(violationRole('network', 'allowed')).toBe('danger')`.
Вернуть старое поведение, игнорирующее `action`, → функция отдаёт `warn`, утверждение
расходится, и вместе с ним ломается ровно то различие, ради которого продукт существует.
Второе — `expect(violationRole('mandatory-deny', 'denied')).toBe('danger')`, оно
удерживает исключение от первого правила. Тест в Node.

**Проверка:** `yarn workspace @mcpproxy/design test`, затем `yarn build` из корня — правка
экспорта `design` ломает компиляцию `desktop`, и это должно всплыть здесь, а не в PR.

**Коммит:** «E7: роль нарушения зависит от исхода, а не только от типа».

### Task 6 — каркас приложения

Реализует `R45`, `R46`, `R47`, `R48`.

**Files:**
- Create: `packages/desktop/src/renderer/App.tsx`
- Create: `packages/desktop/src/renderer/Chrome.tsx`
- Create: `packages/desktop/src/renderer/Nav.tsx`
- Create: `packages/desktop/src/renderer/theme.ts`
- Create: `packages/desktop/src/renderer/strings.ts`
- Modify: `packages/desktop/src/renderer/main.tsx`
- Test: `packages/desktop/src/renderer/strings.test.ts`

**Шаги.**

1. Импортировать `@mcpproxy/design/css` — reset, токены и базовые классы приходят готовыми.
   Ни одного шестнадцатеричного значения в коде E7 не появляется.
2. Оболочка: логотип, переключатель режима песочницы, баннер `unsandboxed-banner` при `none`.
3. Навигация из пяти разделов — таймлайн, нарушения, политика, апрувы, аудит; активный
   получает брендовый красный индикатор, одно из трёх мест, где этот цвет вообще разрешён.
   Раздел апрувов — инбокс из `R57`, поверхность отдельная от authoritative-окна.
4. Тема: явный выбор побеждает системный в обе стороны, через атрибут `data-theme`.
5. Кольцо фокуса не переопределяется нигде.
6. **Вся экранная проза живёт в одном модуле `strings.ts`**, и это обеспечивается
   структурно, как запрет голых `ipcMain.*` в Task 3: тест сканирует `src/renderer` и падает
   на кириллическом литерале в любом файле, кроме `strings.ts`. Проверка «строки модуля
   встречаются в макете» в одиночку бесполезна: она ничего не говорит про файл, который
   захардкодил строку мимо модуля, а это и есть отказ, от которого `R49` защищает.

   Составные предложения макет собирает из шаблонов (`«${violationLabel[type]}: ${target}»`),
   и целиком в файле их нет. Поэтому `strings.ts` хранит **шаблоны**, а сверка с макетом
   идёт по их постоянным фрагментам, а не по готовым предложениям. Подписи доменных значений
   остаются в `@mcpproxy/design` и сюда не дублируются: правило про один модуль относится к
   экранной прозе, а не к отображениям домена в слово.

**Falsification:** первое утверждение — `expect(cyrillicOutsideStrings(rendererSources)).toEqual([])`.
Захардкодить русскую строку в `CallList.tsx` → файл попадает в список и утверждение
расходится; односторонняя сверка с макетом этот отказ пропускала. Второе —
`expect(missingFromMockup(STRING_FRAGMENTS, mockupText)).toEqual([])`. Тесты в Node.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: каркас на токенах дизайн-системы, без единого хекса».

### Task 7 — таймлайн, список вызовов

Реализует `R15`, `R16`, `R22`, `R24`.

**Files:**
- Create: `packages/desktop/src/renderer/timeline/CallList.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Create: `packages/desktop/src/renderer/timeline/groupBar.ts`
- Create: `packages/desktop/src/renderer/timeline/callLine.ts`
- Create: `packages/desktop/src/shared/stageGroup.ts`
- Test: `packages/desktop/src/renderer/timeline/callLine.test.ts`

**Interfaces.**

`StageGroup` и отображение стадии в группу живут в `src/shared/stageGroup.ts`: контракты
заморожены и группировки не несут, а `@mcpproxy/design` по решению Task 5 хранит отображение
доменного значения в **слово**, а не в другое доменное значение.

```ts
import type { Call } from '../../shared/call.js';
import type { StageGroup } from '../../shared/stageGroup.js';

export interface CallLine {
  readonly role: Role;
  readonly outcome: CallOutcome;
  readonly detail: string;
  readonly sandbox: SandboxMode | null;
  readonly verdictMuted: boolean;
}

export function callLine(call: Call): CallLine;
export function groupBar(call: Call): ReadonlyArray<{ group: StageGroup; role: Role }>;
```

Аргумент — `Call` из Task 4, а не `AuditEvent`. Событие описывает одну стадию, и вывести
из него «худший исход в группе стадий» невозможно: свернуть по `traceId` обязана свёртка,
а не функция отрисовки строки.

`CallOutcome` импортируется из `@mcpproxy/design`, где Task 5 объявляет его вместе с
`outcomeLabel`: объявить тот же союз здесь второй раз значило бы завести два независимых
источника одного значения — ровно то, что Task 2 осуждает по имени в шаге 1.

Полей два, потому что осей две. `outcome` — исход вызова; `verdictMuted` — отдельное
решение о том, что бейдж вердикта глушится, когда нарушение прошло насквозь. Одним полем
это не выражается: вызов при этом остаётся разрешённым, и новость не в вердикте.
`sandbox` — режим для бейджа в строке, `null` у вызова, не дошедшего до `spawn`.

Чистые функции возвращают доменные значения, а не готовые русские слова: подпись берётся
из `@mcpproxy/design` на отрисовке. Группы именованы, потому что позиция в массиве ничего
не называет, а при `noUncheckedIndexedAccess` обращение по индексу к укороченному массиву
даёт `undefined` вместо осмысленного падения.

**Шаги.**

1. Строка вызова: имя, бейдж вердикта, **бейдж режима песочницы**, время. Без режима в
   строке два соседних вызова сценария S5 отличаются одним словом, и зал не видит разницы.
2. Строка диспозиции начинается словом «Отбито» или «Прошло» — оно переживает усечение и
   читается раньше цвета. Слово «Отказано» занято вердиктом вызова: поставить его рядом с
   бейджем «разрешено» значит написать противоречие.
3. Когда нарушение прошло насквозь, бейдж вердикта глушится: вердикт вызова и исход
   песочницы — разные оси, и зелёное «разрешено» не имеет права быть самым ярким пятном на
   строке катастрофы.
4. Иконка роли рядом с цветом — избыточный канал: янтарь и красный это ровно та пара,
   которую путают протанопы и дейтеранопы.
5. Свёрнутая полоса из трёх групп, каждая по худшему исходу внутри себя. Стадии, которых
   в записи нет, не рисуются.
6. Скелет повторяет геометрию наполненной строки бокс в бокс, иначе подгрузка даёт скачок
   вёрстки; пустое состояние отдельным текстом.

**Falsification:** первое утверждение — `expect(callLine(leakedCall).outcome).toBe('passed')`.
Убрать учёт `action` из `callLine` → исход становится `blocked` на вызове, где 1247 байт
ушло наружу, и утверждение расходится. Второе —
`expect(groupBar(mixedCall).find((g) => g.group === 'execution')?.role).toBe('danger')`;
вернуть выбор первого нарушения вместо худшего → группа красится янтарём. Поиск по имени
группы, а не по индексу: индекс не называет, какая из трёх групп проверяется, и молча
съезжает, когда группа не нарисована. Оба теста в Node над чистыми функциями: DOM не нужен,
потому что решение о роли принимается до отрисовки.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: строка вызова несёт режим песочницы — без него S5 не читается».

### Task 8 — детали вызова

Реализует `R17`, `R18`, `R19`, `R20`, `R21`.

**Files:**
- Create: `packages/desktop/src/renderer/timeline/CallDetail.tsx`
- Create: `packages/desktop/src/renderer/timeline/StageList.tsx`
- Create: `packages/desktop/src/renderer/timeline/MachineText.tsx`
- Create: `packages/desktop/src/renderer/timeline/commandView.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/timeline/CallList.tsx`
- Test: `packages/desktop/src/renderer/timeline/commandView.test.ts`

**Interfaces.**

```ts
import type { Call } from '../../shared/call.js';

export type CommandView =
  | { readonly kind: 'built'; readonly argv: readonly string[]; readonly fromParams: readonly string[] }
  | { readonly kind: 'not-built'; readonly stoppedAt: Stage };

export function commandView(call: Call): CommandView;
export function stagePresence(call: Call): ReadonlyArray<{ stage: Stage; present: boolean }>;
```

Аргумент — `Call`. На `AuditEvent` `commandView` возвращала бы `not-built` для событий
`received`, `lock_check`, `validate` и `resolve_paths` **успешного** вызова, потому что
`argv` впервые появляется только на `build_argv`. Утверждение из прежней формулировки
проходило бы на любом событии до этой стадии и не доказывало ничего.

`MachineText` — отрисовка машинных фрагментов: путей, регексов, хэшей и элементов argv
моноширинным и без переноса по словам. Имя называет, что именно рисуется; предыдущее имя
не называло ничего.

**Шаги.**

1. Секции: вызов, причина отказа (если есть), команда, стадии, редакция.
2. Причина отказа — отдельный заметный блок, а не строка в конце: требование просит точную
   причину, а перечисление несостоявшихся стадий по площади больше неё.
3. Команда: подсвечивается **происхождение**, а не позиция — выделено то, что подставлено
   из параметров вызова. Роли состояний на подсветку не тратятся: синий значит «ждём
   человека», а не «это аргумент».
4. Вызов без ключа `argv` рисует объяснение «команда не собиралась», а не пустую команду.
5. Стадии, которых не было, перечислены отдельной строкой: пользователь должен отличать
   «прошло мгновенно» от «до стадии не дошло». Ноль длительности рисуется прочерком.
6. Пути, регексы и argv внутри деталей стадии рисуются через `MachineText` — моноширинным
   и без переноса по словам: разорванный аргумент читается как два разных, а кириллическая
   «а» в `--flаg` пропорциональным шрифтом неотличима от латинской.
7. Оверхед берётся из `duration.overheadMs` события `complete`, а не считается в UI.
   Множество исключённых стадий — часть определения метрики
   (`packages/contracts/src/event.ts:149`), и второе его определение неизбежно разъедется.
8. Поля деталей кликабельны и работают фильтром по списку. Состояние фильтра и выбранного
   вызова живёт в `App.tsx` и передаётся обеим панелям: без общего состояния клик в правой
   панели не может изменить левую, и `R21` остался бы рисунком.

**Falsification:** утверждение — `expect(commandView(lockCheckCall).kind).toBe('not-built')`
вместе с `expect(commandView(successfulCall).kind).toBe('built')`. Второе обязательно:
без него реализация, всегда отвечающая `not-built`, прошла бы первое.
Заменить `Object.hasOwn(argvEvent, 'argv')` на проверку истинности `argvEvent.argv?.length` →
вызов, остановленный на `lock_check`, и вызов с пустым `argv` становятся неразличимы, и
`commandView` возвращает `built` с пустой командой; утверждение расходится. Это ровно тот
дефект, ради предотвращения которого написана премисса P1, и без этого теста план проверял
бы, что **фикстура** не пишет ключ, оставляя **читателю** свободу ветвиться по истинности.
Второе — `expect(stagePresence(lockCheckCall).find((x) => x.stage === 'spawn')?.present).toBe(false)`
при том, что стадия с нулевой длительностью даёт `present: true`: «прошло мгновенно» и
«до стадии не дошло» обязаны различаться. Тесты в Node над чистыми функциями.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: детали вызова; отсутствие стадии — факт, а не ноль».

### Task 9 — панель нарушений

Реализует `R23`, `R25`, `R26`.

**Files:**
- Create: `packages/desktop/src/renderer/violations/ViolationsPanel.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`

**Шаги.**

1. Строка: тип, цель, объём, время, режим песочницы вызова. Формулировка — «стучался на
   evil.io:443, отказано, 0 байт», а не «сеть запрещена».
2. Роль строки — из `violationRole(type, action)` после правки Task 5.
3. Легенда учитывает собственное исключение: «янтарь — отбито · красный — прошло **или
   попытка закрепиться**». Без этой оговорки экран, существующий ради различения янтаря и
   красного, опровергается двумя своими первыми строками.
4. Пустая панель — и есть положительный индикатор. Бейджа «всё чисто» нет: зелёный значок
   читают как гарантию, которой он не даёт.

**Проверка:** `yarn build` из корня.

**Коммит:** «E7: панель нарушений; пустота и есть положительный индикатор».

### Task 10 — policy viewer

Реализует `R27`, `R28`, `R29`, `R30`, `R31`.

**Files:**
- Create: `packages/desktop/src/renderer/policy/PolicyView.tsx`
- Create: `packages/desktop/src/renderer/policy/registers.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Test: `packages/desktop/src/renderer/policy/registers.test.ts`

**Interfaces.**

```ts
import type { NormalizedRecipe, RiskTier, Tool } from '@mcpproxy/contracts';

export type PolicyAxis = 'network' | 'write' | 'read';

export interface Register {
  readonly axis: PolicyAxis;
  readonly claimed: string;
  readonly enforced: string;
  readonly diverges: boolean;
  readonly defaulted: boolean;
}

export interface PolicyRow {
  readonly tool: Tool;
  readonly effective: NormalizedRecipe;
  readonly tier: RiskTier;
}

export function registers(row: PolicyRow): Readonly<Record<PolicyAxis, Register>>;
```

`Tool` один эту таблицу не выдаёт: `packages/contracts/src/tool.ts:16` объявляет имя,
схемы и аннотации — ни осей песочницы, ни тира, ни человеческого предложения. Заявленная
сторона считается из аннотаций, обеспеченная — из нормализованного рецепта, тир — из
`deriveRiskTier`. Источник обеих — пара фикстур манифеста и lock из Task 4.

Ключ — доменное значение, а не русское слово. Подпись оси берётся из
`@mcpproxy/design`; если ключом сделать отображаемую строку, переименование слова в
интерфейсе молча ломает вычисление расхождения. Возврат — запись, а не массив: поиск по
несуществующей оси обязан падать, а не отдавать `undefined` в `?.diverges`.

**Шаги.**

1. Карточка инструмента: имя, риск-тир, **одно предложение по-человечески**. Сжатие
   манифеста в человеческую фразу и есть содержание экрана.
2. Два регистра на **одних осях** — сеть, запись, чтение: «заявлено манифестом» против
   «обеспечено прокси». Exec-строка против списка прав — две разные вещи в одной таблице,
   сравнивать нечего.
3. Расхождение регистров подсвечивается. Спека MCP требует считать аннотации недоверенными,
   и расхождение — ровно то, ради чего эти два столбца существуют.
4. Молчание манифеста показывается как «да» с пометкой «по умолчанию»: нейтральное
   «не задано» здесь фактическая ошибка.
5. При `readOnlyHint: true` бейджи `destructiveHint` и `idempotentHint` рисуются
   неприменимыми — оговорка спеки уже записана в
   `packages/contracts/src/annotations.ts:37`.
6. Рецепт с `*` в домене или с ослабляющим флагом помечается «ослабленный режим».

**Falsification:** первое утверждение — `expect(registers(analyzeLogs).network.diverges).toBe(true)`.
Убрать учёт молчащих аннотаций → заявленное станет «нет», расхождения не будет, утверждение
расходится. Второе — `expect(badges(analyzeLogs).destructiveHint).toBe('not-applicable')`;
убрать ветку `readOnly` → бейдж вернётся к `true`, что противоречит оговорке спеки,
записанной в `packages/contracts/src/annotations.ts:37`. Оба сравнения — с доменными
значениями, а не с русскими словами: тест не должен ломаться от правки подписи.
Тесты в Node над чистыми функциями.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: policy viewer; заявленное и обеспеченное на одних осях».

### Task 11 — аудит и проверка цепочки

Реализует `R14`, `R32`, `R33`, `R34`, `R35`.

**Files:**
- Create: `packages/desktop/src/main/chain.ts`
- Create: `packages/desktop/src/shared/chainBadge.ts`
- Create: `packages/desktop/src/renderer/audit/AuditView.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/main/ipc.ts`
- Test: `packages/desktop/src/shared/chainBadge.test.ts`

**Шаги.**

1. `chain.ts` в main вызывает `verifyChain` из входа `@mcpproxy/contracts/audit` и отдаёт
   в рендерер готовый `ChainVerification`. Функция тянет `node:crypto`, которому в
   песочничном бандле рендерера места нет.
2. Бейдж **называет механизм и якорь, а не выносит вердикт**: «самосогласована · N записей ·
   без внешнего якоря». Слово «tamper-proof» не употребляется нигде.
3. Раскрытие — чеклист выполненных проверок, включая ту, которая **не** выполнялась:
   усечение хвоста лога этой проверкой не обнаруживается.
4. Ветвление строго по полю `ok`. Подделка первой записи даёт `brokenAt: 0`, который ложен
   как число, и условие по нему прошло бы обе ветки.
5. При разрыве список якорится к точке разрыва и показывает её саму. Записи выше отделены
   штриховкой и подписью «утверждать нельзя» — «непроверяемое» и «подделанное» это разные
   утверждения.
6. **Список аудита рисует окно, а не весь лог.** Виртуализация не нужна таймлайну, где
   вызовов десятки, но лог — это тысячи записей, и факт F7 про него молчал. Окно якорится
   либо на `brokenAt`, либо на хвост.
7. **Экспорт JSONL — третий канал, а не строка из двух слов.** Кнопка живёт в рендерере, а
   запись файла возможна только в main, поэтому появляется обработчик `export-log` с
   `dialog.showSaveDialog` в main. Архитектурная строка «ровно два сообщения» и шаг 3
   Task 3 правятся на три: они были написаны раньше, чем экспорт получил механизм, и
   остались бы прямым противоречием плана самому себе.

**Interfaces.**

```ts
import type { ChainVerification } from '@mcpproxy/contracts/audit';

export function chainBadge(verification: ChainVerification, total: number): {
  readonly status: 'consistent' | 'broken';
  readonly brokenAt: number | null;
  readonly verifiedThrough: number;
};
```

Функция живёт в `shared/`, а не в `main/`: её результат потребляет `AuditView.tsx`, а
рендереру запрещено импортировать из `main`. В `main` остаётся только вызов `verifyChain`.

`ChainVerification` объявлен в `packages/contracts/src/audit/chain.ts:45`, а не в
`event.ts`, и в рендерер он приходит **только** через `import type`: при
`verbatimModuleSyntax` такой импорт стирается, а значимый затащил бы `node:crypto` в
песочничный бандл — ровно тот провал, ради предотвращения которого написан факт F1.

`total` — аргумент, потому что `ChainVerification` числа записей не несёт, и строка
«самосогласована · N записей» из него невыводима.

Имя называет то, что функция делает: она возвращает описание бейджа и исполняется в Node
без DOM. `render` и соврало бы про это, — а `render` соврало бы и про это,
и про то, что функция как-то связана с отрисовкой.

**Falsification:** утверждение — `expect(chainBadge(verifyOf(forgedFirstEntry), 1284).status).toBe('broken')`.
Заменить ветвление `if (!verification.ok)` на `if (verification.brokenAt)` → подделка
записи №0 даёт `brokenAt: 0`, ложный как число, экран показывает «самосогласована» на
сломанной цепочке, и утверждение расходится. Тест в Node: `verifyChain` — чистая функция
над массивом.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: бейдж цепочки называет механизм и якорь, а не выносит вердикт».

### Task 12 — модалка расхождения lock

Реализует `R36`, `R37`, `R38`.

**Files:**
- Create: `packages/desktop/src/renderer/lock/LockDiffModal.tsx`
- Create: `packages/desktop/src/renderer/lock/diffSlots.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Test: `packages/desktop/src/renderer/lock/diffSlots.test.ts`

**Interfaces.**

```ts
import type { LockDiff, NormalizedRecipe } from '@mcpproxy/contracts';

export type DiffSlot = 'added' | 'removed' | 'changed' | 'defaults';

export interface SlotView {
  readonly slot: DiffSlot;
  readonly rows: ReadonlyArray<{ name: string | null; was: string | null; is: string | null }>;
}

export function diffSlots(diff: LockDiff): ReadonlyArray<SlotView>;
```

`changed[].was` и `changed[].is` — целые `NormalizedRecipe`, а не строки, поэтому «дифф
целиком и без усечения» это настоящая функция сериализации, а не деталь JSX. `name`
допускает `null`: слот `defaults` — одна безымянная пара «было/стало», и выдумывать ей имя
значило бы врать в столбце. Источник
данных — пара фикстур манифеста и lock из Task 4: событие несёт только `recipe.name` и
`recipe.hash`, никакого `LockDiff` в нём нет.

**Шаги.**

1. Четыре раздельных слота: добавлено, удалено, изменено, изменены значения по умолчанию.
   Одна правка `defaults` не должна размножаться по всем рецептам.
2. Пустые слоты показываются явно, а не скрываются: отсутствие изменений — тоже сведение.
3. Дифф целиком, без усечения. Усечение здесь равносильно обману.
4. Дифф красится нейтрально, маркерами. Зелёное «прошло штатно» на строке, из-за которой
   рецепт и заблокирован, — прямая ложь.
5. Основное действие — «Оставить запрет». Безопасный исход не может быть вторичным.
6. Это **не** окно апрува: дрейф lock не риск-тир, и поверхности не смешиваются.

**Falsification:** утверждение — `expect(diffSlots(defaultsOnlyDiff).find((s) => s.slot === 'changed')?.rows).toHaveLength(0)`
при непустом слоте `defaults`. Схлопнуть правку значений по умолчанию в изменения рецептов
→ одна правка `defaults` размножается по всем рецептам модалки, и утверждение расходится.
Второе — `expect(diffSlots(diff).map((s) => s.slot)).toEqual(['added', 'removed', 'changed', 'defaults'])`: все четыре слота
присутствуют всегда, включая пустые, потому что «ничего не добавлено» — тоже сведение.
Тесты в Node над чистой функцией.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: дифф lock; безопасный исход — основное действие».

### Task 13 — окно подтверждения и инбокс

Реализует `R39`, `R40`, `R41`, `R42`, `R43`, `R44`, `R49`, `R57`, `R59`.

**Files:**
- Create: `packages/desktop/src/main/approvalWindow.ts`
- Create: `packages/desktop/src/renderer/approval/ApprovalWindow.tsx`
- Create: `packages/desktop/src/renderer/approval/confirmToken.ts`
- Create: `packages/desktop/src/renderer/approval/ApprovalInbox.tsx`
- Create: `packages/desktop/src/shared/approvalScope.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Test: `packages/desktop/src/renderer/approval/confirmToken.test.ts`
- Test: `packages/desktop/src/shared/approvalScope.test.ts`

**Interfaces.**

```ts
export interface ConfirmChallenge {
  readonly token: string;
  readonly typed: string;
}

export function confirmState(challenge: ConfirmChallenge): {
  readonly approve: 'blocked' | 'ready';
  readonly deny: 'ready';
};
```

Один запрос вместо двух предикатов. Мгновенность отказа выражена типом: `deny` не имеет
второго значения, поэтому «отказ не советуется с набранным» — факт сигнатуры, а не
поведение, которое реализующий обязан не сломать. Пара `token` и `typed` названа: она
ходила бы вместе по двум сигнатурам без имени, а это и есть признак недостающего понятия.

**Шаги.**

1. Отдельный `BrowserWindow` через ту же фабрику настроек из Task 1. Смысл механизма в том,
   что канал не проходит через модель, поэтому это окно, а не модалка основного окна.
2. Команда целиком, по элементу на строку, с номерами позиций. Горизонтальный скролл
   означал бы, что подтвердить можно, не увидев хвоста.
3. Команда — в основном тексте, не за раскрытием: «показать детали» кликают единицы
   процентов, то есть детали за раскрытием эквивалентны их отсутствию.
4. Разрешение требует набрать опасный токен из самого argv; вставка отключена. **Отказ
   мгновенный** — набор нужен только чтобы разрешить. Подсказка не печатает сам токен,
   иначе ритуал превращается в чистое трение.
5. Ширина гранта — один контрол с тремя значениями, а не две независимые оси. Срок показывается абсолютным временем, и
   строка пересчитывается от выбранного значения: у варианта «до конца вызова» таймера нет,
   и печатать рядом с ним конкретное время значит учить неверному.
6. **«Разрешить» красится `.btn-primary`, и это осознанное исключение из правила Task 12.**
   Там основным сделан безопасный исход, здесь — опасный. Разница в тормозе: здесь им служит
   не ранг кнопки, а ритуал — разрешение требует набрать токен из команды, отказ мгновенен.
   Ранжировать вдобавок и кнопку значило бы штрафовать дважды за одно, а правило цвета
   записано в
   `packages/design/src/palette.ts:17` и называет «Одобрить» дословно; вдобавок белый на
   брендовом красном даёт 3.86:1.
7. Вердикт несёт и `requestId`, и `sessionId` (`packages/contracts/src/approval.ts:73`).
   Без `requestId` сообщение из рендерера может одобрить не тот ожидающий вызов, который
   человеку показали.
8. **Отказ по умолчанию — код, а не декларация.** Если окно создать не удалось, main сам
   синтезирует `decision: 'denied'` и закрывает запрос. Прежняя формулировка повторяла
   требование вместо того, чтобы его реализовать.
9. **Обработчик вердикта требует тождества окна.** Оба окна грузятся с одного origin, делят
   один preload и один канал, поэтому проверки origin недостаточно: скомпрометированный
   рендерер главного окна отправил бы вердикт, неотличимый от нажатия человека. Обработчик
   дополнительно требует, чтобы `event.sender.id` совпадал с `webContents.id` открытого
   окна апрува, и отклоняет вердикт, когда окна нет, отдельным кодом. Без этого отдельное
   окно даёт представление, а не полномочие, — то есть ADR-0005 остаётся невыполненным.
10. **Инбокс** — список ожидающих запросов отдельной поверхностью, из которой открывается
    authoritative-окно. Строка эпика называет его среди поверхностей E7, и это не то же
    самое, что окно: окно решает по одному запросу, инбокс показывает очередь. Слить их
    значило бы сделать рутинную поверхность authoritative — ровно та ошибка, из-за которой
    93% запросов разрешения одобряются не глядя.
11. Каждая строка окна берётся из макета дословно.

**Ширина гранта — один выбор из трёх, а не произведение двух осей.**
`packages/contracts/src/approval.ts:20` объявляет три **взаимоисключающие** ширины: `once`
— только этот вызов, `until` — до `expiresAt`, `recipe_and_args` — для этого рецепта с этим
же `argsHash`. Две независимые оси «область × срок» читались бы лучше и пришли из prior art,
но союз их не выражает: «только этот вызов на десять минут» пришлось бы отобразить в
`until`, выбросив ограничение области и **выдав грант шире показанного человеку**. Пять из
шести сочетаний оказались бы лоссовыми, а E5 ключует разрешения именно по этому полю.

Поэтому окно предлагает ровно три варианта — те же три, что уже перечисляет S8:

| Выбор в окне | `scope` | `expiresAt` |
|---|---|---|
| разрешить один раз | `once` | `null` |
| на 10 минут | `until` | ISO, момент выдачи плюс десять минут |
| всегда для этого рецепта и этого хэша аргументов | `recipe_and_args` | `null` |

Макет приведён к этому же виду. Расширить союз четвёртым значением возможно, но это правка
замороженных контрактов, от которых зависит E5, — то есть решение владельца, а не автора
экрана.

**Falsification:** утверждение — `expect(confirmState({ token: 'v2.4.0', typed: 'v2.4.1' }).approve).toBe('blocked')`.
Заменить сравнение на проверку непустоты → любой набранный текст разблокирует разрешение,
и утверждение расходится. Второе — `expect(confirmState({ token: 'v2.4.0', typed: 'v2.4.0' }).approve).toBe('ready')`,
оно отделяет «блокирует всегда» от «блокирует до совпадения»: без него реализация
`return { approve: 'blocked', deny: 'ready' }` прошла бы первое утверждение. Мгновенность
отказа тестом не проверяется, потому что она выражена типом.

Третье, на ширину гранта: `it.each` по трём вариантам —
`expect(toScope('once')).toEqual({ scope: 'once', expiresAt: null })`,
`expect(toScope('recipe_and_args').expiresAt).toBeNull()` и
`expect(toScope('until', now).expiresAt).toBe(new Date(now + 600_000).toISOString())`. Отобразить
«на 10 минут» в `once` → грант перестаёт истекать, и третье утверждение расходится;
отобразить «один раз» в `until` → появляется срок там, где человек его не выбирал.
Тесты в Node, момент выдачи передаётся аргументом.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: окно апрува; набрать токен, чтобы разрешить, отказать — сразу».

### Task 14 — правки документации и покрытие

Реализует `R53`, `R54`, `R60`.

**Files:**
- Modify: `docs/08-demo-scenarios.md`
- Modify: `docs/vibe-coding/27.08.2026-e7-ui/spec.md`

**Шаги.**

1. S2 говорит «таймлайн из 13 стадий» и перечисляет одиннадцать. **Правится число, а не
   список.** S2 — это happy path `run_tests`, где `approval` и `violation` действительно не
   происходят, и дописать их значило бы вписать в документацию ложь, прямо противоречащую
   шагу 5 Task 7 этого же плана: «стадии, которых в записи нет, не рисуются». Становится
   «11 из 13 возможных стадий». Прежняя формулировка правила доку в сторону, обратную
   правильной.
2. Там же — две формулировки, запрещённые требованиями этой спеки: S8 предлагает
   «на 10 минут» относительным сроком, тогда как `R42` и ADR-0005 требуют абсолютного
   времени истечения; S9 называет бейдж «цепочка верифицирована» — ровно тот вердикт,
   который `R32` запрещает, и ровно та формулировка, из-за которой бейдж обещает больше,
   чем механизм даёт.
3. Находка разведки о тайминге демо уже записана в `research.md` и остаётся там до E9, где
   принимается решение о режиссуре: владелец решил не трогать её в этом ране.
4. **Поправить `R42` и `R59` в спеке.** Оба написаны в расчёте на две независимые оси
   «область × срок», взятые из prior art, а замороженный `ApprovalScope` выражает ширину
   одним значением из трёх. Требование, которому реализация обязана противоречить, — дефект
   спеки, а не реализации, и оставить его ради зелёной таблицы покрытия значит соврать в
   таблице. `R42` сужается до абсолютного времени истечения, которое и было её содержанием;
   выбор ширины описывается тремя значениями.

   Расширить союз четвёртым значением ради ортогональности возможно, но это правка
   замороженных контрактов, от которых зависит E5, — **решение владельца**, и оно выносится
   ему отдельно, а не принимается здесь.
5. Формулировка «на 10 минут» в S8 при этом **остаётся**. Запрещён относительный срок в
   записи аудита и там, где показан срок действия, — а не подпись на контроле, рядом с
   которой стоит абсолютное время истечения. Прежняя редакция шага смешивала эти два случая
   и требовала выкинуть строку, которую макет ставит правильно.
6. Дописать в спеку таблицу покрытия: по строке на каждое `R1`–`R60` с пометкой
   реализовано, частично или нет. Частично и нет блокируют PR.

**Проверка:** `yarn typecheck && yarn build && yarn test` из корня.

**Коммит:** «E7: правки доков и таблица покрытия требований».

### Task 15 — смоук-тест собранного приложения

Реализует `R2`, `R55`, и закрывает открытые хвосты фактов F1, F2 и F6.

**Files:**
- Create: `packages/desktop/src/e2e/smoke.test.ts`
- Modify: `packages/desktop/package.json`
- Modify: `e2e/browser/shot-mockup.mjs`

**Зачем отдельной задачей.** Шестнадцать тестовых файлов плана исполняют чистые функции в Node, и
**ни один не запускает Electron**. Для продукта, чей питч — хардненинг Electron, это
неверное место границы между «дёшево» и «правда». Конкретно: `R2` требует читать
`webPreferences` **созданного окна**, а тест фабрики её не читает — вызов
`new BrowserWindow({ webPreferences: { ...webPreferencesFor(role, p), sandbox: false } })`
проходит все остальные тесты этого плана. Тот же класс риска в Task 3 закрыт структурно,
сканированием исходников; И8 заслуживает не меньшего, потому что именно про него сказано
«провалить всё».

**Шаги.**

1. Тест пишется как **vitest-тест**, импортирующий `_electron` из `playwright`, а не как
   спека Playwright-раннера: `@playwright/test` в зависимостях нет, а файл `*.spec.ts` по
   умолчанию подхватился бы `vitest run` и сломал бы прогон каждого пакета. Файл лежит под
   `src/e2e/`, и в `packages/desktop/vitest.config.ts` (заводится в Task 1) добавляется
   отдельный проект, чтобы юниты и смоук гонялись раздельно. `es-module-lexer` добавляется
   в `devDependencies` пакета — шаг 6 им пользуется, а сегодня его в десктопе нет.
2. **`R2` доказывается структурно, а не пробником.** Пробник изнутри страницы
   (`typeof require === 'undefined'` и соседи) здесь не работает: при `contextIsolation: true`
   и `nodeIntegration: false` этих глобалей в главном мире нет **независимо от `sandbox`**,
   потому что preload живёт в отдельном мире. То есть единственную дыру, ради которой задача
   существует, такой пробник не видит; предыдущая формулировка утверждала обратное и была
   просто неверна.

   Вместо этого — та же форма, что уже принята для `ipcMain` в Task 3: тест сканирует
   исходники `src/main` и падает, если `new BrowserWindow` встречается где-либо, кроме
   `window.ts`, а `window.ts` создаёт окно **только** из `webPreferencesFor`, без спреда и
   без последующей мутации. Тогда утверждение Task 1 про фабрику становится утверждением про
   каждое созданное окно, потому что других мест создания нет: ослабление на месте вызова
   перестаёт существовать как возможность, а не остаётся непроверенным риском.
   Смоук дополнительно утверждает изнутри страницы отсутствие `require`, `process` и
   `module` — это доказывает `contextIsolation` и `nodeIntegration: false` и не говорит
   ничего про `sandbox`, и план это признаёт, а не выдаёт одно за другое.
3. Мост preload присутствует на `window` с ожидаемым набором методов, а `ipcRenderer` —
   отсутствует. Это и закрывает факт F6 наблюдением поверх закрепления `entryFileNames`.
4. Обход путей проверяется **через `fetch` из страницы**, а не навигацией: `will-navigate`
   по Task 2 отклоняет всё, и `goto` до обработчика схемы просто не дошёл бы. Тем же
   `fetch` читается заголовок политики из ответа — это единственный способ увидеть его, не
   полагаясь на то, что инструмент умеет читать заголовки нестандартной схемы.
5. Настоящий origin `app://bundle` принимается: единственный юнит `senderRejection`
   сравнивает константу с самой собой, то есть тавтологичен, и открытый хвост факта F2
   закрывается только здесь.
6. Отсутствие `node:crypto`, `ajv` и `re2` в бандле рендерера проверяется **обходом графа
   импортов через `es-module-lexer`**, как это уже делает тест зависимостей в пакете контрактов.
   Поиск подстроки давал бы и ложные срабатывания на строке в уцелевшем комментарии, и
   пропуски на переписанном бандлером спецификаторе.
7. Вердикт, отправленный из главного окна, отклоняется кодом `sender-window`, а из окна
   апрува — принимается.
8. Шутер `e2e/browser/shot-mockup.mjs` получает режим URL: сегодня он принимает путь и
   делает `pathToFileURL`, то есть навести его на запущенное приложение нельзя. Контракт
   состояний `__listStates` рендерер объявляет по **отдельному флагу сборки**, а не по
   `NODE_ENV`: смоук обязан гонять production-политику CSP (Task 2, шаг 5) и при этом видеть
   состояния, а один переключатель на оба назначения сделал бы это невозможным. В отгружаемой
   сборке флаг выключен, и тестовая поверхность в приложение безопасности не попадает. Сверка снятых состояний с
   макетом закрывает критерий готовности «реализация сверена с макетом».

**Falsification:** утверждение — `expect(windowCreationSites(mainSources)).toEqual(['window.ts'])`.
Создать окно напрямую в `index.ts`, минуя фабрику, → список содержит два файла и утверждение
расходится. Дыра закрывается там, где создаётся, а не наблюдением постфактум. Второе —
`expect(await page.evaluate(() => typeof require)).toBe('undefined')`, оно удерживает
`contextIsolation` и `nodeIntegration: false`. Третье —
`expect(rendererImports).not.toContain('node:crypto')`; сделать импорт `ChainVerification`
значимым вместо `import type` → модуль попадает в граф, и утверждение расходится. Тест
исполняется в настоящем Electron: в Node ни один из этих вопросов ответа не имеет.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: смоук-тест — четыре флага проверяются на созданном окне, а не на фабрике».

## Requirement diff

| `Rn` | Строка плана, которая его реализует |
|---|---|
| `R1` | Task 1, шаг 3 — «Разделить tsconfig: главный и preload остаются на `lib: ["ES2023"]`» |
| `R2` | **Task 15, шаг 2** — флаги проверяются изнутри запущенного рендерера отсутствием `require`, `process` и `module`. Тест фабрики в Task 1 требование не закрывает: спека просит созданное окно, а вызов может ослабить флаги на месте |
| `R3` | Task 2, шаг 1 — «Зарегистрировать схему через `registerSchemesAsPrivileged`» |
| `R4` | Task 1, шаг 2 — `entryFileNames` равным `'[name].cjs'`; Task 3, шаг 4 — один замороженный объект |
| `R5` | Task 3, `guarded` — `const frame = event.senderFrame` первым оператором |
| `R6` | Task 3, шаг 6 — тест-страж на голые `ipcMain.handle` и `ipcMain.on` |
| `R7` | Task 3, шаг 5 — «Обработчики возвращают `Result`, а не бросают» |
| `R8` | Task 3, `Interfaces` — «Имя `IpcRequest` здесь не используется» |
| `R9` | Task 2, шаг 3 — «Отгружать **один** механизм доставки CSP — заголовок»; шаг 8 — что происходит в dev |
| `R10` | Task 2, шаг 6 — запрет навигации через точку `web-contents-created`, покрывающую оба окна |
| `R11` | Task 4, шаг 2 — «Тот же механизм — и моки, и демо со сцены, и план Б» |
| `R12` | Task 4, шаг 2 — «Шаг, пауза, скорость, сброс — одной командой из размеченного union» |
| `R13` | Task 4, шаг 3 — «ключ `argv` … **отсутствует**, а не приезжает пустым массивом» |
| `R14` | Task 11, шаг 1 — «`chain.ts` в main вызывает `verifyChain`»; `Interfaces` — почему только `import type` |
| `R15` | Task 7, шаг 1 — строка с именем, вердиктом, режимом и временем |
| `R16` | Task 7, шаг 5 — «Свёрнутая полоса из трёх групп, каждая по худшему исходу» |
| `R17` | Task 8, шаг 1 — секции вызова, команды, стадий и редакции |
| `R18` | Task 8, шаг 7 — «Оверхед берётся из `duration.overheadMs`, а не считается в UI» |
| `R19` | Task 8, `Interfaces` — `commandView` над `Call`, ветка `not-built` |
| `R20` | Task 8, шаг 5 — «Стадии, которых не было, перечислены отдельной строкой» |
| `R21` | Task 8, шаг 8 — «Поля деталей кликабельны и работают фильтром» |
| `R22` | Task 7, шаг 6 — «Скелет повторяет геометрию наполненной строки бокс в бокс» |
| `R23` | Task 9, шаг 1 — «стучался на evil.io:443, отказано, 0 байт» |
| `R24` | Task 5, `Interfaces` — `violationRole(type, action)`; Task 7, шаг 3 |
| `R25` | Task 5, шаг 2 — «`mandatory-deny` остаётся красным на обоих исходах» |
| `R26` | Task 9, шаг 4 — «Пустая панель — и есть положительный индикатор» |
| `R27` | Task 10, шаг 1 — «**одно предложение по-человечески**» |
| `R28` | Task 10, `Interfaces` — `registers(row: PolicyRow)` над парой фикстур манифеста и lock |
| `R29` | Task 10, шаг 4 — «Молчание манифеста показывается как «да»» |
| `R30` | Task 10, шаг 5 — «бейджи `destructiveHint` и `idempotentHint` рисуются неприменимыми» |
| `R31` | Task 10, шаг 6 — «Рецепт с `*` в домене … помечается «ослабленный режим»» |
| `R32` | Task 11, шаг 2 — «Бейдж **называет механизм и якорь, а не выносит вердикт**» |
| `R33` | Task 11, шаг 3 — «чеклист … включая ту, которая **не** выполнялась» |
| `R34` | Task 11, шаги 4 и 5 — ветвление по `ok`, якорение к точке разрыва |
| `R35` | **Task 11, шаг 7** — третий канал `export-log` с `dialog.showSaveDialog` в main. Прежняя строка «Экспорт JSONL» механизма не называла, а архитектура плана в тот момент разрешала только два сообщения |
| `R36` | Task 12, шаг 3 — «Дифф целиком, без усечения» |
| `R37` | Task 12, `Interfaces` — `diffSlots`, четыре слота всегда |
| `R38` | Task 12, шаг 6 — «Это **не** окно апрува» |
| `R39` | Task 13, шаг 1 — «Отдельный `BrowserWindow` через ту же фабрику» |
| `R40` | Task 13, шаг 3 — «Команда — в основном тексте, не за раскрытием» |
| `R41` | Task 13, шаг 4 — «Отказ мгновенный — набор нужен только чтобы разрешить» |
| `R42` | Task 13, шаг 5 и таблица соответствия — абсолютное время истечения |
| `R43` | Task 13, шаг 7 и шаг 9 — вердикт несёт оба идентификатора, и обработчик требует тождества окна |
| `R44` | **Task 13, шаг 8** — main синтезирует `decision: 'denied'`, когда окна нет. Прежняя строка повторяла требование вместо реализации |
| `R45` | Task 6, шаг 1 — «Ни одного шестнадцатеричного значения в коде E7 не появляется» |
| `R46` | Task 6, шаг 4 — «явный выбор побеждает системный в обе стороны» |
| `R47` | Task 6, шаг 5 и Task 8, шаг 6 — кольцо фокуса и `MachineText` |
| `R48` | Task 6, шаг 2 — «баннер `unsandboxed-banner` при `none`» |
| `R49` | **Task 6, шаг 6** — вся копия лежит в `strings.ts`, и тест утверждает, что каждая её строка встречается в макете; плюс Task 15, шаг 8 — сверка состояний. Прежняя строка поручала это одному шагу Task 13, тогда как копию чеканят семь задач |
| `R50` | Закрыто до плана: `packages/design/src/css/base.css:109` читается `  background: var(--brand);` |
| `R51` | Task 5, `Interfaces` — новая сигнатура `violationRole` |
| `R52` | Task 5, шаг 6 — число ролей берётся из типа: их шесть, таблица опускает `muted` |
| `R53` | Task 14, шаг 1 — правится число «13», а не список из одиннадцати стадий |
| `R54` | Task 14, шаг 3 — находка о тайминге остаётся в `research.md` до E9 |
| `R55` | Task 1 (флаги фабрики), Task 3 (граница IPC), Task 4 (отсутствие `argv`), Task 5 (роль при `allowed`), Task 11 (`brokenAt: 0`), Task 15 (флаги созданного окна). Требование перечисляет шесть областей, и несут его шесть задач, а не две |
| `R56` | Закрыто до плана в части падения на ошибке страницы и вождения по контракту состояний; Task 15, шаг 8 добавляет режим URL, которого у шутера сегодня нет |
| `R57` | Task 13, шаг 10 и Task 6, шаг 3 — инбокс отдельной поверхностью и пятым разделом навигации; состояния `approvals-default` и `approvals-empty` добавлены в макет |
| `R58` | Task 4, шаг 7 — две дорожки трейса и команда `select-track`, которой у проигрывателя до этой ревизии не было |
| `R59` | Task 13, таблица из трёх строк: ширина гранта — один выбор из трёх, потому что произведение двух осей союз не выражает и в пяти сочетаниях из шести выдало бы грант шире показанного |
| `R60` | Task 14, шаг 2 — относительный срок в S8 и вердиктная формулировка бейджа в S9 |
