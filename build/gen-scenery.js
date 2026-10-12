#!/usr/bin/env node
/* =====================================================================
   gen-scenery.js —— 沿路线摆"布景"（纯几何块）

   为什么是这样摆，而不是随机撒一片？
   ------------------------------------------------------------------
   旧版是"沿路两侧随机撒方块"：三层用同一套随机参数、同一个颜色、
   全部轴对齐。结果三个毛病（都用 tools/shot.js 截图对比确认过）：
     ① 一眼是"占位方块"—— 512 块同色同朝向，没有任何轮廓变化；
     ② 没有节奏 —— 块的位置和音乐、和路都没有关系，只是噪声；
     ③ 没有纵深 —— 三层同色 + 雾的起雾距离(70m)比布景最远距离(55m)还大，
        等于视野里一点雾都没有，远处只"变小"不"变淡"，画面糊成一片。

   这一版按"每层各有一个明确职责"来摆，并且**严格沿着真实路线走**：
     近景 layer=0  贴路两侧的立柱。固定步长的疏密循环 + 长周期起伏
                    → 产生速度感/长廊感（这是 DL 最核心的观感）
     中景 layer=1  离路 14~40m 的体块/矮楼，错落，撑开中间层次
     远景 layer=2  离路 55~120m 的宽板剪影，只露出一截轮廓 → 天际线

   ⚠️ 一个必须知道的坑：dance-line.json 里的 **samples 不是路线本身**。
   它是每 5m 采一个点，但只记了坐标和朝向 —— 路线是"楼梯形"的
   （长直段 + 90° 转角），采样点之间的直线会把转角切掉。所以
   "在 samples 上按切线偏移"算出来的位置会**跑到路面上**（实测偏 1~2m）。
   摆放必须走 dance-line.json 的 **points**（真实折线）：
   buildLine() 沿折线建一张"弧长 → 位置/切向"表，之后统一按弧长取值。
   samples 只用来把"弧长"映射回"时间"，好让疏密跟着音乐能量走。

   两条硬约束（都是踩过坑总结的，别改）：
     · **相对相机的高度**：相机大约在「路面 + 21m」处（跟客户端的
       CAM_OFF.y 一致）。近景、中景的块顶必须**低于**相机，只有远景
       允许越过视平线。第一版没管这条，楼顶全冲过视平线，天空被糊死、
       整个画面变成一堵灰紫色的墙。
     · **净空**：任何块离路线中心都要有富余，保证不挡路、不碰线。
       判据是"底面矩形（含旋转）到折线的最近距离"，不是拿半径估 ——
       半径估会把贴路的细立柱全部否掉，又会漏掉大块楼伸出来的角。

   颜色不写进关卡数据：每个块只带一个 fade（0=出生点 … 1=最远），
   真正的颜色由客户端的主题表（THEME 的 scenNear/scenMid/scenFar）决定。
   这样"外观由客户端决定、关卡只描述位置"的分工不被破坏（见 ADR-2）。

   用法:
     node build/gen-scenery.js [--level "ring a bell"] [--seed 1]
                               [--density 1] [--clear 4] [--dry]
   --level 缺省时取 levels/ 下 level.json 修改时间最新的那个（旧行为）
   --dry   只算不写，用来先看数量是否合适

   已知局限：**双线关卡只沿线 A 布景**（dance-line.json 的 points 就是线 A）。
   线 B 那侧不会有一列贴身立柱。立柱主要是给"速度感"用的，单侧也有，
   所以先接受这个局限；真要对称，得先把两条线的折线都读进来各摆一遍。
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes('--' + n);

const SEED    = parseInt(arg('seed', '1'), 10);
const DENSITY = parseFloat(arg('density', '1'));     // 密度倍率（>1 更密）
const CLEAR   = parseFloat(arg('clear', '4'));       // 距路线的最小净空
const DRY     = has('dry');

/* ---------------------- 可复现随机 ---------------------- */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------- 定位关卡目录 ---------------------- */
const lvRoot = 'levels';
const dirs = fs.readdirSync(lvRoot)
  .map(d => path.join(lvRoot, d))
  .filter(d => fs.statSync(d).isDirectory() && fs.readdirSync(d).includes('level.json'));
dirs.sort((a, b) => fs.statSync(path.join(b, 'level.json')).mtimeMs
               - fs.statSync(path.join(a, 'level.json')).mtimeMs);

