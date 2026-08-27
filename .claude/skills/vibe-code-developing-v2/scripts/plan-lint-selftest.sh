#!/bin/bash
# Is plan-lint itself alive? Every check must be silent on a clean fixture and red on its own
# mutant. A check that stays green under its mutant is a no-op, and a green plan-lint run then
# means nothing — which is exactly how two of these shipped before this file existed.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../.." && pwd)
LINT="$HERE/plan-lint.mjs"
fails=0
BASE=$(cd "$(mktemp -d)" && pwd -P)

# The quote / consumer / exhaustive checks only fire when the files a plan cites actually exist,
# so the fixture carries its OWN tiny repo instead of quoting whatever the real tree happens to
# hold. plan-lint derives REPO_ROOT four levels up from its own path, so copying it into
# $FIXREPO/.claude/skills/vibe-code-developing-v2/scripts makes $FIXREPO the repo it reads.
FIXREPO=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$BASE" "$FIXREPO"' EXIT
mkdir -p "$FIXREPO/.claude/skills/vibe-code-developing-v2/scripts" \
         "$FIXREPO/packages/core/src/warmup" \
         "$FIXREPO/packages/core/src/insights" \
         "$FIXREPO/packages/mcp-server/src"
cp "$HERE/plan-lint.mjs" "$HERE/gates-lib.mjs" "$FIXREPO/.claude/skills/vibe-code-developing-v2/scripts/"

cat > "$FIXREPO/packages/core/src/warmup/rules.ts" <<'SRC'
export interface WarmupDetail { weight: number | null; reps: number }

export function buildWarmupSetDetails(input: {
  top: number;
  steps: number;
}): WarmupDetail[] {
  const details: WarmupDetail[] = [];
  for (let index = 0; index < input.steps; index += 1) {
    details.push({ weight: input.top * ((index + 1) / input.steps), reps: 5 });
  }
  return details;
}

export function collapseEqualWeightRuns(details: WarmupDetail[]): WarmupDetail[] {
  return details.filter((detail, index) => {
    const next = details[index + 1];
    if (next === undefined) return true;
    return detail.weight === null || detail.weight !== next.weight;
  });
}
SRC

cat > "$FIXREPO/packages/core/src/insights/epley.ts" <<'SRC'
export const epleyInverse = (weight: number, target: number): number =>
  Math.round(((target / weight) - 1) * 30);
SRC
printf 'export { epleyInverse } from "./epley.js";
' > "$FIXREPO/packages/core/src/insights/index.ts"
printf 'import { epleyInverse } from "./epley.js";
it("pins the inverse", () => { expect(epleyInverse(100, 120)).toBe(6); });
' > "$FIXREPO/packages/core/src/insights/epley.test.ts"
printf 'import { epleyInverse } from "@mcpproxy/core";
export const repsForLoad = (w: number, t: number) => epleyInverse(w, t);
' > "$FIXREPO/packages/mcp-server/src/weightGrid.ts"
printf 'import { epleyInverse } from "@mcpproxy/core";
export const recommendReps = (w: number, t: number) => epleyInverse(w, t);
' > "$FIXREPO/packages/mcp-server/src/repRecommendation.ts"
printf 'export type SessionKind = "a" | "b";
' > "$FIXREPO/packages/core/src/events.ts"
# Exhaustive over the type Task 2 widens, and NOT in any task's Files: — widening the union breaks
# this file's build, which is the whole point of the [exhaustive] check.
printf 'import type { SessionKind } from "@mcpproxy/core";
export const LABELS: Record<SessionKind, string> = { a: "A", b: "B" };
' > "$FIXREPO/packages/mcp-server/src/sessionLabels.ts"

(
  cd "$FIXREPO" || exit 1
  git init -q
  git config user.email selftest@local
  git config user.name selftest
  git add -A
  git commit -qm base
) >/dev/null 2>&1

