---
name: vibe-code-developing-v2
description: The gated pipeline for shipping any feature, fix or refactor in mcpproxy — use it whenever implementation work starts, whether the owner names it or hands over a ticket, a bug report or a spec. Gates are executable commands that leave receipts, not paragraphs asking to be obeyed. Trigger (RU) — "делай по вайб кодингу", "запускай в2", "реализуй фичу", "правь по тикету". Trigger (EN) — "implement this", "ship this feature", "run vibe2". Also invocable directly as /vibe-code-developing-v2.
---

# vibe-code-developing-v2

Current gate state:

!`node .claude/skills/vibe-code-developing-v2/scripts/ship-lint.mjs --human 2>/dev/null || echo "no active run"`

## Two routes — pick with a command, not a feeling

| | **full** (gated) | **lite** (ungated) |
|---|---|---|
| when | a feature, a refactor, anything whose cause is not yet proven | a small fix already diagnosed in its ticket |
| branch | `v2/<slug>` | `fix/<slug>` |
| harness | bundle, receipts, `ship-lint`, handoffs, `cost.mjs` | none of it |
| always | worktree · ticket in the PR body · failing test first · mutation check · verification pipeline · `dual-review` + resolution · owner merges | identical |
| lite alone drops | — | the derived review gates and their receipts; replaced by measuring the changed surface and pasting the numbers |

```bash
node .claude/skills/vibe-code-developing-v2/scripts/lite-check.mjs   # 0 = lite · 1 = escalate · 2 = nothing to route yet
```

It reads committed, staged, unstaged and untracked changes, so it answers before the first commit
as well as at the PR. It escalates on **surface** (`packages/contracts/`, a package's public
`src/index.ts`, a `*Schema.ts`, the policy or audit path, auth/credentials, `.claude/` itself,
lockfiles, tsconfig, CI) at any size, and caps **logic files at 3** — tests, docs,
deletions and renames do not count. Escalation is one-way: shrinking the work to stay under the cap
is the failure the cap exists to prevent. Detail: `references/phases.md`, "Lite route".

**Lite drops the paperwork, never the evidence.** `dual-review` in particular is not optional
there — on a fifteen-line fix it caught a layout regression that wrapped a tile in all five
locales. Everything below this line describes the **full** route.

## What a gate is

A gate is a command that writes `docs/vibe-coding/<feature>/.gates/<name>.json`. `ship-lint` reads
those receipts; the `gh pr create` hook refuses to open a PR while any required one is missing, so
the rules do not depend on being remembered. **One branch, one plan**, however many tickets ride
along — `gate-run init` refuses a second bundle on a branch that already has one.

**Never hand-edit `.gates/` or `status.md`.** Receipts come from `gate-run`, `status.md` from
`render.mjs`. A file the model edits is a claim; a file a command writes is a record.

## Commands

```bash
S=.claude/skills/vibe-code-developing-v2/scripts
node $S/gate-run.mjs init --feature docs/vibe-coding/<slug> --agent-consent [--track full|lite] \
     (--ticket <url|id> … | --new-ticket "<title>" | --no-ticket "<why>")
node $S/ticket.mjs start|add|resume|finish|show --feature <dir>  # claim · found mid-run · re-verify · retire to "claude finished" · list
node $S/ship-lint.mjs --human          # what is still owed
node $S/gate-run.mjs run <gate> --feature <dir>
node $S/gate-run.mjs waive <gate> --feature <dir> --reason "<why>"
node $S/gate-run.mjs close --feature <dir>   # the run is over; stops arming the guard
node $S/render.mjs status  --feature <dir>
node $S/render.mjs pr-body --feature <dir>
node $S/render.mjs handover --feature <dir>  # evidence folders + Rn checklist, for the final report
node $S/cost.mjs --feature <dir> --record    # what the run cost · --all for every run on record
node $S/ship-lint.mjs --self-test      # is the harness itself alive
node $S/lite-check.mjs [--base origin/main] [--json]   # may this diff ship ungated? 1 = escalate, 2 = empty
node $S/lite-check.mjs --self-test
```

Gates are derived, not argued with: `packages/contracts/**` or a package's public `src/index.ts`
→ `review-bc`; a test in the diff → `review-tests`; any code → `build-test`, `review-internal`,
`review-scan`, `review-errors`. One is derived from the run rather than the diff, because it
precedes the diff: `track: full` → `plan-approved`.

## Phases

Detail: `references/phases.md` — every gate names the skill it runs, plus the coverage gate, the
design-system catalog gate, scope discipline and the research rule. Reviewers:
`references/reviewers.md`. Ticket flow, identity, `status.md`, the worktree:
`references/ticket-and-status.md`. The plan skeleton and the research guide: `references/plan-template.md`, `references/industry-research.md`.

1. **Preparation** — init, brainstorm **as a grill** (research first, then the whole batch of questions
   in one message; `visualizer` on a visual question), critics + `visualizer/design-review.md` when a
   mockup exists, write `spec.md`.
2. **Plan** — `plan.md` into `references/plan-template.md`, `plan-lint`, `plan-review` → the
   `plan-approved` receipt, push the bundle to the run's own branch — never `main`.
3. **Implementation** — inline, in a `v2/<slug>` worktree. Agents research and review, never write code.
4. **Review and ship** — run the derived gates, render the body, open the PR. **Never merge.**

## An approved plan is finished — never handed back half-done

Once `plan.md` has passed `plan-review`, **running low on context is NEVER a reason to stop, narrow
the scope, or hand the work back.** Compaction restores the window, and the bundle on disk is
precisely the artifact that lets you resume with zero loss — that is what it is FOR.

