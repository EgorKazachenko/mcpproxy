// П10 — третий ASSUMED плана §8: даёт ли filterRequest байты тела для HTTPS под tlsTerminate.
// От величины зависит цифра S5 («отправлено 1.2 KB»), а не только тест.
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';

const seen = [];
const base = { filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] } };
const net = {
  allowedDomains: ['example.com'],
  deniedDomains: [],
  strictAllowlist: true,
  tlsTerminate: {},
  filterRequest: async (request) => {
    let bodyBytes = 0;
    if (request.body !== null) {
      const reader = request.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bodyBytes += value.byteLength;
      }
    }
    seen.push({ url: request.url, method: request.method, bodyBytes, hasBody: request.body !== null });
    return { action: 'allow' };
  },
};
await SandboxManager.initialize({ network: net, ...base }, undefined, true);

async function run(label, cmd) {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, undefined, undefined, '/tmp', {
    commandId: label,
  });
  const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/tmp' });
  let o = '';
  c.stdout.on('data', (d) => { o += d; });
  let e = '';
  c.stderr.on('data', (d) => { e += d; });
  const code = await new Promise((r) => c.on('close', r));
  console.log(`${label.padEnd(28)} exit=${code} out=${JSON.stringify(o.slice(0, 40))} err=${JSON.stringify(e.slice(0, 120))}`);
}

const payload = 'x'.repeat(1234);
await run('POST http 1234b', `curl -s -m 15 -o /dev/null -w "%{http_code}" -X POST --data-binary '${payload}' http://example.com/`);
await run('POST https 1234b', `curl -s -m 15 -o /dev/null -w "%{http_code}" -X POST --data-binary '${payload}' https://example.com/`);
await new Promise((r) => setTimeout(r, 500));
console.log('\n--- filterRequest увидел ---');
for (const s of seen) console.log(JSON.stringify(s));
await SandboxManager.reset();
process.exit(0);
