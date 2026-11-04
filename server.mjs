// 山寺本地服务器 —— 单机运行的一切所需:
//   1. 静态资源(site/ 目录)
//   2. GET /api/rooms     —— 服务器目录(唯一本地服务器 "maru")
//   3. WS  /presence      —— 原站实时在线协议(快照/增量/座位/上香/事件)
//   4. 虚拟玩家模拟        —— 随机数量,散步/落座/礼拜/合掌/拨珠/上香/来去
// 运行: node server.mjs   (默认 http://127.0.0.1:4173/)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = ROOT; // 网站即仓库根(GitHub Pages 与本地服务器共用同一结构)
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';

/* ───────── 协议常量(与前端 bundle 的校验严格一致) ───────── */
const ROOM_ID = 'maru';
const ROOM_NUMBER = 1;
const CAPACITY = 100;                            // Rn
const CUSHION_COLS = 10;                         // Gd
const RESERVED_CUSHIONS = new Set([12, 15, 17, 18]); // J0 —— 常住僧专座
const INCENSE_MS = 120000;                       // D2
const POSES = ['kneel', 'walk', 'beads', 'dance'];
const LAPSED_MS = 10 * 60 * 1000;                // 断线访客保留时长(供 resume)

/* ───────── 坐标公式(与 bundle 内 As()/eg() 一致) ───────── */
function cushionPos(i) {
  const col = i % CUSHION_COLS;
  return {
    x: col < 5 ? (col - 5) * 2.4 : (col - 4) * 2.4,
    z: -8.4 + Math.floor(i / CUSHION_COLS) * 2.8,
    yaw: 0,
  };
}
function spawnPos(slot, existing) {
  const spread = (o, a = 3.2) => (o === 0 ? 0 : Math.ceil(o / 2) * (o % 2 ? -1 : 1) * a);
  const spot = (o) => {
    if (o < 18) return { x: spread(o % 9), z: o < 9 ? 21.6 : 18.4, yaw: 0 };
    const a = o - 18;
    return { x: spread(a % 13), z: 30.4 + Math.floor(a / 13) * 3.2, yaw: 0 };
  };
  const clear = (o) => existing.every((a) => Math.hypot(o.x - a.x, o.z - a.z) >= 1.06 - 1e-7);
  for (let i = 0; i < CAPACITY; i++) {
    const o = spot((slot + i) % CAPACITY);
    if (clear(o)) return o;
  }
  return spot(slot % CAPACITY);
}

/* ───────── 虚拟玩家外观 ───────── */
const NAME_POOL = ['行云', '扫叶', '听雨', '抱朴', '守拙', '望岳', '汲泉', '煮雪', '拾阶', '问竹',
  '归鸿', '疏影', '眠云', '拂尘', '汲露', '踏歌', '倚松', '沐晚', '闻钟', '含烟',
  '映竹', '枕石', '漱玉', '停云'];
const COLOR_POOL = ['#8a9a8b', '#9a8b7a', '#7d8a9a', '#a89888', '#7e8a7e', '#9c8f7f',
  '#887f92', '#8f9a85', '#a09a86', '#7f948f', '#96887e', '#87929c'];
let nameCursor = Math.floor(Math.random() * NAME_POOL.length);
function nextName() {
  const n = NAME_POOL[nameCursor % NAME_POOL.length];
  const round = Math.floor(nameCursor / NAME_POOL.length);
  nameCursor++;
  return round === 0 ? n : `${n}·${round + 1}`;
}
const nextColor = () => COLOR_POOL[Math.floor(Math.random() * COLOR_POOL.length)];

// 启动时的虚拟玩家数量:随机 3~12
const BOT_TARGET = 3 + Math.floor(Math.random() * 10);

/* ───────── 世界状态 ───────── */
const visitors = new Map();   // id -> visitor
const bots = new Set();       // 虚拟玩家 id
const conns = new Map();      // ws -> { visitorId, token, resumed }
const lapsed = new Map();     // visit token -> { record, expiresAt }
const incense = [];           // 当前香供 {id, visitorId, at, expiresAt}
let revision = 1;

const round2 = (n) => Math.round(n * 100) / 100;
const usedSeats = () => new Set([...visitors.values()].map((v) => v.seat));
const usedCushions = () => new Set(
  [...visitors.values()].flatMap((v) => {
    const out = [];
    if (v.cushion !== null && v.cushion !== undefined) out.push(v.cushion);
    if (v.pendingCushion !== undefined && v.pendingCushion !== null) out.push(v.pendingCushion); // 走向蒲团的途中即视为占用
    return out;
  }),
);

