# Internal review (Opus) — E3 executor and sandbox

codeTree: `f9e758fc1aa80c7d7970a395b640028cc9981eb6`

Reviewed `git diff e40b7de..HEAD -- packages docs` on `v2/e3-sandbox` against
`spec.md` (R1..R56, D1..D13), `plan.md`, `probes.md` and the frozen contract in
`packages/contracts/src/{event,lock,domain}.ts`. Vendor claims were re-checked against the
installed `@anthropic-ai/sandbox-runtime@0.0.74` sources rather than taken from `probes.md`.

Verified as correct (candidates killed, listed so silence is not read as absence): the
semaphore chain in `srt-manager.ts:122-134` is a correct capacity-1 ticket lock; `applyNetwork`
does preserve `strictAllowlist`/`tlsTerminate`/`filterRequest` across `updateConfig`
(R56 holds — the vendor's `updateConfig` at `sandbox-manager.js:1521` re-attaches
`filterRequest` by reference); the allow/deny decision is taken by the proxy **before**
`filterRequest` runs (`http-proxy.js:455-500`), so the always-`allow` telemetry callback is not
an enforcement bypass; `quoteArgv` + the vendor's own `quote()` at
`macos-sandbox-utils.js:863-874` are two independent quoting layers, so no shell injection;
`denyGlobToRegex` is a faithful copy of `globToRegex` + `denyGlobRegex`; `resolveGlobPrefix`
matches `normalizePathForSandbox`'s glob branch; `splitPort`/`isValidDomainPattern` are strictly
narrower than the vendor matcher in every divergent case (fail-closed); `advanceCursor` cannot
over-slice; `store.subscribe` firing synchronously on registration is harmless because
`lastSeen` is set first.

## Critical

- `packages/core/src/exec/srt-manager.ts:316` (with `:339-346`) — **the network policy is left
  applied in its "allow" state on every error path.** `applyNetwork(base, IDLE_NETWORK)` sits
  inside the `try` between `await options.body(...)` and the `return`. If `options.body` rejects
  the `finally` only clears `this.active` and releases the semaphore; the global srt config keeps
  the failed invocation's `allowedDomains`. Concrete input: any recipe whose `command[0]` does
  not exist on disk — `spawn` emits `error`, `waitForExit` (`limits.ts:191-192`) rejects,
  `runProcess` throws — or a recipe whose `srt.wrap()` throws (`Shell 'bash' not found in PATH`,
  `macos-sandbox-utils.js:850`). In `none` mode the surviving global allowlist is literally
  `['*']` (`modes/none.ts:77`); in `seatbelt` it is that recipe's domain list. R52 states the
  idle state is the empty list precisely because a process still bound to the proxy port
  (a `setsid` escapee, a child from an earlier run, or the very next `wrap()` that has not yet
  applied its own policy) then travels under it. This is the "returns allow on error" shape.
  Fix: move the teardown into the `finally` so it runs on every exit path —
  ```ts
  } finally {
    try { await delay(DRAIN_WINDOW_MS); applyNetwork(base, IDLE_NETWORK); }
    catch (e) { this.poisoned = `не удалось снять сетевую политику: ${String(e)}`; }
    if (!releaseCalled) { this.active = undefined; if (this.poisoned === undefined) release(); }
  }
  ```
  and delete the two teardown lines from the happy path. Note the drain must move with it,
  otherwise violations arriving after a failed body are attributed to the *next* invocation.

## Major

