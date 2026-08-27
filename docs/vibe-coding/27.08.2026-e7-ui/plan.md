# E7 — Electron UI на моках событий

**Ветка:** `v2/e7-ui` · **Спека:** `docs/vibe-coding/27.08.2026-e7-ui/spec.md` ·
**Макет:** `docs/vibe-coding/27.08.2026-e7-ui/mockup.html` (заморожен, источник истины для строк) ·
**Разведка:** `docs/vibe-coding/27.08.2026-e7-ui/research.md`

## Goal

Отгрузить семь наблюдательных поверхностей прокси и authoritative-канал подтверждений,
работающие на воспроизведении записанного трейса, не дожидаясь ядра. Готовность означает:
приложение запускается, трейс сценариев S1–S9 проигрывается шагами, и каждое требование
`R1`–`R56` отмечено реализованным.

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
рендерер отправляет обратно ровно два сообщения — вердикт апрува и команду проигрывателя.

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

---

## Tasks

### Task 1 — тулчейн, окно и четыре флага

Реализует `R1`, `R2`, `R10`, `R55`.

**Files:**
- Create: `packages/desktop/electron.vite.config.ts`
- Create: `packages/desktop/tsconfig.main.json`
- Create: `packages/desktop/tsconfig.renderer.json`
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
export interface WindowKind {
  readonly role: 'main' | 'approval';
}

export function preloadPath(kind: WindowKind): string;

export function webPreferencesFor(kind: WindowKind): Electron.WebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    preload: preloadPath(kind),
  };
}
```

**Шаги.**

1. `yarn workspace @mcpproxy/desktop add -D electron electron-vite electron-builder` и
   `add react react-dom`. Версии закрепить точно: разведка нашла, что Electron 42 и выше
   больше не скачивает бинарь на установке, поэтому после установки обязателен прогон
   `install-electron`, иначе `electron-vite` падает с `Error('Electron uninstall')`.
2. `electron.vite.config.ts`: три сборки. В сборке preload задать
   `build.rollupOptions.output.format` равным `cjs`. В `build.target` задать цель явно —
   таблица версий `electron-vite` кончается на Electron 39 и промах молча отдаёт последнюю
   запись, то есть `chrome108`.
3. Разделить tsconfig: главный и preload остаются на `lib: ["ES2023"]`, рендерер добавляет
   `DOM` и `DOM.Iterable`. Корневой `packages/desktop/tsconfig.json` становится ссылочным.
4. `window.ts` с фабрикой выше и `preloadPath`. Обе роли окна ходят через одну фабрику.
5. `main/index.ts` создаёт главное окно из фабрики.
6. Удалить заглушку `packages/desktop/src/index.ts` и снять её из `exports` пакета.
7. Записать в раздел F6 фактическое имя эмитированного файла preload.

**Falsification:** утверждение — `expect(webPreferencesFor({ role: 'main' })).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })`.
Заменить `sandbox: true` на `sandbox: false` в `window.ts` → утверждение расходится по одному
полю и падает; вернуть → зелено. Тест исполняется в Node под vitest, Electron не
запускается: фабрика чистая и от рантайма не зависит.

**Проверка:** `yarn workspace @mcpproxy/desktop test` и `yarn build` из корня.

**Коммит:** «E7: оболочка Electron; четыре флага И8 читаются тестом, а не соглашением».

### Task 2 — схема `app://`, CSP, запрет навигации

Реализует `R3`, `R9`, `R10`.

**Files:**
- Create: `packages/desktop/src/main/protocol.ts`
- Create: `packages/desktop/src/main/csp.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Test: `packages/desktop/src/main/csp.test.ts`

**Interfaces.**

```ts
export const APP_SCHEME = 'app';
export const APP_ORIGIN = 'app://bundle';

export const PRIVILEGES: Electron.Privileges = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
};

