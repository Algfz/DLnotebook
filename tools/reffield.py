#!/usr/bin/env python
"""沿路径连续场: 逐帧把点云化到"路面系 (u,v,h) / 单位 W" -> 自由宽度曲线 + 走廊条带图.

  python tools/reffield.py --dir C:\\DLnotebook-media\\tmp\\seq\\desert-a --tag desert-a

每帧 (MoGe-2 单帧度量点云, 常驻模型):
  1) 路面掩膜 HSV(S<70,V>195) ∩ 有效点 -> 用路面点的法线均值当"上", 用其投影中位当地面高度;
  2) 路面点横向展布 -> 路宽 W (本帧), 一切长度除以 W (绝对尺度误差被消掉);
  3) 相机地面投影为原点: v=向前, u=向右, h=离地高度;
  4) 栅格化 (cell=0.05W): 高度图 max h, 占据 = h>0.15W;
  5) 自由宽度 fw(v) = 包含 u=0 的连续非占据区间长度.
产出:
  out/tmp/fields/<tag>-fields.jsonl   每帧一行 (W 度量值/路面点/各 v 的自由宽度/障碍数)
  out/tmp/fields/<tag>-fw.png         自由宽度谱 (横轴=帧, 纵轴=v(W), 亮度=fw)
  out/tmp/fields/<tag>-occ.png        若干帧的 (u,v) 占据图 (每格=0.05W)
  out/tmp/fields/<tag>-curves.png     fw(v=1/2/4W) 与 W 随时间 + 障碍数
"""
import argparse
import glob
import json
import math
import os
import sys

import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import refscene as rs  # noqa: E402
import refserve as rv  # noqa: E402

V_SAMPLES = [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, 8.0, 10.0]


def road_mask(img, smax=70, vmin=195):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    s, v = hsv[..., 1].astype(np.float32), hsv[..., 2].astype(np.float32)
    m = ((s < smax) & (v > vmin)).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    return m.astype(bool)


def road_mask_kmeans(img, k=6, tol=None, max_frac=0.35, min_px=150, seed=0):
    """颜色聚类找"细长带状"路面: 对每个色簇取连通域, 用 周长²/面积(细长) + 是否触底 + 位置 打分."""
    H, W = img.shape[:2]
    rng = np.random.RandomState(seed)
    step = max(1, int(np.sqrt(H * W / 40000.0)))
    sm = img[::step, ::step].reshape(-1, 3).astype(np.float32)
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 12, 1.0)
    _, labels, centers = cv2.kmeans(sm, k, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    clab = cv2.cvtColor(centers.astype(np.uint8).reshape(-1, 1, 3), cv2.COLOR_BGR2LAB).astype(np.float32).reshape(-1, 3)
    best, best_score, best_center, best_ci = None, -1.0, None, -1
    for ci in range(k):
        d = np.linalg.norm(lab - clab[ci], axis=-1)
        t = tol if tol is not None else 34.0
        m = (d < t).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        n, lbl, stats, cent = cv2.connectedComponentsWithStats(m, 8)
        for li in range(1, n):
            area = int(stats[li, 4])
            if area < min_px or area > max_frac * H * W:
                continue
            x, y, w, h = stats[li, 0], stats[li, 1], stats[li, 2], stats[li, 3]
            comp = (lbl == li)
            if y + h < int(H * 0.97):                    # 必须触到图像底边(相机在路上方)
                continue
            bot = comp[H - 1] | comp[H - 2] | comp[H - 3]
            bx = np.flatnonzero(bot)
            if len(bx) < 3:
                continue
            cx_f = float(bx.mean()) / W
            if not (0.22 <= cx_f <= 0.78):               # 底边交点须在中部
                continue
            ys, xs = np.nonzero(comp)
            peri = float(np.count_nonzero(cv2.Canny((comp * 255).astype(np.uint8), 50, 150)))
            elong = peri * peri / max(area, 1)           # 细长 -> 大
            score = elong * (1.0 - abs(cx_f - 0.5) * 1.4)
            if score > best_score:
                best_score, best, best_center, best_ci = score, comp.copy(), centers[ci], ci
    if best is None:
        return np.zeros((H, W), bool), None, -1.0
    # 用整个色簇(不只连通域)当路面: 红带的亮/暗两半常被切成两个连通域
    lab_c = clab[best_ci]
    full = (np.linalg.norm(lab - lab_c, axis=-1) < (tol if tol is not None else 34.0))
    full = cv2.morphologyEx(full.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8)).astype(bool)
    if full.mean() <= max_frac:
        best = full
    return best, best_center, best_score


