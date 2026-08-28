import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { NetworkConfigSchema } from '@anthropic-ai/sandbox-runtime';
import {
  matchesDomainPattern,
  matchesDomainPatternWithPort,
} from '@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js';
import { assertDomainPatterns, isValidDomainPattern, isVendorAcceptableAllow, isWeakened } from './netpolicy.js';

/**
 * Таблица конформанса (R13). Каждая строка зовёт **настоящую вендорскую функцию**, а не
 * наше представление о ней: своего матчера на пути принуждения нет, домены матчит srt, и
 * тест, сверяющий нашу копию с нашей же копией, доказывал бы только внутреннюю
 * непротиворечивость.
 *
 * Порядок аргументов именно `matchesDomainPattern(hostname, pattern)`. Перепутав их,
 * утверждение проваливается в ветку точного сравнения и всегда даёт `false` — то есть
 * тест зеленеет, не проверив ничего.
 */
describe('конформанс с вендорским матчером', () => {
  it('апекс звёздочкой не покрывается, поддомен покрывается', () => {
    expect(matchesDomainPattern('github.com', '*.github.com')).toBe(false);
    expect(matchesDomainPattern('api.github.com', '*.github.com')).toBe(true);
  });

  it('порт в шаблоне сужает запись до этого порта', () => {
    expect(matchesDomainPatternWithPort('api.github.com', 443, 'api.github.com:8443')).toBe(false);
    expect(matchesDomainPatternWithPort('api.github.com', 8443, 'api.github.com:8443')).toBe(true);
    // Шаблон без порта матчит любой — иначе строка выше проверяла бы не сужение, а поломку.
    expect(matchesDomainPatternWithPort('api.github.com', 443, 'api.github.com')).toBe(true);
  });

  /**
   * `deniedDomains` проверяется **раньше** `allowedDomains`. Чистой функции, которую можно
   * было бы позвать, у вендора для этого нет: решение принимает незаэкспортированная
   * `filterNetworkRequest` в `sandbox-manager.js`. Поэтому здесь — детектор дрейфа по
   * порядку в исходнике вендора, а сама **наблюдаемая** проверка (хост в обоих списках
   * отказан живым запросом) стоит в `modes/seatbelt.test.ts`, тест «network.deny рецепта
   * доезжает до deniedDomains и бьёт allow (R53)».
   *
   * Воспроизводить порядок нашим кодом было бы тавтологией: он совпал бы по построению.
   */
  it('в исходнике вендора цикл по deniedDomains стоит раньше цикла по allowedDomains', () => {
    const require_ = createRequire(import.meta.url);
    const managerPath = require_.resolve('@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js');
    const source = readFileSync(managerPath, 'utf8');
    const start = source.indexOf('async function filterNetworkRequest');
    expect(start).toBeGreaterThan(-1);

    const body = source.slice(start, start + 4_000);
    const denyAt = body.indexOf('config.network.deniedDomains');
    const allowAt = body.indexOf('config.network.allowedDomains');
    expect(denyAt).toBeGreaterThan(-1);
    expect(allowAt).toBeGreaterThan(-1);
    expect(denyAt).toBeLessThan(allowAt);
  });

  it('вендор режет слишком широкое, а мы это принимаем — расхождение осознанное (R14)', () => {
    const vendorAccepts = (pattern: string): boolean =>
      NetworkConfigSchema.safeParse({ allowedDomains: [pattern], deniedDomains: [] }).success;

    expect(vendorAccepts('*.com')).toBe(false);
    expect(vendorAccepts('*')).toBe(false);
    expect(vendorAccepts('*.github.com')).toBe(true);
    expect(vendorAccepts('api.github.com:8443')).toBe(true);

    // Наш валидатор шире: он пропускает обе широкие записи, но помечает их ослабленными.
    expect(isValidDomainPattern('*.com')).toBe(true);
    expect(isValidDomainPattern('*')).toBe(true);
  });

  /**
   * Свойство, которое докстринг `isValidDomainPattern` объявляет и которое до этой правки
   * было **ложным**: наш валидатор обязан быть ШИРЕ вендорского, а не строже.
   *
   * ASCII-only фильтр меток отвергал `пример.рф` и `münchen.de`, тогда как вендор их
   * принимает. Схема манифеста доменный синтаксис не проверяет вовсе, значит такой рецепт
   * грузится, хэшируется и попадает в **одобренный человеком** lock — а умирал бы уже на
   * перепроверке перед принуждением, то есть после согласия.
   */
  it('наш валидатор нигде не строже вендорского — ни на одном шаблоне', () => {
    const CASES = [
      'github.com',
      '*.github.com',
      'пример.рф',
      'münchen.de',
      'xn--e1afmkfd.xn--p1ai',
      '中国.cn',
      'api.github.com:8443',
      'localhost',
      'a-b.example.com',
    ];
    const stricterThanVendor = CASES.filter(
      (pattern) =>
        NetworkConfigSchema.safeParse({ allowedDomains: [pattern], deniedDomains: [] }).success &&
        !isValidDomainPattern(pattern),
    );
    expect(stricterThanVendor).toEqual([]);
  });

  it('и всё же отвергает то, что доменом не является ни при каком чтении', () => {
    // Положительный контроль к утверждению выше: «шире вендора» не должно вырождаться в
    // «принимает всё» — иначе перепроверка R13 перестала бы что-либо отбивать.
    for (const pattern of ['http://example.com', 'exa mple.com', 'user@example.com', 'a/b.com']) {
      expect({ pattern, valid: isValidDomainPattern(pattern) }).toEqual({ pattern, valid: false });
    }
  });

  it('наше зеркало вендорского правила совпадает с настоящей схемой на всём наборе', () => {
    // Копия правила живёт у нас (`isVendorAcceptableAllow`), потому что вендор не
    // экспортирует функцию наружу. Копия без сверки устаревает молча — вот сверка.
    const CASES = [
      'github.com',
      '*.github.com',
      '*.npmjs.org',
      'api.github.com:8443',
      'localhost',
      '*.com',
      '*',
      '*.',
      'example.com/path',
      'http://example.com',
      'com',
      '',
    ];
    for (const pattern of CASES) {
      const vendor = NetworkConfigSchema.safeParse({ allowedDomains: [pattern], deniedDomains: [] }).success;
      expect({ pattern, ours: isVendorAcceptableAllow(pattern) }).toEqual({ pattern, ours: vendor });
    }
  });
});

