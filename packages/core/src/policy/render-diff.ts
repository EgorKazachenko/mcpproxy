import type { NormalizedDefaults, NormalizedRecipe } from '@mcpproxy/contracts';
import type { LockApprovalRequest } from './approve.js';

/**
 * Рендер того, что показывают человеку перед записью lock.
 *
 * Рендер делает невидимое **видимым**, а не вырезает молча (R19). `snapshot.own` хранит все
 * строки дословно, и человек, которого позвали читать дифф, обязан увидеть ровно то, что
 * увидит модель. Молчаливая зачистка уничтожила бы улику, ради которой его и позвали, — ровно
 * поэтому Trail of Bits в этом месте рисует литеральный ESC, а не удаляет его.
 *
 * Свойство формулируется **независимо от санитайзера и по всему диффу**: каждый кодпойнт
 * `\p{Cc}` и `\p{Cf}` в любой строке рендера переживает его в видимой форме. Формулировка
 * «показываем всё, что вырезает `sanitizeDescription`» пропустила бы `\r \n \t \v \f` — их
 * санитайзер заменяет пробелом раньше прохода по невидимым, — а привязка к `description`
 * пропустила бы `exec[]`, `cwd`, `params[].description`, `env.allow[]` и строки песочницы,
 * которые лежат в `own` такими же сырыми. Перевод строки в `exec[0]` подделывает структуру
 * диффа в терминале ровно так же, как bidi-override подделывает описание.
 *
 * Дифф показывается целиком, без усечения. Ограничение длины мерой против инъекции здесь не
 * является и таковой не объявляется (R20): санитизация уменьшает описание, а не делает его
 * безопасным.
 */

const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

/** `U+202E` в тексте становится семью печатными символами `<U+202E>`. */
export function renderVisible(raw: string): string {
  return raw.replace(INVISIBLE, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}

/**
 * Тот же проход по дереву значения — и по строкам, и по ключам.
 *
 * Применяется **до** `JSON.stringify`, а не после: печать экранирует управляющие символы
 * своей нотацией, а bidi и zero-width оставляет сырыми, — то есть в одном тексте оказалось бы
 * два разных представления невидимого, и одно из них по-прежнему невидимое.
 */
function visibleDeep(value: unknown): unknown {
  if (typeof value === 'string') return renderVisible(value);
  if (Array.isArray(value)) return value.map(visibleDeep);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [renderVisible(key), visibleDeep(nested)]));
  }
  return value;
}

const show = (value: NormalizedRecipe | NormalizedDefaults): string => JSON.stringify(visibleDeep(value), null, 2);

const names = (values: readonly string[]): string => values.map((one) => renderVisible(one)).join(', ');

function renderDrift(request: Extract<LockApprovalRequest, { kind: 'drift' }>): string[] {
  const lines: string[] = [];
  const { diff, mismatched, digest } = request;
  const empty = diff.defaults === null && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;

  if (empty) {
    // Показать здесь пустой дифф значило бы сказать человеку «что-то изменилось, показать
    // нечего» на самом враждебном из путей (R19a). Путей два, и текст у них разный.
    if (mismatched.length > 0) {
      lines.push('lock подделан: записи противоречат собственным дайджестам.');
      lines.push(`Расходятся: ${names(mismatched)}`);
      lines.push('Снимок в lock совпадает с манифестом, поэтому дифф пуст, — но записанный дайджест ему противоречит.');
    } else if (digest !== null) {
      lines.push('lock пересчитан целиком под изменённый манифест, а дайджест манифеста оставлен прежним.');
      lines.push(`Дайджест манифеста был ${renderVisible(digest.was)}, стал ${renderVisible(digest.is)}.`);
    } else {
      lines.push('lock разошёлся с манифестом, но ни один слот диффа не заполнен. Это состояние не должно возникать.');
    }
    return lines;
  }

  lines.push('Манифест разошёлся с одобренным lock.');
  if (digest !== null) {
    lines.push(`Дайджест манифеста был ${renderVisible(digest.was)}, стал ${renderVisible(digest.is)}.`);
  }
  if (diff.defaults !== null) {
    lines.push('', 'Изменены умолчания.', 'было:', show(diff.defaults.was), 'стало:', show(diff.defaults.is));
  }
  if (diff.added.length > 0) lines.push('', `Добавлены рецепты: ${names(diff.added)}`);
  if (diff.removed.length > 0) lines.push('', `Удалены рецепты: ${names(diff.removed)}`);
  for (const one of diff.changed) {
    lines.push('', `Изменён рецепт ${renderVisible(one.name)}.`, 'было:', show(one.was), 'стало:', show(one.is));
  }
  return lines;
}

/** Полный текст запроса. Возвращается строкой: печатать её — дело вызывающего. */
export function renderRequest(request: LockApprovalRequest): string {
  const lines: string[] = [];

  switch (request.kind) {
    case 'first':
      lines.push('mcpproxy.lock отсутствует: одобрение выдаётся впервые.');
      lines.push('', 'Одобрение получат рецепты:');
      for (const name of request.recipes) lines.push(`  - ${renderVisible(name)}`);
      break;

    case 'unusable':
      lines.push(
        request.reason === 'unreadable'
          ? 'Прежнее одобрение непригодно: mcpproxy.lock не читается.'
          : 'Прежнее одобрение непригодно: mcpproxy.lock не разобран — он испорчен или старой версии.',
      );
      lines.push('', 'Почему:');
      for (const one of request.diagnostics) {
        const pointer = one.pointer === '' ? '(документ)' : renderVisible(one.pointer);
        lines.push(`  - ${pointer}: ${renderVisible(one.message)}`);
      }
      break;

    case 'drift':
      lines.push(...renderDrift(request));
      break;
  }

  lines.push('', `Дайджест манифеста: ${renderVisible(request.manifestHash)}`);
  return lines.join('\n');
}
