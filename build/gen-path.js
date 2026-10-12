#!/usr/bin/env node
/* =====================================================================
   gen-path.js —— 从踩音 JSON 生成「理想舞线轨迹」

   输出纯几何数据（dance-line.json），供 Unity 直接读取、画线、布景。
   与引擎无关：只有坐标、时间和方向。

   形态：两方向交替转向（DL 经典的之字形），段长 = 相邻踩音间隔 × 线速。
   高度：平地（连续路面必须等高）。

   双轨：踩音 JSON 若有 tracks[]（线 A / 线 B），则**每一条线各生成一条路径**，
        俯视预览图并排显示两线。只有单轨（旧格式）时行为与以往完全一致。
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";

/* ---------------------- 参数 ---------------------- */
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const has = n => argv.includes("--" + n);

// 线速模型：
//   默认 —— 恒定米/秒（--mps）。DL 的线速应当是恒定的，不该随 BPM 变快。
//   旧式 —— 每拍多少米（--speed）。BPM 高的曲子会跑得飞快，仅在需要时用。
const SPEED_BEATS = arg("speed", null) ? parseFloat(arg("speed")) : null;
const MPS = arg("mps", null) ? parseFloat(arg("mps"))
          : (SPEED_BEATS == null ? 14 : null);       // 默认 14 m/s
const LINE_W      = parseFloat(arg("width", "1"));    // 线宽（发起人指定 1m）
const SAMPLE_D    = parseFloat(arg("sample", "5"));   // 沿路径采样间距（布景用）
const ELEVATE     = parseFloat(arg("elevate", "0"));  // 高架桥：桥面高度（0 = 贴地）
const PIER_EVERY  = parseFloat(arg("pier", "18"));    // 桥墩间距（米）
const SPLIT       = has("split");                     // 在崩塌处断开（瞬移）
const NO_SVG      = has("no-svg");
const WANT_LEVEL  = has("level");                     // 同时输出客户端可玩的 level.json
const THEME       = arg("theme", "pink");             // 关卡主题（不分场景）
const TITLE       = arg("title", "");                 // 关卡标题
const VIEW        = arg("view", null) ? arg("view").split(",").map(Number) : null; // 预览只画 [t0,t1] 秒
const OUT_NAME    = arg("out", "dance-line");         // 输出文件名前缀
const SVG_ONLY    = has("svg-only");                  // 只出预览图，不写 JSON / level
// 双线关卡：线 B 的起始位置平移若干个「最小转角间隔」。
// 「最小转角间隔」= 相邻转折点之间的最小距离（米），也就是最短段长。
// 符号按俯视预览的方向： +X = 向右、-X = 向左；+Z = 向下、-Z = 向上。
//   --b-x n   线 B 起始位置 X 方向平移 n 个间隔（正=右，负=左）
//   --b-z n   线 B 起始位置 Z 方向平移 n 个间隔（正=下，负=上）
//   --b-gap n 兼容旧写法 = 只设 --b-z（正数=向下）
// 默认 0 = 两条线都从原点出发。
const B_X = arg("b-x", null) != null ? parseFloat(arg("b-x")) : 0;
const B_Z = arg("b-z", null) != null ? parseFloat(arg("b-z"))
          : (arg("b-gap", null) != null ? parseFloat(arg("b-gap")) : 0);
//   --b-y n   线 B（及以后）相对线 A 的抬高（米，正 = 上方）
//             把两条线错成上下两层，两条路就不会在同一平面上糊在一起
const B_Y = arg("b-y", null) != null ? parseFloat(arg("b-y")) : 0;

/* ------------------------------------------------------------------
   幕分界与瞬移（可选）—— 默认整曲一幕，以下参数都从命令行给：
     --acts t1,t2,...     幕的时间分界（秒）。不给 = 不切幕
     --act-names a,b,...  各幕 id（个数 = --acts 个数 + 1），用于预览图着色
     --tp t               瞬移时刻（秒），配合 --split 使用
     --tp-offset x,z      瞬移后新场景的世界位移（默认 1500,0）
   ------------------------------------------------------------------ */