build() {
  cat > "$BASE/spec.md" <<'SPEC'
# Spec
- **R1** the thing works.
SPEC
  cat > "$BASE/plan.md" <<'PLAN'
# Plan — self-test fixture

Implements R1.

## Pre-flight

### 2. Consumers — every symbol this plan changes

| Symbol | Reader (`file:line`) | What that reader does | Reader's test mocks it? |
|---|---|---|---|
| `collapseEqualWeightRuns` | `packages/core/src/warmup/rules.ts:15` | drops a detail whose weight equals the next one's | no |
| `epleyInverse` | `packages/core/src/insights/index.ts` | re-export | n/a |
| `epleyInverse` | `packages/core/src/insights/epley.test.ts` | pins the inverse | n/a |
| `epleyInverse` | `packages/mcp-server/src/weightGrid.ts` | derives reps for a load | no |
| `epleyInverse` | `packages/mcp-server/src/repRecommendation.ts` | recommends reps | no |

### 3. Infrastructure

| Test file | Layer | Quoted evidence |
|---|---|---|
| `packages/core/src/warmup/rules.ts:19` | direct call | `return detail.weight === null || detail.weight !== next.weight;` |

### 5. Premises

The rule holds at 3 sites: `packages/core/src/warmup/rules.ts:17`, `:18`, `:19`.

## Task 1 — do the thing

**Files:**
`packages/core/src/warmup/rules.ts`,
`packages/core/src/warmup/rules.test.ts`

Falsification: fix absent → `collapseEqualWeightRuns` keeps the duplicate, observable is length 3; fix present → length 2.

git add packages/core/src/warmup/rules.ts packages/core/src/warmup/rules.test.ts
PLAN
}

quote_was='return detail.weight === null || detail.weight !== next.weight;'
mutate() { build; perl -pi -e "s/\Q$1\E/$2/" "$BASE/plan.md"; }
lint() { node "$FIXREPO/.claude/skills/vibe-code-developing-v2/scripts/plan-lint.mjs" "$BASE/" --skip-test-commands "$@" 2>&1; }

expect() {
  local label="$1" want="$2" pattern="$3"; shift 3
  local out; out=$(lint "$@")
  if grep -q -- "$pattern" <<<"$out"; then
    [ "$want" = red ] && printf '  ✓ %-48s red\n' "$label" \
      || { printf '  ✗ %-48s fired on clean input\n' "$label"; fails=$((fails + 1)); }
  else
    [ "$want" = green ] && printf '  ✓ %-48s silent\n' "$label" \
      || { printf '  ✗ %-48s STAYED GREEN — the check is a no-op\n' "$label"; fails=$((fails + 1)); }
  fi
}

echo "clean fixture — every check silent:"
build
for check in quote enumerate consumers falsification exhaustive; do
  expect "$check" green "\[$check\]" --strict-consumers
done

echo
echo "one mutant per check — each must turn its own check red:"
mutate "$quote_was" 'return detail.weight === NEVER_IN_THIS_FILE;'
expect "quote is fabricated" red 'does not appear in'

mutate "$quote_was" 'export function buildWarmupSetDetails(input: {'
expect "quote is real but at another line" red 'NOT at the cited anchor'

mutate "$quote_was" 'const next = details\[index + 1\];'
expect "anchor drifted by two lines" red 'anchor drifted'

mutate 'holds at 3 sites' 'holds at 9 sites'
expect "count claims more than it enumerates" red 'claims .9 sites'

build && perl -pi -e 's/^Falsification.*$//' "$BASE/plan.md"
expect "test file with no falsification trace" red 'no falsification trace'

build && perl -ni -e 'print unless /repRecommendation/' "$BASE/plan.md"
expect "consumer map drops a real consumer" red 'repRecommendation' --strict-consumers

build && printf '\n## Task 2 — widen a shared union\n\n**Files:** Modify `packages/core/src/events.ts`\n\nSteps:\n- add a member\n\ngit add packages/core/src/events.ts\n' >> "$BASE/plan.md"
expect "exhaustive Record over a widened type" red '\[exhaustive\]'