- `packages/core/src/exec/srt-manager.ts:294` + `:344` — **poisoning the singleton deadlocks any
  `run()` already queued on the semaphore.** The `poisoned` guard is checked once, before
  `await this.semaphore.acquire()`. Concrete sequence: call A acquires the semaphore; call B
  enters `withNetworkPolicy`, passes the guard (poison not yet set) and awaits `acquire()`;
  A's child leaves a background process, `groupDrained` is false, A sets `poisoned` and the
  `finally` deliberately does not `release()`. B's `acquire()` promise never settles, so B's
  `run()` never resolves and never rejects — the MCP call hangs forever with no timeout and no
  audit record. The class comment at `:153-158` claims "каждый следующий `run()` отказывает
  СРАЗУ", which is true only for calls that arrive after the poisoning. Fix: make the poison
  observable to waiters — hold the queue in the `Semaphore` (e.g. `poison(err)` that rejects
  `this.tail` and every pending `wait`), or re-check `this.poisoned` immediately after
  `acquire()` resolves and throw there, releasing so the next waiter also wakes and throws.

- `packages/core/src/exec/modes/seatbelt.ts:184` — **the `spawn` stage event is emitted after the
  child has already exited, been killed and drained, and is not emitted at all when the spawn
  fails.** `emit({stage:'spawn'})` runs after `await measureAsync(() => runProcess(...))`. Two
  concrete breakages. (1) Ordering: violations stream while the process is alive (R29,
  `srt-manager.ts:245`), so with any recipe that trips a deny — e.g. `write.allow` on the recipe
  dir and a write to `.git/hooks/pre-commit` — the consumer receives `stage:'violation'` events
  strictly *before* `stage:'spawn'`, inverting the frozen `stageOrder`
  (`packages/contracts/src/domain.ts:26-40`, `spawn` index 9, `violation` index 10); the S5
  timeline renders a violation for a process the log has not yet said was spawned. (2) Audit gap:
  if `runProcess` or `behaviour.toArgv` throws (ENOENT on `command[0]`, missing shell), the
  `spawn` stage produces no event at all, contradicting R32 ("событие на каждой стадии, включая
  отказ"). Fix: split `runProcess` so the child handle is returned as soon as `spawn()` returns,
  emit `stage:'spawn'` at that point (measuring only the spawn call), and wrap the whole body in
  `try/catch` that emits a `spawn` event before rethrowing when the spawn itself fails.

- `packages/core/src/exec/srt-manager.ts:241` — **`unrecognized` and `suppressed` kernel deny
  lines are dropped with no record and no counter.** `if (parsed.kind !== 'violation') continue;`
  is the only consumer of the discriminated union that `violation.ts` went to the trouble of
  building, and `violation.ts:56` justifies the explicit `SUPPRESSED_OPERATIONS` list on the
  grounds that an unknown operation "приходит как «неразобрано» и потому громко видна" — nothing
  makes it visible. Concrete input: `violation.test.ts:73` already fixtures
  `nvram(999) deny(1) nvram-get boot-args`, which classifies as `unrecognized`; the same happens
  for real seatbelt operations outside `TYPE_BY_PREFIX` and outside the suppression list —
  `file-map-executable`, `file-issue-extension`, `file-test-existence`, `pseudo-tty`,
  `authorization-right-obtain`. Each is a kernel denial that vanishes from `ExecOutcome`, from
  the event stream and from every counter. Fix: add `unrecognizedLines: number` (or a bounded
  `readonly string[]`) and `suppressedCount: number` to the `active` accumulator and to
  `InvocationResult`/`ExecOutcome`, incremented in the two `continue` branches, so an unparsed
  denial is reported rather than discarded.

- `packages/core/src/exec/srt-manager.ts:237` — **`attributionMismatches` does not count a
  *missing* attribution key, only a differing one.** R45 requires that "его расхождение **или
  отсутствие** считается и докладывается громко"; the guard is
  `event.encodedCommand !== undefined && event.encodedCommand !== active.encoded`, so the
  `undefined` case is skipped. Absence is the *common* case, not the exotic one: the vendor's
  monitor only sets `encodedCommand` when a `CMD64_…_END` line lands in the **same**
  `log stream` stdout chunk as the deny line (`macos-sandbox-utils.js:907-933`), and
  `proxyUsernameFor` falls back to bare `srt` — no key at all — whenever the base64 username
  would exceed the RFC 1929 255-byte cap (`sandbox-utils.js:710`). Result: an operator reading
  `attributionMismatches === 0` concludes every violation was key-confirmed when in fact none
  were. Fix: `if (event.encodedCommand !== active.encoded) active.mismatches += 1;` — or keep
  the two cases as separate counters (`attributionMissing` / `attributionForeign`) so the
  "громко" of R45 is legible.

- `packages/core/src/exec/srt-manager.ts:263` — **the full request URL, query string included, is
  copied verbatim into `SandboxViolation.target` and thence into the audit event.** The vendor
  deliberately strips the query on its own violation path (`redactUrlForViolation`,
  `sandbox-manager.js:170-190`: "Query strings routinely carry credentials (api_key=,
  access_token=, signed URLs)… they must not enter the transcript"); our callback receives the
  unredacted URL because `tlsTerminate` is on (D12), and stores it. Those violations reach
  `ExecOutcome.violations` (`modes/seatbelt.ts:195`) and are emitted as
  `sandbox.violations` on the `violation` stage (`modes/seatbelt.ts:176`), which E6 chains and
  hashes. The `redact` seam declared "сейчас, а не когда E6 напишут" (R20) exists only for
  stdout/stderr (`limits.ts:49`); nothing covers violation targets. Concrete input: a recipe
  allowed to reach `api.example.com` whose child issues
  `GET https://api.example.com/v1/x?api_key=<secret>` — the secret lands in the append-only
  audit chain in cleartext. Fix: add a `redactTarget?: (target: string) => string` to
  `WithPolicyOptions`/`ExecRequest` alongside `redact`, defaulting to the vendor's own
  `origin + pathname + (search ? '?…' : '')` reduction, and apply it in `buildFilterRequest`
  before constructing the `SandboxViolation`.

- `packages/core/src/exec/srt-manager.ts:178` and `:258` — **`this.telemetry` grows without bound
  for the life of the daemon and retains full URLs.** One entry per proxied HTTP/HTTPS request,
  pushed unconditionally (also when `this.active` is `undefined`, i.e. for traffic from
  background survivors between invocations). It is only emptied in `dispose()` (`:396`) and
  `resetForTests()` (`:408`); `telemetrySnapshot()` copies without draining and has no caller in
  the diff. A single long-lived daemon running chatty recipes accumulates unbounded
  `{url, method, bytes}` records — a memory leak, and (given the previous finding) an
  ever-growing in-process store of query-string credentials. Fix: either drop the array
  altogether — `active.collected` already carries everything a caller needs — or scope it to the
  invocation (reset in `withNetworkPolicy` at the same point `this.active` is set, harvested into
  `InvocationResult`), and cap it.

- `packages/core/src/exec/srt-manager.ts:245` (and `modes/seatbelt.ts:169-178`) — **an exception
  thrown by the consumer's `onViolation`/`onEvent` escapes into the vendor's `log stream` data
  handler and takes down the daemon.** The call chain is fully synchronous:
  `logProcess.stdout.on('data', …)` (`macos-sandbox-utils.js:907`, no `try`) →
  `callback(...)` at `:945` → `store.addViolation` → `notifyListeners` →
  `listeners.forEach(listener => listener(violations))` (`sandbox-violation-store.js:57-61`) →
  our `onStoreNotify` → `active.onViolation(...)` → E4's callback and `emit`. A throw there is an
  uncaught exception inside a stream `data` listener: the process dies, and short of that the
  remaining violations in the same notification batch are never processed. The same is true for
  `parseAndClassify` if `new RegExp` ever rejects a pattern built from a `write.allow` root.
  Fix: wrap the per-event body in `onStoreNotify` in `try/catch` that records the failure into a
  counter on `active` and continues the loop, so a defective consumer degrades observability
  instead of killing the daemon.

## Minor

- `packages/core/src/exec/limits.ts:176-180` — `collectInto` attaches only a `data` listener; the
  child's `stdout`/`stderr` have no `error` handler. An `EIO`/`EPIPE` on the pipe (routine when
  the group is SIGKILLed mid-write on the timeout path) emits `error` on a listener-less stream,
  which Node rethrows as an uncaught exception. Fix: `stream.on('error', () => {})` next to the
  `data` listener, exactly as the vendor does for its own shim
  (`request-filter.js:70`, `:81`).

