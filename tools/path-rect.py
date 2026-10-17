# -*- coding: utf-8 -*-
"""A 路线：把「地面上的路径」从图像反正投到俯视地面坐标，并用「转角应该是 90°」自标定相机。

为什么这么做：跳舞的线是**跟随相机 + 平坦地面 + 路径＝地面上的线**。地面是平面 ⇒ 单帧就能用
一个 2 参数相机模型（f, 俯角 θ）把地面像素映射成俯视坐标，不需要深度网络、不需要 3D 重建。
标定判据来自曼哈顿世界：路径的拐角都是 90°（格子边缘），所以「哪个 (f, θ) 让拐角最像 90°」就是答案。

子命令:
  mask  <帧>  --out 预览.png          提取路径掩膜（HSV）+ 中心线骨架，出预览图
  calib <帧>  --out 预览.png          网格搜索 (f, θ)，报拐角角度的中位偏差，并画正投结果
"""
import os
import json
import math
import argparse

import cv2
import numpy as np


# ---------------------------------------------------------------- 路径掩膜
def path_mask(img, h_hi=22, h_lo=0, s_min=110, v_min=80, min_area=150, keep_n=6):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    m = cv2.inRange(hsv, (h_lo, s_min, v_min), (h_hi, 255, 255))
    k = np.ones((3, 3), np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=2)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k, iterations=1)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros_like(m)
    if n > 1:
        order = np.argsort(-stats[1:, 4]) + 1
        for i in order[:keep_n]:
            if stats[i, 4] < min_area:
                break
            keep[lab == i] = 255
    return keep


def centerline(mask, min_dist=1.2, nb=5, max_gap=45.0):
    """距离变换的脊线 + 从画面最下方开始贪心串成一条折线。"""
    d = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    mx = cv2.dilate(d, np.ones((nb, nb), np.uint8))
    ridge = (d >= mx - 1e-6) & (d > min_dist)
    ys, xs = np.nonzero(ridge)
    if len(xs) < 4:
        return np.zeros((0, 2), np.float64), d
    pts = np.stack([xs, ys], 1).astype(np.float64)
    start = int(np.argmax(pts[:, 1]))          # 画面最下的点（离相机最近）
    used = np.zeros(len(pts), bool)
    order = [start]
    used[start] = True
    for _ in range(len(pts) - 1):
        last = pts[order[-1]]
        dd = np.linalg.norm(pts - last, axis=1)
        dd[used] = 1e9
        j = int(np.argmin(dd))
        if dd[j] > max_gap:
            break
        order.append(j)
        used[j] = True
    return pts[order], d


# ---------------------------------------------------------------- 相机模型
def ground_from_image(uv, f, pitch_deg, cx, cy, h=1.0):
    """图像点 → 地面坐标（相机系：X 右、Z 前，单位为相机高度 h）。"""
    th = math.radians(pitch_deg)
    right = np.array([1.0, 0.0, 0.0])
    fwd = np.array([0.0, -math.sin(th), math.cos(th)])
    down = np.array([0.0, -math.cos(th), -math.sin(th)])
    C = np.array([0.0, h, 0.0])
    uv = np.asarray(uv, np.float64).reshape(-1, 2)
    x = (uv[:, 0] - cx) / f
    y = (uv[:, 1] - cy) / f
    d = x[:, None] * right[None, :] + y[:, None] * down[None, :] + fwd[None, :]
    t = -C[1] / d[:, 1]
    P = C[None, :] + t[:, None] * d
    return P[:, [0, 2]], d, t


def image_from_ground(XZ, f, pitch_deg, cx, cy, h=1.0):
    """地面坐标 → 图像点（画叠加用）。"""
    th = math.radians(pitch_deg)
    right = np.array([1.0, 0.0, 0.0])
    fwd = np.array([0.0, -math.sin(th), math.cos(th)])
    down = np.array([0.0, -math.cos(th), -math.sin(th)])
    XZ = np.asarray(XZ, np.float64).reshape(-1, 2)
    P = np.stack([XZ[:, 0], np.full(len(XZ), 0.0), XZ[:, 1]], 1) - np.array([0.0, h, 0.0])
    zc = P @ fwd
    xc = P @ right
    yc = P @ down
    u = f * xc / zc + cx
    v = f * yc / zc + cy
    return np.stack([u, v], 1)


