/**
 * 世界坐标手工摆放（发起人 2026-10-14 m13120：你能读取路线和舞线轨迹、直接确定长方形的两点坐标吗？）
 *
 * 结论：能。关卡文件里每件景物的位置字段是 (t, off)，但引擎把 (t, off) 变成世界坐标的公式是
 * **确定的、可逆的**（src/js/props.js:1021-1034 put()：世界点 = 路上一点 p(t) + p(t) 处的长基线法线 × off）。
 * 所以这里反过来做：我给它一个**世界坐标**（我照路线图挑的点），它用数值反解出 (t, off)，
 * 再用**引擎自己**的 buildPlaced() 复核"真的落在我说的位置上"，并报告每件到路面的实际净空。
 *
 * 我手工挑的点放在 tools/hand-sections/*.json，每段一个文件：
 *   { "t0": 1.6, "t1": 13.4, "items": [ { at:[X,Z], w,d,h, tone, sol, note } ] }
 * 一段一段来：摆完一段就渲染自查（drive + 俯视），确认无遮挡、难度符合 ADR-29 的标尺，再摆下一段。
 *
 * 用法：
 *   node tools/hand-place.mjs --dry                 # 只解算 + 报告（零写入）
 *   node tools/hand-place.mjs --apply               # 按各段 [t0,t1) 替换后写回（自动备份 out/bak/）
 */
import fs from "node:fs";
import path from "node:path";
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
const APPLY = !!A.apply;
const SECDIR = path.join(ROOT, "tools", "hand-sections");

/* ================= 读我手工挑的点（一段一个文件） ================= */
const sections = [];
if (fs.existsSync(SECDIR)) {
  for (const f of fs.readdirSync(SECDIR).filter((n) => n.endsWith(".json")).sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(SECDIR, f), "utf8"));
    sections.push({ file: f, t0: j.t0, t1: j.t1, items: j.items || [] });
  }
}
if (!sections.length) { console.error("tools/hand-sections/ 里没有分段文件，先跑 tools/hand-emit.mjs"); process.exit(1); }
const HAND = sections.flatMap((s) => s.items);

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
  let i = 0;
  if (s <= 0) i = 0; else if (s >= pl.total) i = seg.length - 1;
  else { let lo = 0, hi = seg.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (seg[m].s0 <= s) { i = m; lo = m + 1; } else hi = m - 1; } }
  const g = seg[i], u = Math.min(1, Math.max(0, (s - g.s0) / g.L));
  return { x: g.a.x + (g.b.x - g.a.x) * u, y: g.a.y + (g.b.y - g.a.y) * u, z: g.a.z + (g.b.z - g.a.z) * u };
}
function timeToArc(pl, verts, t) {
  // verts 是 buildVerts 给的折点（{x,y,z,t}）；弧长自己累加，不依赖 polyline 的索引
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1], b = verts[i];
    if (t >= a.t && t <= b.t) {
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return AT[i - 1] + (AT[i] - AT[i - 1]) * u;
    }
  }
  return t <= verts[0].t ? 0 : pl.total;
}
let AT = [];   // 折点累计弧长（下面 buildVerts 之后填）
const BASE = 30; // src/js/props.js:1006 dirAt 用 ±30m 长基线
function dirAt(pl, s) {
  const a = atArc(pl, Math.max(0, s - BASE)), b = atArc(pl, Math.min(pl.total, s + BASE));
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
  return { x: dx / L, z: dz / L };
}
const SNAP = Math.PI / 2;
function snapYaw(y) { return Math.round(y / SNAP) * SNAP; }

