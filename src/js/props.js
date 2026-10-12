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
import { DEFAULT_PARAMS } from "./terrain.js";

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

  // 花：**贴地**的小花片（真实关卡的花是"趴在地上"的，不是立在地上的模型）
  flower(R) {
    const h = 0.22 + R() * 0.16;
    const out = [{ geo: "cyl", pos: [0, h / 2, 0], scale: [0.06, h, 0.06], color: "foliage" }];
    const petal = 0.3 + R() * 0.14;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + R() * 0.4;
      out.push({
        geo: "sphere", color: "bloom",
        pos: [Math.cos(a) * petal * 0.8, h + 0.02, Math.sin(a) * petal * 0.8],
        scale: [petal * 1.7, petal * 0.45, petal * 1.7],
      });
    }
    out.push({ geo: "sphere", pos: [0, h + 0.06, 0], scale: [0.15, 0.12, 0.15], color: "accent" });
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

  // 高矮柱：光秃秃的柱子，靠"成列"产生速度感（真实关卡里最常见的结构件之一）
  column(R) {
    const h = 1.8 + R() * 3.2;
    const w = 0.42 + R() * 0.7;
    const out = [
      { geo: "box", pos: [0, h / 2, 0], scale: [w, h, w], color: "stone" },
    ];
    if (R() < 0.45) out.push({ geo: "box", pos: [0, h + 0.18, 0], scale: [w * 1.5, 0.36, w * 1.5], color: "accent" });
    return out;
  },

  // 贴地色块：一大片很薄的方板铺在地上（真实关卡里"田块/花海"就是这么做的，
  // 是**最省成本**的"看起来有东西"，地面立刻不像一张纯色纸）
  patch(R) {
    const w = 3.5 + R() * 5.5, d = 3.5 + R() * 5.5;
    return [{
      geo: "box", color: R() < 0.5 ? "bloom" : "accent",
      pos: [0, 0.07, 0], scale: [w, 0.14, d], rotY: R() * Math.PI,
    }];
  },

  // 万能方块：一个 Box + 非等比 scale（沙块/雪块/城市块通用）
  block(R) {
    const w = 0.9 + R() * 1.8, h = 0.6 + R() * 2.4, d = 0.9 + R() * 1.8;
    return [{ geo: "box", color: "stone", pos: [0, h / 2, 0], scale: [w, h, d], rotY: R() * Math.PI }];
  },

  // 草丛：3~4 片细长三角面片（真实关卡里"贴地的小东西"都是面片，不是立体模型）
  grass(R) {
    const out = [];
    const n = 3 + Math.floor(R() * 2);
    for (let i = 0; i < n; i++) {
      const h = 0.45 + R() * 0.5;
      const a = (i / n) * Math.PI * 2 + R() * 0.7;
      out.push({
        geo: "cone", color: "foliage",
        pos: [Math.cos(a) * 0.22, h / 2, Math.sin(a) * 0.22],
        scale: [0.16, h, 0.1],
        rotY: a,
      });
    }
    return out;
  },

  // 栅栏：两立柱 + 两条横杆（一段 2m 宽，局部 X 沿路方向，可以成列拼成长栅栏）
  fence(R) {
    const w = 1.4, h = 1.0 + R() * 0.3;
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

  // 巨型剪影：官方每关几乎都有一两件 15~30 倍路宽的大结构（学习结论 R17），
  // 用来当"一段一个地标"。三段收分：方碑基座 + 棱锥中段 + 尖顶，颜色跟段落色卡走，
  // 所以放在哪一段就自动是哪一段的材质。总高 54~60m ≈ 路宽的 18~20 倍。
  giant(R) {
    const w = 7.5 + R() * 2.5;        // 基座宽 ≈ 2.5~3.4 路宽
    const h1 = 26 + R() * 8;
    const h2 = 16 + R() * 6;
    const h3 = 12 + R() * 6;
    return [
      { geo: "box", pos: [0, h1 / 2, 0], scale: [w, h1, w * 0.86], color: "stone", rotY: R() * 0.6 },
      { geo: "oct", pos: [0, h1 + h2 / 2, 0], scale: [w * 0.66, h2, w * 0.6], color: "stone" },
      { geo: "cone", pos: [0, h1 + h2 + h3 / 2, 0], scale: [w * 0.5, h3, w * 0.5], color: "accent" },
    ];
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

  // 跨路牌楼/门洞：两根柱子立在路两侧 + 横梁压在头顶（真实关卡里"换段"的地方
  // 常放这种跨路建筑——它同时是地标、是分段的标点、也是"这关有设计"的证据）。
  // ⚠️ 摆放时必须给规则写 "center": true（否则 row 分支会把 off 抬到 roadW/2+0.9）
  //    和 "skipCorner": true（横梁是长构件，落在 90° 转角上会斜着卡在路口）。
  arch(R) {
    const clear = 4.6;                       // 两柱中心距，柱内侧净宽 ≈ 3.9m（路宽 3m）
    const h = 4.2 + R() * 1.0;
    const cw = 0.62 + R() * 0.2;
    const out = [
      { geo: "box", pos: [0, h / 2, -clear / 2], scale: [cw, h, cw], color: "stone" },
      { geo: "box", pos: [0, h / 2, clear / 2], scale: [cw, h, cw], color: "stone" },
      { geo: "box", pos: [0, h + 0.42, 0], scale: [cw * 1.7, 0.84, clear + 1.5], color: "stone" },
      { geo: "box", pos: [0, h + 1.02, 0], scale: [cw * 2.4, 0.36, clear + 2.3], color: "accent" },
    ];
    if (R() < 0.5) out.push({ geo: "box", pos: [0, h + 1.42, 0], scale: [cw * 1.2, 0.42, clear + 0.9], color: "stone" });
    return out;
  },

  // 石灯笼：方基础 + 柱 + 灯室 + 攒尖顶（中国园林那套模具，用来当路边的"小型地标"）
  lantern(R) {
    const b = 0.8;
    return [
      { geo: "box", pos: [0, 0.1, 0], scale: [b * 1.5, 0.2, b * 1.5], color: "stone" },
      { geo: "box", pos: [0, 0.42, 0], scale: [b * 0.9, 0.5, b * 0.9], color: "stone" },
      { geo: "box", pos: [0, 1.06, 0], scale: [b * 1.35, 0.62, b * 1.35], color: "accent" },
      { geo: "cone", pos: [0, 1.62, 0], scale: [b * 1.9, 0.5, b * 1.9], color: "stone" },
      { geo: "sphere", pos: [0, 1.92, 0], scale: [b * 0.34, b * 0.34, b * 0.34], color: "stone" },
    ];
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
  rose:  { foliage: 0x4f8f5f, wood: 0x7a5230, stone: 0xc9c2bb, bloom: 0xf3a7c6, accent: 0xf7e08a, ground: 0xd08aa8 },
  plum:  { foliage: 0x4a7f6a, wood: 0x5c4030, stone: 0xb9b0b6, bloom: 0xd98bb4, accent: 0xf2d98a, ground: 0x8a6480 },
  sand:  { foliage: 0x6f8c46, wood: 0x7a5a34, stone: 0xd8c9a8, bloom: 0xe8a06a, accent: 0xf6e2a8, ground: 0xe4d0a4 },
  ice:   { foliage: 0x4d8f96, wood: 0x6b7a86, stone: 0xe6f0f4, bloom: 0x9fd6e8, accent: 0xfdfbf6, ground: 0xa9c8dc },
  jade:  { foliage: 0x3f8f63, wood: 0x6d5334, stone: 0xcbd8cd, bloom: 0xf0c0d0, accent: 0xf6e6a0, ground: 0xa8cfae },
  cream: { foliage: 0x8f9c7a, wood: 0x8a7a60, stone: 0xf2ece0, bloom: 0xd9c9b0, accent: 0xf7e8c0, ground: 0xefe0c4 },
  // 没有指定色卡时（跟着主题走的段）用这套中性色
  default: { foliage: 0x6f9e6a, wood: 0x7a5230, stone: 0xc9c2bb, bloom: 0xefa7c5, accent: 0xf7e08a, ground: 0xd89ab0 },
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
 * 每种道具的「占地半径」（scale = 1 时，单位米）。摆放时靠它做两件事：
 *   ① 同一条规则内相邻实例不许互相咬进去；
 *   ② **不同规则之间也不许**——之前 33 条规则各自独立地在互相重叠的 off 区间里撒点
 *      （花 4.4~5.2 / 灌木 5~5.9 / 水晶 5.2~5.9 / 岩石 9.6~12.6 / 树 11.5~16.5 …），
 *      于是石头长在树里、水晶长在灌木里，就是发起人看到的「穿模」。
 * 数字取各道具的实际横向最大外廓（树冠 / 松枝 / 云团 / 牌楼净跨等）。
 */
const PROP_R = {
  tree: 1.35, pine: 1.2, bush: 0.8, rock: 1.0, crystal: 0.55,
  flower: 0.32, grass: 0.28, mushroom: 0.36, cloudlet: 1.3, block: 0.7,
  fence: 0.32, column: 0.5, lamp: 0.32, note: 0.35, arch: 2.0,
  patch: 0.2, giant: 4.0,
};

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
  // 每种母题"离路多远的地面还是平的"（米）。道具的 off 必须落在这个半径内，
  // 否则会飘在空中（地面早就在这一侧退台/掉下去了）——这是最早踩过的坑，
  // 现在改成**由地形参数自己算出来**，不再靠人工在关卡里试数字。
  const FLAT_OF = {
    deck:     (P) => P.walk / 2 + P.shelf,      // 台面 + 一圈矮台
    canyon:   (P) => P.plateauW - 1.2,          // 两侧高台顶面（配 dy = hi）
    terraces: () => 6.0,                        // ⚠️ 主台是"一串圆盘"，gap 必须 < 2*最小半径
    islands:  () => 6.0,                        //    （gap 10 / 最小半径 8.2）台面才连成一片
    cloud:    (P) => P.plateW - 1.2,            // 云海宽板
  };
  const spanFlat = (t) => {
    let sp = null;
    for (const s of spec.spans || []) if (s.t && t >= s.t[0] && t <= s.t[1]) { sp = s; break; }
    const motif = sp ? sp.motif : (spec.base && spec.base.motif);
    const P = Object.assign({}, DEFAULT_PARAMS[motif] || {}, (spec.base && spec.base.params) || {}, (sp && sp.params) || {});
    const f = (FLAT_OF[motif] || (() => 10))(P);
    return sp && sp.flat != null ? sp.flat : f;
  };

  // 收集所有实例：按几何体种类分组
  const bucket = {};
  let seed = 20261012;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  // ── 占用格：治「穿模」的全局互斥 ────────────────────────────────────
  // 官方关卡的物件稀疏且互相让位（R12/R40：画面里东西不多但很大）。我们过去是
  // 每条规则各自在重叠的 off 带里独立撒点，不同规则之间没有任何约束，于是互相咬进去。
  // 这里按 2.5m 的格子登记已经放下的东西，新物件只要和任何一件「半径之和」相交就不放。
  // 注意 occupy 是在 pack 之前调用，所以同一条规则内部也自动拉开距离。
  const CELL = 2.5;
  const occ = new Map();
  const cellKey = (x, z) => Math.round(x / CELL) + "," + Math.round(z / CELL);
  const freeAt = (x, z, rad) => {
    const cx = Math.round(x / CELL), cz = Math.round(z / CELL);
    for (let ix = -1; ix <= 1; ix++) {
      for (let iz = -1; iz <= 1; iz++) {
        const arr = occ.get(cx + ix + "," + (cz + iz));
        if (!arr) continue;
        for (const o of arr) {
          const dx = o.x - x, dz = o.z - z, rr = o.r + rad;
          if (dx * dx + dz * dz < rr * rr) return false;
        }
      }
    }
    return true;
  };
  const occupy = (x, z, rad) => {
    const k = cellKey(x, z);
    let arr = occ.get(k);
    if (!arr) { arr = []; occ.set(k, arr); }
    arr.push({ x, z, r: rad });
  };
  const radOf = (kind, sc) => (PROP_R[kind] || 0.8) * sc;

  // 把一个道具零件塞进对应几何体的桶里（slot = 规则级颜色槽覆盖，用于"这一列全是草绿"这种）
  const pack = (part, sc, wx, wy, wz, rotY, pal, slot) => {
    const hex = slot != null ? pal[slot] : pal[part.color];
    (bucket[part.geo] = bucket[part.geo] || []).push({
      x: wx, y: wy, z: wz,
      sx: part.scale[0] * sc, sy: part.scale[1] * sc, sz: part.scale[2] * sc,
      px: part.pos[0] * sc, py: part.pos[1] * sc, pz: part.pos[2] * sc,
      rotY: (part.rotY || 0) + rotY,
      color: hex == null ? 0xcccccc : hex,
    });
  };

  for (const r of rules) {
    if (!PROPS[r.kind]) continue;
    const s0 = r.t ? timeToArc(pl, verts, r.t[0]) : 0;
    const s1 = r.t ? timeToArc(pl, verts, r.t[1]) : pl.total;
    const every = Math.max(2, r.every || 20);
    const off0 = Array.isArray(r.off) ? r.off[0] : (r.off || 8);
    const off1 = Array.isArray(r.off) ? r.off[1] : (r.off || 8) + 12;
    const sc0 = Array.isArray(r.scale) ? r.scale[0] : (r.scale || 1);
    const sc1 = Array.isArray(r.scale) ? r.scale[1] : (r.scale || 1) * 1.3;
  const minOff0 = roadW / 2 + 1.6;         // 别站到路上
  const ROW_SMOOTH = 5.0;                  // 「成列」用的平滑半径（米），见下面 row 分支的注释
    let i = 0;

    // ── 「成列」模式：沿路等距排成一条线（真实关卡里栏杆/柱子/琴槌都是这么排的，
    //    是速度感的主要来源；散点摆放给不了这个）。间距默认 3m ≈ 一个路块。
    if (r.row) {
      const step = Math.max(1.6, r.every || 3.0);
      // center：长构件（跨路牌楼）要骑在路中线上，不能被抬到路肩外
      const roff = r.center ? 0 : Math.max(roadW / 2 + 0.9, off0);
      const sides = r.side === "left" ? [-1] : r.side === "right" ? [1] : [1, -1];
      // 让零件的局部 +X 沿着路的切线方向（栅栏才能接成一条长栏杆）
      for (const side of sides) {
        for (let s = s0; s < s1; s += step) {
          // ⚠️ 这条路是"每拍一个 90° 转角"，直接取 s 处的切线会让每一段栅栏转 90°、整列变成锯齿。
          // 所以位置和方向都取自"跨 ±ROW_SMOOTH 米的平均"——列才是顺的。
          const p = atArc(pl, s);
          const pa = atArc(pl, Math.max(0, s - ROW_SMOOTH));
          const pb = atArc(pl, Math.min(pl.total, s + ROW_SMOOTH));
          let dx = pb.x - pa.x, dz = pb.z - pa.z;
          const dl = Math.hypot(dx, dz) || 1;
          dx /= dl; dz /= dl;
          // skipCorner：长构件落在转角上会斜着卡在路口，直接不放
          if (r.skipCorner) {
            const ca = atArc(pl, Math.max(0, s - 1.6));
            const cb = atArc(pl, Math.min(pl.total, s + 1.6));
            let lx = cb.x - ca.x, lz = cb.z - ca.z;
            const ll = Math.hypot(lx, lz) || 1;
            lx /= ll; lz /= ll;
            if (dx * lx + dz * lz < Math.cos(0.34)) continue;   // 与局部切线差 >20°
          }
          const nx = dz, nz = -dx;                       // 平滑后的右法线
          const cx = (pa.x + pb.x) / 2, cz = (pa.z + pb.z) / 2;
          const rot = Math.atan2(-dz, dx) + (r.rotRandom ? (rnd() - 0.5) * 0.2 : 0);
          const sc = sc0 + rnd() * (sc1 - sc0);
          const rad = radOf(r.kind, sc);
          // 大件（树/云团）的半径要算进"离路多远"，否则树冠会伸到路面上
          const roffI = r.center ? 0 : Math.max(roff, roadW / 2 + rad + 0.4);
          const x = cx + nx * side * roffI;
          const z = cz + nz * side * roffI;
          if (!r.center && !freeAt(x, z, rad)) continue;   // 和已放下的东西咬在一起 → 不放
          occupy(x, z, rad);
          let sd = (s * 7919 + (side + 1) * 9973 + i) >>> 0;
          const R = () => ((sd = (sd * 1103515245 + 12345) >>> 0) / 4294967296);
          const palName = r.palette || spanPal(timeAt(s)) || "default";
          const pal = PROP_COLORS[palName] || PROP_COLORS.default;
          const yy = (pa.y + pb.y) / 2 + (r.dy || 0);
          for (const part of PROPS[r.kind](R)) pack(part, sc, x, yy, z, rot, pal, r.slot);
          i++;
        }
      }
      continue;
    }

    // ── 散点/条带模式 ──────────────────────────────────────────────────
    // 真实关卡里一侧的景物是**沿路的两三条固定车道**（"树在 7m 和 11m 两条线上"），
    // 不是在一个区间里乱撒——乱撒就是"摆放杂乱"的来源。所以这里：
    //   · off 被量化成 lanes 条固定车道（等分 off 区间、再吸附到 grid 的整数倍）；
    //   · 沿路以 every 为步长 + 少量沿路抖动 jitterS；
    //   · 每处可成簇 cluster，簇内横向散布只有 spread（默认 0.7m）；
    //   · off 一律被 spawnFlat 夹住（见 spanFlat：超出平地半径一定会飘）。
    const grid = r.grid || 0.5;
    const lanes = Math.max(1, Math.round(r.lanes || (off1 > off0 + 0.6 ? 3 : 1)));
    const laneOff = [];
    for (let k = 0; k < lanes; k++) {
      const f = lanes === 1 ? 0 : k / (lanes - 1);
      laneOff.push(Math.round((off0 + (off1 - off0) * f) / grid) * grid);
    }
    const jS = r.jitterS == null ? every * 0.3 : r.jitterS;
    const spread = r.spread == null ? 0.7 : r.spread;
    let n0 = 0;
    for (let s = s0 + (r.phase == null ? every * 0.5 : r.phase); s < s1; s += every) {
      const sides = r.side === "left" ? [-1] : r.side === "right" ? [1] : [1, -1];
      for (const side of sides) {
        if (sides.length === 2 && r.both === false && side === -1) continue;
        const ss = Math.min(pl.total, Math.max(0, s + (rnd() - 0.5) * 2 * jS));
        const p = atArc(pl, ss);
        const flatMax = Math.max(minOff0, spanFlat(timeAt(ss)) - 0.7);
        const n = r.cluster ? r.cluster[0] + Math.floor(rnd() * (r.cluster[1] - r.cluster[0] + 1)) : 1;
        // 一处只挑一条车道：同处的东西成"一撮"，整体看是几条顺路的带子
        const lane = r.lane != null ? Math.min(lanes - 1, r.lane) : (n0 + (side > 0 ? 0 : 1)) % lanes;
        for (let c = 0; c < n; c++) {
          const sc = sc0 + rnd() * (sc1 - sc0);
          const rad = radOf(r.kind, sc);
          // 每件东西自己的"离路下限"：小件贴路、大件（树/云团/岩）要按半径让开路面
          const minOffK = Math.max(minOff0, roadW / 2 + rad + 0.4);
          const off = Math.max(minOffK, Math.min(flatMax, laneOff[lane] + (rnd() - 0.5) * spread));
          const x = p.x + p.nx * side * off;
          const z = p.z + p.nz * side * off;
          const dy = r.dy || 0;
          if (!freeAt(x, z, rad)) continue;               // 和已放下的东西咬在一起 → 不放
          occupy(x, z, rad);
          // 道具自己的随机数流（同一个道具内一致）
          let sd = (s * 7919 + c * 104729 + (side + 1) * 9973 + i) >>> 0;
          const R = () => ((sd = (sd * 1103515245 + 12345) >>> 0) / 4294967296);
          const palName = r.palette || spanPal(timeAt(ss)) || "default";
          const pal = PROP_COLORS[palName] || PROP_COLORS.default;
          const parts = PROPS[r.kind](R);
          for (const part of parts) {
            pack(part, sc, x, p.y + dy, z,
              (part.rotY || 0) + (r.rotRandom === false ? 0 : R() * Math.PI * 2), pal, r.slot);
          }
          i++;
        }
      }
      n0++;
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