const ACTS = arg("acts", "") ? arg("acts").split(",").map(Number) : [];
const ACT_NAMES = arg("act-names", "")
  ? arg("act-names").split(",")
  : Array.from({ length: ACTS.length + 1 }, (_, i) => "act" + (i + 1));
while (ACT_NAMES.length < ACTS.length + 1) ACT_NAMES.push("act" + (ACT_NAMES.length + 1));
const TP_T = arg("tp", null) != null ? parseFloat(arg("tp")) : null;
const TP_OFF = arg("tp-offset", "") ? arg("tp-offset").split(",").map(Number) : [1500, 0];
const TP_OFFSET = { x: TP_OFF[0] || 0, z: TP_OFF[1] || 0 };
// --split 必须配 --tp（告诉脚本在哪一秒瞬移）；缺了就忽略，并提示
const SPLIT_ON = SPLIT && TP_T != null;
if (SPLIT && !SPLIT_ON) console.log("⚠️  --split 需要同时给 --tp <秒>，本次按「不瞬移」处理");

/* ---------------------- 几何 ---------------------- */
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];      // 0:+X 1:+Z 2:-X 3:-Z
const D0 = 0, D1 = 1;                                  // 只用这两个方向 → 之字形
const LINE_COLOR = ["#2e8b57", "#7b52c9"];             // 双线配色（线 A 绿 / 线 B 紫）

/* ---------------------- 输入 ---------------------- */
// levels/ 下可能有多首曲子：默认取**最近修改**的那个（刚归档/刚踩完的那首）
function findBeat() {
  const lv = "levels";
  if (!fs.existsSync(lv)) return null;
  const found = [];
  for (const d of fs.readdirSync(lv)) {
    const dir = path.join(lv, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".beat.json")) continue;
      const p = path.join(dir, f);
      found.push({ p, m: fs.statSync(p).mtimeMs });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.m - a.m);
  if (found.length > 1) {
    console.log("levels/ 下有多首曲子，取最近修改的：\n  " +
      found.map(x => x.p).join("\n  ") + "\n");
  }
  return found[0].p;
}
const inPath = argv.find(a => a.endsWith(".json")) || findBeat();
if (!inPath || !fs.existsSync(inPath)) {
  console.error("找不到 .beat.json（可直接把路径作为参数传入）");
  process.exit(1);
}
const src = JSON.parse(fs.readFileSync(inPath, "utf8"));
const DUR = src.audio?.duration || 0;
const marks = (src.marks || []).map(m => m.time).sort((a, b) => a - b);

function bpmAt(t) {
  const s = src.timing?.sections || [];
  if (!s.length) return 120;
  for (let i = s.length - 1; i >= 0; i--) if (t >= s[i].t) return s[i].bpm;
  return s[0].bpm;
}
const speedAt = t => (MPS != null ? MPS : SPEED_BEATS * bpmAt(t) / 60);   // m/s

