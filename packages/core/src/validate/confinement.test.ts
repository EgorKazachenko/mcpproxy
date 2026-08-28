import { describe, expect, it } from 'vitest';
import { confinementOf } from './confinement.js';

describe('confinementOf', () => {
  it('корень сам по себе — отдельный исход, а не «внутри»', () => {
    expect(confinementOf('/logs', '/logs')).toBe('root-itself');
  });

  it('подкаталог лежит внутри', () => {
    expect(confinementOf('/logs', '/logs/app/today.log')).toBe('inside');
  });

  it('сосед с общим префиксом лежит снаружи — то, что пропускает startsWith (Ф3)', () => {
    expect(confinementOf('/logs', '/logs-evil/a')).toBe('outside');
  });

  it('родительский каталог без хвоста лежит снаружи', () => {
    expect(confinementOf('/logs/app', '/logs')).toBe('outside');
  });

  it('подъём с хвостом лежит снаружи', () => {
    expect(confinementOf('/logs', '/etc/passwd')).toBe('outside');
  });

  it('каталог, чьё имя начинается с двух точек, лежит внутри', () => {
    // Обратная сторона той же клаузы: голый startsWith('..') объявил бы его выходом.
    expect(confinementOf('/logs', '/logs/..cache')).toBe('inside');
  });
});
