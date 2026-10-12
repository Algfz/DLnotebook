// ============================================================================
// props.js —— 道具库（景物）
// ----------------------------------------------------------------------------
// 设计原则（和 terrain.js 一样）：**形状是规则，颜色不进关卡**。
//   · 每个道具 = 若干"基本几何体"的组合（球/圆柱/圆锥/盒子/八面体），
//     全部用**单位尺寸**的几何体（直径 1 / 高 1），所以在道具定义里写的
//     数字直接就是"米"。
//   · 关卡只写"在哪个时间段、每隔多少米、离路多远、放哪种道具"（见 level.props）。
//   · 颜色由**色卡**给（PALETTES 的 props 一节），道具定义里只写色槽名
//     （'foliage' / 'wood' / 'stone' / 'bloom' / 'accent'）。
//   · 渲染时按"几何体种类"合并成几个 InstancedMesh（整关几百个道具也只有
//     4~6 个 draw call），逐实例 setColorAt。
//
// 为什么这么做：真实关卡的景物是"能认出来的东西 + 稀疏摆放"，不是随机方块。
// 参考《跳舞的线》田野/春天/海洋等关：树=圆柱+球、石头=多面体、花=细杆+球、
// 栅栏=盒子、音符=杆+球……全是基本几何体的组合，所以零 npm 依赖也做得出来。
// ============================================================================

import * as THREE from "../vendor/three.module.min.js";

// --- 单位几何体（直径/边长/高都是 1，位置在几何中心） ----------------------
const GEOS = {
  box: new THREE.BoxGeometry(1, 1, 1),
  sphere: new THREE.IcosahedronGeometry(0.5, 1),      // 低多边形球（好认又不"太圆滑"）
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
  oct: new THREE.OctahedronGeometry(0.5, 0),
};
const GEO_ROUGH = { box: 0.9, sphere: 0.95, cyl: 0.85, cone: 0.9, oct: 0.8 };

/* ---------------------------------------------------------------------------
   道具定义
   每个函数返回一组 {geo, pos:[x,y,z], scale:[sx,sy,sz], rotY?, color}
   · y = 0 是地面，道具必须从 0 往上长
   · R 是 [0,1) 随机数函数（同一个道具实例内用同一个 R，所以形态稳）
   --------------------------------------------------------------------------- */
