# -*- coding: utf-8 -*-
"""A 路线第一步：验证「无滚转 + 固定俯仰」的跟随相机机架，并估计地平线行。

原理（曼哈顿世界）：地面上的所有直线，其灭点都落在地平面的**消失线**上，也就是图像里的地平线。
- 滚转 = 0  ⇒ 地平线在图像里**水平**（斜率≈0），且世界中竖直的边在图像里**竖直**（角度≈90°）。
- 俯仰固定 ⇒ 地平线行号在同一段视频里**基本不变**。
输出：每帧的地平线行/斜率/内点数 与 竖直边角度统计；再给汇总。

用法: python tools/rig-check.py <帧目录> [--step 20] [--max 40] [--tag 名字] [--out 目录]
"""
import os
import sys
import math
import json
import glob
import argparse

import cv2
import numpy as np


def frame_lines(img, min_len=70, max_gap=8, thresh=120):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    g = cv2.GaussianBlur(g, (3, 3), 0)
    e = cv2.Canny(g, 60, 170)
    ls = cv2.HoughLinesP(e, 1, np.pi / 720, threshold=thresh,
                         minLineLength=min_len, maxLineGap=max_gap)
    return [] if ls is None else [l[0] for l in ls]


def to_normal_form(lines):
    out = []
    for x1, y1, x2, y2 in lines:
        dx, dy = float(x2 - x1), float(y2 - y1)
        n = math.hypot(dx, dy)
        if n < 1.0:
            continue
        a, b = dy / n, -dx / n
        c = -(a * x1 + b * y1)
        ang = math.degrees(math.atan2(dy, dx)) % 180.0
        out.append((a, b, c, ang, n))
    return out


def intersections(L, W, H):
    pts = []
    n = len(L)
    for i in range(n):
        a1, b1, c1, t1, _ = L[i]
        for j in range(i + 1, n):
            a2, b2, c2, t2, _ = L[j]
            if abs(math.sin(math.radians(t1 - t2))) < 0.35:   # 夹角 < 20° 视为平行
                continue
            det = a1 * b2 - a2 * b1
            if abs(det) < 1e-9:
                continue
            x = (b1 * c2 - b2 * c1) / det
            y = (c1 * a2 - c2 * a1) / det
            if -0.8 * W < x < 1.8 * W and -1.2 * H < y < 2.2 * H:
                pts.append((x, y))
    return np.asarray(pts, np.float64) if pts else np.zeros((0, 2))


def fit_horizon(pts, H, W, iters=600, tol=4.0, max_slope=0.15, seed=0):
    """RANSAC：在所有交点里找一条「近水平、内点最多」的直线 = 地平线。返回 (row, slope, ninl, ntot)。"""
    if len(pts) < 8:
        return None
    rng = np.random.default_rng(seed)
    best = None
    N = len(pts)
    for _ in range(iters):
        i, j = rng.integers(0, N, 2)
        if i == j:
            continue
        x1, y1 = pts[i]
        x2, y2 = pts[j]
        if abs(x2 - x1) < 0.05 * W:
            continue
        k = (y2 - y1) / (x2 - x1)
        if abs(k) > max_slope:
            continue
        b = y1 - k * x1
        d = np.abs(pts[:, 1] - (k * pts[:, 0] + b)) / math.sqrt(1 + k * k)
        inl = int((d < tol).sum())
        if best is None or inl > best[2]:
            best = (b, k, inl)
    if best is None:
        return None
    b, k, inl = best
    # 用内点重拟合
    d = np.abs(pts[:, 1] - (k * pts[:, 0] + b)) / math.sqrt(1 + k * k)
    sel = pts[d < tol]
    if len(sel) >= 2:
        A = np.stack([sel[:, 0], np.ones(len(sel))], 1)
        sol, *_ = np.linalg.lstsq(A, sel[:, 1], rcond=None)
        k, b = float(sol[0]), float(sol[1])
        d = np.abs(pts[:, 1] - (k * pts[:, 0] + b)) / math.sqrt(1 + k * k)
        inl = int((d < tol).sum())
    return float(b), float(k), inl, len(pts)


