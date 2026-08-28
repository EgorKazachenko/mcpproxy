# E7, ран 1 — ядро приложения и таймлайн

**Ветка:** `v2/e7-ui` · **Спека:** `docs/vibe-coding/27.08.2026-e7-ui/spec.md` ·
**Макет:** `docs/vibe-coding/27.08.2026-e7-ui/mockup.html` (заморожен, источник истины для строк) ·
**Разведка:** `docs/vibe-coding/27.08.2026-e7-ui/research.md`

## Goal

Отгрузить всё, что не экран, плюс одну поверхность, доказывающую путь данных целиком:
Electron-оболочку с проверяемой границей IPC, проигрыватель записанного трейса, свёртку
событий в вызовы и таймлайн со списком и панелью деталей. Готовность означает: приложение
запускается, трейс сценариев S1–S9 проигрывается шагами, четыре флага И8 проверяются на
созданном окне, и каждое требование рана 1 отмечено реализованным.

Шесть остальных поверхностей — отдельный ран решением владельца от 2026-08-28. Причина
записана в спеке: первая редакция плана покрывала всё сразу, прошла четыре раунда ревью и не
сошлась, потому что фиксировала точные сигнатуры для сорока файлов ещё не существующего кода.

## Architecture

Четыре входа в одном пакете. Границы между ними — границы безопасности, а не модульности.

```
packages/desktop/
  src/main/       Node. Окно, схема app://, CSP, проигрыватель, диспетчер исходящих
  src/preload/    CJS, песочница. Один замороженный объект через contextBridge
  src/renderer/   React. DOM. Ни одного узла Node, ни одного импорта из main
  src/shared/     Типы канала, свёртка, группировка стадий. Импортируются всеми
```

Односторонний поток: main читает JSONL и отдаёт события рендереру одним каналом; рендерер
шлёт обратно только команды проигрывателя. Файлов рендерер не читает и не пишет.

## Tech Stack

`electron-vite@5`, Vite `7.3.6`, Electron 43, React 19,
TypeScript 5.6, vitest 3, Playwright (уже стоит, см. F8). Зависимости пакета —
`@mcpproxy/contracts` и `@mcpproxy/design`.

## Global Constraints

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`;
  последний означает `import type` для каждого импорта типа.
- `module: NodeNext` — относительные импорты несут расширение `.js`.
- `lib: ["ES2023"]` без DOM. Рендерер расширяет `lib` своим tsconfig; main и preload — нет.
- ESM в main, **CJS в preload**: preload игнорирует `"type": "module"`, и это то, что
  позволяет держать `sandbox: true`.
- `packages/core` отсюда не импортируется никогда.
- Необязательное поле события — отсутствующий ключ, не `null` и не пустой массив.
- Дайджесты — голый нижний регистр, 64 hex, без префикса.

---

## Pre-flight

### 1. Write path

**Удалена.** Ран не пишет ни одного поля ни в одну коллекцию: лог аудита пишет E6,
приложение только читает. Экспорта лога в этом ране нет — он уехал вместе с вкладкой аудита.

### 2. Consumers — для каждого символа, который план меняет

| Symbol | Reader (`file:line`) | What that reader does with the value | Does the reader's test mock it? |
|---|---|---|---|
| `violationRole` | `packages/design/README.md:76` | перечисляет имя в списке экспортов, значение не читает | тестов у пакета нет вообще |
| `AuditEvent` | `packages/contracts/src/otlp.ts:90` | `toOtlp` раскладывает поля события в атрибуты спана | нет, тест работает на настоящем событии |
| `AuditEvent` | `packages/contracts/src/audit/chain.ts:35` | `chainHash` канонизирует событие целиком | нет |
| `AuditEvent` | `packages/contracts/src/jcs.ts:40` | упомянут в комментарии, значение не читает | — |
| `AuditEvent` | тесты `otlp.test.ts`, `chain.test.ts`, `approval.test.ts` внутри пакета контрактов | строят фикстуры события | это тесты потребителей, а не моки |
| `AuditEvent` | `packages/core/src/audit/log.ts:54` | `append` принимает событие целиком и пишет его в журнал | нет |
| `AuditEvent` | `packages/core/src/env/build.ts:50` | берёт **одно поле** индексным доступом — `AuditEvent['env']` | нет |
| `AuditEvent` | `packages/core/src/redact/output.ts:32` | берёт **одно поле** индексным доступом — `AuditEvent['output']` | нет |
| `AuditEvent` | `packages/core/src/audit/export.ts:128` | снимает `chain` через `unchain` и отдаёт событие в `toOtlp`; форму не перечисляет | нет |
| `AuditEvent` | тесты `log.test.ts`, `export.test.ts` внутри пакета ядра | строят фикстуры события | это тесты потребителей, а не моки |
| `ApprovalRequest` | тест `approval.test.ts` внутри пакета | строит фикстуру запроса | тест самой формы |

Таблица пересобрана после слияния E6: до него потребителей `AuditEvent` было два, теперь
восемь. Ни один не перечисляет форму события целиком — все берут поля индексным доступом или
принимают событие как непрозрачное, — поэтому добавление необязательного поля не задевает ни
одного. Отдельно проверен читатель журнала: `packages/core/src/audit/log.ts:143` объявляет,
что «любые неизвестные ЛИШНИЕ поля проходят», то есть E6 править **не нужно**.

Паттерн: `grep -rn "violationRole" packages docs` и то же для двух других имён, вывод целиком
за вычетом `node_modules` и `dist`. Три тестовых файла названы базовыми именами намеренно: они
строки доказательства, а не единицы работы — план их не правит и утверждает, что они остаются
зелёными, потому что добавление необязательных полей их не задевает. Это утверждение проверяет
прогон Task 1, а не обещание. У `violationRole` попадание в коде одно — само
определение (`packages/design/src/semantic.ts:98`). У `AuditEvent` два настоящих потребителя,
оба внутри `contracts`, и оба переживают **добавление** необязательных полей: `toOtlp`
перечисляет атрибуты поимённо, `chainHash` канонизирует то, что есть.

**Параллельные ветки.** `WORK.md` запрещает пересечения по файлам между ветками волны 1. Живы
воркtree `v2/e1-policy`, `v2/e2-validate`, `v2/e3-sandbox`, `v2/e6-audit`; все четыре трогают
`packages/core`. Эта ветка трогает `packages/contracts`, `packages/desktop`,
`packages/design` и `docs/`. Правка контрактов — единственная, требующая ревизии соседей, и
она сделана первой задачей и отдельным коммитом ровно поэтому.

### 3. Infrastructure — по строке на пакет, который план трогает

| Package | Test command actually used | `setupFiles` | env forced by setup | app built per worker or per test | tsconfig strictness | ESLint severities that constrain the design |
|---|---|---|---|---|---|---|
| `@mcpproxy/contracts` | `yarn workspace @mcpproxy/contracts test` | нет | нет | не применимо | наследует `tsconfig.base.json` | ESLint в репозитории отсутствует |
| `@mcpproxy/design` | `yarn workspace @mcpproxy/design test` | нет | нет | не применимо | наследует базовый | ESLint отсутствует |
| `@mcpproxy/desktop` | `yarn workspace @mcpproxy/desktop test` | нет | нет | смоук поднимает собранное приложение один раз на файл | наследует базовый; рендерер добавляет `lib: DOM` и `jsx` | ESLint отсутствует |

Скрипты прочитаны в `package.json` каждого пакета. У `contracts` команда уже есть и звучит
`tsc -b && vitest run` — префикс не косметика, и обе новые команды его повторяют. У `design`
и `desktop` скрипта `test` сегодня нет, их заводят Task 2 и Task 3.

Корневой прогон — `yarn typecheck && yarn build && yarn test`, он обходит весь граф
воркспейса. Это существенно: правка `contracts` ломает компиляцию `design`, а та —
компиляцию `desktop`, и направление зависимости из путей не выводится.

Существующий тестовый файл, в который план дописывает утверждения, один:

| Test file | Layer | Quoted evidence |
|---|---|---|
| проверка публичной поверхности в пакете контрактов | прямая проверка эмита по снапшоту | ` * Исполняемая проверка заморозки (R31, R23).`  |

### 4. Runtime shape

**Удалена.** План не расширяет и не клонирует ни одного значения из загрузчика. Единственные
объекты, пересекающие границу, — разобранные из JSONL простые объекты и литералы настроек.

Оговорка, делающая таблицу неприменимой по другой причине: у объектов **из** рендерера спред
запрещён не из-за прототипа как такового, а потому что прототип может быть подконтролен
атакующему — премисса P4.

### 5. Premises — каждое «потому что здесь верно X»

| Premise | The grep that establishes it | Quoted evidence | Every site where it holds | Decision at each site |
|---|---|---|---|---|
| P1. Необязательное поле события отсутствует как ключ | `sed -n '14,20p' packages/contracts/src/event.ts` | `**Необязательное поле отсутствует как ключ**, а не присутствует со значением `null`.` (`packages/contracts/src/event.ts:16`) | три новых поля контракта; фикстура; рендер команды и стадий | поле не пишется, когда его нет; рендер ветвится по наличию ключа, а не по истинности |
| P2. `violation` может повторяться в одном вызове | `grep -n "может повторяться" packages/contracts/src/domain.ts` | `/** Порядок в таймлайне. `violation` может повторяться. */` (`packages/contracts/src/domain.ts:27`) | свёртка вызова; полоса групп; список стадий | группа красится по худшему из повторов, свёртка хранит повторы |
| P3. `destructiveHint` и `idempotentHint` значимы только при `readOnlyHint == false` | `sed -n '36,40p' packages/contracts/src/annotations.ts` | `// Оговорка спеки: `destructiveHint` и `idempotentHint` значимы только при` (`packages/contracts/src/annotations.ts:37`) | бейджи аннотаций — уезжают в ран 2 | здесь зафиксировано, чтобы не потерялось |
| P4. Объект из недоверенного содержимого проносит прототип через `contextBridge` | `grep -n "CVE-2026-70610" docs/vibe-coding/27.08.2026-e7-ui/research.md` | `**CVE-2026-70610 (Moderate, 5.4)**: копирование объектов через `contextBridge` учитывало` (`docs/vibe-coding/27.08.2026-e7-ui/research.md:428`) | единственное входящее сообщение рендерера | мелкая копия на объект с нулевым прототипом, чтение через `Object.hasOwn` |
| P5. `sandbox: none` красится опасным всегда | `grep -n "красится опасным" packages/design/README.md` | `- **`sandbox: none` красится опасным всегда**, включая баннер `.unsandboxed-banner`.` (`packages/design/README.md:89`) | баннер; бейдж режима в строке; стадия `build_profile` | все три получают роль `danger`, включая стадию, которая «успешно» ничего не применила |
| P6. И8 требует четырёх флагов и жёсткого CSP | `sed -n '98,102p' docs/02-architecture.md` | `` `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, жёсткий CSP.`` (`docs/02-architecture.md:100`) | единственная фабрика окна; проверка на `web-contents-created` | одна точка создания, и рантайм-проверка на общей точке всех web contents |
| P7. Снапшот поверхности обновляется только явным скриптом | `grep -n "API_SURFACE_SNAPSHOT" packages/contracts/src/api-surface.ts` | `export const API_SURFACE_SNAPSHOT = resolve(packageRoot, 'api-surface.snapshot.txt');` (`packages/contracts/src/api-surface.ts:72`) | правка контракта | диф снапшота попадает в PR как запись об изменении шва |

### 6. Ordered parameter

**Удалена.** Ни одно правило рана не ветвится по дате, индексу, версии или порогу.

### 7. Classifier outputs — когда план ветвится по возврату существующей функции

`violationRole(type, action)` после правки Task 2. Все пять типов на обоих исходах.

| Input in scope | Returned value | Branch taken | Surviving outcome / count |
|---|---|---|---|
| `network`, `denied` | `warn` | янтарь, исход `blocked` | вызов не краснеет |
| `network`, `allowed` | `danger` | красный, исход `passed` | строка получает роль `danger`, бейдж вердикта глушится |
| `file-read`, `denied` | `warn` | янтарь | как `network`/`denied` |
| `file-read`, `allowed` | `danger` | красный | как `network`/`allowed` |
| `file-write`, `denied` | `warn` | янтарь | — |
| `file-write`, `allowed` | `danger` | красный | — |
| `process`, `denied` | `warn` | янтарь | — |
| `process`, `allowed` | `danger` | красный | — |
| `mandatory-deny`, `denied` | `danger` | красный, исход `blocked` | единственная пара, где отбитая попытка красная; бейдж вердикта глушится, хотя ничего не прошло |
| `mandatory-deny`, `allowed` | `danger` | красный | — |

### 8. Verified facts this plan is built on

**F1. `@mcpproxy/contracts` в корневом входе не имеет зависимостей, `./audit` тянет
`node:crypto`, `./validate` — нативный `re2`.** Проверено чтением
`packages/contracts/package.json`. Следствие: рендерер и main импортируют **только** корневой
вход, и нативных пересборок в этом ране нет. Чего проверка не покрывает: она не доказывает,
что бандлер вытрясет неиспользуемые ветки — это закрывает Task 8, шаг 5.

**F2. У `file:`-URL непрозрачный origin, сериализуемый строкой `"null"`.** Проба разведки:

```
file:///Users/x/app/index.html            origin "null", host ""
file://evil.example.com/Users/x/app/...   origin "null", host "evil.example.com"
```

Одинаковый origin при одинаковом pathname. Следствие: сверка отправителя по origin в сборке
на `loadFile()` не проверяет ничего, и схема `app://` несущая, а не удобная. Чего проба не
покрывает: она сделана парсером Node, который не знает, что схема стандартная; итоговое
значение для `app://` проверяется в смоуке.

