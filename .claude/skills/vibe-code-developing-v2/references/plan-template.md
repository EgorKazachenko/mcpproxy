# The plan template — pre-flight facts before Task 1

`plan.md` is written **into this skeleton**, not checked against it afterwards. That
distinction is the whole point: across ~28 reviewed runs, five consecutive features hit a defect
the rule for which was already written down, already read that session, and still not executed.
An empty table is visible; a remembered rule is not.

Fill every table that applies. A table that does not apply is deleted with one line saying
why ("no server value is spread or mutated — client-only change"). A table left as a stub
is a plan defect, and `plan-lint.mjs` plus the round-1 reviewer both open here.

**Budget.** Pre-flight is facts, not prose. Each table is rows with `file:line`, not
paragraphs. If a section runs longer than the tasks it protects, it is being written wrong.

---

## Header (unchanged from `superpowers:writing-plans`)

Goal / Architecture / Tech Stack / Global Constraints. `Global Constraints` copies the
spec's project-wide values verbatim **and adds the strictness facts** from the
Infrastructure table below — the plan that wrote `noUncheckedIndexedAccess` into its own
constraints and then violated it two pages later is in the log.

---

## Pre-flight

### 1. Write path — for every collection or field the plan reads or writes

| Field / collection | Producer | Every transform between device and document | Drops or merges data? |
|---|---|---|---|
| | `file:line` | `file:line` → `file:line` | yes/no + consequence |

A stored value is **not** raw truth until you have traced who writes it. Treating something
already filtered, normalised or picked-from as if it were the source is a recurring blocker.

### 2. Consumers — for every symbol the plan changes

| Symbol | Reader (`file:line`) | What that reader does with the value | Does the reader's test mock it? |
|---|---|---|---|
| | | quote the consuming line, not the call | yes → CI is blind to a regression here |

`plan-lint --strict-consumers` re-runs `rg` for every symbol in this table and fails on a file
it finds that the table does not name — the definition site and the plan's own `Files:` are
exempt. It cannot tell a real consumer from a same-named local, so it reports rather than
decides: either add the row or name the filter that excludes it.

Three rules this table exists to enforce, all of them recurrences in the log:

- **Paste the grep.** The plan states the pattern it ran and pastes the **full** hit list.
  Discussing a subset requires naming the filter. A partial map reads exactly like a
  complete one, which makes it worse than none.
- **Quote the consumption, not the call.** A change to the return value's *length*,
  *identity* or *shape* is invisible if you only recorded that a call site exists — that is
  how an index-wise change detector three lines below a call was missed.
- **Mark mocked readers.** A consumer whose test `vi.mock`s the module is a consumer whose
  regression CI cannot see. That is why a wrong change there feels safe.

### 3. Infrastructure — one row per package the plan touches

| Package | Test command actually used | `setupFiles` | env forced by setup | app built per worker or per test | tsconfig strictness | ESLint severities that constrain the design |
|---|---|---|---|---|---|---|

Read `package.json` scripts **and** the test-runner config `include` before writing any command —
a package may have no test script of its own and run under a sibling's project. Every
test command in the plan is **verified, not composed**: run it through
`vitest list --filesOnly` and paste the file count next to it. A filter that matches
nothing still exits 0.

And for every **existing** test file the plan names as the home for a new assertion, quote
3–5 lines showing what it boots:

| Test file | Layer | Quoted evidence |
|---|---|---|
| | direct instantiation / `app.inject` / browser | 3–5 lines |

A test one layer below the edit cannot observe what the layer above strips, serialises or
validates away. Naming the wrong home for the one assertion that guards the load-bearing edit is
the single most repeated defect in this log.

### 4. Runtime shape — every value the plan spreads, clones, mutates or re-assigns

| Value | Loader that produced it | Loader's return type | Spread allowed? |
|---|---|---|---|
| | `file:line` | plain object / class instance / proxy | **no** for anything not a plain object |

Spreading a value that is not a plain object silently drops whatever lives on its prototype or
behind a getter — and the plan's own unit test still passes, because the fixture IS an object
literal. A green test over a corrupted write is the worst outcome available, and TypeScript will
not warn you: the type reads as plain.

### 5. Premises — every "because X is true here"

| Premise | The grep that establishes it | Quoted evidence | Every site where it holds | Decision at each site |
|---|---|---|---|---|
| | pasted, not described | `file:line` + the line itself, verbatim | | |

A rule applied at 1 of N qualifying sites is not an exception, it is an inconsistency.
The same table catches categorical sentences: **"every", "all six", "none" is followed by
the enumeration that proves it**, inline. If the enumeration has an exception, the sentence
is scoped, not softened.

**The `Quoted evidence` column is machine-checked.** `plan-lint` reads every table whose
header names a quote column, takes the row's anchor, and compares the backticked text against
the file: absent → FAIL, present elsewhere → FAIL naming the real line, off by ≤3 lines → WARN
with the correction. So an anchor can no longer be *pointed at* — it is pasted, and a
fabricated or drifted one dies before a reviewer reads it.

