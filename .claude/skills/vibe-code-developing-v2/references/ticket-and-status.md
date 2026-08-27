# Bundle, branch and status

## status.md

**Rendered by `render.mjs status`, never hand-written.** It projects `run.json` + the receipts:
branch, mode, `codeTree`, kill-review date, the handoff session (with its `claude --resume`
command) and one row per gate. The PR body is a projection of it,
updated only at phase transitions — `status.md` is the source of truth, not the ticket.

## One branch, one plan

**A run has exactly ONE bundle, however many tickets ride along** — two features on one branch still
share one `spec.md` and one `plan.md`. Fold the second piece of work into that plan and name its
ticket with `ticket.mjs add`; `init` refuses a second bundle on a branch that already has one.
Two of them leave two plans on one branch, while the
`gh pr create` hook calls `ship-lint` without `--feature` and cannot pick — the PR then cannot open
without disabling the guard.

## The bundle

```
docs/vibe-coding/<DD.MM.YYYY>-<slug>/
  spec.md            R1..Rn + privacy checklist · plan.md
  review.md          findings; anchored to codeTree
  .review/*.md       one per review dimension + plan.md, the verdict plan-approved reads
  status.md          GENERATED
  pr-body.md         GENERATED, ≤1500 chars
  design/mockup.html      optional
  .gates/*.json      receipts, committed
```

## Worktree

Every feature runs in its own worktree off fresh `main`, branch prefix **`v2/<slug>`** (the guard
arms on it). Provision it by running `yarn install && yarn build` inside the worktree —
and if the run boots a server, confirm its §4c: the worktree must own its `shared` resolution and
allocate free ports, or it silently drives a sibling's app.

The worktree lives until merge. `/wipe` removes it afterwards.