export const PROPS = {
  // 阔叶树：树干 + 2~3 个球拼的树冠
  tree(R) {
    const h = 2.2 + R() * 1.8;
    const r = 1.2 + R() * 0.8;
    return [
      { geo: "cyl", pos: [0, h / 2, 0], scale: [0.36, h, 0.36], color: "wood" },
      { geo: "sphere", pos: [0, h + r * 0.7, 0], scale: [r * 2.1, r * 1.8, r * 2.1], color: "foliage" },
      { geo: "sphere", pos: [r * 0.55, h + r * 0.35, r * 0.25], scale: [r * 1.25, r * 1.1, r * 1.25], color: "foliage" },
      { geo: "sphere", pos: [-r * 0.5, h + r * 0.5, -r * 0.3], scale: [r * 1.1, r * 0.95, r * 1.1], color: "foliage" },
    ];
  },

  // 松树：树干 + 3 层圆锥（越往上越小）
  pine(R) {
    const h = 1.6 + R() * 1.2;
    const n = 3;
    const out = [{ geo: "cyl", pos: [0, h / 2, 0], scale: [0.32, h, 0.32], color: "wood" }];
    let y = h * 0.8, w = 2.6 + R() * 0.8;
    for (let i = 0; i < n; i++) {
      const ch = 2.4 + R() * 0.6, sw = w * (1 - i * 0.24);
      out.push({ geo: "cone", pos: [0, y + ch / 2, 0], scale: [sw, ch, sw], color: "foliage" });
      y += ch * 0.52;
    }
    return out;
  },

  // 果树：树冠上挂几个"果子"
  appleTree(R) {
    const out = PROPS.tree(R);
    const n = 3 + Math.floor(R() * 3);
    const h = out[0].scale[1], r = out[1].scale[0] / 2;
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2, d = r * (0.55 + R() * 0.5);
      out.push({
        geo: "sphere", color: "bloom",
        pos: [Math.cos(a) * d, h + r * 0.7 + Math.sin(a) * d * 0.7, Math.sin(a) * d],
        scale: [0.42, 0.42, 0.42],
      });
    }
    return out;
  },

  // 灌木：2~3 个小球挤在一起
  bush(R) {
    const out = [];
    const n = 2 + Math.floor(R() * 2);
    for (let i = 0; i < n; i++) {
      const s = 0.9 + R() * 0.7;
      out.push({
        geo: "sphere", color: "foliage",
        pos: [(R() - 0.5) * 1.2, s * 0.55, (R() - 0.5) * 1.2],
        scale: [s * 1.5, s * 1.2, s * 1.5],
      });
    }
    return out;
  },

  // 石头：1~3 块压扁的低多边形球（有棱角但不"纸片"；用八面体会变成扁平菱形，很难看）
  rock(R) {
    const out = [];
    const n = 1 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const s = 0.62 + R() * 0.95;
      out.push({
        geo: "sphere", color: "stone",
        pos: [(R() - 0.5) * 2.2, s * 0.3, (R() - 0.5) * 2.2],
        scale: [s * 1.5, s * 0.95, s * 1.4],
        rotY: R() * Math.PI,
      });
    }
    return out;
  },

  // 花：细杆 + 花心 + 4 片花瓣（扁球）
  flower(R) {
    const h = 0.75 + R() * 0.5;
    const out = [{ geo: "cyl", pos: [0, h / 2, 0], scale: [0.07, h, 0.07], color: "foliage" }];
    const petal = 0.3 + R() * 0.14;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + R() * 0.4;
      out.push({
        geo: "sphere", color: "bloom",
        pos: [Math.cos(a) * petal * 0.8, h + 0.02, Math.sin(a) * petal * 0.8],
        scale: [petal * 1.7, petal * 0.6, petal * 1.7],
      });
    }
    out.push({ geo: "sphere", pos: [0, h + 0.08, 0], scale: [0.16, 0.16, 0.16], color: "accent" });
    return out;
  },

  // 蘑菇：杆 + 半球伞盖
  mushroom(R) {
    const h = 0.5 + R() * 0.5;
    return [
      { geo: "cyl", pos: [0, h / 2, 0], scale: [0.22, h, 0.22], color: "wood" },
      { geo: "sphere", pos: [0, h, 0], scale: [0.8, 0.5, 0.8], color: "bloom" },
    ];
  },

  // 栅栏：两立柱 + 两条横杆（一段 2m 宽）
  fence(R) {
    const w = 2.0, h = 1.0 + R() * 0.3;
    return [
      { geo: "box", pos: [-w / 2, h / 2, 0], scale: [0.16, h, 0.16], color: "wood" },
      { geo: "box", pos: [w / 2, h / 2, 0], scale: [0.16, h, 0.16], color: "wood" },
      { geo: "box", pos: [0, h * 0.78, 0], scale: [w, 0.14, 0.1], color: "wood" },
      { geo: "box", pos: [0, h * 0.45, 0], scale: [w, 0.14, 0.1], color: "wood" },
    ];
  },

  // 路灯：杆 + 灯头
  lamp(R) {
    const h = 3.2 + R() * 0.8;
    return [
      { geo: "cyl", pos: [0, h / 2, 0], scale: [0.16, h, 0.16], color: "wood" },
      { geo: "box", pos: [0, h + 0.28, 0], scale: [0.5, 0.55, 0.5], color: "accent" },
      { geo: "cone", pos: [0, h + 0.66, 0], scale: [0.8, 0.35, 0.8], color: "wood" },
    ];
  },

  // 音符（发起人提过的"能认出来"的例子）：杆 + 符头 + 符尾
  note(R) {
    const h = 1.6 + R() * 0.6;
    return [
      { geo: "cyl", pos: [0, h / 2, 0], scale: [0.11, h, 0.11], color: "accent" },
      { geo: "sphere", pos: [0, 0.3, 0], scale: [0.62, 0.5, 0.62], color: "accent" },
      { geo: "box", pos: [0.24, h - 0.12, 0], scale: [0.7, 0.16, 0.1], color: "accent" },
    ];
  },

  // 水晶：几根棱锥（八面体拉长）——要"粗"一点，太细会像牙签
  crystal(R) {
    const out = [];
    const n = 1 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const h = 2.0 + R() * 2.4;
      out.push({
        geo: "oct", color: "accent",
        pos: [(R() - 0.5) * 1.8, h * 0.45, (R() - 0.5) * 1.8],
        scale: [1.0 + R() * 0.7, h, 1.0 + R() * 0.7],
        rotY: R() * 3,
      });
    }
    return out;
  },

  // 云团（浮在空中的一簇球，"云海"段用）
  cloudlet(R) {
    const out = [];
    const n = 3 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const s = 1.8 + R() * 2.2;
      out.push({
        geo: "sphere", color: "stone",
        pos: [(R() - 0.5) * 3.6, (R() - 0.5) * 1.2, (R() - 0.5) * 3.6],
        scale: [s * 1.35, s, s * 1.35],
      });
    }
    return out;
  },

  // 雪人（冬季主题）：两个球 + 圆锥帽 + 胡萝卜鼻子
  snowman(R) {
    const b = 1.0 + R() * 0.3;
    return [
      { geo: "sphere", pos: [0, b * 0.9, 0], scale: [b * 1.9, b * 1.8, b * 1.9], color: "stone" },
      { geo: "sphere", pos: [0, b * 2.5, 0], scale: [b * 1.4, b * 1.3, b * 1.4], color: "stone" },
      { geo: "cone", pos: [0, b * 3.5, 0], scale: [b * 1.3, b * 1.1, b * 1.3], color: "bloom" },
      { geo: "cone", pos: [0, b * 2.55, b * 0.7], scale: [b * 0.22, b * 0.5, b * 0.22], color: "accent" },
    ];
  },
};

