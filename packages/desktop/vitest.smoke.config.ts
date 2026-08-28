import { defineConfig } from 'vitest/config';

/** Смоук на собранном приложении. Запускается только через `yarn test:smoke`. */
export default defineConfig({
  test: {
    include: ['src/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
