import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const say = (k, v) => console.log(`${String(k).padEnd(38)} ${v}`);

const inside = (r, c) => {
  const rel = path.relative(r, c);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2case-'));
const root = path.join(base, 'logs');
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'a.log'), 'x');
const realRoot = fs.realpathSync(root);

console.log('=== регистр КОРНЕВОГО сегмента ===');
const upperRootValue = path.join(base, 'LOGS', 'a.log');
say('запрошено', upperRootValue);
say('файл доступен?', fs.existsSync(upperRootValue));
const resolvedUpper = fs.realpathSync(upperRootValue);
say('realpath вернул', resolvedUpper);
say('realRoot', realRoot);
say('path.relative(realRoot, resolved)', JSON.stringify(path.relative(realRoot, resolvedUpper)));
say('confinement пропускает?', inside(realRoot, resolvedUpper) ? 'да' : 'НЕТ — ложный отказ');

console.log('\n=== регистр ЛИСТА ===');
const upperLeaf = path.join(root, 'A.LOG');
say('запрошено', upperLeaf);
say('файл доступен?', fs.existsSync(upperLeaf));
const resolvedLeaf = fs.realpathSync(upperLeaf);
say('realpath вернул', resolvedLeaf);
say('confinement пропускает?', inside(realRoot, resolvedLeaf) ? 'да' : 'НЕТ');

const audit = await import('@mcpproxy/contracts/audit');
say('argsHash(a.log) === argsHash(A.LOG)?',
  audit.argsHash('r', { f: fs.realpathSync(path.join(root, 'a.log')) }) === audit.argsHash('r', { f: resolvedLeaf }));

console.log('\n=== Ф10: absolute под join против resolve ===');
say('path.join(root, "/etc/passwd")', path.join(realRoot, '/etc/passwd'));
say('path.resolve(root, "/etc/passwd")', path.resolve(realRoot, '/etc/passwd'));
say('resolve уходит за root?', !inside(realRoot, path.resolve(realRoot, '/etc/passwd')));

fs.rmSync(base, { recursive: true, force: true });
