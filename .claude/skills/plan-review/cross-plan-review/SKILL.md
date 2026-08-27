---
name: cross-plan-review
description: Use when a feature was split into MULTIPLE interdependent implementation plans (separate per-package/sub-resource plans, or feature-orchestrator phases) that each passed single-plan review and must be checked for cross-plan INTEGRATION before execution — client API calls with no backend endpoint, DTO fields the client renders that the server strips, two plans editing one model incompatibly, shared enums forked per-plan, spec requirements with zero coverage or double-ownership, or unstated/cyclic execution-order dependencies. Trigger phrases (EN) — "cross-plan review", "do the plans assemble", "integration review of the plans", "check the seams between plans", "GO/NO-GO on the plans". Trigger phrases (RU) — "кросс-план ревью", "сходятся ли планы", "проверь швы между планами", "интеграционное ревью планов", "GO/NO-GO по планам".
---

# Cross-Plan Review

## Overview

`plan-review` and `plan-review/clean-plan-review` validate ONE plan in isolation. **Neither catches the seams** — the bugs that only exist *between* plans: a client call to an endpoint no plan defines, a DTO field stripped by a serializer the client plan never sees, two plans adding the same model field with different types, a spec requirement no plan owns (or two plans both own). This skill is the **integration gate** that runs AFTER every plan is individually approved and BEFORE execution.

**Core principle:** a set of individually-correct plans is not a correct system. The verdict is about the *assembly*, not the parts.

It is a peer of `plan-review`/`dual-review`: a self-hosted Opus reviewer over a structured contract+coverage extraction, looped to a single **GO / NO-GO**. Advisory; blocks only on CRITICAL by convention.

## When to use

- A feature split into 2+ plans (one per package, or per sub-resource) where each plan passed `plan-review` — run this before any plan executes.
- Re-run after fixing an offending plan, until GO.

**When NOT to use:** a single plan (use `plan-review`); reviewing actual code at PR time (use `dual-review`); code-quality of one plan's snippets (use `plan-review/clean-plan-review`).

## Inputs

- The N plan files (paths).
- The governing spec (the requirements source — e.g. `docs/<feature>/spec.md`).
- Ground-truth contract surface: the `@mcpproxy/contracts` package + any already-merged/frozen plan whose contracts the others consume verbatim.

## Process

### Stage 1 — Deterministic structural extraction (you, before dispatching)

Read each plan and the spec; build two artifacts the reviewer reasons over (don't make the reviewer re-derive them):

1. **Requirement → plan coverage matrix.** Enumerate the spec's V-scope requirements (§-refs). For each, record which plan(s) own it. Flag **zero-coverage** (gap) and **≥2 owners** (double-ownership).
2. **Per-seam contract inventory.** Extract from the plans: every declared HTTP endpoint (method + path + body + response), every client API call, every DTO/Zod field the client renders, every model/schema edit, every shared enum/const, and the stated execution-order dependencies.

### Stage 2 — Strict reviewer subagent (Opus, read-only, isolated)

Dispatch ONE Opus general-purpose agent with the prompt below + your Stage-1 artifacts. It runs the checklist below plus Spec-Kit's six detection passes, returns a findings table with `plan:section` refs, severity, the coverage matrix, a dependency check, and a single GO/NO-GO.

### Loop

- **NO-GO** → fix the offending plan(s) (edit the files), then re-run Stage 1 (deltas) + Stage 2. Repeat until GO (cap 3 rounds; if still NO-GO, surface unresolved CRITICALs to the user).
- **GO** → report; plans are cleared for execution.

## Reviewer prompt (paste into the Agent, model: opus, read-only)

```
You are a STRICT cross-plan integration reviewer. The feature was split into multiple interdependent plans that each ALREADY passed single-plan review. Your ONLY job is to find problems in how they ASSEMBLE — not within any single plan. Be harsh; do not invent within-plan nitpicks.

Read from disk: <list every plan file>, the spec <spec path>, and the ground-truth contracts in packages/contracts/ (+ any frozen plan). Use the project's CLAUDE.md files as the convention source of truth.

Run these checks and cite EVERY finding as plan:section (file + task/step):

CONTRACT / SEAMS (consumer package ↔ producer package ↔ contracts)
1. Every call a consuming package's plan makes maps to something a producing package's plan actually exports — matching name, arity, argument shape and return shape. Flag calls with no producer AND exports nobody calls.
2. Every field a consumer reads survives the whole path it travels: it is in the declared type, it is not dropped by a validation schema in between, and it is not stripped by whatever serialises it at the boundary. A field that exists on the model and never reaches the caller is the recurring incident class here — scrutinize it.
3. Shared enums/limits resolve to ONE source in packages/contracts/; no plan re-defines a contract another plan owns; no parallel local dictionary.
4. Named-const-over-literal is consistent across plans (no raw literal in one where another uses the named const).
5. Backward-compat holds across the SET: no plan removes/renames/tightens something another plan — or an already-shipped install — still reads; additive-not-destructive; read-with-fallback shipped with its migration.

MODEL / OWNERSHIP
6. No two plans edit the same type/file incompatibly (same field, different type; conflicting migrations).
7. No terminology drift — same concept named differently across plans.

COVERAGE vs SPEC (build/verify the matrix)
8. Every in-scope spec requirement is owned by EXACTLY ONE plan — list zero-coverage gaps AND double-owned requirements.
9. No orphan task references a file/component/endpoint no plan creates.
10. Buildable NFRs (performance, policy enforcement, audit coverage, security) each land in some plan, not dropped.

SEQUENCING
11. Cross-plan execution-order dependencies are STATED and ACYCLIC, and respect the workspace's own build order — a consumer cannot land before the producer it compiles against.

OUTPUT (exactly):
- Findings table: | severity | plan:section | issue | fix |  (CRITICAL = breaks integration or zero-coverage core requirement; HIGH = conflict/double-owned/untestable; MED = drift/missing NFR; LOW = wording).
- Coverage matrix: requirement → owning plan(s); mark GAP / DOUBLE.
- Dependency order: the stated order + any cycle/missing edge.
- End with exactly `VERDICT: GO` (no CRITICAL/HIGH) or `VERDICT: NO-GO`.
```

## Common mistakes

- **Skipping Stage 1.** If you dump raw plans on the reviewer without the coverage matrix + contract inventory, it reviews prose, not seams. Build the matrix yourself first.
- **Treating it as another single-plan pass.** If a finding is internal to one plan, it belongs to `plan-review`, not here — don't gate GO/NO-GO on within-plan nitpicks.
- **Forgetting the frozen/ground-truth plan.** The contracts the others consume verbatim are the reference; a "missing endpoint" may be defined in an already-merged plan — include it in the inputs.
- **Not re-running after a fix.** A fix in plan A can break a seam with plan B. Re-loop until GO.
