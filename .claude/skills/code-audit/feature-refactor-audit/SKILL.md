---
name: feature-refactor-audit
description: Use when a freshly-built feature is green and pre-merge and you want its structure clean before it ships — flat folders mixing subdomains, an oversized service over the LOC ceiling, an algorithm duplicated across files. Triggers (EN) — "audit the feature structure", "this folder is a mess, propose a structure", "find refactor opportunities", "clean this up before prod", "should we restructure X before merge". Triggers (RU) — "глянь структуру фичи", "тут куча файлов в одной папке, предложи структуру", "что отрефакторить перед продом", "причеши до прода". Also use when you're tempted to just reorganize/split-and-commit a refactor inline under a deadline — that urge is the signal to audit and route, not to edit. Read-only, advisory, never blocks; produces a proposal + phased plan and STOPS — it does NOT implement; a MAJOR refactor is handed to a `/vibe-code-developing-v2` run.
---

# feature-refactor-audit

## Overview

A **structural** refactor audit of an entire feature surface (one or more modules /
folders), run while the feature is still **pre-merge / pre-production** — the cheapest
moment to fix organization debt, before the code becomes load-bearing in prod and the
move cost multiplies.

It answers: *"now that the feature is built and green, what should we restructure so it
ships clean?"* — and ends in a **concrete target folder structure + a phased,
classified refactor plan** the user can approve.

This is **not** the line-level clean-code lens and **not** a fixer. It is discovery +
proposal, report-only.

### The gap it fills (read this — it defines the boundary)

| Skill | Lens | Unit | Owns |
|---|---|---|---|
| `code-audit/clean-code-review` | line / function / class clean-code (Uncle Bob, Fowler, SOLID) | a **diff** | naming, SRP-of-a-function, primitive obsession, `any`, comments, named-const violations |
| `plan-review/clean-plan-review` | same clean-code lens | code snippets **in a plan** | pre-implementation snippet quality |
| `plan-review` | architecture / contracts / wire format | a **plan** | should-this-be-a-different-service at PLAN time |
| **`code-audit/feature-refactor-audit`** (this) | **module organization & structural shape** | the **whole built feature** | flat-folder-mixing-subdomains, oversized service crossing the LOC ceiling, an algorithm duplicated across files, the target subfolder structure, the phased move plan + blast radius |

