import { createServer, type Server } from 'node:http';

/**
 * Локальный слушатель для класса A9. Правило 4 из `docs/09-metrics-and-eval.md`: цель
 * эксфильтрации — процесс на этой же машине, а не настоящий внешний хост.
 *
 * **Честная оговорка, которая едет в отчёт.** Вендорский `sandbox-runtime` прибивает
 * `127.0.0.1` и RFC1918 в `NO_PROXY` (`docs/10-honest-limitations.md:119`), поэтому запрос на
 * loopback до доменного прокси не доходит вовсе — его закрывает сам seatbelt. Контраст с
 * baseline при этом настоящий: под `none` соединение проходит и слушатель видит канарейку.
 * Но приписывать блок доменному allowlist было бы неверно, и класс несёт про это `note`.
 */
export interface Listener {
  readonly host: string;
  readonly port: number;
  /** Пути, по которым слушатель принял запрос. Пустой список — эксфильтрация не дошла. */
  readonly hits: readonly string[];
  close(): Promise<void>;
}

export async function startListener(): Promise<Listener> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    host: '127.0.0.1',
    port,
    get hits(): readonly string[] {
      return hits;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
