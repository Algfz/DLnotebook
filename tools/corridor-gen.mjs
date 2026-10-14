// 走廊式布景生成器：把方块贴着路带两侧排成一片，让"障碍物勾勒出路线"。
// 基准 = 仓库根目录 sketch-plan.json（作者手摆草图＝最低标准）：方块内边缘基本贴着路带边缘、
// 沿路 zigzag 成排、大小有层次、路两侧都有；**任何方块都不许压进路带**。
//
// 用法：
//   node tools/corridor-gen.mjs --t0 0 --t1 46 --step 2.6 --far 24          # 干跑（只报数）
//   node tools/corridor-gen.mjs --t0 0 --t1 46 --step 2.6 --far 24 --apply  # 写回 level.json
//   node tools/corridor-gen.mjs --preview out/corridor-preview.svg          # 出俯视取证图
import fs from "node:fs";
import path from "node:path";

const A = process.argv.slice(2);
const arg = (k, d) => {
  const i = A.indexOf("--" + k);
  if (i >= 0) return A[i + 1];
  const eq = A.find((x) => x.startsWith("--" + k + "="));
  return eq ? eq.split("=").slice(1).join("=") : d;
};
const has = (k) => A.includes("--" + k) || A.some((x) => x.startsWith("--" + k + "="));

const LEVEL = arg("level", "levels/ring a bell-灰澈/level.json");
const T0 = +arg("t0", 0), T1 = +arg("t1", 46);
const STEP = +arg("step", 2.6);          // 沿路锚点间距（米）
const FAR = +arg("far", 24);             // 每侧铺到多宽（米）
const JIT = +arg("jitter", 0.42);        // 沿路抖动比例
const GAPMIN = +arg("gapmin", 0.35);     // 方块之间最小缝（"别留太小"）
const EDGEMIN = +arg("edge", 0.25);      // 方块内边缘离路带边缘的最小余量
// 贴边下限改用"离路中心线的绝对距离"：作者草图里 p05=0.79m、min=0.70m，他的标准就是允许方块
// 稍微咬进 1.5m 路带一点（但绝不允许压住中心线/横跨路面）。
const INNER = +arg("inner", 0.75);
const CLEAR = +arg("clear", 0.12);       // 多大的比例直接留空（"别留太大"靠别处控制）
const APP = has("apply");
const PREVIEW = arg("preview", null);

const lvl = JSON.parse(fs.readFileSync(LEVEL, "utf8"));
const roadHalf = (lvl.roadWidth || 3) / 2;
const P = lvl.path;
if (!P || P.length < 2) throw new Error("level.json 里没有 path");

// ---- 折线：把 path 拆成 (x,z) 段 + 弧长，用来算"到路中心线的精确距离" ----
const segs = [];
let total = 0;
for (let i = 1; i < P.length; i++) {
  const a = P[i - 1], b = P[i];
  const ax = a.pos[0], az = a.pos[2], bx = b.pos[0], bz = b.pos[2];
  const L = Math.hypot(bx - ax, bz - az);
  if (L < 1e-6) continue;
  segs.push({ ax, az, bx, bz, L, s0: total, t0: a.t, t1: b.t });
  total += L;
}
function tAt(s) {
  const g = segs.find((x) => s <= x.s0 + x.L) || segs[segs.length - 1];
  const f = Math.max(0, Math.min(1, (s - g.s0) / g.L));
  return g.t0 + (g.t1 - g.t0) * f;
}
function ptAt(s) {
  const g = segs.find((x) => s <= x.s0 + x.L) || segs[segs.length - 1];
  const f = Math.max(0, Math.min(1, (s - g.s0) / g.L));
  const x = g.ax + (g.bx - g.ax) * f, z = g.az + (g.bz - g.az) * f;
  const dx = (g.bx - g.ax) / g.L, dz = (g.bz - g.az) / g.L;
  return { x, z, tx: dx, tz: dz, nx: -dz, nz: dx };
}

