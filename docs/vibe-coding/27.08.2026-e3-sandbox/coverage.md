# Покрытие R1..R56 — где исполнено и чем проверено

Обход по спеке, а не по коду: для каждого требования — модуль, который его исполняет, и
**утверждение**, которое покраснеет, если исполнять перестанут. Требования, где проверки нет,
названы отдельно внизу — их четыре, и у каждой указана причина.

| R | Исполняет | Краснеет |
|---|---|---|
| R1 | `exec/index.ts`, `exec/policy.ts` | `events.test.ts` — обход графа `.d.ts` от входа + положительный контроль на `seatbelt.d.ts`; `surface.test.ts` — то же для `./policy` |
| R2 | `sandbox.ts` `assertModeSupported` | `sandbox.test.ts` — `seatbelt` на `linux`/`win32` бросает |
| R3 | там же | `sandbox.test.ts` — `container` бросает на обеих платформах |
| R4 | `createSandbox(mode)` | `sandbox.test.ts` — режим приходит параметром |
| R5 | `profile.ts` `buildProfile(NormalizedSandbox, …)` | компилятор: агрегат не подставить |
| R6 | `modes/seatbelt.ts` `toFilesystemConfig` | компилятор: возврат типизирован вендорским `FilesystemConfig` |
| R7 | `profile.ts` | `profile.test.ts` — `read.allow: ['./logs']` чтение не сужает, A10 закрывают дефолты |
| R8 | `profile.ts` `resolveProfilePath` | `profile.test.ts` (тильда, относительные) + `seatbelt.test.ts` (`read.deny: ['./secret.txt']` при cwd ≠ демона) |
| R9 | `profile.ts` `mandatoryDenyGlobs` | `profile.test.ts` — якорь на каждом корне, глоб не литерал, `.git/config` в списке |
| R10 | `modes/seatbelt.ts` | `seatbelt.test.ts` — интеграционный отказ четырёх путей **и** детектор дрейфа вендорского набора |
| R11 | — | ничего не делает намеренно: слот `{}` — ошибка загрузки ещё в E0 |
| R12 | `srt-manager.ts` `applyNetwork` | `seatbelt.test.ts` — два последовательных вызова с разными `allow` по HTTPS |
| R13 | `netpolicy.ts` `assertDomainPatterns` | `netpolicy.test.ts` — таблица конформанса, свойство «не строже вендора», fail-closed |
| R14 | `netpolicy.ts` `isWeakened` | `netpolicy.test.ts` + `profile.test.ts` — голая `*` против `*.github.com` |
| R15 | `srt-manager.ts` `telemetryRecord` | `seatbelt.test.ts` — байты тела HTTPS; граница сырого TCP записана в доках |
| R16 | `limits.ts` | `limits.test.ts` — ноль выживших после таймаута на трёх потомках |
| R17 | `DEFAULT_GRACE_MS` | `limits.test.ts` — grace передаётся и наблюдается через сигнал |
| R18 | `limits.ts` | `limits.test.ts` — `SIGTERM` в grace-окне против `SIGKILL` у игнорирующего |
| R19 | `limits.ts` `StreamCollector` | `limits.test.ts` — граница включительна, `maxBytes: null` без потолка, счёт по байтам |
| R20 | `limits.ts` `redact` + `events.ts` `collapseOutput` | `limits.test.ts` — окно ровно `maxBytes + holdBack`, секрет на границе; `events.test.ts` — сумма и дизъюнкция |
| R21 | `srt-manager.ts` `Semaphore` | `seatbelt.test.ts` — разные политики у последовательных вызовов; атрибуция 250 отказов без потерь |
| R22 | доки | `grep` в `03-threat-model.md`, `10-honest-limitations.md`, `06-epics.md` |
| R23 | `env.ts` | `env.test.ts` — литерал `MINIMAL_PATH`, побеждает даже названный в `allow` |
| R24 | `env.ts` `injected` | `env.test.ts` + `seatbelt.test.ts` — ребёнок видит `code=200`, то есть прокси уцелел |
| R25 | `modes/seatbelt.ts` `build_env` | `events.test.ts` — значение секрета не сериализуется |
| R26 | `srt-manager.ts` `buildFilterRequest` | `srt-manager.test.ts` `telemetryRecord`; регистрация только в `initialize` — по коду |
| R27 | `violation.ts` | `violation.test.ts` — три грамматики, пятьдесят отказов не схлопываются, «неразобрано» отдельным тегом |
| R28 | `violation.ts` `isMandatory` | `violation.test.ts` — глоб против реального пути на глубине; `seatbelt.test.ts` — бейдж под настоящим профилем |
| R29 | `srt-manager.ts` `dispatch` | `seatbelt.test.ts` — колбэк сработал, пока ребёнок ждёт условия |
| R30 | `srt-manager.ts` `wrap` | `srt-manager.test.ts` — идентификаторы не коллидируют после вендорского кодирования |
| R31 | `modes/none.ts` `proxyEnvVars` | `none.test.ts` — обе группы переменных, обе ветки громкого отказа |
| R32 | `modes/seatbelt.ts` `runInMode` | `seatbelt.test.ts` (отказ по домену) + `none.test.ts` (провал запуска) |
| R33 | `runInMode` порядок эмита | `events.test.ts` — `sandbox` не раньше `build_profile`, `mode` всегда рядом с `sandbox` |
| R34 | `exactOptionalPropertyTypes` + эмит | `events.test.ts` — `violations` отсутствует ключом на `build_profile` |
| R35 | `events.ts` `measure` | `events.test.ts` — разрешение тоньше миллисекунды |
| R36 | `profile.ts` `toSandboxProfile` | `profile.test.ts` + `events.test.ts` — в событии сырые пути манифеста |
| R37 | `srt-manager.ts` `doInitialize` | `seatbelt.test.ts` — нарушения непусты; без третьего аргумента их ноль |
| R38 | `events.ts` | `events.test.ts` — p95 по серии из ста, порог 5 мс |
| R39 | `violation.ts` `SUPPRESSED_OPERATIONS` | `violation.test.ts` — универсальное свойство непересечения с `typeForOperation` |
| R40 | `violation.ts` `resolvePath` инжектируется | `violation.test.ts` — `/tmp` → `/private/tmp` с обеих сторон, падение резолвера не роняет |
| R41 | доки | `10-honest-limitations.md` — строка про `exit=0` с телом |
| R42 | доки + корпус | `none.test.ts` — по адресу не наблюдается, по имени наблюдается |
| R43 | `modes/seatbelt.ts` `baseSrtConfig` | `seatbelt.test.ts` — `strictAllowlist` в **применённом** конфиге |
| R44 | `srt-manager.ts` `advanceCursor` | `srt-manager.test.ts` (ветка потери, кольцо из исходника вендора) + 250 отказов |
| R45 | `dispatch`, счётчики `ExecOutcome` | `seatbelt.test.ts` — `attributionForeign`/`attributionMissing` нули на прокси-отказах |
| R46 | `withNetworkPolicy` | `none.test.ts` — после упавшего вызова allowlist пуст и семафор отпущен |
| R47 | `profile.ts` `policyHash` | `profile.test.ts` (сеть меняет хэш) + `none.test.ts` (хэш применённой, не манифестной) |
| R48 | `sandbox.ts` `newCommandId` | `srt-manager.test.ts` — тысяча уникальных, различие в первых ста |
| R49 | `limits.ts` `terminationOf` | `limits.test.ts` — процесс не убит, таймаут побеждает, исход по тому же свидетельству |
| R50 | `makeSandbox` | `none.test.ts` — освобождённая бросает, свежая работает |
| R51 | оба интеграционных набора | `beforeAll` — DNS и доступность публичного хоста как условия прогона |
| R52 | `limits.ts` + `srt-manager.ts` `poison` | `limits.test.ts` `isGroupGone`; `seatbelt.test.ts` — идловый allowlist пуст |
| R53 | `runInMode` `networkPolicy` | `seatbelt.test.ts` — хост в обоих списках отказан |
| R55 | `modes/seatbelt.ts` `tlsTerminate` | `seatbelt.test.ts` — самоподписанный listener даёт не-200 |
| R56 | `srt-manager.ts` `applyNetwork` | `seatbelt.test.ts` — применённый конфиг сохраняет базу под семафором и в простое |

## Требования без исполняемой проверки — четыре, и вот почему

- **R54** (громкая проверка, что `allowedDomains: ['*']` доехал). Исполнено
  `assertWildcardSurvived`, вызывается на каждом вызове в режиме `none`. Ветка **отказа**
  требует вендора, который начал валидировать `updateConfig`, — то есть будущей версии.
  Подделать её мокая `getConfig` значило бы проверять мок.
- **Ветка отравления R52** (`groupDrained === false`). Требует процесса, пережившего SIGKILL.
  Решение по errno вынесено в `isGroupGone` и проверено литералами; сама ветка — нет.
- **`lateUnattributed` (R45)**. Требует гонки с недостаточным drain-окном: тест на неё
  проверял бы задержку машины, а не наш код.
- **`bodyCountFailures` в живом прогоне (R26)**. Инвариант вынесен в `telemetryRecord` и
  проверен литералом; чтобы `countBody` бросил в проде, нужно уже прочитанное тело, а вендор
  отдаёт свежую ветку tee.

Общее у всех четырёх: ветка почти недостижима, и **поэтому** решение из неё вынесено туда,
где его можно подать литералом. Там, где вынести было нечего, отсутствие покрытия объявлено
здесь, а не замолчано.