function freeSeat() {
  const used = usedSeats();
  for (let i = 0; i < CAPACITY; i++) if (!used.has(i)) return i;
  return 0;
}
// 蒲团释放冷却:起身/离开后短时间内不可再被预订,等前一人走远,避免视觉重叠"抢座"
const CUSHION_COOLDOWN_MS = 8000;
const cushionCooldown = new Map(); // cushion index -> freeAt 时间戳
function markCushionCooling(c) {
  if (c !== null && c !== undefined) cushionCooldown.set(c, Date.now() + CUSHION_COOLDOWN_MS);
}
function freeCushion() {
  const used = usedCushions();
  const now = Date.now();
  for (const [c, t] of cushionCooldown) if (t <= now) cushionCooldown.delete(c);
  for (let i = 0; i < CUSHION_COLS * CUSHION_COLS; i++) {
    if (RESERVED_CUSHIONS.has(i) || used.has(i) || cushionCooldown.has(i)) continue;
    return i;
  }
  return null;
}
function makeVisitor({ backdate = 0 } = {}) {
  const seat = freeSeat();
  const pos = spawnPos(seat, [...visitors.values()].map((v) => v.position).filter(Boolean));
  return {
    id: crypto.randomUUID(),
    name: nextName(),
    color: nextColor(),
    seat,
    cushion: null,
    joinedAt: Date.now() - backdate,
    pose: 'walk',
    position: pos,
  };
}
function wireVisitor(v) {
  const o = {
    id: v.id, name: v.name, color: v.color, seat: v.seat, cushion: v.cushion,
    joinedAt: v.joinedAt, pose: v.pose,
    position: { x: round2(v.position.x), z: round2(v.position.z), yaw: round2(v.position.yaw) },
  };
  if (v.bowAt !== undefined) o.bowAt = v.bowAt;
  return o;
}
function pruneIncense() {
  const now = Date.now();
  for (let i = incense.length - 1; i >= 0; i--) if (incense[i].expiresAt <= now) incense.splice(i, 1);
}

/* ───────── WebSocket(文本帧,零依赖实现) ───────── */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(payload, opcode = 0x81) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([opcode, len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}
function wsSend(socket, obj) {
  if (socket.destroyed) return;
  try { socket.write(wsFrame(Buffer.from(JSON.stringify(obj)))); } catch { /* 连接已断 */ }
}
function wsPong(socket, payload) {
  if (socket.destroyed) return;
  try { socket.write(wsFrame(payload.subarray(0, 125), 0x8A)); } catch { }
}

class FrameReader {
  // 浏览器客户端只发未分片的文本帧;仍做最小分片容错。
  constructor(onText, onClose, onPing) {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.onText = onText;
    this.onClose = onClose;
    this.onPing = onPing;
  }
  feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 1 << 20) { this.onClose(); return; }
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < off + 2) return; len = this.buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (this.buf.length < off + 8) return; len = Number(this.buf.readBigUInt64BE(off)); off += 8; }
      let mask = null;
      if (masked) { if (this.buf.length < off + 4) return; mask = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      this.buf = this.buf.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

      if (opcode === 1 || opcode === 2 || opcode === 0) {
        this.fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments);
          const isText = opcode === 1 || (opcode === 0 && this.fragments.length > 1);
          this.fragments = [];
          if (isText && opcode !== 2) this.onText(full.toString('utf8'));
        }
      } else if (opcode === 8) { // close
        this.onClose();
        return;
      } else if (opcode === 9) { // ping → pong
        this.onPing(payload);
      } // 10 pong / 其他忽略
    }
  }
}

/* ───────── 广播 ───────── */
function broadcast(obj) {
  for (const [ws] of conns) wsSend(ws, obj);
}
function broadcastDelta(upserts, removed = []) {
  revision += 1;
  broadcast({
    type: 'delta', revision,
    upserts: upserts.map(wireVisitor),
    removed,
    serverTime: Date.now(),
  });
}
function broadcastEvent(type, id) {
  broadcast({ type: 'event', event: { type, id } });
}
function snapshotFor(info) {
  pruneIncense();
  return {
    type: 'snapshot',
    room: ROOM_ID,
    selfId: info.visitorId,
    visitors: [...visitors.values()].map(wireVisitor),
    revision,
    serverTime: Date.now(),
    entryIdle: true,
    incense: incense.map((o) => ({ ...o })),
    visitToken: info.token,
    ...(info.resumed ? { resumed: true } : {}),
  };
}

