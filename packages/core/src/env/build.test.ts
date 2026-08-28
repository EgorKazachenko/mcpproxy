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

  /**
   * Правило сведено с R23 эпика песочницы и с D10 этой спеки: константа побеждает **всегда**,
   * даже когда рецепт назвал `PATH` в листе.
   *
   * Прежняя редакция наследовала окружение в этом случае — и била по каноническому примеру
   * `docs/07-contracts.md:35`, где `allow` содержит `PATH`. Рецепт, назвавший переменную ради
   * переносимости, тихо получал путь поиска демона; рецепт, не назвавший ничего, — не получал.
   * Одно имя значило разное в зависимости от машины.
   */
  it('R3: PATH из окружения НЕ выигрывает, даже когда он разрешён и задан', () => {
    const { env } = buildEnv(['PATH'], { PATH: '/opt/homebrew/bin:/usr/bin' });
    expect(env.PATH).toBe(MINIMAL_PATH);
  });

  it('R3: и в листе, и вне листа результат один — иначе имя значит разное', () => {
    const named = buildEnv(['PATH'], { PATH: '/Users/dev/.secret-tools/bin' }).env.PATH;
    const unnamed = buildEnv([], { PATH: '/Users/dev/.secret-tools/bin' }).env.PATH;
    expect(named).toBe(unnamed);
    expect(named).toBe(MINIMAL_PATH);
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

  /**
   * `__proto__` обязан **доезжать переменной**, а не исчезать.
   *
   * Тест выше про загрязнение прототипа ловит другую половину: со свежим литералом `{}`
   * присваивание `env.__proto__ = '<строка>'` уходит в СЕТТЕР и молча не делает ничего —
   * прототип цел, переменная потеряна, и ни одно утверждение этого не видело. Замер:
   * подмена `Object.create(null)` на `{}` оставляла файл полностью зелёным.
   *
   * Источник строится `JSON.parse`, потому что литерал `{ __proto__: … }` задаёт прототип,
   * а не собственный ключ, — то есть фикстура, написанная литералом, проверяла бы не то.
   */
  it('R2: имя `__proto__` доезжает как обычная переменная, а не теряется молча', () => {
    const source = JSON.parse('{"__proto__":"/значение"}') as Record<string, string>;
    const { env, allowed } = buildEnv(['__proto__'], source);

    expect(Object.keys(env).sort()).toEqual(['PATH', '__proto__']);
    expect(allowed).toContain('__proto__');
    expect(Object.getOwnPropertyDescriptor(env, '__proto__')?.value).toBe('/значение');
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

  /**
   * Поле `pathSubstituted` снято вместе с наследованием: при константе, побеждающей всегда,
   * оно тождественно истинно, а провенанс, который не меняется, — не провенанс.
   */
  it('R3: значение MINIMAL_PATH пинуется литералом, а не символом из модуля под тестом', () => {
    // Иначе ожидание едет вместе с реализацией: подмена константы на `/attacker/bin`
    // оставляла бы весь файл зелёным, включая тест про «путь поиска демона».
    expect(MINIMAL_PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('R3: пустой PATH из окружения тоже не отдаётся — как и любой другой', () => {
    expect(buildEnv(['PATH'], { PATH: '' }).env.PATH).toBe(MINIMAL_PATH);
  });

  it('исходное окружение не мутируется', () => {
    const source = { HOME: '/Users/dev' };
    const { env } = buildEnv(['HOME'], source);
    env.HOME = '/tmp/hijacked';
    expect(source.HOME).toBe('/Users/dev');
  });

  /**
   * Третий параметр — переменные, которые вливает **режим песочницы** (прокси и доверие к CA
   * в режиме `none`), и он проходит **мимо** allowlist намеренно: это не переменные рецепта, а
   * механика песочницы. Провести их через фильтр значило бы дать манифесту право отключить
   * наблюдение за собственной сетью.
   */
  describe('инъекция режима', () => {
    it('доезжает мимо allowlist', () => {
      const { env } = buildEnv([], {}, { HTTP_PROXY: 'http://localhost:1', NODE_EXTRA_CA_CERTS: '/ca.pem' });
      expect(env.HTTP_PROXY).toBe('http://localhost:1');
      expect(env.NODE_EXTRA_CA_CERTS).toBe('/ca.pem');
    });

    it('перекрывает унаследованное значение того же имени', () => {
      const { env } = buildEnv(['HTTP_PROXY'], { HTTP_PROXY: 'http://daemon' }, { HTTP_PROXY: 'http://sandbox' });
      expect(env.HTTP_PROXY).toBe('http://sandbox');
    });

    it('по умолчанию пуста — в seatbelt прокси вшивает в строку команды сам srt', () => {
      expect(Object.keys(buildEnv(['HOME'], { HOME: '/h' }).env).sort()).toEqual(['HOME', 'PATH']);
    });

    it('не приносит ключей со значением не-строкой', () => {
      const { env } = buildEnv([], {}, { A: undefined });
      expect('A' in env).toBe(false);
    });

    it('попадает в allowed — это то, что процесс ПОЛУЧИЛ', () => {
      const { allowed } = buildEnv(['HOME'], { HOME: '/h' }, { HTTP_PROXY: 'http://x' });
      expect(allowed).toEqual(['HOME', 'HTTP_PROXY', 'PATH']);
    });
  });
});
