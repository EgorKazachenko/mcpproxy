import { writeFileSync } from 'node:fs';

/**
 * Обновление замороженного снапшота публичной поверхности.
 *
 * Отдельный скрипт, а не ветка внутри теста, и это принципиально: гейт, который умеет
 * переписать собственный эталон по переменной окружения, гейтом не является — переменная,
 * выставленная один раз, делает его зелёным навсегда. `vitest run` до этого файла не
 * дотягивается, запустить его можно только руками.
 *
 * Запускать вместе с бампом `CONTRACTS_VERSION` и явным решением владельца — правило
 * записано в `docs/07-contracts.md`. Требует свежего `dist`: сначала `yarn build`.
 *
 *     node scripts/update-api-surface.mjs
 */
const { currentApiSurface, API_SURFACE_SNAPSHOT } = await import('../dist/api-surface.js');

const surface = currentApiSurface();
writeFileSync(API_SURFACE_SNAPSHOT, surface);
console.log(`api-surface: снапшот переписан, ${surface.split('\n').length} строк`);
