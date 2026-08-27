import { defineConfig } from 'vitest/config';

// `include` один и покрывает весь `src` — по той же причине, что и в `contracts`: тест,
// положенный мимо шаблона, исчезает молча. Что шаблон и правда покрывает всё, что лежит
// на диске, утверждает `src/coverage.test.ts`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