const want = arg('level', null);
let dir = null;
if (want) {
  const key = String(want).toLowerCase();
  dir = dirs.find(d => {
    const base = path.basename(d).toLowerCase();
    let lv = null;
    try { lv = JSON.parse(fs.readFileSync(path.join(d, 'level.json'), 'utf8')); } catch (e) {}
    const title = (lv?.meta?.title || '').toLowerCase();
    return base.includes(key) || title.includes(key);
  }) || null;
  if (!dir) {
    console.error('找不到匹配 --level "' + want + '" 的关卡。现有：\n  ' +
      dirs.map(path.basename).join('\n  '));
    process.exit(1);
  }
} else {
  dir = dirs[0];
  console.log('（没给 --level，按"最近改过的关卡"选了：' + path.basename(dir) + '）');
}

const lvPath = path.join(dir, 'level.json');
const dlPath = path.join(dir, 'dance-line.json');

function readJson(p) {
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.warn('跳过无法解析的 ' + p + '：' + e.message); return null; }
}
const lv = readJson(lvPath);
const dl = readJson(dlPath);
if (!lv || !dl) {
  console.error('缺少 level.json 或 dance-line.json（先跑 build/gen-path.js --level）');
  process.exit(1);
}

const SPAWN_Y = lv.motion?.spawn?.y ?? 12;            // 路面高度
const ROAD_W  = lv.roadWidth != null ? lv.roadWidth : 3;

/* 音乐能量（让疏密跟着音乐走）：
   注意 music-analysis 的 segments 是**等分整首歌**的固定格数（11 格、每格
   约 34.6s），不是跟着段落走的。所以这里只用它做"缓的浓淡起伏"，
   真正的节奏来自固定步长 —— 两者叠加，密的地方也不会失去节拍。 */
const an = readJson(path.join(dir, 'music-analysis.json'));
const segs = an?.segments || null;
let eMin = 1e9, eMax = -1e9;
if (segs) for (const s of segs) { eMin = Math.min(eMin, s.energy); eMax = Math.max(eMax, s.energy); }
function normE(t) {
  if (!segs?.length) return 0.5;                 // 没有分析数据：按中等密度
  for (const s of segs) if (t >= s.t[0] && t < s.t[1])
    return (s.energy - eMin) / (eMax - eMin + 1e-9);
  const last = segs[segs.length - 1];
  return (last.energy - eMin) / (eMax - eMin + 1e-9);
}

/* ---------------------- 把真实路线做成"弧长表" ---------------------- */
const P = dl.points;                                  // 真实折线（683 个点，含 90° 转角）
if (!P || P.length < 2) {
  console.error('dance-line.json 里没有 points，无法沿路布景（重跑 build/gen-path.js）');
  process.exit(1);
}
const SEGS = [];                                      // { ax, az, bx, bz, dirx, dirz, len, s0 }
let TOTAL = 0;
for (let i = 0; i + 1 < P.length; i++) {
  const a = P[i], b = P[i + 1];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) continue;
  SEGS.push({ a, b, dirx: dx / len, dirz: dz / len, len, s0: TOTAL });
  TOTAL += len;
}
// 按弧长取位置 / 切向 / 路面高度
function lineAt(s) {
  const c = Math.max(0, Math.min(TOTAL, s));
  let i = 0;
  // 段数不多（几百），线性扫描够了；二分是没必要的过早优化
  while (i + 1 < SEGS.length && c > SEGS[i].s0 + SEGS[i].len) i++;
  const g = SEGS[i];
  const u = Math.max(0, Math.min(1, (c - g.s0) / g.len));
  return {
    x: g.a.x + (g.b.x - g.a.x) * u,
    z: g.a.z + (g.b.z - g.a.z) * u,
    y: (g.a.y ?? SPAWN_Y) + ((g.b.y ?? SPAWN_Y) - (g.a.y ?? SPAWN_Y)) * u,
    dirx: g.dirx, dirz: g.dirz,
  };
}
// 弧长 → 时间（用 samples 的 d/t 做线性插值，samples 是每 5m 一个，够用）
const SM = dl.samples || [];
function timeAtArc(s) {
  if (!SM.length) return 0;
  if (s <= SM[0].d) return SM[0].t;
  for (let i = 1; i < SM.length; i++) {
    if (s <= SM[i].d) {
      const a = SM[i - 1], b = SM[i];
      const k = (s - a.d) / Math.max(1e-9, b.d - a.d);
      return a.t + (b.t - a.t) * k;
    }
  }
  return SM[SM.length - 1].t;
}

