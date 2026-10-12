// 地形层：关卡的「地面」。
//
// 为什么需要这一层
// ----------------
// 真实《跳舞的线》关卡的地面是**一整块有厚度的地形**（草皮在上、断面在下），
// 路就嵌在这块地形里；而不是「一堆离散方块浮在空中」。
//
// 数据格式（level.terrain）
// ------------------------
//   {
//     "v": 1,
//     "base": { "motif": "deck", "params": { ... } },          // 整关的底子
//     "spans": [                                               // 局部换母题
//       { "t": [60, 90], "motif": "canyon", "params": { ... } }
//     ],
//     "endcap": { ... }                                        // 结尾的截开金字塔（可省略 / 传 false）
//   }
// 母题（motif）四种，全部只用基本几何体拼：
//   deck     厚板台地：一整块地面 + 一圈更低的台阶，边缘能看到切面
//   canyon   裂谷：路在切开的槽里，两侧是高台，台面一直铺到很远（不是"桥两边鼓包"）
//   terraces 梯台/浮岛：路架在一串大台面上，台间留空，两侧散布更低的卫星台
//   cloud    云海：路走在宽板上，板的两侧堆着云团
//
// 颜色不进关卡
// ------------
// 地面用什么颜色由**客户端的主题表**（THEME 的 scenNear/scenMid/scenFar）决定，
// 和场景一起过渡。关卡只描述"形状"，这样同一份形状可以换主题复用。
//
// ⚠️ 为什么地面的"形状"不能再用「闭合轮廓 + 中间挖洞」那种做法
// ----------------------------------------------------------
// 这个关的路是「每拍一个 90° 转角」的楼梯形（段长中位数 3m，最小 1.17m）。
// 把这样一条折线向外偏移若干米得到闭合轮廓、再靠挖洞做出中间的槽，
// 偏移线在密集转角处**一定自交**，三角化时"洞"会被填死 →
// 表现就是**一整块地面盖住整条路**（视频 1min8s 那一帧就是这个）。
// 所以现在只在**远离路**的外轮廓上用闭合轮廓（台地那种大块形状，平滑之后没问题），
// 靠近路的形状一律改成**沿路生成的条带（ribbon）和分段盒子**：
// 条带和盒子不会因为转角密而"整片糊住"，最多在转角处折一下。

import * as THREE from "../vendor/three.module.min.js";

/* ------------------------------ 折线工具 ------------------------------ */

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

// 逐点的右法线（用前后两点连线的方向，**不做斜接除法**）。
// 为什么不像 offsetSide 那样求交：转角处斜接点会跑到 1.8d 以外，
// 对离路只有两三米的形状来说就是"一根刺扎到路面上"。条带宁可在这里折一下。
function pathNormals(pts) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const L = Math.hypot(dx, dz) || 1;
    out.push({ nx: -dz / L, nz: dx / L });
  }
  return out;
}

// 坐标移动平均（点数不变，**首尾两点固定**）。
// 为什么首尾必须固定：轮廓的两端就是地形的"横切口"，早先用闭合环平滑
// （首尾也一起平均）把切口拽进去 7.6m，开头那一截路面就悬空了。
// 为什么需要它：直接用楼梯形路径做 30m 宽的外轮廓，边缘会是一串密集小锯齿。
function smoothCoords(pts, iters) {
  let cur = pts;
  for (let it = 0; it < iters; it++) {
    const n = cur.length;
    if (n < 4) break;
    const nx = cur.slice();
    for (let i = 1; i < n - 1; i++) {
      const a = cur[i - 1], b = cur[i], c = cur[i + 1];
      nx[i] = { x: (a.x + 2 * b.x + c.x) / 4, z: (a.z + 2 * b.z + c.z) / 4, y: b.y, t: b.t };
    }
    cur = nx;
  }
  return cur;
}

/* --------------------------- 几何原语（稳） --------------------------- */

function meshFromPositions(pos, matl, name) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, matl);
  if (name) m.name = name;
  return m;
}

