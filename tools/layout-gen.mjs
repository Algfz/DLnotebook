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
// 矩形到路径中心线的最小距离（按网格取样，够用）
function distToPathR(cx, cz, w, d) {
  let m = Infinity;
  const sx = Math.max(0.3, w / 6), sz = Math.max(0.3, d / 6);
  for (let dx = -w / 2; dx <= w / 2 + 1e-6; dx += sx)
    for (let dz = -d / 2; dz <= d / 2 + 1e-6; dz += sz)
      m = Math.min(m, distToPath(cx + dx, cz + dz));
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
const CLEAR_MIN = 0.75;          // 方块边缘到路径中心的最小净空（发起人草图实测 0.70）

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
    const offS = Math.round(off / 0.5) * 0.5;
    const sS = Math.round(s / 0.25) * 0.25;
    const spot = tryPlace(sS, growCands(offS === 0 ? 2.0 : offS), w, d)
              || tryPlace(sS, growCands(offS >= 0 ? -2.0 : 2.0), w, d);
    if (!spot) { stat.dropped++; continue; }
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
  // 近排：贴着路线两侧、压得很低（发起人：方便看路），**隔一腿一件**（不是每腿都塞，否则成串珠）→ 踩音弹出
  if (vi % 2 === 0) {
    const wN = [3.0, 4.5, 3.0, 6.0][vi % 4];
    const sg = vi % 4 === 2 ? -1 : 1;
    add(tryPlace(s, growCands(sg * 2.5, 0.5, 10), wN, wN), wN, H_NEAR, "pop", {});
  } else if (vi % 6 === 3) {                              // 偶尔两侧都来一件，节奏上有个顿点
    const wN = 3.0;
    add(tryPlace(s, growCands(-2.5, 0.5, 10), wN, wN), wN, H_NEAR, "pop", {});
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
const cl = out.map((o) => { const p = ptAt(arcOfT(o.t), o.off); return { ...o, x: p.x, z: p.z }; });
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

/* ── 4) 俯视预览图（给发起人看设计，不写进关卡）────────────────────────── */
{
  const xs = cl.map((o) => o.x), zs = cl.map((o) => o.z);
  const x0 = Math.min(...xs) - 20, x1 = Math.max(...xs) + 20, z0 = Math.min(...zs) - 20, z1 = Math.max(...zs) + 20;
  const S = Math.min(2000 / (x1 - x0), 2000 / (z1 - z0));
  const X = (x) => ((x - x0) * S).toFixed(1), Y = (z) => ((z1 - z) * S).toFixed(1);
  const paths = V.map((p) => `${X(p.x)},${Y(p.z)}`).join(" ");
  const W = Math.round((x1 - x0) * S), H = Math.round((z1 - z0) * S);
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="100%" height="100%" fill="#faf8f2"/>`];
  for (const o of cl) {
    const c = o.anim === "pop" ? "#c8552f" : (o.h > 1.6 ? "#2f3d63" : "#7d8aa8");
    svg.push(`<rect x="${(+X(o.x - o.w / 2)).toFixed(1)}" y="${(+Y(o.z + o.d / 2)).toFixed(1)}" width="${(o.w * S).toFixed(1)}" height="${(o.d * S).toFixed(1)}" fill="${c}" opacity="0.85"/>`);
  }
  svg.push(`<polyline points="${paths}" fill="none" stroke="#1d2740" stroke-width="1.6"/>`);
  svg.push(`</svg>`);
  fs.writeFileSync(path.join(ROOT, "out", "layout-gen-preview.svg"), svg.join("\n"));
  console.log(`  预览：out/layout-gen-preview.svg（红＝踩音弹出、深蓝＝立起来、浅蓝＝呼吸）`);
}

/* ── 5) 写回 ──────────────────────────────────────────────────────────── */
if (APPLY) {
  const bak = path.join(ROOT, "out", "bak", `level-${LEVEL_DIR.replace(/[^\w\u4e00-\u9fa5]+/g, "_")}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.writeFileSync(bak, JSON.stringify(level, null, 2));
  const keep = (level.place || []).filter((p) => !p.g && p.t > 29.9 && p.t < 46 && (p.h || 1) > 1.6);   // 保留"不是本工具生成的"老摆件（带 g:1 的都是上一轮产物，重跑时丢掉，免得越跑越多）
  level.place = out.concat(keep);
  fs.writeFileSync(path.join(dir, "level.json"), JSON.stringify(level, null, 2));
  console.log(`  已写回 level.json：place[] = ${out.length} 新 + ${keep.length} 保留（备份 ${path.relative(ROOT, bak)}）`);
} else {
  console.log(`  （未写盘；加 --apply 才写回）`);
}