/* 长方形（旋转 snapYaw 角）到折线的最小距离：把矩形四角+四条边都算一遍 */
function rectPolyDist(cx, cz, w, d, yaw, pts) {
  const c = Math.cos(-yaw), s = Math.sin(-yaw);           // 转回轴对齐
  const local = (x, z) => { const dx = x - cx, dz = z - cz; return { x: dx * c - dz * s, z: dx * s + dz * c }; };
  const hw = w / 2, hd = d / 2;
  let best = Infinity;
  for (const p of pts) {
    const q = local(p.x, p.z);
    const dx = Math.max(Math.abs(q.x) - hw, 0), dz = Math.max(Math.abs(q.z) - hd, 0);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

const level = JSON.parse(fs.readFileSync(path.join(ROOT, LEVEL), "utf8"));
const verts = buildVerts(level, DUR, linesOf(level)[0]);
const pl = polyline(verts);
AT = [0];
for (let i = 1; i < verts.length; i++) AT.push(AT[i - 1] + Math.hypot(verts[i].x - verts[i - 1].x, verts[i].z - verts[i - 1].z));
const roadHalf = (level.roadWidth || 3) / 2;
// 路中心线采样点（0.25m 一个）——净空就是"我这件到这些点的最小距离"
const SAMP = [];
for (let s = 0; s <= pl.total; s += 0.25) { const p = atArc(pl, s); SAMP.push(p); }

/* ================= 世界坐标 → (t, off)：扫 t，找最近的路点 ================= */
function solve(x, z) {
  let best = { d2: Infinity };
  const step = 0.002;
  for (let t = 0; t <= DUR; t += step) {
    const s = timeToArc(pl, verts, t);
    const p = atArc(pl, s), dd = dirAt(pl, s);
    const nx = dd.z, nz = -dd.x;
    const vx = x - p.x, vz = z - p.z;
    const off = vx * nx + vz * nz;
    const lx = p.x + nx * off, lz = p.z + nz * off;
    const d2 = (x - lx) ** 2 + (z - lz) ** 2;
    if (d2 < best.d2) best = { d2, t, off, y: p.y };
  }
  return best;
}
const rows = HAND.map((it) => {
  const r = solve(it.at[0], it.at[1]);
  const yaw = snapYaw(Math.atan2(0, 1) + (r.off >= 0 ? 0 : Math.PI)); // 与引擎 snapYaw 一致（这里只用于净空近似）
  return { it, ...r, yaw, resid: Math.sqrt(r.d2) };
});
const bad = rows.filter((r) => r.resid > 0.05);
console.log("解算 " + rows.length + " 件；残差 max " + Math.max(...rows.map((r) => r.resid)).toFixed(3) + " m" + (bad.length ? "，⚠ " + bad.length + " 件 > 0.05m" : ""));
for (const s of sections) console.log("  段 " + s.file + "：t∈[" + s.t0 + "," + s.t1 + ") " + s.items.length + " 件");

/* ================= 净空 + 重叠自检（用引擎公式算出的实际位置） ================= */
let minClr = Infinity, minRow = null, overlap = 0;
for (const r of rows) {
  const c = rectPolyDist(r.it.at[0], r.it.at[1], r.it.w, r.it.d, 0, SAMP);
  if (c < minClr) { minClr = c; minRow = r; }
}
for (let i = 0; i < rows.length; i++) {
  for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i].it, b = rows[j].it;
    const gx = Math.abs(a.at[0] - b.at[0]) - (a.w + b.w) / 2;
    const gz = Math.abs(a.at[1] - b.at[1]) - (a.d + b.d) / 2;
    if (gx < 0.2 && gz < 0.2) { overlap++; if (overlap <= 6) console.log("  ⚠ 靠得太近：" + JSON.stringify(a.at) + " 与 " + JSON.stringify(b.at)); }
  }
}
console.log("净空（到路中心线）min " + minClr.toFixed(2) + " m（" + (minRow ? JSON.stringify(minRow.it.at) : "-") + "）；路面半宽 " + roadHalf + " m；靠得太近 " + overlap + " 对");
const intrude = rows.filter((r) => rectPolyDist(r.it.at[0], r.it.at[1], r.it.w, r.it.d, 0, SAMP) < roadHalf);
console.log("伸进路带（< " + roadHalf + "m）：" + intrude.length + " 件" + (intrude.length ? " → " + intrude.map((r) => JSON.stringify(r.it.at) + "(" + r.it.note + ")").slice(0, 6).join(" ") : ""));

if (!APPLY) { console.log("（--dry：没有写任何文件）"); process.exit(0); }

/* ================= 写回：按各段窗口删旧的、加我手工的 ================= */
const abs = path.join(ROOT, LEVEL);
const bak = path.join(ROOT, "out", "bak", "level-hand-" + Date.now() + ".json");
const keep = level.place.filter((it) => !sections.some((s) => it.t != null && it.t >= s.t0 && it.t < s.t1));
let removed = level.place.length - keep.length;
const added = rows.map((r, k) => ({
  t: +r.t.toFixed(3), off: +r.off.toFixed(3),
  w: r.it.w, d: r.it.d, h: r.it.h, tone: r.it.tone != null ? r.it.tone : 1,
  sol: r.it.sol ? 1 : 0, hand: 1, hid: k, exact: 1,
  ...(r.it.note ? { note: r.it.note } : {}),
}));
level.place = keep.concat(added);
fs.mkdirSync(path.dirname(bak), { recursive: true });
fs.copyFileSync(abs, bak);
fs.writeFileSync(abs, JSON.stringify(level, null, 2) + "\n");
console.log("删 " + removed + " 件，加手工 " + added.length + " 件；place[] = " + level.place.length + "（备份 " + path.relative(ROOT, bak) + "）");

/* 用引擎自己复核：我手工摆的件，引擎把它放到世界哪里（按我写的 hid 对齐，避免与旧批次串号） */
const lvl2 = JSON.parse(fs.readFileSync(abs, "utf8"));
const built = buildPlaced(lvl2, verts);
const byPi = new Map((built.solids || []).map((s) => [s.pi, s]));
let worst = 0, checked = 0, missing = 0;
lvl2.place.forEach((it, i) => {
  if (it.hid == null) return;
  const r = rows[it.hid];
  if (!r) return;
  if (!it.sol) return;                       // 纯景物没有判定盒，跳过
  const s = byPi.get(i);
  if (!s) { missing++; return; }
  worst = Math.max(worst, Math.hypot(s.x - r.it.at[0], s.z - r.it.at[1]));
  checked++;
});
console.log("引擎复核：受检 " + checked + " 件判定物，与我要的世界坐标最大偏差 " + worst.toFixed(3) + " m" + (missing ? "（" + missing + " 件引擎没给判定盒）" : ""));
