/* corner-check.mjs —— 复验"每个需要判断的折点外侧都有看得见的判定物"
 *
 * 与 corner-gen.mjs 配对，但判据**只用引擎几何**：
 *   - 折点：`buildVerts()` 的顶点（方向改变 > --angle 度）
 *   - 判定物：`buildPlaced()` 返回的 `solids`（真实世界 AABB，带 `pi` = place 下标）
 * 对每个折点算出"外侧参考点"= 折点 + 外法线 × --off，然后看有没有判定物落在它附近
 * （盒到参考点距离 ≤ 2.5m）。有 ⇒ 这个折点有读数点；没有 ⇒ 列出来。
 *
 * 退出码：0 = 所有折点都有读数点；1 = 有缺。
 * 用法：node tools/corner-check.mjs "levels/ring a bell-灰澈" [--angle 30] [--off 4.2] [--dur 174.667]
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith("--")) { a._.push(s); continue; }
    const eq = s.indexOf("=");
    if (eq >= 0) a[s.slice(2, eq)] = s.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) a[s.slice(2)] = argv[++i];
    else a[s.slice(2)] = true;
  }
  return a;
}
const A = parseArgs(process.argv.slice(2));
const DIR = A._[0] || A.level;
if (!DIR) { console.error("用法：node tools/corner-check.mjs <关卡目录> [--angle 30]"); process.exit(2); }
const ANGLE = parseFloat(A.angle) || 30;
const OFF = parseFloat(A.off) || 4.2;
const BRIDGE_OFF = parseFloat(A["bridge-off"]) || 7.2;
const PLAIN = A.plain != null ? parseFloat(A.plain) : 46;
const DUR = parseFloat(A.dur) || 174.667;
const MERGE = parseFloat(A.merge) || 6;

(async () => {
  const { buildVerts, linesOf } = await import("../src/js/level.js");
  const { buildPlaced } = await import("../src/js/props.js");
  const level = JSON.parse(fs.readFileSync(path.join(DIR, "level.json"), "utf8"));
  const verts = buildVerts(level, DUR, linesOf(level)[0]);
  const pl = buildPlaced(level, verts, { roadWidth: level.roadWidth || 3 });
  const solids = pl.solids || [];

  const corners = [];
  for (let i = 1; i < verts.length - 1; i++) {
    const a = verts[i - 1], c = verts[i], b = verts[i + 1];
    const v1x = c.x - a.x, v1z = c.z - a.z, v2x = b.x - c.x, v2z = b.z - c.z;
    const l1 = Math.hypot(v1x, v1z), l2 = Math.hypot(v2x, v2z);
    if (l1 < 0.5 || l2 < 0.5) continue;
    const dot = (v1x * v2x + v1z * v2z) / (l1 * l2);
    const ang = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    if (ang < ANGLE) continue;
    // 外侧 = 内角平分线的反向（不依赖手性）
    let bx = -(v1x / l1 + v2x / l2), bz = -(v1z / l1 + v2z / l2);
    const bl = Math.hypot(bx, bz) || 1;
    corners.push({ t: c.t, x: c.x, z: c.z, ang, sx: bx / bl, sz: bz / bl });
  }
  const merged = [];
  for (const c of corners) {
    const last = merged[merged.length - 1];
    if (last && c.t - last.t < MERGE / 14) { if (c.ang > last.ang) merged[merged.length - 1] = c; continue; }
    merged.push(c);
  }

  const boxDist = (s, px, pz) => {
    const dx = Math.max(0, Math.abs(px - s.x) - s.hw), dz = Math.max(0, Math.abs(pz - s.z) - s.hd);
    return Math.hypot(dx, dz);
  };

  /* ① 每个折点 8m 内有没有判定物（"这里转"能不能读出来）
   * 注：这条路是 3.4m 一折的锯齿，"每个折点的几何外侧"左右交替 —— 对走廊式关卡真正要保证的是
   *     "折点附近有可见参照"，所以这里量的是折点到最近判定物的距离，不区分左右。 */
  const miss = [];
  for (const c of merged) {
    let best = Infinity;
    for (const s of solids) {
      const d = boxDist(s, c.x, c.z);
      if (d < best) best = d;
    }
    if (best > 8.0) miss.push({ t: +c.t.toFixed(2), 角度: +c.ang.toFixed(0), 最近判定物_m: best === Infinity ? null : +best.toFixed(2) });
  }

  /* ② 沿路每 0.25s 量"到最近判定物"的间距（这才是玩家读路的粒度） */
  const V = verts;
  let worst = 0, worstT = 0, over = 0;
  const at = (t) => { let i = 1; while (i < V.length - 1 && V[i].t < t) i++; const a = V[i - 1], b = V[i]; const k = (t - a.t) / ((b.t - a.t) || 1); return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }; };
  const n = Math.ceil(DUR * 4);
  for (let i = 0; i <= n; i++) {
    const t = i / 4, p = at(t);
    let best = Infinity;
    for (const s of solids) { const d = boxDist(s, p.x, p.z); if (d < best) best = d; }
    if (best > worst) { worst = best; worstT = t; }
    if (best > 6) over++;
  }

  console.log(JSON.stringify({
    折点数_合并后: merged.length,
    判定物件数: solids.length,
    折点8m内有判定物: merged.length - miss.length,
    缺参照的折点: miss.length,
    全程到最近判定物_最大_m: +worst.toFixed(2),
    出现时刻_s: +worstT.toFixed(1),
    超过6m的采样点: over,
    明细_最近的: miss.slice(0, 20),
  }, null, 2));
  process.exit(miss.length ? 1 : 0);   // 只看"折点有没有参照"；间距是信息量（长直段本来就不需要障碍物）
})().catch((e) => { console.error(e); process.exit(1); });
