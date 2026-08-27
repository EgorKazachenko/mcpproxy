import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const CODE_PATHS = ['packages'];
export const HARNESS_PATHS = ['.github/workflows', '.claude/skills/vibe-code-developing-v2/scripts', '.claude/hooks'];
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const MAX_LOG_LINE = 1024;

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function repoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: SKILL_DIR,
    encoding: 'utf8',
  }).trim();
}

export const git = (args, input) =>
  execFileSync('git', args, { cwd: repoRoot(), encoding: 'utf8', input, stdio: ['pipe','pipe','ignore'] }).trim();

export function codeTree() {
  const listing = git(['ls-tree', 'HEAD', '--', ...CODE_PATHS]);
  const hash = git(['hash-object', '--stdin'], listing);
  if (hash === EMPTY_BLOB) {
    throw new Error('codeTree resolved to the empty blob — pathspecs matched nothing, refusing to proceed');
  }
  return hash;
}

export const codeDirty = () => git(['status', '--porcelain', '--', ...CODE_PATHS]).length > 0;

export const headSha = () => git(['rev-parse', 'HEAD']);

export const filesBetween = (from, to) => {
  try {
    return git(['diff', '--name-only', `${from}${to === 'HEAD' ? '..' : '...'}${to}`, '--', ...CODE_PATHS, ...HARNESS_PATHS])
      .split('\n').filter(Boolean);
  } catch {
    return null;
  }
};

export const filesChangedSince = (sha) => filesBetween(sha, 'HEAD');

export const anchors = () => ({ codeTree: codeTree(), codeDirty: codeDirty(), headSha: headSha() });

export const planPath = (featureDir) => join(featureDir, 'plan.md');

export const planDirty = (featureDir) =>
  git(['status', '--porcelain', '--', planPath(featureDir)]).length > 0;

export function docHash(featureDir, file) {
  const rel = join(featureDir, file);
  if (!existsSync(join(repoRoot(), rel))) return null;
  const hash = git(['hash-object', '--', rel]);
  return !hash || hash === EMPTY_BLOB ? null : hash;
}

export const planHash = (featureDir) => docHash(featureDir, 'plan.md');

export function currentBranch() {
  const fromCi = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (fromCi) return fromCi;
  try {
    const symbolic = git(['symbolic-ref', '--short', 'HEAD']);
    if (symbolic) return symbolic;
  } catch { /* detached HEAD — fall through to the branches pointing at it */ }
  try {
    const pointing = git(['branch', '--points-at', 'HEAD', '--format=%(refname:short)'])
      .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('('));
    if (pointing[0]) return pointing[0];
  } catch { /* no branch points here */ }
  return 'HEAD';
}


export function detachedHead() {
  try {
    return !git(['symbolic-ref', '--short', 'HEAD']);
  } catch {
    return true;
  }
}

export function guardAnswer() {
  const hookPath = join(repoRoot(), '.claude', 'hooks', 'vibe-hooks.sh');
  const logicPath = join(repoRoot(), '.claude', 'hooks', 'vibe-guard.mjs');
  if (!existsSync(hookPath) || !existsSync(logicPath)) return null;
  const probe = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: repoRoot(),
    tool_input: { command: 'gh pr merge 1' },
  });
  return execFileSync('bash', [hookPath], { input: probe, encoding: 'utf8' });
}

export const changedFiles = (base) =>
  git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);

const resolves = (ref) => {
  try {
    return Boolean(git(['rev-parse', '--verify', `${ref}^{commit}`]));
  } catch {
    return false;
  }
};

const isAncestor = (older, newer) => {
  try {
    git(['merge-base', '--is-ancestor', older, newer]);
    return true;
  } catch {
    return false;
  }
};

export function diffBase(run) {
  const recorded = run?.baseSha && resolves(run.baseSha) ? run.baseSha : null;
  let live = null;
  try {
    live = git(['merge-base', 'origin/main', 'HEAD']);
  } catch {
    return recorded ?? 'HEAD';
  }
  if (!recorded) return live;
  if (isAncestor(recorded, live) || isAncestor(live, recorded)) return live;
  return recorded;
}

export const gatesDir = (featureDir) => join(repoRoot(), featureDir, '.gates');

export function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export const readReceipt = (featureDir, name) => readJson(join(gatesDir(featureDir), `${name}.json`));

export const writeReceipt = (featureDir, receipt) =>
  writeJson(join(gatesDir(featureDir), `${receipt.gate}.json`), receipt);

export const readRun = (featureDir) => readJson(join(gatesDir(featureDir), 'run.json'));

function monthlyLogPath(now) {
  const month = now.toISOString().slice(0, 7);
  return join(homedir(), '.claude', 'harness-logs', `${month}.jsonl`);
}

export function logEvent(event) {
  const now = new Date();
  const path = monthlyLogPath(now);
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify({ ts: now.toISOString(), ...event });
  appendFileSync(path, `${line.slice(0, MAX_LOG_LINE)}\n`);
}

export function expandBraces(path) {
  const match = /^(.*?)\{([^{}]+)\}(.*)$/.exec(path);
  if (!match) return [path];
  const [, head, options, tail] = match;
  return options.split(',').flatMap((option) => expandBraces(`${head}${option.trim()}${tail}`));
}

export function manifest(paths, startedAt) {
  const root = repoRoot();
  const entries = [];
  for (const rel of paths) {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) continue;
    const walk = (p) => {
      const st = statSync(p);
      if (st.isDirectory()) { for (const child of readdirSync(p)) walk(join(p, child)); return; }
      if (st.mtimeMs + 1 < startedAt) return;
      // WHY: evidence may live OUTSIDE the repo by design (an output folder survives teardown), and a blind
      // slice of root.length mangles every such path into one ship-lint can never resolve.
      // A `..` path stays absolute: relative() would encode this checkout's DEPTH, so the same
      // receipt read one directory up resolves to a different, plausible-looking folder and lies.
      const rel = relative(root, p);
      entries.push({
        path: rel.startsWith('..') ? p : rel,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
      });
    };
    walk(abs);
  }
  return entries;
}
