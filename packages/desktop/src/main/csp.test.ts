import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cspFor, cspModeFrom } from './csp.js';
import { resolveBundlePath } from './protocol.js';

describe('cspFor', () => {
  it('не разрешает ни eval, ни инлайн ни в одном режиме', () => {
    expect(cspFor('production')).not.toMatch(/unsafe-(eval|inline)/);
    expect(cspFor('development')).not.toMatch(/unsafe-(eval|inline)/);
  });

  /**
   * Три директивы от `default-src` **не наследуются**: политика с `default-src 'none'` всё
   * ещё позволяет встроить страницу кому угодно. Утверждения раздельные, чтобы удаление
   * одной директивы валило ровно одно из них и называло, какая исчезла.
   */
  it.each(['base-uri', 'form-action', 'frame-ancestors'])('задаёт %s явно', (directive) => {
    expect(cspFor('production')).toMatch(new RegExp(`${directive} 'none'`));
  });

  it('разрешает веб-сокет HMR только в разработке', () => {
    expect(cspFor('development')).toMatch(/ws:\/\/localhost/);
    expect(cspFor('production')).not.toMatch(/ws:/);
  });
});

describe('cspModeFrom', () => {
  /**
   * Отсутствующее значение обязано падать в строгую политику: в собранном бандле главного
   * процесса переменная не гарантирована, и мягкая политика уехала бы в отгрузку молча.
   */
  it.each([undefined, '', 'production', 'test', 'нечто'])('%s → production', (value) => {
    expect(cspModeFrom(value)).toBe('production');
  });

  it('development → development', () => {
    expect(cspModeFrom('development')).toBe('development');
  });
});

describe('resolveBundlePath', () => {
  let root = '';
  let outside = '';

  beforeAll(async () => {
    // WHY: на macOS /var — симлинк на /private/var, и `resolveBundlePath` честно возвращает
    // разрешённую форму. Сравнивать надо с ней же, иначе тест падает на платформе, а не на
    // дефекте.
    const base = await realpath(await mkdtemp(join(tmpdir(), 'mcpproxy-bundle-')));
    root = join(base, 'bundle');
    outside = join(base, 'secret.txt');
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'index.html'), '<!doctype html>');
    await writeFile(join(root, 'assets', 'app.js'), 'export {};');
    await writeFile(outside, 'секрет');
    await symlink(outside, join(root, 'escape.txt'));
  });

  afterAll(async () => {
    if (root !== '') await rm(join(root, '..'), { recursive: true, force: true });
  });

  it('отдаёт файл внутри бандла', async () => {
    await expect(resolveBundlePath('/assets/app.js', root)).resolves.toBe(join(root, 'assets', 'app.js'));
  });

  it('корень отображается в index.html', async () => {
    await expect(resolveBundlePath('/', root)).resolves.toBe(join(root, 'index.html'));
  });

  /**
   * Процентное кодирование доживает до обработчика: стандартная схема нормализует точечные
   * сегменты в URL, но `%2e%2e` она таковым не считает. Без раскрытия и проверки вхождения
   * в корень это прямой обход.
   */
  it('отклоняет обход через процентное кодирование', async () => {
    await expect(resolveBundlePath('/%2e%2e/%2e%2e/etc/passwd', root)).resolves.toBeNull();
  });

  it('отклоняет обычный обход точками', async () => {
    await expect(resolveBundlePath('/../../etc/passwd', root)).resolves.toBeNull();
  });

  /**
   * Цель обхода **существует** — это принципиально. С несуществующей целью тест зеленеет от
   * того, что `realpath` упал, а не от того, что проверка вхождения сработала: проверено
   * мутацией, снятие проверки вхождения такой случай не роняет. Здесь `secret.txt` лежит
   * рядом с корнем бандла и читается без всякого симлинка.
   */
  it.each(['/../secret.txt', '/%2e%2e/secret.txt'])(
    'отклоняет обход на существующий файл за границей: %s',
    async (path) => {
      await expect(resolveBundlePath(path, root)).resolves.toBeNull();
    },
  );

  /**
   * Инвариант И3 этого же проекта: проверка «строка не содержит две точки» обходится
   * симлинком за десять секунд, поэтому вхождение в корень проверяется ПОСЛЕ realpath.
   */
  it('отклоняет симлинк, ведущий за границу бандла', async () => {
    await expect(resolveBundlePath('/escape.txt', root)).resolves.toBeNull();
  });

  it('отклоняет несуществующий путь, а не бросает', async () => {
    await expect(resolveBundlePath('/нет-такого', root)).resolves.toBeNull();
  });
});
