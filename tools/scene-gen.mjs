/**
 * scene-gen.mjs —— 用「场景建模」的方式给《ring a bell》重新布景
 *
 * 设计立场（这是这一版和以前最大的区别）
 * ------------------------------------
 * 以前是「摆放景物」：沿路撒几千个小方块，靠数量堆出"热闹"。
 * 现在是「场景建模」：先决定**这块地是什么形状**，再让建筑长在地上。
 *   · 地形用一条**横断面剖线**（terrain 母题 profile）定义 —— 山脊、深谷、阶梯台地
 *   · 建筑只有门 / 望柱 / 列柱 / 台座四类，尺寸都在 10m 上下，成组出现
 *   · 每件都对齐节拍（BPM 132.8 → 每 8 拍 50.6m），形成节奏而不是随机
 * 结果：物件数从 3049 降到几十件，但每一件都参与构成空间。
 *
 * 用法：
 *   node tools/scene-gen.mjs                # 写入 level.json
 *   node tools/scene-gen.mjs --dry          # 只打印统计，不写
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEVEL = "ring a bell-灰澈";
const FILE = path.join(ROOT, "levels", LEVEL, "level.json");

/* ----------------------------- 节拍与尺度 ----------------------------- */
const BPM = 132.8021;
const BEAT = 60 / BPM;             // 0.4518 s
const SPEED = 14;                  // m/s
const M_PER_BEAT = SPEED * BEAT;   // 6.32 m

/* ----------------------------- 四幕剖面 -----------------------------
   一组 [离路距离 m, 相对路面高度 m]，左右镜像。
   第一段（0 ~ 1.6m）是路面本身；之后每一段先铺台面、再在同一距离处竖起立面。 */
/* 设计：一整块「悬浮的暖石台面」，路是台面上最亮的一条带子。
   台面边缘做 30m 厚的断面（深褐色），让它看起来有质量、不是一张纸。
   台阶只在"离路 20m 以外"出现 —— 近处留白，远处才有形。 */
const ACTS = [
  {
    id: "A", name: "台原", t: [0, 40], palette: "dune", flat: 20,
    profile: [[1.6, 0], [22, 0], [22, -1.2], [64, -1.2], [64, -7], [118, -7], [118, -30], [150, -30]],
  },
  {
    id: "B", name: "深谷", t: [40, 108], palette: "dune", flat: 18,
    profile: [[1.6, 0], [18, 0], [18, -1.4], [46, -1.4], [46, -12], [96, -12], [96, -24], [120, -24], [120, -44], [150, -44]],
  },
  {
    id: "C", name: "梯田", t: [108, 148], palette: "dune", flat: 22,
    profile: [[1.6, 0], [24, 0], [24, -3], [44, -3], [44, -7], [66, -7], [66, -13], [118, -13], [118, -34], [150, -34]],
  },
  {
    id: "D", name: "广场", t: [148, 168], palette: "dune", flat: 30,
    profile: [[1.6, 0], [40, 0], [40, -2], [110, -2], [110, -26], [150, -26]],
  },
];

/* 建筑语法：四类，成组出现，按乐句落位（8 拍 = 50.6m，16 拍 = 101m） */
const ARCH = [];
const put = (o) => ARCH.push({ rise: false, exact: true, ...o });

// ① 山门：幕的交界，两柱 + 架空横梁（横梁不做碰撞，只在头顶上跨过去）
[39.6, 107.6, 147.6].forEach((t) => {
  put({ t, off: 8.2, w: 4.4, h: 18, d: 4.4, tone: 2 });
  put({ t, off: -8.2, w: 4.4, h: 18, d: 4.4, tone: 2 });
  put({ t, off: 0, w: 25, h: 3.0, d: 5.6, dy: 15.4, tone: 1 });
});

// ② 远处的碑：只在平原段出现，做尺度参照（高而不密）
[[6, 34], [18, -40], [30, 36]].forEach(([t, off]) => {
  put({ t, off, w: 5, h: 26, d: 5, tone: 2 });
});

// ③ 柱列：贴着台面前沿排（每 8 拍一根），把"路的走向"读出来
for (let t = 46; t <= 144; t += 8 * BEAT) {
  put({ t, off: 5.6, w: 1.8, h: 7, d: 1.8, tone: 1 });
  put({ t, off: -5.6, w: 1.8, h: 7, d: 1.8, tone: 1 });
}

// ④ 广场台座：两级退台，把金字塔托起来
[[152, 18, 14, 5], [158, 28, 18, 9]].forEach(([t, off, w, h]) => {
  put({ t, off, w, h, d: w, tone: 1 });
  put({ t, off: -off, w, h, d: w, tone: 1 });
});

/* ----------------------------- 写入 ----------------------------- */
const dry = process.argv.includes("--dry");
const level = JSON.parse(fs.readFileSync(FILE, "utf8"));

// 场景：深色虚空 + 拉远的雾（雾 26~118 会把 100m 外的崖壁吃掉，之前就是被它糊平的）
for (const sc of level.scenes || []) {
  sc.theme = "diorama";
  sc.palette = "dune";
  sc.fogRange = [90, 620];
  sc.camera = [
    { t: 0, tilt: 40, dist: 32, yaw: 35 },
    { t: 14, tilt: 38, dist: 30, yaw: 18 },
    { t: 40, tilt: 40, dist: 32, yaw: 0 },
    { t: 70, tilt: 39, dist: 33, yaw: 0 },
    { t: 110, tilt: 42, dist: 32, yaw: 8 },
    { t: 148, tilt: 38, dist: 30, yaw: 0 },
    { t: 168, tilt: 36, dist: 28, yaw: 0 },
  ];
}


