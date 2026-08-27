import {
  codePointLength,
  codePointLengthAtMost,
  denial,
  DENIALS_MAX,
  isCanonicalizable,
  VALUE_MAX_CODE_POINTS,
  type Denial,
  type DenialCode,
  type ParamValue,
  type ValidatedValues,
} from './denial.js';
import type { PreparedParam, PreparedRecipe } from './prepare.js';

/**
 * Стадия `validate`: недоверенный словарь параметров → проверенные значения либо непустой
 * список отказов. Резолва путей здесь нет — он стадия спустя.
 *
 * Ни одна ветка не кладёт `value` в `reason` (R25). Текст называет имя, тип и нарушенное
 * ограничение: паттерн, список `values`, границы.
 */

export type ValidateParamsResult =
  | { ok: true; values: ValidatedValues }
  | { ok: false; denials: readonly [Denial, ...Denial[]] };

/** Исход проверки одного значения. Отказ несёт код и текст, но не само значение. */
type Check = { ok: true; value: ParamValue } | { ok: false; code: DenialCode; reason: string };

const fail = (code: DenialCode, reason: string): Check => ({ ok: false, code, reason });

/**
 * Гейты, общие для всех строковых типов. Стоят **внутри** функции своего типа, после её
 * проверки `typeof` и до её ограничений (R28, источник 1; R30).
 *
 * Порядок несущий, и обоснование здесь замерено, а не выведено. Первой идёт длина, потому что
 * она умеет ответить, НЕ ПРОЙДЯ по строке: `codePointLengthAtMost` смотрит не более
 * `2 * (MAX + 1)` единиц UTF-16 независимо от размера входа. Прежняя формулировка этого
 * комментария утверждала обратное — что дорогая проверка тут канонизируемость, — и была
 * неверна: `isCanonicalizable` идёт по строке одним `charCodeAt` без аллокаций, а `[...value]`,
 * которым длина считалась, разворачивал недоверенную строку в массив и на ста мегабайтах
 * ронял процесс фатальным OOM раньше, чем потолок успевал отказать.
 *
 * Обе — раньше `pattern`, и это закрытие Ф12: `^.{0,64}$` законный паттерн, пропускающий
 * одиночный суррогат, и вердикт не должен зависеть от того, насколько строг автор манифеста.
 */
function checkStringGates(value: string): Check | null {
  if (!codePointLengthAtMost(value, VALUE_MAX_CODE_POINTS)) {
    return fail('value-oversized', `строка длиннее потолка в ${VALUE_MAX_CODE_POINTS} кодовых точек`);
  }
  if (!isCanonicalizable(value)) {
    return fail('not-canonicalizable', 'строка содержит одиночный суррогат и не переживёт запись события');
  }
  return null;
}

function checkString(param: Extract<PreparedParam, { kind: 'string' }>, value: unknown): Check {
  if (typeof value !== 'string') return fail('wrong-type', 'ожидалась строка (type: string)');

  const gate = checkStringGates(value);
  if (gate !== null) return gate;

  // Счёт по кодовым точкам, а не по `length`: для эмодзи это 3 против 4 (Ф11), и потолок,
  // заданный автором манифеста в символах, при подсчёте по `length` был бы вдвое строже.
  if (param.maxLength !== null && codePointLength(value) > param.maxLength) {
    return fail('too-long', `длиннее maxLength: ${param.maxLength} кодовых точек`);
  }
  // `matcher.test` ПОСЛЕДНИМ: паттерн автора манифеста не решает судьбу отравленного значения.
  if (!param.matcher.test(value)) return fail('pattern-mismatch', 'значение не соответствует объявленному паттерну параметра');

  return { ok: true, value };
}

function checkEnum(param: Extract<PreparedParam, { kind: 'enum' }>, value: unknown): Check {
  if (typeof value !== 'string') return fail('wrong-type', 'ожидалась строка (type: enum)');

  const gate = checkStringGates(value);
  if (gate !== null) return gate;

  // Сравнение точное: значения `enum` едут в контекст модели и обязаны вернуться байт в байт.
  if (!param.values.includes(value)) return fail('not-in-enum', `значение вне списка values: ${param.values.join(', ')}`);

  return { ok: true, value };
}

function checkNumber(param: Extract<PreparedParam, { kind: 'number' }>, value: unknown): Check {
  if (typeof value !== 'number') return fail('wrong-type', 'ожидалось число (type: number)');
  // JSON выражает `1e400`, и `JSON.parse` даёт `Infinity`: это отказ, а не «большое число».
  if (!Number.isFinite(value)) return fail('not-finite', 'число не конечно');

  if (param.min !== null && value < param.min) return fail('out-of-range', `ниже min: ${param.min}`);
  if (param.max !== null && value > param.max) return fail('out-of-range', `выше max: ${param.max}`);
  if (param.integer && !Number.isInteger(value)) return fail('not-integer', 'объявлено integer: true');

  return { ok: true, value };
}

function checkBoolean(value: unknown): Check {
  // Строка `"true"` не принимается: приведения типов здесь нет вовсе.
  if (typeof value !== 'boolean') return fail('wrong-type', 'ожидалось true или false (type: boolean)');
  return { ok: true, value };
}

