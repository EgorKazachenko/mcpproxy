# Пробы по srt 0.0.74

Запущены на macOS Darwin 25.5.0, Node 22, `@anthropic-ai/sandbox-runtime@0.0.74`.
Исходники — `probes/p*.mjs` в этой ветке. Вывод ниже — дословный.

## П1. Формат строки violation и форма argv

```
--- argv[0] ---
/bin/bash
--- argv.length --- 3
--- argv[1] ---
-c
--- env identical to process.env? --- true
--- exit code --- 1
--- stderr --- "cat: /var/folders/.../p1-TGNn5Y/secret.txt: Operation not permitted\n"
--- total violations --- 3
```

```
"bash(10515) deny(1) sysctl-read kern.iossupportversion"
"cat(10515) deny(1) sysctl-read kern.iossupportversion"
"cat(10515) deny(1) file-read-data /private/var/folders/.../p1-TGNn5Y/secret.txt"
```

**Что доказано.** `denyRead` работает. Грамматика ядра — `<proc>(<pid>) deny(<n>) <operation> <target>`.
`env` возвращается тождественно равным `process.env`.

**Что доказано и не ожидалось.**
1. **Шум.** На тривиальный `cat` прилетают два `sysctl-read kern.iossupportversion`. Ни в один
   член `ViolationType` они не отображаются. Пробросив поток сырым, мы зальём таймлайн мусором
   на каждом вызове.
2. **`target` — реальный путь.** В конфиг клали `/var/folders/...`, в строке приехало
   `/private/var/folders/...`. Сопоставление цели с настроенными путями требует нормализации,
   иначе сравнение строк не сойдётся никогда.
3. Прокси поднят даже при `allowedDomains: []`, и **логин прокси несёт base64 от `commandId`**
   (`srt.cHJvYmUtdHJhY2UtMDAwMQ%3D%3D`) — вот механизм атрибуции сетевых нарушений.

**Чего проба не покрывает:** только macOS; Linux-грамматика (seccomp) не проверялась и в срез
не входит.

## П2. Сеть: allowlist, filterRequest, байты

```
netRestriction: {"allowedHosts":["example.com"]}

=== ALLOWED example.com === exit=0
stdout: "<!doctype html><html lang=\"en\">…"
=== DENIED evil.invalid === exit=0
stdout: "Connection blocked by network allowlist"
=== RAW SOCKET to loopback === exit=7

--- filterRequest saw ---
[ { "method": "GET", "url": "http://example.com/", "bodyBytes": 0 } ]
```

```
"deny network-outbound evil.invalid:80 (host is not on the allow list)"
```

**Что опровергнуто.** `filterRequest` вызывается **только для разрешённых** запросов: проверка
allowlist идёт раньше него, и `evil.invalid` до колбэка не дошёл. Посылка R26 в первой редакции
спеки — «сетевые violation строим из `filterRequest`» — ложна для отказов.

**Что доказано.**
1. Грамматика прокси — **другая**: `deny network-outbound <host>:<port> (<reason>)`, без
   `proc(pid)` и без `deny(n)`. Парсер обязан знать две формы, а не одну.
2. `filterRequest` даёт `bodyBytes` — байты **тела запроса**. Для эксфильтрации это ровно та
   величина, которую S5 называет «отправлено 1.2 KB». Байтов ответа он не даёт.
3. **Заблокированный HTTP не роняет команду**: `curl` вернул `exit=0` и тело
   `Connection blocked by network allowlist`. Дочерний процесс видит ответ, а не обрыв.
4. **Loopback закрыт по умолчанию** (`exit=7`): `allowLocalBinding` выключен. Для E8 это прямое
   следствие — локальный listener из `09-metrics-and-eval.md:78` под seatbelt недостижим без
   явного разрешения.
5. `getProxyPort()` и `getSocksProxyPort()` дают один порт — мультиплексированный прокси.
6. Шум пополнился: `mach-lookup com.apple.SystemConfiguration.configd` на каждый `curl`.

**Чего проба не покрывает:** HTTPS с `tlsTerminate` не проверялся; `bodyBytes` для чанкованного
тела не измерялся.

## П3. Mandatory deny — и почему он не сработал

`allowWrite` выставлен на **весь** временный каталог, то есть запись разрешена явно.
`process.cwd()` демона — воркtree, не каталог цели.

```
ordinary.txt (ожидаем успех)       exit=0  stderr=""
.git/hooks/pre-commit              exit=0  stderr=""
.zshrc в каталоге                  exit=0  stderr=""
~/.zshrc настоящий                 exit=1  stderr="sh: /Users/…/.zshrc: Operation not permitted"
```

**Запись в `.git/hooks/pre-commit` и в `.zshrc` прошла.** Защита сработала только для настоящего
`~/.zshrc`.

## П3b. Причина — привязка к cwd демона

Единственное отличие от П3: `process.chdir(dir)` **до** `initialize`.

```
process.cwd() демона = /private/var/folders/.../p3b-jFdZAi
.git/hooks/pre-commit          exit=1  stderr="…Operation not permitted"
.zshrc                         exit=1  stderr="…Operation not permitted"
ordinary.txt                   exit=0  stderr=""
[h] ["bash(12042) deny(1) file-write-data /private/…/p3b-jFdZAi/.git/hooks/pre-commit"]
[z] ["bash(12052) deny(1) file-write-data /private/…/p3b-jFdZAi/.zshrc"]
```

**Что доказано.** `macGetMandatoryDenyPatterns` строит абсолютные пути от `process.cwd()`
**демона**, а `wrapWithSandboxArgv`'s `cwd` на macOS не используется вовсе — это записано в его
собственной документации («Currently unused on macOS/Linux»).

