import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asRecipeName, type PatternMatcher, type Recipe } from '@mcpproxy/contracts';
import { argsHash } from '@mcpproxy/contracts/audit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateParams } from './params.js';
import { resolvePaths } from './paths.js';
import { prepareRecipe, type PreparedRecipe } from './prepare.js';

const NAME = asRecipeName('analyze_logs');
const NO_MATCHERS: ReadonlyMap<string, PatternMatcher> = new Map();

let base = '';
let lexRoot = '';
let prepared: PreparedRecipe;

/** Прогон обеих стадий: карту `ValidatedValues` чеканит только `validateParams`. */
function run(params: Readonly<Record<string, unknown>>): ReturnType<typeof resolvePaths> {
  const validated = validateParams(prepared, params);
  if (!validated.ok) throw new Error(`стадия validate отказала: ${validated.denials.map((one) => one.code).join()}`);
  return resolvePaths(prepared, validated.values);
}

const codesOf = (result: ReturnType<typeof resolvePaths>): readonly string[] =>
  result.ok ? [] : result.denials.map((one) => one.code);

const valueOf = (result: ReturnType<typeof resolvePaths>): string | null =>
  result.ok ? String(result.values.get('file')) : null;

beforeAll(() => {
  // `mkdtempSync(join(tmpdir(), …))` намеренно: на macOS временный каталог лежит под
  // симлинком `/var` → `/private/var`, и это ровно та фикстура, на которой видно R14.
  base = mkdtempSync(join(tmpdir(), 'e2-'));
  lexRoot = join(base, 'logs');

  mkdirSync(lexRoot);
  writeFileSync(join(lexRoot, 'a.log'), 'x');
  writeFileSync(join(base, 'secret.txt'), 'SECRET');

  // Сосед по префиксу: `<base>/logs-evil` начинается с `<base>/logs`, и голый `startsWith`
  // объявил бы его лежащим внутри (Ф3).
  mkdirSync(join(base, 'logs-evil'));
  writeFileSync(join(base, 'logs-evil', 'a'), 'x');

  // Каталог снаружи и симлинк на него ИЗНУТРИ root — корпус A3: обход идёт через каталог.
  mkdirSync(join(base, 'outside'));
  writeFileSync(join(base, 'outside', 't.txt'), 'x');
  symlinkSync(join(base, 'outside'), join(lexRoot, 'dir'));

  // Симлинк изнутри root на существующий файл снаружи, и такой же на несуществующий.
  symlinkSync(join(base, 'secret.txt'), join(lexRoot, 'out'));
  symlinkSync(join(base, 'nope.txt'), join(lexRoot, 'ghost'));

  // Каталог-алиас на сам root: законный файл, достигнутый через симлинк.
  symlinkSync(lexRoot, join(base, 'alias'));

  const recipe: Recipe = {
    description: 'опись',
    exec: ['/usr/bin/wc'],
    params: { file: { type: 'path', root: lexRoot, argv: ['{}'] } },
  };
  const result = prepareRecipe(NAME, recipe, NO_MATCHERS, base);
  if (!result.ok) throw new Error(`фикстура не подготовилась: ${result.problems.join('; ')}`);
  prepared = result.prepared;
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolvePaths — предпосылка фикстуры', () => {
  it('корень лежит под симлинком: иначе дефект фикстуры читался бы как успех', () => {
    // Утверждение стоит ПЕРВЫМ намеренно. На платформе, где `tmpdir` не под симлинком, этот
    // `it` честно покажет невыполненную предпосылку вместо того, чтобы молча ослабить остальные.
    expect(lexRoot).not.toBe(realpathSync(lexRoot));
  });
});

describe('resolvePaths — confinement ловит то, чего не видит лексика (R13, R15, И3)', () => {
  it('симлинк на КАТАЛОГ, через который идёт обход, отвергается', () => {
    // Лексическая проверка его пропускает: `logs/dir/t.txt` не содержит ни одного `..`.
    // Ловит только `realpath` (Ф2).
    expect(codesOf(run({ file: 'dir/t.txt' }))).toEqual(['path-escapes-root']);
  });

  it('симлинк на ФАЙЛ наружу отвергается', () => {
    expect(codesOf(run({ file: 'out' }))).toEqual(['path-escapes-root']);
  });

  it('сосед по префиксу не считается лежащим внутри root', () => {
    // `<base>/logs-evil/a`.startsWith(`<base>/logs`) === true; `path.relative` даёт
    // `../logs-evil/a` (Ф3). Мутация предиката на `startsWith` красит именно этот трейс.
    expect(codesOf(run({ file: '../logs-evil/a' }))).toEqual(['path-escapes-root']);
  });

  it('сам корень — не файл под корнем, и причина говорит именно это', () => {
    // Пустая строка резолвится в сам `root` (Ф10), и это ловит ветка `root-itself`.
    const result = run({ file: '' });
    expect(codesOf(result)).toEqual(['path-escapes-root']);
    if (result.ok) return;
    // Общая формулировка давала «резолвнутый путь X лежит вне root: X» — один и тот же путь
    // по обе стороны от «лежит вне», что читается как дефект проверки, а не как «вы передали
    // каталог вместо файла».
    expect(result.denials[0].reason).toContain('at the root itself');
    expect(result.denials[0].reason).not.toContain('lies outside');
  });

  it('родительский каталог корня без хвоста не проходит границу', () => {
    // Клауза `rel === '..'` не покрывалась ни одним вектором: её снятие оставляло 97/97
    // зелёных, а зонд показывал `ok` и argv с каталогом манифеста целиком. Векторы рядом
    // покрывают `''`, соседа по префиксу и `../secret.txt` — и ровно пропускали «на один
    // уровень вверх без хвоста».
    for (const value of ['..', '../']) {
      expect(codesOf(run({ file: value })), value).toEqual(['path-escapes-root']);
    }
  });
});

