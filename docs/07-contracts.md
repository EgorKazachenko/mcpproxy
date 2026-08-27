# 07 — Контракты (E0)

Всё в этом документе замораживается в `packages/contracts` до старта волны 1.
От него зависят семь эпиков.

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
      updateSnapshots:
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
| `string` | `pattern` (regex, обязателен), `maxLength` | подстановка в `{}` |
| `enum` | значение из `values` | подстановка в `{}` |
| `number` | `min`, `max`, целочисленность | подстановка в `{}` |
| `boolean` | — | флаг присутствует или отсутствует |
| `path` | realpath, затем confinement под `root`; отказ при выходе за пределы | абсолютный резолвнутый путь |

**Инварианты схемы:**

- `string` **обязан** иметь `pattern`. Отсутствие regex = ошибка загрузки манифеста, не warning.
- `path` **обязан** иметь `root`.
- `exec[0]` резолвится в абсолютный путь и проверяется по binary allowlist демона.
- Никакой параметр не может влиять на `exec[0]`, `cwd` или профиль песочницы.
- `argv` каждого параметра — массив литералов; `{}` допустим ровно один раз на элемент.

### Риск-тиры

Выводятся из аннотаций, не задаются напрямую. Дефолты пессимистичные (как в спеке MCP).

| Условие | Тир | Поведение |
|---|---|---|
| `readOnlyHint: true` | low | авто |
| `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false` | medium | авто, громкая запись в лог |
| `destructiveHint: true` **или** `openWorldHint: true` | **high** | **out-of-band апрув в Electron** |
| аннотации не заданы | **high** | fail-safe by construction |

## Lock-файл — `mcpproxy.lock`

```json
{
  "version": 1,
  "manifestHash": "sha256:…",
  "tools": {
    "run_tests":      { "hash": "sha256:…", "approvedAt": "2026-08-27T10:00:00Z" },
    "publish_release":{ "hash": "sha256:…", "approvedAt": "2026-08-27T10:00:00Z" }
  }
}
```

Хэш считается по нормализованному представлению рецепта: `exec`, `cwd`, схемы параметров,
аннотации, профиль песочницы, `description`. Расхождение → жёсткий стоп + модалка с диффом
«было / стало». Без этого одобрение рецепта не переживает изменение файла (CVE-2025-54136).

## Схема события аудита

Надстройка над OpenTelemetry GenAI semantic conventions. Базовые поля — их,
наши — в namespace `mcpproxy.*`.

```jsonc
{
  // OTel GenAI
  "gen_ai.operation.name": "execute_tool",
  "gen_ai.tool.name": "run_tests",
  "span.kind": "INTERNAL",
  "trace_id": "…", "span_id": "…", "parent_span_id": "…",
  "start_time": "2026-08-27T10:00:00.000Z",
  "end_time":   "2026-08-27T10:00:12.412Z",

  // mcpproxy
  "mcpproxy.stage": "spawn",            // см. таблицу стадий ниже
  "mcpproxy.verdict": "allowed",        // allowed | denied | pending_approval | error
  "mcpproxy.denyReason": null,          // код причины при denied
  "mcpproxy.recipe.hash": "sha256:…",
  "mcpproxy.argv": ["/opt/homebrew/bin/pnpm", "test", "--testPathPattern", "auth"],
  "mcpproxy.cwd": "/Users/…/proj",
  "mcpproxy.env.allowed": ["PATH", "HOME"],
  "mcpproxy.sandbox.mode": "seatbelt",  // none | seatbelt | container
  "mcpproxy.sandbox.profile": { "read": {…}, "write": {…}, "network": {…} },
  "mcpproxy.sandbox.violations": [
    { "type": "network", "target": "evil.io:443", "action": "denied", "bytes": 0 }
  ],
  "mcpproxy.risk.tier": "low",
  "mcpproxy.risk.annotations": { "readOnlyHint": false, "destructiveHint": false,
                                 "idempotentHint": true, "openWorldHint": false },
  "mcpproxy.approval": null,            // { channel, decision, scope, ttl, decidedAt }
  "mcpproxy.exit.code": 0,
  "mcpproxy.exit.signal": null,
  "mcpproxy.output.bytes": 4211,
  "mcpproxy.output.truncated": false,
  "mcpproxy.redactions": [ { "rule": "aws-access-key-id", "count": 1, "stream": "stdout" } ],
  "mcpproxy.duration.overheadMs": 14,   // время прокси без времени процесса

  // hash-chain
  "mcpproxy.chain.prev": "sha256:…",
  "mcpproxy.chain.self": "sha256:…"
}
```

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

## Контракт IPC

Единственная форма запроса от shim к демону:

```jsonc
{ "recipe": "run_tests", "params": { "pattern": "auth" }, "sessionId": "…" }
```

**Никогда** argv, путь к бинарю, cwd или настройки песочницы. Это структурная защита
от атаки «stdio Transport Security in Proxy Scenarios» из спеки MCP: даже полный
контроль над сокетом не даёт произвольного исполнения.

Транспорт: unix domain socket, права `0600`, проверка peer credentials (uid) на соединении,
per-session токен.
