import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeTree, repoRoot } from './gates-lib.mjs';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const kind = arg('kind');
const featureDir = arg('feature') ?? process.env.VIBE_FEATURE;

if (!kind) {
  console.error('review-verify: --kind <dimension> is required');
  process.exit(1);
}
if (!featureDir) {
  console.error('review-verify: --feature or VIBE_FEATURE is required');
  process.exit(1);
}

const path = join(repoRoot(), featureDir, '.review', `${kind}.md`);

if (!existsSync(path)) {
  console.error(`review-verify: ${featureDir}/.review/${kind}.md does not exist.`);
  console.error('');
  console.error(`  The "${kind}" dimension of the review pass has not run. A dimension that`);
  console.error('  genuinely does not apply still needs a file, whose FIRST LINE is:');
  console.error(`    N/A — <why it does not apply>`);
  console.error('  Absent and not-applicable must be distinguishable. That distinction is');
  console.error('  the entire reason this gate exists.');
  process.exit(1);
}

const body = readFileSync(path, 'utf8');
const firstLine = body.split('\n')[0].trim();

if (/^N\/A\b/i.test(firstLine)) {
  const reason = firstLine.replace(/^N\/A\s*[—:-]?\s*/i, '').trim();
  if (!reason) {
    console.error(`review-verify: ${kind} is marked N/A with no reason — state why it does not apply`);
    process.exit(1);
  }
  console.log(`review-verify: ${kind} — N/A (${reason})`);
  process.exit(0);
}

const tree = codeTree();
if (!body.includes(tree)) {
  console.error(`review-verify: ${featureDir}/.review/${kind}.md is not anchored to the current codeTree ${tree}.`);
  console.error('  Either the review ran against different code, or the anchor was never written.');
  console.error('  Re-run this dimension and paste the current codeTree into its findings file.');
  process.exit(1);
}

if (!/^\s*[-*|]\s*\S/m.test(body)) {
  console.error(`review-verify: ${kind} lists no findings. A review that found nothing says so`);
  console.error('  explicitly as a bullet ("- no findings"), so silence is never mistaken for absence.');
  process.exit(1);
}

console.log(`review-verify: ${kind} anchored to ${tree}`);
