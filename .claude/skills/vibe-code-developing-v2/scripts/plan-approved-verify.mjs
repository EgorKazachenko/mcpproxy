import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { planHash, planPath, repoRoot } from './gates-lib.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const die = (...lines) => {
  for (const line of lines) console.error(line);
  process.exit(1);
};

const featureDir = arg('feature') ?? process.env.VIBE_FEATURE;
const evidence = arg('evidence');

if (!featureDir) die('plan-approved-verify: --feature is required');
if (!evidence) {
  die(
    'plan-approved-verify: --evidence <the reviewer verdict file> is required.',
    '  Save the plan-review report and hand it over:',
    `    gate-run.mjs run plan-approved --feature ${featureDir} --evidence ${featureDir}/.review/plan.md`,
  );
}

const root = repoRoot();
const plan = join(root, planPath(featureDir));
if (!existsSync(plan)) {
  die(`plan-approved-verify: ${planPath(featureDir)} does not exist — write the plan first.`);
}
if (readFileSync(plan, 'utf8').trim().length === 0) {
  die(`plan-approved-verify: ${planPath(featureDir)} is empty — there is nothing to approve.`);
}

const asked = resolve(root, String(evidence));
if (!existsSync(asked) || statSync(asked).isDirectory()) {
  die(`plan-approved-verify: ${evidence} is not a file — pass the reviewer's verdict report.`);
}
const verdictPath = realpathSync(asked);
if (verdictPath === realpathSync(plan)) {
  die('plan-approved-verify: plan.md cannot be its own review verdict.');
}

const inBundle = relative(realpathSync(join(root, featureDir)), verdictPath);
if (!inBundle || inBundle.startsWith('..') || isAbsolute(inBundle)) {
  die(
    `plan-approved-verify: ${evidence} resolves outside ${featureDir}.`,
    `  The verdict lives in the bundle it approves. Canonical location:`,
    `    ${featureDir}/.review/plan.md`,
  );
}

const body = readFileSync(verdictPath, 'utf8');
const hash = planHash(featureDir);
const passed = arg('plan-hash');
if (passed && passed !== hash) {
  die(
    `plan-approved-verify: the caller says plan.md is ${passed}, this process reads ${hash}.`,
    '  plan.md changed while the gate was running. Nothing can be concluded about which text',
    '  the verdict covers — commit the plan you mean and run the gate again.',
  );
}
const shape = [
  `  The report must END with these two lines, in this order and nothing after them:`,
  `    PLAN: ${hash}`,
  '    VERDICT: APPROVED',
  '  Position, not presence: a report quotes earlier rounds and quotes this contract, so a',
  '  VERDICT anywhere but the end is somebody else\'s verdict being read as this one.',
];

const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
const verdictLine = lines.at(-1) ?? '';
const planLine = lines.at(-2) ?? '';

if (!/^VERDICT:\s+APPROVED$/.test(verdictLine)) {
  const withdrawn = /^VERDICT:\s+(\S+)$/.exec(verdictLine)?.[1];
  die(
    `plan-approved-verify: ${evidence} carries no approval.`,
    ...shape,
    withdrawn === 'REVISE'
      ? '  Its last line is a verdict of REVISE. A plan told to revise is not approved: revise it'
        + ' and review it again.'
      : `  Its last non-empty line is: ${verdictLine.slice(0, 120) || '(the file is empty)'}`
        + (body.includes('VERDICT: APPROVED')
          ? '\n  An approval IS in the file, just not as its last line — move it there undecorated,'
            + ' with the PLAN: line above it.'
          : '\n  That is not the literal the verdict must be. Do not paraphrase or decorate it.'),
  );
}

const claimed = /^PLAN:\s+([0-9a-f]{40})$/.exec(planLine)?.[1];
if (claimed !== hash) {
  die(
    `plan-approved-verify: ${evidence} does not name the plan it approves.`,
    ...shape,
    claimed
      ? `  It names ${claimed}, which is a different text — if plan.md moved on since the review,`
        + ' the review is stale by definition. Review the new text; do not re-point the old verdict.'
      : `  The line before its verdict is: ${planLine.slice(0, 120) || '(nothing)'}`,
  );
}

console.log(`plan-approved-verify: ${evidence} approves plan.md @ ${hash}`);
