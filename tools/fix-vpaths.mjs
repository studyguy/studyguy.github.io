// Fix: copy sha-verified source files to their /v/<hash>/ manifest paths; download missing icons.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SITE = path.join(ROOT, 'site');
const BUNDLE = path.join(SITE, 'assets', 'game-iJ7UN04i.js');
const ORIGIN = 'https://sansatemple.com';

const text = fs.readFileSync(BUNDLE, 'utf8');
const entryRe = /\{source:"([^"]+)",sha256:"([a-f0-9]{64})",bytes:(\d+),encoding:"(\w+)",path:"([^"]+)"\}/g;
const entries = [...text.matchAll(entryRe)].map(m => ({ source: m[1], path: m[5] }));

// Remove the two stray misnamed files from the earlier bug.
for (const junk of ['auto', 'identity']) {
  const p = path.join(SITE, junk);
  if (fs.existsSync(p)) { fs.unlinkSync(p); console.log(`removed junk: ${junk}`); }
}

let copied = 0, missing = [];
for (const e of entries) {
  const src = path.join(SITE, e.source.replace(/^\//, ''));
  const dst = path.join(SITE, e.path.replace(/^\//, ''));
  if (!fs.existsSync(src)) { missing.push(e.source); continue; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied++;
}
console.log(`copied to /v/ paths: ${copied}/${entries.length}`);
if (missing.length) console.log('MISSING sources:', missing);

// Icons referenced by manifest.webmanifest.
for (const icon of ['/icon-192.png?v=ccfba25ef8c5', '/icon-512.png?v=ccfba25ef8c5']) {
  const clean = icon.split('?')[0];
  const res = await fetch(ORIGIN + icon);
  if (res.ok) {
    const buf = Buffer.from(await res.arrayBuffer());
    const dst = path.join(SITE, clean.replace(/^\//, ''));
    fs.writeFileSync(dst, buf);
    console.log(`OK ${clean} ${(buf.length / 1024).toFixed(0)}KB`);
  } else {
    console.log(`FAIL ${clean} HTTP ${res.status}`);
  }
}
