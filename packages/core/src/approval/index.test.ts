import { describe, expect, it } from 'vitest';
import * as approval from './index.js';

/**
 * Барреля касается тот же вопрос, что и всей поверхности `core`: снять экспорт после того,
 * как на него сослались E4 и E7, дорого. Тест фиксирует состав входа целиком, а не «есть ли
 * createBroker», — иначе новый экспорт уезжает к потребителям молча.
 */
describe('вход `approval` — состав фиксирован', () => {
  it('экспортирует ровно то, что нужно демону и окну', () => {
    expect(Object.keys(approval).sort()).toEqual([
      'APPROVAL_DENY_CODES',
      'createBroker',
      'createGrantStore',
      'dangerousToken',
      'isLive',
      'parseExpiresAt',
    ]);
  });

  it('словарь кодов отказа стадии не пересекается сам с собой', () => {
    expect(new Set(approval.APPROVAL_DENY_CODES).size).toBe(approval.APPROVAL_DENY_CODES.length);
  });

  it('ядро остаётся без Electron: канал — это порт, а не импорт (ADR-0001)', async () => {
    // Проверка формы, а не графа зависимостей: граф держит `deps.test.ts`. Здесь — то, что
    // брокер собирается вообще без каналов, то есть headless-путь не требует ничего чужого.
    const broker = approval.createBroker({ ports: [] });
    expect(typeof broker.decide).toBe('function');
  });
});
