/* 我们关卡的平均速度 = 路径总长 / 时长；再除以路宽 roadWidth -> "路宽/秒"(W/s)，与官方关卡测量口径对齐 */
import fs from "node:fs";
import { buildVerts, linesOf } from "../src/js/level.js";

const dir = process.argv[2] || "levels/ring a bell-灰澈";
const DUR = Number(process.argv[3] || 174.667);
const level = JSON.parse(fs.readFileSync(dir + "/level.json", "utf8"));
const verts = buildVerts(level, DUR, linesOf(level)[0]);
let tot = 0;
for (let i = 1; i < verts.length; i++) {
  const a = verts[i - 1], b = verts[i];
  tot += Math.hypot(b.x - a.x, b.z - a.z);
}
const W = level.roadWidth || 3;
console.log(`关卡 ${dir}`);
console.log(`折点 ${verts.length - 1}  路径总长 ${tot.toFixed(1)} m  时长 ${DUR} s`);
console.log(`平均速度 ${(tot / DUR).toFixed(2)} m/s = ${(tot / DUR / W).toFixed(2)} W/s  (roadWidth=${W})`);
console.log(`motion: speedBeats=${level.motion?.speedBeats} speedMps=${level.motion?.speedMps}`);
