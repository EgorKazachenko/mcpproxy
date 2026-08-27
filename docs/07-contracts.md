# 07 — Контракты (E0)

Всё в этом документе **заморожено** в `packages/contracts`. От него зависят семь эпиков.

**Что означает «заморожено».** Публичная поверхность пакета — `.d.ts` всех трёх входов
плюс файл схемы — снята снапшотом `packages/contracts/api-surface.snapshot.txt`, и
`api-surface.test.ts` краснеет на любом изменении. Снапшот обновляется командой
`UPDATE_API_SURFACE=1 yarn workspace @mcpproxy/contracts test` и только вместе с явным
решением владельца.

`CONTRACTS_VERSION` двигается **только** при несовместимом изменении публичной поверхности —
удалении или сужении экспорта, смене формы замороженного типа, изменении любой из трёх
формул дайджеста. Добавление опционального поля версию не двигает. Бамп всегда идёт одним
коммитом со снапшотом и с ревизией зависимых веток.

Три входа, у каждого свои права на зависимости: `.` — типы и чистые функции без зависимостей
вообще; `./validate` — `parseManifest` (`ajv`, `yaml`, `re2`); `./audit` — хэши (`node:crypto`).
Границу держит `deps.test.ts`, а не обещание в этом абзаце.

## Манифест рецептов — `mcpproxy.yaml`

Лежит в репозитории проекта. Считается **недоверенным** содержимым (см. модель угроз).

```yaml
version: 1

defaults:
  timeout: 120s
  output:
    maxBytes: 65536
    redact: true
  env:
    allow: ["PATH", "HOME", "LANG", "CI"]     # всё остальное вырезается
  sandbox:
    read:  { deny: ["~/.ssh", "~/.aws", "~/.config/gh"], allow: ["."] }
    write: { allow: [] }
    network: { allow: [] }

tools:
  # Рецепт может переопределить любой лист defaults: sandbox, timeout, env, output.
  # Правило слияния — ниже, в разделе «Слияние с defaults».
  run_tests:
    description: "Прогнать тесты проекта"
    exec: ["pnpm", "test"]         # exec[0] резолвится в абсолютный путь из allowlist
    cwd: "."
    params:
      pattern:
        type: string
        required: false
        pattern: "^[\\w./-]{0,64}$"
        argv: ["--testPathPattern", "{}"]     # ДВА отдельных элемента argv
      update_snapshots:                       # имя обязано подходить под ^[a-z][a-z0-9_]{0,63}$
        type: boolean
        required: false
        argv: ["-u"]                          # boolean → флаг присутствует или нет
    annotations:
      readOnlyHint: false
      destructiveHint: false
      idempotentHint: true
      openWorldHint: false
    sandbox:
      write:   { allow: ["coverage", "node_modules/.cache", "/tmp"] }
      network: { allow: [] }
    timeout: 300s

  build_project:
    description: "Собрать проект"
    exec: ["pnpm", "build"]
    cwd: "."
    params:
      target:
        type: enum
        required: false
        values: ["debug", "release"]
        argv: ["--mode", "{}"]
    annotations:
      readOnlyHint: false
      destructiveHint: false
      idempotentHint: true
      openWorldHint: false
    sandbox:
      write: { allow: ["dist", "node_modules/.cache", "/tmp"] }
      network: { allow: [] }
    timeout: 600s

  analyze_logs:
    description: "Разобрать логи приложения"
    exec: ["./scripts/analyze-logs.sh"]
    params:
      file:
        type: path                            # спец-тип: realpath + confinement
        root: "./logs"                        # обязателен для type: path
        required: true
        argv: ["{}"]
    annotations:
      readOnlyHint: true
    sandbox:
      read: { allow: ["./logs"] }

  publish_release:
    description: "Опубликовать релиз"
    exec: ["./scripts/publish.sh"]
    params:
      tag: { type: string, pattern: "^v\\d+\\.\\d+\\.\\d+$", required: true, argv: ["{}"] }
    annotations:
      readOnlyHint: false
      destructiveHint: true                   # → high risk → out-of-band approval
      idempotentHint: false
      openWorldHint: true
    sandbox:
      network: { allow: ["registry.npmjs.org", "api.github.com"] }
```

