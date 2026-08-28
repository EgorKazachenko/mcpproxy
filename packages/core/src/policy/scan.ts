import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'es-module-lexer';

/**
 * Исполняемые проверки границ. Логика живёт здесь, чтобы её саму можно было прогнать на
 * **фикстурном дереве** в temp, а не подсаживать нарушение в рабочий код: `tsc -b`
 * компилирует `src/**`, и подсадка сделала бы продакшн-скан вечно красным.
 */

export interface ScanRule {
  readonly pattern: RegExp;
  /** Корни поиска, репо-относительные. Хвост `/**` необязателен и игнорируется. */
  readonly roots: readonly string[];
  /** Репо-относительные пути, которым правило не адресовано. Настоящий список, а не ноль. */
  readonly allow: readonly string[];
}

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'];
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git']);

/**
 * Комментарии снимаются до сопоставления: правила запрещают **вызов**, а не упоминание, и
 * доккомментарий, объясняющий запрет, — не его нарушение.
 *
 * Снимаются блочные комментарии и строчные, начинающие строку. Хвостовой `// …` после кода
 * остаётся: пропустить нарушение эта неполнота не может, она может только оставить лишнее
 * совпадение — то есть ошибается в сторону красного, а не зелёного.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

function sourcesUnder(repoRoot: string, root: string): string[] {
  const relative = root.replace(/\/\*+$/, '');
  const absolute = join(repoRoot, relative);
  // Исчезнувший корень — это молчаливо выключенное правило, поэтому он ошибка, а не ноль.
  if (!existsSync(absolute)) throw new Error(`корень скана не существует: ${root}`);

  return readdirSync(absolute, { recursive: true, encoding: 'utf8' })
    .filter((entry) => !entry.split('/').some((part) => IGNORED_DIRS.has(part)))
    .filter((entry) => SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension)))
    .map((entry) => `${relative}/${entry}`);
}

/** Репо-относительные пути файлов, нарушающих правило. */
export function scanSources(repoRoot: string, rule: ScanRule): readonly string[] {
  const allow = new Set(rule.allow);
  // Флаг `g` делает `test` состоящим из состояния: второй вызов на том же объекте пропустил
  // бы совпадение с начала файла.
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.replace(/g/g, ''));

  const hits = new Set<string>();
  for (const root of rule.roots) {
    for (const file of sourcesUnder(repoRoot, root)) {
      if (allow.has(file)) continue;
      if (pattern.test(withoutComments(readFileSync(join(repoRoot, file), 'utf8')))) hits.add(file);
    }
  }
  return [...hits].sort();
}

export interface GraphResult {
  readonly files: readonly string[];
  readonly bare: readonly string[];
}

/**
 * Обход графа от входа: относительные импорты резолвятся по файлу, рабочие — через
 * `resolveWorkspace`, остальные считаются голыми.
 *
 * Заявление R23 касается **достижимости**, а не списка файлов: `tsc` эмитит пофайлово, и в
 * `dist/` лежат модули, до которых из входа не дойти ни одним импортом.
 *
 * Требует инициализированного `es-module-lexer` (`await init`).
 */
export function walkGraph(entry: string, resolveWorkspace: (specifier: string) => string | null): GraphResult {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) continue;

    const [imports] = parse(readFileSync(file, 'utf8'));
    for (const one of imports) {
      const specifier = one.n;
      if (specifier === undefined) continue;

      if (specifier.startsWith('.')) {
        queue.push(resolve(dirname(file), specifier));
        continue;
      }

      const resolved = resolveWorkspace(specifier);
      if (resolved === null) bare.add(specifier);
      else queue.push(resolved);
    }
  }

  return { files: [...seen], bare: [...bare] };
}

/**
 * Резолвер рабочих пакетов — **включая подпути**.
 *
 * `core` импортирует `@mcpproxy/contracts/validate` и `.../audit`, и это именно те входы,
 * что тянут `ajv`, `re2` и `node:crypto`. Отображение по одному лишь базовому имени пакета
 * их бы не прошло — слепое пятно, ради которого резолвер и существует.
 */