def corner_angles(poly):
    """poly: 已排序的地面折线；返回显著的转角（度，0=不回折 180=原路返回）。"""
    if len(poly) < 3:
        return []
    out = []
    for i in range(1, len(poly) - 1):
        a = poly[i] - poly[i - 1]
        b = poly[i + 1] - poly[i]
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        if na < 1e-9 or nb < 1e-9:
            continue
        cosv = float(np.clip(np.dot(a, b) / (na * nb), -1, 1))
        out.append(math.degrees(math.acos(cosv)))
    return out


def ribbon_widths(poly, mask, f, pitch_deg, cx, cy, max_r=80, min_r=2.0, max_turn=25.0):
    """沿中心线量「红带宽度」：左右各打到掩膜边界，再正投到地面求距离。
    返回 (宽度数组, 采样数)。真 (f,θ) 应让宽度方差最小（宽度是世界常数）。"""
    if len(poly) < 5:
        return np.zeros(0), 0
    m = (mask > 0).astype(np.uint8)
    H, W = m.shape[:2]
    ws = []
    for i in range(1, len(poly) - 1):
        a, b, c = poly[i - 1], poly[i], poly[i + 1]
        t1, t2 = b - a, c - b
        if np.linalg.norm(t1) < 1e-6 or np.linalg.norm(t2) < 1e-6:
            continue
        cosv = float(np.clip(np.dot(t1, t2) / (np.linalg.norm(t1) * np.linalg.norm(t2)), -1, 1))
        if math.degrees(math.acos(cosv)) > max_turn:      # 拐角处不测
            continue
        t = (t1 / np.linalg.norm(t1) + t2 / np.linalg.norm(t2))
        nt = np.linalg.norm(t)
        if nt < 1e-6:
            continue
        t /= nt
        nrm = np.array([-t[1], t[0]])
        edges = []
        for sgn in (1.0, -1.0):
            found = None
            r = min_r
            while r < max_r:
                p = b + sgn * nrm * r
                x, y = int(round(p[0])), int(round(p[1]))
                if not (0 <= x < W and 0 <= y < H):
                    break
                if m[y, x] == 0:
                    found = p
                    break
                r += 1.0
            edges.append(found)
        if edges[0] is None or edges[1] is None:
            continue
        e = np.asarray(edges, np.float64)
        P, _, _ = ground_from_image(e, f, pitch_deg, cx, cy)
        ws.append(float(np.linalg.norm(P[0] - P[1])))
    ws = np.asarray(ws, np.float64)
    ws = ws[np.isfinite(ws) & (ws > 1e-6)]
    return ws, len(ws)


def do_width(frame, out, f_list, pitch_list, mask_params, max_r=80):
    img = cv2.imread(frame)
    if img is None:
        raise SystemExit("读不到 %s" % frame)
    H, W = img.shape[:2]
    cx, cy = W / 2.0, H / 2.0
    m = path_mask(img, **mask_params)
    poly, _ = centerline(m)
    print("[width] %s  脊线点 %d" % (os.path.basename(frame), len(poly)))
    rows = []
    for f in f_list:
        for p in pitch_list:
            ws, n = ribbon_widths(poly, m, f, p, cx, cy, max_r=max_r)
            if n < 8:
                continue
            cvs = float(ws.std() / ws.mean())
            rows.append((cvs, f, p, n, float(ws.mean()), float(np.percentile(ws, 10)),
                         float(np.percentile(ws, 90))))
    if not rows:
        raise SystemExit("采样点不足，调 --max-r / --s-min")
    rows.sort()
    print("[width] 最好的 15 组（CV=宽度相对起伏，越小越像「世界等宽」）：")
    for cvs, f, p, n, mean, p10, p90 in rows[:15]:
        print("   f %4d 俯角 %4.1f°  CV %5.3f  n %3d  中位宽 %.3f（p10 %.3f p90 %.3f，单位=相机高）"
              % (f, p, cvs, n, mean, p10, p90))
    return rows[0]


