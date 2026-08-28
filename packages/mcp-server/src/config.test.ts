import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, parseConfig } from './config.js';

describe('parseConfig — строгий разбор, без починки умолчаниями', () => {
  it('пустой объект даёт дефолты', () => {
    const result = parseConfig('{}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(DEFAULT_CONFIG);
  });

  it('дефолтный режим — seatbelt, а дефолтный allowlist пуст', () => {
    // Пустой список запрещает и голое имя, и абсолютный путь: это fail-closed, а не «пока не настроили».
    expect(DEFAULT_CONFIG.sandboxMode).toBe('seatbelt');
    expect(DEFAULT_CONFIG.binaryAllowlist).toEqual([]);
  });

  it('неизвестный ключ — отказ, а не игнор', () => {
    const result = parseConfig('{"allowLocalBinding": true}');
    expect(result.ok).toBe(false);
  });

  it('опечатка в режиме не превращается в дефолт молча', () => {
    const result = parseConfig('{"sandboxMode": "seatbelt "}');
    expect(result.ok).toBe(false);
  });

  it('три настоящих режима принимаются', () => {
    for (const mode of ['none', 'seatbelt', 'container']) {
      const result = parseConfig(JSON.stringify({ sandboxMode: mode }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.config.sandboxMode).toBe(mode);
    }
  });

  it('относительный путь в allowlist отвергается', () => {
    expect(parseConfig('{"binaryAllowlist": ["./bin/pnpm"]}').ok).toBe(false);
  });

  it('не список строк отвергается', () => {
    expect(parseConfig('{"binaryAllowlist": "/usr/bin/pnpm"}').ok).toBe(false);
    expect(parseConfig('{"binaryAllowlist": [1]}').ok).toBe(false);
  });

  it('не JSON и не объект отвергаются', () => {
    expect(parseConfig('{').ok).toBe(false);
    expect(parseConfig('[]').ok).toBe(false);
    expect(parseConfig('null').ok).toBe(false);
  });
});

describe('loadConfig — отсутствие это дефолты, а присутствие мусора это отказ', () => {
  it('отсутствующий файл даёт дефолты и помечается absent', () => {
    const result = loadConfig(join(mkdtempSync(join(tmpdir(), 'mcpproxy-cfg-')), 'нет.json'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(DEFAULT_CONFIG);
    expect('absent' in result).toBe(true);
  });

  it('присутствующий, но неразбираемый файл — отказ, а не молчаливые дефолты', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mcpproxy-cfg-')), 'mcpproxyd.json');
    writeFileSync(path, '{ "sandboxMode": ');
    const result = loadConfig(path);
    expect(result.ok).toBe(false);
  });

  it('нечитаемый файл отличается от отсутствующего', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpproxy-cfg-'));
    const path = join(dir, 'mcpproxyd.json');
    writeFileSync(path, '{}');
    chmodSync(path, 0o000);
    const result = loadConfig(path);
    chmodSync(path, 0o600);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toContain('не читается');
  });

  it('валидный файл доезжает целиком', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mcpproxy-cfg-')), 'mcpproxyd.json');
    writeFileSync(path, JSON.stringify({ sandboxMode: 'none', binaryAllowlist: ['/usr/local/bin/pnpm'] }));
    const result = loadConfig(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual({ sandboxMode: 'none', binaryAllowlist: ['/usr/local/bin/pnpm'] });
  });
});
