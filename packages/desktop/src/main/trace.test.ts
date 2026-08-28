import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stageOrder } from '@mcpproxy/contracts';
import { verifyChain } from '@mcpproxy/contracts/audit';
import { describe, expect, it } from 'vitest';
import { foldCalls } from '../shared/call.js';
import { readTrace } from './trace.js';

const FIXTURES = new URL('../../fixtures/', import.meta.url).pathname;
const load = async (name: string): Promise<string> => readFile(join(FIXTURES, name), 'utf8');

const unwrap = <T>(result: { ok: true; value: T } | { ok: false }): T => {
  if (!result.ok) throw new Error('ожидался успешный разбор');
  return result.value;
};

describe('readTrace', () => {
  it('пропускает пустые строки', () => {
    expect(unwrap(readTrace('\n\n'))).toEqual([]);
  });

  it('отдаёт битую строку конвертом, а не броском', () => {
    expect(readTrace('{ сломано').ok).toBe(false);
  });

  it('отказывает строке, которая не запись аудита', () => {
    expect(readTrace('{"a":1}').ok).toBe(false);
  });

  /**
   * Контракт объявляет, что читатель обязан отрисовать неизвестную версию схемы как «форма
   * новее меня», а не упасть. Проверяется именно это: незнакомое значение проходит.
   */
  it('терпим к незнакомой версии схемы', () => {
    const line = JSON.stringify({ schema: 'mcpproxy.audit/99', stage: 'received', chain: { prev: null, self: 'x' } });
    expect(readTrace(line).ok).toBe(true);
  });
});

/**
 * Фикстура — **запись**, а не выдумка: её пишет `demo/record.mjs`, прогоняя сценарии через
 * настоящий демон над `demo/repo`. Утверждения ниже поэтому проверяют не «мы нарисовали
 * нужные поля», а «система действительно так себя ведёт»: любая правка, меняющая исход
 * сценария, приедет сюда следующей перезаписью и покраснеет здесь.
 */