export function workspaceResolver(repoRoot: string): (specifier: string) => string | null {
  const packages = new Map<string, { dir: string; exports: Record<string, unknown> }>();
  const packagesDir = join(repoRoot, 'packages');

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: unknown;
      exports?: Record<string, unknown>;
    };
    if (typeof manifest.name !== 'string') continue;
    packages.set(manifest.name, { dir: join(packagesDir, entry.name), exports: manifest.exports ?? {} });
  }

  return (specifier) => {
    for (const [name, pkg] of packages) {
      if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;

      const subpath = specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`;
      const target = pkg.exports[subpath];
      const file = typeof target === 'string' ? target : (target as { default?: unknown } | undefined)?.default;
      return typeof file === 'string' ? join(pkg.dir, file) : null;
    }
    return null;
  };
}

/**
 * Чистая половина проверки R24: пути на вход, нарушения на выход.
 *
 * Запись списка с хвостом `/**` означает каталог со всем содержимым; без хвоста — ровно один
 * файл.
 */
export function pathViolations(changed: readonly string[], allowList: readonly string[]): readonly string[] {
  const prefixes = allowList.filter((one) => one.endsWith('/**')).map((one) => one.slice(0, -2));
  const exact = new Set(allowList.filter((one) => !one.endsWith('/**')));

  return changed
    .filter((path) => !exact.has(path) && !prefixes.some((prefix) => path.startsWith(prefix)))
    .sort();
}

/**
 * Пути, изменённые веткой относительно точки ветвления, — вход проверки R24.
 *
 * **Три точки, а не две:** две читали бы коммиты, попавшие в базу после ответвления, как наши
 * нарушения. И **вместе с `git status`**, потому что `git diff` неотслеживаемых файлов не
 * видит, а почти все поставки эпика — новые файлы: без второй половины проверка молчала бы
 * ровно там, где должна говорить.
 *
 * Неразрешимая база — **ошибка**, а не ноль нарушений: в клоне CI база может быть не выкачана,
 * и молчаливый ноль здесь и есть fail-open.
 */
export function changedPaths(repoRoot: string, base: string): readonly string[] {
  // `core.quotePath=false` обязателен: иначе git отдаёт не-ASCII путь в кавычках и восьмеричных
  // экранах, и такой файл не совпал бы ни с одной записью списка — то есть проверка потеряла бы
  // ровно те файлы, чьё имя не в ASCII.
  const git = (args: readonly string[]): string =>
    execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      // stderr перехватывается, а не уезжает в консоль: неразрешимая база — ожидаемая ветка,
      // и её диагностика едет в сообщение исключения, а не в вывод прогона.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  try {
    git(['rev-parse', '--verify', base]);
  } catch (error) {
    throw new Error(`база сравнения ${base} не разрешается: ${error instanceof Error ? error.message : String(error)}`);
  }

  // `--no-renames` намеренно: с определением переименований git показал бы только новый путь, а
  // проверке нужны оба — уехавший файл изменился по обоим адресам.
  const committed = git(['diff', '--name-only', '--no-renames', `${base}...HEAD`]).split('\n');

  return [...new Set([...committed, ...workingTreePaths(git)])].filter((one) => one !== '').sort();
}

/**
 * Пути из `git status`, разобранные из **NUL-разделённого** вывода.
 *
 * Построчный разбор с `slice(3)` здесь — fail-open, а не косметика: переименование приходит
 * записью `R  старый -> новый`, срез отдаёт один склеенный путь `старый -> новый`, и он
 * проходит проверку префиксом, если с разрешённого префикса начинается ЛЕВАЯ половина. То есть
 * `git mv docs/<разрешено>/x.md packages/contracts/evil.ts` давал бы ноль нарушений, положив
 * файл в замороженный пакет. В форме `-z` переименование приходит двумя записями подряд —
 * сначала новый путь, следом исходный, — и кавычек не бывает вовсе.
 */
function workingTreePaths(git: (args: readonly string[]) => string): string[] {
  const entries = git(['status', '--porcelain', '--untracked-files=all', '-z']).split('\0');
  const paths: string[] = [];

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined || entry.length < 4) continue;

    paths.push(entry.slice(3));
    // `R`/`C` в любой из двух колонок статуса: следующая запись — исходный путь, и он тоже
    // изменён, поэтому проверяется наравне с новым.
    if (/^[RC]/.test(entry) || /^.[RC]/.test(entry)) {
      const origin = entries[i + 1];
      if (origin !== undefined && origin !== '') paths.push(origin);
      i += 1;
    }
  }

  return paths;
}