// ---- 精确"线段 × 轴对齐矩形"最小距离（与 tools/layout-gen.mjs 同一套） ----
function segRectDist(ax, az, bx, bz, cx, cz, w, d) {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  if (ax === bx) { if (ax >= x0 && ax <= x1 && Math.max(Math.min(az, bz), z0) <= Math.min(Math.max(az, bz), z1)) return 0; }
  else if (az === bz) { if (az >= z0 && az <= z1 && Math.max(Math.min(ax, bx), x0) <= Math.min(Math.max(ax, bx), x1)) return 0; }
  else {
    const dx = bx - ax, dz = bz - az;
    let t0 = 0, t1 = 1;
    const clip = (p, q) => { if (p === 0) return q >= 0; const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } return true; };
    if (clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dz, az - z0) && clip(dz, z1 - az) && t0 <= t1) return 0;
  }
  const px = (v) => Math.max(x0, Math.min(x1, v)), pz = (v) => Math.max(z0, Math.min(z1, v));
  const d2 = (x, z) => (x - px(x)) ** 2 + (z - pz(z)) ** 2;
  const seg2 = (x, z) => { const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1; let k = ((x - ax) * dx + (z - az) * dz) / L2; k = Math.max(0, Math.min(1, k)); return (x - (ax + dx * k)) ** 2 + (z - (az + dz * k)) ** 2; };
  let m = Math.min(d2(ax, az), d2(bx, bz));
  for (const [cx2, cz2] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) m = Math.min(m, seg2(cx2, cz2));
  return Math.sqrt(m);
}
function clrToRoad(cx, cz, w, d) {
  let m = Infinity;
  for (const g of segs) {
    if (cx + w / 2 < Math.min(g.ax, g.bx) - m && cx - w / 2 > Math.max(g.ax, g.bx) + m) continue;
    const v = segRectDist(g.ax, g.az, g.bx, g.bz, cx, cz, w, d);
    if (v < m) { m = v; if (m === 0) return 0; }
  }
  return m;
}

// ---- 已经放好的方块：空间网格，查重叠/缝 ----
const grid = new Map();
const cell = 8;
const key = (x, z) => Math.floor(x / cell) + "," + Math.floor(z / cell);
function near(cx, cz, w, d) {
  const out = [];
  const i0 = Math.floor((cx - w / 2) / cell), i1 = Math.floor((cx + w / 2) / cell);
  const j0 = Math.floor((cz - d / 2) / cell), j1 = Math.floor((cz + d / 2) / cell);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = grid.get(i + "," + j); if (a) out.push(...a); }
  return out;
}
function add(b) {
  const k = key(b.x, b.z);
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push(b);
}
const overlap = (a, b, gap) => !(a.x + a.w / 2 + gap <= b.x - b.w / 2 || b.x + b.w / 2 + gap <= a.x - a.w / 2
  || a.z + a.d / 2 + gap <= b.z - b.d / 2 || b.z + b.d / 2 + gap <= a.z - a.d / 2);

// ---- 先把窗口外的旧件原样装进网格，避免新件压到它们 ----
const keep = [], replaced = [];
for (const it of lvl.place || []) {
  if (it.t >= T0 && it.t <= T1) { replaced.push(it); continue; }
  keep.push(it);
  const g = segAtT(it.t);
  if (g) add({ x: g.x + g.nx * it.off, z: g.z + g.nz * it.off, w: it.w, d: it.d || it.w });
}
function segAtT(t) {
  let i = 1;
  while (i < P.length - 1 && P[i].t < t) i++;
  const a = P[i - 1], b = P[i];
  const f = Math.max(0, Math.min(1, (t - a.t) / Math.max(1e-9, b.t - a.t)));
  const x = a.pos[0] + (b.pos[0] - a.pos[0]) * f, z = a.pos[2] + (b.pos[2] - a.pos[2]) * f;
  const dx = b.pos[0] - a.pos[0], dz = b.pos[2] - a.pos[2], L = Math.hypot(dx, dz) || 1;
  return { x, z, nx: -dz / L, nz: dx / L };
}
console.log("窗口 t∈[" + T0 + ", " + T1 + "]：保留 " + keep.length + " 件，待重做 " + replaced.length + " 件");

