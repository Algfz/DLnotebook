/* =====================================================================
   game.js — 游戏核心
   · Three.js 渲染：路面、线、相机跟随、主题色过渡
   · 转向判定：点击时机 → 是否在转向点窗口内
   · 音画同步：位置一律由音频时钟算出（见 audio.js）
   · 多线关卡：level.lines[] 给出多条线，各自渲染 / 输入 / 判定
   ===================================================================== */
import * as THREE from "../vendor/three.module.min.js";
import {
  DIRS, rot, buildVerts, posAt, vertAt, speedAt, themeAt, linesOf,
} from "./level.js";
import { AudioClock } from "./audio.js";

// 各主题的视觉参数（路面/天空/雾/线的颜色）
const THEME = {
  garden:   { sky: 0x9fe0c0, fog: 0xc2ead6, road: 0x63b189 },
  collapse: { sky: 0x241c2a, fog: 0x35242f, road: 0x7a4a58 },
  truth:    { sky: 0x111827, fog: 0x17223c, road: 0x44557e },
  dawn:     { sky: 0xf2d3a0, fog: 0xf8e4bd, road: 0xd0a468 },
  void:     { sky: 0x14161c, fog: 0x1c2028, road: 0x5a6270 },
  // 全粉色（单场景关卡用）：天空/雾是浅粉，路面是饱和的桃粉
  pink:     { sky: 0xffd4e6, fog: 0xffe4f0, road: 0xf2579b },
  // 全灰色（双线实验关用）：天空/雾是浅灰，路面是中灰——
  // 白线（0xffffff）与黑线（0x000000）在同一条中灰路面上都能看清。
  gray:     { sky: 0xb9bec6, fog: 0xd2d6db, road: 0x70767d },
};

// 相机相对「线头中点」的固定偏移（等距斜后方视角，DL 的典型机位）
const CAM_OFF = { x: -17, y: 21, z: -17 };

// 相机跟随的时间常数（秒）：越大越"飘"（越平滑），0 = 完全刚性。
// 2026-10-11 发起人要求"更平滑"，0.16 → 0.30：跟随滞后随之翻倍
// （相对线头中点约 2.3m → 4.0m；115s 折返的峰值角加速度 38 → 21 °/s²）。
// 相机位置与注视点用同一个平滑系数，两者差值恒为 offset，
// 所以视线方向永远不变，只有跟随位置有滞后——画面不会旋转发晕。
const CAM_SMOOTH = 0.30;

// 跑出路面后不是立刻判死，而是继续下坠；掉够这么深（或摔到地面）才算死亡。
// 贴地关卡下方是虚空，用这个深度判定；高架关卡则摔到地面即死。
const FALL_DEPTH = 10;

const TRAIL_LIMIT = 20000;      // 每条线的轨迹块上限（全长 2445m / 0.25m ≈ 1 万块）

/* ------------------------------------------------------------------
   镜头环绕（双线关卡用）
   线头中点不动，相机绕它缓缓从「正后方」转到「行进方向的右侧」，
   peak 秒时恰好到正右侧，随后以同样的角速度转回原位。
   行进方向取「两种行进方向之和」——每条线只在 dirA/dirB 两个方向间切换，
   dirA + dirB 是个恒定的对角方向，于是这个参考系整关不抖。

   level.cameraOrbit = { start: 87, peak: 115, end: 143, angleDeg: 90 }

   ⚠️ 环绕与拉远这两条时间曲线都是**分段线性**的（没有缓动），
   速度在每个转折点（87 / 115 / 143 / 118 / 150 / 230 / 250s）突变；
   唯一的柔化来自相机跟随的指数平滑（CAM_SMOOTH）——115s 的折返
   会在约 0.9s 内把角速度从 +3.21°/s 转到 -3.21°/s（峰值角加速度约 21°/s²）。
   ------------------------------------------------------------------ */
function orbitYaw(level, t) {
  const o = level.cameraOrbit;
  if (!o || !o.angleDeg) return 0;
  const t0 = o.start || 0;
  const tp = o.peak != null ? o.peak : 115;
  const t1 = o.end != null ? o.end : tp * 2;
  const a = o.angleDeg * Math.PI / 180;
  if (t <= t0) return 0;
  if (t <= tp) return a * (t - t0) / Math.max(1e-6, tp - t0);
  if (t <= t1) return a * (1 - (t - tp) / Math.max(1e-6, t1 - tp));
  return 0;
}

/* ------------------------------------------------------------------
   镜头拉远（双线关卡用）
   两条线在后半段会拉开很远（Breeze 最大约 73m），固定机位装不下，
   所以在这条时间轴上把「相机到线头中点的距离」整体放大：
     start → peak   逐渐拉远到 scale 倍
     peak  → hold   保持 scale 倍
     hold  → end    逐渐恢复回 1 倍
   时间轴之外恒为 1 倍。倍数直接乘在整条偏移向量上，
   所以水平半径、高度、俯角都原样等比放大，视线方向不变。

   level.cameraOrbit.zoom = { start: 118, peak: 150, hold: 230, end: 250, scale: 2 }
   ------------------------------------------------------------------ */
