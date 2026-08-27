import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { logEvent, readRun, repoRoot } from './gates-lib.mjs';

const PROJECTS = join(homedir(), '.claude', 'projects');
const BUNDLE_ROOT = 'docs/vibe-coding/';

let bundles = null;
function realBundles() {
  if (bundles) return bundles;
  const listed = (ref) => {
    try {
      return execFileSync('git', ['ls-tree', '-d', '--name-only', ref, BUNDLE_ROOT], { cwd: repoRoot(), encoding: 'utf8' })
        .split('\n').filter(Boolean);
    } catch { return []; }
  };
  bundles = new Set([...listed('HEAD'), ...listed('origin/main')]);
  return bundles;
}
const ROUND_GAP_MS = 15 * 60 * 1000;
const CODE_REVIEWER = 'READ-ONLY code reviewer';
const PLAN_REVIEWER = 'strict plan reviewer';
const HEADER_LINES = 8;
const SHIP_GATE = /gate-run(\.mjs)? run (?!plan-approved)[a-z0-9-]+/;

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i === -1 ? null : process.argv[i + 1];
  return !value || value.startsWith('--') ? null : value;
};

const die = (...lines) => { for (const line of lines) console.error(line); process.exit(1); };

const rgList = (pattern, fixed) => {
  try {
    return execFileSync('rg', ['-l', ...(fixed ? ['-F'] : []), pattern, '--glob', '*.jsonl', PROJECTS], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];
    die('cost: ripgrep (rg) is required to locate transcripts, and it did not run.', `  ${err.message}`);
  }
  return [];
};

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const transcriptsIn = (dir) => (existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f))
  : []);

const spawnedBy = (sessionFile) => transcriptsIn(join(dirname(sessionFile), basename(sessionFile, '.jsonl'), 'subagents'));

function runBranch(featureDir) {
  const local = readRun(featureDir)?.branch;
  if (local) return local;
  for (const ref of ['origin/main', 'main']) {
    try {
      return JSON.parse(execFileSync('git', ['show', `${ref}:${featureDir}/.gates/run.json`], {
        cwd: repoRoot(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })).branch;
    } catch { /* the bundle never reached that ref */ }
  }
  return null;
}

function transcriptsOfRun(featureDir) {
  const branch = runBranch(featureDir);
  if (!branch) return { files: [], branch: null };
  const files = new Set(rgList(`"gitBranch":"${branch}"`, true));
  for (const path of [...files]) for (const child of spawnedBy(path)) files.add(child);
  const elsewhere = rgList(`(gate-run|ship-lint|render)\\.mjs[^"]{0,400}${escapeRe(featureDir)}`, false)
    .filter((path) => !path.includes(`${sep}subagents${sep}`) && !files.has(path));
  return { files: [...files], branch, elsewhere: elsewhere.length };
}

function classify(path, lines) {
  const header = lines.slice(0, HEADER_LINES).join('\n');
  if (header.includes(CODE_REVIEWER)) return 'code-review';
  if (header.includes(PLAN_REVIEWER)) return 'plan-review';
  return path.includes(`${sep}subagents${sep}`) ? 'subagent' : 'main';
}

function scan(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const session = { kind: classify(path, lines), turns: 0, ctx: 0, out: 0, at: null, planMark: null, ctxSeq: [], effort: null, shipMark: null };
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.timestamp && !session.at) session.at = entry.timestamp;
    if (entry.effort && !session.effort) session.effort = entry.effort;
    const message = entry.message;
    if (!message || typeof message !== 'object') continue;
    if (session.planMark === null) {
      for (const part of message.content ?? []) {
        if (part?.type !== 'tool_use') continue;
        const input = JSON.stringify(part.input ?? {});
        if (input.includes('gate-run') && input.includes('plan-approved')) session.planMark = session.turns;
      }
    }
    if (session.shipMark === null) {
      for (const part of message.content ?? []) {
        if (part?.type === 'tool_use' && SHIP_GATE.test(JSON.stringify(part.input ?? {}))) session.shipMark = session.turns;
      }
    }
    const usage = message.usage;
    if (!usage) continue;
    const ctx = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    session.turns += 1;
    session.ctx += ctx;
    session.out += usage.output_tokens ?? 0;
    session.ctxSeq.push(ctx);
  }
  return session;
}

