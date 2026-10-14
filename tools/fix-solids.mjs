/* fix-solids.mjs —— 用**引擎自己的几何**把压线的判定物推到不压为止
 *
 * 为什么需要它：引擎把 place 的 `(t, off)` 变成世界坐标时用的是 **±30m 基线法线**
 * （`src/js/props.js:1001-1026` 的 `put()`），而 tools 里的生成器写 `off` 时用的是**局部腿的法线**。
 * 这条路 3.4m 一折，两者最多差 45°，于是"off=3.36"的件会落到离路 1.4m 的地方——工具自检干净、
 * 引擎里却压线（与 ADR-21 / ADR-25 同一个教训：判据只能落在引擎几何上）。
 *
 * 做法：import 引擎模块 → 反复「改 off → 重建 solids → 120Hz 采样官方路线」直到 0 相撞。
 *
 * 用法：node tools/fix-solids.mjs "levels/ring a bell-灰澈" [时长秒]
 */
import fs from "node:fs";
import path from "node:path";
import { buildVerts, posAt, linesOf } from "../src/js/level.js";
import { buildPlaced } from "../src/js/props.js";

const dir = process.argv[2];
if (!dir) { console.error("用法：node tools/fix-solids.mjs <关卡目录> [时长秒]"); process.exit(1); }
const dur = Number(process.argv[3] || 174.667);
const file = path.join(dir, "level.json");
const level = JSON.parse(fs.readFileSync(file, "utf8"));
const defs = linesOf(level);
const verts = buildVerts(level, dur, defs[0]);
const lineHalf = ((defs[0] && defs[0].lineW) || 1) / 2;
const roadW = level.roadWidth || 3;

// 一律按设计者给的 (t, off) 落，不做引擎那套净空外推：它用**顶点距离**衡量，
// 锯齿路上会误判（顶点之间 3.4m，件落在腿中间时"离所有顶点 2.7m"却正好骑在路段上）。
for (const it of level.place) it.exact = 1;

const n = Math.ceil(dur * 120);
const at = (t) => { const q = posAt(verts, t); return q && q.pos ? q.pos : q; };
const route = [];
for (let i = 0; i <= n; i++) route.push(at(i / 120));

const STEP = 0.35;   // 每轮外推量（沿引擎的基线法线方向，所以是"斜着往外挪"）

function scan() {
  const pl = buildPlaced(level, verts, { roadWidth: roadW });
  const solids = pl.solids || [];
  const hits = new Map();
  for (const p of route) {
    for (let k = 0; k < solids.length; k++) {
      const s = solids[k];
      if (p.y < s.y0 || p.y > s.y1) continue;
      if (Math.abs(p.x - s.x) > s.hw + lineHalf) continue;
      if (Math.abs(p.z - s.z) > s.hd + lineHalf) continue;
      if (typeof s.pi === "number" && s.pi >= 0) hits.set(s.pi, (hits.get(s.pi) || 0) + 1);
      break;
    }
  }
  return { solids, hits };
}

let rounds = 0;
let r = scan();
while (r.hits.size && rounds < 60) {
  rounds++;
  for (const i of r.hits.keys()) {
    const it = level.place[i];
    const sgn = it.off >= 0 ? 1 : -1;
    it.off = +(sgn * (Math.abs(it.off) + STEP)).toFixed(3);
  }
  r = scan();
  console.log(`第 ${rounds} 轮：${r.hits.size} 件仍压线（各自外推 ${STEP}m）`);
}

fs.writeFileSync(file, JSON.stringify(level, null, 2) + "\n");
console.log(JSON.stringify({
  迭代轮数: rounds,
  判定物件数: r.solids.length,
  压线件数: r.hits.size,
  剩余: [...r.hits.entries()].slice(0, 10).map(([pi, f]) => ({ pi, 帧: f, t: level.place[pi] && level.place[pi].t, off: level.place[pi] && level.place[pi].off })),
}, null, 2));
process.exit(r.hits.size ? 1 : 0);
