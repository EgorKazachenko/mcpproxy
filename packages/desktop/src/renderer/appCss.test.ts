import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Компонентный слой перенесён руками из замороженного макета, и автоматической связи с ним
 * нет — это записано в заметках передачи как известная хрупкость. Один класс хрупкости
 * проверяем машиной, потому что он тихий и дорогой: **селектор по id**.
 *
 * Первый перенос принёс `#app{display:flex;…}` — корень макета. Точка монтирования
 * приложения зовётся `#root`, поэтому правило не совпадало ни с чем, и весь флекс-каркас
 * ниже молча не применялся: панели не скроллились сами, шапка уезжала вверх вместе со
 * списком. Ни один тест этого не видел, потому что тесты смотрят на разметку и на строки, а
 * не на то, применился ли CSS.
 *
 * Классы так не проверить — их сотни, и «класс объявлен, но не использован» законно. Id в
 * этом файле ровно один, и он обязан существовать в разметке.
 */

const RENDERER = new URL('.', import.meta.url).pathname;

const idSelectors = (css: string): readonly string[] => [
  ...new Set([...css.matchAll(/(^|[\s,>+~{])#([A-Za-z][\w-]*)/g)].map((m) => m[2] ?? '')),
];

async function markupSources(): Promise<string[]> {
  const entries = await readdir(RENDERER, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && (/\.tsx$/.test(e.name) || e.name === 'index.html'))
    .map((e) => relative(RENDERER, join(e.parentPath, e.name)));
}

describe('app.css против разметки', () => {
  it('каждый id-селектор существует в index.html или в разметке рендерера', async () => {
    const css = await readFile(join(RENDERER, 'app.css'), 'utf8');
    const ids = idSelectors(css);

    // Положительный контроль: зонд действительно что-то нашёл. Пустой список сделал бы
    // проверку ниже зелёной навсегда — ровно тот отказ, который она и ловит.
    expect(ids.length).toBeGreaterThan(0);

    const names = await markupSources();
    const markup = (await Promise.all(names.map((n) => readFile(join(RENDERER, n), 'utf8')))).join('\n');

    const missing = ids.filter((id) => !markup.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it('зонд умеет краснеть: id, которого в разметке нет, находится', async () => {
    const markup = await readFile(join(RENDERER, 'index.html'), 'utf8');
    expect(idSelectors('#app{display:flex}').filter((id) => !markup.includes(`id="${id}"`))).toEqual(['app']);
  });
});