### Типы параметров

| `type` | Валидация | Раскрытие в argv |
|---|---|---|
| `string` | `pattern` — **синтаксис RE2**, обязателен; `maxLength` | подстановка в `{}` |
| `enum` | значение из `values` | подстановка в `{}` |
| `number` | `min`, `max`, целочисленность | подстановка в `{}` |
| `boolean` | — | флаг присутствует или отсутствует |
| `path` | realpath, затем confinement под `root`; отказ при выходе за пределы | абсолютный резолвнутый путь |

**Инварианты схемы** — выражены структурно и проверяются на загрузке, а не комментарием:

- `string` **обязан** иметь `pattern`. Отсутствие regex = ошибка загрузки манифеста, не warning.
- `pattern` компилируется движком **RE2**: lookahead и обратные ссылки — ошибка загрузки.
  Это часть контракта (ADR: решение D3), а не дефект. Ограничение длины входа от
  катастрофического бэктрекинга не спасает — замер в `10-honest-limitations.md`.
- `path` **обязан** иметь `root`. `root: "/"` и относительный `root`, выходящий за каталог
  манифеста, — ошибка загрузки.
- `exec[0]` — абсолютный путь, голое имя или путь вниз от манифеста (`./scripts/x.sh`), без
  метасимволов оболочки. Резолв в абсолютный путь и сверка с binary allowlist — дело демона.
- Никакой параметр не может влиять на `exec`, `cwd` или профиль песочницы: слот `{}` в любом
  из них — ошибка загрузки.
- `argv` каждого параметра — массив литералов; `{}` допустим не более одного раза на элемент.
- Имена рецептов и параметров ограничены `^[a-z][a-z0-9_]{0,63}$` **и** явным запретом на
  `constructor`, `prototype`, `__proto__`. Одного паттерна мало: `constructor` ему
  соответствует.
- Значения `enum` не могут содержать управляющих и форматирующих символов (`\p{Cc}`,
  `\p{Cf}`) — отравленное значение становится ошибкой загрузки, а не тихо переписывается
  санитайзером. Санитизации подлежит только свободный текст описаний.
- Рецептный `deny`, если ключ присутствует, обязан быть **непустым**: пустой массив —
  единственная синтаксическая форма «снять запрет из defaults», и она запрещена.
- Документ с директивой `%YAML` отвергается целиком, неизвестный тег и дубли ключей — тоже.
  Размер файла ограничен до разбора.

### Слияние с defaults

| Узел | Операция | Почему |
|---|---|---|
| `sandbox.*.allow` | замена по листу | рецепт осознанно сужает или расширяет свой blast radius |
| `sandbox.*.deny` | **объединение**; рецепт не может сокращать | запрет из `defaults` неснимаем |
| `env.allow` | замена по листу | список переменных рецепт задаёт целиком |
| `output.*`, `timeout` | замена | скаляры |
| ключ отсутствует | наследуется из `defaults` | |
| пустой массив в `allow` | «обнулить», не «наследовать» | `network: {allow: []}` — сеть закрыта |
| пустой массив в `deny` | **ошибка загрузки** | см. инварианты выше |

### Риск-тиры

Выводятся из аннотаций, не задаются напрямую. Дефолты пессимистичные (как в спеке MCP).

| Условие | Тир | Поведение |
|---|---|---|
| `readOnlyHint: true` | low | авто |
| `readOnlyHint: true` **и** `destructiveHint: true` | low | `destructiveHint` игнорируется — см. ниже |
| `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false` | medium | авто, громкая запись в лог |
| `readOnlyHint: false` и (`destructiveHint: true` **или** `openWorldHint: true`) | **high** | **out-of-band апрув в Electron** |
| аннотации не заданы | **high** | пессимистичные дефолты спеки |

