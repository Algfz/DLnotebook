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
const ACTS = [
  {
    id: "A", name: "台原", t: [0, 40], palette: "board",
    // 平原：几乎不放坡，只在 3m 处落一个 0.9m 的坎，让路"读"得出来
    profile: [[1.6, 0], [14, 0], [14, -1.2], [60, -1.6], [110, -1.6]],
  },
  {
    id: "B", name: "深谷", t: [40, 108], palette: "cream",
    // 主体：路是一条窄脊，两侧先垂直落 10m，再两级台地落到谷底 −32m，
    // 谷对面 70m 处拔起一道 46m 高的崖壁（把天压住，画面才有"谷"的感觉）
    profile: [[1.6, 0], [13, 0], [13, -38], [34, -44], [104, -46], [104, 20], [136, 28]],
  },
  {
    id: "C", name: "梯田", t: [108, 148], palette: "sand",
    // 收势：崖壁退到 62m，台地变缓，视野重新打开（和前一幕形成呼吸）
    profile: [[1.6, 0], [9, 0], [9, -7], [26, -15], [62, -18], [104, -18], [104, 12], [134, 18]],
  },
  {
    id: "D", name: "广场", t: [148, 168], palette: "board",
    // 结尾：一片开阔的广场，只保留 7m 的台坎，把视线全部让给金字塔
    profile: [[1.6, 0], [34, 0], [34, -9], [96, -9]],
  },
];

/* ----------------------------- 建筑语法 -----------------------------
   四类，全部按 (t, off) 落位；off 正号 = 行进方向的右侧。 */
const ARCH = [];
const put = (o) => ARCH.push({ rise: false, exact: true, ...o });

// ① 平原上的巨石：建立尺度（人一进关就知道这世界多大）
[8, 16, 24, 32].forEach((t, i) => {
  const off = (16 + 6 * (i % 3)) * (i % 2 ? -1 : 1);
  put({ t, off, w: 2.8, h: 13 + 4 * (i % 3), d: 2.8, tone: 2 });
});

// ② 山门：每一幕的交界处立一道门 —— 门是"进入下一段"的信号
const GATES = [39.5, 107.5, 147.5];
GATES.forEach((t) => {
  put({ t, off: 6.8, w: 3.4, h: 15, d: 3.4, tone: 1 });
  put({ t, off: -6.8, w: 3.4, h: 15, d: 3.4, tone: 1 });
  put({ t, off: 0, w: 19, h: 2.4, d: 4.4, dy: 12.6, tone: 2 });   // 横梁：架空，不挡路
});

// ③ 谷中望柱：每 16 拍一对，沿脊线站成两排（节奏，而不是装饰）
for (let t = 50; t <= 104; t += 16 * BEAT) {
  put({ t, off: 5.2, w: 1.6, h: 6.5, d: 1.6, tone: 0 });
  put({ t, off: -5.2, w: 1.6, h: 6.5, d: 1.6, tone: 0 });
}

// ④ 梯田列柱：每 8 拍一根，间距 50m→25m，走起来像穿过一段柱廊
for (let t = 112; t <= 146; t += 8 * BEAT) {
  put({ t, off: 9, w: 2.0, h: 10, d: 2.0, tone: 1 });
  put({ t, off: -9, w: 2.0, h: 10, d: 2.0, tone: 1 });
}

// ⑤ 广场台座：两级退台，把金字塔托起来
[[152, 15, 12, 5], [156, 24, 16, 8], [160, 15, 12, 5], [164, 24, 16, 8]].forEach(([t, off, w, h]) => {
  put({ t, off, w, h, d: w, tone: 2 });
  put({ t, off: -off, w, h, d: w, tone: 2 });
});

/* ----------------------------- 写入 ----------------------------- */
const dry = process.argv.includes("--dry");
const level = JSON.parse(fs.readFileSync(FILE, "utf8"));

// 旧的高架桥装饰（护栏/桥墩）属于上一版"路架空 4m"的做法；现在的路是走在一整条
// 实心山脊上，再挂护栏/桥墩只会和地形打架 —— 去掉（改由地形剖面 + 望柱表达）。
delete level.bridge;

level.terrain = {
  v: 1,
  base: { motif: "profile", palette: "board", params: { profile: ACTS[0].profile, smooth: 2, smoothFar: 7, smoothFarFrom: 40, th: 6 } },
  spans: ACTS.slice(1).map((a) => ({
    t: a.t, motif: "profile", palette: a.palette,
    params: { profile: a.profile, smooth: 2, smoothFar: 7, smoothFarFrom: 40, th: 6 },
  })),
  // 结尾的金字塔保留（它是最强的终点符号），但让它退得更远、更宽
  endcap: { halfW: 96, slotW: 9, h: 120, enter: -70, sink: 3, palette: "cream" },
};

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