What that does **not** do is judge whether the quoted line supports the claim. The largest
cause in the log is a real line cited as proof of its own opposite (`hidden: { default: false }`
offered as evidence a draft is `hidden: true`). The linter makes the line real; making it
*support the sentence* is still yours, and it is now visible in the plan to be argued with.

### 6. Ordered parameter — when the rule branches on a date, index, version or threshold

| Parameter value | Output | Branch taken |
|---|---|---|
| D−1 | | |
| D | | |
| D+1 | | |

At least three consecutive values, plus one line per branch stating whether the output is
monotone. A non-monotone branch is justified in one sentence or it is a bug. Validating a
predicate at isolated points instead of along its axis produced both a MAJOR defect and,
one round later, a false invariant describing the fix for it.

### 7. Classifier outputs — when the plan branches on an existing function's return value

| Input in scope | Returned value | Branch taken | Surviving outcome / count |
|---|---|---|---|

One row per case, not prose. Where the branch filters events, state the surviving **count**,
because that is what the test will assert.

### 8. Verified facts this plan is built on

Every claim about **framework / browser / OS / ORM / library** behaviour gets one of:

- a **probe** — the smallest runnable thing that answers it — with its **raw output pasted
  verbatim**, plus one line on what the probe does **not** cover (jsdom has no layout, so a
  jsdom test can never settle geometry); or
- the marker **`ASSUMED`**, which reviewers are told to attack first.

The probe instantiates the plan's **exact** structure, never a reduction of it — probing a
simplification answers a different question, and doing so is how a mechanism survived to
round 9 of a 10-round review. Recipe, evidence tiers and worked examples:
`references/industry-research.md`.

**Three disagreeing reads of one file is the signal to run it, not to read it a fourth time.**
Three consecutive review rounds each read the same Swift and each produced a confident,
anchored, mutually contradictory answer; round 3 falsified rounds 1 and 2, and the mechanism
two tasks and one owner decision rested on turned out not to exist. Diligence was the wrong
instrument. When a plan's safety rests on a universal ("always", "never", "iff"), run the
universal before writing it — one `npx tsx` call is cheaper than one review round.

**A decision question inherits the evidence tier of its weakest premise.** If a premise handed
to the owner is `ASSUMED`, the question says so — he cannot audit what he was never told was
uncertain, and the reversal costs his time twice.

Before writing "considered and rejected" for an architecture a mature ecosystem in the same
problem space uses, **name that ecosystem and give one sentence on why they pay for it**.
If you cannot, you have not looked.

---

## Tasks

Task structure is unchanged (`superpowers:writing-plans`): Files / Interfaces / bite-sized
steps / verification command / commit. On top of that, this repo requires:

- **Snippets obey `CLAUDE.md` verbatim** — zero comments in server snippets including
  tests, WHY-only in client; named const over raw literal.
- **Replacement snippets quote their surroundings** — the lines immediately before and
  after — and account for every local the replaced code defined or used.
- **No unread symbols.** Every symbol a snippet references was read this session. "Reuse the
  existing X" requires quoting X. A symbol named by a *ticket* is a hypothesis: `rg` it
  first.
- **Existence claims are grep-backed.** Never conclude "deleted/moved/replaced" from a miss
  at a path someone else supplied — locate by basename (`git log --all -- '**/<Name>*'`)
  before recording it.
- **Numeric expectations carry their derivation** (`23:01→01:53 = 172 min = 10320 s`), and a
  fixture modelling production data reconciles span versus sum explicitly. One canonical
  fixture, defined once.
- **Numeric bounds are derived from the longest member** of the set they protect, and the
  plan lists every member with its measurement (all five locales, not the one you had).
- **Boundary constants are re-derived when the algorithm's shape changes.** A variable that
  is already in scope is the most dangerous candidate for a boundary.
- **Every new test carries a falsification trace**: "fix absent → execution reaches
  `file:line`, observable is X; fix present → observable is Y." No trace, no test — and
  `plan-lint` fails a task that touches a `*.test.*` file with no line matching `Falsification`.
  The trace names the **asserted expression**, not the intent: a trace written in prose beside
  the task does not fire, and one that pins a value while the assertion reads it positionally
  (`result[1]`) flips with the very mutation it was declared insensitive to.
- **Name the runtime the test executes in.** A component test under a no-op `ResizeObserver`
  asserts against an empty DOM; a date test on CI's UTC runner passed with the bug present
  **and passed its mutation check too**, because the discriminating value was the runner's
  timezone. Ask of every gate: can it fail in the environment it runs in?
- **Component tests render through the app's real wrapper chain**, and the plan names it.
- **Every fallback / degradation branch states how an observer distinguishes it firing from
  the feature being broken.** If they cannot, the plan names the CI test that covers the
  breakage instead.
