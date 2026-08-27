import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : process.argv[i + 1]; };
const dir = arg('path');
const minAgeMinutes = Number(arg('max-age-minutes') ?? 240);
const minFiles = Number(arg('min-files') ?? 1);

if (!dir) { console.error('verify-evidence: --path is required'); process.exit(1); }
if (!existsSync(dir)) {
  console.error(`verify-evidence: ${dir} does not exist — the harness did not run, or wrote elsewhere`);
  process.exit(1);
}

const cutoff = Date.now() - minAgeMinutes * 60000;
const files = [];
const walk = (p) => {
  const st = statSync(p);
  if (st.isDirectory()) { for (const c of readdirSync(p)) walk(join(p, c)); return; }
  files.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
};
walk(dir);

const fresh = files.filter((f) => f.mtimeMs >= cutoff && f.size > 0);
if (fresh.length < minFiles) {
  console.error(`verify-evidence: ${dir} holds ${files.length} file(s) but only ${fresh.length} fresh non-empty — needed ${minFiles}`);
  console.error('A stale folder is not evidence: re-run the harness.');
  process.exit(1);
}
console.log(`verify-evidence: ${fresh.length} fresh file(s) in ${dir}`);
