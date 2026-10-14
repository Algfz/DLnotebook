// 以作者手摆的 sketch-plan.json 为**模板**，沿整段路重复铺设布景。
// 动机：发起人说过 "那个（sketch-plan.json）就是最低标准"。所以不去猜"障碍物勾勒出路线"，
// 而是把作者的排布规律（尺寸 1~22m、贴边 0.7~1.6m、1m 扁板、成排成片）沿路复制，
// 同时**只修掉一个缺陷**：不许压进路带（作者草图里有 158 件咬进 ±1.5m 路带，那是他说"直接搁路上"的部分）。
//
// 用法：
//   node tools/corridor-tile.mjs --t0 0 --t1 46            # 干跑
//   node tools/corridor-tile.mjs --t0 0 --t1 46 --apply     # 写回 level.json
import fs from "node:fs";
import path from "node:path";

const A = process.argv.slice(2);
const arg = (k, d) => { const i = A.indexOf("--" + k); if (i >= 0) return A[i + 1]; const eq = A.find((x) => x.startsWith("--" + k + "=")); return eq ? eq.split("=").slice(1).join("=") : d; };
const has = (k) => A.includes("--" + k) || A.some((x) => x.startsWith("--" + k + "="));

const LEVEL = arg("level", "levels/ring a bell-灰澈/level.json");
const SKETCH = arg("sketch", "sketch-plan.json");
const T0 = +arg("t0", 0), T1 = +arg("t1", 46);
const STEP_GAP = +arg("gap", 7);      // 相邻模板副本之间沿路留的空档（米）
const INNER = +arg("inner", 1.55);    // 内边缘离路中心线的硬下限（路带半宽 + 0.05）
const GAPMIN = +arg("gapmin", 0.25);  // 方块之间最小缝
const SKIP = +arg("skip", 0.08);      // 随机丢掉比例（别复制得一模一样）
const APP = has("apply");

const lvl = JSON.parse(fs.readFileSync(LEVEL, "utf8"));
const sk = JSON.parse(fs.readFileSync(SKETCH, "utf8"));
const P = lvl.path;
const roadHalf = (lvl.roadWidth || 3) / 2;

// ---- 折线弧长表 ----
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
const tAt = (s) => { const g = segs.find((x) => s <= x.s0 + x.L) || segs[segs.length - 1]; const f = Math.max(0, Math.min(1, (s - g.s0) / g.L)); return g.t0 + (g.t1 - g.t0) * f; };
function ptAt(s) {
  const g = segs.find((x) => s <= x.s0 + x.L) || segs[segs.length - 1];
  const f = Math.max(0, Math.min(1, (s - g.s0) / g.L));
  const dx = (g.bx - g.ax) / g.L, dz = (g.bz - g.az) / g.L;
  return { x: g.ax + (g.bx - g.ax) * f, z: g.az + (g.bz - g.az) * f, nx: -dz, nz: dx };
}
const sAtT = (t) => { const g = segs.find((x) => t <= x.t1) || segs[segs.length - 1]; const f = Math.max(0, Math.min(1, (t - g.t0) / Math.max(1e-9, g.t1 - g.t0))); return g.s0 + g.L * f; };

// ---- 精确"线段 × 轴对齐矩形"最小距离（与 layout-gen / corridor-gen 同一套） ----
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
function nearestOnPath(x, z) {
  let best = null;
  for (const g of segs) {
    const dx = g.bx - g.ax, dz = g.bz - g.az, L2 = dx * dx + dz * dz || 1;
    let k = ((x - g.ax) * dx + (z - g.az) * dz) / L2; k = Math.max(0, Math.min(1, k));
    const px = g.ax + dx * k, pz = g.az + dz * k;
    const d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) best = { d, t: g.t0 + (g.t1 - g.t0) * k, s: g.s0 + g.L * k, off: (x - px) * (-dz / g.L) + (z - pz) * (dx / g.L) };
  }
  return best;
}

// ---- 网格：查重叠 ----
const grid = new Map(), cell = 8;
const key = (x, z) => Math.floor(x / cell) + "," + Math.floor(z / cell);
const add = (b) => { const k = key(b.x, b.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(b); };
function nearB(cx, cz, w, d) {
  const out = [], i0 = Math.floor((cx - w / 2) / cell), i1 = Math.floor((cx + w / 2) / cell), j0 = Math.floor((cz - d / 2) / cell), j1 = Math.floor((cz + d / 2) / cell);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const a = grid.get(i + "," + j); if (a) out.push(...a); }
  return out;
}
const ov = (a, b, g) => !(a.x + a.w / 2 + g <= b.x - b.w / 2 || b.x + b.w / 2 + g <= a.x - a.w / 2 || a.z + a.d / 2 + g <= b.z - b.d / 2 || b.z + b.d / 2 + g <= a.z - a.d / 2);

// ---- 模板：草图方块 → (弧长 s, off) ----
const tmpl = [];
for (const b of sk.blocks) {
  const n = nearestOnPath(b.x, b.z);
  tmpl.push({ s: n.s, off: n.off, w: b.w, d: b.d || b.w, h: b.h || 1 });
}
tmpl.sort((a, b) => a.s - b.s);
const sMin = tmpl[0].s, sMax = tmpl[tmpl.length - 1].s;
const PERIOD = (sMax - sMin) + STEP_GAP;
console.log("模板 " + tmpl.length + " 件：弧长 " + sMin.toFixed(1) + "~" + sMax.toFixed(1) + " m（周期 " + PERIOD.toFixed(1) + " m）");

