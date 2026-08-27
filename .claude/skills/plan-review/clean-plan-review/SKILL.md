---
name: clean-plan-review
description: Clean-code review of an implementation plan's code snippets, applied BEFORE plan-review. Runs 1 review-revise cycle by default (advisory, never blocks). Focuses on Uncle Bob's Clean Code + selected Fowler smells + SOLID (SRP-heavy). Use when the user wants to stress-test the code-quality of snippets inside a plan file before architectural review starts.
---

You are running a clean-code review of an implementation plan. Your job is to send the plan file to a reviewer agent (forked Claude with Opus), collect feedback, revise the code snippets in the plan in-place, and stop — **1 round by default**, **non-blocking**. The next step (typically `plan-review`) is never blocked by this skill.

**Opt-in for 2 rounds:** if `$ARGUMENTS` includes `rounds=2`, run a second round after applying round 1's fixes. Use only when the user explicitly asks (rare — token cost rarely pays off for a second clean-code pass on the same snippets).

## Input

`$ARGUMENTS` is the path to the plan file to review.

If `$ARGUMENTS` is empty, look for the plan file in the current conversation context. If you still can't determine the file, ask the user for the path.

Read the plan file before starting.

## Scope

This skill reviews **code snippets, type signatures, naming, and structural choices visible IN THE PLAN ITSELF**. It does NOT review architecture, contracts, or wire formats — that's what `plan-review` does. It does NOT review actual implementation code — that's what `dual-review` does at PR time.

In other words: when the plan says "this DTO will look like ...", `code-audit/clean-code-review` checks whether the DTO is well-named, has clean responsibilities, no primitive obsession, etc. When the plan says "this DTO maps to wire field X", that's a `plan-review` concern.

## Process

Default is **1 round**. If `$ARGUMENTS` includes `rounds=2`, do 2.

For each round (1 to N where N is 1 by default, 2 if opted in):

### 1. Send to reviewer

Use the Task tool with:
- `subagent_type: "general-purpose"`
- `model: "opus"`
- `description: "Clean-code review round N"` (where N is current round)
- `prompt`: the FULL prompt below, with the plan content interpolated

```
You are a strict but pragmatic clean-code reviewer. Your job is to find substantive code-quality problems in the implementation plan's code snippets. Apply Uncle Bob's Clean Code, selected Fowler refactoring smells, and SOLID (with SRP-heavy emphasis). DO NOT NIT.

If there is a CLAUDE.md in the project, the existing-codebase patterns it documents take precedence over Clean Code doctrine. Consistency with the existing codebase wins over dogma.

## What to look for

### Function- and class-level smells

- **Naming**: intention-revealing names, no god-names (`data`, `info`, `manager`, `util`, `handler` without context), no abbreviations, no Hungarian notation.
- **Single Responsibility (SRP)**: each class/function has one reason to change. If you'd describe its job using "and", it likely does too much.
- **Function cohesion**: function size is pragmatic — a 30-line cohesive function is fine; a 10-line function with mixed levels of abstraction is not.
- **Side effects**: a function does one thing; no hidden state mutation, no "looks like a getter but writes to disk".
- **Command-Query Separation (CQS)**: a function either changes state OR returns information, not both.
- **Boolean arguments**: usually a smell that the function does two things — split into two named functions.
- **Long parameter list (>3 positional args)**: usually a missing concept — introduce a value object.
- **Output arguments**: avoid mutating arguments in place — confusing and hides the change.

### Code smells (Fowler, complements Clean Code)

- **Primitive obsession**: using `string` for everything (`userId: string`, `accountId: string`) when a named domain type would prevent mix-ups. Especially relevant when multiple ID types coexist.
- **Data clumps**: the same 3+ fields appear together in many function signatures — extract a value object.
- **Feature envy**: a method of class A mostly works with data of class B — the method belongs on B.
- **Speculative generality**: an abstraction / extension point for a use case that doesn't exist yet (YAGNI violation).
- **Switch on type / `instanceof` chain**: often a hidden polymorphism opportunity (only when it actually is one — sometimes a switch is the right tool).

### Dependency direction / Clean Architecture (when visible in plan)

- **Domain ← Framework**: domain types should not import framework decorators or transport/persistence-specific types directly. If the plan's DTO or entity carries framework annotations IN the domain layer, flag.
- **Pure functions where possible**: prefer pure for testability. Side-effectful only at the edges.
- **Repository pattern**: if the codebase already uses it, the new code should too. If not, don't insist on introducing one.

### TypeScript-specific

- **`any` usage**: each occurrence needs justification (third-party type gap, intentional escape hatch). `any` in test mocks is often fine.
- **Type assertion (`as Foo`)** vs proper typing: assertion bypasses the type system; use only when you know more than TS.
- **Optional chaining (`?.`) that hides null bugs**: sometimes asserting non-null (or fail loudly) is better than silently producing `undefined`.

### Tests as first-class (Clean Code ch. 9, beyond F.I.R.S.T.)

- **Test names as specifications**: `it('returns 404 when asset is not found')` good; `it('test1')`, `it('works')` bad.
- **One concept per test**: AAA with one logical assertion-group, not 10 unrelated assertions.
- **Don't mock what you don't own**: mock third-party clients at the boundary; don't mock internal classes that are under test.
- **Test data builders**: repeated fixture construction (`{eventId: 'x', userId: 'y', ...}` × 8 tests) suggests extracting a builder.

### Comments smell

- Comments explain WHY (non-obvious decisions, workarounds, external constraints), not WHAT (the code already says what).
- Dead commented-out code: delete it.
- Section dividers (`// Envelope`, `// Payload`) inside structured types: well-named fields already group themselves; dividers are noise.