`code-audit/clean-code-review` explicitly will NOT flag "extract this into a folder/service" or
restructure modules (it's diff-scoped and conservative on that). This skill is exactly
that missing structural pass — but disciplined by the project's **no-speculative-
abstraction** rule (see below) so it never cargo-cults "enterprise" shapes.

## When to use

- A feature is **built, green, and on its branch** but not yet merged/in prod, and you
  want it structurally clean before it ossifies.
- A folder has grown a flat pile of files for one entity (the canonical trigger: "куча
  `<entity>*` файлов в одной папке, как будто их можно под одну папку смонтировать").
- A module has quietly crossed the LOC ceiling the project sets (check the nearest `CLAUDE.md`).
- Right after a sizable PR lands onto a feature branch (e.g. a stacked sub-feature) and
  you want to fold its structural debt in before the assembled PR merges.

## When NOT to use

- For **line-level** code quality on a diff → `code-audit/clean-code-review`.
- For **architecture/contracts at plan time** → `plan-review`.
- For an already-decided local refactor you just want done → `simplify`.
- On code already in production with no concrete pain — restructuring stable prod code
  for aesthetics is churn, not value. This skill is a **pre-merge** tool.

## Input

`$ARGUMENTS` is the feature scope. Recognised forms:

| Form | Meaning |
|---|---|
| `module=<path>` | one or more module/folder paths to audit, comma-separated (e.g. `module=packages/core/src/policy`) |
| `pr=<N>` / `branch=<ref>` | also pull the introducing diff (`gh pr diff <N>` / `git diff $(git merge-base main <ref>)..<ref>`) so the audit can review newly-added code, not just the resting tree |
| _omitted_ | ask the user which feature/module to audit — never guess |

Optional flag appended with `&`: `fanout=N` — number of parallel read-only analysis
agents (default 3; `0` = do it inline yourself).

## Process

### 1. Scope & measure (always inline first — ground the audit in facts)

Before any agent, establish the ground truth yourself so the proposal is real, not
hallucinated:

```bash
# file inventory + LOC per file for the target module(s)
find <module> -type f -name '*.ts' | sort | while read f; do printf "%5s  %s\n" "$(wc -l < "$f" | tr -d ' ')" "$f"; done
# sibling structure for context
ls -d <module>/../*/
```

Read the relevant `CLAUDE.md` (the root one plus any in the packages you are auditing) so
the proposal obeys the project's **existing** module pattern — never invent a layout the
codebase doesn't already use. Read the module's barrel (`index.ts`) and the introducing
diff if `pr=`/`branch=` was given.

### 2. Optional read-only fan-out (breadth)

These agents are **READ-ONLY analysis** (allowed at audit time — see the project's
no-agents-for-dev rule, which permits read-only analysis/review agents). Run up to
`fanout=N` in parallel. They must **Read/grep only** — never edit, never `git checkout`/
branch-switch (that silently moves a worktree). Each returns a structured report:

- **structure-mapper** — read the big files; for the oversized service, table every
  method (name, ~LOC, classification: ORCHESTRATION = touches DI/persistence/errors |
  PURE = inputs→outputs, no instance state | GUARD | STORAGE/IO | other); propose
  extraction boundaries that respect OOP-classes-not-bare-functions.
- **diff-reviewer** — review the introducing diff for structural smells: a **duplicated
  algorithm** across files (rule-of-two → extract one helper), magic literals vs
  named-const, anything that should be extracted. file:line, severity, concrete fix.
- **blast-radius-mapper** — grep the whole tree for every import site of the module's
  files (barrel vs deep imports), so a folder move's cost is known up front. Returns:
  importer → symbols → barrel-or-deep, and a count of prod vs test import sites.

**Always verify the agents' headline findings yourself** before presenting — Read the
exact lines. Agents over-report (a classic failure: proposing to split a 588-line
service into *five* micro-classes — that is the speculative-abstraction anti-pattern, not
a clean refactor). Treat their output as input, not truth.

### 3. Detection checklist (what counts as a real structural finding)

Flag only substantive structural debt:

- **Flat folder mixing subdomains** — one folder holds files for ≥2 distinct subdomains
  (e.g. `config*` + `log*` + `scoring*` in one flat dir). Propose subfolders per
  subdomain, **keeping the barrel's public surface identical** so external importers are
  shielded. Group by cohesion (which files import each other and are consumed together).
- **Oversized module** — a file over the project's soft trigger (see the nearest `CLAUDE.md`: 500
  LOC) and especially near/over the hard ceiling (~800). Propose extracting **isolated
  logic** (pure transforms, a cohesive IO/storage cluster, guards) into a sibling
  subfolder per the existing convention. The public orchestration methods STAY.
- **Duplicated algorithm** — the SAME multi-line algorithm appears in ≥2 places (rule of
  two satisfied → extract a named helper called from both). Two *similar-looking* lines
  are NOT duplication; be conservative.
- **Magic literal where a named const belongs** — `11000`, `.slice(0,10)`, `'gym'` inline
  vs `ActivityType.GYM` / a named const. (Defer pure line-level cases to
  `code-audit/clean-code-review`; flag here only when it's pervasive across the feature or part of a
  structural extraction.)
- **Misplaced module** — a sub-area consumed by multiple unrelated modules that's nested
  where it should be top-level, or vice-versa (the nearest `CLAUDE.md`'s sub-modules rule).

### 4. The no-speculative-abstraction discipline (HARD RULE — do not violate)

This skill proposes structure; it must NOT cargo-cult enterprise shapes. Root `CLAUDE.md`
"No speculative abstraction" governs every proposal:

- **Never split for the sake of splitting.** A 588-line service becomes ~2 cohesive
  helpers, NOT 5 micro-classes in 5 subfolders. Each extracted unit needs a *real* reason:
  genuine cohesion, a second caller (rule of two), or stateless pure logic that's actually
  reused/tested in isolation.
- **Prefer the narrowest restructuring** that removes the named pain. If the user's pain
  is "flat folder", the core proposal is subfolders — a service split is a *separate,
  optional* phase, not a mandatory bundle.
- **Match the existing codebase.** Only propose layouts/patterns the project already uses
  (`Router→Controller→Service→Model`, `<x>Service.ts` + `<x>/<area>/<file>.ts` for pure
  logic, helper sub-modules). Don't introduce a Factory/Strategy/Repository with one impl.

If you catch yourself proposing an abstraction "in case we swap it later" — delete it.

## Output — the refactor-opportunity report (report-only)

Present in conversation (offer to also save under `docs/superpowers/` — gitignored — if
the user wants it persisted). Structure:

1. **What's good** (briefly — don't only criticize; note what already follows convention).
2. **What's not** — grouped findings, each with file:line, severity, the smell, the fix.
   Confirm every headline finding was verified by reading the actual lines.
3. **Proposed target structure** — a tree diagram of the new folder layout, with the
   barrel surface explicitly marked "UNCHANGED".
4. **Blast radius** — N prod + N test import sites that a move touches; whether the barrel
   shields external consumers; the mechanical-but-large warning if applicable.
5. **Phased plan** — ordered phases, each = one commit, each classified
   **[MINOR]/[MODERATE]/[MAJOR]** (per root CLAUDE.md), each with its verification gate
   (the standard pipeline — point to CLAUDE.md, don't duplicate commands).
6. **Recommendation on execution** (see below).

## Hand-off — this skill ENDS at the report

Report-only, advisory, never blocks (same philosophy as `code-audit/clean-code-review`).

**This skill produces the audit and STOPS. Producing the report does NOT authorize you to
start editing — not even the [MINOR]/[MODERATE] phases, not even the "mechanical" ones, not
even under a deadline.** Execution is a *separate step* the user explicitly approves and
routes, after they've read the proposal. Your own audit is never your own green light.

**Violating the letter of this rule is violating its spirit:** "I'll just do the cheap
phase now and report the rest" is still self-authorizing implementation. Don't.

On execution routing (the user decides, applying `feedback_refactor_needs_fdw_not_inline`):

- A **[MAJOR]** refactor (folder reorg touching dozens of import sites, splitting a large
  service) is **`vibe-code-developing-v2`** work — an agent runs the full plan →
  plan-review → implement → dual-review → e2e cycle (it may work directly on the current
  branch — no worktree needed — when nothing else is in flight). Never an inline fix,
  however mechanical it feels.
- A **[MINOR]/[MODERATE]** finding may be applied inline — but only **after the user
  approves**, as a step outside this skill.
- **Borderline between [MODERATE] and [MAJOR]? Classify it [MAJOR]** (narrowest
  interpretation) and route to `/vibe-code-developing-v2`. A "borderline-MAJOR but I'd do it inline" is a
  rationalization — the borderline IS the answer.

A deadline is an argument to hand off *sooner*, not to skip the gate. Rushing dozens of
import-path rewrites before a review is exactly how a broken import ships.

### Rationalization table — these are NOT reasons to self-execute

| Excuse (verbatim from testing) | Reality |
|---|---|
| "It's purely mechanical code-motion" | Mechanical ≠ small. ≈65 import sites is [MAJOR]. Route it. |
| "It's behavior-preserving, tests stay green" | Behavior-preserving is why it *feels* safe and why a silent path-break hides until CI. Gate it. |
| "No new behavior, so no plan-review needed" | Structural reorg IS the thing plan-review checks. `/vibe-code-developing-v2`, not skip. |
| "Best use of the 2-hour window / lead said commit it now" | Deadline + authority = hand off sooner, not skip the gate. Deliver the proposal, route the work. |
| "It's borderline [MAJOR] but I'd still do it" | Borderline → [MAJOR] → route. The hesitation is the verdict. |
| "I'll do the cheap phase inline and report the rest" | Still self-authorizing implementation. The skill ends at the report. |

### Red flags — STOP, you are about to break the rule

- You're writing edit/`git mv`/commit commands while "running an audit".
- You've decided to implement *before* the user has seen and approved the proposal.
- You're reclassifying a [MAJOR] down to "mechanical / [MODERATE]" to justify doing it now.
- A deadline is making you skip the hand-off instead of accelerate it.

**All of these mean: stop editing, deliver the report, let the user approve and route.**

After the user approves and the refactor lands (in its separate step), the standard live
verification applies: run the project's verification pipeline and, for runnable changes, a
live end-to-end pass against the real stack.

## Non-overlap (cite when deferring)

- Line-level naming / function-SRP / `any` / comments → `code-audit/clean-code-review`. If you spot
  one, note it briefly and defer; don't make it this skill's headline.
- Plan-time architecture / contracts → `plan-review`.
- Already-decided local refactor with auto-fix → `simplify`.
- "Is this work done / correct / covered?" → `requesting-code-review`, `dual-review`.

## Anti-noise — DO NOT FLAG

1. **A 12-line function.** Flag cohesion, never line counts.
2. **"Extract this into a service/folder"** when there's one call site. YAGNI wins.
3. **Two similar lines** = not duplication. Three sites of a multi-line pattern = yes.
4. **Splitting a service into many micro-classes.** The hard ceiling triggers extracting
   *pure logic into a subfolder*, not shattering orchestration into pieces.
5. **Restructuring stable prod code** with no concrete pain. This is a pre-merge tool.
6. **Renaming for generic best-practice** against an existing codebase convention.
   Consistency with the codebase wins.

## Verification before reporting "done"

- [ ] File inventory + LOC measured inline (not guessed)
- [ ] Relevant CLAUDE.md read; proposal uses only patterns the codebase already has
- [ ] Every headline finding verified by reading the actual lines (not trusted from an agent)
- [ ] Proposed structure keeps the barrel's public surface UNCHANGED (external importers shielded)
- [ ] Blast radius quantified (prod + test import sites)
- [ ] Each phase classified [MINOR]/[MODERATE]/[MAJOR] with a verification gate
- [ ] No speculative abstraction proposed; narrowest restructuring that removes the pain
- [ ] Execution routed correctly: [MAJOR] → `/vibe-code-developing-v2` run, not inline
- [ ] No file edited by this skill (report-only)
