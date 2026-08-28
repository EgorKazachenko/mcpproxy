# Разведка: `@anthropic-ai/sandbox-runtime` 0.0.74

Источник — распакованный tarball с npm (`dist/**/*.d.ts` и `.js`), а не README.
Версия опубликована 2026-08-26, research preview, 70 версий. Лицензия Apache-2.0.
Зависимости: `@pondwader/socks5-server`, `commander`, `node-forge`, `zod`.

## Публичная поверхность, которая нам нужна

```ts
export declare const SandboxManager: ISandboxManager;   // ГЛОБАЛЬНЫЙ СИНГЛТОН, не класс
export { SandboxViolationStore }
export type { SandboxRuntimeConfig, NetworkConfig, FilesystemConfig, ... }
export type { SandboxViolationEvent }
export type { FilterRequestCallback, RequestDecision }
export type { FsReadRestrictionConfig, FsWriteRestrictionConfig, NetworkRestrictionConfig }
```

## Ф1. Модель прав совпадает с нашей один в один

`dist/sandbox/sandbox-schemas.d.ts:18,34,91`

```ts
interface FsReadRestrictionConfig  { denyOnly: string[];  allowWithinDeny?: string[] }
interface FsWriteRestrictionConfig { allowOnly: string[]; denyWithinAllow: string[] }
interface NetworkRestrictionConfig { allowedHosts?: string[]; deniedHosts?: string[] }
```

Чтение — deny-then-allow, запись — allow-only, сеть — allow-only. Ровно таблица из
`docs/02-architecture.md:141`. Маппинг `SandboxProfile{read,write,network}: AccessRule{allow,deny}`
ложится без натяжки. `allowedHosts` понимает суффикс `:port` (`api.example.com:443`, `*:22`) —
у нас в манифесте порта нет, это расширение на будущее.

## Ф2. Mandatory deny у srt покрывает весь наш список

`dist/sandbox/sandbox-utils.d.ts:5` —
`DANGEROUS_FILES = ['.gitconfig','.gitmodules','.bashrc','.bash_profile','.zshrc','.zprofile','.profile','.ripgreprc','.mcp.json']`,
плюс `getDangerousDirectories()` включает `.vscode`, `.idea`, `.claude/commands`, `.claude/agents`,
плюс `.git/hooks` и (при `allowGitConfig: false`) `.git/config`.

Наш список из `docs/02-architecture.md` — подмножество. Свой хардкод не нужен, и не надо:
дублирующий список разъедется с апстримом молча.

**Оговорка:** `macGetMandatoryDenyPatterns` (`dist/sandbox/macos-sandbox-utils.js:12`) строит
абсолютные пути от `process.cwd()` — то есть от cwd **демона**, не от `cwd` рецепта. Подтёк
закрывают glob-правила `**/<file>`, которые идут рядом с абсолютными, но проверить это тестом
обязательно.

## Ф3. rlimits и таймаутов у srt НЕТ ВООБЩЕ

`grep -rin "rlimit|ulimit|setrlimit|maxBuffer"` по всему `dist/` — **ноль совпадений**.
`timeout` в конфиге и в менеджере — ноль совпадений.

Значит таймаут, cap на вывод и rlimits — целиком наши, вокруг `child_process.spawn`.
И тут развилка: **в Node нет `setrlimit`**. Варианты — нативный аддон, `ulimit` через шелл
(конфликт с инвариантом), либо честно признать границу. Вопрос владельцу.

## Ф4. Форма violation НЕ совпадает с нашим контрактом

`dist/sandbox/macos-sandbox-utils.d.ts:59`

```ts
interface SandboxViolationEvent { line: string; command?: string; encodedCommand?: string; timestamp: Date }
```

Наш замороженный контракт (`packages/contracts/src/event.ts`):

```ts
interface SandboxViolation { type: ViolationType; target: string; action: 'denied'|'allowed'; bytes: number }
```

srt отдаёт **сырую строку лога ядра**. `type`, `target`, `action`, `bytes` надо из неё выводить
парсером. Хуже всего `bytes`: у seatbelt-deny байтов нет в принципе. Единственный источник
байтов — прокси-сторона. Это самый весомый вопрос плана.

`filterRequest?: (request: Request) => Promise<RequestDecision>` (`dist/sandbox/request-filter.d.ts`)
даёт по HTTP-запросу метод, URL, заголовки и решение с причиной — это гораздо лучший источник
сетевых violation, чем парсинг лога. **Бросок или reject = deny** («a buggy policy fails closed»).

## Ф5. Синглтон + корреляция по `commandId`

`SandboxManager` — `const`, а не класс: один на процесс. Отсюда:

- `initialize(runtimeConfig, askCallback?, enableLogMonitor?)` — один раз на демон;
- политика рецепта передаётся **per-invocation** через `customConfig?: Partial<SandboxRuntimeConfig>`;
- `cleanupAfterCommand()` надо звать после каждого вызова;
- `getSandboxViolationStore().getViolationsForCommand(commandId)` и `.subscribe(listener)`.

`WrapWithSandboxOptions.commandId` — «ключи сравниваются по первым 100 символам», и документация
явно требует уникальный id, а не текст команды. У нас есть `traceId`/`spanId` — берём их.

**Параллельные вызовы делят один стор и один `cleanupAfterCommand()`.** Для демона, который может
исполнять два рецепта разом, это ограничение проектирования, а не деталь.

## Ф6. В цепочке на macOS ЕСТЬ шелл

`dist/sandbox/sandbox-manager.js:1371` — дословно:

> On macOS/Linux `argv` is `[binShell, '-c', <wrapWithSandbox result>]` (proxy env is baked into
> that command) and `env` is the unchanged `process.env`

То есть `wrapWithSandboxArgv()` возвращает argv, который мы спавним с `{shell: false}` — но
внутри него `sh -c '<sandbox-exec … quoted>'`. Экспортируемый `quote(args)`
(`dist/utils/shell-quote.d.ts`) — тот самый квотер, одинарные кавычки, без ловушки с `\!`.

Инвариант `docs/02-architecture.md:45` («Только `spawn(argv[])`. Никогда `shell: true`, никогда
конкатенация») формально не нарушен: конкатенируем не мы, `shell: true` не ставим, argv строит
наш builder из E2. Но доказывает инвариант теперь меньше, чем читается. Нужна строка в
`10-honest-limitations.md` и решение владельца.

## Ф7. `env` возвращается нетронутым, `cwd` на macOS игнорируется

Там же: `env` — «the unchanged `process.env`», прокси-переменные вшиты в строку команды.
Наш `env.allow` — это allowlist, ребёнок обязан получить **только** разрешённое. Значит фильтрацию
env делаем мы, и она обязана не сбить вшитые прокси-переменные. Тест обязателен.

`cwd` в `wrapWithSandboxArgv(command, binShell, customConfig, abortSignal, cwd, options)`
помечен «Currently unused on macOS/Linux» — cwd задаём сами в `spawn({cwd})`.