function zoomScale(level, t) {
  const z = level.cameraOrbit && level.cameraOrbit.zoom;
  if (!z) return 1;
  const s = z.scale != null ? z.scale : 2;
  const t0 = z.start != null ? z.start : 0;
  const tp = z.peak != null ? z.peak : t0;
  const th = z.hold != null ? z.hold : tp;
  const t1 = z.end  != null ? z.end  : th + Math.max(0, tp - t0);   // 缺省对称恢复
  if (t <= t0 || t >= t1) return 1;
  if (t <= tp) return 1 + (s - 1) * (t - t0) / Math.max(1e-6, tp - t0);
  if (t <= th) return s;
  return s - (s - 1) * (t - th) / Math.max(1e-6, t1 - th);
}

export class Game {
  constructor(canvas, level, buffer, opts = {}) {
    this.canvas = canvas;
    this.level = level;
    this.ctx = opts.ctx;
    this.dur = buffer.duration;

    this.clock = new AudioClock(this.ctx, buffer,
      opts.latency != null ? opts.latency : (level.latency_ms || 0));
    this.volume = opts.volume != null ? opts.volume : 0.8;
    this.clock.setVolume(this.volume);

    // 线列表（单线关卡也会合成一条线 A）
    this.lineDefs = linesOf(level);
    this.multi = this.lineDefs.length > 1;

    // 兼容旧字段：顶层 path / verts 仍指线 A（verts 在 buildScene 里建好后回填）
    this.path = this.lineDefs[0].path || level.path;

    // 路宽优先取关卡自己的定义，其次才是外部选项
    this.roadW = level.roadWidth != null ? level.roadWidth
               : (opts.roadWidth != null ? opts.roadWidth : 1.5);
    this.lineW = opts.lineWidth != null ? opts.lineWidth : 1.0;

    this.state = "idle";                 // idle(首帧) | playing | dead | finished
    this.deadAt = 0;
    // 场景瞬移（崩塌处断开）：只作用于线 A
    this.teleports = (level.teleports || []).slice().sort((a, b) => a.t - b.t);
    this.tpIdx = 0;
    this.fadeEl = null;
    // 自动播放（代替玩家操作，用于预览/录屏）：逐线开关，见 setAutoLines / autoPlay

    // 回调（由 main.js 注入）
    this.onStart = null; this.onDeath = null; this.onFinish = null; this.onTick = null;

    this.initThree();
    this.buildScene();
    this.reset();
  }