export function cspFor(mode: 'development' | 'production', nonce: string): string;
```

**Шаги.**

1. Зарегистрировать схему через `registerSchemesAsPrivileged` с константой `PRIVILEGES`.
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
6. `will-navigate` и `setWindowOpenHandler` отклоняют всё.

**Falsification:** утверждение — `expect(cspFor('production', 'n0')).not.toMatch(/unsafe-(eval|inline)/)`
и `expect(cspFor('production', 'n0')).toMatch(/frame-ancestors 'none'/)`. Убрать директиву
`frame-ancestors` из `cspFor` → второе утверждение падает, первое остаётся зелёным, то есть
тест различает две независимые ошибки. Тест исполняется в Node: `cspFor` — чистая функция
над строкой.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: схема app:// вместо file://, у которого origin непрозрачен».

### Task 3 — граница IPC

Реализует `R4`, `R5`, `R6`, `R7`, `R8`, `R55`.

**Files:**
- Create: `packages/desktop/src/shared/channel.ts`
- Create: `packages/desktop/src/shared/result.ts`
- Create: `packages/desktop/src/shared/parse.ts`
- Create: `packages/desktop/src/main/ipc.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Test: `packages/desktop/src/main/ipc.test.ts`
- Test: `packages/desktop/src/shared/parse.test.ts`

**Interfaces.**

```ts
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export const UI_CHANNEL = 'mcpproxy.ui/1';

export interface UiRequest {
  readonly kind: 'approval-verdict' | 'player-command';
  readonly payload: unknown;
}
```

Имя `IpcRequest` здесь не используется: оно занято границей shim↔демон
(`packages/contracts/src/ipc.ts:70`), и переиспользование слило бы два разных периметра
безопасности в одно имя.

```ts
export function guarded<T>(
  run: (payload: unknown) => Result<T>,
): (event: Electron.IpcMainInvokeEvent, payload: unknown) => Result<T> {
  return (event, payload) => {
    const frame = event.senderFrame;
    if (frame === null || frame.detached || frame.parent !== null) return DENIED_SENDER;
    if (frame.origin !== APP_ORIGIN) return DENIED_ORIGIN;
    return run(payload);
  };
}
```

`const frame = event.senderFrame` — **первый оператор**. Геттер ленивый и заново резолвит
фрейм в момент обращения, поэтому любой `await` перед ним обнуляет значение; типы Electron
перевели его в `WebFrameMain | null` именно из-за этого.

**Шаги.**

1. `result.ts` и `channel.ts` — общие типы, без зависимостей.
2. `parse.ts` — разбор полезной нагрузки в объект с нулевым прототипом через `Object.hasOwn`,
   без чтения унаследованных свойств. Типы здесь не защита: они стираются, а объект из
   недоверенного содержимого проносит подконтрольный прототип через `contextBridge`
   даже при включённой contextIsolation.
3. `ipc.ts` — обёртка `guarded` и регистрация ровно двух обработчиков через неё.
4. preload экспонирует один замороженный объект с именованными методами. `ipcRenderer`
   наружу не отдаётся ни целиком, ни отдельным методом.
5. Обработчики возвращают `Result`, а не бросают: через `ipcMain.handle` наружу проходит
   только свойство `message`, а `contextBridge` срезает пользовательские поля `Error`.
6. Тест-страж запрещает голые `ipcMain.handle` и `ipcMain.on`: читает исходники `src/main`
   и падает на вызове вне `ipc.ts`. Обеспечение структурное, а не линтерное — единственный
   плагин с таким правилом имеет одного мейнтейнера и в своей же документации признаёт, что
   проверяет факт защиты, а не её корректность.

**Falsification:** утверждение — `expect(guarded(ok)(fakeEvent({ detached: true }), {})).toEqual(DENIED_SENDER)`.
Убрать проверку `frame.detached` из `guarded` → сообщение от отцепленного фрейма проходит к
обработчику и утверждение расходится. Второе утверждение —
`expect(parsePayload(withPollutedPrototype)).not.toHaveProperty('isAdmin')`; убрать
`Object.hasOwn` → унаследованное свойство протекает. Оба теста в Node, `IpcMainInvokeEvent`
подменяется литералом: настоящий фрейм здесь не нужен, проверяется ветвление.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: граница IPC — конверты вместо исключений, senderFrame до любого await».

### Task 4 — проигрыватель трейса и фикстуры

Реализует `R11`, `R12`, `R13`.

**Files:**
- Create: `packages/desktop/src/main/player.ts`
- Create: `packages/desktop/src/main/trace.ts`
- Create: `packages/desktop/fixtures/demo.jsonl`
- Test: `packages/desktop/src/main/trace.test.ts`

