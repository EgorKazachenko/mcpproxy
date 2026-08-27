# Phases

## 1 — Preparation (interactive)

1. `gate-run init --feature docs/vibe-coding/<DD.MM.YYYY>-<slug> --agent-consent --ticket …` — it
   moves every ticket named into `Claude in progress`, and refuses to start without one.
2. **Brainstorm as a grill.** `superpowers:brainstorming`, plus `visualizer` when the feature has a
   visual question — frequently BOTH: the grill settles the logic, the visualizer what words cannot.

   **Grill format — study the code first, then ask the whole batch in ONE message.** Whatever the
   repo answers is never asked; group what remains in dependency order, each carrying your own
   recommended answer. This **overrides `superpowers:brainstorming`'s one-question-at-a-time rule** —
   that cadence is for a cold start, here it spends a round-trip per answer the owner could have
   given at once. Answers open new forks: ask the next batch. "Пишу спеку?" before the first `Rn`.
3. **When a mockup exists, the critics and `visualizer/design-review.md` are required.** Waive
   with a reason if genuinely not applicable.
4. For a non-trivial data flow or trust boundary, ask whether to draw the architecture into
   `design/tech-design.html` — this is a proxy, and the diagram is often what the review is about.
6. Write `spec.md` with numbered `R1..Rn` and the privacy checklist.

## 2 — Plan (interactive)

1. Write `plan.md` into `plan-template.md` (this folder) — **one per branch**, however many tickets ride along.
2. `plan-lint.mjs` — 0 FAIL, plus `--sweep` after every review round.
3. `plan-review/clean-plan-review`, then `plan-review` (up to 5 rounds). Save the approving report to
   `<feature>/.review/plan.md` unedited except for ONE insertion — `PLAN: $(git hash-object -- <dir>/plan.md)`
   immediately BEFORE its closing `VERDICT: APPROVED`, so those two are the file's last two lines. A
   report quotes earlier rounds; a verdict anywhere else is somebody else's. Commit `plan.md`, then
   `gate-run run plan-approved --feature <dir> --evidence <dir>/.review/plan.md`. Edit the plan after
   that and the gate re-opens — a re-run repairs it only with a fresh verdict naming the new plan.
4. Push the bundle to the run's own `v2/<slug>` branch, **never `main`** — a run resumes by branch,
   so a bundle on `main` is one nothing reads. Then `handoff.mjs --feature <dir>`, then **`/clear` —
   this one is not optional.** Everything up to this gate is 0–31 % of a run (measured, 13 runs) and
   was being carried in context through all of phases 3–4; resetting here cut 28–34 % off the three
   runs re-measured against it. No `handoff.json`, and the resumed session opens blank.

## 3 — Implementation (inline)

Execute the plan. Commit as you go: a code-anchored `gate-run run <gate>` refuses a dirty tree.

It ends the same way phase 2 does, and for the same measured reason — phase 4 is 47–83 % of a run,
and resetting before it took 14–36 % off the bill. Write `<dir>/handoff-notes.md` first: where the
code diverged from the plan and why, what was deliberately left undone, what is fragile, what a
reviewer will ask about. **The plan says what was meant; only this session knows what was done** —
without it the next one re-derives your decisions from the diff or silently drops the debt. Then
`handoff.mjs --feature <dir> --stage ship` (it refuses a missing or three-line note), commit, `/clear`.

## 4 — Review and ship

`ship-lint --human` says which gates are still owed. **A gate does not run the work — it verifies
the evidence.** Run the skill as usual, then hand its output to the receipt:

```bash
node $S/gate-run.mjs run <gate> --feature <dir> --evidence <path>   # a gate whose evidence is a folder
```

`verify-evidence.mjs` refuses a folder that is missing, empty, or older than four hours — a fixed
window, not the run's age, so evidence from a different run this afternoon still passes.

A skill named as a **path** (`code-audit/clean-code-review`, `plan-review/cross-plan-review`) is a
sub-skill: it is not in the skill listing and `Skill(<name>)` will not resolve it. Read
`.claude/skills/<path>/SKILL.md` and follow it. A bare name is a top-level skill, invoked
normally. If `Skill(<name>)` does not resolve a bare name, that reference is stale — grep `.claude/skills/` for its real location.

| gate | skill that produces it |
|---|---|
| `build-test` | runs itself: `yarn typecheck && yarn build && yarn test` across the workspace graph. It builds the WHOLE graph, not just the touched package — a change in one package breaks a dependent one at compile time, and the dependency direction is not knowable from paths alone |
| `review-internal` · `review-scan` | **`dual-review`** — the internal Opus reviewer and the built-in multi-dimension scan. Also run **`code-audit/clean-code-review`** (advisory, 1 round) |
| `review-tests` | the test-quality / anti-flake pass of `dual-review`, derived from the diff |
| `review-bc` | the backward-compatibility lens of `dual-review`, on `packages/contracts/**`, a package's public `src/index.ts`, a schema, the policy-config shape or the audit-record shape |
| `review-errors` | the error-handling / observability-coverage pass of `dual-review`, on any diff with a runtime failure surface |

