# Reviewers — how a review becomes a receipt

A review gate is satisfied by **evidence**, never by an assertion.

## Spawn subagents — and judge them by their findings file

Reviewers are **ordinary subagents**. Spawn them with `Agent`; the standing "do not call the
AgentTool unless the user requested it" instruction is answered by `SKILL.md` — invoking this
workflow IS the request — so it discourages nothing here.

**This file used to prescribe out-of-process reviewers (`claude -p …`). That is retired.** It was
written to route around that same instruction, and it never once ran: `cost.mjs` classifies
reviewer processes by their session header and reports zero across every measured run, while the
transcripts show hundreds of reviewer subagents spawning normally. A headless process nobody
steers was a real cost paid for a problem an explicit authorization solves for free.

What survives from it is the part that was always load-bearing: **judge the gate by the findings
file plus its anchor, never by whether a Task call appeared.** A subagent's final message reaches
the parent unreliably, so every reviewer writes its findings to disk FIRST and the receipt reads
that file — see `dual-review`'s file-first rule.

## Which model each dimension gets, and why it is not all Opus

Pass `model` on the `Agent` call. **Effort is the catch: a subagent inherits the parent's effort,
and a same-effort Sonnet costs what Opus costs** — so `model: sonnet` alone buys much less than the
ratios below suggest. Per-reviewer effort needs an agent definition (`.claude/agents/<name>.md`
frontmatter), and **this repo has none today** — so treat the split below as the target shape and
`cost.mjs --record` as the only proof it paid.

- **`review-tests` · `review-scan` · `review-errors` → sonnet · medium.** Checklist
  work against a catalog and a fixed question list; ~0.81× Opus at this effort.
- **`review-internal` · `review-bc` → opus · high.** Open-ended judgement, and a missed BC break
  reaches an existing install — the one place the premium buys something.

Re-measure with `cost.mjs` before widening this: the saving is a claim until a run shows it.

**v2 overrides `code-audit/clean-code-review` on one point**, so a reader of that skill is not
misled: keep its findings in `<feature>/.review/clean-code.md` rather than the conversation.

## Every reviewer's opening two commands

```
git rev-parse HEAD
git status
```

Anchor every finding to that commit — an unanchored finding cannot be verified later.

## The findings file is the product

Write `docs/vibe-coding/<feature>/review.md`. It must contain the current `codeTree` hash —
`review-verify.mjs` refuses the gate without it, which is what stops a hand-written file from
passing as a review.

## Severity vocabulary — including permission to say "not blocking"

`CRITICAL` · `MAJOR` · `MINOR` · **`VALID-NOT-BLOCKING`**

Reviewer agents always return something. Without a way to say "true but not worth stopping for", an
adversarial gate becomes a permanent red light — and a permanent red light gets overridden.

## Post nothing to GitHub

Measured over 20 merged PRs: 116 of 116 comments were agent-authored with zero human replies, and
one merged three minutes after 51 562 characters landed. Full reviewer output goes to
`~/.claude/harness-logs/review/<feature>/` — **not** into `.gates/`, which the guard forbids
writing to by hand; `--evidence` points the gate at that folder, and the resolution table goes to
`review.md`. **At most one** GitHub comment, ≤1 200 chars, and only when something is left for the
owner — so silence carries meaning.

## Each dimension is its own gate, and each writes its own file

Five derived review gates, all `dual-review` dimensions — `review-internal`, `review-scan`,
`review-bc`, `review-tests`, `review-errors`. Each requires a findings file at
`<feature>/.review/<dimension>.md`, anchored to the current `codeTree`.

A dimension that genuinely does not apply still needs a file, whose FIRST line is `N/A — <reason>`.
**Absent and not-applicable must be distinguishable**: on the first real run three of the
dimensions never ran while `ship-lint` showed `review ✓`, because the single gate read a summary
the model had written about itself.

**This also breaks the chicken-and-egg with the PR.** `dual-review` wants a PR to post to, and the
guard will not open one while a review gate is unsatisfied. Run the dimensions BEFORE the PR and
write their files locally — the gate wants the findings, not a comment. Resolution comments, if
any, come after.

## v2 overrides `dual-review` on where findings go

`dual-review`'s own SKILL.md says to pass `--comment` so its reviewers post inline to the PR.
**Under `/vibe-code-developing-v2` that is overridden:** run its reviewers, use its lenses, post
nothing. Without this paragraph an agent reading both skills gets opposite instructions.