/* ---------------------- 生成一条路径 ---------------------- */
// 给定一组转向时刻，还原「理想舞线轨迹」（起点在原点，先沿 +X）。
// 用的都是形参/局部量，所以可以安全地对多条线各调用一次。
function buildPath(marksIn, off) {
  const ox = (off && off.x) || 0, oz = (off && off.z) || 0;   // 该线的起始位置
  let pos = { x: ox, y: 0, z: oz };
  let dir = D0;
  const pts = [];                                      // 路径点（含转向信息）
  const teleports = [];
  let tpDone = false;

  // 推进到时间 t（途中若跨越瞬移点则跳到新场景）
  function advance(t, from) {
    const t0 = from;
    if (SPLIT_ON && !tpDone && t0 < TP_T && t >= TP_T) {
      const d1 = (TP_T - t0) * speedAt(t0);
      const p1 = { x: pos.x + DIRS[dir][0] * d1, z: pos.z + DIRS[dir][1] * d1 };
      const p2 = { x: p1.x + TP_OFFSET.x, z: p1.z + TP_OFFSET.z };
      teleports.push({
        t: TP_T, atPoint: pts.length,
        from: [+p1.x.toFixed(3), ELEVATE, +p1.z.toFixed(3)],
        to: [+p2.x.toFixed(3), ELEVATE, +p2.z.toFixed(3)],
      });
      tpDone = true;
      pos = p2;
      const d2 = (t - TP_T) * speedAt(TP_T);
      pos = { x: pos.x + DIRS[dir][0] * d2, z: pos.z + DIRS[dir][1] * d2 };
    } else {
      const d = (t - t0) * speedAt(t0);
      pos = { x: pos.x + DIRS[dir][0] * d, z: pos.z + DIRS[dir][1] * d };
    }
  }

  // 起点（高架时整条路都在 ELEVATE 高度——连续路面必须等高，所以是一个常量）
  pts.push({ t: 0, x: ox, y: ELEVATE, z: oz, turn: null, dir });

  marksIn.forEach((t, i) => {
    advance(t, i === 0 ? 0 : marksIn[i - 1]);
    // 交替转向（决定离开该点时的方向）
    const next = (dir === D0) ? D1 : D0;
    const turn = (next === D1) ? "R" : "L";
    dir = next;
    pts.push({ t: +t.toFixed(6), x: +pos.x.toFixed(3), y: ELEVATE, z: +pos.z.toFixed(3), turn, dir });
  });

  // 曲终：最后一段一直走到底
  advance(DUR, marksIn.length ? marksIn[marksIn.length - 1] : 0);
  pts.push({ t: +DUR.toFixed(6), x: +pos.x.toFixed(3), y: ELEVATE, z: +pos.z.toFixed(3), turn: null, dir });

  /* 段信息 */
  const segs = [];
  let totalLen = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    totalLen += len;
    segs.push({
      i, a: i, b: i + 1,
      t0: a.t, t1: b.t,
      len: +len.toFixed(3),
      dir: [Math.sign(dx), Math.sign(dz)],
      mid: [+(a.x + b.x) / 2, ELEVATE, +(a.z + b.z) / 2],   // 段中心（布景对位用）
    });
  }

  /* 包围盒 */
  const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
  const bounds = {
    min: [Math.min(...xs), ELEVATE, Math.min(...zs)],
    max: [Math.max(...xs), ELEVATE, Math.max(...zs)],
  };

  /* 沿路径等距采样（布景用） */
  const samples = [];
  if (SAMPLE_D > 0) {
    let acc = 0, nextD = 0;
    for (const s of segs) {
      const a = pts[s.a], b = pts[s.b];
      while (nextD <= acc + s.len) {
        const k = s.len > 0 ? (nextD - acc) / s.len : 0;
        samples.push({
          d: +nextD.toFixed(2),
          t: +(a.t + (b.t - a.t) * k).toFixed(3),
          x: +(a.x + (b.x - a.x) * k).toFixed(3), y: ELEVATE,
          z: +(a.z + (b.z - a.z) * k).toFixed(3),
          dir: s.dir,
        });
        nextD += SAMPLE_D;
      }
      acc += s.len;
    }
  }

  /* 质量检查 */
  const lens = segs.map(s => s.len);
  const minLen = lens.length ? Math.min(...lens) : 0;
  const { gap: minGapV, at: gapAt } = minGapOf(pts, segs);

  return {
    pts, teleports, segs, totalLen, bounds, samples, minLen, minGapV, gapAt,
    spawn: { x: ox, y: ELEVATE, z: oz, dir: D0 },
  };
}

