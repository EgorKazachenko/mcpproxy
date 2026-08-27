import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  CODE_PATHS, HARNESS_PATHS, anchors, changedFiles, codeDirty, diffBase, codeTree, currentBranch, detachedHead, gatesDir, git, guardAnswer,
  logEvent, manifest, planHash, readJson, readRun, repoRoot, writeJson,
} from './gates-lib.mjs';
import { GATES, driftState, requiredGates, reviewDrift, staleReason } from './gates-registry.mjs';

const PR_BODY_LIMIT = 1500;

const results = [];
const fail = (check, message) => results.push({ level: 'FAIL', check, message });
const warn = (check, message) => results.push({ level: 'WARN', check, message });

function findFeatureDir(explicit, { quiet } = {}) {
  if (explicit) return explicit;
  const root = repoRoot();
  const base = join(root, 'docs', 'vibe-coding');
  if (!existsSync(base)) return null;
  const branch = currentBranch();
  const found = readdirSync(base).sort()
    .map((entry) => join('docs', 'vibe-coding', entry))
    .filter((rel) => {
      const run = readJson(join(root, rel, '.gates', 'run.json'));
      return run && !run.closed && run.branch === branch;
    });
  if (found.length > 1) {
    if (quiet) return null;
    console.log(`✗ [run] ${found.length} bundles claim this branch (${found.join(', ')}).`);
    console.log('        ONE BRANCH, ONE PLAN. The gh pr create');
    console.log('        hook calls ship-lint without --feature, so with two it cannot pick either.');
    console.log('        Merge the work into one bundle\'s plan.md and delete the other run.json.');
    process.exit(1);
  }
  return found[0] ?? null;
}

const listed = (files) => {
  const shown = files.slice(0, 5).join(', ');
  return `${shown}${files.length > 5 ? `, +${files.length - 5} more` : ''}`;
};

function reportDrift(name, drift) {
  if (!drift) return;
  if (drift.state === 'untracked') {
    warn(name, 'the receipt predates drift tracking (no headSha), so nothing here can say what it reviewed'
      + ' — re-run this dimension, or waive it with a reason.');
    return;
  }
  if (drift.state === 'unresolvable') {
    warn(name, `its anchor ${drift.sha} is unreachable — rebased, amended or squashed away, so the drift cannot be computed.`
      + ' Re-run this dimension, or waive it with a reason.');
    return;
  }
  if (drift.state === 'unseen') {
    fail(name, `reviewed at ${drift.sha}, and ${drift.unseen.length} file(s) it never saw have landed since: ${listed(drift.unseen)}.`
      + ' Re-run this dimension, or record the owner\'s decision with gate-run waive --reason.');
    return;
  }
  warn(name, `reviewed at ${drift.sha}; ${drift.files.length} already-reviewed file(s) changed since: ${listed(drift.files)}.`
    + ' Name this in the report and let the owner decide whether a re-run is worth it.');
}

