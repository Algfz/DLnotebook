/* ---------------------------------------------------------------------------
   布景布局生成器：把"发起人手绘的开头样板"延伸成整关的 place[]

   用法：
     node tools/layout-gen.mjs                 # 只算不写，打印统计 + 净空报告 + 预览图
     node tools/layout-gen.mjs --apply         # 写回 levels/<关卡>/level.json（先备份）
     node tools/layout-gen.mjs --level "..."   # 指定关卡目录

   它做三件事：
     1) **整理**发起人手绘的前段（sketch-plan.json，t ≤ 29.7s）：
        方块尺寸吸附到统一模数、位置在 (弧长, 横向 off) 里对齐、紧邻路线的高度压到 0.5m。
     2) **续画**后段（t > 29.7s）：照同一种语言沿路铺"近排 / 中排 / 远排"三层，
        近排低（方便看路）、② 段（<46s）立起来、桥段照铺。
     3) **配动画**：近排＝踩音弹出（pop，绑到最近的拍），中远排＝错落呼吸（breath）。
        相位全部由下标哈希决定 —— 同一份输入每次生成结果完全一致。

   ⚠️ 生成结果会**逐条写进 level.json 的 place[]**（不是运行时随机）——
     文件里仍然是"每一件都显式写出来"，符合 ADR-16。
   ⚠️ 别用 PowerShell 改这个文件（含中文注释），用编辑工具。
   --------------------------------------------------------------------------- */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

const LEVEL_DIR = arg("--level", "ring a bell-灰澈");
const APPLY = has("--apply");
const dir = path.join(ROOT, "levels", LEVEL_DIR);
const level = JSON.parse(fs.readFileSync(path.join(dir, "level.json"), "utf8"));
const beats = (JSON.parse(fs.readFileSync(path.join(dir, LEVEL_DIR + ".beat.json"), "utf8")).beats || []);
let sketch = null;
try { sketch = JSON.parse(fs.readFileSync(path.join(dir, "sketch-plan.json"), "utf8")); } catch { }

const BASE = 30, SNAP = Math.PI / 2, LEGM = 3.418;
const snapYaw = (y) => Math.round(y / SNAP) * SNAP;
const spawn = (level.motion && level.motion.spawn) || { x: 0, y: 12, z: 0 };