Then:

1. **Requirements coverage** — walk every `Rn` in `spec.md`, mark implemented / partial / not.
   Partial or not blocks shipping unless the owner descopes it in writing.
3. `render.mjs pr-body` and `render.mjs status`.
4. `gh pr create --base main`, label `bump:patch` (unconditional; ask once on a minor/major
   signal). The guard denies the create until `ship-lint` exits 0.
5. **`dual-review` runs against the open PR**, its findings land in `review.md`, and its
   Resolve fixes are applied **inline by the main session** as separate commits — never a
   squash after the PR exists, that breaks reviewer threads. **ONE round. Then stop.** Fix what
   it found and verify each fix the cheap way — the test that covers it, `build-test`, an e2e
   run, your own eyes. A second full round is the owner's call and you ask for it in the report:
   name the dimensions the fixes actually touch, say what a re-run would plausibly catch, and let
   him answer. Never launch one on your own reasoning. Rounds belong to `plan-review`; a review
   round is a full fan-out of Opus agents, and two runs spent 6 and 5 rounds — a third of their entire cost —
   on fixes each previous round had introduced.
6. `cost.mjs --feature <dir> --record` — one line, and the only way any of this stays honest.
7. **Hand it over.** `render.mjs handover --feature <dir>` prints the evidence folders and the
   `spec.md` requirements; paste its output into your final message and fill in the reproduction
   steps — screen, route, what to tap, what should happen. The owner ends the run with a folder
   of screenshots he can open and a list he can walk, not with a claim that it works.
8. **The workflow never merges.** You merge.

## Rules the gates cannot express

- **Never `git checkout -b` in the main checkout.** Every feature gets its own worktree
  (`git worktree add … -b v2/<slug>`, then `yarn install && yarn build` inside it). Switching
  branches in the shared tree reverts files mid-task, re-triggers the workspace rebuild and
  tangles unrelated work.
- **A worktree must resolve packages to its OWN `dist`.** A sibling worktree's stale build
  resolving in is the classic way a green run proves nothing — verify before trusting the gate.
- **Never bind a fixed port in a test or probe** — many agents share this machine, and a fixed
  port drives a sibling's process.
- **A new client request header needs the server CORS `allowedHeaders` entry in the same change**, or every cross-origin request 400s at preflight.
- **Code search:** `LSP` for symbol navigation **within** a package; grep/ripgrep for cross-package
  traces and barrel re-exports — no semantic tool spans the three tsconfigs. No code-graph indexer.

## A gate went red on something that is not yours

`waive` is not the first move. The sequence:

1. **Prove it on a clean `origin/main` worktree** and keep the output.
2. **Ask the owner: fix here, or waive and ticket?** On the real run: "фикси прямо в этом ПРе".
3. **Waive last**, only if he says so or nobody is there — `gate-run waive` refuses a "pre-existing"
   reason that does not quote the `origin/main` result, and a waiver is unhideable, not free.

## Order of operations, so gates do not invalidate themselves

- `codeTree` spans product code only (`client`, `server`, `shared`, `mobile`), so committing
  `e2e/**`, a workflow, the harness scripts or `docs/**` never stales a build or e2e receipt for
  a file they did not compile. The harness still gates changes to ITSELF: a diff touching
  `vibe-code-developing-v2/scripts/**`, `.claude/hooks/**` or `.github/workflows/**` derives
  `review-internal` and `review-scan` through `touchesReviewable`.
- **Gates derive from the CURRENT merge-base with `origin/main`, not from `run.baseSha`.** Merge
  `main` into a long-lived branch and the recorded base falls behind, so the diff swells with
  everything the merge brought along — this branch derived nine gates, including e2e and
  `build-test`, off 119 files of which 19 were its own. `diffBase()` re-resolves the base and
  falls back to the recorded one when it is not an ancestor (a branch cut off another branch).
- **Review receipts never expire, and that is the point.** They anchor on the commit they ran
  against; a later commit is REPORTED — `ship-lint`, `--human`, `status.md` and the PR gate line all
  name the sha and what changed since. Changes to files the review already saw are a WARN; a file it
  never saw is a **FAIL**, and you either re-run that dimension or record the owner's decision with
  `gate-run waive --reason`.
- **Record the receipt right after the review, BEFORE you fix its findings** — it attests to what
  was reviewed, not to what shipped. If you have already started fixing, pass the commit the review
  actually read: `gate-run run review-<kind> --feature <dir> --anchor <sha>`. Without it the receipt
  anchors on HEAD, no drift can ever appear, and the whole line above becomes decorative.
- `render.mjs` writes docs, and `gate-run` only refuses on a dirty **code** tree — render last,
  just before the PR. `plan-approved` inverts both: it accepts a dirty code tree, and records an
  uncommitted `plan.md` as `planDirty`, which `ship-lint` fails on — commit the plan, then gate it.

## Scope discipline — fix now, ticket almost never

