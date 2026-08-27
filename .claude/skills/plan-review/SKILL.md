---
name: plan-review
description: Plan-time review family. Default — iterative architectural review: send a plan file to a strict Opus reviewer, revise, repeat up to 5 rounds until approved. Sub-skills cover the other plan-time lenses — clean-code review of the plan's snippets, and cross-plan seam checks between sibling plans. Trigger (RU) — "прогони ревью плана", "проверь план", "клин-код ревью плана", "сверь планы между собой". Trigger (EN) — "review this plan", "validate the plan", "clean-code review the plan", "cross-plan review".
argument-hint: <path-to-plan-file>
allowed-tools: [Read, Edit, Agent, Glob, Grep, Bash]
model: opus
---

# Iterative Plan Review

## Route first

If the ask is one of these, read that sub-skill's `SKILL.md` and follow it INSTEAD of
the procedure below:

| The ask | Sub-skill |
|---|---|
| Clean Code / Fowler / SOLID lens on the code snippets INSIDE a plan, before architectural review | `clean-plan-review/` |
| Two or more sibling plans that must agree — seams, shared contracts, duplicated work | `cross-plan-review/` |

Otherwise — a single plan file, architectural verdict — continue here.

You are orchestrating an iterative plan review process. Your job is to send the plan to a reviewer agent (forked Claude with Opus), collect feedback, revise the plan in the file, and repeat — up to 5 rounds maximum.

## Input

$ARGUMENTS is the path to the plan file to review.

If $ARGUMENTS is empty, look for the plan file in the current conversation context (e.g., the file used in plan mode). If you still can't determine the file, ask the user for the path.

Read the plan file before starting.

## Process

For each round (1 to 5):

### 1. Send to reviewer

Use the Agent tool with these parameters:
- subagent_type: "general-purpose"
- model: "opus"
- description: "Plan review round N" (where N is the current round number)
- prompt: Include ALL of the following in the prompt:

```
You are a strict architectural reviewer. Your only job is to find problems. Do not agree just to agree. Be harsh but fair.

If there is a CLAUDE.md in the project, use it as the source of truth for architecture and conventions.

Review the following aspects:
1. Correctness — Will this plan achieve the stated goals?
2. Risks — What could go wrong? Edge cases? Data loss?
3. Missing steps — Is anything forgotten?
4. Alternatives — Is there a simpler or better approach?
5. Security — Any security concerns?

Be specific and actionable. Reference file paths and line numbers where relevant.

{If this is round 2+, include: "Previous review feedback that was addressed: <paste previous feedback>. Verify the revisions are adequate and look for any remaining or new issues."}

If the plan is solid and ready to implement, end your review with exactly:
VERDICT: APPROVED

If changes are needed, end with exactly:
VERDICT: REVISE

Plan to review:
<plan>
{paste the full plan content here}
</plan>
```

### 2. Handle verdict

- APPROVED: Stop the loop. Report to the user that the plan passed review in round N.
- REVISE:
    1. Show the reviewer's feedback to the user.
    2. Edit the plan file, addressing every specific concern raised by the reviewer.
    3. Show the user a summary of what you changed in the plan file.
    4. Immediately proceed to the next round (no user confirmation needed).

### 3. After 5 rounds

If the plan has not been approved after 5 rounds, stop and present to the user:
- All unresolved concerns from the last review
- Ask the user how to proceed

## Output format

After each round, report:

```
## Round N/5 — [APPROVED | REVISE]

**Reviewer feedback:**
<summary of key points>

**Changes made:** (if REVISE)
<list of what was revised in the plan file>

Proceeding to round N+1...
```
