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
  blade: new THREE.ConeGeometry(0.5, 1, 3),           // 三棱锥＝草叶（官方草是细长三角面片，不是圆锥）
  ball8: new THREE.IcosahedronGeometry(0.5, 0),       // 20 面球＝官方树冠/灌木的原始件
};
const GEO_ROUGH = { box: 0.9, sphere: 0.95, cyl: 0.85, cone: 0.9, oct: 0.8, blade: 0.95, ball8: 0.95 };

// ═══ 精细度：专用几何体 + 每型多变体 ═══════════════════════════════════════
// 过去的道具全是"球/柱/锥裸拼"：一棵树 = 一根等粗圆柱 + 3 个一模一样的球。
// 于是同一段里几十棵树是**同一个形状的复制品** —— 无论怎么摆都透着"粗制滥造"。
// 官方做法（研究结论 R16/R19/R40）是"低多边形 + 明显棱面 + 零件多而大"，
// 这里补三件事：
//   1) **专用形状**：叶团 / 树干 / 岩石 / 松塔 / 水晶各有自己的几何体，不再公用球柱；
//   2) **每型 4 个变体**：顶点按种子抖动，同段内每株都不同，消掉"复制粘贴感"；
//   3) 形状本身带**结构**：树干有收分与板根、岩石底面切平、松塔边缘带锯齿。
// 变体在打包时按几何体名分开成不同的 InstancedMesh，所以变体多也不会掉帧。
const VN = 4;
function mulberry(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// 按**顶点位置**变形：这些几何体是非索引的（每个三角形有自己的顶点），
// 逐顶点独立抖动会把三角形撕开 —— 同一位置必须共用同一个随机数。
function deform(geo, seed, fn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position, seen = new Map(), rnd = mulberry(seed);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const key = x.toFixed(4) + "|" + y.toFixed(4) + "|" + z.toFixed(4);
    let r = seen.get(key);
    if (r === undefined) { r = rnd(); seen.set(key, r); }
    const q = fn(x, y, z, r);
    p.setXYZ(i, q[0], q[1], q[2]);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();     // 非索引几何体 → 逐面法线，天然是"硬边低多边形"
  return g;
}

// 叶团：**20 面**多面体球（detail=0，官方就是 IcosahedronGeometry(r,0)）+ 强抖动（±24%）
// 上宽下略收 —— 20 面 + 硬边才是"低多边形块面"，detail=1（80 面）会读成"皱纸"。
const mkCanopy = (seed) => deform(new THREE.IcosahedronGeometry(0.5, 0), seed,
  (x, y, z, r) => { const m = 1 + (r * 2 - 1) * 0.24; return [x * m, y * m * 1.04, z * m]; });
// 岩石：抖动更大 + 底面切平（官方石头是"坐"在地上的一整块，不是浮着的球）
const mkRock = (seed) => deform(new THREE.IcosahedronGeometry(0.5, 0), seed,
  (x, y, z, r) => { const m = 1 + (r * 2 - 1) * 0.34; return [x * m, Math.max(y * m, -0.16) * 0.94, z * m]; });
// 树干：锥形收分 + 根部板根外扩 + 轻微弯曲（不再是根等粗圆柱）
const mkTrunk = (seed) => {
  const bx = (mulberry(seed + 31)() * 2 - 1) * 0.11, bz = (mulberry(seed + 57)() * 2 - 1) * 0.11;
  return deform(new THREE.CylinderGeometry(0.17, 0.24, 1, 7, 5), seed,
    (x, y, z, r) => {
      const t = y + 0.5;                                   // 0 根 → 1 顶
      const flare = t < 0.18 ? 1 + (0.18 - t) * 3.2 : 1;   // 板根
      const m = (1 + (r * 2 - 1) * 0.07) * flare;
      return [x * m + bx * t * t, y, z * m + bz * t * t];
    });
};
// 松塔：圆锥 + 边缘锯齿（官方针叶树是一层层"手工剪出来"的锥，不是光滑喇叭）
const mkTier = (seed) => deform(new THREE.ConeGeometry(0.5, 1, 9, 2), seed,
  (x, y, z, r) => {
    const t = y + 0.5;
    const jag = 1 + (r * 2 - 1) * 0.17 * (1 - t);
    return [x * jag, y + (r * 2 - 1) * 0.035, z * jag];
  });
// 水晶：八面体拉长 + 棱角抖动（细长有切割感，不是牙签）
const mkCrystal = (seed) => deform(new THREE.OctahedronGeometry(0.5, 0), seed,
  (x, y, z, r) => { const m = 1 + (r * 2 - 1) * 0.15; return [x * m * 0.9, y * m, z * m * 0.9]; });

const VGEO = { canopy: mkCanopy, rock: mkRock, trunk: mkTrunk, tier: mkTier, crystal: mkCrystal };
const VROUGH = { canopy: 0.95, rock: 0.92, trunk: 0.9, tier: 0.95, crystal: 0.5 };
const VFLAT = new Set();      // 这些几何体用硬边材质（低多边形观感的关键）
for (const name of Object.keys(VGEO)) {
  for (let v = 0; v < VN; v++) {
    const key = name + v;
    GEOS[key] = VGEO[name](2200 + v * 977 + name.length * 137);
    GEO_ROUGH[key] = VROUGH[name];
    VFLAT.add(key);
  }
}
// 道具定义里取变体：同一件道具内部稳定，不同实例/不同次调用不同
const V = (name, R) => name + Math.floor(R() * VN);

/* ---------------------------------------------------------------------------
   道具定义
   每个函数返回一组 {geo, pos:[x,y,z], scale:[sx,sy,sz], rotY?, color}
   · y = 0 是地面，道具必须从 0 往上长
   · R 是 [0,1) 随机数函数（同一个道具实例内用同一个 R，所以形态稳）
   --------------------------------------------------------------------------- */
export const PROPS = {
  // 阔叶树：官方是"一树两件"—— 收分树干 + **1~3 块**叶团（1 块最常见，阔叶最多 5 块），
  // 有叶的树**不加分枝**（分枝是枯树/古树才有的），所以这里只叠叶团、不做枝。
  tree(R) {
    const h = 2.3 + R() * 2.1;                 // 树干高
    const r = 1.15 + R() * 0.72;               // 树冠尺度
    const out = [{ geo: V("trunk", R), pos: [0, h / 2, 0], scale: [0.46, h, 0.46], color: "wood" }];
    // 主冠：1 块大的 + 0~2 块小的贴着它（"一簇块"而不是一个球，也不是一堆碎球）
    const nLobe = 1 + Math.floor(R() * 3);
    const topY = h + r * 0.42;
    for (let i = 0; i < nLobe; i++) {
      const a = (i / Math.max(1, nLobe)) * Math.PI * 2 + R() * 1.1;
      const d = i === 0 ? 0 : r * (0.34 + R() * 0.4);
      const s = r * (i === 0 ? 1.0 : 0.5 + R() * 0.3);
      const dy = i === 0 ? 0 : (R() - 0.4) * r * 0.75;
      out.push({
        geo: V("canopy", R), pos: [Math.cos(a) * d, topY + dy, Math.sin(a) * d],
        scale: [s * 2.7, s * 2.15, s * 2.7], rotY: R() * 6.28,
        color: (i === 0 || dy > -r * 0.05) ? "foliage" : "foliageLo",   // 顶亮底暗
      });
    }
    return out;
  },

  // 松树：树干 + 3~4 层带锯齿的锥（越往上越小、层间有重叠），下层压暗
  pine(R) {
    const h = 1.5 + R() * 1.3;
    const out = [{ geo: V("trunk", R), pos: [0, h / 2, 0], scale: [0.40, h, 0.40], color: "wood" }];
    const n = 3 + (R() < 0.45 ? 1 : 0);
    let y = h * 0.62;
    const w0 = 4.0 + R() * 1.0;
    for (let i = 0; i < n; i++) {
      const ch = 2.2 + R() * 0.6, sw = w0 * (1 - i * 0.19);
      out.push({
        geo: V("tier", R), pos: [0, y + ch / 2, 0], scale: [sw, ch, sw],
        rotY: R() * 6.28, color: i >= n - 2 ? "foliage" : "foliageLo",
      });
      y += ch * 0.45;                    // 重叠 ~55%：层与层咬住才有"一整棵树"的感觉
    }
    return out;
  },

  // 果树：在树冠上挂几个"果子"（树冠中心按叶团实际位置算，树的结构改了这里不用跟着改）
  appleTree(R) {
    const out = PROPS.tree(R);
    let cx = 0, cy = 0, cz = 0, m = 0, rad = 1;
    for (const p of out) {
      if (!p.color || !p.color.startsWith("foliage")) continue;
      cx += p.pos[0]; cy += p.pos[1]; cz += p.pos[2]; m++;
      rad = Math.max(rad, p.scale[0] / 2);
    }
    if (!m) return out;
    cx /= m; cy /= m; cz /= m;
    const n = 3 + Math.floor(R() * 4);
    for (let i = 0; i < n; i++) {
      const a = R() * Math.PI * 2, b = (R() - 0.25) * 1.4, d = rad * (0.72 + R() * 0.33);
      out.push({
        geo: "sphere", color: "bloom",
        pos: [cx + Math.cos(a) * Math.cos(b) * d, cy + Math.sin(b) * d * 0.8, cz + Math.sin(a) * Math.cos(b) * d],
        scale: [0.44, 0.44, 0.44],
      });
    }
    return out;
  },

  // 灌木：4~6 个小叶团挤成一丛，底下压一层暗色（坐在地上的一坨，不是飘着的球）
  bush(R) {
    const out = [];
    const base = 0.55 + R() * 0.3;
    out.push({ geo: V("canopy", R), pos: [0, base * 0.5, 0], scale: [base * 2.6, base * 1.5, base * 2.6], rotY: R() * 6.28, color: "foliageLo" });
    const n = 3 + Math.floor(R() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + R() * 1.1;
      const d = base * (0.35 + R() * 0.6);
      const s = base * (0.85 + R() * 0.65);
      out.push({
        geo: V("canopy", R), color: "foliage",
        pos: [Math.cos(a) * d, base * (0.7 + R() * 0.5), Math.sin(a) * d],
        scale: [s * 2.1, s * 1.8, s * 2.1], rotY: R() * 6.28,
      });
    }
    return out;
  },

  // 石头：1~4 块底面切平的多面岩（顶块亮、压在下层的暗），像"坐在地上的一堆"
  rock(R) {
    const out = [];
    const n = 1 + Math.floor(R() * 4);
    // 先放最大的一块当主岩，再在旁边挤小的
    for (let i = 0; i < n; i++) {
      const s = (i === 0 ? 0.95 + R() * 0.7 : 0.5 + R() * 0.7);
      out.push({
        geo: V("rock", R), color: i === 0 ? "stone" : (R() < 0.5 ? "stoneLo" : "stone"),
        pos: [(R() - 0.5) * 2.0, s * 0.42, (R() - 0.5) * 2.0],
        scale: [s * 1.85, s * 1.5, s * 1.65],
        rotY: R() * Math.PI * 1.6, rotZ: (R() - 0.5) * 0.3,
      });
    }
    return out;
  },

  // 花：**贴地**的小花片 + 一对叶子（真实关卡的花是"趴在地上"的，不是立着的模型）
  flower(R) {
    const h = 0.22 + R() * 0.16;
    const out = [{ geo: "cyl", pos: [0, h / 2, 0], scale: [0.06, h, 0.06], color: "foliage" }];
    for (let i = 0; i < 2; i++) {
      const a = R() * 6.28;
      out.push({
        geo: V("canopy", R), color: "foliage", rotY: R() * 6.28,
        pos: [Math.cos(a) * 0.16, h * 0.45, Math.sin(a) * 0.16],
        scale: [0.42, 0.12, 0.3],
      });
    }
    const petal = 0.3 + R() * 0.14;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + R() * 0.4;
      out.push({
        geo: V("canopy", R), color: "bloom", rotY: a,
        pos: [Math.cos(a) * petal * 0.8, h + 0.02, Math.sin(a) * petal * 0.8],
        scale: [petal * 1.7, petal * 0.5, petal * 1.7],
      });
    }
    out.push({ geo: "sphere", pos: [0, h + 0.06, 0], scale: [0.16, 0.13, 0.16], color: "accent" });
    return out;
  },

  // 蘑菇：带收分的杆 + 伞盖 + 伞下的菌褶（一层压暗的薄片）
  mushroom(R) {
    const h = 0.55 + R() * 0.55;
    const cw = 0.75 + R() * 0.4;
    return [
      { geo: V("trunk", R), pos: [0, h / 2, 0], scale: [0.26, h, 0.26], rotY: R() * 6.28, color: "wood" },
      { geo: "cyl", pos: [0, h - 0.03, 0], scale: [cw * 0.92, 0.07, cw * 0.92], color: "woodLo" },
      { geo: V("canopy", R), pos: [0, h + 0.06, 0], scale: [cw * 1.25, cw * 0.8, cw * 1.25], rotY: R() * 6.28, color: "bloom" },
    ];
  },

  // 高矮柱：柱础 + 柱身（微收分）+ 柱头 —— 三段式才像"建筑构件"，不是插了根方棍
  column(R) {
    const h = 1.8 + R() * 3.4;
    const w = 0.42 + R() * 0.68;
    const out = [
      { geo: "box", pos: [0, 0.09, 0], scale: [w * 1.5, 0.18, w * 1.5], color: "stoneLo" },      // 柱础
      { geo: "box", pos: [0, 0.18 + (h - 0.18) / 2, 0], scale: [w, h - 0.18, w], color: "stone" },
    ];
    if (R() < 0.6) out.push({ geo: "box", pos: [0, h + 0.12, 0], scale: [w * 1.42, 0.24, w * 1.42], color: "stone" });   // 柱头
    if (R() < 0.4) out.push({ geo: "box", pos: [0, h + 0.34, 0], scale: [w * 1.1, 0.2, w * 1.1], color: "accent" });
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

  /* ── ETW29「驻足的宁静」的摆件：**只有长方体** ──────────────────────────
     报告原话："只改 position/rotation/scale 就能从『散落石板』变成『柱林』"。
     所以这里不做圆的、不做树、不做结构件——只有 平躺板 / 斜板 / 竖柱 三种姿态，
     加上两件纯点缀（白色小方块、蓝色小点）。这就是那一关**全部的道具**。 */

  // 平躺石板：宽而薄；35% 会**悬浮**在板面上方（那一关段 1 的标志画面）
  slabB(R) {
    const w = 2.2 + R() * 7.0, d = 1.8 + R() * 5.0, t = 0.5 + R() * 1.1;
    const lift = R() < 0.35 ? t * (0.9 + R() * 1.8) : 0;
    return [{
      geo: "box", color: ["blue0", "blue1", "blue2"][(R() * 3) | 0],
      pos: [(R() - 0.5) * 1.4, lift + t / 2, (R() - 0.5) * 1.4],
      scale: [w, t, d], rotY: R() * Math.PI,
    }];
  },

  // 斜板：立起来但歪 15~40°，制造"整块板被切碎"的体量（段 2 的一半靠它）
  wallB(R) {
    const w = 2.6 + R() * 6.0, h = 3.0 + R() * 8.0, t = 0.5 + R() * 0.9;
    const tilt = (0.26 + R() * 0.44) * (R() < 0.5 ? 1 : -1);
    return [{
      geo: "box", color: R() < 0.5 ? "blue1" : "blue2",
      pos: [(R() - 0.5) * 0.8, (h / 2) * Math.cos(tilt) + 0.25, (R() - 0.5) * 0.8],
      scale: [w, h, t], rotY: R() * Math.PI, rotX: tilt,
    }];
  },

  // 竖柱：柱林用（段 2 的主景）。高 5~21m＝1.7~7 倍路宽，40% 顶端再叠一小块（断柱感）
  pillarB(R) {
    const w = 1.4 + R() * 2.6, h = 5.0 + R() * 16.0;
    const out = [{
      geo: "box", color: R() < 0.5 ? "blue1" : "blue2",
      pos: [0, h / 2, 0], scale: [w, h, w * (0.7 + R() * 0.6)], rotY: R() * Math.PI,
    }];
    if (R() < 0.4) out.push({
      geo: "box", color: "blue0",
      pos: [(R() - 0.5) * w * 0.5, h + 0.4, (R() - 0.5) * w * 0.5],
      scale: [w * 0.8, 0.8, w * 0.8], rotY: R() * Math.PI,
    });
    return out;
  },

  // 白色小方块（一屏 0~8 个）：纯粹用来打破板面的空旷
  cubeW(R) {
    const s = 0.5 + R() * 1.1;
    return [{ geo: "box", color: "white", pos: [0, s / 2, 0], scale: [s, s, s], rotY: R() * Math.PI }];
  },

  // 蓝色小点（一屏 0~8 个）
  dotB(R) {
    const s = 0.5 + R() * 0.9;
    return [{ geo: "ball8", color: "blue1", pos: [0, s * 0.4, 0], scale: [s, s * 0.8, s] }];
  },

  // 草丛：**3~9 片细长三角面片**从一点向外发散（官方草簇就是面片，不是圆锥尖刺）
  grass(R) {
    const out = [];
    const n = 4 + Math.floor(R() * 5);
    for (let i = 0; i < n; i++) {
      const h = 0.38 + R() * 0.42;
      const a = (i / n) * Math.PI * 2 + R() * 0.9;
      out.push({
        geo: "blade", color: R() < 0.34 ? "foliageLo" : "foliage",
        pos: [Math.cos(a) * 0.06, h * 0.45, Math.sin(a) * 0.06],
        scale: [0.34, h, 0.10],
        rotY: a, rotX: 0.16 + R() * 0.3,        // 向外倒 → 一簇散开
      });
    }
    return out;
  },

  // 栅栏：立柱（带尖顶）+ 上下两道横杆 + 柱上钉头。一段 1.4m 宽，可成列拼成长栏
  fence(R) {
    const w = 1.4, h = 1.0 + R() * 0.3;
    const out = [];
    for (const sx of [-w / 2, w / 2]) {
      out.push({ geo: "box", pos: [sx, h / 2, 0], scale: [0.16, h, 0.16], color: "wood" });
      out.push({ geo: "cone", pos: [sx, h + 0.09, 0], scale: [0.22, 0.2, 0.22], color: "woodLo" });   // 尖顶
    }
    out.push({ geo: "box", pos: [0, h * 0.78, 0], scale: [w, 0.13, 0.09], color: "wood" });
    out.push({ geo: "box", pos: [0, h * 0.44, 0], scale: [w, 0.13, 0.09], color: "wood" });
    if (R() < 0.5) out.push({ geo: "box", pos: [0, h * 0.61, 0.03], scale: [0.1, 0.5, 0.1], color: "woodLo" });  // 竖条
    return out;
  },

  // 路灯：基座 + 杆 + 挑臂 + 灯笼（灯身 + 灯帽 + 顶珠）
  lamp(R) {
    const h = 3.2 + R() * 0.9;
    const arm = 0.34 + R() * 0.12;
    return [
      { geo: "box", pos: [0, 0.11, 0], scale: [0.42, 0.22, 0.42], color: "stoneLo" },          // 基座
      { geo: V("trunk", R), pos: [0, h / 2 + 0.2, 0], scale: [0.19, h, 0.19], rotY: R() * 6.28, color: "wood" },
      { geo: "box", pos: [arm / 2, h + 0.2, 0], scale: [arm, 0.07, 0.07], color: "wood" },     // 挑臂
      { geo: "box", pos: [arm, h + 0.02, 0], scale: [0.42, 0.42, 0.42], color: "accent" },     // 灯身
      { geo: "cone", pos: [arm, h + 0.33, 0], scale: [0.72, 0.3, 0.72], color: "wood" },       // 灯帽
      { geo: "sphere", pos: [arm, h + 0.52, 0], scale: [0.14, 0.14, 0.14], color: "accent" },  // 顶珠
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

  // 水晶：1 根主晶 + 0~2 根斜插的付晶 + 底部一块岩托（成簇才有"晶簇"的样子）
  crystal(R) {
    const out = [];
    const n = 1 + Math.floor(R() * 3);
    const h0 = 2.0 + R() * 2.4;
    out.push({
      geo: V("crystal", R), color: "accent",
      pos: [(R() - 0.5) * 0.5, h0 * 0.5, (R() - 0.5) * 0.5],
      scale: [1.2 + R() * 0.7, h0, 1.2 + R() * 0.7], rotY: R() * 6.28,
    });
    for (let i = 1; i < n + 1; i++) {
      const h = 1.1 + R() * 1.6;
      const a = R() * 6.28, d = 0.55 + R() * 0.8;
      out.push({
        geo: V("crystal", R), color: i % 2 ? "accent" : "bloom",
        pos: [Math.cos(a) * d, h * 0.45, Math.sin(a) * d],
        scale: [0.8 + R() * 0.5, h, 0.8 + R() * 0.5],
        rotY: R() * 6.28, rotZ: (R() - 0.5) * 0.7, rotX: (R() - 0.5) * 0.5,
      });
    }
    out.push({ geo: V("rock", R), pos: [0, 0.18, 0], scale: [2.4, 0.5, 2.2], rotY: R() * 6.28, color: "stoneLo" });
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

  // 云团（浮在空中的一簇球，"云海"段用）：上亮下暗，团块大小差别拉大
  cloudlet(R) {
    const out = [];
    const n = 4 + Math.floor(R() * 4);
    for (let i = 0; i < n; i++) {
      const s = (i === 0 ? 3.4 + R() * 2.2 : 1.6 + R() * 2.4);
      const yy = (R() - 0.5) * 1.4;
      out.push({
        geo: V("canopy", R), color: yy > 0 ? "stone" : "stoneLo",
        pos: [(R() - 0.5) * 3.8, yy, (R() - 0.5) * 3.8],
        scale: [s * 1.4, s, s * 1.4], rotY: R() * 6.28,
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
  // ETW29「驻足的宁静」：米黄板上只有三档蓝的方块 + 纯白小方块。
  // 三档蓝用的是那一关的实测值（#7F95CF L58 / #657CBE L49 / #3F5286 L32）。
  board: { blue0: 0x7f95cf, blue1: 0x657cbe, blue2: 0x3f5286, white: 0xfdfdfb,
           ground: 0xd1d0bb, shade: 0xbcc0c9 },
  rose:  { foliage: 0x4f8f5f, wood: 0x7a5230, stone: 0xc9c2bb, bloom: 0xf3a7c6, accent: 0xf7e08a, ground: 0xd08aa8, shade: 0xa45f80 },
  plum:  { foliage: 0x4a7f6a, wood: 0x5c4030, stone: 0xb9b0b6, bloom: 0xd98bb4, accent: 0xf2d98a, ground: 0x8a6480, shade: 0x5f3f5a },
  sand:  { foliage: 0x6f8c46, wood: 0x7a5a34, stone: 0xd8c9a8, bloom: 0xe8a06a, accent: 0xf6e2a8, ground: 0xe4d0a4, shade: 0xa8905c },
  ice:   { foliage: 0x4d8f96, wood: 0x6b7a86, stone: 0xe6f0f4, bloom: 0x9fd6e8, accent: 0xfdfbf6, ground: 0xa9c8dc, shade: 0x6e93ad },
  jade:  { foliage: 0x3f8f63, wood: 0x6d5334, stone: 0xcbd8cd, bloom: 0xf0c0d0, accent: 0xf6e6a0, ground: 0xa8cfae, shade: 0x78977c },
  cream: { foliage: 0x8f9c7a, wood: 0x8a7a60, stone: 0xf2ece0, bloom: 0xd9c9b0, accent: 0xf7e8c0, ground: 0xefe0c4, shade: 0xb9a888 },
  // 没有指定色卡时（跟着主题走的段）用这套中性色
  default: { foliage: 0x6f9e6a, wood: 0x7a5230, stone: 0xc9c2bb, bloom: 0xefa7c5, accent: 0xf7e08a, ground: 0xd89ab0, shade: 0xa8608a },
};

// 需要"接地影"的道具 → 影子的平面半径（米）。
// 官方做法（R18）：影是**同形偏移副本**、颜色取地面同色系压暗，不是纯黑。
// 有了这一层，道具才"站在地上"而不是"贴在地上"，是廉价但极其有效的立体感来源。
const SHADOW_R = {
  tree: 1.5, pine: 1.5, appleTree: 1.5, bush: 0.95, rock: 1.1,
  column: 0.6, lamp: 0.35, lantern: 0.55, arch: 2.9, giant: 5.6, mushroom: 0.4,
  slabB: 0.85, wallB: 0.75, pillarB: 0.62, cubeW: 0.18, dotB: 0.12,
};

// 「底座色块」的边长（米）：官方秋天做法 —— 树/石脚下垫一块**比地面略亮**的薄方块
// （1.5~2.0 倍路宽见方、厚 0.12~0.2 倍路宽），衬出"这块地是它的"。
// 和接地影配合：影是同色系压暗（体积感），底座是提亮（层次感）。
const BASE_W = {
  tree: 4.6, appleTree: 4.6, pine: 3.8, rock: 2.8, bush: 1.9, crystal: 1.6,
};

// 「暗色变体」色槽：道具定义里写 foliageLo / stoneLo / woodLo / bloomLo 就自动
// 从同名基础色压暗得到 —— 顶亮底暗是**最廉价也最有效**的体积感来源（官方每件都有），
// 但没必要给 7 套色卡 × 4 个色槽手写 28 个数字，直接从基础色算。
const SLOT_DERIVE = {
  foliageLo: ["foliage", 0.66], stoneLo: ["stone", 0.74], woodLo: ["wood", 0.7], bloomLo: ["bloom", 0.72],
  base: ["ground", 1.16], baseLo: ["ground", 1.06],
};
function darken(hex, f) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return (c((hex >> 16) & 255) << 16) | (c((hex >> 8) & 255) << 8) | c(hex & 255);
}


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
  // ETW29 的四件摆件（石板/斜板/竖柱/白方/蓝点）
  slabB: 1.6, wallB: 1.6, pillarB: 1.1, cubeW: 0.4, dotB: 0.25,
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
    // 无限厚板（ETW29）：整块板都能摆，"平地半径"就是板半宽（只留一点边）
    board:     (P) => P.half - 2,
    boardSlot: (P) => P.half - 2,
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

  // ── 路面上"禁摆"区（最后的闸门）──────────────────────────────────────
  // 这条路是一条**阶梯折线**：相邻两级只差 3m，而路面就有 3m 宽 —— 也就是说
  // "离自己那段 4.6m" 完全可能正踩在**隔壁那一段的路面**上（发起人："依然有一些
  // 物体被摆放在路面上，可能会被玩家误认为是障碍物"）。
  // 所以是否压路，必须对**所有线段取最小距离**来判，不能用自己所在的那一段。
  // 这里放在 pack() 这个唯一出口上做闸门：任何零件只要落到路面 (+0.25m) 以内就不生成。
  const ROAD_CLEAR = 0.25;
  // 返回「到整条路的最小距离」+「最近那个点的路面高度」（门洞要按高度放行，见 pack）
  const pathDistY = (x, z) => {
    let best = 1e9, by = 0;
    for (const g of pl.seg) {
      const dx = g.b.x - g.a.x, dz = g.b.z - g.a.z;
      const L2 = dx * dx + dz * dz;
      let u = L2 > 1e-9 ? ((x - g.a.x) * dx + (z - g.a.z) * dz) / L2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = g.a.x + dx * u, pz = g.a.z + dz * u;
      const d = Math.hypot(x - px, z - pz);
      if (d < best) { best = d; by = g.a.y + (g.b.y - g.a.y) * u; }
    }
    return { d: best, y: by };
  };

  // 单个零件是否"不压在路面上"（含高度例外：从路面上方净空 2.6m 以上越过去的东西放行）
  const partOk = (part, sc, wx, wy, wz, rotY) => {
    const hw = Math.max(Math.abs(part.scale[0]), Math.abs(part.scale[2])) * sc * 0.5;
    const hy = Math.abs(part.scale[1]) * sc * 0.5;
    const lpx = part.pos[0] * sc, lpy = part.pos[1] * sc, lpz = part.pos[2] * sc;
    const cc = Math.cos(rotY), sn = Math.sin(rotY);
    const wxp = wx + lpx * cc + lpz * sn;
    const wzp = wz - lpx * sn + lpz * cc;
    const near = pathDistY(wxp, wzp);
    if (near.d - hw < roadW / 2 + ROAD_CLEAR && wy + lpy - hy < near.y + 2.6) return false;
    return true;
  };

  // 把一个道具零件塞进对应几何体的桶里（slot = 规则级颜色槽覆盖，用于"这一列全是草绿"这种）
  // propRot = 整件的 Y 旋转；lean = [绕X, 绕Z] 的轻微歪斜（每株都不同，消掉"一切都是直的"）
  const _qe = new THREE.Euler(), _qp = new THREE.Quaternion();
  const _qv = new THREE.Quaternion(), _qf = new THREE.Quaternion(), _vv = new THREE.Vector3();
  const pack = (part, sc, wx, wy, wz, propRot, pal, slot, lean) => {
    let hex0 = slot != null ? pal[slot] : pal[part.color];
    if (hex0 == null) {                       // foliageLo / stoneLo … 从基础色压暗得到
      const dv = SLOT_DERIVE[part.color];
      hex0 = dv && pal[dv[0]] != null ? darken(pal[dv[0]], dv[1]) : 0xcccccc;
    }
    let hex = hex0;
    // 逐实例轻微色相/明度抖动：同一棵树复制一百遍会"橡皮图章"，官方每一件都不同。
    // 用世界坐标做确定性哈希 → 同一件东西每次渲染颜色一致。
    if (part.color !== "shade") {
      const hsh = ((Math.round(wx * 7.3) * 73856093) ^ (Math.round(wz * 7.3) * 19349663)) >>> 0;
      const j = ((hsh % 1000) / 1000 - 0.5) * 0.22;      // ±11%
      const r0 = (hex >> 16) & 255, g0 = (hex >> 8) & 255, b0 = hex & 255;
      const f = 1 + j;
      hex = (Math.max(0, Math.min(255, Math.round(r0 * f))) << 16)
          | (Math.max(0, Math.min(255, Math.round(g0 * f))) << 8)
          | Math.max(0, Math.min(255, Math.round(b0 * f)));
    }
    // 零件最终姿态 = 整件姿态（propRot + 轻微歪斜 lean）× 零件自身姿态。
    // ⚠️ 局部偏移只能被**整件**姿态旋转。过去把它连同 part.rotY 一起转 →
    //    树冠绕着树干乱窜、牌楼的柱子被转到路面正中（t=99 那个 bug 的真正根因）。
    _qe.set(part.rotX || 0, part.rotY || 0, part.rotZ || 0);
    _qv.setFromEuler(_qe);
    _qe.set(lean ? lean[0] : 0, propRot, lean ? lean[1] : 0);
    _qp.setFromEuler(_qe);
    _qf.copy(_qp).multiply(_qv);
    _vv.set(part.pos[0] * sc, part.pos[1] * sc, part.pos[2] * sc).applyQuaternion(_qp);
    (bucket[part.geo] = bucket[part.geo] || []).push({
      x: wx, y: wy, z: wz,
      sx: part.scale[0] * sc, sy: part.scale[1] * sc, sz: part.scale[2] * sc,
      lx: _vv.x, ly: _vv.y, lz: _vv.z,
      qx: _qf.x, qy: _qf.y, qz: _qf.z, qw: _qf.w,
      color: hex,
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
          const ca = atArc(pl, Math.max(0, s - 1.6));
          const cb = atArc(pl, Math.min(pl.total, s + 1.6));
          let lx = cb.x - ca.x, lz = cb.z - ca.z;
          const ll = Math.hypot(lx, lz) || 1;
          lx /= ll; lz /= ll;
          if (r.center) {
            // 门洞（牌楼）：必须站在**局部笔直**的一段上，且方向用这段直线。
            // 否则它会斜卡在转角上、柱子直接压在路面里（实测 t=99 就是这样）。
            const g1 = atArc(pl, Math.max(0, s - 2.6));
            const g2 = atArc(pl, Math.min(pl.total, s + 2.6));
            const g0 = atArc(pl, s);
            if (Math.hypot((g1.x + g2.x) / 2 - g0.x, (g1.z + g2.z) / 2 - g0.z) > 0.4) continue;
            const rl = Math.hypot(g2.x - g1.x, g2.z - g1.z) || 1;
            lx = (g2.x - g1.x) / rl; lz = (g2.z - g1.z) / rl;
            dx = lx; dz = lz;
          } else if (r.skipCorner) {
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
          const parts = PROPS[r.kind](R);
          // 门洞（牌楼）用逐零件判：柱子必须让开路面，横梁可以跨过去。
          // 零件自身姿态在 pack 里叠加，这里只传"整件"的朝向 rot。
          if (r.center) {
            let ok = true;
            for (const part of parts) {
              if (!partOk(part, sc, x, yy, z, rot)) { ok = false; break; }
            }
            if (!ok) continue;
          }
          const sr2 = SHADOW_R[r.kind];
          const bw2 = BASE_W[r.kind];
          if (bw2) parts.push({ geo: "box", pos: [0, 0.02, 0], scale: [bw2 * sc, 0.10, bw2 * sc], color: "baseLo", rotY: rot });
          if (sr2) parts.push({ geo: "cyl", pos: [0, 0.10, 0], scale: [sr2 * 2 * sc, 0.06, sr2 * 2 * sc], color: "shade" });
          for (const part of parts) pack(part, sc, x, yy, z, rot, pal, r.slot);
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
          // 每件再乘一个 0.78~1.22 的随机缩放（官方"装饰随机、结构对齐"里的核心手法：
          // 同一 mesh 随机 rot.y + scale 0.7~1.3，是"低成本高丰富度"的关键）。
          // 成列件（栅栏/路灯）不需要，规则里写 scaleJitter:false 关掉。
          const jit = r.scaleJitter === false ? 1 : 0.78 + rnd() * 0.44;
          const sc = (sc0 + rnd() * (sc1 - sc0)) * jit;
          const rad = radOf(r.kind, sc);
          // 每件东西自己的"离路下限"：小件贴路、大件（树/云团/岩）要按半径让开路面
          const minOffK = Math.max(minOff0, roadW / 2 + rad + 0.4);
          const off = Math.max(minOffK, Math.min(flatMax, laneOff[lane] + (rnd() - 0.5) * spread));
          const x = p.x + p.nx * side * off;
          const z = p.z + p.nz * side * off;
          const dy = r.dy || 0;
          // 道具自己的随机数流（同一个道具内一致）
          let sd = (s * 7919 + c * 104729 + (side + 1) * 9973 + i) >>> 0;
          const R = () => ((sd = (sd * 1103515245 + 12345) >>> 0) / 4294967296);
          const parts = PROPS[r.kind](R);
          // 整件一个随机朝向 + 一点歪斜（每株不同）；零件自身姿态在 pack 里再叠
          const propRot = r.rotRandom === false ? 0 : R() * Math.PI * 2;
          const lean = [(R() - 0.5) * 0.10, (R() - 0.5) * 0.10];
          // 整件一起判：阶梯折线上必须对**所有**线段取最小距离（见上面 pathDistY 的说明）。
          // 逐零件判 + "有一个零件压路就整件不放"，避免出现"树干被删掉、树冠还飘着"。
          let ok = true;
          for (const part of parts) { if (!partOk(part, sc, x, p.y + dy, z, propRot)) { ok = false; break; } }
          if (!ok) continue;
          if (!freeAt(x, z, rad)) continue;               // 和已放下的东西咬在一起 → 不放
          occupy(x, z, rad);
          // 接地影：放在闸门之后加，不参与"压路"判定（否则影子会把树一起拖掉）；
          // 影子不跟着歪 —— 它得平躺在地上
          const sr = SHADOW_R[r.kind];
          // 底座色块：比地面略亮的薄方块（官方秋天的树底座），影子和它都趴在地上
          const bw = BASE_W[r.kind];
          if (bw) parts.push({ geo: "box", pos: [0, 0.02, 0], scale: [bw * sc, 0.10, bw * sc], color: "baseLo", rotY: propRot });
          if (sr) parts.push({ geo: "cyl", pos: [0, 0.10, 0], scale: [sr * 2 * sc, 0.06, sr * 2 * sc], color: "shade" });
          const palName = r.palette || spanPal(timeAt(ss)) || "default";
          const pal = PROP_COLORS[palName] || PROP_COLORS.default;
          for (const part of parts) {
            pack(part, sc, x, p.y + dy, z, propRot, pal, r.slot, part.color === "shade" ? null : lean);
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
      e.set(0, 0, 0);
      q.set(o.qx, o.qy, o.qz, o.qw);
      vp.set(o.x + o.lx, o.y + o.ly, o.z + o.lz);
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

/* ---------------------------------------------------------------------------
   道具图鉴（离屏预览）
   ---------------------------------------------------------------------------
   把每种道具按不同随机种子生成若干个"实物"，摆成一张网格，供 tools/shot.js 截图。
   只用于**看模型本身**（建模精细度、比例、配色是否到位），不进游戏。
   每个零件是一个独立 Mesh（不做实例化），并且按新姿态语义摆放：
   零件位置 = 位置，零件旋转绕**自己**的中心 —— 和 buildProps 里 pack() 的语义一致。
   @param kinds    道具名数组（按行排）
   @param perKind  每种生成几个（列数）
   @param opts     { palette, gap, rowGap, seed0 }
   --------------------------------------------------------------------------- */
export function buildPropSheet(kinds, perKind = 4, opts = {}) {
  const group = new THREE.Group();
  group.name = "propsheet";
  const pal = PROP_COLORS[opts.palette || "default"] || PROP_COLORS.default;
  const gap = opts.gap || 6.5, rowGap = opts.rowGap || 9.5;
  kinds.forEach((kind, ri) => {
    if (!PROPS[kind]) return;
    for (let v = 0; v < perKind; v++) {
      let sd = ((opts.seed0 || 20261013) + ri * 7717 + v * 104729) >>> 0;
      const R = () => ((sd = (sd * 1103515245 + 12345) >>> 0) / 4294967296);
      const holder = new THREE.Group();
      holder.position.set((v - (perKind - 1) / 2) * gap, 0, -ri * rowGap);
      for (const part of PROPS[kind](R)) {
        const geo = GEOS[part.geo] || GEOS.box;
        let hex = pal[part.color];
        if (hex == null) {
          const dv = SLOT_DERIVE[part.color];
          hex = dv && pal[dv[0]] != null ? darken(pal[dv[0]], dv[1]) : 0xcccccc;
        }
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: hex, roughness: GEO_ROUGH[part.geo] == null ? 0.9 : GEO_ROUGH[part.geo], metalness: 0,
        }));
        m.scale.set(part.scale[0], part.scale[1], part.scale[2]);
        m.position.set(part.pos[0], part.pos[1], part.pos[2]);
        m.rotation.set(part.rotX || 0, part.rotY || 0, part.rotZ || 0);
        holder.add(m);
      }
      group.add(holder);
    }
  });
  return group;
}