function checkPath(value: unknown): Check {
  if (typeof value !== 'string') return fail('wrong-type', 'ожидалась строка (type: path)');

  // Оба гейта здесь наиболее нужны, а не наименее: `PathParam` не имеет НИ `pattern`, НИ
  // `maxLength` — это и есть весь мотив R30. Пропустив их, мы оставили бы без потолка ровно
  // тот тип, ради которого потолок вводился, и путь в мегабайт доехал бы до `realpath`.
  const gate = checkStringGates(value);
  if (gate !== null) return gate;

  // Резолва здесь нет — значение уходит на стадию `resolve_paths`.
  return { ok: true, value };
}

/** Одна диспетчеризация по `kind`. Второго ветвления по типу нет: два места, отвечающие за `wrong-type`, разъезжаются молча. */
function checkValue(param: PreparedParam, value: unknown): Check {
  switch (param.kind) {
    case 'string':
      return checkString(param, value);
    case 'enum':
      return checkEnum(param, value);
    case 'number':
      return checkNumber(param, value);
    case 'boolean':
      return checkBoolean(value);
    case 'path':
      return checkPath(value);
  }
}

export function validateParams(prepared: PreparedRecipe, params: Readonly<Record<string, unknown>>): ValidateParamsResult {
  // Гейт формы контейнера, до всего остального (R29). Замерено: `Object.keys(null)` бросает
  // `TypeError` (Ф13), а крэш на границе доверия — это отказ без следа в аудите.
  // `IpcRequest.params` — тип, а не рантайм-гарантия: по сокету приходит произвольный JSON.
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return {
      ok: false,
      denials: [
        denial({ stage: 'validate', code: 'bad-params-container', paramName: null, reason: 'params не является объектом' }),
      ],
    };
  }

  const denials: Denial[] = [];
  const declared = new Set(prepared.params.map((one) => one.name));
  const values = new Map<string, ParamValue>();

  // Отказы по ОБЪЯВЛЕННЫМ параметрам собираются ПЕРВЫМИ, и это не стиль. Их число ограничено
  // манифестом, а число неизвестных ключей — нет: собирая неизвестные первыми, мы отдавали бы
  // атакующему, полностью контролирующему сокет (И6), право вытеснить из усечённого списка
  // единственный отказ, называющий параметр с полезной нагрузкой. Вердикт «отвергнут» от
  // порядка не зависел бы, а предмет разбора — исчезал.
  for (const param of prepared.params) {
    // `Object.hasOwn`, а не `params[name] !== undefined`: иначе `constructor` из запроса
    // читался бы с прототипа (R6). Схема запрещает `__proto__` в именах МАНИФЕСТА, но не в
    // ключах ЗАПРОСА.
    if (!Object.hasOwn(params, param.name)) {
      if (param.required) {
        denials.push(
          denial({ stage: 'validate', code: 'missing-required', paramName: param.name, reason: 'обязательный параметр не передан' }),
        );
      }
      // Необязательный и не переданный — пропуск без значения и без элементов argv (R7).
      continue;
    }

    const checked = checkValue(param, params[param.name]);
    if (checked.ok) {
      values.set(param.name, checked.value);
      continue;
    }
    denials.push(denial({ stage: 'validate', code: checked.code, paramName: param.name, reason: checked.reason }));
  }

  // Отсортировано по имени: иначе порядок списка задаёт атакующий порядком ключей в своём
  // JSON, а этот порядок доезжает до `denyReason` и внутрь `chain.self`.
  const unknown = Object.keys(params)
    .filter((key) => !declared.has(key))
    .sort();

  // Цикл обрывается на потолке, а не срезается после (R30а). Потолок, ограничивающий вывод,
  // но не работу, — не потолок: замерено, что двадцать тысяч неизвестных ключей давали 313 мс
  // построения отказов, каждый через две зачистки, ради тридцати двух строк на выходе. Это
  // шестикратное превышение оверхед-бюджета ≤50 мс p95 на стадии, которая всё равно откажет.
  let shown = 0;
  for (const key of unknown) {
    if (denials.length >= DENIALS_MAX) break;
    denials.push(
      denial({ stage: 'validate', code: 'unknown-param', paramName: key, reason: 'ключ не объявлен в рецепте' }),
    );
    shown += 1;
  }
  const omitted = unknown.length - shown;

  if (denials.length === 0) {
    // Двойной каст: одинарный отвергается как недостаточно перекрывающийся. Чеканка бренда
    // происходит ровно здесь и на выходе `resolvePaths` — оба места названы, чтобы касты не
    // расплодились.
    return { ok: true, values: values as unknown as ValidatedValues };
  }

  // Маркер усечения (R30а). Код собственный, а не переиспользованный `unknown-param`: иначе
  // двусторонняя перепись не смогла бы отличить «усечение произошло» от «был один неизвестный
  // ключ», и потолок стал бы непроверяемым. В причине — не только общее число, но и то, что
  // именно съедено: по одному числу нельзя отличить «сто тысяч мусорных ключей» от «сто тысяч
  // мусорных плюс один настоящий отказ».
  if (omitted > 0) {
    denials.push(
      denial({
        stage: 'validate',
        code: 'denials-truncated',
        paramName: null,
        reason: `список отказов усечён: всего ${denials.length + omitted}, показаны первые ${denials.length}, не показаны ещё ${omitted} с кодом unknown-param`,
      }),
    );
  }

  return { ok: false, denials: denials as [Denial, ...Denial[]] };
}
