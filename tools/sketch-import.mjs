// 把作者手摆的俯视草图 sketch-plan.json 导入成引擎能渲染的 place[]，
// 这样我可以在**我们自己的引擎里**看到他心里的"最低标准"长什么样（3D + 俯视），
// 再照着它调生成器，而不是靠猜"障碍物勾勒出路线"是什么意思。
//
// 映射方式：草图的方块是 (x, z, w, d) 的轴对齐矩形；引擎布景的定位是 (t, off)
// —— 沿路弧长 + 侧向偏移。所以对每个方块找它在关卡 path 上的最近点，取该点的 t 与带符号 off。
//
// 用法：node tools/sketch-import.mjs --level "levels/ring a bell-灰澈/level.json" [--apply]
import fs from "node:fs";

const A = process.argv.slice(2);
const arg = (k, d) => { const i = A.indexOf("--" + k); return i >= 0 ? A[i + 1] : d; };
const has = (k) => A.includes("--" + k);
const LEVEL = arg("level", "levels/ring a bell-灰澈/level.json");
const SKETCH = arg("sketch", "sketch-plan.json");
const TMAX = +arg("tmax", 46);          // 草图只覆盖起点这一小段；这段之外保留原布景
const APP = has("apply");

const lvl = JSON.parse(fs.readFileSync(LEVEL, "utf8"));
const sk = JSON.parse(fs.readFileSync(SKETCH, "utf8"));
const P = lvl.path;

function nearest(x, z) {
  let best = null;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    const ax = a.pos[0], az = a.pos[2], dx = b.pos[0] - ax, dz = b.pos[2] - az;
    const L2 = dx * dx + dz * dz || 1;
    let k = ((x - ax) * dx + (z - az) * dz) / L2; k = Math.max(0, Math.min(1, k));
    const px = ax + dx * k, pz = az + dz * k;
    const d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) {
      const L = Math.sqrt(L2), nx = -dz / L, nz = dx / L;
      best = { d, t: a.t + (b.t - a.t) * k, off: (x - px) * nx + (z - pz) * nz,
        px, pz, nx, nz };
    }
  }
  return best;
}
// 方块中心 → (t, off)：中心投影到路上得到 off；矩形是轴对齐的，尺寸直接沿用
const made = [];
let outside = 0;
for (const b of sk.blocks) {
  const n = nearest(b.x, b.z);
  if (n.t > TMAX) { outside++; continue; }
  made.push({
    t: +n.t.toFixed(3), off: +n.off.toFixed(2),
    w: +b.w.toFixed(2), h: b.h || 1, d: +(b.d || b.w).toFixed(2),
    tone: b.w >= 9 ? 1 : b.w >= 4 ? 1 : 0, rot: 0, rise: false, exact: true,
    clr: +n.d.toFixed(3), g: 1, anim: "breath", phase: +((b.x * 7 + b.z * 13) % 10 / 10).toFixed(3),
  });
}
const keep = (lvl.place || []).filter((it) => it.t > TMAX);
const ws = made.map((m) => m.w).sort((a, b) => a - b);
const cl = made.map((m) => m.clr).sort((a, b) => a - b);
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
console.log("草图 " + sk.blocks.length + " 件 → t ≤ " + TMAX + "s 段内 " + made.length + " 件（" + outside + " 件在窗口外，忽略）");
console.log("  宽 min " + ws[0].toFixed(2) + " 中位 " + q(ws, 0.5).toFixed(2) + " p95 " + q(ws, 0.95).toFixed(2) + " max " + ws[ws.length - 1].toFixed(2));
console.log("  中心到路中心线 min " + cl[0].toFixed(2) + " 中位 " + q(cl, 0.5).toFixed(2) + " max " + cl[cl.length - 1].toFixed(2) + " m");
if (APP) {
  const bak = "out/bak/level-sketch-import-" + Date.now() + ".json";
  fs.mkdirSync("out/bak", { recursive: true });
  fs.copyFileSync(LEVEL, bak);
  lvl.place = keep.concat(made).sort((a, b) => a.t - b.t);
  fs.writeFileSync(LEVEL, JSON.stringify(lvl, null, 2));
  console.log("已写回 " + LEVEL + "：place[] = " + made.length + " 草图件 + " + keep.length + " 原有（备份 " + bak + "）");
}
