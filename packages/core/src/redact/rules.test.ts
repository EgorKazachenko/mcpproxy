import RE2 from 're2';
import { describe, expect, it } from 'vitest';
import { SECRET_RULES } from './rules.js';
import { alnum, basicAuthUrl, dbUri, digits, hex, pemHeader, upper } from './secret-samples.js';

/**
 * R5 и R6 — исполняемые, а не декларативные.
 *
 * Секреты в фикстурах ниже синтетические и **собираются из частей на прогоне**: строки формы
 * креденшла не существует на диске. Причина не в аккуратности — сканеры секретов поднимают
 * такие литералы (GitGuardian на этом PR нашёл восемь), а красная проверка на каждом пуше
 * становится шумом, за которым настоящая утечка проедет незамеченной. Подробности — в
 * `secret-samples.ts`.
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
    ['private-key-pem', pemHeader('OPENSSH')],
    ['aws-access-key-id', `AKIA${upper(16)}`],
    ['aws-secret-access-key', `aws_secret_access_key = ${alnum(40)}`],
    ['github-pat', `ghp_${alnum(36)}`],
    ['github-oauth-token', `gho_${alnum(36)}`],
    ['github-app-token', `ghs_${alnum(36)}`],
    ['github-refresh-token', `ghr_${alnum(36)}`],
    ['github-fine-grained-pat', `github_pat_${alnum(82)}`],
    ['gitlab-pat', `glpat-${alnum(20)}`],
    ['slack-bot-token', `xoxb-${digits(13)}-${digits(13)}-${alnum(24)}`],
    ['slack-webhook-url', `https://hooks.slack.com/services/${alnum(40)}`],
    ['stripe-secret-key', `sk_live_${alnum(24)}`],
    ['anthropic-api-key', `sk-ant-api03-${alnum(90)}`],
    ['openai-api-key-classic', `sk-${alnum(20)}T3BlbkFJ${alnum(20)}`],
    ['openai-project-key', `sk-proj-${alnum(50)}`],
    ['google-api-key', `AIza${alnum(35)}`],
    ['npm-access-token', `npm_${alnum(36)}`],
    ['pypi-upload-token', `pypi-AgEIcHlwaS5vcmc${alnum(50)}`],
    ['sendgrid-api-key', `SG.${alnum(22)}.${alnum(43)}`],
    ['twilio-api-key', `SK${hex(32)}`],
    ['jwt', `eyJ${alnum(12)}.eyJ${alnum(12)}.${alnum(24)}`],
    ['db-connection-uri', dbUri()],
    ['basic-auth-url', basicAuthUrl()],
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
    // Ложняк, воспроизведённый ревью на РЕАЛЬНОМ выводе `git`: правило `openai-api-key`
    // не имело ни маркера формата, ни границы слова, и `sk-` внутри `task-` давало
    // 'On branch fix/ta[redacted:openai-api-key]'. Отредактированный stdout — это то,
    // что видит модель, поэтому вырезанное имя ветки ломает вызов молча.
    'On branch fix/task-scheduler-race-condition-in-worker',
    'risk-management-and-compliance-framework-v2',
    'disk-space-monitor-daemon-restart-policy',
    // Идентификаторы принципалов IAM — не креденшлы, и `aws iam` печатает их штатно.
    `arn:aws:iam::123456789012:user/deploy AIDA${upper(16)} AROA${upper(16)}`,
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