Вторая строка — оговорка спеки MCP: `destructiveHint` и `idempotentHint` значимы **только**
при `readOnlyHint == false`. Её легко реализовать неверно, поэтому она проверяется тестом.

**Граница гарантии.** Формулировка «fail-safe by construction» неверна и заменена на более
узкую: молчание манифеста может сделать рецепт только **опаснее** — незаданные поля берут
пессимистичные дефолты. Но явный `readOnlyHint: true` тир **понижает**, а спека требует
считать аннотации недоверенными. Значит вторая линия обороны — песочница и lock, а не вывод
тира. Расхождение с lock в тир **не отображается**: это отдельное состояние `LockStatus`,
дающее жёсткий стоп на стадии `lock_check`, а не обычный high-risk апрув.

## Lock-файл — `mcpproxy.lock`

```json
{
  "version": 1,
  "manifestHash": "e3c9b249…",
  "defaults": { "timeoutMs": 120000, "output": {…}, "env": {…}, "sandbox": {…} },
  "tools": {
    "run_tests":      { "recipeHash": "a1b2…", "approvedAt": "2026-08-27T10:00:00Z", "snapshot": {…} },
    "publish_release":{ "recipeHash": "c3d4…", "approvedAt": "2026-08-27T10:00:00Z", "snapshot": {…} }
  }
}
```

Дайджест — 64 строчных hex-символа **без префикса `sha256:`**. Три замороженные формулы:

```
recipeHash   = sha256(utf8(canonicalizeJcs(normalized.own)))
manifestHash = sha256(utf8(canonicalizeJcs(normalizeManifest(manifest))))
argsHash     = sha256(utf8(canonicalizeJcs({ recipeName, params })))
```

Нормализованное представление рецепта хранит **две стороны**. `own` — собственный блок
(`exec`, `cwd`, схемы параметров **в объявленном порядке**, аннотации с применёнными
дефолтами, `description`, собственные `sandbox`/`timeout`/`env`/`output`); именно он и
хэшируется. `effective` — `defaults`, слитый с блоком рецепта; он лежит в снапшоте **ради
диффа и не хэшируется**. Иначе расширение `defaults.env.allow` разъехало бы `recipeHash`
всех рецептов разом и дало бы `drifted` на каждом.

Порядок **параметров** входит в форму — из него собирается argv. Порядок **рецептов** не
входит: они везде адресуются по имени, и заморозив его, мы получили бы жёсткий стоп на
перестановке двух ключей `tools:` с пустым диффом в модалке.

`manifestHash` нужен потому, что `defaults.env.allow: [..., "AWS_SECRET_ACCESS_KEY"]` или
опустошённый `defaults.sandbox.read.deny` не меняют ни одного объекта рецепта: все
пер-рецептные хэши совпадают, `lock_check` зелёный, и подмена проходит молча.

`snapshot` обязателен: SHA-256 необратим, и без него сторону «было» для диффа построить не
из чего. Дифф (`diffLock`) возвращает четыре слота — `defaults`, `added`, `removed`,
`changed`, — и изменение `defaults` попадает в свой слот, а не размножается по всем рецептам.

Расхождение → жёсткий стоп на стадии `lock_check` (`verdict: denied`) + модалка с диффом
«было / стало». Без этого одобрение рецепта не переживает изменение файла (CVE-2025-54136).

## Схема события аудита

**Источник истины — тип `AuditEvent` в `packages/contracts/src/event.ts`.** Здесь описано,
чем он является и почему; поля перечислены там, и дублировать их списком значит завести
вторую копию, которая разойдётся с первой.

Шейп **вложенный**, время — ISO-8601, enum'ы — строки. Это наш внутренний формат, а не
нативный OTel: статус всего `gen_ai.*` — Development, конвенции MCP уже переезжали между
репозиториями, и привязывать замороженный контракт к дрейфующей схеме нельзя. В OTLP событие
отображает чистая функция `toOtlp`.

