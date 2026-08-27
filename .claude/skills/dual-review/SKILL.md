---
name: dual-review
description: The project's pre-merge code-review GATE — a branch/PR is ready and must pass before it lands. Trigger (RU) — "дуал ревью", "сделай ревью на ПРе", "прогони ревью перед мержем", "проверь обратную совместимость", "не сломает ли это существующие интеграции", "тесты не флакают?". Trigger (EN) — "dual review", "review this PR before merge", "backward compatibility check", "will this break existing installs". The single source of truth for WHICH reviewers run — internal Opus + multi-dimension scan + the gated backward-compat / test-quality / error-observability passes — and HOW their findings reach the PR. Advisory reviews live in `code-audit/`.
---

# dual-review

## Overview

The pre-merge review gate runs **independent reviewers across complementary dimensions** over
a PR diff, each posting its findings to that PR. It is the only review GATE in
`vibe-code-developing-v2` (the `review-*` gates) and the per-phase / assembled review in
`feature-orchestrator` (Stage 3 / Stage 4). This skill is the single source of truth for
which reviewers run and how their output reaches GitHub — referencing skills just say
"invoke `dual-review`".

**The name `dual-review` is legacy** — kept so every "invoke `dual-review`" reference keeps
resolving. The gate is **count-agnostic**: today it runs **five** dimensions — an internal
Opus pass, a multi-dimension scan, a **gated backward-compatibility pass**, a **gated
test-quality / anti-flake pass**, and a **gated error-handling / observability pass** — and more
(e.g. a dedicated security dimension) can be added without renaming. The first two always run;
the third runs only when the diff touches a contract / persisted / wire surface; the fourth runs
only when the diff adds or changes tests; the fifth only when the diff has a runtime failure
surface.

## The reviewers — named exactly

1. **`superpowers:requesting-code-review`** — internal Opus reviewer. Deep analysis
   against the `CLAUDE.md` files, the plan (if any), and the PR diff.
2. **`code-review:code-review`** — the **BUILT-IN** skill (parallel Sonnet sub-agents:
   CLAUDE.md compliance, bug scan, git history, prior PR comments, in-file comments).
   Pass `--comment` so it posts inline to the PR.

**Both reviewers run, every time.** There is no third-party reviewer installed here to stand in
for either of them — never substitute one, never skip one because the other ran. Running only ONE
reviewer is the #1 failure of this gate.

**Invoke the NAMESPACED name.** The bare name `code-review` resolves to the **built-in workflow-backed
reviewer**, which at `high`/`xhigh`/`max` effort — when workflows are enabled — launches a
`Workflow` whose agent count is driven by how many candidates its finders return, not by anything
you pass it: one finder per correctness angle, then **one independent verifier per distinct
(file, line)**. Measured on one feature, two invocations: **27 and 34 agents, 5.13M tokens**,
unrequested. So you MUST invoke `code-review:code-review` — the plugin, which fans out ordinary
agents (four Haiku steps, 5 parallel Sonnet reviewers, one Haiku scorer per issue) and calls no `Workflow` at all. It reads the PR
via `gh pr diff <N>` (no `gh pr checkout`, so no branch-switch hazard).

