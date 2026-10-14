/**
 * 世界坐标手工摆放（发起人 2026-10-14 m13120：你能读取路线和舞线轨迹、直接确定长方形的两点坐标吗？）
 *
 * 结论：能。关卡文件里每件景物的位置字段是 (t, off)，但引擎把 (t, off) 变成世界坐标的公式是
 * **确定的、可逆的**（src/js/props.js:1021-1034 put()：世界点 = 路上一点 p(t) + p(t) 处的长基线法线 × off）。
 * 所以这里反过来做：我给它一个**世界坐标**（我照路线图挑的点），它用数值反解出 (t, off)，
 * 再用**引擎自己**的 buildPlaced() 复核"真的落在我说的位置上"，并报告每件到路面的实际净空。
 *
 * 用法：
 *   node tools/hand-place.mjs --dry                 # 只解算 + 报告（零写入）
 *   node tools/hand-place.mjs --apply [--t0 0 --t1 13]
 *
 * HAND 表就是我手工挑的点：{ at:[X,Z] 世界坐标, w,d,h 尺寸, tone 0/1/2 色档, sol 1=判定物 }。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildVerts, linesOf } from "../src/js/level.js";
import { buildPlaced } from "../src/js/props.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const A = {};
for (let i = 2; i < process.argv.length; i++) {
  const s = process.argv[i];
  if (s.startsWith("--")) { const k = s.slice(2); const v = process.argv[i + 1]; if (v && !v.startsWith("--")) { A[k] = v; i++; } else A[k] = true; }
}
const LEVEL = A.level || "levels/ring a bell-灰澈/level.json";
const DUR = A.dur != null ? parseFloat(A.dur) : 174.667;
const T0 = A.t0 != null ? parseFloat(A.t0) : 0;
const T1 = A.t1 != null ? parseFloat(A.t1) : 13;
const APPLY = !!A.apply;

/* ================= 我手工挑的点（世界坐标 x,z；y 由引擎按路面高度决定） ================= */
/* 这一批做**楼梯段（t≈1.6~4.2s）**。楼梯向东北爬，每个直角弯的外侧都有一个 L 形口袋：
 *   A 型弯（从 +x 腿转 +z 腿，位于 (X0,z0)）⇒ 口袋在西北：中心 ≈ (X0−1.5−gap−w/2, z0+1.5+gap+d/2)
 *   B 型弯（从 +z 腿转 +x 腿，位于 (X0,z0)）⇒ 口袋在东南：中心 ≈ (X0+1.5+gap+w/2, z0−1.5−gap−d/2)
 * gap 取 0.9m（路面半宽 1.5 ⇒ 方块边缘离路面 0.9m）。尺寸我按"转角越尖越小"的原则选 2.6 / 3.4，
 * 密集处（t=3.6~4.2 的四个弯）我**故意只放两件**，留出呼吸。
 */
const HAND = [
  // —— 每个直角弯外侧的口袋里放一件（gap=0.9，2.6×2.6×高2.2）——
  { at: [19.5, 3.7], w: 2.6, d: 2.6, h: 2.2, tone: 1, sol: 1 },   // A 弯 (23.2,0)
  { at: [26.9, -0.3], w: 2.6, d: 2.6, h: 2.2, tone: 1, sol: 1 },  // B 弯 (23.2,3.4)
  { at: [22.4, 7.1], w: 3.4, d: 3.4, h: 2.8, tone: 1, sol: 1 },   // A 弯 (26.1,3.4)
  { at: [29.8, 2.7], w: 2.6, d: 2.6, h: 2.2, tone: 1, sol: 1 },   // B 弯 (26.1,6.4)
  { at: [25.5, 10.1], w: 2.6, d: 2.6, h: 2.2, tone: 1, sol: 1 },  // A 弯 (29.2,6.4)
  { at: [32.9, 5.9], w: 3.4, d: 3.4, h: 2.8, tone: 1, sol: 1 },   // B 弯 (29.2,9.6)
  { at: [28.6, 13.3], w: 2.6, d: 2.6, h: 2.2, tone: 1, sol: 1 },  // A 弯 (32.3,9.6)
  { at: [36.0, 8.9], w: 2.6, d: 2.6, h: 2.2, tone: 1, sol: 1 },   // B 弯 (32.3,12.6)
  { at: [34.7, 16.3], w: 3.4, d: 3.4, h: 2.8, tone: 1, sol: 1 },  // A 弯 (38.4,12.6)
  { at: [43.6, 13.6], w: 2.6, d: 2.6, h: 2.2, tone: 1, sol: 1 },  // B 弯 (39.9,17.3)
  // —— 远景大件（离路 6m 以上，纯景物，做层次）——
  { at: [14.0, -8.0], w: 6.5, d: 6.5, h: 4.0, tone: 2, sol: 0 },
  { at: [10.0, 9.0], w: 6.5, d: 6.5, h: 4.0, tone: 2, sol: 0 },
  { at: [20.0, 15.0], w: 6.5, d: 6.5, h: 4.0, tone: 2, sol: 0 },
  { at: [30.0, -6.0], w: 6.5, d: 6.5, h: 4.0, tone: 2, sol: 0 },
  { at: [38.0, 26.0], w: 6.5, d: 6.5, h: 4.0, tone: 2, sol: 0 },
  // —— 起点长直段（z=0）两侧的中距离件 ——
  { at: [6.0, -6.5], w: 4.0, d: 4.0, h: 2.8, tone: 1, sol: 0 },
  { at: [16.0, 6.5], w: 4.0, d: 4.0, h: 2.8, tone: 1, sol: 0 },
];

