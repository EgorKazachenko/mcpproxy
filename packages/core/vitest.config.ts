import { defineConfig } from 'vitest/config';

// Один `include`, покрывающий весь `src`, — зеркально `packages/contracts/vitest.config.ts`.
// Тест, положенный мимо этого шаблона, исчезает молча; соответствие «всё, что лежит на диске,
// попадает под include» проверяет `runner.test.ts` (R21).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
