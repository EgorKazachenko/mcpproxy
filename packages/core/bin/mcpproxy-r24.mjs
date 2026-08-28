#!/usr/bin/env node
// Исполняемая проверка R24 на РАБОЧЕМ дереве. Живёт здесь, а не в юнит-тестах: `git status`
// по настоящему репозиторию делает прогон `vitest` функцией от незакоммиченных правок
// разработчика и от наличия `origin/main` — один посторонний неотслеживаемый файл красит
// весь пакет, а мелкий клон CI роняет его вовсе. Утверждение о ветке проверяется гейтом,
// а не юнит-тестом; чистая половина (`pathViolations`) при этом остаётся под тестами.
import { changedPaths, pathViolations } from '../dist/policy/scan.js';

const ALLOW_LIST = [
  'packages/core/src/policy/**',
  'packages/core/bin/**',
  'packages/core/package.json',
  'packages/core/vitest.config.ts',
  'packages/core/src/index.ts',
  'package.json',
  'yarn.lock',
  'docs/vibe-coding/27.08.2026-e1-policy/**',
  'docs/vibe-coding/27.08.2026-e0-contracts/.gates/run.json',
  // Второе исключение (владелец, 2026-08-28): E6 смержилась раньше E1 и завела в `core`
  // собственные правила, два из которых E1 нарушает по существу. Обоснование — spec.md, R24.
  'packages/core/src/deps.test.ts',
  'packages/core/src/coverage.test.ts',
  'packages/core/api-surface.snapshot.txt',
];

const repoRoot = process.argv[2] ?? process.cwd();
const base = process.argv[3] ?? 'origin/main';

const changed = changedPaths(repoRoot, base);
if (changed.length === 0) {
  process.stderr.write('R24: ветка не изменила ни одного пути — проверять нечего, это ошибка.\n');
  process.exit(2);
}

const violations = pathViolations(changed, ALLOW_LIST);
if (violations.length > 0) {
  process.stderr.write(`R24: ${violations.length} путь(ей) вне списка:\n`);
  for (const one of violations) process.stderr.write(`  ${one}\n`);
  process.exit(1);
}

process.stdout.write(`R24: ${changed.length} изменённых путей, все в списке.\n`);
