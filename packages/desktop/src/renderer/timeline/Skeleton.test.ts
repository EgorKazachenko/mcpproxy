import type { ChainedEvent, Stage, Verdict } from '@mcpproxy/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { foldCalls } from '../../shared/call.js';
import { STRINGS } from '../strings.js';
import { CallDetail } from './CallDetail.js';
import { CallList } from './CallList.js';
import { CallDetailSkeleton, CallListSkeleton } from './Skeleton.js';

let tick = 0;
const event = (stage: Stage, verdict: Verdict = 'allowed', extra: Partial<ChainedEvent> = {}): ChainedEvent =>
  ({
    schema: 'mcpproxy.audit/1',
    operation: 'execute_tool',
    protocolVersion: '2025-11-25',
    toolName: 'run_tests',
    sessionId: 's',
    traceId: 't',
    spanId: `sp${(tick += 1)}`,
    parentSpanId: null,
    startTime: `2026-08-27T10:00:${String(tick).padStart(2, '0')}.000000Z`,
    endTime: `2026-08-27T10:00:${String(tick).padStart(2, '0')}.001000Z`,
    durationUs: 1000,
    stage,
    verdict,
    recipe: { name: 'run_tests' },
    chain: { prev: null, self: 'x'.repeat(64) },
    ...extra,
  }) as ChainedEvent;

const calls = foldCalls([
  event('received'),
  event('build_argv', 'allowed', { argv: ['pnpm', 'test'], argvFromParams: [1] }),
  event('spawn', 'allowed', { sandbox: { mode: 'seatbelt' } }),
  event('complete'),
]);

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node);

const filled = html(createElement(CallList, { calls, selected: null, onSelect: () => undefined }));
const empty = html(createElement(CallList, { calls: [], selected: null, onSelect: () => undefined }));
const skeleton = html(createElement(CallListSkeleton));

const classesOf = (markup: string): ReadonlySet<string> =>
  new Set([...markup.matchAll(/class="([^"]+)"/g)].flatMap((match) => (match[1] ?? '').split(' ')).filter(Boolean));

/**
 * Классы, несущие цвет исхода. Скелет их не носит по определению: исхода ещё нет, и красить
 * ожидание в зелёное или красное значит показать вердикт до того, как он вычислен.
 */
const COLOURED = /^(role-|badge--|g-)/;

/** Всё остальное — коробки, из которых складывается высота строки. */
const boxesOf = (markup: string): readonly string[] => [...classesOf(markup)].filter((one) => !COLOURED.test(one));

describe('скелет таймлайна', () => {
  /**
   * `R22`: «скелет по высоте повторяет наполненное тело». Список коробок не выписан руками —
   * он снимается с разметки, которую печатает сам `CallList`, поэтому расхождение ловится с
   * ЛЮБОЙ стороны: и когда коробку убирают из скелета, и когда её добавляют в наполненную
   * строку, забыв про скелет. Выписанный руками список пережил бы и то, и другое.
   */
  it('несёт все коробки наполненной строки, кроме тех, что несут цвет исхода', () => {
    const boxes = boxesOf(filled);
    expect(boxes.length).toBeGreaterThan(5);
    expect(boxes.filter((one) => !classesOf(skeleton).has(one))).toEqual([]);
  });

  /**
   * Положительный контроль к утверждению выше: та же проверка на пустом состоянии обязана
   * ПРОВАЛИТЬСЯ. Без него «скелет повторяет коробки» осталось бы утверждением, которое
   * проходит и для разметки, ничего не повторяющей.
   */
  it('пустое состояние тех же коробок не повторяет — проверка выше умеет краснеть', () => {
    expect(boxesOf(filled).filter((one) => !classesOf(empty).has(one))).not.toEqual([]);
  });

  it('строки скелета не выбираются: выбирать пока нечего', () => {
    // Положительный контроль в первой строке: зонд ловит выбор там, где он есть.
    expect(filled).toContain('role="option"');
    expect(skeleton).not.toContain('role="option"');
    expect(skeleton).not.toContain('<button');
    expect(skeleton).toContain('aria-busy="true"');
  });

  it('панель деталей грузится, а не сообщает об отсутствии выбора', () => {
    const detail = html(createElement(CallDetailSkeleton));
    const notSelected = html(createElement(CallDetail, { call: null, onFilter: () => undefined }));

    // Положительный контроль: строка отсутствия выбора существует и зонд её видит.
    expect(notSelected).toContain(STRINGS.detail.notSelectedHead);
    expect(detail).not.toContain(STRINGS.detail.notSelectedHead);

    // Заголовки секций известны до данных, поэтому показаны, а не закрыты полосой.
    expect(detail).toContain(STRINGS.detail.callSection);
    expect(detail).toContain(STRINGS.detail.commandSection);
    expect(detail).toContain(STRINGS.detail.stagesSection);
  });
});
