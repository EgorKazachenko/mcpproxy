# Reviewer 5 — error-handling / observability coverage

codeTree: `05bbd0ce8611a2fbd63aab8b1c79a62498bdc3a7`

Gate fired: `git diff --name-only origin/main...HEAD` changes 12 non-test `.ts` files under
`packages/core/src/policy/**` plus `packages/core/bin/mcpproxy-lock.mjs`. The path does file
I/O, runs an `fs.watch` watcher, writes a lock file atomically, produces the policy verdict and
builds the `lock_check` audit event. All five questions apply.

**Verdict: EO-BLIND** — 3 Major, 2 Minor.

---

## Major

- **`watch.ts:126-128` — the only production caller of `reloadManifest`/`reloadLock` destroys the
  `ReloadResult`, and no channel exists to recover it. This is R2a inverted at the one place R2a
  was written for.**

  ```ts
  manifest.start(() => void store.reloadManifest());
  lock.start(() => void store.reloadLock());
  ```

  The comment above it says the result "should be parsed by whoever can do something about it —
  the E4 daemon". The E4 daemon structurally cannot: `watchPolicy(store, paths, options)` owns
  the store, calls `reload*` itself, and returns `{ stop(): void }`. There is no `onReload`, no
  emitter, no error field. Trace the observable state after a manifest goes invalid at runtime:

  | observable | before | after invalid manifest lands on disk |
  |---|---|---|
  | `store.current()` | last-good policy | last-good policy (R4, by design) |
  | `store.reloadCount()` | *n* | *n* (increments on success only) |
  | `ReloadResult.diagnostics` | — | produced, then discarded by `void` |

  Every observable is byte-identical between "reload failed" and "reload succeeded, nothing
  changed" — the exact pair R2a names as `fail-open на пути решения`. An operator who fat-fingers
  `mcpproxy.yaml`, or `chmod 000`s it, or has it swapped by the threat model of ADR-0006, gets a
  proxy that serves a stale policy forever with no log line, no audit record and no counter move.
  Question (d) asks me to name the record that would find it: **there is none.** `diagnostics-log.ts`
  builds exactly the record that would — and `grep -rn toLogRecords packages/ docs/` returns only
  `diagnostics-log.test.ts`, `dist/`, and the plan. Zero production callers. On the runtime reload
  path the diagnostics are produced and destroyed inside one expression, so `toLogRecords` has no
  reachable production input at all.

  Refutation attempted and failed: (i) no outer handler — `watchPolicy` is a leaf; (ii) the
  library-returns-values defence does not apply here, because `watchPolicy` *is* the consumer of
  the returned value and it drops it — the value is not "left for the caller", it is destroyed;
  (iii) E4 could bypass `watchPolicy` and wire `dirWatcher` + `reload*` by hand — true, both are
  exported, but that makes `watchPolicy` a shipped, barrel-exported, tested composition whose
  only behaviour on failure is silence. The two `watchPolicy` tests
  (`watch.test.ts:106,128`) both assert the *success* path; nothing asserts what a failed reload
  does, because nothing can.

  Fix (a surfaced value, not a comment): give `WatchOptions` an `onReload: (origin: 'manifest' |
  'lock', result: ReloadResult) => void`, required or defaulted, and call it with every result.
  That is the seam `toLogRecords` was built for and currently lacks.

- **`lock-write.ts:86-106` + `lock-command.ts:71,88-107` — a `writeLock` failure is unclassified,
  escapes `LockCommandOutcome`, and reaches the shell as an unhandled rejection whose exit code
  aliases "the human said no".**

  `LockCommandOutcome` enumerates `written | up-to-date | refused{stale|denied|expect-mismatch|
  reload-failed}`. There is no member for "write failed". `runLockCommand` calls
  `await write(deps.lockPath, buildLock(...))` bare; `mainLockCommand` has no `try`; `bin/
  mcpproxy-lock.mjs` is a bare top-level `await`. Measured on Node v22.15.0, a rejection through
  that chain prints a raw stack trace and **exits 1** — the same code `mainLockCommand` documents
  and returns for `refused`. So `EACCES` on the repo, `ENOSPC`, or a `wx` collision with a
  concurrent `mcpproxy lock` are indistinguishable, at the process contract, from a deliberate
  human refusal. `mainLockCommand`'s own doc-comment — "Возвращает код выхода, а не завершает
  процесс: решать, когда умирать, — дело приложения" — is exactly what the throw revokes.

  Worse, the directory `fsync` block is **outside** the `try` that owns temp-file cleanup and runs
  **after** `rename` has already succeeded:

  ```ts
  const directory = await resolved.open(dirname(lockPath), 'r');
  ```

  If that `open` fails (a platform or filesystem that refuses `O_RDONLY` on a directory, or an
  `EMFILE` at that instant), the lock file *is* on disk and approved, while the command dies with
  a stack trace and exit 1. The operator re-runs and re-approves a lock that was already written.
  `lock-write.test.ts` injects a failing `rename` (line 114) but never a failing `open`, and never
  the directory-sync open specifically — the `recorder` mock returns a healthy handle for both
  opens.

  Refutation attempted and failed: no outer handler exists anywhere (`grep -rn
  'unhandledRejection|uncaughtException|process.on' packages/` over non-dist sources returns
  nothing), and the library-returns-values defence cuts the other way — this is the one place in
  the diff that throws instead of returning a value.

  Fix: add `refused{'write-failed'}` (or a `failed` member carrying `code`/`message` from
  `errnoOf`) to `LockCommandOutcome`, catch around the `write` call, map it to a distinct exit
  code in `mainLockCommand`, and move the directory-sync open inside a block that either cleans
  up or reports "lock written, durability not confirmed" rather than reading as total failure.

