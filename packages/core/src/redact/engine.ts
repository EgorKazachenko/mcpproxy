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
  /** `rule → сколько раз сработало`. Порядок вставки — порядок первого срабатывания. */
  readonly counts: ReadonlyMap<string, number>;
}

export interface Redactor {
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
  /** Позиция в наборе. Разрешает ничью по длине (R13) детерминированно. */
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

  const scan = (text: string, options: ScanOptions): readonly SecretMatch[] => {
    const candidates: (SecretMatch & { order: number })[] = [];

    for (const rule of compiled) {
      // Замер: `exec` с флагом `g` сам обнуляет `lastIndex`, когда возвращает `null`, поэтому
      // после ПОЛНОГО обхода он и так 0 — мутационная проверка это подтвердила, убрав строку
      // без единого красного теста. Строка остаётся страховкой на будущее: досрочный выход из
      // цикла (например «хватит первых N совпадений» ради скорости) оставит `lastIndex` в
      // середине — замер даёт 2 после одного `exec`, — и следующий скан начнётся оттуда,
      // молча пропустив секрет в начале текста. Цена страховки — одно присваивание на правило.
      rule.regexp.lastIndex = 0;
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
        // Энтропия идёт ПОСЛЕ всех именованных правил, поэтому при равной длине совпадения
        // выигрывает правило с именем: `ghp_…` в отчёте обязан называться `github-pat`, а не
        // `high-entropy-base64`. Владельцу лога первое говорит, какой ключ отзывать.
        candidates.push({ ...run, rule: ENTROPY_RULE_ID, order: compiled.length });
      }
    }

    return resolveOverlaps(candidates);
  };

  const redact = (text: string, options: ScanOptions): RedactedText => {
    const matches = scan(text, options);
    if (matches.length === 0) return { text, counts: new Map() };

    const counts = new Map<string, number>();
    const pieces: string[] = [];
    let cursor = 0;

    for (const match of matches) {
      pieces.push(text.slice(cursor, match.start), placeholder(match.rule));
      counts.set(match.rule, (counts.get(match.rule) ?? 0) + 1);
      cursor = match.end;
    }
    pieces.push(text.slice(cursor));

    return { text: pieces.join(''), counts };
  };

  return { scan, redact };
}

/**
 * Разрешение пересечений (R13): выигрывает более длинное совпадение, при равной длине —
 * правило, идущее в наборе раньше.
 *
 * Отбор ЖАДНЫЙ по длине, а не слева направо. Разница видна на паре
 * `A = [10,20)`, `B = [5,40)`: обход слева направо взял бы `A` и выкинул `B`, оставив
 * тридцать символов секрета в тексте, — то есть более длинное совпадение проиграло бы
 * более раннему, что прямо противоречит правилу.
 *
 * Возврат отсортирован по `start` и не пересекается: на этом стоит склейка в `redact`.
 */
function resolveOverlaps(candidates: readonly (SecretMatch & { order: number })[]): readonly SecretMatch[] {
  const ranked = [...candidates].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start || a.order - b.order,
  );

  const accepted: SecretMatch[] = [];
  for (const candidate of ranked) {
    if (accepted.some((taken) => candidate.start < taken.end && taken.start < candidate.end)) continue;
    accepted.push({ start: candidate.start, end: candidate.end, rule: candidate.rule });
  }

  return accepted.sort((a, b) => a.start - b.start);
}
