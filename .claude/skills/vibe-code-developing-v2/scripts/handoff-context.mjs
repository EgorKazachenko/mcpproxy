import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentBranch, gatesDir, git, readJson, repoRoot } from './gates-lib.mjs';

const silent = () => process.exit(0);

const RECENT_HANDOFF_MS = 24 * 60 * 60 * 1000;
const OTHERS_SHOWN = 4;
const CLAIM_TTL_MS = 12 * 60 * 60 * 1000;
const WORKING_NOW_MS = 30 * 60 * 1000;

const CLAIMS = join(homedir(), '.claude', 'harness-logs', 'claims');
const claimFile = (branch) => join(CLAIMS, `${branch.replace(/[^A-Za-z0-9._-]/g, '_')}-${createHash('sha1').update(branch).digest('hex').slice(0, 8)}.json`);

function owningSession() {
  let pid = process.ppid;
  for (let hop = 0; hop < 8 && pid > 1; hop += 1) {
    let line;
    try {
      line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) return null;
    if (/claude/i.test(match[2])) return pid;
    pid = Number(match[1]);
  }
  return null;
}

const ME = owningSession();

function safeJson(path) {
  try {
    return readJson(path);
  } catch {
    return null;
  }
}

function sessionAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    return /claude/i.test(execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (err) {
    return err.status === null;
  }
}

function heldByAnotherSession(branch) {
  const claim = safeJson(claimFile(branch));
  if (!claim?.at) return false;
  if (ME !== null && claim.owner === ME) return false;
  if (sessionAlive(claim.owner)) return true;
  return Date.now() - claim.at < CLAIM_TTL_MS && claim.owner === undefined;
}