/* ---------------------------------------------------------------------------
   道具配色：跟着地形色卡走（关卡里同样只写色卡名字）
   --------------------------------------------------------------------------- */
export const PROP_COLORS = {
  rose:  { foliage: 0x4f8f5f, wood: 0x7a5230, stone: 0xc9c2bb, bloom: 0xf3a7c6, accent: 0xf7e08a },
  plum:  { foliage: 0x4a7f6a, wood: 0x5c4030, stone: 0xb9b0b6, bloom: 0xd98bb4, accent: 0xf2d98a },
  sand:  { foliage: 0x6f8c46, wood: 0x7a5a34, stone: 0xd8c9a8, bloom: 0xe8a06a, accent: 0xf6e2a8 },
  ice:   { foliage: 0x4d8f96, wood: 0x6b7a86, stone: 0xe6f0f4, bloom: 0x9fd6e8, accent: 0xfdfbf6 },
  jade:  { foliage: 0x3f8f63, wood: 0x6d5334, stone: 0xcbd8cd, bloom: 0xf0c0d0, accent: 0xf6e6a0 },
  cream: { foliage: 0x8f9c7a, wood: 0x8a7a60, stone: 0xf2ece0, bloom: 0xd9c9b0, accent: 0xf7e8c0 },
  // 没有指定色卡时（跟着主题走的段）用这套中性色
  default: { foliage: 0x6f9e6a, wood: 0x7a5230, stone: 0xc9c2bb, bloom: 0xefa7c5, accent: 0xf7e08a },
};

/* ---------------------------------------------------------------------------
   摆放：沿路按弧长走，规则见文件头
   --------------------------------------------------------------------------- */