// 水平条带：两条边可以各自来自不同的折线 / 不同偏移量。
//   ptsA + offA  → 一条边
//   ptsB + offB  → 另一条边
// 这样就能"内沿贴着精确路径、外沿用平滑路径"，既不留缝也不出锯齿。
function flatBand(ptsA, offA, ptsB, offB, y, matl, name) {
  const NA = pathNormals(ptsA), NB = ptsB === ptsA ? NA : pathNormals(ptsB);
  const pos = [];
  const pt = (P, N, i, off) => [P[i].x + N[i].nx * off, y, P[i].z + N[i].nz * off];
  for (let i = 1; i < ptsA.length; i++) {
    const a0 = pt(ptsA, NA, i - 1, offA), b0 = pt(ptsB, NB, i - 1, offB);
    const a1 = pt(ptsA, NA, i, offA), b1 = pt(ptsB, NB, i, offB);
    pos.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
  }
  return meshFromPositions(pos, matl, name);
}

// 竖直条带：在离路 off 的位置竖一堵墙（y0→y1）
function vertBand(pts, off, y0, y1, matl, name) {
  const N = pathNormals(pts), pos = [];
  const px = (i) => pts[i].x + N[i].nx * off, pz = (i) => pts[i].z + N[i].nz * off;
  for (let i = 1; i < pts.length; i++) {
    const x0 = px(i - 1), z0 = pz(i - 1), x1 = px(i), z1 = pz(i);
    pos.push(x0, y0, z0, x0, y1, z0, x1, y1, z1);
    pos.push(x0, y0, z0, x1, y1, z1, x1, y0, z1);
  }
  return meshFromPositions(pos, matl, name);
}

