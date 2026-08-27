#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const FENCE_RE = /^```/;
const ANCHOR_RE = /`([A-Za-z0-9_./@-]+\.[A-Za-z0-9]+):(\d+)(?:[-–:](\d+))?`/g;
const PATH_IN_BACKTICKS_RE = /`((?:packages|docs|scripts)\/[A-Za-z0-9_./@-]+\.[A-Za-z0-9]+)`/g;
const FILES_LINE_RE = /^\s*[-*]?\s*(Create|Modify|Test|Delete):\s*`?([A-Za-z0-9_./@-]+)`?/i;
const FILES_HEADER_RE = /^\s*[-*]?\s*\*{0,2}Files:?\*{0,2}\s*(.*)$/i;
const TASK_HEADING_RE = /^#{1,4}\s+(?:\*\*)?Task\s+([0-9]+[a-z]?)/i;
const STALE_BASE_FAIL_AT = 25;
const CALL_RE = /\b([a-z][A-Za-z0-9_]{3,})\s*\(/g;
const DEFINED_RE = /(?:function|const|let|var|class|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?\(/g;
const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from/g;
const TEST_CMD_RE = /(?:npx\s+)?vitest\s+run\s+([^\n|&;]+)/g;
const COMMENT_RE = /^\s*\/\/(?!\s*eslint|\s*@ts-)/;
const RN_RE = /\bR([0-9]{1,2})\b/g;
const WORKSPACES = ['packages'];

const BACKTICK_RE = /`([^`]+)`/g;
const SHORT_ANCHOR_RE = /`:(\d+)(?:[-–](\d+))?`/g;
const PREFLIGHT_RE = /^#{2,3}\s+(?:\*\*)?Pre-?flight/i;
const NUMBERED_HEADING_RE = /^#{2,4}\s+(?:\*\*)?(\d+)\.\s/;
const TOP_HEADING_RE = /^##\s+/;
const COUNTED_NOUNS = 'call sites?|callers?|consumers?|readers?|usages?|use sites?|hits?|sites?|files?|tests?|test files?|places?|surfaces?|branches?|arms?|members?';
const NUMBER_WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
]);
const ORDINAL_CONTEXT = 'task|step|round|phase|week|day|part|section|figure|note|line|R';
const COUNT_CLAIM_RE = new RegExp(
  `(?<!\\b(?:${ORDINAL_CONTEXT})\\s)\\b(${[...NUMBER_WORDS.keys()].join('|')}|\\d{1,2})\\s+(${COUNTED_NOUNS})\\b`,
  'gi',
);
const CONSUMER_SEARCH_ROOTS = ['packages'];
const QUOTE_MIN_LENGTH = 10;
const QUOTE_FRAGMENT_MIN_LENGTH = 6;
const ANCHOR_DRIFT_TOLERANCE = 3;
const AMBIENT_SYMBOL_THRESHOLD = 10;

const BUILTIN_CALLS = new Set([
  'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
  'vi', 'fn', 'mock', 'spyOn', 'console', 'log', 'warn', 'error', 'info', 'debug',
  'require', 'import', 'then', 'catch', 'finally', 'map', 'filter', 'reduce', 'forEach',
  'find', 'findIndex', 'some', 'every', 'sort', 'slice', 'splice', 'concat', 'join',
  'push', 'pop', 'shift', 'unshift', 'includes', 'indexOf', 'keys', 'values', 'entries',
  'toBe', 'toEqual', 'toContain', 'toThrow', 'toHaveBeenCalled', 'toHaveBeenCalledWith',
  'toMatchObject', 'toBeDefined', 'toBeUndefined', 'toBeNull', 'toBeTruthy', 'toBeFalsy',
  'toHaveLength', 'toBeCloseTo', 'toBeGreaterThan', 'toBeLessThan', 'resolves', 'rejects',
  'useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useContext', 'useReducer',
  'render', 'screen', 'fireEvent', 'waitFor', 'within', 'cleanup', 'act',
  'parse', 'stringify', 'assign', 'freeze', 'round', 'floor', 'ceil', 'abs', 'min', 'max',
  'toString', 'toFixed', 'trim', 'split', 'replace', 'match', 'startsWith',
  'endsWith', 'padStart', 'padEnd', 'toLowerCase', 'toUpperCase', 'charAt', 'substring',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch',
  'all', 'allSettled', 'race', 'resolve', 'reject', 'from', 'of', 'isArray',
  'getTime', 'getDate', 'setDate', 'now', 'valueOf', 'hasOwnProperty',
  'type', 'select', 'populate', 'lean', 'exec', 'save', 'toObject', 'aggregate',
  'status', 'send', 'json', 'code', 'inject', 'register', 'get', 'post', 'put', 'patch',
  'delete', 'add', 'has', 'set', 'clear', 'next', 'done', 'call', 'apply', 'bind',
]);

const results = [];
const report = (level, check, message) => results.push({ level, check, message });

let basenameIndexCache = null;
function basenameIndex() {
  if (basenameIndexCache) return basenameIndexCache;
  const out = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const index = new Map();
  for (const rel of out.split('\n')) {
    if (!rel) continue;
    const key = basename(rel);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(rel);
  }
  basenameIndexCache = index;
  return index;
}

const hitsFor = (rel) => basenameIndex().get(basename(rel)) ?? [];
const locateByBasename = (rel) => (hitsFor(rel).length ? ` — basename found at ${hitsFor(rel)[0]}` : '');

function resolveRepoPath(rel) {
  if (existsSync(join(REPO_ROOT, rel))) return [rel];
  const hits = hitsFor(rel);
  const suffixHits = hits.filter((p) => p.endsWith(rel));
  return suffixHits.length ? suffixHits : hits;
}

const isDependencyPath = (rel) => rel.startsWith('@') || rel.includes('node_modules') || rel.startsWith('~/');

function findInDependencies(rel) {
  const tail = rel.split('node_modules/').pop();
  for (const workspace of WORKSPACES) {
    if (existsSync(join(REPO_ROOT, workspace, 'node_modules', tail))) return true;
  }
  return false;
}

function countLines(rel) {
  try {
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const lines = text.split('\n');
    return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  } catch {
    return 0;
  }
}

function fenceBlocks(text) {
  const blocks = [];
  let current = null;
  text.split('\n').forEach((line, index) => {
    const lineno = index + 1;
    if (FENCE_RE.test(line)) {
      if (current) {
        blocks.push(current);
        current = null;
      } else {
        current = { lines: [] };
      }
      return;
    }
    if (current) current.lines.push({ lineno, line });
  });
  return blocks;
}

function proseLines(text) {
  const out = [];
  let inside = false;
  text.split('\n').forEach((line, index) => {
    if (FENCE_RE.test(line)) {
      inside = !inside;
      return;
    }
    if (!inside) out.push({ lineno: index + 1, line });
  });
  return out;
}

function collectCreatedPaths(text) {
  const created = new Set();
  for (const { line } of proseLines(text)) {
    const match = FILES_LINE_RE.exec(line);
    if (match && ['create', 'test'].includes(match[1].toLowerCase())) created.add(match[2].split(':')[0]);
  }
  return created;
}

function checkAnchors(text, createdByPlan) {
  const seen = new Set();
  for (const match of text.matchAll(ANCHOR_RE)) {
    const [, rel, startRaw, endRaw] = match;
    const key = `${rel}:${startRaw}:${endRaw ?? ''}`;
    if (seen.has(key) || rel.includes('...') || createdByPlan.has(rel)) continue;
    seen.add(key);
    const highest = Number(endRaw ?? startRaw);
    if (isDependencyPath(rel)) {
      if (!findInDependencies(rel)) {
        report('WARN', 'anchor', `\`${rel}:${startRaw}\` — dependency file not found under any node_modules (version drift?)`);
      }
      continue;
    }
    const matches = resolveRepoPath(rel);
    if (!matches.length) {
      report('FAIL', 'anchor', `\`${rel}:${startRaw}\` — no such file is tracked in the repo`);
      continue;
    }
    const counts = matches.map(countLines);
    if (counts.every((count) => highest > count)) {
      const where = matches.length === 1 ? matches[0] : `${matches.length} candidates, longest ${Math.max(...counts)} lines`;
      report('FAIL', 'anchor', `\`${rel}:${highest}\` — out of range (${where})`);
    }
  }
}