- **Container re-layouts list every child**, flag bare `<>` fragments (their children are
  the container's children) and mark margins owned by other files.
- **Adopted components record the resolved context value per call site** — what
  `useInSheet()` / the theme / the media query returns *there*, and what renders as a
  result. A prop table is not that.
- **A reused condition states what question it answers there and what question is being
  asked here.** If the two sentences differ, the reuse is wrong.
- **Ownership proof for any step that deletes or overwrites data the plan did not write**,
  plus a test that seeds foreign data and asserts it survives. Absence of a computed value
  is never ownership.
- **Third-party payload fields are classified** enumerated-or-free-text with the type
  declaration cited. Free text from an external system is PII until proven otherwise.

---

## Before submitting to review

1. **Requirement diff.** For each `Rn` in `spec.md`, quote the plan line that implements it.
   Not a tick — the line. A coverage table of ticks stayed green while spec and plan
   contradicted each other.
2. **Run `plan-lint.mjs`** (see below) and fix every FAIL.
3. **Self-check the pre-flight tables against the finished tasks** — every snippet is
   covered by a row.

## After every review round — the revision sweep

Long revision cycles manufacture their own defects; in the 10-round feature this became the
dominant cost, above every design error. Mechanically, after each round:

- `grep` the plan for every identifier you removed or renamed in this revision — revisions
  leave contradicting paragraphs behind, and `executing-plans` copies literally;
- re-read each touched task's `Files:` list against its steps **and** its `git add`;
- confirm no two sections give contradictory instructions;
- when the revision rewrote an algorithm, **run or hand-simulate its test cases** before
  resubmitting. Three of four rounds in one review ended with a reviewer doing arithmetic
  the author could have done first;
- when the mechanism changed, re-read every requirement it implements and ask whether it
  still delivers the outcome — especially the one the feature was requested for.

## The deterministic gate

```bash
node .claude/skills/vibe-code-developing-v2/scripts/plan-lint.mjs docs/vibe-coding/<feature>/
```

Checks, all token-free: every `file:line` anchor resolves and is in range · `Modify`/`Delete`
targets exist (or are created by an earlier task) · `Create` targets do not already exist ·
every backticked repo path resolves · no comments inside code fences · every called symbol
exists in the repo or is defined by the plan (WARN; `--strict-symbols` to fail) · every
`vitest run` filter resolved through `vitest list --filesOnly` with its file count (0 files
is a FAIL) · every `Rn` from `spec.md` appears in `plan.md`.

Seven more, aimed at the causes that dominated the review rounds:

| check | catches | level |
|---|---|---|
| `quote` | a quoted-evidence cell whose text is not at its anchor | FAIL (drift → WARN) |
| `enumerate` | "N call sites / consumers / files" enumerating fewer than N | FAIL |
| `consumers` | a §2 symbol whose `rg` hits include a file the table omits | WARN · `--strict-consumers` |
| `falsification` | a task touching a test file with no falsification trace | FAIL |
| `sweep` | `--sweep[=<ref>]`, two failures: this revision names a file only in prose, reaching no task's `Files:` (FAIL), or the plan is byte-identical to the ref — a revision that did not land (FAIL with an explicit ref, WARN with the default `HEAD`, which cannot tell that from a fresh commit) | FAIL · WARN |
| `stale-base` | the tree is behind its base ref, so a file you read may already be false | FAIL ≥ 25 · WARN 1–24 |
| `exhaustive` | a `Record<T, …>` exhaustive over a type this plan edits, in a file no task lists | WARN |

`stale-base` is the cheapest of these and closes the most expensive shape: a worktree 57
commits behind read `minSdkVersion` as 26 when it was 31, and an owner decision was argued from
a platform limitation that did not exist. Neither read was a fabrication — both were faithful
reads of the wrong tree. `git show origin/main:<path>` is not the remedy: it silently diverges
from the file the linter and the executor actually see. The **25** is derived, not chosen:
`main` takes ~10.8 commits a day (324 over 30 days), so 25 is about two days of drift — well
inside the 57 of the incident, and above a normal day's churn, which is why 1–24 only warns.

Run `--sweep` after **every** review round: revision-manufactured defects are the second
largest cause in the log and the dominant cost of the two longest reviews, and the prose
sweep step was measurably skipped three times.

`--skip-test-commands` makes it sub-second when iterating; run it once without the flag
before review. `--skip-consumer-map` drops the `rg` pass — both `consumers` and `exhaustive`.

**Is the linter itself alive?** `bash scripts/plan-lint-selftest.sh` — a clean fixture that
must stay silent plus one mutant per check that must turn it red. It exists because two of
these checks shipped as no-ops (a quote check that only looked at a syntax no plan uses, a
consumer check whose exemption swallowed every hit), and a green `plan-lint` then meant
nothing.

It is built for a **fresh** plan, whose anchors were read this session. Run against an
already-implemented plan it reports expected noise — `Create` targets now exist and line
numbers have drifted since the code was written. That noise is the point: on a plan awaiting
review, either symptom is a real defect.
