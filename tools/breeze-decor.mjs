/* =============================================================================
   Breeze 布景（"整关都是高架桥" → 照《ring a bell》高架桥段那套思路铺云）
   -----------------------------------------------------------------------------
   发起人（2026-10-13）：
     "breeze 整个关卡都是高架桥，所以现在按照同样的思路，帮我给 Breeze 加上景物。
      不过请特别注意不要让景物覆盖路线。"

   Breeze 是**双线关卡**（白线 lines[0] + 黑线 lines[1]），两条线都必须让开。
   所以这里的净空判定对**两条路径同时**做，而且要精确 —— 不能"在方块里打网格取样"：
   路是每几米折 90° 的阶梯，大块按网格取样时一条腿会从采样格之间穿过去（踩过这个坑）。

   轴对齐线段 × 轴对齐矩形的最小距离：Liang-Barsky 判交，相交＝0；不相交就取
   "线段端点到矩形" 与 "矩形四角到线段" 的最小值。O(1)/段。

   用法：
     node tools/breeze-decor.mjs                 # 干跑：只算+报告+出预览
     node tools/breeze-decor.mjs --apply         # 写回 level.json 的 place[]
     node tools/breeze-decor.mjs --clear         # 清掉 place[]（回到光秃秃）
     node tools/breeze-decor.mjs --gap=2.5       # 换净空下限（米，默认 2.0）
   ============================================================================= */
import fs from "node:fs";
import path from "node:path";

const LEVEL_DIR = "levels/Breeze (Original Mix)-Axero";
const LEVEL = path.join(LEVEL_DIR, "level.json");
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const CLEAR = argv.includes("--clear");
const GAP = (() => { const a = argv.find((x) => x.startsWith("--gap=")); return a ? +a.split("=")[1] : 3.0; })();

const level = JSON.parse(fs.readFileSync(LEVEL, "utf8"));
const lines = (level.lines || []).map((L) => (L.path || []).map((p) => ({ t: +p.t, x: +p.pos[0], y: +p.pos[1], z: +p.pos[2] })));
if (lines.length < 1) { console.error("✗ 关卡里没有 lines[].path"); process.exit(1); }

/* ── 弧长表：和引擎 props.js 的 atArc/timeToArc 同口径（逐点累加 + 线性内插） ── */
function makePlan(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  const total = cum[cum.length - 1];
  const atArc = (s) => {
    s = Math.max(0, Math.min(total, s));
    let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i];
    const k = (s - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, t: a.t + (b.t - a.t) * k };
  };
  const arcOfT = (t) => {
    if (t <= pts[0].t) return 0;
    if (t >= pts[pts.length - 1].t) return total;
    let i = 1; while (i < pts.length - 1 && pts[i].t < t) i++;
    const a = pts[i - 1], b = pts[i];
    const k = (t - a.t) / Math.max(1e-9, b.t - a.t);
    return cum[i - 1] + (cum[i] - cum[i - 1]) * k;
  };
  return { pts, total, atArc, arcOfT };
}
const plan = makePlan(lines[0]);
const plan2 = lines[1] ? makePlan(lines[1]) : null;
const BASE = 30;                                   // 法线的长基线（和 props.js 一致）
const dirAt = (pl, s) => {
  const a = pl.atArc(Math.max(0, s - BASE)), b = pl.atArc(Math.min(pl.total, s + BASE));
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
};
const normAt = (pl, s) => { const d = dirAt(pl, s); return { x: d.z, z: -d.x }; };   // 右法线

/* ── 精确：轴对齐线段 × 轴对齐矩形 的最小距离 ── */
function segRectDist(ax, az, bx, bz, cx, cz, w, d) {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  const dx = bx - ax, dz = bz - az;
  let t0 = 0, t1 = 1, ok = true;
  for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dz, az - z0], [dz, z1 - az]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) { ok = false; break; } continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
    else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
  }
  if (ok) return 0;                                                     // 相交 ⇒ 压住了
  const dPtRect = (px, pz) => Math.hypot(px - Math.max(x0, Math.min(x1, px)), pz - Math.max(z0, Math.min(z1, pz)));
  const dPtSeg = (px, pz) => {
    const L2 = dx * dx + dz * dz;
    const u = L2 > 1e-12 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
    return Math.hypot(px - (ax + dx * u), pz - (az + dz * u));
  };
  return Math.min(dPtRect(ax, az), dPtRect(bx, bz),
                  dPtSeg(x0, z0), dPtSeg(x1, z0), dPtSeg(x0, z1), dPtSeg(x1, z1));
}
/* 方块（中心 cx,cz，宽 w 深 d）到某条路径的最小距离 */
function distToPlan(pl, cx, cz, w, d) {
  let m = Infinity;
  for (let i = 1; i < pl.pts.length; i++) {
    const a = pl.pts[i - 1], b = pl.pts[i];
    const dd = segRectDist(a.x, a.z, b.x, b.z, cx, cz, w, d);
    if (dd < m) m = dd;
  }
  return m;
}

/* ── 云的配方（确定性，不掷骰子）：越远越大、越厚、越慢 ── */
const OFFS = [13, 18, 24, 32, 42, 54];
const SIZE = [5, 6.5, 8, 10, 12.5, 15];
const THICK = [1.0, 1.4, 1.8, 2.2, 2.8, 3.4];
const DY = [-11, -7.5, -5, -3, -1.5, 1, 3, 5.5, 8];
const AMP = [0.7, 0.9, 1.1, 1.3];
const PER = [6.0, 7.2, 8.4, 9.6];