/* ================= 引擎映射的复刻（与 src/js/props.js 同源，逐行照抄） ================= */
function polyline(verts) {
  const seg = []; let acc = 0;
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1], b = verts[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    seg.push({ a, b, L, s0: acc }); acc += L;
  }
  return { seg, total: acc };
}
function atArc(pl, s) {
  const { seg } = pl;
  let lo = 0, hi = seg.length - 1, i = 0;
  if (s <= 0) i = 0; else if (s >= pl.total) i = seg.length - 1;
  else while (lo <= hi) { const mid = (lo + hi) >> 1; if (seg[mid].s0 + seg[mid].L < s) lo = mid + 1; else if (seg[mid].s0 > s) hi = mid - 1; else { i = mid; break; } }
  const sg = seg[i];
  const k = Math.max(0, Math.min(1, (s - sg.s0) / sg.L));
  return { x: sg.a.x + (sg.b.x - sg.a.x) * k, y: sg.a.y + (sg.b.y - sg.a.y) * k, z: sg.a.z + (sg.b.z - sg.a.z) * k };
}
function timeToArc(pl, verts, t) {
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1], b = verts[i];
    if (t >= a.t && t <= b.t) {
      const k = (b.t - a.t) < 1e-6 ? 0 : (t - a.t) / (b.t - a.t);
      const px = a.x + (b.x - a.x) * k, pz = a.z + (b.z - a.z) * k;
      let s = 0;
      for (let j = 1; j < i; j++) s += Math.hypot(verts[j].x - verts[j - 1].x, verts[j].z - verts[j - 1].z);
      return s + Math.hypot(px - a.x, pz - a.z);
    }
  }
  return t <= (verts[0] ? verts[0].t : 0) ? 0 : pl.total;
}
const SNAP = Math.PI / 2;
const snapYaw = (y) => Math.round(y / SNAP) * SNAP;
const BASE = 30;

function makeMapper(verts) {
  const pl = polyline(verts);
  const dirAt = (s) => {
    const a = atArc(pl, Math.max(0, s - BASE)), b = atArc(pl, Math.min(pl.total, s + BASE));
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  };
  const world = (t, off) => {
    const s = timeToArc(pl, verts, t);
    const p = atArc(pl, s), d = dirAt(s);
    return { x: p.x + d.z * off, z: p.z - d.x * off, yaw: snapYaw(Math.atan2(d.x, d.z)), d };
  };
  return { pl, world };
}

/* 世界坐标 → (t, off)：扫描 t，取残差最小者 */
function solve(mapper, X, Z) {
  let best = { res: Infinity };
  for (let t = 0; t <= DUR; t += 0.002) {
    const w = mapper.world(t, 0);
    const nx = w.d.z, nz = -w.d.x;
    const off = (X - w.x) * nx + (Z - w.z) * nz;
    const px = w.x + nx * off, pz = w.z + nz * off;
    const res = Math.hypot(px - X, pz - Z);
    if (res < best.res) best = { res, t: +t.toFixed(3), off: +off.toFixed(3), px, pz, yaw: w.yaw };
    if (res < 1e-6) break;
  }
  return best;
}

