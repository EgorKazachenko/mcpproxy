import { describe, expect, it } from 'vitest';
import { asRecipeName, toTool } from '@mcpproxy/contracts';
import type { Recipe } from '@mcpproxy/contracts';
import { requestFor } from './approve.js';
import type { LockApprovalRequest } from './approve.js';
import { LOCK_PATH, MANIFEST_PATH, MANIFEST_YAML, lockTextFor, memoryDisk, started } from './policy.fixture.js';
import { renderRequest, renderVisible } from './render-diff.js';

// Символы собираются из кодпойнтов, а не лежат в исходнике сырыми: сырой управляющий символ
// невидим и для читателя теста — тот же довод, что и в `packages/contracts/src/tool.ts:47`.
const BIDI = String.fromCodePoint(0x202e);
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const ESC = String.fromCodePoint(0x001b);

const INVISIBLE = /[\p{Cc}\p{Cf}]/u;
const REQUESTED_AT = '2026-08-28T00:00:00.000Z';

/** Манифест с невидимыми символами в трёх разных слотах — не только в `description`. */
const POISONED_YAML = MANIFEST_YAML.replace(
  '    description: "Прогнать тесты проекта"\n    exec: ["pnpm", "test"]\n    cwd: "."',
  `    description: "Прогнать тесты${BIDI} проекта"\n    exec: ["pnpm", "test${BIDI}"]\n    cwd: ".${ZERO_WIDTH}"`,
);

async function driftRequest(nextYaml: string): Promise<LockApprovalRequest> {
  const disk = memoryDisk();
  const store = await started(disk);
  disk.write(LOCK_PATH, lockTextFor(store.current().manifest.manifest));
  await store.reloadLock();

  disk.write(MANIFEST_PATH, nextYaml);
  const reloaded = await store.reloadManifest();
  if (reloaded.outcome !== 'reloaded') throw new Error(`манифест не перечитан: ${reloaded.outcome}`);

  const request = requestFor(store.current(), REQUESTED_AT);
  if (request === null) throw new Error('ожидался запрос апрува');
  return request;
}

describe('renderVisible', () => {
  it('bidi-override переживает рендер в видимой форме', () => {
    expect(renderVisible(`а${BIDI}б`)).toBe('а<U+202E>б');
  });

  it('zero-width и ESC — тоже', () => {
    expect(renderVisible(`а${ZERO_WIDTH}б`)).toBe('а<U+200B>б');
    expect(renderVisible(`а${ESC}[31m`)).toBe('а<U+001B>[31m');
  });

  it('разделители, которые санитайзер заменяет пробелом раньше прохода по невидимым', () => {
    // Привязка свойства к `sanitizeDescription` пропустила бы ровно эту пятёрку.
    expect(renderVisible('a\r\n\t\v\fb')).toBe('a<U+000D><U+000A><U+0009><U+000B><U+000C>b');
  });

  it('обычный текст не трогает', () => {
    expect(renderVisible('pnpm test --watch')).toBe('pnpm test --watch');
  });
});

describe('renderRequest: свойство по всему диффу', () => {
  it('ни одна строка рендера не несёт сырого Cc/Cf', async () => {
    const rendered = renderRequest(await driftRequest(POISONED_YAML));

    expect(rendered.split('\n').filter((line) => INVISIBLE.test(line))).toEqual([]);
  });

  it('невидимое из exec[] доезжает до человека видимым, а не только из description', async () => {
    // Инъекционная поверхность — весь `NormalizedRecipe` в `was`/`is`, а не одно поле.
    const rendered = renderRequest(await driftRequest(POISONED_YAML));

    expect(rendered).toContain('test<U+202E>');
    expect(rendered).toContain('<U+200B>');
  });

  it('дифф показывается целиком: обе стороны изменённого рецепта', async () => {
    const rendered = renderRequest(await driftRequest(POISONED_YAML));

    expect(rendered).toContain('Изменён рецепт run_tests.');
    expect(rendered).toContain('было:');
    expect(rendered).toContain('стало:');
    expect(rendered).toContain('Прогнать тесты проекта');
  });
});

describe('renderRequest: две ветки «дрифт есть, показать нечего»', () => {
  const emptyDrift = (patch: Partial<Extract<LockApprovalRequest, { kind: 'drift' }>>): LockApprovalRequest => ({
    kind: 'drift',
    diff: { defaults: null, added: [], removed: [], changed: [] },
    mismatched: [],
    digest: null,
    manifestHash: 'c'.repeat(64),
    requestedAt: REQUESTED_AT,
    ...patch,
  });

  it('подделанный lock назван поимённо и объяснён', () => {
    const rendered = renderRequest(emptyDrift({ mismatched: ['run_tests'] }));

    expect(rendered).toContain('run_tests');
    expect(rendered).toContain('подделан');
    // Почему дифф пуст — иначе человек читает «что-то изменилось, показать нечего» на самом
    // враждебном из путей.
    expect(rendered).toContain('Снимок в lock совпадает с манифестом');
  });

  it('пересчитанный целиком lock объясняется ОБЕИМИ сторонами дайджеста', () => {
    const rendered = renderRequest(emptyDrift({ digest: { was: 'a'.repeat(64), is: 'b'.repeat(64) } }));

    expect(rendered).toContain('a'.repeat(64));
    expect(rendered).toContain('b'.repeat(64));
  });

  it('две ветки дают РАЗНЫЙ текст', () => {
    const tampered = renderRequest(emptyDrift({ mismatched: ['run_tests'] }));
    const recomputed = renderRequest(emptyDrift({ digest: { was: 'a'.repeat(64), is: 'b'.repeat(64) } }));

    expect(tampered).not.toBe(recomputed);
  });
});