describe('isWeakened', () => {
  it('бейдж носит голая звёздочка, а не любая (R14)', () => {
    expect(isWeakened(['*'])).toBe(true);
    expect(isWeakened(['*.github.com'])).toBe(false);
    expect(isWeakened(['*.github.com', '*.npmjs.org'])).toBe(false);
    expect(isWeakened([])).toBe(false);
  });

  it('и всё, что вендор считает слишком широким', () => {
    expect(isWeakened(['*.com'])).toBe(true);
    expect(isWeakened(['github.com', '*.com'])).toBe(true);
  });
});

describe('isValidDomainPattern', () => {
  it('пропускает то, что доменом является', () => {
    const VALID = ['github.com', '*.github.com', '*', '*.com', 'localhost', 'api.github.com:8443', '[::1]', '[::1]:443'];
    for (const pattern of VALID) {
      expect({ pattern, valid: isValidDomainPattern(pattern) }).toEqual({ pattern, valid: true });
    }
  });

  it('отвергает то, что доменом не является ни при каком чтении', () => {
    const INVALID = [
      '',
      'http://example.com',
      'example.com/path',
      'exa mple.com',
      'user@example.com',
      '::1:443',
      'e*il.com',
      'com',
    ];
    for (const pattern of INVALID) {
      expect({ pattern, valid: isValidDomainPattern(pattern) }).toEqual({ pattern, valid: false });
    }
  });
});

describe('assertDomainPatterns', () => {
  it('падает закрыто на неразбираемом шаблоне, а не превращает список в пустой (R13)', () => {
    expect(() => assertDomainPatterns(['http://evil.com'], [])).toThrow(/network\.allow/);
    expect(() => assertDomainPatterns([], ['exa mple.com'])).toThrow(/network\.deny/);
    expect(() => assertDomainPatterns(['*.github.com'], ['*'])).not.toThrow();
  });
});