// ── 路径（和引擎一样：先补一个出生点，再逐点累积弧长）─────────────────────
const V = [{ x: spawn.x, z: spawn.z, t: 0, y: spawn.y }];
for (const p of level.path) V.push({ x: p.pos[0], y: p.pos[1], z: p.pos[2], t: p.t });
const seg = [];
let TOTAL = 0;
for (let i = 1; i < V.length; i++) {
  const a = V[i - 1], b = V[i];
  const L = Math.hypot(b.x - a.x, b.z - a.z);
  seg.push({ a, b, s0: TOTAL, L });
  TOTAL += L;
}
const atArc = (s) => {
  s = Math.max(0, Math.min(TOTAL, s));
  let i = 1; while (i < seg.length && seg[i].s0 + seg[i].L <= s) i++;
  const g = seg[Math.min(i, seg.length) - 1];
  const k = g.L > 1e-9 ? (s - g.s0) / g.L : 0;
  return { x: g.a.x + (g.b.x - g.a.x) * k, z: g.a.z + (g.b.z - g.a.z) * k,
           t: g.a.t + (g.b.t - g.a.t) * k, y: g.a.y + (g.b.y - g.a.y) * k };
};
const arcOfT = (t) => {
  for (const g of seg) if (t <= g.b.t) { const k = (t - g.a.t) / Math.max(1e-9, g.b.t - g.a.t); return g.s0 + g.L * k; }
  return TOTAL;
};
const dirAt = (s) => {
  const a = atArc(Math.max(0, s - BASE)), b = atArc(Math.min(TOTAL, s + BASE));
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
};
const nrmAt = (s) => { const d = dirAt(s); return { x: d.z, z: -d.x }; };   // 右法线
const ptAt = (s, off) => {
  const p = atArc(s), n = nrmAt(s), d = dirAt(s);
  return { x: p.x + n.x * off, z: p.z + n.z * off, t: p.t, yaw: snapYaw(Math.atan2(d.x, d.z)) };
};
const distToPath = (x, z) => {
  let m = Infinity;
  for (const g of seg) {
    const dx = g.b.x - g.a.x, dz = g.b.z - g.a.z, L2 = dx * dx + dz * dz || 1;
    let k = ((x - g.a.x) * dx + (z - g.a.z) * dz) / L2;
    k = Math.max(0, Math.min(1, k));
    const px = g.a.x + dx * k, pz = g.a.z + dz * k;
    const dd = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (dd < m) m = dd;
  }
  return Math.sqrt(m);
};
// ★ 矩形到路径的**精确**最小距离（轴对齐线段 vs 轴对齐矩形，O(1) 一段）。
//   之前用"在矩形里打网格取样"是错的：24m 的大方块按 w/6 取样，格距 3.5m，
//   而路是每 3.418m 折 90° 的腿 —— 一条腿正好能从采样格之间穿过去，
//   于是大块被判"安全"，实际压在轨迹上（发起人 2026-10-13 抓到的硬伤）。
function segRectDist(ax, az, bx, bz, cx, cz, w, d) {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  if (ax === bx) {                                    // 竖段（沿 z）
    if (ax >= x0 && ax <= x1 && Math.max(Math.min(az, bz), z0) <= Math.min(Math.max(az, bz), z1)) return 0;
  } else if (az === bz) {                             // 横段（沿 x）
    if (az >= z0 && az <= z1 && Math.max(Math.min(ax, bx), x0) <= Math.min(Math.max(ax, bx), x1)) return 0;
  } else {                                            // 一般段：Liang-Barsky 裁剪判交
    const dx = bx - ax, dz = bz - az;
    let t0 = 0, t1 = 1;
    const clip = (p, q) => {
      if (p === 0) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    if (clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dz, az - z0) && clip(dz, z1 - az) && t0 <= t1) return 0;
  }
  const px = (v) => Math.max(x0, Math.min(x1, v)), pz = (v) => Math.max(z0, Math.min(z1, v));
  const d2 = (x, z) => (x - px(x)) ** 2 + (z - pz(z)) ** 2;
  const seg2 = (x, z) => {                            // 点到线段
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    let k = ((x - ax) * dx + (z - az) * dz) / L2; k = Math.max(0, Math.min(1, k));
    return (x - (ax + dx * k)) ** 2 + (z - (az + dz * k)) ** 2;
  };
  let m = Math.min(d2(ax, az), d2(bx, bz));           // 端点 → 矩形
  for (const [cx2, cz2] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) m = Math.min(m, seg2(cx2, cz2));  // 四角 → 线段
  return Math.sqrt(m);
}
function distToPathR(cx, cz, w, d) {
  let m = Infinity;
  for (const g of seg) { const v = segRectDist(g.a.x, g.a.z, g.b.x, g.b.z, cx, cz, w, d); if (v < m) m = v; }
  return m;
}
// 世界点 → (s, off)：粗扫 + refine
function toArcOff(x, z) {
  let best = Infinity, bs = 0;
  for (let s = 0; s <= TOTAL; s += 0.5) {
    const p = atArc(s), d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < best) { best = d; bs = s; }
  }
  for (let s = Math.max(0, bs - 0.5); s <= Math.min(TOTAL, bs + 0.5); s += 0.02) {
    const p = atArc(s), d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < best) { best = d; bs = s; }
  }
  const p = atArc(bs), n = nrmAt(bs);
  return { s: bs, off: (x - p.x) * n.x + (z - p.z) * n.z };
}
const nearestBeat = (t) => {
  if (!beats.length) return null;
  let bi = 0, bd = Infinity;
  for (let i = 0; i < beats.length; i++) { const d = Math.abs(beats[i] - t); if (d < bd) { bd = d; bi = i; } }
  return beats[bi];
};
// 平均拍长（本曲 0.4518s ≈132.8 BPM，但真人弹奏有波动 —— 只用来定"反复弹"的周期）
const BEATPER = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : 0.4518;
// 下标哈希（稳定、不用 Math.random）
const hash = (n) => { let x = (n * 2654435761) >>> 0; x ^= x >>> 15; x = (x * 2246822519) >>> 0; x ^= x >>> 13; return (x >>> 0) / 4294967296; };