3. **Backward-compatibility pass (GATED — the third dimension).** A dispatched Opus agent
   that runs ONLY when the diff touches a contract / persisted / wire surface. Rationale: this is
   a proxy that sits between MCP clients and MCP servers, so most of what it exposes is somebody
   else's compile-time or run-time dependency, and nothing else in the gate checks that
   systematically.

   | Surface | Who breaks when it changes | Rollback |
   |---|---|---|
   | `@mcpproxy/contracts` types and schemas | every sibling package, at compile time | recompile |
   | The MCP wire protocol the proxy speaks (tool/resource shapes, error payloads) | connected clients and upstream servers, at run time | redeploy, but in-flight sessions still break |
   | Policy config + audit-record format on disk | an existing install's config; already-written audit records that must stay readable | none — records on disk cannot be rewritten retroactively |
   | A package's public `src/index.ts` export surface | consumers of the workspace | recompile |

   **Gate first — cheaply inspect the changed file paths. Deep-dive ONLY if the diff touches any of:**
   - `packages/contracts/**` — the shared types/schemas every package compiles against
   - any `*Schema.ts` / `*Schemas.ts` — request/response or config validation
   - any `packages/*/src/index.ts` — a package's public export surface
   - the policy decision path or its config shape — a rule file an existing install already has
   - the audit-record shape — a reader must still parse records written by an older build
   - any removal/rename of an exported symbol, tool name, or enum member — or a change to an enum
     member's **value**

   If NONE are touched → return `BC: N/A — no contract/persisted/wire surface in the diff` and post
   nothing further. Pure internal refactors correctly no-op here — do not tax them with a full
   analysis.

   **When triggered, analyse four axes:**
   1. **Old caller → new code**: did the diff remove/rename an exported symbol, a tool name, or a
      response field a caller reads? Did it tighten validation (optional→required, a new required
      field, a narrowed enum)? Did it change the **meaning** of an enum value already in use?
   2. **New code → old config**: does the new build require a policy/config key an existing
      install's file lacks, with no default and no migration? A config that fails closed on an
      unknown-but-valid old shape is a break, not a safety feature — unless that is the documented
      intent, stated as such.
   3. **Old data → new code**: does a reader assume a field that audit records written by an older
      build do not carry? Audit evidence is append-only by design; a reader that throws on an old
      record destroys the ability to answer questions about the past.
   4. **New code → old upstream**: does the proxy now require behaviour from an upstream MCP server
      that older servers do not implement, without feature-detection and a graceful degrade?

   **Verdict `BC-SAFE` / `BC-RISK`.** For each risk, name the exact break + the safe path:
   additive-not-destructive; expand → migrate → contract (parallel change); tolerant reader (never
   fail on an unknown field); dual-write / dual-read; deprecate-then-remove across two releases;
   feature-detect + graceful degrade. Triage a real break to an existing install as **Critical**.
   A break in the audit-record format is strictly worse than the others, because the evidence it
   makes unreadable cannot be regenerated.

