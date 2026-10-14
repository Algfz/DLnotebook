/**
 * 生成"手工摆放表"的**候选**：我按自己对路线几何的读法写规则，脚本只负责把坐标算出来给我过目。
 * 输出的 JSON 我会逐条看、必要时手改；真正写进关卡的是那份 JSON（tools/hand-place.mjs 读它）。
 *
 * 用法：node tools/hand-emit.mjs --t0 1.6 --t1 13.4 --out tools/hand-sections/01-first13s.json
 *
 * 我这一版的选择（不是随机的）：
 *  ①每个直角弯的外侧口袋里一件"贴边件"：优先 gap 0.35m（= 方块边缘离路面 0.35m，几乎贴着）；
 *    放不下就往外挪（0.9 / 1.5）或缩小（3.4 → 2.6 → 1.9 → 1.4）；都不行才跳过（并报出来）。
 *  ②腿长 ≥5.5m 的弯，贴边件基准尺寸 3.6×3.6×2.8；否则 2.6×2.6×2.2。
 *  ③每 4 个弯补一件"第二排"体积件（4.2×4.2×3.0），离路 ≥2.5m，做层次。
 *  ④难度：挑长腿中点放**伸入路面**的件（内边缘离路中心线 1.0m ⇒ 通道 2.5m＝比较难；
 *    0.5m ⇒ 通道 2.0m＝很难），标尺见 AGENT.md ADR-29。第一段（t<3）不伸，给玩家起手。
 *  ⑤远景：离路 ≥6m 的大件（6.5m，纯景物 sol:0）。
 * 所有候选都要过两道自检：与路中心线净空、与已摆件不重叠（≥0.25m）。
 */
import fs from "node:fs";
import path from "node:path";
import { buildVerts, linesOf } from "../src/js/level.js";

const A = {};
for (let i = 2; i < process.argv.length; i++) {
  const s = process.argv[i];
  if (s.startsWith("--")) { const k = s.slice(2); const v = process.argv[i + 1]; if (v && !v.startsWith("--")) { A[k] = v; i++; } else A[k] = true; }
}
const T0 = A.t0 != null ? parseFloat(A.t0) : 1.6;
const T1 = A.t1 != null ? parseFloat(A.t1) : 13.4;
const OUT = A.out || "tools/hand-sections/01-first13s.json";
const ROAD_HALF = 1.5, SAFE = 0.15, MIN_SEP = 0.25;

const level = JSON.parse(fs.readFileSync("levels/ring a bell-灰澈/level.json", "utf8"));
const vertsAll = buildVerts(level, 174.667, linesOf(level)[0]);
const verts = vertsAll.filter((v) => v.t <= T1 + 0.6);
const r2 = (x) => +x.toFixed(2);

/* 路中心线采样点（0.25m）——净空判据 */
const SAMP = [];
for (let i = 1; i < vertsAll.length; i++) {
  const a = vertsAll[i - 1], b = vertsAll[i];
  const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.round(L / 0.25));
  for (let k = 0; k <= n; k++) SAMP.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n });
}
const clearance = (x, z, w, d) => {
  const hw = w / 2, hd = d / 2;
  let best = Infinity;
  for (const p of SAMP) {
    const dx = Math.max(Math.abs(p.x - x) - hw, 0), dz = Math.max(Math.abs(p.z - z) - hd, 0);
    const v = Math.hypot(dx, dz); if (v < best) best = v;
  }
  return best;
};

const items = [];
const sepOk = (x, z, w, d) => items.every((it) => {
  const gx = Math.abs(it.at[0] - x) - (it.w + w) / 2;
  const gz = Math.abs(it.at[1] - z) - (it.d + d) / 2;
  return Math.max(gx, gz) >= MIN_SEP;
});
const push = (it) => { items.push(it); return it; };

/* ① 贴边件：每个直角弯外侧口袋 */
const elbows = [];
for (let i = 1; i < verts.length - 1; i++) {
  const a = verts[i - 1], b = verts[i], c = verts[i + 1];
  if (b.t < T0 || b.t > T1) continue;
  const d1 = { x: b.x - a.x, z: b.z - a.z }, d2 = { x: c.x - b.x, z: c.z - b.z };
  const l1 = Math.hypot(d1.x, d1.z), l2 = Math.hypot(d2.x, d2.z);
  if (l1 < 0.5 || l2 < 0.5) continue;
  const u = { x: d1.x / l1, z: d1.z / l1 }, w2 = { x: d2.x / l2, z: d2.z / l2 };
  if (Math.abs(u.x * w2.z - u.z * w2.x) < 0.5) continue;    // 非直角弯
  const typeA = Math.abs(u.x) > 0.5 && Math.abs(w2.z) > 0.5;
  elbows.push({ b, typeA, longLeg: Math.max(l1, l2) >= 5.5 });
}
/* ④ 难度：长腿伸入路面（**先于贴边件生成**，否则会被占位挡掉） */
const narrowPlan = [];
for (let i = 1; i < verts.length; i++) {
  const a = verts[i - 1], b = verts[i];
  if (b.t < Math.max(3.0, T0) || b.t > T1) continue;
  const L = Math.hypot(b.x - a.x, b.z - a.z);
  if (L < 5.5) continue;
  narrowPlan.push({ a, b, L });
}
let narrowCount = 0;
for (const seg of narrowPlan) {
  const vert = Math.abs(seg.b.z - seg.a.z) > Math.abs(seg.b.x - seg.a.x);
  const narrow = narrowCount % 3 === 2 ? 0.5 : 1.0;      // 每三处一个"很难"
  let placed = false;
  for (const frac of [0.55, 0.62, 0.45, 0.70, 0.38]) {
    for (const [w, d] of [[2.4, 2.4], [1.8, 2.2], [1.4, 2.0]]) {
      const mid = { x: seg.a.x + (seg.b.x - seg.a.x) * frac, z: seg.a.z + (seg.b.z - seg.a.z) * frac };
      const cx = vert ? mid.x - narrow - w / 2 : mid.x;
      const cz = vert ? mid.z : mid.z - narrow - d / 2;
      if (!sepOk(cx, cz, w, d)) continue;
      const cl = clearance(cx, cz, w, d);
      if (cl > narrow + 0.25) continue;                  // 必须真的伸进来
      push({ at: [r2(cx), r2(cz)], w, d, h: 2.0, tone: 1, sol: 1,
             note: "伸入 " + (vert ? "竖腿" : "横腿") + " t≈" + seg.a.t.toFixed(2) + " 通道" +
                   (narrow === 1.0 ? "2.5m(比较难)" : "2.0m(很难)") + " 净空" + cl.toFixed(2) });
      placed = true; narrowCount++; break;
    }
    if (placed) break;
  }
  if (!placed) console.log("  伸入件放不下，跳过 t≈" + seg.a.t.toFixed(2));
}

