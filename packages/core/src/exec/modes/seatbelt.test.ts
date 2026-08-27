import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { asRecipeName, normalizeRecipe } from '@mcpproxy/contracts';
import type { Defaults, Recipe, SandboxViolation } from '@mcpproxy/contracts';
import type { ExecEvent } from '../events.js';
import { newCommandId } from '../sandbox.js';
import type { ExecOutcome, Sandbox } from '../sandbox.js';
import { createSeatbeltSandbox, quoteArgv } from './seatbelt.js';

/**
 * Интеграционный набор под **настоящим** seatbelt. Он видит дефекты, которых юнит-тесты на
 * литеральных строках увидеть не могут: проверка «строка лежит в массиве `denyWrite`»
 * зелёная и тогда, когда srt наш список игнорирует, и тогда, когда глоб с несуществующим
 * префиксом не матчит ничего.
 *
 * Пропуск на не-macOS **громкий** (критерий готовности `spec.md`): молчаливо зелёный
 * Linux-CI при мёртвой песочнице — худший из возможных исходов, поэтому отсутствие
 * платформы объявляется отдельным красным тестом, а не читается как успех. Осознанный
 * пропуск включается переменной `MCPPROXY_SKIP_SANDBOX_TESTS=1`.
 */
const IS_MACOS = process.platform === 'darwin';
const OPTED_OUT = process.env['MCPPROXY_SKIP_SANDBOX_TESTS'] === '1';

describe('громкость пропуска', () => {
  it.skipIf(IS_MACOS)('на не-macOS набор не исполняется, и это объявлено, а не замолчано', () => {
    expect(
      OPTED_OUT ? 'пропуск объявлен переменной MCPPROXY_SKIP_SANDBOX_TESTS' : `платформа ${process.platform}`,
    ).toBe('пропуск объявлен переменной MCPPROXY_SKIP_SANDBOX_TESTS');
  });
});

const DEFAULTS: Defaults = {
  timeout: '30s',
  output: { maxBytes: 65_536, redact: true },
  // Оба маркера — в дефолтах, потому что `effective.env.allow` это ПЕРЕСЕЧЕНИЕ с ними
  // (`lock.ts:239`): рецепт сужает allowlist окружения, но не вводит своего.
  env: { allow: ['HOME', 'E3_MARKER', 'E3_SECRET'] },
  sandbox: { read: { deny: [] }, write: { allow: [] }, network: { allow: [] } },
};

/** Имя из публичного wildcard-DNS, а не правка `/etc/hosts` (R51): последняя требует root. */
const LOOPBACK_NAME = '127-0-0-1.nip.io';

/** Публичный хост для сетевых утверждений: у локального listener самоподписанный сертификат (R55). */
const PUBLIC_HOST = 'example.com';

interface RunResult {
  readonly outcome: ExecOutcome;
  readonly violations: SandboxViolation[];
  readonly events: ExecEvent[];
}