/* ---------------------- 点/矩形 → 路线的最短距离 ---------------------- */
function distToSeg(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const L2 = dx * dx + dz * dz;
  if (L2 < 1e-9) return Math.hypot(x - a.x, z - a.z);
  let u = ((x - a.x) * dx + (z - a.z) * dz) / L2;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u));
}
/* 点 → 折线的最短距离。cap = 这个点到折线的距离上界（只用来加速）。
   ⚠️ cap 绝不能给小：给小了会把最近的线段提前剪掉，函数返回 Infinity，
   位置就会被当成"压在路上"而全部否掉（第一版就是这样悄悄干掉了多半立柱，
   最后只放出 241 个）。所以内部再乘一个安全系数。 */
function distToPath(x, z, cap) {
  const lim = (cap == null ? 200 : cap * 1.5) + 2;
  let best = Infinity;
  for (const g of SEGS) {
    if (Math.abs(g.a.x - x) > lim && Math.abs(g.b.x - x) > lim) continue;
    if (Math.abs(g.a.z - z) > lim && Math.abs(g.b.z - z) > lim) continue;
    const d = distToSeg(x, z, g.a, g.b);
    if (d < best) best = d;
    if (best <= 0.01) break;
  }
  return best;
}
/* 块底面矩形（含绕 Y 旋转）→ 折线的最短距离：这是"挡不挡路"的准确判据。
   取 4 个角 + 4 条边中点共 8 个探测点求最小（只测四角会漏掉细长楼的边）。 */
function rectDistXZ(x, z, w, d, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const hw = w / 2, hd = d / 2;
  const cap = Math.hypot(hw, hd);
  let best = Infinity;
  for (const [sx, sz] of [
    [hw, hd], [hw, -hd], [-hw, hd], [-hw, -hd],
    [hw, 0], [-hw, 0], [0, hd], [0, -hd],
  ]) {
    const px = x + sx * c + sz * s;
    const pz = z - sx * s + sz * c;
    const dd = distToPath(px, pz, cap);
    if (dd < best) best = dd;
    if (best <= 0.01) break;
  }
  return best;
}

/* ---------------------- 关键高度常量 ---------------------- */
const CAM_Y   = SPAWN_Y + 21;                     // 相机高度（= 客户端 CAM_OFF.y）
const CAP_NEAR = SPAWN_Y + 6;                     // 近景最高顶
const CAP_MID  = SPAWN_Y + 5;                     // 中景最高顶
const CAP_FAR  = CAM_Y + 5;                       // 远景最高顶（允许略微越线）
const FADE_SPAN = 900;                            // fade 走满 0→1 的距离（米）
/* 「光海」平面的高度：高架关卡在桥面下很远的地方放了大片发光平面
   （客户端 buildBridge：y = -deckY*5），它是"下面是光不是地"的关键。
   布的景绝对不能戳出这层平面 —— 一旦戳出去，就会在光海上露出一截
   方块的底面，像一堆柱子插在水里。所以把它当摆放的下界。 */
const SEA_Y = lv.bridge && lv.bridge.deckY > 0 ? -lv.bridge.deckY * 5 : -Infinity;

/* ---------------------- 摆放 ---------------------- */
const rand = rng(SEED);
const items = [];
const placed = [];                                // { x, z, w, d, r, layer }
const rndInt = n => Math.floor(rand() * n);

function push(layer, x, yb, z, w, h, d, angY, arc) {
  // fade：0 = 出生点附近，1 = 最远。按**沿路里程**算（不是世界距离），
  // 因为路线是楼梯形的，世界距离和"走了多远"差很多。
  const fade = Math.min(1, Math.pow(Math.min(1, arc / FADE_SPAN), 0.55));
  items.push({
    pos: [+x.toFixed(2), +(yb + h / 2).toFixed(2), +z.toFixed(2)],
    scale: [+w.toFixed(2), +h.toFixed(2), +d.toFixed(2)],
    angY: +angY.toFixed(4),
    layer, fade: +fade.toFixed(3),
  });
  placed.push({ x, z, w, d, r: Math.hypot(w, d) / 2, layer });
}