function editedMomentsAgo(worktree) {
  try {
    const changed = git(['-C', worktree, '-c', 'core.quotepath=false', 'status', '--porcelain', '-z'])
      .split('\0').filter(Boolean)
      .filter((entry) => /^[ MADRCU?!]{2} /.test(entry))
      .map((entry) => entry.slice(3));
    return changed.some((rel) => {
      try {
        return Date.now() - statSync(join(worktree, rel)).mtimeMs < WORKING_NOW_MS;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function writeClaim(branch) {
  if (ME === null) return;
  const staging = `${claimFile(branch)}.${process.pid}.tmp`;
  mkdirSync(CLAIMS, { recursive: true });
  writeFileSync(staging, JSON.stringify({ branch, at: Date.now(), owner: ME }));
  renameSync(staging, claimFile(branch));
}

function stakeClaim(branch) {
  if (ME === null) return true;
  try {
    mkdirSync(CLAIMS, { recursive: true });
    const fd = openSync(claimFile(branch), 'wx');
    writeSync(fd, JSON.stringify({ branch, at: Date.now(), owner: ME }));
    closeSync(fd);
    return true;
  } catch {
    if (heldByAnotherSession(branch)) return false;
    try {
      writeClaim(branch);
      return true;
    } catch {
      return false;
    }
  }
}

function dropExpiredClaims() {
  try {
    for (const name of readdirSync(CLAIMS)) {
      if (!name.endsWith('.json')) continue;
      const path = join(CLAIMS, name);
      const claim = safeJson(path);
      if (claim?.owner !== undefined && sessionAlive(claim.owner)) continue;
      if (!claim?.at || Date.now() - claim.at >= CLAIM_TTL_MS) rmSync(path, { force: true });
    }
  } catch { /* no claims directory yet */ }
}

function siblingWorktreeRuns(root) {
  const entries = [];
  let path = null;
  let branch = null;
  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) { path = line.slice(9).trim(); branch = null; }
    if (line.startsWith('branch ')) branch = line.slice(7).trim().replace('refs/heads/', '');
    if (!line.trim() && path) { entries.push({ path, branch }); path = null; branch = null; }
  }
  if (path) entries.push({ path, branch });

  const waiting = [];
  for (const entry of entries) {
    if (entry.path === root || !entry.branch?.startsWith('v2/')) continue;
    const base = join(entry.path, 'docs', 'vibe-coding');
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name, '.gates');
      const handoff = join(dir, 'handoff.json');
      if (!existsSync(handoff)) continue;
      const run = safeJson(join(dir, 'run.json'));
      if (!run || run.closed || run.branch !== entry.branch) continue;
      waiting.push({
        ...entry,
        bundle: join('docs', 'vibe-coding', name),
        at: statSync(handoff).mtimeMs,
        task: safeJson(handoff)?.initialUserMessage ?? null,
      });
    }
  }
  return waiting.sort((a, b) => b.at - a.at);
}

function pointElsewhere(root, branch) {
  let waiting = [];
  try {
    waiting = siblingWorktreeRuns(root);
  } catch {
    silent();
  }
  dropExpiredClaims();
  const stale = waiting.filter((one) => Date.now() - one.at > RECENT_HANDOFF_MS);
  waiting = waiting.filter((one) => Date.now() - one.at <= RECENT_HANDOFF_MS);
  if (!waiting.length) silent();

  const taken = [];
  const free = [];
  for (const one of waiting) {
    const claimed = heldByAnotherSession(one.branch);
    const editing = !claimed && editedMomentsAgo(one.path);
    if (claimed || editing) taken.push({ ...one, why: claimed ? 'claimed' : 'edited minutes ago' });
    else free.push(one);
  }

  const latest = free.find((one) => stakeClaim(one.branch));
  if (!latest) {
    process.stdout.write(`${[
      '# vibe2 — every run handed off in the last 24h is already being worked on',
      '',
      `${waiting.length} run(s) qualify and every one is taken. Two sessions writing one worktree lose`,
      'work, so **do not pick one of these on your own.**',
      '',
      ...taken.map((one) => `    ${one.bundle}  ·  ${one.why}  ·  ${one.path}`),
      ...(stale.length ? ['', `(${stale.length} further run(s) were handed off more than 24h ago and are not offered.)`] : []),
      '',
      'Ask the owner what to work on. A run marked `claimed` frees up by deleting its file under',
      '`~/.claude/harness-logs/claims/`; one marked `edited minutes ago` has a live session in its tree —',
      'deleting a claim will not change that, so confirm that session is gone before touching it.',
    ].join('\n')}\n`);
    process.exit(0);
  }

  const older = free.filter((one) => one !== latest);
  const hours = Math.max(1, Math.round((Date.now() - latest.at) / 3_600_000));
  process.stdout.write(`${[
    '# vibe2 — you handed a run off, but this is not the checkout that carries it',
    '',
    `This session opened in \`${root}\` on branch \`${branch}\`, where no run lives, so nothing was`,
    `injected. A run was handed off ${hours}h ago from another worktree:`,
    '',
    `**\`${latest.bundle}\`** \u00b7 branch \`${latest.branch}\``,
    '',
    '**Move yourself there, now, without asking.** Your FIRST Bash command:',
    '',
    `    cd ${latest.path}`,
    '',
    "The Bash tool's working directory persists, so every later command lands in the right checkout.",
    '(`EnterWorktree` errors once you are already inside it \u2014 plain `cd` is the move.) Nobody has to',
    'open a new session: `/clear` resets the process to the directory it was launched from, which is',
    'why you are here, and a `cd` is the whole remedy. Do NOT start the work from this checkout \u2014 every',
    'write creates the path it needs, so the bundle would fork here, and a bundle with no run behind it',
    'is exactly what silences this injection next time.',
    '',
    ...(ME === null
      ? ['This session could not identify itself, so **no claim was recorded** — another session clearing',
        'right now may be sent to the same worktree. Check `git status` there before you write anything.']
      : ['This run is now **claimed for you** (`~/.claude/harness-logs/claims/`), keyed to this session, so a',
        'DIFFERENT session starting after you is not sent here and your own next `/clear` still recognises it',
        'as yours. The claim is not proof the tree is empty: if `git status` there shows work you did not do,',
        'or a file changes while you read this, **another session is inside — stop and tell the owner.**']),
    ...(latest.task ? ['', 'Then carry out exactly this:', '', latest.task] : []),
    ...(older.length ? ['', `**${older.length} other free run(s) are also waiting.** The one above is simply the most recent —`,
      'if the owner named a different feature, `cd` to its worktree instead:', '',
      ...older.slice(0, OTHERS_SHOWN).map((one) => `    ${one.bundle}  →  cd ${one.path}`),
      ...(older.length > OTHERS_SHOWN ? [`    …and ${older.length - OTHERS_SHOWN} more — \`git worktree list\``] : [])] : []),
    ...(taken.length ? ['', `**${taken.length} further run(s) are taken** — claimed, or edited in the last 30 minutes. Not yours to pick up.`] : []),
  ].join('\n')}\n`);
  process.exit(0);
}

let root;
let branch;
try {
  root = repoRoot();
  branch = currentBranch();
} catch {
  silent();
}

const base = join(root, 'docs', 'vibe-coding');
if (!existsSync(base)) silent();

const feature = readdirSync(base).sort()
  .map((entry) => join('docs', 'vibe-coding', entry))
  .find((rel) => {
    const run = safeJson(join(root, rel, '.gates', 'run.json'));
    return run && !run.closed && run.branch === branch;
  });
if (!feature) pointElsewhere(root, branch);

try { writeClaim(branch); } catch { /* a session already inside its worktree still works without a claim */ }

const run = safeJson(join(gatesDir(feature), 'run.json'));
const handoff = safeJson(join(gatesDir(feature), 'handoff.json'));
if (!handoff?.initialUserMessage) silent();

const receipts = readdirSync(gatesDir(feature))
  .filter((f) => f.endsWith('.json') && f !== 'run.json' && f !== 'handoff.json')
  .map((f) => ({ name: f.replace(/\.json$/, ''), receipt: safeJson(join(gatesDir(feature), f)) }));
const notPassing = receipts.filter(({ receipt }) => receipt?.status !== 'pass').map(({ name }) => name);

const shipping = handoff.stage === 'ship';

process.stdout.write(`${[
  shipping
    ? '# vibe2 — the code is written and committed; what is left here is phase 4'
    : '# vibe2 — an approved plan is waiting here, and the run is not finished',
  '',
  `Bundle \`${feature}\` · branch \`${branch}\` · track ${run.track ?? 'full'} · worktree \`${root}\``,
  ...(shipping ? [`Read \`${feature}/handoff-notes.md\` FIRST — the session that wrote the code left its own`,
    'account there of where it diverged from the plan and what it left owed. The diff will not tell you that.'] : []),
  receipts.length === 0
    ? 'No gate has run yet.'
    : notPassing.length
      ? `Receipts not passing: ${notPassing.join(', ')}`
      : `${receipts.length} receipt(s) passing — check what else is derived before assuming it is done.`,
  '',
  '**Do not open with questions and do not re-plan.** This is a resumed run, not a new one. Read the',
  "bundle's `spec.md`, `plan.md` and `status.md`, then carry out exactly this:",
  '',
  handoff.initialUserMessage,
  '',
  'What is still owed: `node .claude/skills/vibe-code-developing-v2/scripts/ship-lint.mjs --human`',
].join('\n')}\n`);
