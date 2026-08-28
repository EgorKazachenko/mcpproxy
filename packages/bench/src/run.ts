import { spawnSync } from 'node:child_process';
import { A12_ENV, attackCases } from './corpus/attacks.js';
import { utilityCases } from './corpus/legit.js';
import { startListener, type Listener } from './listener.js';
import { attackMetrics, journalMetrics, utilityMetrics, type DirectComparison, type ModeReport } from './metrics.js';
import { RigStartError, startRig, type Rig } from './rig.js';
import type { AttackCase, BenchMode, CaseResult, UtilityCase } from './types.js';

/**
 * Прогон корпуса. Один вход, две точки входа сверху — CLI и вкладка «Red team» в E7
 * (правило 5 из `docs/09-metrics-and-eval.md`).
 *
 * **Baseline обязателен.** Режимы прогоняются оба и всегда: доля заблокированных атак без
 * контраста не интерпретируется. Порядок — сначала `seatbelt`, затем `none`: если прогон
 * оборвут посередине, останется тот режим, который и предъявляется как результат.
 */
export interface RunOptions {
  readonly modes?: readonly BenchMode[];
  /** Фильтр по префиксу идентификатора: `A1`, `U-T`, `A10-03`. Пусто — весь корпус. */
  readonly only?: readonly string[];
  readonly overheadIterations?: number;
  readonly onResult?: (result: CaseResult) => void;
  readonly onMode?: (mode: BenchMode) => void;
}

export interface BenchRun {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly modes: readonly ModeReport[];
  /** Границы, названные вслух: они едут в отчёт рядом с цифрами, а не в сноску под ним. */
  readonly limits: readonly string[];
}

export const LIMITS: readonly string[] = [
  'A15 (Electron) не исполняется из bench-процесса: рендерера здесь нет. Класс закрывают чек-лист E9 и тесты E7.',
  'Два хоста класса A9 требуют настоящей внешней сети и пропущены: их отказ в оффлайне пришёл бы от DNS, а не от политики.',
  'Инъекция обычным текстом в `description` (A7) структурной защитой не снимается и в корпус не входит — см. docs/10-honest-limitations.md.',
  'Сетевые легитимные задачи помечены `openWorldHint` и потому high-risk: пока брокер апрувов E5 не подключён, они отказываются — это ложные блокировки конвейера, а не политики.',
  '`read.allow` вендорской песочницы расширяет доступ, а не сужает: реально держит только явный `deny`. Демо-манифест поэтому перечисляет пути учёток поимённо — см. docs/10-honest-limitations.md.',
  'Корпус написан авторами прокси и неполон по определению; половина классов взята из внешних источников (CVE, спека MCP, OWASP ASI), а не придумана.',
];

const filtered = <T extends { readonly id: string }>(cases: readonly T[], only: readonly string[]): readonly T[] =>
  only.length === 0 ? cases : cases.filter((one) => only.some((prefix) => one.id.startsWith(prefix)));

const timed = async <T>(work: () => Promise<T>): Promise<{ value: T; ms: number }> => {
  const started = Date.now();
  const value = await work();
  return { value, ms: Date.now() - started };
};

const errorResult = (
  base: Omit<CaseResult, 'status' | 'denyCode' | 'detail' | 'durationMs'>,
  error: unknown,
  ms: number,
): CaseResult => ({
  ...base,
  status: 'error',
  denyCode: null,
  detail: `сбой стенда: ${(error as Error).message}`,
  durationMs: ms,
});

async function runUtility(rig: Rig, cases: readonly UtilityCase[], emit: (r: CaseResult) => void): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const one of cases) {
    const base = { id: one.id, kind: 'utility' as const, klass: one.klass, title: one.title, mode: rig.mode };
    try {
      const { value, ms } = await timed(() => one.run(rig));
      const status = value.skipped !== undefined ? 'skipped' : value.ok ? 'completed' : 'false-block';
      const result: CaseResult = {
        ...base,
        status,
        denyCode: value.denyCode ?? null,
        detail: value.skipped ?? value.detail,
        durationMs: ms,
      };
      results.push(result);
      emit(result);
    } catch (error) {
      const result = errorResult(base, error, 0);
      results.push(result);
      emit(result);
    }
  }
  return results;
}

async function runAttack(
  one: AttackCase,
  rig: Rig,
  mode: BenchMode,
  emit: (r: CaseResult) => void,
): Promise<CaseResult> {
  const base = { id: one.id, kind: 'attack' as const, klass: one.klass, title: one.title, mode };
  try {
    const { value, ms } = await timed(() => one.run(rig));
    const result: CaseResult = {
      ...base,
      status: value.skipped !== undefined ? 'skipped' : value.achieved ? 'achieved' : 'blocked',
      denyCode: value.denyCode ?? null,
      detail: value.skipped ?? value.detail,
      durationMs: ms,
      ...(value.note === undefined ? {} : { note: value.note }),
    };
    emit(result);
    return result;
  } catch (error) {
    const result = errorResult(base, error, 0);
    emit(result);
    return result;
  }
}