function checkDeclaredPaths(text, createdByPlan) {
  for (const { lineno, line } of proseLines(text)) {
    const match = FILES_LINE_RE.exec(line);
    if (!match) continue;
    const kind = match[1].toLowerCase();
    const rel = match[2].split(':')[0];
    if (!/^(client|server|shared|mobile|docs|scripts|\.github|\.claude)\//.test(rel) || rel.includes('...')) continue;
    const exists = existsSync(join(REPO_ROOT, rel));
    if (['modify', 'delete'].includes(kind) && !exists && !createdByPlan.has(rel)) {
      report('FAIL', 'files', `line ${lineno}: Modify/Delete target \`${rel}\` does not exist${locateByBasename(rel)}`);
    }
    if (kind === 'create' && exists) {
      report('FAIL', 'files', `line ${lineno}: Create target \`${rel}\` already exists`);
    }
  }
}

function checkBacktickPaths(text, createdByPlan) {
  const reported = new Set();
  for (const { lineno, line } of proseLines(text)) {
    for (const match of line.matchAll(PATH_IN_BACKTICKS_RE)) {
      const rel = match[1];
      if (reported.has(rel) || createdByPlan.has(rel) || rel.includes('...') || resolveRepoPath(rel).length) continue;
      reported.add(rel);
      const hits = hitsFor(rel);
      if (hits.length) {
        report('FAIL', 'path', `line ${lineno}: \`${rel}\` does not exist — real path is ${hits[0]}`);
      } else {
        report('WARN', 'path', `line ${lineno}: \`${rel}\` does not exist and no file with that basename is tracked (new file?)`);
      }
    }
  }
}

function checkFenceComments(text) {
  for (const block of fenceBlocks(text)) {
    for (const { lineno, line } of block.lines) {
      if (COMMENT_RE.test(line)) {
        report('FAIL', 'comments', `line ${lineno}: comment inside a code fence — \`${line.trim().slice(0, 60)}\``);
      }
    }
  }
}

function collectDefinedSymbols(text) {
  const defined = new Set();
  for (const block of fenceBlocks(text)) {
    for (const { line } of block.lines) {
      for (const match of line.matchAll(DEFINED_RE)) defined.add(match[1] ?? match[2]);
      for (const match of line.matchAll(IMPORT_RE)) {
        for (const raw of match[1].split(',')) {
          const cleaned = raw.split(' as ').pop().trim().replace(/[{}]/g, '').trim();
          if (cleaned) defined.add(cleaned);
        }
      }
    }
  }
  defined.delete(undefined);
  return defined;
}

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|swift|kt)$/;

