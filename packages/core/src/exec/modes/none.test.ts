import { lookup } from 'node:dns/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRecipeName, normalizeRecipe } from '@mcpproxy/contracts';
import type { Defaults, Recipe, SandboxViolation } from '@mcpproxy/contracts';
import { newCommandId } from '../sandbox.js';
import type { ExecOutcome, Sandbox } from '../sandbox.js';
import { createNoneSandbox, parseEnvPairs } from './none.js';

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
   * Последний тест набора намеренно: он отпускает **последнюю** ссылку и выставляет
   * терминальный флаг, после которого любой `run()` бросает (R50).
   *
   * `reset()` у srt глобален, чистит `initializationPromise`, но не `config`, а `initialize`
   * возвращается сразу при выставленном промисе. Значит вызов после освобождения идёт со
   * старым конфигом и `getProxyPort() === undefined`: прокси-переменные не эмитятся вовсе,
   * и сеть оказывается тихо ОТКРЫТА в `none` и тихо МЕРТВА в `seatbelt`.
   *
   * Ссылки считаются по песочницам, а не по вызовам: `run()` зовёт `ensureInitialized`, и
   * счётчик по вызовам не дошёл бы до нуля никогда — флаг не выставился бы, а это
   * утверждение осталось бы зелёным, ничего не проверив. Вторая песочница здесь именно за
   * тем, чтобы счёт был наблюдаем: пока жива она, флага нет.
   */
  it('флаг ставится на ПОСЛЕДНЕЙ ссылке, и после него любой run бросает (R50)', async () => {
    const second = createNoneSandbox();
    const request = {
      recipeName: asRecipeName('baseline'),
      command: ['/bin/sh', '-c', 'echo hi'] as const,
      recipeCwd: fixture,
      effective: normalizeRecipe(CLOSED, DEFAULTS).effective,
      commandId: newCommandId(),
    };

    // Одна из двух ссылок отпущена — песочница ещё жива.
    await sandbox.dispose();
    await expect(second.run(request, () => undefined)).resolves.toMatchObject({ termination: 'exited' });

    await second.dispose();
    await expect(second.run(request, () => undefined)).rejects.toThrow(/dispose/);
    // Флаг процессный, а не объектный: новая песочница тоже не поднимется.
    expect(() => createNoneSandbox()).toThrow(/dispose/);
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
