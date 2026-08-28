import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

/**
 * Три сборки: главный процесс, preload и рендерер.
 *
 * Контракты и дизайн-система **собираются внутрь**, а не выносятся во внешние. Это решение с
 * наибольшим рычагом по разведке: упаковщик тогда никогда не идёт по симлинку `workspace:*`,
 * и целый класс багов «упаковщик плюс yarn workspaces» исчезает по построению.
 *
 * `build.target` задан явно. Таблица версий electron-vite кончается на Electron 39, а промах
 * молча отдаёт последнюю запись — то есть цель уехала бы на chrome108 без единого сообщения.
 */
const TARGET_MAIN = 'node22';
const TARGET_RENDERER = 'chrome134';

const BUNDLED_WORKSPACE_DEPS = ['@mcpproxy/contracts', '@mcpproxy/design'];

export default defineConfig({
  main: {
    build: {
      target: TARGET_MAIN,
      rollupOptions: { external: [], input: resolve(__dirname, 'src/main/index.ts') },
    },
    resolve: { noExternal: BUNDLED_WORKSPACE_DEPS },
  },
  preload: {
    build: {
      target: TARGET_MAIN,
      rollupOptions: {
        external: [],
        input: resolve(__dirname, 'src/preload/index.ts'),
        // WHY: `.mjs` с CJS-содержимым Electron грузит как ESM, а ESM-preload требует
        // `sandbox: false` — единственное, чем этот продукт торговать не может.
        // Замерено на electron-vite 5.0.0 + Electron 43: одного `format: 'cjs'` уже
        // достаточно, расширение выходит `.cjs` и без пина. Пин оставлен не потому, что без
        // него не работает, а потому что делает гарантию явной: вывод расширения — деталь
        // реализации тулчейна, и менять её он вправе на любом мажоре.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    resolve: { noExternal: BUNDLED_WORKSPACE_DEPS },
  },
  renderer: {
    build: { target: TARGET_RENDERER, rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
});