// 用分段盒子拼一堵沿路的墙（盒子的长度多吃 extend 米，转角处的缺口就被盖住了）。
// 盒子是实体，重叠部分不会 z-fighting —— 但**墙顶会和它上面的台面共面**，
// 所以调用方要把墙顶压低几厘米（见 motifCanyon）。
function wallBoxes(pts, off, width, yBase, yTop, matl, extend, name) {
  const N = pathNormals(pts), items = [];
  const h = yTop - yBase, cy = (yBase + yTop) / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    items.push({
      x: (a.x + b.x) / 2 + N[i].nx * off,
      y: cy,
      z: (a.z + b.z) / 2 + N[i].nz * off,
      ang: Math.atan2(dx, dz),
      w: width,
      h,
      len: L + extend,
    });
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const inst = new THREE.InstancedMesh(geo, matl, items.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const v = new THREE.Vector3(), s = new THREE.Vector3();
  items.forEach((it, i) => {
    e.set(0, it.ang, 0);
    q.setFromEuler(e);
    v.set(it.x, it.y, it.z);
    s.set(it.w, it.h, it.len);
    m4.compose(v, q, s);
    inst.setMatrixAt(i, m4);
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  if (name) inst.name = name;
  return inst;
}

/* --------------------- 闭合轮廓那套（只给大块形状用） --------------------- */

// 沿折线左侧偏移 d 的轮廓线（斜接）。**只给台地这种远离路的宽形状用**。
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

function smoothChain(pts, alpha, iters) {
  let cur = pts;
  for (let it = 0; it < iters; it++) {
    const n = cur.length;
    if (n < 4) break;
    const nx = cur.slice();
    for (let i = 1; i < n - 1; i++) {
      const a = cur[i - 1], b = cur[i], c = cur[i + 1];
      nx[i] = {
        x: b.x + alpha * ((a.x + c.x) / 2 - b.x),
        z: b.z + alpha * ((a.z + c.z) / 2 - b.z),
      };
    }
    cur = nx;
  }
  return cur;
}

function band(pts, d, smooth) {
  const L = offsetSide(pts, d);
  const R = offsetSide(pts, -d);
  if (!smooth) return L.concat(R.reverse());
  return smoothChain(L, smooth.a, smooth.i).concat(smoothChain(R, smooth.a, smooth.i).reverse());
}

const SM = { a: 0.6, i: 2 };

// 2D 轮廓 → 有厚度的实心板：顶面在 surfaceY，向下延伸 th
function slab(outline, surfaceY, th, matl, name) {
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, -p.z)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, matl);
  m.position.y = surfaceY - th;
  if (name) m.name = name;
  return m;
}

// 不规则圆盘（梯台的台面）
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

// A 厚板台地：一整块 + 一圈更低的台 + 外沿切面
function motifDeck(pts, W, M, surf) {
  const w = W.walk / 2, out = [];
  out.push(slab(band(pts, w + W.shelf, SM), surf, W.th, M.mid, "deck-top"));
  out.push(slab(band(pts, w + W.shelf * 2.2, SM), surf - W.step, W.th * 0.8, M.near, "deck-shelf"));
  return out;
}

// B 裂谷：槽底 + 两侧高台（台面一直铺到 plateauW，不是"桥两边鼓包"）+ 两侧槽壁
function motifCanyon(pts, W, M, surf) {
  const w = W.walk / 2, out = [];
  // 两条平滑路径各司其职：
  //   sm1（轻平滑）给"槽口/槽壁"——离路只有几米，平滑太狠会切到路面上；
  //   sm2（重平滑）给"槽底/高台外沿"——离路很远，可以放心抹平锯齿。
  const sm1 = smoothCoords(pts, 1), sm2 = smoothCoords(pts, 3);
  const rim = w + W.slot;                // 槽口内沿（也是高台的内边）
  const top = surf + W.hi;

  // 槽底：一个宽条带（外侧被高台盖住，看不见边）
  out.push(flatBand(sm2, -W.floorW, sm2, W.floorW, surf, M.far, "canyon-floor"));

  // 两侧高台：**内沿和槽壁共用 sm1 + rim 这一批点**（接缝绝对不漏），
  // **外沿用 sm2**（不然 30m 宽的高台边缘会是一串密集锯齿）
  out.push(flatBand(sm1, +rim, sm2, +W.plateauW, top, M.mid, "canyon-plateau-r"));
  out.push(flatBand(sm1, -rim, sm2, -W.plateauW, top, M.mid, "canyon-plateau-l"));

  // 槽壁：薄薄一层竖直面就够了 —— 顶边和台面内沿是同一批点，水密。
  // （早先用"分段盒子"拼墙，6m 厚的盒子在 90° 转角互相穿插，糊成一团方块。）
  out.push(vertBand(sm1, +rim, surf - W.th, top, M.near, "canyon-wall-r"));
  out.push(vertBand(sm1, -rim, surf - W.th, top, M.near, "canyon-wall-l"));

  // 高台外沿的立面（给厚度感）
  out.push(vertBand(sm2, +W.plateauW, top - W.th, top, M.mid));
  out.push(vertBand(sm2, -W.plateauW, top - W.th, top, M.mid));
  return out;
}

// C 梯台/浮岛：路架在一串大台面上（台心就在路上，所以永远盖不住路），两侧散布更低的卫星台
function motifTerraces(pts, W, M, surf) {
  const out = [];
  let acc = W.gap, i = 0;
  for (let j = 1; j < pts.length; j++) {
    const a = pts[j - 1], b = pts[j];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    acc += L;
    if (acc < W.gap) continue;
    acc = 0;
    // 主台：**圆心落在路上**、顶面与地面齐平 —— 这样它只会托着路，不可能盖住路。
    // 每块台面压低几厘米且互不相同，避免相邻台面共面闪烁。
    out.push(disc(
      b.x, b.z,
      W.rx * (0.82 + (((i * 29) % 9) / 9) * 0.36),
      W.ry * (0.82 + (((i * 13) % 7) / 7) * 0.36),
      surf - 0.02 - (i % 4) * 0.03,
      W.th, 9, i % 2 ? M.mid : M.far, i
    ));
    i++;
  }
  // 卫星台：离路至少 w+10 米、并且比地面低 4~11 米，所以同样挡不住视线
  const N = pathNormals(pts);
  let acc2 = W.gap2, k = 0;
  for (let j = 1; j < pts.length; j++) {
    const a = pts[j - 1], b = pts[j];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    acc2 += L;
    if (acc2 < W.gap2) continue;
    acc2 = 0;
    const side = k % 2 === 0 ? 1 : -1;
    const off = W.off0 + (((k * 53) % 11) / 11) * W.offSpan;
    const cx = b.x + N[j].nx * side * off, cz = b.z + N[j].nz * side * off;
    if (distPath(cx, cz, pts) < W.off0 * 0.8) continue;
    const low = W.low0 + (((k * 17) % 5) / 5) * W.lowSpan;
    out.push(disc(
      cx, cz,
      W.rx2 * (0.8 + (((k * 31) % 7) / 7) * 0.4),
      W.ry2 * (0.8 + (((k * 19) % 7) / 7) * 0.4),
      surf - low, W.th, 8, k % 2 ? M.near : M.mid, k + 77
    ));
    k++;
  }
  return out;
}

// D 云海：一条宽板，板的两侧下方堆云团
function motifCloud(pts, W, M, surf) {
  const sm = smoothCoords(pts, 2), out = [];
  out.push(flatBand(sm, -W.plateW, sm, W.plateW, surf, M.mid, "cloud-plate"));
  out.push(vertBand(sm, +W.plateW, surf - W.th, surf, M.mid));
  out.push(vertBand(sm, -W.plateW, surf - W.th, surf, M.mid));

  const N = pathNormals(pts);
  let acc = W.gap, i = 0;
  for (let j = 1; j < pts.length; j++) {
    const a = pts[j - 1], b = pts[j];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 1e-6) continue;
    acc += L;
    if (acc < W.gap) continue;
    acc = 0;
    const side = i % 2 === 0 ? 1 : -1;
    const off = W.plateW + W.off0 + (((i * 53) % 13) / 13) * W.offSpan;
    const cx = b.x + N[j].nx * side * off, cz = b.z + N[j].nz * side * off;
    const cy = surf + W.low + (((i * 17) % 5) / 5) * W.hSpan;
    i++;
    // 云团是一簇球，会从中心往四周散开 ±2r 左右，所以净空要按"中心离路 ≥ r*2.5"来判，
    // 否则大云团会有一半个球压到路面上（第一版就是这样）。
    if (distPath(cx, cz, pts) < W.r * 2.5) continue;
    for (let k = 0; k < 4 + (i % 3); k++) {
      const r = W.r * (0.6 + (((i * 31 + k * 17) % 9) / 12));
      const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), M.far);
      m.position.set(
        cx + (((i + k * 3) % 5) - 2) * r * 0.75,
        cy + (((i * 2 + k) % 4) - 1.5) * r * 0.45,
        cz + (((i * 3 + k) % 5) - 2) * r * 0.75
      );
      m.scale.set(1, 0.62, 1);
      out.push(m);
    }
  }
  return out;
}

