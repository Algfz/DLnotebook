/**
 * 手工摆放（发起人 2026-10-14 要求：不要全靠程序自动生成，亲自摆、频繁渲染检查）
 *
 * 用法：node tools/hand-place.mjs [--apply] [--t0 0] [--t1 12]
 *
 * 语义：删掉 [t0, t1) 窗口内**原来所有**的布景件（不管是不是程序生成的），
 *       换成下面 HAND 数组里**我一件一件写死**的坐标。
 *       每件的字段是 (t, off, w, h, d, tone, sol)，全部由我按转角表人工决定，没有任何随机/贪心/规则。
 * 备份：写回前存 out/bak/level-hand-<时间戳>.json
 *
 * 我摆的依据（人工读图读表得到，不是程序摆的）：
 *   t=0..12.2s 共 43 个 90° 转角（每 0.21s 一个、3.4m 一折）。外侧左右交替：
 *   1.9R 2.11L 2.32R 2.54L 2.77R 2.99L 3.21R 3.64L 3.75R 3.86L 4.08R 4.29L 4.52R 4.73L 5.17R 5.39L
 *   5.61R 5.83L 6.04R 6.26L 6.49R 6.7L 7.14R 7.25L 7.36R 7.58L 7.8R 8.02L 8.24R 8.47L 8.68R 9.13L
 *   9.57R 9.79L 10.02R 10.23L 10.67R 10.79L 10.89R 11.11L 11.34R 11.56L 11.78R
 * 我的取舍：①每个转角外侧一件"小柱"（off 4.0、2.6×2.6、高 2.2），负责"这里要转"的读数；
 *           ②长腿（3.64 / 5.17 / 7.14 / 9.13 / 10.67）外侧加一件"大块"（off 7.0、6×6、高 3.6）做体积层次；
 *           ③2.77 与 8.47 两处**故意留空**当呼吸（发起人："长直段可以没有障碍物"）。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const A = {};
for (let i = 2; i < process.argv.length; i++) {
  const s = process.argv[i];
  if (s.startsWith("--")) { const k = s.slice(2); const v = process.argv[i + 1]; if (v && !v.startsWith("--")) { A[k] = v; i++; } else A[k] = true; }
}
const LEVEL = A.level || "levels/ring a bell-灰澈/level.json";
const T0 = A.t0 != null ? parseFloat(A.t0) : 0;
const T1 = A.t1 != null ? parseFloat(A.t1) : 12;
const APPLY = !!A.apply;

/* ===== 我手工写的摆放表（一件一件写的，没有任何随机） ===== */
/* off<0 = 转角表里的"左"，off>0 = "右" */
const HAND = [
  // —— 每个转角外侧的"小柱" ——
  { t: 1.90, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },   // 1.90 R
  { t: 2.11, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },   // 2.11 L
  { t: 2.32, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },   // 2.32 R
  { t: 2.54, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },   // 2.54 L
  // 2.77 故意留空
  { t: 2.99, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },   // 2.99 L
  { t: 3.21, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },   // 3.21 R
  { t: 3.64, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },   // 3.64 L
  { t: 3.64, off: -7.0, w: 6.0, h: 3.6, d: 6.0, tone: 1, sol: 1 },   // 3.64 大块（长腿）
  { t: 3.75, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 3.86, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 4.08, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 4.29, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 4.52, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 4.73, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 5.17, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 5.17, off: +7.6, w: 6.6, h: 3.6, d: 6.6, tone: 1, sol: 1 },   // 5.17 大块（长腿）
  { t: 5.39, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 5.61, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 5.83, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 6.04, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 6.26, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 6.49, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 6.70, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 7.14, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 7.14, off: +8.0, w: 6.6, h: 3.6, d: 6.6, tone: 1, sol: 1 },   // 7.14 大块
  { t: 7.25, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 7.36, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 7.58, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 7.80, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 8.02, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 8.24, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  // 8.47 故意留空
  { t: 8.68, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 9.13, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 9.13, off: -7.6, w: 6.6, h: 3.6, d: 6.6, tone: 1, sol: 1 },   // 9.13 大块
  { t: 9.57, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 9.79, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 10.02, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 10.23, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 10.67, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 10.67, off: +8.2, w: 6.6, h: 3.6, d: 6.6, tone: 1, sol: 1 },  // 10.67 大块
  { t: 10.79, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 10.89, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 11.11, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 11.34, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 11.56, off: -4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
  { t: 11.78, off: +4.0, w: 2.6, h: 2.2, d: 2.6, tone: 1, sol: 1 },
];

const abs = path.resolve(ROOT, LEVEL);
const level = JSON.parse(fs.readFileSync(abs, "utf8"));
const before = level.place.length;

level.place = level.place.filter((it) => !(it.t >= T0 && it.t < T1));
const removed = before - level.place.length;

const added = HAND.map((it, k) => ({
  t: it.t, off: it.off, w: it.w, h: it.h, d: it.d,
  tone: it.tone != null ? it.tone : 1,
  rot: 0, rise: false, exact: 1,
  anim: "breath", phase: +(((k * 0.137) % 1).toFixed(3)),
  hand: 1,
  ...(it.sol ? { sol: 1 } : {}),
}));

level.place.push(...added);
level.place.sort((a, b) => a.t - b.t || a.off - b.off);

console.log("窗口 [" + T0 + ", " + T1 + ") 秒：删掉原布景 " + removed + " 件，手工摆上 " + added.length + " 件");
console.log("  现在 place[] = " + level.place.length + " 件，其中 sol=1 " + level.place.filter((x) => x.sol).length);
if (!APPLY) { console.log("  （--dry：未写回）"); process.exit(0); }

fs.mkdirSync(path.join(ROOT, "out", "bak"), { recursive: true });
const bak = path.join(ROOT, "out", "bak", "level-hand-" + Date.now() + ".json");
fs.copyFileSync(abs, bak);
fs.writeFileSync(abs, JSON.stringify(level, null, 2) + "\n");
console.log("  已写回 " + LEVEL + "（备份 " + path.relative(ROOT, bak) + "）");

/* 复核：用引擎自己的 buildPlaced 读我摆的件到底落在世界的哪里 */
const mod = await import(pathToFileURL(path.join(ROOT, "src", "js", "props.js")).href);
const built = mod.buildPlaced(level, null);
const solidByIdx = new Map((built.solids || []).map((s) => [s.pi, s]));
console.log("  手工件的世界落位（引擎 buildPlaced 复核，前 8 件）：");
let shown = 0;
for (let i = 0; i < level.place.length && shown < 8; i++) {
  const it = level.place[i];
  if (!it.hand) continue;
  const s = solidByIdx.get(i);
  console.log("    place[" + i + "] t=" + it.t + " off=" + it.off + " → 世界(" +
    (s ? s.x.toFixed(2) + ", " + s.z.toFixed(2) : "?") + ")  判定半宽 " + (s ? s.hw.toFixed(2) : "?"));
  shown++;
}