"I'm running low on context, let me commit what I have and report" is a workflow violation, and so
is a PR body listing unimplemented requirements as "outstanding". The owner asked for a feature,
not a partial branch — a PR he cannot merge costs a review pass and leaves the feature unknown.

The only legitimate stops: **(a)** the owner says stop, **(b)** a genuine external blocker no
amount of work removes (a credential you do not have, a third-party outage), **(c)** a decision
that is genuinely the owner's — and there you ASK and keep working on everything that does not
depend on the answer. "The remaining work is large" is not one of them; neither is "context is tight".

## Agents — the whitelist, and the line

**Running this skill IS the owner's request for the agents below. Do not stop to ask for
permission to spawn them.** Claude Code ships a standing instruction — *"Do not call the
AgentTool unless the user requested it"* — and it is satisfied here: the owner invoked a workflow
whose gates are DEFINED as agent runs. Pausing at a review gate to ask "may I spawn reviewers?"
is the workflow violation, not the caution: it stalls an autonomous run, and answering "yes"
tells you nothing the skill did not already say. Spawn them and report what they found.

**Agents are forbidden for implementation.** No coding, edits, test writing, bug fixes, or
auto-fixing review findings via subagents. All development and all fixes run INLINE.

Pre-authorized, and only these:
- **Phase 1 and any phase — read-only research.** Mapping code, tracing callsites, inventorying a
  catalog, answering "where is X used". Fan these out freely and by default; prefer `Explore`.
  Reading breadth-first and stopping too early is the single most repeated cause of plan defects
  in this repo, and a research fan-out is the cheapest cure. They must not edit, write, or run
  mutating commands.
- **Phase 2** — `plan-review`.
- **Phase 4** — the review fan-out, all READ-ONLY: `dual-review`, `code-audit/clean-code-review`.
  The `review-internal` · `review-scan` · `review-bc` · `review-tests` · `review-errors`
  gates cannot be earned any other way: reviewing your own diff inline is not an
  independent review, and a receipt claiming otherwise is false. Spawn them as ordinary subagents
  and judge the gate by each reviewer's findings FILE, not by whether the call appeared — a
  subagent's final message reaches the parent unreliably. If a reviewer genuinely cannot run, say
  so and record in the report that the review was NOT independent — never let an inline pass be
  written up as one that ran. **The fan-out happens ONCE.** Fixing what it found does not earn a
  second one: verify each fix with the test that covers it, and if you believe a dimension truly
  needs re-reading, ASK — name it, say why, and wait. The review fan-out is the most expensive
  thing this workflow does.

A skill named as a **path** (`code-audit/clean-code-review`, `plan-review/cross-plan-review`) is a
sub-skill: it is not in the skill listing and `Skill(<name>)` will not resolve it. Read
`.claude/skills/<path>/SKILL.md` and follow it. A bare name is a top-level skill, invoked
normally. If `Skill(<name>)` does not resolve a bare name, that reference is stale — grep `.claude/skills/` for its real location.

**The line is write access, not phase.** Tempted to fork a subagent to *write* code because the
scope is large or to keep context clean? **STOP and ASK the owner per instance** — this overrides
any "dispatch parallel agents" guidance elsewhere.

**`Workflow` needs the owner's consent, per invocation.** The rules above govern the `Agent` tool;
`Workflow` is a different one that spawns dozens at once, and a skill's own instructions can launch
it without you deciding to. One run spent 61 agents and 5.13M tokens that way. Ask first.

**Do not trust an agent's self-report.** "Tests pass", "review done", "I fixed it" — verify
against the repo. Reviewers are READ-ONLY: they produce findings and touch no code; fixes are
applied inline by the main session, sequentially, or two writers race on the same tree.

## Rules that no gate can express, so they stay here

- **Fix it in this run.** Inside the diff's blast radius a follow-up ticket is a violation, not a
  deferral. A failing test, a red lint, a type error, any e2e or design finding: never ticketable.
- **Verify a reviewer's premise against the code before applying it.** Reviewers are wrong
  often enough to matter, and a wrong fix costs more than the finding.
- **The mockup is the source of truth for copy** — the string typed there is the string that
  ships.
- **A worktree must build its own workspace** — `yarn install` then `yarn build` inside it, so a
  package resolves to its OWN `dist`, never a sibling worktree's stale one.

## Context handoff

**Twice per run, both mandatory:** `--stage plan` after APPROVED, `--stage ship` once the code is
committed — the second refuses without `<dir>/handoff-notes.md`. Each reset is worth ~30 %, measured.

- **You stay:** run `handoff.mjs --feature <dir> --stage plan|ship` — it writes `handoff.json` and
  prints the prompt — then `/clear`. The SessionStart hook feeds that prompt to the next session,
  so it opens already knowing what it continues. **No `handoff.json`, nothing to inject** — and the
  hook that reads it lives outside the repo, so on a machine without it, paste the printed prompt.
- **You leave:** the same script with `--mode handoff` spawns `claude -p --session-id <uuid>`
  instead, and records the uuid, its log and `claude --resume <uuid>` in `status.md`.

Reminders work only while you are present; in an autonomous run enforcement is the deny alone.

**The handoff is not enforced, and cannot be from inside the session.** On the first real run the
whole feature went through in one context and nothing noticed. What exists is a paper trail —
compare `handoff.json`'s session against the one that opened the PR. A discipline, not a gate.

## Is any of this earning its keep

`/harness-report` answers it, and the kill criteria are already committed: at 60 days and ≥20
runs, a gate with zero ship-time catches is deleted, not defended.