function checkReceipt(featureDir, name, tree, { ci, driftIo }) {
  const receipt = readJson(join(gatesDir(featureDir), `${name}.json`));
  if (!receipt) { fail(name, `no receipt — this gate has not run. Run it with: gate-run.mjs run ${name} --feature <dir>`); return; }
  if (receipt.status === 'waived') {
    if (!receipt.reason) fail(name, 'waived without a reason');
    else warn(name, `WAIVED: ${receipt.reason}`);
    return;
  }
  if (receipt.status !== 'pass') { fail(name, `status is "${receipt.status}" (exit ${receipt.exit_code})`); return; }
  const stale = staleReason(featureDir, name, receipt, tree);
  if (stale) { fail(name, `stale — ${stale}`); return; }
  if (GATES[name]?.anchor === 'review') reportDrift(name, reviewDrift(receipt, readRun(featureDir), driftIo));
  if (GATES[name]?.anchor === 'plan') {
    if (receipt.planDirty !== false) {
      fail(name, receipt.planDirty
        ? 'ran against an uncommitted plan.md, so CI would read a different plan than the one approved — commit it, then re-run this gate'
        : 'carries no planDirty, so it cannot say whether the plan it approved was ever committed — re-run the gate');
      return;
    }
  } else if (receipt.codeDirty) {
    fail(name, 'ran while the code tree had uncommitted changes, so it proves nothing — commit, then re-run it');
    return;
  }
  const declared = receipt.artifacts ?? [];
  if (declared.length === 0) return;
  if (ci) return;
  const missing = declared.filter((a) => !existsSync(resolve(repoRoot(), a.path)));
  // WHY: any-missing, not all-missing — a half-deleted evidence folder is exactly the teardown
  // accident an evidence folder exists to survive, and one surviving artifact must not pass forty.
  if (missing.length) {
    fail(name, `${missing.length}/${declared.length} declared artifacts are missing on disk: ${missing.slice(0, 3).map((a) => a.path).join(', ')}${missing.length > 3 ? ', …' : ''}`);
  }
}

function prBodyLength(featureDir) {
  const path = join(repoRoot(), featureDir, 'pr-body.md');
  if (!existsSync(path)) return;
  const size = readFileSync(path, 'utf8').length;
  if (size > PR_BODY_LIMIT) fail('pr-body', `${size} chars exceeds the ${PR_BODY_LIMIT} limit`);
}

