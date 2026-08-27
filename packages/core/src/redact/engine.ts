import RE2 from 're2';
import { ENTROPY_RULE_ID, findHighEntropyRuns } from './entropy.js';
import type { SecretRule } from './rules.js';
import { SECRET_RULES } from './rules.js';

/**
 * Движок редакции: находит совпадения, разрешает пересечения, заменяет.
 *
 * Направление (`stdout` / `argv` / …) движку не сообщается — он про текст. Что с каким
 * направлением делать, решает `output.ts`: исходящее заменяется, входящее только считается.
 */

export interface SecretMatch {
  readonly start: number;
  readonly end: number;
  readonly rule: string;
}

export interface ScanOptions {
  /**
   * Включать ли энтропийный детектор. Только для `stdout` и `stderr` (R7): на `argv` и
   * значениях окружения он даёт ложняки на путях и идентификаторах, а находок не добавляет —
   * там сидят значения параметров, а не блобы.
   */
  readonly entropy: boolean;
}

export interface RedactedText {
  readonly text: string;
  /** `rule → сколько раз сработало`. */
  readonly counts: ReadonlyMap<string, number>;
}

export interface Redactor {
  /** Отрезки, которые будут заменены. Отсортированы по `start`, не пересекаются. */
  readonly scan: (text: string, options: ScanOptions) => readonly SecretMatch[];
  readonly redact: (text: string, options: ScanOptions) => RedactedText;
}

/**
 * Плейсхолдер несёт имя правила: без него демо S2 показывает залу чёрный прямоугольник и
 * доказывает ровно ничего. Имена правил публичны — они и так лежат в этом репозитории.
 */
export const placeholder = (rule: string): string => `[redacted:${rule}]`;

interface CompiledRule {
  readonly id: string;
  readonly regexp: RE2;
  /** Позиция в наборе. Разрешает последнюю ничью (R13) детерминированно. */
  readonly order: number;
}

interface Candidate extends SecretMatch {
  readonly order: number;
}

/**
 * Ошибка компиляции набора. Отдельный класс, а не строка: `output.ts` обязан отличать
 * «набор правил сломан» от «в тексте нет секретов», и `instanceof` — единственный способ,
 * переживающий сериализацию сообщения.
 */
export class RuleCompilationError extends Error {
  constructor(readonly failures: readonly { readonly id: string; readonly reason: string }[]) {
    super(`правила не компилируются в RE2: ${failures.map((one) => `${one.id} (${one.reason})`).join(', ')}`);
    this.name = 'RuleCompilationError';
  }
}

/** Ранжирование (R13): длиннее → раньше по позиции → раньше в наборе. */
const outranks = (a: Candidate, b: Candidate): boolean => {
  const lengthA = a.end - a.start;
  const lengthB = b.end - b.start;
  if (lengthA !== lengthB) return lengthA > lengthB;
  if (a.start !== b.start) return a.start < b.start;
  return a.order < b.order;
};

/**
 * Слияние пересекающихся совпадений в непересекающиеся отрезки замены.
 *
 * **Замена покрывает ОБЪЕДИНЕНИЕ найденного, а не только победителя.** Первая версия
 * выбирала победителя и отбрасывала пересёкшегося кандидата ЦЕЛИКОМ — и торчащий за границы
 * победителя кусок, уже опознанный как секрет, оставался в тексте. Воспроизводилось на паре
 * «высокоэнтропийный блоб впритык к JWT»: JWT длиннее и побеждал, блоб отбрасывался, 42
 * символа уезжали вызывающему, и в отчёте не было даже следа. Объединение делает утечку
 * невозможной по построению: ни один найденный байт не переживает замену.
 *
 * Отрезок помечается правилом сильнейшего кандидата в нём — оператору `github-pat` говорит,
 * какой ключ отзывать, а `high-entropy-base64` не говорит ничего. При этом в отчёт попадает
 * **каждое** сработавшее правило, а не только победившее: слияние отрезков не имеет права
 * скрывать, что сработал второй детектор.
 *
 * Стоимость — сортировка плюс один проход. Прошлая версия сверяла каждого кандидата со всем
 * списком принятых и была квадратичной: замер на выводе из base64-ранов давал 8 КБ → 1.7 мс,
 * 1 МБ → 436 мс, 4 МБ → 4.2 с, то есть удвоение входа стоило ×3.9 времени. Вход — `stdout`
 * дочернего процесса ДО обрезки (порядок R10 обязывает), и `maxBytes` его не ограничивает,
 * так что это был тот же отказ в обслуживании, ради которого R6 выбрал RE2, — только этажом
 * выше.
 */
interface Merged {
  /** Непересекающиеся отрезки замены, по возрастанию `start`. */
  readonly segments: readonly SecretMatch[];
  /** Совпадения, попадающие в отчёт. См. правило поглощения ниже. */
  readonly reported: readonly Candidate[];
}