const MODULE = [1.2, 2.4, 3.0, 4.5, 6.0, 9.0, 12.0, 15.0, 18.0, 21.0];
const snapSize = (v) => MODULE.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), MODULE[0]);
const NEAR_OFF = 6.0;            // |off| 小于它 = "紧挨路线" → 压低 + 踩音弹出
const H_NEAR = 0.5;              // 紧邻路线的高度（发起人：低一点，方便看路）
const CLEAR_MIN = 0.85;          // 方块边缘到路径中心的净空下限：舞线半宽 0.5 ⇒ 留 0.35m 视觉余量
const TRAIL_HALF = 0.5;          // 舞线宽 1m ⇒ 半宽 0.5m：方块边缘离中心线必须 > 它，否则就是"压在轨迹上"
// 🧱 围墙：先把舞线两侧 ±WALL_OFF 的界限画出来（建的时候看得见），障碍物只许建在外面，建完围墙"拆掉"
//    （只是施工基准，不进关卡数据）。舞线半宽 0.5m ⇒ 墙设在 1.0m，中间 0.5m 是不许建的缓冲带。
const WALL_OFF = (() => { const a = process.argv.find((x) => x.startsWith("--wall=")); return a ? +a.split("=")[1] : 1.0; })();

const out = [];
const stat = { tidyFront: 0, dropped: 0, near: 0, mid: 0, far: 0, pop: 0, breath: 0 };

/* 在给定弧长处，从一串候选横向偏移里挑**第一个真能放下**的位置。
   为什么不能直接"按 off 摆"：这关的路是每 3.418m 折 90° 的阶梯 —— 沿一条腿的法线往外挪，
   反而可能贴到相邻那条**垂直**的腿上。所以判据一律用"整条路"的最小距离（矩形口径），
   放不下的候选直接跳过。发起人草图里那些贴着路的方块，其实都落在**阶梯的凹角（缺口）**里。 */
const LEGS = seg.map((g) => ({ s0: g.s0, s1: g.s0 + g.L, mid: g.s0 + g.L / 2 }));
const legOf = (s) => LEGS.find((l) => s >= l.s0 && s <= l.s1) || LEGS[LEGS.length - 1];
// 把弧长挪进"这一腿的安全窗"：转角附近法线会 90° 突变，方块与路的关系会跳，写进 JSON 就还原不回来
const safeArc = (s, m = 0.7) => { const l = legOf(s); const lo = l.s0 + m, hi = l.s1 - m; return hi <= lo ? l.mid : Math.max(lo, Math.min(hi, s)); };
function tryPlace(s, cands, w, d, minClear = CLEAR_MIN) {
  s = safeArc(s);
  const p = atArc(s), n = nrmAt(s);
  for (const off of cands) {
    // ★ 判据要落在**引擎真正会用的那个位置**上：place[] 只存 (t, off)（而且是四舍五入后的），
    //   引擎按 ptAt(arcOfT(t), off) 还原。在转角附近，弧长差几毫米就会让法线翻 90°，
    //   于是"验过的位置"和"游戏里的位置"能差一米多 —— 必须按**写进 JSON 的那两个数**来验。
    const tW = +p.t.toFixed(3), offW = +off.toFixed(2);
    const q = ptAt(arcOfT(tW), offW);
    const c = distToPathR(q.x, q.z, w, d);
    if (c >= minClear) return { off: offW, x: q.x, z: q.z, t: tW, clear: c, sPlace: s, sBack: arcOfT(tW) };
  }
  return null;
}
// 从"标称 off"开始、逐步加大，找到能放下的那一档
function growCands(off, step = 0.5, tries = 26) {
  const c = [];
  for (let g = 0; g < tries; g++) c.push(Math.sign(off) * (Math.abs(off) + g * step));
  return c;
}

