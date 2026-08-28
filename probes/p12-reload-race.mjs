import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStore } from '@mcpproxy/core';

const M = (extra) => `version: 1
defaults:
  timeout: 30s
  output: { maxBytes: 65536, redact: true }
  env: { allow: ["PATH"] }
  sandbox:
    read: { allow: ["."] }
    write: { allow: [] }
    network: { allow: [] }
tools:
  run_ok:
    description: "Тихий"
    exec: ["./ok.sh"]
    annotations: { readOnlyHint: true }
${extra}`;

const SECOND = `  second:
    description: "Второй"
    exec: ["./ok.sh"]
    annotations: { readOnlyHint: true }
`;

const dir = mkdtempSync(join(tmpdir(), 'race-'));
const manifestPath = join(dir, 'mcpproxy.yaml');
writeFileSync(manifestPath, M(''));

// Подставная ФС: чтение B задерживается так, что оно происходит ДО записи нового манифеста,
// а чтение A — после. Оба вызова стартуют в порядке A, B, то есть B столбит номер поколения 2.
let call = 0;
const real = (await import('node:fs/promises')).readFile;
const deps = {
  statSize: async (p) => (await (await import('node:fs/promises')).stat(p)).size,
  readFile: async (p, limit) => {
    call += 1;
    const mine = call;
    if (mine === 2) await new Promise((r) => setTimeout(r, 30));       // A читает поздно
    if (mine === 3) { /* B читает сразу */ }
    return (await real(p, 'utf8')).slice(0, limit + 1);
  },
};

const started = await startStore(manifestPath, join(dir, 'mcpproxy.lock'), deps);
if (started.outcome !== 'started') { console.error(started); process.exit(1); }
const store = started.store;
console.log('инструментов на старте:', Object.keys(store.current().manifest.manifest.tools).length);

const a = store.reloadManifest();            // поколение 1, чтение задержано на 30 мс
await new Promise((r) => setTimeout(r, 5));
const b = store.reloadManifest();            // поколение 2, читает немедленно — СТАРОЕ содержимое
await new Promise((r) => setTimeout(r, 5));
writeFileSync(manifestPath, M(SECOND));      // новое содержимое появляется между чтениями
await Promise.all([a, b]);

const tools = Object.keys(store.current().manifest.manifest.tools);
console.log('инструментов после двух перечиток:', tools.length, JSON.stringify(tools));
console.log('на диске:', Object.keys({ run_ok: 1, second: 1 }).length);
console.log(tools.length === 2 ? 'ОК — обновление применилось' : 'ПОТЕРЯ ОБНОВЛЕНИЯ: current() старее диска');
