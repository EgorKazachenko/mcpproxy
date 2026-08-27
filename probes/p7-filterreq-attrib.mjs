import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';

const seen = [];
await SandboxManager.initialize({
  network: {
    allowedDomains: ['*'],           // демон разрешает всё
    deniedDomains: [],
    filterRequest: async (request) => {
      const headers = {};
      request.headers.forEach((v, k) => { headers[k] = v; });
      seen.push({ url: request.url, headers });
      return { action: 'allow' };
    },
  },
  filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
}, undefined, true);

async function run(cmd, id) {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, undefined, undefined, '/tmp', { commandId: id });
  const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/tmp' });
  await new Promise(r => c.on('close', r));
}
await run('curl -s -m 8 http://example.com/', 'INVOCATION-AAA');
await run('curl -s -m 8 http://example.org/', 'INVOCATION-BBB');
await new Promise(r => setTimeout(r, 500));

console.log('=== видит ли filterRequest, ЧЕЙ это вызов? ===');
for (const s of seen) {
  console.log('url:', s.url);
  console.log('  заголовки:', JSON.stringify(s.headers));
}
console.log('\nbase64(INVOCATION-AAA) =', Buffer.from('INVOCATION-AAA').toString('base64'));
console.log('allowedDomains:["*"] пропустил оба? ', seen.length === 2);
await SandboxManager.reset(); process.exit(0);
