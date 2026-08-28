import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const say = (k, v) => console.log(`${String(k).padEnd(40)} ${v}`);

const inside = (root, cand) => {
  const rel = path.relative(root, cand);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2r3-'));
const lexRoot = path.join(base, 'logs');
fs.mkdirSync(lexRoot);
fs.writeFileSync(path.join(lexRoot, 'a.log'), 'x');
const realRoot = fs.realpathSync(lexRoot);

console.log('=== A. зеркальный дефект: ЛЕКСИЧЕСКАЯ форма против РЕЗОЛВНУТОГО корня ===');
const lexValue = path.join(lexRoot, 'a.log');
say('root в форме манифеста', lexRoot);
say('realpath(root)', realRoot);
say('законное значение (лексич. форма)', lexValue);
say('relative(realRoot, значение)', JSON.stringify(path.relative(realRoot, path.resolve(realRoot, lexValue))));
say('ПРЕДПРОВЕРКА (шаг 3)', inside(realRoot, path.resolve(realRoot, lexValue)) ? 'пропустила' : 'ОТКАЗ (ложный!)');
say('realpath(кандидат)', fs.realpathSync(lexValue));
say('пост-проверка (шаг 5)', inside(realRoot, fs.realpathSync(lexValue)) ? 'пропустила => путь ЗАКОННЫЙ' : 'отказ');

console.log('\n=== B. общий случай: законный файл ВНУТРИ root через симлинк ===');
const alias = path.join(base, 'alias');
fs.symlinkSync(lexRoot, alias);
const viaAlias = path.join(alias, 'a.log');
say('значение через симлинк-каталог', viaAlias);
say('ПРЕДПРОВЕРКА (шаг 3)', inside(realRoot, path.resolve(realRoot, viaAlias)) ? 'пропустила' : 'ОТКАЗ (ложный!)');
say('realpath', fs.realpathSync(viaAlias));
say('пост-проверка (шаг 5)', inside(realRoot, fs.realpathSync(viaAlias)) ? 'пропустила => ЗАКОННЫЙ' : 'отказ');
console.log('  Лексический предикат симлинков не видит — это и есть причина существования И3.');

console.log('\n=== C. предлагаемая форма: предпроверка советующая, а не запрещающая ===');
const decide = (value) => {
  const cand = path.resolve(realRoot, value);
  const preOk = inside(realRoot, cand);
  let resolved;
  try {
    resolved = fs.realpathSync(cand);
  } catch (e) {
    return { code: preOk ? (e.code === 'ENOENT' ? 'path-not-found' : 'path-unusable') : 'path-escapes-root' };
  }
  if (!inside(realRoot, resolved)) return { code: 'path-escapes-root' };
  return { ok: true, resolved };
};
const outside = path.join(base, 'secret.txt');
fs.writeFileSync(outside, 'S');
const cases = [
  ['законный относительный', 'a.log'],
  ['законный лексической формы', lexValue],
  ['законный через симлинк', viaAlias],
  ['обход, цель СУЩЕСТВУЕТ', '../secret.txt'],
  ['обход, цели НЕТ', '../nope.txt'],
  ['обход глубокий, цели нет', '../../../../etc/nope'],
];
for (const [label, v] of cases) {
  const r = decide(v);
  say(label, r.ok ? 'ПРИНЯТ' : r.code);
}
console.log('  Оба обхода дают один код => оракул существования схлопнут,');
console.log('  и ни один законный путь не отвергнут.');

console.log('\n=== D. канонизация проверяет КЛЮЧИ, не только значения ===');
const { canonicalizeJcs } = await import('@mcpproxy/contracts');
const LONE = String.fromCharCode(0xd800);
for (const [label, obj] of [
  ['значение с суррогатом', { k: 'a' + LONE }],
  ['КЛЮЧ с суррогатом', { ['k' + LONE]: 'ok' }],
]) {
  try {
    canonicalizeJcs(obj);
    say(label, 'прошло');
  } catch (e) {
    say(label, 'БРОСИЛ ' + e.constructor.name);
  }
}

console.log('\n=== E. версия es-module-lexer в воркспейсе ===');
const cj = JSON.parse(fs.readFileSync('packages/contracts/package.json', 'utf8'));
say('contracts devDep', JSON.stringify(cj.devDependencies?.['es-module-lexer'] ?? cj.dependencies?.['es-module-lexer']));

fs.rmSync(base, { recursive: true, force: true });