// ---- 窗口外的旧件保留 ----
const keep = [], replaced = [];
for (const it of lvl.place || []) {
  if (it.t >= T0 && it.t <= T1) { replaced.push(it); continue; }
  keep.push(it);
  const n = nearestOnPath(it.t >= 0 ? 0 : 0);   // 占位：旧件用 (t, off) 直接算位置
  const s = sAtT(it.t), g = ptAt(s);
  add({ x: g.x + g.nx * it.off, z: g.z + g.nz * it.off, w: it.w, d: it.d || it.w });
}
console.log("窗口 t∈[" + T0 + ", " + T1 + "]：保留 " + keep.length + " 件，待重做 " + replaced.length + " 件");

const rnd = (() => { let s = 20261015; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const R = (a, b) => a + rnd() * (b - a);
const made = [];
let skips = 0, fClr = 0, fHit = 0, nudged = 0;
const sA = sAtT(T0), sB = sAtT(T1);
for (let k = 0; ; k++) {
  const base = sMin + k * PERIOD;                    // 这一份副本的起点弧长
  if (base > sB) break;
  for (const b of tmpl) {
    const s = base + (b.s - sMin);
    if (s < sA || s > sB) continue;                  // 不加 break：模板内部按 s 排序，但要兼容跨窗口
    if (rnd() < SKIP) { skips++; continue; }
    let w = b.w * R(0.85, 1.2), dd = b.d * R(0.85, 1.2);
    // 离路越近、件越小：大板推到 12m 外，免得"工具以为没压线、引擎里复原差半个身位"就盖住路
    const cap = Math.abs(b.off) < 6 ? 4 : Math.abs(b.off) < 12 ? 9 : 24;
    w = Math.min(w, cap); dd = Math.min(dd, cap);
    let off = b.off * R(0.94, 1.06) + (rnd() < 0.5 ? -1 : 1) * rnd() * 0.6;
    const g0 = ptAt(s);
    let placed = false;
    for (let attempt = 0; attempt < 6 && !placed; attempt++) {
      if (attempt) { const sgn = off >= 0 ? 1 : -1; off = sgn * (Math.abs(off) + 0.7); nudged++; }
      const cx = g0.x + g0.nx * off, cz = g0.z + g0.nz * off;
      const clr = clrToRoad(cx, cz, w, dd);
      if (clr < INNER) { fClr++; continue; }
      if (nearB(cx, cz, w, dd).some((x) => ov({ x: cx, z: cz, w, d: dd }, x, GAPMIN))) { fHit++; continue; }
      // ⚠️ 必须用**锚点 s 自己的法线**反解 off，不能用 nearestOnPath()：
      // 后者在 3.4m 一折的锯齿路上会就近吸到**另一条腿**上，写出来的 (t, off) 让引擎复原到别处
      // （ADR-23 那个坑的真正来源：工具以为净空 1.55m，引擎里方块却压在路中心上）。
      const offS = (cx - g0.x) * g0.nx + (cz - g0.z) * g0.nz;
      made.push({
        t: +tAt(s).toFixed(3), off: +offS.toFixed(2), w: +w.toFixed(2), h: b.h, d: +dd.toFixed(2),
        tone: Math.abs(off) < 2.2 ? 0 : 1, rot: 0, rise: false, exact: true,
        clr: +clr.toFixed(3), g: 1, anim: "breath", phase: +rnd().toFixed(3),
      });
      add({ x: cx, z: cz, w, d: dd });
      placed = true;
    }
  }
}
console.log("  跳过 " + skips + " 件；压路带被拒 " + fClr + "、撞已有被拒 " + fHit + "、向外挪 " + nudged + " 次");
console.log("  新件 " + made.length + " 件");

const cl = made.map((m) => m.clr).sort((a, b) => a - b);
const ws = made.map((m) => m.w).sort((a, b) => a - b);
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
if (made.length) {
  console.log("  宽 min " + ws[0].toFixed(2) + " 中位 " + q(ws, 0.5).toFixed(2) + " max " + ws[ws.length - 1].toFixed(2));
  console.log("  内边缘到中心线 min " + cl[0].toFixed(2) + " 中位 " + q(cl, 0.5).toFixed(2) + "；压进路带(<" + roadHalf + ") " + cl.filter((x) => x < roadHalf).length + " 件");
}
const all = keep.concat(made);
const w15 = {};
for (const it of all) { const b = Math.floor(it.t / 15) * 15; w15[b] = (w15[b] || 0) + 1; }
console.log("  全关 " + all.length + " 件；每 15s 窗口：" + Object.keys(w15).sort((a, b) => a - b).map((k) => k + "s=" + w15[k]).join(" "));

if (APP) {
  const bak = path.join("out/bak", "level-tile-" + Date.now() + ".json");
  fs.mkdirSync("out/bak", { recursive: true });
  fs.copyFileSync(LEVEL, bak);
  lvl.place = all.sort((a, b) => a.t - b.t);
  fs.writeFileSync(LEVEL, JSON.stringify(lvl, null, 2));
  console.log("已写回 " + LEVEL + "：place[] = " + made.length + " 新 + " + keep.length + " 保留（备份 " + bak + "）");
}
