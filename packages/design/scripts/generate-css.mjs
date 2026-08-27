/**
 * Генерирует dist/css/tokens.css из скомпилированных токенов.
 *
 * Смысл: значения живут в одном месте (src/tokens.ts). CSS — производная.
 * Руками tokens.css не правят — правка молча разъедется с TS и всплывёт
 * через месяц в виде «в Electron кнопка другого оттенка, чем на слайде».
 */

import { mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const outDir = join(pkg, 'dist', 'css');

const {
  palette, font, fontSize, fontWeight, lineHeight, letterSpacing,
  space, radius, shadow, motion, zIndex, dark, light,
} = await import(join(pkg, 'dist', 'index.js'));

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Плоский объект темы → строки CSS-переменных. */
function themeVars(theme) {
  const out = [];
  for (const [group, entries] of Object.entries(theme)) {
    for (const [key, value] of Object.entries(entries)) {
      const name = key === 'base' ? group : `${group}-${kebab(key)}`;
      out.push(`  --${name}: ${value};`);
    }
  }
  return out.join('\n');
}

function scaleVars() {
  const out = [];
  for (const [name, scale] of Object.entries(palette)) {
    for (const [step, value] of Object.entries(scale)) {
      out.push(`  --op-${name}-${step}: ${value};`);
    }
  }
  return out.join('\n');
}

function flatVars(prefix, obj) {
  return Object.entries(obj)
    .map(([k, v]) => `  --${prefix}-${kebab(k)}: ${v};`)
    .join('\n');
}

const css = `/* Сгенерировано scripts/generate-css.mjs — не редактировать вручную.
   Источник: packages/design/src/tokens.ts */

:root {
  /* ── Палитра Opera ─────────────────────────────────────────────── */
${scaleVars()}

  /* ── Типографика ───────────────────────────────────────────────── */
  --font-sans: ${font.sans};
  --font-mono: ${font.mono};
${flatVars('text', fontSize)}
${flatVars('weight', fontWeight)}
${flatVars('leading', lineHeight)}
${flatVars('tracking', letterSpacing)}

  /* ── Пространство и форма ──────────────────────────────────────── */
${flatVars('space', space)}
${flatVars('radius', radius)}
${flatVars('shadow', shadow)}

  /* ── Движение и слои ───────────────────────────────────────────── */
${flatVars('motion', motion)}
${flatVars('z', zIndex)}

  /* ── Тема по умолчанию: светлая ────────────────────────────────── */
${themeVars(light)}

  color-scheme: light dark;
}

/* Системная тема = тёмная, если пользователь не выбрал явно светлую.
   Тёмная — основная: приложение живёт рядом с терминалом. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
${themeVars(dark)}
  }
}

/* Явный выбор пользователя всегда побеждает — в обе стороны. */
:root[data-theme='dark'] {
${themeVars(dark)}
}

:root[data-theme='light'] {
${themeVars(light)}
}
`;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'tokens.css'), css, 'utf8');

const srcCss = join(pkg, 'src', 'css');
for (const file of await readdir(srcCss)) {
  if (file.endsWith('.css')) await copyFile(join(srcCss, file), join(outDir, file));
}

console.log('design: dist/css готов');
