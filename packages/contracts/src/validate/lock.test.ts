import { describe, expect, it } from 'vitest';
import { recipeHash } from '../audit/lock.js';
import { normalizeDefaults, normalizeRecipe, type LockFile } from '../lock.js';
import type { Defaults, Recipe } from '../manifest.generated.js';
import { parseLockFile } from './lock.js';

const DEFAULTS: Defaults = {
  timeout: '120s',
  output: { maxBytes: 65536, redact: true },
  env: { allow: ['PATH'] },
  sandbox: { read: { deny: ['~/.ssh'], allow: ['.'] } },
};

const PUBLISH: Recipe = {
  description: 'Опубликовать релиз',
  exec: ['./scripts/publish.sh'],
  annotations: { readOnlyHint: false, destructiveHint: true },
};

const normalized = normalizeRecipe(PUBLISH, DEFAULTS);

const CURRENT: LockFile = {
  version: 2,
  manifestHash: 'a'.repeat(64),
  defaults: normalizeDefaults(DEFAULTS),
  tools: {
    publish_release: { recipeHash: recipeHash(normalized), approvedAt: '2026-08-27T10:00:00Z', snapshot: normalized },
  },
};

/**
 * Форма ревизии 1 — та, что была задокументирована ДО этого диффа: поле называлось `hash`,
 * снапшота и слота `defaults` не существовало. Именно её обязан отбить парсер, а не уронить
 * `diffLock` необработанным исключением на стадии `lock_check`.
 */
const LEGACY_V1 = JSON.stringify({
  version: 1,
  manifestHash: 'a'.repeat(64),
  tools: { publish_release: { hash: 'b'.repeat(64), approvedAt: '2026-08-27T10:00:00Z' } },
});

