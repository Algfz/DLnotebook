#!/usr/bin/env node
// style-audit.mjs —— 视觉审计：把一帧图像拆成「背景 + 若干连通块」，量出可比较的数字。
//
// 目的：把规律表里那些"看起来"的要求（R8 小:大比、R12 不多但很大、R17 三档尺寸、
//       R4 一段一色系）变成一帧上可测的量，用来和官方参考帧对照。
//
// 用法：
//   node tools/style-audit.mjs --ref "out/ref_etw/ETW29 驻足的宁静" --ours "out/shot/ring a bell-灰澈" \
//        --n 8 --label-ref ETW29 --label-ours ours
//
// 量什么（每个都只有图像，所以对参考帧和我们的帧一视同仁）：
//   件数        连通块个数（= 画面里能分辨出的独立体量，贴在一起的会并成一块）
//   大件数      面积 ≥ 1% 画面的块
//   中件数      0.1% ~ 1%
//   小件数      < 0.1%
//   小:大比     线性尺寸(√面积)的中位数 / 最大件，用来对照 R8「小:大 = 1:8~25」
//   占比        非背景像素占比（≈ 被道具/路占掉的部分），留白 = 1 - 占比
//   主色数      量化到每通道 5 bit 后，占比 ≥ 1% 的颜色簇个数（R4「一段 2~4 种」）
//   边密度      相邻像素色差 > 阈值的像素占比（细节量/密度，越高越"碎"）
//   竖高比      影子/侧面的暗像素占非背景像素的比例 —— 粗略代理"有没有竖向体量"
//
// 依赖：只调 ffmpeg（把任意图片转成 PPM P6），其余自己算，不引第三方库。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const av = process.argv.slice(2);
// 支持 --k=v 与 --k v 两种写法
const val = (k, d) => {
  const eq = av.find((x) => x.startsWith(k + "="));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = av.indexOf(k);
  return i >= 0 && av[i + 1] && !av[i + 1].startsWith("--") ? av[i + 1] : d;
};
const dirs = (k) => {
  const out = [];
  for (let i = 0; i < av.length; i++) {
    if (av[i].startsWith(k + "=")) out.push(av[i].split("=").slice(1).join("="));
    else if (av[i] === k && av[i + 1]) out.push(av[++i]);
  }
  return out;
};
const REF = dirs("--ref"), OUR = dirs("--ours");
const N = +val("--n", 8);
const W = +val("--w", 480);
const THR = +val("--thr", 30);          // 与背景色的欧氏距离阈值
const MINPX = +val("--minpx", 10);      // 小于这个像素数的连通块忽略
if (!REF.length && !OUR.length) {
  console.error("用法: node tools/style-audit.mjs --ref <目录> [--ref ...] --ours <目录> [--n 8]");
  process.exit(1);
}

const TMP = path.join("out", "tmp", "audit");
fs.mkdirSync(TMP, { recursive: true });

/* ── 读图：ffmpeg → PPM(P6) → {w,h,data} ── */
function loadPPM(file) {
  const out = path.join(TMP, "t.ppm");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vf", `scale=${W}:-2`, "-f", "image2", "-pix_fmt", "rgb24", out], { stdio: "ignore" });
  const buf = fs.readFileSync(out);
  // 解析 P6 头（可能含注释）
  let i = 0, fields = [];
  while (fields.length < 4 && i < buf.length) {
    if (buf[i] === 0x23) { while (buf[i] !== 0x0a) i++; continue; }
    if (buf[i] <= 0x20) { i++; continue; }
    let s = i; while (buf[i] > 0x20) i++;
    fields.push(buf.subarray(s, i).toString("latin1"));
  }
  i++; // 单个空白
  const [, w, h, maxv] = fields;
  if (fields[0] !== "P6" || +maxv !== 255) throw new Error("不是 8bit P6 PPM: " + file);
  return { w: +w, h: +h, data: buf.subarray(i, i + +w * +h * 3) };
}