- **`confirm-tty.ts:54-60` — `mcpproxy lock` on a non-interactive stdin never settles: the process
  exits 13 with no message, no record and no lock.**

  `nodeAsk` builds a readline interface over `process.stdin` and awaits `rl.question`. Measured
  on Node v22.15.0 with stdin closed (`stdio: ['ignore', ...]`, i.e. CI, a pipe, or an agent
  shelling out): the promise **never settles**; Node prints only `Warning: Detected unsettled
  top-level await` and exits **13**. The rendered diff has already gone to stdout by then, so the
  tail of the output looks like a run in progress. Exit 13 appears in no contract in this diff;
  `mainLockCommand` documents 0/1/2.

  Refutation attempted and failed: spec R17a's "Отдельной проверки «мы в headless?» нет: она была
  бы поверхностью без потребителя" scopes out an *approval channel* for headless mode — it does
  not license the command to hang and vanish. The direction of failure is fail-closed (no lock is
  written), which is why this is Major and not blocking, but it is invisible: nothing distinguishes
  it from a crash, a hang, or a kill.

  Fix: in `nodeAsk`, treat `close` without an answer as a settled refusal (`rl.on('close')` →
  resolve `''`, which `decisionOf` already maps to `denied`), so the command exits through the
  documented `refused` path with a printed reason.

## Minor

- **`lock-command.ts:31-33, 62-70` — the two CVE-2025-54136 detection branches surface a bare
  tag.** `refused{'reload-failed'}` throws away the `ReloadResult` it just inspected, including
  its `diagnostics` or its `code`/`message`; `refused{'stale'}` and `refused{'expect-mismatch'}`
  carry neither the expected nor the actual digest. `mainLockCommand` then prints
  `mcpproxy.lock не записан: reload-failed`. These are precisely the branches that fire when the
  manifest changed under the human between the render and the answer — the attack signal the
  whole module exists to catch — and they reach the operator as one word. This *does* surface and
  *does* classify, so it is not Major; but per question (e) it does not carry the discriminating
  identifier. Widening `refused` to carry the payload is a few lines and is the highest
  value-per-line fix in the diff.

- **`store.ts:82-85` — `errnoOf` dereferences `error` before establishing it is an object.**
  `typeof (error as { code?: unknown }).code` throws `TypeError` if a `StoreDeps` implementation
  rejects with `null` or `undefined`. `StoreDeps` is public (`Partial<StoreDeps>` on `startStore`),
  so this is a caller-reachable way to make the module that documents "**никогда не бросает**"
  throw from inside its own catch block. Not compiler-preventable. One-line guard.

## Candidates raised and killed

- **`lock-write.ts:100-101`, the two `.catch(() => undefined)`.** Killed. Both sit on the cleanup
  path of a `catch` block that ends in `throw error` — the discriminating error always surfaces,
  the swallowed one is only the cleanup's own. Written justification present, and the unique temp
  name means leaked garbage is never reused.
- **`void store.reload*()` as an unhandled-rejection / daemon-crash vector.** Killed by
  measurement, not by argument. I probed `startStore` through `dist` with a lone surrogate in a
  description and with six hostile `timeout` forms; every one returned `invalid-manifest` rather
  than throwing, because `validate/index.ts:98,117` pre-canonicalizes and converts every
  `canonicalizeJcs` `TypeError` into an `invariant` diagnostic, and `validate/lock.ts:107-118`
  does the same for lock snapshots. `reload*` genuinely cannot reject. Finding 1 stands on the
  discarded *value*, not on a discarded rejection.
- **`store.ts:213-217` — `reloadLock` always returns `{outcome:'reloaded'}` even for an unreadable
  or unparsed lock.** Killed: deliberate and documented (R9/R3 asymmetry) — lock failure is the
  *value* `absent`, the caller reads `policy.lock.present` and `verdict.denyReason`, and both are
  typed discriminated unions.
- **`toLogRecords` having no production caller, as a standalone finding.** Killed as standalone:
  R2 assigns the structured log to the E4 daemon, and on the *start* path `StartResult` hands the
  diagnostics to the caller as a value, which is sufficient for a library. It survives only as
  evidence under finding 1, where the value is destroyed rather than handed over.
- **`denyReason` on `lock-drifted` not naming the recipe.** Killed: the verdict carries
  `check.diff` alongside, `lock-tampered` does name its entries, and `denyReason` is explicitly
  the OTLP span-status summary (R12a, `otlp.ts:114,151`), not the full record.
- **The synthesized `size-limit` / `lock` diagnostics carrying `pointer: ''`.** Killed: they do
  not point into the file and say so; the byte count is the discriminating value and it is present.
- **`event.ts` / `lock-check.ts` classification.** Not a finding — this is the diff's strongest
  work. `denyReason` is a typed, prefixed string (`lock-absent:`/`lock-unreadable:`/`lock-unparsed:`/
  `lock-tampered:`/`lock-drifted:`), a policy denial is `verdict: 'denied'` on stage `lock_check`
  and can never be confused with a transport error, and the conditional spread keeps the key out
  of `chain.self` on allow. Questions (c) and (d) are answered affirmatively for the audit path.
