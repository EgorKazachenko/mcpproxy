#!/usr/bin/env node
// Демон. Библиотека — в `dist`, здесь только разбор аргументов и коды возврата.
import { join } from 'node:path';
import { LOCK_FILE, MANIFEST_FILE } from '@mcpproxy/core';
import { loadConfig, configPath, runtimeDir, socketPath, tokenPath, startDaemon } from '../dist/index.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? null);
};

const cwd = flag('--manifest-dir') ?? process.cwd();
const sandboxOverride = flag('--sandbox');

const loaded = loadConfig(configPath());
if (!loaded.ok) {
  for (const problem of loaded.problems) process.stderr.write(`конфиг: ${problem}\n`);
  process.exit(2);
}

let config = loaded.config;
if (sandboxOverride !== null) {
  if (!['none', 'seatbelt', 'container'].includes(sandboxOverride)) {
    process.stderr.write(`--sandbox: неизвестный режим ${sandboxOverride}\n`);
    process.exit(2);
  }
  config = { ...config, sandboxMode: sandboxOverride };
}
if (config.sandboxMode === 'none') {
  // Громко: `none` — это baseline-режим замера E8, а не «выключить лишнее».
  process.stderr.write('ОСЛАБЛЕННЫЙ РЕЖИМ: песочница отключена (--sandbox=none), исполнение без изоляции\n');
}

const started = await startDaemon({
  manifestPath: join(cwd, MANIFEST_FILE),
  lockPath: join(cwd, LOCK_FILE),
  runtimeDir: runtimeDir(),
  socketPath: socketPath(),
  tokenPath: tokenPath(),
  config,
  onDiagnostic: (text) => process.stderr.write(`${text}\n`),
});

if (!started.ok) {
  process.stderr.write(`демон не стартовал (${started.code}): ${started.message}\n`);
  for (const diagnostic of started.diagnostics ?? []) {
    process.stderr.write(`  ${diagnostic.pointer} ${diagnostic.line}:${diagnostic.column} ${diagnostic.code} — ${diagnostic.message}\n`);
  }
  process.exit(3);
}

process.stderr.write(`mcpproxyd слушает ${started.daemon.socketPath}, режим ${config.sandboxMode}\n`);

const stop = async () => {
  await started.daemon.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