/* ───────── 连接生命周期 ───────── */
function setupConnection(socket, params) {
  let info = null;
  let dead = false;

  const finish = () => {
    if (dead) return;
    dead = true;
    if (info) {
      console.log(`[presence] 断开 ${info.visitorId.slice(0, 8)} room=${ROOM_ID} 剩余连接=${conns.size - 1}`);
      msgLog.delete(info.visitorId);
      const record = visitorsSnapshot(info.visitorId);
      if (record && record.cushion !== null && record.cushion !== undefined) markCushionCooling(record.cushion);
      visitors.delete(info.visitorId);
      conns.delete(socket);
      // 保留记录供 resume(同一标签页刷新/切后台后恢复同一访客)
      lapsed.set(info.token, { record, expiresAt: Date.now() + LAPSED_MS });
      broadcastDelta([], [info.visitorId]);
    } else {
      console.log('[presence] 未完成握手即断开');
    }
    try { socket.destroy(); } catch { }
  };
  const visitorsSnapshot = (id) => {
    const v = visitors.get(id);
    return v ? JSON.parse(JSON.stringify(v)) : null;
  };

  const reader = new FrameReader(
    (text) => { try { handleMessage(socket, text); } catch (e) { console.warn('message error:', e.message); } },
    finish,
    (payload) => wsPong(socket, payload),
  );
  socket.on('data', (chunk) => reader.feed(chunk));
  socket.on('error', finish);
  socket.on('close', finish);

  // ── 入场/复活访客 ──
  const token = params.get('visit') || crypto.randomUUID();
  let v = null;
  let resumed = false;
  const lap = lapsed.get(token);
  if (lap && lap.expiresAt > Date.now() && lap.record) {
    lapsed.delete(token);
    resumed = true;
    const seatFree = ![...visitors.values()].some((x) => x.seat === lap.record.seat);
    if (lap.record.cushion !== null && lap.record.cushion !== undefined) markCushionCooling(lap.record.cushion);
    v = {
      ...lap.record,
      cushion: null,
      bowAt: undefined,
      pose: 'walk',
      seat: seatFree ? lap.record.seat : freeSeat(),
      position: spawnPos(seatFree ? lap.record.seat : 0, [...visitors.values()].map((x) => x.position).filter(Boolean)),
    };
  } else {
    v = makeVisitor();
  }
  if (visitors.size >= CAPACITY) {
    wsSend(socket, { type: 'error', code: 'room-full', serverTime: Date.now() });
    try { socket.destroy(); } catch { }
    return;
  }
  visitors.set(v.id, v);
  info = { visitorId: v.id, token, resumed };
  conns.set(socket, info);
  console.log(`[presence] 连接 ${v.name}(${v.id.slice(0, 8)}) room参数=${params.get('room')} resume=${resumed} 总连接=${conns.size}`);

  wsSend(socket, snapshotFor(info));
  broadcastDelta([v]); // 新访客广播给所有人(新访客自己也会收到,revision 连续,无副作用)
}