async function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'gates-selftest-'));
  const tree = codeTree();
  const gatesPath = join(dir, '.gates');
  mkdirSync(gatesPath, { recursive: true });
  writeFileSync(join(gatesPath, 'good.json'), JSON.stringify({ gate: 'good', status: 'pass', codeTree: tree, codeDirty: false, artifacts: [] }));
  writeFileSync(join(gatesPath, 'stale.json'), JSON.stringify({ gate: 'stale', status: 'pass', codeTree: 'deadbeef', codeDirty: false, artifacts: [] }));

  const before = results.length;
  const load = (name) => readJson(join(gatesPath, `${name}.json`));
  const mustPass = load('good');
  const mustFail = load('stale');

  const feature = relative(repoRoot(), dir);
  writeFileSync(join(dir, 'plan.md'), 'a plan the self-test owns\n');
  const thisPlan = planHash(feature);
  const planReceipt = (over) => ({ ...mustPass, planHash: thisPlan, planDirty: false, ...over });

  const fixtures = [
    ['a fresh code-anchored receipt', 'build-test', mustPass, false],
    ['a receipt from an older tree', 'build-test', mustFail, true],
    ['a plan receipt with no planHash', 'plan-approved', planReceipt({ planHash: null }), true],
    ['a plan receipt naming another plan', 'plan-approved', planReceipt({ planHash: 'deadbeef' }), true],
    ['a plan receipt naming this plan', 'plan-approved', planReceipt(), false],
    ['a review receipt from an older tree', 'review-internal', mustFail, false],
  ];

  let broken = false;
  for (const [label, gate, receipt, shouldReject] of fixtures) {
    const rejected = Boolean(staleReason(feature, gate, receipt, tree));
    if (rejected !== shouldReject) {
      console.error(`self-test: ${label} was ${rejected ? 'rejected' : 'accepted'} — staleReason no longer enforces the ${gate === 'plan-approved' ? 'plan' : 'code'} anchor`);
      broken = true;
    }
  }

  const outsideDir = mkdtempSync(join(tmpdir(), 'gates-evidence-'));
  const outsideFile = join(outsideDir, 'verdict.json');
  writeFileSync(outsideFile, '{"verdict":"PASS"}');
  const insideFile = join(dir, 'plan.md');
  for (const [label, source] of [['outside the repo', outsideDir], ['inside the repo', insideFile]]) {
    const [entry] = manifest([source], 0);
    if (!entry) {
      console.error(`self-test: manifest() recorded nothing for evidence ${label} — the artifact list a gate receipt attests to is empty`);
      broken = true;
      continue;
    }
    if (!existsSync(resolve(repoRoot(), entry.path))) {
      console.error(`self-test: an artifact ${label} was recorded as "${entry.path}", which does not resolve back to a file`
        + ' — ship-lint would report the evidence missing and deny a PR whose evidence is on disk');
      broken = true;
    }
  }

  const stateProbes = [
    ['a file the review never saw', ['a.ts', 'b.ts'], ['a.ts'], 'unseen'],
    ['only already-reviewed files', ['a.ts'], ['a.ts', 'b.ts'], 'drift'],
    ['nothing changed since', [], ['a.ts'], null],
    ['an anchor git cannot resolve', null, [], 'unresolvable'],
  ];
  for (const [label, since, reviewed, expected] of stateProbes) {
    const got = driftState('abcdef12', since, reviewed)?.state ?? null;
    if (got !== expected) {
      console.error(`self-test: ${label} classified as ${got ?? 'no drift'}, expected ${expected ?? 'no drift'}`
        + ' — the review anchor no longer tells drift the owner must decide on from drift it may only report');
      broken = true;
    }
  }

  const levelProbes = [
    ['a file the review never saw', { state: 'unseen', sha: 'abcdef12', files: ['a.ts'], unseen: ['a.ts'] }, 'FAIL'],
    ['changes to already-reviewed files', { state: 'drift', sha: 'abcdef12', files: ['a.ts'], unseen: [] }, 'WARN'],
    ['a receipt predating drift tracking', { state: 'untracked' }, 'WARN'],
    ['an unreachable anchor', { state: 'unresolvable', sha: 'abcdef12' }, 'WARN'],
    ['no drift at all', null, null],
  ];
  for (const [label, drift, expected] of levelProbes) {
    const mark = results.length;
    reportDrift('review-internal', drift);
    const raised = results.slice(mark).map((r) => r.level);
    results.length = mark;
    const got = raised.includes('FAIL') ? 'FAIL' : raised.includes('WARN') ? 'WARN' : null;
    if (got !== expected) {
      console.error(`self-test: ${label} reported ${got ?? 'nothing'}, expected ${expected ?? 'nothing'}`
        + ' — a review gate must block on code its review never saw and only report everything softer');
      broken = true;
    }
  }

  const anchored = { ...mustPass, headSha: git(['rev-parse', 'HEAD']) };
  const io = (since, reviewed) => ({ since: () => since, between: () => reviewed, base: () => 'base' });
  const wiredProbes = [
    ['a receipt anchored at HEAD', anchored, null, undefined],
    ['a receipt predating drift tracking', mustPass, 'WARN', undefined],
    ['a receipt from an older tree', { ...mustFail, headSha: git(['rev-parse', 'HEAD']) }, null, undefined],
    ['a receipt whose review never saw a shipped file', anchored, 'FAIL', io(['new.ts'], [])],
    ['a receipt whose files were all reviewed', anchored, 'WARN', io(['a.ts'], ['a.ts'])],
    ['a receipt with an anchor git cannot resolve', anchored, 'WARN', io(null, [])],
  ];
  for (const [label, receipt, expected, driftIo] of wiredProbes) {
    writeFileSync(join(gatesPath, 'review-internal.json'), JSON.stringify(receipt));
    const mark = results.length;
    checkReceipt(feature, 'review-internal', tree, { ci: false, driftIo });
    const raised = results.slice(mark).map((r) => r.level);
    results.length = mark;
    const got = raised.includes('FAIL') ? 'FAIL' : raised.includes('WARN') ? 'WARN' : null;
    if (got !== expected) {
      console.error(`self-test: ${label} reported ${got ?? 'nothing'}, expected ${expected ?? 'nothing'}`
        + ' — drift reporting is no longer wired into the path ship-lint actually runs');
      broken = true;
    }
  }
  rmSync(join(gatesPath, 'review-internal.json'));

  const derivationProbes = [
    ['a hook change', '.claude/hooks/vibe-guard.mjs'],
    ['a gate-script change', '.claude/skills/vibe-code-developing-v2/scripts/gates-lib.mjs'],
  ];
  for (const [label, file] of derivationProbes) {
    const derived = requiredGates([file], { hasMockup: false, track: 'full' });
    if (!derived.includes('review-internal') || !derived.includes('review-scan')) {
      console.error(`self-test: ${label} derives ${derived.join(', ') || 'no gates'} — the harness no longer gates changes to itself`);
      broken = true;
    }
  }
  if (!anchors().headSha) {
    console.error('self-test: anchors() records no headSha — every future review receipt would report no drift, forever');
    broken = true;
  }
  const gateRunSource = readFileSync(join(repoRoot(), '.claude/skills/vibe-code-developing-v2/scripts/gate-run.mjs'), 'utf8');
  if ((gateRunSource.match(/\.\.\.anchors\(\)/g) ?? []).length < 2) {
    console.error('self-test: gate-run no longer stamps anchors() into both receipts — drift tracking dies at the source');
    broken = true;
  }
  let liveBase = null;
  try {
    liveBase = git(['merge-base', 'origin/main', 'HEAD']);
  } catch {
    console.error('self-test: this checkout shares no merge base with origin/main — the base probes cannot run here');
    broken = true;
  }
  const baseProbes = liveBase === null ? [] : [
    ['a baseSha behind the current merge-base', { baseSha: git(['rev-parse', `${liveBase}~1`]) }, liveBase],
    ['a baseSha at the current merge-base', { baseSha: liveBase }, liveBase],
    ['an unresolvable baseSha', { baseSha: 'deadbeef' }, liveBase],
    ['a baseSha ahead of the live merge-base', { baseSha: git(['rev-parse', 'HEAD']) }, liveBase],
  ];
  for (const [label, run, expected] of baseProbes) {
    if (diffBase(run) !== expected) {
      console.error(`self-test: ${label} resolved to ${diffBase(run)}, expected ${expected.slice(0, 8)} — gates would be derived from the wrong diff`);
      broken = true;
    }
  }

  const wired = [
    ...fixtures,
    ['a receipt that failed', 'build-test', { ...mustPass, status: 'fail', exit_code: 1 }, true],
    ['a code receipt taken on a dirty tree', 'build-test', { ...mustPass, codeDirty: true }, true],
    ['a plan receipt taken on an uncommitted plan', 'plan-approved', planReceipt({ planDirty: true }), true],
  ];
  for (const [label, gate, receipt, shouldReject] of wired) {
    writeFileSync(join(gatesPath, `${gate}.json`), JSON.stringify(receipt));
    const mark = results.length;
    checkReceipt(feature, gate, tree, { ci: false });
    const rejected = results.slice(mark).some((r) => r.level === 'FAIL');
    results.length = mark;
    if (rejected !== shouldReject) {
      console.error(`self-test: checkReceipt ${rejected ? 'rejected' : 'accepted'} ${label} — the rule is no longer wired into the path ship-lint actually runs`);
      broken = true;
    }
  }
  const rules = [
    ['a gate with no receipt at all', () => {
      rmSync(join(gatesPath, 'build-test.json'), { force: true });
      checkReceipt(feature, 'build-test', tree, { ci: false });
    }, true],
    ['a waiver with no reason', () => {
      writeFileSync(join(gatesPath, 'build-test.json'), JSON.stringify({ status: 'waived' }));
      checkReceipt(feature, 'build-test', tree, { ci: false });
    }, true],
    ['a full-track run that does not require plan-approved', () => {
      if (!requiredGates([], { track: 'full' }).includes('plan-approved')) fail('probe', 'gone');
    }, false],
    ['a lite-track run that still requires it', () => {
      if (requiredGates([], { track: 'lite' }).includes('plan-approved')) fail('probe', 'present');
    }, false],
    ['a packages diff that does not owe review-bc', () => {
      if (!requiredGates(['packages/contracts/src/domain.ts'], { track: 'lite' }).includes('review-bc')) fail('probe', 'gone');
    }, false],
    ["a package's public entry that does not owe review-bc", () => {
      if (!requiredGates(['packages/core/src/index.ts'], { track: 'lite' }).includes('review-bc')) fail('probe', 'gone');
    }, false],
    ['an ordinary module that owes review-bc anyway', () => {
      if (requiredGates(['packages/core/src/proxy/forward.ts'], { track: 'lite' }).includes('review-bc')) fail('probe', 'present');
    }, false],
    ['a test diff that does not owe review-tests', () => {
      if (!requiredGates(['packages/core/src/__tests__/x.test.ts'], { track: 'lite' }).includes('review-tests')) fail('probe', 'gone');
    }, false],
    ['a docs-only diff that owes any code gate anyway', () => {
      const gates = requiredGates(['docs/02-architecture.md'], { track: 'lite' });
      if (gates.includes('build-test') || gates.includes('review-internal')) fail('probe', 'present');
    }, false],
    ['a pr-body over the limit', () => {
      writeFileSync(join(dir, 'pr-body.md'), 'x'.repeat(PR_BODY_LIMIT + 1));
      prBodyLength(feature);
      rmSync(join(dir, 'pr-body.md'), { force: true });
    }, true],
    ['an approval that is not the report\'s last line', () => {
      mkdirSync(join(dir, '.review'), { recursive: true });
      writeFileSync(join(dir, '.review', 'plan.md'),
        `Round 1 said:\n\nVERDICT: APPROVED\n\nRound 2 withdrew it.\n\nPLAN: ${thisPlan}\nVERDICT: REVISE\n`);
      const probe = spawnSync(process.execPath, [
        resolve(import.meta.dirname, 'plan-approved-verify.mjs'),
        '--feature', feature, '--evidence', join(feature, '.review', 'plan.md'),
      ], { cwd: repoRoot(), encoding: 'utf8' });
      if (probe.status === 0) fail('probe', 'position no longer decides which verdict counts');
    }, false],
    ['an approval naming a different plan', () => {
      mkdirSync(join(dir, '.review'), { recursive: true });
      writeFileSync(join(dir, '.review', 'plan.md'), `PLAN: ${'0'.repeat(40)}\nVERDICT: APPROVED\n`);
      const probe = spawnSync(process.execPath, [
        resolve(import.meta.dirname, 'plan-approved-verify.mjs'),
        '--feature', feature, '--evidence', join(feature, '.review', 'plan.md'),
      ], { cwd: repoRoot(), encoding: 'utf8' });
      if (probe.status === 0) fail('probe', 'a verdict for any text now greens the gate');
    }, false],
    ['a pr-body that must truncate', () => {
      writeJson(join(gatesPath, 'run.json'), {
        feature, branch: currentBranch(), baseSha: 'HEAD', mode: 'attended', track: 'full',
        killReviewDue: '2099-01-01',
      });
      writeJson(join(gatesPath, 'plan-approved.json'), { gate: 'plan-approved', status: 'waived', reason: 'ю'.repeat(900) });
      writeFileSync(join(dir, 'review.md'), Array.from({ length: 5 }, (_, i) => `- [ ] MAJOR ${'я'.repeat(400)}${i}`).join('\n'));
      spawnSync(process.execPath, [resolve(import.meta.dirname, 'render.mjs'), 'pr-body', '--feature', feature],
        { cwd: repoRoot(), encoding: 'utf8' });
      prBodyLength(feature);
      const written = readFileSync(join(dir, 'pr-body.md'), 'utf8');
      if (!written.includes('**Гейты @')) fail('probe', 'truncation dropped the gate line');
      if (!written.includes('Бандл:')) fail('probe', 'truncation dropped the bundle path');
      if (!written.includes('_Truncated')) fail('probe', 'truncation dropped its own notice');
    }, false],
  ];
  for (const [label, probe, shouldReject] of rules) {
    const mark = results.length;
    probe();
    const rejected = results.some((r, i) => i >= mark && r.level === 'FAIL');
    results.length = mark;
    if (rejected !== shouldReject) {
      console.error(`self-test: ${label} was ${rejected ? 'rejected' : 'accepted'} — that rule is no longer enforced`);
      broken = true;
    }
  }
  rmSync(dir, { recursive: true, force: true });

  try {
    const cwdProbe = execFileSync(process.execPath, ['-e', `import(${JSON.stringify(resolve(import.meta.dirname, 'gates-lib.mjs'))}).then(m=>console.log(m.codeTree()))`], {
      // any real subdirectory will do — the point is that codeTree pins its pathspecs to the
      // repo root rather than resolving them against whatever cwd it happens to be called from.
      cwd: join(repoRoot(), 'packages'), encoding: 'utf8',
    }).trim();
    if (cwdProbe !== tree) { console.error('self-test: codeTree differs by cwd — the pathspec pin is broken'); broken = true; }
  } catch { console.error('self-test: codeTree threw from another cwd'); broken = true; }

  if (!process.env.CI) try {
    const out = guardAnswer();
    const runIsActive = findFeatureDir(null, { quiet: true }) !== null || currentBranch().startsWith('v2/');
    if (out === null) {
      console.error('self-test: the guard is not installed — a gated run would be unenforced');
      broken = true;
    } else if (runIsActive && !out.includes('"deny"')) {
      if (detachedHead()) {
        console.error('self-test: HEAD is detached, so the guard reads the branch as "HEAD", matches no');
        console.error('run and arms nothing. The harness is fine; this checkout is not guarded.');
        console.error('Check the branch out.');
      } else {
        console.error('self-test: a run is active but the guard did not deny a known-forbidden command.');
        console.error('The wrapper fails open by design, so a broken guard cannot halt other sessions —');
        console.error('which is exactly why this check exists. Fix the guard before continuing.');
      }
      broken = true;
    } else if (!runIsActive && out.trim() && !out.includes('"deny"')) {
      console.error('self-test: the guard answered with something that is neither silence nor a deny.');
      broken = true;
    }
  } catch (err) {
    console.error(`self-test: the guard probe threw — ${err.message}`);
    broken = true;
  }

  results.length = before;
  if (broken) { console.error('HARNESS IS BROKEN — refusing to vouch for any gate'); process.exit(1); }
  console.log(`self-test: OK (${fixtures.length} through staleReason, ${wired.length} through checkReceipt, ${rules.length} rule probes, cwd pin holds, guard answers)`);
  process.exit(0);
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? null : argv[i + 1]; };