function symbolsPresentInRepo(names) {
  if (!names.length) return new Set();
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort();
  const scanner = new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');
  const found = new Set();
  const remaining = new Set(names);
  for (const [, paths] of basenameIndex()) {
    for (const rel of paths) {
      if (!remaining.size) return found;
      if (!SOURCE_EXT_RE.test(rel) || rel.includes('/dist/')) continue;
      let text;
      try {
        text = readFileSync(join(REPO_ROOT, rel), 'utf8');
      } catch {
        continue;
      }
      scanner.lastIndex = 0;
      for (const match of text.matchAll(scanner)) {
        found.add(match[1]);
        remaining.delete(match[1]);
      }
    }
  }
  return found;
}

function checkUnreadSymbols(text, strict) {
  const defined = collectDefinedSymbols(text);
  const candidates = new Map();
  for (const block of fenceBlocks(text)) {
    for (const { lineno, line } of block.lines) {
      for (const match of line.matchAll(CALL_RE)) {
        const name = match[1];
        if (BUILTIN_CALLS.has(name) || defined.has(name) || name.length < 5 || candidates.has(name)) continue;
        candidates.set(name, lineno);
      }
    }
  }
  const present = symbolsPresentInRepo([...candidates.keys()]);
  if (!present) return;
  for (const [name, lineno] of [...candidates].sort((a, b) => a[1] - b[1])) {
    if (present.has(name)) continue;
    report(strict ? 'FAIL' : 'WARN', 'symbol', `line ${lineno}: \`${name}()\` is called but exists nowhere in the repo and is not defined by this plan`);
  }
}

function vitestBinary(workspace) {
  const local = join(REPO_ROOT, workspace, 'node_modules', '.bin', 'vitest');
  return existsSync(local) ? local : null;
}