**F3. `tsc -b --noEmit` в этом репозитории не работает.** Проверено запуском:

```
packages/desktop/tsconfig.json(11,5): error TS6310: Referenced project may not disable emit.
```

Следствие: `typecheck` берёт форму соседей — `tsc -b --noEmit false --emitDeclarationOnly`.

**F4. Белый на брендовом красном даёт 3.86:1.** Посчитано по формуле WCAG для `#FFFFFF` на
`#FF1B2D`; ниже AA для 14px. Важно рану 2, здесь зафиксировано, чтобы не потерять.

**F5. `--text-tertiary` даёт 4.01:1 на `--bg-surface` в тёмной теме.** Посчитано там же.
Данные — длительности, время — на этом токене не живут.

**F6. `ASSUMED` — нужен ли `entryFileNames` поверх `format: 'cjs'`.** Разведка заключает, что
одного `format` достаточно; я закрепляю расширение вторым параметром, потому что его выводит
поле `"type": "module"`. Рассуждение — не проба, расхождение закрывается первой сборкой.
Ревьюерам атаковать это первым.

**F7. `ASSUMED` — обоснование `spellcheck: false`.** В разведке его нет. Утверждение моё:
проверка орфографии включена по умолчанию и тянет словари из главного процесса по сети, то
есть мимо CSP рендерера. Сам флаг защитим и без обоснования — приложению безопасности
проверка орфографии не нужна, — но причина остаётся допущением.

**F9. `ASSUMED` — чтение фактических настроек созданного web contents.** Ни имени API, ни
обработчика `web-contents-created`, ни пускового модуля Playwright для Electron в разведке
нет. Это мои утверждения, и по дисциплине этого раздела они помечены, а не выданы за
проверенные. Закрываются первым прогоном смоука.

**F8. Playwright уже стоит, и разведка на этот счёт устарела.** `research.md` писался до его
установки. Проверено: пакет в корневых `devDependencies`, `e2e/browser/shot-mockup.mjs`
существует и снял состояния макета для дизайн-ревью.

### 9. Поток данных — по строке на каждую полезную нагрузку

| Полезная нагрузка | Производит | Вариант канала | Потребляет | Источник |
|---|---|---|---|---|
| `ChainedEvent` | `src/main/player.ts` | `UiEvent` · `trace-event` | `src/shared/call.ts` → `CallList`, `CallDetail` | `fixtures/demo.jsonl` — оба прогона S5 в одном логе |
| `PlayerState` | `src/main/player.ts` | `UiEvent` · `player-state` | `Chrome.tsx` — позиция и кнопка паузы | состояние проигрывателя |
| сброс накопленного | `src/main/player.ts` | `UiEvent` · `trace-reset` | `App.tsx` | следствие `reset` и `select-track` |
| `PlayerCommand` | `Chrome.tsx` | `UiRequest` · `player-command` | `src/main/player.ts` | ввод человека |
| запрос начального состояния | `App.tsx` при монтировании | `UiRequest` · `hello` | `src/main/player.ts` | — |
| `PlayerState` в ответ на `hello` | `src/main/player.ts` | **возврат обработчика**, а не `UiEvent` | `App.tsx` | состояние проигрывателя |
| индексы происхождения argv | E6 в составе события | внутри `trace-event` | `CallDetail.tsx` через `commandView` | поле контракта из Task 1 |

Отправляет наружу **только** `src/main/dispatch.ts`: он держит реестр окон и даёт
`send(event: UiEvent)`. Производители получают его аргументом, как `createPlayer` получает
приёмник. Иначе `webContents.send` расползается по модулям, и тест-страж Task 5 запрещает его
вне `dispatch.ts` так же, как голый `ipcMain.handle` вне `ipc.ts`.

Второе окно в этом ране не создаётся: окно подтверждения уехало в ран 2 вместе с апрувами.
Поэтому у `dispatch` пока один адресат, и параметр цели появится там же, где второе окно.

---

## Tasks

### Task 1 — контракт: происхождение элементов argv

Реализует `R61`, `R62`, `R64`, `R65`.

**Files:**
- Modify: `packages/contracts/src/event.ts`
- Modify: `packages/contracts/src/approval.ts`
- Modify: `packages/contracts/api-surface.snapshot.txt`
- Modify: `packages/contracts/src/api-surface.ts`
- Modify: `docs/07-contracts.md`
- Modify: `WORK.md`
- Test: `packages/contracts/src/event.test.ts`

**Interfaces.** Одно необязательное поле, добавляемое к двум существующим формам.

```ts
export interface AuditEvent {
  readonly argvFromParams?: readonly number[];
}

export interface ApprovalRequest {
  readonly argvFromParams?: readonly number[];
}
```

Появляется на стадии `build_argv`, рядом с самим `argv`, и подчиняется правилу
отсутствующего ключа.

Индексы, а не параллельный массив меток: параллельный массив обязан совпадать с `argv` по
длине, и это условие никто не проверяет, а список индексов либо пуст, либо указывает в
существующие позиции.

**Почему параметров вызова здесь нет.** Первая редакция плана добавляла и их. Это дефект
безопасности: `packages/contracts/src/jcs.ts:36` называет `IpcRequest.params` поимённо —
«произвольный JSON из сокета» — как то, ради чего введён потолок вложенности, а
`assertWellFormed` (`packages/contracts/src/jcs.ts:18`) бросает на одиночном суррогате.
Параметры приходят от модели и попали бы в событие на стадии `received`, то есть **до**
валидации; одна подстроенная строка сделала бы событие нехэшируемым, E6 не дописал бы его, и
в append-only логе появилась бы дыра, выбранная атакующим. Все прочие поля, пришедшие от
модели, стоят после валидации намеренно.

Вдобавок `Redaction.stream` (`packages/contracts/src/event.ts:133`) перечисляет места, откуда
секрет вырезается, и его JSDoc говорит, что расширять юнион после заморозки дорого:
параметры стали бы пятым таким местом без своего члена, то есть нередактируемым стоком.

Индексы обеих этих проблем не создают: глубины у них нет, строк нет, секретов нет. Но
«числа безопасны» — не абсолют: `packages/contracts/src/jcs.ts:63` бросает на нефинитном
числе, а `:75` — на дырке в разреженном массиве, и `NaN` в этом поле сделал бы событие
нехэшируемым тем же способом. Разница с параметрами в том, что это баг производителя, а не
строка, выбранная атакующим, — и он закрывается инвариантом, который пишется в тот же JSDoc.