let skipped = 0;
elbows.forEach((e, k) => {
  const base = e.longLeg ? 3.6 : 2.6, baseH = e.longLeg ? 2.8 : 2.2;
  for (const gap of [0.35, 0.9, 1.5, 2.2]) {
    for (const s of [base, base * 0.72, base * 0.55, 1.4]) {
      const half = s / 2;
      const bx = e.typeA ? e.b.x - ROAD_HALF - gap - half : e.b.x + ROAD_HALF + gap + half;
      const bz = e.typeA ? e.b.z + ROAD_HALF + gap + half : e.b.z - ROAD_HALF - gap - half;
      const sx = e.typeA ? -1 : 1, sz = e.typeA ? 1 : -1;      // 口袋所在的两个方向（沿腿）
      for (const [ux, uz] of [[0, 0], [0, 1], [1, 0], [0, 2], [2, 0], [0, 3]]) {
        const cx = bx + sx * ux * 1.2, cz = bz + sz * uz * 1.2;
        if (clearance(cx, cz, s, s) < ROAD_HALF + SAFE) continue;
        if (!sepOk(cx, cz, s, s)) continue;
        push({ at: [r2(cx), r2(cz)], w: +s.toFixed(2), d: +s.toFixed(2), h: baseH, tone: 1, sol: 1,
               note: "贴边 " + (e.typeA ? "A" : "B") + " t=" + e.b.t.toFixed(2) + " gap" + gap + (ux || uz ? " 移" + (ux * 1.2) + "/" + (uz * 1.2) : "") });
        // ③ 每 4 个弯补第二排
        if (k % 4 === 3) {
          for (const [vx, vz] of [[3.1, 3.1], [2.2, 2.2]]) {
            const dx2 = cx + sx * vx, dz2 = cz + sz * vz;
            if (clearance(dx2, dz2, 4.2, 4.2) >= ROAD_HALF + 2.5 && sepOk(dx2, dz2, 4.2, 4.2)) {
              push({ at: [r2(dx2), r2(dz2)], w: 4.2, d: 4.2, h: 3.0, tone: 2, sol: 0, note: "第二排 t=" + e.b.t.toFixed(2) }); break;
            }
          }
        }
        return;
      }
    }
  }
  skipped++;
  console.log("  跳过弯 t=" + e.b.t.toFixed(2) + "（口袋放不下）");
});

/* ⑤ 远景 */
for (const [x, z] of [[6, -9], [12, 9], [22, 20], [30, -7], [40, 26], [52, 16], [64, 62], [78, 44], [22, -12], [60, 20]]) {
  if (clearance(x, z, 6.5, 6.5) < 6) continue;
  if (!sepOk(x, z, 6.5, 6.5)) continue;
  push({ at: [x, z], w: 6.5, d: 6.5, h: 4.0, tone: 2, sol: 0, note: "远景" });
}

const minClr = Math.min(...items.map((it) => clearance(it.at[0], it.at[1], it.w, it.d)));
const intruding = items.filter((it) => clearance(it.at[0], it.at[1], it.w, it.d) < ROAD_HALF);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ t0: T0, t1: T1, items }, null, 2) + "\n");
console.log("写出 " + OUT + "：" + items.length + " 件（贴边 " + items.filter(i => i.note.startsWith("贴边")).length +
  "、第二排 " + items.filter(i => i.note.startsWith("第二排")).length + "、伸入 " + items.filter(i => i.note.startsWith("伸入")).length +
  "、远景 " + items.filter(i => i.note === "远景").length + "）；跳过的弯 " + skipped);
console.log("  净空 min " + minClr.toFixed(2) + "m；伸进路带 " + intruding.length + " 件" +
  (intruding.length ? "：" + intruding.map((i) => i.note.split(" ")[1] + "/" + i.note.split(" ")[2]).join(" ") : ""));