const items = [];
const STEP = 4.0;                                  // 沿路每 4 m 一个锚点
let tried = 0, rejected = 0, minClear = Infinity;for (let s = STEP; s < plan.total - STEP; s += STEP) {
  const i = Math.round(s / STEP);
  const anchor = plan.atArc(s);
  const t = anchor.t;
  const want = i % 3 === 0 ? 2 : 1;                // 每三个锚点放一对，显得成团而不是一串
  for (let k = 0; k < want; k++) {
    const gi = (i * 2 + k * 5) % OFFS.length;
    const side = (Math.floor(i / 3) + k) % 2 === 0 ? 1 : -1;
    const off = side * OFFS[gi];
    const w = SIZE[(i + k * 3) % SIZE.length];
    const d = SIZE[(i + k * 3 + 2) % SIZE.length];
    const h = THICK[(i + k) % THICK.length];
    const dy = DY[(i * 3 + k) % DY.length];
    const p = plan.atArc(s);
    const n = normAt(plan, s);
    const cx = p.x + n.x * off, cz = p.z + n.z * off;
    tried++;
    // 净空：对**两条线**都要 >= GAP（方块边缘到任一条线的中心线）
    const c1 = distToPlan(plan, cx, cz, w, d);
    const c2 = plan2 ? distToPlan(plan2, cx, cz, w, d) : Infinity;
    const c = Math.min(c1, c2);
    if (c < GAP) { rejected++; continue; }
    if (c < minClear) minClear = c;                  // 只统计**收下**的件
    items.push({
      t: +t.toFixed(3), off: +off.toFixed(2), w, d, h, dy: +dy.toFixed(2),
      tone: (i + k) % 3, exact: true, anim: "breath",
      amp: AMP[(i + k) % AMP.length], period: PER[(i + k * 2) % PER.length],
    });
  }
}
items.sort((a, b) => a.t - b.t);

console.log(`关卡 ${level.meta && level.meta.title}`);
console.log(`  两条线：白线 ${plan.pts.length} 点 / ${plan.total.toFixed(1)} m，黑线 ${plan2 ? `${plan2.pts.length} 点 / ${plan2.total.toFixed(1)} m` : "无"}`);
console.log(`  试放 ${tried} 件 → 收 ${items.length} 件（因压到任一条线丢掉 ${rejected} 件）`);
console.log(`  净空：最小 ${minClear === Infinity ? "-" : minClear.toFixed(2)} m（下限 ${GAP} m）`);

if (CLEAR) {
  delete level.place;
  fs.writeFileSync(LEVEL, JSON.stringify(level, null, 1));
  console.log("  ✓ 已清空 place[]");
} else if (APPLY) {
  level.place = items;
  fs.writeFileSync(LEVEL, JSON.stringify(level, null, 1));
  console.log(`  ✓ 已写回 ${LEVEL}：place[] = ${items.length} 件`);
} else {
  console.log("  （干跑：加 --apply 才写回）");
}

/* ── 俯视取证图：两条线的禁区带 + 中心线 + 方块（越界画纯红，目标 0 件） ── */
{
  const S = (() => { const a = argv.find((x) => x.startsWith("--s=")); return a ? +a.split("=")[1] : 0.5; })();   // px/m
  const all = plan.pts.concat(plan2 ? plan2.pts : []);
  const xs = all.map((p) => p.x), zs = all.map((p) => p.z);
  const x0 = Math.min(...xs) - 30, x1 = Math.max(...xs) + 30;
  const z0 = Math.min(...zs) - 30, z1 = Math.max(...zs) + 30;
  const W = Math.round((x1 - x0) * S) + 40, H = Math.round((z1 - z0) * S) + 40;
  const X = (x) => (20 + (x - x0) * S).toFixed(1);
  const Y = (z) => (20 + (z1 - z) * S).toFixed(1);
  const poly = (pl) => pl.pts.map((p) => `${X(p.x)},${Y(p.z)}`).join(" ");
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="100%" height="100%" fill="#f7f7f8"/>`];
  for (const pl of [plan, plan2]) {
    if (!pl) continue;
    svg.push(`<polyline points="${poly(pl)}" fill="none" stroke="#f0a49a" stroke-width="${(2 * GAP * S).toFixed(2)}" opacity="0.8" stroke-linejoin="miter"/>`);
    svg.push(`<polyline points="${poly(pl)}" fill="none" stroke="#1d2740" stroke-width="0.3" stroke-dasharray="2 1.6"/>`);
  }
  const list = CLEAR ? [] : items;
  for (const it of list) {
    const s = plan.arcOfT(it.t), p = plan.atArc(s), n = normAt(plan, s);
    const cx = p.x + n.x * it.off, cz = p.z + n.z * it.off;
    const d1 = distToPlan(plan, cx, cz, it.w, it.d);
    const d2 = plan2 ? distToPlan(plan2, cx, cz, it.w, it.d) : Infinity;
    const bad = Math.min(d1, d2) < GAP - 1e-6;
    svg.push(`<rect x="${(+X(cx) - it.w * S / 2).toFixed(1)}" y="${(+Y(cz) - it.d * S / 2).toFixed(1)}" width="${(it.w * S).toFixed(1)}" height="${(it.d * S).toFixed(1)}" fill="${bad ? "#ff0000" : ["#d8dbdf", "#b3b8bf", "#878d95"][it.tone]}"/>`);
  }
  svg.push(`<text x="24" y="${H - 12}" font-size="13" fill="#555">Breeze 布景取证：红带＝两条线各自的禁区（±${GAP}m，方块边缘不得进入）；红方块＝越界件（应为 0）；共 ${list.length} 件</text>`);
  svg.push(`</svg>`);
  const out = "out/breeze-decor-preview.svg";
  fs.writeFileSync(out, svg.join("\n"));
  console.log(`  预览：${out}（${W}×${H}）`);
}