describe.skipIf(!IS_MACOS)('seatbelt под настоящей песочницей', () => {
  let sandbox: Sandbox;
  let fixture: string;

  beforeAll(async () => {
    // Зависимость от внешнего DNS — объявленное условие прогона (R51). Падение здесь
    // означает «сеть недоступна», а не «песочница сломана», и текст обязан это говорить.
    const resolved = await lookup(LOOPBACK_NAME).catch(() => undefined);
    if (resolved?.address !== '127.0.0.1') {
      throw new Error(
        `условие прогона не выполнено: ${LOOPBACK_NAME} обязан резолвиться в 127.0.0.1 ` +
          'через публичный wildcard-DNS (R51). Проверьте доступность сети.',
      );
    }

    sandbox = createSeatbeltSandbox();
    fixture = mkdtempSync(join(tmpdir(), 'e3-seatbelt-'));
    for (const sub of ['.git/hooks', 'sub/.git/hooks']) mkdirSync(join(fixture, sub), { recursive: true });
    writeFileSync(join(fixture, 'secret.txt'), 'верхний секрет');
  });

  afterAll(async () => {
    await sandbox.dispose();
    rmSync(fixture, { recursive: true, force: true });
  });

  const run = async (recipe: Recipe, script: string, cwd?: string): Promise<RunResult> => {
    const { effective } = normalizeRecipe(recipe, DEFAULTS);
    const violations: SandboxViolation[] = [];
    const events: ExecEvent[] = [];
    const outcome = await sandbox.run(
      {
        recipeName: asRecipeName('probe'),
        command: ['/bin/sh', '-c', script],
        recipeCwd: cwd ?? fixture,
        effective,
        commandId: newCommandId(),
      },
      (violation) => violations.push(violation),
      (event) => events.push(event),
    );
    return { outcome, violations, events };
  };

  /**
   * Каталог рецепта **отличен** от cwd демона, и `write.allow` стоит на весь этот каталог,
   * то есть запись разрешена явно. Проба П3 показала, что вендорский mandatory-deny в этой
   * конфигурации не срабатывает вовсе: он якорится на cwd демона.
   */
  describe('mandatory deny под настоящим профилем (R9, R10)', () => {
    const writable: Recipe = { description: 'x', exec: ['/bin/sh'], sandbox: { write: { allow: ['.'] } } };

    it('каталог рецепта не совпадает с cwd демона — иначе дефект замаскирован', () => {
      expect(fixture).not.toBe(process.cwd());
    });

    it('запись в .git/hooks, sub/.git/hooks, .zshrc и .git/config отказана', async () => {
      const targets = ['.git/hooks/pre-commit', 'sub/.git/hooks/pre-commit', '.zshrc', '.git/config'];
      const script = targets.map((one) => `echo x > '${join(fixture, one)}' 2>/dev/null; echo $?`).join('; ');
      const { outcome } = await run(writable, script);

      // Каждая строка — код возврата своей записи. Ноль означает, что защита не сработала.
      expect(outcome.stdout.text.trim().split('\n')).toEqual(['1', '1', '1', '1']);
    });

    it('обычная запись в тот же каталог проходит — иначе тест выше доказывал бы, что всё запрещено', async () => {
      const { outcome } = await run(writable, `echo x > '${join(fixture, 'ordinary.txt')}' 2>/dev/null; echo $?`);
      expect(outcome.stdout.text.trim()).toBe('0');
    });

    it('отказ классифицирован как mandatory-deny, а не file-write — это бейдж S6', async () => {
      const { violations } = await run(writable, `echo x > '${join(fixture, 'sub/.git/hooks/pre-commit')}' 2>/dev/null`);
      const writes = violations.filter((one) => one.type === 'mandatory-deny' || one.type === 'file-write');
      expect(writes.map((one) => one.type)).toContain('mandatory-deny');
      expect(writes.map((one) => one.type)).not.toContain('file-write');
    });
  });

  /**
   * Детектор дрейфа (R10). Гоняет **вендорскую** защиту, а не нашу: формулировка «наш
   * список отказан» тавтологична — он отказан потому, что мы его запретили, и покраснеть
   * при сужении апстрима не может.
   *
   * Прогон идёт в дочернем процессе с `process.chdir` на фикстуру (техника П3b), потому что
   * cwd глобален и трогать его в демоне нельзя.
   */
  it('детектор дрейфа: вендорский набор обязательных запретов не изменился', () => {
    const require_ = createRequire(import.meta.url);
    const vendor = require_.resolve('@anthropic-ai/sandbox-runtime');
    const script = join(fixture, 'drift-probe.mjs');
    writeFileSync(script, DRIFT_PROBE);

    const out = execFileSync(process.execPath, [script, vendor], { encoding: 'utf8', timeout: 120_000 });
    const denied: string[] = JSON.parse(out) as string[];

    // Записано, а не выведено из нашего списка: сравнение нашей копии с самой собой ничего
    // не проверяет. Сужение апстрима укорачивает набор, расширение — удлиняет; красное в
    // обе стороны, потому что и то и другое требует решения человека.
    expect(denied).toEqual(RECORDED_VENDOR_DENIALS);
  });

  describe('сеть под updateConfig и семафором (R12, R21, R53)', () => {
    const withNetwork = (allow: string[], deny: string[] = []): Recipe => ({
      description: 'x',
      exec: ['/bin/sh'],
      sandbox: { network: { allow, deny } },
    });
    const CURL = `curl -s -m 20 -o /dev/null -w "%{http_code}" https://${PUBLIC_HOST}/`;

    /**
     * Два **последовательных** вызова: одновременных быть не может по построению — семафор
     * R21 их запрещает. Проверка идёт по HTTPS и по **публичному** хосту: на plain HTTP
     * дефект не виден вовсе (проба П5 показала, что `customConfig.network` не действует), а
     * локальный listener покрасил бы разрешённую ногу по причине из R55.
     */
    it('разные network.allow дают разные решения', async () => {
      const allowed = await run(withNetwork([PUBLIC_HOST]), CURL);
      expect(allowed.outcome.stdout.text).toBe('200');

      const blocked = await run(withNetwork(['example.org']), CURL);
      expect(blocked.outcome.stdout.text).toBe('000');
      expect(blocked.violations.some((one) => one.type === 'network' && one.action === 'denied')).toBe(true);
    });

    it('network.deny рецепта доезжает до deniedDomains и бьёт allow (R53)', async () => {
      // Явный запрет автора рецепта терять молча нельзя; srt проверяет deny раньше allow.
      const both = await run(withNetwork([PUBLIC_HOST], [PUBLIC_HOST]), CURL);
      expect(both.outcome.stdout.text).toBe('000');
      expect(both.violations.some((one) => one.target.startsWith(`${PUBLIC_HOST}:`))).toBe(true);
    });

    it('разрешённый запрос даёт violation телеметрии с байтами тела (R15, R26, D12)', async () => {
      const payload = 'x'.repeat(1234);
      const { violations } = await run(
        withNetwork([PUBLIC_HOST]),
        `curl -s -m 20 -o /dev/null -X POST --data-binary '${payload}' https://${PUBLIC_HOST}/`,
      );
      const allowed = violations.filter((one) => one.action === 'allowed');
      expect(allowed).toHaveLength(1);
      // Это и есть «отправлено 1.2 KB» из S5, и оно снято с HTTPS — то есть tlsTerminate
      // действительно даёт нам тело (проба П10).
      expect(allowed[0]?.bytes).toBe(1234);
    });

    /**
     * Число отказов независимое, а не взятое из накопителя: сравнение накопителя со стримом,
     * который его же и кормит, одинаково усечено с обеих сторон и зелено при потере.
     *
     * Источник — **прокси**, а не ядро: каждый отказ прокси это одно `addViolation` без
     * дедупликации, то есть число детерминировано, а монитор ядра отдаёт не более одного
     * нарушения на чанк вывода `log stream`, и ядерная фикстура была бы флакающей.
     */
    it('двести пятьдесят отказов прокси доезжают все, хотя кольцо стора держит сто', async () => {
      const { outcome, violations } = await run(
        withNetwork([PUBLIC_HOST]),
        'for i in $(seq 1 250); do curl -s -m 5 -o /dev/null http://blocked.invalid/ ; done; echo done',
      );
      expect(violations.filter((one) => one.action === 'denied')).toHaveLength(250);
      expect(outcome.violations).toHaveLength(250);
      expect(outcome.violationsLost).toBe(0);
      expect(outcome.attributionMismatches).toBe(0);
    });

    /**
     * `updateConfig` заменяет конфиг **целиком** (`structuredClone` без слияния), поэтому
     * пер-вызовный конфиг обязан быть сохранённой базой с заменой ровно двух доменных
     * списков (R56).
     *
     * Утверждение смотрит на **применённый** конфиг, а не на наш аргумент, и это
     * единственная форма, которая здесь что-то ловит: литерал из двух полей роняет
     * `strictAllowlist`, `tlsTerminate` и `filterRequest` совершенно молча. Ни один
     * поведенческий тест этого не видит — колбэк прокси захвачен по значению ещё в
     * `initialize` (R26), CA поднят там же, а deny-by-default держится и без
     * `strictAllowlist`, пока никто не зарегистрировал колбэк апрува. Дефект проявился бы
     * ровно тогда, когда E5 повесит свой (R43): неизвестный хост начал бы спрашивать
     * вместо отказа.
     */
    it('пер-вызовный конфиг сохраняет базу, а не литерал из двух списков (R56, R43, D12)', async () => {
      const { effective } = normalizeRecipe(withNetwork([PUBLIC_HOST]), DEFAULTS);
      let applied: SandboxRuntimeConfig | undefined;

      await sandbox.run(
        {
          recipeName: asRecipeName('probe'),
          command: ['/bin/sh', '-c', 'echo hi'],
          recipeCwd: fixture,
          effective,
          commandId: newCommandId(),
        },
        () => undefined,
        (event) => {
          // Стадия `spawn` наступает под уже выставленной политикой и под семафором.
          if (event.stage === 'spawn') applied = SandboxManager.getConfig();
        },
      );

      expect(applied?.network.allowedDomains).toEqual([PUBLIC_HOST]);
      expect(applied?.network.strictAllowlist).toBe(true);
      expect(applied?.network.tlsTerminate).toBeDefined();
      expect(typeof applied?.network.filterRequest).toBe('function');
      expect(applied?.filesystem).toBeDefined();
    });

    it('в простое allowlist пуст, а база всё ещё цела (R52, R56)', async () => {
      // Фоновый потомок, переживший вызов, не должен попасть под чужую политику — а в
      // режиме `none` чужая политика это `*`.
      await run(withNetwork([PUBLIC_HOST]), 'echo hi');
      const idle = SandboxManager.getConfig();
      expect(idle?.network.allowedDomains).toEqual([]);
      expect(idle?.network.deniedDomains).toEqual([]);
      expect(idle?.network.strictAllowlist).toBe(true);
    });

    /**
     * R55: прокси делает собственное соединение наверх **с проверкой сертификата**, и
     * самоподписанный локальный listener на нём падает — ребёнок получает 502, а не успех.
     * Тест на байты этого не поймал бы: `filterRequest` отрабатывает ДО соединения наверх.
     *
     * Отсюда решение спеки: baseline-нога S5 обязана либо ходить по HTTP, либо получить
     * сертификат, которому демон доверяет. Тест фиксирует цену, а не чинит её.
     */
    it('самоподписанный HTTPS-listener даёт 502, а не успех', async () => {
      const listener = await startSelfSignedListener();
      try {
        const { outcome } = await run(
          withNetwork([LOOPBACK_NAME]),
          `curl -s -m 20 -o /dev/null -w "%{http_code}" https://${LOOPBACK_NAME}:${listener.port}/`,
        );
        expect(outcome.stdout.text).not.toBe('200');
      } finally {
        listener.close();
      }
    });
  });

  describe('наблюдаемость и события (R29, R32, R37)', () => {
    const readDenied: Recipe = {
      description: 'x',
      exec: ['/bin/sh'],
      // Относительный путь — намеренно: срт резолвит относительные от cwd **демона**
      // (проба П3b), поэтому без нашего резолва от `recipeCwd` (R8) запрет промахнулся бы
      // мимо цели и тест бы покраснел. Тильду проверяет юнит-тест `profile.test.ts`:
      // её вендор разворачивает и сам, то есть интеграционно она неразличима.
      sandbox: { read: { deny: ['./secret.txt'] } },
    };

    it('нарушения вообще есть — без enableLogMonitor их было бы ноль (R37, факт Ф10)', async () => {
      const { violations } = await run(readDenied, `cat '${join(fixture, 'secret.txt')}' 2>/dev/null`);
      expect(violations.filter((one) => one.type === 'file-read')).not.toHaveLength(0);
    });

    it('нарушение доезжает до колбэка, пока процесс ещё жив (R29)', async () => {
      const marker = join(fixture, 'alive-marker');
      rmSync(marker, { force: true });
      let seenWhileAlive = false;
      const { effective } = normalizeRecipe(readDenied, DEFAULTS);

      await sandbox.run(
        {
          recipeName: asRecipeName('probe'),
          command: ['/bin/sh', '-c', `cat '${join(fixture, 'secret.txt')}' 2>/dev/null; sleep 2; touch '${marker}'`],
          recipeCwd: fixture,
          effective,
          commandId: newCommandId(),
        },
        () => {
          // Маркер пишется последней строкой скрипта. Его отсутствие в момент колбэка и
          // есть «строка появилась в таймлайне до выхода процесса».
          if (!existsSync(marker)) seenWhileAlive = true;
        },
      );

      expect(seenWhileAlive).toBe(true);
    });

    it('вызов, остановленный отказом, всё равно оставил событие build_profile (R32)', async () => {
      const events: ExecEvent[] = [];
      const { effective } = normalizeRecipe(
        { description: 'x', exec: ['/bin/sh'], sandbox: { network: { allow: ['http://evil.example'] } } },
        DEFAULTS,
      );

      await expect(
        sandbox.run(
          {
            recipeName: asRecipeName('probe'),
            command: ['/bin/sh', '-c', 'echo never'],
            recipeCwd: fixture,
            effective,
            commandId: newCommandId(),
          },
          () => undefined,
          (event) => events.push(event),
        ),
      ).rejects.toThrow(/network\.allow/);

      expect(events.map((one) => one.stage)).toContain('build_env');
      expect(events.map((one) => one.stage)).toContain('build_profile');
      expect(events.map((one) => one.stage)).not.toContain('spawn');
    });
  });

  describe('окружение ребёнка (R23, R24)', () => {
    it('видит только названное, минимальный PATH и при этом сохраняет сеть', async () => {
      process.env['E3_MARKER'] = 'виден';
      process.env['E3_SECRET'] = 'не виден';
      try {
        const recipe: Recipe = {
          description: 'x',
          exec: ['/bin/sh'],
          env: { allow: ['E3_MARKER'] },
          sandbox: { network: { allow: [PUBLIC_HOST] } },
        };
        const { outcome } = await run(
          recipe,
          `echo "marker=\${E3_MARKER:-нет}"; echo "secret=\${E3_SECRET:-нет}"; echo "path=$PATH"; ` +
            `curl -s -m 20 -o /dev/null -w "code=%{http_code}\n" https://${PUBLIC_HOST}/`,
        );

        const lines = outcome.stdout.text.trim().split('\n');
        expect(lines).toContain('marker=виден');
        // `E3_SECRET` есть в дефолтах, но рецепт его не назвал — сужение работает.
        expect(lines).toContain('secret=нет');
        expect(lines).toContain('path=/usr/bin:/bin:/usr/sbin:/sbin');
        // Наивная замена env лишила бы ребёнка прокси — то есть тихо сломала бы сеть (R24).
        expect(lines).toContain('code=200');
      } finally {
        delete process.env['E3_MARKER'];
        delete process.env['E3_SECRET'];
      }
    });
  });
});

