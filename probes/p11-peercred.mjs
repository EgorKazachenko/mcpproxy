// Проба: отдаёт ли Node хоть чем-нибудь учётные данные пира unix-сокета (И6, LOCAL_PEERCRED).
import { createServer, connect } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'peercred-'));
const path = join(dir, 's.sock');

const server = createServer((sock) => {
  const own = Object.getOwnPropertyNames(sock);
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(sock));
  const all = [...own, ...proto];
  const hit = all.filter((k) => /peer|cred|uid|gid|pid/i.test(k));
  console.log('node', process.version);
  console.log('свойств у сокета:', all.length);
  console.log('совпавших по peer|cred|uid|gid|pid:', JSON.stringify(hit));
  console.log('sock.address():', JSON.stringify(sock.address()));
  console.log('remoteAddress:', JSON.stringify(sock.remoteAddress));
  console.log('_handle keys:', JSON.stringify(Object.getOwnPropertyNames(sock._handle ?? {}).filter((k) => /peer|cred|uid|gid|pid|fd/i.test(k))));
  server.close();
  sock.destroy();
});

server.listen(path, () => {
  const c = connect(path, () => c.end());
});