describe('parseLockFile', () => {
  it('разбирает файл текущей ревизии', () => {
    const result = parseLockFile(JSON.stringify(CURRENT));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostics.map((one) => one.message).join('\n'));
    expect(Object.keys(result.lock.tools)).toEqual(['publish_release']);
    expect(result.lock.version).toBe(2);
  });

  it('отбивает lock прежней формы диагностикой, а не исключением на пути решения', () => {
    const result = parseLockFile(LEGACY_V1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('файл ревизии 1 не должен разбираться');
    const pointers = result.diagnostics.map((one) => one.pointer);
    // Версия названа отдельно: у человека старый lock, а не сломанный файл, и сообщение
    // обязано это различать.
    expect(pointers).toContain('version');
    expect(pointers).toContain('defaults');
    expect(pointers).toContain('tools.publish_release.recipeHash');
    expect(pointers).toContain('tools.publish_release.snapshot');
  });

  it('не разобранный JSON — диагностика, а не бросок', () => {
    const result = parseLockFile('{ это не json');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('мусор не должен разбираться');
    expect(result.diagnostics).toHaveLength(1);
    // Код `lock`, а не `schema`: сломанный lock ведёт на повторный апрув, сломанный
    // манифест — на отказ старта, и потребитель обязан их различать.
    expect(result.diagnostics[0]?.code).toBe('lock');
  });

  it('всё, что прошло парсер, переживает diffLock и verifyLockEntries', () => {
    // Смысл модуля — снять исключение с пути `lock_check`. Структурной проверки для этого
    // мало: единственная бросающая операция внутри `diffLock` — `canonicalizeJcs`, и у неё
    // пять оснований для `TypeError`, ни одно из которых не исключается проверкой «поле на
    // месте и это объект». Ниже четыре крафтовых входа, каждый из которых ПРОХОДИЛ первую
    // версию парсера и ронял `diffLock`.
    const deep = (n: number): unknown => JSON.parse('{"a":'.repeat(n) + '1' + '}'.repeat(n));
    const loneSurrogate = JSON.parse('{"x": "\\ud800"}') as unknown;

    // Утверждается ПРИЧИНА, а не только `ok: false`. Иначе завтрашнее структурное требование
    // к `snapshot.own` начнёт ронять все четыре входа по себе, цикл останется зелёным, и
    // защиту от `TypeError` можно будет снять незаметно.
    const crafted: Array<[string, unknown, string]> = [
      // Входы валидны ПО ФОРМЕ и ядовиты для канонизатора — иначе их отбивала бы проверка
      // формы, и кейс доказывал бы не ту защиту. Глубина прячется там, где форма её не
      // ограничивает: в элементе `params` и в лишнем ключе `defaults`.
      [
        'snapshot.own глубокий',
        { ...CURRENT, tools: { publish_release: { ...CURRENT.tools.publish_release, snapshot: { own: { ...normalized.own, params: [deep(300)] }, effective: CURRENT.defaults } } } },
        'собственный блок не канонизируется: вложенность глубже',
      ],
      ['defaults глубокий', { ...CURRENT, defaults: { ...CURRENT.defaults, extra: deep(300) } }, 'defaults не канонизируется: вложенность глубже'],
      [
        'defaults с одиночным суррогатом',
        { ...CURRENT, defaults: { ...CURRENT.defaults, env: { allow: [JSON.parse('"\\ud800"')] } } },
        'defaults не канонизируется: строка содержит одиночный суррогат',
      ],
      [
        'snapshot.own с одиночным суррогатом',
        { ...CURRENT, tools: { publish_release: { ...CURRENT.tools.publish_release, snapshot: { own: { ...normalized.own, description: JSON.parse('"\\ud800"') }, effective: CURRENT.defaults } } } },
        'собственный блок не канонизируется: строка содержит одиночный суррогат',
      ],
    ];

    for (const [label, lock, reason] of crafted) {
      const result = parseLockFile(JSON.stringify(lock));
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics.map((one) => one.message).join('\n'), label).toContain(reason);
    }
  });

  it('имя записи проверяется той же парой, что и asRecipeName', () => {
    // Иначе `diffLock` кладёт `__proto__` в `removed`, и человеку показывают «удалён рецепт
    // __proto__», которого никогда не существовало.
    for (const name of ['__proto__', 'constructor', 'Publish']) {
      const lock = { ...CURRENT, tools: { [name]: CURRENT.tools.publish_release } };
      const result = parseLockFile(JSON.stringify(lock));
      expect(result.ok, name).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics.map((one) => one.pointer)).toContain(`tools.${name}`);
    }
  });

  it('указатель диагностики тоже санитизирован — им ищут в логе', () => {
    // Сегменты пути манифеста ограничены `propertyNames` ещё до попадания в указатель, а ключ
    // `tools` в lock-файле — нет. Контракт называет `pointer` ключом поиска в структурном логе
    // демона, то есть поле, которым ищут, несло бы ANSI и bidi.
    const ESC = String.fromCharCode(27);
    const lock = { ...CURRENT, tools: { [`a${ESC}[31mb`]: CURRENT.tools.publish_release } };
    const result = parseLockFile(JSON.stringify(lock));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const pointers = result.diagnostics.map((one) => one.pointer);
    // Контроль: указатель под этим ключом вообще произведён — но уже без ESC.
    expect(pointers).toContain('tools.ab');
    expect(pointers.join('')).not.toContain(ESC);
  });

  it('форма defaults и effective проверяется, а не кастуется', () => {
    // Иначе бросок не исчезал, а переезжал: `{}` проходил `isRecord`, кастовался в
    // `NormalizedDefaults` и доезжал до рендерера апрува S7 через `LockDiff.was`.
    const cases: Array<[string, unknown, string]> = [
      ['defaults пустой', { ...CURRENT, defaults: {} }, 'defaults'],
      [
        'defaults без sandbox.network',
        { ...CURRENT, defaults: { ...CURRENT.defaults, sandbox: { read: { allow: [], deny: [] }, write: { allow: [], deny: [] } } } },
        'defaults',
      ],
      [
        'effective пустой',
        { ...CURRENT, tools: { publish_release: { ...CURRENT.tools.publish_release, snapshot: { own: normalized.own, effective: {} } } } },
        'tools.publish_release.snapshot.effective',
      ],
      [
        'own без exec',
        { ...CURRENT, tools: { publish_release: { ...CURRENT.tools.publish_release, snapshot: { own: { description: 'x' }, effective: normalized.effective } } } },
        'tools.publish_release.snapshot.own',
      ],
    ];
    for (const [label, lock, pointer] of cases) {
      const result = parseLockFile(JSON.stringify(lock));
      expect(result.ok, label).toBe(false);
      if (result.ok) continue;
      expect(result.diagnostics.map((one) => one.pointer), label).toContain(pointer);
    }
  });

  it('отвергает дайджест не той формы', () => {
    const broken = { ...CURRENT, manifestHash: 'sha256:' + 'a'.repeat(64) };
    const result = parseLockFile(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('префикс sha256: не входит в кодировку');
    expect(result.diagnostics.map((one) => one.pointer)).toContain('manifestHash');
  });

  it('снапшот без собственного блока не проходит — иначе diffLock строит «было» из undefined', () => {
    const broken = {
      ...CURRENT,
      tools: { publish_release: { ...CURRENT.tools.publish_release, snapshot: { effective: {} } } },
    };
    const result = parseLockFile(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('снапшот без own не форма');
    expect(result.diagnostics.map((one) => one.pointer)).toContain('tools.publish_release.snapshot.own');
  });
});
