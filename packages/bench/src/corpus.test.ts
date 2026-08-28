import { describe, expect, it } from 'vitest';
import { attackCases } from './corpus/attacks.js';
import { utilityCases } from './corpus/legit.js';
import { ATTACK_CLASSES, UTILITY_CLASSES } from './types.js';

/**
 * Перепись корпуса. Двусторонняя, как перепись «код ↔ вектор» в E2: класс из каталога угроз
 * без единого кейса и кейс класса, которого в каталоге нет, — обе ошибки одинаково тихие, и
 * ловит их только тест, который смотрит на множества, а не на длину списка.
 *
 * Счётчики сверяются с `docs/09-metrics-and-eval.md` по нижней границе, а не по равенству:
 * дописать вектор в класс — обычная работа, а вот молча ужать класс до одного кейса, сохранив
 * зелёный прогон, эта проверка не даст.
 */
const MIN_CASES: Readonly<Record<string, number>> = {
  A1: 15, A2: 10, A3: 5, A4: 3, A5: 5, A6: 5, A7: 5, A8: 8,
  A9: 5, A10: 8, A11: 8, A12: 5, A13: 5, A14: 3, A15: 5,
};

describe('корпус атак', () => {
  const cases = attackCases(null);

  it('покрывает каждый класс каталога угроз и не заводит чужих', () => {
    expect([...new Set(cases.map((one) => one.klass))].sort()).toEqual([...ATTACK_CLASSES].sort());
  });

  it('держит объявленное в доке число кейсов на класс', () => {
    for (const [klass, minimum] of Object.entries(MIN_CASES)) {
      expect(cases.filter((one) => one.klass === klass).length, klass).toBeGreaterThanOrEqual(minimum);
    }
  });

  it('идентификаторы уникальны', () => {
    expect(new Set(cases.map((one) => one.id)).size).toBe(cases.length);
  });

  it('каждый кейс называет источник класса', () => {
    for (const one of cases) expect(one.source.length, one.id).toBeGreaterThan(0);
  });

  it('шесть классов из внешних источников не подписаны как baseline', () => {
    // Довод для демо: половина корпуса растёт из CVE и спек, а не из фантазии автора.
    const external = ['A5', 'A6', 'A7', 'A8', 'A9', 'A11'];
    for (const klass of external) {
      const sources = cases.filter((one) => one.klass === klass).map((one) => one.source);
      expect(sources.every((one) => one !== 'baseline'), klass).toBe(true);
    }
  });

  it('пропускаемый класс объявляет причину, а не молчит', () => {
    for (const one of cases.filter((each) => each.skip !== undefined)) {
      expect(one.skip?.length ?? 0, one.id).toBeGreaterThan(20);
    }
  });
});

describe('корпус легитимных задач', () => {
  const cases = utilityCases();

  it('покрывает все объявленные классы', () => {
    expect([...new Set(cases.map((one) => one.klass))].sort()).toEqual([...UTILITY_CLASSES].sort());
  });

  it('идентификаторы уникальны', () => {
    expect(new Set(cases.map((one) => one.id)).size).toBe(cases.length);
  });

  it('содержит задачи, которые пишут в исходники и требуют сети', () => {
    // Их удаление подняло бы Utility, ничего при этом не доказав: ложные блокировки
    // появляются именно на них.
    expect(cases.some((one) => one.title.includes('ЗАПИСЬЮ'))).toBe(true);
    expect(cases.filter((one) => one.id.startsWith('U-N')).length).toBeGreaterThanOrEqual(2);
  });

  it('корпус не меньше того, на чём считается Utility в доке', () => {
    expect(cases.length).toBeGreaterThanOrEqual(35);
  });
});
