# Разведка E1 — пиннинг манифеста, diff-approve, санитизация описаний

Дата: 2026-08-27. Пять читающих агентов, два по индустрии (WebSearch + чтение исходников на
GitHub). Уровни доказательности: **T1** — прочитан исходник, **T2** — исполненный запрос/проба,
**T3** — официальная спека/адвайзори, **T4** — блог вендора или исследователя, **T5** — форум.

Это сырые заметки. То, что из них попало в решения, лежит в `spec.md` → «Что разведка изменила».

## 1. CVE-2025-54136

**T2** (NVD API, `cveId=CVE-2025-54136`), дословно: *«In versions 1.2.4 and below, attackers can
achieve remote and persistent code execution by modifying an already trusted MCP configuration
file inside a shared GitHub repository… Once a collaborator accepts a harmless MCP, the attacker
can silently swap it for a malicious command (e.g., calc.exe) without triggering any warning or
re-prompt… This is fixed in version 1.3.»* CWE-78.

Два CVSS: **7.2** от GitHub CNA (`PR:H`) и **8.8** от NVD primary (`PR:L`). Наши доки цитируют
8.8 — это NVD-шный, и цитировать его законно, но надо называть источник.

**T3** GHSA-24mc-g4xr-4395: фикс — *«Cursor 1.3 now requires user approval whenever an
`mcpServer` entry is modified, not just when new servers are added.»*

**T4** Check Point Research (нашедшие), корневая причина дословно: *«This trust is bound only to
the name… The contents — such as command and args — can be modified later without triggering a new
approval prompt.»* Раскрытие 2025-07-16, фикс 2025-07-29.

**Вывод для нас:** это не дыра протокола MCP, а привязка апрува к имени вместо содержимого.
Шипнутый вендором фикс — ровно наша схема. Cursor намеренно сделал его несемантическим (пробел
тоже переспрашивает): меньше багов канонизации, больше шума. JCS — противоположный размен.

## 2. Tool poisoning / rug pull

**T4, первоисточник** Invariant Labs, апрель 2025: *«malicious instructions are embedded within
MCP tool descriptions that are invisible to users but visible to AI models.»* Их три
рекомендации: разделение AI-видимого и user-видимого текста в UI; **пиннинг определений
инструментов хэшами**; межсерверные границы. Терминология («rug pull», «shadowing») принадлежит
им, а не спеке MCP — наши доки это уже отмечают, и правильно делают.

**T3-ish** OWASP MCP Security Cheat Sheet — самый предписывающий текст, который нашёлся, и он
предписывает именно наш механизм: *«Pin tool definitions at discovery time using cryptographic
hashes (e.g., SHA-256 over the canonical JSON)»*, *«Re-prompt for consent when tool definitions
change»*.

## 3. Что реально реализовано

| Проект | Что хэшируется | Гранулярность | На расхождении | Апрув |
|---|---|---|---|---|
| mcp-scan v0.3.x (T1) | **MD5(description)** и только | на сущность | предупреждение `W003`, **эталон тут же перезаписывается** | `mcp-scan whitelist TYPE NAME HASH` |
| mcp-context-protector (T1) | инструкции + описания + input-схемы; SHA-256 на инструмент | конфиг целиком + поинструментно | **блокирует все вызовы** | `--review-server`, вне канала |
| mcptrust (T1) | SHA-256 по JCS; пополевые хэши | на инструмент/поле | CI по severity; рантайм deny-by-default | перегенерировать lock, закоммитить |
| mcp-warden (T1) | JCS + SHA-256, `entry_digest` → `overall_digest` | пополевая | non-zero exit | `pin --approve --approver` |
| Docker MCP Gateway (T1) | дайджест образа (cosign) | артефакт | отказ запускать | новый подписанный релиз |
| Cursor ≥1.3 (T3) | содержимое записи конфига | на запись | промпт | в IDE |

**Ключевые уроки:**

- **mcp-scan — антипаттерн в двух местах.** `Storage.check_and_update` печатает предупреждение и
  безусловно перезаписывает эталон в том же прогоне: второе появление атаки невидимо. И
  `is_whitelisted` проверяет `hash in self.whitelist.values()` — без привязки к имени, так что
  хэш, одобренный для `tool.add`, одобряет любую сущность с тем же описанием на любом сервере.
