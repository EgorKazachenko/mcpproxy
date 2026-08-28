# MULTI-DIMENSION SCAN — E7 run 1 (dual-review, dimension `scan`)

Anchor: HEAD `bc3e9630d99bfd702ae37e73063d88e258424ad5`, codeTree `833bdcd4055ef0ae7209a4d68257e8b2a2ce5fc8`.
Diff reviewed: `59235c32858461bc68812dcb71842adc0cd83900..HEAD`.

## Pass 1 — project-convention compliance

- no findings. `packages/desktop` has no `@mcpproxy/core` dependency and no import of it
  anywhere in `packages/desktop/src` (verified by grep); R1's boundary holds. The design-system
  boundary from `packages/design/README.md` ("что не отображает доменное значение в цвет, того
  тут нет") is respected: `packages/desktop/src/shared/stageGroup.ts` and
  `packages/desktop/src/shared/callOutcome.ts` both carry a comment explaining why they live in
  `desktop/src/shared` rather than `packages/design` (app-specific unions with no equivalent in
  `@mcpproxy/contracts`), and the reasoning is correct against the README's stated rule
  ("та отображает доменное значение в слово, а не в другое доменное значение").
- **MAJOR** — `docs/07-contracts.md:490` (a convention source of truth named in this review's
  brief) documents `ApprovalRequest`'s field list as `requestId, sessionId, recipeName,
  argsHash, tier, argv, cwd, profile` — it was never updated to add `argvFromParams`, even
  though the last commit (`bc3e963`) added exactly that field to
  `packages/contracts/src/approval.ts:80` to close R63. The sibling field on `AuditEvent`
  (R62) *was* documented in the same file (`docs/07-contracts.md` new paragraph after line
  305). `WORK.md`'s producer-receipt table got a matching second row for
  `ApprovalRequest.argvFromParams` in the same commit — so the omission is specific to
  `docs/07-contracts.md`, not a blanket "docs weren't touched" gap.
  Fix: add a row/paragraph for `argvFromParams` next to the `ApprovalRequest` table row.

## Pass 2 — bug scan

- **MAJOR** — `packages/desktop/src/shared/callOutcome.ts`: `CallOutcome` has six members
  (`blocked | passed | denied | awaiting | clean | running`) but `Verdict` (contracts) has
  four, including `'error'`. `outcomeOf()` in
  `packages/desktop/src/renderer/timeline/callLine.ts:38-44` never special-cases
  `call.verdict === 'error'`; it falls through to the violations branches and finally
  `call.open ? 'running' : 'clean'`. Since `error` is in `TERMINAL` (`call.ts:26`), `open` is
  always `false` for an errored call, so an error call with no sandbox violations gets outcome
  `'clean'` → `STRINGS.outcome.clean` = **"Выполнено"** ("Done") — while `roleOf()`
  (`callLine.ts:29`, `if (call.verdict === 'error') return 'danger'`) colors the same row red.
  This directly contradicts R15 ("строка начинается словом диспозиции — оно читается раньше
  цвета") and the entire premise of `packages/design/README.md`'s six-role system (color and
  word must agree). No fixture or test exercises `verdict: 'error'` (grepped
  `callLine.test.ts` — no hit), so nothing currently catches this.
  Fix: add an `'error'` (or reuse an existing) `CallOutcome` member and branch `outcomeOf()` on
  it before the violations checks, mirroring `roleOf()`'s early return.

- **MAJOR** — call-list violation summary silently drops information the frozen mockup shows.
  `docs/vibe-coding/27.08.2026-e7-ui/mockup.html:776-780` (the `callLine()` JS, same name/role
  as the shipped `callLine.ts`, and R49 makes the mockup the source of truth for shipped
  strings) computes `rest` as
  `` `${violationLabel[worst.type]}: ${worst.target}${sent}${v.length > 1 ? ` и ещё ${v.length - 1}` : ''}` ``
  — i.e. it appends the byte count when `worst.action === 'allowed' && worst.bytes > 0`, and
  appends "и ещё N" when more than one violation exists for the call. The shipped
  `packages/desktop/src/renderer/timeline/CallList.tsx:73-78` renders only
  `{violationLabel[line.worst.type]}: {line.worst.target}` — no bytes, no "+N" suffix.
  `CallLine.others` (`callLine.ts:21`, computed at `callLine.ts:64` as
  `Math.max(0, violations.length - 1)`) is a dead field — `grep -rn "\.others\b"` across
  `packages/desktop/src` finds only its own declaration and assignment, never a read. There is
  also no "и ещё" string anywhere in `strings.ts` (grepped). For a security-audit UI whose
  headline scenario (S5) is exactly "did data leave, and how much", dropping the byte count and
  the violation count on the one row a reviewer glances at is a real information loss, not a
  cosmetic gap.
  Fix: render `line.others` (e.g. `STRINGS.calls.andMore(line.others)`) and the byte count when
  `line.worst.action === 'allowed' && line.worst.bytes > 0`, matching the mockup.

- **MAJOR** — R12 ("Проигрыватель умеет шаг, паузу и скорость") is marked "реализовано" in the
  coverage table ("шаг, пауза, скорость, сброс и выбор дорожки одной командой"), and the
  `PlayerCommand` union, `packages/desktop/src/main/player.ts` (`play`, `pause`, `step`,
  `reset`, `select-track`), and `packages/desktop/src/shared/parse.ts` all correctly implement
  and validate `play`/`pause`/speed. But no renderer code path ever sends
  `{ kind: 'player-command', command: { kind: 'play', speed } }` or `{ kind: 'pause' }`.
  `packages/desktop/src/renderer/Chrome.tsx` wires only `step` and `reset` buttons (plus
  `select-track` via the mode switch); `STRINGS.player.play` and `STRINGS.player.pause`
  (`strings.ts`) are defined but never referenced anywhere in the renderer (grepped
  `STRINGS.player` — only `.step`, `.reset`, `.position` are used). There is no keyboard
  handler either. R12 frames continuous playback as "план Б, если ядро на сцене упадёт" — a
  demo fallback — which is currently unreachable from the shipped UI: a presenter can only
  single-step or reset/switch track, never let the trace auto-play. This is a real, not
  speculative, gap versus what the coverage table claims. (The frozen `mockup.html` does not
  model player transport controls at all, so this isn't a divergence from the mockup — it's a
  gap between the coverage table's wording and what the UI actually exposes.)
  Fix: either add a Play/Pause control (+ speed) to `Chrome.tsx`, or narrow R12's coverage-table
  claim to "player module supports it; UI exposes step/reset/track-select only" so a reader
  doesn't infer a working play button exists.

- VALID-NOT-BLOCKING — `packages/desktop/src/main/player.ts`: `createPlayer` sets
  `setInterval` on `play` and clears it on `pause`, but there is no explicit teardown on window
  close (`main/index.ts` has no `window.on('closed', ...)` calling `pause()`). The implementer
  already flagged this exact concern in `handoff-notes.md` ("Таймер проигрывателя... это стоит
  проверить ревьюеру"). In practice the whole process exits with the single window (no
  `window-all-closed` special-casing beyond the standard darwin check), so this is not a
  leak in the shipped single-window app; only relevant if a second window is added later
  (approvals window, run 2).

## Pass 3 — git history coherence

- no findings. `git log --oneline 59235c3..HEAD` shows 21 commits: 9 plan-review rounds
  (`ccc56fd`…`349b115`, matching the "10, 10, 11, 13, 10, 10 блокеров" narrative in
  `handoff-notes.md`/`spec.md`), 9 run-1 task commits (`5c84840`…`ece7be8`), a docs/coverage
  commit (`7fe0636`), two handoff-prep commits (`69ed8b8`, `1cbfaa2`), and the phase-4 closeout
  (`bc3e963`). Each task commit's stated scope matches its diff (spot-checked `5c84840` "R63 в
  ран 2" / contract origin, `bfd81ac` scheme, `a820f65` IPC boundary, and the full `bc3e963`
  diff above). `packages/core` is untouched by this diff (`git diff --stat ... -- packages/core`
  is empty), consistent with `349b115`'s claim of rebasing onto merged E6 without touching E6's
  files. No file in the diff is unexplained by a commit message.

## Pass 4 — in-file comments and markers

- no findings requiring action. Diff-wide grep for
  `TODO|FIXME|XXX|@ts-ignore|@ts-expect-error|eslint-disable|: any|<any>|as unknown as|\.skip\(|\.only\(`
  across `packages/` turned up exactly two hits, both justified:
  - `packages/contracts/src/approval.test.ts:112` — `// @ts-expect-error argvFromParams несёт
    индексы, а не значения`, immediately followed by a positive-control assertion
    (`expect(smuggled.argvFromParams).toEqual(['v1.0.0'])`) proving the value really is
    accepted at runtime and only rejected by the type system. This is a properly justified,
    single-purpose `@ts-expect-error`, not a suppressed unknown.
  - `packages/desktop/src/main/ipc.test.ts:42` — `({ senderFrame: frame }) as unknown as
    Electron.IpcMainInvokeEvent` — a minimal test-only stub cast to Electron's event type, the
    standard pattern for building a fake IPC event in a unit test. Not present in production
    code.
  - No `console.log` in shipped app code; the one hit (`packages/desktop/scripts/
    build-fixtures.mjs:134`) is a Node build script, not part of the Electron app bundle.
  - No commented-out code blocks found in the diff.

## Pass 5 — consistency across the diff

- See Pass 2's "call-list violation summary" and "R12 play/pause" findings — both are, at
  root, a consistency gap between what the frozen mockup / coverage table promises and what
  the code does.
- See Pass 1's `docs/07-contracts.md` finding — the same field (`argvFromParams`) is
  documented for `AuditEvent` but not for its sibling on `ApprovalRequest`, despite both being
  added in this same run and the JSDoc on both fields explicitly stating "то же поле... по той
  же причине."
- no other findings. `stageGroup.ts` / `callOutcome.ts` naming and homing rationale is
  consistently applied and consistently commented in both files. `argvFromParams`'s JSDoc is
  word-for-word duplicated between `packages/contracts/src/event.ts:115` and
  `packages/contracts/src/approval.ts:80` (and the generated snapshot) — this is deliberate per
  R63's own text ("то же поле... и проектировать в нём было нечего") and is enforced by a
  compile-time `expectTypeOf<...>().toEqualTypeOf<...>()` test
  (`approval.test.ts`), so a real duplicate-drift would fail the build; not flagged as a
  finding.

## Standing lenses

- **Policy-and-audit integrity**: no findings. `run()` in `main/index.ts` never allows-on-error
  (`player === null` → explicit `denied`); `guarded()` in `main/ipc.ts` reads `senderFrame`
  before any `await` and denies on every rejection path; no credential/token/argv value is
  written to a log line anywhere in the diff (`readTrace` in `trace.ts` returns diagnostics with
  only the line number and a fixed message, never the line content).
- **Contract hygiene**: the one gap found is the `docs/07-contracts.md` drift already listed
  under Pass 1/5. No type/schema is duplicated in `packages/desktop` instead of imported from
  `@mcpproxy/contracts` (`stageGroup`/`callOutcome` are legitimately app-local unions, not
  contract duplicates — see Pass 1). No package reaches into a sibling's `src/` internals
  (`packages/desktop` imports only `@mcpproxy/contracts` and `@mcpproxy/design` public entries).
  IPC payloads are validated by `parseUiRequest`/`sanitize` before use (R5/R6), not trusted by
  type.