/* ── 1) 前段：整理发起人的手绘草图 ─────────────────────────────────────── */
if (sketch) {
  for (const b of sketch.blocks) {
    const { s, off } = toArcOff(b.x, b.z);
    // 尺寸吸附模数（近方形就保方，长方形分别吸附）
    let w = snapSize(b.w), d = snapSize(b.d);
    if (Math.abs(b.w - b.d) <= 0.35) { const m = snapSize((b.w + b.d) / 2); w = m; d = m; }
    // ★ 只在 (弧长 s, 横向 off) 这套"路的坐标"里对齐：
    //   off 吸到 0.5m、s 吸到 0.25m —— 同一条腿旁边的方块就落在与路平行的直线上（阶梯上就是整齐的行列）。
    //   不能去吸世界 x/z 网格：那样方块会沿路方向平移，(t, off) 表达不出来，摆回去会挪位甚至压线。
    // ★ 前段**不挪你的方块**（2026-10-13 的教训：把作者摆的东西"对齐"到别处 = 改了设计）。
    //   位置（弧长、横向 off）原样保留；只有**真的会压到 1m 舞线**（净空 < 0.56m）的那几件，
    //   才沿法线往外挪最小量（每次 0.25m）。尺寸吸附统一模数、近路的压低、加 pop/breath 照旧。
    const tUse = +atArc(s).t.toFixed(3);
    let offUse = +off.toFixed(2), clrF = 0, okF = false;
    for (let g = 0; g <= 40 && !okF; g++) {
      const o2 = g === 0 ? offUse : (Math.sign(offUse) || 1) * (Math.abs(offUse) + g * 0.25);
      const q = ptAt(arcOfT(tUse), +o2.toFixed(2));
      clrF = distToPathR(q.x, q.z, w, d);
      if (clrF >= CLEAR_MIN) { offUse = +o2.toFixed(2); okF = true; }
    }
    if (!okF) { stat.dropped++; continue; }
    const spot = { t: tUse, off: offUse, clear: clrF };
    const near = Math.abs(spot.off) < NEAR_OFF;
    const h = near ? H_NEAR : (b.h == null ? 1 : b.h);
    const beat = near ? nearestBeat(spot.t) : null;
    out.push({ t: +spot.t.toFixed(3), off: +spot.off.toFixed(2), w, h, d, tone: b.tone == null ? 1 : b.tone,
               rot: 0, rise: false, exact: true, clr: +spot.clear.toFixed(3), g: 1,
               anim: near ? "pop" : "breath",
               ...(near ? { beat: +beat.toFixed(3), beatPeriod: +BEATPER.toFixed(4), every: 1 + (out.length % 3) }
                      : { phase: +hash(out.length).toFixed(3) }) });
    stat.tidyFront++; near ? stat.pop++ : stat.breath++;
  }
}