**Interfaces.**

```ts
import type { ChainedEvent } from '@mcpproxy/contracts';

export interface Player {
  readonly step: () => void;
  readonly pause: () => void;
  readonly play: (speed: number) => void;
  readonly reset: () => void;
}

export function readTrace(text: string): Result<readonly ChainedEvent[]>;
```

**Шаги.**

1. `trace.ts` разбирает JSONL построчно, пустые строки пропускает, битую строку отдаёт
   диагностикой в конверте, а не бросает.
2. `player.ts` держит позицию и отдаёт события в рендерер по одному. Шаг, пауза, скорость.
   Тот же механизм — и моки, и демо со сцены, и план Б, если ядро упадёт: поток событий на
   сцене не стримят вживую, а воспроизводят под управлением клавиши.
3. `fixtures/demo.jsonl` покрывает сценарии S1–S9. Формы полей берутся из
   `packages/contracts/src/event.ts:42`; ключ `argv` у вызова, остановленного на `lock_check`,
   **отсутствует**, а не приезжает пустым массивом.
4. Хотя бы одно событие несёт `protocolVersion` старой ревизии: значение принадлежит сессии,
   а не сборке, и UI не имеет права его захардкодить.

**Falsification:** утверждение — `expect(Object.hasOwn(lockCheckEvent, 'argv')).toBe(false)`.
Дописать `argv: []` в фикстуру остановленного вызова → утверждение расходится, и это ловит
ровно тот дефект, из-за которого UI отрисовал бы выдуманную пустую команду настоящей.
Второе — `expect(readTrace('{ broken').ok).toBe(false)`. Тест в Node, файловая система не
нужна: `readTrace` принимает текст.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: проигрыватель трейса — один механизм под моки, демо и фикстуры».

### Task 5 — правки дизайн-системы

Реализует `R51`, `R52`, и закрывает `R50`, сделанный ранее в этом ране.

**Files:**
- Modify: `packages/design/src/semantic.ts`
- Modify: `packages/design/README.md`
- Modify: `packages/design/package.json`
- Test: `packages/design/src/semantic.test.ts`

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
4. `README.md`: заголовок «Четыре роли, а не три» противоречит собственной таблице, где
   ролей пять; и строка 73 обещает `stageOrder` из этого пакета, тогда как он живёт в
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
- Modify: `packages/desktop/src/renderer/main.tsx`

**Шаги.**

1. Импортировать `@mcpproxy/design/css` — reset, токены и базовые классы приходят готовыми.
   Ни одного шестнадцатеричного значения в коде E7 не появляется.
2. Оболочка: логотип, переключатель режима песочницы, баннер `unsandboxed-banner` при `none`.
3. Навигация из четырёх разделов; активный получает брендовый красный индикатор — одно из
   трёх мест, где этот цвет вообще разрешён.
4. Тема: явный выбор побеждает системный в обе стороны, через атрибут `data-theme`.
5. Кольцо фокуса не переопределяется нигде.

**Проверка:** `yarn build` из корня.

**Коммит:** «E7: каркас на токенах дизайн-системы, без единого хекса».

### Task 7 — таймлайн, список вызовов

Реализует `R15`, `R16`, `R22`, `R24`.

**Files:**
- Create: `packages/desktop/src/renderer/timeline/CallList.tsx`
- Create: `packages/desktop/src/renderer/timeline/groupBar.ts`
- Create: `packages/desktop/src/renderer/timeline/callLine.ts`
- Test: `packages/desktop/src/renderer/timeline/callLine.test.ts`

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

**Falsification:** утверждение — `expect(callLine(leakedCall).verb).toBe('Прошло')`.
Убрать учёт `action` из `callLine` → слово становится «Отбито» на вызове, где 1247 байт
ушло наружу, и утверждение расходится. Второе — `expect(groupBar(mixedCall)[2]).toBe('danger')`;
вернуть выбор первого нарушения вместо худшего → группа красится янтарём. Оба теста в Node
над чистыми функциями: DOM не нужен, потому что решение о роли принимается до рендера.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: строка вызова несёт режим песочницы — без него S5 не читается».

### Task 8 — детали вызова