4. **Test-quality / anti-flake pass (GATED — the fourth dimension).** A dispatched Opus agent that
   runs ONLY when the diff adds or changes a test. Rationale: a bad test does not fail loudly at
   review time — it goes **green**, and its cost arrives weeks later as a red suite nobody trusts,
   or, worse, as **silence while the feature it "covers" is broken**. Neither always-on reviewer
   audits test *construction*: they read tests as documentation of intent, not as code with its own
   failure modes. Every rule below is a defect observed in real review, not generic advice.

   **Gate: fire only if the diff adds/changes a `*.test.ts`, a file under
   `packages/*/src/**/__tests__/**` or `packages/*/tests/**`, or a test helper/fixture/factory
   they import.** A diff with no test surface returns `TQ: N/A — no test surface in the diff` and
   posts nothing. Do NOT run it on a production-code-only diff — but DO note that a prod change with
   **no** test in the blast radius is reviewer 1's finding, not this pass's.

   **When triggered, read every added/changed test in full and answer six questions:**

   1. **Does it expire? (time-bomb — the canonical local defect.)** A test that pins an **absolute**
      date/time (`'2026-07-26T05:16:00.000Z'`) while the code under test compares against a **live
      window off `Date.now()`** is a scheduled failure: it is green in CI on the day it lands and
      turns red, with no code change, once the window slides past. **Real incident (28.07.2026):**
      `routeCatchUp.test.ts` hardcoded an activity 2 days before the 48 h `ROUTE_CATCH_UP_WINDOW_MS`
      — three tests went red ~40 h after merge, on `main`, having passed review. → **Major.** Fix:
      anchor the fixture **relative to `Date.now()`** with a comfortable margin (`Date.now() - 1h`
      for "inside", `Date.now() - 30 days` for "outside"), never an absolute literal. Flag any
      absolute date in a test whose subject reads the clock. (An absolute date is fine — and
      preferred — when `now` is **injected** into the unit under test, as `buildRouteCatchUpOps({now})`
      does: `catchUpOps.test.ts` pins `NOW` explicitly and is immune. **Injected clock ⇒ absolute
      dates OK; ambient `Date.now()` ⇒ relative fixtures required.**)
   2. **Is it tautological?** Does the expectation restate the implementation — importing the very
      constant/formula the code uses (`Date.now() - ROUTE_CATCH_UP_WINDOW_MS`), or asserting
      `expect(fn(x)).toBe(fn(x))`? Then a mutation of that constant moves the test **with** the
      code and is never caught. **Real incident:** the first attempt at the fix above derived the
      out-of-window fixture from `ROUTE_CATCH_UP_WINDOW_MS` itself — scaling the window 1000× left
      the suite fully green. → **Major.** Fix: express the *expectation* in independent, literal
      terms ("30 days ago is outside any sane window"); importing a prod const for a **fixture's
      shape** is fine, for the **boundary under test** it is not.
   3. **Would it pass if the feature were deleted? (vacuous / false-green.)** An assertion on a
      **default** value — `toBe(0)`, `toBeNull()`, `toEqual([])`, `not.toHaveBeenCalled()` — proves
      nothing on its own: the field is 0 because nothing ran, and it stays 0 when the feature is
      ripped out. Same class as the **case-sensitive attribute selector** incident
      (`querySelector('[aria-label="close"]')` vs the real `"Close"` — the negative check could
      never match, so it was green while the element was visibly present). → **Major** when the
      negative assertion IS the point of the test. Fix: **every negative assertion needs a paired
      positive control** — a sibling case proving the same probe fires when it should — and DOM
      queries go through the accessible name (`queryByLabelText(i18n.t(...))`), never a raw CSS
      attribute selector. Ask literally: *"which line of production code, if deleted, turns this
      test red?"* If the honest answer is "none", the test is decoration.
   4. **Does it fight the clock or the network instead of the state?** Flag `vi.setSystemTime` /
      fake timers in an **integration** test that logs a user in — the 15-minute access token
      expires the moment the clock jumps, and the test dies with a 401 unrelated to its subject
      (see the project rule: drive local-hour logic by **choosing a timezone** from `Etc/GMT±N` via
      `tzWithLocalHour(h)` / Playwright `timezoneId`, not by moving the clock; fake timers stay in
      isolated unit/component tests, `toFake: ['Date']` only, with **numeric** date args, never an
      ISO `Z` string). Flag any fixed `sleep(n)`/`waitForTimeout` used as a substitute for waiting
      on a **condition**, and any target hour picked within an hour of a threshold boundary (a zone
      sitting at 17:59:59 flips mid-request). → **Major** for the token-expiry pattern, **Major** for
      sleep-as-synchronisation.
   5. **Does it depend on order, on a sibling, or on a shared registry?** Wherever a suite runs with
      **`isolate: false`** the module registry is shared across files in a worker, so
      `vi.mock()` of a module the cached `getTestApp()` already imported is **order-dependent**: it
      works alone and silently no-ops in the full suite (and `vi.spyOn` on an ESM namespace throws
      outright). → **Major**; fix: move module-mock assertions into a **unit** test (per-file
      isolation) built from stub deps. Also flag: a test leaking state a sibling reads (no cleanup),
      and fixture keys that collide under parallelism — `Date.now()`-derived emails/nicknames are
      **not** unique across concurrently-created users; prefer a per-test unique id.
   6. **Does it assert the reported scenario, or a generic invariant?** Per the standing project
      rule, a bug fix ships its regression test **in the same diff**, reproducing the **exact**
      reported inputs (the rounding-boundary values, the specific payload), not a paraphrase that
      would pass before the fix. Flag a fix whose test would have been green on the pre-fix code —
      the reviewer should be able to state which assertion the old code fails. Also flag a **skipped
      / commented-out / `.only`** test (`.only` silently disables the rest of the file) — never
      deferrable, per Triage.

   **Verdict `TQ-SOLID` / `TQ-FLAKY`.** A clean diff returns `TQ-SOLID ✓` explicitly. For each
   finding, name the exact `file:line`, which of the six questions it fails, and the concrete fix
   (relative anchor / independent boundary / positive control / timezone-not-clock / unit-test the
   mock / exact-scenario assertion). **The strongest available evidence is a mutation check**: when
   a test's value is in doubt, break the production line it claims to cover, confirm the test goes
   red, and revert — a test that stays green under that mutation is the finding, and "it passes" is
   never a defence. As always the fix is a **restructured test** — never "add a comment", and never
   a `retry` / longer timeout to paper over a race (that hides the defect and is itself a finding).

   **Do NOT flag:** don't demand tests for behaviour already covered, or invent coverage for a
   refactor that changes none. The authoritative gate is the full workspace run (`yarn test` from
   the repo root), not a single package run in isolation.

