#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

export const LOGIC_FILE_LIMIT = 3;
export const MASS_CHANGE_LIMIT = 12;

const DANGEROUS = [
  [/^packages\/contracts\//, 'the cross-package contract every other package compiles against'],
  [/^packages\/[^/]+\/src\/index\.ts$/, "a package's public export surface — siblings break at compile time"],
  [/^\.claude\//, 'the harness that gates everything else'],
  [/^\.github\//, 'CI definition'],
  [/[Ss]chemas?\.ts$/, 'wire/validation schema'],
  // mcpproxy is a security proxy: the policy decision path and the audit trail are the two places
  // where a silent regression is not a bug report but an unlogged bypass.
  [/(^|\/)(policy|policies)\//, 'policy decision path — a regression here is a silent bypass'],
  [/(^|\/)audit\//, 'audit trail — evidence that cannot be reconstructed after the fact'],
  [/(^|\/)(auth|credentials|secrets)\//, 'credential / auth handling'],
  [/(^|\/)(package\.json|yarn\.lock|\.yarnrc\.yml)$/, 'dependency / workspace config'],
  [/(^|\/)tsconfig(\.[a-z]+)?\.json$/, 'build + project-reference graph'],
];

const MECHANICAL = [
  [/(^|\/)__tests__\//, 'test'],
  [/\.test\.[cm]?[jt]sx?$/, 'test'],
  [/\.spec\.[cm]?[jt]sx?$/, 'test'],
  [/^packages\/[^/]+\/tests?\//, 'test'],
  [/^packages\/bench\//, 'benchmark harness'],
  [/^docs\//, 'docs'],
  [/\.md$/, 'docs'],
];

const match = (path, table) => {
  for (const [re, label] of table) if (re.test(path)) return label;
  return null;
};

export function classify(entries) {
  const dangerous = [];
  const mechanical = [];
  const logic = [];

  for (const entry of entries) {
    const paths = entry.paths ?? [entry.path];
    const primary = paths[paths.length - 1];

    const mech = match(primary, MECHANICAL);
    if (mech && !paths.some((p) => match(p, DANGEROUS) && !match(p, MECHANICAL))) {
      mechanical.push({ path: primary, reason: mech });
      continue;
    }

    const dangerPath = paths.find((p) => match(p, DANGEROUS));
    if (dangerPath) {
      dangerous.push({ path: dangerPath, reason: match(dangerPath, DANGEROUS) });
      continue;
    }
    if (mech) {
      mechanical.push({ path: primary, reason: mech });
      continue;
    }
    if (entry.status.startsWith('D')) {
      mechanical.push({ path: primary, reason: 'deletion' });
      continue;
    }
    const rename = /^R(\d+)$/.exec(entry.status);
    if (rename && Number(rename[1]) >= 90) {
      mechanical.push({ path: primary, reason: 'move' });
      continue;
    }
    logic.push({ path: primary });
  }

  return { dangerous, mechanical, logic };
}

export function verdict(buckets) {
  if (buckets.dangerous.length) {
    return { route: 'full', why: `${buckets.dangerous[0].path} — ${buckets.dangerous[0].reason}` };
  }
  if (buckets.logic.length > LOGIC_FILE_LIMIT) {
    return { route: 'full', why: `${buckets.logic.length} files carry logic, the lite limit is ${LOGIC_FILE_LIMIT}` };
  }
  const total = buckets.logic.length + buckets.mechanical.length;
  if (total > MASS_CHANGE_LIMIT) {
    return { route: 'full', why: `${total} files changed — past ${MASS_CHANGE_LIMIT} this is not a small fix, however mechanical it looks` };
  }
  return { route: 'lite', why: null };
}

function parseEntries(raw) {
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      return { status: parts[0], paths: parts.slice(1) };
    });
}

function collect(base) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const seen = new Map();
  for (const args of [
    ['diff', '--name-status', '-M', `${base}...HEAD`],
    ['diff', '--name-status', '-M', 'HEAD'],
    ['diff', '--name-status', '-M', '--cached', 'HEAD'],
  ]) {
    for (const entry of parseEntries(run(args))) {
      seen.set(entry.paths.join('\t'), entry);
    }
  }
  for (const path of run(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    seen.set(path, { status: 'A', paths: [path] });
  }
  return [...seen.values()];
}

function report(buckets, call) {
  const lines = [];
  if (call.route === 'lite') {
    lines.push(`LITE-OK — ${buckets.logic.length}/${LOGIC_FILE_LIMIT} logic files, no dangerous surface`);
  } else {
    lines.push(`ESCALATE to the full gated route — ${call.why}`);
  }
  const list = (label, items) => (items.length ? `  ${label}: ${items.map((i) => i.path).join(', ')}` : null);
  for (const line of [
    list('dangerous', buckets.dangerous),
    list('logic', buckets.logic),
    list('mechanical (uncounted)', buckets.mechanical),
  ]) {
    if (line) lines.push(line);
  }
  if (call.route === 'full') {
    lines.push('', 'Start the full route: gate-run init --feature docs/vibe-coding/<slug>');
  }
  return lines.join('\n');
}

const at = (path) => ({ status: 'M', paths: [path] });
const routeOf = (entries) => verdict(classify(entries)).route;

const PROBES = [
  ['a contract change escaping on lite', () => (routeOf([at('packages/contracts/src/domain.ts')]) === 'full' ? null : 'packages/contracts no longer escalates')],
  ["a package's public entry escaping on lite", () => (routeOf([at('packages/core/src/index.ts')]) === 'full' ? null : 'a package index.ts no longer escalates')],
  ['the harness modifying itself on lite', () => (routeOf([at('.claude/hooks/vibe-guard.mjs')]) === 'full' ? null : '.claude/ no longer escalates')],
  ['the policy path escaping on lite', () => (routeOf([at('packages/core/src/policy/evaluate.ts')]) === 'full' ? null : 'the policy path no longer escalates')],
  ['the audit trail escaping on lite', () => (routeOf([at('packages/core/src/audit/writer.ts')]) === 'full' ? null : 'the audit trail no longer escalates')],
  ['a singular *Schema.ts escaping on lite', () => (routeOf([at('packages/mcp-server/src/toolCallSchema.ts')]) === 'full' ? null : 'a singular Schema.ts no longer escalates')],
  ['a lockfile escaping on lite', () => (routeOf([at('yarn.lock')]) === 'full' ? null : 'a lockfile no longer escalates')],
  ['the project-reference graph escaping on lite', () => (routeOf([at('tsconfig.base.json')]) === 'full' ? null : 'tsconfig no longer escalates')],
  ['an ordinary module wrongly escalating', () => (routeOf([at('packages/core/src/proxy/forward.ts')]) === 'lite' ? null : 'a plain module is being read as dangerous')],
  ['a test inside a dangerous folder wrongly escalating', () => (routeOf([at('packages/contracts/src/__tests__/domain.test.ts')]) === 'lite' ? null : 'a test under contracts is escalating as a contract change')],
  ['a file moved OUT of a dangerous folder escaping', () => (routeOf([{ status: 'R100', paths: ['packages/contracts/src/foo.ts', 'packages/core/src/foo.ts'] }]) === 'full' ? null : 'only the destination path is being classified')],
  ['docs counted against the logic limit', () => {
    const buckets = classify([at('packages/core/src/proxy/forward.ts'), ...['01-problem', '02-architecture'].map((d) => at(`docs/${d}.md`))]);
    if (buckets.logic.length !== 1) return `docs leaked into logic (${buckets.logic.length})`;
    return verdict(buckets).route === 'lite' ? null : 'a one-file change plus docs no longer fits lite';
  }],
  ['tests counted against the logic limit', () => {
    const buckets = classify([at('packages/core/src/proxy/forward.ts'), at('packages/core/src/__tests__/forward.test.ts'), at('packages/core/tests/unit/x.test.ts')]);
    return buckets.logic.length === 1 ? null : `tests leaked into logic (${buckets.logic.length})`;
  }],
  ['a pure move counted against the logic limit', () => {
    const buckets = classify([{ status: 'R100', paths: ['packages/core/src/utils/y.ts', 'packages/core/src/helpers/y.ts'] }]);
    return buckets.logic.length === 0 ? null : 'a 100% rename is being counted as logic';
  }],
  ['a heavily rewritten rename passing as mechanical', () => {
    const buckets = classify([{ status: 'R062', paths: ['packages/core/src/utils/y.ts', 'packages/core/src/helpers/y.ts'] }]);
    return buckets.logic.length === 1 ? null : 'a rewritten rename is no longer counted as logic';
  }],
  ['a four-file logic diff passing as lite', () => (routeOf(['a', 'b', 'c', 'd'].map((n) => at(`packages/core/src/proxy/${n}.ts`))) === 'full' ? null : 'the logic limit no longer bites')],
  ['a mass deletion passing as a small fix', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ status: 'D', paths: [`packages/core/src/gone/f${i}.ts`] }));
    return routeOf([...entries, at('packages/core/src/proxy/forward.ts')]) === 'full' ? null : 'a 40-file removal still reads as lite';
  }],
  ['an empty diff answering "lite"', () => withTempRepo((repo) => {
    const probe = runSelf(repo, ['--base', 'HEAD']);
    if (probe.status === 0) return 'an empty diff still exits 0, which SKILL.md documents as "lite"';
    return /nothing to route/.test(probe.stdout) ? null : `an empty diff no longer explains itself: ${probe.stdout.trim()}`;
  })],
  ['a bad --base printing a raw stack', () => withTempRepo((repo) => {
    const probe = runSelf(repo, ['--base', 'definitely-no-such-ref']);
    if (/\n\s+at /.test(probe.stderr)) return 'a bad --base still dumps a Node stack';
    return /cannot read the diff/i.test(probe.stdout) ? null : `a bad --base no longer explains itself: ${probe.stdout.trim()}`;
  })],
  ['the documented exit codes', () => withTempRepo((repo) => {
    writeFileSync(join(repo, 'client', 'src', 'features', 'x', 'a.tsx'), 'export const a = 1;\n');
    const lite = runSelf(repo, ['--base', 'HEAD', '--json']);
    if (lite.status !== 0) return `a one-logic-file diff exited ${lite.status}, expected 0`;
    if (JSON.parse(lite.stdout).route !== 'lite') return '--json did not carry route "lite"';
    for (const n of ['b', 'c', 'd']) {
      writeFileSync(join(repo, 'client', 'src', 'features', 'x', `${n}.tsx`), 'export const x = 1;\n');
    }
    const full = runSelf(repo, ['--base', 'HEAD', '--json']);
    if (full.status !== 1) return `an escalating diff exited ${full.status}, expected 1`;
    return JSON.parse(full.stdout).route === 'full' ? null : '--json did not carry route "full"';
  })],
];

function runSelf(cwd, args) {
  const probe = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: probe.status, stdout: String(probe.stdout ?? ''), stderr: String(probe.stderr ?? '') };
}

function withTempRepo(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'lite-check-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'probe@local');
    git('config', 'user.name', 'probe');
    mkdirSync(join(repo, 'client', 'src', 'features', 'x'), { recursive: true });
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    git('add', '-A');
    git('commit', '-qm', 'seed');
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function selfTest() {
  const failures = [];
  for (const [name, probe] of PROBES) {
    let outcome;
    try {
      outcome = probe();
    } catch (err) {
      outcome = `threw: ${err.message}`;
    }
    if (outcome) failures.push(`  ✗ ${name} — ${outcome}`);
  }
  if (failures.length) {
    process.stdout.write(`lite-check self-test FAILED\n${failures.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`lite-check self-test ok — ${PROBES.length} probes\n`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  const baseIndex = argv.indexOf('--base');
  const base = baseIndex === -1 ? 'origin/main' : argv[baseIndex + 1];
  if (!base) {
    process.stdout.write('--base needs a ref\n');
    process.exit(1);
  }

  let entries;
  try {
    entries = collect(base);
  } catch (err) {
    const detail = String(err.stderr ?? err.message).split('\n')[0];
    process.stdout.write(`cannot read the diff against "${base}" — ${detail}\n`);
    process.exit(1);
  }

  if (!entries.length) {
    process.stdout.write(`no diff against ${base} — nothing to route yet, so this is not an answer of "lite"\n`);
    process.exit(2);
  }

  const buckets = classify(entries);
  const call = verdict(buckets);

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ ...call, ...buckets }, null, 2)}\n`);
  } else {
    process.stdout.write(`${report(buckets, call)}\n`);
  }
  process.exit(call.route === 'lite' ? 0 : 1);
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) main();
