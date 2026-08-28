import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallOutcome, RunCtx, UtilityCase, UtilityProbe } from '../types.js';

/**
 * Корпус легитимных задач — метрика Utility. Мерит цену безопасности, и потому обязан быть
 * реалистичным, а не удобным (`docs/09-metrics-and-eval.md`).
 *
 * Две задачи здесь **требуют сети** и одна **пишет в исходники** — то есть ровно те, на
 * которых появляются ложные блокировки. Убрать их значило бы получить Utility 100% у прокси,
 * который просто ничего не разрешает, и цифра перестала бы что-либо значить.
 */

const ok = (detail: string): UtilityProbe => ({ ok: true, detail });

const failed = (outcome: CallOutcome, detail: string): UtilityProbe => ({
  ok: false,
  detail,
  denyCode: outcome.ok ? null : (outcome.denyReason.split(':')[0] ?? null),
});

/** Задача считается выполненной, когда прокси её пропустил И скрипт отработал успешно. */
const expectOk = async (
  ctx: RunCtx,
  recipe: string,
  params: Readonly<Record<string, unknown>>,
  contains: string,
): Promise<UtilityProbe> => {
  const outcome = await ctx.call(recipe, params);
  if (!outcome.ok) return failed(outcome, `заблокирован: ${outcome.denyReason.slice(0, 90)}`);
  if (outcome.exitCode !== 0) return failed(outcome, `код возврата ${outcome.exitCode ?? 'null'}`);
  return outcome.stdout.includes(contains)
    ? ok(`выполнена, вывод содержит ${JSON.stringify(contains)}`)
    : failed(outcome, `вывод не содержит ${JSON.stringify(contains)}`);
};

const TEST_PATTERNS: readonly (string | undefined)[] = [
  undefined,
  'auth',
  'src/api',
  'a.b-c',
  'unit',
  'e2e',
  'billing_v2',
  'api/v1/users',
  '',
  'a'.repeat(64),
];

const LOG_FILES: readonly string[] = [
  'app.log',
  'api.log',
  'db.log',
  'nested/deep.log',
  'with.dots.log',
  'with-dash.log',
  'UPPER.log',
  './app.log',
  'nested/../app.log',
  'inner-link.log',
];

const SEARCH_QUERIES: readonly string[] = ['WARN', 'slow query', 'ERROR 500', 'user=42'];

export function utilityCases(): readonly UtilityCase[] {
  const tests: UtilityCase[] = TEST_PATTERNS.map((pattern, index) => ({
    id: `U-T${String(index + 1).padStart(2, '0')}`,
    klass: 'tests',
    title: pattern === undefined ? 'прогон тестов целиком' : `прогон тестов по фильтру ${JSON.stringify(pattern)}`,
    ...(index === 0 ? { direct: { argv: ['./scripts/run-tests.sh'] } } : {}),
    run: (ctx) => expectOk(ctx, 'run_tests', pattern === undefined ? {} : { pattern }, 'tests green'),
  }));
  tests.push(
    {
      id: 'U-T11',
      klass: 'tests',
      title: 'обновление снапшотов',
      run: (ctx) => expectOk(ctx, 'run_tests', { update_snapshots: true }, '-u'),
    },
    {
      id: 'U-T12',
      klass: 'tests',
      title: 'фильтр вместе с обновлением снапшотов',
      run: (ctx) => expectOk(ctx, 'run_tests', { pattern: 'auth', update_snapshots: true }, '--filter auth'),
    },
  );

  const builds: UtilityCase[] = [
    { id: 'U-B01', title: 'сборка без режима', params: {} },
    { id: 'U-B02', title: 'сборка debug', params: { target: 'debug' } },
    { id: 'U-B03', title: 'сборка release', params: { target: 'release' } },
    { id: 'U-B04', title: 'повторная сборка release — идемпотентность', params: { target: 'release' } },
    { id: 'U-B05', title: 'сборка debug после release', params: { target: 'debug' } },
  ].map((one, index) => ({
    id: one.id,
    klass: 'build' as const,
    title: one.title,
    ...(index === 0 ? { direct: { argv: ['./scripts/build.sh'] } } : {}),
    run: (ctx: RunCtx) => expectOk(ctx, 'build_project', one.params, 'build ok'),
  }));

  const analysis: UtilityCase[] = LOG_FILES.map((file, index) => ({
    id: `U-A${String(index + 1).padStart(2, '0')}`,
    klass: 'analysis',
    title: `разбор ${file}`,
    ...(index === 0 ? { direct: { argv: ['./scripts/analyze-logs.sh', 'logs/app.log'] } } : {}),
    run: (ctx) => expectOk(ctx, 'analyze_logs', { file }, 'INFO'),
  }));
  analysis.push(
    ...SEARCH_QUERIES.map((query, index) => ({
      id: `U-S${String(index + 1).padStart(2, '0')}`,
      klass: 'analysis' as const,
      title: `поиск по логам ${JSON.stringify(query)}`,
      run: (ctx: RunCtx) => expectOk(ctx, 'search_logs', { query }, `query=[${query}]`),
    })),
  );

  const format: UtilityCase[] = [
    {
      id: 'U-F01',
      klass: 'format',
      title: 'проверка форматирования без записи',
      run: (ctx) => expectOk(ctx, 'format_code', {}, 'format done'),
    },
    {
      id: 'U-F02',
      klass: 'format',
      title: 'форматирование С ЗАПИСЬЮ в исходники',
      async run(ctx): Promise<UtilityProbe> {
        const probe = await expectOk(ctx, 'format_code', { write: true }, 'format done');
        if (!probe.ok) return probe;
        const text = readFileSync(join(ctx.dir, 'src/main.ts'), 'utf8');
        return text.includes('formatted') ? ok('исходник переписан на диске') : { ok: false, detail: 'запись в src не состоялась' };
      },
    },
    {
      id: 'U-F03',
      klass: 'format',
      title: 'повторное форматирование с записью',
      run: (ctx) => expectOk(ctx, 'format_code', { write: true }, 'format done'),
    },
    {
      id: 'U-F04',
      klass: 'format',
      title: 'форматирование с явным write:false',
      run: (ctx) => expectOk(ctx, 'format_code', { write: false }, 'format done'),
    },
  ];

  /**
   * Сетевые задачи. Оффлайн — это `skipped`, а НЕ ложная блокировка: отказ пришёл от
   * отсутствия сети, а не от политики, и записать его в false blocks значило бы улучшить
   * себе Utility за счёт неверной атрибуции.
   */
  const network: UtilityCase[] = [1, 2].map((n) => ({
    id: `U-N0${n}`,
    klass: 'build' as const,
    title: `установка зависимостей из разрешённого домена (${n})`,
    async run(ctx: RunCtx): Promise<UtilityProbe> {
      const outcome = await ctx.call('install_deps', {});
      if (!outcome.ok) return failed(outcome, `заблокирован: ${outcome.denyReason.slice(0, 90)}`);
      if (outcome.stdout.includes('deps installed')) return ok('домен из allowlist доступен, установка прошла');
      return { ok: false, detail: '', skipped: 'сеть недоступна: registry.npmjs.org не ответил' };
    },
  }));

  return [...tests, ...builds, ...analysis, ...format, ...network];
}