// 最近的一对「平行且相邻」的路段（间距小于路宽就会看起来糊在一起）
function minGapOf(pts, segs) {
  let best = Infinity, at = null;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 2; j < segs.length; j++) {
      const A = pts[segs[i].a], B = pts[segs[i].b];
      const C = pts[segs[j].a], D = pts[segs[j].b];
      const g = segSegDist(A, B, C, D);
      if (g < best) { best = g; at = [i, j]; }
    }
  }
  return { gap: best, at };
}
function segSegDist(a, b, c, d) {
  const pt = (t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  let best = Infinity;
  for (let k = 0; k <= 10; k++) {
    const p = pt(k / 10);
    const dx = d.x - c.x, dz = d.z - c.z;
    const L2 = dx * dx + dz * dz || 1;
    let u = ((p.x - c.x) * dx + (p.z - c.z) * dz) / L2;
    u = Math.max(0, Math.min(1, u));
    const q = { x: c.x + dx * u, z: c.z + dz * u };
    best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z));
  }
  return best;
}

/* ---------------------- 逐条线生成 ---------------------- */
// 有 tracks[] 就每条线各生成一条；否则退化为单条（沿用旧的 marks）
const trackMarks = (Array.isArray(src.tracks) && src.tracks.length)
  ? src.tracks.map(t => (t.marks || []).map(m => m.time).sort((a, b) => a - b))
  : [marks];
const TWO_LINE = trackMarks.length > 1;
const lines = trackMarks.map((mk, i) => Object.assign(
  { id: (src.tracks && src.tracks[i] && src.tracks[i].id) || String.fromCharCode(65 + i), marks: mk },
  buildPath(mk),
));
// 双线：线 B（及以后）的起始位置平移若干个「最小转角间隔」（单位 = 最短段长）
//   X 方向：正=向右、负=向左；Z 方向：正=向下、负=向上（俯视预览坐标）
// 整条线连同出生点一起平移，几何保持自洽、形状不变。
let lineOffX = 0, lineOffZ = 0, gapUnitM = 0;
if (TWO_LINE && (B_X || B_Z)) {
  gapUnitM = Math.min(...lines.map(L => L.minLen));   // 参考：最短的转角间隔
  lineOffX = +(B_X * gapUnitM).toFixed(3);
  lineOffZ = +(B_Z * gapUnitM).toFixed(3);
  for (let i = 1; i < lines.length; i++) {
    const ox = lineOffX * i, oz = lineOffZ * i;
    lines[i] = Object.assign(
      { id: lines[i].id, marks: lines[i].marks, xOffset: ox, zOffset: oz },
      buildPath(lines[i].marks, { x: ox, z: oz }),
    );
  }
}
// 兼容：顶层沿用第一条线（线 A）的几何，旧读取方（含 Unity 脚本）不受影响
const { pts, teleports, segs, totalLen, bounds, samples, minLen, minGapV, gapAt } = lines[0];

/* ---------------------- 幕分段（分场景布景用） ---------------------- */
const actT = [0, ...ACTS, DUR];
// 用「第一个不早于边界的点」来切，并向前多带一个点，保证几何连续；
// 空档段（如崩塌段没有踩音点）也不会退化成 [0,0]
const scenes = ACT_NAMES.map((id, i) => {
  const t0 = actT[i], t1 = actT[i + 1];
  let i0 = pts.findIndex(p => p.t >= t0); if (i0 < 0) i0 = 0;
  let i1 = pts.findIndex(p => p.t >= t1); if (i1 < 0) i1 = pts.length - 1;
  const a = i === 0 ? 0 : Math.max(0, i0 - 1);
  const b = Math.min(pts.length - 1, i1);
  return { id, t: [+t0.toFixed(3), +t1.toFixed(3)], points: [a, b] };
}).filter(s => s.t[1] > s.t[0]);