function pickWorkspace(hinted, config, positional) {
  const candidates = [hinted, ...WORKSPACES].filter(Boolean);
  for (const candidate of candidates) {
    const root = join(REPO_ROOT, candidate);
    if (config && !existsSync(join(root, config))) continue;
    const anyPathExists = positional.some((p) => {
      const cleaned = p.replace(/^\.\//, '');
      if (existsSync(join(root, cleaned))) return true;
      try {
        return statSync(join(root, dirname(cleaned))).isDirectory();
      } catch {
        return false;
      }
    });
    if (anyPathExists) return candidate;
  }
  return hinted ?? (config ? 'server' : 'client');
}

function resolveVitestFilter(workspace, config, positional) {
  const binary = vitestBinary(workspace);
  if (!binary) return { files: [], skipped: `no vitest binary in ${workspace}/node_modules` };
  const args = ['list', '--filesOnly'];
  if (config) args.push('--config', config);
  args.push(...positional);
  try {
    const out = execFileSync(binary, args, {
      cwd: join(REPO_ROOT, workspace),
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { files: out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('>')) };
  } catch (error) {
    if (typeof error.stdout === 'string') {
      const files = error.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('>'));
      if (files.length) return { files };
    }
    return { files: [] };
  }
}

function checkTestCommands(text) {
  for (const block of fenceBlocks(text)) {
    const joined = block.lines.map(({ line }) => line).join('\n');
    for (const match of joined.matchAll(TEST_CMD_RE)) {
      const rest = match[1].split('2>')[0].trim();
      const cds = [...joined.slice(0, match.index).matchAll(/cd\s+(client|server|shared|mobile)\b/g)];
      let workspace = cds.length ? cds[cds.length - 1][1] : null;
      const tokens = rest.split(/\s+/).filter(Boolean);
      let config = null;
      let positional = [];
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--config') {
          config = tokens[index + 1] ?? null;
          index += 1;
        } else if (token.startsWith('--config=')) {
          config = token.split('=')[1];
        } else if (!token.startsWith('-')) {
          positional.push(token);
        }
      }
      if (!positional.length) continue;
      for (const candidate of WORKSPACES) {
        if (positional[0].startsWith(`${candidate}/`)) {
          workspace = candidate;
          // WHY: per element — a second path outside the matched workspace keeps its own prefix,
          // and slicing it by this workspace's length silently mangles it into a path that resolves nowhere.
          positional = positional.map((p) => (p.startsWith(`${candidate}/`) ? p.slice(candidate.length + 1) : p));
          break;
        }
      }
      workspace = pickWorkspace(workspace, config, positional);
      const { files, skipped } = resolveVitestFilter(workspace, config, positional);
      if (skipped) {
        report('WARN', 'testcmd', `\`vitest run ${rest}\` not resolved: ${skipped}`);
      } else if (!files.length) {
        report('FAIL', 'testcmd', `\`vitest run ${rest}\` resolves to 0 test files (a filter matching nothing still exits 0)`);
      } else {
        report('INFO', 'testcmd', `\`vitest run ${rest}\` → ${files.length} file(s)`);
      }
    }
  }
}

function checkRequirements(specText, planText) {
  if (!specText) {
    report('WARN', 'coverage', 'no spec.md in the bundle — requirement coverage not checked');
    return;
  }
  const specRn = new Set([...specText.matchAll(RN_RE)].map((m) => Number(m[1])));
  if (!specRn.size) {
    report('WARN', 'coverage', 'spec.md declares no R<n> requirements');
    return;
  }
  const planRn = new Set([...planText.matchAll(RN_RE)].map((m) => Number(m[1])));
  const missing = [...specRn].filter((n) => !planRn.has(n)).sort((a, b) => a - b);
  if (missing.length) {
    report('FAIL', 'coverage', `spec requirements never mentioned in plan.md: ${missing.map((n) => `R${n}`).join(', ')}`);
  }
}

const normalizeSpace = (value) => value.replace(/\s+/g, ' ').trim();

const fileLinesCache = new Map();
function normalizedFileLines(rel) {
  if (fileLinesCache.has(rel)) return fileLinesCache.get(rel);
  let lines = null;
  try {
    lines = readFileSync(join(REPO_ROOT, rel), 'utf8').split('\n').map(normalizeSpace);
  } catch {
    lines = null;
  }
  fileLinesCache.set(rel, lines);
  return lines;
}

function preflightBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => PREFLIGHT_RE.test(line));
  if (start === -1) return [];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (TOP_HEADING_RE.test(lines[index]) && !NUMBERED_HEADING_RE.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).map((line, index) => ({ lineno: start + index + 1, line }));
}

