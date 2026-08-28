import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Структурный страж границы — обходом AST и по всему `src`.
 *
 * Вместо линтера: единственный плагин с такими правилами имеет одного мейнтейнера и в
 * собственной документации признаёт, что проверяет факт наличия защиты, а не её корректность.
 *
 * Две правки против прежней редакции, и обе — про то, что она пропускала.
 *
 * **По AST, а не грепом.** Прежняя проверяла исходник регуляркой, поэтому `webContents.send`
 * в JSDoc `dispatch.ts` считался вызовом. Ложное срабатывание стража хуже пропуска: страж,
 * который врёт, отключают.
 *
 * **По всему `src`, а не по верхнему уровню `main`.** Прежняя звала `readdir` без
 * `recursive`, то есть `ipcMain.handle` в подкаталоге `main/`, в `shared/` или в `preload/`
 * не видела вовсе — а именно туда и переезжает код, когда файл разрастается.
 */

const SRC = new URL('../', import.meta.url).pathname;

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map((e) => relative(SRC, join(e.parentPath, e.name)));
}

const parse = (source: string, name: string): ts.SourceFile =>
  ts.createSourceFile(name, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** `x.y(...)` с заданными именами объекта и метода — вызов, а не упоминание в комментарии. */
const isMethodCall = (node: ts.Node, object: string, methods: readonly string[]): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === object &&
  methods.includes(node.expression.name.text);

const isNewOf = (node: ts.Node, name: string): boolean =>
  ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

/**
 * Отправка в рендерер опознаётся по КАНАЛУ, а не по имени приёмника.
 *
 * Настоящий вызов в `dispatch.ts` — `contents.send(UI_CHANNEL, event)` на локальной
 * переменной, и правило «объект зовётся `webContents`» его не видит. Канал же в вызове
 * назван всегда: без него сообщение просто не уедет.
 */
const isChannelSend = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === 'send' &&
  node.arguments[0] !== undefined &&
  ts.isIdentifier(node.arguments[0]) &&
  node.arguments[0].text === 'UI_CHANNEL';

const RULES: ReadonlyArray<readonly [string, string, (node: ts.Node) => boolean]> = [
  ['ipcMain.handle / on / handleOnce', 'main/ipc.ts', (n) => isMethodCall(n, 'ipcMain', ['handle', 'on', 'handleOnce'])],
  ['отправка по UI_CHANNEL', 'main/dispatch.ts', isChannelSend],
  ['new BrowserWindow', 'main/window.ts', (n) => isNewOf(n, 'BrowserWindow')],
];

describe('структурный страж границы', () => {
  it.each(RULES)('%s встречается только в %s', async (_label, owner, matches) => {
    const offenders: string[] = [];

    for (const name of await sourceFiles()) {
      const tree = parse(await readFile(join(SRC, name), 'utf8'), name);
      let hit = false;
      walk(tree, (node) => {
        if (matches(node)) hit = true;
      });
      if (hit && name !== owner) offenders.push(name);
    }

    expect(offenders).toEqual([]);
    // Положительный контроль: владелец обязан вызов СОДЕРЖАТЬ. Без него правило становится
    // зелёным в тот день, когда вызов переименуют, — и страж перестаёт стеречь молча.
    const ownerTree = parse(await readFile(join(SRC, owner), 'utf8'), owner);
    let ownerHit = false;
    walk(ownerTree, (node) => {
      if (matches(node)) ownerHit = true;
    });
    expect(ownerHit).toBe(true);
  });

  /**
   * `R2` требует, чтобы тест падал на изменении **любого** из четырёх флагов. Три доказаны на
   * созданном окне смоуком (`process.sandboxed`, `process.contextIsolated`, отсутствие узловых
   * глобалей); четвёртый, `webSecurity`, со страницы не наблюдаем — `connect-src 'self'` режет
   * кросс-ориджин запрос раньше, чем он проверил бы флаг.
   *
   * Поэтому четвёртый закрывается структурно: единственный `new BrowserWindow` обязан брать
   * `webPreferences` целиком у `webPreferencesFor` и не имеет права ни разложить его спредом,
   * ни дописать ключ рядом. Прежде дописать `webSecurity: false` внутри `window.ts` не мешало
   * ничто — юнит фабрики остался бы зелёным, потому что про место вызова он не знает.
   */
  it('единственное окно получает webPreferences целиком от webPreferencesFor', async () => {
    const owner = 'main/window.ts';
    const tree = parse(await readFile(join(SRC, owner), 'utf8'), owner);

    const created: ts.NewExpression[] = [];
    walk(tree, (node) => {
      if (isNewOf(node, 'BrowserWindow')) created.push(node as ts.NewExpression);
    });

    expect(created).toHaveLength(1);
    const options = created[0]?.arguments?.[0];
    expect(options !== undefined && ts.isObjectLiteralExpression(options)).toBe(true);
    if (options === undefined || !ts.isObjectLiteralExpression(options)) return;

    // Спред в опциях окна означает, что настройки пришли откуда-то ещё и могли быть ослаблены.
    expect(options.properties.filter((p) => ts.isSpreadAssignment(p))).toHaveLength(0);

    const preferences = options.properties.find(
      (p): p is ts.PropertyAssignment =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'webPreferences',
    );
    expect(preferences).toBeDefined();

    const value = preferences?.initializer;
    const fromFactory =
      value !== undefined &&
      ts.isCallExpression(value) &&
      ts.isIdentifier(value.expression) &&
      value.expression.text === 'webPreferencesFor';
    expect(fromFactory).toBe(true);
  });
});