def polyline_ground(uv, f, pitch_deg, cx, cy, eps_px=4.0):
    P, _, _ = ground_from_image(uv, f, pitch_deg, cx, cy)
    if len(P) < 3:
        return P, P
    approx = cv2.approxPolyDP(P.astype(np.float32).reshape(-1, 1, 2), eps_px * 0.004,
                              False).reshape(-1, 2)
    return P, approx.astype(np.float64)


def do_mask(frame, out, params):
    img = cv2.imread(frame)
    if img is None:
        raise SystemExit("读不到 %s" % frame)
    m = path_mask(img, **params)
    poly, d = centerline(m)
    print("[mask] 掩膜像素 %d  脊线点 %d" % (int((m > 0).sum()), len(poly)))
    vis = img.copy()
    vis[m > 0] = (0.35 * vis[m > 0] + 0.65 * np.array([0, 255, 0])).astype(np.uint8)
    for (x, y) in poly.astype(int):
        cv2.circle(vis, (x, y), 1, (255, 0, 255), -1)
    if len(poly) >= 2:
        cv2.polylines(vis, [poly.astype(np.int32).reshape(-1, 1, 2)], False, (255, 255, 255), 1)
    tile = np.concatenate([img, cv2.cvtColor(m, cv2.COLOR_GRAY2BGR), vis], 1)
    if out:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        cv2.imwrite(out, tile)
        print("[mask] 预览 %s" % out)
    return poly