  /* ---------------------- Three.js 初始化 ---------------------- */
  initThree() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    // near/far 的比值决定深度缓冲精度。原来 0.5:3000（1:6000）太夸张，
    // 贴着路面的东西（拖尾只高出 1.5cm）会被路面盖掉。
    // 相机离线约 32m，雾在 460m 就全遮了，所以 near=2 / far=800 足够，精度提升约 15 倍。
    this.camera = new THREE.PerspectiveCamera(55, 1, 2, 800);

    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(-45, 90, -35);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));

    const th = THEME[themeAt(this.level, 0)] || THEME.void;
    this.skyColor = new THREE.Color(th.sky);
    this.fogColor = new THREE.Color(th.fog);
    this.scene.background = this.skyColor.clone();
    this.scene.fog = new THREE.Fog(this.fogColor.clone(), 70, 460);

    // 镜头环绕的参考系：「正后方」= -(两种行进方向之和)
    const d0 = DIRS[this.lineDefs[0].spawn.dir];
    const d1 = DIRS[rot(this.lineDefs[0].spawn.dir, "R")];
    const sx = d0[0] + d1[0], sz = d0[1] + d1[1];
    const n = Math.hypot(sx, sz) || 1;
    this.camBase = { x: -sx / n, z: -sz / n };

    this._tmp = new THREE.Color();
    this.resize();
  }

  /* ------------------------------------------------------------------
     路面用「块拼接」生成，不用连续带状网格：
     每个段一个长方体、每个转角一个方形平台，块与块直角衔接。
     连续带状 + 斜接（miter）在密集 90° 直角处会翻转扭结、自我重叠，
     这正是之前「路线稀碎」的根源。
     多线时每条线各铺一条路：两条路在同一高度相交会共面 z-fighting，
     所以给第 i 条路下沉 i×Y_STEP（肉眼不可见，但深度上永远分得开）。
     ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------
     高架桥：桥面已在路径高度（连续路面必须等高，所以是一个常量），
     这里补上「桥墩」和「地面」。路架高之后地面可以自由布景，
     密集段路面交错看起来也像立交匝道，而不是糊在地上。
     ------------------------------------------------------------------ */
  // 高架桥的「悬崖」处理：桥面下方不画支柱（发起人认为画蛇添足）、
  // 也不画实体地面，只在很深处放一片向下融进雾里的「光海」——
  // 这正是优秀同类关卡的做法：下面是光，不是地。
  buildBridge() {
    const b = this.level.bridge;
    if (!b || !(b.deckY > 0)) return;
    const H = b.deckY;

    const span = 3000;
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(span, span),
      new THREE.MeshBasicMaterial({ color: 0xffeaf3 })   // 亮粉白，会融进粉色雾
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, -H * 2, 0);                     // 远在桥面之下，融入雾中
    this.scene.add(sea);
  }

  // 布景：生成器预算好的纯几何块，这里只负责一次画完（InstancedMesh）
  buildScenery() {
    const sc = this.level.scenery;
    if (!sc || !sc.items || !sc.items.length) return;
    this.sceneryMesh = this.makeBlockMesh(sc.items, new THREE.MeshStandardMaterial({
      // 中粉：比天空(浅粉)深、比路面(桃粉)浅，三者形成层次
      color: 0xf8b0cc, roughness: 0.75, metalness: 0.0,
    }));
    this.scene.add(this.sceneryMesh);
  }

  /* ---------------------- 轨迹（玩家实际画出来的） ---------------------- */

  // 追加一个轨迹块
  addTrailInstance(L, cx, cy, cz, angY, sx, sy, sz) {
    if (L.trailCount >= TRAIL_LIMIT) return;
    this._v3.set(cx, cy, cz);
    this._q.setFromAxisAngle(this._up, angY);
    this._s.set(sx, sy, sz);
    this._m4.compose(this._v3, this._q, this._s);
    L.trail.setMatrixAt(L.trailCount, this._m4);
    L.trailCount++;
    L.trail.count = L.trailCount;
    L.trail.instanceMatrix.needsUpdate = true;
  }

  // 从 (x0,z0) 到 (x1,z1) 补一段通道（截面 = 线头，从路面向上线头高度）
  addTrailSeg(L, x0, z0, x1, z1) {
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    this.addTrailInstance(
      L, (x0 + x1) / 2, L.pos.y + this.lineW / 2 + L.yOff, (z0 + z1) / 2,
      Math.atan2(dx, dz), this.lineW, this.lineW, len
    );
  }

  // 转角补一个方块，保证两个方向的通道无缝衔接
  addTrailCorner(L, x, z) {
    this.addTrailInstance(L, x, L.pos.y + this.lineW / 2 + L.yOff, z, 0,
      this.lineW, this.lineW, this.lineW);
  }

  // 线头前进后调用：每走 STEP 米切一块（连续生成，不是一段一段跳）
  emitTrail(L) {
    const STEP = 0.25;
    let dx = L.pos.x - L.lastSample.x;
    let dz = L.pos.z - L.lastSample.z;
    let dist = Math.hypot(dx, dz);
    while (dist >= STEP) {
      const ux = dx / dist, uz = dz / dist;
      const nx = L.lastSample.x + ux * STEP;
      const nz = L.lastSample.z + uz * STEP;
      this.addTrailSeg(L, L.lastSample.x, L.lastSample.z, nx, nz);
      L.lastSample.x = nx; L.lastSample.z = nz;
      dx = L.pos.x - nx; dz = L.pos.z - nz;
      dist = Math.hypot(dx, dz);
    }
  }

  // 沿一条直线从 lastSample 走到 (x,z)。自动播放的每一段都落在同一条
  // 路线段内（轴对齐），所以块不会斜着摆。
  // reachEnd=true 时精确走到终点（用于拐角，保证下一段从拐角出发、不斜切）；
  // 否则只走整步，余量留到下一帧（普通轨迹采样的行为）。
  _emitStraightTo(L, x, z, reachEnd) {
    const STEP = 0.25;
    let dx = x - L.lastSample.x, dz = z - L.lastSample.z;
    let dist = Math.hypot(dx, dz);
    while (dist >= STEP) {
      const ux = dx / dist, uz = dz / dist;
      const nx = L.lastSample.x + ux * STEP;
      const nz = L.lastSample.z + uz * STEP;
      this.addTrailSeg(L, L.lastSample.x, L.lastSample.z, nx, nz);
      L.lastSample.x = nx; L.lastSample.z = nz;
      dx = x - nx; dz = z - nz;
      dist = Math.hypot(dx, dz);
    }
    if (reachEnd && dist > 1e-4) {
      this.addTrailSeg(L, L.lastSample.x, L.lastSample.z, x, z);
      L.lastSample.x = x; L.lastSample.z = z;
    }
  }

  // 自动播放的轨迹：严格沿官方路线铺设。
  // 从时间 t0 走到 t1，在每个途经的路线顶点（拐角）处断开并补一个拐角方块，
  // 于是每一段轨迹块都与路线段同向（轴对齐），拐角处不会出现斜切的「锯齿」。
  emitRouteTrail(L, t0, t1) {
    const last = L.verts[L.verts.length - 1];
    for (let i = 0; i < L.verts.length; i++) {
      const v = L.verts[i];
      if (v.t <= t0 || v.t >= t1 || v === last) continue;
      this._emitStraightTo(L, v.x, v.z, true);          // 精确走到拐角
      this.addTrailCorner(L, v.x, v.z);
    }
    const end = vertAt(L.verts, t1);
    this._emitStraightTo(L, end.x, end.z, false);       // 再走到当前时刻
  }

  // 计算所有路面块（段块 + 转角块），按路径顺序排列
  roadBlocks(verts, roadW, thick, yOff) {
    const items = [];
    const n = verts.length;
    for (let i = 0; i < n - 1; i++) {
      const a = verts[i], b = verts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-6) {
        items.push({
          pos: [(a.x + b.x) / 2, (a.y + b.y) / 2 - thick / 2 + yOff, (a.z + b.z) / 2],
          angY: Math.atan2(dx, dz),
          scale: [roadW, thick, len],
          endT: b.t,
        });
      }
      if (i < n - 2) {                    // 转角块（起点除外）
        const p = verts[i + 1];
        items.push({
          pos: [p.x, p.y - thick / 2 + yOff, p.z],
          angY: 0,
          scale: [roadW, thick, roadW],
          endT: p.t,
        });
      }
    }
    return items;
  }

  // 引导线：沿官方路线的虚线 + 每个转向点的虚线方框，合成一个 LineSegments。
  // 两者共用同一套虚线节奏（画 DASH 空 GAP）和同一个材质，
  // 而 WebGL 的线宽恒为 1px，所以粗细天然一致。
  buildGuideLines(verts, yOff) {
    const pos = [];
    const DASH = 0.125, GAP = 0.125;          // 与方框一致：边长 1m 分 8 段、隔段画
    const LIFT = 0.06;                        // 抬离路面，避免被盖住

    // (1) 路线本体的虚线
    for (let i = 0; i + 1 < verts.length; i++) {
      const a = verts[i], b = verts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const ux = dx / len, uz = dz / len;
      for (let s = 0; s < len - 1e-6; s += DASH + GAP) {
        const e = Math.min(s + DASH, len);
        pos.push(a.x + ux * s, a.y + LIFT + yOff, a.z + uz * s);
        pos.push(a.x + ux * e, a.y + LIFT + yOff, a.z + uz * e);
      }
    }

    // (2) 转向点的虚线方框
    const h = this.lineW * 0.5;               // 边长 = 线宽
    const corner = [[-h, -h], [h, -h], [h, h], [-h, h]];
    const segs = 8;                            // 每条边分 8 段 → 每段 1/8 m
    // 只在转向点画（跳过起点和曲终点）
    for (let vi = 1; vi < verts.length - 1; vi++) {
      const p = verts[vi];
      for (let i = 0; i < 4; i++) {
        const a = corner[i], b = corner[(i + 1) % 4];
        for (let k = 0; k < segs; k++) {
          if (k % 2 !== 0) continue;           // 隔一段画一段 = 虚线
          const t0 = k / segs, t1 = (k + 1) / segs;
          pos.push(p.x + a[0] + (b[0] - a[0]) * t0, p.y + LIFT + yOff, p.z + a[1] + (b[1] - a[1]) * t0);
          pos.push(p.x + a[0] + (b[0] - a[0]) * t1, p.y + LIFT + yOff, p.z + a[1] + (b[1] - a[1]) * t1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.8 });
    mat.polygonOffset = true; mat.polygonOffsetFactor = -5; mat.polygonOffsetUnits = -5;
    return new THREE.LineSegments(g, mat);
  }

  // 预建 3 个扩散方框（轮转复用），避免每次点击都新建对象
  buildRipples() {
    this.ripples = [];
    const p = [];
    const c = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      p.push(a[0], 0, a[1], b[0], 0, b[1]);
    }
    for (let i = 0; i < 3; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(p.slice(), 3));
      const ls = new THREE.LineSegments(g,
        new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0 }));
      ls.visible = false;
      ls.frustumCulled = false;        // 同样是动态显示的对象，防止被视锥剔除
      this.scene.add(ls);
      this.ripples.push({ mesh: ls, t: -1, x: 0, y: 0, z: 0 });
    }
  }

  spawnRipple(x, y, z) {
    let r = this.ripples.find(v => v.t < 0) || this.ripples[0];
    r.t = 0; r.x = x; r.y = y; r.z = z;
    r.mesh.visible = true;
  }

  updateRipples(dt) {
    const dur = 0.45, base = this.roadW * 0.8;
    for (const r of this.ripples) {
      if (r.t < 0) continue;
      r.t += dt;
      const k = r.t / dur;
      if (k >= 1) { r.t = -1; r.mesh.visible = false; continue; }
      const size = base * (1 + k * 2.2);       // 向外不断扩大
      r.mesh.position.set(r.x, r.y + 0.09, r.z);
      r.mesh.scale.set(size, 1, size);
      r.mesh.material.opacity = 0.9 * (1 - k); // 颜色变淡直至透明
    }
  }

  // 用 InstancedMesh 一次绘制全部块（几百个块只算一次绘制调用）
  makeBlockMesh(items, material) {
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, items.length);
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    items.forEach((it, i) => {
      pos.set(it.pos[0], it.pos[1], it.pos[2]);
      q.setFromAxisAngle(up, it.angY);
      s.set(it.scale[0], it.scale[1], it.scale[2]);
      m.compose(pos, q, s);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    return inst;
  }

  // 线的材质：线头与轨迹共用同一个实例，从根上杜绝色差。
  // 白线给一点自发光（背光面也不至于发灰）；黑线保持纯黑。
  makeLineMaterial(hex) {
    return new THREE.MeshStandardMaterial({
      color: hex,
      roughness: 0.35,
      metalness: 0.0,
      emissive: hex === 0x000000 ? 0x000000 : 0x555555,
    });
  }

  // 每条线的「同一高度下沉量」：第 0 条为 0，之后每条再低一点点。
  static get Y_STEP() { return 0.004; }

  buildScene() {
    const th = THEME[themeAt(this.level, 0)] || THEME.void;
    this.thick = 0.6;                                     // 路面厚度（悬崖感）
    this.roadMat = new THREE.MeshStandardMaterial({
      color: th.road, roughness: 0.88, metalness: 0.04,
    });

    // 1) 逐线建几何与状态
    this.lines = this.lineDefs.map((def, i) => {
      const verts = buildVerts(this.level, this.dur, def);
      const hex = new THREE.Color(def.color || "#ffffff").getHex();
      const dirA = def.spawn.dir != null ? def.spawn.dir : this.level.motion.spawn.dir;
      return {
        def, id: def.id, key: def.key, hand: def.hand,
        colorHex: hex,
        verts,
        dirA, dirB: rot(dirA, "R"),
        // elevate 已经烘进 verts 的高度里；yOff 只是同高度时的防共面微下沉
        elevate: def.elevate || 0,
        yOff: -i * Game.Y_STEP,
        // 状态（reset 里再初始化一遍）
        pos: { x: verts[0].x, y: verts[0].y, z: verts[0].z },
        dir: dirA,
        cur: { x: verts[0].x, y: verts[0].y, z: verts[0].z },
        falling: false, vy: 0,
        lastT: 0, lastSample: { x: verts[0].x, z: verts[0].z },
        trailCount: 0, _jumped: false, _trailFrom: 0,
        auto: false,                            // 这条线是否自动播放（可逐线单独开）
        mat: this.makeLineMaterial(hex),
      };
    });

    this.verts = this.lines[0].verts;                     // 兼容旧字段：意为线 A

    // 2) 每条线一条路面（共用一个材质实例 → 主题色过渡一次全变）
    this.roads = this.lines.map(L => {
      const blocks = this.roadBlocks(L.verts, this.roadW, this.thick, L.yOff);
      const mesh = this.makeBlockMesh(blocks, this.roadMat);
      this.scene.add(mesh);
      return mesh;
    });
    this.road = this.roads[0];                            // 兼容旧字段

    this.buildBridge();          // 悬崖：桥下的光海（贴地关卡不会触发）
    this.buildScenery();         // 布景：路线两侧的纯几何块

    // 3) 每条线一套「轨迹 + 线头」，用各自的材质
    // 轨迹 = 玩家线头实际画出来的线（不是官方路线！）。
    // 线头每前进一小步就追加一个块（截面 = 线头截面），转向时补一个转角方块。
    // 全部塞进一个 InstancedMesh，上限给足（全长 2445m / 0.25m ≈ 1 万块）。
    // count 是动态的：必须关掉视锥剔除，否则包围球按 count=0 算，相机走远就整条消失。
    for (const L of this.lines) {
      L.trail = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1), L.mat, TRAIL_LIMIT
      );
      L.trail.count = 0;
      L.trail.frustumCulled = false;
      this.scene.add(L.trail);

      // 线头：正方体（边长 = 线宽），底面贴路面，是轨迹的「笔尖」。
      // 比轨迹块大 2%：线头始终和最新的轨迹块重叠，尺寸完全相同时两个
      // 立方体表面共面 → z-fighting → 看起来一直在闪烁；稍大就能包住它。
      const hs = this.lineW * 1.02;
      L.mesh = new THREE.Mesh(new THREE.BoxGeometry(hs, hs, hs), L.mat);
      this.scene.add(L.mesh);
    }

    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.camReady = false;        // 首次/重开/瞬移时直接吸附，不做平滑
    this._m4 = new THREE.Matrix4();
    this._v3 = new THREE.Vector3();
    this._q  = new THREE.Quaternion();
    this._s  = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);

    // 引导线（单独的元素类型）：画在路面上的黑色虚线 + 转向点的虚线方框。
    // 每条线一份，同一个 LineSegments 里线宽与虚线节奏完全一致。
    this.guideLines = this.lines.map(L => {
      const gl = this.buildGuideLines(L.verts, L.yOff);
      gl.visible = false;
      gl.frustumCulled = false;    // 覆盖整条路线，别被剔除
      this.scene.add(gl);
      return gl;
    });

    // 点击反馈：从虚线方框位置向四周扩大并淡出的黑色实线方框
    this.buildRipples();
  }

  /* ---------------------- 状态控制 ---------------------- */
  reset() {
    this.state = "idle";
    this.tpIdx = 0;
    this.clock.stop();
    for (const L of this.lines) {
      const v0 = L.verts[0];
      L.lastT = 0;
      L.pos = { x: v0.x, y: v0.y, z: v0.z };
      L.dir = L.dirA;
      L.cur = { x: v0.x, y: v0.y, z: v0.z };
      L.falling = false;                     // 是否已跑出路面、正在下坠
      L.vy = 0;                              // 竖直速度（下坠用）
      L.trailCount = 0;
      L.trail.count = 0;                     // 轨迹清空
      L.lastSample = { x: v0.x, z: v0.z };
      L._jumped = false;
      L._trailFrom = 0;
    }
    this.updateCenter();
    this.camReady = false;                   // 相机直接归位，别飞过来
  }

  // 线头中点（相机绕它环绕，也用它当注视点）
  updateCenter() {
    let x = 0, y = 0, z = 0;
    for (const L of this.lines) { x += L.cur.x; y += L.cur.y; z += L.cur.z; }
    const n = this.lines.length || 1;
    this.center = { x: x / n, y: y / n, z: z / n };
  }

  begin() {
    if (this.state !== "idle") return;
    this.state = "playing";
    this.clock.play(0);
    if (this.onStart) this.onStart();
  }

  die() {
    if (this.state !== "playing") return;
    this.state = "dead";
    this.deadAt = performance.now();
    this.clock.stop();
    if (this.onDeath) this.onDeath();
  }

  finish() {
    if (this.state !== "playing") return;
    this.state = "finished";
    this.clock.stop();
    if (this.onFinish) this.onFinish();
  }

  /* ---------------------- 自动播放（逐线） ---------------------- */
  // list[i] = true → 第 i 条线自动沿自己的官方路线走；其余线仍由玩家操作。
  // 允许只自动播放其中一条线（例如录屏时只演示白线）。
  setAutoLines(list) {
    this.lines.forEach((L, i) => { L.auto = !!(list && list[i]); });
  }

  // 兼容旧字段：读写 autoPlay = 「所有线一起开关」
  get autoPlay() { return !!this.lines && this.lines.every(L => L.auto); }
  set autoPlay(v) { if (this.lines) this.lines.forEach(L => { L.auto = !!v; }); }

  // 按键 → 线的下标（-1 = 不处理）。空格沿用旧行为：等同右手（线 A）。
  keyToLine(code) {
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].key === code) return i;
    }
    if (code === "Space" && this.lines.length) return 0;
    return -1;
  }

  // 转向本身（玩家点击和自动播放共用）
  // DL 核心：点击永远立即生效，不存在判定窗口。
  // 难度来自「只有在正确位置点击才不会撞墙」——
  // 点早了点晚了，线都会偏离官方路线，撞判定物/掉出路面即死。
  doTurn(L) {
    if (L.falling) return;                 // 已经掉下去了，转也救不回来
    L.dir = (L.dir === L.dirA) ? L.dirB : L.dirA;

    // 转角：先补上上一采样点到这里的余量，再放转角方块，轨迹才无缝
    this.addTrailSeg(L, L.lastSample.x, L.lastSample.z, L.pos.x, L.pos.z);
    this.addTrailCorner(L, L.pos.x, L.pos.z);
    L.lastSample.x = L.pos.x; L.lastSample.z = L.pos.z;
  }

  // idx：哪条线（0 = 右手/上箭头，1 = 左手/X）。默认 0，兼容单线调用。
  onTap(idx = 0) {
    if (this.state === "idle") { this.begin(); return; }
    if (this.state !== "playing") return;
    const L = this.lines[idx] || this.lines[0];
    if (L.auto) return;                       // 这条线正在自动播放，忽略手动操作
    this.doTurn(L);

    // 点击反馈：若恰好点在引导线顶点（虚线方框）附近，显示扩散方框
    const t = this.clock.time;
    let best = null, bd = 1e9;
    for (const p of (L.def.path || [])) {
      const d = Math.abs(p.t - t);
      if (d < bd) { bd = d; best = p; }
    }
    if (best && bd < 0.2 && this.ripples) {
      this.spawnRipple(best.pos[0], best.pos[1] + L.elevate + L.yOff, best.pos[2]);
    }
  }

  /* ---------------------- 每帧更新 ---------------------- */
  update() {
    const t = this.clock.time;

    // 帧间隔（驱动扩散动画）
    const now = performance.now();
    const dt = this._lastFrame ? (now - this._lastFrame) / 1000 : 0.016;
    this._lastFrame = now;
    this._dt = dt;                  // 相机平滑需要（与帧率无关）
    if (this.ripples) this.updateRipples(dt);

    if (this.state === "playing") {
      // 逐线推进：自动播放的线走官方路线，其余线走玩家的方向。
      // 一条线只能二选一 —— 两套都跑会互相打架（位置被写两遍）。
      {
        const spd = speedAt(this.level, t);
        for (const L of this.lines) {
          if (L.auto) {
            // 自动播放：位置与方向直接由音频时间在官方路线上解析（ADR-4：位置 = f(音频时间)）。
            // 绝不做逐帧累加 —— 否则在几百个转向点处，每个转向帧都会把整帧的位移
            // 按「旧方向」走完再转向，这种量化误差不会抵消，会一路累积到明显偏离路线。
            // 由时间插值取位置，累积误差在数学上恒为 0。
            L._trailFrom = L.lastT;               // 本帧轨迹要覆盖的时间区间起点
            const v = vertAt(L.verts, t);
            L.pos.x = v.x; L.pos.y = v.y; L.pos.z = v.z;
            L.dir = v.dir;                        // 线头朝向取自路线
          } else {
            // 玩家：沿「自己的当前方向」匀速前进
            // （方向由该线的按键决定，不沿官方路线）
            const ddt = Math.max(0, t - L.lastT);
            L.pos.x += DIRS[L.dir][0] * ddt * spd;
            L.pos.z += DIRS[L.dir][1] * ddt * spd;
          }
          L.lastT = t;
        }
      }

      // 场景瞬移：跳到新场景的对应位置，并保留玩家相对官方路线的偏移量
      // （玩家在前一场景偏左，新场景也同等程度偏左）。只作用于线 A。
      const L0 = this.lines[0];
      L0._jumped = false;
      while (this.tpIdx < this.teleports.length && t >= this.teleports[this.tpIdx].t) {
        const tp = this.teleports[this.tpIdx++];
        const before = posAt(L0.verts, tp.t - 1e-3);
        const after = posAt(L0.verts, tp.t + 1e-3);
        const off = { x: L0.pos.x - before.x, z: L0.pos.z - before.z };
        L0.pos = { x: after.x + off.x, z: after.z + off.z };
        // 瞬移不产生轨迹：采样点直接跟到新位置
        L0.lastSample.x = L0.pos.x; L0.lastSample.z = L0.pos.z;
        this.camReady = false;                  // 相机直接跳过去，别横跨 1500m
        L0._jumped = true;                      // 本帧跨了瞬移，轨迹不沿路线铺
      }

      // 逐线判定
      for (const L of this.lines) {
        // 官方路线上「此刻应该在」的位置（高度与水平参考都用时间轴，保持与音乐同步）
        const ref = posAt(L.verts, t);

        // 死亡判定分两步：先跑出路面 → 开始下坠；掉够深（或摔到地面）→ 才判死。
        // 直接「碰到边缘就死」手感很硬，DL 里是掉下去才失败。
        // 只要线还有一点点搭在路面上就不掉：线的外沿越过了路面外沿才算出界。
        // 线宽 lineW、路宽 roadW，所以阈值是两者半宽之和（而不是 roadW/2）。
        const off = Math.hypot(L.pos.x - ref.x, L.pos.z - ref.z);
        if (!L.falling && off > this.roadW / 2 + this.lineW / 2) {
          L.falling = true;
          L.vy = 0;
        }
        if (L.falling) {
          const g = (this.level.motion && this.level.motion.gravity) || 10;
          L.vy -= g * dt;
          L.pos.y += L.vy * dt;
          // 高架桥下方有地面 → 摔到地面即死；贴地关卡下方是虚空 → 掉够深度才死
          const deathY = (this.level.bridge && this.level.bridge.deckY > 0)
            ? 0 : ref.y - FALL_DEPTH;
          if (L.pos.y <= deathY) { this.die(); break; }
        } else {
          L.pos.y = ref.y;      // 还在路面上：贴着桥面走
        }

        L.cur = { x: L.pos.x, y: L.pos.y, z: L.pos.z };

        // 轨迹跟随玩家实际路径（下坠时不产生新轨迹）
        // 自动播放：沿官方路线铺设（拐角精确断开，不斜切）；玩家：沿实际路径采样
        if (!L.falling) {
          if (L.auto && !L._jumped) this.emitRouteTrail(L, L._trailFrom, t);
          else this.emitTrail(L);
        }
      }

      this.updateCenter();
      if (t >= this.dur - 1e-3) this.finish();
    } else if (this.state === "dead") {
      if (performance.now() - this.deadAt > 1000) this.reset();   // 1 秒后自动重来
    } else if (this.state === "idle") {
      this.updateCenter();
    }

    this.renderFrame(t);
    this.updateWhiteFade(t);
    if (this.onTick) this.onTick(t, this);
  }

  // 场景瞬移的白屏过渡：渐白 → （瞬移已在 update 中完成）→ 从白淡出
  updateWhiteFade(t) {
    if (!this.fadeEl) this.fadeEl = document.getElementById("whiteFade");
    if (!this.fadeEl) return;
    let op = 0;
    for (const s of (this.level.scenes || [])) {
      const e = s.enter;
      if (!e || e.type !== "teleport") continue;
      const fi = e.fadeIn || 2.5, fo = e.fadeOut || 2.5, t0 = s.t[0];
      if (t < t0 - fi || t > t0 + fo) continue;
      op = t < t0 ? (t - (t0 - fi)) / fi : 1 - (t - t0) / fo;
      op = Math.max(0, Math.min(1, op));
    }
    this.fadeEl.style.opacity = op;
  }

  // 当前时刻相机相对线头中点的偏移
  // （cameraOrbit 管方位角环绕，cameraOrbit.zoom 管距离整体放大）
  camOffsetAt(t) {
    const o = this.level.cameraOrbit;
    let ox = CAM_OFF.x, oy = CAM_OFF.y, oz = CAM_OFF.z;
    if (o && o.angleDeg) {
      const yaw = orbitYaw(this.level, t);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const R = Math.hypot(CAM_OFF.x, CAM_OFF.z);
      const b = this.camBase;               // 基准「正后方」单位向量
      // 绕 +Y 转 yaw：x' = x cos + z sin；z' = -x sin + z cos
      ox = (b.x * c + b.z * s) * R;
      oz = (-b.x * s + b.z * c) * R;
    }
    const k = zoomScale(this.level, t);     // 拉远倍数（乘在整条向量上 → 距离等比放大）
    return { x: ox * k, y: oy * k, z: oz * k };
  }

  renderFrame(t) {
    // 每条线：线头位置与朝向
    for (const L of this.lines) {
      L.mesh.position.set(L.cur.x, L.cur.y + this.lineW / 2 + L.yOff, L.cur.z);
      const d = DIRS[L.dir];
      L.mesh.rotation.y = Math.atan2(d[0], d[1]);
    }

    // 相机以「线头中点」为中心；偏移可能随关卡环绕（双线关卡）
    const p = this.center;
    const off = this.camOffsetAt(t);

    // 相机：平滑跟随（水平 x/z 指数平滑，时间常数 CAM_SMOOTH）。
    // 偏移 off 不变时（单线关卡）注视点 = 滞后后的中点，视线方向恒定，
    // 只有跟随位置有滞后 —— 转向时线头略微偏离画面中心，产生"甩尾感"。
    // 有 cameraOrbit 时 off 本身在变，视线方向就会跟着变（那是运镜本身要的效果）；
    // 平滑只作用在 cos 之前的跟随位置层，不会把运镜的匀速抹成缓入缓出。
    const tx = p.x + off.x, ty = p.y + off.y, tz = p.z + off.z;
    if (!this.camReady) {
      this.camPos.set(tx, ty, tz);
      this.camReady = true;
    } else {
      const dt = this._dt || 0.016;
      const k = CAM_SMOOTH > 0 ? 1 - Math.exp(-dt / CAM_SMOOTH) : 1;
      this.camPos.x += (tx - this.camPos.x) * k;
      this.camPos.z += (tz - this.camPos.z) * k;
      this.camPos.y = ty;      // 垂直方向不做平滑，坠落时相机才不会落后到看不见线头
    }
    this.camera.position.copy(this.camPos);
    this.camLook.set(
      this.camPos.x - off.x,
      this.camPos.y - off.y,
      this.camPos.z - off.z
    );
    this.camera.lookAt(this.camLook);

    // 主题色平滑过渡（分幕切换时不会突变）
    const th = THEME[themeAt(this.level, t)] || THEME.void;
    const k = 0.035;
    this._tmp.setHex(th.sky); this.skyColor.lerp(this._tmp, k);
    this._tmp.setHex(th.fog); this.fogColor.lerp(this._tmp, k);
    this._tmp.setHex(th.road); this.roadMat.color.lerp(this._tmp, k);
    this.scene.background.copy(this.skyColor);
    this.scene.fog.color.copy(this.fogColor);

    this.renderer.render(this.scene, this.camera);
  }

  /* ---------------------- 杂项 ---------------------- */
  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setGuide(v) {
    for (const gl of (this.guideLines || [])) gl.visible = !!v;
  }
  setLatency(ms) { this.clock.setLatency(ms); }
  setVolume(v) { this.volume = v; this.clock.setVolume(v); }

  get progress() { return this.dur ? this.clock.time / this.dur : 0; }

  dispose() {
    this.clock.stop();
    this.renderer.dispose();
  }
}
