import RE2 from 're2';
import { describe, expect, it } from 'vitest';
import { SECRET_RULES } from './rules.js';

/**
 * R5 и R6 — исполняемые, а не декларативные.
 *
 * Секреты в фикстурах ниже синтетические: форма настоящая, значение выдумано. Настоящий
 * ключ в тестовом файле — это тот же A12 через git-историю.
 */

describe('набор правил', () => {
  it('непустой — иначе всё остальное здесь зелено на пустоте', () => {
    expect(SECRET_RULES.length).toBeGreaterThan(15);
  });

  it('R5: у каждого правила есть провенанс', () => {
    const orphans = SECRET_RULES.filter((rule) => rule.source.trim() === '').map((rule) => rule.id);
    expect(orphans).toEqual([]);
  });

  it('R5: провенанс ссылается на признанный набор, а не на слова', () => {
    // Иначе поле заполняется строкой «наше правило» и перестаёт что-либо значить.
    const bad = SECRET_RULES.filter((rule) => !/^(?:gitleaks|Secrets-Patterns-DB):/.test(rule.source));
    expect(bad.map((rule) => `${rule.id} → ${rule.source}`)).toEqual([]);
  });

  it('идентификаторы уникальны — они уезжают в Redaction.rule и в плейсхолдер', () => {
    const ids = SECRET_RULES.map((rule) => rule.id);
    expect([...new Set(ids)]).toHaveLength(ids.length);
  });

  it('идентификатор не содержит `]` — иначе плейсхолдер [redacted:<id>] не разобрать глазом', () => {
    expect(SECRET_RULES.filter((rule) => /[\]\s]/.test(rule.id)).map((r) => r.id)).toEqual([]);
  });

  it('R6: каждый паттерн компилируется движком RE2', () => {
    const broken: string[] = [];
    for (const rule of SECRET_RULES) {
      try {
        new RE2(rule.pattern, 'g');
      } catch (error) {
        broken.push(`${rule.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('R6: ни один паттерн не использует lookahead или обратную ссылку', () => {
    // RE2 их не компилирует, и предыдущий тест это поймал бы. Этот — про диагностику:
    // при обновлении набора из gitleaks видно ИМЕННО причину, а не «Bad pattern».
    const unsupported = SECRET_RULES.filter((rule) => /\(\?[=!<]/.test(rule.pattern) || /\\[1-9]/.test(rule.pattern));
    expect(unsupported.map((rule) => rule.id)).toEqual([]);
  });
});

/**
 * Каждое правило обязано ловить свою форму. Без этого набор — двадцать две строки,
 * компилирующиеся и не совпадающие ни с чем: все тесты выше остались бы зелёными.
 */
describe('правила ловят свою форму', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['private-key-pem', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['aws-access-key-id', 'AKIAIOSFODNN7EXAMPLE'],
    ['aws-secret-access-key', 'aws_secret_access_key = wJalrXUtnFEMIfK7MDENGfbPxRfiCYEXAMPLEKEYx'],
    ['github-pat', 'ghp_016ABCdefGHIjklMNOpqrSTUvwxYZ0123456'],
    ['github-oauth-token', 'gho_016ABCdefGHIjklMNOpqrSTUvwxYZ0123456'],
    ['github-app-token', 'ghs_016ABCdefGHIjklMNOpqrSTUvwxYZ0123456'],
    ['github-refresh-token', 'ghr_016ABCdefGHIjklMNOpqrSTUvwxYZ0123456'],
    ['github-fine-grained-pat', `github_pat_${'A1b2C3d4E5'.repeat(8)}ab`],
    ['gitlab-pat', 'glpat-ABCdefGHIjklMNOpqrST'],
    ['slack-bot-token', 'xoxb-1234567890123-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx'],
    ['slack-webhook-url', `https://hooks.slack.com/services/${'A1b2C3d4E5'.repeat(4)}`],
    ['stripe-secret-key', 'sk_live_ABCdefGHIjklMNOpqrSTUvwx'],
    ['anthropic-api-key', `sk-ant-api03-${'A1b2C3d4E5'.repeat(9)}AA`],
    ['openai-api-key', 'sk-proj-ABCdefGHIjklMNOpqrSTUvwxYZ0123456789'],
    ['google-api-key', 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
    ['npm-access-token', 'npm_016ABCdefGHIjklMNOpqrSTUvwxYZ0123456'],
    ['pypi-upload-token', `pypi-AgEIcHlwaS5vcmc${'A1b2C3d4E5'.repeat(6)}`],
    ['sendgrid-api-key', `SG.${'A1b2C3d4E5'.repeat(2)}ab.${'A1b2C3d4E5'.repeat(4)}abc`],
    ['twilio-api-key', 'SK0123456789abcdef0123456789abcdef'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g'],
    ['db-connection-uri', 'postgresql://svc:hunter2secret@db.internal:5432/app'],
    ['basic-auth-url', 'https://deploy:hunter2secret@registry.internal/'],
  ];

  it('покрыты все правила набора — иначе новое правило приезжает непроверенным', () => {
    expect([...cases.map(([id]) => id)].sort()).toEqual([...SECRET_RULES.map((rule) => rule.id)].sort());
  });

  it.each(cases)('%s ловит свою форму', (id, sample) => {
    const rule = SECRET_RULES.find((one) => one.id === id);
    expect(rule, `правила ${id} нет в наборе`).toBeDefined();
    expect(new RE2(rule?.pattern ?? '(?!)', 'g').test(sample)).toBe(true);
  });
});

describe('правила не ловят обычный вывод', () => {
  // Ложное срабатывание на этих строках означает, что демо S2 показывает зрителю
  // чёрные прямоугольники вместо вывода тестов.
  const benign = [
    'PASS src/validate/refine.test.ts (34 tests) 12ms',
    'node_modules/.cache/vite/deps',
    'Resolved 412 packages in 1.2s',
    'commit e40b7defb42add5ade60cc85192e63ad42aa7b4a',
    'https://github.com/EgorKazachenko/mcpproxy/pull/1',
    'Error: ENOENT: no such file or directory, open "/Users/dev/proj/logs/app.log"',
    'sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  ];

  it.each(benign)('%s не совпадает ни с одним правилом', (line) => {
    const hit = SECRET_RULES.filter((rule) => new RE2(rule.pattern, 'g').test(line));
    expect(hit.map((rule) => rule.id)).toEqual([]);
  });
});
