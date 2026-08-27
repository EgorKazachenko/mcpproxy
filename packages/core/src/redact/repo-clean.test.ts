import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRedactor } from './engine.js';

/**
 * Детектор, который мы поставляем, применённый к репозиторию, который его поставляет.
 *
 * **Зачем.** GitGuardian на первом же PR этого эпика поднял восемь секретов. Все были
 * синтетическими фикстурами, но вывод из этого не «сканер шумит», а «красная проверка на
 * каждом пуше становится шумом, за которым настоящая утечка проедет незамеченной». Фикстуры
 * переведены на сборку из частей (`secret-samples.ts`); этот тест не даёт им вернуться.
 *
 * **Почему не путь в игноре сканера.** Шаблон вида «все файлы `.test.ts`» в списке исключений
 * ослепляет проверку на тестах — типовом месте, куда настоящий ключ попадает по недосмотру.
 * Проект, чей тезис в том, что защита обязана быть структурной, не имеет права лечить свой
 * красный сканер его отключением.
 *
 * **Граница.** Тест ловит то, что ловят НАШИ правила: именованные форматы. Энтропия здесь
 * выключена сознательно — в репозитории полно легитимных высокоэнтропийных строк (хэши в
 * снапшотах, base64 в фикстурах кодировок), и на них он краснел бы постоянно, то есть стал бы
 * тем самым шумом. То, что у секрета нет характерного формата, этот страж не заметит.
 */

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** Файлы, которые сканируются: всё, что под контролем версий. `dist/` не отслеживается. */
function trackedFiles(): string[] {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' });
  return output.split('\0').filter((one) => one !== '');
}

describe('репозиторий не содержит строк формы креденшла', () => {
  it('список отслеживаемых файлов получен — иначе проверка зелена на пустоте', () => {
    expect(trackedFiles().length).toBeGreaterThan(20);
  });

  it('ни один отслеживаемый файл не совпадает с правилами набора', () => {
    const redactor = createRedactor();
    const found: string[] = [];

    for (const file of trackedFiles()) {
      let text: string;
      try {
        text = readFileSync(resolve(repoRoot, file), 'utf8');
      } catch {
        continue; // бинарный файл или симлинк — сканировать нечего
      }
      for (const hit of redactor.scan(text, { entropy: false })) {
        const line = text.slice(0, hit.start).split('\n').length;
        found.push(`${file}:${line} [${hit.rule}]`);
      }
    }

    expect(found).toEqual([]);
  });

  it('и сам страж способен покраснеть — иначе он декорация', () => {
    // Положительный контроль: тот же скан по строке, которая ДОЛЖНА совпасть. Без него
    // «ничего не найдено» неотличимо от «сканирование не работает».
    const redactor = createRedactor();
    const bait = `ghp_${'A1b2C3d4E5'.repeat(3)}A1b2C3'`;
    expect(redactor.scan(bait, { entropy: false }).map((one) => one.rule)).toEqual(['github-pat']);
  });
});
