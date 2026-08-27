import { describe, expect, it } from 'vitest';
import { MINIMAL_PATH, buildEnv } from './env.js';

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
