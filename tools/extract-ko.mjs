// Extract all string literals containing Hangul from the mirror, with context.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILES = [
  path.join(ROOT, 'site', 'index.html'),
  path.join(ROOT, 'site', 'assets', 'index-C6rPWc71.js'),
  path.join(ROOT, 'site', 'assets', 'game-iJ7UN04i.js'),
  path.join(ROOT, 'site', 'assets', 'game-CXqKEmtK.css'),
  path.join(ROOT, 'site', 'manifest.webmanifest'),
];

const HANGUL = /[\uAC00-\uD7AF]/;
const out = [];

for (const file of FILES) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');
  // Quoted string literals (double/single/backtick) containing Hangul
  const litRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  const seen = new Map();
  for (const m of text.matchAll(litRe)) {
    const s = m[1] ?? m[2] ?? m[3];
    if (s && HANGUL.test(s)) {
      const idx = m.index;
      const ctx = text.slice(Math.max(0, idx - 60), idx + s.length + 40).replace(/\s+/g, ' ');
      if (!seen.has(s)) seen.set(s, { file: rel, ctx, count: 0 });
      seen.get(s).count++;
    }
  }
  for (const [s, info] of seen) out.push({ str: s, ...info });
}

out.sort((a, b) => a.str.localeCompare(b.str, 'ko'));
for (const o of out) {
  console.log(`### [${o.file}] x${o.count}`);
  console.log(`STR: ${JSON.stringify(o.str)}`);
  console.log(`CTX: ${o.ctx}`);
  console.log();
}
console.log(`TOTAL unique: ${out.length}`);