## Anti-noise rules — DO NOT FLAG THESE

You will be tempted; resist. If you flag any of the below, the review loses signal and the human stops reading.

1. **"Function is 12 lines long, Uncle Bob says 3-4."** Dogmatic and useless. Flag cohesion problems, not line counts.
2. **"Extract this into a separate use-case / service / pattern."** If there's exactly one call site, YAGNI wins.
3. **"Add JSDoc to public methods."** That's documentation style, not Clean Code.
4. **"Variable `e` should be `error`."** `e` in `.catch(e => ...)` or `onClick={e => ...}` is conventional. Flag `data`, `info`, `temp`, `result`, `obj` — not `e`.
5. **"Magic number 200 ms."** If a comment one line above explains why, it's not magic. Only flag truly unexplained numbers.
6. **"This is duplicated."** Two similar-looking lines are NOT duplication. Three sites of the same multi-line pattern = duplication. Be conservative.
7. **"Speculative generality" on tiny enums.** A `enum { EMBED }` with one value, where the plan explicitly says "v1 scope, will extend in v2", is not over-engineering — it's deliberate.
8. **"Variable naming inconsistency with general convention."** Consistency with the existing codebase wins over generic best practice. If the plan mirrors an existing file's pattern, that's correct, even if Uncle Bob disagrees.
9. **"Add a builder pattern for this 5-field DTO."** Over-engineering.
10. **TypeScript `any` in test mocks** when the mock surface is a single method that returns a Jest mock — fine.
11. **"This DTO duplicates the proto type."** DTOs at REST boundaries SHOULD be separate from wire types — that's intentional layering, not duplication.
12. **Function purity in a NestJS service**: services are dependency-injected and stateful by design; don't demand pure functions in `@Injectable` classes.

## Output format

For each finding, use this structure:

```
[CRITICAL|MAJOR|NIT] <one-line summary>
Location: <plan file path>:<line/section reference>
Snippet: `<excerpt of the offending code>`
Issue: <one or two sentences explaining the substantive problem>
Suggested fix: <concrete change, e.g. "rename `data` to `engagementEvent`" or "extract `{key, value}` pair into `MetadataEntry` value object">
```

