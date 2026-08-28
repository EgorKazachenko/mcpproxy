import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const audit = await import('@mcpproxy/contracts/audit');
const say = (k, v) => console.log(`${String(k).padEnd(46)} ${v}`);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'e2r2-'));
const lexicalRoot = path.join(base, 'logs');
fs.mkdirSync(lexicalRoot);
fs.writeFileSync(path.join(lexicalRoot, 'a.log'), 'x');
const realRoot = fs.realpathSync(lexicalRoot);

const inside = (root, cand) => {
  const rel = path.relative(root, cand);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};

console.log('=== BLOCKER-1: предпроверка против НЕрезолвнутого корня ===');
say('лексический root', lexicalRoot);
say('realpath(root)', realRoot);
const realForm = path.join(realRoot, 'a.log');
const relForm = 'a.log';
say('значение в realpath-форме', realForm);
say('relative(лексич.root, realForm)', JSON.stringify(path.relative(lexicalRoot, realForm)));
say('предпроверка против ЛЕКСИЧ. корня', inside(lexicalRoot, path.resolve(lexicalRoot, realForm)) ? 'ПРОПУСТИЛА' : 'ОТКАЗ (ложный!)');
say('предпроверка против REALPATH корня', inside(realRoot, path.resolve(realRoot, realForm)) ? 'пропустила (верно)' : 'ОТКАЗ');
say('относительное значение против лексич.', inside(lexicalRoot, path.resolve(lexicalRoot, relForm)) ? 'пропустила' : 'отказ');

console.log('\n=== MAJOR-2: NFC-алиасинг двух РАЗНЫХ файлов ===');
const nfc = 'caf' + String.fromCharCode(0xe9) + '.log';
const nfd = 'cafe' + String.fromCharCode(0x301) + '.log';
say('NFC и NFD — разные JS-строки', nfc !== nfd);
say('nfd.normalize("NFC") === nfc', nfd.normalize('NFC') === nfc);
const hFromNfc = audit.argsHash('analyze_logs', { file: path.join(realRoot, nfc) });
const hFromNfdNormalized = audit.argsHash('analyze_logs', { file: path.join(realRoot, nfd).normalize('NFC') });
say('argsHash(NFC-путь)', hFromNfc.slice(0, 16));
say('argsHash(NFD-путь после NFC)', hFromNfdNormalized.slice(0, 16));
say('=> два ПУТИ дают один хэш', hFromNfc === hFromNfdNormalized);
console.log('  На байтовой ФС это два РАЗНЫХ файла, и апрув на один авторизует другой.');

const hRawNfc = audit.argsHash('analyze_logs', { file: path.join(realRoot, nfc) });
const hRawNfd = audit.argsHash('analyze_logs', { file: path.join(realRoot, nfd) });
say('без нормализации: хэши различны', hRawNfc !== hRawNfd);
console.log('  Без нормализации на macOS тот же файл даёт два хэша — лишний запрос апрува.');

console.log('\n=== мотив, ради которого NFC вводился, даёт ли его realpath сам ===');
const viaRel = fs.realpathSync(path.resolve(lexicalRoot, './a.log'));
const viaAbs = fs.realpathSync(path.join(lexicalRoot, 'a.log'));
say('realpath("./a.log")', viaRel);
say('realpath(абсолютный)', viaAbs);
say('argsHash совпадает без всякого NFC', audit.argsHash('r', { f: viaRel }) === audit.argsHash('r', { f: viaAbs }));

console.log('\n=== MINOR-5: форма cwd в контракте ===');
const ev = fs.readFileSync('packages/contracts/src/event.ts', 'utf8').split('\n');
say('event.ts:90', ev[89].trim());

fs.rmSync(base, { recursive: true, force: true });
