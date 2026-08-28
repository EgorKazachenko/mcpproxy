# Обратная совместимость — E7 UI (перечтение дельты)

- **HEAD** `cad08c39318abcc9ffe47cc8e30d785231ecf18d`
- **codeTree** `c86e85bd469ec2b6dad402b020ca02b2dae12a2b`
- **Перечитанная дельта** `bc3e9630d99bfd702ae37e73063d88e258424ad5..HEAD`
- **База ветки** `59235c32858461bc68812dcb71842adc0cd83900`
- **Вердикт: `BC-SAFE`.** MAJOR прошлого прогона закрыт общим лечением, и лечение проверено
  A/B-прогоном старого и нового канонизатора: на **всяком** валидном входе байт в байт то же.

## Что закрыто

- **MAJOR «дырка в массиве канонизацию не роняет» — ЗАКРЫТ.** `packages/contracts/src/jcs.ts:87-92`
  теперь отвергает дырку тем же `TypeError`, что и нефинитное число; тесты — `jcs.test.ts:84-102`,
  с положительным контролем (`canonicalizeJcs([1,3]) === '[1,3]'`), то есть зонд ловит дырку, а не
  массивы вообще. Выбран вариант (а) из прошлого разбора — самый сильный из трёх.
- **JSDoc больше не переобещает.** `packages/contracts/src/event.ts:112-115` и его копия в
  снапшоте теперь говорят «обе проверки живут в `jcs.ts` и покрыты тестами», и это правда.
  `packages/contracts/src/approval.ts:65-79` про канонизацию не утверждает **ничего** — там только
  инвариант индексов как обязанность производителя, так что переобещания нет и не было.
  `WORK.md:84-86` приведён в соответствие.
- **VALID-NOT-BLOCKING про `argvFromParams: undefined` — снят у единственного производителя.**
  `packages/desktop/scripts/build-fixtures.mjs:88` собирает **ключ**, а не значение:
  `...(argvFromParams === undefined ? {} : { argvFromParams })`.

## Ось 1 — старый вызывающий → новый код: сужение домена ничего валидного не теряет

Проверено A/B: копия собранного `packages/contracts/dist` с вырезанным циклом-проверкой против
неё же нетронутой (обе в скретчпаде, репозиторий не трогался).

- **20 000 случайных валидных JSON-значений** (объекты/массивы/скаляры, глубина до 5):
  `ok=20000 throw=0 diverged=0`.
- **Структурный корпус из 31 формы** — расхождений ровно 5, и все пять это дырка:
  `[,,1]`, `{a:[[1,[,,1]]]}`, `[0,,0]`, `new Array(2)`, `[ , ]`. Старый код на них отдавал
  **не-JSON** (`[,,1]`, `[,]`) либо коллизию (`[ , ]` → `[]`, неотличимо от пустого массива).
  Ни один валидный вход не начал бросать.
- **Явный `undefined` в массиве** бросал и раньше (`значение типа undefined не сериализуется`),
  и после — один и тот же текст. Новое поведение здесь не появилось.
- **Дырок в дереве не производит никто.** `new Array(`, `delete x[i]`, `arr.length = n` по
  `packages/*/src` и `packages/desktop/scripts` — попаданий вне тестов ноль.
- `Object.hasOwn` доступен: `tsconfig.base.json` — `target/lib ES2023`, корневой
  `engines.node >= 22`, и та же функция уже используется в `core/src/env/build.ts:75`.

## Ось 3 — старые данные → новый код: ни один дайджест не изменился

- **55 записей `packages/desktop/fixtures/demo.jsonl`**: `chainHash` старой и новой сборки —
  `records=55 diverged=0 oldThrow=0 newThrow=0`; `verifyChain` обеими — `{"ok":true}`.
- **`readLog` + `verifyLog` из `packages/core/dist` поверх нового контракта**:
  `records 55, malformedAt null, trailingPartial false, future 0, legacy 0`,
  `verifyLog {"ok":true,"count":55}`.
- **Запись, которую СТАРАЯ сборка могла посадить на диск из дырявого массива**, перечитана
  обеими: `self` на диске `ccb49c37…`, перепроверка старым кодом `5d4c3ca5…`, новым — тот же
  `5d4c3ca5…`; `verifyChain` обеими даёт `{"ok":false,"brokenAt":0}`. То есть уже испорченная
  запись испорчена **ровно так же**, а не иначе: новый код её не портит и не «чинит».
  Читатель дырку получить не может в принципе — путь чтения всегда `JSON.parse`
  (`core/src/audit/log.ts:214`, `desktop/src/main/trace.ts:24`), а JSON дырок не имеет.
- **Бросок теперь случается только на записи** (`append` → `chainHash`, `log.ts:385`) — это та
  сторона, на которой безопасно: отказ ДО `append` вместо навсегда неверифицируемой строки в
  append-only логе. Класс отказа не новый: `TypeError` из `canonicalizeJcs` вызывающий уже
  обязан был ловить из-за нефинитного числа, суррогата и глубины.

## Ось 4 — поверхность и версия

