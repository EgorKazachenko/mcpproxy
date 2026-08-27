import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHIP_LINT = '.claude/skills/vibe-code-developing-v2/scripts/ship-lint.mjs';
const DENY_HINT = 'run: node .claude/skills/vibe-code-developing-v2/scripts/ship-lint.mjs';

const allow = () => process.exit(0);
const deny = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};

const readStdin = () => {
  try {
    return JSON.parse(execFileSync('cat', [], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
};

const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

function featureRun(root, branch) {
  const base = join(root, 'docs', 'vibe-coding');
  if (!existsSync(base)) return false;
  return readdirSync(base).some((entry) => {
    const path = join(base, entry, '.gates', 'run.json');
    if (!existsSync(path)) return false;
    try {
      const run = JSON.parse(readFileSync(path, 'utf8'));
      return !run.closed && run.branch === branch;
    } catch {
      return false;
    }
  });
}

// A path is only this run's business when it belongs to this checkout. Worktrees live UNDER the
// main checkout, so a substring match denies edits to a sibling worktree's copy of the harness —
// which is where harness development legitimately happens.
function belongsToThisCheckout(filePath, root) {
  let dir = filePath;
  for (let depth = 0; depth < 40; depth += 1) {
    dir = dirname(dir);
    if (existsSync(dir)) break;
    if (dir === dirname(dir)) return false;
  }
  return git(['rev-parse', '--show-toplevel'], dir) === root;
}

const input = readStdin();
if (!input) allow();

const cwd = input.cwd || process.cwd();
const root = git(['rev-parse', '--show-toplevel'], cwd);
if (!root) allow();

if (input.hook_event_name === 'SessionStart') {
  const script = join(root, '.claude', 'skills', 'vibe-code-developing-v2', 'scripts', 'handoff-context.mjs');
  if (existsSync(script)) {
    try {
      process.stdout.write(execFileSync('node', [script], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch { /* a resumed run is a convenience, never a reason to fail a session start */ }
  }
  process.exit(0);
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
const inFeatureRun = featureRun(root, branch);
const gatedBranch = branch.startsWith('v2/');

const tool = input.tool_name || '';
const ti = input.tool_input || {};

// These two hold on EVERY branch, gated or not. They used to sit below the early allow(), which
// made them unreachable on the ungated lite route - exactly the route whose whole safety story is
// "the owner reads the diff and merges it himself". A self-merge or a --no-verify commit there had
// nothing standing in its way, and both denies cost nothing on ordinary work.
if (tool === 'Bash') {
  const guarded = String(ti.command || '').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  if (!/^\s*(grep|rg|ag)\b/.test(String(ti.command || ''))) {
    if (/gh\s+pr\s+merge/.test(guarded) || /gh\s+api[^|;]*\/pulls\/\d+\/merge/.test(guarded)) {
      deny('vibe2: the workflow never merges - merging is the owner decision');
    }
    if (/--no-verify|(^|\s)SKIP=/.test(guarded)) {
      deny('vibe2: verification bypass flags are not allowed - fix the hook, do not skip it');
    }
  }
}

if (!inFeatureRun && !gatedBranch) allow();

if (tool === 'Bash') {
  const raw = String(ti.command || '');
  // Text inside quotes is data, not an invocation: a commit message or a grep pattern that
  // merely mentions a forbidden command must not trip the guard. Strip quoted runs first.
  const cmd = raw.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  if (/^\s*(grep|rg|ag)\b/.test(raw)) allow();

  if (/gh\s+pr\s+create|gh\s+api[^|;]*\/pulls/.test(cmd)) {
    if (!existsSync(join(root, SHIP_LINT))) {
      deny('vibe2: ship-lint.mjs is missing - refusing to open a PR the harness cannot check');
    }
    try {
      const out = execFileSync('node', [SHIP_LINT, '--at-ship-attempt'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const lines = String(out).split('\n');
      const notes = lines.filter((line, i) => line.startsWith('! [')
        || (line.trim() && i > 0 && /^\s/.test(line) && lines.slice(0, i).some((p) => p.startsWith('! ['))));
      if (notes.length) process.stdout.write(JSON.stringify({ systemMessage: notes.join('\n') }));
      process.exit(0);
    } catch {
      deny(`vibe2: gate not satisfied - ${DENY_HINT}`);
    }
  }

  if (/claude\s+-p[^|;]*--settings/.test(cmd)) {
    deny('vibe2: a spawned carrier may not override --settings');
  }

  if (inFeatureRun) {
    const writesTo = (target) =>
      new RegExp(`(>>?\\s*"?[^"|;\\s]*${target}|sed\\s+-i[^|;]*${target}|tee\\s+[^|;]*${target}|git\\s+(checkout\\s+--|restore)\\s+[^|;]*${target})`)
        .test(cmd);
    if (writesTo('\\.gates/')) deny('vibe2: receipts are written by gate-run, never by hand');
    if (writesTo('gates\\.yml')) deny('vibe2: the CI gate workflow may not be edited from inside a gated run');
    if (writesTo('\\.claude/hooks/')) deny('vibe2: the guard may not be edited from inside a gated run');
  }
  allow();
}

if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  if (!inFeatureRun) allow();
  const path = String(ti.file_path || ti.notebook_path || '');
  if (/\/\.gates\//.test(path) && belongsToThisCheckout(path, root)) {
    deny('vibe2: receipts are written by gate-run, never by hand');
  }
  if (/vibe-code-developing-v2\/scripts\//.test(path) && belongsToThisCheckout(path, root)) {
    deny('vibe2: gate scripts may not be edited from inside a gated run');
  }
  if (/\.claude\/hooks\//.test(path) && belongsToThisCheckout(path, root)) {
    deny('vibe2: the guard may not be edited from inside a gated run');
  }
  if (/\.github\/workflows\/gates\.yml$/.test(path)) deny('vibe2: the CI gate workflow may not be edited from inside a gated run');
  if (/\.claude\/settings(\.local)?\.json$/.test(path)) deny('vibe2: settings may not be edited from inside a gated run');
  allow();
}

allow();