function polyline(verts) {
  const seg = [];
  let acc = 0;
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1], b = verts[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    seg.push({ a, b, L, s0: acc });
    acc += L;
  }
  return { seg, total: acc };
}
function atArc(pl, s) {
  const { seg } = pl;
  let lo = 0, hi = seg.length - 1, i = 0;
  if (s <= 0) i = 0;
  else if (s >= pl.total) i = seg.length - 1;
  else {
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (seg[mid].s0 + seg[mid].L < s) lo = mid + 1;
      else if (seg[mid].s0 > s) hi = mid - 1;
      else { i = mid; break; }
    }
  }
  const sg = seg[i];
  const k = Math.max(0, Math.min(1, (s - sg.s0) / sg.L));
  const x = sg.a.x + (sg.b.x - sg.a.x) * k;
  const z = sg.a.z + (sg.b.z - sg.a.z) * k;
  const y = sg.a.y + (sg.b.y - sg.a.y) * k;
  const ux = (sg.b.x - sg.a.x) / sg.L, uz = (sg.b.z - sg.a.z) / sg.L;
  return { x, y, z, nx: uz, nz: -ux };   // nx,nz = 右侧法线
}
// 弧长 ↔ 时间（用 verts 上的 t 插值，用于规则的 t 区间）
function timeToArc(pl, verts, t) {
  // verts 里每个点都有 t；先线性插值找到 t 对应的位置，再算它的累计弧长
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1], b = verts[i];
    if (t >= a.t && t <= b.t) {
      const k = (b.t - a.t) < 1e-6 ? 0 : (t - a.t) / (b.t - a.t);
      const p = { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k };
      let s = 0;
      for (let j = 1; j < i; j++) {
        s += Math.hypot(verts[j].x - verts[j - 1].x, verts[j].z - verts[j - 1].z);
      }
      s += Math.hypot(p.x - a.x, p.z - a.z);
      return s;
    }
  }
  return t <= (verts[0] ? verts[0].t : 0) ? 0 : pl.total;
}

/**
 * 建道具。返回 THREE.Group（里面每种几何体一个 InstancedMesh）。
 * @param level  关卡数据（读 level.props / level.terrain 里的 palette）
 * @param verts  lines[0].verts（含末尾延伸到关卡结束的那一段）
 * @param opts   { roadWidth }
 */