- **Снапшот сходится с собранным `dist` байт в байт**: прогон `currentApiSurface()` из
  `packages/contracts/dist/api-surface.js` против `api-surface.snapshot.txt` — `84302/84302, identical: true`.
- **Диф снапшота от базы ветки аддитивен по типам**: два необязательных поля
  (`ApprovalRequest.argvFromParams?`, `AuditEvent.argvFromParams?`). Единственная `-`-строка —
  строка таблицы внутри JSDoc (`| build_argv | argv |`). Сигнатура `canonicalizeJcs` не тронута.
- **`CONTRACTS_VERSION` = 1, не двинут — и правильно.** `docs/07-contracts.md:13-15`: версию
  двигают удаление, сужение, смена формы замороженного типа и изменение любой из четырёх формул
  дайджеста. Формула не менялась — доказано A/B выше; тип не менялся; добавление опционального
  поля версию не двигает по букве правила.
- **Строка `ApprovalRequest` в `docs/07-contracts.md:490` обновлена верно** — `argvFromParams?`
  стоит между `argv` и `cwd`, ровно как в `packages/contracts/src/approval.ts:63-80`, и абзац
  под таблицей повторяет обязанность E5 переносить индексы, а не пересчитывать.

## Открытые (не блокирующие)

- **Гейт заморозки типовой, а не поведенческий.** Сужение рантайм-домена замороженной
  `canonicalizeJcs` снапшот не видит вовсе: диф поверхности показал только JSDoc. Здесь сужение
  желаемое и проверенное, но тот же гейт пропустил бы и вредное. Единственная защита — тесты
  `jcs.test.ts`; они есть.
- **`handoff-notes.md:92-94` расходится с `WORK.md:81-83` в одной и той же дельте.** Расписка
  говорит «нарушение даёт дыру в отрисовке, `noUncheckedIndexedAccess` вернёт `undefined`»;
  `CallDetail.tsx:110` по `fromParams` не индексирует — `fromParams.includes(index)`. WORK.md это
  уже формулирует правильно. Ошибка в безопасную сторону, но два документа теперь говорят разное.
- **MINOR `violationRole` — статус изменился, риск не вырос.** Пакет `@mcpproxy/design` в дельте
  не тронут (`git diff … -- packages/design` пуст), но потребители у функции ТЕПЕРЬ есть и они
  в дереве: `desktop/src/renderer/timeline/StageList.tsx:32` и `callLine.ts:48,94,100,132`, все
  под новой сигнатурой `violationRole(type, action)` и под `tsc -b`. Деструктивная правда та же:
  у `@mcpproxy/design` нет снапшота поверхности, поэтому внешнего потребителя гейт бы не поймал.
  Пакет `private: true`, внешних потребителей нет.
- **MINOR `@mcpproxy/desktop` без `exports` — без изменений.** В дельте `package.json` получил
  только скрипт `build:smoke` и две devDep; блока `exports` по-прежнему нет, `main: out/main/index.js`
  на месте. Констатация, а не требование.
- **`Player` получил обязательный член `stop`** (`main/player.ts:10`). Реализация в дереве одна
  (`createPlayer`), пакет-приложение, внешних реализаторов нет.
- Остальные VALID-NOT-BLOCKING прошлого прогона (JSON Schema трогать не требовалось; индексы после
  `redactInbound` не разъезжаются, `core/src/redact/output.ts:153`; фикстура — уже существующий
  производитель; поле не течёт в OTLP; смешанный лог читается) перепроверены и стоят как были.

**Вердикт: `BC-SAFE`.**

---

# Приложение: как именно проверялось (полные выводы)

Все прогоны — только чтение. Собранный `packages/contracts/dist` скопирован в скретчпад дважды;
у копии `dist-old` вырезан ровно цикл-проверка дырки (241 символ), остальное байт в байт.

## 0. Точка привязки

```
$ git rev-parse HEAD
cad08c39318abcc9ffe47cc8e30d785231ecf18d

$ git status
On branch v2/e7-ui
Your branch is ahead of 'origin/v2/e7-ui' by 2 commits.
Changes to be committed:
	modified:   docs/vibe-coding/27.08.2026-e7-ui/.gates/build-test.json
```

Дельта `bc3e963..HEAD`: 47 файлов, +1716/-155. Контрактных из них четыре —
`api-surface.snapshot.txt`, `src/event.ts`, `src/jcs.ts`, `src/jcs.test.ts`.

## 1. Сам фикс

`packages/contracts/src/jcs.ts:80-92` — проверка стоит ПЕРЕД `map`, отказ тот же `TypeError`:

```js
for (let index = 0; index < object.length; index += 1) {
  if (!Object.hasOwn(object, index)) {
    throw new TypeError(`дырка в массиве в позиции ${index}: значение не канонизируется`);
  }
}
return `[${object.map((item) => canonicalize(item, depth + 1)).join(',')}]`;
```

Цикл ничего не возвращает и ничего не меняет — на плотном массиве выход тот же символ в символ.
Это проверено эмпирически, а не выведено из чтения (см. §2).

