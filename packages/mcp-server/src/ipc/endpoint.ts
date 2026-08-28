import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Каталог, сокет и токен. Каталог — тот же, что у журнала аудита E6, и права те же `0700`:
 * два разных каталога под одну установку разъезжаются, а `MCPPROXY_HOME` уже определён как
 * точка переопределения (`packages/core/src/audit/log.ts:61`).
 */
export const SOCKET_FILE = 'mcpproxyd.sock';
export const TOKEN_FILE = 'mcpproxyd.token';

export function runtimeDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = env.MCPPROXY_HOME;
  return home === undefined || home === '' ? join(homedir(), '.mcpproxy') : home;
}

export const socketPath = (env?: Readonly<Record<string, string | undefined>>): string => join(runtimeDir(env), SOCKET_FILE);
export const tokenPath = (env?: Readonly<Record<string, string | undefined>>): string => join(runtimeDir(env), TOKEN_FILE);

/**
 * Потолок длины пути unix-сокета. `sun_path` в `struct sockaddr_un` — 104 байта на macOS и
 * 108 на Linux, минус завершающий ноль; берётся меньший из двух.
 *
 * Проверка нужна потому, что превышение **не даёт внятной ошибки**: `listen` отрабатывает,
 * колбэк вызывается, а файла по пути нет, и первым падает следующий шаг — у нас это был
 * `chmod` с ENOENT на путь, который мы только что «успешно» слушали. Замерено на настоящем
 * запуске демона в каталоге с длинным путём.
 */
export const SOCKET_PATH_MAX_BYTES = 103;

export class EndpointError extends Error {
  readonly code: 'insecure-directory' | 'socket-busy' | 'socket-path-too-long' | 'socket-unprotected' | 'token-absent' | 'token-unreadable';
  constructor(code: EndpointError['code'], message: string) {
    super(message);
    this.name = 'EndpointError';
    this.code = code;
  }
}

/**
 * Каталог создаётся `0700` и **проверяется после создания**, а не вместо: `mkdir` с готовым
 * каталогом режима не меняет, поэтому каталог, оставшийся от прежней установки с правами для
 * группы, прошёл бы создание молча. Симметрично `insecure-directory` журнала аудита.
 *
 * Права каталога здесь несут ту же нагрузку, что в доках нёс peer-cred: чужой uid не проходит
 * даже резолв пути к сокету. См. `docs/10-honest-limitations.md`.
 */
export function ensureRuntimeDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = statSync(dir).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new EndpointError('insecure-directory', `каталог доступен группе или другим (${mode.toString(8)}): ${dir}`);
  }
}

export function assertSocketPathFits(path: string): void {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > SOCKET_PATH_MAX_BYTES) {
    throw new EndpointError(
      'socket-path-too-long',
      `путь сокета ${bytes} байт при потолке ${SOCKET_PATH_MAX_BYTES}: ${path}`,
    );
  }
}

export const TOKEN_BYTES = 32;

/** Токен живёт в файле `0600` рядом с сокетом: не в конфиге и не в argv шима (И6). */
export function issueToken(path: string): string {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const fd = openSync(path, 'w', 0o600);
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return token;
}

export function readToken(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') throw new EndpointError('token-absent', `токен не найден: ${path}`);
    throw new EndpointError('token-unreadable', `токен не читается (${code ?? 'неизвестно'}): ${path}`);
  }
  const token = text.trim();
  if (token === '') throw new EndpointError('token-unreadable', `токен пуст: ${path}`);
  return token;
}

/**
 * Сравнение токена постоянного времени. `===` на строках выходит на первом различающемся
 * байте, и по времени ответа токен подбирается побайтово — атака дешёвая ровно потому, что
 * сокет локальный и попыток можно сделать сколько угодно.
 */
export function tokenMatches(expected: string, given: string): boolean {
  if (expected.length !== given.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/**
 * Стоячий сокет от прошлого запуска. Снимается ТОЛЬКО после того, как выяснилось, что никто
 * не слушает: удалить живой сокет значит увести соединения у работающего демона, который в
 * это время исполняет чужой рецепт.
 */
export async function clearStaleSocket(path: string): Promise<void> {
  const exists = ((): boolean => {
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  })();
  if (!exists) return;

  const listening = await new Promise<boolean>((resolve) => {
    const probe = connect(path);
    const done = (answer: boolean): void => {
      probe.destroy();
      resolve(answer);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });

  if (listening) throw new EndpointError('socket-busy', `демон уже слушает ${path}`);
  unlinkSync(path);
}
