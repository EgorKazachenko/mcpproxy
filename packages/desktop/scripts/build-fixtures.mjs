import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainHash } from '@mcpproxy/contracts/audit';

/**
 * Собирает демо-трейс с честной цепочкой хэшей.
 *
 * Хэши написать руками нельзя: `chain.self` обязан удовлетворять формуле контракта, и
 * проставленное на глаз значение сделало бы демо-трейс постоянно «разошедшимся» — на сцене.
 * Поэтому фикстура генерируется, её вывод коммитится, а тест утверждает, что закоммиченное
 * проверяется.
 *
 * Оба прогона сценария S5 лежат в ОДНОМ логе: переключатель режима перематывает позицию, а
 * не подменяет файл. Разведёнными по файлам соседние строки пары не бывают, а цепочка
 * распалась бы на две с разными генезисами.
 */

const SESSION = 'sess-7f3a';
const CWD = '/Users/y/work/demo-repo';

let clock = Date.parse('2026-08-27T14:05:12.000Z');
const at = (deltaMs) => new Date((clock += deltaMs)).toISOString().replace('Z', '000Z');

const core = (traceId, spanId, stage, durationUs, extra = {}) => {
  const startTime = at(120);
  return {
    schema: 'mcpproxy.audit/1',
    operation: 'execute_tool',
    protocolVersion: '2025-11-25',
    toolName: extra.toolName ?? 'run_tests',
    sessionId: SESSION,
    traceId,
    spanId,
    parentSpanId: null,
    startTime,
    endTime: new Date(Date.parse(startTime) + Math.ceil(durationUs / 1000)).toISOString().replace('Z', '000Z'),
    durationUs,
    stage,
    verdict: extra.verdict ?? 'allowed',
    recipe: extra.recipe ?? { name: extra.toolName ?? 'run_tests' },
    ...extra.fields,
  };
};

const trace = (n) => `4bf92f3577b34da6a3ce929d0e0e${String(n).padStart(4, '0')}`;
const span = (n, k) => `00f067aa0b${String(n).padStart(3, '0')}${String(k).padStart(3, '0')}`;

/** Вызов, остановленный на стадии: ключа `argv` у него нет вовсе, а не пустой массив. */
function deniedCall(n, toolName, recipe, stages, denyReason) {
  return stages.map(([stage, us, fields], k) =>
    core(trace(n), span(n, k), stage, us, {
      toolName,
      recipe,
      verdict: stage === stages.at(-1)[0] ? 'denied' : 'allowed',
      fields: stage === stages.at(-1)[0] ? { denyReason, ...fields } : fields,
    }),
  );
}

/** Вызов, дошедший до `approval` и там остановленный: вердикт ожидания, а не отказ. */
function pendingCall(n, toolName, tier, stages) {
  const last = stages.at(-1)[0];
  return stages.map(([stage, us, fields], k) =>
    core(trace(n), span(n, k), stage, us, {
      toolName,
      recipe: { name: toolName },
      verdict: stage === last ? 'pending_approval' : 'allowed',
      fields: { ...fields, ...(stage === 'classify_risk' ? { risk: { tier, annotations: ANNOTATIONS[tier] } } : {}) },
    }),
  );
}