function preflightSection(text, number) {
  const block = preflightBlock(text);
  const start = block.findIndex(({ line }) => Number(NUMBERED_HEADING_RE.exec(line)?.[1]) === number);
  if (start === -1) return [];
  const rest = block.slice(start + 1);
  const end = rest.findIndex(({ line }) => NUMBERED_HEADING_RE.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

function isQuoteLike(value) {
  if (value.length < QUOTE_MIN_LENGTH) return false;
  if (/^[A-Za-z0-9_./@-]+\.[A-Za-z0-9]+:\d+/.test(value)) return false;
  if (/^[A-Za-z0-9_./@-]+$/.test(value)) return false;
  if (/^(rg|grep|git|npx|npm|node|cd|PORT=)\b/.test(value)) return false;
  return /[ ={(:<]/.test(value);
}

function quoteFragments(quote) {
  return quote
    .split(/…|\.\.\./)
    .map(normalizeSpace)
    .filter((fragment) => fragment.length >= QUOTE_FRAGMENT_MIN_LENGTH);
}

function locateQuote(rel, fragments) {
  const lines = normalizedFileLines(rel);
  if (!lines) return { unreadable: true };
  const positions = [];
  for (const fragment of fragments) {
    const found = [];
    lines.forEach((line, index) => {
      if (line.includes(fragment)) found.push(index + 1);
    });
    if (!found.length) return { missing: fragment };
    positions.push(found);
  }
  return { at: positions[0] };
}

function quoteColumnRows(text) {
  const rows = [];
  let quoteColumn = -1;
  let headerSeen = false;
  for (const { lineno, line } of proseLines(text)) {
    if (!line.trim().startsWith('|')) {
      quoteColumn = -1;
      headerSeen = false;
      continue;
    }
    if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue;
    const cells = line.split('|').slice(1, -1);
    if (!headerSeen) {
      headerSeen = true;
      quoteColumn = cells.findIndex((cell) => /quoted?\s*(evidence)?$/i.test(cell.trim()));
      continue;
    }
    if (quoteColumn !== -1 && cells[quoteColumn]) rows.push({ lineno, line, cell: cells[quoteColumn] });
  }
  return rows;
}

function checkAnchorQuotes(text, createdByPlan) {
  for (const { lineno, line, cell } of quoteColumnRows(text)) {
    const anchors = [...line.matchAll(ANCHOR_RE)].filter(
      ([, rel]) => !rel.includes('...') && !createdByPlan.has(rel) && !isDependencyPath(rel),
    );
    if (!anchors.length) continue;
    const quotes = [...cell.matchAll(BACKTICK_RE)].map((match) => match[1]).filter(isQuoteLike);
    for (const quote of quotes) {
      const fragments = quoteFragments(quote);
      if (!fragments.length) continue;
      let best = null;
      for (const [, rel, startRaw, endRaw] of anchors) {
        const target = resolveRepoPath(rel)[0];
        if (!target) continue;
        const start = Number(startRaw);
        const end = Number(endRaw ?? startRaw);
        const found = locateQuote(target, fragments);
        if (found.unreadable) continue;
        if (found.missing) {
          best ??= { kind: 'missing', rel: target, fragment: found.missing };
          continue;
        }
        if (found.at.some((at) => at >= start && at <= end)) {
          best = { kind: 'exact' };
          break;
        }
        const drifted = found.at.find((at) => at >= start - ANCHOR_DRIFT_TOLERANCE && at <= end + ANCHOR_DRIFT_TOLERANCE);
        if (drifted) {
          best = { kind: 'drift', rel: target, at: drifted, cited: start };
          continue;
        }
        if (!best || best.kind === 'missing') best = { kind: 'elsewhere', rel: target, at: found.at[0], cited: start };
      }
      if (!best || best.kind === 'exact') continue;
      const excerpt = quote.length > 70 ? `${quote.slice(0, 70)}…` : quote;
      if (best.kind === 'drift') {
        report('WARN', 'quote', `line ${lineno}: anchor drifted — the quoted line is at ${best.rel}:${best.at}, cited as :${best.cited}`);
      } else if (best.kind === 'elsewhere') {
        report('FAIL', 'quote', `line ${lineno}: the quote \`${excerpt}\` is NOT at the cited anchor — it is at ${best.rel}:${best.at}`);
      } else {
        report('FAIL', 'quote', `line ${lineno}: the quote \`${excerpt}\` does not appear in ${best.rel} at all (fragment: "${best.fragment}")`);
      }
    }
  }
}

function enumeratedIn(lines) {
  const seen = new Set();
  for (const line of lines) {
    for (const match of line.matchAll(ANCHOR_RE)) seen.add(`${match[1]}:${match[2]}`);
    for (const match of line.matchAll(SHORT_ANCHOR_RE)) seen.add(`:${match[1]}`);
    for (const match of line.matchAll(PATH_IN_BACKTICKS_RE)) seen.add(match[1]);
  }
  return seen.size;
}

function checkEnumerations(text) {
  const raw = text.split('\n');
  const prose = new Set(proseLines(text).map(({ lineno }) => lineno));
  for (let index = 0; index < raw.length; index += 1) {
    const lineno = index + 1;
    const line = raw[index];
    if (!prose.has(lineno)) continue;
    if (/^\s*[-*]?\s*(Create|Modify|Test|Delete):/i.test(line)) continue;
    const window = [line];
    let fenced = false;
    let blanks = 0;
    for (let ahead = index + 1; ahead < raw.length && window.length <= 8; ahead += 1) {
      const next = raw[ahead];
      if (FENCE_RE.test(next)) {
        fenced = true;
        break;
      }
      if (/^#{2,4}\s/.test(next)) break;
      if (!next.trim()) {
        blanks += 1;
        if (blanks > 1) break;
        continue;
      }
      window.push(next);
    }
    if (fenced) continue;
    const quoted = [...line.matchAll(/"[^"]*"|«[^»]*»/g)].map((match) => [match.index, match.index + match[0].length]);
    for (const match of line.matchAll(COUNT_CLAIM_RE)) {
      if (quoted.some(([from, to]) => match.index >= from && match.index < to)) continue;
      const claimed = NUMBER_WORDS.get(match[1].toLowerCase()) ?? Number(match[1]);
      if (claimed < 2 || claimed > 40) continue;
      const found = enumeratedIn(window);
      if (found === 0) {
        report('WARN', 'enumerate', `line ${lineno}: "${match[0]}" is a categorical count with nothing enumerated near it — paste the grep`);
      } else if (found < claimed) {
        report('FAIL', 'enumerate', `line ${lineno}: claims "${match[0]}" but enumerates ${found} — a count in a categorical sentence is a claim`);
      }
    }
  }
}

function ripgrepFiles(needle, { regex = false } = {}) {
  const roots = CONSUMER_SEARCH_ROOTS.filter((root) => existsSync(join(REPO_ROOT, root)));
  if (!roots.length) return [];
  try {
    const globs = ['-g', '*.{ts,tsx,js,jsx,mjs,cjs,swift,kt}', '-g', '!**/index.ts', '-g', '!**/index.tsx'];
    const out = execFileSync('rg', ['-l', ...globs, ...(regex ? [] : ['--fixed-strings']), '--', needle, ...roots], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean);
  } catch (error) {
    // rg ran and matched nothing — that is an answer, not a failure.
    if (error.status === 1) return [];
    // rg is not installed. The old code returned [] here too, which made the consumer map check a
    // SILENT no-op on any machine without ripgrep — every row passed because nothing was searched.
    // git grep is always present in a git repo and answers the same question.
    if (error.code === 'ENOENT') return gitGrepFiles(needle, regex, roots);
    return [];
  }
}

function gitGrepFiles(needle, regex, roots) {
  // git's wildmatch has no brace expansion, so each extension needs its own pathspec.
  const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'swift', 'kt'];
  const pathspecs = [
    ...roots.flatMap((root) => EXTENSIONS.map((ext) => `:(glob)${root}/**/*.${ext}`)),
    ':(exclude,glob)**/index.ts',
    ':(exclude,glob)**/index.tsx',
  ];
  // --untracked so a file the plan just created counts as a consumer; -P because the declaration
  // probe uses \s, which POSIX ERE does not know.
  try {
    const out = execFileSync('git', ['grep', '-l', '--untracked', regex ? '-P' : '-F', '-e', needle, '--', ...pathspecs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function checkConsumerMap(text, declaredFiles, strict) {
  const rows = preflightSection(text, 2).filter(({ line }) => line.trim().startsWith('|') && !/^\s*\|[\s|:-]+\|\s*$/.test(line));
  if (rows.length < 2) return;
  const bySymbol = new Map();
  for (const { lineno, line } of rows.slice(1)) {
    const cells = line.split('|').map((cell) => cell.trim());
    const symbol = /^`([A-Za-z_][A-Za-z0-9_]{5,})`/.exec(cells[1] ?? '')?.[1];
    if (!symbol) continue;
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, { lineno, covered: new Set() });
    const entry = bySymbol.get(symbol);
    for (const match of line.matchAll(BACKTICK_RE)) {
      const token = match[1].split(':')[0];
      if (/\.[A-Za-z0-9]+$/.test(token)) entry.covered.add(basename(token));
    }
  }
  const exempt = new Set([...declaredFiles].map((file) => basename(file)));
  for (const [symbol, { lineno, covered }] of bySymbol) {
    const declaresIt = new Set(
      ripgrepFiles(`(function|class|const|let|var|static|interface|type|enum)\\s+${symbol}\\b`, { regex: true })
        .map((rel) => basename(rel)),
    );
    const missing = ripgrepFiles(symbol)
      .filter((rel) => !covered.has(basename(rel)) && !exempt.has(basename(rel)) && !declaresIt.has(basename(rel)));
    if (!missing.length) continue;
    if (missing.length > AMBIENT_SYMBOL_THRESHOLD) {
      report('WARN', 'consumers', `line ${lineno}: \`${symbol}\` is ambient — ${missing.length} unmapped files (${missing.slice(0, 3).join(', ')}, …). Enumerating them is not the map's job: §2 must name the filter it maps instead`);
      continue;
    }
    const shown = missing.slice(0, 6).join(', ');
    const more = missing.length > 6 ? `, +${missing.length - 6} more` : '';
    report(strict ? 'FAIL' : 'WARN', 'consumers', `line ${lineno}: \`${symbol}\` — \`rg\` finds ${missing.length} file(s) absent from the consumer map: ${shown}${more}`);
  }
}

function planTasks(text) {
  const tasks = [];
  let current = null;
  let inFilesBlock = false;
  text.split('\n').forEach((line, index) => {
    const heading = TASK_HEADING_RE.exec(line);
    if (heading) {
      current = { id: heading[1], lineno: index + 1, body: [], files: new Set() };
      tasks.push(current);
      inFilesBlock = false;
      return;
    }
    if (!current) return;
    current.body.push(line);
    const filesMatch = FILES_LINE_RE.exec(line);
    if (filesMatch) {
      current.files.add(filesMatch[2].split(':')[0]);
      return;
    }
    const header = FILES_HEADER_RE.exec(line);
    if (header) {
      inFilesBlock = true;
      for (const match of (header[1] ?? '').matchAll(BACKTICK_RE)) current.files.add(match[1].split(':')[0]);
      return;
    }
    if (!inFilesBlock) return;
    const paths = [...line.matchAll(BACKTICK_RE)].map((match) => match[1].split(':')[0]);
    if (!paths.length || !paths.every((path) => /\.[A-Za-z0-9]+$/.test(path))) {
      inFilesBlock = false;
      return;
    }
    for (const path of paths) current.files.add(path);
  });
  return tasks;
}

function allDeclaredFiles(text) {
  const declared = new Set();
  for (const task of planTasks(text)) for (const file of task.files) declared.add(file);
  return declared;
}

function checkFalsificationTraces(text) {
  for (const task of planTasks(text)) {
    const testFiles = [...task.files].filter((file) => /\.test\.[a-z]+$/.test(file));
    if (!testFiles.length) continue;
    const trace = task.body.find((line) => /falsif/i.test(line));
    if (!trace) {
      report('FAIL', 'falsification', `Task ${task.id} (line ${task.lineno}): touches ${testFiles.length} test file(s) with no falsification trace — no trace, no test`);
      continue;
    }
    if (!/`[^`]+`/.test(trace)) {
      report('WARN', 'falsification', `Task ${task.id} (line ${task.lineno}): the falsification trace names no asserted expression — a trace that does not name what is asserted is not a trace`);
    }
  }
}

function checkStaleBase() {
  const baseRef = process.env.PLAN_LINT_BASE_REF || 'origin/main';
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    report('WARN', 'stale-base', `${baseRef} does not resolve in this checkout, so this check did NOT run — nothing here says whether your tree is current. \`git fetch origin main\`, or fix PLAN_LINT_BASE_REF.`);
    return;
  }
  let behind;
  try {
    behind = Number(execFileSync('git', ['rev-list', '--count', `HEAD..${baseRef}`], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
  } catch {
    report('WARN', 'stale-base', `could not count commits against ${baseRef} — this check did NOT run`);
    return;
  }
  if (!Number.isFinite(behind)) return;

  let refAgeHours = null;
  try {
    const at = Number(execFileSync('git', ['log', '-1', '--format=%ct', baseRef], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    if (Number.isFinite(at)) refAgeHours = Math.round((Date.now() / 1000 - at) / 3600);
  } catch { /* a repo without the ref cannot date it */ }

  report('INFO', 'stale-base', `compared against ${baseRef}${process.env.PLAN_LINT_BASE_REF ? ' (overridden by PLAN_LINT_BASE_REF)' : ''} — ${behind} commit(s) behind`);
  if (behind >= STALE_BASE_FAIL_AT) {
    report('FAIL', 'stale-base', `this tree is ${behind} commit(s) behind ${baseRef} — at this drift a file you read is likely already false. Rebase onto ${baseRef}, then re-run and re-check every anchor.`);
  } else if (behind > 0) {
    report('WARN', 'stale-base', `this tree is ${behind} commit(s) behind ${baseRef} — cheap to ignore at this drift, but re-read any file whose behaviour the plan leans on`);
  }
  if (refAgeHours !== null && refAgeHours > 24) {
    report('WARN', 'stale-base', `${baseRef} here is ${refAgeHours}h old, so "0 commits behind" proves nothing — \`git fetch origin main\` first`);
  }
}

function checkExhaustiveConsumers(declaredFiles) {
  const types = new Set();
  for (const file of declaredFiles) {
    const absolute = join(REPO_ROOT, file);
    if (!/\.(ts|tsx)$/.test(file) || !existsSync(absolute)) continue;
    const source = readFileSync(absolute, 'utf8');
    for (const match of source.matchAll(/export\s+(?:type|enum|interface)\s+([A-Z][A-Za-z0-9_]*)/g)) types.add(match[1]);
    for (const match of source.matchAll(/export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*\{[\s\S]{0,4000}?\}\s*as\s+const/g)) types.add(match[1]);
  }
  if (!types.size) return;

  const alternation = [...types].join('|');
  for (const hit of ripgrepFiles(`Record<\\s*(${alternation})\\b`, { regex: true })) {
    if (declaredFiles.has(hit)) continue;
    let source;
    try {
      source = readFileSync(join(REPO_ROOT, hit), 'utf8');
    } catch {
      continue;
    }
    for (const type of types) {
      if (!new RegExp(`Record<\\s*${type}\\b`).test(source)) continue;
      report('WARN', 'exhaustive', `${hit} holds a \`Record<${type}, …>\` exhaustive over a type this plan edits, and no task lists that file — widening ${type} would fail that file's build. Add the row, or say why ${type} is not widened.`);
    }
  }
}

function checkRevisionSweep(planPath, planText, ref) {
  const rel = relative(REPO_ROOT, planPath);
  let previous;
  try {
    previous = execFileSync('git', ['show', `${ref}:${rel}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    report('WARN', 'sweep', `no committed version of ${rel} at ${ref} — nothing to sweep against`);
    return;
  }
  if (previous === planText) {
    const explicit = ref !== 'HEAD';
    report(explicit ? 'FAIL' : 'WARN', 'sweep', explicit
      ? `the plan is byte-identical to ${ref} — a revision you believe you applied did not land. Re-read the edit you made.`
      : `the plan is byte-identical to HEAD. If you just committed it, that is expected; if you just applied a review round, the edit did not land — sweep against the round before it (\`--sweep=<older-ref>\`) to tell the two apart.`);
    return;
  }
  const before = new Set(previous.split('\n').map((line) => line.trim()));
  const addedLines = planText.split('\n').filter((line) => !before.has(line.trim()));
  if (!addedLines.length) {
    report('INFO', 'sweep', `this revision only removed lines — nothing new to sweep for orphaned paths`);
    return;
  }
  const previousPaths = new Set([...previous.matchAll(PATH_IN_BACKTICKS_RE)].map((match) => match[1]));
  const declared = allDeclaredFiles(planText);
  const introduced = new Set();
  for (const line of addedLines) {
    if (FILES_LINE_RE.test(line)) continue;
    for (const match of line.matchAll(PATH_IN_BACKTICKS_RE)) {
      if (!previousPaths.has(match[1])) introduced.add(match[1]);
    }
  }
  const orphans = [...introduced].filter((path) => !declared.has(path));
  if (orphans.length) {
    report('FAIL', 'sweep', `this revision names ${orphans.length} file(s) in prose that reach no task's \`Files:\` — ${orphans.slice(0, 6).join(', ')}`);
  }
  report('INFO', 'sweep', `${addedLines.length} changed line(s) against ${ref}, ${introduced.size} newly-named file(s)`);
}

function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const target = argv.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error(
      'usage: plan-lint.mjs <docs/vibe-coding/<feature>/ | plan.md>\n'
        + '       [--strict-symbols] [--strict-consumers] [--skip-consumer-map]\n'
        + '       [--skip-test-commands] [--sweep[=<ref>]] [--json]',
    );
    return 2;
  }
  const targetPath = resolve(target);
  const planPath = existsSync(targetPath) && statSync(targetPath).isDirectory() ? join(targetPath, 'plan.md') : targetPath;
  if (!existsSync(planPath)) {
    console.error(`plan-lint: no plan at ${planPath}`);
    return 2;
  }
  const specPath = join(dirname(planPath), 'spec.md');
  const planText = readFileSync(planPath, 'utf8');
  const specText = existsSync(specPath) ? readFileSync(specPath, 'utf8') : '';

  const createdByPlan = collectCreatedPaths(planText);
  const declaredFiles = allDeclaredFiles(planText);
  checkStaleBase();
  checkAnchors(planText, createdByPlan);
  checkDeclaredPaths(planText, createdByPlan);
  checkBacktickPaths(planText, createdByPlan);
  checkFenceComments(planText);
  checkUnreadSymbols(planText, flags.has('--strict-symbols'));
  checkRequirements(specText, planText);
  checkAnchorQuotes(planText, createdByPlan);
  checkEnumerations(planText);
  checkFalsificationTraces(planText);
  if (!flags.has('--skip-consumer-map')) {
    checkConsumerMap(planText, declaredFiles, flags.has('--strict-consumers'));
    checkExhaustiveConsumers(declaredFiles);
  }
  const sweepFlag = argv.find((a) => a === '--sweep' || a.startsWith('--sweep='));
  if (sweepFlag) checkRevisionSweep(planPath, planText, sweepFlag.split('=')[1] || 'HEAD');
  if (!flags.has('--skip-test-commands')) checkTestCommands(planText);

  const fails = results.filter((r) => r.level === 'FAIL');
  const warns = results.filter((r) => r.level === 'WARN');
  const infos = results.filter((r) => r.level === 'INFO');

  if (flags.has('--json')) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const marker = { FAIL: '✗', WARN: '!', INFO: '·' };
    for (const { level, check, message } of [...fails, ...warns, ...infos]) {
      console.log(`${marker[level]} [${check}] ${message}`);
    }
    console.log(`\nplan-lint: ${fails.length} FAIL, ${warns.length} WARN, ${infos.length} INFO — ${planPath}`);
  }
  return fails.length ? 1 : 0;
}

process.exit(main());
