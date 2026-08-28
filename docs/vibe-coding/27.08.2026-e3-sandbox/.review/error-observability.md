# Error-handling / observability — E3 executor and sandbox

codeTree: `6db5a00a0b4670b0c2c4c2cd3d96de6eb09c9cbb`

Diff: `git diff e40b7de..HEAD -- packages/core/src` (worktree `v2/e3-sandbox`).
Scope: `packages/core/src/exec/**`. Repo has **no ESLint/Biome config at all** (checked: no `.eslintrc*`,
no `eslint.config*`, no `biome.json`, no lint script in either `package.json`) — so nothing here is
"already enforced by the linter", and every finding below is one no tool in this repo would catch.

**Verdict: EO-BLIND** — 5 Major, 2 Minor.

## Findings

- **`packages/core/src/exec/limits.ts:169-176` (`groupAlive`) — Major — errno-blind catch turns "cannot
  confirm" into "confirmed empty".** `process.kill(-pid, 0)` throws `ESRCH` when the group is gone, but
  also `EPERM` (some member is no longer signalable by us) and `EINVAL`; the catch collapses every errno
  into `return false`. `confirmGroupEmpty` (`:178-185`) then returns `true`, `RawRun.groupDrained` is
  `true`, and `withNetworkPolicy` (`srt-manager.ts:390-397`) never poisons. R52 says a group that cannot
  be confirmed empty must refuse loudly; here the one probe that decides it reads "I was not allowed to
  ask" as "there is nobody to ask about". What becomes invisible: a surviving descendant still bound to
  the proxy port, which then runs under the **next** invocation's policy (`['*']` in `none`) — with
  `groupDrained: true` in the record, no poison, and no counter, no query can distinguish this from a
  clean exit. Fix: inspect `(error as NodeJS.ErrnoException).code` — only `ESRCH` returns `false`;
  every other code returns `true` (unknown ⇒ alive), so `confirmGroupEmpty` fails and R52's poison fires.

- **`packages/core/src/exec/limits.ts:216-263` (`runProcess`) — Major — no `try/finally` around the
  post-spawn region, so a throw skips the R52 kill-and-confirm entirely.** `spawn()` at `:220` creates a
  *detached* group leader. Everything after it is on the straight path: `limits.onSpawn?.()` at `:231`
  (which in `modes/seatbelt.ts:208-211` calls `emitSpawn` → the caller's `EventSink`, i.e. E4's audit
  writer) and `waitForExit` at `:254`, which rejects on the child's `error` event (`:210`). Concrete
  failure: the audit sink throws on the `spawn` stage, or the child emits `error` after it has already
  started — `confirmGroupEmpty` (`:263`) and `drainStreams` (`:264`) never run, the error propagates
  through `modes/seatbelt.ts:214-217` (which only re-emits the stage event and rethrows) into
  `withNetworkPolicy`, whose `finally` (`srt-manager.ts:409-424`) resets the allowlist and **releases the
  semaphore without poisoning** — the `!outcome.groupDrained` branch at `:390` is skipped because
  `outcome` was never assigned. A live detached group inherits the next invocation's policy. Nothing
  records it: no `ExecOutcome` is produced at all, so `groupDrained` is never reported, `poisoned` stays
  unset, and no counter moves. Fix: wrap `:231-264` in `try/finally` that always runs
  `killGroup(pid,'SIGKILL')` + `confirmGroupEmpty(pid)`, and carry the result out on the error path
  (a thrown error object carrying `groupDrained: false`) so `withNetworkPolicy` poisons on it too.

- **`packages/core/src/exec/srt-manager.ts:317-339` (`buildFilterRequest`) — Major — the catch at `:335`
  swallows the *record*, not just the decision.** `active.collected.push(violation)` (`:328`) and
  `active.onViolation(violation)` (`:330`) are both *inside* the `try`, and the only thing that can throw
  before them is `countBody` (`:318`): `request.body.getReader()` on an already-disturbed body, or
  `reader.read()` rejecting when the client aborts mid-upload. On that failure the request is allowed
  through and produces **no violation at all** — absent from `ExecOutcome.violations`, absent from the
  live `onViolation` stream, and absent from every counter (`consumerFailures` is only reached by the
  *inner* catch at `:331`). In `none` mode that is the exfiltration request S5 exists to display,
  disappearing from the audit trail while the bytes leave the machine. The written justification is
  sound but answers a different question: it explains why the return is `allow` and not `deny` (R26); it
  never claims the record may be dropped, and R32/R45 say it may not be. Fix: build the violation and
  call `collected.push` + `onViolation` **outside** the `try` (bytes = whatever `countBody` counted, or
  `0`), and add a distinct `ExecOutcome` counter for the byte-count failure — `consumerFailures` is
  already documented (`sandbox.ts:108-112`) to mean something else.

