import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  anchors, codeDirty, codeTree, currentBranch, detachedHead, gatesDir, git, guardAnswer, logEvent, manifest,
  planDirty, docHash, planHash, readJson, readRun, repoRoot, writeJson, writeReceipt,
} from './gates-lib.mjs';
import { GATES, evidenceArgv } from './gates-registry.mjs';

const KILL_REVIEW_DAYS = 60;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
      else { out[a.slice(2)] = next; i += 1; }
    } else out._.push(a);
  }
  return out;
}

function refuseIfUnguarded(branch) {
  if (process.env.CI) return;
  if (detachedHead()) {
    throw new Error(
      'HEAD is detached, so the branch is only inferred — alphabetically, from the refs pointing at\n'
      + `  this commit, which is how "${branch}" was chosen. The guard reads "HEAD", matches no run\n`
      + '  and arms nothing, and a run bound to an inferred branch is invisible to ship-lint and CI.\n'
      + '  Check the branch out before starting a run.',
    );
  }
  if (!branch.startsWith('v2/')) return;
  if (guardAnswer()?.includes('"deny"')) return;
  throw new Error(
    'the guard did not deny a known-forbidden command, so it is missing or broken.\n'
    + '  It fails OPEN by design — a broken guard must not halt every session in this repository —\n'
    + '  which is why starting a run is what refuses instead. Fix .claude/hooks/vibe-guard.mjs,\n'
    + '  confirm with: node .claude/skills/vibe-code-developing-v2/scripts/ship-lint.mjs --self-test',
  );
}

function refuseSecondBundle(featureDir, branch) {
  const base = join(repoRoot(), 'docs', 'vibe-coding');
  if (!existsSync(base)) return;
  const others = readdirSync(base)
    .map((entry) => join('docs', 'vibe-coding', entry))
    .filter((rel) => rel !== featureDir && readJson(join(repoRoot(), rel, '.gates', 'run.json'))?.branch === branch);
  if (!others.length) return;
  throw new Error(
    `${branch} already carries a run: ${others.join(', ')}
`
    + '  ONE BRANCH, ONE PLAN. With two bundles on one branch ship-lint cannot pick between\n'
    + '  them — add the work to that bundle\'s plan.md instead.');
}

function cmdInit(args) {
  const featureDir = args.feature;
  if (!featureDir || featureDir === true) throw new Error('usage: gate-run init --feature docs/vibe-coding/<slug> [--mode attended|handoff] [--track full|lite] [--agent-consent]');
  if (args.track !== undefined && args.track !== 'full' && args.track !== 'lite') {
    const seen = args.track === true ? 'nothing' : `"${args.track}"`;
    throw new Error(`--track takes "full" or "lite" and was given ${seen} — the track decides whether plan-review is gated`);
  }
  const path = join(gatesDir(featureDir), 'run.json');
  const previous = readRun(featureDir);
  if (existsSync(path) && !args.force) throw new Error('run.json already exists — pass --force to overwrite');
  const previousTrack = previous ? previous.track ?? 'full' : null;
  if (previousTrack === 'full' && args.track === 'lite') {
    throw new Error(
      're-initing a full run as lite would drop plan-approved from the required set, and nothing\n'
      + '  would show it was ever owed. If the plan review genuinely does not apply here, say so\n'
      + '  where it stays visible:\n'
      + `    gate-run waive plan-approved --feature ${featureDir} --reason "<why>"`,
    );
  }
  refuseIfUnguarded(currentBranch());
  if (!previous) refuseSecondBundle(featureDir, currentBranch());
  const now = new Date();
  const killReviewDue = new Date(now.getTime() + KILL_REVIEW_DAYS * 86400000);
  const run = {
    feature: featureDir,
    branch: currentBranch(),
    baseSha: execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: repoRoot(), encoding: 'utf8' }).trim(),
    mode: args.mode === 'handoff' ? 'handoff' : 'attended',
    track: args.track ?? previousTrack ?? 'full',
    agentConsent: Boolean(args['agent-consent']),
    createdAt: now.toISOString(),
    killReviewDue: killReviewDue.toISOString().slice(0, 10),
  };
  writeJson(path, run);
  execFileSync('git', ['add', path], { cwd: repoRoot() });
  logEvent({ kind: 'run-init', feature: featureDir, mode: run.mode, track: run.track, killReviewDue: run.killReviewDue });
  console.log(`run.json written — mode ${run.mode}, track ${run.track}, kill-review due ${run.killReviewDue}`);
}

