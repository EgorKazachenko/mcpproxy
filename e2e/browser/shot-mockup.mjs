/**
 * Рендерит макет в PNG — по снимку на каждое состояние из `__listStates()`.
 *
 * Дизайн-критик должен смотреть на пиксели, а не на исходник: переполнение,
 * клиппинг, съехавшее выравнивание и недобор контраста существуют только в
 * растре. Поэтому макет обязан объявлять свои состояния сам — статический
 * снимок показал бы одно состояние из семнадцати.
 *
 *   node e2e/browser/shot-mockup.mjs <mockup.html> <outDir>
 *
 * Переменные окружения:
 *   THEME=dark|light|both   какие темы снимать (по умолчанию both)
 *   ONLY=id,id              снимать только эти состояния
 *   LIGHT_ONLY=id,id        в светлой теме снимать только эти
 *   VIEWPORT=1400x900       размер окна
 *   DSF=1                   масштаб устройства
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('usage: node e2e/browser/shot-mockup.mjs <mockup.html> <outDir>');
  process.exit(2);
}

const themeArg = process.env.THEME ?? 'both';
const themes = themeArg === 'both' ? ['dark', 'light'] : [themeArg];
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const lightOnly = process.env.LIGHT_ONLY ? new Set(process.env.LIGHT_ONLY.split(',')) : null;
const [width, height] = (process.env.VIEWPORT ?? '1400x900').split('x').map(Number);
const deviceScaleFactor = Number(process.env.DSF ?? 1);

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor });

const failures = [];
page.on('pageerror', (err) => failures.push(`pageerror: ${err.message}`));
page.on('console', (msg) => { if (msg.type() === 'error') failures.push(`console: ${msg.text()}`); });

await page.goto(pathToFileURL(resolve(input)).href, { waitUntil: 'load' });

const states = await page.evaluate(() => {
  if (typeof window.__listStates !== 'function') return null;
  return window.__listStates();
});

if (!states) {
  console.error('макет не объявляет __listStates() — снимать нечего, кроме одного кадра');
  await browser.close();
  process.exit(1);
}

const shot = [];
for (const theme of themes) {
  await page.evaluate((t) => window.__setTheme(t), theme);
  for (const state of states) {
    if (only && !only.has(state.id)) continue;
    if (theme === 'light' && lightOnly && !lightOnly.has(state.id)) continue;
    await page.evaluate((id) => window.__setState(id), state.id);
    await page.waitForTimeout(60);
    const path = `${outDir}/${state.id}--${theme}.png`;
    await page.screenshot({ path, fullPage: true });
    shot.push(path);
  }
}

await browser.close();

console.log(`${shot.length} снимков в ${outDir}`);
for (const p of shot) console.log(`  ${p}`);
if (failures.length) {
  console.log('\nОшибки страницы во время съёмки:');
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
