#!/usr/bin/env node
/*
 * export-route.mjs —— 只导出"两样东西"的干净图：**路线虚线 + 舞线轨迹带**
 * （不出网格、不出路带、不画方块、不画顶点方块、不画起终标记、不画比例尺、不写标题）
 *
 * 用法：node tools/export-route.mjs [每米像素数，默认 3] [关卡目录名]
 * 产物：out/route-trail.svg（再由 Chrome 栅格成 out/route-trail.png）
 *
 * 数据源：levels/<关卡>/level-sketch.json 的 road[]（整条舞线，含出生点→首转折与冲线两段）
 *         时间轴按 motion.speedMps 恒速（本关 speedMode="mps"，与曲子时长吻合到 1ms）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const S = Number(process.argv[2] || 3);                 // 每米像素
const LEVEL_DIR = process.argv[3] || "ring a bell-灰澈";
const SKETCH = path.join(ROOT, "levels", LEVEL_DIR, "level-sketch.json");
const LV = path.join(ROOT, "levels", LEVEL_DIR, "level.json");
const j = JSON.parse(fs.readFileSync(SKETCH, "utf8"));
const lv = JSON.parse(fs.readFileSync(LV, "utf8"));
const SPEED = (lv.motion && lv.motion.speedMps) || 14;  // m/s，恒速
const ROAD = j.road || [];
if (ROAD.length < 2) { console.error("level-sketch.json 里没有 road[]"); process.exit(1); }

const stepT = Number(process.argv[4] || 15);            // 打点间隔（秒）

/* ── 坐标：世界 z 向上 → 图上 z 向上（起点在左下、终点在右上） ── */
const pad = 40;                                          // px
let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
for (const [x, z] of ROAD) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
const W = Math.round((x1 - x0) * S + pad * 2), H = Math.round((z1 - z0) * S + pad * 2);
const X = (x) => ((x - x0) * S + pad).toFixed(1);
const Y = (z) => ((z1 - z) * S + pad).toFixed(1);        // z 翻转：起点落到左下角

/* ── 弧长（米）→ 世界点 ── */
const cum = [0];
for (let i = 1; i < ROAD.length; i++) {
  cum.push(cum[i - 1] + Math.hypot(ROAD[i][0] - ROAD[i - 1][0], ROAD[i][1] - ROAD[i - 1][1]));
}
const total = cum[cum.length - 1];
function at(s) {
  s = Math.max(0, Math.min(total, s));
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const k = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  return [ROAD[i - 1][0] + (ROAD[i][0] - ROAD[i - 1][0]) * k, ROAD[i - 1][1] + (ROAD[i][1] - ROAD[i - 1][1]) * k];
}

const pts = ROAD.map(([x, z]) => `${X(x)},${Y(z)}`).join(" ");
// 整条 2.4 km 的图在屏幕上 1 m 只有几个像素 —— 线宽取最小可见值，否则缩略图里就是一根看不见的头发丝
const bandW = Math.max(1 * S, 6);                        // 舞线（游戏里 1 m 宽）
const dashW = Math.max(2.5, S * 0.9);
const o = [];
o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif">`);
o.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
/* ① 舞线轨迹带：白带 + 一圈边（近白底上白带会看不见） */
o.push(`<polyline points="${pts}" fill="none" stroke="#9aa7c2" stroke-width="${(bandW + 2.5).toFixed(1)}" stroke-linejoin="miter"/>`);
o.push(`<polyline points="${pts}" fill="none" stroke="#ffffff" stroke-width="${bandW.toFixed(1)}" stroke-linejoin="miter"/>`);
/* ② 路线虚线 */
o.push(`<polyline points="${pts}" fill="none" stroke="#3a4763" stroke-width="${dashW.toFixed(1)}" stroke-dasharray="${(S * 4).toFixed(1)} ${(S * 2.6).toFixed(1)}" stroke-linejoin="miter"/>`);
/* ③ 轨迹的头部打点（舞线在每一秒走到哪儿） */
const r = Math.max(5, S * 1.6);
for (let t = stepT; t * SPEED <= total; t += stepT) {
  const [px, pz] = at(t * SPEED);
  o.push(`<circle cx="${X(px)}" cy="${Y(pz)}" r="${r.toFixed(1)}" fill="#a3452f" stroke="#fff" stroke-width="${(r * 0.4).toFixed(1)}"/>`);
  o.push(`<text x="${X(px)}" y="${(Number(Y(pz)) - r * 2).toFixed(1)}" font-size="${Math.max(13, S * 5).toFixed(0)}" font-weight="700" fill="#3a4763" text-anchor="middle">${t % 1 ? t.toFixed(1) : t}s</text>`);
}
o.push(`</svg>`);

const out = path.join(ROOT, "out", "route-trail.svg");
fs.writeFileSync(out, o.join("\n"));
console.log(`已写出 out/route-trail.svg　${W}×${H} px（${S} px/m）`
  + `　｜　路 ${ROAD.length} 点、总长 ${total.toFixed(1)} m、按 ${SPEED} m/s ＝ ${(total / SPEED).toFixed(1)} s、每 ${stepT}s 打一个点`);
