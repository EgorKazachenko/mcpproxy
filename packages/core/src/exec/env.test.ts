import { describe, expect, it } from 'vitest';
import { MINIMAL_PATH, buildEnv } from './env.js';

/**
 * Значение пинуется **литералом**, потому что все остальные утверждения файла сравнивают
 * результат с `MINIMAL_PATH`, импортированным из модуля под тестом, — то есть ожидание
 * едет вместе с реализацией. Замер: с `MINIMAL_PATH = '/attacker/bin'` весь файл оставался
 * зелёным, включая тест, который называется «путь поиска демона». Единственный литерал в
 * ветке жил в интеграционном наборе под `skipIf(!IS_MACOS)`, то есть на Linux-раннере
 * величина, ради защиты которой R23 существует, не утверждалась нигде.
 */
describe('MINIMAL_PATH (R23)', () => {
  it('равен ровно системным каталогам, и это записано литералом', () => {
    expect(MINIMAL_PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('не содержит ни одного каталога, куда мог бы писать пользователь', () => {
    // Смысл константы: ребёнок не должен резолвить бинарь из каталога, подконтрольного
    // тому, кто прислал рецепт.
    for (const dir of MINIMAL_PATH.split(':')) {
      expect(dir.startsWith('/usr/') || dir.startsWith('/bin') || dir.startsWith('/sbin')).toBe(true);
    }
  });
});

describe('buildEnv — allowlist (R23)', () => {
  /**
   * У R23 две половины, и фикстура обязана разводить их: «пропускаем только названное» и
   * «`PATH` всегда константа». Слитая фикстура оставила бы вторую непроверенной.
   */
  it('пропускает только названное, остальное вырезает', () => {
    expect(buildEnv(['PATH'], { PATH: '/usr/bin', SECRET: 'x' }, {})).toEqual({ PATH: MINIMAL_PATH });
    expect(buildEnv(['HOME'], { HOME: '/h', SECRET: 'x' }, {})).toEqual({ HOME: '/h', PATH: MINIMAL_PATH });
  });

  it('даёт минимальный PATH даже при пустом allow — иначе ребёнок не резолвит exec[0]', () => {
    expect(buildEnv([], {}, {})['PATH']).toBe(MINIMAL_PATH);
  });

  it('минимальный PATH побеждает унаследованный, даже когда PATH назван в allow', () => {
    // Самое важное по последствиям: вернуть унаследованный `PATH` вместо константы значит
    // отдать рецепту с `allow: []` путь поиска демона — то есть чужие каталоги с бинарями.
    expect(buildEnv([], { PATH: '/attacker/bin' }, {})['PATH']).toBe(MINIMAL_PATH);
    expect(buildEnv(['PATH'], { PATH: '/attacker/bin' }, {})['PATH']).toBe(MINIMAL_PATH);
  });

  it('имя из allow, которого нет у демона, не приезжает ключом со значением undefined', () => {
    // Ключ с `undefined` не то же самое, что отсутствие ключа: `spawn` передал бы его как
    // пустую строку, и рецепт увидел бы переменную, которой у демона нет.
    const env = buildEnv(['NOT_SET_ANYWHERE'], {}, {});
    expect(Object.keys(env)).toEqual(['PATH']);
  });
});

describe('buildEnv — инъекция режима (R24, R31)', () => {
  it('прокси-переменные доезжают мимо allowlist', () => {
    // Наивная фильтрация лишила бы ребёнка прокси: в `none` это тихо открыло бы сеть, в
    // `seatbelt` — тихо сломало бы её.
    expect(buildEnv([], {}, { HTTP_PROXY: 'http://x' })['HTTP_PROXY']).toBe('http://x');
    expect(buildEnv(['HOME'], { HOME: '/h' }, { HTTPS_PROXY: 'http://x', NODE_EXTRA_CA_CERTS: '/ca.pem' })).toEqual({
      HOME: '/h',
      PATH: MINIMAL_PATH,
      HTTPS_PROXY: 'http://x',
      NODE_EXTRA_CA_CERTS: '/ca.pem',
    });
  });

  it('инъекция бьёт унаследованное значение того же имени', () => {
    expect(buildEnv(['HTTP_PROXY'], { HTTP_PROXY: 'http://daemon' }, { HTTP_PROXY: 'http://sandbox' })['HTTP_PROXY']).toBe(
      'http://sandbox',
    );
  });
});

describe('buildEnv — чистота', () => {
  it('не мутирует base: srt отдаёт process.env тождественно (факт Ф7)', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', SECRET: 'x' };
    const snapshot = { ...base };
    buildEnv(['PATH', 'SECRET'], base, { HTTP_PROXY: 'http://x' });
    expect(base).toEqual(snapshot);
  });

  it('не возвращает ту же ссылку, что base', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    expect(buildEnv(['PATH'], base, {})).not.toBe(base);
  });
});
