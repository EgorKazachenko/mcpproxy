import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn, execSync } from 'node:child_process';

await SandboxManager.initialize({
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: ['/tmp'], denyWrite: [] },
}, undefined, true);

// Дерево: обёртка порождает трёх долгоживущих потомков и ждёт.
const marker = 'P4MARKER';
const cmd = `sh -c 'sleep 300 & sleep 300 & sleep 300 & echo ${marker}-STARTED; wait'`;
const { argv, env } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, undefined, undefined, '/tmp', { commandId: 'kill' });

console.log('--- БЕЗ detached: kill только по pid ---');
const a = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/tmp' });
await new Promise(r => a.stdout.on('data', d => String(d).includes(marker) && r()));
a.kill('SIGKILL');
await new Promise(r => setTimeout(r, 600));
let survivors = execSync(`pgrep -f "sleep 300" | wc -l`).toString().trim();
console.log('выживших sleep после kill(pid):', survivors);
execSync('pkill -f "sleep 300" || true');
await new Promise(r => setTimeout(r, 300));

console.log('\n--- С detached: kill по группе ---');
const b = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: '/tmp', detached: true });
await new Promise(r => b.stdout.on('data', d => String(d).includes(marker) && r()));
process.kill(-b.pid, 'SIGKILL');
await new Promise(r => setTimeout(r, 600));
survivors = execSync(`pgrep -f "sleep 300" | wc -l`).toString().trim();
console.log('выживших sleep после kill(-pgid):', survivors);
execSync('pkill -f "sleep 300" || true');

console.log('\n--- поведение потока при обрыве чтения (cap) ---');
const big = await SandboxManager.wrapWithSandboxArgv(
  `sh -c 'yes ABCDEFGH | head -c 5000000'`, undefined, undefined, undefined, '/tmp', { commandId: 'cap' });
const c = spawn(big.argv[0], big.argv.slice(1), { shell: false, env: big.env, cwd: '/tmp', detached: true });
let got = 0, destroyedAt = 0;
c.stdout.on('data', d => {
  got += d.length;
  if (got >= 65536 && !destroyedAt) { destroyedAt = got; c.stdout.destroy(); try { process.kill(-c.pid, 'SIGKILL'); } catch {} }
});
const code = await new Promise(r => c.on('close', r));
console.log('прочитано байт до обрыва:', got, '| порог сработал на:', destroyedAt, '| exit:', code);
await SandboxManager.reset();
