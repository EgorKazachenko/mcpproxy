/**
 * Валидатор доменных шаблонов. **Не матчер.**
 *
 * Матчит домены сам srt (`matchesDomainPatternWithPort`), потому что по D11 принуждение
 * делает `updateConfig`. Второй матчер с другой семантикой на пути принуждения был бы дырой,
 * а не запасом: расхождение между «что мы считаем разрешённым» и «что пропустит прокси»
 * невидимо в тестах и наблюдаемо только атакующим.
 *
 * Поэтому модуль делает ровно две вещи, и обе — вокруг вендорского матчера, а не вместо
 * него: проверяет шаблоны манифеста (R13) и решает, носит ли рецепт бейдж «ослабленный»
 * (R14). Согласие нашего понимания с вендорским закрепляет таблица конформанса в
 * `netpolicy.test.ts`, где каждая строка вызывает настоящую вендорскую функцию.
 *
 * Модуль чистый: ни ФС, ни процессов, ни сети, ни импорта вендора в рантайме.
 */

import { ExecError } from './errors.js';

/** Управляющие и форматирующие символы: домен с ними — не домен, а попытка. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\s]/u;

/**
 * Разделение необязательного суффикса `:port`, по правилу вендора
 * (`domain-pattern.d.ts` `splitDomainPatternPort`): портом считается только строго
 * числовой суффикс 1–65535 без ведущих нулей, поэтому подсунутый хвост вида
 * `evil.com:443.allowed.com` остаётся целым и проваливается на проверке хоста.
 */
export function splitPort(pattern: string): { host: string; port: number | undefined } {
  if (pattern.startsWith('[')) {
    const close = pattern.indexOf(']');
    if (close === -1) return { host: pattern, port: undefined };
    const host = pattern.slice(1, close);
    const rest = pattern.slice(close + 1);
    if (rest === '') return { host, port: undefined };
    if (!rest.startsWith(':')) return { host: pattern, port: undefined };
    const port = parsePort(rest.slice(1));
    return port === undefined ? { host: pattern, port: undefined } : { host, port };
  }
  const first = pattern.indexOf(':');
  if (first === -1) return { host: pattern, port: undefined };
  // Два и больше двоеточий без скобок — неоднозначный IPv6 (`::1:443` сам по себе адрес).
  // Вендор такую запись отвергает; мы возвращаем её целиком, и проверка хоста её отобьёт.
  if (pattern.indexOf(':', first + 1) !== -1) return { host: pattern, port: undefined };
  const port = parsePort(pattern.slice(first + 1));
  return port === undefined ? { host: pattern, port: undefined } : { host: pattern.slice(0, first), port };
}

function parsePort(text: string): number | undefined {
  if (!/^[1-9][0-9]{0,4}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= 1 && value <= 65535 ? value : undefined;
}

/**
 * Наша проверка шаблона. Шире вендорской намеренно: голая `*` и `*.com` для нас
 * **валидны**, но носят бейдж «ослабленный» (R14). Вендор их отвергает, и это расхождение —
 * не дефект, а разделение ролей: он решает, что безопасно по умолчанию, мы решаем, что
 * автор рецепта имел право написать, показав человеку цену.
 *
 * Отвергается то, что доменом не является ни при каком чтении: схема, путь, пробел,
 * управляющий символ, пустая строка, неоднозначный IPv6 без скобок.
 */
export function isValidDomainPattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > 253) return false;
  if (CONTROL_OR_FORMAT.test(pattern)) return false;
  if (pattern.includes('://') || pattern.includes('/') || pattern.includes('@')) return false;

  const { host, port } = splitPort(pattern);
  // `splitPort` вернул шаблон целиком — значит суффикс портом не был. Оставшееся двоеточие
  // в незаскобленном хосте означает либо неоднозначный IPv6, либо мусор.
  if (port === undefined && host === pattern && pattern.includes(':') && !pattern.startsWith('[')) return false;
  return isValidHostPattern(host);
}

function isValidHostPattern(host: string): boolean {
  if (host.length === 0) return false;
  if (host === '*') return true;
  if (host === 'localhost') return true;
  // Заскобленный литерал уже развёрнут `splitPort`; допускаем hex-двоеточия IPv6.
  if (/^[0-9a-fA-F:.]+$/.test(host) && host.includes(':')) return true;
  // Порог у ветки со звёздочкой на метку ниже: `*.com` для нас валиден и лишь ослаблен
  // (R14), тогда как голый `com` — не домен, а обрубок, и его не спасает ничто.
  if (host.startsWith('*.')) return isValidLabels(host.slice(2), 1);
  if (host.includes('*')) return false;
  return isValidLabels(host, 2);
}