// 旧的高架桥装饰（护栏/桥墩）属于上一版"路架空 4m"的做法；现在的路是走在一整条
// 实心山脊上，再挂护栏/桥墩只会和地形打架 —— 去掉（改由地形剖面 + 望柱表达）。
delete level.bridge;

level.terrain = {
  v: 1,
  base: { motif: "profile", palette: "board", params: { profile: ACTS[0].profile, flat: ACTS[0].flat, inset: 0.3, smooth: 2, smoothFar: 8, smoothFarFrom: 20, th: 8 } },
  spans: ACTS.slice(1).map((a) => ({
    t: a.t, motif: "profile", palette: a.palette,
    params: { profile: a.profile, flat: a.flat, inset: 0.3, smooth: 2, smoothFar: 8, smoothFarFrom: 20, th: 8 },
  })),
  // 结尾的金字塔保留（它是最强的终点符号），但让它退得更远、更宽
  endcap: { halfW: 96, slotW: 9, h: 120, enter: -70, sink: 3, palette: "dune" },
};

// 树：参考图里"稀但大"的植被。每 34m 一棵、左右交替，尺寸 1.2~1.9 倍，
// 摆在台面内侧（off 7.5~11m，不出台沿），归 buildProps 的占用格处理互相避让。
level.props = [
  { kind: "tree", t: [4, 164], every: 38, off: [9, 19], scale: [1.6, 2.5] },
  { kind: "rock", t: [26, 158], every: 63, off: [12, 22], scale: [0.9, 1.6] },
];

level.place = ARCH.map((o) => ({
  t: +o.t.toFixed(3), off: +o.off.toFixed(2),
  w: o.w, h: o.h, d: o.d, tone: o.tone, rot: 0,
  rise: false, exact: true,
  ...(o.dy != null ? { dy: o.dy } : {}),
}));

/* ----------------------------- 自检 -----------------------------
   净空：所有落地件（dy 为空）到整条路的最小距离必须 > 路半宽 + 自身外接半径 + 0.3 */
const pathPts = level.path;
const pts = [[level.motion.spawn.x, level.motion.spawn.z], ...pathPts.map((p) => [p.pos[0], p.pos[2]])];
function distToPath(x, z) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    let k = L2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    k = Math.max(0, Math.min(1, k));
    best = Math.min(best, Math.hypot(x - (ax + dx * k), z - (az + dz * k)));
  }
  return best;
}
// 时间 → 世界点：直接按 path[i].t 插值（每段长度不等，用 t·v 近似会偏，净空就假了）
const TP = [{ x: level.motion.spawn.x, z: level.motion.spawn.z, t: 0 },
            ...pathPts.map((p) => ({ x: p.pos[0], z: p.pos[2], t: p.t }))];
function atT(t) {
  t = Math.max(0, Math.min(t, TP[TP.length - 1].t));
  let lo = 0, hi = TP.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (TP[m].t <= t) lo = m; else hi = m; }
  const a = TP[lo], b = TP[hi];
  const k = (t - a.t) / Math.max(1e-9, b.t - a.t);
  const p = { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
  // 方向用 ±2s 的长基线（和 props.js 的 BASE=30 同思路，避免在 90° 折点处抖动）
  const p0 = (() => { let l = 0, h = TP.length - 1; const tt = Math.max(0, t - 2);
    while (l < h - 1) { const m = (l + h) >> 1; if (TP[m].t <= tt) l = m; else h = m; }
    const A = TP[l], B = TP[h], kk = (tt - A.t) / Math.max(1e-9, B.t - A.t);
    return { x: A.x + (B.x - A.x) * kk, z: A.z + (B.z - A.z) * kk }; })();
  const p1 = (() => { let l = 0, h = TP.length - 1; const tt = Math.min(TP[TP.length - 1].t, t + 2);
    while (l < h - 1) { const m = (l + h) >> 1; if (TP[m].t <= tt) l = m; else h = m; }
    const A = TP[l], B = TP[h], kk = (tt - A.t) / Math.max(1e-9, B.t - A.t);
    return { x: A.x + (B.x - A.x) * kk, z: A.z + (B.z - A.z) * kk }; })();
  const dx = p1.x - p0.x, dz = p1.z - p0.z, L = Math.hypot(dx, dz) || 1;
  return { ...p, dx: dx / L, dz: dz / L };
}
let worst = Infinity, bad = [];
for (const o of level.place) {
  if (o.dy != null) continue;                     // 架空件（门的横梁）不参与落地净空
  const p = atT(o.t);
  const nx = p.dz, nz = -p.dx;
  const x = p.x + nx * o.off, z = p.z + nz * o.off;
  const half = Math.max(o.w, o.d) / 2;
  const clear = distToPath(x, z) - half;
  if (clear < worst) worst = clear;
  if (clear < level.roadWidth / 2 + 0.3) bad.push({ t: o.t, clear: +clear.toFixed(2) });
}

const byKind = level.place.length;
console.log(`关卡: ${LEVEL}`);
console.log(`  幕数 ${ACTS.length}（${ACTS.map((a) => a.name).join(" / ")}）`);
console.log(`  建筑件 ${byKind} 件（旧版 3049 件）`);
console.log(`  最小净空 ${worst.toFixed(2)} m ${bad.length ? "⚠ 有 " + bad.length + " 件压线" : "✓ 无压线"}`);
if (bad.length) console.log("  压线件:", bad.slice(0, 6));

if (!dry) {
  fs.writeFileSync(FILE, JSON.stringify(level), "utf8");
  console.log("  已写入", path.relative(ROOT, FILE));
} else {
  console.log("  --dry：未写入");
}