def road_mask_adaptive(img, tol=26.0, band=(0.94, 1.0), cx=(0.42, 0.58), max_frac=0.35):
    """路面 = 含"图像底部中央"种子的连通色块 (颜色从底部中央自适应取)."""
    H, W = img.shape[:2]
    y0 = int(H * band[0])
    x0, x1 = int(W * cx[0]), int(W * cx[1])
    patch = img[y0:H, x0:x1].reshape(-1, 3).astype(np.float32)
    if len(patch) < 50:
        return np.zeros((H, W), bool)
    c = np.median(patch, axis=0)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    clab = cv2.cvtColor(np.uint8([[c]]), cv2.COLOR_BGR2LAB).astype(np.float32)[0, 0]
    dist = np.linalg.norm(lab - clab, axis=-1)
    m = (dist < tol).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lbl = cv2.connectedComponents(m, 8)
    seed = int(lbl[int(H * 0.985), int(W * 0.5)])
    if seed == 0:
        for dy in range(1, 12):                     # 底部中央找不到就往上找
            seed = int(lbl[max(int(H * 0.985) - dy, 0), int(W * 0.5)])
            if seed:
                break
    if seed == 0:
        return np.zeros((H, W), bool)
    out = (lbl == seed)
    if out.mean() > max_frac:                        # 太大 -> 多半是地面, 不是路面
        return np.zeros((H, W), bool)
    return out


def ground_plane(P, valid, iters=500, seed=0, max_pts=60000, min_inl=2000):
    """RANSAC 拟合主导地面平面 (相机系): 只接受 y 朝上(|n·(0,-1,0)|>0.5)的平面."""
    Q = P[valid.reshape(-1)]
    if len(Q) < min_inl:
        return None
    rng = np.random.RandomState(seed)
    sub = Q[rng.choice(len(Q), min(len(Q), max_pts), replace=False)]
    med_d = float(np.median(np.linalg.norm(sub, axis=1)))
    thr = max(0.015 * med_d, 1e-4)
    best = (0, None, 0.0)
    for _ in range(iters):
        i = rng.choice(len(sub), 3, replace=False)
        p0, p1, p2 = sub[i]
        n = np.cross(p1 - p0, p2 - p0)
        nn = np.linalg.norm(n)
        if nn < 1e-9:
            continue
        n = n / nn
        if n[1] > 0:
            n = -n
        if n[1] > -0.5:                       # 要求近似水平(相机系 y 向下)
            continue
        d = float(np.median(sub @ n))
        inl = int(np.sum(np.abs(sub @ n - d) < thr))
        if inl > best[0]:
            best = (inl, n, d)
    if best[1] is None:
        return None
    n, d = best[1], best[2]
    inl = np.abs(sub @ n - d) < thr
    Qs = sub[inl]
    c = Qs.mean(0)
    u, s, vt = np.linalg.svd(Qs - c, full_matrices=False)
    n2 = vt[2]
    if n2[1] > 0:
        n2 = -n2
    if n2[1] > -0.5:
        n2 = n
    d2 = float(c @ n2)
    return {"n": n2 / np.linalg.norm(n2), "d": d2, "inliers": int(inl.sum()),
            "inlier_frac": float(inl.mean()), "thr": thr, "med_depth": med_d}


def ground_up(P, nrm, valid, H, band_lo=0.55):
    """地面上方向: 图像下半部(地面为主)法线中位, 并统一"朝向相机"(n·(-P)>0)."""
    band = np.zeros((H, nrm.shape[1]), bool)
    band[int(H * band_lo):, :] = True
    idx = band.reshape(-1) & valid.reshape(-1)
    if idx.sum() < 200:
        return None, 0.0
    nn = nrm.reshape(-1, 3)[idx]
    nn = nn / np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-9)
    n = np.median(nn, axis=0)
    n /= max(np.linalg.norm(n), 1e-9)
    Qn = P.reshape(-1, 3)[idx]
    if float(n @ (-Qn.mean(0))) < 0:
        n = -n
    frac = float(np.mean(nn @ n > 0.9))
    return n, frac


