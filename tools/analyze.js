/* =====================================================================
   analyze.js — 踩音数据分析
   用法: node tools/analyze.js [关卡目录]
   不给参数则分析 levels/ 下的所有关卡
   输出: 密度分布、间隔分位数、最长空档、踩音点全表
   ===================================================================== */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const fmt = t => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");

// 定位要分析的关卡目录
function resolveTargets() {
  const arg = process.argv[2];
  if (arg) return [path.resolve(process.cwd(), arg)];
  const lvRoot = path.join(ROOT, "levels");
  if (!fs.existsSync(lvRoot)) return [];
  return fs.readdirSync(lvRoot, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(lvRoot, e.name))
    .filter(d => fs.readdirSync(d).some(f => f.endsWith(".beat.json")));
}

const targets = resolveTargets();
if (!targets.length) {
  console.log("没有找到任何 .beat.json。用法: node tools/analyze.js [关卡目录]");
  process.exit(0);
}

for (const dir of targets) {
  const jf = fs.readdirSync(dir).find(f => f.endsWith(".beat.json"));
  const d = JSON.parse(fs.readFileSync(path.join(dir, jf), "utf8"));

  console.log("\n================================================");
  console.log("关卡目录:", path.relative(ROOT, dir));
  console.log("工程文件:", jf);
  console.log("================================================");
  console.log("版本:", d.version, "| 延迟补偿:", d.latency_ms, "ms");
  console.log("音频:", JSON.stringify(d.audio));
  console.log("拍号:", d.timing.meter, "| offset:", d.timing.offset);
  console.log("网格段:");
  d.timing.sections.forEach((s, i) =>
    console.log("  #" + (i + 1) + "  t=" + s.t.toFixed(3) + "s  bpm=" + s.bpm +
                "  phase=" + (s.phase * 1000).toFixed(1) + "ms  细分=1/" + s.div +
                "  吸附=" + (s.snap ? "开" : "关(自由)")));
  console.log("拍点总数:", d.beats.length, "| 踩音点:", d.marks.length);

  const marks = d.marks.map(m => m.time);
  const dur = d.audio.duration;

  console.log("\n--- 踩音点密度（每 10 秒）---");
  for (let t = 0; t < dur; t += 10) {
    const c = marks.filter(x => x >= t && x < t + 10).length;
    console.log(fmt(t).padStart(6) + "  " + String(c).padStart(3) + "  " + "█".repeat(c));
  }

  if (marks.length < 2) continue;

  const iv = [];
  for (let i = 1; i < marks.length; i++) iv.push(marks[i] - marks[i - 1]);
  const siv = iv.slice().sort((a, b) => a - b);
  const q = p => siv[Math.min(siv.length - 1, (siv.length * p) | 0)];
  console.log("\n--- 相邻踩音间隔（秒）---");
  console.log("最小 " + siv[0].toFixed(3) +
              " | 25% " + q(0.25).toFixed(3) +
              " | 中位 " + q(0.5).toFixed(3) +
              " | 75% " + q(0.75).toFixed(3) +
              " | 最大 " + siv[siv.length - 1].toFixed(3));

  console.log("\n--- 最长空档 TOP6 ---");
  const gaps = [];
  for (let i = 1; i < marks.length; i++)
    gaps.push({ t: marks[i - 1], gap: marks[i] - marks[i - 1] });
  gaps.sort((a, b) => b.gap - a.gap);
  gaps.slice(0, 6).forEach(g =>
    console.log("  " + fmt(g.t) + " 之后空 " + g.gap.toFixed(2) + "s"));

  console.log("\n--- 踩音点全表 ---");
  console.log(marks.map((t, i) => (i % 8 === 0 ? "\n" : "") + t.toFixed(3)).join("  "));
  console.log("");
}