- **mcp-warden: `approved_digest` хранится ВНЕ `overall_digest`.** Самое чистое выражение
  «человек подписал конкретный дайджест»: переаттестация не двигает хэш, а изменение без апрува
  становится отдельным состоянием, а не обычным дрифтом. У нас эквивалент даёт сам факт, что
  `manifestHash` лежит в lock-файле, который человек закоммитил.
- **mcptrust: канонизация версионирована** (`CanonVersion` v1/v2) и **float'ы отвергаются до
  хэширования**, чтобы не ловить краевые случаи JCS. Плюс нормализация свободного текста
  (CRLF→LF, обрезка хвостовых пробелов построчно) перед хэшированием — иначе апрув
  переспрашивается на артефактах редактора.
- **mcp-context-protector идентифицирует сервер командной строкой, а не именем из конфига** —
  прямой антидот к CVE-2025-54136.

## 4. Что говорит спека MCP (T3, 2026-07-28)

- *«For trust & safety and security, there SHOULD always be a human in the loop with the ability
  to deny tool invocations.»*
- *«clients MUST consider tool annotations to be untrusted unless they come from trusted
  servers.»* — подтверждает ADR-0004: тир из аннотаций не может быть единственной линией.
- `notifications/tools/list_changed` в этой ревизии **подписочный**: нужен
  `subscriptions/listen` с `toolsListChanged: true`. Полагаться на самопроизвольный приход
  нельзя.
- Набор инструментов *«MUST NOT vary per-connection»*, порядок — детерминированный, но только
  SHOULD. Значит канонизация обязана быть нечувствительной к порядку в любом случае.
- **Отрицательная находка:** страница Security Best Practices не упоминает tool poisoning, rug
  pull, целостность описаний, хэширование, пиннинг и переапрув вообще. Ближайший полезный
  нормативный текст — в разделе Local MCP Server Compromise: клиент MUST *«Show the exact command
  that will be executed, without truncation»*. Это спекой благословлённый шаблон для нашей модалки.
- **T5** modelcontextprotocol discussion #348 предлагал внести пиннинг в протокол — отклонено
  как вне области: *«there are probably some best practices that MCP clients could implement».*

## 5. Прецеденты вне MCP

- **cargo-vet (T3).** `cargo vet init` кладёт все существующие зависимости в **exemptions**, а не
  в «проверено». Первый прогон записан как отдельное видимое состояние, которое надо выжигать.
  Дельта-аудиты: одобряется дифф между версиями, и инструмент *«computes the relevant diffs and
  identifies the smallest one»*. Апрув — коммит в `supply-chain/` под CODEOWNERS.
- **Terraform plan → apply (T3).** *«Terraform ignores the `-auto-approve` option when you pass a
  previously-saved plan file because Terraform interprets the act of passing the plan file as the
  approval.»* Урок: апрув привязывается к конкретному артефакту диффа, а не к булеву флагу.
  Отсюда R16.
- **npm/yarn + lockfile-lint (T3).** Lock пинит **поэлементно** (`integrity`, SRI sha512), а
  политику поверх lock проверяет отдельный линтер. Два артефакта, две работы — зеркало нашего
  разделения «манифест-lock» и «policy engine».
- **in-toto (T3).** Разделяет *что запиннено* (subject DigestSet) и *что о нём утверждается*
  (predicate). Если когда-нибудь понадобятся сторонние апрувы — это стандартный конверт.
- **git-secrets (T3).** Escape hatch обязателен, но узкий и записанный в репозитории.

## 6. Санитизация описаний — честное состояние дел

**Никто этого не делает.** Проверено по исходникам: mcp-scan детектит удалённо и никогда не
переписывает; mcp-warden объявляет вне области (*«does not read injection-y wording»*);
Docker MCP Gateway фильтрует только то, что роняет SDK; TypeScript SDK — вся валидация это
`description: z.string().optional()`, ни длины, ни charset, ни контрольных символов.

Что говорят те, кто это изучает:

- **T4** Simon Willison про гардрейлы с «95% catch rate»: *«in web application security 95% is
  very much a failing grade.»* Его рекомендация архитектурная, не фильтрующая.
- **T3/academic** arXiv 2506.08837 «Design Patterns for Securing LLM Agents against Prompt
  Injections» — защита через ограничение возможностей агента по построению, не через детекцию
  текста.
