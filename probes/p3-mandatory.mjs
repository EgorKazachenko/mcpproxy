import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'p3-'));
mkdirSync(path.join(dir, '.git/hooks'), { recursive: true });
writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\n');
writeFileSync(path.join(dir, '.zshrc'), '# rc\n');
writeFileSync(path.join(dir, 'ordinary.txt'), 'plain\n');

// allowWrite на ВЕСЬ каталог — то есть явное разрешение, которое mandatory deny обязан перебить.
await SandboxManager.initialize({
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [], allowWrite: [dir], denyWrite: [] },
}, undefined, true);

async function attempt(label, cmd, id) {
  const { argv, env } = await SandboxManager.wrapWithSandboxArgv(cmd, undefined, undefined, undefined, dir, { commandId: id });
  const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: dir });
  let e = '';
  c.stderr.on('data', d => { e += d; });
  const code = await new Promise(r => c.on('close', r));
  console.log(`${label.padEnd(34)} exit=${code}  stderr=${JSON.stringify(e.trim().slice(0, 120))}`);
}

console.log('--- запись при allowWrite на весь каталог ---');
await attempt('ordinary.txt (ожидаем успех)', `sh -c 'echo x >> ${dir}/ordinary.txt'`, 'w-ok');
await attempt('.git/hooks/pre-commit', `sh -c 'echo x >> ${dir}/.git/hooks/pre-commit'`, 'w-hooks');
await attempt('.zshrc в каталоге', `sh -c 'echo x >> ${dir}/.zshrc'`, 'w-zshrc');
await attempt('~/.zshrc настоящий', `sh -c 'echo x >> ${homedir()}/.zshrc'`, 'w-home-zshrc');

await new Promise(r => setTimeout(r, 2000));
const store = SandboxManager.getSandboxViolationStore();
for (const id of ['w-ok', 'w-hooks', 'w-zshrc', 'w-home-zshrc']) {
  const v = store.getViolationsForCommand(id).filter(x => !/sysctl-read|mach-lookup/.test(x.line));
  console.log(`\n[${id}]`, JSON.stringify(v.map(x => x.line), null, 2));
}
await SandboxManager.reset();
