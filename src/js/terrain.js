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
  // 颜色用 mid 不用 near：竖直面只吃环境光，near 会黑成一条洞；官方山脉的崖壁
  // 也是"和台面同色、靠顶亮/侧暗区分"。
  out.push(vertBand(sm1, +rim, surf - W.th, top, M.mid, "canyon-wall-r"));
  out.push(vertBand(sm1, -rim, surf - W.th, top, M.mid, "canyon-wall-l"));

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

// E 无限厚板（ETW29「驻足的宁静」）——整关**只有一块板**：顶面米黄、断面蓝灰。
//   这是那个关卡最该抄的第 1 条："一种材质造一座世界"：
//   一个平面 + 两种面（顶面/断面）+ 摆放方块，就能同时表达「平地 / 悬崖 / 峡谷 / 碎片 / 柱林」，
//   地形变化全靠**在这块板上切槽**（减法），而不是往空中搭东西（加法）。
//   板面要"无限延伸"：半宽给到 100m 以上，再配合**很近的雾**（见 game.js 的 fogRange），
//   远处板面直接溶进天空同色 → 画面里根本不存在地平线，留白就是主角。
function motifBoard(pts, W, M, surf) {
  const w = W.walk / 2, out = [];
  const sm1 = smoothCoords(pts, 1), sm2 = smoothCoords(pts, 3);
  const half = W.half, th = W.th;
  if (W.slot > 0) {
    // 板上切出折线槽：**槽底与台面同色（米黄），露出来的槽壁断面是蓝灰**。
    // 路走槽底，于是"峡谷"是挖出来的，不是搭出来的。
    const rim = w + W.slot, top = surf + W.hi;
    out.push(flatBand(sm2, -half, sm2, -rim, top, M.mid, "board-l"));
    out.push(flatBand(sm1, rim, sm2, half, top, M.mid, "board-r"));
    out.push(flatBand(sm1, -rim, sm1, rim, surf, M.mid, "board-slot"));
    out.push(vertBand(sm1, +rim, surf - th, top, M.near, "board-wall-r"));
    out.push(vertBand(sm1, -rim, surf - th, top, M.near, "board-wall-l"));
    out.push(vertBand(sm2, +half, top - th, top, M.near, "board-edge-r"));
    out.push(vertBand(sm2, -half, top - th, top, M.near, "board-edge-l"));
  } else {
    out.push(flatBand(sm2, -half, sm2, half, surf, M.mid, "board-top"));
    out.push(vertBand(sm2, +half, surf - th, surf, M.near, "board-edge-r"));
    out.push(vertBand(sm2, -half, surf - th, surf, M.near, "board-edge-l"));
  }
  return out;
}

// F 结尾：**中间截开的金字塔**——一座四棱锥被"过顶点与底面一条对角线"的竖直面切成两半，
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

