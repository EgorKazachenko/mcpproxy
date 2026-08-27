import { HARNESS_PATHS, diffBase, docHash, filesBetween, filesChangedSince, planHash } from './gates-lib.mjs';

const verify = (path, extra = []) => [
  'node', '.claude/skills/vibe-code-developing-v2/scripts/verify-evidence.mjs', '--path', path, ...extra,
];

export const GATES = {
  'plan-approved': {
    argv: ['node', '.claude/skills/vibe-code-developing-v2/scripts/plan-approved-verify.mjs'],
    needsFeature: true,
    needsEvidence: true,
    anchor: 'plan',
    evidence: "the reviewer's verdict report saved under <feature>/.review/plan.md — its last line is VERDICT: APPROVED",
    appliesWhen: (c) => c.track === 'full',
    runsItself: true,
    skill: 'plan-review',
  },
  'build-test': {
    argv: ['node', '.claude/skills/vibe-code-developing-v2/scripts/run-build-test.mjs'],
    needsFeature: true,
    evidence: null,
    appliesWhen: (c) => c.touchesCode,
    runsItself: true,
  },
  'review-internal': {
    argv: ['node', '.claude/skills/vibe-code-developing-v2/scripts/review-verify.mjs', '--kind', 'internal'],
    needsFeature: true,
    anchor: 'review',
    evidence: null,
    appliesWhen: (c) => c.touchesReviewable,
    runsItself: true,
    skill: 'dual-review — the internal Opus reviewer',
  },
  'review-scan': {
    argv: ['node', '.claude/skills/vibe-code-developing-v2/scripts/review-verify.mjs', '--kind', 'scan'],
    needsFeature: true,
    anchor: 'review',
    evidence: null,
    appliesWhen: (c) => c.touchesReviewable,
    runsItself: true,
    skill: 'dual-review — the built-in multi-dimension scan',
  },
  'review-bc': {
    argv: ['node', '.claude/skills/vibe-code-developing-v2/scripts/review-verify.mjs', '--kind', 'backward-compat'],
    needsFeature: true,
    anchor: 'review',
    evidence: null,
    appliesWhen: (c) => c.touchesContract,
    runsItself: true,
    skill: 'dual-review — the backward-compatibility pass',
  },
  'review-tests': {
    argv: ['node', '.claude/skills/vibe-code-developing-v2/scripts/review-verify.mjs', '--kind', 'test-quality'],
    needsFeature: true,
    anchor: 'review',
    evidence: null,
    appliesWhen: (c) => c.touchesTests,
    runsItself: true,
    skill: 'dual-review — the test-quality / anti-flake pass',
  },
  'review-errors': {
    argv: ['node', '.claude/skills/vibe-code-developing-v2/scripts/review-verify.mjs', '--kind', 'error-observability'],
    needsFeature: true,
    evidence: null,
    appliesWhen: (c) => c.touchesCode,
    runsItself: true,
    skill: 'dual-review — the error-handling / observability-coverage pass',
  },
};

export const evidenceArgv = (path) => verify(path);

const isCode = (f) => /^packages\//.test(f);
const isHarness = (f) => HARNESS_PATHS.some((root) => f.startsWith(`${root}/`));

// WHY these and no others: this is a TypeScript monorepo of libraries and a server — there is no
// mobile shell, no cached PWA and no browser e2e suite, so the gates that used to key off those
// surfaces were removed rather than left to match nothing and silently pass.
export function classify(files, { track }) {
  return {
    track: track === 'lite' ? 'lite' : 'full',
    touchesCode: files.some(isCode),
    touchesReviewable: files.some((f) => isCode(f) || isHarness(f)),
    touchesTests: files.some((f) => /\.test\.tsx?$/.test(f)
      || /(^|\/)__tests__\//.test(f)
      || /^packages\/[^/]+\/tests?\//.test(f)),
    // The contract surface: the shared wire/type package, plus anything a sibling package imports
    // across the workspace boundary — a public export here is somebody else's compile error.
    touchesContract: files.some((f) => f.startsWith('packages/contracts/')
      || /^packages\/[^/]+\/src\/index\.ts$/.test(f)),
  };
}

export function requiredGates(files, opts) {
  const context = classify(files, opts);
  return Object.entries(GATES).filter(([, g]) => g.appliesWhen(context)).map(([name]) => name);
}

export function driftState(sha, since, reviewed) {
  if (since === null) return { state: 'unresolvable', sha };
  if (!since.length) return null;
  const unseen = since.filter((file) => !reviewed.includes(file));
  return { state: unseen.length ? 'unseen' : 'drift', sha, files: since, unseen };
}

export function reviewDrift(receipt, run, io = {}) {
  if (!receipt?.headSha) return { state: 'untracked' };
  const changedSince = io.since ?? filesChangedSince;
  const changedBetween = io.between ?? filesBetween;
  const baseOf = io.base ?? diffBase;
  const since = changedSince(receipt.headSha);
  const reviewed = since === null ? [] : changedBetween(baseOf(run), receipt.headSha) ?? [];
  return driftState(String(receipt.headSha).slice(0, 8), since, reviewed);
}

export function staleReason(featureDir, name, receipt, tree) {
  const gate = GATES[name];
  const anchor = gate?.anchor ?? 'code';
  if (anchor === 'review') return null;
  // WHY: this gate checks a DOC against CODE, so it goes stale when either moves. Returning on the
  // doc alone silently dropped the code anchor — a deleted call site kept a green receipt, which is
  // the exact mutation the gate exists to catch.
  if (anchor === 'doc') {
    if (!receipt.docHash) {
      return `the receipt carries no docHash, so it attests to no particular ${gate.anchorDoc} — re-run the gate.`;
    }
    const now = docHash(featureDir, gate.anchorDoc);
    if (!now) return `${featureDir}/${gate.anchorDoc} is now missing or empty, so this receipt covers nothing.`;
    if (receipt.docHash !== now) {
      return `${gate.anchorDoc} was rewritten after this gate ran (receipt ${receipt.docHash.slice(0, 8)}, now ${now.slice(0, 8)}). The receipt attests to the old text — re-run it.`;
    }
    return receipt.codeTree === tree
      ? null
      : `the code changed after this gate ran (receipt ${String(receipt.codeTree).slice(0, 8)}, now ${tree.slice(0, 8)}). The plan is verified against the code, so both anchors matter. Re-run it.`;
  }
  if (anchor === 'code') {
    return receipt.codeTree === tree
      ? null
      : `the code changed after this gate ran (receipt ${String(receipt.codeTree).slice(0, 8)}, now ${tree.slice(0, 8)}). Re-run it.`;
  }
  if (!receipt.planHash) {
    return 'the receipt carries no planHash, so it attests to no particular plan — re-run the gate.';
  }
  const now = planHash(featureDir);
  if (!now) return `${featureDir}/plan.md is now missing or empty, so nothing is left for this approval to cover.`;
  return receipt.planHash === now
    ? null
    : `plan.md was rewritten after it was approved (receipt ${receipt.planHash.slice(0, 8)}, now ${now.slice(0, 8)}). The approval covers the old text — review the plan again.`;
}