```jsonc
{
  "operation": "execute_tool",
  "toolName": "run_tests",
  "sessionId": "…", "traceId": "…", "spanId": "…", "parentSpanId": null,
  "startTime": "2026-08-27T10:00:00.000000Z",
  "endTime":   "2026-08-27T10:00:12.412500Z",
  "durationUs": 9120,                   // монотонная длительность СТАДИИ
  "stage": "spawn",                     // см. таблицу стадий ниже
  "verdict": "allowed",                 // allowed | denied | pending_approval | error
  "recipe": { "name": "run_tests", "hash": "a1b2…" },
  "argv": ["/opt/homebrew/bin/pnpm", "test", "--testPathPattern", "auth"],
  "cwd": "/Users/…/proj",
  "env": { "allowed": ["PATH", "HOME"] },
  "sandbox": { "mode": "seatbelt", "profile": {…}, "violations": [{…}] },
  "risk": { "tier": "low", "annotations": {…} },
  "approval": { "channel": "electron", "decision": "approved", "scope": "until",
                "expiresAt": "2026-08-27T10:10:00.000Z", "argsHash": "…", "sessionId": "…" },
  "exit": { "code": 0, "signal": null },
  "output": { "bytes": 4211, "truncated": false },
  "redactions": [{ "rule": "aws-access-key-id", "count": 1, "stream": "stdout" }],
  "duration": { "overheadMs": 14 }      // только на complete
}
```

**Обязательное ядро** — то, что существует на любой стадии, включая `received`: `operation`,
`toolName`, `sessionId`, `traceId`, `spanId`, `parentSpanId`, `startTime`, `endTime`,
`durationUs`, `stage`, `verdict`, `recipe.name`. `sessionId` в ядре не случайно: без него
append-only лог многосессионного демона не может сказать, какая IPC-сессия сделала вызов, —
а это единственный криминалистический артефакт при украденном токене.

**Всё остальное необязательно и появляется на своей стадии.** Необязательное поле
**отсутствует как ключ**, а не приезжает со значением `null`. `null` означает ровно
«известно и пусто» (`exit.signal`, `denyReason` при `verdict: allowed`). Различие не
стилистическое: JCS различает отсутствующий ключ и `null` побайтово, и оба варианта попадают
внутрь хэша цепочки. Вызов, остановленный на `lock_check`, обязан уметь **не иметь `argv`
вовсе** — иначе он понесёт выдуманный `argv: []`, и UI отрисует его как настоящую пустую
команду.

`durationUs` — монотонная длительность стадии из `process.hrtime.bigint()`, целым числом.
Она рядом с ISO-временем, а не вместо: метки, квантованные до миллисекунды, дают ошибку
порядка самого измерения, а часы стены ещё и прыгают по NTP. Оверхед прокси считается по
**непересекающемуся** множеству стадий:

```
overheadMs = round(Σ durationUs по стадиям ∉ {spawn, violation, approval, complete} / 1000)
```

`spawn` — время дочернего процесса; `violation` возникает внутри окна `spawn` и прибавлял бы
уже посчитанное; `approval` — это человек, смотрящий на модалку; `complete` — событие, на
котором значение и вычисляется, так что его собственный `durationUs` ещё не известен.

### Экспорт в OTLP

`toOtlp(event)` даёт валидный OTLP/JSON-спан. Имена полей — **lowerCamelCase**, и это
требование спеки OTLP, а не стиль: приёмник обязан **молча игнорировать** поля с неизвестными
именами, поэтому `trace_id` не даёт ошибки — он теряется. Отсюда тест, запрещающий любой ключ
с подчёркиванием в выводе.

Атрибуты — только те имена, которые действительно существуют в реестре конвенций:

| Атрибут | Значение |
|---|---|
| `gen_ai.operation.name` | `operation` события |
| `gen_ai.tool.name` | имя рецепта |
| `network.transport` | константа `"pipe"` |
| `mcp.session.id` | `sessionId` |
| `mcp.method.name` | константа `"tools/call"` |
| `mcp.protocol.version` | `2025-11-25` |

`mcp.tool.name`, `mcp.request.id` и `mcp.transport` **не существуют** — их нет и не будет.
`jsonrpc.request.id` не эмитится сознательно: id живёт между клиентом и шимом и через
`IpcRequest` не едет; корреляция идёт по `traceId`. `mcp.resource.uri` не эмитится — ресурсов
у нас нет. Собственные поля уезжают в namespace `mcpproxy.*`.

### Стадии вызова

Каждая — отдельное событие. Именно эта пошаговость делает таймлайн наглядным:
видно, на каком шаге вызов остановился.

| `mcpproxy.stage` | Что происходит |
|---|---|
| `received` | Пришёл вызов от клиента |
| `lock_check` | Сверка рецепта с lock-файлом |
| `validate` | Валидация параметров по схеме |
| `resolve_paths` | realpath + confinement |
| `build_argv` | Сборка argv из слотов |
| `classify_risk` | Определение тира по аннотациям |
| `approval` | Ожидание и результат подтверждения |
| `build_env` | Сборка окружения по allowlist |
| `build_profile` | Генерация профиля песочницы |
| `spawn` | Запуск процесса |
| `violation` | Нарушение песочницы (может быть много) |
| `redact` | Редакция вывода |
| `complete` | Завершение, запись в цепочку |

**Правило:** событие пишется на каждой стадии, включая отказ. Отказ без записи в аудит —
баг, а не оптимизация.

## Контракт подтверждений

Формы объявлены в E0 целиком, потому что после заморозки поле сюда не добавить, а без них
не реализуемы ни сценарий S8, ни атака A14, ни ASI09.

| Тип | Значения / поля |
|---|---|
| `ApprovalChannel` | `electron` \| `elicitation` |
| `ApprovalDecision` | `approved` \| `denied` — третьего члена нет: истечение и отмена это **отсутствие** вердикта |
| `ApprovalScope` | `once` \| `until` \| `recipe_and_args` |
| `ApprovalRequest` | `requestId`, `sessionId`, `recipeName`, `argsHash`, `tier`, `argv`, `cwd`, `profile` |
| `ApprovalVerdict` | `requestId`, `sessionId`, `channel`, `decision`, `scope`, `expiresAt` |
| `ApprovalRecord` (в событии) | `channel`, `decision`, `scope`, `expiresAt`, `argsHash`, `sessionId` |

`expiresAt` — **абсолютное** ISO-время, а не относительный TTL: append-only запись читают
через месяцы, и «10 минут» в ней уже ничего не означают. `requestId` непрозрачный и
брендированный — без него вердикт из рендерера может быть отнесён к другому ожидающему
вызову. `sessionId` присутствует и в запросе, и в вердикте, и в записи события: иначе
подтверждение со скоупом `until` оказывается неявно действительным во всех сессиях.

## Контракт IPC

Единственная форма запроса от shim к демону:

```jsonc
{ "recipeName": "run_tests", "params": { "pattern": "auth" }, "sessionId": "…" }
```

Оба идентификатора брендированы в контракте (`RecipeName`, `SessionId`), поэтому
перестановка аргументов на этой границе — ошибка компиляции, а не принятый запрос от чужой
сессии. Лишнее поле в этой форме тоже не компилируется: `argv` сюда не приписать.

**Никогда** argv, путь к бинарю, cwd или настройки песочницы. Это структурная защита
от атаки «stdio Transport Security in Proxy Scenarios» из спеки MCP: даже полный
контроль над сокетом не даёт произвольного исполнения.

Транспорт: unix domain socket, права `0600`, проверка peer credentials (uid) на соединении,
per-session токен.
