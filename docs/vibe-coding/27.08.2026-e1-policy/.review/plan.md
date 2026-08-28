# Plan review — round 5 (final)

I read both documents, then verified their load-bearing claims against the frozen contracts rather than taking them on trust.

## Document integrity — clean

8 task headings, no duplicates, no orphans. Each has Files / Falsification / Verification / Commit; Task 1 correctly has no Interfaces (infra only). No sed damage remains (`/Users/opera_user/Documents/projects/mcpproxy-e0-contracts/docs/vibe-coding/27.08.2026-e1-policy/plan.md`). The requirement diff has 39 rows covering all 38 spec R-ids plus R24a — no requirement is unclaimed, and every row names a task and trace that exist.

## Facts checked against frozen sources — all accurate

`toTool(name, recipe)` arity; `verifyLockEntries` return shape; `manifestHash`/`recipeHash` living in `audit/`; `sanitizeDescription`'s operation order (separators collapsed *before* `INVISIBLE`, so R19's "attach to `\p{Cc}`/`\p{Cf}`, not to the sanitizer" argument is correct); `PatternMatcher` really is an object literal with an own `test` closure; `AuditEvent.denyReason?: string | null` vs `argv?: readonly string[]` (so the conditional-spread argument holds and differs between the two); `recipe.hash?` inside a required `recipe`; `DiagnosticCode` member `lock`; lock diagnostics really carry `line: 1` with a sanitized `tools.${name}` pointer; root `package.json:15` is the `-Ap` test script. `Manifest` is genuinely mutable, so the R6 freeze trace is writable.

## Traces — none vacuous

I re-derived each. Task 2 trace 3 works because the `drifted` variant of `LockCheck` still needs *a* diff, so the mutant must supply an empty one — `changed.length` 0 vs 1 discriminates. Trace 2 correctly uses "lock recomputed wholesale, `manifestHash` left stale" rather than the `defaults` case that `diffLock` catches on its own (P2c). Traces 5a/5b/6a genuinely observe what round 4 said they observe. Task 7 trace 2 is a real success-path trace. Execution order is sound: task 5 and 6 precede their consumer in task 7; task 8 closes the barrel last; each Verification is reachable at its point.

## Residual items (none blocking, all cheap)

1. **Two stale statements contradicting R15b.** `plan.md:196` (Pre-flight §7 classifier row) still says `missing` is "**единственный** случай записи без подтверждения", and the diff-table row `plan.md:872` still reads `| R15 | Задача 7: «missing → писать без подтверждения» |`. Both are pre-round-4 text and both say the opposite of Task 7's body, R15b, and trace 6a. Fix the two lines; the executable trace already forces correct behavior.
2. **Task 7 interface gap.** `runLockCommand(store, confirm, expectDigest)` has no lock path and no write-deps seam — `StartedStore` exposes neither, and `startStore` swallowed both paths. Also `bin/mcpproxy-lock.mjs` is described as importing only `lock-command.js`, which therefore needs an undeclared entry that resolves paths, calls `startStore` and `confirmTty`. Add `lockPath` (and a `main`) when you write it.
3. **Task 8 trace 5 has no declared observation seam.** `pathViolations` is pure; the three-dot/`git status` half has no signature and no `repoRoot`, and п.4 explicitly forbids planting out-of-list garbage in the working tree. Needs a `changedPaths(repoRoot, baseRef)` seam plus a temp `git init` fixture, or the trace can't run.
4. **R1a's lock half is untraced and unnamed** — no lock size constant, and `LoadedLock` has no oversize branch (`missing | unreadable | unparsed`). Trace 8 covers the manifest only. Map oversize to `unparsed` with a synthesized `code: 'lock'` diagnostic and it stays fail-closed.
5. **`typecheck` stays `-Ap`.** The plan's own tsbuildinfo-collision argument applies verbatim to `yarn typecheck`, which Task 8's Verification runs. Pre-existing, but E1 makes it likelier to bite.
6. **Task 2 trace 5a hardcodes `2` diagnostics** for a `version: 1` lock. That count came from a probe fixture whose `defaults` was *also* malformed; an otherwise-valid lock with only the version flipped yields 1. Reuse the exact probe fixture or assert non-zero.

## Strongest remaining risk

The `kind: 'first'` request carries only recipe **names** (`recipes: readonly string[]`). So the round-4 fix proves *that* something is being pinned, not *what*. The exact sequence R15b names — delete lock, poison manifest, human hits `denied (absent)` and runs the command — still ends with the poisoned `exec`/`description` pinned, because the human never sees it; only the name `run_tests`, which was there before either way. Spec R15b does say "список рецептов", so this is the spec's own choice and not a plan defect, but the plan's prose ("теперь показывается и он") overstates what a name list delivers. The cheap fix while implementing task 6/7: put the normalized recipes into the `'first'` branch and render them through `renderVisible` exactly like the drift branch's `is` side — the machinery is already there.

PLAN: 7ed0480be9479488bd92487b302251915a8a3a61
VERDICT: APPROVED