function clearOK(x, z, w, d, ang, minClear) {
  const need = minClear != null ? minClear : CLEAR;
  if (rectDistXZ(x, z, w, d, ang || 0) < need) return false;
  // 块与块之间也要留缝：用轴对齐包围盒的最小间距判。
  // 这里偏保守（旋转过的块按更大的包围盒算），宁可少放几块，
  // 也不要出现两块互相插进去的破面。
  const GAP = 0.6;
  for (const q of placed) {
    if (Math.abs(x - q.x) < (w + q.w) / 2 + GAP &&
        Math.abs(z - q.z) < (d + q.d) / 2 + GAP) return false;
  }
  return true;
}

/* ---- 近景：沿真实路线每 SLOT 米放一对贴路立柱 ---- */
const SLOT = Math.max(1.2, 2.5 / DENSITY);        // 立柱间距（米）
const CLEAR_NEAR = Math.min(CLEAR, ROAD_W / 2 + 0.8);   // 立柱可以贴路，只需不压路面
let s = SLOT / 2;
while (s < TOTAL) {
  const g = lineAt(s);
  const e = normE(timeAtArc(s));
  const pBoost = 0.45 + e * 0.65;                 // 高能量段更密（0.45~1.1）
  const beat = Math.round(s / SLOT);
  let rhythm = (beat % 4 === 3) ? 1.35 : (beat % 4 === 1 ? 1.1 : 0.62);
  rhythm *= 0.72 + 0.75 * (0.5 + 0.5 * Math.sin(beat / 9));       // 长周期起伏
  // 右法线（把切向绕 Y 转 -90°）
  const nx = g.dirz, nz = -g.dirx;
  for (const side of [1, -1]) {
    if (rand() > 0.84 * Math.min(1.2, pBoost)) continue;          // 留缺口，别成死墙
    const w = 0.55 + rndInt(3) * 0.16;
    const d = w * (1.0 + rndInt(3) * 0.7);
    const ang = (beat * 7 % 5 - 2) * 5 * Math.PI / 180;           // ±5°，打破轴对齐
    /* 离路中心的距离必须"因块而异"：矩形躺得越斜、越大，伸出去的角越长。
       拿一个固定值去试，细立柱能过、粗立柱就只剩一条缝，最后只剩几十个。
       所以先按自己的尺寸反算需要多远。
       reach = 旋转之后底面离自身中心最远的那个角。矩形（半宽 hw、半深 hd）
       绕 Y 转 ang 后，角的 (x,z) 偏移是 (cos·sx + sin·sz, -sin·sx + cos·sz)，
       四个角的距离极值就是 hypot(hw·cos+hd·sin, hw·sin+hd·cos)——它的
       平方是 hw²+hd²+4·hw·hd·sin·cos，所以只要看 sin·cos 的符号：
       ang 在 (0°,90°) 里取正，否则取零（零就等于外接圆半径）。 */
    const rc = Math.cos(ang), rs = Math.sin(ang);
    const cross = rc * rs > 0 ? 4 * (w / 2) * (d / 2) * rc * rs : 0;
    const reach = Math.sqrt((w / 2) ** 2 + (d / 2) ** 2 + cross);
    const allow = CLEAR_NEAR + reach + 0.05;
    const off = allow + rand() * 0.35;
    const px = g.x + nx * off * side, pz = g.z + nz * off * side;
    // 摆放阶段按"中心到路线的实测距离"判，比拿外接圆估准得多，也不会误杀
    if (distToPath(px, pz, off) < allow) continue;
    const h = Math.max(1.2, Math.min(3.0 + rhythm * 2.2, CAP_NEAR - g.y));
    push(0, px, g.y, pz, w, h, d, ang, s);
  }
  s += SLOT;
}