// ---- 沿路"篱笆"：弧长每 STEP 米推进一步，两侧同时从路带边缘往外铺 ----
// 关键区别于上一版（先摆最宽敞的点）：这里是**由近到远**铺，所以贴边那一排一定是连续的，
// 不会出现"路和最近方块之间还隔着 3~10m 草坪"。尺寸/高度按"离中心线多远"分档（作者草图贴边件
// 就是 1~3m 的小块、高度全 1m）。
const rnd = (() => { let s = 20261014; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const R = (a, b) => a + rnd() * (b - a);
const FARN = +arg("far", 45);       // 每侧铺到多宽（米）
const BAND = [
  { d: 3.0, size: [1.4, 2.4], h: [1.0, 1.5], skip: 0.04, tone: 0 },
  { d: 6.0, size: [2.0, 3.4], h: [1.5, 2.5], skip: 0.18, tone: 0 },
  { d: 10.0, size: [2.8, 5.0], h: [2.0, 3.5], skip: 0.34, tone: 1 },
  { d: 18.0, size: [4.0, 7.5], h: [2.5, 4.5], skip: 0.46, tone: 1 },
  { d: Infinity, size: [6.0, 11.0], h: [3.0, 6.0], skip: 0.68, tone: 1 },
];
const bandOf = (d) => BAND.find((b) => d < b.d) || BAND[BAND.length - 1];

function nearestOnPath(x, z) {
  let best = null;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    const ax = a.pos[0], az = a.pos[2], dx = b.pos[0] - ax, dz = b.pos[2] - az;
    const L2 = dx * dx + dz * dz || 1;
    let k = ((x - ax) * dx + (z - az) * dz) / L2; k = Math.max(0, Math.min(1, k));
    const px = ax + dx * k, pz = az + dz * k;
    const d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) {
      const L = Math.sqrt(L2), nx = -dz / L, nz = dx / L;
      best = { d, t: a.t + (b.t - a.t) * k, off: (x - px) * nx + (z - pz) * nz };
    }
  }
  return best;
}

const made = [];
let anchors = 0, skips = 0, tries = 0, fClr = 0, fHit = 0;

for (let s = 0; s <= total; s += STEP) {
  const t = tAt(s);
  if (t < T0 || t > T1) continue;
  const g = ptAt(s);
  for (const side of [1, -1]) {
    let d = roadHalf + EDGEMIN;                       // 本排"内边缘离路中心线"的距离
    while (d < FARN) {
      const bd = bandOf(d);
      if (rnd() < bd.skip) { skips++; d += R(0.9, 2.4); continue; }   // 随机留空：别铺成一整片地板
      const w = R(bd.size[0], bd.size[1]);
      const dd = w * R(0.85, 1.15);
      const cx = g.x + g.nx * side * (d + dd / 2);
      const cz = g.z + g.nz * side * (d + dd / 2);
      tries++;
      const clr = clrToRoad(cx, cz, w, dd);
      if (clr < INNER - 1e-6) { fClr++; d += 0.6; continue; }          // 咬进路带了：往外挪一格再试
      if (near(cx, cz, w, dd).some((b) => overlap({ x: cx, z: cz, w, d: dd }, b, GAPMIN))) { fHit++; d += 0.9; continue; }
      // ⚠️ 用锚点 s 自己的法线反解 off（不要用 nearestOnPath：锯齿路上会吸到别的腿，引擎复原位置会偏）
      const offS = (cx - g.x) * g.nx + (cz - g.z) * g.nz;
      const h = +R(bd.h[0], bd.h[1]).toFixed(2);
      made.push({
        t: +tAt(s).toFixed(3), off: +offS.toFixed(2), w: +w.toFixed(2), h, d: +dd.toFixed(2),
        tone: bd.tone, rot: 0, rise: false, exact: true,
        clr: +clr.toFixed(3), g: 1, anim: "breath", phase: +rnd().toFixed(3),
      });
      add({ x: cx, z: cz, w, d: dd });
      anchors++;
      d += dd + R(0.35, 1.6);                                          // 下一排：外边缘 + 一条缝
    }
  }
}
console.log("  尝试 " + tries + " 次：压路带被拒 " + fClr + "、撞已有被拒 " + fHit);
console.log("锚点 " + anchors + " 个（" + (skips) + " 次随机留空）；新件 " + made.length + " 件");