const ANNOTATIONS = {
  medium: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  high: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

function fullRun(n, { toolName = 'run_tests', argv, argvFromParams, tier = 'medium', mode, violations }) {
  const stages = [
    ['received', 340, {}],
    ['lock_check', 1020, { recipe: { name: toolName, hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' } }],
    ['validate', 720, {}],
    ['resolve_paths', 1640, { cwd: CWD }],
    // Ключ, а не значение: `argvFromParams: undefined` уронил бы канонизацию, и это правильно —
    // контракт различает отсутствующий ключ и пустое значение побайтово (`R13`).
    ['build_argv', 260, { argv, ...(argvFromParams === undefined ? {} : { argvFromParams }) }],
    ['classify_risk', 140, { risk: { tier, annotations: ANNOTATIONS[tier] } }],
    ['build_env', 480, { env: { allowed: ['PATH', 'HOME', 'LANG', 'CI'] } }],
    ['build_profile', mode === 'none' ? 0 : 1980, mode === 'none' ? {} : { sandbox: { mode, profile: { network: { allow: [] }, write: { allow: ['coverage', '/tmp'] } } } }],
    ['spawn', 12_400_000, { sandbox: { mode } }],
    ...violations.map((v) => ['violation', 0, { sandbox: { mode, violations: [v] } }]),
    ['redact', 1310, { redactions: [{ rule: 'npm-token', count: 1, stream: 'stdout' }], output: { bytes: 4096, truncated: false } }],
    ['complete', 0, { exit: { code: 0, signal: null }, duration: { overheadMs: 7 } }],
  ];
  return stages.map(([stage, us, fields], k) => core(trace(n), span(n, k), stage, us, { toolName, fields }));
}

const events = [
  ...deniedCall(
    1,
    'run_tests',
    { name: 'run_tests' },
    [
      ['received', 280, {}],
      ['lock_check', 960, {}],
      ['validate', 830, {}],
    ],
    'значение не соответствует ^[\\w./-]{0,64}$',
  ),
  ...deniedCall(
    2,
    'analyze_logs',
    { name: 'analyze_logs' },
    [
      ['received', 290, {}],
      ['lock_check', 980, {}],
      ['validate', 600, {}],
      ['resolve_paths', 2140, { cwd: CWD }],
    ],
    'резолвнутый путь вне корня logs',
  ),
  // S7 — rug pull: определение рецепта разошлось с lock, жёсткий стоп на `lock_check`.
  // Он же — пример из `R13`: у вызова, остановленного здесь, ключа `argv` нет вовсе.
  ...deniedCall(
    5,
    'analyze_logs',
    { name: 'analyze_logs' },
    [
      ['received', 300, {}],
      ['lock_check', 1140, {}],
    ],
    'определение рецепта разошлось с lock: добавлен аргумент --exec',
  ),

  // S6 — persistence: обе попытки отбиты, и обе всё равно красные. `mandatory-deny` —
  // единственная роль, не зависящая от исхода: успешно отбитая попытка закрепиться в системе
  // это не рутина.
  ...fullRun(6, {
    toolName: 'build_project',
    argv: ['pnpm', 'build'],
    mode: 'seatbelt',
    violations: [
      { type: 'mandatory-deny', target: '/Users/y/work/demo-repo/.git/hooks/pre-commit', action: 'denied', bytes: 0 },
      { type: 'mandatory-deny', target: '/Users/y/.zshrc', action: 'denied', bytes: 0 },
    ],
  }),

  // S8 — подтверждение: вызов ждёт человека вне контекста модели и до `spawn` не доходит.
  ...pendingCall(7, 'publish_release', 'high', [
    ['received', 310, {}],
    ['lock_check', 990, { recipe: { name: 'publish_release', hash: 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f901' } }],
    ['validate', 640, {}],
    ['resolve_paths', 1580, { cwd: CWD }],
    ['build_argv', 240, { argv: ['/bin/sh', './scripts/publish.sh', 'v1.4.0'], argvFromParams: [2] }],
    ['classify_risk', 150, {}],
    ['approval', 0, {}],
  ]),

  ...fullRun(3, { argv: ['pnpm', 'test', '--testPathPattern', 'auth'], argvFromParams: [3], mode: 'none', violations: [
    { type: 'network', target: 'evil.io:443', action: 'allowed', bytes: 1247 },
    { type: 'file-read', target: '/Users/y/.aws/credentials', action: 'allowed', bytes: 1247 },
  ] }),
  ...fullRun(4, { argv: ['pnpm', 'test', '--testPathPattern', 'auth'], argvFromParams: [3], mode: 'seatbelt', violations: [
    { type: 'network', target: 'evil.io:443', action: 'denied', bytes: 0 },
    { type: 'file-read', target: '/Users/y/.aws/credentials', action: 'denied', bytes: 0 },
  ] }),
];

/** Одна цепочка на весь лог: `prev` каждой записи совпадает с `self` предыдущей. */
let prev = null;
const chained = events.map((event) => {
  const self = chainHash(event, prev);
  const record = { ...event, chain: { prev, self } };
  prev = self;
  return record;
});

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
await mkdir(out, { recursive: true });
await writeFile(join(out, 'demo.jsonl'), chained.map((e) => JSON.stringify(e)).join('\n') + '\n');

/** Позиции начала прогонов — их читает проигрыватель, а не вычисляет на глаз. */
const marks = {
  seatbelt: chained.findIndex((e) => e.traceId === trace(4)),
  none: chained.findIndex((e) => e.traceId === trace(3)),
};
await writeFile(join(out, 'marks.json'), JSON.stringify(marks, null, 2) + '\n');

console.log(`fixtures: ${chained.length} записей, marks ${JSON.stringify(marks)}`);
