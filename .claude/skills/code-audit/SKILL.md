---
name: code-audit
description: Router for ADVISORY, read-only reviews of real code that are NOT the pre-merge gate — clean-code quality, performance/scalability, one feature's structure before it ships, or a whole-codebase tech-debt audit grounded on prod signals. Trigger (RU) — "клин-код ревью", "перф ревью", "проверь на производительность", "нет ли тут тормозов", "глянь структуру фичи", "что отрефакторить перед продом", "сделай аудит кодбейса", "тех-аудит", "найди где отрефакторить". Trigger (EN) — "clean code review", "performance review", "is this slow", "find N+1 / re-render issues", "audit the feature structure", "tech-debt audit", "audit the codebase". NOT the merge gate — that is `dual-review`.
---

# code-audit

Router only. Read the matching sub-skill's `SKILL.md` and follow it.

| The ask | Scope | Sub-skill |
|---|---|---|
| Quality of changed code — Clean Code, Fowler smells, SOLID/SRP | diff | `clean-code-review/` |
| Structure of ONE freshly-built feature before it merges — flat folders, oversized service, duplicated algorithm | feature | `feature-refactor-audit/` |

**`dual-review` stays top-level and is not in this family.** It is the mandatory
pre-merge gate (internal + scan + the gated backward-compat / test-quality /
error-observability passes) and it BLOCKS. Everything here is advisory,
report-only, and never blocks. "прогони ревью перед мержем" ⇒ `dual-review`, not this.

Every sub-skill here **stops at the report**. None of them edits code, and none files
a follow-up task without a separate explicit approval — a MAJOR refactor is handed to
`vibe-code-developing-v2`, never done inline.
