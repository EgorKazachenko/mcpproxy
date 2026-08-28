import { isAbsolute, relative, sep } from 'node:path';

export type Confinement = 'inside' | 'root-itself' | 'outside';

/**
 * Предикат confinement (R15). Строится на `path.relative`, а не на `startsWith`: голый
 * `startsWith` считает `/logs-evil/a` лежащим внутри `/logs` (Ф3).
 *
 * `rel === '..'` проверяется отдельно от `startsWith('..' + sep)` по той же причине, по
 * которой она стоит в `checkRootConfinement` (`packages/contracts/src/validate/refine.ts:223`):
 * каталог `..cache` даёт `relative` = `..cache`, и голый `startsWith('..')` объявил бы законный
 * подкаталог выходом за пределы. Обратная сторона той же клаузы — значение ровно `..`, то есть
 * родительский каталог корня без хвоста: без неё он проходит границу целиком.
 *
 * Живёт отдельным модулем, а не внутри `paths.ts`, с E4: тот же вопрос задаётся дважды и о
 * разных вещах — о резолвнутом значении параметра относительно его `root` (R13) и о рабочем
 * каталоге рецепта относительно каталога манифеста (R34 E4). Две копии одной границы
 * расходятся молча, и ровно это записано границей в спеке E2.
 */
export function confinementOf(root: string, candidate: string): Confinement {
  const rel = relative(root, candidate);
  if (rel === '') return 'root-itself';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'outside';
  return 'inside';
}