**Инвариант поля, записываемый в контракт:** неотрицательные целые, строго меньше длины
`argv` **того же события**, без повторов, ключ присутствует только когда присутствует `argv`.
Уточнение «того же события» несущее: в событие приземляется безопасная копия argv после
редакции (`packages/core/src/redact/output.ts:44`), и индексы обязаны указывать в неё, а не в
исходную команду — иначе они разъедутся ровно там, где секрет был вырезан. Потребитель
(`commandView`) индексирует `argv` при `noUncheckedIndexedAccess`, и выход за границу дал бы
дыру в отрисовке. Дописать это после заморозки нельзя — тем же аргументом, которым план
обосновывает необходимость самой правки.

**Шаги.**

1. Добавить поле и дописать строку `build_argv` в таблицу «стадия → какие поля впервые
   появляются» в JSDoc `AuditEvent`: там уже есть строка про `argv`, и новое поле встаёт
   рядом. Таблица — часть контракта для E6 и E4, и поле без строки в ней означает, что
   производитель события не знает, когда его писать.
   Версию контракта поле не двигает: `docs/07-contracts.md:13` объявляет, что добавление
   опционального поля версию не двигает, и требовать бампа здесь не нужно. Но
   `packages/contracts/src/api-surface.ts:18` утверждает, что снапшот обновляется **вместе с
   бампом**, и после этой задачи утверждение станет ложным — правится тем же движением и по
   той же причине, что и вводный JSDoc `approval.ts`.
   Заодно дописать в таблицу стадий недостающую строку `validate`: таблица несёт двенадцать
   строк на тринадцать стадий с самого E0, и эта задача — единственная, которой позволено
   трогать этот JSDoc.
2. **`ApprovalRequest` в этом ране не трогается.** Первая редакция добавляла поле и туда ради
   `R63`. Это неверно по двум причинам. Правило «опасный токен» из `R41` не определяется этим
   полем: оно отмечает позиции, **подконтрольные модели**, а это не синоним опасного — у
   булева параметра argv получает `-u`, элемент существует из-за параметра и данных параметра
   не несёт, а у вызова без параметров кандидата нет вовсе. И согласовывать это не с кем: у
   `ApprovalRequest` сегодня ноль потребителей в коде, его потребитель — E5, который по
   `WORK.md` стартует после E4 и E7, то есть ни ветки, ни воркtree, ни человека. Заморозить
   поле в чужой форме под правило, которое тот эпик ещё не спроектировал, — ровно то, что
   `packages/contracts/src/approval.ts:6` запрещает. `R63` уезжает в ран 2, где окно
   подтверждения планируется вместе с правилом.
   В `event.ts` поправить вводный JSDoc файла: `packages/contracts/src/approval.ts:5` утверждает,
   что формы объявлены целиком в E0 «а не дорисованы в E5/E7». Эта задача его опровергает, и
   оставить утверждение значило бы соврать внутри того самого диффа, который служит записью
   об изменении шва.
3. **Согласовать с производителем — и это не E6.** E6 слился в main, пока шло планирование, и
   его читатель журнала (`packages/core/src/audit/log.ts:143`) объявляет, что неизвестные
   лишние поля проходят, а `append` берёт событие целиком: правок он не требует. Заполнять
   `argvFromParams` обязан тот, кто собирает argv и само событие, — это E2 (`v2/e2-validate`,
   ветка жива) и E4, который событие ассемблирует. Обязанность фиксируется **распиской**:
   строкой в `WORK.md` рядом с правилом про правки контрактов. Устное «доносится» проверить
   нечем, а каждое другое структурное правило этого плана обеспечено исполняемой распиской —
   страж голых вызовов IPC, AST-страж кириллицы, гейт снапшота.
4. Собрать пакет и обновить снапшот публичной поверхности **явным скриптом** — скрипт читает
   `dist`, поэтому порядок «сборка, потом снапшот» обязателен —, а не переменной окружения:
   тест публичной поверхности объявляет проверку заморозки исполняемой, и
   диф снапшота — единственная аудируемая запись о том, что шов изменился.
5. Дописать `docs/07-contracts.md` там, где перечислены поля события.
6. Коммитом отдельно от всего остального: правка контракта требует ревизии зависимых веток.

**Falsification:** первое утверждение — `expect(Object.hasOwn(receivedEvent, 'argvFromParams')).toBe(false)`
на событии стадии `received` вместе с `expect(buildArgvEvent.argvFromParams).toEqual([3])` на
событии `build_argv`. Написать поле уже на `received` → первое расходится, и это ловит ровно
ту ошибку, из-за которой UI показал бы происхождение аргументов у вызова, ещё не собравшего
команду.

Второе — `expect(toOtlp(event).attributes.filter((a) => a.key.includes('argvFromParams'))).toEqual([])`.
Именно поиск по вхождению, а не сравнение с точным именем: все атрибуты в `toOtlp` несут
префикс пространства имён, и естественная ошибка выглядит как `mcpproxy.argvFromParams`,
которую точное сравнение пропустило бы. Спан по контракту сводка, а не полная запись, и новое
поле не имеет права протечь туда без записи в реестре атрибутов.

Третье — `expect(() => chainHash(eventWithField, null)).not.toThrow()` вместе с
`expect(() => chainHash({ ...eventWithField, argvFromParams: [Number.NaN] }, null)).toThrow(TypeError)`:
поле обязано быть канонизируемым, и второе утверждение показывает, что «числа» — не гарантия
сама по себе, а следствие объявленного инварианта.
Четвёртое — `expect(() => chainHash(eventWithField, null)).not.toThrow()` на счастливом пути, и это утверждение — то, чего не хватало исходной редакции, добавлявшей в
событие произвольный JSON из сокета.

Тесты в Node.

**Проверка:** `yarn workspace @mcpproxy/contracts test`, затем `yarn build` из корня.

**Коммит:** «E7: контракт получает происхождение элементов argv».

### Task 2 — дизайн-система

Реализует `R51`, `R52`, и закрывает `R50`, сделанный до плана.

**Files:**
- Modify: `packages/design/src/semantic.ts`
- Modify: `packages/design/README.md`
- Modify: `packages/design/package.json`
- Test: `packages/design/src/semantic.test.ts`

**Interfaces.**

```ts
export function violationRole(type: ViolationType, action: 'denied' | 'allowed'): Role;

```

Было — `violationRole` в виде `Readonly<Record<ViolationType, Role>>`
(`packages/design/src/semantic.ts:98`). Строки вокруг — комментарий-разделитель выше и
`violationLabel` ниже — не трогаются; локалей определение не использовало, это был литерал.

**Шаги.**

1. Заменить запись функцией с двумя аргументами. Роль зависит и от типа, и от исхода:
   `network` при `denied` — янтарь, песочница отбила; тот же `network` при `allowed` —
   красный, данные ушли. Это и есть содержание S5, а отгруженная версия его не выражает.
2. `mandatory-deny` остаётся красным на обоих исходах: отбито успешно, но сама попытка записи
   в persistence-путь означает, что код пытался закрепиться. Существующий JSDoc с этим
   объяснением переезжает на функцию и дополняется осью `action` — записанное WHY здесь и
   есть ценность, и потерять его при переписывании записи в функцию нельзя.
3. `CallOutcome` сюда **не** добавляется. `packages/design/src/semantic.ts:5` объявляет, что
   значение состояния решает контракт, а этот союз — понятие UI, которого в контрактах нет;
   класть его в пакет, от которого зависят другие эпики, значит нарушить правило, которым
   Task 6 обосновывает место `stageGroup`. Союз живёт в `desktop/src/shared`, подписи — в
   `strings.ts` рендерера вместе с остальной экранной прозой.
4. Заодно поправить `packages/design/src/semantic.ts:11` — вводный комментарий перечисляет
   пять ролей и опускает `muted`, тогда как строка 27 объявляет шесть. Это тот же дефект, что
   `R52` чинит в README, в файле, который эта задача и так правит.
5. Завести пакету скрипт `test` вида `tsc -b && vitest run` и `vitest` в `devDependencies` —
   сегодня скрипта нет, и первый же тест пакета не запустился бы.
6. `README.md`: заголовок «Четыре роли, а не три» неверен, и таблица под ним тоже.
   `packages/design/src/semantic.ts:27` объявляет **шесть** значений `Role`; таблица
   перечисляет пять, опуская `muted`, который используется в бейджах. Число берётся из типа,
   а не из таблицы. Плюс строка 73 обещает `stageOrder` из этого пакета, тогда как он живёт
   в `packages/contracts/src/domain.ts:28`.

**Falsification:** утверждение — `expect(violationRole('network', 'allowed')).toBe('danger')`.
Вернуть поведение, игнорирующее `action`, → функция отдаёт `warn`, и вместе с утверждением
ломается ровно то различие, ради которого продукт существует. Второе —
`expect(violationRole('mandatory-deny', 'denied')).toBe('danger')`, оно удерживает исключение
из первого правила. Тесты в Node.

**Проверка:** `yarn workspace @mcpproxy/design test`, затем `yarn build` из корня — правка
экспорта ломает компиляцию зависимых пакетов, и это должно всплыть здесь, а не в PR.

**Коммит:** «E7: роль нарушения зависит от исхода, а не только от типа».

### Task 3 — тулчейн, окно и четыре флага

Реализует `R1`, `R55`.

**Files:**
- Create: `packages/desktop/electron.vite.config.ts`
- Create: `packages/desktop/tsconfig.main.json`
- Create: `packages/desktop/tsconfig.renderer.json`
- Create: `packages/desktop/tsconfig.e2e.json`
- Create: `packages/desktop/tsconfig.deps.json`
- Create: `packages/desktop/vitest.config.ts`
- Create: `packages/desktop/vitest.smoke.config.ts`
- Create: `packages/desktop/src/main/index.ts`
- Create: `packages/desktop/src/main/window.ts`
- Create: `packages/desktop/src/preload/index.ts`
- Create: `packages/desktop/src/renderer/index.html`
- Create: `packages/desktop/src/renderer/main.tsx`
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/tsconfig.json`
- Delete: `packages/desktop/src/index.ts`
- Test: `packages/desktop/src/main/window.test.ts`

**Interfaces.**

```ts
export type WindowRole = 'main';

export function createWindow(role: WindowRole, url: string): BrowserWindow;

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

`createWindow` не только конструирует окно, но и **грузит в него содержимое**. Адрес приходит
**аргументом**, а не берётся из константы схемы: сама схема появляется в Task 4, и ссылка на
неё сделала бы Task 3 некомпилируемой, а её окно грузило бы адрес, который никто ещё не
обслуживает. В Task 3 вызывающий передаёт адрес dev-сервера, в Task 4 — origin схемы. Без этого шага приложение открывает пустое
окно, а критерий готовности «приложение запускается» и пробник смоука изнутри страницы
опираются на код, которого нет.