describe('закоммиченная фикстура', () => {
  /**
   * Главное утверждение этой задачи.
   *
   * `chain.self` обязан удовлетворять формуле контракта, и написанные руками хэши сделали бы
   * демо-трейс постоянно «разошедшимся» — на сцене. Без этого теста одна поздняя правка
   * фикстуры руками ломает демо молча, и узнать об этом можно только на показе.
   */
  it('несёт честную цепочку хэшей', async () => {
    const events = unwrap(readTrace(await load('demo.jsonl')));
    expect(verifyChain(events)).toEqual({ ok: true });
  });

  it('покрывает оба прогона сценария S5 одним логом', async () => {
    const calls = foldCalls(unwrap(readTrace(await load('demo.jsonl'))));
    const modes = calls.flatMap((c) => c.stages.flatMap((e) => (e.sandbox ? [e.sandbox.mode] : [])));
    expect(new Set(modes)).toEqual(new Set(['none', 'seatbelt']));
  });

  /**
   * Вызов, остановленный ДО сборки команды, обязан не иметь ключа `argv` вовсе: выдуманный
   * пустой массив отрисовался бы настоящей пустой командой.
   *
   * Граница — стадия, а не вердикт. Прежняя редакция требовала отсутствия `argv` у КАЖДОГО
   * отказанного вызова и была верна лишь пока фикстуру рисовали руками: `publish_release`
   * отказан на `approval`, то есть уже после `build_argv`, и команда у него есть — её и
   * обязан показать человек, решающий про подтверждение. Условие «нет argv у отказа» вырезало
   * бы из записи ровно тот вызов, ради которого поле в событии и заведено.
   */
  it('у вызова, остановленного до build_argv, нет ключа argv', async () => {
    const calls = foldCalls(unwrap(readTrace(await load('demo.jsonl'))));
    const beforeArgv = stageOrder.indexOf('build_argv');
    const stoppedEarly = calls.filter(
      (c) => c.verdict === 'denied' && stageOrder.indexOf(c.stages[c.stages.length - 1]?.stage ?? 'received') < beforeArgv,
    );
    expect(stoppedEarly.length).toBeGreaterThan(0);
    for (const call of stoppedEarly) {
      for (const event of call.stages) expect(Object.hasOwn(event, 'argv')).toBe(false);
    }

    // И обратная половина: вызов, дошедший до сборки, команду в записи НЕСЁТ.
    const stoppedLate = calls.filter(
      (c) => c.verdict === 'denied' && stageOrder.indexOf(c.stages[c.stages.length - 1]?.stage ?? 'received') > beforeArgv,
    );
    expect(stoppedLate.length).toBeGreaterThan(0);
    for (const call of stoppedLate) {
      expect(call.stages.some((e) => Object.hasOwn(e, 'argv'))).toBe(true);
    }
  });

  /**
   * Поле контракта, добавленное этим раном, обязано быть в фикстуре: иначе единственный его
   * потребитель получал бы события, где поля нет, и требование не доказывалось бы ничем.
   */
  it('события build_argv несут происхождение элементов команды', async () => {
    const events = unwrap(readTrace(await load('demo.jsonl')));
    const built = events.filter((e) => e.stage === 'build_argv');
    expect(built.length).toBeGreaterThan(0);

    const withOrigin = built.filter((e) => e.argvFromParams !== undefined);
    expect(withOrigin.length).toBeGreaterThan(0);

    // Инвариант поля, а не одно ожидаемое значение: индексы обязаны указывать в `argv` ТОГО
    // ЖЕ события. Прежняя редакция ждала ровно `[3]` у каждого события и была верна только
    // пока в логе жил один рецепт.
    for (const event of withOrigin) {
      const argv = event.argv ?? [];
      for (const index of event.argvFromParams ?? []) {
        expect(Number.isInteger(index)).toBe(true);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(argv.length);
      }
    }

    // И обратная половина `R13`: где из параметров не подставлялось ничего, ключа НЕТ вовсе.
    expect(built.some((e) => !Object.hasOwn(e, 'argvFromParams'))).toBe(true);
  });

  /**
   * `R13` просит покрыть фикстурами сценарии S1–S9. Покрыты те, у которых в ране 1 есть
   * поверхность: таймлайн показывает вызовы, а не политику и не журнал.
   *
   * Проверяется исходами, а не именами сценариев: имя в фикстуре — комментарий, а исход —
   * то, что действительно отрисуется. S3 и S4 дают отказ на `validate` и на `resolve_paths`,
   * S5 — пару прогонов с прошедшим и отбитым нарушением, S6 — `mandatory-deny`, S7 — стоп на
   * `lock_check`, S8 — стоп на `approval`.
   */
  it('покрывает сценарии, у которых в этом ране есть поверхность', async () => {
    const calls = foldCalls(unwrap(readTrace(await load('demo.jsonl'))));
    const stoppedAt = (stage: string) =>
      calls.some((c) => c.verdict === 'denied' && c.stages[c.stages.length - 1]?.stage === stage);
    const violations = calls.flatMap((c) => c.stages.flatMap((e) => e.sandbox?.violations ?? []));

    expect(stoppedAt('validate')).toBe(true); // S3
    expect(stoppedAt('resolve_paths')).toBe(true); // S4
    expect(stoppedAt('lock_check')).toBe(true); // S7
    expect(violations.some((v) => v.action === 'allowed')).toBe(true); // S5, прогон без песочницы
    expect(violations.some((v) => v.action === 'denied')).toBe(true); // S5, прогон с песочницей
    expect(violations.some((v) => v.type === 'mandatory-deny')).toBe(true); // S6
    expect(stoppedAt('approval')).toBe(true); // S8
  });

  /**
   * S8 останавливается ОТКАЗОМ, а не ожиданием, и это не упрощение фикстуры, а состояние
   * системы: брокера подтверждений (E5) в дереве нет, и конвейер на `tier: 'high'` отвечает
   * `approval-unavailable` — fail-closed. Прежняя редакция этого теста ждала здесь
   * `pending_approval`, потому что фикстура была нарисована руками и могла обещать то, чего
   * код не делает. Утверждение перевёрнуто НАМЕРЕННО: `pending_approval` в записи означал бы,
   * что брокер появился, — и тогда красный тест напомнит дописать сюда ожидание.
   */
  it('high-risk сегодня отказан, а не поставлен в ожидание — брокера апрувов ещё нет', async () => {
    const calls = foldCalls(unwrap(readTrace(await load('demo.jsonl'))));
    const high = calls.filter((c) => c.stages.some((e) => e.risk?.tier === 'high'));
    expect(high.length).toBeGreaterThan(0);

    for (const call of high) {
      expect(call.verdict).toBe('denied');
      expect(call.stages.at(-1)?.stage).toBe('approval');
      expect(call.stages.at(-1)?.denyReason).toContain('approval-unavailable');
    }
    expect(calls.some((c) => c.verdict === 'pending_approval')).toBe(false);
  });
});
