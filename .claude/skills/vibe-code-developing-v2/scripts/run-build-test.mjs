import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { changedFiles, diffBase, readRun, repoRoot } from './gates-lib.mjs';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : process.argv[i + 1]; };
const featureDir = arg('feature');
const root = repoRoot();
const run = featureDir ? readRun(featureDir) : null;
const changed = run ? changedFiles(diffBase(run)) : [];
const SCRIPTS = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};

// This is a yarn-workspaces monorepo: a change in one package can break a dependent one, and the
// dependency direction is not knowable from paths alone. So the gate builds the whole graph in
// topological order rather than guessing which siblings a touched package feeds.
const STEPS = ['typecheck', 'build', 'test'];

const touchedPackages = [...new Set(changed
  .map((f) => /^packages\/([^/]+)\//.exec(f)?.[1])
  .filter(Boolean))];

if (!touchedPackages.length) { console.log('run-build-test: no package touched'); process.exit(0); }
console.log(`run-build-test: touched ${touchedPackages.join(', ')} — building the whole workspace graph`);

for (const step of STEPS) {
  if (!SCRIPTS[step]) continue;
  console.log(`▶ yarn ${step}`);
  execFileSync('yarn', [step], { cwd: root, stdio: 'inherit' });
}

console.log('run-build-test: green');
