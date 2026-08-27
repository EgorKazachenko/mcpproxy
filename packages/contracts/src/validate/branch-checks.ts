/**
 * Таблица «ветка схемы ↔ проверки, которых JSON Schema выразить не может» (R6).
 *
 * Ветка без проверок помечена **пустым списком**, а не отсутствием строки: тест сверяет
 * множество ключей с множеством `$defs` схемы в обе стороны и падает, называя недостающую.
 * Поэтому новая ветка не может приехать в схему молча — она обязана либо получить проверку,
 * либо явно сказать, что не требует ни одной.
 */

/**
 * Идентификаторы проверок — массивом, а не только юнионом.
 *
 * Юнион живёт лишь в типах, поэтому перепись R6 сверяла имена веток и не видела второй
 * половины: объявленная проверка могла нигде не применяться, и удаление её из таблицы не
 * роняло ничего. Массив делает перепись двусторонней и на уровне самих проверок.
 */
export const CHECK_IDS = [
  /** `root` абсолютен либо резолвится относительно манифеста и не выходит за его каталог. */
  'root-confinement',
  /** `exec[0]` без метасимволов оболочки и без выхода вверх по дереву. */
  'exec-shape',
  /** Элемент `argv` содержит слот `{}` не более одного раза. */
  'argv-slot-count',
  /** Ни один параметр не подставляется в `exec`, `cwd` или профиль песочницы. */
  'no-param-substitution',
  /** `pattern` компилируется движком RE2. */
  'pattern-re2',
  /** Рецептный `deny`, если ключ присутствует, обязан быть непустым. */
  'deny-non-empty',
  /** Рецептный `env.allow` — подмножество `defaults.env.allow`, а не произвольный список. */
  'env-allow-subset',
  /** Рецепт не снимает редакцию вывода и не поднимает потолок байт выше `defaults`. */
  'output-floor',
  /** Значение длительности не превышает максимум таймера платформы. */
  'duration-executable',
] as const;

export type CheckId = (typeof CHECK_IDS)[number];

export type BranchName =
  | 'Defaults'
  | 'Recipe'
  | 'Param'
  | 'StringParam'
  | 'EnumParam'
  | 'NumberParam'
  | 'BooleanParam'
  | 'PathParam'
  | 'ArgvTemplate'
  | 'Annotations'
  | 'SandboxProfile'
  | 'AccessRule'
  | 'EnvPolicy'
  | 'OutputPolicy'
  | 'Duration'
  | 'SafeText';

export const branchChecks: Readonly<Record<BranchName, readonly CheckId[]>> = {
  Defaults: [],
  Recipe: ['exec-shape', 'no-param-substitution'],
  // Обёртка союза: собственных данных не несёт, проверки живут на ветках.
  Param: [],
  StringParam: ['pattern-re2'],
  EnumParam: [],
  NumberParam: [],
  BooleanParam: [],
  PathParam: ['root-confinement'],
  ArgvTemplate: ['argv-slot-count'],
  Annotations: [],
  SandboxProfile: ['no-param-substitution'],
  // Правило про пустой `deny` — на носителе данных, а не на рецепте: так оно не разъедется
  // с таблицей слияния, которая тоже говорит про этот узел.
  AccessRule: ['deny-non-empty'],
  // Потолок, а не дефолт: слияние заменой по листу иначе позволило бы рецепту ввести
  // переменную, которой в `defaults` нет. Проверка на носителе, как и `deny-non-empty`.
  EnvPolicy: ['env-allow-subset'],
  // Пол, симметрично потолку `env`: замена скаляров иначе позволила бы рецепту выключить
  // редакцию вывода и поднять потолок байт. Сузить — можно, ослабить — нет.
  OutputPolicy: ['output-floor'],
  // Формат — да, целиком; значение — нет. `999999999h` проходит паттерн и даёт 3.6·10¹⁵ мс,
  // а выше максимума таймера платформы Node клампит таймаут к 1 мс.
  Duration: ['duration-executable'],
  SafeText: [],
} as const;