// E 结尾：**中间截开的金字塔**——一座四棱锥被"过顶点与底面一条对角线"的竖直面切成两半，
//    两半各自向左右让开 slotW/2，中间留出一条缝，线从缝里进去（真实关卡收尾的常见做法）。
//    底面做成菱形（两条对角线分别沿行进方向与左右方向），于是那条缝正好顺着路走。
//    ⚠️ 别做成"三角形截面挤出"——挤出来是一道长长的屋脊，从正面看就是两块竖墙（踩过）。
function endPyramid(pts, W, M, surf) {
  const n = pts.length;
  const last = pts[n - 1], prev = pts[n - 2] || pts[0];
  let dx = last.x - prev.x, dz = last.z - prev.z;
  const L = Math.hypot(dx, dz) || 1;
  dx /= L; dz /= L;

  const s = W.halfW;                    // 底面菱形半对角线（沿路 / 沿左右各 s）
  const H = W.h;                        // 塔高
  const gap = (W.slotW == null ? 6 : W.slotW) / 2;   // 两半各向两侧让开多少
  const sink = W.sink == null ? 3 : W.sink;          // 底座埋进地面，免得看到"浮空的塔底"
  const apex = [0, H, 0];
  // 两半的底面三角形：共用"前后两个角"，第三个角分别在 +x / -x 一侧
  const tri = (sign) => [[0, 0, s], [sign * s, 0, 0], [0, 0, -s]];

  const out = [];
  for (const sign of [1, -1]) {
    const base = tri(sign);
    const pos = [];
    const put = (p) => pos.push(p[0] + sign * gap, p[1] - sink, p[2]);
    put(base[0]); put(base[2]); put(base[1]);                 // 底面
    for (const [a, b] of [[base[0], base[1]], [base[1], base[2]], [base[2], base[0]]]) {
      put(a); put(b); put(apex);                              // 三个侧面（含被切开的那一面）
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, M.mid);
    m.name = "endcap";
    // ⚠️ 塔的**正面**要退到路的终点之前 `enter` 米：相机在线的后上方（离线约 24m），
    //    塔要是以终点为中心，相机会被关在塔体里面（只剩两块巨大的内表面）。
    m.position.set(last.x - dx * W.enter, surf, last.z - dz * W.enter);
    m.rotation.y = Math.atan2(dx, dz);              // 让局部 +z 指向行进方向
    out.push(m);
  }
  return out;
}