/* ---------------- G 石板原（paving）：ETW29 开场段的"密铺石板" ---------------- */
// 拆自《驻足的宁静》开场（f0060）：一整块米黄板上**密密麻麻铺满轴对齐的蓝石板**，
//   石板之间留均匀的缝（缝里露出压暗的一道"影子带"），路本身不铺任何东西，
//   靠石板在两边让出的这条"街"来读路 —— 信息量比"散落几块大方块"大一个量级。
//
// 为什么这一层写成地形母题、而不是 place[] 逐件摆：
//   ① 它只受路径约束、几千件、不参与升起动画，本质是"地面的一部分"；
//   ② 写成母题才能合并成几个 draw call（place[] 是 InstancedMesh，但几千件挤进
//      level.json 会让文件涨到几 MB、读盘和 diff 都难受）；
//   ③ **石板要被"街"切掉一角**（紧贴路边），这需要几何裁剪，摆件做不到。
//   place[] 只留给"要动 / 要判定 / 要单独配色"的摆件。
//
// 配方（全部来自 ETW29 f0016/f0060/f0133 的实测比例，见 out/design/v9-recipe.md）：
//   石板 6~15m 见方、厚 0.6~1.6m（厚度 << 边长，所以像"切下来的板"，不像积木）、
//   缝 0.5~1.7m、街宽 ≈ 路宽 + 2.6m。石板顶面 = 道具蓝，台面/街 = 米黄，
//   石板侧面 = 深一档的蓝 —— "米黄是地、蓝才是石板"这一条决定整屏的对比关系，
//   只靠高度差是看不出来的（第一次实验就是顶面也刷米黄，整屏像一板瓷砖）。
//
// 纵深靠两件事，都不靠距离：① 分档台地（0.65 / 1.5 / 2.9 / 4.6m）；
//   ② 低频噪声把"密铺街区"和"空广场"分成成片区域（留白是主色，参考关开阔段
//   地面占屏 87%，逐格随机会让整屏均匀发花、既没有留白也没有簇）。
//
// 时间上的分幕靠 acts：每一幕有自己的色卡/密度/台地高度/立起来的板或柱，
//   还可以给几圈 **walls**（人字折墙，ETW29 段 3 的折线峡谷）。墙高用 4 秒的
//   淡入淡出长出来，所以进/出峡谷没有硬切。
//   为什么墙是"站在平台上的墙"而不是"把平台切一条槽"：槽要在连续条带上按 t
//   变截面，接缝处必然缺一块；而且 ETW29 的峡谷本来就是墙立在板上，不是切下去的。
function motifPaving(pts, W, M, surf, palMats) {
  const out = [];
  const half = W.half, th = W.th;
  // rim = 街的半宽（石板内沿到路中线的距离）
  const rim = W.rim == null ? W.walk / 2 + 1.3 : W.rim;
  // t0 与 t 都认（老数据里有人写 t），并剔掉没有时间的幕 —— 否则排序与 t1Of 会算出 NaN，
  // 后果是"最后一幕的台面又覆盖全程"，和四幕共面 z-fighting 是同一个症状。
  const acts = (W.acts && W.acts.length ? W.acts.map((a) => Object.assign({}, a, {
    t0: a.t0 == null ? (a.t == null ? -1e9 : a.t) : a.t0,
  })) : [{ t0: -1e9 }]).filter((a) => Number.isFinite(a.t0) || a.t0 === -1e9)
    .sort((a, b) => a.t0 - b.t0);
  // 每一幕用自己的色卡（同一座世界、不同段的温度差）
  const actMat = acts.map((a) => (a.palette && palMats ? palMats(a.palette) : null) || M);
  const actAt = (t) => {
    let k = 0;
    for (let i = 0; i < acts.length; i++) if (t >= acts[i].t0) k = i;
    return k;
  };
  const t1Of = (k) => (k + 1 < acts.length ? acts[k + 1].t0 : 1e9);

  // smoothCoords(pts, k)：k 次平滑。k=1 的折角还是 90°，k=3 的折角变成圆角，
  //   所以台面/街面用 sm2（圆角，铺得平），路心轨迹附近用 sm1 保持折线感。
  const sm1 = smoothCoords(pts, 1), sm2 = smoothCoords(pts, 3);
  const N1 = pathNormals(sm1), N2 = pathNormals(sm2);

  // 顶点缓冲：同一个 (幕, 名字, 材质) 攒成一个 mesh
  const acc = new Map();
  const buf = (ai, name, matl) => {
    const k = ai + "|" + name + "|" + matl.uuid;
    let b = acc.get(k);
    if (!b) { b = { pos: [], matl, name: name + "-a" + ai }; acc.set(k, b); }
    return b.pos;
  };
  const pushQuad = (arr, a, b, c, d) => {
    arr.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    arr.push(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
  };
  // 水平条带：在两个偏移之间铺一条带子，y 可以逐点不同
  const strip = (ai, P, N, offA, offB, yFn, name, matl, i0 = 0, i1 = P.length) => {
    const arr = buf(ai, name, matl === undefined ? actMat[ai].mid : matl);
    for (let i = Math.max(1, i0); i < i1; i++) {
      const y0 = yFn(P[i - 1].t || 0), y1 = yFn(P[i].t || 0);
      const A0 = [P[i - 1].x + N[i - 1].nx * offA, y0, P[i - 1].z + N[i - 1].nz * offA];
      const B0 = [P[i - 1].x + N[i - 1].nx * offB, y0, P[i - 1].z + N[i - 1].nz * offB];
      const A1 = [P[i].x + N[i].nx * offA, y1, P[i].z + N[i].nz * offA];
      const B1 = [P[i].x + N[i].nx * offB, y1, P[i].z + N[i].nz * offB];
      pushQuad(arr, A0, B0, B1, A1);
    }
  };
  // 竖直条带（上沿/下沿都可以逐点不同：墙就是从 0 长到 h）
  const vstrip = (ai, P, N, off, yb, yt, name, matl, i0 = 0, i1 = P.length) => {
    const arr = buf(ai, name, matl);
    for (let i = Math.max(1, i0); i < i1; i++) {
      const x0 = P[i - 1].x + N[i - 1].nx * off, z0 = P[i - 1].z + N[i - 1].nz * off;
      const x1 = P[i].x + N[i].nx * off, z1 = P[i].z + N[i].nz * off;
      const b0 = yb(P[i - 1].t || 0), b1 = yb(P[i].t || 0);
      const u0 = yt(P[i - 1].t || 0), u1 = yt(P[i].t || 0);
      if (Math.abs(u0 - b0) < 0.02 && Math.abs(u1 - b1) < 0.02) continue;
      pushQuad(arr, [x0, b0, z0], [x0, u0, z0], [x1, u1, z1], [x1, b1, z1]);
    }
  };
  const CONST = (v) => () => v;

  // 1) 台面（左右两片）+ 街面 + 外缘（全部水平）
  //    ⚠️ 每一幕只建**自己那一段**的索引区间：四幕各建一遍整条会让 4 张台面全部叠在
  //    同一个高度上（z-fighting），谁赢看像素、而且后一幕的色卡会把前一幕盖掉。
  const rangeOf = (P, ai) => {
    const tA = acts[ai].t0, tB = t1Of(ai);
    let i0 = 0, i1 = P.length;
    for (let i = 0; i < P.length; i++) if ((P[i].t || 0) >= tA) { i0 = Math.max(0, i - 1); break; }
    for (let i = 0; i < P.length; i++) if ((P[i].t || 0) >= tB) { i1 = Math.min(P.length, i + 1); break; }
    return [i0, i1];
  };
  for (let ai = 0; ai < acts.length; ai++) {
    const [a0, a1] = rangeOf(sm2, ai);
    if (a1 <= a0) continue;
    strip(ai, sm2, N2, -half, -rim, CONST(surf), "paving-plate-l", undefined, a0, a1);
    strip(ai, sm2, N2, rim, half, CONST(surf), "paving-plate-r", undefined, a0, a1);
    strip(ai, sm2, N2, -rim, rim, CONST(surf), "paving-floor", actMat[ai].floor || actMat[ai].mid, a0, a1);
    vstrip(ai, sm2, N2, +half, CONST(surf - th), CONST(surf), "paving-edge-r", actMat[ai].near, a0, a1);
    vstrip(ai, sm2, N2, -half, CONST(surf - th), CONST(surf), "paving-edge-l", actMat[ai].near, a0, a1);
  }

  // 2) 人字折墙（可选）：按幕给出几圈墙，进/出幕用 fade 秒淡入淡出
  //    w = { off, th, h, fade }：墙的内沿在 off - th/2、外沿在 off + th/2
  for (let ai = 0; ai < acts.length; ai++) {
    const a = acts[ai];
    if (!a.walls || !a.walls.length) continue;
    const tA = a.t0, tB = t1Of(ai);
    const i0 = sm2.findIndex((p) => (p.t || 0) >= tA);
    let i1 = sm2.length;
    for (let i = 0; i < sm2.length; i++) if ((sm2[i].t || 0) >= tB) { i1 = i; break; }
    if (i0 < 1 || i1 <= i0 + 1) continue;
    for (const w of a.walls) {
      const fade = w.fade == null ? 4 : w.fade;
      // 墙高：幕两端各 fade 秒淡入淡出（用平滑曲线，别让墙顶"跳"出来）
      const hAt = (t) => {
        const u = Math.min(1, (t - tA) / fade, (tB - t) / fade);
        const s = Math.max(0, u), sm = s * s * (3 - 2 * s);
        return surf + w.h * sm;
      };
      const oi = w.off - w.th / 2, oo = w.off + w.th / 2;
      const mw = w.palette && palMats ? (palMats(w.palette) || actMat[ai]) : actMat[ai];
      for (const sgn of [1, -1]) {
        vstrip(ai, sm2, N2, sgn * oi, CONST(surf), hAt, "wall" + w.off + "-in" + sgn, mw.near, i0, i1);
        vstrip(ai, sm2, N2, sgn * oo, CONST(surf), hAt, "wall" + w.off + "-out" + sgn, mw.near, i0, i1);
        const lo = Math.min(sgn * oi, sgn * oo), hi2 = Math.max(sgn * oi, sgn * oo);
        strip(ai, sm2, N2, lo, hi2, hAt, "wall" + w.off + "-top" + sgn, mw.mid, i0, i1);
      }
    }
  }

  // 3) 石板场：世界坐标轴对齐的网格，逐格拼大块，再按"街"做矩形裁剪
  const cell = W.cell || 7.5;
  const gap = W.gap == null ? 0.5 : W.gap;
  const corridor = rim + 0.08;            // 石板内沿几乎贴住街沿             // 街面到台面的"净空"（石板内沿留 0.35 缝）
  const reach = W.reach == null ? 108 : W.reach;
  const seed = W.slabSeed == null ? 20261018 : W.slabSeed;
  const Hs = (i, j, s) => {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041) + seed) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const vnoise = (x, z, s) => {
    const xf = Math.floor(x), zf = Math.floor(z);
    const tx = x - xf, tz = z - zf;
    const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
    const v00 = Hs(xf, zf, s), v10 = Hs(xf + 1, zf, s);
    const v01 = Hs(xf, zf + 1, s), v11 = Hs(xf + 1, zf + 1, s);
    return (v00 * (1 - sx) + v10 * sx) * (1 - sz) + (v01 * (1 - sx) + v11 * sx) * sz;
  };

  // 空间桶：把路径每段扩成"矩形 + 桶"（矩形裁剪用 corridor 扩张，保证算得对）
  const B = 30;
  const buckets = new Map();
  const K = (i, j) => i * 100003 + j;
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) continue;
    const L = { x0: Math.min(a.x, b.x) - corridor, x1: Math.max(a.x, b.x) + corridor,
                z0: Math.min(a.z, b.z) - corridor, z1: Math.max(a.z, b.z) + corridor,
                t: ((a.t || 0) + (b.t || 0)) / 2 };
    legs.push(L);
    const bi0 = Math.floor(L.x0 / B), bi1 = Math.floor(L.x1 / B);
    const bj0 = Math.floor(L.z0 / B), bj1 = Math.floor(L.z1 / B);
    for (let ii = bi0; ii <= bi1; ii++) for (let jj = bj0; jj <= bj1; jj++) {
      const k = K(ii, jj);
      let arr = buckets.get(k); if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(legs.length - 1);
    }
  }
  const rectMinus = (r, s, acc2) => {
    if (s.x1 <= r.x0 || s.x0 >= r.x1 || s.z1 <= r.z0 || s.z0 >= r.z1) { acc2.push(r); return; }
    if (s.x0 > r.x0) acc2.push({ x0: r.x0, x1: s.x0, z0: r.z0, z1: r.z1 });
    if (s.x1 < r.x1) acc2.push({ x0: s.x1, x1: r.x1, z0: r.z0, z1: r.z1 });
    const xa = Math.max(r.x0, s.x0), xb = Math.min(r.x1, s.x1);
    if (s.z0 > r.z0) acc2.push({ x0: xa, x1: xb, z0: r.z0, z1: s.z0 });
    if (s.z1 < r.z1) acc2.push({ x0: xa, x1: xb, z0: s.z1, z1: r.z1 });
  };
  const clip = (r) => {
    let cur = [r];
    const seen = new Set();
    const bi0 = Math.floor((r.x0 - corridor) / B), bi1 = Math.floor((r.x1 + corridor) / B);
    const bj0 = Math.floor((r.z0 - corridor) / B), bj1 = Math.floor((r.z1 + corridor) / B);
    for (let ii = bi0; ii <= bi1; ii++) for (let jj = bj0; jj <= bj1; jj++) {
      const arr = buckets.get(K(ii, jj)); if (!arr) continue;
      for (const li of arr) {
        if (seen.has(li)) continue;
        seen.add(li);
        const nxt = [];
        for (const q of cur) rectMinus(q, legs[li], nxt);
        cur = nxt;
        if (!cur.length) return cur;
      }
    }
    return cur;
  };

  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
  }
  const di = Math.floor((x0 - reach) / cell), dx = Math.floor((x1 + reach) / cell);
  const dj = Math.floor((z0 - reach) / cell), dz = Math.floor((z1 + reach) / cell);

  const topsOf = acts.map(() => [[], [], []]);
  const sidesOf = acts.map(() => []);
  const topQuad = (arr, r, y) => {
    pushQuad(arr, [r.x0, y, r.z0], [r.x0, y, r.z1], [r.x1, y, r.z1], [r.x1, y, r.z0]);
  };
  const sideQuad = (arr, r, y0, y1) => {
    pushQuad(arr, [r.x0, y0, r.z0], [r.x0, y1, r.z0], [r.x1, y1, r.z0], [r.x1, y0, r.z0]);
    pushQuad(arr, [r.x0, y0, r.z1], [r.x1, y0, r.z1], [r.x1, y1, r.z1], [r.x0, y1, r.z1]);
    pushQuad(arr, [r.x0, y0, r.z0], [r.x0, y0, r.z1], [r.x0, y1, r.z1], [r.x0, y1, r.z0]);
    pushQuad(arr, [r.x1, y0, r.z0], [r.x1, y1, r.z0], [r.x1, y1, r.z1], [r.x1, y0, r.z1]);
  };

  const taken = new Set();
  let nmade = 0;
  const tierH = W.tierH || [0.65, 1.5, 2.9, 4.6];
  for (let i = di; i <= dx; i++) for (let j = dj; j <= dz; j++) {
    if (taken.has(K(i, j))) continue;
    const cx = (i + 0.5) * cell, cz = (j + 0.5) * cell;
    // 到路径（已扩 corridor 的矩形）的距离 —— 只有搜索桶里有的段才需要算
    let near = Infinity, tNear = 0;
    const bi = Math.floor(cx / B), bj = Math.floor(cz / B);
    for (let ii = bi - 1; ii <= bi + 1; ii++) for (let jj = bj - 1; jj <= bj + 1; jj++) {
      const arr = buckets.get(K(ii, jj)); if (!arr) continue;
      for (const li of arr) {
        const L = legs[li];
        const ddx = Math.max(L.x0 - cx, 0, cx - L.x1);
        const ddz = Math.max(L.z0 - cz, 0, cz - L.z1);
        const dd = Math.hypot(ddx, ddz);
        if (dd < near) { near = dd; tNear = L.t; }
      }
    }
    if (near - cell * 0.5 > reach) continue;
    if (near < corridor - cell * 0.5 - 0.5) continue;
    const ai = actAt(tNear);
    const oc = acts[ai].occ == null ? 0.40 : acts[ai].occ;
    if (oc >= 1) continue;                                   // 这一幕不放石板
    const occ = 0.62 * vnoise(cx / 46, cz / 46, 21) + 0.38 * vnoise(cx / 17, cz / 17, 22);
    // 空广场里也撒几块"孤石"（7%），否则留白太干净、像没做完
    if (occ < oc && Hs(i, j, 23) > 0.30) continue;   // 空场里也留 30% 的低石板，别留大块空白
    // 墙圈里不放石板（墙体本身是实心的，石板会插进去）
    const dw = near + corridor;
    if (acts[ai].walls) {
      let inside = false;
      for (const w of acts[ai].walls) if (dw < w.off + w.th / 2 + 1.5) inside = true;
      if (inside) continue;
    }
    // 拼大块：越往后的概率越小 —— 2x2 的 15m 板最贵，不能太多
    const rr = Hs(i, j, 1);
    let pw = 1, pd = 1;
    if (rr > 0.90) { pw = 2; pd = 2; }
    else if (rr > 0.70) { pw = 2; pd = 1; }
    else if (rr > 0.52) { pw = 1; pd = 2; }
    for (;;) {
      if (pw === 1 && pd === 1) break;
      let ok = true;
      for (let a = 0; a < pw && ok; a++) for (let b = 0; b < pd && ok; b++) {
        if (taken.has(K(i + a, j + b))) ok = false;
      }
      if (ok) break;
      pw = 1; pd = 1;
    }
    for (let a = 0; a < pw; a++) for (let b = 0; b < pd; b++) taken.add(K(i + a, j + b));
    // 缝宽：34% 的板"摆得松"（0.6~1.7m 大缝），其余 0.25m 细缝
    const sh = Hs(i, j, 9);
    const inset = sh < 0.34 ? 0.6 + 1.1 * Hs(i, j, 10) : gap * 0.5;
    const r = {
      x0: i * cell + inset, x1: (i + pw) * cell - inset,
      z0: j * cell + inset, z1: (j + pd) * cell - inset,
    };
    if (Hs(i, j, 2) < 0.035) continue;                        // 3.5% 直接缺一块（断口）
    const pieces = clip(r);
    if (!pieces.length) continue;
    let area = 0;
    const fullArea = (r.x1 - r.x0) * (r.z1 - r.z0);
    for (const p of pieces) area += (p.x1 - p.x0) * (p.z1 - p.z0);
    if (area < fullArea * 0.22) continue;                    // 被街啃掉大半的碎渣不要
    // 分档台地：低频噪声决定"这一片是薄板还是厚板"，再加 4.6m 的塔
    const tv = 0.6 * vnoise(cx / 52, cz / 52, 31) + 0.4 * vnoise(cx / 19, cz / 19, 32);
    let tier = tv < 0.42 ? 0 : tv < 0.70 ? 1 : tv < 0.88 ? 2 : 3;
    const tierMax = acts[ai].tierMax == null ? 3 : acts[ai].tierMax;
    tier = Math.min(tier, tierMax);
    if (near < 9) tier = Math.min(tier, 1);      // 街两侧 9m 内不许起高台，否则挡视线
    let h = (tierH[tier] || 0.65) * (0.86 + 0.28 * Hs(i, j, 3));
    const tallP = acts[ai].tall == null ? (W.tall == null ? 0.13 : W.tall) : acts[ai].tall;
    const tH0 = acts[ai].tallH0 || W.tallH0 || 2.6;
    const tH1 = acts[ai].tallH1 || W.tallH1 || 6.2;
    const tallMin = acts[ai].tallMin == null ? 2 : acts[ai].tallMin;
    let tall = false;
    if (tier >= tallMin && near > 7 && Hs(i, j, 5) < tallP) {
      tall = true;
      h = tH0 + (tH1 - tH0) * Hs(i, j, 4);
    }
    const tn = Hs(i, j, 8);
    const ti = tn < 0.26 ? 0 : tn > 0.78 ? 2 : 1;
    const arr = topsOf[ai][ti], sarr = sidesOf[ai];
    if (tall) {
      // 立起来的板/柱：缩到原 footprint 的 pillarK 倍（柱要瘦、板要宽），
      // 再随机平移一点 —— 柱子全落在网格上会读成"整齐的阵列"，不像乱长的石塔
      const pk = acts[ai].pillarK == null ? 0.55 : acts[ai].pillarK;
      const k = pk * (0.85 + 0.3 * Hs(i, j, 6));
      const jx = (Hs(i, j, 11) - 0.5) * cell * 0.5, jz = (Hs(i, j, 12) - 0.5) * cell * 0.5;
      for (const p of pieces) {
        const mx = (p.x0 + p.x1) / 2 + jx, mz = (p.z0 + p.z1) / 2 + jz;
        const q = { x0: mx - (p.x1 - p.x0) * 0.5 * k, x1: mx + (p.x1 - p.x0) * 0.5 * k,
                    z0: mz - (p.z1 - p.z0) * 0.5 * k, z1: mz + (p.z1 - p.z0) * 0.5 * k };
        topQuad(arr, q, surf + h); sideQuad(sarr, q, surf, surf + h);
      }
    } else {
      for (const p of pieces) { topQuad(arr, p, surf + h); sideQuad(sarr, p, surf, surf + h); }
    }
    nmade++;
    if (nmade > 30000) break;
  }
  for (let ai = 0; ai < acts.length; ai++) {
    const m = actMat[ai];
    if (sidesOf[ai].length) out.push(meshFromPositions(sidesOf[ai], m.slabSide || m.near, "paving-slab-sides-a" + ai));
    const names = ["paving-slab-tops-d-a", "paving-slab-tops-a", "paving-slab-tops-l-a"];
    const mats = [m.slabTopD || m.slabTop || m.mid, m.slabTop || m.mid, m.slabTopL || m.slabTop || m.mid];
    for (let ti = 0; ti < 3; ti++) {
      if (topsOf[ai][ti].length) out.push(meshFromPositions(topsOf[ai][ti], mats[ti], names[ti] + ai));
    }
  }
  for (const b of acc.values()) out.push(meshFromPositions(b.pos, b.matl, b.name));
  return out;
}

