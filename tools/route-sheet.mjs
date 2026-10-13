#!/usr/bin/env node
/*
 * route-sheet.mjs —— 出一张**空白底稿**：只有网格 + 路线虚线 + 舞线轨迹带（+ 每 15 s 一个时间点）
 *
 * 为什么单独做这张图：发起人要的是"一个只有路线和舞线轨迹的文件"，
 * 而草图编辑器是个功能齐全的工具，不该让他每次打开再手动关一堆图层。这张图**打开就是最终样子**。
 *
 * 用法：node tools/route-sheet.mjs [每米像素=4] [关卡目录] [打点间隔秒=15]
 * 产物：levels/<关卡目录>/route-sheet.svg   ← 跟着关卡走、进 git，双击就能看
 *       out/route-sheet.png                ← 同上内容的位图预览（out/ 不进 git）
 *
 * 数据源：levels/<关卡>/route-only.json 的 road[]（整条舞线，683 点；该文件**不含方块**）
 *         时间轴按 motion.speedMps 恒速（本关 speedMode="mps"：2445.3 m ÷ 14 = 174.666 s，与曲子 174.667 s 差 1 ms）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const S = Number(process.argv[2] || 4);                  // 每米像素
const LEVEL_DIR = process.argv[3] || "ring a bell-灰澈";
const STEP_T = Number(process.argv[4] || 15);            // 打点间隔（秒）

const ROUTE = path.join(ROOT, "levels", LEVEL_DIR, "route-only.json");
const LV = path.join(ROOT, "levels", LEVEL_DIR, "level.json");
const j = JSON.parse(fs.readFileSync(ROUTE, "utf8"));
const lv = JSON.parse(fs.readFileSync(LV, "utf8"));
const SPEED = (j.trail && j.trail.speedMps) || (lv.motion && lv.motion.speedMps) || 14;
const GRID = 1;                                          // 网格 1 m
const ROAD = j.road || [];
if (ROAD.length < 2) { console.error("route-only.json 里没有 road[]"); process.exit(1); }

/* ── 画布：世界坐标 → 图上坐标（z 向上 = 起点在左下、终点在右上） ── */
const pad = 90, TOP = 190;                               // 左边/下边留白 + 顶部留给说明
let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
for (const [x, z] of ROAD) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
const W = Math.round((x1 - x0) * S + pad * 2);
const H = Math.round((z1 - z0) * S + pad * 2 + TOP);
const X = (x) => ((x - x0) * S + pad).toFixed(1);
const Y = (z) => ((z1 - z) * S + pad + TOP).toFixed(1);   // z 翻转
const nx = (v) => Number(v);

/* ── 弧长参数化 ── */
const cum = [0];
for (let i = 1; i < ROAD.length; i++) cum.push(cum[i - 1] + Math.hypot(ROAD[i][0] - ROAD[i - 1][0], ROAD[i][1] - ROAD[i - 1][1]));
const total = cum[cum.length - 1];
const dur = total / SPEED;
function at(s) {
  s = Math.max(0, Math.min(total, s));
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const k = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  return [ROAD[i - 1][0] + (ROAD[i][0] - ROAD[i - 1][0]) * k, ROAD[i - 1][1] + (ROAD[i][1] - ROAD[i - 1][1]) * k];
}

const o = [];
o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif">`);
o.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

/* ① 网格：1 m 细格 + 每 10 m 一条粗线（发起人点名要网格线，虚线顶点要压在交点上） */
{
  const kx0 = Math.floor((0 - pad / S) / GRID), kx1 = Math.ceil(((W - pad) / S + x0) / GRID);
  const kz0 = Math.floor((z0 - (pad + TOP) / S) / GRID), kz1 = Math.ceil((z1 + (pad + TOP) / S) / GRID);
  let fine = "", major = "";
  for (let k = kx0; k <= kx1; k++) {
    const px = nx(X(k * GRID));
    if (px < 0 || px > W) continue;
    (k % 10 === 0 ? (major += `M${px} 0L${px} ${H}`) : (fine += `M${px} 0L${px} ${H}`));
  }
  for (let k = kz0; k <= kz1; k++) {
    const py = nx(Y(k * GRID));
    if (py < 0 || py > H) continue;
    (k % 10 === 0 ? (major += `M0 ${py}L${W} ${py}`) : (fine += `M0 ${py}L${W} ${py}`));
  }
  o.push(`<path d="${fine}" stroke="#f0ebdd" stroke-width="1" fill="none"/>`);
  o.push(`<path d="${major}" stroke="#ddd3bb" stroke-width="1.6" fill="none"/>`);
}