/* ---- 中景 / 远景：按站点（每 8m）成对放 ---- */
const STATION = Math.max(3, 8 / DENSITY);
for (let sc = STATION; sc < TOTAL; sc += STATION) {
  const g = lineAt(sc);
  const e = normE(timeAtArc(sc));
  const pBoost = 0.45 + e * 0.65;
  const nx = g.dirz, nz = -g.dirx;

  // 中景：体块 / 矮楼，离路 18~52m。
  // 注意别摆得太近、太大 —— 摆近了就是几个巨方块怼在镜头前，
  // 会把路面这个主角挤掉（第一版就是这样）。中景的职责是"撑开中间
  // 那一层"，它应该是背景不是前景。
  if (rand() < 0.75 * pBoost) {
    for (const side of [1, -1]) {
      if (rand() < 0.25) continue;
      const off = 18 + rand() * 34;
      const yb = SPAWN_Y - 12 + rand() * 5;        // 楼底压到路面以下，像从雾里长出来
      const w = 2.5 + rand() * 7, d = 2.5 + rand() * 7;
      const px = g.x + nx * off * side, pz = g.z + nz * off * side;
      const h = Math.max(1, Math.min(3 + rand() * 9, CAP_MID - yb));
      if (!clearOK(px, pz, w, d, 0)) continue;
      push(1, px, yb, pz, w, h, d, 0, sc);
    }
  }

  // 远景：宽板剪影，离路 70~150m；楼底不能戳出「光海」。
  // 高度用 pow(rand,1.8) 分布：大多数是矮矮的一条"城市带"，
  // 偶尔冒出一两座高塔 —— 天际线要有高低差，一排齐平的高墙最假。
  if (rand() < 0.6 * pBoost) {
    for (const side of [1, -1]) {
      if (rand() < 0.4) continue;
      const off = 70 + rand() * 80;
      const yb = Math.max(SEA_Y + 1, SPAWN_Y - 34 - rand() * 18);
      const w = 20 + rand() * 36, d = 16 + rand() * 30;
      const px = g.x + nx * off * side, pz = g.z + nz * off * side;
      const h = Math.max(1, Math.min(10 + Math.pow(rand(), 1.8) * 30, CAP_FAR - yb));
      if (!clearOK(px, pz, w, d, 0)) continue;
      push(2, px, yb, pz, w, h, d, 0, sc);
    }
  }
}

/* ---------------------- 自检：布景离路线够远吗 ----------------------
   "不挡路"是硬约束（块压到路面或者挡住引导线，玩家会莫名其妙死）。
   摆放时已经查过一次，但立柱是带旋转、又是按弧长内插的，所以在**写完
   之前**再独立算一遍：每个块的底面矩形（含旋转）到路线的最近距离，
   取全局最小值报出来。这个数必须 ≥ 路面半宽 + 线半宽，否则不要交付。 */
let minClear = Infinity, minItem = null;
for (const it of items) {
  const dd = rectDistXZ(it.pos[0], it.pos[2], it.scale[0], it.scale[2], it.angY);
  if (dd < minClear) { minClear = dd; minItem = it; }
}
const SAFE = ROAD_W / 2 + 0.5;                    // 路面半宽 + 线半宽(1m)/2
const clearOKAll = minClear >= SAFE;

/* ---------------------- 写回 ---------------------- */
const byLayer = [0, 0, 0];
for (const it of items) byLayer[it.layer]++;

if (DRY) {
  console.log('--dry：没有写文件。');
} else {
  lv.scenery = {
    v: 2,                       // 2 = 带 layer/fade 的分层格式（客户端按此分层渲染）
    seed: SEED,
    density: DENSITY,
    count: items.length,
    items,
  };
  fs.writeFileSync(lvPath, JSON.stringify(lv, null, 2), 'utf8');
}

console.log(`
================================================
布景生成（分层 + 沿真实路线走）
================================================
关卡:   ${lvPath}${DRY ? '   [只算不写]' : ''}
种子:   ${SEED}   密度: ${DENSITY}
路线:   ${TOTAL.toFixed(0)}m（真实折线 ${SEGS.length} 段；samples 只用来查时间）

景物:   ${items.length} 块
  近景  ${byLayer[0]} 块   贴路立柱，每 ${SLOT.toFixed(2)}m 一对，4 步一循环
  中景  ${byLayer[1]} 块   离路 18~52m，楼顶不过视平线
  远景  ${byLayer[2]} 块   离路 70~150m，宽板剪影当天际线

高度:   相机约在路面 +21m；近/中景顶 ≤ ${(CAP_NEAR - SPAWN_Y).toFixed(0)}/${(CAP_MID - SPAWN_Y).toFixed(0)}m（低于相机）
净空:   自检最小离路 ${minClear.toFixed(2)}m（要求 ≥ ${SAFE.toFixed(2)}m）${clearOKAll ? ' ✅' : ' ❌ 有块压到路了！'}
颜色:   不写进关卡 —— 每块只带 fade（0~1），颜色由客户端主题表决定
`);
if (!clearOKAll) {
  console.error('❌ 自检没通过：最近的一块离路只有 ' + minClear.toFixed(2) +
    'm（需要 ≥ ' + SAFE.toFixed(2) + 'm）。这块是 ' + JSON.stringify(minItem));
  process.exit(2);
}
