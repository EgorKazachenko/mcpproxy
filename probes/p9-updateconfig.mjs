import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
const base = { filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] } };
await SandboxManager.initialize({ network: { allowedDomains: ['example.com'], deniedDomains: [] }, ...base }, undefined, true);

async function run(label, cmd, id) {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, undefined, undefined, '/tmp', { commandId: id });
  const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/tmp' });
  let o=''; c.stdout.on('data',d=>{o+=d;});
  const code = await new Promise(r => c.on('close', r));
  console.log(`${label.padEnd(46)} exit=${code} out=${JSON.stringify(o.slice(0,26))}`);
}
console.log('=== HTTPS под updateConfig ===');
await run('allow=[example.com] → https://example.com', 'curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.com/', 'a');
SandboxManager.updateConfig({ network: { allowedDomains: ['example.org'], deniedDomains: [] }, ...base });
await run('allow=[example.org] → https://example.com', 'curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.com/', 'b');
SandboxManager.updateConfig({ network: { allowedDomains: [], deniedDomains: [] }, ...base });
await run('allow=[]           → https://example.com', 'curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.com/', 'c');
console.log('\n=== сырой TCP (не HTTP) под updateConfig ===');
SandboxManager.updateConfig({ network: { allowedDomains: ['example.com'], deniedDomains: [] }, ...base });
await run('allow=[example.com] → nc example.com 443', 'sh -c "echo | nc -w 5 example.com 443 >/dev/null 2>&1; echo rc=$?"', 'd');
SandboxManager.updateConfig({ network: { allowedDomains: [], deniedDomains: [] }, ...base });
await run('allow=[]           → nc example.com 443', 'sh -c "echo | nc -w 5 example.com 443 >/dev/null 2>&1; echo rc=$?"', 'e');
await new Promise(r => setTimeout(r, 800));
const st = SandboxManager.getSandboxViolationStore();
console.log('\n--- сетевые нарушения ---');
for (const v of st.getViolations(30)) if (v.line.includes('network-outbound')) console.log(' ', v.line, '|', v.encodedCommand);
await SandboxManager.reset(); process.exit(0);