**Следствие для E3, меняющее план.** Демон и рецепт живут в разных каталогах, значит
mandatory-deny из коробки **не защищает** `.git/hooks` и dot-файлы в каталоге рецепта — то есть
ровно то, что показывает сценарий S6. `process.chdir` перед каждым вызовом не годится: cwd
глобален для процесса и гонка неизбежна. Остаётся собирать mandatory-deny пути самим, якоря их
на `cwd` рецепта, и передавать через `filesystem.denyWrite` — там, где `denyWrite` бьёт
`allowWrite`. Наш собственный список из декоративного становится **несущим**.

**Чего проба не покрывает:** поведение при `cwd` рецепта, совпадающем с cwd демона (там всё
работает и без нас) — этот случай маскирует дефект, и тест обязан брать разные каталоги.

## П4. Убийство группы и cap вывода

```
--- БЕЗ detached: kill только по pid ---
выживших sleep после kill(pid): 3

--- С detached: kill по группе ---
выживших sleep после kill(-pgid): 0

--- поведение потока при обрыве чтения (cap) ---
прочитано байт до обрыва: 65536 | порог сработал на: 65536 | exit: null
```

**Что доказано.** Без `detached: true` убийство по pid оставляет **три живых потомка** — то есть
гарантия «наследуется на всё дерево процессов» (`10-honest-limitations.md:14`) без группы не
держится. С `detached: true` и `process.kill(-pid)` выживших ноль. Обрыв чтения на потолке
останавливается ровно на 65536 байт, `exit` при убийстве сигналом — `null`.

**Чего проба не покрывает:** поведение при процессе, который сам меняет группу (`setsid`), не
проверялось — это остаётся признанной границей.

---

# Пробы второго круга — проверка находок ревью

Ревью плана выдало семь блокеров. Три проверены пробой: **два подтвердились, один опровергнут.**

## П5. Работает ли `customConfig.network` — БЛОКЕР ПОДТВЕРЖДЁН

Демон инициализирован с `allowedDomains: ['example.com']`.

```
=== BLOCKER 1: перебивает ли customConfig сетевую политику демона? ===
без customConfig (демон разрешил example.com)        exit=0 blocked=false
customConfig.network.allowedDomains = []             exit=0 blocked=false
customConfig.network.deniedDomains = [example.com]   exit=0 blocked=false
```

**Ни `allowedDomains: []`, ни явный `deniedDomains: ['example.com']` в `customConfig` не
заблокировали соединение.** Сетевую политику определяет конфиг демона, и только он.

Следствие: R6, R12 и R15 в первой редакции неисполнимы. Рецепт A с `network.allow: ['github.com']`
и рецепт B с `network.allow: []` получили бы одинаковую фильтрацию, а профиль в событии врал бы
про «сети нет». Решение владельца — D11.

## П6a. Задержка violations — БЛОКЕР ОПРОВЕРГНУТ

```
ЯДЕРНОЕ нарушение: выход 21 мс, найдено 21 мс, лаг после выхода 0 мс
```

Ревью утверждало, что нарушения приезжают через `log stream` с задержкой в секунды, и потому
R29 (стрим) и полнота `ExecOutcome.violations` недостижимы. На этой машине лаг после выхода
процесса — **ноль**. `setTimeout(2000)` в пробах первого круга был перестраховкой, а не
доказательством лага, и извлекать из него вывод было нельзя.

R29 остаётся в силе. Осторожность, которую находка всё же оправдывает: путь через unified log
асинхронен по природе, поэтому drain-окно перед resolve `run()` и тест на полноту нужны — но как
страховка, а не как признание секундной задержки.

**Чего проба не покрывает:** одна машина, ненагруженный лог. На загруженной системе `log stream`
может отставать сильнее.

## П6b. `enableLogMonitor` по умолчанию — БЛОКЕР ПОДТВЕРЖДЁН

Третий аргумент `initialize` не передан.

```
БЕЗ enableLogMonitor: чтение отказано=true ("cat: /var/folders/..."), нарушений в сторе=0
```

**Песочница работает, наблюдаемость мертва.** Чтение отказано, в сторе ноль нарушений.
Реализация по букве первой редакции плана дала бы ровно это: граница цела, `violation.ts`, R28,
R29, R39, бейдж S6 и половина S5 не работают — а юнит-тесты остались бы зелёными, потому что
кормятся литеральными строками.

## П7. Может ли `filterRequest` понять, чей это вызов — ДА

```
url: http://example.com/
  заголовки: {"accept":"*/*","host":"example.com","proxy-authorization":"Basic c3J0LlNVNVdUME5CVkVsUFRpMUJRVUU9OjRjMzdiNzFhMWQ1NmM4YzEyYjg3ZDZmMGUyY2E0N2Ey", ...}

base64(INVOCATION-AAA) = SU5WT0NBVElPTi1BQUE=
allowedDomains:["*"] пропустил оба?  true
```

`c3J0Llt...` декодируется в `srt.SU5WT0NBVElPTi1BQUE=:4c37b71a...`, где
`SU5WT0NBVElPTi1BQUE=` — это base64 от `INVOCATION-AAA`, то есть нашего `commandId`.

**Значит атрибуция в `filterRequest` возможна:** имя пользователя прокси несёт
`srt.<base64(commandId)>`. Это и есть механизм, на котором строится D11 — принуждение
per-recipe политики в нашем колбэке, а не в конфиге демона. Заодно `allowedDomains: ['*']`
пропускает всё до колбэка, то есть решение целиком наше.

**Чего проба не покрывает:** SOCKS-путь (сырой TCP) до `filterRequest` не доходит; HTTPS без
`tlsTerminate` — тоже. Обе границы закрыты решениями D11 и D12.