/* ───────── 客户端消息处理 ───────── */
const msgLog = new Map(); // 诊断:每连接前若干条消息
function handleMessage(socket, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg.type !== 'string') return;
  const info = conns.get(socket);
  if (!info) return;
  const seen = msgLog.get(info.visitorId) ?? 0;
  if (seen < 30) {
    const extra = msg.type === 'move' ? ` x=${round2(msg.x)} z=${round2(msg.z)} pose=${msg.pose}` : msg.requestId !== undefined ? ` req=${msg.requestId}` : msg.revision !== undefined ? ` rev=${msg.revision}` : '';
    console.log(`[msg] ${info.visitorId.slice(0, 8)} ${msg.type}${extra}`);
    msgLog.set(info.visitorId, seen + 1);
  }
  const v = visitors.get(info.visitorId);
  const now = Date.now();

  switch (msg.type) {
    case 'move': {
      if (!v) return;
      const { x, z, yaw, pose } = msg;
      if (![x, z, yaw].every(Number.isFinite) || !POSES.includes(pose)) return;
      v.position = { x, z, yaw };
      v.pose = pose;
      if (pose !== 'kneel' && v.cushion !== null && v.cushion !== undefined) {
        // 离开蒲团走动 = 起身,释放座位(带冷却)
        markCushionCooling(v.cushion);
        v.cushion = null;
      }
      broadcastDelta([v]);
      break;
    }
    case 'stand': {
      if (!v) return;
      if (v.cushion !== null && v.cushion !== undefined) markCushionCooling(v.cushion);
      v.cushion = null;
      v.pose = 'walk';
      broadcastDelta([v]);
      break;
    }
    case 'hello':
      if (v) broadcastEvent('hello', v.id);
      break;
    case 'bow':
      if (v) { v.bowAt = now; broadcastDelta([v]); broadcastEvent('bow', v.id); }
      break;
    case 'bead':
      if (v) broadcastEvent('bead', v.id);
      break;
    case 'seat': {
      if (!v) return;
      const c = freeCushion();
      if (c === null) { wsSend(socket, { type: 'seat-unavailable', requestId: msg.requestId }); break; }
      if (v.cushion !== null && v.cushion !== undefined) markCushionCooling(v.cushion); // 换座:旧座冷却
      v.cushion = c;
      v.position = cushionPos(c);
      v.pose = 'kneel';
      wsSend(socket, { type: 'seat-granted', requestId: msg.requestId, seat: c });
      broadcastDelta([v]);
      break;
    }
    case 'incense': {
      if (!v) return;
      pruneIncense();
      const offering = { id: crypto.randomUUID(), visitorId: v.id, at: now, expiresAt: now + INCENSE_MS };
      incense.push(offering);
      wsSend(socket, { type: 'incense-result', requestId: msg.requestId, accepted: true });
      broadcast({ type: 'incense', offering, serverTime: now });
      break;
    }
    case 'sync':
      if (v) wsSend(socket, snapshotFor(info));
      break;
    case 'ping':
      wsSend(socket, { type: 'pong', serverTime: now });
      break;
    case 'ack':
    case 'pong':
    case 'entry-active':
    case 'entry-idle':
      break;
    case 'leave':
      try { socket.end(); } catch { }
      break;
    default:
      break;
  }
}

/* ───────── 虚拟玩家行为系统(500ms tick 驱动) ───────── */
// 空间地标(与 bundle 的殿堂/庭院几何一致):
//   大殿内部 |x|<16, z∈[-20,21.5];柱子在 x=±16.4 一带,避开
//   佛像位于殿内深处 z≈-21(朝 -z 即面向佛,yaw=0)
//   蒲团网格 As(i):x=-12~12, z=-8.4~16.8
//   香炉位于殿前沿 (x=0, z≈23.95)
//   庭院(灯笼步道/莲池) z∈[24,32]
const WALK_SPEED_MIN = 1.05, WALK_SPEED_MAX = 1.5;
const HALL = { minX: -14.5, maxX: 14.5, frontZ: 21, backZ: -19.5 };
const BUDDHA_SPOTS = [-4.5, -2.2, 0, 2.2, 4.5].map((x) => ({ x, z: -18.5 - Math.random() * 1.5 })); // 佛前拜位
const INCENSE_SPOTS = [-1.6, 1.6].map((x) => ({ x, z: 24.9 })); // 香炉两侧上香点(面向炉)
const STROLL_RECT = { minX: -11, maxX: 11, minZ: 24.5, maxZ: 31 }; // 庭院漫步区
const dirty = new Set();
const toRemove = new Set();

function pickWalkSpeed() { return WALK_SPEED_MIN + Math.random() * (WALK_SPEED_MAX - WALK_SPEED_MIN); }

function makeBot({ backdate = 0 } = {}) {
  const v = makeVisitor({ backdate });
  visitors.set(v.id, v);
  bots.add(v.id);
  Object.assign(v, {
    state: 'idle',           // idle | walk
    act: null,               // 当前活动 { kind, stage, ... }
    nextDecisionAt: Date.now() + 1500 + Math.random() * 5000,
    from: null, to: null, walkStart: 0, walkDur: 1, walkSpeed: pickWalkSpeed(), onArrive: null,
    sitUntil: 0, bowsLeft: 0, nextBowAt: 0,
  });
  dirty.add(v);
  return v;
}

function botWalkTo(v, target, speed, then) {
  const dist = Math.hypot(target.x - v.position.x, target.z - v.position.z);
  if (dist < 0.15) { then?.(); return; }
  const sp = speed ?? v.walkSpeed ?? 1.3;
  v.from = { ...v.position };
  v.to = { ...target };
  v.walkStart = Date.now();
  v.walkDur = Math.max(500, (dist / sp) * 1000);
  v.state = 'walk';
  v.pose = 'walk';
  v.cushion = null;
  v.onArrive = then;
}

