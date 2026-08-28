import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { init } from 'es-module-lexer';
import { beforeAll, describe, expect, it } from 'vitest';
import { changedPaths, pathViolations, scanSources, walkGraph, workspaceResolver } from './scan.js';
import type { ScanRule } from './scan.js';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const repoRoot = dirname(dirname(packageRoot));

beforeAll(async () => {
  await init;
});

/** Фикстурное дерево в temp: подсадка нарушения в рабочий код сделала бы скан вечно красным. */
function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'mcpproxy-boundary-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

describe('R23: core не тянет Electron ни прямо, ни транзитивно', () => {
  const entry = join(packageRoot, 'dist', 'index.js');

  it('граф собран — иначе проверка ниже пуста', () => {
    expect(existsSync(entry)).toBe(true);
    expect(walkGraph(entry, workspaceResolver(repoRoot)).files.length).toBeGreaterThan(1);
  });

  it('подпути рабочих пакетов действительно резолвятся — иначе слепое пятно', () => {
    // `core` импортирует `@mcpproxy/contracts/validate` и `.../audit`: именно эти входы тянут
    // `ajv`, `re2` и `node:crypto`. Отображение по базовому имени пакета их бы не прошло.
    const { files } = walkGraph(entry, workspaceResolver(repoRoot));

    expect(files.some((one) => one.endsWith(join('contracts', 'dist', 'validate', 'index.js')))).toBe(true);
    expect(files.some((one) => one.endsWith(join('contracts', 'dist', 'audit', 'index.js')))).toBe(true);
  });

  it('electron недостижим из входа', () => {
    const { bare } = walkGraph(entry, workspaceResolver(repoRoot));

    expect(bare.filter((one) => one === 'electron' || one.startsWith('electron/'))).toEqual([]);
  });

  it('резолвер подпутей проверяем на фикстуре: без него electron не находится', () => {
    const root = fixtureTree({
      'packages/fake/package.json': JSON.stringify({
        name: '@fake/pkg',
        exports: { '.': './main.js', './sub': './sub.js' },
      }),
      'packages/fake/main.js': 'export const safe = 1;\n',
      'packages/fake/sub.js': "import 'electron';\nexport const risky = 1;\n",
      'entry.js': "import '@fake/pkg/sub';\n",
    });

    try {
      const { bare } = walkGraph(join(root, 'entry.js'), workspaceResolver(root));
      expect(bare).toContain('electron');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const POLICY_ROOT = 'packages/core/src/policy/**';

describe('вход ./pure свободен от платформенных импортов', () => {
  it('ни один node:* не достижим из чистого входа', () => {
    // Корневой баррель Node-only намеренно (`confirm-tty` тянет `node:readline/promises`).
    // Чистый вход существует, чтобы E5 и E7 могли импортировать рендер диффа, не втаскивая
    // это в бандл; проверка держит границу, а не обещание в доккомментарии.
    const entry = join(packageRoot, 'dist', 'policy', 'pure.js');
    const { files, bare } = walkGraph(entry, workspaceResolver(repoRoot));

    expect(existsSync(entry)).toBe(true);
    expect(files.length).toBeGreaterThan(1);
    expect(bare.filter((one) => one.startsWith('node:'))).toEqual([]);
  });

  it('а корневой вход их тянет — иначе проверка выше ничего не значит', () => {
    const { bare } = walkGraph(join(packageRoot, 'dist', 'index.js'), workspaceResolver(repoRoot));

    expect(bare.some((one) => one.startsWith('node:'))).toBe(true);
  });
});

describe('R1 и R8: два разных правила, а не одно', () => {
  // Правило R1 шире по корню, чем правило R8, и это намеренно: по R24a на эту ветку
  // ребейзятся E2, E3 и E6, которые будут законно парсить JSON у себя в `core/*`.
  const noParseManifest: ScanRule = {
    pattern: /\bparseManifest\s*\(/,
    roots: ['packages/core/src/**'],
    allow: ['packages/core/src/policy/store.ts'],
  };

  const noJsonParseOfLock: ScanRule = {
    pattern: /\bJSON\.parse\s*\(/,
    roots: [POLICY_ROOT, 'packages/core/bin/**'],
    // `scan.ts` читает `package.json` рабочих пакетов, а не lock: он вообще не знает о нём.
    allow: ['packages/core/src/policy/scan.ts'],
  };

  it('parseManifest не зовётся нигде в core вне store.ts', () => {
    expect(scanSources(repoRoot, noParseManifest)).toEqual([]);
  });

  it('JSON.parse над текстом lock не появляется в policy и bin', () => {
    expect(scanSources(repoRoot, noJsonParseOfLock)).toEqual([]);
  });

  it('правило R1 покрывает весь core/src, а не только policy', () => {
    const root = fixtureTree({
      'packages/core/src/other/y.ts': "import { parseManifest } from 'x';\nparseManifest('', {});\n",
      'packages/core/src/policy/ok.ts': 'export const fine = 1;\n',
    });

    try {
      expect(scanSources(root, { ...noParseManifest, allow: [] })).toEqual(['packages/core/src/other/y.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('скан спускается в подкаталоги', () => {
    const root = fixtureTree({
      'packages/core/src/policy/nested/x.ts': 'const lock = JSON.parse("{}");\nexport { lock };\n',
    });

    try {
      expect(scanSources(root, { ...noJsonParseOfLock, roots: [POLICY_ROOT], allow: [] })).toEqual([
        'packages/core/src/policy/nested/x.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('исчезнувший корень — ошибка, а не молчаливый ноль', () => {
    const root = fixtureTree({ 'packages/core/src/policy/x.ts': 'export const a = 1;\n' });

    try {
      expect(() => scanSources(root, { ...noJsonParseOfLock, roots: ['packages/core/src/gone/**'] })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('упоминание в доккомментарии не считается вызовом', () => {
    const root = fixtureTree({
      'packages/core/src/policy/x.ts': '/** Тут нельзя звать JSON.parse(text). */\nexport const a = 1;\n',
    });

    try {
      expect(scanSources(root, { ...noJsonParseOfLock, roots: [POLICY_ROOT], allow: [] })).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('R13: расхождение с lock не отображается в риск-тир', () => {
  it('имя запрещённой функции не встречается нигде в policy, а не только в lock-check', () => {
    // У `AuditEvent` есть слот `risk`, и `event.ts` — как раз то место, где отображение
    // могло бы всплыть заново.
    //
    // Имя склеивается из двух половин, иначе файл правила нарушал бы собственное правило, и
    // единственным способом сделать проверку зелёной было бы внести её саму в `allow`.
    const rule: ScanRule = { pattern: new RegExp(`derive${'RiskTier'}`), roots: [POLICY_ROOT], allow: [] };

    // Правило сначала КАЛИБРУЕТСЯ на фикстуре. Оба соседних правила в этом файле калиброваны, а
    // это — нет: сломайся склейка имени, оно перестало бы совпадать с чем угодно, и утверждение
    // ниже осталось бы вечно зелёным при полностью снятой охране R13.
    const root = fixtureTree({
      'packages/core/src/policy/x.ts': `export const t = derive${'RiskTier'}(annotations);\n`,
    });
    try {
      expect(scanSources(root, rule)).toEqual(['packages/core/src/policy/x.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(scanSources(repoRoot, rule)).toEqual([]);
  });
});

describe('R24: ни один файл вне списка не меняется', () => {
  const ALLOW_LIST = [
    'packages/core/src/policy/**',
    'packages/core/bin/**',
    'packages/core/package.json',
    'packages/core/vitest.config.ts',
    'packages/core/src/index.ts',
    'package.json',
    'yarn.lock',
    'docs/vibe-coding/27.08.2026-e1-policy/**',
    // Расписка `gate-run close` по прошлому прогону, написанная харнессом на фазе плана.
    // Записана явно, потому что список исполняемый и читает его проверка, а не намерение.
    'docs/vibe-coding/27.08.2026-e0-contracts/.gates/run.json',
  ];

  /** Репозиторий-фикстура: ветка ушла вперёд, и база тоже. */
  function fixtureRepo(): string {
    const root = fixtureTree({ 'a.txt': 'a\n', 'base-only.txt': 'base\n' });
    // Конфиг машины ОТРЕЗАН. Иначе фикстурный репозиторий наследует `commit.gpgsign`,
    // `core.hooksPath`, `commit.template` — и `git commit` либо падает, либо ждёт пароль; а
    // `execFileSync` синхронен, поэтому таймаут теста к нему не применяется и виснет весь
    // воркер, а не краснеет один тест. `timeout` превращает зависание в красное.
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });

    git('init', '--initial-branch=main', '--quiet');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'первый');

    git('checkout', '--quiet', '-b', 'feature');
    writeFileSync(join(root, 'a.txt'), 'изменено веткой\n');
    // Имя не в ASCII и **закоммичено**: половину `git diff` (в отличие от `-z`-статуса) git
    // отдаёт в кавычках и восьмеричных экранах, если не снять `core.quotePath`.
    writeFileSync(join(root, 'ветка-добавила.txt'), 'новый\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'правка ветки');

    // База уходит вперёд ПОСЛЕ ответвления: две точки прочитали бы это как наше нарушение.
    git('checkout', '--quiet', 'main');
    writeFileSync(join(root, 'base-only.txt'), 'изменено базой\n');
    git('commit', '--quiet', '-a', '-m', 'правка базы');
    git('checkout', '--quiet', 'feature');

    return root;
  }

  it('чистая половина ловит путь вне списка', () => {
    // Кейсы гоняются на списках-фикстурах, а не на рабочем дереве: иначе тесту пришлось бы
    // создавать мусор вне списка и удалять его — гонка между воркерами vitest и транзиторное
    // нарушение R24 ровно в тот момент, когда R24 проверяется.
    expect(pathViolations(['packages/contracts/src/lock.ts'], ALLOW_LIST)).toEqual([
      'packages/contracts/src/lock.ts',
    ]);
    expect(pathViolations(['packages/core/src/policy/store.ts', 'yarn.lock'], ALLOW_LIST)).toEqual([]);
    expect(pathViolations(['packages/core/src/other.ts'], ALLOW_LIST)).toEqual(['packages/core/src/other.ts']);
  });

  it('вход собирается ОТ ТОЧКИ ВЕТВЛЕНИЯ: правка базы после ответвления — не наша', () => {
    const root = fixtureRepo();
    try {
      expect(changedPaths(root, 'main')).toEqual(['a.txt', 'ветка-добавила.txt']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('и включает неотслеживаемые файлы — иначе молчит там, где должен говорить', () => {
    // Все поставки эпика — новые файлы, а `git diff` их не видит.
    const root = fixtureRepo();
    try {
      writeFileSync(join(root, 'вне-списка.txt'), 'новый\n');
      expect(changedPaths(root, 'main')).toEqual(['a.txt', 'ветка-добавила.txt', 'вне-списка.txt']);
      expect(pathViolations(changedPaths(root, 'main'), ['a.txt', 'ветка-добавила.txt'])).toEqual([
        'вне-списка.txt',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('неразрешимая база — ошибка, а не ноль нарушений', () => {
    const root = fixtureRepo();
    try {
      expect(() => changedPaths(root, 'origin/такой-ветки-нет')).toThrow(/не разрешается/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('переименование не склеивается в один путь — иначе R24 молчит на подмене', () => {
    // `git status --porcelain` отдаёт переименование как `R  старый -> новый`, и наивный
    // `slice(3)` даёт ОДИН путь `старый -> новый`. Он проходит проверку префиксом, если с
    // разрешённого префикса начинается ЛЕВАЯ половина: `git mv <разрешено>/x packages/…/evil.ts`
    // давал бы ноль нарушений, положив файл в замороженный пакет.
    const root = fixtureRepo();
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: root,
          encoding: 'utf8',
          timeout: 15_000,
          env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        });

      git('mv', 'base-only.txt', 'ушёл-в-запретное.txt');
      const changed = changedPaths(root, 'main');

      expect(changed).toContain('ушёл-в-запретное.txt');
      expect(changed).toContain('base-only.txt');
      expect(changed.some((one) => one.includes(' -> '))).toBe(false);
      expect(pathViolations(changed, ['base-only.txt', 'a.txt', 'ветка-добавила.txt'])).toEqual([
        'ушёл-в-запретное.txt',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Утверждение о РАБОЧЕМ дереве ветки живёт в `packages/core/bin/mcpproxy-r24.mjs` и
  // прогоняется гейтом, а не здесь. Причина измерена: `changedPaths` по настоящему
  // репозиторию делает весь юнит-прогон функцией от незакоммиченных правок разработчика —
  // один посторонний неотслеживаемый файл красит пакет целиком, — а мелкий клон CI без
  // `origin/main` роняет его вовсе. Это утверждение о ветке, а не инвариант модуля.
});
