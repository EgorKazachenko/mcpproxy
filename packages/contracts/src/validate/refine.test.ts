import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ManifestSource } from '../types.js';
import { branchChecks } from './branch-checks.js';
import { parseManifest } from './index.js';

// Путь намеренно глубокий: из `/proj` выражение `../..` резолвится в корень файловой системы,
// и правило «не выходить за каталог манифеста» оказалось бы неотличимо от правила «не `/`».
const SOURCE: ManifestSource = { path: '/home/u/proj/mcpproxy.yaml' };

const HEAD = `version: 1
defaults:
  timeout: 120s
  output: { maxBytes: 65536, redact: true }
  env: { allow: ["PATH"] }
  sandbox:
    read: { deny: ["~/.ssh"], allow: ["."] }
tools:
`;

const load = (recipeBody: string) => parseManifest(`${HEAD}${recipeBody}`, SOURCE);

const messagesOf = (result: ReturnType<typeof load>): string[] =>
  result.ok ? [] : result.diagnostics.map((one) => one.message);

describe('правило 1 — confinement для root', () => {
  it('принимает относительный root вниз от манифеста', () => {
    expect(load(`  x:
    description: "x"
    exec: ["./s.sh"]
    params: { file: { type: path, root: "./logs" } }
`).ok).toBe(true);
  });

  it('отвергает root: "/"', () => {
    const result = load(`  x:
    description: "x"
    exec: ["./s.sh"]
    params: { file: { type: path, root: "/" } }
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('не ограничивает ничего');
  });

  it('отвергает выход вверх по дереву', () => {
    const result = load(`  x:
    description: "x"
    exec: ["./s.sh"]
    params: { file: { type: path, root: "../.." } }
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('за каталог манифеста');
  });
});

describe('правило 2 — форма exec[0]', () => {
  it('принимает голое имя, абсолютный путь и путь вниз от манифеста', () => {
    for (const binary of ['pnpm', '/usr/bin/make', './scripts/publish.sh']) {
      expect(load(`  x:
    description: "x"
    exec: ["${binary}"]
`).ok).toBe(true);
    }
  });

  it('отвергает метасимвол оболочки', () => {
    const result = load(`  x:
    description: "x"
    exec: ["sh -c 'id' ; rm -rf /"]
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('метасимвол оболочки');
  });

  it('отвергает выход вверх по дереву в exec[0]', () => {
    const result = load(`  x:
    description: "x"
    exec: ["../../bin/sh"]
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('абсолютным путём');
  });
});

describe('правило 3 — слот {} в элементе argv', () => {
  it('принимает один слот', () => {
    expect(load(`  x:
    description: "x"
    exec: ["./s.sh"]
    params: { tag: { type: string, pattern: "^v.+$", argv: ["--tag", "{}"] } }
`).ok).toBe(true);
  });

  it('отвергает два слота в одном элементе', () => {
    const result = load(`  x:
    description: "x"
    exec: ["./s.sh"]
    params: { tag: { type: string, pattern: "^v.+$", argv: ["--from={}--to={}"] } }
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('не более одного раза');
  });
});

describe('правило 4 — параметр не подставляется в exec, cwd и профиль', () => {
  it('отвергает слот в exec[0]', () => {
    // И1/И2, атаки A1/A4 на границе загрузки: иначе недоверенное значение выбирает бинарь.
    const result = load(`  x:
    description: "x"
    exec: ["./run-{}.sh"]
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('подставляться в exec');
  });

  it('отвергает слот в cwd', () => {
    const result = load(`  x:
    description: "x"
    exec: ["./s.sh"]
    cwd: "./{}"
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('подставляться в cwd');
  });

  it('отвергает слот в профиле песочницы', () => {
    const result = load(`  x:
    description: "x"
    exec: ["./s.sh"]
    sandbox: { write: { allow: ["./out/{}"] } }
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('профиль песочницы');
  });
});

describe('правило 5 — pattern компилируется движком RE2', () => {
  it('отвергает паттерн, которого RE2 не принимает', () => {
    const result = load(`  x:
    description: "x"
    exec: ["./s.sh"]
    params: { p: { type: string, pattern: "^(?=.*a)b$" } }
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('RE2');
  });
});

describe('правило 6 — рецептный deny не может быть пустым', () => {
  it('отвергает read.deny: []', () => {
    // Единственная синтаксическая форма, которой рецепт выражает намерение снять запрет.
    // При объединяющем слиянии она — тихий no-op; при слиянии заменой стёрла бы ~/.ssh,
    // ~/.aws и ~/.config/gh (атака A10). Правило делает намерение ошибкой загрузки.
    const result = load(`  x:
    description: "x"
    exec: ["./s.sh"]
    sandbox: { read: { deny: [] } }
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join()).toContain('снять запрет');
  });

  it('принимает дополнительный непустой deny', () => {
    expect(load(`  x:
    description: "x"
    exec: ["./s.sh"]
    sandbox: { read: { deny: ["/etc/shadow"] } }
`).ok).toBe(true);
  });

  it('пустой allow остаётся законным — это «обнулить», а не «снять запрет»', () => {
    expect(load(`  x:
    description: "x"
    exec: ["./s.sh"]
    sandbox: { network: { allow: [] } }
`).ok).toBe(true);
  });
});

describe('манифест, прошедший загрузку, обязан быть хэшируемым', () => {
  // `diffLock(lock, manifest)` берёт два аргумента. Парсер lock страхует первый; без проверки
  // ниже второй не страховал никто, и манифест, принятый схемой и `refine`, ронял
  // `manifestHash` необработанным `TypeError` — крэшем на стадии `lock_check`, до записи
  // стадийного события. Отказ без следа в аудите контракт называет багом.
  it('отвергает одиночный суррогат в description', () => {
    const result = load(`  x:
    description: "a\ud800b"
    exec: ["true"]
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join('\n')).toContain('не хэшируется');
  });

  it('отвергает одиночный суррогат в строке песочницы уровня defaults', () => {
    const text = `version: 1
defaults:
  timeout: 120s
  output: { maxBytes: 65536, redact: true }
  env: { allow: ["PATH"] }
  sandbox:
    read: { deny: ["~/.ssh\ud800"], allow: ["."] }
tools:
  x:
    description: "x"
    exec: ["true"]
`;
    expect(parseManifest(text, SOURCE).ok).toBe(false);
  });

  it('и длительность, дающую Infinity, — её же ограничивает и схема', () => {
    // `Number('9'×400) * 1000` — это `Infinity`, а не бросок: `normalizeManifest` отрабатывает
    // успешно и возвращает `timeoutMs: Infinity`, отказывает только канонизатор.
    const text = `version: 1
defaults:
  timeout: ${'9'.repeat(400)}s
  output: { maxBytes: 65536, redact: true }
  env: { allow: ["PATH"] }
  sandbox:
    read: { deny: ["~/.ssh"], allow: ["."] }
tools:
  x:
    description: "x"
    exec: ["true"]
`;
    expect(parseManifest(text, SOURCE).ok).toBe(false);
  });

  it('нормальный манифест при этом грузится', () => {
    expect(load(`  x:
    description: "x"
    exec: ["true"]
`).ok).toBe(true);
  });
});

describe('код диагностики — каждый член юниона производится своей ситуацией', () => {
  // `DiagnosticCode` замораживается этим контрактом, и потребитель обязан ветвиться по нему.
  // Без исполняемого покрытия перестановка двух кодов местами не роняла ничего: юнион
  // существовал только в типах.
  const codeOf = (result: ReturnType<typeof load>): (string | undefined)[] =>
    result.ok ? [] : result.diagnostics.map((one) => one.code);

  it('size-limit — файл больше потолка', () => {
    const huge = `${HEAD}  x:\n    description: "${'a'.repeat(300_000)}"\n    exec: ["true"]\n`;
    expect(codeOf(parseManifest(huge, SOURCE))).toEqual(['size-limit']);
  });

  it('yaml — синтаксис', () => {
    expect(codeOf(parseManifest(`${HEAD}  x: [unclosed\n`, SOURCE))).toContain('yaml');
  });

  it('schema — документ разобран, но форма не та', () => {
    expect(codeOf(load(`  x:
    description: "x"
`))).toEqual(['schema']);
  });

  it('invariant — проверка, которой в схеме нет', () => {
    expect(codeOf(load(`  x:
    description: "x"
    exec: ["true"]
    cwd: "{}"
`))).toEqual(['invariant']);
  });

  it('pattern — RE2 не принял выражение', () => {
    expect(codeOf(load(`  x:
    description: "x"
    exec: ["true"]
    params:
      p: { type: string, pattern: "(?=x)" }
`))).toEqual(['pattern']);
  });
});

describe('текст диагностики безопасен для отрисовки', () => {
  const ESC = String.fromCharCode(27);
  const BIDI = String.fromCharCode(0x202e);
  const unsafe = (result: ReturnType<typeof load>): string =>
    result.ok ? '' : result.diagnostics.map((one) => one.message).join('\n');

  it('сообщение RE2 не проносит ANSI и bidi из паттерна', () => {
    // Сообщение RE2 эхоит фрагмент паттерна дословно — замерено на вендоренном re2@1.26.1.
    const result = load(`  x:
    description: "x"
    exec: ["true"]
    params:
      p: { type: string, pattern: "[a-${ESC}[31m${BIDI}" }
`);
    expect(result.ok).toBe(false);
    expect(unsafe(result)).not.toContain(ESC);
    expect(unsafe(result)).not.toContain(BIDI);
  });

  it('сообщение yaml не проносит их из исходной строки — а оно вклеивает её дословно', () => {
    // Точка ДЕШЕВЛЕ предыдущей: до RE2 надо дойти через валидную схему, а до doc.errors
    // хватает одной синтаксической ошибки.
    const result = parseManifest(`version: 1\ndefaults: !${ESC}[31m${BIDI}IGNORE foo\n`, SOURCE);
    expect(result.ok).toBe(false);
    expect(unsafe(result)).not.toContain(ESC);
    expect(unsafe(result)).not.toContain(BIDI);
  });

  it('и имя переменной окружения из манифеста — тоже', () => {
    const result = load(`  x:
    description: "x"
    exec: ["true"]
    env: { allow: ["PATH", "A${ESC}[31mB"] }
`);
    expect(result.ok).toBe(false);
    expect(unsafe(result)).not.toContain(ESC);
  });
});

describe('правило 8 — рецептный output не ослабляет defaults', () => {
  it('отвергает снятие редакции вывода', () => {
    // Слияние скаляров заменой позволило бы рецепту выключить редакцию, включённую в
    // defaults, — то есть секрет доехал бы до модели и до лога, тогда как sandbox.*.deny
    // сделан принципиально неснимаемым.
    const result = load(`  x:
    description: "x"
    exec: ["true"]
    output: { redact: false }
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join('\n')).toContain('редакцию');
  });

  it('отвергает поднятие потолка вывода', () => {
    const result = load(`  x:
    description: "x"
    exec: ["true"]
    output: { maxBytes: 999999 }
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join('\n')).toContain('потолок');
  });

  it('сужение остаётся законным', () => {
    expect(load(`  x:
    description: "x"
    exec: ["true"]
    output: { maxBytes: 1024, redact: true }
`).ok).toBe(true);
  });
});

describe('правило 7 — рецептный env.allow не выше потолка defaults', () => {
  it('принимает подмножество', () => {
    expect(load(`  x:
    description: "x"
    exec: ["true"]
    env: { allow: ["PATH"] }
`).ok).toBe(true);
  });

  it('отвергает переменную, которой нет в defaults.env.allow', () => {
    // Рецептный `env` сливается ЗАМЕНОЙ по листу, поэтому без этого правила рецепт выдал бы
    // себе `AWS_SECRET_ACCESS_KEY` — тогда как `sandbox.*.deny` из defaults принципиально
    // неснимаем. Асимметрия была бы тем опаснее, что схема разрешила рецепту нести `env`
    // только в этом диффе.
    const result = load(`  x:
    description: "x"
    exec: ["true"]
    env: { allow: ["PATH", "AWS_SECRET_ACCESS_KEY"] }
`);
    expect(result.ok).toBe(false);
    expect(messagesOf(result).join('\n')).toContain('AWS_SECRET_ACCESS_KEY');
  });
});

describe('уровень defaults — та же ветка, то же правило', () => {
  it('отвергает слот {} в профиле песочницы уровня defaults', () => {
    // Ветка `SandboxProfile` инстанцируется и в `Defaults`, и в `Recipe`, а проверка
    // обходила только рецепты — то есть таблица R6 объявляла покрытой ветку, чью проверку
    // применяли не ко всем её вхождениям.
    const text = `version: 1
defaults:
  timeout: 120s
  output: { maxBytes: 65536, redact: true }
  env: { allow: ["PATH"] }
  sandbox:
    read: { deny: ["~/.ssh"], allow: ["."] }
    write: { allow: ["{}/out"] }
tools:
  x:
    description: "x"
    exec: ["true"]
`;
    const result = parseManifest(text, SOURCE);
    expect(result.ok).toBe(false);
    expect(messagesOf(result)).toContain('параметр не может подставляться в профиль песочницы');
  });

  it('пустой defaults.deny при этом остаётся законным — там он значит «запретов нет»', () => {
    const text = `version: 1
defaults:
  timeout: 120s
  output: { maxBytes: 65536, redact: true }
  env: { allow: ["PATH"] }
  sandbox:
    read: { deny: [], allow: ["."] }
tools:
  x:
    description: "x"
    exec: ["true"]
`;
    expect(parseManifest(text, SOURCE).ok).toBe(true);
  });
});

describe('каталог, чьё имя начинается с двух точек', () => {
  it('является подкаталогом, а не выходом за пределы', () => {
    // `relative()` вернёт `..cache`, и проверка `startsWith('..')` объявляла бы легитимный
    // подкаталог выходом наверх. Отказ ложный, но отказ загрузки на честном манифесте люди
    // чинят обходом правила.
    expect(load(`  x:
    description: "x"
    exec: ["true"]
    params:
      p: { type: path, root: "./..cache" }
`).ok).toBe(true);
  });
});

describe('таблица «ветка ↔ проверка» (R6)', () => {
  const schemaPath = fileURLToPath(new URL('../../schema/mcpproxy.schema.json', import.meta.url));
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { $defs: Record<string, unknown> };

  it('покрывает каждую ветку схемы и не выдумывает лишних', () => {
    // Сравнение множеств, а не массивов: `toEqual` на массивах краснело бы на безобидной
    // перестановке, и первый же пострадавший «починил» бы гейт через .sort(), заодно
    // молча превратив его в не-проверку.
    expect(new Set(Object.keys(branchChecks))).toEqual(new Set(Object.keys(schema.$defs)));
  });

  it('называет разницу в обе стороны, когда она есть', () => {
    const declared = new Set(Object.keys(branchChecks));
    const actual = new Set(Object.keys(schema.$defs));
    expect([...actual].filter((one) => !declared.has(one))).toEqual([]);
    expect([...declared].filter((one) => !actual.has(one))).toEqual([]);
  });
});