if (flag('self-test')) await selfTest();

const featureDir = findFeatureDir(value('feature'));
if (!featureDir) {
  if (currentBranch().startsWith('v2/')) {
    console.log('✗ [run] This is a v2/* branch, but no run has been started on it.');
    console.log('        A v2/* branch means "a gated feature lives here", so the gates cannot');
    console.log('        be derived without a run manifest. Start one:');
    console.log('          node .claude/skills/vibe-code-developing-v2/scripts/gate-run.mjs init --feature docs/vibe-coding/<slug>');
    logEvent({ kind: 'run-summary', required: [], passed: [], waived: [], blocked: true, atShipAttempt: flag('at-ship-attempt') });
    process.exit(1);
  }
  if (flag('ci')) {
    console.log('');
    console.log('  This PR has no vibe2 run attached, so there are no gates to verify.');
    console.log('');
    console.log(`  Branch seen by CI: ${currentBranch()}`);
    console.log('  Looked for:        docs/vibe-coding/*/.gates/run.json with a matching "branch" field');
    console.log('');
    console.log('  If this PR was NOT built with /vibe-code-developing-v2, this is expected and');
    console.log('  the job is green — nothing to check.');
    console.log('');
    console.log('  If it WAS, the run manifest is missing or belongs to another branch. Fix with:');
    console.log('    node .claude/skills/vibe-code-developing-v2/scripts/gate-run.mjs init --feature docs/vibe-coding/<slug>');
    console.log('    git add docs/vibe-coding/<slug>/.gates/run.json && git commit && git push');
    console.log('');
    process.exit(0);
  }
  console.log('ship-lint: no active run (no .gates/run.json under docs/vibe-coding/) — nothing to check');
  process.exit(0);
}
const run = readRun(featureDir);
if (!run) {
  console.log(`✗ [run] ${featureDir} has no .gates/run.json — run \`gate-run init --feature ${featureDir}\` first`);
  process.exit(1);
}
const tree = codeTree();
const changed = changedFiles(diffBase(run));
const hasMockup = existsSync(join(repoRoot(), featureDir, 'design', 'mockup.html'));
const hasAnalyticsPlan = existsSync(join(repoRoot(), featureDir, 'analytics.md'));
const required = requiredGates(changed, { hasMockup, hasAnalyticsPlan, track: run.track });

