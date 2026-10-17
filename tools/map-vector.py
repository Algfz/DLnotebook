# -*- coding: utf-8 -*-
"""map-vector.py —— 把 path-map.py 产出的"路径点云地图"矢量化成曼哈顿折线 + 折点表。

流程：
  1. 读 <tag>-map-pts.npz（世界坐标点 P + 颜色 C），栅格化成带状掩膜；
  2. ximgproc.thinning 取骨架 → 8 邻接图 → 两端点间最长路径 → 有序中心线；
  3. Douglas-Peucker 简化 → 按"主导轴"分类每段（沿 X 或沿 Z）→ 每段拟合一条直线
     （沿 X 段取 z=中位数，沿 Z 段取 x=中位数）→ 相邻段直线求交 ⇒ 折点；
  4. 输出 JSON（折点、段长、转角、累计弧长、对应帧号/时间）+ SVG + 覆盖预览 PNG。

用法：
  python tools/map-vector.py --npz ...\\s1-map-pts.npz --json ...\\s1-map.json \\
      --tag s1 --out ...\\vec --map-png ...\\s1-map.png --res 300 --tol 0.04
"""
import argparse
import json
import math
import os

import cv2
import numpy as np
from scipy.spatial import cKDTree


def load_map(npz_path):
    z = np.load(npz_path)
    P = np.asarray(z["P"], np.float64)
    C = np.asarray(z["C"], np.uint8) if "C" in z else None
    origin = np.asarray(z["origin"], np.float64) if "origin" in z else P.min(0) - 0.05
    return P, C, origin


def rasterize(P, origin, res, pad=0.05):
    lo = origin - pad
    hi = P.max(0) + pad
    w = int((hi[0] - lo[0]) * res) + 1
    h = int((hi[1] - lo[1]) * res) + 1
    m = np.zeros((h, w), np.uint8)
    px = ((P[:, 0] - lo[0]) * res).astype(int)
    pz = ((P[:, 1] - lo[1]) * res).astype(int)
    ok = (px >= 0) & (px < w) & (pz >= 0) & (pz < h)
    m[pz[ok], px[ok]] = 255
    return m, lo, res


def order_skeleton(mask):
    """骨架化 → 8 邻接 → 找最远两点 → 返回有序像素坐标（N,2）与降采样骨架图。"""
    try:
        from skimage.morphology import skeletonize
        sk = (skeletonize(mask > 0).astype(np.uint8)) * 255
    except Exception:
        raise SystemExit("需要 skimage.morphology.skeletonize（本机 cv2.ximgproc 无 thinning）")
    ys, xs = np.nonzero(sk)
    if len(xs) < 8:
        raise SystemExit("骨架点太少：%d" % len(xs))
    pts = set(zip(xs.tolist(), ys.tolist()))
    # 端点（8 邻域内只有 1 个骨架点）
    ends = []
    for (x, y) in pts:
        n = 0
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                if (x + dx, y + dy) in pts:
                    n += 1
        if n <= 1:
            ends.append((x, y))
    if not ends:
        ends = [next(iter(pts))]
    # 从第一个端点 BFS 找最远点（图上最远 = 直径近似）
    def bfs(src):
        dist = {src: 0}
        prev = {}
        q = [src]
        far = src
        for u in q:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    v = (u[0] + dx, u[1] + dy)
                    if v in pts and v not in dist:
                        dist[v] = dist[u] + 1
                        prev[v] = u
                        if dist[v] > dist[far]:
                            far = v
                        q.append(v)
        return far, dist, prev

    a = ends[0]
    b, _, _ = bfs(a)
    c, dist, prev = bfs(b)
    # 回溯 b..c 最短路
    path = [c]
    while path[-1] != b:
        path.append(prev[path[-1]])
    path.reverse()
    return np.asarray(path, np.float64)      # (x, y) 像素


