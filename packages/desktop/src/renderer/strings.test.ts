import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { STRINGS } from './strings.js';

const SRC = new URL('../', import.meta.url).pathname;
const SCANNED = ['renderer', 'shared'];
const HOME = 'renderer/strings.ts';
const CYRILLIC = /[Ѐ-ӿ]/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(join(SRC, dir), { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith('.test.ts') && !e.name.endsWith('.test.tsx'))
    .map((e) => relative(SRC, join(e.parentPath, e.name)));
}

/**
 * Диагностика — не экранная проза.
 *
 * Сообщение `new Error(...)` и текст отказа на границе IPC никогда не рисуются: они живут
 * рядом с проверкой, которая их порождает, и перенос в модуль копии оторвал бы причину от
 * места. Требование говорит про строки, которые ПОПАДАЮТ НА ЭКРАН, и правило сужено по месту
 * вызова, а не отменено.
 */
const DIAGNOSTIC_CALLEES = new Set(['Error', 'TypeError', 'denied']);

function isDiagnostic(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isNewExpression(parent) || ts.isCallExpression(parent)) {
    const callee = ts.isNewExpression(parent) ? parent.expression : parent.expression;
    return ts.isIdentifier(callee) && DIAGNOSTIC_CALLEES.has(callee.text);
  }
  if (ts.isTemplateExpression(parent) || ts.isTemplateSpan(parent)) return isDiagnostic(parent);
  return false;
}

/**
 * Кириллица в литералах, тексте JSX и кусках шаблонных строк — но НЕ в комментариях.
 *
 * Грепом это не делается: в этом репозитории каждый файл несёт русские комментарии, и греп
 * покрасил бы красным всё. Отсюда обход AST.
 */
function cyrillicLiterals(source: string, fileName: string): string[] {
  const tree = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
  const hits: string[] = [];

  const visit = (node: ts.Node): void => {
    const isLiteral =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);

    if (isLiteral && CYRILLIC.test(node.text) && !isDiagnostic(node)) {
      hits.push(node.text.trim().slice(0, 40));
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(tree, visit);
  return hits;
}

describe('экранная проза живёт в одном модуле', () => {
  /**
   * Обеспечение структурное, как запрет голых вызовов IPC. Односторонняя сверка «строки
   * модуля встречаются в макете» этот отказ пропускала бы: она ничего не говорит про файл,
   * который захардкодил строку МИМО модуля, а это и есть то, от чего правило защищает.
   */
  it('ни один файл рендерера и общего слоя не несёт кириллицу в литералах', async () => {
    const offenders: Record<string, string[]> = {};

    for (const dir of SCANNED) {
      for (const file of await sourceFiles(dir)) {
        if (file === HOME) continue;
        const hits = cyrillicLiterals(await readFile(join(SRC, file), 'utf8'), file);
        if (hits.length > 0) offenders[file] = hits;
      }
    }

    expect(offenders).toEqual({});
  });
});

describe('строки сверены с макетом', () => {
  const MOCKUP = new URL('../../../../docs/vibe-coding/27.08.2026-e7-ui/mockup.html', import.meta.url).pathname;

  /**
   * Макет заморожен и служит источником истины для копии. Сверяются постоянные фрагменты, а
   * не готовые предложения: составные фразы макет собирает из шаблонов, и целиком в файле их
   * нет.
   */
  const FRAGMENTS: readonly string[] = [
    STRINGS.app.unsandboxedBanner,
    STRINGS.calls.head,
    STRINGS.calls.emptyHead,
    STRINGS.detail.head,
    STRINGS.detail.fromParams,
    STRINGS.nav.timeline,
    STRINGS.nav.violations,
    STRINGS.nav.policy,
    STRINGS.nav.approvals,
    STRINGS.nav.audit,
    STRINGS.outcome.blocked,
    STRINGS.outcome.passed,
    STRINGS.stage.profileSkipped,
  ];

  /** Пробелы схлопываются: макет переносит длинные фразы, а HTML их всё равно схлопнет. */
  const collapse = (text: string): string => text.replace(/\s+/g, ' ');

  it.each(FRAGMENTS)('«%s» встречается в макете', async (fragment) => {
    expect(collapse(await readFile(MOCKUP, 'utf8'))).toContain(collapse(fragment));
  });
});