describe('resolvePaths — корень резолвится сам (R14)', () => {
  it('законное относительное значение проходит', () => {
    // Без `realpath` корня на macOS ЛЮБОЙ путь давал бы `path-escapes-root`, включая законный:
    // нерезолвнутый `root` не совпадает с резолвнутым путём ни для одного файла (Ф4).
    const result = run({ file: 'a.log' });
    expect(result.ok).toBe(true);
    expect(valueOf(result)).toBe(realpathSync(join(lexRoot, 'a.log')));
  });
});

describe('resolvePaths — корень резолвится на КАЖДЫЙ вызов, а не кэшируется', () => {
  it('подмена корня после подготовки видна немедленно', () => {
    // Цена решения («один сисколл на параметр») наблюдаема только так: под кэширующей
    // мутацией подмена остаётся невидимой, и сюита при этом полностью зелёная.
    // Фикстура своя, чтобы не портить общий корень соседним `it`.
    const local = mkdtempSync(join(tmpdir(), 'e2-swap-'));
    try {
      const logs = join(local, 'logs');
      const other = join(local, 'other');
      mkdirSync(logs);
      mkdirSync(other);
      writeFileSync(join(logs, 'a.log'), 'x');
      writeFileSync(join(other, 'b.log'), 'x');

      const recipe: Recipe = {
        description: 'о',
        exec: ['/usr/bin/wc'],
        params: { file: { type: 'path', root: logs, argv: ['{}'] } },
      };
      const built = prepareRecipe(NAME, recipe, NO_MATCHERS, local);
      expect(built.ok).toBe(true);
      if (!built.ok) return;

      const call = (value: string): readonly string[] => {
        const validated = validateParams(built.prepared, { file: value });
        if (!validated.ok) throw new Error('validate');
        const resolved = resolvePaths(built.prepared, validated.values);
        return resolved.ok ? [] : resolved.denials.map((one) => one.code);
      };

      expect(call('a.log')).toEqual([]);
      expect(call('b.log')).toEqual(['path-not-found']);

      // Корень подменён на симлинк ПОСЛЕ подготовки — ровно то, что кэш сделал бы невидимым.
      rmSync(logs, { recursive: true });
      symlinkSync(other, logs);

      expect(call('a.log')).toEqual(['path-not-found']);
      expect(call('b.log')).toEqual([]);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });

  it('нерезолвимый корень называет errno и сам корень', () => {
    // Голый `catch {}` стирал различие между `ENOENT`, `ELOOP`, `EACCES` и `ENOTDIR` — то
    // есть подмена корня, ради обнаружения которой заплачен сисколл, была в следе неотличима
    // от опечатки в конфиге.
    const local = mkdtempSync(join(tmpdir(), 'e2-noroot-'));
    try {
      const logs = join(local, 'logs');
      mkdirSync(logs);
      const recipe: Recipe = { description: 'о', exec: ['/usr/bin/wc'], params: { file: { type: 'path', root: logs } } };
      const built = prepareRecipe(NAME, recipe, NO_MATCHERS, local);
      expect(built.ok).toBe(true);
      if (!built.ok) return;

      rmSync(logs, { recursive: true });
      const validated = validateParams(built.prepared, { file: 'a.log' });
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const resolved = resolvePaths(built.prepared, validated.values);

      expect(resolved.ok).toBe(false);
      if (resolved.ok) return;
      expect(resolved.denials[0].code).toBe('path-unusable');
      expect(resolved.denials[0].reason).toContain('ENOENT');
      expect(resolved.denials[0].reason).toContain(logs);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });
});

describe('resolvePaths — предпроверка советующая, а не запрещающая (R15а)', () => {
  it('все ТРИ формы одного законного пути приняты', () => {
    // Каждая ловит свой вариант дефекта предпроверки. Именно отсутствие второй и третьей
    // позволило прошлому раунду «починить» дефект перестановкой корня: относительное
    // значение round-trip'ится при любом варианте.
    const forms: ReadonlyArray<readonly [string, string]> = [
      ['относительная', 'a.log'],
      ['лексическая, форма из манифеста', join(lexRoot, 'a.log')],
      ['через симлинк-каталог внутрь root', join(base, 'alias', 'a.log')],
    ];
    for (const [label, value] of forms) {
      expect(run({ file: value }).ok, label).toBe(true);
    }
  });

  it('оракул существования схлопнут для ЛЕКСИЧЕСКОЙ спелляции обхода', () => {
    // Утверждается РАВЕНСТВО кодов у существующей и несуществующей цели — именно это и есть
    // схлопывание. Без предпроверки они различались бы (`path-escapes-root` против
    // `path-not-found`), то есть каждый вызов отдавал бы бит о произвольном пути на диске.
    const existing = codesOf(run({ file: '../secret.txt' }));
    const missing = codesOf(run({ file: '../nope.txt' }));
    expect(existing).toEqual(missing);
    expect(existing).toEqual(['path-escapes-root']);
  });

  it('остаток честный: через симлинк ВНУТРИ root коды снова различаются', () => {
    // Записано в ограничениях спеки, а не выдаётся за закрытую дыру. Симлинк лексически
    // лежит внутри, предпроверка проходит, и различие возвращается (Ф18). Цена для
    // атакующего — примитив записи внутрь root и след в аудите на каждый симлинк.
    expect(codesOf(run({ file: 'out' }))).toEqual(['path-escapes-root']);
    expect(codesOf(run({ file: 'ghost' }))).toEqual(['path-not-found']);
  });
});

describe('resolvePaths — отсутствующий путь и текст отказа (R16, R26)', () => {
  it('файла нет внутри root — path-not-found', () => {
    expect(codesOf(run({ file: 'missing.log' }))).toEqual(['path-not-found']);
  });

  it('при выходе за границу причина называет резолвнутый путь — это и показывает S4', () => {
    const result = run({ file: 'out' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denials[0].reason).toContain(realpathSync(join(base, 'secret.txt')));
  });

  it('при нерезолвимости причина называет ГРАНИЦУ, а не путь — его не существует', () => {
    const result = run({ file: 'missing.log' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denials[0].reason).toContain(realpathSync(lexRoot));
    expect(result.denials[0].reason).not.toContain('missing.log');
  });
});

describe('resolvePaths — нормализации нет нигде (R17)', () => {
  it('строка байт в байт та, что вернул realpath: NFD не схлопывается в NFC', () => {
    // Записано escape'ами: NFC- и NFD-литералы визуально неотличимы, и разница обязана
    // читаться в исходнике, а не зависеть от нормализации редактора или git.
    const nfd = 'cafe\u0301.log';
    writeFileSync(join(lexRoot, nfd), 'x');

    const value = valueOf(run({ file: nfd }));
    expect(value).not.toBeNull();
    expect(value).toBe(realpathSync(join(lexRoot, nfd)));
    // Нормализация где-нибудь в цепочке превратила бы `e` + U+0301 в `é` и это утверждение
    // покраснело бы.
    expect(value).toContain('e\u0301');
  });

  it('argsHash совпадает для относительного и абсолютного написания — это даёт realpath', () => {
    const relativeForm = run({ file: 'a.log' });
    const absoluteForm = run({ file: join(lexRoot, 'a.log') });
    expect(relativeForm.ok && absoluteForm.ok).toBe(true);
    if (!relativeForm.ok || !absoluteForm.ok) return;

    const hashOf = (result: typeof relativeForm): string => argsHash(NAME, Object.fromEntries(result.values));
    expect(hashOf(relativeForm)).toBe(hashOf(absoluteForm));
    expect(() => hashOf(relativeForm)).not.toThrow();
  });

  it('argsHash РАЗЛИЧАЕТСЯ для NFC- и NFD-пути, потому что это разные пути', () => {
    // Это и есть цена, ради которой D5 развёрнуто: NFC склеивал бы два разных файла в один
    // апрув-идентификатор, и `scope: recipe_and_args`, выданный на один, авторизовал бы другой.
    const nfd = 'cafe\u0301.log';
    const nfc = 'caf\u00E9.log';
    writeFileSync(join(lexRoot, nfd), 'x');

    const asNfd = run({ file: nfd });
    const asNfc = run({ file: nfc });
    expect(asNfd.ok && asNfc.ok).toBe(true);
    if (!asNfd.ok || !asNfc.ok) return;

    expect(argsHash(NAME, Object.fromEntries(asNfd.values))).not.toBe(argsHash(NAME, Object.fromEntries(asNfc.values)));
  });
});

describe('resolvePaths — необязательный параметр и не-path значения', () => {
  it('не переданный необязательный параметр пропускается без резолва', () => {
    const validated = validateParams(prepared, {});
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const result = resolvePaths(prepared, validated.values);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.has('file')).toBe(false);
  });
});
