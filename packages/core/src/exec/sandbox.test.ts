import { describe, expect, it } from 'vitest';
import type { SandboxMode } from '@mcpproxy/contracts';
import { asCommandId, assertModeSupported } from './sandbox.js';

/**
 * Платформа — **параметр**, а не `process.platform`, и это не удобство: с чтением глобала
 * половина R2 проверялась бы только на Linux-CI, то есть на macOS-разработке уезжала бы под
 * `skipIf` и молчала. Пропуск, который читается как успех, — ровно тот дефект, против
 * которого спека требует громких пропусков.
 */
describe('assertModeSupported', () => {
  it('бросает на container, а не откатывается на seatbelt (R3, D7)', () => {
    expect(() => assertModeSupported('container', 'darwin')).toThrow(/container/);
    expect(() => assertModeSupported('container', 'linux')).toThrow(/container/);
  });

  it('бросает на seatbelt вне macOS, а не деградирует до none (R2)', () => {
    expect(() => assertModeSupported('seatbelt', 'linux')).toThrow(/seatbelt/);
    expect(() => assertModeSupported('seatbelt', 'win32')).toThrow(/seatbelt/);
  });

  it('пропускает seatbelt на macOS и none везде', () => {
    expect(() => assertModeSupported('seatbelt', 'darwin')).not.toThrow();
    expect(() => assertModeSupported('none', 'linux')).not.toThrow();
    expect(() => assertModeSupported('none', 'darwin')).not.toThrow();
  });

  it('покрывает каждый член SandboxMode — иначе новый режим проехал бы молча', () => {
    // Компилятор держит полноту: режим, добавленный в `SandboxMode`, но не внесённый сюда,
    // делает `Missing` непустым и роняет сборку до запуска vitest.
    const MODES = ['none', 'seatbelt', 'container'] as const satisfies readonly SandboxMode[];
    type Missing = Exclude<SandboxMode, (typeof MODES)[number]>;
    const _everyModeListed: [Missing] extends [never] ? true : Missing = true;
    void _everyModeListed;

    expect(MODES.length).toBe(3);
  });
});

describe('asCommandId', () => {
  it('отвергает пустую строку', () => {
    expect(() => asCommandId('')).toThrow(/пустой/);
  });

  it('пропускает непустую', () => {
    expect(asCommandId('abc')).toBe('abc');
  });
});
