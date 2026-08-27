/**
 * Таблица «ветка схемы ↔ проверки, которых JSON Schema выразить не может» (R6).
 *
 * Ветка без проверок помечена **пустым списком**, а не отсутствием строки: тест сверяет
 * множество ключей с множеством `$defs` схемы в обе стороны и падает, называя недостающую.
 * Поэтому новая ветка не может приехать в схему молча — она обязана либо получить проверку,
 * либо явно сказать, что не требует ни одной.
 */

export type CheckId =
  /** `root` абсолютен либо резолвится относительно манифеста и не выходит за его каталог. */
  | 'root-confinement'
  /** `exec[0]` без метасимволов оболочки и без выхода вверх по дереву. */
  | 'exec-shape'
  /** Элемент `argv` содержит слот `{}` не более одного раза. */
  | 'argv-slot-count'
  /** Ни один параметр не подставляется в `exec`, `cwd` или профиль песочницы. */
  | 'no-param-substitution'
  /** `pattern` компилируется движком RE2. */
  | 'pattern-re2'
  /** Рецептный `deny`, если ключ присутствует, обязан быть непустым. */
  | 'deny-non-empty'
  /** Рецептный `env.allow` — подмножество `defaults.env.allow`, а не произвольный список. */
  | 'env-allow-subset'
  /** Рецепт не снимает редакцию вывода и не поднимает потолок байт выше `defaults`. */
  | 'output-floor';

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
  // Формат длительности целиком выражается схемой.
  Duration: [],
  SafeText: [],
} as const;