def road_width_local(fr, rm, rows=None, min_run=3):
    """路面局部厚度法估路宽: 在若干图像行上量掩膜连通段的像素宽 -> 世界宽 = w_px * |P| / fx."""
    H, W = fr["H"], fr["W"]
    fx = fr["fx"]
    pts = fr["points"]
    if rows is None:
        rows = tuple(np.arange(0.62, 0.995, 0.03))
    est = []
    for rr in rows:
        y = min(int(round(H * rr)), H - 1)
        row = rm[y]
        idx = np.flatnonzero(row)
        if len(idx) < min_run:
            continue
        for run in np.split(idx, np.flatnonzero(np.diff(idx) > 2) + 1):
            if len(run) < min_run:
                continue
            seg = pts[y, run[0]:run[-1] + 1]
            z = np.linalg.norm(seg, axis=1)
            m = np.isfinite(z) & (z > 1e-6)
            if m.sum() < min_run:
                continue
            est.append(float(np.median(z[m])) * (run[-1] - run[0] + 1) / fx)
    est = [e for e in est if np.isfinite(e) and e > 0]
    if not est:
        return float("nan"), 0
    return float(np.median(est)), len(est)


def frame_field(fr, img, cell=0.05, lat=3.0, ahead=10.0, obst_h=0.12, min_road_px=300):
    """单帧 -> 路面系栅格 + 自由宽度谱 (长度单位 = 本帧路宽 W)."""
    pts, nrm, valid = fr["points"], fr["normal"], fr["mask"]
    H, W = fr["H"], fr["W"]
    P = pts.reshape(-1, 3)
    rmk, mk_center, mk_score = road_mask_kmeans(img)
    rma = road_mask_adaptive(img)
    rmb = road_mask(img)
    if rmk.sum() >= 200:
        rm0 = rmk
    elif rma.sum() >= 200:
        rm0 = rma
    else:
        rm0 = rmb
    rm = rm0 & valid
    if rm.sum() < min_road_px:                       # 兜底: 用下三分之一 + 有效点
        rm = np.zeros_like(valid)
        rm[int(H * 0.65):, :] = True
        rm &= valid
    n, agree = ground_up(P, nrm, valid, H)
    if n is None:                                    # 再兜底: 用路面点法线中位
        nr = nrm[rm].reshape(-1, 3)
        nr = nr / np.maximum(np.linalg.norm(nr, axis=1, keepdims=True), 1e-9)
        n = np.median(nr, axis=0)
        n /= max(np.linalg.norm(n), 1e-9)
        Qn = P[rm.reshape(-1)]
        if float(n @ (-Qn.mean(0))) < 0:
            n = -n
        agree = 0.0
    hmask = rm.reshape(-1)
    d_road = float(np.median(P[hmask] @ n)) if hmask.sum() >= 80 else None
    # 平坦度自检: 下半部点在 n 上的展布
    band = np.zeros((H, W), bool)
    band[int(H * 0.65):, :] = True
    bi = band.reshape(-1) & valid.reshape(-1)
    h_band = P[bi] @ n
    flat_rms = float(np.std(h_band)) if bi.sum() else float("nan")
    d = d_road if d_road is not None else float(np.median(h_band))
    # 水平基
    zax = np.array([0.0, 0.0, 1.0])
    f = zax - (zax @ n) * n
    nf = np.linalg.norm(f)
    if nf < 1e-6:
        return None
    f /= nf
    r = np.cross(f, n)
    r /= max(np.linalg.norm(r), 1e-9)
    # 尺度单位: 相机离地高 Hc = |d| (稳健, 与配色无关); 路宽单独作为诊断量上报
    q = P - d * n
    u_all, v_all, h_all = q @ r, q @ f, q @ n
    rmask = rm.reshape(-1)
    Wm = abs(float(d))
    Wroad, nrow = road_width_local(fr, rm)
    if not np.isfinite(Wroad) or Wroad <= 1e-6:
        Wroad = float("nan")
    if not np.isfinite(Wm) or Wm <= 1e-6:
        Wm = float("nan")
    # 栅格化
    nu, nv = int(round(2 * lat / cell)) + 1, int(round(ahead / cell)) + 1
    hmap = np.zeros((nv, nu), np.float32)
    cnt = np.zeros((nv, nu), np.float32)
    if np.isfinite(Wm):
        sel = valid.reshape(-1) & (h_all > -0.5 * Wm) & (v_all > 0.1 * Wm) & (v_all < ahead * Wm)
        uu = u_all[sel] / Wm
        vv = v_all[sel] / Wm
        hh = np.maximum(h_all[sel], 0.0) / Wm
        iu = np.round((uu - (-lat)) / cell).astype(np.int32)
        iv = np.round(vv / cell).astype(np.int32)
        ok = (iu >= 0) & (iu < nu) & (iv >= 0) & (iv < nv)
        iu, iv, hh = iu[ok], iv[ok], hh[ok]
        np.maximum.at(hmap, (iv, iu), hh)
        np.add.at(cnt, (iv, iu), 1.0)
    # 去趋势: 地面平面在 MoGe 输出里有残留倾斜/弯曲, 减掉局部中位背景后小道具才浮出噪声
    try:
        from scipy.ndimage import median_filter
        bg = median_filter(hmap, size=(31, 31), mode="nearest")
    except Exception:
        bg = cv2.blur(hmap, (31, 31))
    hrel = hmap - bg
    filled = cnt > 0
    if filled.any():
        base = float(np.median(hrel[filled]))
        mad = float(np.median(np.abs(hrel[filled] - base)))
    else:
        base, mad = 0.0, 0.0
    thr_eff = max(obst_h, base + 6.0 * mad)
    occ = hrel > thr_eff
    # 自由宽度: 每行包含 u=0 的连续非占据区间
    iu0 = int(round(lat / cell))
    fw, vv_grid, hrow = [], [], []
    for iv in range(nv):
        row = occ[iv]
        if not row[iu0]:
            lo = iu0
            while lo > 0 and not row[lo - 1]:
                lo -= 1
            hi = iu0
            while hi < nu - 1 and not row[hi + 1]:
                hi += 1
            width = (hi - lo + 1) * cell
            edge = (lo == 0) or (hi == nu - 1)
        else:
            width, edge = 0.0, False
        fw.append(width)
        vv_grid.append(iv * cell)
        hrow.append(float(hmap[iv].max()))
    fw = np.array(fw)
    hrow = np.array(hrow)
    vv_grid = np.array(vv_grid)
    prof = []
    for v in V_SAMPLES:
        i = int(round(v / cell))
        prof.append(float(fw[min(i, nv - 1)]))
    i4 = int(round(4.0 / cell))
    return {
        "W_m": Wm, "W_road_m": Wroad, "road_px": int(rm.sum()), "up": n.tolist(),
        "up_agree": agree, "flat_rms": flat_rms, "W_rows": nrow,
        "cam_h_W": float(abs(d) / Wm) if np.isfinite(Wm) else None,
        "occ_cells": int(occ.sum()), "occ_frac": float(occ.mean()),
        "hmax_W": float(hrow.max()) if len(hrow) else 0.0,
        "fw": prof, "v": V_SAMPLES,
        "fw_min_4W": float(fw[:i4 + 1].min()) if nv > i4 else float(fw.min()),
        "hmap": hrel, "habs": hmap, "thr_eff": thr_eff, "occ": occ, "fw_all": fw, "v_all": vv_grid,
    }


