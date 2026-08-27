# What this harness cannot do

Written down because a control that is trusted beyond its reach is worse than no control.
Every line here was demonstrated by an adversarial re-audit, not imagined.

## A local receipt can be forged, and no local check can stop that

The agent has full filesystem access: it can write `{status:"pass"}` into `.gates/` with `node -e`,
or `rm run.json` and re-init on easier terms. The deny list catches the common shapes, never all.
**The guard is friction against drift, not a security boundary.**
What actually holds: staleness — `codeTree` for the eight code-anchored gates, `planHash` for
`plan-approved` (a forged receipt dies at the next change, `git commit --amend` included); for the
seven review gates, which no longer expire, only the drift line below; the
evidence manifest (faking it means faking screenshots); CI, off this machine, restoring the
harness from `origin/main` — which cuts the other way on a PR that CHANGES the harness, where CI
therefore checks it with the OLD gate set; and you, because the gate line — carrying a ⚠ for every
waived gate — survives any truncation of `pr-body.md`, which is where a skip would hide. Nothing
binds that file to the PR, though: the guard checks `ship-lint` before `gh pr create`, not `--body`.
The goal is that a skipped gate is **impossible to hide**, not impossible to skip.

## The guard fails OPEN, and that is deliberate

The hook lives in `.claude/hooks/` and is registered in the repo's `.claude/settings.json` via
`${CLAUDE_PROJECT_DIR}`, so it runs for **every session, every worktree and every parallel agent in
this repository** — a single point of failure for all of them, and it failed exactly that way once:
an apostrophe inside single quotes broke its bash syntax, and every session lost `Bash` and `Edit`
at once, mid unrelated work. So the layering is now explicit:

- `vibe-hooks.sh` is a **trivial wrapper** — read stdin, delegate, exit 0 on every failure path.
- `vibe-guard.mjs` holds the decisions; broken or missing, the wrapper allows the call and logs to `~/.claude/harness-logs/guard-errors.log`.
- **A worktree carries its own copy**, so a branch cut before this move has no guard at all until it takes `main`.
- **Availability beats enforcement here.** Blocking one agent is a bug; blocking every agent on the machine is an outage.
- What that gives up is recovered by **`gate-run init` refusing to start a run when the guard does
  not deny** — probed only on a `v2/` branch, since that is the only place a run can live;
  `--self-test` runs the same probe on demand and in CI. A silently-open guard cannot reach a gated
  run, but can no longer take the machine down.

## A run is bound to its branch name, and that has edges

A run is active only where `run.branch` equals the current branch. That is what stops a merged
`run.json` from gating every later PR in the repo. The cost:

- **Rename the branch, or branch off it, and the run goes quiet** — `ship-lint` says "nothing to
  check". Re-run `gate-run init` on the new branch.
- **On a detached HEAD the branch is inferred** from refs pointing at the commit, alphabetically — `main` or a `backup/*` ref wins and the run is lost. CI reads `GITHUB_HEAD_REF` first; `gate-run init` refuses outright.
- **A worktree carries its own `scripts/`, so a NEW gate strands an OLD run.** The `gh pr create`
  guard runs the worktree's own `ship-lint`, but CI restores `scripts/` from `origin/main`. Add a
  gate to the registry and every already-cut worktree passes locally and fails in CI — and cannot
  recover in place, because `gate-run` refuses both `run` and `waive` for a gate its own registry
  does not know. The fix is one command, and it belongs here because nothing else will tell you:
  `git checkout origin/main -- .claude/skills/vibe-code-developing-v2/scripts/` — which also STAGES
  what it restores, so unstage it before your next `git add -A` or the harness rides into your commit. Measured when
  `review-errors` was added: 21 of 21 live `v2/*` worktrees were armed, and `gate-run close` had been
  called once, ever.
- **A run ends only when closed.** `gate-run close` marks it; until then a long-lived branch — `main` above all — keeps arming the guard forever.

## A review receipt attests to the code it saw, not to the code that ships

Review gates anchor on the commit they ran against and never expire. The fixes that follow a
review are therefore UNREVIEWED by the gate that prompted them, and the harness says so instead of
pretending otherwise: `ship-lint` and `status.md` print the anchor sha and the files committed
after it, and the decision to re-run a dimension is the owner's.

