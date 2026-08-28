import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EndpointError, SOCKET_PATH_MAX_BYTES, assertSocketPathFits, clearStaleSocket, ensureRuntimeDir, issueToken, readToken, runtimeDir, socketPath, tokenMatches } from './endpoint.js';

const temp = (): string => mkdtempSync(join(tmpdir(), 'mcpproxy-endpoint-'));
const servers: { close(cb: () => void): void }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((one) => new Promise<void>((resolve) => one.close(() => resolve()))));
});

describe('runtimeDir — тот же каталог, что у журнала аудита', () => {
  it('MCPPROXY_HOME перекрывает домашний', () => {
    expect(runtimeDir({ MCPPROXY_HOME: '/srv/box' })).toBe('/srv/box');
    expect(socketPath({ MCPPROXY_HOME: '/srv/box' })).toBe('/srv/box/mcpproxyd.sock');
  });

  it('пустая строка трактуется как незаданная — как в E6', () => {
    expect(runtimeDir({ MCPPROXY_HOME: '' })).not.toBe('');
    expect(runtimeDir({ MCPPROXY_HOME: '' }).endsWith('.mcpproxy')).toBe(true);
  });
});

describe('ensureRuntimeDir — права проверяются ПОСЛЕ создания', () => {
  it('новый каталог создаётся 0700', () => {
    const dir = join(temp(), 'nested');
    ensureRuntimeDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('готовый каталог с правами для группы отвергается — mkdir режима не меняет', () => {
    const dir = join(temp(), 'loose');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    expect(() => ensureRuntimeDir(dir)).toThrowError(EndpointError);
  });
});

describe('токен', () => {
  it('пишется 0600 и читается обратно', () => {
    const path = join(temp(), 'tok');
    const issued = issueToken(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readToken(path)).toBe(issued);
    expect(issued).toMatch(/^[0-9a-f]{64}$/);
  });

  it('отсутствующий и пустой различаются кодом', () => {
    const dir = temp();
    try {
      readToken(join(dir, 'нет'));
      expect.unreachable();
    } catch (error) {
      expect((error as EndpointError).code).toBe('token-absent');
    }
    const empty = join(dir, 'empty');
    writeFileSync(empty, '   ');
    try {
      readToken(empty);
      expect.unreachable();
    } catch (error) {
      expect((error as EndpointError).code).toBe('token-unreadable');
    }
  });

  it('сравнение не выходит на первом различии', () => {
    expect(tokenMatches('abcd', 'abcd')).toBe(true);
    expect(tokenMatches('abcd', 'abce')).toBe(false);
    expect(tokenMatches('abcd', 'abc')).toBe(false);
  });
});

describe('clearStaleSocket — живой сокет не трогается', () => {
  it('отсутствующий сокет — не ошибка', async () => {
    await expect(clearStaleSocket(join(temp(), 'нет.sock'))).resolves.toBeUndefined();
  });

  it('мёртвый сокет снимается', async () => {
    const path = join(temp(), 'dead.sock');
    writeFileSync(path, '');
    await clearStaleSocket(path);
    expect(existsSync(path)).toBe(false);
  });

  it('живой сокет НЕ снимается: иначе у работающего демона уводятся соединения', async () => {
    const path = join(temp(), 'live.sock');
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, () => resolve()));
    await expect(clearStaleSocket(path)).rejects.toThrowError(EndpointError);
    expect(existsSync(path)).toBe(true);
  });
});

describe('длина пути сокета', () => {
  it('путь сверх sun_path отвергается ЯВНО, а не падает позже на chmod', () => {
    // Замерено на настоящем запуске: listen отрабатывает, колбэк вызывается, файла нет.
    const long = `/tmp/${'d'.repeat(120)}/mcpproxyd.sock`;
    expect(() => assertSocketPathFits(long)).toThrowError(EndpointError);
  });

  it('путь в потолок проходит', () => {
    expect(() => assertSocketPathFits('/tmp/mcpproxy/mcpproxyd.sock')).not.toThrow();
  });

  it('потолок считается в БАЙТАХ, а не в символах', () => {
    // `/tmp/` (5) + 50 кириллических (по 2 байта = 100) + `.sock` (5) = 110 байт при 60
    // символах. Считай мы символы — путь прошёл бы, а bind молча не создал бы файл.
    const cyrillic = `/tmp/${'я'.repeat(50)}.sock`;
    expect(cyrillic.length).toBe(60);
    expect(Buffer.byteLength(cyrillic, 'utf8')).toBe(110);
    expect(cyrillic.length).toBeLessThan(SOCKET_PATH_MAX_BYTES);
    expect(() => assertSocketPathFits(cyrillic)).toThrowError(EndpointError);
  });
});