Реализует `R17`, `R18`, `R19`, `R20`, `R21`.

**Files:**
- Create: `packages/desktop/src/renderer/timeline/CallDetail.tsx`
- Create: `packages/desktop/src/renderer/timeline/StageList.tsx`
- Create: `packages/desktop/src/renderer/machine.tsx`

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
6. Пути, регексы и argv внутри деталей стадии — моноширинные и без переноса по словам:
   разорванный аргумент читается как два разных.
7. Оверхед берётся из `duration.overheadMs` события `complete`, а не считается в UI.
   Множество исключённых стадий — часть определения метрики
   (`packages/contracts/src/event.ts:149`), и второе его определение неизбежно разъедется.
8. Поля деталей кликабельны и работают фильтром по списку.

**Проверка:** `yarn build` из корня.

**Коммит:** «E7: детали вызова; отсутствие стадии — факт, а не ноль».

### Task 9 — панель нарушений

Реализует `R23`, `R25`, `R26`.

**Files:**
- Create: `packages/desktop/src/renderer/violations/ViolationsPanel.tsx`

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
- Test: `packages/desktop/src/renderer/policy/registers.test.ts`

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

**Falsification:** утверждение — `expect(registers(analyzeLogs).find((r) => r.axis === 'сеть')?.diverges).toBe(true)`.
Убрать учёт молчащих аннотаций → заявленное станет «нет», расхождения не будет, утверждение
расходится. Второе — `expect(badges(analyzeLogs).destructiveHint).toBe('не применимо')`;
убрать ветку `readOnly` → бейдж вернётся к «да», что противоречит спеке. Тесты в Node над
чистыми функциями.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: policy viewer; заявленное и обеспеченное на одних осях».

### Task 11 — аудит и проверка цепочки

Реализует `R14`, `R32`, `R33`, `R34`, `R35`.

**Files:**
- Create: `packages/desktop/src/main/chain.ts`
- Create: `packages/desktop/src/renderer/audit/AuditView.tsx`
- Test: `packages/desktop/src/main/chain.test.ts`

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
6. Экспорт JSONL.

**Falsification:** утверждение — `expect(render(verifyOf(forgedFirstEntry)).status).toBe('broken')`.
Заменить ветвление `if (!result.ok)` на `if (result.brokenAt)` → подделка записи №0 даст
ложь и экран покажет «самосогласована» на сломанной цепочке; утверждение расходится.
Тест в Node: `verifyChain` — чистая функция над массивом.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: бейдж цепочки называет механизм и якорь, а не выносит вердикт».

### Task 12 — модалка расхождения lock

Реализует `R36`, `R37`, `R38`.

**Files:**
- Create: `packages/desktop/src/renderer/lock/LockDiffModal.tsx`

**Шаги.**

1. Четыре раздельных слота: добавлено, удалено, изменено, изменены значения по умолчанию.
   Одна правка `defaults` не должна размножаться по всем рецептам.
2. Пустые слоты показываются явно, а не скрываются: отсутствие изменений — тоже сведение.
3. Дифф целиком, без усечения. Усечение здесь равносильно обману.
4. Дифф красится нейтрально, маркерами. Зелёное «прошло штатно» на строке, из-за которой
   рецепт и заблокирован, — прямая ложь.
5. Основное действие — «Оставить запрет». Безопасный исход не может быть вторичным.
6. Это **не** окно апрува: дрейф lock не риск-тир, и поверхности не смешиваются.

**Проверка:** `yarn build` из корня.

**Коммит:** «E7: дифф lock; безопасный исход — основное действие».

### Task 13 — окно подтверждения

Реализует `R39`, `R40`, `R41`, `R42`, `R43`, `R44`, `R49`.

**Files:**
- Create: `packages/desktop/src/main/approvalWindow.ts`
- Create: `packages/desktop/src/renderer/approval/ApprovalWindow.tsx`
- Create: `packages/desktop/src/renderer/approval/confirmToken.ts`
- Test: `packages/desktop/src/renderer/approval/confirmToken.test.ts`

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
5. Область и срок — два независимых контрола. Срок показывается абсолютным временем, и
   строка пересчитывается от выбранного значения: у варианта «до конца вызова» таймера нет,
   и печатать рядом с ним конкретное время значит учить неверному.
