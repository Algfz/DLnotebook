/**
 * sketch-plan.json → level.json 的 place[]（俯视草图 → 游戏里的显式摆放）
 *
 * 发起人在 tools/SketchEditor.html 里手绘的草图（世界坐标 x/z）要变成关卡能渲染的东西：
 * 关卡的布景写成 `place[]`，每件是 **(t 时刻, off 横向偏移)**，由 src/js/props.js 的 buildPlaced()
 * 用「±30 m 长基线法线」换算回世界坐标。所以这里做的是**逆向**：
 *   草图方块 (x,z) → 找到离它最近的路上的点 → 反解出 t 与 off，并保持世界坐标不变。
 *
 * 换算规则严格照抄引擎（src/js/props.js buildPlaced / atArc）：
 *   · t 是**时刻（秒）**，不是距离；本关 speedMode="mps"、14 m/s，所以 t ≈ 弧长/14
 *   · 法线取 ±30 m 长基线方向（逐段法线会在 x/z 之间乱跳）
 *   · off 的 **正号 = 行进方向的右侧**
 *   · rotY 一律吸附到坐标轴：路沿 ±x 时 rot=π/2，沿 ±z 时 rot=0
 *     （这样 w 沿世界 x、d 沿世界 z，和草图里的矩形一模一样）
 *
 * 用法：
 *   node tools/sketch-to-place.mjs                  # 直接改 level.json（先备份到 out/bak/）
 *   node tools/sketch-to-place.mjs --dry            # 只出报告，不写文件
 *   node tools/sketch-to-place.mjs --dist 0.05      # 采样精度（米）
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const LEVEL_DIR = arg("--level", "ring a bell-灰澈");
const SKETCH = arg("--sketch", "sketch-plan.json");
const DRY = has("--dry");
const STEP = +arg("--dist", 0.05);

const levelFile = path.join(ROOT, "levels", LEVEL_DIR, "level.json");
const sketchFile = path.join(ROOT, "levels", LEVEL_DIR, SKETCH);
const level = JSON.parse(fs.readFileSync(levelFile, "utf8"));
const sketch = JSON.parse(fs.readFileSync(sketchFile, "utf8"));

const SPEED = (level.motion && level.motion.speedMps) || 14;
const SNAP = Math.PI / 2;
const BASE = 30;                                   // 与引擎一致的长基线
const snapYaw = (y) => Math.round(y / SNAP) * SNAP;

// ── 1) 建折线（顶点带 t，和引擎 buildVerts 的第一段一致：出生点 + path[]）─────
const spawn = (level.motion && level.motion.spawn) || { x: 0, y: 0, z: 0 };
const V = [{ x: spawn.x, z: spawn.z, t: 0 }];
for (const p of level.path) V.push({ x: p.pos[0], z: p.pos[2], t: p.t });

const seg = [];
let acc = 0;
for (let i = 1; i < V.length; i++) {
  const a = V[i - 1], b = V[i];
  const L = Math.hypot(b.x - a.x, b.z - a.z);
  if (L < 1e-6) continue;
  seg.push({ a, b, L, s0: acc });
  acc += L;
}
const TOTAL = acc;
const atArc = (s) => {
  s = Math.max(0, Math.min(TOTAL, s));
  let i = 0;
  while (i < seg.length - 1 && seg[i].s0 + seg[i].L < s) i++;
  const g = seg[i];
  const k = Math.max(0, Math.min(1, (s - g.s0) / g.L));
  const x = g.a.x + (g.b.x - g.a.x) * k, z = g.a.z + (g.b.z - g.a.z) * k;
  const t = g.a.t + (g.b.t - g.a.t) * k;            // 与 timeToArc 互为逆运算
  return { x, z, t, ux: (g.b.x - g.a.x) / g.L, uz: (g.b.z - g.a.z) / g.L };
};
// 长基线方向（引擎 dirAt）
const dirAt = (s) => {
  const a = atArc(Math.max(0, s - BASE)), b = atArc(Math.min(TOTAL, s + BASE));
  let dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
};
const nrmAt = (s) => { const d = dirAt(s); return { x: d.z, z: -d.x }; };   // 右法线

// 点到轴对齐矩形（中心 bx,bz 半宽 hw,hd）的距离（内部为 0）
const distRect = (px, pz, b) => {
  const dx = Math.max(Math.abs(px - b.x) - b.w / 2, 0);
  const dz = Math.max(Math.abs(pz - b.z) - b.d / 2, 0);
  return Math.hypot(dx, dz);
};
const distToPath = (px, pz, b) => {
  let m = Infinity;
  for (const g of seg) {
    const n = Math.max(2, Math.ceil(g.L / STEP));
    for (let k = 0; k <= n; k++) {
      m = Math.min(m, distRect(g.a.x + (g.b.x - g.a.x) * k / n, g.a.z + (g.b.z - g.a.z) * k / n, b));
      if (m === 0) return 0;
    }
  }
  return m;
};

// ── 2) 每件方块反解 (t, off) ────────────────────────────────────────────
const out = [];
let maxRes = 0, sumRes = 0, worst = null;
for (const b of sketch.blocks) {
  // 在整条路上找使「重建位置 ≈ 原位置」的弧长：残差 = 沿路方向的分量
  let bestS = 0, bestE = Infinity;
  const scan = (from, to, step) => {
    for (let s = from; s <= to; s += step) {
      const p = atArc(s), n = nrmAt(s);
      // 垂直分量（沿法线）允许任意大；残差只看沿路方向
      const d = dirAt(s);
      const e = Math.abs((b.x - p.x) * d.x + (b.z - p.z) * d.z);
      if (e < bestE) { bestE = e; bestS = s; }
    }
  };
  // 粗扫（每 0.5 m）+ 细扫（STEP）
  scan(0, TOTAL, 0.5);
  scan(Math.max(0, bestS - 0.6), Math.min(TOTAL, bestS + 0.6), STEP);

  const p = atArc(bestS), n = nrmAt(bestS);
  const off = (b.x - p.x) * n.x + (b.z - p.z) * n.z;
  const rx = p.x + n.x * off, rz = p.z + n.z * off;      // 引擎会摆到的世界坐标
  const res = Math.hypot(rx - b.x, rz - b.z);
  if (res > maxRes) { maxRes = res; worst = b; }
  sumRes += res;

  const d = dirAt(bestS);
  const alongX = Math.abs(d.x) > Math.abs(d.z);          // 路沿 ±x → 方块要转 90°
  out.push({
    t: +p.t.toFixed(3),
    off: +off.toFixed(3),
    w: +b.w.toFixed(2), h: +(b.h ?? 1).toFixed(2), d: +b.d.toFixed(2),
    rot: alongX ? +(Math.PI / 2).toFixed(6) : 0,
    tone: b.tone ?? 1,
    rise: false,                                        // 先不添加动画：一开始就立在那儿
    exact: true,                                        // 别被净空规则推走（位置是手绘的，原样落地）
  });
}

// ── 3) 检查 ────────────────────────────────────────────────────────────
out.sort((a, b) => a.t - b.t);
const tMax = out[out.length - 1].t;
const clearances = out.map((o) => {
  // 由 (t,off) 反算世界坐标（引擎那套），再算矩形到路的距离
  const s = o.t * SPEED;
  const p = atArc(s), n = nrmAt(s);
  return { o, c: (() => { // 用重建后的矩形算净空
    const d = dirAt(s);
    const cx = p.x + n.x * o.off, cz = p.z + n.z * o.off;
    // rot=π/2 时 w 沿世界 z、d 沿世界 x；rot=0 时 w 沿 x、d 沿 z
    const rect = Math.abs(Math.sin(o.rot)) > 0.5
      ? { x: cx, z: cz, w: o.d, d: o.w }
      : { x: cx, z: cz, w: o.w, d: o.d };
    return distToPath(cx, cz, rect);
  })() };
});
clearances.sort((a, b) => a.c - b.c);

const lineHalf = 0.5;                                   // 舞线宽 1 m
const collide = clearances.filter((x) => x.c < lineHalf);
const old = level.place || [];
const kept = old.filter((p) => p.t > tMax + 1e-6);
const dropped = old.length - kept.length;

// ── 4) 报告 ────────────────────────────────────────────────────────────
console.log(`草图 ${sketch.blocks.length} 件 → place[]（t 0 → ${tMax.toFixed(1)} s，占全程 ${(100 * tMax / (TOTAL / SPEED)).toFixed(1)}%）`);
console.log(`  位置还原残差：中位 ${(sumRes / out.length).toFixed(3)} m，最大 ${maxRes.toFixed(3)} m` + (maxRes > 0.35 ? "  ⚠️ 偏大" : "  ✓"));
console.log(`  净空（方块边缘→路径中心）：最小 ${clearances[0].c.toFixed(2)} m，中位 ${clearances[Math.floor(clearances.length / 2)].c.toFixed(2)} m`);
console.log(`  ${collide.length ? `⚠️ ${collide.length} 件压到路上（< ${lineHalf} m）` : `✓ 没有一件压到路上（舞线半宽 ${lineHalf} m）`}`);
if (collide.length) for (const x of collide.slice(0, 6)) console.log(`     t=${x.o.t.toFixed(2)} off=${x.o.off.toFixed(2)} w=${x.o.w} d=${x.o.d} → ${x.c.toFixed(2)} m`);
console.log(`  替换：删掉 t ≤ ${tMax.toFixed(1)} s 的旧摆件 ${dropped} 件（原 ${old.length} 件），保留 ${kept.length} 件`);
console.log(`  尺寸：w/d ${Math.min(...out.map(o => Math.min(o.w, o.d))).toFixed(1)}–${Math.max(...out.map(o => Math.max(o.w, o.d))).toFixed(1)} m，h=${[...new Set(out.map(o => o.h))].join("/")}`);

if (DRY) { console.log("\n--dry：没有写文件"); process.exit(0); }

// ── 5) 写回（先备份）───────────────────────────────────────────────────
const bakDir = path.join(ROOT, "out", "bak");
fs.mkdirSync(bakDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const bak = path.join(bakDir, `level-${LEVEL_DIR.replace(/\s+/g, "_")}-${stamp}.json`);
fs.copyFileSync(levelFile, bak);
level.place = kept.concat(out).sort((a, b) => a.t - b.t);
fs.writeFileSync(levelFile, JSON.stringify(level, null, 1));
console.log(`\n已写 ${path.relative(ROOT, levelFile)}：place[] ${level.place.length} 件（新 ${out.length} + 旧 ${kept.length}）`);
console.log(`备份 ${path.relative(ROOT, bak)}`);
