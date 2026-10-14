/* solid-check.mjs —— 判定物的引擎级自检（不启动浏览器）
 *
 * 为什么这样做：ADR-21 / ADR-25 的教训是"判据必须落在引擎真正的几何上"。
 * tools/solid-check.mjs 用 Node **直接 import 引擎自己的模块**：
 *   - src/js/level.js 的 buildVerts() / posAt()  → 官方路线上线头的真实位置
 *   - src/js/props.js 的 buildPlaced()           → 判定物的真实世界 AABB（含 SOL_SHRINK）
 * 于是这里量出来的就是 `src/js/game.js` 判定循环用的同一组数字，不存在"工具的模型和引擎不一样"。
 *
 * 用法：node tools/solid-check.mjs "levels/ring a bell-灰澈" [时长秒]
 * 退出码：0 = 官方路线全程不撞；1 = 有相撞（或参数错误）。
 */
import fs from "node:fs";
import path from "node:path";
import { buildVerts, posAt, linesOf } from "../src/js/level.js";
import { buildPlaced } from "../src/js/props.js";

const dir = process.argv[2];
if (!dir) { console.error("用法：node tools/solid-check.mjs <关卡目录> [时长秒]"); process.exit(1); }
const dur = Number(process.argv[3] || 174.667);

const level = JSON.parse(fs.readFileSync(path.join(dir, "level.json"), "utf8"));
const defs = linesOf(level);
const verts = buildVerts(level, dur, defs[0]);
const pl = buildPlaced(level, verts, { roadWidth: level.roadWidth || 3 });
const solids = pl.solids || [];

// 线宽：引擎里 lineW 缺省 1m ⇒ 判定用的半宽 0.5m
const lineHalf = ((defs[0] && defs[0].lineW) || level.lineW || 1) / 2;
const roadHalf = (level.roadWidth || 3) / 2;

const at = (t) => { const q = posAt(verts, t); return q && q.pos ? q.pos : q; };

// 判定：与 game.js 里那段一致（先高度重叠，再 x/z 与线半宽重叠）
function hit(p) {
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (p.y < s.y0 || p.y > s.y1) continue;
    if (Math.abs(p.x - s.x) > s.hw + lineHalf) continue;
    if (Math.abs(p.z - s.z) > s.hd + lineHalf) continue;
    return i;
  }
  return -1;
}

// ① 官方路线全程（120Hz 采样）会不会撞上判定物
const n = Math.ceil(dur * 120);
let firstHit = null, hitFrames = 0, minClear = Infinity, minClearT = 0;
const offenders = new Map();
for (let i = 0; i <= n; i++) {
  const t = i / 120, p = at(t);
  const k = hit(p);
  if (k >= 0) {
    hitFrames++;
    if (!firstHit) firstHit = { t: +t.toFixed(3), x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), solid: k };
    const o = offenders.get(k) || { k, box: solids[k], frames: 0, t0: t, t1: t };
    o.frames++; o.t1 = t; offenders.set(k, o);
  }
  for (let j = 0; j < solids.length; j++) {
    const s = solids[j];
    const dx = Math.max(0, Math.abs(p.x - s.x) - s.hw);
    const dz = Math.max(0, Math.abs(p.z - s.z) - s.hd);
    const dy = Math.max(0, Math.max(s.y0 - p.y, p.y - s.y1));
    const d = Math.hypot(dx, dz, dy);
    if (d < minClear) { minClear = d; minClearT = t; }
  }
}

// ② 反向验证：把线头横向推进"门"的墙里，必须判定为撞（否则判定代码是死的）
const probe = [];
for (const s of solids) if (s.hw > 0.9 && s.y1 - s.y0 > 2) probe.push(s);
let probeOk = 0;
for (const s of probe) {
  const p = { x: s.x, y: (s.y0 + s.y1) / 2, z: s.z };
  if (hit(p) >= 0) probeOk++;
}

console.log(JSON.stringify({
  关卡: dir,
  判定物件数: solids.length,
  采样帧数: n + 1,
  官方路线撞帧数: hitFrames,
  第一处相撞: firstHit,
  相撞的件: [...offenders.values()].map((o) => ({
    k: o.k, x: +o.box.x.toFixed(2), z: +o.box.z.toFixed(2),
    hw: +o.box.hw.toFixed(2), hd: +o.box.hd.toFixed(2),
    y0: +o.box.y0.toFixed(2), y1: +o.box.y1.toFixed(2),
    帧数: o.frames, t从: +o.t0.toFixed(2), t到: +o.t1.toFixed(2),
  })),
  路线到判定物最近距离_m: +minClear.toFixed(3),
  最近距离出现时刻_s: +minClearT.toFixed(2),
  线半宽: lineHalf,
  路带半宽: roadHalf,
  反向验证_探针件数: probe.length,
  反向验证_命中件数: probeOk,
}, null, 2));

process.exit(hitFrames === 0 && probe.length > 0 && probeOk === probe.length ? 0 : 1);
