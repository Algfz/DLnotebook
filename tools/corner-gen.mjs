/* corner-gen.mjs —— 按"玩家只需要判断在哪转"来摆判定物
 *
 * 原则（发起人 2026-10-14 定，AGENT.md ADR-32）：
 *   障碍物的职责是**在需要判断的位置**让玩家看得出"往哪走、什么时候点"；
 *   长直段可以没有障碍物（玩家在那里只有"继续"，没有决策）。
 *   假墙（贴着路边却没有意义的装饰件）比没有还糟——它会教玩家错误的规则。
 *
 * 本工具做两件事：
 *   ① 假墙清场：平原段 1.4 < |off| < 4.0 的散件推到 4.6~6.0m 外并 `sol:0`（纯景物）
 *   ② 每个 >ANGLE° 的折点，在**外侧**放一件看得见的判定物（`sol:1`）= "这里转"的读数点
 *
 * "外侧"怎么定：内角平分线的**反向**（`-(u+w)`，u=入边单位向量、w=出边单位向量）——
 * 这个定义不依赖坐标系手性，比叉积符号稳。
 * ⚠️ 引擎把 `(t, off)` 变成世界坐标用的是 ±30m **基线法线**（ADR-30），和局部腿法线最多差 45°，
 *    所以 off 的正负不能靠几何推：这里**先用 + 写一份、交给引擎 build 一次、量每个标记件的真实世界
 *    位置，再按外法线分量翻正负、重建复核**（两次 build，全部用引擎几何）。
 *
 * 用法：
 *   node tools/corner-gen.mjs "levels/ring a bell-灰澈" --dry      # 预览
 *   node tools/corner-gen.mjs "levels/ring a bell-灰澈" --apply    # 写回（自动备份）
 *   --angle 30 折点阈值 | --merge 6 合并窗口(米) | --off 4.2 平原外侧距离
 *   --bridge-off 7.2 桥段外侧距离（桥面半宽 5.3m） | --plain 46 平原段结束秒
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith("--")) { a._.push(s); continue; }
    const eq = s.indexOf("=");
    if (eq >= 0) a[s.slice(2, eq)] = s.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) a[s.slice(2)] = argv[++i];
    else a[s.slice(2)] = true;
  }
  return a;
}
const A = parseArgs(process.argv.slice(2));
const DIR = A._[0] || A.level;
if (!DIR) { console.error("用法：node tools/corner-gen.mjs <关卡目录> [--apply|--dry]"); process.exit(2); }
const ANGLE = parseFloat(A.angle) || 30;
const MERGE = parseFloat(A.merge) || 6;
const OFF = parseFloat(A.off) || 4.2;
const BRIDGE_OFF = parseFloat(A["bridge-off"]) || 7.2;
const PLAIN = A.plain != null ? parseFloat(A.plain) : 46;
const DUR = A.dur != null ? parseFloat(A.dur) : 174.667;
const DRY = !!A.dry || !A.apply;

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20261014);
const R = (a, b) => a + (b - a) * rnd();

(async () => {
  const { buildVerts, linesOf } = await import("../src/js/level.js");
  const { buildPlaced } = await import("../src/js/props.js");
  const file = path.join(DIR, "level.json");
  const level = JSON.parse(fs.readFileSync(file, "utf8"));
  const verts = buildVerts(level, DUR, linesOf(level)[0]);

  /* ---- 折点 + 外侧（内角平分线反向） ---- */
  const raw = [];
  for (let i = 1; i < verts.length - 1; i++) {
    const a = verts[i - 1], c = verts[i], b = verts[i + 1];
    const ux = c.x - a.x, uz = c.z - a.z, wx = b.x - c.x, wz = b.z - c.z;
    const l1 = Math.hypot(ux, uz), l2 = Math.hypot(wx, wz);
    if (l1 < 0.5 || l2 < 0.5) continue;
    const dot = (ux * wx + uz * wz) / (l1 * l2);
    const ang = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    if (ang < ANGLE) continue;
    let bx = -(ux / l1 + wx / l2), bz = -(uz / l1 + wz / l2);
    const bl = Math.hypot(bx, bz) || 1;
    raw.push({ t: c.t, cx: c.x, cz: c.z, ang, sx: bx / bl, sz: bz / bl });
  }
  const corners = [];
  for (const c of raw) {
    const last = corners[corners.length - 1];
    if (last && c.t - last.t < MERGE / 14) { if (c.ang > last.ang) corners[corners.length - 1] = c; continue; }
    corners.push(c);
  }

  /* ---- ① 假墙清场 ---- */
  let pushed = 0;
  for (const it of level.place) {
    if (it.t > PLAIN) continue;
    const o = Math.abs(it.off || 0);
    if (o > 1.4 && o < 4.0) { it.off = +(Math.sign(it.off || 1) * R(4.6, 6.0)).toFixed(2); it.sol = 0; pushed++; }
    else if (o <= 1.4) it.sol = 0;
  }

  /* ---- ② 折点外侧的读数点 ---- */
  const geo = corners.map((c) => ({ cx: c.cx, cz: c.cz, sx: c.sx, sz: c.sz }));
  const marks = corners.map((c) => ({
    t: +c.t.toFixed(3),
    off: +((c.t > PLAIN ? BRIDGE_OFF : OFF) + R(-0.4, 0.6)).toFixed(2),
    w: +R(2.6, 3.4).toFixed(2), h: +R(3.0, 4.5).toFixed(2), d: +R(2.6, 3.4).toFixed(2),
    tone: 1, rot: 0, rise: false, exact: true, sol: 1, g: 1, anim: "breath", phase: +rnd().toFixed(3),
  }));

  const basePlace = JSON.parse(JSON.stringify(level.place));
  const baseLen = basePlace.length;
  const withSign = (signs) => basePlace.concat(marks.map((m, i) => ({ ...m, off: +(Math.abs(m.off) * signs[i]).toFixed(2) })));
  const bestSolid = (lv) => {
    const pl = buildPlaced(lv, verts, { roadWidth: lv.roadWidth || 3 });
    const map = new Map();
    for (const s of pl.solids || []) map.set(s.pi, s);
    return map;
  };

  let signs = marks.map(() => 1);
  level.place = withSign(signs);
  let solids = bestSolid(level);
  signs = marks.map((m, i) => {
    const s = solids.get(baseLen + i);
    if (!s) return 1;
    const g = geo[i];
    return ((s.x - g.cx) * g.sx + (s.z - g.cz) * g.sz) >= 0 ? 1 : -1;
  });
  level.place = withSign(signs);
  solids = bestSolid(level);
  let miss = 0, dmin = Infinity;
  marks.forEach((m, i) => {
    const s = solids.get(baseLen + i), g = geo[i];
    if (!s) { miss++; return; }
    const lat = (s.x - g.cx) * g.sx + (s.z - g.cz) * g.sz;
    const d = Math.hypot(s.x - g.cx, s.z - g.cz);
    if (lat < 1.0) miss++;
    if (d < dmin) dmin = d;
  });

  console.log("  折点(> " + ANGLE + "°) " + raw.length + " 个 → 合并为 " + marks.length + " 个读数点");
  console.log("  假墙清场：推远并改成纯景物 " + pushed + " 件");
  console.log("  读数点：引擎复验（翻正负后）外侧落位失败 " + miss + " 件；最近一件离折点 " + dmin.toFixed(2) + " m");
  console.log("  仍在 2.6m 内的判定物：" + level.place.filter((it) => it.t < PLAIN && it.sol && Math.abs(it.off) < 2.6).length + " 件（应为 0）");
  if (DRY) { console.log("  （--dry 预览，未写回）"); return; }

  const bak = path.join("out", "bak", "level-corner-" + Date.now() + ".json");
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.copyFileSync(file, bak);
  fs.writeFileSync(file, JSON.stringify(level, null, 2) + "\n");
  console.log("  已写回 " + file + "（place[] = " + level.place.length + " 件，备份 " + bak + "）");
})().catch((e) => { console.error(e); process.exit(1); });
