// Download all sansatemple.com assets locally, verify sha256, patch the bundle CDN origin.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // 礼佛/
const SITE = path.join(ROOT, 'site');
const BUNDLE = path.join(SITE, 'assets', 'game-iJ7UN04i.js');
const CDN = 'https://sansa-assets.wlsdnjs0529.workers.dev';
const ORIGIN = 'https://sansatemple.com';

const text = fs.readFileSync(BUNDLE, 'utf8');
const entryRe = /\{source:"([^"]+)",sha256:"([a-f0-9]{64})",bytes:(\d+),encoding:"(\w+)",path:"([^"]+)"\}/g;
const entries = [...text.matchAll(entryRe)].map(m => ({
  source: m[1], sha256: m[2], bytes: +m[3], path: m[4],
}));

// Same-origin statics referenced by index.html / CSS / JS (query strings stripped on save).
const statics = [
  '/favicon.ico?v=4c79780808f4',
  '/favicon.svg?v=4c79780808f4',
  '/favicon-32.png?v=4c79780808f4',
  '/apple-touch-icon.png?v=ccfba25ef8c5',
  '/manifest.webmanifest?v=ccfba25ef8c5',
  '/og/sansa-rest-20261101-v11.png',
  '/fonts/SansaQuietUI-Core.woff2?v=bc9d113510bd',
  '/fonts/SansaQuietUI-Remainder.woff2?v=c08b83e11761',
  '/audio/heart-sutra-v1.mp3',
  '/audio/temple-chant-review-v1.mp3',
  '/audio/moktak-hit-natural.wav?v=c3f11da43c87',
  '/assets/altar-wall-calm-20261102.jpg?v=074017b9f22d',
  '/assets/moktak-7FyZzEKd.webp',
  '/assets/buymeacoffee-logo-Dd8V_aS3.svg',
  '/assets/kakaopay-support-XQdUYe-c.jpg',
];

function save(urlPath, buf) {
  const dest = path.join(SITE, urlPath.replace(/^\//, ''));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

let ok = 0, bad = [];
for (const e of entries) {
  try {
    // Origin hosts the same bytes on Cloudflare Pages; CDN (workers.dev) is unreachable from this network.
    let res = await fetch(ORIGIN + e.source);
    if (!res.ok) res = await fetch(CDN + e.path);
    if (!res.ok) { bad.push([e.source, `HTTP ${res.status}`]); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== e.sha256) { bad.push([e.source, `sha256 mismatch got=${sha.slice(0, 12)}`]); continue; }
    if (buf.length !== e.bytes) bad.push([e.source, `bytes ${buf.length} != ${e.bytes} (sha ok)`]);
    save(e.path, buf);
    save(e.source, buf);
    ok++;
    console.log(`OK  ${e.source}  ${(buf.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    bad.push([e.source, err.message]);
  }
}

// Statics: try origin, fall back to CDN /v/<hash> path from manifest if present.
const manifestPath = new Map(entries.map(e => [e.source, e.path]));
for (const s of statics) {
  const clean = s.split('?')[0];
  try {
    let res = await fetch(ORIGIN + s);
    if (!res.ok && manifestPath.has(clean)) {
      res = await fetch(CDN + manifestPath.get(clean));
    }
    if (!res.ok) { bad.push([clean, `HTTP ${res.status}`]); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    save(clean, buf);
    ok++;
    console.log(`OK  ${clean}  ${(buf.length / 1024).toFixed(0)}KB`);
  } catch (err) {
    bad.push([clean, err.message]);
  }
}

// Patch the bundle so the asset CDN resolves to this same origin.
const patched = text.replace(
  `"https://sansa-assets.wlsdnjs0529.workers.dev"`,
  `""`,
);
if (patched === text) {
  console.log('\nWARN: CDN origin string not found for patching');
} else {
  fs.writeFileSync(BUNDLE, patched);
  console.log('\nPATCHED bundle CDN origin -> "" (same-origin local)');
}

console.log(`\nDONE ok=${ok}/${entries.length + statics.length}`);
if (bad.length) {
  console.log('FAILURES:');
  for (const [f, why] of bad) console.log(`  ${f}: ${why}`);
  process.exitCode = 1;
}