This is deliberate, and it replaces a rule that could not be satisfied. `review-verify` demands the
current `codeTree`, so while every receipt expired on any commit, fixing a finding invalidated all
seven review receipts at once and the harness asked for another full round — of the very fixes it
had just asked for. The loop had no exit that did not involve ignoring it, and two runs paid for
six and five rounds of seven Opus agents each. What backs the fixes now: `build-test` and the e2e
gates, which DO expire on any code commit; the drift line; and the owner.

The drift line has a reach, and it stops where the anchor does. A file the review never saw is a
FAIL — re-run the dimension or waive it. Everything softer is a WARN carried by all four surfaces
(`ship-lint`, `ship-lint --human`, `status.md`, the PR gate line): a receipt written before drift
tracking existed (no `headSha` — every receipt on every branch cut before this change), and an
anchor made unreachable by a rebase, an amend or a squash. Both say so in words rather than
passing silently, but neither can tell you what was actually reviewed. And on a harness-only PR
the `codeTree` anchor in the findings file proves nothing at all — `codeTree` spans product code,
which such a PR does not touch, so the hash is a constant for the whole branch and `headSha` is
the only signal left.

`.github/workflows/**` counts as harness too: a workflow-only diff derives `review-internal` and
`review-scan`, since CI is what runs the gates everywhere except this machine.

Skill PROSE is outside every path the harness watches — `dual-review/SKILL.md`, this file,
`phases.md` and `plan-template.md` derive no gate and stale no receipt, though the scripts and
hooks beside them do both. A change to the review procedure is reviewed by whoever reads the PR.

## Two things it cannot prove

`waived_by` is always `agent-recorded`: nothing here distinguishes a waiver you asked for from one
the agent decided on, which is why waivers are surfaced rather than counted as satisfied. And it
cannot block a merge — branch protection is unavailable on a private repo on the free plan
(measured: HTTP 403). CI reports red; the merge button, and the enforcement, are yours.

## Three more, stated plainly

- **Exactly one pre-code step is gated.** `plan-approved` covers `plan-review`, triggered by
  `run.json`'s `track` — `full` requires it, `lite` deliberately does not, and a `run.json` from
  before the field reads as `full`. The rest of Phases 1–3 — brainstorm-as-grill, the mockup
  critics, `visualizer/design-review.md` — stays ungated, and not from neglect: none leaves an
  artifact a second party can check, so a gate over them would record the model's claim that it
  ran, the exact thing receipts replace. And `plan-approved` itself is bounded narrowly — it
  proves a FILE exists whose last two lines name THIS plan and say APPROVED. Nothing checks its
  substance, so a two-line file passes; nothing proves a reviewer wrote it (`plan-review` returns
  a message, not a file, so saving it is transcription and the guard does not cover `.review/`);
  nothing proves the review was any good, or that it happened BEFORE the code — ordering is
  unenforced and the gate greens just as well at ship time. A run predating `track` owes the gate
  too, and the remedy there is a waiver, not a re-init that would reset the kill-review date.
- **The `Workflow` and `Agent` rules are prose, and nothing executes them.** The `PreToolUse`
  matcher is `Bash|Edit|Write|MultiEdit|NotebookEdit` — neither tool reaches the guard, so "agents
  never write code" and "ask before `Workflow`" have always been discipline. The second failed once
  already, at 61 agents and 5.13M tokens. A `PreToolUse` deny is mechanically reachable and was
  declined; this line exists so the gap is a known cost rather than a surprise.
- **Nothing checks that an `Rn` was implemented** — that walk stays a human step in `phases.md`.
- **The lite route enforces almost nothing, by construction.** It runs on a `fix/*` branch with no
  bundle, which is exactly the condition under which `vibe-guard.mjs` returns `allow()` — so on
  lite there is no receipt to miss and no `ship-lint` at the PR. Two denies were moved ABOVE that
  early exit and therefore do hold everywhere: `gh pr merge` and `--no-verify`/`SKIP=`. Everything
  else on lite — the review, the test, the measurement — is discipline, and nothing stops a run
  from skipping `dual-review`. `lite-check.mjs` routes a diff but does not police one: it
  reads the diff on demand and no hook calls it, so a run can simply not ask, or ask and ignore the
  answer. What keeps lite honest is that its whole point is a diff small enough for the owner to
  read on the PR — the review of last resort is his, and unlike the full route that is not a
  backstop, it is the design. Two consequences worth stating plainly: the route is only as good as
  the entry decision, and a diff that grows past the cap mid-run has no mechanism to notice —
  re-running `lite-check` before opening the PR is discipline, the same class of thing as the
  handoff above.
