import { defineConfig } from 'vitest/config';

// `include` намеренно один и покрывает весь `src`: тест, положенный мимо этого шаблона,
// исчезает молча — ровно тот дефект, ради которого R21 и существует. Соответствие
// «всё, что лежит на диске, попадает под include» проверяет `domain.test.ts`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