function reviewRounds(sessions) {
  const stamps = sessions.filter((s) => s.kind === 'code-review' && s.at).map((s) => Date.parse(s.at)).sort((a, b) => a - b);
  let rounds = 0;
  let previous = null;
  for (const at of stamps) {
    if (previous === null || at - previous > ROUND_GAP_MS) rounds += 1;
    previous = at;
  }
  return { rounds, reviewers: stamps.length };
}

function measure(featureDir) {
  const { files, branch, elsewhere } = transcriptsOfRun(featureDir);
  const sessions = files.map(scan).filter((s) => s.turns > 0);
  if (!sessions.length) return null;

  const sum = (kinds, field) => sessions.filter((s) => kinds.includes(s.kind)).reduce((n, s) => n + s[field], 0);
  const REVIEWERS = ['code-review', 'plan-review'];
  const main = { ctx: sum(['main'], 'ctx'), turns: sum(['main'], 'turns') };
  const review = { ctx: sum(REVIEWERS, 'ctx'), turns: sum(REVIEWERS, 'turns') };
  const sub = { ctx: sum(['subagent'], 'ctx'), turns: sum(['subagent'], 'turns') };
  const ctx = main.ctx + review.ctx + sub.ctx;
  const out = sum(['main', 'subagent', ...REVIEWERS], 'out');

  const chronological = sessions.filter((s) => s.kind === 'main').sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const gated = chronological.findIndex((s) => s.planMark !== null);
  const prePlan = gated === -1 ? null : chronological.slice(0, gated).reduce((n, s) => n + s.ctx, 0)
    + chronological[gated].ctxSeq.slice(0, chronological[gated].planMark).reduce((n, v) => n + v, 0);

  const shipping = chronological.findIndex((s) => s.shipMark !== null);
  const beforeShip = shipping === -1 ? null : chronological.slice(0, shipping).reduce((n, s) => n + s.ctx, 0)
    + chronological[shipping].ctxSeq.slice(0, chronological[shipping].shipMark).reduce((n, v) => n + v, 0);
  const shipCtx = beforeShip === null ? null : main.ctx - beforeShip;
  const shipReset = shipping === -1 ? null : (() => {
    const seq = chronological[shipping].ctxSeq;
    const tail = seq.slice(chronological[shipping].shipMark);
    const replayed = tail.reduce((n, _, i) => n + seq[Math.min(i, seq.length - 1)], 0);
    return Math.round((100 * (tail.reduce((n, v) => n + v, 0) - replayed)) / main.ctx);
  })();

  return {
    feature: featureDir,
    branch,
    elsewhere,
    efforts: [...new Set(sessions.map((s) => s.effort).filter(Boolean))].sort().join(' · ') || '—',
    sessions: sessions.length,
    turns: main.turns + review.turns + sub.turns,
    mainTurns: main.turns,
    ctx,
    mainCtx: main.ctx,
    reviewCtx: review.ctx,
    subCtx: sub.ctx,
    subagents: sessions.filter((s) => s.kind === 'subagent').length,
    out,
    ratio: out ? Math.round(ctx / out) : null,
    ctxPerTurn: Math.round(ctx / (main.turns + review.turns + sub.turns)),
    prePlanCtx: prePlan,
    prePlanShare: prePlan === null ? null : Math.round((100 * prePlan) / main.ctx),
    shipShare: shipCtx === null ? null : Math.round((100 * shipCtx) / main.ctx),
    shipReset,
    ...reviewRounds(sessions),
  };
}