5. **Error-handling / observability-coverage pass (GATED — the fifth dimension).**
   No existing reviewer asks whether a new failure path is *visible after the fact*. A swallowed
   failure is invisible to monitoring by construction: nothing is ever sent, so no query can find
   it. In a security proxy the stakes are higher than a missing log line — a failure that is
   swallowed on the policy or audit path is a decision nobody can reconstruct.

   **Gate: fire only if the diff changes a `.ts` under `packages/*/src/` that can fail at
   runtime** — an upstream call, a policy evaluation, an audit write, a transport handler, a
   background task. A docs/config/token/test-only diff returns
   `EO: N/A — no runtime failure surface in the diff` and posts nothing.

   When triggered, answer these five:

   a. **Does every new catch either surface or report?** A catch on a **policy-decision, audit-write
      or credential-handling** path that neither surfaces to the caller nor records is **Major** —
      a silently-swallowed policy error is indistinguishable from an allow. On a best-effort
      side-effect it is Minor at most, and only if the failure is self-healing.

   b. **Is a fire-and-forget path covered?** `void fn()`, a `.catch(() => undefined)`, a
      `setInterval`, a stream or background-task handler. `.catch(() => undefined)` on an
      **identity or session** call (attaching a session to a principal, tearing one down, purging
      a cache on disconnect) is Major: it fails silently and leaves state attached to the wrong
      session.

   c. **Is the error classified, not stringified?** A typed error code from `@mcpproxy/contracts`
      on the wire, not a raw `err.message`. A proxy that collapses an upstream failure, a policy
      denial and its own bug into one opaque string makes all three indistinguishable to the
      caller — and a policy denial in particular MUST be distinguishable from a transport error,
      or a blocked call reads as a flaky one.

   d. **Does the new failure mode leave a trace?** A new upstream call or policy branch with no log
      line and no audit record is invisible after the fact. For this project that bar is higher
      than ordinary logging: a decision the proxy makes about a tool call is only defensible if it
      is in the audit trail. Name the record or query that would find it; if you cannot, that is
      the finding.

   e. **Is the error message good enough to triage?** `new Error('failed')` passes every lint rule
      and is useless in a log. The message must carry the discriminating identifier — which tool,
      which upstream, which rule denied it.

   **Before reporting, run an adversarial refutation pass over your own candidates.** For each one
   ask: is there an outer handler, a transport-level error mapper, or a deliberate documented
   best-effort catch that already covers this? Kill the candidate if so. Expect to kill most of
   what you first find.

   **Verdict `EO-COVERED` / `EO-BLIND`.** A clean diff returns `EO-COVERED ✓` explicitly — a silent
   pass is indistinguishable from a pass that never ran.

   **Do NOT flag:**
   - **Anything ESLint already enforces — but check WHERE it is enforced.** `no-empty`
     A rule that is already enforced repo-wide by lint is pure noise as a review finding — check
     the eslint config before reporting one. **Where a type-aware rule is scoped to a subset of
     paths, it is OFF outside that subset, and a defect it would have caught IS reportable.**
   - **A best-effort catch that carries a written justification and whose failure is self-healing.**
     A cache write that fails and only forces a recompute is not a finding when the code says so.
   - **Demanding a capture for a recurring environmental fact** (an upstream that is legitimately
     absent in this configuration). That is a per-boot event stream; the log is its correct home.

   As everywhere else, the fix is a guard, a surfaced error or a recorded one — **never "add a
   comment"**.

**Policy-and-audit integrity is a STANDING lens for reviewers 1 & 2.** This is a proxy whose
whole value is that it decides and records; a defect on either path is not an ordinary bug.
Whenever the diff touches the decision path or the audit writer, flag: (1) a **path that returns
an allow on error** — a `catch` that falls through to "let it pass" turns any transient failure
into a bypass; deny-on-error is the default and an allow-on-error needs an explicit written
justification. (2) A **decision that is not recorded** — a call the proxy allowed, denied or
modified with no corresponding audit record leaves no way to answer "what happened" afterwards.
(3) An **audit record written after the side effect it describes**, where a crash in between
loses the evidence but keeps the effect. (4) A **credential, token or tool argument copied into a
log line or an audit record** that was not deliberately redacted — the audit trail is itself a
place secrets leak to. Each is a Major at least. The fix is a restructured path — never "add a
comment".

**Contract hygiene is a STANDING lens for reviewers 1 & 2** — not a separate gated pass (unlike
BC it applies to almost every diff in this workspace). Flag: a type or schema duplicated in a
package instead of imported from `@mcpproxy/contracts`; a package reaching into a sibling's
`src/` internals instead of its public entry; a validated-at-the-edge shape re-validated
inconsistently downstream, or a shape that crosses the wire with no validation at all. Each is a
correctness finding, triaged by how far the wrong shape can travel before anything notices.

## How to run

### Findings go to a FILE first — the file is the source of truth (loss-proof, idle-proof)

**The single biggest failure of this gate is a reviewer that runs, finds real issues, then goes
idle WITHOUT posting** — a background review agent silently no-ops (finishes/idles before its
`gh` post step, or its returned text is dropped), so nothing lands on the PR and the coordinator
gets no findings. Relying on the PR-post or the returned summary as the ONLY copy = findings get
lost. **Never again.** So:

