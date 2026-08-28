import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_GRACE_MS, runProcess, truncateToBytes } from './limits.js';
import type { ProcessLimits } from './limits.js';

/**
 * Живые процессы, а не моки: R16 говорит о дереве процессов, и дерево, которого нет,
 * ничего не доказывает. Проба П4 показала три выживших потомка при убийстве по pid —
 * именно это число и обязан ловить первый тест.
 */

/** Уникальная длительность вместо pid-группы: маркер виден в `ps` независимо от нашей же логики. */
const MARKER_SECONDS = '29387';

const survivors = (): number => {
  const out = execFileSync('/bin/ps', ['-A', '-o', 'args='], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line.includes(`sleep ${MARKER_SECONDS}`)).length;
};

const LIMITS: ProcessLimits = {
  timeoutMs: 5_000,
  graceMs: DEFAULT_GRACE_MS,
  maxBytes: null,
  holdBackBytes: 0,
  env: { PATH: '/usr/bin:/bin' },
  cwd: tmpdir(),
};

const sh = (script: string): readonly [string, ...string[]] => ['/bin/sh', '-c', script];

const cleanupMarkers = async (): Promise<void> => {
  try {
    execFileSync('/usr/bin/pkill', ['-f', `sleep ${MARKER_SECONDS}`]);
  } catch {
    // pkill выходит с 1, когда убивать нечего, — это норма после зелёного теста.
  }
  // Сигнал доставлен, но процесс ещё не пожат: `pkill` вернулся, а строка в `ps` живёт
  // ещё миллисекунды. Без ожидания предусловие следующего теста краснеет по гонке уборки.
  for (let attempt = 0; attempt < 40 && survivors() > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// Уборка и ПЕРЕД набором тоже: маркер один на файл, и сирота, пережившая прошлый прогон
// (например прогон с намеренно сломанным `detached`), сделала бы предусловие красным по
// причине, не имеющей отношения к проверяемому коду.
beforeAll(cleanupMarkers);
afterEach(cleanupMarkers);

describe('runProcess — таймаут по группе (R16, R18)', () => {
  it('убивает всё дерево, а не один exec[0]', async () => {
    expect(survivors()).toBe(0);

    const raw = await runProcess(sh(`sleep ${MARKER_SECONDS} & sleep ${MARKER_SECONDS} & sleep ${MARKER_SECONDS} & wait`), {
      ...LIMITS,
      timeoutMs: 300,
      graceMs: 200,
    });

    expect(raw.termination).toBe('timeout');
    // Проба П4: без `detached: true` и убийства по группе здесь выживают трое.
    expect(survivors()).toBe(0);
    expect(raw.groupDrained).toBe(true);
  });

  it('SIGTERM в grace-окне против SIGKILL у игнорирующего сигнал', async () => {
    // Вердикт не выводится из сигнала (D6, R18) — его несёт `termination`, — но само
    // различие обязано быть наблюдаемым: иначе «умер штатно» и «пришлось добивать»
    // неотличимы в отчёте.
    const polite = await runProcess(sh(`sleep ${MARKER_SECONDS}`), { ...LIMITS, timeoutMs: 200, graceMs: 3_000 });
    expect(polite.exit.signal).toBe('SIGTERM');
    expect(polite.termination).toBe('timeout');

    const stubborn = await runProcess(sh(`trap '' TERM; sleep ${MARKER_SECONDS}`), {
      ...LIMITS,
      timeoutMs: 200,
      graceMs: 300,
    });
    expect(stubborn.exit.signal).toBe('SIGKILL');
    expect(stubborn.termination).toBe('timeout');
  });

  it('штатный выход не помечается таймаутом и подтверждает пустоту группы', async () => {
    const raw = await runProcess(sh('exit 3'), LIMITS);
    expect(raw.termination).toBe('exited');
    expect(raw.exit).toEqual({ code: 3, signal: null });
    expect(raw.groupDrained).toBe(true);
  });
});

describe('runProcess — потолок вывода (R19, R20, R49)', () => {
  const capped = { ...LIMITS, maxBytes: 64, holdBackBytes: 8 };

  it('считает произведённое и доехавшее РАЗНЫМИ числами', async () => {
    // Слив двух счётчиков в один опубликовал бы в событии не ту величину: `producedBytes`
    // — сколько процесс произвёл, `bytes` — сколько доехало после редакции и обрезки.
    const raw = await runProcess(sh('printf "%0100d" 0'), capped);
    expect(raw.stdout.producedBytes).toBe(100);
    expect(raw.stdout.bytes).toBe(64);
    expect(raw.stdout.truncated).toBe(true);
  });

  it('не убивает процесс на потолке — cap это исход усечения, а не казни', async () => {
    // Убийство на потолке превратило бы многословную, но безобидную команду в отказ и
    // сдвинуло бы метрику Utility under Attack.
    const raw = await runProcess(sh('printf "%0300d" 0; exit 0'), capped);
    expect(raw.exit.code).toBe(0);
    expect(raw.exit.signal).toBe(null);
    expect(raw.termination).toBe('output-cap');
  });

  it('граница включительна: ровно потолок не режется, потолок плюс один режется', async () => {
    const exact = await runProcess(sh('printf "%064d" 0'), capped);
    expect(exact.stdout.bytes).toBe(64);
    expect(exact.stdout.truncated).toBe(false);
    expect(exact.termination).toBe('exited');

    const over = await runProcess(sh('printf "%065d" 0'), capped);
    expect(over.stdout.bytes).toBe(64);
    expect(over.stdout.truncated).toBe(true);
    expect(over.termination).toBe('output-cap');
  });

  it('maxBytes: null означает отсутствие потолка (D8)', async () => {
    const raw = await runProcess(sh('printf "%0500d" 0'), { ...LIMITS, maxBytes: null });
    expect(raw.stdout.bytes).toBe(500);
    expect(raw.stdout.truncated).toBe(false);
    expect(raw.termination).toBe('exited');
  });

  it('таймаут побеждает потолок, когда сработали оба (R49)', async () => {
    const raw = await runProcess(sh(`printf "%0300d" 0; sleep ${MARKER_SECONDS}`), {
      ...capped,
      timeoutMs: 300,
      graceMs: 200,
    });
    expect(raw.stdout.producedBytes).toBeGreaterThanOrEqual(300);
    // Приоритет задан, а не выведен из порядка проверок: иначе поле одно, а исходов два.
    expect(raw.termination).toBe('timeout');
  });

  it('stderr считается отдельно от stdout', async () => {
    const raw = await runProcess(sh('printf "%0100d" 0 >&2'), capped);
    expect(raw.stderr.producedBytes).toBe(100);
    expect(raw.stderr.bytes).toBe(64);
    expect(raw.stdout.producedBytes).toBe(0);
    expect(raw.stdout.truncated).toBe(false);
  });
});

describe('runProcess — hold-back окно и шов с E6 (R20, D13)', () => {
  it('редактор получает окно ДО обрезки, размером ровно потолок плюс запас', async () => {
    // `holdBackBytes` строго больше нуля в фикстуре намеренно: с нулевым запасом
    // утверждение вырождается в `maxBytes === maxBytes` и не проверяет ничего.
    const windows: Buffer[] = [];
    const raw = await runProcess(sh('printf "%0300d" 0'), {
      ...LIMITS,
      maxBytes: 64,
      holdBackBytes: 8,
      redact: (window) => {
        windows.push(window);
        return window;
      },
    });

    expect(windows).toHaveLength(2);
    expect(windows[0]?.byteLength).toBe(72);
    expect(raw.stdout.bytes).toBe(64);
  });

  /**
   * Секрет лежит **ровно на границе**: шестьдесят нулей, затем `SECRET-XYZ` — то есть он
   * начинается до потолка в 64 байта и заканчивается за ним.
   *
   * Пара утверждений одна против другой, и это единственная форма, в которой hold-back
   * вообще что-то доказывает: с запасом редактор видит правило целиком и вырезает его, без
   * запаса он видит обрубок `SECRE`, не узнаёт правило — и обрубок `SECR` уезжает
   * потребителю.
   */
  it('секрет на границе редактируется с запасом и протекает без него', async () => {
    const script = 'printf "%060d" 0; printf "SECRET-XYZ"; printf "%030d" 0';
    const redact = (window: Buffer): Buffer =>
      Buffer.from(window.toString('utf8').replace('SECRET-XYZ', '[REDACTED]'), 'utf8');

    const withHoldBack = await runProcess(sh(script), { ...LIMITS, maxBytes: 64, holdBackBytes: 16, redact });
    expect(withHoldBack.stdout.buffer.toString('utf8')).not.toContain('SEC');
    expect(withHoldBack.stdout.bytes).toBe(64);

    const without = await runProcess(sh(script), { ...LIMITS, maxBytes: 64, holdBackBytes: 0, redact });
    expect(without.stdout.buffer.toString('utf8')).toContain('SECR');
  });

  /**
   * Исход и `truncated` обязаны опираться на ОДНО свидетельство.
   *
   * Фикстура разводит два основания: процесс произвёл 70 байт при потолке 64, то есть
   * `produced > maxBytes` — по этому основанию исход был бы `output-cap`. Но в окно чтения
   * (64 + 8) поместилось всё, а редакция схлопнула окно до десяти байт, и на потолке тоже
   * ничего не отброшено. Отброшенного нет — значит и «оборван по потолку» нет.
   *
   * Без пары утверждений здесь `Termination` утверждал бы «отказ, потому что вывод обрезан»
   * на вызове, где не обрезано ничего, — а из этого дискриминатора E4 по D6 выводит вердикт.
   */
  it('исход и truncated считаются по одному свидетельству, а не по разным', async () => {
    const raw = await runProcess(sh('printf "%070d" 0'), {
      ...LIMITS,
      maxBytes: 64,
      holdBackBytes: 8,
      redact: () => Buffer.from('короче', 'utf8'),
    });

    expect(raw.stdout.producedBytes).toBe(70);
    expect(raw.stdout.truncated).toBe(false);
    // По старому основанию (`produced > maxBytes`) здесь стояло бы 'output-cap'.
    expect(raw.termination).toBe('exited');
  });

  it('и наоборот: отброшенное на потолке даёт output-cap при любой редакции', async () => {
    const raw = await runProcess(sh('printf "%0300d" 0'), {
      ...LIMITS,
      maxBytes: 64,
      holdBackBytes: 8,
      redact: (window) => window,
    });
    expect(raw.stdout.truncated).toBe(true);
    expect(raw.termination).toBe('output-cap');
  });

});

describe('truncateToBytes — байты, а не единицы UTF-16 (R19)', () => {
  it('режет по байтам', () => {
    expect(truncateToBytes('ЖЖЖ', 5).byteLength).toBe(5);
    // Шесть байт в трёх символах: `text.length` дал бы 3 и не сработал бы вовсе.
    expect(Buffer.from('ЖЖЖ', 'utf8').byteLength).toBe(6);
  });

  it('обрезка на границе последовательности даёт U+FFFD, а не молчаливую потерю', () => {
    expect(truncateToBytes('ЖЖЖ', 5).toString('utf8')).toBe('ЖЖ�');
  });

  it('короче потолка — не трогает', () => {
    expect(truncateToBytes('abc', 64).toString('utf8')).toBe('abc');
  });
});