Окна создаёт **только** `createWindow`; `index.ts` её зовёт и сам не конструирует. Путь к
preload резолвится внутри неё, а `webPreferencesFor` остаётся чистой и берёт путь входом —
так утверждение о четырёх флагах читается тестом без запуска Electron, а место создания
остаётся одно.

`WindowRole` пока с единственным значением: второе окно приходит в ран 2 вместе с апрувами.
Тип введён сразу, чтобы фабрику тогда не переписывать.

**Шаги.**

1. **`@mcpproxy/contracts` и `@mcpproxy/design` собираются внутрь main и preload, а не
   выносятся во внешние.** Разведка называет это решением с наибольшим рычагом: упаковщик
   тогда не пойдёт по симлинку `workspace:*`, и класс багов «упаковщик плюс yarn workspaces»
   исчезнет по построению. Сам упаковщик здесь не ставится — упаковка предмет E9, — но выбор
   бандлинга это конфиг данной задачи, и E9 его дёшево не переиграет. Версию упаковщика,
   которую назвала разведка, передать в E9: `electron-builder@^26.15.6`.
2. Установить зависимости версиями из разведки. Electron 42 и выше не скачивает бинарь на
   установке, поэтому нужен прогон бина `install-electron`, иначе `electron-vite` падает с
   `Error('Electron uninstall')`.
3. `electron.vite.config.ts`: три сборки. Для preload задать `format` равным `cjs` **и**
   `entryFileNames` равным `'[name].cjs'`. Одного `format` может быть мало: расширение
   определяет `entryFileNames`, а его `electron-vite` выводит из поля `"type": "module"`,
   которое здесь остаётся ради ESM в main. Файл `.mjs` с CJS-содержимым Electron грузит как
   ESM, а ESM-preload требует `sandbox: false` — единственное, чем этот продукт торговать не
   может. Расхождение с выводом разведки помечено `ASSUMED` в F6.
   В `build.target` задать цель явно: таблица версий `electron-vite` кончается на Electron 39
   и промах молча отдаёт последнюю запись, то есть `chrome108`.
4. Разделить tsconfig, **и переписать `packages/desktop/tsconfig.json` в решение-ссылку** на
   два новых под-проекта. Сегодня он несёт `rootDir`, `outDir` и `include` без `.tsx`, и его
   же ссылается корневое решение (`tsconfig.json:8`): оставить его как есть значит, что
   корневые `tsc -b` и `yarn typecheck` продолжат компилировать старый плоский проект.
   Main и preload остаются на `lib: ["ES2023"]`; рендерер добавляет `DOM`, `DOM.Iterable`,
   `"jsx": "react-jsx"` и объявление модуля для `@mcpproxy/design/css` — при
   `moduleResolution: NodeNext` спецификатор CSS иначе не резолвится.
   **`src/shared/` — свой, третий под-проект**, на который ссылаются и main, и рендерер. Класть
   его внутрь main нельзя: тогда рендерер, ссылающийся на проект main, начинает видеть
   `src/main/dispatch.ts`, и запрет «ни одного импорта из main» перестаёт быть проверяемым
   типами — а он объявлен границей безопасности, а не стилем. При `composite: true` одни и те
   же файлы в двух проектах дают конфликт эмита, поэтому отдельный проект — единственная
   форма, где обе цели достижимы.
   `src/e2e` получает собственный `tsconfig.e2e.json`: иначе единственный файл пакета, который
   поднимает настоящий Electron, оказывается единственным же, который никогда не тайпчекается. Ссылки на `../contracts` и `../design` живут в обоих под-проектах.
5. Смоук выносится **вторым файлом конфигурации и вторым скриптом**, а не проектом внутри
   одного конфига: объявленные проекты гоняются все, и отдельного флага «только этот проект по
   умолчанию» нет — есть только фильтр на запуске. Проект внутри одного конфига означал бы,
   что каждая «Проверка» начиная с Task 8 поднимает Electron. Обычный `vitest.config.ts`
   исключает каталог `src/e2e` из `include`.
6. Переписать скрипты пакета: `build` — `electron-vite build`, `test` — `tsc -b && vitest run`,
   **`test:smoke` — `vitest run --config vitest.smoke.config.ts`** (без него смоук нечем
   запустить: флага «только этот проект» у vitest нет, и Task 8 ссылался бы на несуществующее),
   `typecheck` — форма из F3. Сегодня `build` это `tsc -b`, а `test` отсутствует вовсе,
   поэтому корневой `yarn build` собирал бы типы вместо приложения, а `yarn test` молча
   пропускал бы пакет.
7. Удалить заглушку `packages/desktop/src/index.ts`, снять её из `exports`, задать `main` —
   точку входа собранного главного процесса. Каталог `fixtures/` попадает в сборку, и путь к
   нему резолвится от `app.getAppPath()`, а не относительно исходников.
8. Записать в F6 фактическое имя эмитированного файла preload.

**Falsification:** утверждение — `expect(webPreferencesFor('main', '/p')).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, preload: '/p' })`.
Именно `toEqual`, а не `toMatchObject`: второй игнорирует лишние ключи, и добавленный позже
`webviewTag: true` прошёл бы молча. Заменить `sandbox: true` на `false` → утверждение
расходится. Тест в Node, Electron не запускается: фабрика чистая. Того, что окно создано
именно с этими настройками, тест не доказывает — это делает Task 8, шаг 2.

**Проверка:** `yarn workspace @mcpproxy/desktop test` и `yarn build` из корня.

**Коммит:** «E7: оболочка Electron; четыре флага читаются тестом, а не соглашением».

### Task 4 — схема `app://`, CSP, запрет навигации

Реализует `R3`, `R9`, `R10`.

**Files:**
- Create: `packages/desktop/src/main/protocol.ts`
- Create: `packages/desktop/src/main/csp.ts`
- Create: `packages/desktop/src/main/observePreferences.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/electron.vite.config.ts`
- Test: `packages/desktop/src/main/csp.test.ts`

**Interfaces.**

```ts
export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
export const APP_ORIGIN = 'app://bundle';

export const APP_SCHEME_PRIVILEGES: Electron.Privileges = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
};

export function cspFor(mode: 'development' | 'production'): string;
export function resolveBundlePath(requestPath: string, bundleRoot: string): string | null;
```

**Шаги.**

1. Зарегистрировать схему через `registerSchemesAsPrivileged` **до `app.whenReady()`**, а
   `protocol.handle` вызвать после: перепутанный порядок — самый частый способ сломать эту
   связку. `corsEnabled` обязателен: `supportFetchAPI` без него — это CVE-2026-70604.
   `standard` обязателен отдельно: без него отключены `localStorage`, а относительные ссылки
   разрешаются как у `file:`, что ломает пути ассетов из сборки.
2. `resolveBundlePath` резолвит запрошенный путь, берёт `realpath` **внутри `try`** — на
   несуществующем пути он бросает, а функция обязана вернуть `null`, а не выбросить наружу, —
   и отдаёт `null` всему, что не под корнем сборки; обработчик на `null` отвечает 404. Стандартная схема нормализует
   точечные сегменты в URL, но процентное кодирование доживает до обработчика. Инвариант И3
   этого же проекта говорит, что проверка «строка не содержит две точки» защитой не является;
   применить его к демону и не применить к собственному загрузчику рендерера — ровно тот
   случай, когда UI продукта становится аргументом против его тезиса.
3. Один механизм доставки CSP — заголовок ответа схемы. Статического тега с политикой в
   `index.html` нет: заголовок и тег **пересекаются**, и забытый тег молча ужесточает
   политику, а ловить придётся фантом.
4. `script-src 'self'` без nonce и без `unsafe-inline`: на схеме `app://` инлайновых скриптов
   нет, и вся возня с nonce не нужна. `base-uri`, `form-action` и `frame-ancestors` заданы
   явно — от `default-src` они не наследуются. `'unsafe-eval'` не появляется ни в одном
   режиме; предупреждение Electron про небезопасный CSP завязано ровно на разрешение eval.
5. Ветка режима — по `NODE_ENV`, **с падением в строгую политику при отсутствующем
   значении**: в собранном бандле главного процесса переменная не гарантирована, а `cspFor`
   берёт закрытый союз, поэтому отображение пустого значения обязано быть явным и
   fail-closed. Не по `app.isPackaged`: собранное приложение под смоуком
   идёт с `isPackaged` равным false и получило бы мягкую политику в единственной
   автоматической проверке, которая вообще поднимает настоящий рендерер.
6. **Режим разработки назван явно.** В dev рендерер грузится с адреса dev-сервера, где
   обработчик схемы не выполняется вовсе; политика там доставляется dev-middleware и
   разрешает соединение с веб-сокетом HMR, а множество принимаемых origin расширяется этим
   адресом. Одно решение, из которого выводятся и доставка политики, и множество origin.
7. Там же, за **флагом сборки `MCPPROXY_OBSERVE`**, включается сбор фактических настроек
   каждого созданного web contents в `observePreferences.ts`. Флаг объявляется через `define`
   в `electron.vite.config.ts` и в отгружаемой сборке равен лжи, поэтому кода в ней нет вовсе.
   Валить запуск проверка не имеет права: тот же обработчик срабатывает на внутренних web
   contents вроде инструментов разработчика, чьи настройки заданных флагов не несут, —
   самоуничтожение приложения на первом открытии дев-тулов было бы дороже дефекта, который
   оно ловит. Утверждает про собранное смоук.
8. Запрет навигации и открытия окон вешается на `app.on('web-contents-created')` — единую
   точку, через которую проходит каждый web contents процесса. Обработчики на конкретном окне
   не покрыли бы второе окно, которое придёт в ран 2.

**Falsification:** первое утверждение — `expect(cspFor('production')).not.toMatch(/unsafe-(eval|inline)/)`,
второе — `expect(cspFor('production')).toMatch(/frame-ancestors 'none'/)`. Убрать директиву
`frame-ancestors` → второе падает, первое остаётся зелёным, то есть тест различает две
независимые ошибки. Третье — `expect(resolveBundlePath('/%2e%2e/%2e%2e/etc/passwd', root)).toBe(null)`;
убрать проверку вхождения в корень → функция вернёт путь наружу. Тесты в Node: обе функции
чистые, корень подставляется аргументом.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: схема app:// вместо file://, у которого origin непрозрачен».