function botStop(v, now) {
  v.state = 'idle';
  v.act = null;
  v.pendingCushion = undefined; // 释放途中预订
  v.nextDecisionAt = now + 2500 + Math.random() * 6000;
}

// ── 活动定义 ──
function startWorship(v, now) {
  // 参拜:走到佛像前 → 面佛 → 连拜 1~3 次 → 静立片刻
  const spot = BUDDHA_SPOTS[Math.floor(Math.random() * BUDDHA_SPOTS.length)];
  const bows = 1 + Math.floor(Math.random() * 3);
  botWalkTo(v, { x: spot.x, z: spot.z, yaw: 0 }, null, () => {
    v.pose = 'walk';
    v.yawFace = 0;
    v.position.yaw = 0;
    dirty.add(v);
    v.act = { kind: 'worship', stage: 'bowing', bowsLeft: bows, nextAt: now + 1200 + Math.random() * 800 };
    v.nextDecisionAt = Infinity;
  });
}
function startSit(v, now) {
  // 落座:预订空蒲团(途中即占位,防止两人同订) → 走过去坐下(20~90 秒),期间偶尔拨珠
  const c = freeCushion();
  if (c === null) { botStop(v, now); return; }
  v.pendingCushion = c;
  const p = cushionPos(c);
  botWalkTo(v, { x: p.x, z: p.z, yaw: 0 }, null, () => {
    if (v.pendingCushion !== c) return; // 预订被清(离开/被移除)
    v.pendingCushion = undefined;
    v.cushion = c;
    v.pose = 'kneel';
    v.position.yaw = 0;
    delete v.bowAt;
    v.sitUntil = Date.now() + 20000 + Math.random() * 70000;
    v.act = { kind: 'sit', stage: 'sitting' };
    dirty.add(v);
    v.nextDecisionAt = Infinity;
  });
}
function startIncense(v, now) {
  // 上香:走到香炉旁 → 上香(offering 广播即触发众人动画) → 静立 → 结束
  const spot = INCENSE_SPOTS[Math.floor(Math.random() * INCENSE_SPOTS.length)];
  botWalkTo(v, { x: spot.x, z: spot.z, yaw: 0 }, null, () => {
    v.position.yaw = 0;
    v.pose = 'walk';
    dirty.add(v);
    pruneIncense();
    const offering = { id: crypto.randomUUID(), visitorId: v.id, at: now, expiresAt: now + INCENSE_MS };
    incense.push(offering);
    broadcast({ type: 'incense', offering, serverTime: now });
    v.act = { kind: 'incense', stage: 'praying', nextAt: now + 4000 + Math.random() * 4000 };
    v.nextDecisionAt = Infinity;
  });
}
function startStroll(v) {
  // 漫步:庭院里连走 2~4 个途经点
  const legs = 2 + Math.floor(Math.random() * 3);
  v.act = { kind: 'stroll', stage: 'walking', legsLeft: legs };
  v.nextDecisionAt = Infinity;
  strollLeg(v);
}
function strollLeg(v) {
  if (v.act?.kind !== 'stroll' || v.act.legsLeft <= 0) { botStop(v, Date.now()); return; }
  v.act.legsLeft--;
  botWalkTo(v, {
    x: STROLL_RECT.minX + Math.random() * (STROLL_RECT.maxX - STROLL_RECT.minX),
    z: STROLL_RECT.minZ + Math.random() * (STROLL_RECT.maxZ - STROLL_RECT.minZ),
    yaw: 0,
  }, null, () => { v.nextDecisionAt = Date.now() + 600 + Math.random() * 1500; });
}
function startLinger(v, now) {
  // 伫立:原地静立张望,偶尔合掌
  v.act = { kind: 'linger', stage: 'standing', helloAt: Math.random() < 0.4 ? now + 1500 + Math.random() * 3000 : 0 };
  v.nextDecisionAt = now + 5000 + Math.random() * 6000;
  v.nextDecisionAt = Infinity;
  v.act.endAt = now + 5000 + Math.random() * 6000;
}

function botPickActivity(v, now) {
  const r = Math.random();
  if (r < 0.30) startWorship(v, now);
  else if (r < 0.55) startSit(v, now);
  else if (r < 0.68) startIncense(v, now);
  else if (r < 0.86) startStroll(v);
  else startLinger(v, now);
}

