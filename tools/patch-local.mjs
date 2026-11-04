// Localize the mirror bundle for single-server offline operation (idempotent).
// 1) Server list -> exactly one local room ("maru").
// 2) Presence endpoint -> derive from page origin (local server).
// 3) Supabase URL -> empty (cloud presence branch never taken).
// 4) Reconnect backoff -> fast, local-friendly (was exponential up to 15s).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUNDLE = path.join(ROOT, 'site', 'assets', 'game-iJ7UN04i.js');

const edits = [
  // 100 hardcoded rooms -> single local server
  [
    'Ar=Object.freeze(Array.from({length:rf},(s,e)=>Object.freeze({id:e===0?"maru":`maru-${String(e+1).padStart(2,"0")}`,number:e+1,capacity:Rn})))',
    'Ar=Object.freeze([Object.freeze({id:"maru",number:1,capacity:Rn})])',
  ],
  // realtime endpoint -> same-origin /presence (ws://127.0.0.1:<port>)
  [
    'ub="wss://sansa-realtime.wlsdnjs0529.workers.dev/presence"',
    'ub=""',
  ],
  // supabase origin -> empty so Sh=false and the V2 (websocket) client is used
  [
    'lb="https://xvwhzwnrrrnebdlgleqg.supabase.co"',
    'lb=""',
  ],
  // reconnect backoff: exponential 0.7s..15s -> fast 0.4s..2.2s (local latency is nil)
  [
    'const e=Math.min(15e3,700*2**Math.min(this.attempt++,5)+Math.random()*350);',
    'const e=Math.min(2200,400*2**Math.min(this.attempt++,2)+Math.random()*250);',
  ],
  // standalone mode: on non-local hosts (e.g. GitHub Pages) run the in-page
  // presence simulator instead of the WebSocket client
  [
    'else try{mt=new V2(Vg,Rl,{url:ub})}catch{Rl.onStatus("disconnected"),rr("连接未能建立，请重新进入。")}',
    'else if(window.__sansaStandalone&&window.__sansaCreatePresence)try{mt=window.__sansaCreatePresence(Rl)}catch(e2){Rl.onStatus("disconnected")}else try{mt=new V2(Vg,Rl,{url:ub})}catch{Rl.onStatus("disconnected"),rr("连接未能建立，请重新进入。")}',
  ],
];

let text = fs.readFileSync(BUNDLE, 'utf8');
for (const [from, to] of edits) {
  const n = text.split(from).length - 1;
  if (n === 1) {
    text = text.replace(from, to);
    console.log(`OK: ${from.slice(0, 56)}...`);
  } else if (n === 0 && text.includes(to)) {
    console.log(`SKIP (already applied): ${to.slice(0, 56)}...`);
  } else {
    console.error(`FAIL: expected exactly 1 occurrence, found ${n}:\n  ${from.slice(0, 80)}`);
    process.exit(1);
  }
}
fs.writeFileSync(BUNDLE, text);
console.log('bundle patched');