function cmdRun(args) {
  const name = args._[1];
  const featureDir = args.feature;
  const gate = GATES[name];
  if (!gate) throw new Error(`unknown gate "${name}" — the registry decides the command, not the caller`);
  if (!featureDir || featureDir === true) throw new Error('--feature <dir> is required, with a value');
  if (gate.anchor !== 'plan' && codeDirty()) {
    throw new Error('code tree is dirty — commit first. A receipt must attest to the tree that was actually tested.');
  }

  const demandEvidence = () => {
    if (args.evidence && args.evidence !== true) return String(args.evidence);
    throw new Error(
      `${name} is produced by a skill, not by this script — run ${gate.skill}, then pass its output:\n` +
      `  gate-run run ${name} --feature ${featureDir} --evidence <path>\n` +
      `  expected: ${gate.evidence}\n` +
      `  a skill named as a path is a sub-skill: read .claude/skills/<path>/SKILL.md instead of Skill(<name>)`,
    );
  };

  const planAnchored = gate.anchor === 'plan';
  const planAtStart = planAnchored ? planHash(featureDir) : null;
  const docAtStart = gate.anchorDoc ? docHash(featureDir, gate.anchorDoc) : null;

  let argv;
  if (gate.runsItself) {
    argv = [...gate.argv];
    if (gate.needsFeature) argv.push('--feature', featureDir);
    if (gate.needsEvidence) argv.push('--evidence', demandEvidence());
    if (planAnchored) argv.push('--plan-hash', String(planAtStart));
  } else {
    argv = evidenceArgv(demandEvidence());
  }

  const startedAt = Date.now();
  const tree = codeTree();
  if (args.anchor && gate.anchor !== 'review') {
    throw new Error(`--anchor is only meaningful for a review gate; ${name} anchors on ${gate.anchor ?? 'code'}`);
  }
  const reviewAnchor = args.anchor && args.anchor !== true ? git(['rev-parse', String(args.anchor)]) : null;
  console.log(`▶ ${name}: ${argv.join(' ')}`);
  const result = spawnSync(argv[0], argv.slice(1), { cwd: repoRoot(), stdio: 'inherit' });
  const exitCode = result.status === null ? 1 : result.status;

  const artifacts = args.evidence ? manifest([String(args.evidence)], 0) : [];
  const status = exitCode === 0 ? 'pass' : 'fail';
  const receipt = {
    gate: name,
    status,
    exit_code: exitCode,
    ...anchors(),
    ...(reviewAnchor ? { headSha: reviewAnchor } : {}),
    codeTree: tree,
    startedAt: new Date(startedAt).toISOString(),
    command: argv.join(' '),
    evidencePath: args.evidence ? String(args.evidence) : null,
    artifacts,
    ...(planAnchored ? { planHash: planAtStart, planDirty: planDirty(featureDir) } : {}),
    ...(gate.anchorDoc ? { anchorDoc: gate.anchorDoc, docHash: docAtStart } : {}),
  };
  writeReceipt(featureDir, receipt);
  execFileSync('git', ['add', join(featureDir, '.gates', `${name}.json`)], { cwd: repoRoot() });
  logEvent({ kind: 'gate-run', gate: name, status, artifacts: artifacts.length });

  console.log(`${exitCode === 0 ? '✓' : '✗'} ${name} — ${status}${args.evidence ? `, ${artifacts.length} evidence file(s)` : ''}`);
  if (receipt.planDirty) {
    console.log('⚠ plan.md is uncommitted, so this receipt fails ship-lint until you commit it and re-run:');
    console.log('  CI reads the committed blob, and it is not the one just approved.');
  }
  process.exit(exitCode);
}

function cmdWaive(args) {
  const name = args._[1];
  const featureDir = args.feature;
  if (!GATES[name]) throw new Error(`unknown gate "${name}"`);
  if (!args.reason || args.reason === true) throw new Error('a waiver without --reason is refused');
  const reason = String(args.reason);
  if (/pre-?existing|уже падал|не связан/i.test(reason) && !/origin\/main/.test(reason)) {
    throw new Error(
      'a waiver claiming the failure is pre-existing must quote the proof: run the same check on a\n'
      + '  clean origin/main worktree and put its result in --reason. Before waiving, ASK the owner\n'
      + '  whether to fix it here instead — a 20-line fix beats a PR whose green is conditional.',
    );
  }
  const receipt = {
    gate: name,
    status: 'waived',
    waived_by: 'agent-recorded',
    reason: String(args.reason),
    ...anchors(),
    startedAt: new Date().toISOString(),
    artifacts: [],
  };
  writeReceipt(featureDir, receipt);
  execFileSync('git', ['add', join(featureDir, '.gates', `${name}.json`)], { cwd: repoRoot() });
  logEvent({ kind: 'waiver', gate: name, reason: receipt.reason });
  console.log(`⚠ ${name} waived — surfaced at the top of the PR body and in the CI summary`);
}

function cmdClose(args) {
  const featureDir = args.feature;
  if (!featureDir || featureDir === true) throw new Error('--feature <dir> is required, with a value');
  const path = join(gatesDir(featureDir), 'run.json');
  const run = readJson(path);
  if (!run) throw new Error(`no run at ${path} — nothing to close`);
  if (run.closed) {
    console.log(`already closed at ${run.closed}`);
    return;
  }
  writeJson(path, { ...run, closed: new Date().toISOString() });
  logEvent({ kind: 'run-closed', feature: featureDir, branch: run.branch });
  console.log(`closed the run on ${run.branch}. The guard stops arming for it, and ship-lint stops`);
  console.log('picking it up. Re-open by re-running init; the receipts are untouched.');
}

const COMMANDS = { init: cmdInit, run: cmdRun, waive: cmdWaive, close: cmdClose };
const args = parseArgs(process.argv.slice(2));
const command = COMMANDS[args._[0]];
if (!command) {
  console.log(`usage:
  gate-run.mjs init  --feature <dir>
                     [--mode attended|handoff] [--track full|lite] [--agent-consent]
  gate-run.mjs run   <gate> --feature <dir> [--evidence <path produced by the skill>]
  gate-run.mjs waive <gate> --feature <dir> --reason "<text>"`);
  process.exit(1);
}
try { command(args); } catch (err) { console.error(`ERROR: ${err.message}`); process.exit(1); }