/* ---------------------- 输出 JSON ---------------------- */
const out = {
  tool: "DanceLineGen",
  version: "1.0",
  source: path.basename(inPath),
  audio: { name: src.audio?.name || "", duration: +DUR.toFixed(4) },
  // 注意：不叫 params —— C# 里 params 是关键字，反序列化会踩坑
  config: {
    lineWidth: LINE_W,
    speedMode: MPS != null ? "mps" : "beats",
    speedBeats: SPEED_BEATS,
    speedMps: +speedAt(0).toFixed(3),
    flat: true,                       // 连续路面等高
    split: SPLIT_ON,
    elevate: ELEVATE,                 // 高架桥：桥面离地高度（0 = 贴地）
    pierEvery: PIER_EVERY,
    // 线 B 起始位置的平移（单位 = 最小转角间隔；X 正=右、Z 正=下）
    lineGap: {
      xUnits: B_X, zUnits: B_Z,
      xMeters: lineOffX, zMeters: lineOffZ,
      unitMeters: +gapUnitM.toFixed(4),
    },
  },
  bpm: +(bpmAt(0)).toFixed(3),
  spawn: { x: 0, y: 0, z: 0, dir: D0 },
  points: pts.map((p, i) => ({
    i, t: p.t, x: p.x, y: p.y, z: p.z, turn: p.turn, dir: p.dir,
  })),
  segments: segs,
  teleports,
  scenes,
  samples,
  stats: {
    totalLength: +totalLen.toFixed(1),
    pointCount: pts.length,
    turnCount: marks.length,
    minSegLen: +minLen.toFixed(3),
    minGap: +minGapV.toFixed(3),
    bounds,
  },
};
// 双轨：把每条线完整附上（顶层仍是线 A，向后兼容）
if (TWO_LINE) {
  out.lines = lines.map(L => ({
    id: L.id,
    turnCount: L.marks.length,
    points: L.pts.map((p, i) => ({
      i, t: p.t, x: p.x, y: p.y, z: p.z, turn: p.turn, dir: p.dir,
    })),
    segments: L.segs,
    teleports: L.teleports,
    stats: {
      totalLength: +L.totalLen.toFixed(1),
      pointCount: L.pts.length,
      turnCount: L.marks.length,
      minSegLen: +L.minLen.toFixed(3),
      minGap: +L.minGapV.toFixed(3),
      bounds: L.bounds,
    },
  }));
}

const outDir = path.dirname(inPath);
const outJsonPath = path.join(outDir, OUT_NAME + ".json");
const outSvgPath = path.join(outDir, OUT_NAME + ".svg");
if (!SVG_ONLY) fs.writeFileSync(outJsonPath, JSON.stringify(out, null, 2), "utf8");

