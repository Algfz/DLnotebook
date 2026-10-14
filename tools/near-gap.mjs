/* near-gap.mjs —— 「这段路旁边有没有景物」的客观量法（引擎几何，不启浏览器）
 *
 * 发起人 2026-10-14 在截图上用红圈圈出"这些地方没有放置障碍物"。
 * 把这句话变成数字：沿官方路线每 0.25s 取一个点，量它到**最近一件布景**的横向距离，
 * 报出「全程最大值 / 超过 4m 的采样点」。这个数就是"障碍物有没有勾勒出路线"的验收线。
 *
 * 用法：node tools/near-gap.mjs "levels/ring a bell-灰澈" [时长秒]
 */
import fs from "node:fs";
import path from "node:path";
import { buildVerts, posAt, linesOf } from "../src/js/level.js";
import { buildPlaced } from "../src/js/props.js";

const dir = process.argv[2];
if (!dir) { console.error("用法：node tools/near-gap.mjs <关卡目录> [时长秒]"); process.exit(1); }
const dur = Number(process.argv[3] || 174.667);
const level = JSON.parse(fs.readFileSync(path.join(dir, "level.json"), "utf8"));
const defs = linesOf(level);
const verts = buildVerts(level, dur, defs[0]);
const pl = buildPlaced(level, verts, { roadWidth: level.roadWidth || 3 });

// 实例矩阵 → 世界轴对齐盒（rotY 一律吸附 0/±90°，所以 AABB 就是精确体）
const boxes = [];
pl.group.traverse((o) => {
  if (!o.isInstancedMesh) return;
  const a = o.instanceMatrix.array;
  for (let i = 0; i < o.count; i++) {
    const m = i * 16;
    boxes.push({
      x: a[m + 12], z: a[m + 14],
      hw: Math.hypot(a[m + 0], a[m + 1], a[m + 2]) / 2,
      hd: Math.hypot(a[m + 8], a[m + 9], a[m + 10]) / 2,
    });
  }
});

const at = (t) => { const q = posAt(verts, t); return q && q.pos ? q.pos : q; };
const n = Math.ceil(dur * 4);
const over = [];
let worst = 0, worstT = 0;
for (let i = 0; i <= n; i++) {
  const t = i / 4, p = at(t);
  let best = Infinity;
  for (let k = 0; k < boxes.length; k++) {
    const b = boxes[k];
    const dx = Math.max(0, Math.abs(p.x - b.x) - b.hw);
    const dz = Math.max(0, Math.abs(p.z - b.z) - b.hd);
    const d = Math.hypot(dx, dz);
    if (d < best) { best = d; if (d === 0) break; }
  }
  if (best > worst) { worst = best; worstT = t; }
  if (best > 4) over.push(+t.toFixed(1));
}
console.log(JSON.stringify({
  布景件数: boxes.length,
  采样点: n + 1,
  最近布景距离_最大_m: +worst.toFixed(2),
  出现时刻_s: +worstT.toFixed(1),
  超过4m的采样点: over.length,
  时间点: over.slice(0, 24),
}, null, 2));
process.exit(over.length ? 1 : 0);
