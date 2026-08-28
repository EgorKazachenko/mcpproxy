import { defineConfig } from 'vitest/config';

/**
 * Юниты. Каталог `src/e2e` исключён намеренно: смоук поднимает настоящий Electron, и попади
 * он сюда — каждая проверка каждой задачи запускала бы приложение. Отдельного флага «гонять
 * только этот проект» у vitest нет, поэтому разделение идёт конфигами, а не проектами.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/e2e/**'],
  },
});
