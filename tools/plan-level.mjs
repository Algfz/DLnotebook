/* 关卡"布景总平面图"（俯视设计草图）
   ----------------------------------------------------------------------------
   直接调用 props.js 的 buildPlaced()（和游戏运行时同一个函数），把返回的 InstancedMesh
   逐实例分解出 位置 / 尺寸 / 朝向 / 颜色 —— 图上每一件方块都是运行时真实存在的那一件。
   整张图按"路的主轴"旋转，使关卡在纸面上从左上读到右下（横着读）。
   用法：node out/_plan.mjs [pxPerMeter]
   产物：out/plan.svg（矢量）+ out/plan-stats.json
*/
import * as THREE from "../src/vendor/three.module.min.js";
import { buildPlaced } from "../src/js/props.js";
import { DEFAULT_PARAMS } from "../src/js/terrain.js";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const LV = path.join(ROOT, "levels", "ring a bell-灰澈", "level.json");
const level = JSON.parse(fs.readFileSync(LV, "utf8"));
const S = Number(process.argv[2] || 4);            // 每米多少像素
const PAD = 240;
const TOP = 700;                                   // 顶部留给标题/图例的整条带（不压住地图）
const DUR = 174.667;

/* ── 1. 真实几何 ─────────────────────────────────────────────────────── */
const vertsW = level.path.map((p) => ({ t: p.t, x: p.pos[0], y: p.pos[1], z: p.pos[2] }));
const { group } = buildPlaced(level, vertsW, { roadWidth: level.roadWidth || 3 });
const im = group.children[0];
const m4 = new THREE.Matrix4(), pv = new THREE.Vector3(), qv = new THREE.Quaternion(),
      sv = new THREE.Vector3(), ev = new THREE.Euler(), col = new THREE.Color();
const raw = [];
for (let k = 0; k < im.count; k++) {
  im.getMatrixAt(k, m4); m4.decompose(pv, qv, sv);
  im.getColorAt(k, col);
  let hex; try { hex = "#" + col.getHexString(THREE.SRGBColorSpace); } catch (e) { hex = "#" + col.getHexString(); }
  const deg = Math.round((ev.setFromQuaternion(qv, "YXZ").y * 180) / Math.PI);
  raw.push({ k, x: pv.x, z: pv.z, w: sv.x, d: sv.z, h: sv.y, deg, hex });
}
const P = (level.place || []).length;
const B = level.bridge || {};
const deckTh = B.deckTh == null ? 0.9 : B.deckTh;
raw.forEach((b) => {
  b.kind = b.k < P ? "手工摆放"
    : Math.abs(b.h - deckTh) < 0.01 ? "桥面"
    : Math.abs(b.w - b.d) < 0.01 ? "桥墩" : "桥护栏";
});
const counts = raw.reduce((a, b) => ((a[b.kind] = (a[b.kind] || 0) + 1), a), {});

/* ── 2. 不旋转：**保留世界坐标轴** ─────────────────────────────────────
   发起人 2026-10-13 的更正：俯视图应当"从一角开始、到对角结束"，不要为了横着铺开而旋转。
   本关的路只朝 +x / +z 两个方向延伸，所以按世界轴平铺时它天然是一条从一角走到对角的阶梯
   （之前按"路的主轴"旋转把它掰成了横条，反而看不出这个结构）。 */
const p0 = vertsW[0], pn = vertsW[vertsW.length - 1];
const TH = 0;                                        // 0 = 不旋转
const cs = Math.cos(-TH), sn = Math.sin(-TH);
const R2 = (x, z) => ({ x: x * cs - z * sn, z: x * sn + z * cs });
const verts = vertsW.map((v) => { const r = R2(v.x, v.z); return { t: v.t, x: r.x, z: r.z }; });
raw.forEach((b) => { const r = R2(b.x, b.z); b.rx = r.x; b.rz = r.z; });
const ROT_DEG = (-TH * 180) / Math.PI;               // 方块在纸面上的偏转角（0 = 轴对齐）

/* ── 3. 边界（板面按 2*half 宽的带算进去） ──────────────────────────── */
const half = ((DEFAULT_PARAMS.board || {}).half) || 60;
let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
const grow = (x, z, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); };
verts.forEach((v) => grow(v.x, v.z, half));
raw.forEach((b) => grow(b.rx, b.rz, Math.max(b.w, b.d) / 2 + 2));
const W = Math.round((x1 - x0) * S + PAD * 2), H = Math.round((z1 - z0) * S + PAD * 2 + TOP);
const X = (x) => ((x - x0) * S + PAD).toFixed(1);
// z 轴翻转：让起点落在**左下角**、终点落到**右上对角**（世界的 +z 原本在 SVG 里向下画）
const Z = (z) => ((z1 - z) * S + PAD + TOP).toFixed(1);
const NX = (x) => Number(X(x)), NZ = (z) => Number(Z(z));