def vertical_stats(L, min_len_frac=0.06, H=720):
    """世界里竖直的边在无滚转时应当是图像里的竖线：统计角度分布。"""
    angs = []
    for a, b, c, ang, n in L:
        if n < min_len_frac * H:
            continue
        dev = min(abs(ang - 90.0), abs(ang - 90.0))
        angs.append(dev)
    if not angs:
        return None
    angs = np.asarray(angs)
    return {
        "n": int(len(angs)),
        "frac_lt2deg": float((angs < 2.0).mean()),
        "frac_lt5deg": float((angs < 5.0).mean()),
        "p50_dev": float(np.median(angs)),
        "p90_dev": float(np.percentile(angs, 90)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--step", type=int, default=20)
    ap.add_argument("--max", type=int, default=40)
    ap.add_argument("--tag", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--dump", action="store_true", help="把地平线画到帧上存图（抽查用）")
    a = ap.parse_args()

    files = sorted(glob.glob(os.path.join(a.dir, "*.jpg")) + glob.glob(os.path.join(a.dir, "*.png")))
    if not files:
        raise SystemExit("没有帧: %s" % a.dir)
    picks = files[::max(1, a.step)][:a.max]
    tag = a.tag or os.path.basename(os.path.normpath(a.dir))
    print("[rig] %s  帧 %d 张（目录共 %d）" % (tag, len(picks), len(files)))

    rows, slopes, ninls, nv, vs = [], [], [], [], []
    for i, f in enumerate(picks):
        img = cv2.imread(f)
        if img is None:
            continue
        H, W = img.shape[:2]
        ls = frame_lines(img)
        L = to_normal_form(ls)
        pts = intersections(L, W, H)
        fit = fit_horizon(pts, H, W)
        vt = vertical_stats(L, H=H)
        if fit is None:
            print("  %-16s 线 %3d  交点 %4d  地平线：拟合失败" % (os.path.basename(f), len(L), len(pts)))
            continue
        b, k, inl, ntot = fit
        rows.append(b)
        slopes.append(k)
        ninls.append(inl)
        if vt:
            vs.append(vt["p50_dev"])
        print("  %-16s 线 %3d  交点 %4d  地平线 row %6.1f  斜率 %+.3f（%.2f°）内点 %4d/%4d  竖线 %3d 中位偏差 %.2f°"
              % (os.path.basename(f), len(L), ntot, b, k, math.degrees(math.atan(k)), inl, ntot,
                 vt["n"] if vt else 0, vt["p50_dev"] if vt else float("nan")))
        if a.dump and a.out:
            vis = img.copy()
            cv2.line(vis, (0, int(round(b))), (W - 1, int(round(b + k * (W - 1)))), (0, 0, 255), 2)
            os.makedirs(a.out, exist_ok=True)
            cv2.imwrite(os.path.join(a.out, "rig-%s-%s" % (tag, os.path.basename(f))), vis)

    if not rows:
        raise SystemExit("没有一帧成功拟合地平线")
    rows = np.asarray(rows)
    slopes = np.asarray(slopes)
    print("\n[rig] === 汇总 %s（%d 帧） ===" % (tag, len(rows)))
    print("  地平线行: 中位 %.1f  p10 %.1f  p90 %.1f  std %.2f  （行高变化 std/画面高 = %.3f%%）"
          % (np.median(rows), np.percentile(rows, 10), np.percentile(rows, 90), rows.std(), 100.0 * rows.std() / H))
    print("  地平线斜率: 中位 %+.4f（%.2f°） p90|斜率| %.4f  ⇒ %s"
          % (np.median(slopes), math.degrees(math.atan(np.median(slopes))),
             np.percentile(np.abs(slopes), 90),
             "滚转≈0（地平线水平）" if np.percentile(np.abs(slopes), 90) < 0.02 else "存在滚转/畸变，需查"))
    print("  竖线中位偏差: %.2f°   ⇒ %s"
          % (np.median(vs) if vs else float('nan'),
             "竖直边保持竖直" if (vs and np.median(vs) < 3.0) else "竖直边不竖直（滚转或透视？）"))
    print("  俯仰是否固定: 行 std %.2f px  ⇒ %s"
          % (rows.std(), "固定俯仰" if rows.std() < 6.0 else "俯仰在变（可能有坡道/镜头动作）"))


if __name__ == "__main__":
    main()
