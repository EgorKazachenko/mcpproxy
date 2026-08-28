# plan-review — E2

Пять раундов, все Opus, read-only. Раунды 1–4 — REVISE, раунд 5 — APPROVED.
Ниже отчёт финального раунда и подтверждение дельты, изданное тем же ревьюером
после применения его собственных непреграждающих находок.

---

## Раунд 5 — финальный отчёт

All seven probes run clean; every anchor resolves; I verified the round-4 claims against the repository rather than the prose.

### 1. Round-4 fixes — verified in mechanism

**MAJOR-1 (withdrawn, not patched).** Correct call, and the withdrawal is honest. I re-ran `probes/probe-substitution.mjs` block B: lexical traversal gives `path-escapes-root` for both existing and missing targets; a symlink created inside `root` gives `preOk=true` and the codes diverge again (`path-escapes-root` / `path-not-found`). Spec R15а now says exactly that, names the previous wording as wrong, and the two limitation rows (residual oracle, reason-string leak) are present. Ф18 quotes the transcript verbatim.

**MAJOR-2.** R20а exists; task 6 step 7 mandates `split('{}').join(v)` and names `replace('{}', v)` as forbidden. `probe-substitution.mjs` A2 reproduces the legitimate-file case: created `a$'b.log`, realpath returns it, naive substitution yields `.../ab.log`. Falsification names both `$'` and `` $` `` vectors with different templates — the two failure shapes differ, so one vector would not catch the other.

**MAJOR-3.** Slot count is now task 3 step 9 (`problems` return), task 6 step 8 keeps it as a stated-unreachable assert with the reason given (`buildArgv` is total; a throw at stage 3 is a call with no `CallResult`).

**MINOR-1/2/3.** Task 5 step 10 is rewritten for the advisory pre-check and correctly splits the two denial texts (step-4 names the boundary, step-5 names the realpath result). S4 is split into S4-а (code collapse, non-existent target) and S4-б (resolved path, created target) with opposite fixtures — and the plan correctly notes that `docs/08-demo-scenarios.md:95`'s promise holds on the demo because the presenter's target exists. `denials-truncated` is in `DENIAL_CODES` and used in task 4 step 2а. R22's vacuous sandbox clause is recorded with its reason (`PreparedRecipe` carries no `sandbox` field — confirmed against the Interfaces block).

**Anchors and quotes.** I checked all 37 cited line anchors in `packages/contracts` and `docs/`. Every one resolves to the quoted content, including the two corrected ones: `refine.ts:213` is `if (resolved === resolve('/'))` and `:223` is the `outside === '..' || startsWith('..'+sep)` half — genuinely the two halves task 3 step 9 claims. `types.ts:99` is `ParseManifestResult`. All Ф transcripts match live probe output verbatim (hashes/tmpdirs differ per run, as expected). No fabricated quotes found.

**Diff table.** All 38 requirements (R1–R35 plus R15а, R20а, R30а) are present and each points at a step that genuinely carries it.

### 2. Attacks — nothing broken

- **Raw/mutated string into argv:** blocked. Values are unmutated between the pattern check and argv; the `ValidatedValues`/`ResolvedValues` brands make handing a pre-resolve map to `buildArgv` a compile error; `exec` is never substituted.
- **Newline/anchoring:** I checked `re2` directly rather than trusting probe block G. `new RE2('^[\w./-]{0,64}$').test()` agrees with `RegExp` on trailing newline, embedded newline, CRLF, NUL and `;` — all `false`. The A1 corpus claim holds.
- **`> null` shorthand** in task 4 steps 6/8 (`length > maxLength` where `maxLength: number | null`): I compiled it — TS18047 fires under `strict`, so the compiler forces the null guard. Not a latent false-denial.
- **NUL byte in a path:** `path.resolve` does not throw on NUL (confirmed), `realpathSync` throws `ERR_INVALID_ARG_VALUE` → step 4's "any other code → `path-unusable`" catches it.
- **Contracts root entry:** `packages/contracts/src/index.ts` exports `tool.js` and pulls no deps — task 2 step 6's "import from the root entry drags nothing" is true.
- **Fixture claims:** `packages/contracts/recipes/mcpproxy.yaml` really has `run_tests.pattern: ^[\w./-]{0,64}$` and `analyze_logs.file` with `root: ./logs`, `argv: ["{}"]`.

### 3. On the three "documentation-only" judgements

**Ф10 `path.join` vs `path.resolve` — confirmed, with a caveat.** The three rows the plan quotes (NUL, `..`, empty) survive the substitution. But the probe's own `absolute` row does **not**: `path.join(root,'/etc/passwd')` → `/logs/etc/passwd` → `ENOENT`, while the design's `path.resolve` → `/etc/passwd` → `path-escapes-root`. That row is silently omitted from the Ф10 excerpt in plan.md. No plan conclusion rests on it and corpus A2 covers the absolute vector under resolve semantics, so it stays documentation-only — but it is the one row where the substitution is not neutral, and the excerpt hides exactly that.

**Probe block G's RE2-`.test`-is-a-search note — confirmed documentation-only.** Measured: `re2` matches JS semantics; the fixture pattern is anchored; nothing in the plan depends on the note.

**`argsHash` across filename casings — I reject "documentation-only, unrecorded".** It is not a blocker (deny-safe), but it has a second consequence the plan never draws, and the measurement is already sitting in a committed probe. `probe-path.mjs` block 5 prints `realpath(LOGS/APP.LOG) → /private/.../LOGS/APP.LOG` — realpath preserves the *requested* casing. I reproduced it: with `realRoot = <base>/logs`, a legitimate value spelled `<base>/LOGS/a.log` resolves fine, `path.relative` returns `../LOGS/a.log`, and step 5 denies a real in-root file as `path-escapes-root`. Leaf-case differences (`A.LOG`) stay confined but split `argsHash`, i.e. an extra approval — which R17's "two spellings" sentence arguably covers. The root-component case is a distinct, unrecorded **false denial**. It belongs as one row in the limitations table next to the NFC/NFD note. It is not a design error: normalizing case would reintroduce precisely the collision R17 was rewritten to avoid.

### 4. Residual findings (none blocking)

1. **`PreparedRecipe` is unbranded.** The plan brands `ValidatedValues`/`ResolvedValues` with unique symbols and argues at length (task 3 step 9) that "a `Recipe` built programmatically bypasses the loader" — but `validateCall(prepared, params)` takes a plain structural interface, and `PatternMatcher` is `{ test(v): boolean }`, trivially hand-constructible. A consumer can skip `prepareRecipe` and every invariant it enforces. Not a hole against the actual attacker (who controls `params`, not `prepared`), but inconsistent with the brand argument the plan itself makes two tasks earlier.
2. **Task 3's falsification names 2 of 4 invariants.** It states the rule "one vector per invariant, because one vector is green while another check is missing" and then supplies vectors only for `exec` slot and `root: '/'` — not for the relative-root escape, not for the slot count (the round-4 arrival), and not for step 9а's recipe-string canonicalizability. The stated rule generates the missing traces, so this self-corrects at implementation, but the section as written under-delivers on its own promise.
3. **Diff-table filing.** R20's second clause ("slot expands at most once per element") is carried by task 3 step 9 but filed under the **R22** row ("счёт слотов"); the R20 row points only at task 6 step 5, which carries the first clause. Mechanism present in two places; the mapping is misfiled.
4. **`path-unusable` has no named corpus vector**, while task 8 step 6 demands a bidirectional code↔vector census. The census test will go red and force one — that is the census working — but the plan could name it (NUL in a `path` value).
5. **Cosmetic:** task 5 has two falsifications both labelled "Шестая"; tasks 3 and 7 say "см. ниже «типовые трейсы»" for a block that sits in task 2, i.e. above; task 2 steps 9 and 11 carry run-on lines from the round-4 edit.

None of these produces wrong code or a false safety claim. The plan's security-bearing mechanisms are present, measured, and honestly bounded — including the two places where round 4 chose to withdraw an overclaim rather than paper over it.

VERDICT: APPROVED

---

## Подтверждение дельты — тот же ревьюер, после применения его непреграждающих находок

Delta verified against the repository. `git diff c98a145 9297b9d` touches exactly three files — `plan.md` (+68/−11), `spec.md` (+1), new `probes/probe-case.mjs` (+44) — and I read the whole diff. It is the six changes you describe and nothing else. `git hash-object plan.md` = `773f846275a24a4bddbcac3e05bf5a156754c395`, matching the hash you gave; commit `9297b9d`, working tree clean.

**1. Casing (Ф19 + spec row).** `probe-case.mjs` runs clean and its transcript matches Ф19 verbatim: `<base>/LOGS/a.log` accessible, `realpath` returns the requested casing, `relative` gives `"../LOGS/a.log"`, confinement denies. Leaf case stays confined and splits `argsHash` (`false`). The spec row states it as a deny-safe false denial and gives the right reason for refusing the case-normalization fix. Correctly recorded.

**2. Ф10.** The restored `absolute` row is verbatim from `probe-path.mjs` block 7, and the caveat's divergence claim is now measured in `probe-case.mjs`: `join` → `<root>/etc/passwd`, `resolve` → `/etc/passwd`, escapes root. Accurate. One nit: the sentence now reads "Четыре класса, четыре ветки" and then enumerates three — the absolute branch is described in the following paragraph rather than in that list.

**3. Task 3 falsification.** Four vectors for four invariants, as a table, plus the 9а trace. The 9а vector on `exec[0]` is the right pick — task 4's value gate genuinely does not cover recipe-sourced strings, so a vector on a parameter value would have been green against a missing check.

**4. `path-unusable` vector — I checked this one rather than taking it on the prose**, because step 3 of task 5 calls `path.resolve` *before* step 4's try/catch, and a throw there would be the unrecordable refusal the plan exists to prevent. Measured: `path.resolve`, `path.relative` and `path.isAbsolute` all tolerate an embedded NUL and return normally; only `realpathSync` throws, with `ERR_INVALID_ARG_VALUE`, inside step 4's catch. The candidate is lexically inside `root`, so `preOk === true` and step 4 takes its third branch → `path-unusable`. The vector lands where step 3а claims.

**5. Diff table.** R20 now names both clauses (task 6 step 5 + task 3 step 9); R22 retaining "счёт слотов" in its prepare-time list is correct, not double-filing.

**6. Cosmetics.** "Шестая"→"Седьмая" fixed; both "см. ниже" pointers corrected.

**One thing the delta introduced**, cosmetic and non-blocking: task 3 now carries **two falsifications both labelled "Третья"** — the new step-9а trace and the pre-existing type-level trace on steps 4/5. That is the same duplicate-ordinal class you just fixed in task 5; the second should read "Четвёртая". Both traces are distinct and fully specified, so nothing is lost — it is a label collision only. (The sentence "Форма — формой, названной в задаче 2 (см. «типовые трейсы» в задаче 2)" now also names task 2 twice; leftover from an earlier round, not this delta.)

**On residual #1 — I agree with your decision not to brand `PreparedRecipe`, and my own finding said as much.** The brands on `ValidatedValues`/`ResolvedValues` earn their ceremony for a specific reason: both maps exist simultaneously at the facade seam, are structurally identical, and swapping them puts an unvalidated user string directly into argv. `PreparedRecipe` has no structural twin to be confused with, and it never crosses the IPC boundary — it is produced and consumed inside the daemon. A third brand would buy notation, not a caught bug. Leave it.

Nothing new introduced beyond the label collision. The plan as it now stands — `docs/vibe-coding/27.08.2026-e2-validate/plan.md` at `773f846275a24a4bddbcac3e05bf5a156754c395` (commit `9297b9d`), with `spec.md` at the same commit and all eight probes runnable — is approved.

PLAN: 773f846275a24a4bddbcac3e05bf5a156754c395
VERDICT: APPROVED
