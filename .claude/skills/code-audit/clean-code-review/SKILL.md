---
name: clean-code-review
description: Clean-code review of REAL code on a branch / PR / staged diff. Self-hosted Opus pass focused on Uncle Bob's Clean Code + selected Fowler smells + SOLID (SRP-heavy), with project-wide anti-noise rules. Advisory, never blocks. Runs 1 review-revise cycle by default; the sibling skill `plan-review/clean-plan-review` does the same lens at plan time. Use when the user wants to stress-test code-quality of changed code BEFORE pushing (or before / after PR-time review).
---

You are running a clean-code review of real implementation code (a diff, a branch, or a PR). Your job is to send the changed code to a reviewer agent (forked Claude with Opus), collect feedback, and present findings to the user — **1 round by default**, **non-blocking, report-only**.

The user decides what to fix. This skill does **not** auto-fix and does **not** block any downstream skill (`dual-review`, `superpowers:requesting-code-review`, merge, etc.). It complements them with a fast self-hosted Opus pass tuned to Uncle Bob / Fowler / SRP.

**Opt-in for 2 rounds:** if `$ARGUMENTS` includes `rounds=2`, run a second round after the user applies round 1's fixes. Rare — token cost rarely pays off twice on the same diff.

## Input

`$ARGUMENTS` is a target spec. Recognised forms (mutually exclusive):

| Form | Diff source |
|---|---|
| `pr=<N>` | `gh pr diff <N>` |
| `branch=<ref>` | `git diff $(git merge-base main <ref>)..<ref>` |
| `staged` | `git diff --cached` |
| `head` | `git diff main..HEAD` |
| _omitted_ | default to `head` (`git diff main..HEAD`) |

Optional flags appended with `&`:

| Flag | Effect |
|---|---|
| `rounds=2` | run a second review round after user applies fixes from round 1 |
| `post=true` | after the final round, post a sanitised summary as a PR comment via `gh pr comment` (only meaningful with `pr=<N>`) |

Examples: `clean-code-review pr=137`, `clean-code-review branch=feat/X&rounds=2`, `clean-code-review staged`, `clean-code-review pr=137&post=true`.

