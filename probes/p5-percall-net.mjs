import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';

// Демон разрешает example.com.
await SandboxManager.initialize({
  network: { allowedDomains: ['example.com'], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
}, undefined, true);

async function run(label, cmd, id, customConfig) {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, customConfig, undefined, '/tmp', { commandId: id });
  const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/tmp' });
  let o = ''; c.stdout.on('data', d => { o += d; });
  const code = await new Promise(r => c.on('close', r));
  const blocked = o.includes('blocked by network allowlist');
  console.log(`${label.padEnd(52)} exit=${code} blocked=${blocked}`);
}

console.log('=== BLOCKER 1: перебивает ли customConfig сетевую политику демона? ===');
await run('без customConfig (демон разрешил example.com)', 'curl -s -m 8 http://example.com/', 'a', undefined);
await run('customConfig.network.allowedDomains = []', 'curl -s -m 8 http://example.com/', 'b',
          { network: { allowedDomains: [], deniedDomains: [] } });
await run('customConfig.network.deniedDomains = [example.com]', 'curl -s -m 8 http://example.com/', 'c',
          { network: { allowedDomains: [], deniedDomains: ['example.com'] } });

console.log('\n=== BLOCKER 2: задержка появления violation после выхода процесса ===');
const t0 = Date.now();
const { argv, env } = await SandboxManager.wrapWithSandboxArgv('curl -s -m 8 http://evil.invalid/', undefined, undefined, undefined, '/tmp', { commandId: 'lag' });
const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/tmp' });
await new Promise(r => c.on('close', r));
const tExit = Date.now() - t0;
const store = SandboxManager.getSandboxViolationStore();
let tFound = null;
for (let i = 0; i < 100; i++) {
  if (store.getViolationsForCommand('lag').some(v => v.line.includes('network-outbound'))) { tFound = Date.now() - t0; break; }
  await new Promise(r => setTimeout(r, 100));
}
console.log(`процесс завершился на ${tExit} мс, сетевое нарушение появилось на ${tFound} мс (лаг ${tFound === null ? 'НЕ ПОЯВИЛОСЬ' : tFound - tExit + ' мс после выхода'})`);

console.log('\n=== BLOCKER 7: enableLogMonitor по умолчанию ===');
await SandboxManager.reset();
await SandboxManager.initialize({
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: ['/etc/hosts'], allowWrite: ['/tmp'], denyWrite: [] },
});  // третий аргумент НЕ передан
const w = await SandboxManager.wrapWithSandboxArgv('cat /etc/hosts', undefined, undefined, undefined, '/tmp', { commandId: 'nolog' });
const c2 = spawn(w.argv[0], w.argv.slice(1), { shell: false, env: w.env, cwd: '/tmp' });
let err2 = ''; c2.stderr.on('data', d => { err2 += d; });
const code2 = await new Promise(r => c2.on('close', r));
await new Promise(r => setTimeout(r, 3000));
console.log(`чтение отказано: ${code2 !== 0} (stderr: ${JSON.stringify(err2.trim().slice(0,60))})`);
console.log(`нарушений в сторе: ${SandboxManager.getSandboxViolationStore().getTotalCount()}`);
await SandboxManager.reset();