/* E 剖面（profile）：用一条**横断面剖线**定义整个地形。
   这是"场景建模"用的母题：设计师给的是"从路中心往外，地面在第 X 米处落到第 Y 米"，
   而不是"往路两边撒一些石头"。所有台面/崖壁都沿路连续生成，转角由 sm 平滑统一处理。

   params.profile = [[off, h], ...]，off 从路中心向外的距离（米），h 相对路面的高度。
   左右镜像；相邻两点之间：先铺水平台面（在 h_i），再在同一 off 处竖一堵立面到 h_{i+1}。
   例（山脊 + 深谷 + 远崖）：
     [[1.6,0],[3.2,0],[3.2,-9],[10,-18],[26,-26],[60,-30],[72,18],[84,24]]
   读法：路面 0~1.6m；肩宽到 3.2m 仍是路面高度；3.2m 处垂直落下 9m；
   9m 外是缓坡台地，26m 处到 -26m；60m 处谷底 -30m；72m 处拔起一道 48m 高的崖壁到 +18m。 */
function motifProfile(pts, W, M, surf) {
  const prof = (W.profile && W.profile.length >= 2 ? W.profile : [[1.6, 0], [60, 0]])
    .slice().sort((a, b) => a[0] - b[0]);
  // inset：地面整体压到路面以下多少米。参考 Astra 那代复刻：路是一条**凸起**的带子，
  // 坐在一整块台面之上；齐平时路和地会糊成一张纸。
  const IN = W.inset == null ? 0 : W.inset;
  const surf0 = surf - IN;
  const sm = smoothCoords(pts, W.smooth == null ? 2 : W.smooth);
  // 远处（off > smoothFarFrom）用**更重的平滑**：近处要给路让位、不能抹，
  // 但 100m 外的崖壁如果还跟着每 3m 一个 90° 折点走，就会碎成一块块"板"。
  const smFar = smoothCoords(pts, W.smoothFar == null ? 7 : W.smoothFar);
  const FAR_FROM = W.smoothFarFrom == null ? 40 : W.smoothFarFrom;
  const out = [];
  const th = W.th == null ? 6 : W.th;
  for (const sign of [1, -1]) {
    for (let i = 0; i < prof.length - 1; i++) {
      const o0 = prof[i][0], h0 = prof[i][1];
      const o1 = prof[i + 1][0], h1 = prof[i + 1][1];
      // ⚠️ 不能"近环用 sm、远环用 smFar"——两条曲线的顶点位置不同，
      //    交界的那个 offset 上会裂出缝（预览里看得很清楚：一圈飘着的薄片）。
      //    按偏移量把两条曲线**混合**，相邻两环在同一个 offset 上求值，接缝天然闭合。
      const curve = (off) => {
        const t = Math.max(0, Math.min(1, (off - 3) / (FAR_FROM - 3)));
        if (t <= 0) return sm;
        if (t >= 1) return smFar;
        const A = sm, B = smFar, out = [];
        for (let j = 0; j < A.length; j++) {
          out.push({ x: A[j].x + (B[j].x - A[j].x) * t,
                     y: A[j].y + (B[j].y - A[j].y) * t,
                     z: A[j].z + (B[j].z - A[j].z) * t,
                     t: A[j].t });
        }
        return out;
      };
      const S0 = curve(o0), S1 = curve(o1);
      // 水平台面：一格一亮一暗，读起来才有"层"（官方关的台阶感来自明暗交替）
      out.push(flatBand(S0, sign * o0, S1, sign * o1, surf0 + h0,
        i % 2 ? M.far : M.mid, "prof-flat-" + i));
      // 立面：同一 off 处的高度跳变
      if (Math.abs(h1 - h0) > 1e-6) {
        out.push(vertBand(S1, sign * o1, surf0 + Math.min(h0, h1), surf0 + Math.max(h0, h1),
          M.near, "prof-wall-" + i));
      }
    }
    // 最外沿补一堵立面，让最后一级台地看起来有厚度（不然边缘是纸片）
    const last = prof[prof.length - 1];
    out.push(vertBand(sm, sign * last[0], surf0 + last[1] - th, surf0 + last[1], M.mid, "prof-lip"));
  }
  return out;
}

