import { protocol } from 'electron';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { cspFor, type CspMode } from './csp.js';

export const APP_SCHEME = 'app';
export const APP_HOST = 'bundle';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Привилегии схемы.
 *
 * `corsEnabled` обязателен рядом с `supportFetchAPI`: схема, объявленная поддерживающей fetch
 * и не подпадающая под контроль CORS, — это CVE-2026-70604.
 *
 * `standard` обязателен отдельно, и не только ради непрозрачного origin: без него отключены
 * `localStorage`, `sessionStorage` и cookies, а относительные ссылки разрешаются как у
 * `file:` — то есть ломаются пути ассетов из сборки.
 */
export const APP_SCHEME_PRIVILEGES: Electron.Privileges = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
};

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const mimeOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return (dot >= 0 ? MIME[path.slice(dot)] : undefined) ?? 'application/octet-stream';
};

/**
 * Путь внутри бандла или `null`, если запрошенное лежит вне его.
 *
 * Проверка идёт **после** `realpath`, а не по строке: инвариант И3 этого же проекта прямо
 * говорит, что «строка не содержит две точки» защитой не является и обходится симлинком за
 * десять секунд. Применить это правило к демону и не применить к собственному загрузчику
 * рендерера — ровно тот случай, когда UI продукта становится аргументом против его тезиса.
 *
 * Стандартная схема нормализует точечные сегменты в URL, но процентное кодирование доживает
 * до обработчика, а `decodeURIComponent` ниже его раскрывает.
 */
export async function resolveBundlePath(requestPath: string, bundleRoot: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const root = await realpath(bundleRoot).catch(() => null);
  if (root === null) return null;

  const candidate = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
  // WHY: realpath бросает на несуществующем пути — это отказ, а не исключение наружу.
  const real = await realpath(candidate).catch(() => null);
  if (real === null) return null;

  return real === root || real.startsWith(root + sep) ? real : null;
}

/** Регистрируется ДО `app.whenReady()`; сам обработчик вешается после. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: APP_SCHEME_PRIVILEGES }]);
}

export function handleAppScheme(bundleRoot: string, mode: CspMode): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    // WHY: `protocol.handle` регистрируется на СХЕМУ целиком, поэтому `app://что-угодно/`
    // отдавало бы тот же бандл под другим origin — со своим `localStorage` и своим `'self'`
    // в CSP. `R3` выбирает стандартную схему именно ради сравнимого origin; сравнение должно
    // быть, а не подразумеваться.
    if (url.host !== APP_HOST) return new Response('not found', { status: 404 });

    const path = await resolveBundlePath(url.pathname, bundleRoot);
    if (path === null) return new Response('not found', { status: 404 });

    return new Response(await readFile(path), {
      headers: {
        'content-type': mimeOf(path),
        // WHY: политика доставляется ровно одним способом. Заголовок и <meta> ПЕРЕСЕКАЮТСЯ, а
        // не заменяют друг друга, и забытый тег молча ужесточил бы политику — ловить пришлось
        // бы фантом. Тега в index.html поэтому нет.
        'content-security-policy': cspFor(mode),
      },
    });
  });
}

export const bundleRootFor = (appPath: string): string => join(appPath, 'out', 'renderer');
