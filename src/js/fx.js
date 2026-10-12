/* ---------------------------------------------------------------------------
   氛围粒子（fx.js）
   官方关卡里几乎每一关都有"空气里的东西"：春天是花粉/柳絮、寒冬是雪、海洋是气泡、
   游乐园是彩色纸屑、大教堂是浮尘。它们不影响玩法，但**是"这关活着"的主要来源**——
   没有粒子，画面就是一张干净到假的静物。
   实现取巧：不按整条路撒粒子（那要几万个），而是**固定一个池子（默认 800 个）跟着
   相机/线头走**，每个粒子在"头部周围 46×26×46 的盒子"里有一个偏移量；偏移随速度漂移，
   越界就从对面绕回来。于是不管走到哪里，视野里永远有粒子在飘。
   --------------------------------------------------------------------------- */
import * as THREE from "../vendor/three.module.min.js";

// 每个母题的粒子配方：颜色 / 大小 / 升降速度 / 横向摇摆 / 不透明度 / 密度系数
export const MOTIF_FX = {
  deck:     { color: 0xfff2c0, size: 0.19, rise: 0.34, sway: 0.9, op: 0.85 },  // 花粉、柳絮
  flat:     { color: 0xfff0c8, size: 0.18, rise: 0.28, sway: 0.8, op: 0.8 },
  canyon:   { color: 0xffd8a8, size: 0.16, rise: 0.22, sway: 0.7, op: 0.7 },   // 浮尘
  terraces: { color: 0xffd2e4, size: 0.24, rise: 0.12, sway: 1.4, op: 0.9 },   // 花瓣
  islands:  { color: 0xffe6f0, size: 0.24, rise: 0.16, sway: 1.3, op: 0.9 },
  cloud:    { color: 0xffffff, size: 0.22, rise: -0.5, sway: 0.6, op: 0.95 },  // 雪
};
MOTIF_FX.default = MOTIF_FX.flat;

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0.0, "rgba(255,255,255,1)");
  r.addColorStop(0.35, "rgba(255,255,255,0.85)");
  r.addColorStop(0.75, "rgba(255,255,255,0.18)");
  r.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * @param {object} opts {count, box:{x,y,z}, seed}
 * @returns {{points: THREE.Points, update: Function, setColor: Function}}
 */
export function buildAtmos(opts = {}) {
  const N = opts.count || 800;
  const box = opts.box || { x: 46, y: 24, z: 46 };
  let seed = (opts.seed || 20261012) >>> 0;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const ox = new Float32Array(N), oy = new Float32Array(N), oz = new Float32Array(N);
  const ph = new Float32Array(N), sp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    ox[i] = (rnd() - 0.5) * box.x;
    oy[i] = (rnd() - 0.5) * box.y;
    oz[i] = (rnd() - 0.5) * box.z;
    ph[i] = rnd() * Math.PI * 2;
    sp[i] = 0.5 + rnd() * 1.6;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mat = new THREE.PointsMaterial({
    size: 0.2, map: dotTexture(), vertexColors: true, transparent: true,
    opacity: 0.85, depthWrite: false, sizeAttenuation: true,
    blending: THREE.NormalBlending, alphaTest: 0.01,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  points.name = "atmos";

  const cur = new THREE.Color(0xfff2c0);
  let curSize = 0.2;
  const setColor = (hex, size, op) => {
    cur.setHex(hex);
    curSize = size;
    mat.size = size;
    if (op != null) mat.opacity = op;
    for (let i = 0; i < N; i++) {
      col[i * 3] = cur.r; col[i * 3 + 1] = cur.g; col[i * 3 + 2] = cur.b;
    }
    geo.attributes.color.needsUpdate = true;
  };
  setColor(0xfff2c0, 0.2, 0.85);

  // 让颜色平滑过渡（换段时粒子不会"啪"地变色）
  const want = new THREE.Color(0xfff2c0);
  let wantSize = 0.2, wantOp = 0.85;
  const want_ = (hex, size, op) => {
    want.setHex(hex); wantSize = size; wantOp = op;
  };

  const update = (dt, t, hx, hy, hz, fx) => {
    if (fx) want_(fx.color, fx.size, fx.op);
    // 颜色/大小平滑逼近目标
    const k = 1 - Math.exp(-dt / 0.35);
    cur.lerp(want, k);
    curSize += (wantSize - curSize) * k;
    mat.size = curSize;
    mat.opacity += (wantOp - mat.opacity) * k;
    for (let i = 0; i < N; i++) {
      const rise = fx ? fx.rise : 0.3;
      const sway = fx ? fx.sway : 0.8;
      oy[i] += rise * dt * (0.6 + 0.8 * ((i * 37) % 11) / 11);
      ox[i] += Math.sin(t * sp[i] + ph[i]) * sway * 0.35 * dt;
      oz[i] += Math.cos(t * sp[i] * 0.8 + ph[i] * 1.7) * sway * 0.35 * dt;
      // 越界绕回（让粒子场"无限"
      const hb = box.y / 2;
      if (oy[i] > hb) oy[i] -= box.y;
      else if (oy[i] < -hb) oy[i] += box.y;
      const hx2 = box.x / 2, hz2 = box.z / 2;
      if (ox[i] > hx2) ox[i] -= box.x; else if (ox[i] < -hx2) ox[i] += box.x;
      if (oz[i] > hz2) oz[i] -= box.z; else if (oz[i] < -hz2) oz[i] += box.z;
      pos[i * 3] = hx + ox[i];
      pos[i * 3 + 1] = hy + oy[i];
      pos[i * 3 + 2] = hz + oz[i];
      col[i * 3] = cur.r; col[i * 3 + 1] = cur.g; col[i * 3 + 2] = cur.b;
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  };

  return { points, update, setColor };
}
