const say = (k, v) => console.log(`${String(k).padEnd(46)} ${v}`);

const root = await import('@mcpproxy/contracts');
const audit = await import('@mcpproxy/contracts/audit');
const validate = await import('@mcpproxy/contracts/validate');

console.log('=== A. what is actually callable from each entry ===');
say('root exports', Object.keys(root).length);
say('audit exports', Object.keys(audit).join(', '));
say('validate exports', Object.keys(validate).join(', '));
say('compilePattern reachable?', 'compilePattern' in validate || 'compilePattern' in root);

console.log('\n=== B. argsHash sensitivity to unicode normalization ===');
const nfc = 'caf' + String.fromCharCode(0xe9) + '.log';
const nfd = 'cafe' + String.fromCharCode(0x301) + '.log';
const hNfc = audit.argsHash('analyze_logs', { file: nfc });
const hNfd = audit.argsHash('analyze_logs', { file: nfd });
say('argsHash(NFC)', hNfc.slice(0, 16));
say('argsHash(NFD)', hNfd.slice(0, 16));
say('SAME file on disk, same hash?', hNfc === hNfd);

console.log('\n=== C. canonicalizeJcs on a lone surrogate ===');
try { root.canonicalizeJcs({ denyReason: 'bad ' + String.fromCharCode(0xd800) }); say('lone surrogate', 'RETURNED'); }
catch (e) { say('lone surrogate', e.constructor.name + ': ' + e.message.slice(0, 60)); }
try { root.canonicalizeJcs({ a: undefined }); say('explicit undefined', 'RETURNED'); }
catch (e) { say('explicit undefined', e.constructor.name + ': ' + e.message.slice(0, 60)); }
say('absent key vs null differ?', root.canonicalizeJcs({}) !== root.canonicalizeJcs({ a: null }));

console.log('\n=== D. sanitizeDescription does NOT strip a lone surrogate ===');
const poisoned = 'x' + String.fromCharCode(0xd800) + 'y';
const s = root.sanitizeDescription(poisoned);
say('input length / output length', poisoned.length + ' / ' + s.text.length);
say('output still has lone surrogate?', /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s.text));
try { root.canonicalizeJcs({ denyReason: s.text }); say('=> jcs of SANITIZED text', 'RETURNED'); }
catch (e) { say('=> jcs of SANITIZED text', 'THROWS ' + e.constructor.name); }

console.log('\n=== E. matchers map from parseManifest ===');
const fs = await import('node:fs');
const yamlText = fs.readFileSync('packages/contracts/recipes/mcpproxy.yaml', 'utf8');
const r = validate.parseManifest(yamlText, { path: 'packages/contracts/recipes/mcpproxy.yaml' });
say('parse ok?', r.ok);
if (r.ok) {
  say('matcher keys', [...r.matchers.keys()].join(' | '));
  const k = root.matcherKey('publish_release', 'tag');
  const m = r.matchers.get(k);
  say('matcherKey(publish_release,tag)', k);
  say('matcher present?', Boolean(m));
  if (m) {
    say('test("v1.2.3")', m.test('v1.2.3'));
    say('test("v1.2.3; rm -rf /")', m.test('v1.2.3; rm -rf /'));
    say('matcher own props', JSON.stringify(Object.keys(m)));
    say('has .source / .flags?', 'source' in m || 'flags' in m);
  }
  const rec = r.manifest.tools.publish_release;
  say('recipe.params.tag.pattern (raw string)', JSON.stringify(rec.params.tag.pattern));
  console.log('\n=== F. NumberParam min/max sanity at load time ===');
  say('is there a number param in stubs?', Object.values(r.manifest.tools).some((t) => Object.values(t.params ?? {}).some((p) => p.type === 'number')));
} else {
  say('diagnostics', JSON.stringify(r.diagnostics.slice(0, 3)));
}

console.log('\n=== G. anchored vs unanchored pattern ===');
say('note', 'RE2 .test is a SEARCH unless anchored');
if (r.ok) {
  const m = r.matchers.get(root.matcherKey('run_tests', 'pattern'));
  say('run_tests.pattern raw', JSON.stringify(r.manifest.tools.run_tests.params.pattern.pattern));
  if (m) {
    say('test("ok")', m.test('ok'));
    say('test("ok; rm -rf /")', m.test('ok; rm -rf /'));
  }
}