export function buildProps(level, verts, opts = {}) {
  const group = new THREE.Group();
  group.name = "props";
  const rules = level.props;
  if (!Array.isArray(rules) || !rules.length || !verts || verts.length < 2) return group;

  const roadW = opts.roadWidth || level.roadWidth || 3;
  const pl = polyline(verts);
  // 弧长 → 时间（verts 上每个点都带 t；线性插值）
  const arcs = [0];
  for (let i = 1; i < verts.length; i++) {
    arcs.push(arcs[i - 1] + Math.hypot(verts[i].x - verts[i - 1].x, verts[i].z - verts[i - 1].z));
  }
  const timeAt = (s) => {
    if (s <= 0) return verts[0].t;
    const last = verts.length - 1;
    if (s >= arcs[last]) return verts[last].t;
    let lo = 0, hi = last;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (arcs[m] <= s) lo = m; else hi = m; }
    const k = (s - arcs[lo]) / Math.max(1e-6, arcs[hi] - arcs[lo]);
    return verts[lo].t + (verts[hi].t - verts[lo].t) * k;
  };
  const spec = level.terrain || {};
  const spanPal = (t) => {
    for (const s of spec.spans || []) {
      if (s.t && t >= s.t[0] && t <= s.t[1]) return s.palette || (spec.base && spec.base.palette) || null;
    }
    return (spec.base && spec.base.palette) || null;
  };

  // 收集所有实例：按几何体种类分组
  const bucket = {};
  let seed = 20261012;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  for (const r of rules) {
    if (!PROPS[r.kind]) continue;
    const s0 = r.t ? timeToArc(pl, verts, r.t[0]) : 0;
    const s1 = r.t ? timeToArc(pl, verts, r.t[1]) : pl.total;
    const every = Math.max(2, r.every || 20);
    const off0 = Array.isArray(r.off) ? r.off[0] : (r.off || 8);
    const off1 = Array.isArray(r.off) ? r.off[1] : (r.off || 8) + 12;
    const sc0 = Array.isArray(r.scale) ? r.scale[0] : (r.scale || 1);
    const sc1 = Array.isArray(r.scale) ? r.scale[1] : (r.scale || 1) * 1.3;
    const minOff = roadW / 2 + 1.6;         // 别站到路上
    let i = 0;
    for (let s = s0 + rnd() * every * 0.5; s < s1; s += every * (0.75 + rnd() * 0.5)) {
      const p = atArc(pl, s);
      const sides = r.side === "left" ? [-1] : r.side === "right" ? [1] : [1, -1];
      for (const side of sides) {
        if (sides.length === 2 && r.both === false && side === -1) continue;
        const n = r.cluster ? 1 + Math.floor(rnd() * (r.cluster[1] - r.cluster[0] + 1)) : 1;
        for (let c = 0; c < n; c++) {
          const off = Math.max(minOff, off0 + rnd() * (off1 - off0));
          const jx = (rnd() - 0.5) * (r.jitter == null ? 1.5 : r.jitter);
          const jz = (rnd() - 0.5) * (r.jitter == null ? 1.5 : r.jitter);
          const x = p.x + p.nx * side * off + jx;
          const z = p.z + p.nz * side * off + jz;
          const sc = sc0 + rnd() * (sc1 - sc0);
          const dy = r.dy || 0;
          // 道具自己的随机数流（同一个道具内一致）
          let sd = (s * 7919 + c * 104729 + (side + 1) * 9973 + i) >>> 0;
          const R = () => ((sd = (sd * 1103515245 + 12345) >>> 0) / 4294967296);
          const palName = r.palette || spanPal(timeAt(s)) || "default";
          const pal = PROP_COLORS[palName] || PROP_COLORS.default;
          const parts = PROPS[r.kind](R);
          for (const part of parts) {
            const key = part.geo;
            (bucket[key] = bucket[key] || []).push({
              x: x + 0, y: p.y + dy, z: z + 0,
              sx: part.scale[0] * sc, sy: part.scale[1] * sc, sz: part.scale[2] * sc,
              px: part.pos[0] * sc, py: part.pos[1] * sc, pz: part.pos[2] * sc,
              rotY: (part.rotY || 0) + (r.rotRandom === false ? 0 : R() * Math.PI * 2),
              color: pal[part.color] == null ? 0xcccccc : pal[part.color],
            });
          }
          i++;
        }
      }
    }
  }

  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const vp = new THREE.Vector3(), vs = new THREE.Vector3(), col = new THREE.Color();
  for (const key of Object.keys(bucket)) {
    const list = bucket[key];
    const mat = new THREE.MeshStandardMaterial({ roughness: GEO_ROUGH[key], metalness: 0.0 });
    const im = new THREE.InstancedMesh(GEOS[key], mat, list.length);
    im.name = "props-" + key;
    im.frustumCulled = false;
    for (let k = 0; k < list.length; k++) {
      const o = list[k];
      e.set(0, o.rotY, 0);
      q.setFromEuler(e);
      // 局部偏移要跟着 rotY 转（否则树冠会歪）
      const lx = o.px * Math.cos(o.rotY) + o.pz * Math.sin(o.rotY);
      const lz = -o.px * Math.sin(o.rotY) + o.pz * Math.cos(o.rotY);
      vp.set(o.x + lx, o.y + o.py, o.z + lz);
      vs.set(o.sx, o.sy, o.sz);
      m4.compose(vp, q, vs);
      im.setMatrixAt(k, m4);
      im.setColorAt(k, col.setHex(o.color));
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    group.add(im);
  }
  group.userData.count = Object.values(bucket).reduce((a, b) => a + b.length, 0);
  return group;
}
