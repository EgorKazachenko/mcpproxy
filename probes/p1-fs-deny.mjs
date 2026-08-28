import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'p1-'));
const secret = path.join(dir, 'secret.txt');
writeFileSync(secret, 'TOPSECRET\n');

await SandboxManager.initialize({
  network: { allowedDomains: [], deniedDomains: [] },
  filesystem: { denyRead: [secret], allowWrite: [dir], denyWrite: [] },
}, undefined, true);

console.log('isSupportedPlatform:', SandboxManager.isSupportedPlatform());
console.log('isSandboxingEnabled:', SandboxManager.isSandboxingEnabled());
console.log('deps:', JSON.stringify(SandboxManager.checkDependencies()));

const commandId = 'probe-trace-0001';
const { argv, env } = await SandboxManager.wrapWithSandboxArgv(
  `cat ${secret}`, undefined, undefined, undefined, dir, { commandId },
);

console.log('--- argv[0] ---'); console.log(argv[0]);
console.log('--- argv.length ---', argv.length);
console.log('--- argv[1] ---'); console.log(argv[1]);
console.log('--- argv[2] (first 600 chars) ---'); console.log(String(argv[2]).slice(0, 600));
console.log('--- env identical to process.env? ---', env === process.env);

const child = spawn(argv[0], argv.slice(1), { shell: false, env, cwd: dir });
let out = '', err = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { err += d; });
const code = await new Promise(r => child.on('close', r));

console.log('--- exit code ---', code);
console.log('--- stdout ---', JSON.stringify(out));
console.log('--- stderr ---', JSON.stringify(err.slice(0, 400)));

await new Promise(r => setTimeout(r, 2500));
const store = SandboxManager.getSandboxViolationStore();
console.log('--- total violations ---', store.getTotalCount());
console.log('--- byCommandId ---', JSON.stringify(store.getViolationsForCommand(commandId), null, 2));
console.log('--- all violations ---', JSON.stringify(store.getViolations(10), null, 2));
SandboxManager.cleanupAfterCommand();
await SandboxManager.reset();
