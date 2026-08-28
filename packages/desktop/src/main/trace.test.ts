import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
   * Вызов, остановленный на стадии, обязан НЕ ИМЕТЬ ключа `argv` вовсе: выдуманный пустой
   * массив отрисовался бы настоящей пустой командой.
   */
  it('у остановленного вызова нет ключа argv', async () => {
    const calls = foldCalls(unwrap(readTrace(await load('demo.jsonl'))));
    const denied = calls.filter((c) => c.verdict === 'denied');
    expect(denied.length).toBeGreaterThan(0);
    for (const call of denied) {
      for (const event of call.stages) expect(Object.hasOwn(event, 'argv')).toBe(false);
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
    for (const event of built) expect(event.argvFromParams).toEqual([3]);
  });
});