Inside the blast radius (the files this diff touches + their tests) you FIX it in this run. A follow-up ticket is legal only when: **(a)** it needs the owner's
decision — ask now, ticket only if nobody is there; **(b)** it lies outside the blast radius and
needs its own spec; **(c)** it needs access this run lacks. The report must name which.
**Never ticketable:** a failing, skipped or flaky test · a red lint · a type error · dead code or
duplication in a file you edited.

A deferral must name the full PR URL it fell out of — one with no clickable source is unusable
weeks later.

## Research before inventing

If the design rests on framework/browser/OS behaviour you have not personally verified, look up how
the ecosystem solves it and **probe the load-bearing assumption instead of reasoning about it** —
a throwaway script in the workspace beats an argument. Paste raw numbers into `plan.md` under
"Verified facts". Promote anything load-bearing to read-the-source or a probe. Detail: `industry-research.md` (this folder).

## Lite route — ungated, and that is the point

`/vibe-code-developing-v2 lite <task>` runs a small, already-diagnosed fix **without the gate
harness at all**: no `gate-run init`, no bundle under `docs/vibe-coding/`, no receipts, no
`ship-lint`, no `cost.mjs`, no handoffs. The branch is a plain `fix/<slug>`, so the guard —
which arms on a `v2/*` branch or an existing bundle — stays out of the way by construction.

This is not a loophole being opened; it is a route that already existed and was undocumented, so
it got improvised differently every time. What the harness buys on a multi-day feature (a plan
that survives a context reset, receipts a second party can audit, drift detection against a review
sha) buys nothing on a fix whose cause is already proven in the ticket and whose diff is read in
one sitting.

**Entry is decided by a command, not by eye:**

```bash
node .claude/skills/vibe-code-developing-v2/scripts/lite-check.mjs   # exit 0 = lite, 1 = escalate
```

Two rules, and only the first is about risk:

- **Any dangerous surface escalates, at any size.** `packages/contracts/**`, a package's public
  `src/index.ts`, a `*Schema.ts`, the policy decision path, the audit writer, credential handling,
  the lockfile, `tsconfig*.json`, `.github/workflows/**`. A one-line enum edit in `contracts`
  outranks fifty lines of formatting — size never overrides surface.
- **At most three files carrying logic.** Tests, docs, benchmarks, pure deletions and ≥90 % renames
  are **not counted**: they are mechanical, and counting them punishes the diff that also cleans up
  after itself.

**Escalation is one-way and immediate.** The moment the work grows a fourth logic file or reaches a
dangerous surface, it stops being a lite run: start the full route on a `v2/*` branch. Trimming the
work to stay under the limit is the failure this rule exists to prevent — the limit is a router,
never a budget to fit into.

**What lite does NOT drop.** These are not gates in the receipt sense; they are the reason the
route is safe, and every one of them earned its place on a real defect:

1. **A worktree, never `main`** — `yarn install && yarn build` inside it before anything else.
2. **The failing test first, proven to fail** — write it, watch it go red against the current code,
   then fix. A test written after a green fix proves nothing.
3. **A mutation check on anything load-bearing** — break the line the test claims to cover, confirm
   red, revert. "It passes" is the cheapest property a test has.
4. **The workspace's own pipeline** — `yarn typecheck && yarn build && yarn test`.
5. **Pixel evidence for anything visual.** See below — this is the one place lite is genuinely
   thinner than the full route, so it is spelled out rather than left to inference.
6. **`dual-review` on the PR, and its resolution comment.** This is the one that must never be
   negotiable. A route that skips review is not a lighter route, it is an unreviewed one.
7. **The owner merges.** Same as the full route — and since the deny for `gh pr merge` now sits
   above the guard's early exit, that one is mechanical on lite too, along with `--no-verify`.

**What lite DOES drop, stated plainly so nobody discovers it by accident.** The full route derives
its review gates from the diff and requires a receipt for each; lite runs none of them. That is a
real reduction, not an oversight.

The replacement is narrower and cheaper, and it is **not optional** — when a lite diff changes
anything observable, **measure the thing you changed and paste the numbers in the PR**. A
twenty-line script that exercises the changed path and prints real values is a minute's work and
is strictly better evidence than an assertion that it works.

If the change is large enough that per-unit measurement stops being convincing, that is itself the
signal to escalate — the full route exists for exactly that case.

`dual-review`'s own dimensions are already derived from the diff (`BC` and `LS` return `N/A` for
free on a diff that cannot need them), so a small diff pays for a small review without anyone
tuning it.

### `--track lite` is a different, older thing

The `gate-run init --track lite` flag still exists and still means what it meant: a **gated** run —
bundle, receipts, `ship-lint` — that deliberately does not owe `plan-approved`. Old `run.json`
files carry it and must keep reading correctly, so nothing about them changes. Use it when the work
is genuinely gated but has no written plan; use the ungated route above when the work is small
enough not to need the harness at all. Two names, two situations — do not reach for the flag when
what you want is the route.
