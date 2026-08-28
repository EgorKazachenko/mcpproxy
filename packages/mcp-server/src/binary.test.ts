import { describe, expect, it } from 'vitest';
import { resolveBinary } from './binary.js';

const DIR = '/home/u/proj';
// realpath, который ведёт себя как настоящий на дереве без симлинков.
const plain = { realpath: (path: string): string => path };
const missing = {
  realpath: (path: string): string => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT', path });
  },
};

describe('resolveBinary — A4, PATH hijack', () => {
  it('голое имя НЕ резолвится через PATH: без allowlist это отказ', () => {
    // Резолв через PATH и есть атака. Отсутствие записи в списке обязано быть отказом, а не
    // поводом посмотреть в окружение.
    const result = resolveBinary('pnpm', { allowlist: [], manifestDir: DIR }, plain);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('binary-not-allowed');
  });

  it('голое имя проходит по единственному совпадению в allowlist', () => {
    const result = resolveBinary('pnpm', { allowlist: ['/usr/local/bin/pnpm'], manifestDir: DIR }, plain);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe('/usr/local/bin/pnpm');
  });

  it('неоднозначное голое имя отвергается, а не решается порядком строк', () => {
    const result = resolveBinary('pnpm', { allowlist: ['/usr/local/bin/pnpm', '/opt/bin/pnpm'], manifestDir: DIR }, plain);
    expect(result.ok).toBe(false);
  });

  it('абсолютный путь вне списка отвергается', () => {
    const result = resolveBinary('/usr/bin/curl', { allowlist: ['/usr/local/bin/pnpm'], manifestDir: DIR }, plain);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('binary-not-allowed');
  });

  it('абсолютный путь сверяется ПОСЛЕ realpath: симлинк наружу не проходит', () => {
    // Симлинк лежит по разрешённому пути, но указывает на неразрешённую цель.
    const deps = { realpath: (path: string): string => (path === '/usr/local/bin/pnpm' ? '/tmp/evil' : path) };
    const result = resolveBinary('/usr/local/bin/pnpm', { allowlist: ['/usr/local/bin/pnpm'], manifestDir: DIR }, deps);
    expect(result.ok).toBe(false);
  });

  it('путь вниз от манифеста проходит без allowlist — он приехал тем же файлом', () => {
    const result = resolveBinary('./scripts/publish.sh', { allowlist: [], manifestDir: DIR }, plain);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe('/home/u/proj/scripts/publish.sh');
  });

  it('относительный путь ВВЕРХ отвергается', () => {
    const result = resolveBinary('../../../usr/bin/curl', { allowlist: [], manifestDir: DIR }, plain);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('binary-not-allowed');
  });

  it('относительный путь, резолвящийся симлинком наружу, отвергается', () => {
    const deps = { realpath: (path: string): string => (path.endsWith('publish.sh') ? '/tmp/evil.sh' : path) };
    const result = resolveBinary('./scripts/publish.sh', { allowlist: [], manifestDir: DIR }, deps);
    expect(result.ok).toBe(false);
  });

  it('метасимвол оболочки отвергается, хотя shell и не запускается', () => {
    for (const one of ['pnpm; rm -rf /', '/bin/sh -c "x"', 'pnpm && curl', '$(which pnpm)', '/usr/bin/*']) {
      expect(resolveBinary(one, { allowlist: [], manifestDir: DIR }, plain).ok).toBe(false);
    }
  });

  it('нерезолвящийся путь отличается от неразрешённого', () => {
    const result = resolveBinary('/usr/local/bin/pnpm', { allowlist: ['/usr/local/bin/pnpm'], manifestDir: DIR }, missing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('binary-unresolved');
  });

  it('пустой exec[0] отвергается', () => {
    expect(resolveBinary('', { allowlist: [], manifestDir: DIR }, plain).ok).toBe(false);
  });
});
