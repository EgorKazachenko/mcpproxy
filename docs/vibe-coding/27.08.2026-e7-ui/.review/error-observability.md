# error-observability review — E7 run 2 (re-read of delta after run-1 fixes)

HEAD = `cad08c39318abcc9ffe47cc8e30d785231ecf18d`, codeTree `c86e85bd469ec2b6dad402b020ca02b2dae12a2b`
Prior HEAD reviewed = `bc3e9630d99bfd702ae37e73063d88e258424ad5`

Verdict: **EO-BLIND**

This is a re-read, not a fresh review. Three of run 1's four findings hold up. The CRITICAL's
fix does not: it is well-intentioned, cites the right scenario in its own comment, and still
does not catch it, because of a classic `Promise.prototype.then(onFulfilled, onRejected)`
misuse. That keeps the verdict at EO-BLIND.

## Status of run-1 findings

| # | Run-1 severity | Status now | Why |
|---|---|---|---|
| 1 | CRITICAL — unhandled `whenReady()` rejection | **NOT FIXED — new CRITICAL below** | The added second argument to `.then()` never fires for the failure it was written to catch |
| 2 | MAJOR — fire-and-forget `bridge().send()` in `App.tsx` | **RESOLVED**, one new MINOR (flapping fault) | both call sites now have `.then`/`.catch`; new `fault` state renders a visible `role="alert"` banner |
| 3 | MAJOR — unrecorded IPC rejections in `ipc.ts` | **RESOLVED**, one MINOR residual | security `sender-*` rejections still carry their specific message end-to-end to the renderer (not collapsed); only genuine internal exceptions from `run()` are now collapsed to a static `bad-payload` text, and those are still not recorded anywhere in `main` |
| 4 | MINOR — player timer not torn down on darwin | **RESOLVED** | `player.stop()` (= `pause()`) is called from `window.on('closed', ...)`; unit-tested |

## Findings

### 1. CRITICAL (recurrence) — the `whenReady()` fix does not catch its own target scenario

`packages/desktop/src/main/index.ts:83-96`:

```ts
app.whenReady().then(
  async () => {
    handleAppScheme(bundleRootFor(app.getAppPath()), mode);
    registerIpc(run, allowedOrigins);
    await loadPlayer();
    const window = createWindow('main', devUrl ?? APP_ORIGIN);
    dispatch.register(window.webContents);
    window.on('closed', () => player?.stop());
  },
  (cause: unknown) => {
    process.stderr.write(`mcpproxy: приложение не стартовало — ${String(cause)}\n`);
    app.exit(1);
  },
);
```

The comment above this block names the exact motivating scenario — `loadPlayer()`'s
`JSON.parse` throwing on a corrupt `marks.json`, or `readTrace` returning a failed envelope
that gets re-thrown as `Error`. But `Promise.prototype.then(onFulfilled, onRejected)` only
invokes `onRejected` if the promise `.then` was called *on* (here, `app.whenReady()`) itself
rejects. It does **not** invoke `onRejected` when `onFulfilled` (the async arrow function)
itself throws or returns a rejected promise — that produces a *separate* promise (the one
`.then(...)` returns), which nothing here observes, since there is no trailing `.catch()` on
the whole expression.

Verified directly, not by inference — reproduced the exact shape in plain Node 22:

```
$ node -e '
Promise.resolve().then(
  async () => { throw new Error("boom-from-fulfilled"); },
  (e) => { console.log("onRejected fired:", e); }
);
'
[eval]:3
  async () => { throw new Error("boom-from-fulfilled"); },
                      ^
Error: boom-from-fulfilled
    ...
Node.js v22.15.0
```

