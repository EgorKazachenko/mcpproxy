import RE2 from 're2';
import type { PatternMatcher } from '../types.js';

export type CompiledPattern = { ok: true; matcher: PatternMatcher } | { ok: false; reason: string };

/**
 * Компиляция паттерна манифеста через RE2.
 *
 * Замер (Ф1) показал, что ограничение длины входа катастрофический бэктрекинг не лечит:
 * `(a+)+$` на 30 символах — 4.5 с, на 64 — геологическое время. RE2 не бэктрекит вовсе:
 * тот же паттерн на 64 символах — 0.009 мс. Цена — урезанный синтаксис: lookahead и
 * обратные ссылки не компилируются, и это часть контракта (D3), а не дефект.
 *
 * Наружу отдаётся обёртка, а не сам экземпляр RE2: у него есть `source`, `flags` и
 * `lastIndex`, то есть достаточно, чтобы потребитель собрал `new RegExp(source)` и вернул
 * ровно тот вектор, который здесь закрыт.
 */
/**
 * Тот же движок отдаётся ajv через `code.regExp`.
 *
 * Причина — **не** «чтобы схемы E2 были безопасны»: E2 компилирует свои схемы своим
 * экземпляром Ajv, и выставленная здесь опция туда не долетает. Причин ровно две: паритет
 * движков, чтобы паттерн, принятый компиляцией выше, не был иначе отвергнут валидатором, и
 * защита в глубину на случай, когда схема начнёт компилировать паттерн из манифеста.
 *
 * Цена записана в Ф10: с подключённым RE2 наша собственная схема тоже не может использовать
 * lookahead. Поэтому `SafeText` ограничен категориями `\p{Cc}\p{Cf}`, а не отрицательным
 * просмотром вперёд.
 *
 * Свойство `code` требуется типом ajv для standalone-кодогенерации; мы её не используем.
 */
export const RE2_ENGINE = Object.assign((pattern: string, flags: string) => new RE2(pattern, flags), {
  code: 'new (require("re2"))',
});

export function compilePattern(pattern: string): CompiledPattern {
  let re: RE2;
  try {
    re = new RE2(pattern, 'u');
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, matcher: { test: (value: string) => re.test(value) } };
}