- **Every reviewer MUST write its full findings markdown to a deterministic file FIRST — before
  (and independent of) posting to the PR.** Path: `/tmp/dual-review-pr<N>/<slug>.md`, where
  `<slug>` is `internal` / `scan` / `bc` / `ds` / `loading` / `tests`. Write the file as the FIRST thing after the
  analysis completes; only THEN attempt the `gh` post. If the agent dies/idles before posting,
  the findings still exist on disk. A reviewer that finds nothing writes the file anyway with an
  explicit `no actionable findings` (or `BC: N/A` / `DS: N/A` / `TQ: N/A`) line — an absent file means the
  reviewer never ran, a present-but-empty file means it ran clean; the two must be distinguishable.
- **The FILE is the source of truth — not the PR post, not the returned one-liner.** When a
  reviewer is dispatched as a background agent, do NOT trust "it idled = it's done": after it
  stops, the coordinator **reads `/tmp/dual-review-pr<N>/<slug>.md`**. If the file has findings but
  nothing was posted to the PR (the silent-idle failure), **the coordinator posts it on the
  reviewer's behalf** (REST, with the reviewer's stable header) so nothing is lost. If the file is
  missing entirely, the reviewer silently no-op'd — **re-run that dimension directly in the
  coordinator's own context** (do not declare the gate done with a dimension missing).
- **Resolve reads the FILES + the PR**, so a reviewer whose post silently failed still contributes
  every finding. A gate is only "done" when all active dimensions have a findings file AND a posted
  comment (or a recorded `N/A`).

- **Large or assembled diff (whole feature, Stage 4):** dispatch the dual review as ONE
  **separate agent** so the orchestrator/main context stays clean. That agent runs all the
  active reviewers (the two always-on + the BC pass if its gate fires + the test-quality pass if
  its gate fires + the error-observability pass if its gate fires) and returns only a
  one-line-per-reviewer summary.
- **Small per-phase diff (the `vibe-code-developing-v2` `review-*` gates):** the reviews can run directly. **Respect the ≤3-parallel
  GraphQL cap (see "Posting findings"):** run the two always-on reviewers first (parallel), then
  the gated passes (BC + test-quality + error-observability) in batches of ≤3 — never fan out all
  five at once. The test-quality pass fires on almost every feature PR (they nearly all ship
  tests) — it is cheap and reads only the test files, so it is never the one to drop.
- Either way, **each reviewer posts its formatted findings to the PR itself** and returns
  ONLY a one-line summary **that includes the posted comment's `html_url`** (e.g.
  `posted 7 findings (4 ≥75, 3 50–74) to PR #N → https://github.com/.../issues/N#issuecomment-…`).
  The reviewer comment URLs are load-bearing — the resolution comment (see **Resolve** below)
  links back to them. Never return findings prose into the main conversation — it duplicates
  ~20–30K tokens that already live on GitHub.
- Give each reviewer a **stable, recognisable header** so the resolution step can match a
  finding to its source comment: reviewer 1 → `## Internal review (Opus) — PR #N`,
  reviewer 2 → `## Multi-dimension scan — PR #N`, reviewer 3 (only when the BC gate fires) →
  `## Backward-compatibility — PR #N` (when it no-ops, it need not post — just report `BC: N/A`),
  reviewer 4 (only when the test-quality gate fires) → `## Test-quality / anti-flake — PR #N`
  (when the diff ships no test surface, it need not post — just report `TQ: N/A`), reviewer 5
  (only when the error-observability gate fires) → `## Error-handling / observability — PR #N`
  (when it no-ops, it need not post — just report `EO: N/A`).

## Posting findings — REST, not GraphQL

`gh`'s GraphQL endpoint has been **rate-limiting** on this repo, and `gh pr comment <N>`
goes through GraphQL — it can fail or hang. Post via the **REST** issues endpoint instead:

```bash
gh api repos/<owner>/<repo>/issues/<N>/comments -F body=@/tmp/body.md --jq '.html_url'
```

(For this repo: `repos/EgorKazachenko/mcpproxy/issues/<N>/comments`. `-F body=@file`
avoids shell-escaping a long markdown body; `-f body='...'` works for short ones.) GraphQL
and REST have separate quotas — only GraphQL gets drained by the review fan-out, so REST
`core` usually still has thousands left. Confirm with
`gh api rate_limit --jq '.resources.graphql, .resources.core'`. Do NOT run more than ~2–3
review agents in parallel — a 5-agent fan-out drains the GraphQL budget and every subsequent
`gh` GraphQL call (including `gh pr comment`) starts failing with "API rate limit exceeded".

## CI is OFF — never trigger it

