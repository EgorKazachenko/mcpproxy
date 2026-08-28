#!/usr/bin/env node
// Шим: тонкий stdio-мост. JSON-RPC от клиента к демону и обратно, по одному сообщению на строку.
import { createShim, createFrameDecoder, readToken, socketPath, tokenPath } from '../dist/index.js';

let token;
try {
  token = readToken(tokenPath());
} catch (error) {
  process.stderr.write(`${error.message}\nдемон не запущен? запустите mcpproxyd\n`);
  process.exit(4);
}

const shim = createShim({
  socketPath: socketPath(),
  token,
  send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
});

const decoder = createFrameDecoder();
process.stdin.on('data', (chunk) => {
  for (const outcome of decoder.push(chunk)) {
    if (outcome.kind === 'oversized') {
      process.stderr.write('сообщение клиента превысило потолок кадра\n');
      process.exit(5);
    }
    if (outcome.kind !== 'frame') continue;
    void shim.handle(outcome.value);
  }
});

process.stdin.on('end', () => {
  shim.close();
  process.exit(0);
});