def do_calib(frame, out, f_list, pitch_list, mask_params):
    img = cv2.imread(frame)
    if img is None:
        raise SystemExit("读不到 %s" % frame)
    H, W = img.shape[:2]
    cx, cy = W / 2.0, H / 2.0
    m = path_mask(img, **mask_params)
    poly, _ = centerline(m)
    print("[calib] %s  脊线点 %d" % (os.path.basename(frame), len(poly)))
    if len(poly) < 10:
        raise SystemExit("脊线点太少，调 --h-hi/--s-min")
    rows = []
    for f in f_list:
        for p in pitch_list:
            P, approx = polyline_ground(poly, f, p, cx, cy)
            ang = corner_angles(approx)
            big = [a for a in ang if a > 25.0]
            if not big:
                continue
            ws, nw = ribbon_widths(poly, m, f, p, cx, cy)
            cvs = float(ws.std() / ws.mean()) if nw >= 8 else float("nan")
            wmed = float(np.median(ws)) if nw >= 8 else float("nan")
            dev = float(np.median([abs(a - 90.0) for a in big]))
            rows.append((dev, cvs, f, p, len(big), len(approx), wmed, nw))
    if not rows:
        raise SystemExit("没有任何 (f,θ) 出现 >25° 的转角")
    rows.sort()
    print("[calib] 最好的 15 组（d90=显著转角与 90° 的中位差；CV=带宽相对起伏；宽=相机高为单位）：")
    print("      f  俯角    d90      CV    显著转角  顶点   中位宽   采样")
    for dev, cvs, f, p, nb, na, wmed, nw in rows[:15]:
        print("   %4d  %4.1f°  %6.2f  %6.3f      %2d    %2d   %.3f   %3d"
              % (f, p, dev, cvs, nb, na, wmed, nw))
    # 按 CV 排序的前 15（看两条判据是否指向同一片区域）
    bycv = sorted([r for r in rows if r[1] == r[1]], key=lambda r: r[1])
    print("[calib] 按宽度起伏 CV 最好的 10 组：")
    for dev, cvs, f, p, nb, na, wmed, nw in bycv[:10]:
        print("   %4d  %4.1f°  CV %6.3f  d90 %6.2f  宽 %.3f  n %3d" % (f, p, cvs, dev, wmed, nw))
    best = [r for r in rows if r[1] == r[1]]
    if best:
        j = min(range(len(best)), key=lambda k: best[k][0] + 60.0 * best[k][1])
        print("[calib] 折中（d90 + 60*CV）：f=%d 俯角=%.1f°  d90=%.2f  CV=%.3f"
              % (best[j][2], best[j][3], best[j][0], best[j][1]))
    dev, cvs, f, p, nb, na, wmed, nw = rows[0]
    P, approx = polyline_ground(poly, f, p, cx, cy)
    ang = corner_angles(approx)
    big = [a for a in ang if a > 25.0]
    print("[calib] 选中 f=%d 俯角=%.1f°  显著转角 %s" % (f, p, ["%.1f" % a for a in big]))
    if out:
        vis = img.copy()
        uv2 = image_from_ground(P, f, p, cx, cy)
        for (x, y) in uv2.astype(int):
            if 0 <= x < W and 0 <= y < H:
                cv2.circle(vis, (x, y), 1, (0, 255, 0), -1)
        uv3 = image_from_ground(approx, f, p, cx, cy).astype(int)
        cv2.polylines(vis, [uv3.reshape(-1, 1, 2)], False, (255, 0, 255), 2)
        # 正投小图
        xs = (P[:, 0] - P[:, 0].min())
        zs = (P[:, 1] - P[:, 1].min())
        S = 90.0
        cw, ch = int(max(xs.max() * S + 60, 200)), int(max(zs.max() * S + 60, 200))
        cw, ch = min(cw, 1400), min(ch, 1400)
        gv = np.full((ch, cw, 3), 255, np.uint8)
        gis = image_from_ground(P, f, p, cx, cy)      # 占位，避免未用告警
        gp = np.stack([xs * S + 30, zs * S + 30], 1).astype(int)
        for (x, y) in gp:
            if 0 <= x < cw and 0 <= y < ch:
                cv2.circle(gv, (x, y), 1, (0, 0, 255), -1)
        oa = np.stack([(approx[:, 0] - P[:, 0].min()) * S + 30,
                       (approx[:, 1] - P[:, 1].min()) * S + 30], 1).astype(int)
        cv2.polylines(gv, [oa.reshape(-1, 1, 2)], False, (255, 0, 0), 2)
        for (x, y) in oa:
            if 0 <= x < cw and 0 <= y < ch:
                cv2.circle(gv, (x, y), 3, (0, 128, 0), -1)
        cv2.putText(gv, "f=%d pitch=%.1f  d90=%.2f" % (f, p, dev), (10, 24),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1, cv2.LINE_AA)
        vis2 = cv2.resize(vis, (min(W, cw), int(H * min(W, cw) / W))) if cw != W else vis
        os.makedirs(os.path.dirname(out), exist_ok=True)
        cv2.imwrite(out, np.concatenate([vis2, gv], 1) if vis2.shape[0] == gv.shape[0] else gv)
        cv2.imwrite(out.replace(".png", "-over.png"), vis)
        print("[calib] 正投图 %s / 叠加图 %s" % (out, out.replace(".png", "-over.png")))
    return rows[0]


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("frame")
        sp.add_argument("--out", default="")
        sp.add_argument("--h-hi", type=int, default=22)
        sp.add_argument("--h-lo", type=int, default=0)
        sp.add_argument("--s-min", type=int, default=110)
        sp.add_argument("--v-min", type=int, default=80)

    m = sub.add_parser("mask")
    common(m)
    c = sub.add_parser("calib")
    common(c)
    c.add_argument("--f", default="400,1200,40")
    c.add_argument("--pitch", default="20,75,2")
    w = sub.add_parser("width")
    common(w)
    w.add_argument("--f", default="300,1400,25")
    w.add_argument("--pitch", default="30,86,2")
    w.add_argument("--max-r", type=int, default=80)

    a = ap.parse_args()
    mp = dict(h_hi=a.h_hi, h_lo=a.h_lo, s_min=a.s_min, v_min=a.v_min)
    if a.cmd == "mask":
        do_mask(a.frame, a.out, mp)
    elif a.cmd == "width":
        f0, f1, fs = [float(x) for x in a.f.split(",")]
        p0, p1, ps = [float(x) for x in a.pitch.split(",")]
        f_list = list(range(int(f0), int(f1) + 1, int(fs)))
        pitch_list = [p0 + i * ps for i in range(int((p1 - p0) / ps) + 1)]
        do_width(a.frame, a.out, f_list, pitch_list, mp, max_r=a.max_r)
    else:
        f0, f1, fs = [float(x) for x in a.f.split(",")]
        p0, p1, ps = [float(x) for x in a.pitch.split(",")]
        f_list = list(range(int(f0), int(f1) + 1, int(fs)))
        pitch_list = [p0 + i * ps for i in range(int((p1 - p0) / ps) + 1)]
        do_calib(a.frame, a.out, f_list, pitch_list, mp)


if __name__ == "__main__":
    main()