- **`packages/core/src/exec/srt-manager.ts:255-260` (`onStoreNotify`) — Major — violations arriving with
  no active invocation are consumed and dropped with no counter.** `this.lastSeen` is advanced at `:256`
  *before* the `if (active === undefined) return;` at `:260`, so those events are permanently retired
  from the cursor and both `step.take` and `step.lost` are discarded. The reachable failure is exactly
  the one `DRAIN_WINDOW_MS` is admitted not to bound — its own doc at `:27-33` says «ноль на одной
  машине — не «ноль всегда», и окно здесь страховка»: under load the unified-log path lags past 150 ms,
  `this.active = undefined` runs at `:422`, and the invocation's **own** kernel denials arrive a moment
  later and vanish. The invocation has already returned `violationsLost: 0`, i.e. it asserts a complete
  set it does not have — the precise R45 failure of "S5 shows zero while the защита works". Name the
  record that would find it: there is none — no event, no counter, no log line, and the store cursor has
  moved past them. Fix: keep a singleton-level counter incremented in this branch and surface it
  (a `lateUnattributed` field on the next `ExecOutcome`, or an `onViolation` emission tagged
  unattributed), so an insufficient drain window becomes detectable instead of silent.

- **`packages/core/src/exec/srt-manager.ts:166` + `packages/core/src/exec/index.ts:16-40` — Major — the
  error class exists, is not exported, and is not used at most refusal sites: every policy denial reaches
  the caller as an anonymous `Error`.** `SrtManagerError` is a bare `extends Error {}` with no
  discriminant, and it is absent from the public surface — `surface.test.ts:19-42` pins the export list
  and it is not on it, so E4 cannot even write `instanceof`. Six further refusal sites throw plain
  `Error`: `sandbox.ts:155` (container unsupported, R3/D7), `sandbox.ts:161` (seatbelt off macOS, R2),
  `modes/seatbelt.ts:288` (disposed sandbox, R50), `modes/seatbelt.ts:257` (empty argv from srt),
  `netpolicy.ts:140` and `netpolicy.ts:145` (invalid domain pattern, R13 — a fail-closed policy denial),
  `modes/none.ts:54` and `modes/none.ts:64` (proxy/CA not up, R31). `Verdict`
  (`packages/contracts/src/domain.ts:9`) is `'allowed' | 'denied' | 'pending_approval' | 'error'`, so E4
  must pick one from what E3 throws; with no exported class and no code field the only available
  discriminator is the message text, and the safe default is `verdict: 'error'` — a call blocked by
  policy is recorded as a flaky one, and `denyReason` (`event.ts:88`) gets an unstructured string. Fix:
  export the class from `exec/index.ts` (and add it to `EXPECTED_SURFACE`) with a
  `readonly code: 'disposed' | 'poisoned' | 'group-not-drained' | 'invalid-domain' | 'mode-unsupported' |
  'proxy-down' | 'wildcard-dropped'`, and throw it at every site above.