/* 长方形（按引擎吸附后的朝向）到整条路的最小距离 */
function clearance(verts, cx, cz, w, d, rotY) {
  const alongX = Math.abs(Math.cos(rotY)) > 0.5;
  const hw = (alongX ? w : d) / 2, hd = (alongX ? d : w) / 2;
  let m = Infinity;
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1], b = verts[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    const n = Math.max(2, Math.ceil(L / 0.05));
    for (let k = 0; k <= n; k++) {
      const px = a.x + (b.x - a.x) * (k / n), pz = a.z + (b.z - a.z) * (k / n);
      const dx = Math.max(0, Math.abs(px - cx) - hw), dz = Math.max(0, Math.abs(pz - cz) - hd);
      const dd = Math.hypot(dx, dz);
      if (dd < m) { m = dd; if (m < 0.05) return m; }
    }
  }
  return m;
}

const abs = path.resolve(ROOT, LEVEL);
const level = JSON.parse(fs.readFileSync(abs, "utf8"));
const verts = buildVerts(level, DUR, linesOf(level)[0]);
const mapper = makeMapper(verts);

const solved = [];
console.log("世界坐标 → (t, off) 解算（残差 = 引擎复原后与我要的位置差多少米）：");
for (const it of HAND) {
  const s = solve(mapper, it.at[0], it.at[1]);
  const clr = clearance(verts, s.px, s.pz, it.w, it.d, s.yaw);
  solved.push({ ...it, ...s, clr });
  const flag = s.res > 0.6 ? " ⚠残差大" : "";
  const flag2 = clr < 1.7 ? " ⚠离路太近" : "";
  console.log("  (" + it.at[0].toFixed(1) + "," + it.at[1].toFixed(1) + ") → t=" + s.t + " off=" + s.off +
    "  残差 " + s.res.toFixed(3) + "m  实际净空 " + clr.toFixed(2) + "m" + flag + flag2);
}
const bad = solved.filter((s) => s.res > 0.6).length, near = solved.filter((s) => s.clr < 1.7).length;
console.log("合计 " + solved.length + " 件：残差>0.6m " + bad + " 件；净空<1.7m " + near + " 件");

if (!APPLY) { console.log("（--dry：未写回。加 --apply 写进关卡）"); process.exit(0); }

const before = level.place.length;
level.place = level.place.filter((it) => !(it.t >= T0 && it.t < T1));
const removed = before - level.place.length;
const added = solved.map((s, k) => {
  const e = { t: s.t, off: s.off, w: s.w, h: s.h, d: s.d, tone: s.tone || 0, rot: 0, rise: false, exact: 1,
              anim: "breath", phase: +(((k * 0.191) % 1).toFixed(3)), hand: 1, at: [+s.at[0].toFixed(2), +s.at[1].toFixed(2)] };
  if (s.sol) e.sol = 1;
  return e;
});
level.place.push(...added);
level.place.sort((a, b) => a.t - b.t || a.off - b.off);

fs.mkdirSync(path.join(ROOT, "out", "bak"), { recursive: true });
const bak = path.join(ROOT, "out", "bak", "level-hand-" + Date.now() + ".json");
fs.copyFileSync(abs, bak);
fs.writeFileSync(abs, JSON.stringify(level, null, 2) + "\n");
console.log("窗口 [" + T0 + "," + T1 + ") 删 " + removed + " 件，手工摆 " + added.length + " 件；place[] = " + level.place.length + "（备份 " + path.relative(ROOT, bak) + "）");

/* 用引擎自己复核：我的件（sol=1）到底落在世界哪里 */
const built = buildPlaced(level, verts);
const byPi = new Map((built.solids || []).map((s) => [s.pi, s]));
let maxErr = 0, checked = 0;
for (let i = 0; i < level.place.length; i++) {
  const it = level.place[i];
  if (!it.hand || !it.sol) continue;
  const s = byPi.get(i);
  if (!s) { console.log("  ⚠ 引擎里没找到 place[" + i + "] 的判定盒"); continue; }
  const err = Math.hypot(s.x - it.at[0], s.z - it.at[1]);
  if (err > maxErr) maxErr = err;
  checked++;
}
console.log("引擎复核：受检 " + checked + " 件，与我要的世界坐标最大偏差 " + maxErr.toFixed(3) + " m");
