#!/usr/bin/env node
/* =====================================================================
   thin-marks.mjs —— 把踩点文件里"挨得太近"的 mark 抽稀

   为什么需要：gen-path.js 每两个相邻 mark 之间转一次弯，段长 = 间隔 × 线速。
   如果两个 mark 只差 0.09 s，14 m/s 下这一段只有 1.2 m —— 比路宽（3 m）还窄，
   两个 90° 转弯挤在 1.2 m 里，路面会自己叠在一起糊成一个疙瘩。

   做法：贪心保留 —— 第一颗永远保留，之后只保留"距上一颗保留点 ≥ minDt"的，
   这样每个转弯仍然落在**真实踩点**上，只是把挤成一团的几颗合成一颗。

   用法：
     node tools/thin-marks.mjs levels/<关>/<名>.beat.json --min-dt 0.30
     node tools/thin-marks.mjs <in> --min-dt 0.30 --out <out>   # 另存，不改原文件
     node tools/thin-marks.mjs <in> --dry                       # 只报数，不写盘
   ===================================================================== */
import fs from "node:fs";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes("--" + n);
const file = argv.find(a => !a.startsWith("--") && !/^\d/.test(a));
if (!file) { console.error("用法: node tools/thin-marks.mjs <beat.json> [--min-dt 0.30] [--out 路径] [--dry]"); process.exit(1); }
const MIN_DT = parseFloat(arg("min-dt", "0.30"));
const OUT = arg("out", null);
const DRY = has("dry");

const b = JSON.parse(fs.readFileSync(file, "utf8"));
if (!(MIN_DT > 0)) { console.error("--min-dt 必须 > 0"); process.exit(1); }

/** 对一组 {time} 做贪心抽稀 */
function thin(marks) {
  const kept = [];
  let last = -Infinity;
  for (const m of marks) {
    if (m.time - last >= MIN_DT - 1e-9) { kept.push(m); last = m.time; }
  }
  return kept;
}

let before = 0, after = 0;
if (Array.isArray(b.tracks) && b.tracks.length) {
  for (const t of b.tracks) {
    const src = Array.isArray(t.marks) ? t.marks : [];
    before += src.length;
    t.marks = thin(src);
    if (typeof t.count === "number") t.count = t.marks.length;
    after += t.marks.length;
  }
  // 顶层 marks 是 track A 的镜像（老读取方用）
  if (Array.isArray(b.tracks[0].marks)) b.marks = b.tracks[0].marks.slice();
} else {
  const src = Array.isArray(b.marks) ? b.marks : [];
  before += src.length;
  b.marks = thin(src);
  after += b.marks.length;
}
if (typeof b.count === "number") b.count = after;

console.log(`保留 ${after} / ${before} 颗（丢掉 ${before - after}，min-dt=${MIN_DT}s）`);
if (DRY) process.exit(0);
fs.writeFileSync(OUT || file, JSON.stringify(b, null, 2), "utf8");
console.log("写入:", OUT || file);