/* ② + ③ 舞线轨迹带（1 m 宽，真宽）与路线虚线 */
const pts = ROAD.map(([x, z]) => `${X(x)},${Y(z)}`).join(" ");
const bandW = GRID * S;                                   // 游戏里舞线 1 m 宽 → 真实比例
const edge = Math.max(1.2, S * 0.35);
o.push(`<polyline points="${pts}" fill="none" stroke="#9aa7c2" stroke-width="${(bandW + edge * 2).toFixed(1)}" stroke-linejoin="miter"/>`);
o.push(`<polyline points="${pts}" fill="none" stroke="#ffffff" stroke-width="${bandW.toFixed(1)}" stroke-linejoin="miter"/>`);
o.push(`<polyline points="${pts}" fill="none" stroke="#3a4763" stroke-width="${Math.max(1.6, S * 0.5).toFixed(1)}" stroke-dasharray="${(S * 3).toFixed(1)} ${(S * 2).toFixed(1)}" stroke-linejoin="miter"/>`);

/* ④ 时间点：舞线每 STEP_T 秒走到哪儿 */
const rDot = Math.max(3.5, S * 1.1), fsz = Math.max(11, S * 3.2);
for (let t = STEP_T; t * SPEED <= total; t += STEP_T) {
  const [px, pz] = at(t * SPEED);
  o.push(`<circle cx="${X(px)}" cy="${Y(pz)}" r="${rDot.toFixed(1)}" fill="#a3452f" stroke="#ffffff" stroke-width="${(rDot * 0.42).toFixed(1)}"/>`);
  o.push(`<text x="${X(px)}" y="${(nx(Y(pz)) - rDot * 2.2).toFixed(1)}" font-size="${fsz.toFixed(0)}" font-weight="700" fill="#3a4763" text-anchor="middle">${t % 1 ? t.toFixed(1) : t}s</text>`);
}

/* ⑤ 说明（顶部一条，尽量不占地方）+ 比例尺 */
o.push(`<text x="${pad}" y="52" font-size="30" font-weight="700" fill="#1e2740">${LEVEL_DIR}　舞线底稿（只有网格 + 路线虚线 + 舞线轨迹）</text>`);
o.push(`<text x="${pad}" y="90" font-size="19" fill="#6b6a63">路线 ${total.toFixed(1)} m　｜　按 ${SPEED} m/s ＝ ${dur.toFixed(1)} s　｜　网格 1 m（每 10 m 一条粗线）　｜　时间点每 ${STEP_T} s 一个　｜　轨迹带宽 1 m＝游戏内线宽</text>`);
o.push(`<text x="${pad}" y="120" font-size="19" fill="#6b6a63">单位：米　｜　右 = +x　上 = +z　｜　起点左下角 → 终点右上角　｜　生成：node tools/route-sheet.mjs（数据源 route-only.json，不含布景方块）</text>`);
{
  const y = H - 42, len = 50 * S;                          // 50 m 比例尺
  o.push(`<line x1="${pad}" y1="${y}" x2="${pad + len}" y2="${y}" stroke="#1e2740" stroke-width="3"/>`);
  o.push(`<line x1="${pad}" y1="${y - 7}" x2="${pad}" y2="${y + 7}" stroke="#1e2740" stroke-width="3"/>`);
  o.push(`<line x1="${pad + len}" y1="${y - 7}" x2="${pad + len}" y2="${y + 7}" stroke="#1e2740" stroke-width="3"/>`);
  o.push(`<text x="${pad + len + 12}" y="${y + 7}" font-size="19" fill="#1e2740">50 m</text>`);
}
o.push(`</svg>`);

const svgOut = path.join(ROOT, "levels", LEVEL_DIR, "route-sheet.svg");
fs.writeFileSync(svgOut, o.join("\n"));
console.log(`已写出 levels/${LEVEL_DIR}/route-sheet.svg　${W}×${H} px（${S} px/m）`
  + `　｜　路 ${ROAD.length} 点、${total.toFixed(1)} m、${dur.toFixed(1)} s、每 ${STEP_T}s 打点`);
console.log(`栅格预览：chrome --headless=new --screenshot=out/route-sheet.png --window-size=${W},${H} "file:///${svgOut.replace(/\\/g, "/")}"`);
