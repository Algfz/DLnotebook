#!/usr/bin/env node
/* =====================================================================
   gen-scenery.js —— 沿路线密布纯几何块（布景）

   目标：保证玩家视野内始终有内容（发起人：密集摆在路面周围，
   一定范围内都要有东西，让屏幕丰富起来）。

   三层结构（参照优秀同类关卡）：
     近景  贴着路线的小块，密集，形成"路在块中穿行"的包围感
     中景  中等块，撑开中间层次
     远景  大平台 / 高柱，铺天际线（同时充当锚点）

   所有层都做净空检查（不挡路）、互不重叠、疏密跟随音乐能量。
   输出写回 level.json 的 scenery 字段（客户端只渲染）。
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const SEED    = parseInt(arg('seed', '1'), 10);
const DENSITY = parseFloat(arg('density', '1'));     // 密度倍率
const CLEAR   = parseFloat(arg('clear', '4'));       // 距路线的最小净空

/* ---------------------- 可复现随机 ---------------------- */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------- 定位关卡目录 ---------------------- */
const lvRoot = 'levels';
const dirs = fs.readdirSync(lvRoot)
  .map(d => path.join(lvRoot, d))
  .filter(d => fs.statSync(d).isDirectory() && fs.readdirSync(d).includes('level.json'));
dirs.sort((a, b) => fs.statSync(path.join(b, 'level.json')).mtimeMs
               - fs.statSync(path.join(a, 'level.json')).mtimeMs);
const dir = dirs[0];

const lvPath = path.join(dir, 'level.json');
const dlPath = path.join(dir, 'dance-line.json');
const anPath = path.join(dir, 'music-analysis.json');

function readJson(p) {
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn('跳过无法解析的 ' + p + '：' + e.message); return null; }
}
const lv = readJson(lvPath);
const dl = readJson(dlPath);
const an = readJson(anPath);
if (!lv || !dl) {
  console.error('缺少 level.json 或 dance-line.json（先跑 build/gen-path.js --level）');
  process.exit(1);
}

const H   = (lv.motion?.spawn?.y) || 0;
const pts = dl.points;
const segs = [];
for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);

/* ---------------------- 音乐能量 ---------------------- */
const segEnergy = an?.segments || null;
let eMin = 1e9, eMax = -1e9;
if (segEnergy) for (const s of segEnergy) { eMin = Math.min(eMin, s.energy); eMax = Math.max(eMax, s.energy); }
function normE(t) {
  if (!segEnergy?.length) return 0.5;
  for (const s of segEnergy) if (t >= s.t[0] && t < s.t[1])
    return (s.energy - eMin) / (eMax - eMin + 1e-9);
  const last = segEnergy[segEnergy.length - 1];
  return (last.energy - eMin) / (eMax - eMin + 1e-9);
}

/* ---------------------- 几何辅助 ---------------------- */
function distToSeg(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const L2 = dx * dx + dz * dz;
  if (L2 < 1e-9) return Math.hypot(x - a.x, z - a.z);
  let u = ((x - a.x) * dx + (z - a.z) * dz) / L2;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u));
}
function distToPath(x, z) {
  let best = Infinity;
  for (const [a, b] of segs) {
    const d = distToSeg(x, z, a, b);
    if (d < best) best = d;
  }
  return best;
}

/* ---------------------- 三层摆放 ---------------------- */
// slot:沿路线间隔  pSide:每侧放置概率  d:距路线范围  s:平面尺寸  h:高度  yo:高度中心偏移
const LAYERS = [
  { name: '近景', slot: 3,  pSide: 0.9, dMin: 3.5, dMax: 9,   sMin: 0.7, sMax: 3,   hMin: 0.6, hMax: 5,  yo: [-2, 4] },
  { name: '中景', slot: 8,  pSide: 0.65, dMin: 9,  dMax: 24,  sMin: 2,   sMax: 8,   hMin: 1,   hMax: 12, yo: [-4, 10] },
  { name: '远景', slot: 20, pSide: 0.75, dMin: 24, dMax: 55,  sMin: 6,   sMax: 18,  hMin: 2,   hMax: 26, yo: [-8, 18] },
];

const rand = rng(SEED);
const items = [];
const placed = [];     // { x, z, r }
let made = 0;

for (const L of LAYERS) {
  const all = dl.samples || [];
  const step = Math.max(1, Math.round(L.slot / 5));       // samples 是每 5m 一个
  for (let i = 0; i < all.length; i += step) {
    const s = all[i];
    const e = normE(s.t);
    const pBoost = 0.45 + e * 0.65;                       // 高能量段更密

    for (const side of [-1, 1]) {
      if (rand() > L.pSide * pBoost * DENSITY) continue;

      const dir = s.dir || [1, 0];
      const nx = -dir[1] * side, nz = dir[0] * side;
      const off = L.dMin + rand() * (L.dMax - L.dMin);
      const x = s.x + nx * off, z = s.z + nz * off;

      const w = L.sMin + Math.pow(rand(), 1.8) * (L.sMax - L.sMin);
      const d = L.sMin + Math.pow(rand(), 1.8) * (L.sMax - L.sMin);
      const h = L.hMin + Math.pow(rand(), 1.4) * (L.hMax - L.hMin);
      const r = Math.max(w, d) / 2;

      // 净空：任何层的块都不许挡路
      if (distToPath(x, z) < CLEAR + r * 0.6) continue;

      // 与已有景物保持间隙（近景层检查得严，远层宽松些）
      const gap = L.name === '近景' ? 1.2 : 0.6;
      let ok = true;
      for (const q of placed) {
        if (Math.hypot(x - q.x, z - q.z) < r + q.r + gap) { ok = false; break; }
      }
      if (!ok) continue;

      const yc = H + L.yo[0] + rand() * (L.yo[1] - L.yo[0]);

      items.push({
        pos: [+x.toFixed(2), +yc.toFixed(2), +z.toFixed(2)],
        scale: [+w.toFixed(2), +h.toFixed(2), +d.toFixed(2)],
        angY: 0,
      });
      placed.push({ x, z, r });
      made++;
    }
  }
}

lv.scenery = { seed: SEED, count: items.length, items };
fs.writeFileSync(lvPath, JSON.stringify(lv, null, 2), 'utf8');

const byLayer = Math.round(items.length);
console.log(`
================================================
布景生成（三层密布）
================================================
关卡:   ${lvPath}
种子:   ${SEED}

景物:   ${items.length} 块
  近景  贴路线 3.5~9m，小块，包围感
  中景  9~24m，中等块
  远景  24~55m，大平台/高柱，天际线
净空:   ≥ ${CLEAR}m（不挡路）
疏密:   跟随音乐能量
`);