## 2. A/B старого и нового канонизатора

### 2.1 Структурный корпус (31 форма)

```
same     "ok:[]"                        -> "ok:[]"
same     "ok:[1,2,3]"                   -> "ok:[1,2,3]"
same     "ok:{\"argvFromParams\":[0,1,2]}" -> "ok:{\"argvFromParams\":[0,1,2]}"
same     "ok:1e+21"                     -> "ok:1e+21"
same     "ok:[1,[2,[3,[4,[5]]]]]"       -> "ok:[1,[2,[3,[4,[5]]]]]"
DIVERGE  "ok:[,,1]"                     -> "throw:дырка в массиве в позиции 0"
DIVERGE  "ok:{\"a\":[[1,[,,1]]]}"       -> "throw:дырка в массиве в позиции 0"
DIVERGE  "ok:[0,,0]"                    -> "throw:дырка в массиве в позиции 1"
same     "throw:значение типа undefined не сериализуется в JSON" -> (то же)
DIVERGE  "ok:[]"        (new Array(2))  -> "throw:дырка в массиве в позиции 0"
DIVERGE  "ok:[,]"       ([ , ])         -> "throw:дырка в массиве в позиции 0"
diverged = 5
```

Каждое расхождение — дырка, и в каждом старый выход был либо не-JSON (`[,,1]`, `[,]`), либо
коллизией (`[ , ]` → `[]`). Ни одного случая «валидное значение начало бросать».

### 2.2 Случайный фуз

```
cases=20000 ok=20000 throw=0 diverged=0
```

### 2.3 Корпус реальных записей

```
$ node ab.mjs dist-old dist-new packages/desktop/fixtures/demo.jsonl
records=55 diverged=0 oldThrow=0 newThrow=0
verifyChain(new) = {"ok":true}
verifyChain(old) = {"ok":true}
```

### 2.4 Запись, которую старая сборка могла написать из дырявого массива

```
line on disk        : {"schema":"mcpproxy.audit.v1","ts":"2026-08-01T00:00:00.000Z",
                       "argvFromParams":[null,3],"chain":{"prev":null,"self":"ccb49c37…"}}
self written (old)  : ccb49c372105d7e18bd2df20a8decf7a68aaf5335823bea11e64edfc4df43423
reverify OLD code   : 5d4c3ca52f31ebdd20e3a3aeb4ab3b628e9f97ccf48a44b7f3f18dd7ea3672e1 => match false
reverify NEW code   : 5d4c3ca52f31ebdd20e3a3aeb4ab3b628e9f97ccf48a44b7f3f18dd7ea3672e1 => match false
verifyChain old     : {"ok":false,"brokenAt":0}
verifyChain new     : {"ok":false,"brokenAt":0}
new write           : throws TypeError
```

Читается так: испорченная старым багом запись под новым кодом испорчена ТОЧНО так же —
ни один дайджест не поехал, ни одна ранее верифицируемая запись не перестала верифицироваться.
А тот же вход на ЗАПИСИ теперь отбивается до `append`.

## 3. Читатели

```
$ node -e "readLog + verifyLog из packages/core/dist по фикстуре"
records 55 malformedAt null trailingPartial false future 0 legacy 0
verifyLog {"ok":true,"count":55}
```

Дырка на чтении невозможна структурно: `core/src/audit/log.ts:214` — `JSON.parse(line)`,
`desktop/src/main/trace.ts:24` — `JSON.parse(trimmed)`. JSON дырок не кодирует; `[null,3]`
разбирается в плотный массив. Следовательно новая проверка на пути чтения не срабатывает
никогда, и `isReadableRecord` (`log.ts:157-182`, включая свой `try { canonicalizeJcs } catch`)
ведёт себя на старых данных идентично.

## 4. Поверхность

```
$ node -e "currentApiSurface() vs api-surface.snapshot.txt"
bytes cur/snap: 84302 84302 identical: true
```

Диф снапшота от базы ветки: `+ readonly argvFromParams?: readonly number[];` дважды, плюс
JSDoc; единственная `-`-строка — `| build_argv | argv |` внутри комментария, заменённая на две.
`CONTRACTS_VERSION = 1` (`src/index.ts:18`), не двинут; правило — `docs/07-contracts.md:13-15`.

## 5. Прочие файлы дельты, просмотренные на предмет BC

- `main/ipc.ts` — `guarded` обзавёлся `try/catch` и `.catch` на промис: строго толерантнее.
- `main/protocol.ts` — проверка `url.host !== APP_HOST` → 404. Сужение, но схема `app://`
  внутренняя, внешних потребителей нет.
- `main/index.ts` — `whenReady().then(ok, fail)` c `app.exit(1)`; `player.stop()` по `closed`.
- `main/player.ts` — новый обязательный член `Player.stop`; реализация в дереве одна.
- `fixtures/marks.json` — 20/7 → 42/29, следствие двух новых прогонов в фикстуре; файл
  перегенерируем скриптом, потребитель — только `main/index.ts`.
- `packages/design` — в дельте не тронут вовсе.
