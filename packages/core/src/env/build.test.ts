import { describe, expect, it } from 'vitest';
import { alnum } from '../redact/secret-samples.js';
import { MINIMAL_PATH, buildEnv } from './build.js';

/**
 * И4: секреты не попадают в процесс. Это **настоящая** защита, а редакция вывода —
 * страховочная сетка, поэтому тесты здесь про отсутствие, а не про вырезание.
 */

describe('buildEnv', () => {
  it('пропускает только имена из allowlist', () => {
    const { env } = buildEnv(['HOME', 'LANG'], {
      HOME: '/Users/dev',
      LANG: 'ru_RU.UTF-8',
      AWS_SECRET_ACCESS_KEY: alnum(40),
      GITHUB_TOKEN: `ghp_${alnum(36)}`,
    });

    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH']);
    expect(JSON.stringify(env)).not.toContain(alnum(40));
    expect(JSON.stringify(env)).not.toContain('ghp_');
  });

  it('не «всё кроме запрещённого»: имя вне листа не проходит, даже будучи безобидным', () => {
    const { env } = buildEnv(['HOME'], { HOME: '/Users/dev', EDITOR: 'vim' });
    expect('EDITOR' in env).toBe(false);
  });

  it('R2: разрешённое, но не заданное имя ОТСУТСТВУЕТ как ключ, а не равно пустой строке', () => {
    const { env } = buildEnv(['HOME', 'GIT_DIR'], { HOME: '/Users/dev' });

    // Именно `in`, а не `toBeUndefined()`: `{GIT_DIR: undefined}` и `{GIT_DIR: ''}` оба дают
    // falsy при чтении, но `spawn` превращает первое в отсутствие переменной, а второе — в
    // заданную пустую. `git` с `GIT_DIR=''` ведёт себя не как `git` без `GIT_DIR`.
    expect('GIT_DIR' in env).toBe(false);
    expect(Object.keys(env)).not.toContain('GIT_DIR');
  });

  it('заданная пустая строка — это ЗАДАННОЕ значение и проходит', () => {
    // Обратная сторона предыдущего: «известно и пусто» отличается от «не задано» и здесь тоже.
    const { env } = buildEnv(['CI'], { CI: '' });
    expect('CI' in env).toBe(true);
    expect(env.CI).toBe('');
  });

  it('R3: PATH есть всегда — даже когда его нет ни в листе, ни в окружении', () => {
    const { env } = buildEnv([], {});
    expect(env.PATH).toBe(MINIMAL_PATH);
  });

  it('R3: PATH из окружения выигрывает, когда он разрешён и задан', () => {
    const { env } = buildEnv(['PATH'], { PATH: '/opt/homebrew/bin:/usr/bin' });
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('R3: PATH разрешён, но в окружении отсутствует — минимальный, а не пропажа', () => {
    const { env } = buildEnv(['PATH'], {});
    expect(env.PATH).toBe(MINIMAL_PATH);
  });

  it('R3: PATH окружения НЕ протекает, когда он вне листа', () => {
    // Иначе `PATH`, собранный direnv из каталога проекта, уезжает в песочницу целиком —
    // а он бывает нашпигован путями к приватным тулчейнам.
    const { env } = buildEnv(['HOME'], { HOME: '/Users/dev', PATH: '/Users/dev/.secret-tools/bin' });
    expect(env.PATH).toBe(MINIMAL_PATH);
  });

  it('R4: allowed — отсортированный список без дублей', () => {
    const { allowed } = buildEnv(['LANG', 'HOME', 'LANG'], { HOME: '/Users/dev', LANG: 'C' });
    expect(allowed).toEqual(['HOME', 'LANG', 'PATH']);
  });

  it('R4: allowed описывает то, что дочерний процесс ПОЛУЧИЛ, а не то, что просили', () => {
    // Запись аудита читают через месяцы, и вопрос к ней всегда один: что было у процесса.
    // Политику восстанавливают из снапшота рецепта в lock — для этого она там и лежит целиком.
    const { allowed, env } = buildEnv(['HOME', 'NOT_SET_ANYWHERE'], { HOME: '/Users/dev' });
    expect(allowed).toEqual(['HOME', 'PATH']);
    expect(allowed).toEqual(Object.keys(env).sort());
  });

  it('R4: значения переменных не протекают в allowed', () => {
    const { allowed } = buildEnv(['HOME'], { HOME: '/Users/dev' });
    expect(allowed.join('')).not.toContain('/Users/dev');
  });

  it('R2: унаследованные свойства прототипа НЕ считаются заданными', () => {
    // `source[name]` идёт по цепочке прототипов: `allow: ['toString']` при пустом окружении
    // клал в результат ФУНКЦИЮ. То есть имя, которого в окружении нет, приезжало ключом —
    // прямое нарушение R2, — да ещё с нестроковым значением в типе `Record<string, string>`,
    // который E3 отдаёт `spawn`, а запись аудита при этом утверждала, что такая переменная
    // у процесса была.
    const { env, allowed } = buildEnv(['toString', 'constructor', 'hasOwnProperty', 'valueOf'], {});
    expect(Object.keys(env)).toEqual(['PATH']);
    expect(allowed).toEqual(['PATH']);
  });

  it('R2: унаследованная СТРОКА тоже не считается заданной', () => {
    // Проверка типа значения ловит унаследованные функции, но не строки: при загрязнённом
    // `Object.prototype` имя, которого в окружении нет, снова приезжало бы ключом. Владение,
    // а не тип, — вот что здесь несущее.
    const source = Object.create({ INHERITED: 'из прототипа' }) as Record<string, string>;
    source.OWN = 'своё';

    const { env, allowed } = buildEnv(['OWN', 'INHERITED'], source);
    expect(Object.keys(env).sort()).toEqual(['OWN', 'PATH']);
    expect(allowed).toEqual(['OWN', 'PATH']);
  });

  it('R2: собственное свойство с тем же именем проходит — запрет не по имени, а по владению', () => {
    const { env } = buildEnv(['toString'], { toString: '/usr/bin/toString' });
    expect(env.toString).toBe('/usr/bin/toString');
  });

  it('нестроковое значение отбрасывается, а не уезжает в spawn', () => {
    // `source`, пришедший из `JSON.parse`, строками не ограничен.
    const { env } = buildEnv(['A', 'B'], { A: 'ок', B: 42 as unknown as string });
    expect(Object.keys(env).sort()).toEqual(['A', 'PATH']);
  });

  it('__proto__ в allowlist не задевает прототип и не появляется ключом', () => {
    // Манифест весь остальной E6 считает недоверенным входом; `allow` приезжает оттуда.
    const source = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, string>;
    const { env } = buildEnv(['__proto__'], source);

    expect(Object.keys(env)).toEqual(['PATH']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('EO5: провенанс PATH отдаётся наружу', () => {
    // Без него запись аудита утверждает, что у процесса был `PATH`, и умалчивает, ЧЕЙ.
    // Разбор инцидента «под-вызов не нашёл бинарь» начинается ровно с этого вопроса.
    expect(buildEnv(['PATH'], { PATH: '/opt/homebrew/bin' }).pathSubstituted).toBe(false);
    expect(buildEnv([], {}).pathSubstituted).toBe(true);
    expect(buildEnv(['HOME'], { HOME: '/h', PATH: '/leak' }).pathSubstituted).toBe(true);
  });

  it('R3: пустой PATH из окружения заменяется минимальным, а не отдаётся как есть', () => {
    // Единственное место, где общее правило R2 («пустая строка — заданное значение») не
    // действует: `PATH: ''` ломает под-вызовы дочернего процесса ровно так же, как
    // отсутствующий, а `MINIMAL_PATH` заведён именно для этого случая.
    const { env, pathSubstituted } = buildEnv(['PATH'], { PATH: '' });
    expect(env.PATH).toBe(MINIMAL_PATH);
    expect(pathSubstituted).toBe(true);
  });

  it('исходное окружение не мутируется', () => {
    const source = { HOME: '/Users/dev' };
    const { env } = buildEnv(['HOME'], source);
    env.HOME = '/tmp/hijacked';
    expect(source.HOME).toBe('/Users/dev');
  });
});