### Task 5 — граница IPC

Реализует `R4`, `R5`, `R6`, `R7`, `R8`, `R55`.

**Files:**
- Create: `packages/desktop/src/shared/channel.ts`
- Create: `packages/desktop/src/shared/result.ts`
- Create: `packages/desktop/src/shared/parse.ts`
- Create: `packages/desktop/src/shared/playerCommand.ts`
- Create: `packages/desktop/src/main/ipc.ts`
- Create: `packages/desktop/src/main/dispatch.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Test: `packages/desktop/src/main/ipc.test.ts`
- Test: `packages/desktop/src/shared/parse.test.ts`

**Interfaces.**

```ts
export type UiErrorCode =
  | 'sender-absent'
  | 'sender-detached'
  | 'sender-subframe'
  | 'sender-origin'
  | 'bad-payload';

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: UiErrorCode; readonly message: string } };

export const UI_CHANNEL = 'mcpproxy.ui/1';

export type TrackId = 'seatbelt' | 'none';

export type PlayerCommand =
  | { readonly kind: 'step' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'play'; readonly speed: number }
  | { readonly kind: 'reset' }
  | { readonly kind: 'select-track'; readonly track: TrackId };

export interface PlayerState {
  readonly track: TrackId;
  readonly position: number;
  readonly total: number;
  readonly playing: boolean;
}

export type UiRequest =
  | { readonly kind: 'player-command'; readonly command: PlayerCommand }
  | { readonly kind: 'hello' };

export type UiEvent =
  | { readonly kind: 'trace-event'; readonly event: ChainedEvent }
  | { readonly kind: 'player-state'; readonly state: PlayerState }
  | { readonly kind: 'trace-reset'; readonly track: TrackId };
```

`code` — закрытый union, а не `string`: каждый дискриминатор в контрактах закрыт, и это
делает возможным исчерпывающий разбор и тест на опечатку в литерале. Четыре причины отказа
отправителю — четыре независимые атаки, и сваливать их в один код значит лишить тест
возможности сказать, какая проверка сработала.

`hello` — не церемония. Рендерер подписывается позже, чем main начинает работу, и события,
отправленные до подписки, теряются: первая отрисовка осталась бы без позиции, длины и признака
воспроизведения. На `hello` main отвечает текущим `PlayerState` и, если трейс уже
проигрывался, повторяет накопленные события. Тянуть состояние рендерер иначе не может —
`Player.state()` живёт в main.

Ран 2 добавит сюда вердикт апрува и экспорт лога, и форма не поменяется.

Имя `IpcRequest` здесь не используется: оно занято границей shim и демона
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

export function guarded(
  run: (request: UiRequest) => Result<UiReply> | Promise<Result<UiReply>>,
  allowedOrigins: ReadonlySet<string>,
): (event: Electron.IpcMainInvokeEvent, payload: unknown) => Result<UiReply> | Promise<Result<UiReply>>;

export function sanitize(value: unknown): Record<string, unknown>;
export function parseUiRequest(payload: unknown): Result<UiRequest>;

export type UiReply =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'state'; readonly state: PlayerState };
```

Парсер один и разбирает **весь** союз, а не только команду проигрывателя: `hello` пересекает
ту же границу, и оставить один из двух вариантов без разбора значит оставить дыру в `R5`
ровно на самой новой поверхности.

`UiReply` нужен потому, что `guarded<T>` параметризован одним `T`, а обработчик теперь
отвечает по-разному на два варианта запроса: на `hello` — состоянием, на команду —
подтверждением. Общий размеченный ответ снимает это, не размножая каналы.

Внутри `guarded` чтение `event.senderFrame` — **первый оператор**. Геттер ленивый и заново
резолвит фрейм в момент обращения, поэтому любой `await` перед ним обнуляет значение; типы
Electron перевели его в допускающий `null` именно из-за этого.

`senderRejection` берёт структурный тип, а не тип фрейма Electron: каждую ветку можно
проверить литералом, не подделывая событие. `allowedOrigins` — параметр, потому что в dev
рендерер грузится с адреса dev-сервера, и сверка с единственной константой отклоняла бы там
каждое сообщение. Возврат допускает промис, чтобы ран 2 мог добавить экспорт лога с
асинхронным диалогом сохранения, не переписывая охрану.

**Шаги.**

1. `result.ts`, `channel.ts`, `playerCommand.ts` — общие типы, без зависимостей от `main` и
   `renderer`. `PlayerCommand`, `PlayerState` и `TrackId` живут здесь, а не в `main/player.ts`:
   иначе `channel.ts` ссылался бы на модуль, который создаёт следующая задача, тайпчек падал
   бы, а рендерер через канал импортировал бы `main`.
2. `parse.ts` даёт `sanitize` — **мелкую** копию на объект с нулевым прототипом — и поверх неё
   парсер команды. Чтение полей только через `Object.hasOwn`. Типы здесь не защита: они
   стираются, а объект из недоверенного содержимого проносит подконтрольный прототип через
   мост даже при включённой contextIsolation. Мелкой копии хватает ровно потому, что
   полезная нагрузка плоская, и тест это фиксирует, чтобы вложенный объект из рана 2 не
   проехал границу на прежней гарантии.
3. `parseUiRequest` — **разбор написан руками, а не схемой**, и это осознанное отклонение
   от `R5`. Единственный вход контрактов, дающий валидатор схем, тянет `ajv` и нативный `re2`,
   и затащить их в главный процесс ради одного плоского сообщения из пяти вариантов значит
   противоречить факту F1. Смысл требования — «проверяется значение, а не тип» — соблюдён:
   разбор идёт по закрытому союзу и по диапазону, а не по объявлению.
   Скорость ограничивается конечным числом в закрытом диапазоне. `hello` полезной нагрузки не
   несёт и проверяется на то, что её и нет.
   Неограниченное число из рендерера уезжает прямо в таймер, и модель угроз, где рендерер
   считается компрометируемым, покупала бы главному процессу занятый цикл.
4. `ipc.ts` — обёртка `guarded` и регистрация единственного обработчика через неё.
5. `dispatch.ts` — единственный владелец исходящего направления: держит реестр окон и даёт
   отправку события.
6. preload экспонирует один замороженный объект с именованными методами — отправка команды и
   подписка на события. Объект `ipcRenderer` наружу не отдаётся ни целиком, ни отдельным
   методом.
7. **Входящее направление тоже сужается.** Подписка отдаёт слушателю событие, несущее
   отправителя и порты; preload обязан его отбросить и передать рендереру только полезную
   нагрузку. Иначе весь хардненинг исходящего направления обходится с другой стороны моста.
8. Обработчик возвращает `Result`, а не бросает: через `ipcMain.handle` наружу проходит
   только свойство сообщения, а мост срезает пользовательские поля ошибки.
9. Тест-страж запрещает голые `ipcMain.handle`, `ipcMain.on` и `webContents.send` вне
   `ipc.ts` и `dispatch.ts`: читает исходники `src/main` и падает на вызове снаружи.
   Обеспечение структурное, а не линтерное — единственный плагин с таким правилом имеет
   одного мейнтейнера и в своей же документации признаёт, что проверяет факт защиты, а не её
   корректность.

**Falsification:** первое утверждение — таблица из пяти случаев `senderRejection`:
`expect(senderRejection(null, ORIGINS)).toBe('sender-absent')`,
`expect(senderRejection({ detached: true, parent: null, origin: APP_ORIGIN }, ORIGINS)).toBe('sender-detached')`,
`expect(senderRejection({ detached: false, parent: {}, origin: APP_ORIGIN }, ORIGINS)).toBe('sender-subframe')`,
`expect(senderRejection({ detached: false, parent: null, origin: 'file://' }, ORIGINS)).toBe('sender-origin')`
и `expect(senderRejection({ detached: false, parent: null, origin: APP_ORIGIN }, ORIGINS)).toBe(null)`.
Удалить любую одну проверку → расходится ровно один случай, и он называет, какая защита
исчезла.

Второе — `expect(Object.getPrototypeOf(sanitize(polluted))).toBe(null)` вместе с
`expect(Object.hasOwn(sanitize(polluted), 'isAdmin')).toBe(false)`: проверяется объявленное
свойство, а не симптом, потому что обход цепочки прототипов матчером — деталь его реализации,
и безопасность границы не может на ней держаться.

Третье — `expect(parseUiRequest({ kind: 'play', speed: Infinity }).ok).toBe(false)` и
`expect(parseUiRequest({ kind: 'hello', extra: 1 }).ok).toBe(false)`: второй вариант союза
обязан разбираться так же строго, как первый.

Четвёртое — `expect(bareIpcCallSites(mainSources)).toEqual([])`; добавить `ipcMain.handle` в
`index.ts` → список непуст.

Все тесты в Node: настоящий фрейм не нужен, проверяется ветвление.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: граница IPC — конверты вместо исключений, senderFrame до любого await».

### Task 6 — данные: проигрыватель, свёртка вызовов, фикстура

Реализует `R11`, `R12`, `R13`, `R58`.

**Files:**
- Create: `packages/desktop/src/shared/call.ts`
- Create: `packages/desktop/src/shared/stageGroup.ts`
- Create: `packages/desktop/src/main/player.ts`
- Create: `packages/desktop/src/main/trace.ts`
- Create: `packages/desktop/fixtures/demo.jsonl`
- Create: `packages/desktop/scripts/build-fixtures.mjs`
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc.ts`
- Test: `packages/desktop/src/shared/call.test.ts`
- Test: `packages/desktop/src/main/trace.test.ts`
- Test: `packages/desktop/src/main/player.test.ts`

**Interfaces.**

`AuditEvent` описывает **одну стадию**: он несёт один `stage`, одну длительность стадии
(`packages/contracts/src/event.ts:83`) и собирается в вызов только по `traceId`
(`packages/contracts/src/event.ts:71`). Пока такой свёртки нет, ни «худший исход в группе», ни
«каких стадий не было», ни «команда не собиралась» вычислить не из чего: все три — свойства
вызова, а не события.

```ts
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