/* ── 4. 画 ───────────────────────────────────────────────────────────── */
const o = [], push = (s) => o.push(s);
push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Noto Sans SC','Microsoft YaHei',system-ui,sans-serif">`);
push(`<rect width="${W}" height="${H}" fill="#fbfaf6"/>`);

push(`<g stroke="#eae7dc" stroke-width="1.5">`);
for (let gx = Math.ceil(x0 / 50) * 50; gx <= x1; gx += 50) push(`<line x1="${X(gx)}" y1="${TOP - 140}" x2="${X(gx)}" y2="${H}"/>`);
for (let gz = Math.ceil(z0 / 50) * 50; gz <= z1; gz += 50) push(`<line x1="0" y1="${Z(gz)}" x2="${W}" y2="${Z(gz)}"/>`);
push(`</g>`);
push(`<g fill="#c2bdad" font-size="26">`);
for (let gx = Math.ceil(x0 / 100) * 100; gx <= x1; gx += 100) push(`<text x="${X(gx)}" y="${TOP - 106}" text-anchor="middle">${(gx / 10).toFixed(0)}0m</text>`);
for (let gz = Math.ceil(z0 / 100) * 100; gz <= z1; gz += 100) push(`<text x="16" y="${Z(gz)}" dominant-baseline="middle">${(gz / 10).toFixed(0)}0m</text>`);
push(`</g>`);

// 板面：平滑后的中线 + 300m 宽的带（和 terrain.js 的 flatBand 用同一种平滑思路）
const smooth = (pts, r) => pts.map((p, i) => {
  let sx = 0, sz = 0, n = 0;
  for (let j = Math.max(0, i - r); j <= Math.min(pts.length - 1, i + r); j++) { sx += pts[j].x; sz += pts[j].z; n++; }
  return { t: p.t, x: sx / n, z: sz / n };
});
const sm = smooth(verts, 10);
const ptsOf = (a) => a.map((v) => `${X(v.x)},${Z(v.z)}`).join(" ");
// 板面＝平滑中线左右各偏移 half 的多边形（比粗描边干净：没有贝壳状锯齿）
const ribbon = (a, h) => {
  const L = [], R = [];
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[Math.min(a.length - 1, i + 1)], r = a[Math.max(0, i - 1)];
    let dx = q.x - r.x, dz = q.z - r.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    L.push([p.x - dz * h, p.z + dx * h]);
    R.push([p.x + dz * h, p.z - dx * h]);
  }
  return [...L, ...R.reverse()].map((c) => `${X(c[0])},${Z(c[1])}`).join(" ");
};
push(`<polygon points="${ribbon(sm, half)}" fill="#e7e3d3"/>`);
const iFrom = Math.max(12, sm.findIndex((v) => v.t >= (B.from == null ? 0 : B.from)));
push(`<polygon points="${ribbon(sm.slice(iFrom), half)}" fill="#dcd7c4"/>`);
// 路带（3m，阶梯状：用未平滑的真实路径）
push(`<polyline points="${ptsOf(verts)}" fill="none" stroke="#9fb0d2" stroke-width="${(level.roadWidth || 3) * S}" stroke-linejoin="miter"/>`);
push(`<polyline points="${ptsOf(verts)}" fill="none" stroke="#fdfdfb" stroke-width="${Math.max(2, 0.45 * S)}" stroke-dasharray="${S * 1.6} ${S * 1.6}"/>`);

// 结尾金字塔的底面菱形（terrain.endcap）
const ec = (level.terrain || {}).endcap;
if (ec) {
  const last = verts[verts.length - 1], prev = verts[verts.length - 8] || verts[0];
  let dx = last.x - prev.x, dz = last.z - prev.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  const s = ec.halfW || 60, g = (ec.slotW || 6) / 2;
  const cx = last.x + dx * (s * 0.2), cz = last.z + dz * (s * 0.2);
  const corners = [[cx + dx * s, cz + dz * s], [cx - dz * s, cz + dx * s], [cx - dx * s, cz - dz * s], [cx + dz * s, cz - dx * s]];
  push(`<polygon points="${corners.map((c) => `${X(c[0])},${Z(c[1])}`).join(" ")}" fill="none" stroke="#8b8677" stroke-width="4" stroke-dasharray="18 12"/>`);
  push(`<line x1="${X(cx - dz * g * 4)}" y1="${Z(cz + dx * g * 4)}" x2="${X(cx + dz * g * 4)}" y2="${Z(cz - dx * g * 4)}" stroke="#8b8677" stroke-width="4"/>`);
  push(`<text x="${X(cx)}" y="${Z(cz) - 26}" font-size="40" font-weight="700" fill="#7a6f52" stroke="#ffffff" stroke-width="9" paint-order="stroke" text-anchor="middle">④ 结尾 · 中开的金字塔</text>`);
}