// ⚠️ splitRuns 把"母题名 + 色卡都相同"的相邻段并成一段（段内 params 取第一段的），
//    所以"平板上切了槽"的那一段必须用**另一个母题名**，否则槽不会出现。
const MOTIFS = { board: motifBoard, boardSlot: motifBoard, bridge: motifBoard, deck: motifDeck, canyon: motifCanyon, terraces: motifTerraces, islands: motifTerraces, cloud: motifCloud, paving: motifPaving, profile: motifProfile };

// 每种母题缺省的尺寸参数（关卡里可以逐个覆盖）
export const DEFAULT_PARAMS = {
  // 无限厚板（ETW29）：half 是"板有多宽"（要远到看不见边），slot/hi 是"板上切多深的槽"
  board: { walk: 3.0, half: 150, th: 9.0, slot: 0, hi: 0, drop: 0 },
  // 同一块板，但中间切了一条槽（ETW29 段 3 的"折线峡谷"）：路走槽底、槽壁露出蓝灰断面
  boardSlot: { walk: 3.0, half: 150, th: 9.0, slot: 4.2, hi: 5.5, drop: 0 },
  // 高架桥段：同一块板，但**整块下沉 drop 米** —— 路面留在原高度，
  // 于是路凭空比地面高出 drop，再由 props 的 bridge 摆件（护栏/桥面/桥墩）补成一座高架桥。
  bridge: { walk: 3.0, half: 150, th: 9.0, slot: 0, hi: 0, drop: 7.0 },
  deck: { walk: 13.0, shelf: 2.4, th: 3.2, step: 1.6 },
  // 剖面母题：默认一整片平地（不传 profile 时等价于 board 的无限板）
  profile: { profile: [[1.6, 0], [60, 0]], smooth: 2, th: 6 },
  canyon: { walk: 4.4, slot: 2.2, hi: 4.0, floorW: 12, plateauW: 30, th: 3.0 },
  // ⚠️ 主台是"一串圆盘"：gap 必须 < 2*rx*0.82（最小半径），否则两块台子之间会有洞，
  //    道具会飘在洞上。gap 10 / 最小半径 8.2 → 连着。
  //    卫星台因此要推到 off0 16 以外（不然会被主台盖住）。
  terraces: { walk: 5.0, gap: 10, rx: 12, ry: 10, th: 2.0, gap2: 13, off0: 16, offSpan: 16, rx2: 5.5, ry2: 4.2, low0: 4, lowSpan: 7 },
  islands: { walk: 5.0, gap: 10, rx: 12, ry: 10, th: 2.0, gap2: 13, off0: 16, offSpan: 16, rx2: 5.5, ry2: 4.2, low0: 4, lowSpan: 7 },
  cloud: { walk: 5.4, plateW: 14, th: 3.0, gap: 9, off0: 12, offSpan: 14, low: -4.5, hSpan: 3, r: 3.4 },
  // 结尾的金字塔：真实关卡里它是一座"吃掉整屏"的巨物，所以尺寸给得很大
  // （路宽 3m，相机离线 24m / 高 21m → 90m 高、180m 宽的塔会把画面填满）
  // ⚠️ `slotW` 是两半之间的缝有多宽。发起人的标准是"线的三倍宽就够"，
  //    所以路宽 3m → 缝 9m。缝再宽就变成"两堵立在两边的墙"，不像金字塔了。
  // ⚠️ `enter` 是"塔心在路终点之前多少米"，负值表示塔心在终点**之后**。
  //    它跟"相机在缝里待多久"直接挂钩：相机永远在线的后 24m，所以
  //    正面角点（塔心再往前 halfW）落在 -24m 时，整关结束的瞬间相机刚好到缝口，
  //    整个结尾是"看着金字塔的正面角点迎面压过来、路钻进缝里"。
  //    → enter = -(halfW + 24) = -66（再往里就会变成一路上只看两侧切面）
  // 石板原（ETW29 开场段）：网格密铺 + 街道 + 可选人字折墙。
  // ⚠️ 段内想要不同的密度/高度，**不要**用 terrain.spans 换色卡：
  //    splitRuns 会在换色卡处分段、每段各建一遍台面，接缝处会出缺口。
  //    正确做法是 paving.acts（一个连续母题、按时间换色卡/密度/墙）。
  paving: {
    walk: 3.0, half: 150, th: 9.0, slot: 0, hi: 0, drop: 0,
    // rim = 街半宽（默认 = walk/2 + 1.3，即路两侧各留 1.3m 路肩）
    cell: 7.5, gap: 0.5, reach: 108, tierH: [0.65, 1.5, 2.9, 4.6],
    tall: 0.13, tallH0: 2.6, tallH1: 6.2, slabSeed: 20261018,
    acts: [{ t0: -1e9, palette: "board", occ: 0.40, tierMax: 3 }],
  },
  endcap: { halfW: 90, slotW: 9, h: 110, enter: -66, sink: 3, palette: "cream" },
};