- `packages/core/src/exec/limits.ts:126` vs `:267` — `termination` and `truncated` can disagree
  once E6 plugs a non-identity `redact` in. `terminationOf` decides `output-cap` from
  `produced > maxBytes`, while `truncated` is decided from post-redaction byte counts. With
  `maxBytes: 1000`, `holdBackBytes: 256`, a child producing 1010 bytes of which redaction
  collapses 40 into 8: `produced (1010) > 1000` → `termination: 'output-cap'`, yet nothing was
  dropped at read (1010 ≤ 1256) and nothing at the cap (978 ≤ 1000) → `truncated: false`. The
  outcome then claims the run ended on the output cap while asserting no data was discarded.
  Fix: derive `termination` from the same evidence as `truncated` — return the per-stream
  `truncated` flags out of `finish()` and let `terminationOf` take
  `stdout.truncated || stderr.truncated`.

- `packages/core/src/exec/srt-manager.ts:254` — R15 requires a violation with `bytes: 0` for an
  **allowed** raw-TCP connection through SOCKS, but no such record is produced. `filterRequest`
  is invoked only on the two HTTP paths (`http-proxy.js:500` plaintext,
  `tls-terminate-proxy.js:163` after CONNECT termination), and the vendor writes to the violation
  store only on *denials* (`recordProxyViolation` is called only from `denied()`,
  `sandbox-manager.js:189-196`). So an allowed `nc allowed.example.com 443` produces no violation
  at all and S5 undercounts silently. Fix: either drop the "разрешённая" half of R15 for SOCKS
  and record the gap in `10-honest-limitations.md` next to the existing raw-TCP row, or hook the
  SOCKS accept path (it is not exposed today — which is itself the answer).