export type StageGroup = 'checks' | 'setup' | 'execution';
export function stageGroup(stage: Stage): StageGroup;
```

Правила свёртки заданы явно, иначе четыре поля из семи остались бы на усмотрение
реализующего:

- `stages` **сортируются** по позиции в `stageOrder`, а при равенстве — по времени начала.
  Хранить «как пришло» нельзя: проигрыватель отдаёт события по одному, порядок прихода не
  гарантирован, а панель деталей требует стадии по порядку. Повторы `violation` сохраняются:
  схлопывание потеряло бы контраст S5.
- `verdict` берётся из **последнего** события по этому же порядку: вердикт вызова — его
  исход, а не вердикт промежуточной стадии.
- `startedAt` — время начала события стадии `received`.
- `open` истинно, пока вызов не завершён **и** не отказан: нет ни события `complete`, ни
  вердикта `denied` или `error`. Вызов, остановленный на `validate`, до `complete` не доходит
  никогда, и правило «нет `complete` — значит открыт» держало бы его в списке ждущих вечно.
  Ожидание подтверждения остаётся открытым: оно действительно ждёт.
- Вызовы сортируются по времени начала убыванием.

`stageGroup` живёт в `shared/`, а не в дизайн-системе: контракты заморожены и группировки не
несут, а дизайн-система по решению Task 2 хранит отображение доменного значения в **слово**,
а не в другое доменное значение.

```ts
export interface Player {
  readonly apply: (command: PlayerCommand) => void;
  readonly state: () => PlayerState;
  readonly replay: () => void;
}

export function createPlayer(
  events: readonly ChainedEvent[],
  marks: Readonly<Record<TrackId, number>>,
  emit: (event: UiEvent) => void,
): Player;

export function readTrace(text: string): Result<readonly ChainedEvent[]>;
```

`replay` существует ради `hello`: рендерер подписывается позже, чем main начинает работу, и
события, отправленные до подписки, теряются. Без него первая отрисовка показывала бы пустой
список при непустом трейсе.

Приёмник — аргумент, а не спрятанный внутри модуля побочный эффект: иначе тип умалчивает,
куда уходят события. Запрос состояния существует, потому что без него ни рендерер не нарисует
правильную кнопку паузы, ни тест не проверит, что пауза остановила выдачу.

**Шаги.**

1. `trace.ts` разбирает JSONL построчно, пустые строки пропускает, битую строку отдаёт
   диагностикой в конверте, а не бросает. Разбор терпим к незнакомой версии схемы:
   `packages/contracts/src/event.ts:49` объявляет, что читатель обязан отрисовать неизвестное
   значение как «форма новее меня», а не упасть.
2. `player.ts` держит позицию и отдаёт события в приёмник по одному. Шаг, пауза, скорость,
   сброс и выбор дорожки — одной командой из размеченного union, а не пятью методами: команда
   едет через IPC, и её всё равно пришлось бы разбирать как данные.
3. **Трейс один, и оба прогона S5 лежат в нём.** Переключатель режима отправляет
   `select-track`, и проигрыватель **перематывается** к началу выбранного прогона — команда
   идёт через проигрыватель, как требует `R58`, но список не подменяется. Два файла ломали бы
   ровно то, ради чего S5 существует: макет рисует пару соседними строками в четырёх секундах
   друг от друга, `08-demo-scenarios.md` описывает один таймлайн, а цепочка хэшей распалась бы
   на две с разными генезисами. `marks` — позиции начала прогонов в общем массиве.
4. `trace-reset` отправляется первым после сброса и после смены дорожки: обе команды делают
   накопленный рендерером массив недействительным, и без явного сообщения рендереру пришлось
   бы **выводить** сброс из гонки состояния проигрывателя с событиями.
5. Фикстура покрывает сценарии S1–S9. Формы полей берутся из
   `packages/contracts/src/event.ts:42`; ключ `argv` у вызова, остановленного на `lock_check`,
   **отсутствует**, а не приезжает пустым массивом. События стадии `build_argv` несут
   `argvFromParams`: без этого единственный потребитель самого рискованного изменения плана
   получал бы события, в которых поля нет, и `R62` не доказывался бы ничем.
   Хотя бы одно событие несёт старую ревизию
   протокола: значение принадлежит сессии, а не сборке.
6. **Генератор фикстур считает цепочку хэшей.** Поле `chain.self` обязано
   удовлетворять формуле из `packages/contracts/src/audit/chain.ts:35`; написанные руками
   хэши сделали бы демо-трейс постоянно «разошедшимся» — на сцене. Скрипт берёт формулу из
   входа `./audit`, вешается на скрипт пакета, его вывод коммитится, а тест утверждает, что
   закоммиченная фикстура проверяется: иначе одна поздняя правка руками ломает демо молча.
7. Проигрыватель создаётся в `main/index.ts` при запуске и получает `dispatch` приёмником;
   его команда регистрируется обработчиком в `ipc.ts`. Без этих двух правок проигрыватель
   существует как модуль и не работает как механизм.

**Falsification:** первое утверждение — `expect(Object.hasOwn(lockCheckEvent, 'argv')).toBe(false)`.
Дописать пустой `argv` в фикстуру остановленного вызова → расходится, и это ловит ровно тот
дефект, из-за которого UI отрисовал бы выдуманную пустую команду настоящей.

Второе — `expect(verifyChain(committedFixture).ok).toBe(true)` на закоммиченной фикстуре.

Третье, на свёртку: `expect(foldCalls(shuffled).map((c) => c.traceId)).toEqual(foldCalls(ordered).map((c) => c.traceId))`
при перемешанном порядке прихода, и `expect(mixedCall.stages.filter((e) => e.stage === 'violation')).toHaveLength(2)`
на вызове с двумя нарушениями. Свернуть по `spanId` вместо `traceId` → события одного вызова
расползаются по разным вызовам, и оба утверждения расходятся.

Четвёртое — `expect(foldCalls([deniedAtValidate])[0].open).toBe(false)`: правило «нет
`complete` — значит открыт» держало бы отказанный вызов в списке ждущих вечно.

Пятое, на проигрыватель: приёмник подменяется собирающим массивом, и
`expect(collected).toHaveLength(1)` после одного шага, затем
`expect(player.state().position).toBe(1)`. Убрать инкремент позиции → второе расходится,
первое остаётся зелёным, то есть тест различает две независимые ошибки.

Все тесты в Node, IPC не нужен: приёмник — обычная функция.

**Проверка:** `yarn workspace @mcpproxy/desktop test`.

**Коммит:** «E7: проигрыватель трейса и свёртка вызовов — один механизм под моки, демо и тесты».

### Task 7 — оболочка и таймлайн

Реализует `R15`, `R16`, `R17`, `R18`, `R19`, `R20`, `R21`, `R22`, `R45`, `R46`, `R47`, `R48`, `R49`.

**Files:**
- Create: `packages/desktop/src/renderer/App.tsx`
- Create: `packages/desktop/src/renderer/Chrome.tsx`
- Create: `packages/desktop/src/renderer/Nav.tsx`
- Create: `packages/desktop/src/renderer/theme.ts`
- Create: `packages/desktop/src/renderer/strings.ts`
- Create: `packages/desktop/src/shared/callOutcome.ts`
- Create: `packages/desktop/src/renderer/timeline/CallList.tsx`
- Create: `packages/desktop/src/renderer/timeline/CallDetail.tsx`
- Create: `packages/desktop/src/renderer/timeline/StageList.tsx`
- Create: `packages/desktop/src/renderer/timeline/MachineText.tsx`
- Create: `packages/desktop/src/renderer/timeline/callLine.ts`
- Create: `packages/desktop/src/renderer/timeline/commandView.ts`
- Create: `packages/desktop/src/renderer/timeline/stageDetail.ts`
- Modify: `packages/desktop/src/renderer/main.tsx`
- Test: `packages/desktop/src/renderer/timeline/stageDetail.test.ts`
- Test: `packages/desktop/src/renderer/timeline/callLine.test.ts`
- Test: `packages/desktop/src/renderer/timeline/commandView.test.ts`
- Test: `packages/desktop/src/renderer/strings.test.ts`

**Interfaces.**

```ts
export interface CallLine {
  readonly role: Role;
  readonly outcome: CallOutcome;
  readonly detail: string;
  readonly sandbox?: SandboxMode;
  readonly verdictMuted: boolean;
}

export function callLine(call: Call): CallLine;

export function groupBar(call: Call): ReadonlyArray<{
  readonly group: StageGroup;
  readonly reached: number;
  readonly total: number;
  readonly role: Role;
}>;

export type CommandView =
  | { readonly kind: 'built'; readonly argv: readonly string[]; readonly fromParams: readonly number[] }
  | { readonly kind: 'not-built'; readonly stoppedAt: Stage };

export function commandView(call: Call): CommandView;
export function stagePresence(call: Call): ReadonlyArray<{ stage: Stage; present: boolean }>;

