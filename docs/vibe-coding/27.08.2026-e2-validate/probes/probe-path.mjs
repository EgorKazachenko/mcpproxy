import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2probe-'));
const root = path.join(base, 'logs');
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'app.log'), 'x');
const outside = path.join(base, 'secret.txt');
fs.writeFileSync(outside, 'SECRET');

const say = (k, v) => console.log(`${String(k).padEnd(50)} ${v}`);
const RROOT = fs.realpathSync(root);

console.log('=== 1. realpath on a path that does not exist yet ===');
try { fs.realpathSync(path.join(root, 'new.log')); say('realpathSync(missing)', 'RETURNED'); }
catch (e) { say('realpathSync(missing)', 'THROWS ' + e.code); }
try { say('realpathSync(existing dir + missing leaf).dirname', fs.realpathSync(path.dirname(path.join(root, 'new.log')))); }
catch (e) { say('realpath(dirname)', 'THROWS ' + e.code); }

console.log('\n=== 2. file symlink escaping root ===');
const link = path.join(root, 'escape');
fs.symlinkSync(outside, link);
say('lexical path.resolve(link)', path.resolve(link));
say('realpathSync(link)', fs.realpathSync(link));
say('escapes root after realpath?', !fs.realpathSync(link).startsWith(RROOT + path.sep));

console.log('\n=== 3. DIRECTORY symlink + traversal through it ===');
const dlink = path.join(root, 'dl');
fs.symlinkSync(base, dlink);
const through = path.join(root, 'dl', 'secret.txt');
say('lexical resolve', path.resolve(through));
say('lexical startsWith(root)? (i.e. naive PASSES)', path.resolve(through).startsWith(root + path.sep));
say('realpath', fs.realpathSync(through));
say('startsWith(root) after realpath?', fs.realpathSync(through).startsWith(RROOT + path.sep));

console.log('\n=== 4. prefix-sibling trap: /logs vs /logs-evil ===');
const evil = path.join(base, 'logs-evil');
fs.mkdirSync(evil); fs.writeFileSync(path.join(evil, 'a'), 'x');
const p = fs.realpathSync(path.join(evil, 'a'));
say('naive startsWith(root) WITHOUT sep', p.startsWith(RROOT));
say('startsWith(root + sep)', p.startsWith(RROOT + path.sep));
const rel = path.relative(RROOT, p);
say('path.relative', JSON.stringify(rel));
say('relative-based verdict says safe?', !(rel === '' || rel.startsWith('..') || path.isAbsolute(rel)));

console.log('\n=== 5. macOS case-insensitivity ===');
say('exists LOGS/APP.LOG ?', fs.existsSync(path.join(base, 'LOGS', 'APP.LOG')));
try { say('realpath(LOGS/APP.LOG)', fs.realpathSync(path.join(base, 'LOGS', 'APP.LOG'))); }
catch (e) { say('realpath(LOGS/APP.LOG)', 'THROWS ' + e.code); }

console.log('\n=== 6. unicode normalization NFC vs NFD ===');
const nfc = 'caf' + String.fromCharCode(0xe9) + '.log';
const nfd = 'cafe' + String.fromCharCode(0x301) + '.log';
say('NFC === NFD as JS strings', nfc === nfd);
fs.writeFileSync(path.join(root, nfc), 'x');
say('wrote NFC; exists() under NFD?', fs.existsSync(path.join(root, nfd)));
const listed = fs.readdirSync(root).find((f) => f.startsWith('caf'));
say('readdir returns', listed === nfc ? 'NFC' : listed === nfd ? 'NFD' : JSON.stringify(listed));
try { say('realpath(NFD) returns', JSON.stringify(path.basename(fs.realpathSync(path.join(root, nfd))))); }
catch (e) { say('realpath(NFD)', 'THROWS ' + e.code); }

console.log('\n=== 7. hostile characters in a path value ===');
const cases = [
  ['NUL', 'a' + String.fromCharCode(0) + 'b'],
  ['newline', 'a' + String.fromCharCode(10) + 'b'],
  ['dotdot', '..' + path.sep + 'secret.txt'],
  ['absolute', '/etc/passwd'],
  ['empty', ''],
];
for (const [name, val] of cases) {
  let joined;
  try { joined = path.join(root, val); } catch (e) { say('path.join(' + name + ')', 'THROWS ' + e.code); continue; }
  say('path.join(' + name + ') ->', JSON.stringify(joined));
  try { fs.realpathSync(joined); say('  realpath', 'RETURNED'); }
  catch (e) { say('  realpath', 'THROWS ' + e.code); }
}

console.log('\n=== 8. is the root itself a symlink? (tmpdir on macOS) ===');
say('os.tmpdir()', os.tmpdir());
say('realpath(os.tmpdir())', fs.realpathSync(os.tmpdir()));
say('root as given', root);
say('realpath(root)', RROOT);
say('UNRESOLVED root would break startsWith', root !== RROOT);

console.log('\n=== 9. TOCTOU: swap file for symlink after resolve ===');
const t = path.join(root, 'toctou.log');
fs.writeFileSync(t, 'x');
const resolved = fs.realpathSync(t);
say('resolved (confined)', resolved.startsWith(RROOT + path.sep));
fs.unlinkSync(t);
fs.symlinkSync(outside, t);
say('after swap, realpath(same input)', fs.realpathSync(t));
say('resolved STRING still points where?', fs.readFileSync(resolved, 'utf8').trim());

fs.rmSync(base, { recursive: true, force: true });