const M = (n) => `${(n / 1e6).toFixed(0)}M`;
const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)}%` : '—');

function report(cost) {
  console.log(`${cost.feature}${cost.branch ? ` · ${cost.branch}` : ''}`);
  console.log(`  сессий            ${cost.sessions} · ходов ${cost.turns} (основные ${cost.mainTurns})`);
  console.log(`  контекст          ${M(cost.ctx)} — основные ${M(cost.mainCtx)} ${pct(cost.mainCtx, cost.ctx)} · субагенты ${M(cost.subCtx)} ${pct(cost.subCtx, cost.ctx)} · ревьюеры-процессы ${M(cost.reviewCtx)} ${pct(cost.reviewCtx, cost.ctx)}`);
  console.log(`  выход             ${(cost.out / 1e6).toFixed(2)}M`);
  console.log(`  контекст : выход  ${cost.ratio ?? '—'}`);
  console.log(`  контекст на ход   ${Math.round(cost.ctxPerTurn / 1000)}k`);
  console.log(`  до plan-approved  ${cost.prePlanCtx === null ? 'гейт в этих сессиях не звался' : `${M(cost.prePlanCtx)} — ${cost.prePlanShare}% основных сессий`}`);
  console.log(cost.reviewers
    ? `  раундов ревью     ${cost.rounds} (${cost.reviewers} процессов-ревьюеров)`
    : '  раундов ревью     — ревьюеры шли не отдельными процессами, их расход не измерим');
  console.log(`  фаза 4            ${cost.shipShare === null ? 'первый гейт выкатки в этих сессиях не звался' : `${cost.shipShare}% основных сессий · сброс перед ней снял бы ${cost.shipReset}%`}`);
  console.log(`  усилие            ${cost.efforts}`);
  if (cost.elsewhere) {
    console.log(`  ⚠ ${cost.elsewhere} сесси(й) звали скрипты этого бандла с другой ветки и НЕ посчитаны —`);
    console.log('    прогон приписывается по `gitBranch`, иначе в него попадает любой позднейший разбор.');
  }
}

function knownRuns() {
  const dir = join(homedir(), '.claude', 'harness-logs');
  const features = new Set();
  let files = [];
  try {
    files = execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.jsonl'));
  } catch { return []; }
  for (const file of files) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.includes('"run-init"')) continue;
      try {
        const event = JSON.parse(line);
        if (event.feature?.startsWith(BUNDLE_ROOT) && realBundles().has(event.feature)) features.add(event.feature);
      } catch { /* a truncated line is not a run */ }
    }
  }
  return [...features].sort();
}

const record = (cost) => logEvent({
  kind: 'run-cost',
  feature: cost.feature,
  ctx: cost.ctx,
  mainCtx: cost.mainCtx,
  reviewCtx: cost.reviewCtx,
  subCtx: cost.subCtx,
  subagents: cost.subagents,
  out: cost.out,
  turns: cost.turns,
  ratio: cost.ratio,
  ctxPerTurn: cost.ctxPerTurn,
  prePlanShare: cost.prePlanShare,
  rounds: cost.rounds,
  reviewers: cost.reviewers,
});

const feature = arg('feature');
if (!feature && !flag('all')) {
  die('usage:',
    '  cost.mjs --feature docs/vibe-coding/<slug> [--json] [--record]',
    '  cost.mjs --all [--record]        every run this machine ever started, from the harness log');
}

const targets = feature ? [feature] : knownRuns();
const measured = targets.map(measure).filter(Boolean);

if (flag('json')) {
  console.log(JSON.stringify(measured, null, 2));
} else if (feature) {
  if (!measured.length) die(`cost: no transcript under ~/.claude/projects mentions ${feature} — nothing to measure`);
  report(measured[0]);
} else {
  console.log(`${'прогон'.padEnd(46)} ${'ctx'.padStart(6)} ${'ревью'.padStart(6)} ${'выход'.padStart(6)} ${'ratio'.padStart(6)} ${'ctx/ход'.padStart(8)} ${'≤план'.padStart(6)} ${'раунды'.padStart(7)}`);
  for (const cost of measured.sort((a, b) => b.ctx - a.ctx)) {
    console.log(`${cost.feature.replace('docs/vibe-coding/', '').padEnd(46)} ${M(cost.ctx).padStart(6)} ${pct(cost.reviewCtx + cost.subCtx, cost.ctx).padStart(6)} ${`${(cost.out / 1e6).toFixed(1)}M`.padStart(6)} ${String(cost.ratio ?? '—').padStart(6)} ${`${Math.round(cost.ctxPerTurn / 1000)}k`.padStart(8)} ${(cost.prePlanShare === null ? '—' : `${cost.prePlanShare}%`).padStart(6)} ${String(cost.rounds).padStart(7)}`);
  }
  const total = measured.reduce((n, c) => n + c.ctx, 0);
  const middle = measured.map((c) => c.ctx).sort((a, b) => a - b)[Math.floor(measured.length / 2)];
  console.log(`\n${measured.length} прогонов · всего ${M(total)} · медиана ${M(middle)}`);
}

if (flag('record')) for (const cost of measured) record(cost);