describe('renderRequest: остальные две ветви', () => {
  it('первый lock показывает СОДЕРЖИМОЕ рецептов, а не только имена', async () => {
    // Имя стоит в манифесте и до атаки, поэтому список имён не показывает ничего: человек
    // одобрил бы отравленный `exec`, ни разу его не увидев. Ровно эту последовательность —
    // «удалить lock → отравить манифест → дождаться оператора» — ветка и обязана закрывать.
    const store = await started(memoryDisk());
    const request = requestFor(store.current(), REQUESTED_AT);

    const rendered = renderRequest(request as LockApprovalRequest);
    expect(rendered).toContain('одобрение выдаётся впервые');
    expect(rendered).toContain('Рецепт run_tests:');
    expect(rendered).toContain('"pnpm"');
    expect(rendered).toContain('"exec"');
  });

  it('отравленный exec виден человеку и на ветке «файла нет»', async () => {
    const store = await started(memoryDisk({ [MANIFEST_PATH]: POISONED_YAML }));
    const request = requestFor(store.current(), REQUESTED_AT);

    const rendered = renderRequest(request as LockApprovalRequest);
    expect(rendered).toContain('test<U+202E>');
    expect(rendered.split('\n').filter((line) => INVISIBLE.test(line))).toEqual([]);
  });

  it('непригодный lock показывает диагностики И то, что будет закреплено', async () => {
    const stale = JSON.stringify({ version: 1, manifestHash: 'a'.repeat(64), tools: {} });
    const store = await started(memoryDisk({ [MANIFEST_PATH]: MANIFEST_YAML, [LOCK_PATH]: stale }));
    const request = requestFor(store.current(), REQUESTED_AT);

    const rendered = renderRequest(request as LockApprovalRequest);
    expect(rendered).toContain('не разобран');
    expect(rendered).toContain('версия lock 1');
    expect(rendered).toContain('Рецепт run_tests:');
  });
});

describe('renderRequest: подделка называется всегда, а не только при пустом диффе', () => {
  it('непустой дифф вместе с подделкой несёт предупреждение и имена записей', async () => {
    // Состояние «запись подделана И дифф непуст» достижимо и типично: атакующий правит
    // `snapshot.own.exec`, оставив прежний `recipeHash`. Тогда сторона «было» целиком сочинена
    // им, и без предупреждения человек читает её как доверенную.
    const request: LockApprovalRequest = {
      kind: 'drift',
      diff: {
        defaults: null,
        added: [],
        removed: [],
        changed: [
          {
            name: 'run_tests',
            was: (await pinnedOf()).snapshot,
            is: (await pinnedOf()).snapshot,
          },
        ],
      },
      mismatched: ['run_tests'],
      digest: { was: 'a'.repeat(64), is: 'b'.repeat(64) },
      manifestHash: 'b'.repeat(64),
      requestedAt: REQUESTED_AT,
    };

    const rendered = renderRequest(request);
    expect(rendered).toContain('подделан');
    expect(rendered).toContain('run_tests');
    expect(rendered).toContain('НЕ является доверенной');
    expect(rendered).toContain('Изменён рецепт run_tests.');
  });
});

/** Нормализованный рецепт фикстуры — для конструирования диффов в тестах рендера. */
async function pinnedOf() {
  const store = await started(memoryDisk());
  const request = requestFor(store.current(), REQUESTED_AT);
  if (request === null || request.kind !== 'first' || request.recipes[0] === undefined) {
    throw new Error('ожидался запрос вида first');
  }
  return request.recipes[0];
}

describe('R18: сырое человеку, чистое модели', () => {
  it('toTool вычищает описание, которое рендер диффа показывает сырым', () => {
    // Пара и есть содержание решения «хэшируем сырое, санитизируем на проекции». Разъедется
    // — покраснеет здесь, а не в E4, где строится сама поверхность `tools/list`.
    const recipe: Recipe = { description: `Прогнать тесты${BIDI}`, exec: ['pnpm', 'test'] };
    const projected = toTool(asRecipeName('run_tests'), recipe).description ?? '';

    expect(projected).not.toContain(BIDI);
    expect(projected).not.toContain('<U+202E>');
    expect(renderVisible(recipe.description)).toContain('<U+202E>');
  });
});