describe('quoteArgv', () => {
  it('аргумент с пробелом остаётся одним аргументом', () => {
    expect(quoteArgv(['/bin/echo', 'два слова'])).toBe(`'/bin/echo' 'два слова'`);
  });

  it('одинарная кавычка внутри аргумента не закрывает строку', () => {
    expect(quoteArgv([`it's`])).toBe(`'it'\\''s'`);
  });

  it('метасимволы оболочки остаются данными', () => {
    expect(quoteArgv(['$(rm -rf /)'])).toBe(`'$(rm -rf /)'`);
  });
});

/**
 * Что вендорская защита отказывает сама, при `denyWrite: []` и cwd, равном фикстуре.
 * Снято прогоном на `@anthropic-ai/sandbox-runtime@0.0.74`; `ordinary.txt` в наборе
 * отсутствует — контроль того, что запрещено не всё подряд.
 */
const RECORDED_VENDOR_DENIALS: readonly string[] = [
  '.git/hooks/pre-commit',
  '.git/config',
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.vscode/settings.json',
  '.idea/workspace.xml',
  '.claude/commands/x.md',
  '.claude/agents/y.md',
  'sub/.git/hooks/pre-commit',
  'sub/.zshrc',
  'sub/.vscode/settings.json',
];

/** Скрипт дочернего процесса: `process.chdir` до обёртки, иначе cwd демона не сдвинуть. */
const DRIFT_PROBE = `
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { SandboxManager } = await import(process.argv[2]);

const dir = mkdtempSync(join(tmpdir(), 'e3-drift-'));
for (const sub of ['.git/hooks', '.vscode', '.idea', '.claude/commands', '.claude/agents', 'sub/.git/hooks', 'sub/.vscode']) {
  mkdirSync(join(dir, sub), { recursive: true });
}
process.chdir(dir);

await SandboxManager.initialize(
  { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [dir], denyWrite: [] } },
  undefined,
  false,
);

const CANDIDATES = ${JSON.stringify([
  'ordinary.txt',
  '.git/hooks/pre-commit',
  '.git/config',
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.vscode/settings.json',
  '.idea/workspace.xml',
  '.claude/commands/x.md',
  '.claude/agents/y.md',
  'sub/.git/hooks/pre-commit',
  'sub/.zshrc',
  'sub/.vscode/settings.json',
])};
const denied = [];
for (const rel of CANDIDATES) {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
    "echo x > '" + join(dir, rel) + "'", undefined, undefined, undefined, dir, { commandId: rel });
  const code = await new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: dir, stdio: 'ignore' });
    child.on('close', resolve);
  });
  if (code !== 0) denied.push(rel);
}
console.log(JSON.stringify(denied));
rmSync(dir, { recursive: true, force: true });
process.exit(0);
`;

/**
 * Локальный HTTPS-listener с самоподписанным сертификатом — ровно та конфигурация, на
 * которой прокси срывается при проверке сертификата наверх (R55).
 */
async function startSelfSignedListener(): Promise<{ port: number; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'e3-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('/usr/bin/openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', `/CN=${LOOPBACK_NAME}`,
  ]);

  const server: Server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (_request, response) => {
    response.end('ok');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address === null || typeof address === 'string' ? 0 : address.port;

  return {
    port,
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