/* ── 2) 后段：照同一种语言续画 ─────────────────────────────────────────── */
const T0 = sketch ? Math.max(...sketch.blocks.map((b) => toArcOff(b.x, b.z).s)) : 0;
const S0 = T0 + LEGM;
let vi = 0;
for (let s = S0; s < TOTAL; s += LEGM, vi++) {
  const p = atArc(s), d = dirAt(s);
  const t = p.t;
  const rising = t < 46;                                   // ② 立起来：这批要高
  const add = (spot, w, h, kind, extra) => {
    if (!spot) { stat.dropped++; return; }
    const near = Math.abs(spot.off) < NEAR_OFF;
    const it = { t: +spot.t.toFixed(3), off: +spot.off.toFixed(2), w, h, d: w, clr: +spot.clear.toFixed(3), g: 1,
                 tone: extra.tone == null ? (vi % 2 ? 0 : 2) : extra.tone, rot: 0, rise: false, exact: true };
    if (kind === "pop") {
      const b = nearestBeat(spot.t);
      it.anim = "pop"; it.beat = +((b == null ? spot.t : b)).toFixed(3);
      it.beatPeriod = +BEATPER.toFixed(4); it.every = 1 + (vi % 3);       // 每 1/2/3 拍弹一下 → 错落，不是整排一起跳
      stat.pop++;
    }
    else { it.anim = "breath"; it.phase = +hash(vi * 7 + Math.round(spot.off * 10)).toFixed(3);
           it.amp = extra.amp; it.period = extra.period; stat.breath++; }
    stat[near ? "near" : (Math.abs(spot.off) < 16 ? "mid" : "far")]++;
    out.push(it);
  };
  // 近排：**两侧连续密排的护栏**（发起人 2026-10-13：
  //   "紧贴路线两侧的那些方块非常重要的作用就是让玩家知道哪些地方是路线……
  //     如果路线两侧没有排列足够多的方块那游戏就没难度了"）——
  //   所以每一腿、左右都放；净空就是发起人草图实测的那个量级（0.7m 上下），矮（0.5m）不挡视线，踩拍弹出。
  {
    const wN = vi % 3 === 0 ? 3.0 : 2.4;
    add(tryPlace(s, growCands(wN / 2 + CLEAR_MIN, 0.5, 10), wN, wN), wN, H_NEAR, "pop", {});
    const wN2 = vi % 4 === 1 ? 3.0 : 2.4;
    add(tryPlace(s + 0.9, growCands(-(wN2 / 2 + CLEAR_MIN), 0.5, 10), wN2, wN2), wN2, H_NEAR, "pop", {});
  }
  // 中排：每一腿一对（同一侧挨着放，成"簇"），② 段立起来，其余矮矮地呼吸
  {
    const side = vi % 2 === 0 ? 1 : -1;
    const base = [9, 11, 13][vi % 3];
    const hM = rising ? (3 + (vi % 3) * 1.6) : (1.0 + (vi % 2) * 0.4);
    const w1 = 3.0 + (vi % 3) * 1.5;
    add(tryPlace(s, growCands(side * base, 0.5, 16), w1, w1), w1, hM, "breath", { amp: 0.5, period: 3.0 });
    if (vi % 3 !== 2) {
      const w2 = 3.0 + ((vi + 1) % 3) * 1.5;
      add(tryPlace(s, growCands(side * (base + w1 / 2 + w2 / 2 + 0.6), 0.5, 16), w2, w2), w2,
          rising ? hM * 0.7 : 1.0 + ((vi + 1) % 2) * 0.4, "breath", { amp: 0.5, period: 3.4 });
    }
  }
  // 远排：隔一腿一次、铺得开（20–55m），平段矮、② 段也立起来，起伏最慢
  if (vi % 2 === 0) {
    const k = vi / 2 | 0;
    const far = [20, 28, 38, 55][k % 4];
    const w = 9 + (k % 3) * 4.5;
    const hF = rising ? 5 + (k % 3) * 2 : 1.4 + (k % 3) * 0.6;
    add(tryPlace(s, growCands(k % 8 < 4 ? far : -far, 0.5, 24), w, w), w, hF, "breath", { amp: 0.9, period: 4.4 });
    if (k % 3 === 0) {                                    // 远处再来一件小的，破掉"一条线"的感觉
      const w2 = 6 + (k % 2) * 3;
      add(tryPlace(s, growCands((k % 8 < 4 ? 1 : -1) * (far + w / 2 + w2 / 2 + 1.2), 0.5, 24), w2, w2), w2,
          rising ? 4 + (k % 2) * 2 : 1.2 + (k % 2) * 0.4, "breath", { amp: 0.9, period: 4.4 });
    }
  }
}

/* ── 3) 报告（位置一律按引擎口径 ptAt(arcOfT(t), off) 反算）────────────── */
let cl = out.map((o) => { const p = ptAt(arcOfT(o.t), o.off); return { ...o, x: p.x, z: p.z }; });
const arcOfS = new Map(out.map((o) => [o, o.sPlace == null ? arcOfT(o.t) : o.sPlace]));
let minC = Infinity, bad = 0;
for (const o of cl) { const c = distToPathR(o.x, o.z, o.w, o.d); o._clear = c; if (c < minC) minC = c; if (c < CLEAR_MIN - 1e-6) bad++; }
console.log(`关卡 ${LEVEL_DIR}`);
console.log(`  路径 ${V.length - 1} 段 / ${TOTAL.toFixed(1)} m / 末点 t=${V[V.length - 1].t.toFixed(1)}s`);
console.log(`  生成 ${out.length} 件：整理前段 ${stat.tidyFront} + 续画后段 ${out.length - stat.tidyFront}（放不下丢掉 ${stat.dropped}）`);
console.log(`  动画：踩音弹出 ${cl.filter((o) => o.anim === "pop").length} 件 / 呼吸起伏 ${cl.filter((o) => o.anim === "breath").length} 件`);
console.log(`  净空：最小 ${minC.toFixed(2)} m，低于 ${CLEAR_MIN} m 的 ${bad} 件`);
if (bad) {                                    // 把最贴路的几件点名，方便收
  const worst = cl.filter((o) => o._clear < CLEAR_MIN).sort((a, b) => a._clear - b._clear).slice(0, 6);
  for (const o of worst) console.log(`     ⚠ ${o._clear.toFixed(2)}m（落位 ${o.clr == null ? "?" : o.clr.toFixed(2)}m / s=${o.sPlace == null ? "?" : o.sPlace.toFixed(2)}→${arcOfT(o.t).toFixed(2)}）idx=${out.indexOf(o)} t=${o.t.toFixed(3)} off=${o.off} w=${o.w} d=${o.d} ${o.anim}`);
}
// 自检：s → t → s 的往返误差（place[] 只存 (t,off)，往返一偏，方块在游戏里就不在验过的位置上）
{
  let m = 0, wi = -1;
  cl.forEach((o, i) => { const e = Math.abs(arcOfT(o.t) - arcOfS.get(o)); if (e > m) { m = e; wi = i; } });
  console.log(`  往返自检：s→t→s 最大误差 ${m.toFixed(2)} m${m > 0.05 ? `（第 ${wi} 件 t=${cl[wi].t.toFixed(1)}）` : ""}`);
}
console.log(`  高过 1.6m 的 ${cl.filter((o) => o.h > 1.6).length} 件（"立起来"的那批）`);
const bySec = {};
for (const o of cl) { const k = o.t < 29.7 ? "① 平原" : (o.t < 46 ? "② 立起来" : "③ 桥"); bySec[k] = (bySec[k] || 0) + 1; }
console.log(`  分段：${Object.entries(bySec).map(([k, v]) => k + " " + v + " 件").join(" | ")}`);

