#!/usr/bin/env node
// CLI прогона корпуса. `--json <path>` — машиночитаемая форма для вкладки «Red team» (E7).
import { writeFileSync } from 'node:fs';
import { formatReport, runBench, toJson } from '../dist/index.js';

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
};

const modes = valueOf('--mode')?.split(',');
const only = valueOf('--only')?.split(',') ?? [];
const jsonPath = valueOf('--json');

const run = await runBench({
  ...(modes === undefined ? {} : { modes }),
  only,
  onMode: (mode) => process.stderr.write(`\n[${mode}] прогон корпуса\n`),
  onResult: (result) => {
    const mark = { blocked: '.', completed: '.', achieved: '!', 'false-block': 'x', skipped: '-', error: 'E' }[result.status];
    process.stderr.write(mark ?? '?');
  },
});

process.stderr.write('\n\n');
process.stdout.write(formatReport(run));
if (jsonPath !== undefined) writeFileSync(jsonPath, toJson(run));

const seatbelt = run.modes.find((one) => one.mode === 'seatbelt') ?? run.modes[0];
// Ненулевой код возврата — когда атака достигла цели или журнал не сошёлся: гейт CI.
process.exit(seatbelt !== undefined && seatbelt.attacks.achieved === 0 && seatbelt.chainVerified ? 0 : 1);
