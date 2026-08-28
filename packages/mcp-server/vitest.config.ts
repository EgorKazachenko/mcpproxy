import { defineConfig } from 'vitest/config';

// Шаблон один и покрывает весь `src` — по той же причине, что в `contracts` и `core`: тест,
// положенный мимо шаблона, исчезает молча.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // E2E поднимает настоящий демон, настоящий сокет и настоящую песочницу.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Тот же довод, что в `core`: набор поднимает синглтон srt, а он один на процесс.
    fileParallelism: false,
  },
});
