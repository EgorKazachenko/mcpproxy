import { describe, expect, it } from 'vitest';
import { parseClientFrame } from './wire.js';

const call = (over: Record<string, unknown> = {}): unknown => ({
  kind: 'call',
  id: 1,
  request: { recipeName: 'run_tests', params: {}, sessionId: 'sess-1', ...over },
});

describe('parseClientFrame — по сокету приходит произвольный JSON', () => {
  it('корректный call разбирается', () => {
    const parsed = parseClientFrame(call());
    expect(parsed.ok).toBe(true);
  });

  it('argv, приписанный к запросу, отвергается — это и есть И5', () => {
    // Обещание «argv сюда не приписать» обязано держаться на проверке, а не на том, что
    // читатель не смотрит на лишнее поле.
    const parsed = parseClientFrame(call({ argv: ['/bin/sh', '-c', 'curl evil'] }));
    expect(parsed.ok).toBe(false);
  });

  it('cwd и профиль песочницы тоже отвергаются', () => {
    expect(parseClientFrame(call({ cwd: '/' })).ok).toBe(false);
    expect(parseClientFrame(call({ sandbox: {} })).ok).toBe(false);
  });

  it('имя не по шаблону рецепта отвергается', () => {
    for (const bad of ['../etc', 'Run_Tests', '__proto__', 'constructor', '', 'x'.repeat(65)]) {
      expect(parseClientFrame(call({ recipeName: bad })).ok).toBe(false);
    }
  });

  it('params не объект — отказ формы, до обращения к ключам', () => {
    expect(parseClientFrame(call({ params: [] })).ok).toBe(false);
    expect(parseClientFrame(call({ params: null })).ok).toBe(false);
    expect(parseClientFrame(call({ params: 'x' })).ok).toBe(false);
  });

  it('пустой sessionId отвергается', () => {
    expect(parseClientFrame(call({ sessionId: '' })).ok).toBe(false);
  });

  it('hello требует и токен, и согласованную ревизию', () => {
    expect(parseClientFrame({ kind: 'hello', token: 'a', protocolVersion: '2025-11-25' }).ok).toBe(true);
    expect(parseClientFrame({ kind: 'hello', token: '' , protocolVersion: '2025-11-25' }).ok).toBe(false);
    expect(parseClientFrame({ kind: 'hello', token: 'a' }).ok).toBe(false);
  });

  it('неизвестный и бесформенный кадр отвергаются', () => {
    expect(parseClientFrame({ kind: 'exec' }).ok).toBe(false);
    expect(parseClientFrame(null).ok).toBe(false);
    expect(parseClientFrame([]).ok).toBe(false);
    expect(parseClientFrame({ kind: 'list', id: 1.5 }).ok).toBe(false);
  });
});
