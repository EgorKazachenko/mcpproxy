const fs = await import('node:fs');
const { parseManifest } = await import('@mcpproxy/contracts/validate');
const { matcherKey } = await import('@mcpproxy/contracts');
const say = (k, v) => console.log(`${String(k).padEnd(50)} ${v}`);

const yamlText = fs.readFileSync('packages/contracts/recipes/mcpproxy.yaml', 'utf8');
const r = parseManifest(yamlText, { path: 'packages/contracts/recipes/mcpproxy.yaml' });
if (!r.ok) throw new Error('манифест не разобрался');
const m = r.matchers.get(matcherKey('run_tests', 'pattern'));
if (!m) throw new Error('матчер не найден');

const LONE_HIGH = String.fromCharCode(0xd800);
const LONE_LOW = String.fromCharCode(0xdc00);
const PAIR = String.fromCodePoint(0x1f600);

const cases = [
  ['обычная строка', 'auth'],
  ['одиночный высокий суррогат', 'a' + LONE_HIGH + 'b'],
  ['одиночный низкий суррогат', 'a' + LONE_LOW + 'b'],
  ['корректная пара (эмодзи)', 'a' + PAIR + 'b'],
  ['нулевой байт', 'a' + String.fromCharCode(0) + 'b'],
  ['пустая строка', ''],
];

console.log('=== matcher.test на враждебных строках ===');
for (const [label, value] of cases) {
  try {
    say(label, 'вернул ' + m.test(value));
  } catch (e) {
    say(label, 'БРОСИЛ ' + e.constructor.name + ': ' + String(e.message).slice(0, 60));
  }
}

console.log('\n=== длина: кодовые точки против единиц UTF-16 ===');
const emoji = 'a' + PAIR + 'b';
say('строка', JSON.stringify(emoji));
say('.length (единицы UTF-16)', emoji.length);
say('[...s].length (кодовые точки)', [...emoji].length);

console.log('\n=== normalize на строке с одиночным суррогатом ===');
try {
  const n = ('a' + LONE_HIGH + 'b').normalize('NFC');
  say('normalize NFC', 'вернул, длина ' + n.length);
} catch (e) {
  say('normalize NFC', 'БРОСИЛ ' + e.constructor.name);
}

console.log('\n=== зачистка одиночных суррогатов: форма правила ===');
const strip = (s) => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
const { canonicalizeJcs } = await import('@mcpproxy/contracts');
for (const [label, value] of cases) {
  const cleaned = strip(value);
  let verdict;
  try {
    canonicalizeJcs({ r: cleaned });
    verdict = 'jcs принял';
  } catch (e) {
    verdict = 'jcs БРОСИЛ ' + e.constructor.name;
  }
  say(label + ' -> после зачистки', JSON.stringify(cleaned) + '  ' + verdict);
}
say('пара переживает зачистку?', strip('a' + PAIR + 'b') === 'a' + PAIR + 'b');
