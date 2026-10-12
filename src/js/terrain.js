// 地形层：关卡的「地面」。
//
// 为什么需要这一层
// ----------------
// 真实《跳舞的线》关卡的地面是**一整块有厚度的地形**（草皮在上、断面在下），
// 路就嵌在这块地形里；而不是「一堆离散方块浮在空中」。
// 之前那种「沿路随机撒长方体」的布景在这一点上就是错的：
// 块与块之间没有地面，看起来像漂浮的碎屑（诊断见 AGENT.md §8 的纠偏记录）。
//
// 数据格式（level.terrain）
// ------------------------
//   {
//     "v": 1,
//     "base": { "motif": "deck", "params": { ... } },          // 整关的底子
//     "spans": [                                               // 局部换母题
//       { "t": [60, 90], "motif": "canyon", "params": { ... } }
//     ]
//   }
// 母题（motif）只有四种，全部只用基本几何体拼：
//   deck    厚板台地：一整块地面 + 一圈更低的台阶，边缘能看到切面
//   canyon  峡谷：路在切开的窄槽里，两侧是抬高的台地
//   islands 浮岛：路架在一串大圆台上，台间是空隙
//   cloud   云海：路走在厚板上，板两侧是大团云
//
// 颜色不进关卡
// ------------
// 地面用什么颜色由**客户端的主题表**（THEME 的 scenNear/scenMid/scenFar）决定，
// 和场景一起过渡。关卡只描述"形状"，这样同一份形状可以换主题复用。
//
// 已知局限（都写在 AGENT.md §13）
// ------------------------------
// - 只用线的 A 条路径做地形（双线关卡的第二条线没有自己的地形）。
// - 一段地形的高度取这一段路径的最高点；路径高度在段内起伏很大的关卡会穿帮。
// - 母题切换处是硬切（断面直接相邻），远看像地貌变化，近看有缝。

import * as THREE from "../vendor/three.module.min.js";

/* ------------------------------ 小工具 ------------------------------ */

function dseg(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

function distPath(x, z, pts) {
  let m = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = dseg(x, z, pts[i - 1].x, pts[i - 1].z, pts[i].x, pts[i].z);
    if (d < m) m = d;
  }
  return m;
}

// 沿折线左侧偏移 d 的轮廓线（用斜接点求交）。
// cosHalf 下限 0.55：小转角的斜接点不能拉太远，否则边缘会被磨成锯齿状。
function offsetSide(pts, d) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[i], c = pts[Math.min(n - 1, i + 1)];
    let ux = b.x - a.x, uz = b.z - a.z;
    const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
    let vx = c.x - b.x, vz = c.z - b.z;
    const vl = Math.hypot(vx, vz) || 1; vx /= vl; vz /= vl;
    const dx = ux + vx, dz = uz + vz, dl = Math.hypot(dx, dz);
    const nx = dl > 1e-9 ? -dz / dl : -uz, nz = dl > 1e-9 ? dx / dl : ux;
    const cosHalf = Math.max(0.55, dl / 2);
    out.push({ x: b.x + nx * (d / cosHalf), z: b.z + nz * (d / cosHalf) });
  }
  return out;
}

// 把两条轮廓线拼成一个闭合环（左轮廓 + 反向的右轮廓）
function band(pts, d) {
  return offsetSide(pts, d).concat(offsetSide(pts, -d).reverse());
}

// 闭合多边形的移动平均平滑。
// 为什么要平滑：这个关的路是「每拍一个 90° 转角」的楼梯形，直接用它的轮廓偏移，
// 地面的边缘就会跟着变成一串密集的小锯齿，看起来像被啃过。
// 平滑之后边缘变成"人工铺出来的"大台阶 —— 路本身不动，只有地面的外沿被抹平。
function smoothLoop(pts, alpha, iters) {
  let cur = pts;
  for (let it = 0; it < iters; it++) {
    const n = cur.length;
    if (n < 5) break;
    const nx = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n], b = cur[i], c = cur[(i + 1) % n];
      nx[i] = {
        x: b.x + alpha * ((a.x + c.x) / 2 - b.x),
        z: b.z + alpha * ((a.z + c.z) / 2 - b.z),
      };
    }
    cur = nx;
  }
  return cur;
}

// 2D 轮廓 → 有厚度的实心板：**顶面在 surfaceY**，向下延伸 th。
// （ExtrudeGeometry 是沿 +y 挤出的，所以网格原点要落到 surfaceY - th。）
function slab(outline, surfaceY, th, matl) {
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, -p.z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, matl);
  m.position.y = surfaceY - th;
  return m;
}

// 环形板：外轮廓里挖掉内轮廓（做「峡谷」那种中间开一条槽的效果）
function ringSlab(inner, outer, surfaceY, th, matl) {
  const shape = new THREE.Shape(outer.map((p) => new THREE.Vector2(p.x, -p.z)));
  shape.holes.push(new THREE.Path(inner.map((p) => new THREE.Vector2(p.x, -p.z))));
  const g = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, matl);
  m.position.y = surfaceY - th;
  return m;
}

