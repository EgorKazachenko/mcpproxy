import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { init, parse } from 'es-module-lexer';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PACKAGE = resolve(new URL('../../', import.meta.url).pathname);
const FORBIDDEN = ['node:crypto', 'ajv', 're2', 'yaml'];

let app: ElectronApplication;
let page: Page;

beforeAll(async () => {
  app = await electron.launch({
    args: ['.'],
    cwd: PACKAGE,
    env: { ...process.env, MCPPROXY_OBSERVE: '1' },
  });
  page = await app.firstWindow();
  await page.waitForSelector('.chrome');
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('И8 на созданном окне', () => {
  /**
   * Требование просит фактические настройки **созданного окна**, а не фабрики: вызов вида
   * `new BrowserWindow({ webPreferences: { ...webPreferencesFor(...), sandbox: false } })`
   * прошёл бы юнит фабрики целиком.
   *
   * Читается `process.sandboxed` из preload, а не настройки окна: публичного API для чтения
   * применённых `webPreferences` у `WebContents` нет — я предполагал обратное, и тайпчек это
   * отверг. Замена оказалась строго сильнее: она показывает **эффект** флага в самом процессе
   * рендерера, а не то, что было запрошено при создании.
   */
  it('песочница и изоляция контекста действительно применены', async () => {
    const observed = await page.evaluate(() => window.__mcpproxyObserve);
    expect(observed).toEqual({ sandboxed: true, contextIsolated: true });
  });

  /**
   * Второй рубеж, и он слабее первого: при `contextIsolation` и `nodeIntegration: false`
   * этих глобалей в главном мире нет **независимо** от песочницы. Утверждение доказывает
   * изоляцию и отсутствие интеграции Node, но про `sandbox` не говорит ничего.
   */
  it('узловых глобалей в странице нет', async () => {
    const globals = await page.evaluate(() => ({
      require: typeof (globalThis as Record<string, unknown>)['require'],
      process: typeof (globalThis as Record<string, unknown>)['process'],
      module: typeof (globalThis as Record<string, unknown>)['module'],
    }));
    expect(globals).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined' });
  });

  it('мост выставлен, а ipcRenderer наружу не отдан', async () => {
    const bridge = await page.evaluate(() => ({
      methods: Object.keys(window.mcpproxy).sort(),
      frozen: Object.isFrozen(window.mcpproxy),
      ipcRenderer: typeof (globalThis as Record<string, unknown>)['ipcRenderer'],
    }));
    expect(bridge).toEqual({ methods: ['onEvent', 'send'], frozen: true, ipcRenderer: 'undefined' });
  });
});

describe('схема приложения', () => {
  const fetchFromPage = async (path: string): Promise<{ status: number; csp: string | null }> =>
    page.evaluate(async (target) => {
      const response = await fetch(target);
      return { status: response.status, csp: response.headers.get('content-security-policy') };
    }, path);

  /**
   * Запросом из страницы, а не навигацией: `will-navigate` отклоняет всё, и переход до
   * обработчика схемы просто не дошёл бы.
   */
  it('политика приходит заголовком и строга', async () => {
    const { csp } = await fetchFromPage('app://bundle/index.html');
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-(eval|inline)/);
  });

  it('обход путей через процентное кодирование отклонён', async () => {
    const { status } = await fetchFromPage('app://bundle/%2e%2e/%2e%2e/etc/passwd');
    expect(status).toBe(404);
  });
});

describe('граница IPC на живом окне', () => {
  /**
   * Единственный юнит `senderRejection` сравнивает константу с самой собой — тавтология по
   * построению. Что настоящий origin схемы действительно принимается, проверяется только
   * здесь, на запущенном приложении.
   */
  it('сообщение из окна приложения принимается', async () => {
    const reply = await page.evaluate(() => window.mcpproxy.send({ kind: 'hello' }));
    expect(reply.ok).toBe(true);
  });

  it('нагрузка, не прошедшая разбор, отклоняется кодом', async () => {
    const reply = await page.evaluate(() => window.mcpproxy.send({ kind: 'нечто' }));
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe('bad-payload');
  });
});

describe('рендерер не тянет узловых зависимостей', () => {
  const requireFrom = createRequire(join(PACKAGE, 'package.json'));

  /**
   * Голые специфаеры, ДОСТИЖИМЫЕ из входа по относительным импортам.
   *
   * Обход графа, а не каталога: первая редакция читала весь `dist` пакета целиком и находила
   * `re2`, `yaml` и `node:crypto` — но не как утечку, а потому что видела входы `validate` и
   * `audit`, которых корневой вход не импортирует. Тест упал громко и на собственном дефекте,
   * что лучше, чем зелень на ложном основании.
   */
  async function bareSpecifiers(entries: readonly string[]): Promise<Set<string>> {
    await init;
    const found = new Set<string>();
    const seen = new Set<string>();
    const queue = [...entries];

    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);

      const source = await readFile(file, 'utf8').catch(() => null);
      if (source === null) continue;

      for (const imported of parse(source)[0]) {
        const specifier = imported.n;
        if (specifier === undefined) continue;
        if (specifier.startsWith('.')) queue.push(resolve(dirname(file), specifier));
        else found.add(specifier);
      }
    }
    return found;
  }

  async function emittedFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => join(e.parentPath, e.name));
  }

  /**
   * Обход идёт по эмиту `tsc`, а не по бандлу и не по исходникам.
   *
   * В исходниках лексер JS не отличает `import type` от значимого импорта; в бандле Rollup
   * встраивает случайно значимый импорт внутрь, не оставив специфаера. Обе проверки вернули
   * бы зелёное на той самой регрессии, которую ловят.
   *
   * И обход обязан **входить внутрь зависимости**: код рендерера импортирует
   * `@mcpproxy/contracts` голым специфаером, поэтому проход только по своему эмиту показал бы
   * его и никогда `node:crypto` — независимо от того, есть утечка или нет.
   */
  it('ни рендерер, ни его зависимости не тянут node:crypto, ajv, re2 и yaml', async () => {
    execFileSync('./node_modules/.bin/tsc', ['-p', 'packages/desktop/tsconfig.deps.json'], {
      cwd: resolve(PACKAGE, '../..'),
      stdio: 'pipe',
    });

    const own = await bareSpecifiers(await emittedFiles(join(PACKAGE, 'dist', 'deps')));
    const reachable = new Set(own);

    for (const specifier of own) {
      if (!specifier.startsWith('@mcpproxy/')) continue;
      for (const nested of await bareSpecifiers([requireFrom.resolve(specifier)])) reachable.add(nested);
    }

    expect([...reachable].filter((s) => FORBIDDEN.includes(s))).toEqual([]);
  });

  /** Проверка обязана уметь падать: без входа внутрь зависимости она была бы тавтологией. */
  it('обход действительно доходит до зависимостей, а не только до своих файлов', async () => {
    const own = await bareSpecifiers(await emittedFiles(join(PACKAGE, 'dist', 'deps')));
    expect([...own]).toContain('@mcpproxy/contracts');
  });
});
