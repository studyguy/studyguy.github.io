// Extract asset URLs and backend endpoints from downloaded JS/CSS bundles.
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
const exts = /\.(png|jpe?g|webp|gif|svg|ico|mp3|ogg|wav|m4a|webm|mp4|glb|gltf|json|webmanifest|woff2?|ttf|otf|css|js)(\?|$)/i;

const urls = new Set();
const endpoints = new Set();

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  // 1) Quoted strings that look like root-relative asset paths: "/assets/...", "/fonts/...", "/og/..."
  const strRe = `["']((?:/|\\./|\\.\\./)?[A-Za-z0-9_@\\-./]+\\.(?:png|jpe?g|webp|gif|svg|ico|mp3|ogg|wav|m4a|webm|mp4|glb|gltf|webmanifest|woff2?|ttf|otf))(\\?[^"']{0,64})?["']`;
  for (const m of text.matchAll(new RegExp(strRe, 'g'))) {
    let u = m[1] + (m[2] || '');
    if (u.startsWith('.')) u = u.replace(/^\.?\//, '');
    urls.add(u);
  }
  // 2) CSS url() refs (also inside JS-injected CSS)
  for (const m of text.matchAll(/url\((["']?)([^)"']+)\1\)/g)) {
    const u = m[2];
    if (!/^data:|^#|^about:/i.test(u)) urls.add(u);
  }
  // 3) Backend endpoints / sockets
  for (const m of text.matchAll(/["'](\/api\/[A-Za-z0-9_\-/.$ {}]*|\/ws[A-Za-z0-9_\-/.$ {}]*|wss?:\/\/[^"']+|https?:\/\/[^"']+)["']/g)) {
    const u = m[1];
    if (!/sansatemple\.com\/(og\/|$)/.test(u)) endpoints.add(u);
  }
}

console.log('=== ASSET URLS (%d) ===', urls.size);
for (const u of [...urls].sort()) console.log(u);
console.log('\n=== ENDPOINTS / EXTERNAL (%d) ===', endpoints.size);
for (const u of [...endpoints].sort()) console.log(u);
