import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gatesDir, logEvent, readRun, repoRoot, writeJson } from './gates-lib.mjs';

const MAX_DEPTH = 1;
const TIMEOUT_MINUTES = 90;

const NOTES = 'handoff-notes.md';
const MIN_NOTE_LINES = 3;
const STAGES = ['plan', 'ship'];

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : process.argv[i + 1]; };
const featureDir = arg('feature');
const mode = arg('mode') ?? 'attended';
const stage = arg('stage') ?? 'plan';
const dryRun = process.argv.includes('--dry-run');
if (!featureDir || !STAGES.includes(stage)) {
  console.error('usage: handoff.mjs --feature <dir> [--stage plan|ship] [--mode attended|handoff] [--dry-run]');
  console.error('  --stage plan   after plan-approved, before implementation');
  console.error(`  --stage ship   after implementation, before the gates — requires ${NOTES}`);
  process.exit(1);
}

const notesPath = join(repoRoot(), featureDir, NOTES);
const notes = existsSync(notesPath) ? readFileSync(notesPath, 'utf8').trim() : '';
if (stage === 'ship' && notes.split('\n').filter((l) => l.trim()).length < MIN_NOTE_LINES) {
  console.error(`handoff --stage ship: ${featureDir}/${NOTES} is missing or too thin to be worth injecting.`);
  console.error('  The plan says what was meant; only you know what the implementation actually did.');
  console.error('  Write it before clearing — where the code diverged from the plan and why, what was');
  console.error('  deliberately left undone, what is fragile, what a reviewer will ask about. Without it');
  console.error('  the next session re-derives your decisions from the diff, or silently drops the debt.');
  process.exit(1);
}

const run = readRun(featureDir);
const depth = (run?.depth ?? 0) + 1;
if (depth > MAX_DEPTH) {
  console.error(`handoff: depth ${depth} exceeds ${MAX_DEPTH} — a carrier may not spawn another carrier`);
  process.exit(1);
}

const sessionId = randomUUID();
const logPath = join(homedir(), '.claude', 'harness-logs', `carrier-${sessionId}.log`);
const prompt = stage === 'ship'
  ? `Continue the feature in ${featureDir}. The code is written and committed; what is left is phase 4. Read its spec.md, plan.md, status.md and ${NOTES} — the last one is the outgoing session's own account of where the implementation diverged from the plan and what it left owed, so read it before you judge the diff. Then run every derived gate via gate-run, walk the Rn coverage, and open the PR when ship-lint passes. Do not re-plan and do not merge.`
  : `Continue the feature in ${featureDir}. Read its spec.md, plan.md and status.md, then execute the plan with /vibe-code-developing-v2 rules. Run every derived gate via gate-run and open the PR when ship-lint passes. Do not merge.`;

const argv = ['-p', '--session-id', sessionId, '--permission-mode', 'bypassPermissions', prompt];

writeJson(join(gatesDir(featureDir), 'handoff.json'), {
  mode, stage, sessionId, depth, logPath,
  worktree: repoRoot(),
  resume: `claude --resume ${sessionId}`,
  timeoutMinutes: TIMEOUT_MINUTES,
  initialUserMessage: prompt,
  createdAt: new Date().toISOString(),
});

if (mode !== 'handoff' || dryRun) {
  console.log(`handoff.json written (mode ${mode}, stage ${stage}).`);
  console.log('');
  console.log('After /clear the SessionStart hook injects this automatically. Paste it only if the');
  console.log('resumed session does not already say it is continuing this bundle:');
  console.log('');
  console.log('----- copy below -----');
  console.log(prompt);
  console.log('----- copy above -----');
  console.log('');
  console.log(`Or hand it to a separate process instead: handoff.mjs --feature ${featureDir} --mode handoff`);
  process.exit(0);
}

const out = openSync(logPath, 'a');
const child = spawn('claude', argv, { cwd: repoRoot(), detached: true, stdio: ['ignore', out, out] });
child.unref();
setTimeout(() => {}, 0);
logEvent({ kind: 'handoff', feature: featureDir, stage, sessionId, depth });
console.log(`carrier started — session ${sessionId}\nlog: ${logPath}\nresume: claude --resume ${sessionId}`);
