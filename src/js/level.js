/* =====================================================================
   level.js — 关卡数据与路径几何
   纯计算，不依赖渲染引擎。
   ===================================================================== */

export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // +x, +z, -x, -z
export const rot = (d, turn) => (d + (turn === "R" ? 1 : 3)) % 4;

/* ---------------------- 网络加载 ---------------------- */
export async function fetchLevels() {
  const r = await fetch("/api/levels");
  if (!r.ok) throw new Error("无法获取关卡列表（HTTP " + r.status + "）");
  return r.json();
}

export async function loadLevelJSON(dir) {
  const r = await fetch("/levels/" + encodeURIComponent(dir) + "/level.json");
  if (!r.ok) throw new Error("无法读取 level.json（HTTP " + r.status + "）");
  return r.json();
}

export async function loadAudioBuffer(ctx, dir, music) {
  const url = "/levels/" + encodeURIComponent(dir) + "/" + encodeURIComponent(music);
  const r = await fetch(url);
  if (!r.ok) throw new Error("无法读取音乐文件：" + music);
  const ab = await r.arrayBuffer();
  return await new Promise((res, rej) => {
    const p = ctx.decodeAudioData(ab, res, rej);
    if (p && p.then) p.then(res, rej);
  });
}

/* ---------------------- 时间与速度 ---------------------- */
export function bpmAt(level, t) {
  const secs = level.timing.sections;
  let bpm = secs[0].bpm;
  for (const s of secs) { if (s.t <= t + 1e-9) bpm = s.bpm; else break; }
  return bpm;
}
// 恒定线速（motion.speedMps）优先；否则按「每拍多少米」随 BPM 变化
export const speedAt = (level, t) =>
  level.motion.speedMps != null
    ? level.motion.speedMps
    : level.motion.speedBeats * bpmAt(level, t) / 60;

/* ---------------------- 多线关卡 ---------------------- */
// 归一化出「线列表」。单线关卡也会返回一条合成的线 A，
// 于是渲染/输入/判定三处都能用同一套「遍历所有线」的代码。
// 每条线：{ id, spawn, path, color, key, hand, elevate, primary }
//   color 缺省 线 A 白、线 B 黑；key 缺省 线 A ArrowUp、线 B KeyX。
//   elevate = 该线整体抬高多少米（叠在 spawn.y / pos[1] 之上），用来把两条线错成上下两层。
export function linesOf(level) {
  const ls = level.lines;
  if (Array.isArray(ls) && ls.length) {
    return ls.map((l, i) => ({
      id: l.id || String.fromCharCode(65 + i),
      spawn: l.spawn || level.motion.spawn,
      path: Array.isArray(l.path) ? l.path : (i === 0 ? level.path : []),
      color: l.color != null ? l.color : (i === 0 ? "#ffffff" : "#000000"),
      key:   l.key   != null ? l.key   : (i === 0 ? "ArrowUp" : "KeyX"),
      hand:  l.hand  || (i === 0 ? "right" : "left"),
      elevate: l.elevate != null ? l.elevate : 0,
      primary: i === 0,        // 只有线 A 吃顶层的 teleports
    }));
  }
  return [{
    id: "A", spawn: level.motion.spawn, path: level.path,
    color: "#ffffff", key: "ArrowUp", hand: "right", elevate: 0, primary: true,
  }];
}

/* ---------------------- 官方路线顶点 ---------------------- */
// 由 spawn + path 还原完整折线，末尾延伸到音乐结束。
// 每个顶点带 t（时刻）与 dir（从该点出发的方向）。
// 传 line（linesOf() 的一项）时按该线构建；不传则用顶层 path/spawn（= 线 A）。
export function buildVerts(level, dur, line) {
  const sp = (line && line.spawn) || level.motion.spawn;
  const path = (line && Array.isArray(line.path)) ? line.path : level.path;
  const el = (line && line.elevate) || 0;      // 该线整体抬高（上下两层）
  let dir = sp.dir;
  const V = [{ x: sp.x, y: (sp.y || 0) + el, z: sp.z, t: 0, dir }];
  // 瞬移只属于线 A（顶层的 teleports 是单线时代的产物）
  const tps = (!line || line.primary !== false)
    ? (level.teleports || []).slice().sort((a, b) => a.t - b.t)
    : [];
  let tpIdx = 0;

  for (const p of path) {
    // 插入瞬移点：先走到瞬移处（旧场景），再跳到新场景位置。
    // 两个点时间几乎相同，posAt 就会瞬间跳变，而不是插值为「飞过去」。
    while (tpIdx < tps.length && tps[tpIdx].t <= p.t) {
      const tp = tps[tpIdx++];
      const last = V[V.length - 1];
      const dt = Math.max(0, tp.t - last.t);
      const v = speedAt(level, last.t);
      V.push({
        x: last.x + DIRS[last.dir][0] * dt * v,
        y: last.y,
        z: last.z + DIRS[last.dir][1] * dt * v,
        t: tp.t - 1e-4, dir: last.dir,
      });
      V.push({ x: tp.to[0], y: (tp.to[1] || 0) + el, z: tp.to[2], t: tp.t, dir: last.dir });
    }
    V.push({ x: p.pos[0], y: p.pos[1] + el, z: p.pos[2], t: p.t, dir });
    dir = rot(dir, p.turn);
  }
  const last = path[path.length - 1];
  if (last) {
    const dt = Math.max(0, dur - last.t);
    const v = speedAt(level, last.t);
    V.push({
      x: last.pos[0] + DIRS[dir][0] * v * dt,
      y: last.pos[1] + el,
      z: last.pos[2] + DIRS[dir][1] * v * dt,
      t: dur, dir,
    });
  }
  return V;
}

// 按时间在官方路线上插值取点
// 与 posAt 相同，但额外给出该点出发的方向（自动播放按官方路线走时用）。
// 位置纯粹由音频时间插值得到，不逐帧累加，因此没有累积误差。
export function vertAt(verts, t) {
  if (!verts.length) return { x: 0, y: 0, z: 0, dir: 0 };
  if (t <= verts[0].t) return verts[0];
  const last = verts[verts.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = verts.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (verts[m].t <= t) lo = m; else hi = m; }
  const a = verts[lo], b = verts[hi];
  const span = b.t - a.t;
  const k = span > 1e-9 ? (t - a.t) / span : 0;
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
    dir: a.dir,
  };
}

export function posAt(verts, t) {
  if (!verts.length) return { x: 0, y: 0, z: 0 };
  if (t <= verts[0].t) return { x: verts[0].x, y: verts[0].y, z: verts[0].z };
  const last = verts[verts.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y, z: last.z };

  let lo = 0, hi = verts.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (verts[m].t <= t) lo = m; else hi = m; }
  const a = verts[lo], b = verts[hi];
  const span = b.t - a.t;
  const k = span > 1e-9 ? (t - a.t) / span : 0;
  return {
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    z: a.z + (b.z - a.z) * k,
  };
}

/* ---------------------- 分幕查询 ---------------------- */
export function sceneAt(level, t) {
  const sc = level.scenes || [];
  for (const s of sc) if (t >= s.t[0] && t < s.t[1]) return s;
  return sc[sc.length - 1] || null;
}
export const themeAt = (level, t) => {
  const s = sceneAt(level, t);
  return s ? s.theme : "void";
};
