/* 读关卡路线，按时间段统计"腿长"（相邻折点之间的距离）——用于判断哪一段是小转角密布 */
import fs from "node:fs";
import { buildVerts, linesOf } from "../src/js/level.js";

const level = JSON.parse(fs.readFileSync("levels/ring a bell-灰澈/level.json", "utf8"));
const verts = buildVerts(level, 174.667, linesOf(level)[0]);

const legs = [];
for (let i = 1; i < verts.length; i++) {
  const a = verts[i - 1], b = verts[i];
  legs.push({ t: b.t, L: Math.hypot(b.x - a.x, b.z - a.z) });
}
for (const w of [[0, 13.4], [13.4, 27], [27, 60], [60, 175]]) {
  const sel = legs.filter((v) => v.t >= w[0] && v.t < w[1]).map((v) => v.L).sort((a, b) => a - b);
  if (!sel.length) continue;
  const q = (p) => sel[Math.min(sel.length - 1, Math.floor(sel.length * p))].toFixed(2);
  console.log(`t ${w[0]}~${w[1]}s  腿数 ${sel.length}  min ${sel[0].toFixed(2)}  p25 ${q(0.25)}  p50 ${q(0.5)}  p75 ${q(0.75)}  max ${sel[sel.length - 1].toFixed(2)}`);
}
const short = legs.filter((v) => v.L < 2.2);
console.log(`短腿(<2.2m) ${short.length}/${legs.length}，时间范围 ${short.length ? short[0].t.toFixed(1) : "-"}~${short.length ? short[short.length - 1].t.toFixed(1) : "-"}s`);