/**
 * Метка домена: непустая, без дефиса по краям и без символов, которые доменом не бывают.
 *
 * ASCII-only здесь было **дефектом контракта**, а не строгостью. Схема манифеста объявляет
 * `network.allow` как `{"type": "array", "items": {"type": "string"}}` — никакого формата, —
 * и загрузчик доменный синтаксис не проверяет вовсе. Значит рецепт с `["пример.рф"]`
 * сегодня грузится, хэшируется и **попадает в одобренный человеком `mcpproxy.lock`**, а
 * дальше умирал бы на перепроверке перед принуждением — то есть отказ наступал бы после
 * согласия, а не до него.
 *
 * Хуже: вендор такие домены **принимает** (проверено на `NetworkConfigSchema`:
 * `пример.рф` и `münchen.de` проходят), то есть мы были строже него — при том что докстринг
 * `isValidDomainPattern` обещает обратное. Отвергаем теперь только то, что доменом не
 * является ни при каком чтении.
 *
 * Валидация доменного синтаксиса на **загрузке** — правильное место для этой проверки, но
 * оно в `packages/contracts/src/validate/refine.ts`, а contracts в этом эпике не трогается
 * (граница объявлена в `spec.md`). Остаток записан в границах как долг E1.
 */
function isValidLabels(domain: string, minLabels: number): boolean {
  if (domain.length === 0) return false;
  const labels = domain.split('.');
  if (labels.length < minLabels) return false;
  return labels.every((label) => label.length > 0 && !label.startsWith('-') && !label.endsWith('-'));
}

/**
 * Зеркало вендорского `isValidDomainPattern` из `sandbox-config.js:20-46` — то, что схема
 * вендора принимает в `allowedDomains`.
 *
 * Копия, а не импорт: функция не экспортирована наружу пакета вовсе, а вход `./validate`
 * этого модуля обязан оставаться чистым. Расхождение копии с оригиналом краснеет в
 * `netpolicy.test.ts`, где утверждения гоняют настоящую `NetworkConfigSchema`.
 */
export function isVendorAcceptableAllow(pattern: string): boolean {
  const first = pattern.indexOf(':');
  const multiColon = first !== -1 && pattern.indexOf(':', first + 1) !== -1;
  if (multiColon && !pattern.startsWith('[')) return false;
  const { host } = splitPort(pattern);
  if (host.includes('://') || host.includes('/') || host.includes(':')) return false;
  if (host === 'localhost') return true;
  if (host.startsWith('*.')) {
    const domain = host.slice(2);
    if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
    const parts = domain.split('.');
    return parts.length >= 2 && parts.every((part) => part.length > 0);
  }
  if (host.includes('*')) return false;
  return host.includes('.') && !host.startsWith('.') && !host.endsWith('.');
}

/**
 * Бейдж «ослабленный» (R14) — на **голой** звёздочке, а не на любой.
 *
 * `*.github.com` и `*.npmjs.org` — обычные рабочие правила; пометив их, бейдж перестаёт
 * что-либо значить на слайде S5, а бейдж, который носят все, не носит никто.
 *
 * Вторая половина — всё, что вендорская схема считает слишком широким (`*.com`): это мы
 * принимаем, а он отвергает, и разницу обязан видеть человек, а не только тест.
 */
export function isWeakened(allow: readonly string[]): boolean {
  return allow.some((pattern) => pattern === '*' || !isVendorAcceptableAllow(pattern));
}

/**
 * Перепроверка перед принуждением (R13). Между загрузкой манифеста (E1) и `updateConfig`
 * нет ни одной проверки — `updateConfig` не валидирует **ничего**, это голый
 * `structuredClone`, — а «доверяем предвалидированному входу» в продукте про безопасность
 * не аргумент. Падаем закрыто: список, который нельзя разобрать, не превращается в пустой.
 */
export function assertDomainPatterns(allow: readonly string[], deny: readonly string[]): void {
  for (const pattern of allow) {
    if (!isValidDomainPattern(pattern)) {
      throw new ExecError('invalid-domain', `не доменный шаблон в network.allow: ${JSON.stringify(pattern)}`);
    }
  }
  for (const pattern of deny) {
    if (!isValidDomainPattern(pattern)) {
      throw new ExecError('invalid-domain', `не доменный шаблон в network.deny: ${JSON.stringify(pattern)}`);
    }
  }
}