// 不规则圆盘（浮岛的台面）
function disc(cx, cz, rx, rz, surfaceY, th, sides, matl, seed) {
  const o = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2 + seed * 0.7;
    const j = 0.78 + 0.22 * (((i * 7919 + seed * 104729) % 97) / 97);
    o.push({ x: cx + Math.cos(a) * rx * j, z: cz + Math.sin(a) * rz * j });
  }
  return slab(o, surfaceY, th, matl);
}

/* ------------------------------ 四种母题 ------------------------------ */

// A 厚板台地
function motifDeck(pts, W, M, surf) {
  const w = W.walk / 2, out = [];
  out.push(slab(smoothLoop(band(pts, w + W.shelf), 0.6, 2), surf, W.th, M.mid));
  out.push(slab(smoothLoop(band(pts, w + W.shelf * 2.2), 0.6, 2), surf - W.step, W.th * 0.8, M.near));
  return out;
}

// B 峡谷：路在槽底，两侧一圈一圈往外抬（用环板，中间是挖空的）
function motifCanyon(pts, W, M, surf) {
  const w = W.walk / 2, out = [];
  const floorY = surf - W.floor;                 // 槽底比路面低 floor 米
  // 槽底和「环的内沿」不能平滑：它们离路只有 2.8m，比路面折线的锯齿幅度还小，
  // 平滑会让多边形自交、把中间挖空的洞填死（表现为"整个画面被地面糊住"）。
  out.push(slab(band(pts, w + 0.6), floorY, 5, M.far));
  for (let t = 0; t < W.hiCount; t++) {
    const inner = band(pts, w + 0.6 + t * W.hiDepth);
    const outer = smoothLoop(band(pts, w + 0.6 + (t + 1) * W.hiDepth), 0.6, 2);
    const top = floorY + ((t + 1) * W.hi) / W.hiCount;
    out.push(ringSlab(inner, outer, top, 6, t === 0 ? M.mid : M.near));
  }
  return out;
}

// C 浮岛：隔一段丢一块大圆台，台间留空（路从空处过去）
function motifIslands(pts, W, M, surf) {
  const out = [];
  let acc = W.gap, i = 0;                        // 起手先摆一块
  for (let j = 1; j < pts.length; j++) {
    const a = pts[j - 1], b = pts[j];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    acc += L;
    if (acc < W.gap) continue;
    acc = 0;
    const y = surf + (((i % 3) - 1) * W.hStep);
    out.push(disc(
      b.x, b.z,
      W.rx * (0.82 + ((i * 29) % 9) / 9 * 0.36),
      W.ry * (0.82 + ((i * 13) % 7) / 7 * 0.36),
      y, W.th, 9, i % 2 ? M.near : M.mid, i
    ));
    i++;
  }
  return out;
}

// D 云海：一条厚板贴着路，板下面和两侧堆云团
function motifCloud(pts, W, M, surf) {
  const w = W.walk / 2, out = [];
  out.push(slab(band(pts, w + 1.2), surf, 2.6, M.mid));
  let acc = W.gap, i = 0;
  for (let j = 1; j < pts.length; j++) {
    const a = pts[j - 1], b = pts[j];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    acc += L;
    if (acc < W.gap) continue;
    acc = 0;
    const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L, nx = -uz, nz = ux;
    const side = i % 2 === 0 ? 1 : -1;
    const off = w + W.off0 + (((i * 53) % 13) / 13) * W.offSpan;
    const cx = b.x + nx * side * off, cz = b.z + nz * side * off;
    i++;
    // 云团是一簇球，会从中心往四周散开 ±2r 左右，所以净空要按"中心离路 ≥ w + 2 + 2r"来判，
    // 否则大云团会有一半个球压到路面上（第一版就是这样）。
    if (distPath(cx, cz, pts) < w + 2.0 + W.r * 2.2) continue;
    const cy = surf + W.low + (((i * 17) % 5) / 5) * W.hSpan;
    for (let k = 0; k < 4 + (i % 3); k++) {
      const r = W.r * (0.6 + ((i * 31 + k * 17) % 9) / 12);
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), M.far);
      m.position.set(
        cx + (((i + k * 3) % 5) - 2) * r * 0.75,
        cy + (((i * 2 + k) % 4) - 1.5) * r * 0.45,
        cz + (((i * 3 + k) % 5) - 2) * r * 0.75
      );
      m.scale.set(1, 0.6, 1);
      out.push(m);
    }
  }
  return out;
}

const MOTIFS = { deck: motifDeck, canyon: motifCanyon, islands: motifIslands, cloud: motifCloud };