// 所有方块（轴对齐 → 纸上仍是一个矩形，只是整体偏转 ROT_DEG）
push(`<g stroke="rgba(25,35,65,.38)" stroke-width="1.2">`);
for (const b of raw) {
  const cx = NX(b.rx), cy = NZ(b.rz);
  push(`<rect x="${(cx - (b.w * S) / 2).toFixed(1)}" y="${(cy - (b.d * S) / 2).toFixed(1)}" width="${(b.w * S).toFixed(1)}" height="${(b.d * S).toFixed(1)}" fill="${b.hex}"${Math.abs(ROT_DEG % 90) < 0.01 ? "" : ` transform="rotate(${ROT_DEG.toFixed(2)} ${cx.toFixed(1)} ${cy.toFixed(1)})"`}/>`);
}
push(`</g>`);

/* ── 5. 时间刻度 / 相机关键帧 / 分段大字 ───────────────────────────── */
const at = (t) => { const i = verts.findIndex((v) => v.t >= t); return verts[i < 0 ? verts.length - 1 : i]; };
push(`<g font-size="30" fill="#2b3550" stroke="#ffffff" stroke-width="7" paint-order="stroke" text-anchor="middle">`);
for (let t = 0; t <= DUR; t += 10) {
  const v = at(t);
  push(`<circle cx="${X(v.x)}" cy="${Z(v.z)}" r="9" fill="#ffffff" stroke="#2b3550" stroke-width="4"/>`);
  push(`<text x="${X(v.x)}" y="${(NZ(v.z) - 24).toFixed(1)}">${t}s</text>`);
}
push(`</g>`);
const cams = ((level.scenes || [])[0] || {}).camera || [];
push(`<g font-size="28" fill="#8a3f2f" stroke="#ffffff" stroke-width="7" paint-order="stroke" text-anchor="middle">`);
for (const c of cams) {
  const v = at(c.t);
  push(`<rect x="${(NX(v.x) - 11).toFixed(1)}" y="${(NZ(v.z) - 11).toFixed(1)}" width="22" height="22" transform="rotate(45 ${X(v.x)} ${Z(v.z)})" fill="#ffffff" stroke="#8a3f2f" stroke-width="4"/>`);
  push(`<text x="${X(v.x)}" y="${(NZ(v.z) + 48).toFixed(1)}">cam ${c.t}s</text>`);
}
push(`</g>`);
push(`<g font-size="54" font-weight="700" stroke="#ffffff" stroke-width="11" paint-order="stroke" text-anchor="middle">`);
push(`<text x="${X(at(12).x)}" y="${(NZ(at(12).z) + 200).toFixed(1)}" fill="#8a7f5c">① 平原 · 散落石板</text>`);
push(`<text x="${X(at(36).x)}" y="${(NZ(at(36).z) + 200).toFixed(1)}" fill="#8a7f5c">② 方块立起来</text>`);
push(`<text x="${X(at(100).x)}" y="${(NZ(at(100).z) + 200).toFixed(1)}" fill="#3d4f78">③ 高架桥走廊 · 方块围出路线</text>`);
push(`</g>`);