if (flag('human')) {
  const drifted = [];
  const state = required.map((name) => {
    const r = readJson(join(gatesDir(featureDir), `${name}.json`));
    if (!r) return `${name} ✗`;
    if (r.status === 'waived') return `${name} ⚠`;
    if (r.status !== 'pass' || staleReason(featureDir, name, r, tree)) return `${name} ✗`;
    const advisory = GATES[name]?.advisory ? ' (advisory)' : '';
    const drift = GATES[name]?.anchor === 'review' ? reviewDrift(r, run) : null;
    if (!drift) return `${name} ✓${advisory}`;
    drifted.push([name, drift]);
    return `${name} ${drift.state === 'unseen' ? '✗' : '✓⚠'}${advisory}`;
  });
  console.log(`GATES @ ${tree.slice(0, 8)}: ${state.join(' · ') || 'none required'}`);
  for (const [name, drift] of drifted) {
    const mark = results.length;
    reportDrift(name, drift);
    for (const r of results.slice(mark)) console.log(`${r.level === 'FAIL' ? '✗' : '!'} [${r.check}] ${r.message}`);
    results.length = mark;
  }
  process.exit(0);
}

if (codeDirty()) warn('tree', 'code tree is dirty — gates cannot be trusted until it is committed');
if (!changed.length) {
  warn('base', `the diff against ${String(diffBase(run)).slice(0, 8)} is empty, so no gate is derived from this branch's own work`
    + ' — check run.json\'s baseSha and that origin/main is fetched, because an empty diff gates nothing');
}
for (const name of required) checkReceipt(featureDir, name, tree, { ci: flag('ci') });
prBodyLength(featureDir);

for (const r of results) console.log(`${r.level === 'FAIL' ? '✗' : '!'} [${r.check}] ${r.message}`);
const failures = results.filter((r) => r.level === 'FAIL');
const passed = required.filter((n) => !failures.some((f) => f.check === n));
const waived = results.filter((r) => r.message.startsWith('WAIVED')).map((r) => r.check);

logEvent({
  kind: 'run-summary', feature: featureDir, required, passed, waived,
  blocked: failures.length > 0, atShipAttempt: flag('at-ship-attempt'),
});

console.log(`\nship-lint: ${failures.length} FAIL, ${results.length - failures.length} WARN — ${required.length} gate(s) required @ ${tree.slice(0, 8)}`);
process.exit(failures.length ? 1 : 0);