const MOTIFS = { deck: motifDeck, canyon: motifCanyon, terraces: motifTerraces, islands: motifTerraces, cloud: motifCloud };

// 每种母题缺省的尺寸参数（关卡里可以逐个覆盖）
export const DEFAULT_PARAMS = {
  deck: { walk: 7.0, shelf: 2.4, th: 3.2, step: 1.6 },
  canyon: { walk: 4.4, slot: 2.2, hi: 4.0, floorW: 12, plateauW: 30, th: 3.0 },
  terraces: { walk: 5.0, gap: 18, rx: 8.5, ry: 6.5, th: 2.0, gap2: 13, off0: 11, offSpan: 16, rx2: 5.5, ry2: 4.2, low0: 4, lowSpan: 7 },
  islands: { walk: 5.0, gap: 18, rx: 8.5, ry: 6.5, th: 2.0, gap2: 13, off0: 11, offSpan: 16, rx2: 5.5, ry2: 4.2, low0: 4, lowSpan: 7 },
  cloud: { walk: 5.4, plateW: 14, th: 3.0, gap: 9, off0: 12, offSpan: 14, low: -4.5, hSpan: 3, r: 3.4 },
  // 结尾的金字塔：真实关卡里它是一座"吃掉整屏"的巨物，所以尺寸给得很大
  // （路宽 3m，相机离线 24m / 高 21m → 90m 高、180m 宽的塔会把画面填满）
  // ⚠️ `slotW` 是两半之间的缝有多宽：缝太窄，相机钻进去以后画面就只剩两侧的切面
  //    （看不到缝的尽头），所以给到 24m。
  // ⚠️ `enter` 是"塔心在路终点之前多少米"，负值表示塔心在终点**之后**。
  //    它跟"相机在缝里待多久"直接挂钩：相机永远在线的后 24m，所以
  //    正面角点（塔心再往前 halfW）落在 -24m 时，整关结束的瞬间相机刚好到缝口，
  //    整个结尾是"看着金字塔的正面角点迎面压过来、路钻进缝里"。
  //    → enter = -(halfW + 24) = -66（再往里就会变成一路上只看两侧切面）
  endcap: { halfW: 90, slotW: 24, h: 110, enter: -66, sink: 3, palette: "cream" },
};

/* 地形色卡：关卡里只写**名字**，颜色仍然不进关卡文件（和主题色一个道理） */
export const PALETTES = {
  rose:  { near: 0x8e2a57, mid: 0xc06a95, far: 0xf0d2e0 },   // 和 pink 主题同色
  plum:  { near: 0x2f1730, mid: 0x6b3f63, far: 0xbe9cba },   // 深紫：裂谷
  sand:  { near: 0x8a5a2b, mid: 0xc9a86f, far: 0xf2e4c4 },   // 暖沙：层叠平台
  ice:   { near: 0x27506e, mid: 0x5f89a6, far: 0xcfe2ec },   // 冰蓝：云海
  jade:  { near: 0x2f6b48, mid: 0x74ad91, far: 0xc4e8d5 },   // 草绿
  cream: { near: 0xa89f8e, mid: 0xe9e3d7, far: 0xfdfbf6 },   // 发白的米色：结尾金字塔
};