`onRejected` never printed. `app.whenReady(): Promise<void>` (from `node_modules/electron/electron.d.ts:1916`,
documented only as "fulfilled when Electron is initialized") for all practical purposes never
rejects — so the added handler is dead code, and every failure inside the async body
(`handleAppScheme`, `registerIpc`, `loadPlayer`, `createWindow`, `dispatch.register` — not just
the cited `marks.json` case) still produces an unhandled rejection, exactly as before this fix.
The developer's own WHY comment even restates the original finding's wording ("а на macOS
процесс при этом оставался жив") while shipping a fix that doesn't reach that code path.

Nothing in the delta tests this: neither `e2e/smoke.test.ts` nor any new `index`/`guard` test
launches the app against a corrupt fixture and asserts `app.exit(1)`/stderr output, so this
regression was unobservable at CI too.

**Fix**: replace the second `.then()` argument with a trailing `.catch()` on the whole chain:

```ts
app.whenReady()
  .then(async () => { ...body... })
  .catch((cause: unknown) => {
    process.stderr.write(...);
    app.exit(1);
  });
```

### 2. MINOR (new) — `process.stderr.write` has no fallback for a packaged, terminal-less launch

Even once the above is fixed, `process.stderr.write` is only observable when something is
attached to the process's stderr — normal for `electron .` in dev, for the Playwright smoke
harness, and for a user who launched the packaged `.app` from a terminal. It is not generally
observable for a `.app` bundle double-clicked from Finder/Dock/Spotlight, which is exactly the
"packaged Electron main process on darwin" case the brief asks about. Run 1's suggested fix
included `dialog.showErrorBox` for this reason; the shipped fix has no such fallback. Given
this is presently a developer-facing demo/observe tool (not an end-user-distributed app) and
the primary channel used to run it during development/demo (terminal, Playwright) does see
stderr, this is not blocking — but it should not be treated as "the user will see this" without
qualification.

### 3. MINOR (new) — the fault banner can clear itself before it is read

`packages/desktop/src/renderer/App.tsx:93-99`:

```ts
const command = (next: PlayerCommand): void => {
  void bridge()
    .send({ kind: 'player-command', command: next })
    .then((reply) => setFault(reply.ok ? null : reply.error.message))
    .catch((cause: unknown) => setFault(String(cause)));
};
```

Every successful `command` reply unconditionally clears `fault` to `null`, regardless of what
set it (including a prior `hello` failure, or a prior command failure of a *different* kind).
If a user issues two commands in quick succession and the first is rejected while the second
succeeds, the banner appears and disappears without necessarily being read — `role="alert"`
gives screen readers an announcement, but a sighted user watching the timeline, not the banner,
can miss it. No test exercises this path (no `App.tsx`-level unit test exists at all; the
Playwright smoke test never asserts on `.fault-banner`). Not blocking: the security-relevant
rejections (`sender-*`) are not the ones that would flap this way in practice, since a rejected
sender is rejected on every subsequent call too (the guard re-checks `event.senderFrame` per
request), so a genuine attack-triggered fault would persist, not flap.

### 4. VALID-NOT-BLOCKING — security-rejection visibility is real for misconfiguration, theatre for a live attack

The brief asks directly: is a security-relevant rejection (`sender-origin`, `sender-detached`,
`sender-subframe`, `sender-absent`) reaching a human now meaningful, or theatre? Both, depending
on cause:

- **Meaningful** for a benign cause — e.g. `allowedOrigins` misconfigured against the actual dev
  server origin, or a legitimate race where the frame detaches mid-request during window
  teardown. In dev/QA, a human driving the app now sees the fault banner and can diagnose it.
  This is genuinely better than run 1's silent drop.
- **Theatre** for an actual attack — `sender-origin`/`sender-subframe` are only reachable once a
  renderer is already running attacker script (XSS through a CSP bypass), and the reply carrying
  the rejection message is delivered back to that same compromised renderer, not to a trusted
  operator. `main` still records nothing persistent about the rejection (no file, no counter) —
  confirmed by grep, no such write was added in this delta. If a real attack occurred, there is
  no forensic trail after the fact; only the attacker's own script "sees" the denial, and it
  already knew it was denied.

Not blocking: the brief explicitly rules out demanding a logging framework, and the run-1
finding's own accepted alternative fix ("branch on `reply.ok === false` in the renderer") is
exactly what shipped. The residual gap (no main-side record for forensics) is the same
proportionate trade-off already accepted for the `protocol.ts` 404 path in run 1.

### 5. VALID-NOT-BLOCKING — `ipc.ts`'s `guarded` collapses internal bugs and malformed payloads into one message, but only for genuine exceptions, and with nothing lost that wasn't already lost

`packages/desktop/src/main/ipc.ts:73-80`:

```ts
try {
  const reply = run(request.value);
  return reply instanceof Promise ? reply.catch(() => denied('bad-payload', MESSAGES['bad-payload'])) : reply;
} catch {
  return denied('bad-payload', MESSAGES['bad-payload']);
}
```

Confirmed `senderRejection`'s four codes are untouched by this — they still return their
specific `MESSAGES[rejection]` text (`ipc.ts:63-64`), so security denials are not swept into
`bad-payload`. Only an actual thrown/rejected `run(request.value)` (today, effectively only a
bug in `player.apply`/`state`, since `run` is small and total per `R7`) is collapsed to a static
string, with no message and nothing recorded in `main`. This does trade specific diagnostic text
for a generic one — but it is a **net improvement** over the baseline this replaced: before this
fix, an exception in `run()` propagated as an actual rejected `ipcMain.handle` promise, and
(at that same commit) neither `App.tsx` call site had a `.catch()` at all, so it was a fully
silent, unhandled rejection in the renderer. Now it surfaces as a visible, if generic, fault
banner. Worth tightening in a later run (e.g. a one-line `console.error`-equivalent when
`NODE_ENV === 'development'`), not blocking now.

## Killed candidates (adversarial pass over this delta)

- **`packages/desktop/src/main/protocol.ts:78-83` — new `url.host !== APP_HOST` 404 check.**
  Deny-by-default, closes the "any host under the custom scheme resolves the same bundle"
  origin-confusion gap the WHY comment names. No new blind spot: failure path is the same
  already-accepted `new Response(..., {status: 404})` pattern as the sibling `resolveBundlePath`
  null case from run 1.
- **`packages/desktop/src/shared/stageGroup.ts` — throw replaced by `?? 'execution'` fallback.**
  This is a correctness improvement for observability, not a regression: there is still no
  error boundary anywhere in `packages/desktop/src/renderer` (confirmed again by grep), so the
  old throw would have taken down the whole timeline render on any unrecognized stage from a
  newer trace schema. The replacement is backed by a completeness test tied to
  `Record<StageGroup, …>`, so a *genuinely* new stage still fails the build, just not the
  running app. Correct trade, not a finding.
- **`packages/contracts/src/jcs.ts` — throws on array holes.** Consistent with the module's
  existing throw-on-non-finite-number behavior (same WHY comment says so explicitly), and not
  reachable from the `main/index.ts` startup path — grepped `trace.ts` and confirmed it does not
  call `canonicalizeJcs` at all (readTrace stays in its own try/catch envelope, unaffected).
  All other callers (`lock.ts`, `audit/*.ts`, `validate/*.ts`) are inside the contracts package's
  own established "throws are caught at the validation boundary" pattern from run 1's killed
  candidates. Not a new gap.
- **`player.ts`'s `stop: pause` calling `announce()` → `emit()` → `dispatch.send()` after the
  window that triggered it is already closing.** Checked whether this could throw
  synchronously against a destroyed `webContents`. It cannot: `dispatch.send` guards every
  target with `if (!contents.isDestroyed())` before calling `.send()` (`dispatch.ts:27-29`).
  Not a finding.
- **`App.tsx`'s `unsandboxed` banner switching from `state?.track === 'none'` to
  `calls.some((call) => callLine(call).sandbox === 'none')`.** Bundled into this same diff hunk
  but is a UI-correctness change (R48), not an error-handling or observability change — no
  swallowed error path involved either way. Out of scope for this dimension, noted only so it
  isn't mistaken for a missed finding.
- **`app.exit(1)` vs `app.quit()`.** `app.exit()` is the right call here specifically because
  the failure happens *before* a window exists — there is nothing for `before-quit`/`will-quit`
  listeners to clean up, and `app.quit()` would still leave a real risk of the app just hanging
  under Electron's normal quit sequencing if something is subtly wrong post-failure. Given the
  goal ("silent zero-exit reads as a clean shutdown to a launcher"), `app.exit(1)` is correct.
  Not a finding — mentioned because the brief asked for a judgment call on it.