/* ---------------------- 客户端关卡（level.json） ---------------------- */
// 单场景、平地、无跳跃/下落：整关一个主题色
// 双轨（beat.json 有两条 track）时同时写 lines[]：线 A + 线 B，各带颜色与按键。
if (WANT_LEVEL) {
  const name = (src.audio?.name || "").replace(/\.[^.]+$/, "");
  const lv = {
    format: "dlfan.level",
    version: "1.0",
    meta: { title: TITLE || name, subtitle: "" },
    music: src.audio?.name || "",
    latency_ms: src.latency_ms || 0,
    roadWidth: LINE_W,                       // 注意：这里复用 --width，即路面宽度
    timing: {
      offset: src.timing?.offset || 0,
      meter: src.timing?.meter || 4,
      sections: src.timing?.sections || [],
    },
    motion: {
      speedBeats: +(MPS != null ? MPS * 60 / bpmAt(0) : SPEED_BEATS).toFixed(5),
      speedMps: MPS,
      spawn: { x: 0, y: ELEVATE, z: 0, dir: D0 },
      gravity: 10,                           // 记档：本关无跳跃/下落，暂不启用
    },
    // 高架桥：桥面在 ELEVATE 高度，桥墩每隔 PIER_EVERY 米一根落到地面
    bridge: ELEVATE > 0
      ? { deckY: ELEVATE, pierEvery: PIER_EVERY, pierSize: Math.max(1.2, LINE_W * 0.45) }
      : null,
    path: pts.filter(p => p.turn)
             .map(p => ({ t: p.t, turn: p.turn, pos: [p.x, p.y, p.z] })),
    teleports: teleports,
    scenes: [{
      id: THEME, title: TITLE || name, t: [0, +DUR.toFixed(3)],
      height: 0,
      theme: THEME, enter: { type: "start" }, palette: THEME,
      decor: [],
      camera: [{ t: 0, mode: "follow", height: 8, dist: 14 }],
      fx: [],
    }],
  };
  // 双轨：把线 B（及以后的线）也写进 level.json 的可选 lines[] 字段。
  // 顶层 path 仍是线 A，旧读取方（客户端/旧预览器）不受影响；
  // 支持多线的读取方（PathPreview、客户端）以 lines[] 为准。
  // color/key：线 A 白·上箭头（右手），线 B 黑·X（左手）——与预览器的绿/紫一一对应。
  // elevate：线 B（及以后）抬高 B_Y 米（--b-y），让两条线上下分层。
  if (TWO_LINE) {
    const LINE_COLOR = ["#ffffff", "#000000"];
    const LINE_KEY   = ["ArrowUp", "KeyX"];
    lv.lines = lines.map((L, i) => ({
      id: L.id,
      spawn: L.spawn,
      path: L.pts.filter(p => p.turn).map(p => ({ t: p.t, turn: p.turn, pos: [p.x, p.y, p.z] })),
      color: LINE_COLOR[i] || "#ffffff",
      key:   LINE_KEY[i]   || "ArrowUp",
      hand:  i === 0 ? "right" : "left",
      elevate: +(B_Y * i).toFixed(3),
    }));
  }
  const lvPath = path.join(outDir, "level.json");
  fs.writeFileSync(lvPath, JSON.stringify(lv, null, 2), "utf8");
  console.log(`关卡:   ${lvPath}${TWO_LINE ? "（含 lines[]：线 A + 线 B）" : ""}`);
}