/* ── 6. 标题 / 图例 / 比例尺 / 时间轴 ───────────────────────────────── */
const lw = 1120, lh = 620;
push(`<g transform="translate(${PAD - 30},${40})">`);
push(`<rect width="${lw}" height="${lh}" rx="20" fill="rgba(255,255,255,.95)" stroke="#c9c4b4" stroke-width="2"/>`);
push(`<text x="40" y="74" font-size="52" font-weight="700" fill="#1e2740">Ring a Bell · 灰澈 ｜ 布景总平面图</text>`);
push(`<text x="40" y="122" font-size="30" fill="#4a5470">俯视 · 1 像素 = ${(1 / S).toFixed(3)} m · 本图由 props.js 的 buildPlaced() 真实几何导出</text>`);
const rows = [
  ["#657cbe", `手工摆放的方块 ${P} 件 —— 逐件写死、零随机、全部轴对齐`],
  ["#7f95cf", `高架桥护栏 ${counts["桥护栏"] || 0} 道（每 26 m 一道长墙，接成走廊）`],
  ["#3f5286", `桥面 ${counts["桥面"] || 0} 段 ｜ 桥墩 ${counts["桥墩"] || 0} 根`],
  ["#e7e3d3", "米黄板面：沿路 300 m 宽的带"],
  ["#9fb0d2", `路带（宽 ${level.roadWidth || 3} m）＋ 白色虚线＝中线`],
];
rows.forEach((r, i) => {
  const y = 186 + i * 58;
  push(`<rect x="40" y="${y - 28}" width="48" height="36" fill="${r[0]}" stroke="rgba(25,35,65,.38)"/>`);
  push(`<text x="108" y="${y}" font-size="30" fill="#333c56">${r[1]}</text>`);
});
const len = vertsW.reduce((a, v, i) => (i ? a + Math.hypot(v.x - vertsW[i - 1].x, v.z - vertsW[i - 1].z) : 0), 0);
push(`<text x="40" y="${lh - 118}" font-size="30" fill="#333c56">方块合计 ${raw.length} 件 ｜ 时长 ${DUR} s ｜ 路长 ${len.toFixed(0)} m</text>`);
push(`<text x="40" y="${lh - 76}" font-size="30" fill="#333c56">◇＝相机关键帧（15 个）　○＝每 10 s 的时间刻度</text>`);
push(`<g transform="translate(40,${lh - 46})"><rect width="${25 * S}" height="14" fill="#1e2740"/><rect x="${25 * S}" width="${25 * S}" height="14" fill="#fff" stroke="#1e2740" stroke-width="2"/><text x="0" y="46" font-size="26" fill="#333c56">0</text><text x="${50 * S}" y="46" font-size="26" fill="#333c56" text-anchor="end">50 m</text></g>`);
push(`</g>`);

const tlY = H - 210;
push(`<text x="${PAD - 30}" y="${tlY - 22}" font-size="34" font-weight="600" fill="#1e2740">时间轴 · 方块随线的前进"一片一片"升起（每件在自己时刻前 5 s 开始升，1.7 s 升到位）</text>`);
const sec = [
  [0, 26, "① 平原 · 散落石板（10 条横向带 / 每 3.0 s 一档）", "#e7e3d3"],
  [26, 46, "② 方块立起来（柱林 / 每 2.2 s 一档）", "#dcd7c4"],
  [46, DUR, "③ 高架桥走廊：护栏/桥面/桥墩从路面上升起，一路到结尾", "#9fb0d2"],
];
sec.forEach(([a, b, label, c]) => {
  const xa = (PAD - 30) + (a / DUR) * (W - 2 * PAD + 60), xb = (PAD - 30) + (b / DUR) * (W - 2 * PAD + 60);
  push(`<rect x="${xa.toFixed(1)}" y="${tlY}" width="${(xb - xa).toFixed(1)}" height="44" fill="${c}" stroke="#b9b4a4"/>`);
  push(`<text x="${(xa + 14).toFixed(1)}" y="${tlY + 84}" font-size="28" fill="#333c56">${label}</text>`);
});
cams.forEach((c) => {
  const x = (PAD - 30) + (c.t / DUR) * (W - 2 * PAD + 60);
  push(`<line x1="${x.toFixed(1)}" y1="${tlY - 6}" x2="${x.toFixed(1)}" y2="${tlY + 44}" stroke="#8a3f2f" stroke-width="3"/>`);
});
push(`<text x="${PAD - 30}" y="${tlY + 130}" font-size="28" fill="#8a3f2f">竖线＝相机关键帧（tilt ${cams.map((c) => c.tilt).join("° / ")}°）</text>`);
push(`<text x="${W / 2}" y="${H - 18}" font-size="26" fill="#8b8677" text-anchor="middle">按世界坐标轴平铺（不旋转）：起点在左下角、终点在右上对角　｜　世界坐标 x ${p0.x.toFixed(0)}→${pn.x.toFixed(0)}、z ${pn.z.toFixed(0)}→${p0.z.toFixed(0)}</text>`);
push(`</svg>`);

fs.writeFileSync(path.join(ROOT, "out", "level-plan.svg"), o.join("\n"));
console.log(`方块 ${raw.length} 件：` + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" / "));
console.log(`纸面范围 x ${x0.toFixed(1)}…${x1.toFixed(1)}  z ${z0.toFixed(1)}…${z1.toFixed(1)} → SVG ${W}×${H} px（${S} px/m）`);
fs.writeFileSync(path.join(ROOT, "out", "level-plan-stats.json"), JSON.stringify({ W, H, S, total: raw.length, counts, P, ROT_DEG, bounds: { x0, x1, z0, z1 } }, null, 2));