GitHub Actions budget is tight; phase branches have **no CI** (a PR into a feature branch
showing "no checks" is NORMAL, not a failure). The dual review must NOT push a `[full-ci]`
commit or run `gh workflow run`. Only the user opts into CI explicitly, per-PR.

## Triage

Classify every finding **Critical / Major / Minor / Nit** with `file:line`. Default
confidence floor: post **score ≥ 50** (drop below-50 noise unless the user asks for
everything). Push review-fix commits as **separate** commits (the PR is live — never
squash/force-push over reviewer threads). Severity is assigned here; what happens to each finding is decided in **Resolve**.

## A disputed finding is settled by running something, not by a third opinion

The author of a diff is also the one triaging criticism of it, which is a real bias — but the
answer is **not** another model. A judge agent was tried here and removed: a weaker judge over a
stronger model's output is the documented failure case (a code-specialised 3B judge scores ~50 %
test–retest consistency, i.e. a coin flip, and position alone swings its accuracy from 89 % to
17 % — [Bias in the Loop](https://arxiv.org/html/2604.16790v1)), self-preference bias means one
model family grading its own family favours it, and the same literature covers pairwise *code*
comparison, never the grading of *findings about* code. It would have added a mandatory serial
subagent whose only output was better prose in a cell.

**What actually settles these disputes, measured on PR #953 and PR #957: a command.** The
reviewer's claim that plans carry no `git add` lines died to one `grep`; the author's claim that a
check had no false positives died to one `plan-lint` run; a 13.5× slowdown was established by
`time`, not argument. So:

- **A finding you believe is wrong is refuted with output, not opinion.** Run the grep, the probe,
  the test — and paste the raw result into the resolution comment. `CLAUDE.md`'s standing rule is
  the same one: verify a reviewer's premise against the code before applying it.
- **If it cannot be settled by running something, it goes to the owner** — not into a `wont-fix`
  row. The fixer never waives a flagged finding.
- Everything else in the blast radius gets fixed. Scope discipline — what the blast radius is and
  the only three deferral reasons — lives in **one** place:
  `vibe-code-developing-v2/references/phases.md`, "Scope discipline — fix now, ticket almost never".

**Calibrate the reviewers by what the diff is, not only by which surfaces it touches.** Pass each
reviewer the changed-line count and the surface. A reviewer at full adversarial effort on a
300-line script diff will always find something, and a loop of author-versus-reviewer over things
that do not matter is the expensive failure mode. Concretely: a finding that proposes moving code
across a package boundary must first check and state the constraint that would block it (the
project-reference build order, whether the target package already depends on the source, what is
exported from its public entry) — otherwise it is not a finding, it is a guess the author has to
refute.

## Resolve — collect, fix, post the resolution comment (MANDATORY, every run)

The reviewers post to the PR and return only one-line summaries — **their full findings
are NOT in your context**. So after they finish you MUST pull every finding back from
GitHub, fix everything fixable in this same run, and **post exactly ONE resolution comment
that links back to each reviewer's source comment**. This step is owned by `dual-review` (not
by the calling workflow) and runs on **every** invocation, even when the reviewers come back
clean (then the resolution comment simply records "no actionable findings"). The gated BC
pass, when it no-ops, is recorded as a `BC: N/A` row rather than a linked comment.

