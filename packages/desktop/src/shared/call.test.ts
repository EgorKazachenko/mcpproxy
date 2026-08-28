import { stageOrder, type ChainedEvent, type Stage, type Verdict } from '@mcpproxy/contracts';
import { describe, expect, it } from 'vitest';
import { foldCalls } from './call.js';
import { allGroupedStages, stageGroup, STAGE_GROUPS } from './stageGroup.js';

let tick = 0;
const event = (traceId: string, stage: Stage, verdict: Verdict = 'allowed'): ChainedEvent =>
  ({
    schema: 'mcpproxy.audit/1',
    operation: 'execute_tool',
    protocolVersion: '2025-11-25',
    toolName: 'run_tests',
    sessionId: 's',
    traceId,
    spanId: `sp${(tick += 1)}`,
    parentSpanId: null,
    startTime: `2026-08-27T10:00:${String(tick).padStart(2, '0')}.000000Z`,
    endTime: `2026-08-27T10:00:${String(tick).padStart(2, '0')}.001000Z`,
    durationUs: 1000,
    stage,
    verdict,
    recipe: { name: 'run_tests' },
    chain: { prev: null, self: 'x'.repeat(64) },
  }) as ChainedEvent;

describe('stageGroup', () => {
  /**
   * Полнота, а не выборка: стадия, забытая в таблице групп, молча выпала бы из полосы, и
   * заметить это без утверждения о покрытии было бы нечем.
   */
  it('покрывает все 13 стадий контракта', () => {
    expect(allGroupedStages()).toEqual(stageOrder);
  });

  /**
   * Стадия из более новой сборки не роняет отрисовку.
   *
   * Прежняя редакция бросала, и бросала внутри рендера, где error boundary нет: одно событие
   * с незнакомой стадией гасило весь таймлайн. Контракт же требует терпимого читателя —
   * «читаемая запись с пометкой „форма новее меня“, а не исключение».
   *
   * Прежняя проверка на этом месте перебирала `stageOrder` и утверждала, что каждая стадия
   * попадает в группу: с любым значением по умолчанию она зелена всегда и не значит ничего.
   * Полноту таблицы держит тест выше — он и роняет СБОРКУ на новой стадии контракта.
   */
  it('незнакомая стадия не бросает, а уезжает в последнюю группу', () => {
    const unknown = 'quarantine' as Stage;
    expect(() => stageGroup(unknown)).not.toThrow();
    expect(STAGE_GROUPS).toContain(stageGroup(unknown));
    // Положительный контроль: известная стадия по-прежнему попадает В СВОЮ группу, то есть
    // терпимость не превратила таблицу в одну корзину.
    expect(stageGroup('lock_check')).toBe('checks');
  });
});

describe('foldCalls', () => {
  it('сворачивает по traceId, а не по spanId', () => {
    const events = [event('a', 'received'), event('b', 'received'), event('a', 'complete')];
    expect(foldCalls(events).map((c) => c.traceId).sort()).toEqual(['a', 'b']);
  });

  /**
   * Проигрыватель отдаёт события по одному, и порядок прихода не гарантирован. Панель
   * деталей при этом требует стадии по порядку — значит сортировка обязана быть в свёртке.
   */
  it('порядок стадий не зависит от порядка прихода', () => {
    const ordered = [event('a', 'received'), event('a', 'validate'), event('a', 'complete')];
    const shuffled = [ordered[2]!, ordered[0]!, ordered[1]!];
    const stagesOf = (events: ChainedEvent[]) => foldCalls(events)[0]!.stages.map((e) => e.stage);
    expect(stagesOf(shuffled)).toEqual(stagesOf(ordered));
    expect(stagesOf(shuffled)).toEqual(['received', 'validate', 'complete']);
  });

  /** Повторы `violation` сохраняются: схлопывание потеряло бы контраст сценария S5. */
  it('сохраняет повторы стадии violation', () => {
    const events = [event('a', 'spawn'), event('a', 'violation'), event('a', 'violation')];
    expect(foldCalls(events)[0]!.stages.filter((e) => e.stage === 'violation')).toHaveLength(2);
  });

  it('вердикт берётся из последнего события по порядку стадий', () => {
    const events = [event('a', 'received'), event('a', 'complete', 'error')];
    expect(foldCalls(events)[0]!.verdict).toBe('error');
  });

  /**
   * Вызов, остановленный на `validate`, до `complete` не доходит никогда. Правило «нет
   * complete — значит открыт» держало бы его в списке ждущих вечно.
   */
  it('отказанный вызов закрыт, хотя complete у него нет', () => {
    const events = [event('a', 'received'), event('a', 'validate', 'denied')];
    expect(foldCalls(events)[0]!.open).toBe(false);
  });

  it('ждущий подтверждения вызов остаётся открытым', () => {
    const events = [event('a', 'received'), event('a', 'classify_risk', 'pending_approval')];
    expect(foldCalls(events)[0]!.open).toBe(true);
  });

  it('завершённый вызов закрыт', () => {
    expect(foldCalls([event('a', 'received'), event('a', 'complete')])[0]!.open).toBe(false);
  });

  it('свежие вызовы сверху', () => {
    const first = event('a', 'received');
    const second = event('b', 'received');
    expect(foldCalls([first, second]).map((c) => c.traceId)).toEqual(['b', 'a']);
  });
});
