// Apply the zh translation map to the mirror; report zero-hit keys and leftover Hangul.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairs } from './zh-map.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILES = [
  path.join(ROOT, 'site', 'index.html'),
  path.join(ROOT, 'site', 'assets', 'index-C6rPWc71.js'),
  path.join(ROOT, 'site', 'assets', 'game-iJ7UN04i.js'),
  path.join(ROOT, 'site', 'manifest.webmanifest'),
];

const sorted = [...pairs].sort((a, b) => b[0].length - a[0].length);
const totals = new Map(sorted.map(([k]) => [k, 0]));

for (const file of FILES) {
  let text = fs.readFileSync(file, 'utf8');
  for (const [ko, zh] of sorted) {
    const parts = text.split(ko);
    if (parts.length > 1) {
      totals.set(ko, totals.get(ko) + parts.length - 1);
      text = parts.join(zh);
    }
  }
  fs.writeFileSync(file, text);
}

const zero = sorted.filter(([k]) => totals.get(k) === 0);
console.log(`applied ${sorted.length - zero.length}/${sorted.length} keys`);
if (zero.length) {
  console.log('ZERO-HIT KEYS (review):');
  for (const [k] of zero) console.log('  ' + JSON.stringify(k));
}

// Leftover Hangul scan (full runs, deduped, with file + one context line).
const HANGUL = /[\uAC00-\uD7AF]/;
console.log('\nLEFTOVER HANGUL:');
for (const file of FILES) {
  const text = fs.readFileSync(file, 'utf8');
  const seen = new Map();
  for (const m of text.matchAll(/[\uAC00-\uD7AF][\uAC00-\uD7AF\s.,·…!?~'%:0-9()\-]*[\uAC00-\uD7AF]|[\uAC00-\uD7AF]/g)) {
    const run = m[0];
    if (!seen.has(run)) {
      const ctx = text.slice(Math.max(0, m.index - 50), m.index + run.length + 50).replace(/\s+/g, ' ');
      seen.set(run, ctx);
    }
  }
  if (seen.size) {
    console.log(`--- ${path.relative(ROOT, file)} (${seen.size} runs)`);
    for (const [run, ctx] of seen) console.log(`  ${JSON.stringify(run)}  ⟵ …${ctx}…`);
  }
}
console.log('done');