// ---- 统计 ----
const ws = made.map((m) => m.w).sort((a, b) => a - b);
const cl = made.map((m) => m.clr).sort((a, b) => a - b);
const hs = made.map((m) => m.h);
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log("  方块宽：min " + ws[0].toFixed(2) + " 中位 " + q(ws, 0.5).toFixed(2) + " p95 " + q(ws, 0.95).toFixed(2) + " max " + ws[ws.length - 1].toFixed(2));
console.log("  内边缘到路中心线：min " + cl[0].toFixed(2) + " 中位 " + q(cl, 0.5).toFixed(2) + " p95 " + q(cl, 0.95).toFixed(2) + "（路带半宽 " + roadHalf + "，即最小缝 " + (cl[0] - roadHalf).toFixed(2) + " m）");
console.log("  压进路带(<" + roadHalf + "m)：" + cl.filter((x) => x < roadHalf).length + " 件");
console.log("  高度分布：" + [...new Set(hs)].sort((a, b) => a - b).map((h) => h + "m×" + hs.filter((x) => x === h).length).join(" "));

if (PREVIEW) {
  const sk = fs.existsSync("sketch-plan.json") ? JSON.parse(fs.readFileSync("sketch-plan.json", "utf8")) : null;
  let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
  const box = (x, z) => { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); };
  for (const g of segs) { if (tAt(g.s0) < T0 || tAt(g.s0) > T1) continue; box(g.ax, g.az); box(g.bx, g.bz); }
  for (const m of made) { const g = segAtT(m.t); if (!g) continue; const x = g.x + g.nx * m.off, z = g.z + g.nz * m.off; box(x - m.w / 2, z - m.d / 2); box(x + m.w / 2, z + m.d / 2); }
  const S = Math.min(1600 / Math.max(1, maxx - minx + 20), 1600 / Math.max(1, maxz - minz + 20), 40);
  const W = ((maxx - minx + 20) * S).toFixed(0), H = ((maxz - minz + 20) * S).toFixed(0);
  const X = (x) => ((x - minx + 10) * S).toFixed(1), Z = (z) => ((maxz + 10 - z) * S).toFixed(1);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#efece4"/>`;
  const road = [] ;
  for (let s = 0; s <= total; s += 1) { const p = ptAt(s), t = tAt(s); if (t < T0 || t > T1) continue; road.push(X(p.x) + " " + Z(p.z)); }
  svg += `<path d="M ` + road.join(" L ") + `" fill="none" stroke="#fff" stroke-width="${(roadHalf * 2 * S).toFixed(1)}" stroke-linejoin="round"/>`;
  svg += `<path d="M ` + road.join(" L ") + `" fill="none" stroke="#d93636" stroke-width="1.5" stroke-dasharray="7 6"/>`;
  for (const m of made) {
    const g = segAtT(m.t); const x = g.x + g.nx * m.off, z = g.z + g.nz * m.off;
    svg += `<rect x="${X(x - m.w / 2)}" y="${Z(z + m.d / 2)}" width="${(m.w * S).toFixed(1)}" height="${(m.d * S).toFixed(1)}" fill="#5b6f9c" fill-opacity="0.9"/>`;
  }
  svg += `</svg>`;
  fs.writeFileSync(PREVIEW, svg);
  console.log("  取证图 → " + PREVIEW + "（" + W + "x" + H + "）");
}

if (APP) {
  const bak = path.join("out/bak", "level-" + path.basename(path.dirname(LEVEL)).replace(/[^\w\u4e00-\u9fa5-]/g, "_") + "-" + Date.now() + ".json");
  fs.mkdirSync("out/bak", { recursive: true });
  fs.copyFileSync(LEVEL, bak);
  const all = keep.concat(made).sort((a, b) => a.t - b.t);
  lvl.place = all;
  fs.writeFileSync(LEVEL, JSON.stringify(lvl, null, 2));
  console.log("已写回 " + LEVEL + "：place[] = " + made.length + " 新 + " + keep.length + " 保留（备份 " + bak + "）");
}