function botAdvanceAct(v, now) {
  const a = v.act;
  if (!a) return;
  if (a.kind === 'worship' && a.stage === 'bowing') {
    if (now >= a.nextAt) {
      if (a.bowsLeft <= 0) {
        delete v.bowAt;
        dirty.add(v);
        botStop(v, now);
        return;
      }
      a.bowsLeft--;
      v.bowAt = now;
      broadcastEvent('bow', v.id);
      dirty.add(v);
      a.nextAt = now + 4200 + Math.random() * 1200;
    }
  } else if (a.kind === 'sit' && a.stage === 'sitting') {
    if (now >= v.sitUntil) {
      markCushionCooling(v.cushion);
      v.cushion = null;
      v.pose = 'walk';
      dirty.add(v);
      botStop(v, now);
    } else if (Math.random() < 0.05) {
      broadcastEvent('bead', v.id);
    }
  } else if (a.kind === 'incense' && a.stage === 'praying') {
    if (now >= a.nextAt) botStop(v, now);
  } else if (a.kind === 'linger') {
    if (a.helloAt && now >= a.helloAt) {
      broadcastEvent('hello', v.id);
      a.helloAt = 0;
    }
    if (now >= a.endAt) botStop(v, now);
  }
}

function botTick() {
  const now = Date.now();
  for (const id of bots) {
    const v = visitors.get(id);
    if (!v) { bots.delete(id); continue; }
    // 移动插值
    if (v.state === 'walk') {
      const t = Math.min(1, (now - v.walkStart) / v.walkDur);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad
      const dx = v.to.x - v.from.x, dz = v.to.z - v.from.z;
      v.position = { x: v.from.x + dx * e, z: v.from.z + dz * e, yaw: Math.atan2(-dx, -dz) || 0 };
      dirty.add(v);
      if (t >= 1) {
        v.state = 'idle';
        const cb = v.onArrive;
        v.onArrive = null;
        cb?.();
      }
    } else {
      botAdvanceAct(v, now);
    }
    // 漫步的多段行走
    if (v.act?.kind === 'stroll' && v.state === 'idle' && now >= v.nextDecisionAt) strollLeg(v);
    // 空闲时挑选新活动
    if (!v.act && v.state === 'idle' && now >= v.nextDecisionAt) botPickActivity(v, now);
  }
  // 来去动态:维持随机目标人数上下浮动
  if (Math.random() < 0.008) {
    const target = Math.max(2, Math.min(14, BOT_TARGET + (Math.random() < 0.5 ? -1 : 1)));
    if (bots.size < target) {
      makeBot();
    } else if (bots.size > target) {
      const arr = [...bots];
      toRemove.add(arr[Math.floor(Math.random() * arr.length)]);
    }
  }
  // 应用变更:一批 upsert/removed 合并为一个 delta
  if (dirty.size) {
    const ups = [...dirty].filter((v) => visitors.has(v.id));
    dirty.clear();
    if (ups.length) broadcastDelta(ups);
  }
  if (toRemove.size) {
    const ids = [...toRemove];
    toRemove.clear();
    for (const id of ids) { visitors.delete(id); bots.delete(id); }
    broadcastDelta([], ids);
  }
}

/* ───────── 定期清理 ───────── */
setInterval(() => {
  const now = Date.now();
  for (const [token, lap] of lapsed) if (lap.expiresAt <= now) lapsed.delete(token);
}, 60000);

/* ───────── HTTP:静态 + /api/rooms ───────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
};
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { res.writeHead(400); res.end(); return; }
  if (url.pathname === '/api/rooms') {
    pruneIncense();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      rooms: [{ id: ROOM_ID, number: ROOM_NUMBER, count: visitors.size, capacity: CAPACITY, checkedAt: Date.now() }],
      serverTime: Date.now(),
    }));
    return;
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, visitors: visitors.size, bots: bots.size, revision, incense: incense.length }));
    return;
  }
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(SITE, p));
  if (file !== SITE && !file.startsWith(SITE + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ───────── WS 升级 ───────── */
server.on('upgrade', (req, socket) => {
  let url;
  try { url = new URL(req.url, 'http://local'); } catch { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/presence' || !key || (req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  setupConnection(socket, url.searchParams);
});

/* ───────── 启动 ───────── */
server.listen(PORT, HOST, () => {
  // 初始虚拟玩家:随机数量,入场时间回溯(像已经待了一会儿)
  for (let i = 0; i < BOT_TARGET; i++) {
    makeBot({ backdate: 60000 + Math.floor(Math.random() * 120 * 60000) });
  }
  console.log(`山寺本地服务器  http://${HOST}:${PORT}/`);
  console.log(`虚拟玩家:${bots.size} 位(随机)`);
});
setInterval(botTick, 500);
