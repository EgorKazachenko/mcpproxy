#!/usr/bin/env node
/**
 * PostToolUse — прогоняет tsc по монорепозиторию после правки .ts и возвращает
 * ошибки в контекст модели.
 *
 * Дополняет LSP, а не заменяет: LSP отвечает на вопросы («какой тип у X»),
 * хук сообщает без вопроса («ты только что сломал сборку»).
 *
 * Молчит, когда всё чисто — иначе контекст забивается сообщениями «ок».
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');
const LOCK = join(ROOT, 'node_modules', '.cache', 'mcpproxy-typecheck.lock');

/** Сколько ошибок отдавать модели. Дальше — шум: чинить всё равно по одной. */
const MAX_ERRORS = 15;
const MAX_CHARS = 4000;
/** Замок старше этого считаем осиротевшим после падения. */
const LOCK_STALE_MS = 60_000;

const quiet = () => process.exit(0);

function report(text) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: text,
      },
    }),
  );
  process.exit(0);
}

function readStdin() {
  try {
    return JSON.parse(
      execFileSync('cat', [], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'ignore'] }),
    );
  } catch {
    return null;
  }
}

/* ── Отбор ──────────────────────────────────────────────────────────────── */

const input = readStdin();
if (!input) quiet();

const ti = input.tool_input ?? {};
const paths = [ti.file_path, ti.notebook_path, ...(ti.edits ?? []).map((e) => e?.file_path)]
  .filter((p) => typeof p === 'string');

// Только исходники пакетов. dist/ игнорируем — он сам продукт сборки.
const touched = paths.some((p) => {
  if (!/\.(ts|tsx|mts|cts)$/.test(p)) return false;
  const rel = relative(ROOT, p);
  return rel.startsWith('packages' + '/') && !rel.includes('/dist/');
});

if (!touched) quiet();
if (!existsSync(TSC)) quiet();

/* ── Замок ──────────────────────────────────────────────────────────────────
   Параллельные `tsc -b` бьются за один .tsbuildinfo. Если замок занят —
   молча выходим: экземпляр, который его держит, читает файлы с диска и уже
   видит нашу правку. Терять нечего. */

mkdirSync(join(ROOT, 'node_modules', '.cache'), { recursive: true });

if (existsSync(LOCK)) {
  let stale = true;
  try {
    stale = Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS;
  } catch {
    stale = true;
  }
  if (!stale) quiet();
  rmSync(LOCK, { force: true });
}

writeFileSync(LOCK, String(process.pid));

/* ── Прогон ─────────────────────────────────────────────────────────────── */

// Замок снимаем ДО любого выхода: process.exit() не даёт отработать finally,
// и на чистом прогоне замок утекал бы, глуша все последующие правки на минуту.
const res = spawnSync(TSC, ['-b', '--pretty', 'false'], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 90_000,
});
rmSync(LOCK, { force: true });

if (res.status === 0) quiet();

const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;

const errors = out
  .split('\n')
  .filter((l) => /error TS\d+/.test(l))
  .map((l) => l.replace(ROOT + '/', ''));

if (errors.length === 0) quiet();

const shown = errors.slice(0, MAX_ERRORS).join('\n').slice(0, MAX_CHARS);
const rest = errors.length > MAX_ERRORS ? `\n… и ещё ${errors.length - MAX_ERRORS}` : '';

report(
  `tsc -b: ошибок ${errors.length}\n\n${shown}${rest}\n\n` +
    `Проверить целиком: yarn typecheck`,
);