def dp_simplify(P, tol):
    """Douglas-Peucker，返回保留点的索引。"""
    n = len(P)
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        A, B = P[i], P[j]
        AB = B - A
        L = np.hypot(*AB)
        if L < 1e-9:
            d = np.hypot(*(P[i + 1:j] - A).T)
        else:
            d = np.abs(np.cross(AB, P[i + 1:j] - A)) / L
        k = int(np.argmax(d))
        if d[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return np.nonzero(keep)[0]


def grid_angle(P, idx):
    """用简化后各段方向估计栅格角（mod 90°，取圆均值）。"""
    angs = []
    wts = []
    for i in range(len(idx) - 1):
        a, b = idx[i], idx[i + 1]
        d = P[b] - P[a]
        L = math.hypot(*d)
        if L < 1e-6:
            continue
        angs.append(math.atan2(d[1], d[0]))
        wts.append(L)
    if not angs:
        return 0.0
    angs = np.asarray(angs)
    wts = np.asarray(wts)
    # mod 90°
    k = np.round(angs / (math.pi / 2)) * (math.pi / 2)
    r = angs - k
    g = math.atan2(float((np.sin(r) * wts).sum()), float((np.cos(r) * wts).sum()))
    return g


def raw_turns(P, idx):
    """吸附前的原始转角：返回[(转角(度, 带符号), 两侧较短段长)]，转角归一 (-180, 180]。"""
    out = []
    for i in range(len(idx) - 2):
        a, b, c = idx[i], idx[i + 1], idx[i + 2]
        d1, d2 = P[b] - P[a], P[c] - P[b]
        l1, l2 = math.hypot(*d1), math.hypot(*d2)
        if l1 < 1e-9 or l2 < 1e-9:
            continue
        t = math.degrees(math.atan2(d2[1], d2[0]) - math.atan2(d1[1], d1[0]))
        out.append(((t + 180.0) % 360.0 - 180.0, min(l1, l2)))
    return out


def grid_spread(P, idx, g):
    """各段方向相对栅格角 g 的偏差（mod 90°）：返回 (加权中位偏差°, 最大偏差°) —— 机架精度的独立验证。"""
    devs, wts = [], []
    for i in range(len(idx) - 1):
        a, b = idx[i], idx[i + 1]
        d = P[b] - P[a]
        L = math.hypot(*d)
        if L < 1e-6:
            continue
        ang = math.atan2(d[1], d[0]) - g
        k = round(ang / (math.pi / 2)) * (math.pi / 2)
        devs.append(abs(math.degrees(ang - k)))
        wts.append(L)
    if not devs:
        return 0.0, 0.0
    devs, wts = np.asarray(devs), np.asarray(wts)
    o = np.argsort(devs)
    cw = np.cumsum(wts[o]) / wts.sum()
    return float(devs[o][int(np.searchsorted(cw, 0.5))]), float(devs.max())


def manhattan_rebuild(P, idx, g, min_len=0.05):
    """把折线吸附成曼哈顿折线：每段判定主导轴 → 取该轴的偏移中位数 → 相邻段求交。"""
    c, s = math.cos(-g), math.sin(-g)
    R = np.array([[c, -s], [s, c]])
    Q = (R @ P.T).T
    segs = []
    for i in range(len(idx) - 1):
        a, b = idx[i], idx[i + 1]
        pts = Q[a:b + 1]
        d = Q[b] - Q[a]
        axis = 0 if abs(d[0]) >= abs(d[1]) else 1        # 0=沿 X（z 固定），1=沿 Z（x 固定）
        off = float(np.median(pts[:, 1 - axis]))
        lo = float(min(pts[:, axis].min(), pts[:, axis].max()))
        hi = float(max(pts[:, axis].min(), pts[:, axis].max()))
        segs.append({"axis": axis, "off": off, "lo": lo, "hi": hi,
                     "span": hi - lo, "n": b - a})
    # 合并相邻同轴段
    merged = []
    for sg in segs:
        if merged and merged[-1]["axis"] == sg["axis"]:
            m = merged[-1]
            m["off"] = 0.5 * (m["off"] + sg["off"])
            m["lo"] = min(m["lo"], sg["lo"])
            m["hi"] = max(m["hi"], sg["hi"])
            m["span"] = m["hi"] - m["lo"]
            m["n"] += sg["n"]
        else:
            merged.append(dict(sg))
    segs = [m for m in merged if m["span"] >= min_len] or merged
    # 折点 = 相邻段直线交点；同轴相邻（不应出现）取公共端点
    cor = []
    if segs:
        cor.append((segs[0]["lo"], segs[0]["off"]) if segs[0]["axis"] == 0
                   else (segs[0]["off"], segs[0]["lo"]))
        for i in range(len(segs) - 1):
            A, B = segs[i], segs[i + 1]
            if A["axis"] == 0 and B["axis"] == 1:
                cor.append((B["off"], A["off"]))
            elif A["axis"] == 1 and B["axis"] == 0:
                cor.append((A["off"], B["off"]))
            else:
                cor.append((A["hi"], A["off"]) if A["axis"] == 0 else (A["off"], A["hi"]))
        last = segs[-1]
        cor.append((last["hi"], last["off"]) if last["axis"] == 0 else (last["off"], last["hi"]))
    C = np.asarray(cor, np.float64)
    # 转回世界系
    Rinv = np.array([[math.cos(g), -math.sin(g)], [math.sin(g), math.cos(g)]])
    W = (Rinv @ C.T).T
    return W, segs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--npz", required=True)
    ap.add_argument("--json", default=None, help="path-map.py 的 <tag>-map.json（取相机轨迹/帧号）")
    ap.add_argument("--map-png", default=None, help="用于画覆盖预览")
    ap.add_argument("--tag", default="map")
    ap.add_argument("--out", required=True)
    ap.add_argument("--res", type=float, default=300.0, help="栅格分辨率 px/单位")
    ap.add_argument("--tol", type=float, default=0.04, help="Douglas-Peucker 容差（世界单位）")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--step", type=int, default=1, help="path-map 的帧步长（用于时间换算）")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    P, C, origin = load_map(a.npz)
    m, lo, res = rasterize(P, origin, a.res)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    # 只留最大连通域
    nlab, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if nlab > 1:
        k = 1 + int(np.argmax(stats[1:, 4]))
        m = np.where(lab == k, 255, 0).astype(np.uint8)
    print("[mv] 栅格 %dx%d px @ %.0f px/单位，掩膜 %d px" % (m.shape[1], m.shape[0], res, int((m > 0).sum())))

    sk = order_skeleton(m)
    Q = (sk / res) + lo                              # 像素 → 世界
    idx = dp_simplify(Q, a.tol)
    g = grid_angle(Q, idx)
    print("[mv] 中心线 %d px，DP 简化后 %d 段，栅格角 %.2f°" % (len(sk), len(idx) - 1, math.degrees(g)))

    # 轨迹（可选）：相机应当贴着路径中轴 ⇒ 轨迹到骨架的距离可用来反标路径带高度 δ
    poses = []
    if a.json and os.path.exists(a.json):
        poses = json.load(open(a.json, encoding="utf-8")).get("poses", [])
    traj = np.array([[p["T"][0][2], p["T"][1][2]] for p in poses], np.float64) if poses else np.zeros((0, 2))
    traj_off = None
    if len(traj) > 2:
        tq = cKDTree(Q)
        dd, _ = tq.query(traj)
        traj_off = (float(np.median(dd)), float(np.percentile(dd, 90)))
        print("[mv] 轨迹到路径中轴：中位 %.4f / p90 %.4f h 单位（越小=相机越贴中轴）"
              % (traj_off[0], traj_off[1]))

    world, segs = manhattan_rebuild(Q, idx, g, 0.05)
    # 统计
    seglen = np.hypot(*(world[1:] - world[:-1]).T)
    cum = np.concatenate([[0.0], np.cumsum(seglen)])
    turn = []
    for i in range(1, len(world) - 1):
        a1 = world[i] - world[i - 1]
        a2 = world[i + 1] - world[i]
        t = math.degrees(math.atan2(a1[0] * a2[1] - a1[1] * a2[0], a1[0] * a2[0] + a1[1] * a2[1]))
        turn.append(t)

    # 折点表
    corners = []
    for i, (x, z) in enumerate(world):
        rec = {"i": i, "x": round(float(x), 4), "z": round(float(z), 4),
               "cum_len": round(float(cum[i]), 4),
               "seg_len": round(float(seglen[i]), 4) if i < len(seglen) else 0.0,
               "turn_deg": round(float(turn[i - 1]), 2) if 0 < i < len(world) - 1 else None}
        if len(traj):
            d = np.hypot(traj[:, 0] - x, traj[:, 1] - z)
            k = int(np.argmin(d))
            rec["frame"] = int(poses[k]["i"])
            rec["time_s"] = round(float(poses[k]["i"]) / a.fps, 3)
            rec["traj_dist"] = round(float(d[k]), 4)
        corners.append(rec)
    out = {"tag": a.tag, "grid_deg": round(math.degrees(g), 3),
           "total_len": round(float(cum[-1]), 4), "n_corners": len(corners),
           "traj_off_med": round(traj_off[0], 4) if traj_off else None,
           "traj_off_p90": round(traj_off[1], 4) if traj_off else None,
           "corners": corners}
    if len(traj) and len(poses) > 1:
        dt = (poses[-1]["i"] - poses[0]["i"]) / a.fps
        out["speed_h_per_s"] = round(float(cum[-1] / dt), 4) if dt > 0 else None
        out["duration_s"] = round(float(dt), 3)
    with open(os.path.join(a.out, "%s-vec.json" % a.tag), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print("[mv] 折线 %d 点，总长 %.3f h 单位，转角 %s，栅格角 %.2f°"
          % (len(corners), cum[-1], [round(t) for t in turn[:8]], math.degrees(g)))
    raw = raw_turns(Q, idx)
    if raw:
        dev = [abs(abs(t) - 90.0) for t, _ in raw]
        print("[mv] 吸附前原始转角 %s ⇒ 与 90° 偏差 中位 %.2f° / 最大 %.2f°（%d 个）"
              % (["%.1f" % t for t, _ in raw], float(np.median(dev)), float(max(dev)), len(raw)))
        big = [(t, l) for t, l in raw if l >= 0.10]
        if big:
            dv = [abs(abs(t) - 90.0) for t, _ in big]
            print("[mv] 其中显著转角（两侧短边≥0.10 h）%s ⇒ 偏差 中位 %.2f° / 最大 %.2f°（%d 个）"
                  % (["%.1f" % t for t, _ in big], float(np.median(dv)), float(max(dv)), len(big)))
    gm, gx = grid_spread(Q, idx, g)
    print("[mv] 各段方向相对栅格角偏差：加权中位 %.2f° / 最大 %.2f°（机架精度验证）" % (gm, gx))

    # ---- SVG（矢量地图）----
    pad = 0.3
    x0, x1 = float(world[:, 0].min() - pad), float(world[:, 0].max() + pad)
    z0, z1 = float(world[:, 1].min() - pad), float(world[:, 1].max() + pad)
    W = 900.0
    sc = W / max(x1 - x0, z1 - z0)
    H = (z1 - z0) * sc

    def T(p):
        return ((p[0] - x0) * sc, H - (p[1] - z0) * sc)

    pts = " ".join("%.1f,%.1f" % T(p) for p in world)
    body = ['<rect width="%.0f" height="%.0f" fill="#ffffff"/>' % (W, H)]
    body.append('<polyline points="%s" fill="none" stroke="#e23b2e" stroke-width="6" '
                'stroke-linejoin="miter" stroke-linecap="square"/>' % pts)
    for i, p in enumerate(world):
        cx, cy = T(p)
        body.append('<circle cx="%.1f" cy="%.1f" r="4.5" fill="#1b3f8b"/>' % (cx, cy))
        body.append('<text x="%.1f" y="%.1f" font-size="13" fill="#1b3f8b" '
                    'font-family="sans-serif">%d</text>' % (cx + 8, cy - 8, i))
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%.0f" height="%.0f" '
           'viewBox="0 0 %.0f %.0f">%s</svg>' % (W, H, W, H, "".join(body)))
    svgp = os.path.join(a.out, "%s-vec.svg" % a.tag)
    open(svgp, "w", encoding="utf-8").write(svg)
    print("[mv] 写出 %s" % svgp)

    # ---- 覆盖预览 ----
    if a.map_png and os.path.exists(a.map_png):
        img = cv2.imread(a.map_png)
        S = res
        pp = np.stack([(world[:, 0] - lo[0]) * S, (world[:, 1] - lo[1]) * S], 1).astype(int)
        cv2.polylines(img, [pp.reshape(-1, 1, 2)], False, (40, 40, 40), 2)
        for i, q in enumerate(pp):
            cv2.circle(img, tuple(q), 5, (255, 0, 0), -1)
        if len(traj):
            tt = np.stack([(traj[:, 0] - lo[0]) * S, (traj[:, 1] - lo[1]) * S], 1).astype(int)
            cv2.polylines(img, [tt.reshape(-1, 1, 2)], False, (0, 0, 255), 1)
        op = os.path.join(a.out, "%s-vec-over.png" % a.tag)
        cv2.imwrite(op, img)
        print("[mv] 写出 %s" % op)
    print("[mv] 写出 %s" % os.path.join(a.out, "%s-vec.json" % a.tag))


if __name__ == "__main__":
    main()