- `packages/core/src/exec/srt-manager.ts:474-479` — `countBody` awaits the *entire* request body
  whenever it is under `BODY_SAMPLE_BYTES`, and the proxy does not dial upstream until the
  callback resolves (`request-filter.js:118`, then `:130`). A chunked request that stays open
  and trickles under 1 MiB — a streaming upload, an SSE-style POST — is held until the recipe
  timeout kills the child, and the recipe reports `termination: 'timeout'`/`denied` for what is
  a working request. R26's "бесконечное тело обязано не подвешивать запрос" is only satisfied for
  bodies that actually exceed the cap. Fix: race the read loop against a bounded timer
  (`Promise.race([readLoop, delay(BODY_SAMPLE_MS)])`) and cancel the reader on either exit,
  returning the bytes counted so far.

- `packages/core/src/exec/srt-manager.ts:391` — `disposed` is set permanently and cleared only by
  `resetForTests()`, so once the last sandbox is released the daemon can never create another
  one: `createSeatbeltSandbox()`/`createNoneSandbox()` call `srt.retain()`, which throws
  `DISPOSED_MESSAGE` (`:189`). Concrete sequence: E4 creates a `none` sandbox for the baseline
  leg of S5, creates a `seatbelt` sandbox, disposes both after the demo, then the operator
  switches the mode again — `createSandbox` throws for the rest of the process lifetime. R50
  requires that `run()` after `dispose()` throws on the *disposed* instance; it does not require
  the process to be unusable. Fix: after `await SandboxManager.reset()` completes with `refs === 0`,
  clear `disposed`, `initPromise` and `baseConfig` so a fresh `retain()` + `ensureInitialized()`
  re-runs `SandboxManager.initialize`, and keep the per-instance "this sandbox is dead" flag in
  `onceDispose()` where it already lives.
