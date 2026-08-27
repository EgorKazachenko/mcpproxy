import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const say = (k, v) => console.log(`${String(k).padEnd(34)} ${v}`);

console.log('=== A. String.replace трактует $-последовательности в ЗАМЕНЕ ===');
const cases = [
  ['--file={}', '/root/a$`b'],
  ['{}', "/root/a$'b"],
  ['{}', '/root/a$&b'],
  ['{}', '/root/a$$b'],
  ['--x={}', '/root/plain'],
];
for (const [tpl, val] of cases) {
  const naive = tpl.replace('{}', val);
  const safe = tpl.split('{}').join(val);
  const fn = tpl.replace('{}', () => val);
  say(`replace  ${JSON.stringify(tpl)} + ${JSON.stringify(val)}`, JSON.stringify(naive));
  say('  split/join', JSON.stringify(safe));
  say('  replace(fn)', JSON.stringify(fn));
  say('  наивный == безопасный?', naive === safe);
}

console.log('\n=== A2. легален ли $ в имени файла ===');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2r4-'));
const root = fs.realpathSync(base);
const dollarName = "a$'b.log";
fs.writeFileSync(path.join(root, dollarName), 'x');
say('файл создан', fs.existsSync(path.join(root, dollarName)));
const resolved = fs.realpathSync(path.join(root, dollarName));
say('realpath', resolved);
say('argv наивно', JSON.stringify('{}'.replace('{}', resolved)));
say('argv безопасно', JSON.stringify('{}'.split('{}').join(resolved)));
say('совпадают?', '{}'.replace('{}', resolved) === resolved);

console.log('\n=== B. MAJOR-1: схлопнут ли оракул при симлинке ВНУТРИ root ===');
const inside = (r, c) => {
  const rel = path.relative(r, c);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
const decide = (value) => {
  const cand = path.resolve(root, value);
  const preOk = inside(root, cand);
  let res;
  try {
    res = fs.realpathSync(cand);
  } catch (e) {
    return { preOk, code: preOk ? (e.code === 'ENOENT' ? 'path-not-found' : 'path-unusable') : 'path-escapes-root' };
  }
  if (!inside(root, res)) return { preOk, code: 'path-escapes-root', shown: res };
  return { preOk, ok: true };
};

fs.symlinkSync('/etc/passwd', path.join(root, 'probe-exists'));
fs.symlinkSync('/etc/definitely-not-here', path.join(root, 'probe-missing'));
for (const [label, v] of [
  ['лексический обход, цель есть', '../../../../etc/passwd'],
  ['лексический обход, цели нет', '../../../../etc/nope'],
  ['СИМЛИНК внутри root -> есть', 'probe-exists'],
  ['СИМЛИНК внутри root -> нет', 'probe-missing'],
]) {
  const r = decide(v);
  say(label, `preOk=${r.preOk}  ${r.ok ? 'ПРИНЯТ' : r.code}`);
}
console.log('  Лексические обходы дают один код => та спелляция закрыта.');
console.log('  Симлинк внутри root лексически ВНУТРИ, preOk=true, коды снова различаются.');

console.log('\n=== C. утечка через ТЕКСТ причины ===');
const a = decide('probe-exists');
say('показанный путь при escape', a.shown ?? '(нет)');
say('=> текст называет цель, не границу', Boolean(a.shown));

fs.rmSync(base, { recursive: true, force: true });