/* 地形色卡：关卡里只写**名字**，颜色仍然不进关卡文件（和主题色一个道理） */
export const PALETTES = {
  // ETW29「驻足的宁静」的两面：米黄顶面 L81 + 蓝灰断面 L60（同一块板）
  board: { near: 0x9199ac, mid: 0xd1d0bb, far: 0xa8b8d8,
           slabTop: 0x93a4cf, slabTopL: 0xa9b7da, slabTopD: 0x7b8ab8,
           slabSide: 0x5d6fa8, floor: 0xcbc9b2 },
  rose:  { near: 0x8e2a57, mid: 0xc06a95, far: 0xf0d2e0 },   // 和 pink 主题同色
  plum:  { near: 0x452838, mid: 0x6b3f63, far: 0xbe9cba },   // 深紫：裂谷（near 只留给槽底阴影，不再黑成洞）
  sand:  { near: 0x8a5a2b, mid: 0xc9a86f, far: 0xf2e4c4 },   // 暖沙：层叠平台
  ice:   { near: 0x27506e, mid: 0x5f89a6, far: 0xcfe2ec },   // 冰蓝：云海
  jade:  { near: 0x2f6b48, mid: 0x74ad91, far: 0xc4e8d5 },   // 草绿
  cream: { near: 0xa89f8e, mid: 0xe9e3d7, far: 0xfdfbf6 },
  // 暖石台：断面（near）明显比台面深，边缘才立得住；far 淡到接近雾色，远处自然消失
  dune:  { near: 0x6b5b46, mid: 0xc9b183, far: 0xe8dcc0 },
  // 石板原后半段的两张色卡（石板都是蓝的，差异在「台面」和「断面」的冷暖）
  stone2: { near: 0x7f8798, mid: 0xd6d2bd, far: 0xb9c2d8,
            slabTop: 0x9aa7c8, slabTopL: 0xb0bcd8, slabTopD: 0x8290b8,
            slabSide: 0x66739c, floor: 0xcfcbb6 },
  stone3: { near: 0x6e778c, mid: 0xcfcdb8, far: 0xaebad4,
            slabTop: 0x8d9bc0, slabTopL: 0xa4b1d2, slabTopD: 0x7784b0,
            slabSide: 0x5c6b98, floor: 0xc8c5ae },   // 发白的米色：结尾金字塔
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

  // 双面：条带/盒子的朝向不必抠得很准，双面省掉一整类"整片发黑"的坑。
  // polygonOffset：地形整体往深度里推一点，凡是与地形**共面或近共面**的东西
  // （路面、路缘描边、贴地色块）都稳定赢下深度测试——这是"路两侧闪烁"的兜底修复。
  const mk = (c, rough) => {
    const m = new THREE.MeshStandardMaterial({
      color: c, roughness: rough, metalness: 0, flatShading: true, side: THREE.DoubleSide,
    });
    m.polygonOffset = true;
    m.polygonOffsetFactor = 2;
    m.polygonOffsetUnits = 2;
    return m;
  };
  const mkMats = (c) => ({
    near: mk(c.near, 0.92), mid: mk(c.mid, 0.88), far: mk(c.far, 0.95),
    // paving 石板原专用：石板的顶/侧、街面、外边侧面。不写就退回同族颜色
    slabTop: mk(c.slabTop == null ? c.far : c.slabTop, 0.9),
    slabTopL: mk(c.slabTopL == null ? (c.slabTop == null ? c.far : c.slabTop) : c.slabTopL, 0.9),
    slabTopD: mk(c.slabTopD == null ? c.near : c.slabTopD, 0.9),
    slabSide: mk(c.slabSide == null ? c.near : c.slabSide, 0.9),
    floor: mk(c.floor == null ? c.mid : c.floor, 0.9),
  });
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
    const surf = top - 0.06 - (P.drop || 0);
    const pts = simplify(run.pts, 2.0);
    const rm = palMats(run.palette) || mats;      // 这一段用哪套材质
    for (const m of fn(pts, P, rm, surf, palMats)) group.add(m);
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