/**
 * Оверхед относительно ПРЯМОГО вызова того же скрипта (правило 3), а не относительно нуля.
 * Медиана, а не среднее: первый прогон греет кэш файловой системы и тянет среднее вверх.
 */
function directComparison(rig: Rig, proxied: readonly number[], iterations: number): DirectComparison | null {
  if (proxied.length === 0) return null;
  const direct: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = Date.now();
    spawnSync('./scripts/analyze-logs.sh', ['logs/app.log'], { cwd: rig.dir, encoding: 'utf8' });
    direct.push(Date.now() - started);
  }
  const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  const proxiedMs = median(proxied);
  const directMs = median(direct);
  return { proxiedMs, directMs, deltaMs: proxiedMs - directMs, iterations };
}

async function runMode(mode: BenchMode, listener: Listener | null, options: RunOptions): Promise<ModeReport> {
  const only = options.only ?? [];
  const emit = options.onResult ?? ((): void => {});
  const journals: string[] = [];
  const results: CaseResult[] = [];

  const attacks = filtered(attackCases(listener), only);
  const utility = filtered(utilityCases(), only);

  const shared = await startRig({ mode, listener: listener === null ? null : `${listener.host}:${listener.port}` });
  process.env.HOME = shared.home;
  journals.push(shared.auditPath);

  try {
    results.push(...(await runUtility(shared, utility, emit)));

    // Замер оверхеда — на общем риге и на одном рецепте: сравнивать надо один и тот же
    // скрипт, иначе разница длительностей скажет про скрипты, а не про прокси.
    const proxied: number[] = [];
    const iterations = options.overheadIterations ?? 7;
    if (utility.length > 0) {
      for (let index = 0; index < iterations; index += 1) {
        const started = Date.now();
        await shared.call('analyze_logs', { file: 'app.log' });
        proxied.push(Date.now() - started);
      }
    }
    const direct = directComparison(shared, proxied, iterations);

    for (const one of attacks) {
      if (one.fresh === undefined) {
        results.push(await runAttack(one, shared, mode, emit));
        continue;
      }
      // Кейс правит манифест или lock — ему нужен свой демон, иначе он поменяет условия
      // соседям по корпусу и следующая цифра будет измерена уже на другом стенде.
      let fresh: Rig | null = null;
      try {
        fresh = await startRig({ mode, ...(one.fresh.manifest === undefined ? {} : { manifest: one.fresh.manifest }) });
        process.env.HOME = fresh.home;
        journals.push(fresh.auditPath);
        if (one.fresh.after !== undefined) await one.fresh.after(fresh);
        results.push(await runAttack(one, fresh, mode, emit));
      } catch (error) {
        // Манифест, отвергнутый загрузчиком, — это БЛОК класса A7, а не сбой стенда: до
        // `tools/list` отравленное описание не доехало.
        const rejected = error instanceof RigStartError && error.code === 'manifest-rejected';
        const result: CaseResult = {
          id: one.id,
          kind: 'attack',
          klass: one.klass,
          title: one.title,
          mode,
          status: rejected ? 'blocked' : 'error',
          denyCode: rejected ? 'invalid-manifest' : null,
          detail: rejected ? 'манифест отвергнут схемой при загрузке' : `сбой стенда: ${(error as Error).message}`,
          durationMs: 0,
        };
        results.push(result);
        emit(result);
      } finally {
        await fresh?.close();
        process.env.HOME = shared.home;
      }
    }

    const journal = journalMetrics(journals);
    return {
      mode,
      attacks: attackMetrics(results),
      utility: utilityMetrics(results),
      overhead: journal.overhead,
      direct,
      highRisk: journal.highRisk,
      secretLeaks: journal.secretLeaks,
      chainVerified: journal.chainVerified,
      results,
    };
  } finally {
    await shared.close();
  }
}

export async function runBench(options: RunOptions = {}): Promise<BenchRun> {
  const startedAt = new Date().toISOString();
  const modes = options.modes ?? (['seatbelt', 'none'] as const);
  const savedHome = process.env.HOME;
  const savedEnv = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(A12_ENV)) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }

  const listener = await startListener();
  const reports: ModeReport[] = [];
  try {
    for (const mode of modes) {
      options.onMode?.(mode);
      reports.push(await runMode(mode, listener, options));
    }
  } finally {
    await listener.close();
    process.env.HOME = savedHome;
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  return { startedAt, finishedAt: new Date().toISOString(), modes: reports, limits: LIMITS };
}