6. «Разрешить» красится `.btn-primary`. Правило записано в
   `packages/design/src/palette.ts:17` и называет «Одобрить» дословно; вдобавок белый на
   брендовом красном даёт 3.86:1.
7. Вердикт несёт и `requestId`, и `sessionId` (`packages/contracts/src/approval.ts:73`).
   Без `requestId` сообщение из рендерера может одобрить не тот ожидающий вызов, который
   человеку показали.
8. Отсутствие окна означает отказ, а не ожидание.
9. Каждая строка окна берётся из макета дословно.

**Falsification:** утверждение — `expect(canApprove({ token: 'v2.4.0', typed: 'v2.4.1' })).toBe(false)`.
Заменить сравнение на проверку непустоты → любой набранный текст разблокирует разрешение, и
утверждение расходится. Второе — `expect(canDeny({ token: 'v2.4.0', typed: '' })).toBe(true)`,
оно удерживает мгновенность отказа: если набор потребуется и для отказа, механизм начнёт
подталкивать к разрешению. Тесты в Node над чистой функцией.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: окно апрува; набрать токен, чтобы разрешить, отказать — сразу».

### Task 14 — правки документации и покрытие

Реализует `R52`, `R53`, `R54`, `R56`.

**Files:**
- Modify: `docs/08-demo-scenarios.md`
- Modify: `docs/vibe-coding/27.08.2026-e7-ui/spec.md`

**Шаги.**

1. `docs/08-demo-scenarios.md` в сценарии S2 говорит «таймлайн из 13 стадий» и перечисляет
   одиннадцать: пропущены `approval` и `violation`. Каноничен `stageOrder`
   (`packages/contracts/src/domain.ts:28`), не проза.
2. Находка разведки о тайминге демо уже записана в `research.md` и остаётся там до E9, где
   принимается решение о режиссуре: владелец решил не трогать её в этом ране.
3. Дописать в спеку таблицу покрытия: по строке на каждое `R1`–`R56` с пометкой
   реализовано, частично или нет. Частично и нет блокируют PR.

**Проверка:** `yarn typecheck && yarn build && yarn test` из корня; затем прогон шутера
`e2e/browser/shot-mockup.mjs` по макету, чтобы убедиться, что он не сломался правками.

**Коммит:** «E7: правки доков и таблица покрытия требований».

---

## Requirement diff

