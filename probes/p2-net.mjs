import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

// Локальный "внешний" хост: слушаем на 127.0.0.1, но ходим по имени.
const srv = createServer((req, res) => { res.writeHead(200); res.end('OK-BODY'); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const seen = [];
await SandboxManager.initialize({
  network: {
    allowedDomains: ['example.com'],
    deniedDomains: [],
    filterRequest: async (request) => {
      const body = await request.arrayBuffer().catch(() => new ArrayBuffer(0));
      seen.push({ method: request.method, url: request.url, bodyBytes: body.byteLength });
      return { action: 'allow' };
    },
  },
  filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
}, undefined, true);

console.log('proxyPort:', SandboxManager.getProxyPort(), 'socks:', SandboxManager.getSocksProxyPort());
console.log('netRestriction:', JSON.stringify(SandboxManager.getNetworkRestrictionConfig()));

async function run(label, cmd, id) {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, undefined, undefined, '/tmp', { commandId: id });
  const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/tmp' });
  let o = '', e = '';
  c.stdout.on('data', d => { o += d; }); c.stderr.on('data', d => { e += d; });
  const code = await new Promise(r => c.on('close', r));
  console.log(`\n=== ${label} === exit=${code}`);
  console.log('stdout:', JSON.stringify(o.slice(0, 200)));
  console.log('stderr:', JSON.stringify(e.slice(0, 300)));
}

await run('ALLOWED example.com', 'curl -s -m 8 http://example.com/', 'id-allowed');
await run('DENIED evil.invalid', 'curl -s -m 8 http://evil.invalid/', 'id-denied');
await run('RAW SOCKET to loopback', `curl -s -m 5 http://127.0.0.1:${port}/`, 'id-loopback');

await new Promise(r => setTimeout(r, 2000));
console.log('\n--- filterRequest saw ---', JSON.stringify(seen, null, 2));
const store = SandboxManager.getSandboxViolationStore();
for (const id of ['id-allowed', 'id-denied', 'id-loopback']) {
  console.log(`\n--- violations[${id}] ---`, JSON.stringify(store.getViolationsForCommand(id), null, 2));
}
srv.close();
await SandboxManager.reset();