Severity definitions:
- **CRITICAL** — real harm at runtime or maintainability cliff (god class, broken SRP that will rot, leaking abstraction, named-after-the-implementation-not-the-domain).
- **MAJOR** — fix before merge (misleading name, missing test concept, primitive obsession on key domain IDs).
- **NIT** — small improvement, optional. Implementer can skip without consequence.

Group findings by severity. List CRITICAL first.

At the end, give exactly one of:

```
VERDICT: APPROVED
```

(no substantive issues — only NITs or nothing)

OR

```
VERDICT: REVISE
```

(CRITICAL or MAJOR findings exist)

{If running round 2 (opt-in via `rounds=2`): include "Previous review feedback that was addressed: <paste round 1 findings>. Verify the revisions are adequate and look for any NEW issues — do not re-flag what was already fixed unless the fix was inadequate."}

Plan to review:
<plan>
{paste the full plan content here}
</plan>
```

### 2. Handle verdict

- **APPROVED**: stop the loop. Record status in the plan file header (see "Recording status" below). Report to the user that the plan passed clean-code review.
- **REVISE**:
    1. Show the user the reviewer's findings (grouped by severity).
    2. Edit the plan file, addressing each CRITICAL and MAJOR. NITs are optional — apply if cheap, skip otherwise.
    3. Show the user a summary of changes.
    4. If running default 1-round mode: stop. Record status as "advisory, 1-round cap hit" (see below). Move on.
    5. If running opt-in 2-round mode: proceed to round 2.

### 3. After the loop ends

Whether APPROVED or REVISE, the skill stops after the configured round limit. Record status in the plan file header. Do NOT block downstream skills (plan-review, executing-plans, etc.) — this skill is advisory.

If the final round still has unresolved CRITICAL findings, surface them prominently to the user so they can decide to:
- Hand-fix and re-run,
- Accept and document in the plan's "Open items",
- Ignore and move on.

## Recording status

After the loop ends (whether by approval, round-2 cap, or no findings), update the plan file's header to record the review result. Insert a line near the top of the file (after the existing `> **For agentic workers:**` block, before the `**Goal:**` line):

```markdown
**Clean-code review:** <status> (<date YYYY-MM-DD>)
```

Where `<status>` is one of:
- `passed (round 1, no findings)` — round 1 returned APPROVED with no findings
- `passed (round 1)` — round 1 APPROVED after acknowledging only NITs
- `passed (round 2)` — only when running opt-in 2-round mode and round 2 APPROVED
- `advisory, 1-round cap hit — N unresolved CRITICAL, M unresolved MAJOR` — default 1-round mode finished with REVISE; user chose not to apply or to opt-in to round 2
- `advisory, 2-round cap hit — N unresolved CRITICAL, M unresolved MAJOR` — opt-in 2-round mode finished with REVISE on round 2

The plan-review skill (run next) does not read or care about this annotation. It's purely a paper trail for human review.

## Non-overlap with other skills

- **`plan-review`** reviews architecture, contracts, missing steps, security, risks. Run AFTER `code-audit/clean-code-review`. Reads code snippets for correctness, not for clean-code compliance.
- **`dual-review`** reviews the actual implementation diff at PR time. Catches issues in real code that a plan cannot show.
- **`code-audit/clean-code-review`** (this skill) is the missing link — it catches design-level smells (naming, SRP, primitive obsession) at the plan stage when they're cheap to fix.

If you find yourself flagging an architectural problem (e.g. "this should be a different service"), defer it to `plan-review` — note it briefly but don't gate this skill's verdict on it.

## Output format (to the user)

After each round, report:

```
## clean-code-review — Round N/<max> — [APPROVED | REVISE]

**Findings:**
<grouped by severity: CRITICAL, MAJOR, NIT — each with location + snippet + suggested fix>

**Changes made:** (if REVISE)
<list of CRITICAL/MAJOR items addressed and how>

<If final round done: "Annotation added to plan header: '<status string>'. Skill complete; proceed to next step (typically plan-review).">
```