1. **Collect ALL findings from GitHub** (REST, to dodge the GraphQL limit) — every
   reviewer issue-comment AND any inline review comments AND any human comment:
   ```bash
   gh api repos/<owner>/<repo>/issues/<N>/comments --paginate --jq '.[] | {id, url: .html_url, user: .user.login, body}'
   gh api repos/<owner>/<repo>/pulls/<N>/comments  --paginate --jq '.[] | {url: .html_url, path, line, body}'
   ```
   Capture the `html_url` of **each** reviewer comment (match on the headers from "How to
   run"). These are the links the resolution comment points at.
2. **Build one triage list** — every distinct finding across all reviewers, deduped, each
   tagged Critical/Major/Minor/Nit with `file:line` and **which source comment it came from**.
3. **Fix everything in the blast radius — Critical through Nit, no exceptions.** Apply each finding
   inline (code change + re-verify the affected build/test). Two outcomes other than "fixed" exist,
   and neither is a judgement call you make alone:
   - **Refuted** — the finding is wrong. Prove it by running something and paste the raw output in
     the resolution row. Pre-existing-and-outside-the-blast-radius counts here only when the run on
     `origin/main` is shown, never asserted.
   - **Deferred** — only for a reason on the closed list in
     `vibe-code-developing-v2/references/phases.md` ("Scope discipline"). That list lives there and
     is deliberately NOT copied here, so the two can never drift. Name which reason in the
     resolution comment — never silently drop.

   "It's only a Nit / leave it for the user" is NOT a defer reason, and neither is "it's a refactor"
   for work confined to the files this PR already edits.
   **Never deferrable, under any condition:** a failing / skipped / commented-out test, a red
   lint or type error. Those are unfinished work — fix them in this run. **Every deferral MUST
   name the full GitHub PR URL this review was for** (e.g.
   `https://github.com/EgorKazachenko/mcpproxy/pull/<N>`), so it can be traced back. A deferral
   that only says "Deferred from PR #<N>" with no clickable link is unacceptable.
4. **Re-verify** after the fixes (`yarn typecheck` + `yarn build` + the affected tests; the full
   `yarn test` if a contract changed). Push the fixes as **separate** commits.
5. **Post the resolution comment** (REST, one comment) — see the template below.
6. Return to the caller a one-line resolution summary (e.g.
   `resolution posted: N fixed, M refuted, K deferred → <resolution-comment-url>`). Do NOT
   return the full triage prose — it already lives on the PR.

### Resolution comment template (links to each posted reviewer comment at the top)

The opening line MUST link to **every reviewer comment that posted** so a reader jumps straight
to the source, then states what was fixed vs not and why, then the per-finding table. The two
always-on reviewers always have a link; the **Backward-compatibility** pass has one only when its
gate fired AND it posted (when it returned `BC: N/A`, record that inline instead of a link):

```markdown
## Review resolution — PR #<N>

Triaged findings from [Internal review (Opus)](<url-1>), [Multi-dimension scan](<url-2>), and [Backward-compatibility](<url-3>) (drop the third link if the BC gate returned `BC: N/A`).
Fixes pushed in <sha…> (separate post-review commits; verified: <lint/build/tests green>).

**Fixed:** <short list>. **Refuted:** <short list, each with the command whose output disproves it>. **Deferred:** <short list with its phases.md reason>.

| Finding | Severity | Source | Resolution |
|---|---|---|---|
| <one-line finding> | Major | [internal](<url-1>) | **Fixed** — <what changed> (`<sha>`) |
| <one-line finding> | Minor | [scan](<url-2>) | **Fixed** — <what changed> |
| <one-line finding> | Minor | [scan](<url-2>) | **Refuted** — `<command>` → `<raw output>` |
| <one-line finding> | Minor | [bc](<url-3>) | **Deferred** — <one of phases.md's three reasons> |
```

Every finding from every posted comment appears exactly once. `Source` links to the comment it
came from (the user can click through to the original). A reader sees at a glance that
nothing was silently dropped.

## Quick reference

| | |
|---|---|
| Reviewer 1 (always) | `superpowers:requesting-code-review` (internal Opus) |
| Reviewer 2 (always) | `code-review:code-review` `--comment` (the plugin, built-in Sonnet fan-out) |
| Reviewer 3 (gated) | Backward-compatibility pass — dispatched Opus agent; runs only when the diff touches a contract/persisted/wire surface, else `BC: N/A`. Four axes: old caller→new code, new code→old config, old data→new code, new code→old upstream |
| Reviewer 4 (gated) | Test-quality / anti-flake pass — dispatched Opus agent; runs only when the diff adds/changes tests, else `TQ: N/A`. Six questions: does it expire (time-bomb) / is it tautological / would it pass with the feature deleted / does it fight the clock / does it depend on order & `isolate:false` / does it assert the reported scenario. Evidence = mutation check |
| Reviewer 5 (gated) | Error-handling / observability-coverage pass — dispatched Opus agent; runs only on a diff with a runtime failure surface, else `EO: N/A`. Five questions: does every catch surface or report / is fire-and-forget covered / is the error classified not stringified / does the new failure leave a trace / is the message triageable. Mandatory adversarial refutation pass before reporting |
| Post via | REST `gh api repos/OWNER/REPO/issues/N/comments -f body=...` |
| Return | one line per reviewer (incl. comment URL) — findings live on the PR, not in context |
| CI | OFF — never trigger; "no checks" on a phase PR is normal |
| Resolve | MANDATORY every run: collect all findings → fix everything fixable → ONE resolution comment linking each posted reviewer comment (Fixed sha / Refuted with raw output / Deferred url + its phases.md reason) |

## Common mistakes (observed baseline failures)

| Mistake | Reality |
|---|---|
| "I ran the code review" (one reviewer) | The gate is the two always-on reviewers + the gated BC pass. Running only `requesting-code-review` or only `code-review:code-review` is a fraction of the gate. |
| Assuming some external reviewer covers the second pass | Nothing else is installed here. The second reviewer is `code-review:code-review`. |
| Running the BC pass on a pure internal refactor | It's gated for a reason — byte-identical responses / no contract surface → `BC: N/A`, no full analysis. Don't burn tokens analysing a refactor that can't break compatibility. |
| Posting with `gh pr comment` / `gh api graphql` | GraphQL is rate-limited on this repo → fails. Use REST `gh api issues/N/comments`. |
| 5 parallel review agents | Drains GraphQL for the whole session. Cap at ~2–3. |
| Triggering CI to "be safe" | CI is off by budget. Never trigger; the gate is the reviewers + local verification. |
| Returning full findings into the main chat | ~20–30K wasted tokens. Findings go to the PR; return one line. |
| Trusting a background reviewer that "idled = done" | Background review agents silently no-op (idle before posting). Every reviewer writes findings to `/tmp/dual-review-pr<N>/<slug>.md` FIRST; the coordinator reads that file after the agent stops and posts on its behalf (or re-runs the dimension if the file is missing). The file — not the post or the return — is the source of truth. Never let a finding get lost. |
| Skipping the resolution comment (or "I fixed the findings" with no comment) | **Resolve is mandatory every run.** No resolution comment = the gate is half-done. Even an all-clean run posts one. |
| Resolution comment that doesn't link every posted reviewer comment | The whole point is click-through to the origin. Open with `[Internal review](url), [Multi-dimension scan](url)` + `[Backward-compatibility](url)` when the BC gate posted, and link each row's `Source`. |
| Skipping the BC pass on a contract change | If the diff touches `packages/contracts/**`, a `*Schema.ts`, a package's `src/index.ts`, the policy-config shape or the audit-record shape, the BC pass is REQUIRED — a removed field or tightened validation breaks an existing install, and an audit-format change makes already-written evidence unreadable. Only a diff with no such surface skips it (`BC: N/A`). |
| Fixing from the returned summaries instead of re-fetching | The summaries are one-liners; the authoritative findings live on the PR. Always `gh api …/comments` first, then fix. |
| Leaving Minor/Nit "for the user" | Resolve fixes everything in the blast radius (Critical→Nit). Refute with output, or defer for one of the three reasons in `vibe-code-developing-v2/references/phases.md`, recorded in the resolution comment. |
| Deferring a red/skipped test or a red lint | Never deferrable. That's unfinished work — fix it, or PROVE pre-existing by running it on `origin/main` and raise it in the report. |
| Reading an added test as *documentation* and moving on | Tests are code with their own failure modes. A green test proves nothing until you can name the production line whose deletion turns it red. On any diff that ships tests, the test-quality pass is REQUIRED. |
| "The test passes, so it's fine" | Passing is the **cheapest** property a test has — a vacuous, tautological or expired test also passes. The evidence is a **mutation check**: break the covered line, watch it go red, revert. |
| An absolute date in a test whose subject reads `Date.now()` | A scheduled failure. It merges green and turns red days later on `main` with no code change (`routeCatchUp.test.ts`, 28.07.2026 — 40 h after merge). Anchor fixtures relative to `Date.now()`, or inject `now` into the unit and then pin it absolutely. |
| Deriving the boundary under test from the prod constant | Tautology: mutate the constant and the test moves with it. Fixture *shape* may import prod consts; the *boundary being asserted* must be independent. |
| A lone `toBe(0)` / `toBeNull()` / `not.toHaveBeenCalled()` | Defaults prove nothing — they hold when the feature is deleted, and a case-sensitive selector made exactly this green while the element was on screen. Every negative assertion needs a paired positive control. |
| Fixing a flake with a retry or a longer timeout | That hides the defect and is itself a finding. Wait on a **condition**, not a duration; drive local-hour logic by timezone, never by moving the clock in a logged-in integration test (the 15-min token expires → unrelated 401). |

## Relationship to other skills

- **`vibe-code-developing-v2`**'s `review-*` gates invoke this as the post-PR review gate; its
  the collect → fix → resolution loop is **owned here** — the workflow just invokes
  `dual-review` and mirrors the returned resolution summary into its final report.
- The reviewers are `superpowers:requesting-code-review`, the built-in `code-review:code-review`,
  the gated backward-compatibility pass (dispatched Opus agent, runs only on contract/persisted/wire
  diffs), the gated test-quality / anti-flake pass (diffs that add or change tests — time-bombs,
  tautologies, vacuous assertions, clock-fighting, order dependence), and the gated error-handling /
  observability pass (diffs with a runtime failure surface).