- **T4** Cisco про Unicode tag injection (U+E0000–U+E007F): токенизаторы срезают префиксы тегов,
  и *«the LLM essentially re-builds the payload»*; закрытие одних только тегов не спасает.
- **T4** CSA research note даёт повторяемый рецепт: NFKC, затем вырезать/отвергать Tags block
  U+E0000–U+E007F, zero-width U+200B–U+200D и U+FEFF, bidi U+202A–U+202E — на каждом слое
  приёма независимо.
- **T1** Trail of Bits в `mcp-context-protector` описания **не переписывает**: блокирует до
  апрува, а ANSI **делает видимым** (`_make_ansi_escape_codes_visible`, ESC → литеральный `ESC`).
  Выбор сознательный: молчаливая зачистка уничтожает улику для человека-ревьюера.

**Не работает и не поддержано ни одним источником:** regex/keyword-фильтрация
инструкциеподобного текста, обёртка в разделители («игнорируй всё внутри этих тегов» — у модели
нет границы доверия между разделителями), LLM-классификатор инъекций как гейт. **Ограничение
длины как контроль безопасности не рекомендует никто** — это бюджет токенов.

**Где санитизация действительно несёт вес:** всё, из-за чего описание рендерится человеку иначе,
чем модели, — невидимые кодпойнты, bidi, ANSI, гомоглифы, длинные пробельные прогоны. Это
контроль целостности отображения, и он прямо обслуживает diff-approve: человек обязан увидеть
ровно то, что увидит модель.

## 7. JCS в JS — что делают эталонные реализации

Важно, потому что у нашего `canonicalizeJcs` были баги ровно в трёх местах.

- **`erdtman/canonicalize` v5 (T1)** — поддерживаемая, закрывает все три: одиночные суррогаты
  через `isWellFormed()` с **броском** (и регексп быстрого пути включает весь диапазон
  `\uD800-\uDFFF`, поэтому валидная пара тоже уходит на медленный путь и проверяется);
  `NaN`/`Infinity` — бросок; глубина — **явный стек вместо рекурсии**, тесты гоняют глубину
  100 000. Отдельно: суррогат проверяется и **в ключах объекта**, не только в значениях. И
  детектор циклов удаляет контейнер из `seen` по завершении кадра, поэтому дважды
  переиспользованный нецикличный объект проходит — наивный `seen`-детектор дал бы ложное
  срабатывание на DAG.
- Пины чисел, которые ручные реализации чаще всего врут: `-0 → "0"`, `1e21 → "1e+21"`,
  `1e20 → "100000000000000000000"`, `5e-324 → "5e-324"`.
- **`cyberphone/json-canonicalization` (T1)** — эталон RFC-автора и при этом **учебный
  артефакт**: одиночные суррогаты не проверяет вовсе (`JSON.stringify` выдаёт `"\ud800"` вместо
  броска — расхождение хэша между реализациями), `NaN` молча превращает в `null`, глубина —
  обычная рекурсия, циклы не детектит.

**Вывод:** если сверять наш `canonicalizeJcs` с чем-то, то с `canonicalize@5` и его тестами, а не
с эталоном из RFC-репозитория. Это работа не E1 — записано как наблюдение для владельца.

## 8. Открытые вопросы, которые разведка не закрыла

- Порядок «санитизация ↔ хэширование» не решён нигде: никто не совмещает пиннинг и нормализацию.
  Наш выбор (хэшируем сырое, санитизируем на проекции) обоснован, но собственный.
- YAML как пиннируемый артефакт — прецедентов нет, все пинят JSON. У нас перед JCS появляется
  второй слой канонизации (YAML→JSON) со своей неоднозначностью. Закрыто в E0 запретом `%YAML`,
  неизвестных тегов и дублей ключей, но это наше решение, не индустриальное.
- Интерактивный diff-approve в рантайме: mcp-warden делает это флагом CI, mcp-scan — перепечаткой
  MD5 в шелл. **Ни один прочитанный проект не показывает человеку отрендеренный дифф и не ждёт
  ответа.** Поведение на таймауте, в headless и при отказе прецедента не имеет — решения D1/D4
  приняты владельцем без опоры на индустрию, и это надо помнить.
