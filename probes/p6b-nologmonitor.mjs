import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'p6b-')); const secret = path.join(dir, 's.txt');
writeFileSync(secret, 'x\n');
// enableLogMonitor НЕ передан — дефолт
await SandboxManager.initialize({ network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [secret], allowWrite: [dir], denyWrite: [] } });
const { argv, env } = await SandboxManager.wrapWithSandboxArgv(`cat ${secret}`, undefined, undefined, undefined, dir, { commandId: 'x' });
const c = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: dir });
let e = ''; c.stderr.on('data', d => { e += d; });
const code = await new Promise(r => c.on('close', r));
await new Promise(r => setTimeout(r, 4000));
console.log(`БЕЗ enableLogMonitor: чтение отказано=${code !== 0} (${JSON.stringify(e.trim().slice(0,50))}), нарушений в сторе=${SandboxManager.getSandboxViolationStore().getTotalCount()}`);
await SandboxManager.reset(); process.exit(0);