| `Rn` | Строка плана, которая его реализует |
|---|---|
| `R1` | Task 1, шаг 3 — «Разделить tsconfig: главный и preload остаются на `lib: ["ES2023"]`» |
| `R2` | Task 1, `webPreferencesFor` — четыре флага литералами, читаются тестом |
| `R3` | Task 2, шаг 1 — «Зарегистрировать схему через `registerSchemesAsPrivileged`» |
| `R4` | Task 1, шаг 2 — `format` равным `cjs`; Task 3, шаг 4 — один замороженный объект |
| `R5` | Task 3, `guarded` — `const frame = event.senderFrame` первым оператором |
| `R6` | Task 3, шаг 6 — тест-страж на голые `ipcMain.handle` и `ipcMain.on` |
| `R7` | Task 3, шаг 5 — «Обработчики возвращают `Result`, а не бросают» |
| `R8` | Task 3, `Interfaces` — «Имя `IpcRequest` здесь не используется» |
| `R9` | Task 2, шаг 3 — «Отгружать **один** механизм доставки CSP — заголовок» |
| `R10` | Task 2, шаг 6 — «`will-navigate` и `setWindowOpenHandler` отклоняют всё» |
| `R11` | Task 4, шаг 2 — «Тот же механизм — и моки, и демо со сцены, и план Б» |
| `R12` | Task 4, шаг 2 — «Шаг, пауза, скорость» |
| `R13` | Task 4, шаг 3 — «ключ `argv` … **отсутствует**, а не приезжает пустым массивом» |
| `R14` | Task 11, шаг 1 — «`chain.ts` в main вызывает `verifyChain`» |
| `R15` | Task 7, шаг 1 — строка с именем, вердиктом, режимом и временем |
| `R16` | Task 7, шаг 5 — «Свёрнутая полоса из трёх групп, каждая по худшему исходу» |
| `R17` | Task 8, шаг 1 — секции вызова, команды, стадий и редакции |
| `R18` | Task 8, шаг 7 — «Оверхед берётся из `duration.overheadMs`, а не считается в UI» |
| `R19` | Task 8, шаг 4 — «Вызов без ключа `argv` рисует объяснение» |
| `R20` | Task 8, шаг 5 — «Стадии, которых не было, перечислены отдельной строкой» |
| `R21` | Task 8, шаг 8 — «Поля деталей кликабельны и работают фильтром» |
| `R22` | Task 7, шаг 6 — «Скелет повторяет геометрию наполненной строки бокс в бокс» |
| `R23` | Task 9, шаг 1 — «стучался на evil.io:443, отказано, 0 байт» |
| `R24` | Task 7, шаг 3 и Task 5, шаг 1 — роль из типа и исхода вместе |
| `R25` | Task 5, шаг 2 — «`mandatory-deny` остаётся красным на обоих исходах» |
| `R26` | Task 9, шаг 4 — «Пустая панель — и есть положительный индикатор» |
| `R27` | Task 10, шаг 1 — «**одно предложение по-человечески**» |
| `R28` | Task 10, шаг 2 — «Два регистра на **одних осях** — сеть, запись, чтение» |
| `R29` | Task 10, шаг 4 — «Молчание манифеста показывается как «да»» |
| `R30` | Task 10, шаг 5 — «бейджи `destructiveHint` и `idempotentHint` рисуются неприменимыми» |
| `R31` | Task 10, шаг 6 — «Рецепт с `*` в домене … помечается «ослабленный режим»» |
| `R32` | Task 11, шаг 2 — «Бейдж **называет механизм и якорь, а не выносит вердикт**» |
| `R33` | Task 11, шаг 3 — «чеклист … включая ту, которая **не** выполнялась» |
| `R34` | Task 11, шаги 4 и 5 — ветвление по `ok`, якорение к точке разрыва |
| `R35` | Task 11, шаг 6 — «Экспорт JSONL» |
| `R36` | Task 12, шаг 3 — «Дифф целиком, без усечения» |
| `R37` | Task 12, шаг 1 — «Четыре раздельных слота» |
| `R38` | Task 12, шаг 6 — «Это **не** окно апрува» |
| `R39` | Task 13, шаг 1 — «Отдельный `BrowserWindow` через ту же фабрику» |
| `R40` | Task 13, шаг 3 — «Команда — в основном тексте, не за раскрытием» |
| `R41` | Task 13, шаг 4 — «Отказ мгновенный — набор нужен только чтобы разрешить» |
| `R42` | Task 13, шаг 5 — «строка пересчитывается от выбранного значения» |
| `R43` | Task 13, шаг 7 — «Вердикт несёт и `requestId`, и `sessionId`» |
| `R44` | Task 13, шаг 8 — «Отсутствие окна означает отказ, а не ожидание» |
| `R45` | Task 6, шаг 1 — «Ни одного шестнадцатеричного значения в коде E7 не появляется» |
| `R46` | Task 6, шаг 4 — «явный выбор побеждает системный в обе стороны» |
| `R47` | Task 6, шаг 5 и Task 8, шаг 6 — кольцо фокуса и моноширинность без переноса |
| `R48` | Task 6, шаг 2 — «баннер `unsandboxed-banner` при `none`» |
| `R49` | Task 13, шаг 9 — «Каждая строка окна берётся из макета дословно» |
| `R50` | Закрыто до плана: `packages/design/src/css/base.css:109` читается `  background: var(--brand);` |
| `R51` | Task 5, `Interfaces` — новая сигнатура `violationRole` |
| `R52` | Task 5, шаг 4 — «заголовок «Четыре роли, а не три» противоречит собственной таблице» |
| `R53` | Task 14, шаг 1 — «перечисляет одиннадцать: пропущены `approval` и `violation`» |
| `R54` | Task 14, шаг 2 — находка о тайминге остаётся в `research.md` до E9 |
| `R55` | Task 1, Task 3 — тесты на флаги окна и на границу IPC |
| `R56` | Task 14, `Проверка` — прогон `e2e/browser/shot-mockup.mjs` |
