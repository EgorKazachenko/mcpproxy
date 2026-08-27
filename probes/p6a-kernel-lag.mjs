import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'p6a-')); const secret = path.join(dir, 's.txt');
writeFileSync(secret, 'x\n');
await SandboxManager.initialize({ network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [secret], allowWrite: [dir], denyWrite: [] } }, undefined, true);
const t0 = Date.now();
const { argv, env } = await SandboxManager.wrapWithSandboxArgv(`cat ${secret}`, undefined, undefined, undefined, dir, { commandId: 'lag' });
const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: dir });
await new Promise(r => c.on('close', r));
const tExit = Date.now() - t0;
let tFound = null;
for (let i = 0; i < 150; i++) {
  if (SandboxManager.getSandboxViolationStore().getViolationsForCommand('lag').some(v => v.line.includes('file-read-data'))) { tFound = Date.now() - t0; break; }
  await new Promise(r => setTimeout(r, 50));
}
console.log(`ЯДЕРНОЕ нарушение: выход ${tExit} мс, найдено ${tFound} мс, лаг после выхода ${tFound === null ? 'НЕ ПОЯВИЛОСЬ за 7.5с' : (tFound - tExit) + ' мс'}`);
await SandboxManager.reset(); process.exit(0);
