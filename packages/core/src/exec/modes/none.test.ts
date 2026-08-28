import { lookup } from 'node:dns/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { asRecipeName, normalizeRecipe } from '@mcpproxy/contracts';
import type { Defaults, Recipe, SandboxViolation } from '@mcpproxy/contracts';
import type { ExecEvent } from '../events.js';
import { newCommandId } from '../sandbox.js';
import type { ExecOutcome, Sandbox } from '../sandbox.js';
import { createNoneSandbox, parseEnvPairs, proxyEnvVars } from './none.js';

/**
 * Режим `none` — baseline демо. Он обязан **наблюдать**, а не запрещать: левая половина
 * таблицы S5 состоит ровно из того, что здесь видно.
 *
 * Пропуск на не-macOS громкий по тем же основаниям, что и в `seatbelt.test.ts`: прокси
 * поднимает тот же синглтон srt, и молчаливо зелёный прогон при мёртвом прокси показал бы
 * нулевую эксфильтрацию как успех.
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
  env: { allow: ['HOME'] },
  sandbox: { read: { deny: [] }, write: { allow: [] }, network: { allow: [] } },
};

/**
 * Цель — **имя**, а не `127.0.0.1` (R42, R51). Имя берётся из публичного wildcard-DNS, а не
 * из правки `/etc/hosts`: последняя требует root, мутирует машину глобально и в CI не
 * ставится. Имя не совпадает с `NO_PROXY`, поэтому запрос уходит в прокси — а прокси
 * работает ВНЕ песочницы, и его соединение на loopback не ограничено.
 */
const LOOPBACK_NAME = '127-0-0-1.nip.io';
const PUBLIC_HOST = 'example.com';

