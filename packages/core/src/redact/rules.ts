/**
 * Набор правил редакции секретов.
 *
 * **Правила не сочиняются здесь.** `docs/04-research-findings.md` §10 говорит прямо:
 * «секретные паттерны не пишем сами» — у gitleaks 150+ правил, у Secrets-Patterns-DB
 * унифицированный формат. Отсюда обязательное поле `source`: правило без провенанса — это
 * ровно тот самодельный regex для AWS-ключа, против которого разведка и написана, и
 * `rules.test.ts` на него краснеет.
 *
 * **Честная граница, которую надо знать при обновлении.** Паттерны ниже выписаны по
 * публичным наборам (gitleaks `config/gitleaks.toml`, Secrets-Patterns-DB) и **переписаны
 * под синтаксис RE2**: у части исходных правил стоит `(?i)` вместе с lookahead-контекстом
 * вида `(?=.{0,40})`, а RE2 lookahead не компилирует вовсе (ADR решение D3 из E0 — тот же
 * движок, что у манифеста). То есть это адаптация, а не машинная конвертация, и при
 * обновлении набора сверять надо построчно. Цена адаптации — потерянный контекст вокруг
 * совпадения, из-за чего правила без характерного префикса (`aws-secret-access-key`)
 * держатся на ключевом слове рядом, а не на форме самого значения.
 *
 * Порядок массива детерминирован и участвует в разрешении пересечений (R13): при равной
 * длине совпадения выигрывает правило, идущее раньше.
 */

export interface SecretRule {
  /** Идентификатор. Публичен: он уезжает в `Redaction.rule` и в плейсхолдер `[redacted:<id>]`. */
  readonly id: string;
  /** Откуда правило взято. Обязательно — это и есть исполняемая часть «не пишем сами». */
  readonly source: string;
  readonly description: string;
  /** Синтаксис RE2. Компилируется на старте; несовместимый паттерн роняет загрузку набора. */
  readonly pattern: string;
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key-pem',
    source: 'gitleaks:private-key',
    description: 'Заголовок приватного ключа в PEM',
    pattern: '-----BEGIN[ A-Z]{0,32}PRIVATE KEY(?: BLOCK)?-----',
  },
  {
    id: 'aws-access-key-id',
    source: 'gitleaks:aws-access-token',
    description: 'AWS Access Key ID',
    pattern: '(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}',
  },
  {
    id: 'aws-secret-access-key',
    source: 'Secrets-Patterns-DB:aws-secret-key (контекст вместо lookahead)',
    description: 'AWS Secret Access Key рядом с именем переменной',
    // Держится на ключевом слове рядом: у самого значения формы нет — это 40 символов
    // base64. Без контекста правило совпадало бы с любой base64-строкой такой длины.
    pattern: '(?i)aws[_\\-]?secret[_\\-]?access[_\\-]?key[\'"\\s:=]{1,10}[A-Za-z0-9/+=]{40}',
  },
  {
    id: 'github-pat',
    source: 'gitleaks:github-pat',
    description: 'GitHub Personal Access Token (classic)',
    pattern: 'ghp_[A-Za-z0-9]{36}',
  },
  {
    id: 'github-oauth-token',
    source: 'gitleaks:github-oauth',
    description: 'GitHub OAuth Access Token',
    pattern: 'gho_[A-Za-z0-9]{36}',
  },
  {
    id: 'github-app-token',
    source: 'gitleaks:github-app-token',
    description: 'GitHub App / Server-to-Server Token',
    pattern: 'gh[su]_[A-Za-z0-9]{36}',
  },
  {
    id: 'github-refresh-token',
    source: 'gitleaks:github-refresh-token',
    description: 'GitHub Refresh Token',
    pattern: 'ghr_[A-Za-z0-9]{36}',
  },
  {
    id: 'github-fine-grained-pat',
    source: 'gitleaks:github-fine-grained-pat',
    description: 'GitHub Fine-Grained Personal Access Token',
    pattern: 'github_pat_[A-Za-z0-9_]{82}',
  },
  {
    id: 'gitlab-pat',
    source: 'gitleaks:gitlab-pat',
    description: 'GitLab Personal Access Token',
    pattern: 'glpat-[A-Za-z0-9_\\-]{20}',
  },
  {
    id: 'slack-bot-token',
    source: 'gitleaks:slack-bot-token',
    description: 'Slack Bot / User OAuth Token',
    pattern: 'xox[baprs]-[0-9A-Za-z\\-]{10,72}',
  },
  {
    id: 'slack-webhook-url',
    source: 'gitleaks:slack-webhook-url',
    description: 'Slack Incoming Webhook',
    pattern: 'https://hooks\\.slack\\.com/(?:services|workflows)/[A-Za-z0-9+/]{40,}',
  },
  {
    id: 'stripe-secret-key',
    source: 'gitleaks:stripe-access-token',
    description: 'Stripe Secret / Restricted Key',
    pattern: '(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,99}',
  },
  {
    id: 'anthropic-api-key',
    source: 'Secrets-Patterns-DB:anthropic-api-key',
    description: 'Anthropic API Key',
    pattern: 'sk-ant-[A-Za-z0-9]{4,12}-[A-Za-z0-9_\\-]{80,120}',
  },
  {
    id: 'openai-api-key',
    source: 'Secrets-Patterns-DB:openai-api-key',
    description: 'OpenAI API Key',
    pattern: 'sk-(?:proj-)?[A-Za-z0-9_\\-]{32,}',
  },
  {
    id: 'google-api-key',
    source: 'gitleaks:gcp-api-key',
    description: 'Google API Key',
    pattern: 'AIza[0-9A-Za-z_\\-]{35}',
  },
  {
    id: 'npm-access-token',
    source: 'gitleaks:npm-access-token',
    description: 'npm Access Token',
    pattern: 'npm_[A-Za-z0-9]{36}',
  },
  {
    id: 'pypi-upload-token',
    source: 'gitleaks:pypi-upload-token',
    description: 'PyPI Upload Token',
    pattern: 'pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\\-]{50,}',
  },
  {
    id: 'sendgrid-api-key',
    source: 'gitleaks:sendgrid-api-token',
    description: 'SendGrid API Key',
    pattern: 'SG\\.[A-Za-z0-9_\\-]{22}\\.[A-Za-z0-9_\\-]{43}',
  },
  {
    id: 'twilio-api-key',
    source: 'gitleaks:twilio-api-key',
    description: 'Twilio API Key SID',
    // Единственный способ поймать 32 hex: по префиксу формата. Энтропией их не отличить от
    // git sha — замер в spec.md, «Проверенные факты».
    pattern: 'SK[0-9a-fA-F]{32}',
  },
  {
    id: 'jwt',
    source: 'gitleaks:jwt',
    description: 'JSON Web Token',
    pattern: 'eyJ[A-Za-z0-9_\\-]{8,}\\.eyJ[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}',
  },
  {
    id: 'db-connection-uri',
    source: 'Secrets-Patterns-DB:database-connection-string',
    description: 'Строка подключения к БД с паролем',
    pattern: '(?i)(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis|amqp)://[^:@/\\s]{1,128}:[^@/\\s]{1,256}@[^\\s/]{1,256}',
  },
  {
    id: 'basic-auth-url',
    source: 'Secrets-Patterns-DB:basic-auth-credentials',
    description: 'HTTP Basic-креды внутри URL',
    pattern: '(?i)https?://[^:@/\\s]{1,128}:[^@/\\s]{1,256}@',
  },
] as const;