// 每种母题缺省的尺寸参数（关卡里可以逐个覆盖）
export const DEFAULT_PARAMS = {
  deck: { walk: 7.0, shelf: 2.4, th: 3.2, step: 1.6 },
  canyon: { walk: 4.4, hi: 9.0, hiCount: 2, hiDepth: 7.0, floor: 3.0 },
  islands: { walk: 5.0, gap: 11, rx: 8.5, ry: 6.5, th: 1.8, hStep: 1.6 },
  cloud: { walk: 5.4, gap: 9, off0: 5, offSpan: 16, low: -7, hSpan: 5, r: 3.6 },
};

/* --------------------------- 组装整条地形 --------------------------- */

// 把 level.path 还原成带时间的折线。
// ⚠️ path[i].pos 是**绝对世界坐标**，直接当顶点用（见 src/js/level.js 的 buildVerts）。
function collectPath(level) {
  const sp = level.motion && level.motion.spawn ? level.motion.spawn : { x: 0, y: 0, z: 0 };
  const pts = [{ x: sp.x, y: sp.y, z: sp.z, t: 0 }];
  const path = level.path || [];
  for (const p of path) {
    pts.push({ x: p.pos[0], y: p.pos[1], z: p.pos[2], t: p.t || 0 });
  }
  return pts;
}

// 去掉过密的短段：这个关的 path 是「每拍一点」，最短 1.17m，
// 直接把 682 个点当轮廓会把地形边缘磨出密密麻麻的小锯齿。
function simplify(pts, minSeg) {
  if (pts.length <= 2) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1];
    if (Math.hypot(pts[i].x - p.x, pts[i].z - p.z) >= minSeg) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// 按时间把折线切成若干段：每段一个母题（base 或某个 span）
function splitRuns(pts, spec) {
  const spans = (spec.spans || []).slice().sort((a, b) => a.t[0] - b.t[0]);
  const motifAt = (t) => {
    for (const s of spans) if (t >= s.t[0] && t < s.t[1]) return s;
    return null;
  };
  const runs = [];
  let cur = null;
  for (const p of pts) {
    const s = motifAt(p.t);
    const name = s ? s.motif : spec.base.motif;
    const params = (s && s.params) || (s ? spec.base.params : spec.base.params) || {};
    if (!cur || cur.motif !== name) {
      cur = { motif: name, params, pts: [] };
      runs.push(cur);
    }
    cur.pts.push(p);
  }
  // 相邻两段共用一个点，避免切换处出现缺口
  for (let i = 1; i < runs.length; i++) {
    if (runs[i - 1].pts.length > 1) runs[i].pts.unshift(runs[i - 1].pts[runs[i - 1].pts.length - 1]);
  }
  return runs.filter((r) => r.pts.length >= 2);
}

/**
 * 建出整关的地形。
 * @param {object} level 关卡数据（读 level.terrain）
 * @param {{near:number, mid:number, far:number}} colors 三档颜色（来自主题表）
 * @param {Array<{x:number,y:number,z:number,t:number}>} [verts]
 *        客户端已经算好的路线顶点（`buildVerts` 的结果，含末尾延伸到关卡结束的那一段）。
 *        **必须传**：不传的话地形会止于 level.path 的最后一个点，
 *        而路面还要继续延伸到关卡结束（这关就多出 108m），那一段路就会悬空。
 * @returns {THREE.Group|null} 地形组；group.userData.materials 是 3 份材质，供换主题时改色
 */
export function buildTerrain(level, colors, verts) {
  const spec = level && level.terrain;
  if (!spec || !spec.base || !spec.base.motif || !MOTIFS[spec.base.motif]) return null;

  const mats = {
    near: new THREE.MeshStandardMaterial({ color: colors.near, roughness: 0.92, metalness: 0, flatShading: true }),
    mid: new THREE.MeshStandardMaterial({ color: colors.mid, roughness: 0.88, metalness: 0, flatShading: true }),
    far: new THREE.MeshStandardMaterial({ color: colors.far, roughness: 0.95, metalness: 0, flatShading: true }),
  };

  const group = new THREE.Group();
  group.name = "terrain";
  group.userData.materials = mats;

  const src = verts && verts.length > 1
    ? verts.map((v) => ({ x: v.x, y: v.y, z: v.z, t: v.t }))
    : collectPath(level);
  const runs = splitRuns(src, spec);
  for (const run of runs) {
    const fn = MOTIFS[run.motif];
    if (!fn) continue;
    const P = Object.assign({}, DEFAULT_PARAMS[run.motif] || {}, run.params || {});
    // 这一段的地面高度 = 这段路径的最高点，再压低 6cm：
    // 路面色带本身就铺在这个高度上，完全齐平会共面闪烁，压 6cm 的台阶肉眼看不见。
    let top = -Infinity;
    for (const p of run.pts) if (p.y > top) top = p.y;
    const surf = top - 0.06;
    const pts = simplify(run.pts, 2.0);
    for (const m of fn(pts, P, mats, surf)) group.add(m);
  }
  return group;
}
