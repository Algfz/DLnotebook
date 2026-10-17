// 给关卡撒"路边方石"判定体（v9 石板原用）
// 用法：node tools/obstacle-gen.mjs "levels/ring a bell-灰澈" [--step 2] [--apply]
//   --step N   每 N 个折点摆一件（默认 2）
//   --apply    真写回 level.json（默认只报数）；写回前备份到 out/bak/
// 约定：偏移 1.45~1.75m（压进街沿但不进线）、0.7~1.05m 见方、0.55~1.25m 高，
//       sol:1 参与判定、exact:1 关掉引擎的净空外推。改完必须跑 tools/solid-check.mjs 复核。
import fs from "node:fs";
import path from "node:path";

const A = process.argv.slice(2);
const dir = A.find((s) => !s.startsWith("--"));
const kStep = A.indexOf("--step");
const step = kStep >= 0 && A[kStep + 1] ? +A[kStep + 1] : 2;
const apply = A.includes("--apply");
if (!dir) { console.error("用法：node tools/obstacle-gen.mjs \"levels/<关卡>\" [--step 2] [--apply]"); process.exit(1); }

const LF = path.join(dir, "level.json");
const L = JSON.parse(fs.readFileSync(LF, "utf8"));
const P = L.path || [];
if (!P.length) { console.error("level.json 里没有 path[]"); process.exit(1); }
const hs = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

const out = [];
for (let i = 1; i < P.length - 2; i += Math.max(1, step)) {
  const t = P[i].t || 0;
  if (t < 6 || t > 171) continue;                       // 开头/结尾留白
  if (hs(i) < 0.20) continue;                           // 约 1/5 跳过，留呼吸
  const side = P[i].turn === "R" ? 1 : -1;
  const off = side * (1.45 + hs(i + 7) * 0.3);
  const w = 0.7 + hs(i + 13) * 0.35;
  const d = 0.7 + hs(i + 19) * 0.35;
  const h = 0.55 + hs(i + 23) * 0.7;
  out.push({ t: +t.toFixed(3), off: +off.toFixed(3), w: +w.toFixed(2), d: +d.toFixed(2),
             h: +h.toFixed(2), clr: 0, tone: i % 3, sol: 1, exact: 1 });
}
console.log("折点", P.length, "→ 路障", out.length, apply ? "（写回）" : "（只报数，加 --apply 写回）");
if (apply) {
  const bak = path.join("out", "bak", `level-${Date.now()}-pre-obstacles.json`);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.writeFileSync(bak, JSON.stringify(L, null, 2) + "\n", "utf8");
  L.place = out;
  fs.writeFileSync(LF, JSON.stringify(L, null, 2) + "\n", "utf8");
  console.log("备份", bak);
}
