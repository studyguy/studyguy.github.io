// Probe the V2 presence-client region: literals, method names, boundaries.
import fs from 'node:fs';
const t = fs.readFileSync('site/assets/game-iJ7UN04i.js', 'utf8');
const start = t.indexOf('class V2{');
const mode = process.argv[2] || 'lits';
const from = +(process.argv[3] || 0);
const to = +(process.argv[4] || 20000);
const region = t.slice(start + from, start + to);

if (mode === 'lits') {
  const lit = region.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) || [];
  console.log([...new Set(lit)].join('\n'));
} else if (mode === 'raw') {
  console.log(region);
} else if (mode === 'slice') {
  // slice at absolute bundle offsets
  console.log(t.slice(from, to));
}