- **`packages/core/src/exec/limits.ts:187-198` (`collectInto`) — Minor — the stream `error` listener does
  not fold its loss into `truncated`.** The justification ("EIO/EPIPE on every timeout; a listener is
  mandatory or the daemon dies") holds for *not crashing*, and is correct. It does not cover the
  accounting: after an error the collector simply stops receiving, so `produced === held`, `droppedAtRead`
  and `droppedAtCap` are both `false` (`:136-137`), and on a **non-timeout** stream error `finish()`
  returns `truncated: false` while `terminationOf` returns `'exited'`. The caller is told the output is
  complete when bytes were lost — and `truncated` is the field R19/R20 hang on, documented at
  `limits.ts:73` as "истинно тогда и только тогда, когда данные отброшены". Not self-healing: the wrong
  boolean is what reaches the audit event via `collapseOutput`. Fix: set a `streamErrored` flag in the
  handler and OR it into `truncated` in `finish()` (a per-stream error counter on `ExecOutcome` would
  serve equally).

- **`packages/core/src/exec/srt-manager.ts:173-175, 360, 393-395, 418-420` — Minor — the loud refusals
  carry no discriminating identifier.** `DISPOSED_MESSAGE`, «srt не инициализирован», the R52 group
  poison and the allowlist-reset poison name the *rule* and the *reason* well, but none carries
  `commandId`, `recipeName` or the child pid. The poison flag is terminal by design (`:196-207`), so
  after it trips **every** subsequent invocation fails with the identical string: an operator reading the
  audit trail cannot tell which recipe or invocation leaked the survivor, nor which pid to go hunt.
  R45 asks that attribution be reported loudly, and this is the one place where the surviving process is
  named nowhere at all. Fix: interpolate `options.commandId` into the poison strings at `:393` and
  `:418`, thread the child pid out of `runProcess` into the group-drain message, and pass
  `request.recipeName` from `runInMode` so the disposed/uninitialised refusals name the recipe.

## Candidates refuted (adversarial pass)

| Candidate | Why it was killed |
|---|---|
| `srt-manager.ts:111` `redactUrlForTarget` catch | Self-healing by construction — falls back to cutting everything after `?`, which is strictly safer than the parsed path. Best-effort with a written justification. |
| `violation.ts:199-204` `safeResolve` catch | Justified and self-healing: `realpathSync` throwing on a non-existent path is *the normal case* (the write was denied because the file does not exist), and `isMandatory` (`:260`) additionally compares against the unresolved pattern, so the classification is not lost. |
| `srt-manager.ts:555` `reader.cancel().catch(() => undefined)` | Best-effort teardown of a reader we are abandoning anyway; the byte count is already returned. |
| `limits.ts:160-166` `killGroup` catch | Not a swallow in effect — `confirmGroupEmpty` re-probes with `groupAlive` and the decision is taken there. (The *errno* defect is real, but it belongs to `groupAlive`; filed once, above.) |
| `modes/none.ts:99-103` `parseEnvPairs` `if (at <= 0) continue;` | Covered: `none.test.ts:282-302` runs the real vendor `generateProxyEnvVars` and asserts `HTTP_PROXY` is present, so a vendor format change reds CI rather than silently blinding the baseline; the handle-level guards at `:53-68` cover the runtime path. |
| `modes/seatbelt.ts:128-130` `emit` unguarded on `build_env`/`build_profile` | Surfaces: an audit-sink throw there propagates straight out of `run()`. (Its `spawn`-stage sibling does **not** surface cleanly — that is the `runProcess` finding above.) |
| Audit-sink throw on the `violation` stage (`modes/seatbelt.ts:176-180`) | Recorded: it reaches `dispatch`'s catch and increments `consumerFailures`, which `sandbox.ts:108-112` documents with exactly this meaning. Per rule (a), it records — not a finding. |
| `srt-manager.ts:415-421` `applyNetwork` catch in `finally` | Surfaces and records: it sets the terminal `poisoned` flag, so the next invocation refuses loudly. |
| `violationsLost` unreachable? | Reachable in principle and tested as a pure function (`advanceCursor`); the "almost unreachable in production" framing is the author's own and is honest. Not a finding. |
| `attributionMissing` firing on most invocations | A recurring environmental fact (the vendor sets the key only when both lines land in one `log stream` chunk) — explicitly counted separately from `attributionForeign` for that reason. Not flagged. |

## Note on the working tree (not a finding)

While this pass was running, an **uncommitted** edit appeared in the worktree from outside this
review: `packages/core/src/exec/limits.ts:225` flipped `detached: true` → `detached: false`. It is not
part of `e40b7de..HEAD` and was not made by this pass (read-only on `packages/`). It looks like another
reviewer's mutation probe. It is left in place, but it must not be committed: with `detached: false` the
child is not a group leader, so `killGroup`'s `process.kill(-pid, …)` targets the daemon's own group —
the whole R52 mechanism, and the two Major findings above that rest on it, change meaning. Line numbers
cited in this document are unaffected (one-line in-place substitution).