/* --------------------------- 组装整条地形 --------------------------- */

// 把 level.path 还原成带时间的折线。
// ⚠️ path[i].pos 是**绝对世界坐标**，直接当顶点用（见 src/js/level.js 的 buildVerts）。
function collectPath(level) {
  const sp = level.motion && level.motion.spawn ? level.motion.spawn : { x: 0, y: 0, z: 0 };
  const pts = [{ x: sp.x, y: sp.y, z: sp.z, t: 0 }];
  for (const p of level.path || []) {
    pts.push({ x: p.pos[0], y: p.pos[1], z: p.pos[2], t: p.t || 0 });
  }
  return pts;
}

// 去掉过密的短段（这个关最短 1.17m）
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
    const params = (s && s.params) || (spec.base && spec.base.params) || {};
    const palette = (s && s.palette) || (spec.base && spec.base.palette) || null;
    if (!cur || cur.motif !== name || cur.palette !== palette) {
      cur = { motif: name, params, palette, pts: [] };
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
 *        而路面还要继续延伸到关卡结束（这关多出 108m），那一段路就会悬空。
 * @returns {THREE.Group|null} 地形组；group.userData.materials 是 3 份材质，供换主题时改色
 */
export function buildTerrain(level, colors, verts) {
  const spec = level && level.terrain;
  if (!spec || !spec.base || !spec.base.motif || !MOTIFS[spec.base.motif]) return null;

  // 双面：条带/盒子的朝向不必抠得很准，双面省掉一整类"整片发黑"的坑
  const mk = (c, rough) => new THREE.MeshStandardMaterial({
    color: c, roughness: rough, metalness: 0, flatShading: true, side: THREE.DoubleSide,
  });
  const mkMats = (c) => ({ near: mk(c.near, 0.92), mid: mk(c.mid, 0.88), far: mk(c.far, 0.95) });
  const mats = mkMats(colors);

  // 色卡材质按名字缓存（同一色卡的多段共用一套材质）。
  // 它们**不进** group.userData.materials：那份是"跟着主题逐帧过渡"的材质，
  // 指定了色卡的地段颜色是固定的，不参与主题过渡。
  const palCache = new Map();
  const palMats = (name) => {
    if (!name || !PALETTES[name]) return null;
    if (!palCache.has(name)) palCache.set(name, mkMats(PALETTES[name]));
    return palCache.get(name);
  };

  const group = new THREE.Group();
  group.name = "terrain";
  group.userData.materials = mats;
  group.userData.paletteMaterials = palCache;

  const src = verts && verts.length > 1
    ? verts.map((v) => ({ x: v.x, y: v.y, z: v.z, t: v.t }))
    : collectPath(level);
  const runs = splitRuns(src, spec);
  for (const run of runs) {
    const fn = MOTIFS[run.motif];
    if (!fn) continue;
    const P = Object.assign({}, DEFAULT_PARAMS[run.motif] || {}, run.params || {});
    // 这一段的地面高度 = 这段路径的最高点，再压低 6cm：
    // 路面色带本身就铺在这个高度上，完全齐平会共面闪烁，压 6cm 的台阶肉眼看不出。
    let top = -Infinity;
    for (const p of run.pts) if (p.y > top) top = p.y;
    const surf = top - 0.06;
    const pts = simplify(run.pts, 2.0);
    const rm = palMats(run.palette) || mats;      // 这一段用哪套材质
    for (const m of fn(pts, P, rm, surf)) group.add(m);
  }

  // 结尾：中间截开的金字塔
  if (spec.endcap !== false && src.length > 2) {
    const P = Object.assign({}, DEFAULT_PARAMS.endcap, spec.endcap || {});
    let top = -Infinity;
    for (const p of src) if (p.y > top) top = p.y;
    const flat = simplify(src, 1.0);
    const em = palMats(P.palette) || mats;
    for (const m of endPyramid(flat, P, em, top - 0.06)) group.add(m);
  }
  return group;
}
