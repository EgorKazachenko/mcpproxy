import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stageOrder, type Stage } from './domain.js';

/**
 * Ожидаемая последовательность записана здесь литералом, а не выведена из `stageOrder`:
 * сверять массив с самим собой бессмысленно. Порядок — часть контракта (`docs/07-contracts.md`),
 * и перестановка двух стадий обязана краснеть так же, как удаление.
 */
const EXPECTED_STAGES = [
  'received',
  'lock_check',
  'validate',
  'resolve_paths',
  'build_argv',
  'classify_risk',
  'approval',
  'build_env',
  'build_profile',
  'spawn',
  'violation',
  'redact',
  'complete',
] as const satisfies readonly Stage[];

// Полноту проверяет компилятор, а не только прогон: стадия, добавленная в `Stage`, но не
// внесённая в список выше, делает `Missing` непустым и роняет сборку до запуска vitest.
type Missing = Exclude<Stage, (typeof EXPECTED_STAGES)[number]>;
const _everyStageListed: [Missing] extends [never] ? true : Missing = true;
void _everyStageListed;

describe('stageOrder', () => {
  it('поэлементно равен задокументированной последовательности', () => {
    expect(stageOrder).toEqual(EXPECTED_STAGES);
  });

  it('содержит каждую стадию ровно один раз', () => {
    const counts = new Map<Stage, number>();
    for (const stage of stageOrder) counts.set(stage, (counts.get(stage) ?? 0) + 1);

    expect([...counts.keys()].sort()).toEqual([...EXPECTED_STAGES].sort());
    expect([...counts.values()]).toEqual(EXPECTED_STAGES.map(() => 1));
  });
});

describe('раннер', () => {
  // R21: `yarn test` до этой задачи выходил с нулём, не запустив ничего. Утверждения ниже
  // ловят возврат в это состояние — пустой набор файлов и файл, положенный мимо `include`.
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const IGNORED = new Set(['node_modules', 'dist', '.git']);

  const testFiles = readdirSync(packageRoot, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.split('/'))
    .filter((parts) => !parts.some((part) => IGNORED.has(part)))
    .filter((parts) => parts.at(-1)?.endsWith('.test.ts') === true);

  it('обнаружил хотя бы один тестовый файл', () => {
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it('не имеет тестов за пределами `src/`, куда не смотрит include', () => {
    const outside = testFiles.filter((parts) => parts[0] !== 'src').map((parts) => parts.join('/'));
    expect(outside).toEqual([]);
  });
});
