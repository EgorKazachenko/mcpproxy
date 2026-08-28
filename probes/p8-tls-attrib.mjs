import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
const seen = [];
await SandboxManager.initialize({
  network: { allowedDomains: ['example.com'], deniedDomains: [], tlsTerminate: {},
    filterRequest: async (req) => {
      const h = []; req.headers.forEach((_v, k) => h.push(k));
      seen.push({ url: req.url, hasProxyAuth: h.includes('proxy-authorization'), headers: h });
      return { action: 'allow' };
    } },
  filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
}, undefined, true);
async function run(cmd, id) {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, undefined, undefined, '/tmp', { commandId: id });
  const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/tmp' });
  let o=''; c.stdout.on('data',d=>{o+=d;});
  const code = await new Promise(r => c.on('close', r));
  console.log(`${id.padEnd(12)} exit=${code} out=${JSON.stringify(o.slice(0,40))}`);
}
await run('curl -s -m 10 -o /dev/null -w "%{http_code}" http://example.com/', 'INVOC-HTTP');
await run('curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.com/', 'INVOC-HTTPS');
await new Promise(r => setTimeout(r, 800));
console.log('--- filterRequest увидел ---');
for (const x of seen) console.log(JSON.stringify(x));
await SandboxManager.reset(); process.exit(0);