describe.skipIf(!IS_MACOS)('режим none — наблюдающий baseline', () => {
  let sandbox: Sandbox;
  let fixture: string;
  let listener: Server;
  let port: number;

  beforeAll(async () => {
    const resolved = await lookup(LOOPBACK_NAME).catch(() => undefined);
    if (resolved?.address !== '127.0.0.1') {
      throw new Error(
        `условие прогона не выполнено: ${LOOPBACK_NAME} обязан резолвиться в 127.0.0.1 ` +
          'через публичный wildcard-DNS (R51). Проверьте доступность сети.',
      );
    }

    // Второе условие прогона, и оно объявляется так же громко. Без него блокированный
    // egress, captive portal или заминка `example.com` всплывали бы как
    // `expected '000' to be '200'` внутри теста про allowlist — то есть читались бы как
    // «песочница отказала запросу, который обязана была пропустить», а на deny-ногах
    // делали бы тест зелёным по неверной причине.
    const reachable = await fetch(`https://${PUBLIC_HOST}/`, { signal: AbortSignal.timeout(20_000) })
      .then((response) => response.status)
      .catch(() => 0);
    if (reachable !== 200) {
      throw new Error(
        `условие прогона не выполнено: ${PUBLIC_HOST} обязан отвечать 200 напрямую с ` +
          `машины демона, а ответил ${reachable}. Сетевые утверждения набора без этого ` +
          'читаются как отказ песочницы.',
      );
    }

    sandbox = createNoneSandbox();
    fixture = mkdtempSync(join(tmpdir(), 'e3-none-'));
    writeFileSync(join(fixture, 'secret.txt'), 'верхний секрет');

    listener = createServer((_request, response) => {
      response.end('ok');
    });
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    port = address === null || typeof address === 'string' ? 0 : address.port;
  });

  afterAll(async () => {
    await sandbox.dispose();
    listener.close();
    rmSync(fixture, { recursive: true, force: true });
  });

  const run = async (
    recipe: Recipe,
    script: string,
  ): Promise<{ outcome: ExecOutcome; violations: SandboxViolation[] }> => {
    const { effective } = normalizeRecipe(recipe, DEFAULTS);
    const violations: SandboxViolation[] = [];
    const outcome = await sandbox.run(
      {
        recipeName: asRecipeName('baseline'),
        command: ['/bin/sh', '-c', script],
        recipeCwd: fixture,
        effective,
        commandId: newCommandId(),
      },
      (violation) => violations.push(violation),
    );
    return { outcome, violations };
  };

  const CLOSED: Recipe = { description: 'x', exec: ['/bin/sh'], sandbox: { network: { allow: [] } } };

  it('обращение на разрешённый хост видно как allowed, а не как отказ (R31, D2)', async () => {
    // Убрать проброс прокси-переменных → нарушений ноль, и разваливается левая половина S5.
    const { outcome, violations } = await run(
      CLOSED,
      `curl -s -m 20 -o /dev/null -w "%{http_code}" http://${LOOPBACK_NAME}:${port}/`,
    );

    expect(outcome.stdout.text).toBe('200');
    expect(violations).toContainEqual(
      expect.objectContaining({ type: 'network', action: 'allowed' } satisfies Partial<SandboxViolation>),
    );
  });

  /**
   * Вторая группа переменных — доверие к CA. Без неё `curl` по HTTPS даёт `exit=60`
   * (`SSL certificate problem: self signed certificate`), потому что `tlsTerminate` подсовывает
   * ребёнку сертификат, подписанный эфемерным CA прокси.
   *
   * Это и есть худший вид отказа: baseline ломается как **сетевая ошибка**, неотличимая в
   * таймлайне от «песочница заблокировала».
   */
  it('HTTPS в baseline работает — значит CA-группа переменных доехала', async () => {
    const { outcome } = await run(
      CLOSED,
      `curl -s -m 20 -o /dev/null -w "%{http_code}" https://${PUBLIC_HOST}/`,
    );
    expect(outcome.exit.code).toBe(0);
    expect(outcome.stdout.text).toBe('200');
  });

  it('байты тела POST видны — это «1.2 KB» из S5', async () => {
    const payload = 'x'.repeat(1234);
    const { violations } = await run(
      CLOSED,
      `curl -s -m 20 -o /dev/null -X POST --data-binary '${payload}' http://${LOOPBACK_NAME}:${port}/`,
    );
    const allowed = violations.filter((one) => one.action === 'allowed');
    expect(allowed).toHaveLength(1);
    expect(allowed[0]?.bytes).toBe(1234);
  });

  it('пустой network.allow рецепта в baseline ничего не запрещает — иначе это не baseline', async () => {
    // Рецепт объявил «сети нет», и в `seatbelt` его бы отказали. Здесь он идёт насквозь, и
    // именно эта разница делает `evil.io` из S5 достижимым в левой колонке.
    const { violations } = await run(CLOSED, `curl -s -m 20 -o /dev/null http://${LOOPBACK_NAME}:${port}/`);
    expect(violations.filter((one) => one.action === 'denied')).toHaveLength(0);
  });

  it('файл, закрытый профилем, читается — профиль не применяется вовсе', async () => {
    const denied: Recipe = {
      description: 'x',
      exec: ['/bin/sh'],
      sandbox: { read: { deny: ['./secret.txt'] } },
    };
    const { outcome } = await run(denied, `cat '${join(fixture, 'secret.txt')}'`);
    expect(outcome.termination).toBe('exited');
    expect(outcome.exit.code).toBe(0);
    expect(outcome.stdout.text).toContain('верхний секрет');
  });

  /**
   * R42, записанное исполняемым: `127.0.0.1` зашит в `NO_PROXY` (`sandbox-utils.js`), клиент
   * идёт мимо прокси, и наблюдать становится нечего. Корпус E8 обязан ходить на имя.
   */
  it('обращение по адресу проходит мимо прокси и не наблюдается, по имени — наблюдается', async () => {
    const byAddress = await run(CLOSED, `curl -s -m 20 -o /dev/null http://127.0.0.1:${port}/`);
    expect(byAddress.violations).toHaveLength(0);

    const byName = await run(CLOSED, `curl -s -m 20 -o /dev/null http://${LOOPBACK_NAME}:${port}/`);
    expect(byName.violations).not.toHaveLength(0);
  });

  it('политика вызова хэшируется как применённая, а не как манифестная (R47)', async () => {
    // В `none` они расходятся: рецепт объявил `[]`, применён `['*']`. Хэш, врущий про сеть,
    // бесполезен ровно там, где решение человека важнее всего.
    const closed = await run(CLOSED, 'echo hi');
    const open = await run(
      { description: 'x', exec: ['/bin/sh'], sandbox: { network: { allow: ['*'] } } },
      'echo hi',
    );
    expect(closed.outcome.policyHash).toBe(open.outcome.policyHash);
  });
  /**
   * Аварийный путь, и он проверяется здесь, а не под `seatbelt`, по устройству режимов: в
   * `seatbelt` команду запускает обёртка `bash -c`, поэтому несуществующий бинарь даёт код
   * возврата 127, а не отказ `spawn`. В `none` команда идёт как есть — и `spawn` эмитит
   * `error`, то есть тело вызова реджектится по-настоящему.
   *
   * До правки снятие политики стояло на успешном пути, и упавший вызов оставлял демону свой
   * allowlist — в `none` это буквально `['*']`. Форма «на ошибке возвращаем allow»; идловым
   * состоянием R52 объявляет пустой список, и наступать оно обязано на каждом выходе.
   */
  it('после упавшего вызова allowlist пуст, семафор отпущен, событие spawn есть (R32, R52)', async () => {
    const { effective } = normalizeRecipe(CLOSED, DEFAULTS);
    const events: ExecEvent[] = [];

    await expect(
      sandbox.run(
        {
          recipeName: asRecipeName('baseline'),
          command: [join(fixture, 'нет-такого-бинаря'), 'аргумент'],
          recipeCwd: fixture,
          effective,
          commandId: newCommandId(),
        },
        () => undefined,
        (event) => events.push(event),
      ),
    ).rejects.toThrow();

    const idle = SandboxManager.getConfig();
    expect(idle?.network.allowedDomains).toEqual([]);
    expect(idle?.network.deniedDomains).toEqual([]);

    // Стадия оставила событие, хотя запуск провалился: «событие на каждой стадии, включая
    // отказ» (R32). Без него вызов исчезал бы из таймлайна между build_profile и ничем.
    expect(events.map((one) => one.stage)).toContain('spawn');

    // И семафор освобождён — следующий вызов проходит, а не виснет навсегда.
    const after = await run(CLOSED, 'echo жив');
    expect(after.outcome.stdout.text.trim()).toBe('жив');
  });

  /**
   * R50 требует, чтобы `run()` бросал у **освобождённого экземпляра**: вызов после
   * `dispose()` пошёл бы со старым конфигом и `getProxyPort() === undefined` — сеть тихо
   * ОТКРЫТА в `none` и тихо МЕРТВА в `seatbelt`. Флаг поэтому живёт в самой песочнице.
   *
   * Процессным его делать нельзя, и это утверждается здесь же: `reset()` у srt чистит
   * `initializationPromise`, значит переподъём безопасен, — а с процессным флагом E5,
   * освободив обе песочницы после демо, не смог бы переключить режим на слайде S5, потому
   * что `createSandbox` бросал бы до конца жизни процесса.
   */
  it('после dispose бросает ЭТА песочница, но процесс остаётся способен поднять новую (R50)', async () => {
    // Обе ссылки — свои. Раньше одной из них была `sandbox` набора, и весь файл был зелёным
    // только благодаря порядку объявления: под `--sequence.shuffle.tests` любой тест,
    // объявленный после этого, падал с «песочница уже освобождена». Комментарий «последний
    // тест набора намеренно» производил зелёный, а не документировал его.
    const first = createNoneSandbox();
    const second = createNoneSandbox();
    const request = {
      recipeName: asRecipeName('baseline'),
      command: ['/bin/sh', '-c', 'echo hi'] as const,
      recipeCwd: fixture,
      effective: normalizeRecipe(CLOSED, DEFAULTS).effective,
      commandId: newCommandId(),
    };

    // Одна из двух ссылок отпущена — вторая песочница жива и работает.
    await first.dispose();
    await expect(second.run(request, () => undefined)).resolves.toMatchObject({ termination: 'exited' });

    await second.dispose();
    await expect(second.run(request, () => undefined)).rejects.toThrow(/dispose/);

    // А процесс — нет: свежая песочница поднимается и исполняет.
    const third = createNoneSandbox();
    await expect(
      third.run({ ...request, commandId: newCommandId() }, () => undefined),
    ).resolves.toMatchObject({ termination: 'exited' });
    await third.dispose();
  });
});