export function stageDetail(event: ChainedEvent): string;
```

`stageDetail` — то, чего в плане не было, а в макете есть: у каждой стадии в панели деталей
своя фраза («2 элемента, подстановок в `exec[0]` нет», «сеть запрещена, запись: coverage,
node_modules/.cache, /tmp»). Свободного текста стадии `AuditEvent` не несёт и нести не должен,
поэтому фраза **собирается** из полей события по таблице шаблонов на все тринадцать стадий.
Шаблоны живут в `strings.ts` по правилу шага 13, а сами фразы берутся из макета дословно.
Это самая большая неспецифицированная поверхность рана, и она больше тех полей контракта,
которые план описал подробно.

Аргумент везде `Call`, а не `AuditEvent`. На событии `commandView` возвращала бы `not-built`
для стадий `received`, `lock_check`, `validate` и `resolve_paths` **успешного** вызова, потому
что `argv` впервые появляется только на `build_argv`.

`groupBar` возвращает именованные группы с числом достигнутых и общим числом стадий: макет
рисует полосу пропорционально и оставляет рельс под недостигнутые, и одной ролью на группу
это не выражается. Поиск по имени, а не по индексу: индекс не называет, какая из трёх групп
проверяется, и при `noUncheckedIndexedAccess` даёт отсутствующее значение на укороченном
массиве.

`CallLine` несёт две оси: `outcome` — исход вызова, `verdictMuted` — отдельное решение о том,
что бейдж вердикта глушится. Правило берётся из макета, который по `R49` источник истины:
глушится, когда **хоть одно нарушение имеет роль `danger`**, а не только когда нарушение
прошло насквозь. Разница ровно в паре `mandatory-deny` + `denied`: попытка отбита, но строка
всё равно красная, и зелёный бейдж рядом с красной строкой спорил бы сам с собой. Одним полем это не выражается:
вызов при этом остаётся разрешённым, и новость не в вердикте. `CallOutcome` объявлен в `src/shared/callOutcome.ts`: это понятие UI, а не домена, и
дизайн-система по собственному правилу отображает в слово доменные значения из контрактов.
Подписи ко всем шести значениям живут в `strings.ts` — «Отбито», «Прошло», «Отказано»,
«Ждёт подтверждения», «Выполнено», «Выполняется». Шестое обязательно: проигрыватель отдаёт
события по одному, и половина вызовов на экране всегда незакончена.

**Шаги.**

1. Импортировать CSS дизайн-системы — reset, токены и базовые классы приходят готовыми.
   Ни одного шестнадцатеричного значения в коде E7 не появляется.
2. Оболочка: логотип, переключатель режима песочницы, отправляющий `select-track`, баннер
   без песочницы при режиме `none`. Навигация из пяти разделов; активный получает брендовый
   красный индикатор — одно из трёх мест, где этот цвет вообще разрешён. Четыре раздела,
   кроме таймлайна, в этом ране ведут на заглушку «появится в следующем ране»: рисовать
   мёртвые пункты нельзя, а прятать их значит переделывать навигацию дважды.
3. Тема: явный выбор побеждает системный в обе стороны, через атрибут темы на корне. Кольцо
   фокуса не переопределяется нигде.
4. Строка вызова: имя, бейдж вердикта, **бейдж режима песочницы**, время. Без режима в строке
   два соседних вызова S5 отличаются одним словом, и зал не видит разницы. Строка диспозиции
   начинается словом исхода — оно переживает усечение и читается раньше цвета. Рядом иконка
   роли: янтарь и красный — ровно та пара, которую путают протанопы и дейтеранопы.
5. Свёрнутая полоса из трёх групп, каждая по худшему исходу внутри себя; недостигнутые стадии
   рисуются рельсом, а не нулевой полоской.
6. Скелет повторяет геометрию наполненной строки бокс в бокс, иначе подгрузка даёт скачок
   вёрстки; пустое состояние отдельным текстом.
7. Панель деталей: вызов, причина отказа отдельным заметным блоком, команда, стадии, редакция.
   Секция «вызов» несёт рабочий каталог, список разрешённых переменных окружения и профиль
   песочницы — `R17` называет их поимённо, и без них требование покрыто наполовину.
   Причина отказа не может быть строкой в конце — требование просит точную причину, а
   перечисление несостоявшихся стадий по площади больше неё.
8. Команда подсвечивает **происхождение**, а не позицию: выделено то, что подставлено из
   параметров, по индексам из нового поля контракта. Роли состояний на подсветку не тратятся:
   синий значит «ждём человека», а не «это аргумент».
9. Вызов без ключа `argv` рисует объяснение «команда не собиралась», а не пустую команду.
   Стадии, которых не было, перечислены отдельной строкой: «прошло мгновенно» и «до стадии не
   дошло» обязаны различаться, и ноль длительности рисуется прочерком.
10. Пути, регексы и элементы команды внутри деталей стадии рисуются через `MachineText` —
    моноширинным и без переноса по словам: разорванный аргумент читается как два разных, а
    кириллическая буква в имени флага пропорциональным шрифтом неотличима от латинской.
11. Оверхед берётся из поля события `complete`, а не считается в UI. Множество исключённых
    стадий — часть определения метрики (`packages/contracts/src/event.ts:149`), и второе его
    определение неизбежно разъедется.
12. Поля деталей кликабельны и работают фильтром по списку. Состояние фильтра и выбранного
    вызова живёт в `App.tsx` и передаётся обеим панелям: без общего состояния клик в правой
    панели не может изменить левую.
13. **Строка каждой стадии собирается `stageDetail`** из полей события по таблице шаблонов на
    все тринадцать стадий. Свободного текста стадии `AuditEvent` не несёт и нести не должен;
    фразы берутся из макета дословно, шаблоны живут в `strings.ts`. Это самая большая
    поверхность рана, и до шестого раунда ревью у неё не было ни шага, ни якоря в реестре.
14. **Вся экранная проза живёт в `strings.ts`**, и это обеспечивается структурно, как запрет
    голых вызовов IPC: тест обходит **AST** файлов `src/renderer` и `src/shared` сканером
    TypeScript и падает на кириллице в строковом литерале, в тексте JSX или в куске шаблонной
    строки — но не в комментарии. Грепом это не делается: в этом репозитории каждый файл несёт
    русские комментарии. Составные предложения макет собирает из шаблонов, целиком в файле их
    нет, поэтому `strings.ts` хранит шаблоны, а сверка с макетом идёт по их постоянным
    фрагментам. Подписи доменных значений остаются в дизайн-системе и сюда не дублируются.

**Falsification:** первое утверждение — `expect(callLine(leakedCall).outcome).toBe('passed')`.
Убрать учёт исхода нарушения из `callLine` → исход становится `blocked` на вызове, где 1247
байт ушло наружу. Второе — `expect(callLine(openCall).outcome).toBe('running')`: без шестого
значения незавершённый вызов подписывался бы «Выполнено». Третье —
`expect(groupBar(mixedCall).find((g) => g.group === 'execution')?.role).toBe('danger')`;
вернуть выбор первого нарушения вместо худшего → группа красится янтарём.

Четвёртое — `expect(commandView(lockCheckCall).kind).toBe('not-built')` вместе с
`expect(commandView(successfulCall).kind).toBe('built')`. Второе обязательно: без него
реализация, всегда отвечающая `not-built`, прошла бы первое. Заменить проверку наличия ключа
на проверку истинности длины → вызов, остановленный на `lock_check`, и вызов с пустой
командой становятся неразличимы.

Пятое — `expect(commandView(successfulCall).fromParams).toEqual([3])`, и оно же удерживает
свёртку отсутствия: контрактное поле необязательно, а `CommandView.fromParams` — нет, поэтому
`commandView` схлопывает отсутствие в пустой массив. Это та же подмена отсутствия пустотой,
которую `R13` объявляет дефектом, и здесь она допустима только потому, что для подсветки «нет
подстановок» и «нет поля» — одно и то же. Сказано явно, а не подразумевается.

Шестое — `expect(stageDetail(buildArgvEvent)).toBe(STRINGS.stage.buildArgv({ count: 4, substituted: 1 }))`
и `expect(stageOrder.every((st) => st in STAGE_TEMPLATES)).toBe(true)`. Второе обязательно:
таблица на двенадцать стадий из тринадцати даёт пустую строку на тринадцатой, и заметить это
без утверждения о полноте нечем.

Седьмое — `expect(callLine(mandatoryDenyCall).verdictMuted).toBe(true)` при
`expect(callLine(mandatoryDenyCall).outcome).toBe('blocked')`: две оси расходятся ровно здесь,
и правило «глушить только прошедшее насквозь» дало бы `false`.

Восьмое — `expect(cyrillicOutsideStrings(rendererSources)).toEqual([])`; захардкодить русскую
строку в `CallList.tsx` → файл попадает в список.

Тесты в Node над чистыми функциями: DOM не нужен, потому что решение о роли и о виде команды
принимается до отрисовки.

**Проверка:** `yarn workspace @mcpproxy/desktop test` и `yarn build` из корня.

**Коммит:** «E7: оболочка и таймлайн; отсутствие стадии — факт, а не ноль».

### Task 8 — смоук на собранном приложении

Реализует `R2`, `R55`, и закрывает открытые хвосты фактов F1, F2 и F6.

**Files:**
- Create: `packages/desktop/src/e2e/smoke.test.ts`
- Modify: `packages/desktop/package.json`

**Зачем отдельной задачей.** Все остальные тесты плана исполняют чистые функции в Node, и **ни
один не запускает Electron**. Для продукта, чей питч — хардненинг Electron, это неверное место
границы между «дёшево» и «правда». Конкретно: `R2` требует читать настройки **созданного
окна**, а тест фабрики их не читает.

**Шаги.**

1. Тест пишется как vitest-тест, импортирующий пусковой модуль Electron из `playwright`, а не
   как спека Playwright-раннера: раннера в зависимостях нет, а файл со спекой подхватился бы
   обычным прогоном. Каталог `src/e2e` исключён из обычного конфига, и смоук гоняется вторым
   конфигом и вторым скриптом из Task 3. `es-module-lexer` и `playwright` объявляются в
   `devDependencies` пакета: первого сегодня нет вовсе, второй резолвится подъёмом из корня, и
   полагаться на подъём в объявлении зависимостей нельзя.
2. **`R2` проверяется на общей точке всех web contents.** Обработчик `web-contents-created` из
   Task 4 — единственное место, через которое проходит каждый web contents процесса, включая
   встраиваемые представления, у которых собственные настройки и в которых конструктор окна
   не встречается вовсе. Там читаются фактические настройки созданного объекта и сверяются с
   четырьмя флагами. Это и есть буквальное «читает фактические настройки созданного окна» из
   спеки.
   Сбор ведёт `observePreferences.ts` из Task 4 под флагом `MCPPROXY_OBSERVE`; в отгружаемой
   сборке этого кода нет. Само API помечено `ASSUMED` в F9.
   Сканирование исходников остаётся вторым рубежом: оно ловит появление второго места
   создания раньше, чем оно создаст окно. Само по себе оно недостаточно — присваивание
   конструктора в переменную его обходит.
   Пробник изнутри страницы — третий и самый слабый: он доказывает `contextIsolation` и
   `nodeIntegration: false` и **не говорит ничего про `sandbox`**, потому что при этих двух
   флагах узловых глобалей в главном мире нет независимо от него.
3. Мост preload присутствует на объекте окна с ожидаемым набором методов, а `ipcRenderer`
   отсутствует. Это и закрывает F6 наблюдением поверх закрепления имени файла.
4. Обход путей проверяется **запросом из страницы**, а не навигацией: запрет навигации из
   Task 4 отклоняет всё, и переход до обработчика схемы не дошёл бы. Тем же запросом читается
   заголовок политики из ответа.
5. Отсутствие `node:crypto`, `ajv` и `re2` проверяется обходом графа импортов по эмиту `tsc`
   для проекта рендерера — там `import type` уже стёрт, а относительные импорты ещё не
   схлопнуты. **Этот эмит надо произвести:** ни `typecheck` (только объявления, где импорты
   типов сохраняются), ни `build` (это бандлер) его не дают. Каталог назначения задаётся
   конфигом, а не флагом — у `tsc -b` его нет, — поэтому Task 3 заводит четвёртый под-проект
   `tsconfig.deps.json` с собственным `outDir`, и смоук собирает им.

   Обход обязан **входить внутрь зависимости**: код рендерера импортирует
   `@mcpproxy/contracts` голым специфаером, который `tsc` сохраняет как есть, поэтому проход
   только по своему эмиту показал бы `@mcpproxy/contracts` и никогда `node:crypto` —
   независимо от того, есть утечка или нет. Такое утверждение проходило бы всегда, а Task 8
   шагом 6 как раз снимает другое тавтологичное утверждение; заводить новое на его месте
   нельзя. Проход резолвит специфаер в эмит пакета и продолжает по нему, как это делает тест
   зависимостей контрактов.
6. Настоящий origin схемы принимается: единственный юнит `senderRejection` сравнивает
   константу с самой собой, то есть тавтологичен, и открытый хвост F2 закрывается здесь.

**Falsification:** первое утверждение — `expect(cspHeaderSeen).toMatch(/script-src 'self'/)` на
заголовке, прочитанном запросом из страницы: без него мягкая политика в собранном приложении
не обнаруживается ни одним тестом плана. Второе — `expect(prefsSeenAtCreation.every((p) => p.sandbox === true)).toBe(true)`,
где массив собран обработчиком создания web contents за время запуска. Дописать
`sandbox: false` на месте вызова → в массиве появляется запись с ложью; тест фабрики из
Task 3 при этом остаётся зелёным, что и делает эту проверку несводимой к нему. Второе —
`expect(rendererImports).not.toContain('node:crypto')`. Тест исполняется в настоящем Electron:
в Node ни один из этих вопросов ответа не имеет.

**Проверка:** `yarn workspace @mcpproxy/desktop test:smoke`.

**Коммит:** «E7: смоук — четыре флага проверяются на созданном окне, а не на фабрике».

### Task 9 — правки документации и покрытие

Реализует `R53`, `R54`, `R60`.

**Files:**
- Modify: `docs/08-demo-scenarios.md`
- Modify: `docs/vibe-coding/27.08.2026-e7-ui/spec.md`
- Modify: `docs/vibe-coding/27.08.2026-e7-ui/mockup.html`

**Шаги.**

1. Сценарий S2 говорит «таймлайн из 13 стадий» и перечисляет одиннадцать. **Правится число, а
   не список.** S2 — happy path `run_tests`, где подтверждение и нарушение действительно не
   происходят, и дописать их значило бы вписать в документацию ложь, противоречащую шагу 9
   Task 7 этого же плана. Становится «11 из 13 возможных стадий».
2. Там же — формулировка S9 про верифицированную цепочку: `R32` запрещает вердиктную форму
   бейджа, потому что она обещает больше, чем механизм даёт. Экран уезжает в ран 2, а строка
   в доке правится здесь, пока причина под рукой. Формулировка S8 про десять минут
   **остаётся**: запрещён относительный срок в записи аудита и там, где показан срок
   действия, — а не подпись на контроле, рядом с которой стоит абсолютное время истечения.
3. Находка разведки о тайминге демо остаётся в `research.md` до E9, где принимается решение о
   режиссуре: владелец решил не трогать её.
4. **Снять из макета строку с параметрами в секции «Вызов».** Она рисовала значение, которого
   событие не несёт и теперь намеренно нести не будет, и была живым фильтром по `R21`. Макет
   заморожен и по `R49` служит источником истины для строк, поэтому удаление строки из него —
   такое же решение, как правка замороженного контракта, и оно записывается, а не делается
   молча. Смысл строки переходит к подсветке происхождения: подсвеченные элементы команды и
   есть значения параметров.
5. Дописать в спеку таблицу покрытия по требованиям рана 1. Требования рана 2 перечислены
   отдельным списком с отметкой об отложении и датой решения владельца — это записанный
   дескоуп, а не пропуск.

**Проверка:** `yarn typecheck && yarn build && yarn test` из корня.

**Коммит:** «E7: правки доков и таблица покрытия требований».

---

## Requirement diff

Требования рана 1.

| `Rn` | Строка плана, которая его реализует |
|---|---|
| `R1` | Task 3, шаг 4 — «main и preload остаются на `lib: ["ES2023"]`; рендерер добавляет `DOM`» |
| `R2` | Task 8, шаг 2 — фактические настройки каждого созданного web contents читаются на общей точке; сканирование исходников и пробник в странице идут вторым и третьим рубежом |
| `R3` | Task 4, шаг 1 — «Зарегистрировать схему через `registerSchemesAsPrivileged`» |
| `R4` | Task 3, шаг 3 — `entryFileNames` равным `'[name].cjs'`; Task 5, шаг 6 — один замороженный объект |
| `R5` | Task 5, `Interfaces` — чтение `senderFrame` первым оператором до любого `await`; шаг 3 — разбор значений закрытым союзом и диапазоном, с названным отклонением от буквы «схемой» и его причиной |
| `R6` | Task 5, шаг 9 — тест-страж на голые вызовы IPC и отправку событий |
| `R7` | Task 5, шаг 8 — «Обработчик возвращает `Result`, а не бросает» |
| `R8` | Task 5, `Interfaces` — «Имя `IpcRequest` здесь не используется» |
| `R9` | Task 4, шаги 3 и 4 — один механизм доставки, `script-src 'self'` без nonce |
| `R10` | Task 4, шаг 7 — запрет навигации на единой точке создания web contents |
| `R11` | Task 6, шаг 2 — проигрыватель как единственный источник событий |
| `R12` | Task 6, шаг 2 — «Шаг, пауза, скорость, сброс и выбор дорожки — одной командой» |
| `R13` | Task 6, шаг 5 — «ключ `argv` … **отсутствует**, а не приезжает пустым массивом» |
| `R15` | Task 7, шаг 4 — строка с именем, вердиктом, режимом и временем |
| `R16` | Task 7, шаг 5 — «Свёрнутая полоса из трёх групп, каждая по худшему исходу» |
| `R17` | Task 7, шаг 7 — секции вызова с рабочим каталогом, env и профилем; шаг 13 — `stageDetail` собирает точные данные каждой стадии |
| `R18` | Task 7, шаг 11 — «Оверхед берётся из поля события `complete`, а не считается в UI» |
| `R19` | Task 7, шаг 9 и `commandView` — ветка `not-built` |
| `R20` | Task 7, шаг 9 — «Стадии, которых не было, перечислены отдельной строкой» |
| `R21` | Task 7, шаг 12 — общее состояние фильтра в `App.tsx` |
| `R22` | Task 7, шаг 6 — «Скелет повторяет геометрию наполненной строки бокс в бокс» |
| `R45` | Task 7, шаг 1 — «Ни одного шестнадцатеричного значения в коде E7 не появляется» |
| `R46` | Task 7, шаг 3 — «явный выбор побеждает системный в обе стороны» |
| `R47` | Task 7, шаги 3 и 10 — кольцо фокуса и `MachineText` |
| `R48` | Task 7, шаг 2 — баннер при режиме без песочницы |
| `R49` | Task 7, шаг 14 — AST-страж на кириллицу вне `strings.ts` плюс сверка фрагментов с макетом |
| `R50` | Закрыто до плана: `packages/design/src/css/base.css:109` читается `  background: var(--brand);` |
| `R51` | Task 2, `Interfaces` — новая сигнатура `violationRole` |
| `R52` | Task 2, шаг 5 — число ролей берётся из типа: их шесть, таблица опускает `muted` |
| `R53` | Task 9, шаг 1 — правится число «13», а не список из одиннадцати стадий |
| `R54` | Task 9, шаг 3 — находка о тайминге остаётся в `research.md` до E9 |
| `R55` | Task 3 (флаги фабрики), Task 5 (граница IPC), Task 6 (отсутствие `argv`), Task 2 (роль при пропущенном нарушении), Task 8 (флаги созданного окна) |
| `R56` | Закрыто до плана: `e2e/browser/shot-mockup.mjs` падает на ошибке страницы и водит макет по объявленному контракту состояний |
| `R58` | Task 6, шаг 3 — один трейс, перемотка проигрывателя по `select-track` |
| `R60` | Task 9, шаг 2 — вердиктная формулировка бейджа в S9 |
| `R61` | Task 1, `Interfaces` — параметры вызова в событие **не** добавляются, и там же записано почему: до валидации они непроверены, а `Redaction.stream` не имеет для них члена |
| `R62` | Task 1, `Interfaces` — `argvFromParams` на стадии `build_argv` |
| `R63` | Task 1, шаг 2 — то же поле в `ApprovalRequest` ради вычислимого правила выбора токена |
| `R64` | Task 1, шаг 3 — обязанность писать поле доносится до `v2/e6-audit` с распиской в `WORK.md`, а не устно |
| `R65` | Task 1, шаги 4 и 6 — снапшот обновляется явным скриптом после сборки, правка идёт отдельным коммитом |

Отложено в ран 2 решением владельца от 2026-08-28, с готовым и прошедшим дизайн-ревью
макетом в качестве спецификации. Перечислены поимённо, а не диапазонами: диапазон читается
как покрытие, а проверить его нечем.

`R14` — проверка цепочки в main, у неё без вкладки аудита нет потребителя. Панель нарушений —
`R23`, `R24`, `R25`, `R26`. Policy viewer — `R27`, `R28`, `R29`, `R30`, `R31`. Вкладка аудита —
`R32`, `R33`, `R34`, `R35`. Модалка расхождения lock — `R36`, `R37`, `R38`. Окно подтверждения —
`R39`, `R40`, `R41`, `R42`, `R43`, `R44`. Инбокс апрувов — `R57`. Соответствие ширины гранта —
`R59`.