/* ---------------------- 俯视预览图（SVG） ---------------------- */
// 取时间窗 [t0,t1] 内的路径点（含两侧各一个点，保证首尾连线不断）
function windowPts(p, t0, t1) {
  if (VIEW == null) return p;
  let i0 = 0; while (i0 < p.length && p[i0].t < t0) i0++;
  i0 = Math.max(0, i0 - 1);
  let i1 = p.length - 1; while (i1 > 0 && p[i1].t > t1) i1--;
  i1 = Math.min(p.length - 1, i1 + 1);
  return p.slice(i0, i1 + 1);
}
function boundsOf(p) {
  const xs = p.map(q => q.x), zs = p.map(q => q.z);
  return { min: [Math.min(...xs), ELEVATE, Math.min(...zs)],
           max: [Math.max(...xs), ELEVATE, Math.max(...zs)] };
}
if (!NO_SVG) {
  const W = 1400, H = 900, pad = 40;
  const viewNote = VIEW ? `  ·  时间窗 ${VIEW[0]}–${VIEW[1]}s` : "";

  if (TWO_LINE) {
    /* 双线：左右并排两个面板，各自适配缩放，方便对比两条路径形态 */
    const pw = W / lines.length;
    let body = `<rect width="${W}" height="${H}" fill="#f7f7f4"/>\n`;
    lines.forEach((L, pi) => {
      const vp = windowPts(L.pts, VIEW ? VIEW[0] : 0, VIEW ? VIEW[1] : 0);
      const bx = boundsOf(vp);
      const bw = bx.max[0] - bx.min[0], bh = bx.max[2] - bx.min[2];
      const sc = Math.min((pw - pad * 2) / (bw || 1), (H - 96 - pad * 2) / (bh || 1));
      const ox = pi * pw + pad + ((pw - pad * 2) - bw * sc) / 2;
      const oy = 96 + pad + ((H - 96 - pad * 2) - bh * sc) / 2;
      const X = x => ox + (x - bx.min[0]) * sc;
      const Y = z => oy + (z - bx.min[2]) * sc;
      const col = LINE_COLOR[pi] || "#333";
      const w = Math.min(Math.max(1.5, LINE_W * sc), 20);

      // 面板边框
      body += `<rect x="${(pi * pw + 1).toFixed(1)}" y="1" width="${(pw - 2).toFixed(1)}" ` +
              `height="${H - 2}" fill="none" stroke="#e2e2dc"/>\n`;
      // 路径
      for (let i = 0; i + 1 < vp.length; i++) {
        const a = vp[i], b = vp[i + 1];
        body += `<line x1="${X(a.x).toFixed(1)}" y1="${Y(a.z).toFixed(1)}" ` +
                `x2="${X(b.x).toFixed(1)}" y2="${Y(b.z).toFixed(1)}" ` +
                `stroke="${col}" stroke-width="${w.toFixed(2)}" stroke-linecap="round"/>\n`;
      }
      // 转向点
      for (const p of vp) if (p.turn) {
        body += `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.z).toFixed(1)}" r="1.8" fill="#111" opacity="0.6"/>\n`;
      }
      // 起点（用该线自己的起点，线 B 平移后也不会画错）
      const s0 = vp[0] || L.pts[0];
      body += `<circle cx="${X(s0.x).toFixed(1)}" cy="${Y(s0.z).toFixed(1)}" r="5" fill="#000" stroke="#fff" stroke-width="2"/>\n`;
      // 面板标题
      body += `<text x="${(pi * pw + 16).toFixed(0)}" y="34" font-family="monospace" font-size="17" fill="#222">` +
              `线 ${L.id}</text>\n` +
              `<text x="${(pi * pw + 16).toFixed(0)}" y="58" font-family="monospace" font-size="12" fill="#555">` +
              `转向 ${L.marks.length} · 全长 ${L.totalLen.toFixed(0)}m · 最短段 ${L.minLen.toFixed(2)}m · 最近间距 ${L.minGapV.toFixed(2)}m</text>\n` +
              `<text x="${(pi * pw + 16).toFixed(0)}" y="78" font-family="monospace" font-size="12" fill="#777">` +
              `线速 ${speedAt(0).toFixed(1)}m/s · 线宽 ${LINE_W}m（双线并排对比，非实际同屏位置）${viewNote}</text>\n`;
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
      `viewBox="0 0 ${W} ${H}">${body}</svg>`;
    fs.writeFileSync(outSvgPath, svg, "utf8");
  } else {
    /* 单线：保持原有渲染（按幕着色） */
    const vp = windowPts(pts, VIEW ? VIEW[0] : 0, VIEW ? VIEW[1] : 0);
    const bb = boundsOf(vp);
    const bw = bb.max[0] - bb.min[0], bh = bb.max[2] - bb.min[2];
    const sc = Math.min((W - pad * 2) / (bw || 1), (H - pad * 2) / (bh || 1));
    const ox = pad + ((W - pad * 2) - bw * sc) / 2;
    const oy = pad + ((H - pad * 2) - bh * sc) / 2;
    const X = x => ox + (x - bb.min[0]) * sc;
    const Y = z => oy + (z - bb.min[2]) * sc;

    const colors = ["#3f9d5a", "#c0392b", "#5b7fbd", "#d9a441"];   // 按幕循环取色
    let body = "";
    for (let i = 0; i + 1 < vp.length; i++) {
      const a = vp[i], b = vp[i + 1];
      const act = actT.findIndex((t0, k) =>
        k + 1 < actT.length && a.t >= t0 && a.t < actT[k + 1]);
      const col = colors[(act < 0 ? 0 : act) % colors.length] || "#333";
      const w = Math.max(1.5, LINE_W * sc);
      body += `<line x1="${X(a.x).toFixed(1)}" y1="${Y(a.z).toFixed(1)}" ` +
              `x2="${X(b.x).toFixed(1)}" y2="${Y(b.z).toFixed(1)}" ` +
              `stroke="${col}" stroke-width="${w}" stroke-linecap="round"/>\n`;
    }
    // 转向点
    for (const p of vp) if (p.turn) {
      body += `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.z).toFixed(1)}" r="2.2" fill="#111"/>\n`;
    }
    // 起点（用该线自身起点）
    const s0 = vp[0] || pts[0];
    body += `<circle cx="${X(s0.x).toFixed(1)}" cy="${Y(s0.z).toFixed(1)}" r="5" fill="#000" stroke="#fff" stroke-width="2"/>\n`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
      `viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#f7f7f4"/>\n${body}` +
      `<text x="20" y="30" font-family="monospace" font-size="16" fill="#333">` +
      `${path.basename(inPath)}  ·  转向 ${marks.length}  ·  全长 ${totalLen.toFixed(0)}m  ` +
      `·  线速 ${speedAt(0).toFixed(1)}m/s  ·  线宽 ${LINE_W}m${viewNote}</text></svg>`;
    fs.writeFileSync(outSvgPath, svg, "utf8");
  }
}

/* ---------------------- 报告 ---------------------- */
// 只看真正的数据问题：踩音点几乎重合会产生近似零长段（属于误点，建议清理）。
// 段长 / 间距短于路宽是高难关卡的常态（路面块自然重叠），不算错误。
const warn = [];
if (minLen < 0.05) warn.push(`存在 ${minLen.toFixed(3)}m 的近似零长段（踩音点几乎重合，建议清理）`);

const lineReport = TWO_LINE
  ? lines.map(L => {
      const z = L.minLen < 0.05 ? "  ⚠️ 近似零长段" : "";
      return `  线 ${L.id}: 转向 ${L.marks.length}  全长 ${L.totalLen.toFixed(0)}m  ` +
             `最短段 ${L.minLen.toFixed(2)}m  最近间距 ${L.minGapV.toFixed(2)}m${z}`;
    }).join("\n")
  : "";

console.log(`
================================================
理想舞线轨迹${TWO_LINE ? "（双线）" : ""}
================================================
输入:   ${inPath}
输出:   ${SVG_ONLY ? "（--svg-only，未写 JSON）" : outJsonPath}${NO_SVG ? "" : "\n预览:   " + outSvgPath + (VIEW ? `（时间窗 ${VIEW[0]}–${VIEW[1]}s）` : "")}

音乐:   ${out.audio.name} | ${DUR.toFixed(2)}s | BPM ${out.bpm}
${TWO_LINE ? "双线:\n" + lineReport : `转向点: ${marks.length}`}
线速:   ${speedAt(0).toFixed(2)} m/s（${MPS != null ? "恒定" : SPEED_BEATS + " 米/拍"}）
线宽:   ${LINE_W} m
高度:   ${ELEVATE > 0 ? `高架 ${ELEVATE}m（桥面等高，桥墩间距 ${PIER_EVERY}m）` : "贴地（等高）"}
${(lineOffX || lineOffZ || B_Y) ? `线 B 起点: ΔX ${lineOffX} m、ΔZ ${lineOffZ} m（= X ${B_X} / Z ${B_Z} × 最小转角间隔 ${gapUnitM.toFixed(3)} m；正=右/下）${B_Y ? `，抬高 ${B_Y} m（正=上方）` : ""}\n` : ""}
路径点: ${pts.length}    段数: ${segs.length}
总长:   ${totalLen.toFixed(1)} m
包围盒: X[${bounds.min[0].toFixed(1)}, ${bounds.max[0].toFixed(1)}]  ` +
`Z[${bounds.min[2].toFixed(1)}, ${bounds.max[2].toFixed(1)}]
最短段: ${minLen.toFixed(2)} m
最近路段间距: ${minGapV.toFixed(2)} m${gapAt ? `（段 ${gapAt[0]} 与 ${gapAt[1]}）` : ""}
布景采样: ${samples.length} 个（每 ${SAMPLE_D}m）
${SPLIT_ON ? `瞬移:   ${teleports.length} 处（${TP_T}s）` : "瞬移:   未启用（--split --tp <秒> 可开）"}
${warn.length ? "\n⚠️  " + warn.join("\n⚠️  ") + "\n" : ""}
`);
