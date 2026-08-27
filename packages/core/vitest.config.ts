import { defineConfig } from 'vitest/config';

// `include` намеренно один и покрывает весь `src`: тест, положенный мимо этого шаблона,
// исчезает молча — ровно тот дефект, ради которого существует R34. Соответствие
// «всё, что лежит на диске, попадает под include» проверяет `harness.test.ts`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