If `$ARGUMENTS` is empty: default to `head`. If `git diff main..HEAD` is empty, ask the user which target they meant (don't review a no-op).

Before invoking the reviewer agent, capture the actual diff into a variable so the prompt is reproducible:

```bash
DIFF=$(gh pr diff 137)                         # pr=N
DIFF=$(git diff $(git merge-base main feat/X)..feat/X)   # branch=feat/X
DIFF=$(git diff --cached)                      # staged
DIFF=$(git diff main..HEAD)                    # head / default
```

If the diff is enormous (>2_000 changed lines), warn the user — Opus will still read it, but a too-broad pass dilutes signal. Suggest narrowing (`pr=<N>` or a specific path filter).

## Scope

This skill reviews **real code in the diff** — function signatures, naming, structure, type usage, test shape — through a Clean Code lens. It does NOT:

- review architecture, contracts, or wire formats (`plan-review` does that at plan time);
- review the plan itself (`plan-review/clean-plan-review` does that at plan time);
- guarantee security or correctness coverage (`security-review`, `code-review:code-review`, `dual-review` cover those angles);
- auto-fix anything (the user decides).

Run it whenever you've made meaningful code changes and want a quick clean-code signal — typically:

- **Before pushing** a branch for the first time (catch smells before they're on a public PR).
- **After applying** a review batch (manual fixes) — sanity-check you didn't regress design quality.
- **At pre-commit** (`staged`) — light pass on what you're about to commit.

## Process

Default is **1 round**. If `$ARGUMENTS` includes `rounds=2`, do 2.

### 1. Send to reviewer

Use the Task tool with:
- `subagent_type: "general-purpose"`
- `model: "opus"`
- `description: "Clean-code review round N"` (where N is current round)
- `prompt`: the FULL prompt below, with the diff interpolated and the project's CLAUDE.md path provided

```
You are a strict but pragmatic clean-code reviewer. Your job is to find substantive code-quality problems in the diff below. Apply Uncle Bob's Clean Code, selected Fowler refactoring smells, and SOLID (with SRP-heavy emphasis). DO NOT NIT.

Read CLAUDE.md at the project root before reviewing. The existing-codebase patterns it documents take precedence over Clean Code doctrine. Consistency with the existing codebase wins over dogma. The project also has hard rules (no comments in server code, named const over raw literal, RORO for 4+ args, OOP over functional, ResponsiveDialog over bare MUI Dialog, etc.) — flag violations of those FIRST, before any general clean-code lens.

## What to look for

### Function- and class-level smells

- **Naming**: intention-revealing names, no god-names (`data`, `info`, `manager`, `util`, `handler` without context), no abbreviations, no Hungarian notation.
- **Single Responsibility (SRP)**: each class/function has one reason to change. If you'd describe its job using "and", it likely does too much.
- **Function cohesion**: function size is pragmatic — a 30-line cohesive function is fine; a 10-line function with mixed levels of abstraction is not.
- **Side effects**: a function does one thing; no hidden state mutation, no "looks like a getter but writes to disk".
- **Command-Query Separation (CQS)**: a function either changes state OR returns information, not both.
- **Boolean arguments**: usually a smell that the function does two things — split into two named functions.
- **Long parameter list (>3 positional args)**: usually a missing concept — the project's RORO rule already mandates an object for 4+ args; flag any new violation.
- **Output arguments**: avoid mutating arguments in place — confusing and hides the change.

### Code smells (Fowler, complements Clean Code)

- **Primitive obsession**: using `string` for everything when a named domain type would prevent mix-ups. Especially relevant when multiple ID types coexist (`sessionId: string`, `serverId: string`).
- **Data clumps**: the same 3+ fields appear together in many function signatures — extract a value object.
- **Feature envy**: a method of class A mostly works with data of class B — the method belongs on B.
- **Speculative generality**: an abstraction / extension point for a use case that doesn't exist yet (YAGNI violation). The project's CLAUDE.md "No speculative abstraction" rule already covers this — cite it directly when flagging.
- **Switch on type / `instanceof` chain**: often a hidden polymorphism opportunity (only when it actually is one).

### Project-specific anti-patterns (cite the relevant `CLAUDE.md` when flagging)

- **Raw literal where a named const exists** — a string or number written inline where the
  workspace already exports the named constant for it.
- **A type or schema redefined locally** instead of imported from `@mcpproxy/contracts` — the
  cross-package source of truth. Two definitions of one wire shape drift silently.
- **A package reaching into a sibling's `src/` internals** instead of its public entry.
- **WHAT-comments** — comments are WHY-only. Flag any comment that explains what the code does
  instead of why it does it.
- **A swallowed error on the policy or audit path** — this is a security proxy; a `catch` that
  neither surfaces nor records turns a failure into an unrecorded decision.

### Dependency direction / layering

- **Domain ← Framework leak**: domain types should not import framework decorators or transport/persistence-specific types where the project's layering keeps them separated. Flag if a service starts pulling transport or storage types into its public signature.
- **Controller calls `reply.send()`**: CLAUDE.md "Controller never calls `reply.send()` — it returns data". Flag.
- **Admin route added to a feature module** instead of the admin module: CLAUDE.md "Admin endpoints rule". Flag.

### TypeScript-specific

- **`any` usage**: each occurrence needs justification (third-party type gap, test mock, intentional escape hatch).
- **Type assertion (`as Foo`)** vs proper typing: assertion bypasses the type system; use only when you know more than TS.
- **Optional chaining (`?.`) that hides null bugs**: sometimes asserting non-null (or failing loudly) is better than silently producing `undefined`.

### Tests as first-class

- **Test names as specifications**: `it('returns 404 when asset is not found')` good; `it('test1')`, `it('works')` bad.
- **One concept per test**: AAA with one logical assertion-group, not 10 unrelated assertions.
- **Don't mock what you don't own**: mock third-party clients at the boundary; don't mock internal classes that are under test.
- **Test data builders**: repeated fixture construction (`{eventId: 'x', userId: 'y', ...}` × 8 tests) suggests extracting a builder.

### Comments smell

- Server: ZERO comments — anywhere, any kind. Project rule.
- Client: WHY only; flag any WHAT-comment.
- Dead commented-out code: delete.
- Section dividers (`// Envelope`, `// Payload`) inside structured types: well-named fields already group themselves; dividers are noise.

## Anti-noise rules — DO NOT FLAG THESE

You will be tempted; resist. If you flag any of the below, the review loses signal and the human stops reading.

1. **"Function is 12 lines long, Uncle Bob says 3-4."** Dogmatic and useless. Flag cohesion problems, not line counts.
2. **"Extract this into a separate use-case / service / pattern."** If there's exactly one call site, YAGNI wins.
3. **"Add JSDoc to public methods."** Server has a NO-COMMENT rule. Don't propose adding any.
4. **"Variable `e` should be `error`."** `e` in `.catch(e => ...)` or `onClick={e => ...}` is conventional. Flag `data`, `info`, `temp`, `result`, `obj` — not `e`.
5. **"Magic number 200 ms."** If a comment one line above explains why, it's not magic. Only flag truly unexplained numbers.
6. **"This is duplicated."** Two similar-looking lines are NOT duplication. Three sites of the same multi-line pattern = duplication. Be conservative — the project's "Rule of two" lives in CLAUDE.md and applies on the SECOND concrete copy, not on visual similarity.
7. **"Speculative generality" on tiny enums.** A `enum { EMBED }` with one value, where the surrounding code explicitly scopes to v1, is not over-engineering.
8. **"Variable naming inconsistency with general convention."** Consistency with the existing codebase wins over generic best practice. If the diff mirrors an existing file's pattern, that's correct.
9. **"Add a builder pattern for this 5-field DTO."** Over-engineering.
10. **TypeScript `any` in test mocks** when the mock surface is a single method that returns a Vitest/Jest mock — fine.
11. **"This DTO duplicates the wire type."** Types at a boundary SHOULD be separate from wire types — that's intentional layering.
12. **Service-level "purity" critique**: where the project's services are DI-instantiated and stateful by design, don't demand pure functions inside them.
13. **Repeated `import` lines, repeated test-setup `beforeEach`.** Standard boilerplate. Not duplication.

## Output format

For each finding, use this structure:

```
[CRITICAL|MAJOR|NIT] <one-line summary>
Location: <file>:<line>  (or path:line-range)
Snippet: `<excerpt of the offending code>`
Issue: <one or two sentences explaining the substantive problem>
Suggested fix: <concrete change, e.g. "rename `data` to `engagementEvent`" or "extract `{key, value}` pair into `MetadataEntry` value object">
```

Severity definitions (recalibrated for real code, not plan snippets):
- **CRITICAL** — merge-blocker on this diff. Bug, leaked private state, broken project rule (named const, no-comment, ResponsiveDialog, etc.), god class, broken SRP that will rot.
- **MAJOR** — fix before merge if possible. Misleading name, missing test concept, primitive obsession on key domain IDs, missed CLAUDE.md guidance that doesn't break anything but degrades the codebase.
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

{If running round 2 (opt-in via `rounds=2`): include "Previous round findings that were addressed: <paste round 1 findings>. Verify the revisions are adequate and look for NEW issues — do not re-flag what was already fixed unless the fix was inadequate."}

Diff to review:
<diff>
{paste the full diff content here}
</diff>
```

### 2. Handle verdict

- **APPROVED**: stop the loop. Report to the user that the diff passed clean-code review.
- **REVISE**:
    1. Show the user the reviewer's findings (grouped by severity).
    2. Do NOT auto-edit any file. Present each finding with the location + suggested fix; the user (or you, in a separate follow-up turn after explicit confirmation) applies them.
    3. If running default 1-round mode: stop after presenting findings. Move on.
    4. If running opt-in 2-round mode: wait for the user to apply round 1's fixes, then proceed to round 2 with the updated diff.

### 3. Optional PR-comment post

If `$ARGUMENTS` includes `post=true` AND the target form is `pr=<N>`, after the final round post a single consolidated comment to the PR:

```bash
gh pr comment <N> --body "$(cat <<'EOF'
## Clean-code review (self-hosted Opus pass)

**Round:** <N>/<max>  ·  **Verdict:** APPROVED|REVISE  ·  Threshold: CRITICAL+MAJOR (NITs not posted)

<findings sections — CRITICAL first, then MAJOR; one block per finding using the format above>

_Note: this is an advisory clean-code pass focused on Uncle Bob / Fowler / SRP, separate from the pre-merge gate and from any architectural review. The user decides what to fix._
EOF
)"
```

**Default is no post** — findings stay in your conversation. Posting is opt-in because a clean-code pass that posts on every run noisies up the PR thread.

If `post=true` is set but the target isn't `pr=<N>` (e.g. `staged`, `head`, `branch=...`), warn the user that posting is skipped and findings stay local.

## Non-overlap with other skills

- **`plan-review/clean-plan-review`** — same lens, applied to plan-file code snippets BEFORE implementation. Pre-implementation.
- **`code-review:code-review`** — broad PR review (security, correctness, style). Not focused on clean-code specifically.
- **`superpowers:requesting-code-review`** — generic Opus review pass with broader scope (covers correctness, coverage, plan adherence). Use it for "is this work done?" gates; use `code-audit/clean-code-review` for "is this code well-written?".
- **`simplify`** — local refactor pass that BOTH reviews AND fixes for reuse/quality/efficiency. Use it when you've already decided to refactor. Use `code-audit/clean-code-review` when you want a signal first, without the auto-fix.
- **`vercel:react-best-practices`** — narrow TSX-specific checklist (hooks, accessibility, performance). Complementary; not duplicative.

If you find yourself flagging an architectural problem (e.g. "this should be a different service") or a security/correctness bug, defer it to the appropriate skill — note it briefly but don't gate this skill's verdict on it.

## Common mistakes

- **Running this when the diff is empty.** Default `head` against `main` on a freshly-pulled branch is empty. Ask the user which target they meant before invoking the agent.
- **Reviewing a diff > 2000 lines.** Signal-to-noise drops sharply. Suggest narrowing.
- **Posting on every run.** Default is conversation-only. Use `post=true` only when the PR thread genuinely benefits.
- **Treating verdict REVISE as a merge-block.** This skill is advisory — `dual-review` (Phase 4 of `vibe-code-developing-v2`) is the merge gate. A REVISE here means "consider these"; the user decides.
- **Re-running after applying fixes without `rounds=2`.** If the user wants a second pass, they can re-invoke the skill — but a second pass on the same diff often surfaces the same general-purpose nits and rarely justifies the token cost. Encourage one round + selective fixes.

## Verification before reporting "done"

- [ ] Diff captured into a variable so the prompt is reproducible
- [ ] Reviewer agent invoked with Opus + the full diff + a pointer to project CLAUDE.md
- [ ] Findings grouped by severity (CRITICAL → MAJOR → NIT)
- [ ] Verdict line present (`APPROVED` or `REVISE`)
- [ ] If `post=true` AND target is `pr=<N>`: comment posted, URL returned to user
- [ ] No file edited by this skill (report-only)