def up_h(q, n):
    return q @ n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", default=os.path.join("out", "tmp", "fields"))
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--cell", type=float, default=0.05)
    ap.add_argument("--lat", type=float, default=3.0)
    ap.add_argument("--ahead", type=float, default=10.0)
    ap.add_argument("--obst-h", type=float, default=0.15)
    ap.add_argument("--num-tokens", type=int, default=1800)
    ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--probe", action="store_true", help="第一帧存调试图")
    ap.add_argument("--ckpt", default=rs.DEFAULT_CKPT)
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.dir, "*.jpg")))[:: args.stride]
    if args.max_frames:
        files = files[: args.max_frames]
    model, device = rv.load_model(args.ckpt)
    rows, hmaps = [], []
    for k, fp in enumerate(files):
        img = rs.imread_u(fp)
        if img is None:
            continue
        fr = rv.infer_frame(model, device, img, num_tokens=args.num_tokens)
        f = frame_field(fr, img, cell=args.cell, lat=args.lat, ahead=args.ahead, obst_h=args.obst_h)
        if f is None:
            rs.log("[fields] %s: 几何失败" % os.path.basename(fp))
            continue
        row = {kk: f[kk] for kk in ("W_m", "road_px", "occ_cells", "occ_frac", "hmax_W", "fw", "v", "fw_min_4W", "cam_h_W")}
        row["frame"] = os.path.basename(fp)
        row["i"] = k
        rows.append(row)
        hmaps.append(f["hmap"])
        if args.probe and k == 0:
            dbg = img.copy()
            m = road_mask(img)
            dbg[m] = (0.5 * dbg[m] + 0.5 * np.array([0, 0, 255])).astype(np.uint8)
            rs.imwrite_u(os.path.join(out, "%s-probe-mask.png" % args.tag), dbg)
            hh = f["hmap"]
            vis = np.clip(hh / max(hh.max(), 1e-6) * 255, 0, 255).astype(np.uint8)
            vis = cv2.applyColorMap(vis, cv2.COLORMAP_INFERNO)
            big = cv2.resize(vis, (vis.shape[1] * 2, vis.shape[0] * 2), interpolation=cv2.INTER_NEAREST)
            rs.imwrite_u(os.path.join(out, "%s-probe-hmap.png" % args.tag), big)
        if (k + 1) % 20 == 0:
            rs.log("[fields] %d/%d" % (k + 1, len(files)))

    with open(os.path.join(out, "%s-fields.jsonl" % args.tag), "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    rs.log("[fields] 写出 %d 帧 -> %s-fields.jsonl" % (len(rows), args.tag))
    if not rows:
        return

    # ---- 自由宽度谱 (x=帧, y=v, 颜色=fw)
    nv = len(V_SAMPLES)
    prof = np.array([r["fw"] for r in rows]).T          # (nv, nframes)
    strip = np.clip((prof - 0.8) / 2.2, 0, 1)            # 0.8W=黑, 3.0W=白
    img = (strip * 255).astype(np.uint8)
    img = cv2.resize(img, (img.shape[1] * 6, img.shape[0] * 40), interpolation=cv2.INTER_NEAREST)
    img = cv2.applyColorMap(img, cv2.COLORMAP_VIRIDIS)
    for i, v in enumerate(V_SAMPLES):
        cv2.line(img, (0, i * 40), (img.shape[1], i * 40), (60, 60, 60), 1)
        cv2.putText(img, "%.2gW" % v, (4, i * 40 + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    rs.imwrite_u(os.path.join(out, "%s-fw.png" % args.tag), img)

    # ---- 占据图 (选 6 帧)
    cols = []
    pick = np.linspace(0, len(hmaps) - 1, 6).astype(int)
    for i in pick:
        hh = hmaps[i]
        vis = np.clip(hh / 1.2 * 255, 0, 255).astype(np.uint8)
        vis = cv2.applyColorMap(255 - vis, cv2.COLORMAP_BONE)
        vis = cv2.resize(vis, (vis.shape[1] * 3, vis.shape[0] * 3), interpolation=cv2.INTER_NEAREST)
        cv2.putText(vis, rows[i]["frame"][:12], (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1)
        cols.append(vis)
    if cols:
        rs.imwrite_u(os.path.join(out, "%s-occ.png" % args.tag), np.hstack(cols))

    # ---- 曲线
    n = len(rows)
    w = 1200
    h = 420
    cv = np.full((h, w, 3), 255, np.uint8)
    xs = np.linspace(40, w - 20, n).astype(np.int32)

    def plot(vals, scale, color, lo=0.0):
        v = np.array(vals, dtype=np.float32)
        y = (h - 40 - (v - lo) * scale).astype(np.int32)
        for i in range(n - 1):
            cv2.line(cv, (xs[i], int(np.clip(y[i], 5, h - 5))), (xs[i + 1], int(np.clip(y[i + 1], 5, h - 5))), color, 2)

    sc = (h - 90) / 4.0
    for lev in (1, 2, 3, 4):
        yy = int(h - 40 - lev * sc)
        cv2.line(cv, (40, yy), (w - 20, yy), (200, 200, 200), 1)
        cv2.putText(cv, "%dW" % lev, (6, yy + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (80, 80, 80), 1)
    for j, col in zip((2, 4, 6), ((0, 0, 255), (0, 160, 0), (255, 0, 0))):
        plot([r["fw"][j] for r in rows], sc, col)
    cv2.putText(cv, "fw(v=1W) red / 2W green / 4W blue", (50, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1)
    rs.imwrite_u(os.path.join(out, "%s-curves.png" % args.tag), cv)

    fw1 = np.array([r["fw"][2] for r in rows])
    fw4 = np.array([r["fw"][6] for r in rows])
    Wm = np.array([r["W_m"] for r in rows])
    rs.log("[fields] fw(1W) 中位 %.2fW (最小 %.2f)  fw(4W) 中位 %.2fW  W 中位 %.3fm (n=%d)"
           % (np.nanmedian(fw1), np.nanmin(fw1), np.nanmedian(fw4), np.nanmedian(Wm), n))
    rs.log("[fields] done -> %s" % out)


if __name__ == "__main__":
    main()