echo
echo "sweep — a throwaway repo; the real one is never written to:"
SWEEPBOX=$(cd "$(mktemp -d)" && pwd -P)
mkdir -p "$SWEEPBOX/.claude/skills/vibe-code-developing-v2/scripts" "$SWEEPBOX/docs/vibe-coding/probe"
cp "$LINT" "$HERE/gates-lib.mjs" "$SWEEPBOX/.claude/skills/vibe-code-developing-v2/scripts/"
printf '# spec\n- **R1** the thing works.\n' > "$SWEEPBOX/docs/vibe-coding/probe/spec.md"
printf '# Plan\n\nImplements R1.\n\n## Task 1 — do it\n\n**Files:** Modify `docs/vibe-coding/probe/spec.md`\n\nSteps:\n- do it\n\ngit add docs/vibe-coding/probe/spec.md\n' > "$SWEEPBOX/docs/vibe-coding/probe/plan.md"
(
  cd "$SWEEPBOX" || exit 1
  git init -q
  git config user.email selftest@local
  git config user.name selftest
  git add -A
  git commit -qm base
) >/dev/null 2>&1
SWEEP_PLAN="$SWEEPBOX/docs/vibe-coding/probe/plan.md"
sweep() { node "$SWEEPBOX/.claude/skills/vibe-code-developing-v2/scripts/plan-lint.mjs" "$SWEEP_PLAN" --skip-test-commands --skip-consumer-map --sweep 2>&1; }
if grep -q 'byte-identical' <<<"$(sweep)"; then printf '  ✓ %-48s flagged\n' "unchanged plan = a revision that did not land"
else printf '  ✗ %-48s STAYED GREEN — the check is a no-op\n' "unchanged plan = a revision that did not land"; fails=$((fails + 1)); fi
printf '\nThis revision also touches `packages/core/src/warmup/sets.ts`, which no task lists.\n' >> "$SWEEP_PLAN"
if grep -q 'reach no task' <<<"$(sweep)"; then printf '  ✓ %-48s red\n' "prose-only path after a revision"
else printf '  ✗ %-48s STAYED GREEN\n' "prose-only path after a revision"; fails=$((fails + 1)); fi
if grep -q 'byte-identical' <<<"$(sweep)"; then
  printf '  ✗ %-48s fired on a real revision\n' "byte-identical is silent once edited"; fails=$((fails + 1))
else printf '  ✓ %-48s silent\n' "byte-identical is silent once edited"; fi
rm -rf "$SWEEPBOX"

echo
echo "stale-base — a throwaway repo, so the real one is never touched:"
SANDBOX=$(cd "$(mktemp -d)" && pwd -P)
mkdir -p "$SANDBOX/.claude/skills/vibe-code-developing-v2/scripts" "$SANDBOX/docs/vibe-coding/probe"
cp "$LINT" "$HERE/gates-lib.mjs" "$SANDBOX/.claude/skills/vibe-code-developing-v2/scripts/"
printf '# spec\n- **R1** the thing works.\n' > "$SANDBOX/docs/vibe-coding/probe/spec.md"
printf '# Plan\n\nImplements R1.\n\n## Task 1 — do it\n\n**Files:** Modify `docs/vibe-coding/probe/spec.md`\n\nSteps:\n- do it\n\ngit add docs/vibe-coding/probe/spec.md\n' > "$SANDBOX/docs/vibe-coding/probe/plan.md"
(
  cd "$SANDBOX" || exit 1
  git init -q
  git config user.email selftest@local
  git config user.name selftest
  git add -A
  git commit -qm base
  for _ in $(seq 1 30); do git commit -q --allow-empty -m ahead; done
  git update-ref refs/remotes/origin/main HEAD
  git reset -q --hard HEAD~30
) >/dev/null 2>&1
sandbox_lint() { node "$SANDBOX/.claude/skills/vibe-code-developing-v2/scripts/plan-lint.mjs" "$SANDBOX/docs/vibe-coding/probe/" --skip-test-commands --skip-consumer-map 2>&1; }
if grep -qE '✗ \[stale-base\]' <<<"$(sandbox_lint)"; then printf '  ✓ %-48s red\n' "30 commits behind the base ref"
else printf '  ✗ %-48s STAYED GREEN — the check is a no-op\n' "30 commits behind the base ref"; fails=$((fails + 1)); fi
if grep -qE '^[✗!] \[stale-base\]' <<<"$(PLAN_LINT_BASE_REF=HEAD sandbox_lint)"; then
  printf '  ✗ %-48s fired on an up-to-date tree\n' "level with the base ref"; fails=$((fails + 1))
else printf '  ✓ %-48s silent\n' "level with the base ref"; fi
if grep -q 'overridden by PLAN_LINT_BASE_REF' <<<"$(PLAN_LINT_BASE_REF=HEAD sandbox_lint)"; then
  printf '  ✓ %-48s on the record\n' "an overridden base ref is reported"
else printf '  ✗ %-48s INVISIBLE — the gate can be silenced unseen\n' "an overridden base ref is reported"; fails=$((fails + 1)); fi
if grep -q 'does not resolve in this checkout' <<<"$(PLAN_LINT_BASE_REF=no-such-ref-xyz sandbox_lint)"; then
  printf '  ✓ %-48s loud\n' "an unresolvable base ref"
else printf '  ✗ %-48s SILENT — the check vanishes unseen\n' "an unresolvable base ref"; fails=$((fails + 1)); fi
rm -rf "$SANDBOX"

echo
[ "$fails" -eq 0 ] && echo "plan-lint self-test: OK — every check earns its keep" \
  || echo "plan-lint self-test: $fails problem(s)"
exit "$fails"