function mergeCandidates(candidates: readonly Candidate[]): Merged {
  if (candidates.length === 0) return { segments: [], reported: [] };

  const byStart = [...candidates].sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  const segments: SecretMatch[] = [];
  const reported: Candidate[] = [];

  const first = byStart[0] as Candidate;
  let start = first.start;
  let end = first.end;
  let best = first;
  let members: Candidate[] = [first];

  /**
   * Правило отчёта: совпадение попадает в него, если победитель отрезка **не поглощает его
   * целиком**.
   *
   * Иначе отчёт шумит на пустом месте: на одном `ghp_…` срабатывают и `github-pat`, и
   * энтропия — тот же самый диапазон, два имени, и оператор гадает, два там секрета или один.
   * И наоборот, поглощение не должно скрывать находку, торчащую за границы победителя: блоб
   * рядом с JWT — это ВТОРОЙ секрет, и промолчать о нём значит вернуть ту же дыру, только в
   * отчёте вместо текста.
   */
  const flush = (): void => {
    segments.push({ start, end, rule: best.rule });
    for (const member of members) {
      if (member === best || !(best.start <= member.start && member.end <= best.end)) reported.push(member);
    }
  };

  for (let i = 1; i < byStart.length; i += 1) {
    const candidate = byStart[i];
    if (candidate === undefined) continue;

    // Строгое `<`: соприкасающиеся отрезки (`candidate.start === end`) не пересекаются и
    // остаются двумя заменами — два секрета подряд обязаны читаться как два.
    if (candidate.start < end) {
      if (candidate.end > end) end = candidate.end;
      if (outranks(candidate, best)) best = candidate;
      members.push(candidate);
    } else {
      flush();
      start = candidate.start;
      end = candidate.end;
      best = candidate;
      members = [candidate];
    }
  }
  flush();

  return { segments, reported };
}

/**
 * Компилирует набор один раз.
 *
 * Паттерн, который RE2 не принимает, роняет **загрузку набора**, а не выпадает из
 * сканирования (R6). Правило, тихо выпавшее из набора, — это выключенная защита, о которой
 * никто не узнает: тесты на остальные правила остаются зелёными.
 */
export function createRedactor(rules: readonly SecretRule[] = SECRET_RULES): Redactor {
  const compiled: CompiledRule[] = [];
  const failures: { id: string; reason: string }[] = [];

  rules.forEach((rule, order) => {
    try {
      compiled.push({ id: rule.id, regexp: new RE2(rule.pattern, 'g'), order });
    } catch (error) {
      failures.push({ id: rule.id, reason: error instanceof Error ? error.message : String(error) });
    }
  });

  if (failures.length > 0) throw new RuleCompilationError(failures);

  const collect = (text: string, options: ScanOptions): Candidate[] => {
    const candidates: Candidate[] = [];

    for (const rule of compiled) {
      for (let match = rule.regexp.exec(text); match !== null; match = rule.regexp.exec(text)) {
        const hit = match[0];
        // Паттерн, способный совпасть с пустотой (`x*` в пользовательском наборе), не двигает
        // `lastIndex` — движок встал бы на месте навсегда. Двигаем сами и такое совпадение
        // не считаем: вырезать нечего.
        if (hit.length === 0) {
          rule.regexp.lastIndex += 1;
          continue;
        }
        candidates.push({ start: match.index, end: match.index + hit.length, rule: rule.id, order: rule.order });
      }
    }

    if (options.entropy) {
      for (const run of findHighEntropyRuns(text)) {
        // Энтропия идёт ПОСЛЕ всех именованных правил, поэтому при равной длине и позиции
        // выигрывает правило с именем: `ghp_…` в отчёте обязан называться `github-pat`.
        candidates.push({ ...run, rule: ENTROPY_RULE_ID, order: compiled.length });
      }
    }

    return candidates;
  };

  const scan = (text: string, options: ScanOptions): readonly SecretMatch[] =>
    mergeCandidates(collect(text, options)).segments;

  const redact = (text: string, options: ScanOptions): RedactedText => {
    const { segments, reported } = mergeCandidates(collect(text, options));
    if (segments.length === 0) return { text, counts: new Map() };

    const pieces: string[] = [];
    let cursor = 0;
    for (const segment of segments) {
      pieces.push(text.slice(cursor, segment.start), placeholder(segment.rule));
      cursor = segment.end;
    }
    pieces.push(text.slice(cursor));

    const counts = new Map<string, number>();
    for (const candidate of reported) counts.set(candidate.rule, (counts.get(candidate.rule) ?? 0) + 1);

    return { text: pieces.join(''), counts };
  };

  return { scan, redact };
}