/* ── 分析一帧 ── */
function analyze(file) {
  const { w, h, data } = loadPPM(file);
  const N2 = w * h;
  const at = (p) => [data[p * 3], data[p * 3 + 1], data[p * 3 + 2]];

  // 背景色：取四边一圈像素的中位数色（一般就是天空或地面）
  const border = [];
  for (let x = 0; x < w; x += 2) { border.push(at(x)); border.push(at((h - 1) * w + x)); }
  for (let y = 0; y < h; y += 2) { border.push(at(y * w)); border.push(at(y * w + w - 1)); }
  const med = (arr, k) => { const a = arr.map((c) => c[k]).sort((p, q) => p - q); return a[a.length >> 1]; };
  const bg = [med(border, 0), med(border, 1), med(border, 2)];

  // 前景掩码 + 边密度
  const fg = new Uint8Array(N2);
  let fgN = 0, edgeN = 0, darkN = 0;
  for (let p = 0; p < N2; p++) {
    const [r, g, b] = at(p);
    const d = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
    if (d > THR) { fg[p] = 1; fgN++; if (r + g + b < 3 * 110) darkN++; }
    if (p % w && p >= w) {
      const q = at(p - 1);
      if (Math.abs(r - q[0]) + Math.abs(g - q[1]) + Math.abs(b - q[2]) > 60) edgeN++;
    }
  }

  // 连通块（4 邻域，并查集）
  const par = new Int32Array(N2).fill(-1);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const uni = (x, y) => { const a = find(x), b = find(y); if (a !== b) par[a] = b; };
  for (let p = 0; p < N2; p++) if (fg[p]) par[p] = p;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x; if (!fg[p]) continue;
    if (x && fg[p - 1]) uni(p, p - 1);
    if (y && fg[p - w]) uni(p, p - w);
  }
  const size = new Map();
  for (let p = 0; p < N2; p++) if (fg[p]) { const r = find(p); size.set(r, (size.get(r) || 0) + 1); }
  const comps = [...size.values()].filter((v) => v >= MINPX).sort((a, b) => b - a);
  const bigN = comps.filter((v) => v >= 0.01 * N2).length;
  const midN = comps.filter((v) => v >= 0.001 * N2 && v < 0.01 * N2).length;
  const smlN = comps.filter((v) => v < 0.001 * N2).length;
  const lin = comps.map(Math.sqrt);
  const maxLin = lin[0] || 1;
  const medLin = lin.length ? lin[lin.length >> 1] : 0;
  const smallBig = medLin ? +(maxLin / medLin).toFixed(1) : 0;

  // 主色数：每通道量化到 32 级，统计占比 ≥1% 的簇
  const hist = new Map();
  for (let p = 0; p < N2; p += 1) { const k = (data[p * 3] >> 3) << 10 | (data[p * 3 + 1] >> 3) << 5 | (data[p * 3 + 2] >> 3); hist.set(k, (hist.get(k) || 0) + 1); }
  const mainColors = [...hist.values()].filter((v) => v >= 0.01 * N2).length;

  return {
    file: path.basename(file), w, h,
    pieces: comps.length, big: bigN, mid: midN, small: smlN,
    cover: +(100 * fgN / N2).toFixed(1),
    blank: +(100 - 100 * fgN / N2).toFixed(1),
    smallBig, colors: mainColors,
    edge: +(100 * edgeN / N2).toFixed(2),
    vert: fgN ? +(100 * darkN / fgN).toFixed(1) : 0,
  };
}

/* ── 采样一组帧（均匀取 N 张） ── */
function sample(dir, n) {
  const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  if (!files.length) return [];
  const step = Math.max(1, Math.floor(files.length / n));
  const pick = [];
  for (let i = 0; i < files.length && pick.length < n; i += step) pick.push(path.join(dir, files[i]));
  return pick;
}

const groups = [];
for (const d of REF) groups.push({ label: path.basename(d), rows: sample(d, N).map(analyze) });
for (const d of OUR) groups.push({ label: path.basename(d) + "(我们)", rows: sample(d, N).map(analyze) });

/* ── 输出 ── */
const avg = (rows, k) => +(rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(1);
console.log("\n单帧明细");
console.log("组\t帧\t件数\t大\t中\t小\t小:大\t占比%\t留白%\t主色\t边密度\t竖高%");
for (const g of groups) for (const r of g.rows) {
  console.log([g.label, r.file, r.pieces, r.big, r.mid, r.small, r.smallBig, r.cover, r.blank, r.colors, r.edge, r.vert].join("\t"));
}
console.log("\n组均值");
console.log("组\t件数\t大\t中\t小\t小:大\t占比%\t留白%\t主色\t边密度\t竖高%");
for (const g of groups) {
  console.log([g.label, avg(g.rows, "pieces"), avg(g.rows, "big"), avg(g.rows, "mid"), avg(g.rows, "small"),
    avg(g.rows, "smallBig"), avg(g.rows, "cover"), avg(g.rows, "blank"), avg(g.rows, "colors"),
    avg(g.rows, "edge"), avg(g.rows, "vert")].join("\t"));
}
console.log("");