describe('parseEnvPairs', () => {
  it('делит по первому знаку равенства — в URL прокси есть свои', () => {
    expect(parseEnvPairs(['HTTP_PROXY=http://user:tok=en@localhost:1234'])).toEqual({
      HTTP_PROXY: 'http://user:tok=en@localhost:1234',
    });
  });

  it('пропускает строки без имени', () => {
    expect(parseEnvPairs(['=значение', 'без-равенства', 'A=1'])).toEqual({ A: '1' });
  });
});

/**
 * Обе ветки отказа — отдельным набором, потому что на macOS прокси поднимается всегда, и
 * через живой синглтон они недостижимы. Код, который нельзя заставить упасть, не проверен.
 */
describe('proxyEnvVars — громкий отказ вместо слепого baseline', () => {
  const READY = { httpPort: 8080, socksPort: 8080, caBundle: '/tmp/ca.pem', token: 'тк' };

  it('без единого порта бросает, а не отдаёт env без прокси', () => {
    // Вендор при обоих портах `undefined` возвращает ровно `['SANDBOX_RUNTIME=1']` — без
    // HTTP_PROXY, без NO_PROXY, без токена. Пройди это тихо, `none` стал бы слепым: ноль
    // violations, сеть открыта, тесты зелёные, S5 показывает ноль эксфильтрации как успех.
    expect(() => proxyEnvVars({ ...READY, httpPort: undefined, socksPort: undefined }, 'к')).toThrow(/слепым/);
  });

  it('без трастового бандла CA бросает — иначе HTTPS упал бы как сетевая ошибка', () => {
    expect(() => proxyEnvVars({ ...READY, caBundle: undefined }, 'к')).toThrow(/сертификат/);
  });

  it('одного SOCKS-порта достаточно: отказ на отсутствии обоих, а не любого', () => {
    expect(() => proxyEnvVars({ ...READY, httpPort: undefined }, 'к')).not.toThrow();
  });

  it('при живом прокси отдаёт обе группы переменных', () => {
    const env = proxyEnvVars(READY, 'к');
    expect(env['HTTP_PROXY']).toContain('8080');
    expect(env['NO_PROXY']).toContain('127.0.0.1');
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/tmp/ca.pem');
  });
});