/* ── 4) 俯视预览图（给发起人看设计，不写进关卡）──────────────────────────
   放在**围墙审计之后**调用：图上要能看到白带（舞线）、两侧红虚线（围墙）和每一块的落点，
   越墙的块画成纯红——目标是 0 个红块（发起人的做法：建墙 → 只在外侧建 → 拆墙）。 */
function emitPreview() {
  cl = out.map((o) => { const p = ptAt(arcOfT(o.t), o.off); return { ...o, x: p.x, z: p.z }; });
  const xs = cl.map((o) => o.x), zs = cl.map((o) => o.z);
  const x0 = Math.min(...xs) - 20, x1 = Math.max(...xs) + 20, z0 = Math.min(...zs) - 20, z1 = Math.max(...zs) + 20;
  const S = Math.min(2000 / (x1 - x0), 2000 / (z1 - z0));
  const X = (x) => ((x - x0) * S).toFixed(1), Y = (z) => ((z1 - z) * S).toFixed(1);
  const paths = V.map((p) => `${X(p.x)},${Y(p.z)}`).join(" ");
  const W = Math.round((x1 - x0) * S), H = Math.round((z1 - z0) * S);
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="100%" height="100%" fill="#faf8f2"/>`];
  // ① 舞线轨迹带（1m 宽）② 两侧围墙（±WALL_OFF）—— 建的时候要看得见，建完就"拆掉"（不进关卡数据）
  // ① 先铺"禁区"（±WALL_OFF 的红带＝施工时的围墙以内）② 再铺舞线白带 ③ 中心线
  svg.push(`<polyline points="${paths}" fill="none" stroke="#f0a49a" stroke-width="${(2 * WALL_OFF * S).toFixed(1)}" stroke-linejoin="miter" opacity="0.75"/>`);
  svg.push(`<polyline points="${paths}" fill="none" stroke="#ffffff" stroke-width="${(1.0 * S).toFixed(1)}" stroke-linejoin="miter"/>`);
  svg.push(`<polyline points="${paths}" fill="none" stroke="#c9cfe0" stroke-width="${(1.0 * S).toFixed(1)}" stroke-linejoin="miter" opacity="0.35"/>`);
  svg.push(`<polyline points="${paths}" fill="none" stroke="#1d2740" stroke-width="1.2" stroke-dasharray="6 4" stroke-linejoin="miter"/>`);
  let breach = 0;
  for (const o of cl) {
    const q = ptAt(arcOfT(o.t), o.off);
    const inner = distToPathR(q.x, q.z, o.w, o.d) < WALL_OFF - 1e-6;   // 越墙？
    if (inner) breach++;
    const c = inner ? "#ff0000" : (o.anim === "pop" ? "#e08a2e" : (o.h > 1.6 ? "#2f3d63" : "#7d8aa8"));
    svg.push(`<rect x="${(+X(o.x - o.w / 2)).toFixed(1)}" y="${(+Y(o.z + o.d / 2)).toFixed(1)}" width="${(o.w * S).toFixed(1)}" height="${(o.d * S).toFixed(1)}" fill="${c}" opacity="0.85"/>`);
  }
  svg.push(`</svg>`);
  fs.writeFileSync(path.join(ROOT, "out", "layout-gen-preview.svg"), svg.join("\n"));
  console.log(`  预览：out/layout-gen-preview.svg（白带＝舞线 1m、红虚线＝围墙 ±${WALL_OFF.toFixed(2)}m、`
            + `红块＝越墙 ${breach} 件；其余：红＝弹出、深蓝＝立起来、浅蓝＝呼吸）`);
}

/* ── 4b) 保留的老摆件也要过一遍"压轨迹"检查 ────────────────────────────────
   发起人 2026-10-13："整个关卡都出现了障碍物直接放在舞线轨迹上" ——
   我这轮生成的全部走 CLEAR_MIN（0.85m）自检，但**保留的老摆件**（浮空段那些"云朵"高柱，
   他明确说要）还是老数据，必须一起验；真压线的沿法线往外挪最小量（0.25m 一档），不删。 */
const keepOld = (level.place || []).filter((p) => !p.g && p.t > 29.9 && p.t < 46 && (p.h || 1) > 1.6);
{
  let badN = 0, movedN = 0;
  for (const p of keepOld) {
    const w = p.w || 1, d = p.d || 1, o0 = p.off || 0;
    const at = (o) => { const q = ptAt(arcOfT(p.t), o); return distToPathR(q.x, q.z, w, d); };
    if (at(o0) >= CLEAR_MIN) continue;
    badN++;
    let done = false;
    for (let g = 1; g <= 40 && !done; g++) {
      const o2 = +((Math.sign(o0) || 1) * (Math.abs(o0) + g * 0.25)).toFixed(2);
      if (at(o2) >= CLEAR_MIN) { p.off = o2; movedN++; done = true; }
    }
    if (!done) console.log(`      ⚠ 老摆件挪不开：t=${(+p.t).toFixed(1)} off=${o0} w=${w} d=${d}`);
  }
  console.log(`  ⚠ 保留的老摆件${keepOld.length} 件：压线 ${badN} 件 → 挪开 ${movedN} 件`);
}

/* ── 4c) **全关**连续护栏：每一腿、左右两侧都贴一块矮的（踩拍弹出）──────────
   2026-10-13 发起人看游戏截图："有些路段两侧空荡荡，舞线孤零零一条，看不出路在哪" ——
   护栏的作用是**读路**（撞障碍死、掉非路面死、掉虚空死），所以它必须**从头到尾连续**，
   而且**不能把作者已经放好的方块挤掉/堆叠**：某处 3m 内已有方块就跳过那一个位置。 */
let fenceN = 0;
{
  const occ = [];
  // 只把**贴路的**已有方块算作"占位"（|off| < 8m），而且半径按最小 1.8m 算 ——
  // 否则远处那些 20m 的大块会把整段护栏全跳过，路两侧又空了。
  for (const o of out) if (Math.abs(o.off) < 8) { const q = ptAt(arcOfT(o.t), o.off); occ.push({ x: q.x, z: q.z, r: Math.min(Math.max(o.w, o.d) / 2, 1.8) }); }
  if (sketch) for (const b of sketch.blocks) {
    const { off } = toArcOff(b.x, b.z);
    if (Math.abs(off) < 8) occ.push({ x: b.x, z: b.z, r: Math.min(Math.max(b.w, b.d) / 2, 1.8) });
  }
  const tooClose = (x, z, gap) => occ.some((o) => Math.hypot(o.x - x, o.z - z) < o.r + gap);
  let k = 0;
  for (let s = 1.8; s < TOTAL - 1.8; s += LEGM, k++) {
    const ss = s + (k % 2 ? 0.9 : 0);
    for (const sgn of [1, -1]) {
      const w = (k + (sgn > 0 ? 0 : 1)) % 3 === 0 ? 3.0 : 2.4;
      const spot = tryPlace(ss, growCands(sgn * (w / 2 + CLEAR_MIN), 0.4, 14), w, w);
      if (!spot) { stat.dropped++; continue; }
      if (tooClose(spot.x, spot.z, 0.3)) continue;          // 那儿已经有方块了，别堆
      const b = nearestBeat(spot.t);
      out.push({ t: +spot.t.toFixed(3), off: +spot.off.toFixed(2), w, h: H_NEAR, d: w, tone: k % 2,
                 rot: 0, rise: false, exact: true, clr: +spot.clear.toFixed(3), g: 1, fence: 1,
                 anim: "pop", beat: +(b == null ? spot.t : b).toFixed(3),
                 beatPeriod: +BEATPER.toFixed(4), every: 1 + (k % 3) });
      occ.push({ x: spot.x, z: spot.z, r: w / 2 });
      fenceN++; stat.pop++;
    }
  }
  console.log(`  全关护栏：新增 ${fenceN} 件（已有方块旁边跳过，不含在"续画"统计里）`);
}

/* ── 4d-0) 高度分带：越靠路越矮（发起人 2026-10-13："紧挨路线两边的方块高度调低一点，方便看路"）
   他看游戏截图时说"还是各种遮挡"—— 问题不是压线，是**高块离路太近**：一堵 7m 的墙摆在 9m 外，
   前方的路就全被挡住了。规则：|off| < 6m → 0.5m；< 16m → ≤1.4m；< 26m → ≤3.0m；更远随便立。 */
const hCap = (off) => { const a = Math.abs(off); return a < 6 ? 0.5 : a < 16 ? 1.4 : a < 26 ? 3.0 : 9.0; };
let capped = 0;
for (const o of out) { const c = hCap(o.off); if (o.h > c) { o.h = c; o.capped = 1; capped++; } }
console.log(`  📏 高度分带：${capped} 件被压低（近路矮、远端才让"立起来"）`);

/* ── 4d) "围墙"审计（发起人 2026-10-13 的做法：
       ① 先把舞线两侧的界限画出来当围墙 ② 障碍物只许建在围墙外 ③ 再把围墙拆掉）──────
   WALL_OFF = 围墙离路径中心的距离（常量声明在文件顶部，见 CLEAR_MIN 旁边）。 */
let wallBad = 0, wallMoved = 0, wallDrop = 0;
{
  const audit = (o) => {                     // o 必须是 out / keepOld 里的**本体**（不是副本）
    const at = (off) => { const q = ptAt(arcOfT(o.t), off); return distToPathR(q.x, q.z, o.w, o.d); };
    if (at(o.off) >= WALL_OFF) return true;
    wallBad++;
    const k = Math.sign(o.off) || 1;
    for (let g = 1; g <= 60; g++) {
      const o2 = +(k * (Math.abs(o.off) + g * 0.25)).toFixed(2);
      if (at(o2) >= WALL_OFF) { o.off = o2; o.wallMoved = 1; wallMoved++; return true; }
    }
    return false;
  };
  const keeps = [];
  for (const o of out) if (!audit(o)) { wallDrop++; } else keeps.push(o);
  for (const p of keepOld) audit(p);          // 保留的老摆件：只挪不删（发起人要的"云朵"）
  out.length = 0; out.push(...keeps);
  console.log(`  🧱 围墙审计（墙在 ±${WALL_OFF.toFixed(2)}m）：越墙 ${wallBad} 件 → 挪到墙外 ${wallMoved} 件`
            + `，删掉实在放不下的 ${wallDrop} 件`);
}
emitPreview();     // 审计之后再画：图上红块应当为 0

/* ── 5) 写回 ──────────────────────────────────────────────────────────── */
if (APPLY) {
  const bak = path.join(ROOT, "out", "bak", `level-${LEVEL_DIR.replace(/[^\w\u4e00-\u9fa5]+/g, "_")}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.writeFileSync(bak, JSON.stringify(level, null, 2));
  const keep = keepOld;   // 保留"不是本工具生成的"老摆件（带 g:1 的是上一轮产物，重跑时丢掉，免得越跑越多）
  level.place = out.concat(keep);
  fs.writeFileSync(path.join(dir, "level.json"), JSON.stringify(level, null, 2));
  console.log(`  已写回 level.json：place[] = ${out.length} 新 + ${keep.length} 保留（备份 ${path.relative(ROOT, bak)}）`);
} else {
  console.log(`  （未写盘；加 --apply 才写回）`);
}
