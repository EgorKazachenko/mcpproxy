import { defineConfig } from 'vitest/config';

// `include` один и покрывает весь `src` — по той же причине, что и в `contracts`: тест,
// положенный мимо шаблона, исчезает молча. Что шаблон и правда покрывает всё, что лежит на
// диске, утверждают `src/coverage.test.ts` (E6) и `src/policy/runner.test.ts` (E1) — первый
// сверяет список файлов с шаблоном, второй закрепляет сам шаблон.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
