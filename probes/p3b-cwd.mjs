import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'p3b-'));
mkdirSync(path.join(dir, '.git/hooks'), { recursive: true });
writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\n');
writeFileSync(path.join(dir, '.zshrc'), '# rc\n');

// КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ p3: меняем cwd демона ДО initialize.
process.chdir(dir);
console.log('process.cwd() демона =', process.cwd());

const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime');
const { spawn } = await import('node:child_process');

await SandboxManager.initialize({
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [dir], denyWrite: [] },
}, undefined, true);

async function attempt(label, cmd, id) {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, undefined, undefined, dir, { commandId: id });
  const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: dir });
  let e = ''; c.stderr.on('data', d => { e += d; });
  const code = await new Promise(r => c.on('close', r));
  console.log(`${label.padEnd(30)} exit=${code}  stderr=${JSON.stringify(e.trim().slice(0, 110))}`);
}

await attempt('.git/hooks/pre-commit', `sh -c 'echo x >> ${dir}/.git/hooks/pre-commit'`, 'h');
await attempt('.zshrc', `sh -c 'echo x >> ${dir}/.zshrc'`, 'z');
await attempt('ordinary.txt', `sh -c 'echo x >> ${dir}/ordinary.txt'`, 'o');

await new Promise(r => setTimeout(r, 1800));
const store = SandboxManager.getSandboxViolationStore();
for (const id of ['h', 'z', 'o']) {
  const v = store.getViolationsForCommand(id).filter(x => !/sysctl-read|mach-lookup/.test(x.line));
  console.log(`[${id}]`, JSON.stringify(v.map(x => x.line)));
}
await SandboxManager.reset();
