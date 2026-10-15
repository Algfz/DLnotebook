#!/usr/bin/env python
"""参考帧 -> 3D 场景 (MoGe-2 度量点云 + 主轴/地平面 + 长方体候选 + 重投影校验)

用途: 把官方关卡视频里的一帧, 变成"可测量的三维坐标"——
输出度量点云, 世界主轴 (up/e1/e2), 最低显著水平面, 一组轴对齐长方体候选,
以及把它们重新投影回原图的校验图 (肉眼比对: 框是否套住画面里的方块).

例:
  python tools/refscene.py --image "C:\\DLnotebook-media\\ref_official2\\空间\\g0252.jpg" \
      --tag space-g0252 --max-side 1024 --num-tokens 2200

输出 (默认写到 out/tmp/ref-scene/ 下, 前缀 = --tag):
  <tag>.json          内参/FOV/主轴/最低水平面/长方体候选
  <tag>-boxes.png     原图 + 长方体线框重投影 (校验用)
  <tag>-points.ply    彩色点云 (MeshLab / CloudCompare 可开)
  <tag>-depth.png     深度伪彩
  <tag>-normal.png    法线伪彩
  <tag>-top.png       俯视投影 (按高度着色)
  <tag>-side.png      侧视投影 (按高度着色)
"""
import argparse
import json
import math
import os
import sys

import numpy as np
import cv2
import torch

MOGE_REPO = r"C:\DLnotebook-media\tools\MoGe"
DEFAULT_CKPT = r"C:\DLnotebook-media\models\Ruicheng__moge-2-vitl-normal\model.pt"


def log(*a):
    print(*a, flush=True)


def imread_u(path):
    """cv2.imread 在 Windows 上读不了中文路径, 用字节流解码."""
    data = np.fromfile(path, dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def imwrite_u(path, img):
    ext = os.path.splitext(path)[1] or ".png"
    ok, buf = cv2.imencode(ext, img)
    if ok:
        buf.tofile(path)
    return ok


def load_image(path, max_side, crop):
    img = imread_u(path)
    if img is None:
        raise SystemExit("cannot read image: %s" % path)
    if crop:
        x0, y0, x1, y1 = crop
        img = img[y0:y1, x0:x1]
    h, w = img.shape[:2]
    if max_side and max(h, w) > max_side:
        s = max_side / max(h, w)
        img = cv2.resize(img, (int(round(w * s)), int(round(h * s))), interpolation=cv2.INTER_AREA)
    return img


def unit_rows(n, eps=1e-9):
    ln = np.linalg.norm(n, axis=-1, keepdims=True)
    return n / np.maximum(ln, eps)


def colormap(x, mask=None, cmap=cv2.COLORMAP_TURBO):
    x = np.asarray(x, dtype=np.float32)
    v = np.nan_to_num(x[mask] if mask is not None else x.reshape(-1))
    lo, hi = np.percentile(v, 2), np.percentile(v, 98)
    if hi <= lo:
        hi = lo + 1e-6
    n = np.clip((x - lo) / (hi - lo), 0, 1)
    n = np.nan_to_num(n)
    if mask is not None:
        n = n * mask.astype(np.float32)
    return cv2.applyColorMap((n * 255).astype(np.uint8), cmap)


def normals_to_rgb(n, mask):
    v = np.clip((np.nan_to_num(n) * 0.5 + 0.5) * 255, 0, 255).astype(np.uint8)
    return cv2.cvtColor(v, cv2.COLOR_RGB2BGR) * mask[..., None].astype(np.uint8)


def write_ply(path, xyz, rgb):
    pts = xyz.reshape(-1, 3).astype(np.float32)
    cols = rgb.reshape(-1, 3).astype(np.uint8)
    with open(path, "wb") as f:
        f.write(b"ply\nformat binary_little_endian 1.0\n")
        f.write(b"element vertex %d\n" % len(pts))
        f.write(b"property float x\nproperty float y\nproperty float z\n")
        f.write(b"property uchar red\nproperty uchar green\nproperty uchar blue\n")
        f.write(b"end_header\n")
        rec = np.empty(len(pts), dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"),
                                        ("r", "u1"), ("g", "u1"), ("b", "u1")])
        rec["x"], rec["y"], rec["z"] = pts[:, 0], pts[:, 1], pts[:, 2]
        rec["r"], rec["g"], rec["b"] = cols[:, 0], cols[:, 1], cols[:, 2]
        f.write(rec.tobytes())


def splat(path, a, b, c, size=900, pad=40, bg=255):
    """把 (u,v) 点按标量 c 着色画到 PNG (画家算法: 远的先画)."""
    order = np.argsort(-c)
    a, b, c = a[order], b[order], c[order]
    lo, hi = np.percentile(c, 2), np.percentile(c, 98)
    t = np.clip((c - lo) / max(hi - lo, 1e-6), 0, 1)
    canvas = np.full((size, size, 3), bg, np.uint8)
    amin, amax = a.min(), a.max()
    bmin, bmax = b.min(), b.max()
    sc = (size - 2 * pad) / max(amax - amin, bmax - bmin, 1e-6)
    px = (pad + (a - amin) * sc).astype(np.int32)
    py = (size - pad - (b - bmin) * sc).astype(np.int32)
    ok = (px >= 0) & (px < size) & (py >= 0) & (py < size)
    px, py, t = px[ok], py[ok], t[ok]
    colors = cv2.applyColorMap((t * 255).astype(np.uint8), cv2.COLORMAP_TURBO)[:, 0, :]
    canvas[py, px] = colors
    canvas = cv2.morphologyEx(canvas, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    imwrite_u(path, canvas)


# ---------------------------------------------------------------- 世界主轴

def up_from_normals(normal, mask, k=8, seed=0):
    """世界"上"方向 = 法线图里最接近"水平面法线"的主聚类.

    相机系 y 向下, 所以水平面(朝上的面)法线 ny ~ -1 => up 与 -y 同向.
    返回 (up, 内点比例) 或 (None, 0).
    """
    if normal is None:
        return None, 0.0
    n = np.nan_to_num(normal[mask])
    n = n[np.isfinite(n).all(1)]
    n = unit_rows(n)
    if len(n) < 500:
        return None, 0.0
    sub = n[:: max(1, len(n) // 20000)]
    try:
        from scipy.cluster.vq import kmeans2
        cen, _ = kmeans2(sub.astype(np.float64), k, minit="++", seed=seed)
    except Exception as e:  # pragma: no cover
        log("[ref-scene] kmeans failed: %s" % e)
        return None, 0.0
    cen = unit_rows(cen)
    ny = np.abs(cen @ np.array([0.0, 1.0, 0.0]))
    cand = np.where(ny > 0.6)[0]
    if len(cand) == 0:
        return None, 0.0
    i = cand[np.argmax(ny[cand])]
    u = cen[i]
    if u[1] > 0:
        u = -u
    inl = (n @ u) > math.cos(math.radians(20))
    if inl.sum() < 200:
        return None, 0.0
    u = unit_rows(n[inl].mean(0).reshape(1, 3))[0]
    if u[1] > 0:
        u = -u
    return u, float(inl.mean())


def horizontal_axes(up, normal, mask, floor_normal_only=True):
    """水平面的两个主方向: 用"竖直面"(法线垂直于 up)的方位角直方图求主方向."""
    x0 = np.cross(up, np.array([0.0, 0.0, 1.0]))
    if np.linalg.norm(x0) < 1e-6:
        x0 = np.cross(up, np.array([1.0, 0.0, 0.0]))
    x0 = unit_rows(x0.reshape(1, 3))[0]
    y0 = unit_rows(np.cross(up, x0).reshape(1, 3))[0]
    if normal is None:
        return x0, y0, 0
    n = np.nan_to_num(normal[mask])
    n = n[np.isfinite(n).all(1)]
    n = unit_rows(n)
    perp = n - (n @ up)[:, None] * up
    ln = np.linalg.norm(perp, axis=1)
    keep = ln > 0.5
    if keep.sum() < 200:
        return x0, y0, 0
    h = perp[keep] / ln[keep, None]
    az = np.arctan2(h @ y0, h @ x0)
    hist, edges = np.histogram(((az + math.pi) % math.pi), bins=180)  # 折到 0..pi
    i = int(hist.argmax())
    th = edges[i] + (edges[1] - edges[0]) / 2
    e1 = unit_rows((math.cos(th) * x0 + math.sin(th) * y0).reshape(1, 3))[0]
    e2 = unit_rows(np.cross(up, e1).reshape(1, 3))[0]
    return e1, e2, int(hist[i])


def lowest_level(h, horiz_mask, bins=90):
    """最低的"显著水平面": 高度直方图里第一处超过峰值 1/4 的峰."""
    v = np.nan_to_num(h[horiz_mask])
    if len(v) < 200:
        return None
    hist, edges = np.histogram(v, bins=bins)
    k = np.array([1.0, 2.0, 3.0, 2.0, 1.0])
    k /= k.sum()
    hs = np.convolve(hist.astype(np.float64), k, mode="same")
    if hs.max() <= 0:
        return None
    above = np.where(hs > 0.25 * hs.max())[0]
    i = int(above.min())
    return float((edges[i] + edges[i + 1]) / 2)


# ---------------------------------------------------------------- 长方体候选

def boxes_from_height_map(pts, h, up, e1, e2, base, cell=0.05, min_cells=6,
                          min_pts=120, max_boxes=40, thin_ratio=4.0):
    """把基准面以上的点投影到水平面 -> 占据栅格 -> 连通域 = 每个方块的"占地".

    对轴对齐的关卡很稳: 每个方块 = 一个紧凑的 2D 连通域;
    细长的连通域 (长宽比 > thin_ratio) 判为"道路/细条", 分开报告.
    """
    from scipy import ndimage
    keep = (h - base) > 0.05
    P = pts[keep]
    Hh = (h - base)[keep]
    if len(P) < min_pts:
        return [], []
    u1, u2 = P @ e1, P @ e2
    o1, o2 = u1.min(), u2.min()
    i1 = np.floor((u1 - o1) / cell).astype(np.int64)
    i2 = np.floor((u2 - o2) / cell).astype(np.int64)
    w1, w2 = int(i1.max()) + 1, int(i2.max()) + 1
    cnt = np.zeros((w1, w2), np.int32)
    hmax = np.full((w1, w2), -1e9, np.float32)
    np.add.at(cnt, (i1, i2), 1)
    np.maximum.at(hmax, (i1, i2), Hh.astype(np.float32))
    occ = cnt >= 3
    lab, n = ndimage.label(occ, structure=np.ones((3, 3), int))
    boxes, ribbons = [], []
    for k in range(1, n + 1):
        cells = np.argwhere(lab == k)
        if len(cells) < min_cells:
            continue
        m = lab == k
        npts = int(cnt[m].sum())
        if npts < min_pts:
            continue
        r0, r1 = cells[:, 0].min(), cells[:, 0].max()
        c0, c1 = cells[:, 1].min(), cells[:, 1].max()
        size1 = float((r1 - r0 + 1) * cell)
        size2 = float((c1 - c0 + 1) * cell)
        top = float(np.percentile(hmax[m], 95))
        ctr = np.array([o1 + (r0 + r1 + 1) / 2.0 * cell, o2 + (c0 + c1 + 1) / 2.0 * cell,
                        (base + top) / 2.0])
        rec = {
            "n_points": npts,
            "n_cells": int(len(cells)),
            "size_e1_e2_up": [round(size1, 3), round(size2, 3), round(top - base, 3)],
            "center_e1_e2_up": [round(float(v), 3) for v in ctr],
            "top_height": round(top, 3),
            "footprint_long_short": [round(v, 3) for v in sorted([size1, size2], reverse=True)],
        }
        lo, hi = rec["footprint_long_short"]
        if lo > 1e-6 and hi / lo >= thin_ratio:
            ribbons.append(rec)
        else:
            boxes.append(rec)
    boxes.sort(key=lambda b: -b["n_points"])
    ribbons.sort(key=lambda b: -b["n_points"])
    return boxes[:max_boxes], ribbons[:max_boxes]


def slabs_from_faces(pts, normal, h, up, e1, e2, base, cell=0.05, level_band=0.06,
                     bin_m=0.02, peak_frac=0.15, min_pts=300, max_levels=12,
                     thin_ratio=4.0, debug=False):
    """按"朝上的面"分层 -> 每层做 2D 连通域 = 每块平板的顶面.

    比"堆叠占据栅格"稳: 不同高度的平板即使投影重叠也不会粘成一坨.
    每块输出: 顶面高度 top, 占地长宽, 以及该占地内点云的垂直跨度(高度).
    """
    from scipy import ndimage
    nz = np.nan_to_num(normal) if normal is not None else None
    if nz is None:
        return [], []
    upface = np.abs((nz * up[None, None, :]).sum(-1)) > 0.85
    fin = np.isfinite(pts).all(-1)
    Pc = np.where(fin[..., None], pts, 0.0)
    sel = upface & np.isfinite(h) & fin
    if debug:
        print("      [dbg] upface px=%d sel=%d" % (int(upface.sum()), int(sel.sum())), flush=True)
    if sel.sum() < min_pts:
        return [], []
    v = h[sel]
    lo, hi = float(np.percentile(v, 0.5)), float(np.percentile(v, 99.5))
    nb = max(8, int((hi - lo) / bin_m))
    hist, edges = np.histogram(v, bins=nb, range=(lo, hi))
    k = np.array([1.0, 2.0, 3.0, 2.0, 1.0])
    k /= k.sum()
    hs = np.convolve(hist.astype(np.float64), k, mode="same")
    thr = peak_frac * (hs.max() if hs.max() > 0 else 1)
    peaks = []
    for i in range(1, len(hs) - 1):
        if hs[i] >= thr and hs[i] >= hs[i - 1] and hs[i] >= hs[i + 1]:
            peaks.append((hs[i], (edges[i] + edges[i + 1]) / 2))
    peaks.sort(key=lambda p: -p[0])
    levels = []
    for _, lv in peaks:
        if all(abs(lv - l) > 0.08 for l in levels):
            levels.append(lv)
        if len(levels) >= max_levels:
            break
    if debug:
        print("      [dbg] h range %.2f..%.2f  peaks=%d  levels=%s"
              % (lo, hi, len(peaks), [round(l, 2) for l in levels[:8]]), flush=True)
    u1_all, u2_all = Pc @ e1, Pc @ e2
    o1, o2 = u1_all.min(), u2_all.min()
    boxes, ribbons = [], []
    for lv in levels:
        m = sel & (np.abs(h - lv) < level_band)
        if debug:
            print("      [dbg] level %.3f -> px %d" % (lv, int(m.sum())), flush=True)
        if m.sum() < min_pts:
            continue
        s1, s2 = u1_all[m], u2_all[m]
        i1 = np.floor((s1 - o1) / cell).astype(np.int64)
        i2 = np.floor((s2 - o2) / cell).astype(np.int64)
        w1, w2 = int(i1.max()) + 1, int(i2.max()) + 1
        if w1 * w2 > 40_000_000:
            continue
        cnt = np.zeros((w1, w2), np.int32)
        np.add.at(cnt, (i1, i2), 1)
        lab, n = ndimage.label(cnt >= 2, structure=np.ones((3, 3), int))
        for kk in range(1, n + 1):
            mask_k = lab == kk
            npts = int(cnt[mask_k].sum())
            if npts < min_pts:
                continue
            rr = np.argwhere(mask_k)
            r0, r1 = rr[:, 0].min(), rr[:, 0].max()
            c0, c1 = rr[:, 1].min(), rr[:, 1].max()
            la = float((r1 - r0 + 1) * cell)
            lb = float((c1 - c0 + 1) * cell)
            a1 = o1 + r0 * cell
            a2 = o2 + c0 * cell
            b1 = o1 + (r1 + 1) * cell
            b2 = o2 + (c1 + 1) * cell
            inbox = fin & (u1_all >= a1) & (u1_all <= b1) & (u2_all >= a2) & (u2_all <= b2)
            if inbox.sum() < 20:
                continue
            hh = h[inbox]
            hh = hh[np.isfinite(hh)]
            if len(hh) < 20:
                continue
            floor = float(np.percentile(hh, 2))
            top = float(np.percentile(hh, 98))
            if top - floor < 0.10:
                top = float(lv)
            rec = {
                "n_points": npts,
                "level_top_m": round(top, 3),
                "level_top_rel_m": round(top - base, 3),
                "height_m": round(max(top - floor, 0.0), 3),
                "size_e1_e2_up": [round(la, 3), round(lb, 3), round(max(top - floor, 0.0), 3)],
                "center_e1_e2_up": [round((a1 + b1) / 2, 3), round((a2 + b2) / 2, 3),
                                    round((base + top) / 2, 3)],
                "footprint_long_short": [round(x, 3) for x in sorted([la, lb], reverse=True)],
            }
            long_, short_ = rec["footprint_long_short"]
            if short_ > 1e-6 and long_ / short_ >= thin_ratio:
                ribbons.append(rec)
            else:
                boxes.append(rec)
    boxes.sort(key=lambda b: -b["n_points"])
    ribbons.sort(key=lambda b: -b["n_points"])
    return boxes, ribbons


def box_candidates(pts, h, up, e1, e2, base=0.0, above=0.06, max_boxes=12,
                   voxel=0.12, min_pts=220):
    """把基准面以上的点聚成簇, 每簇给一个轴对齐包围盒 (e1/e2/up 坐标系)."""
    keep = (h - base) > above
    P = pts[keep]
    if len(P) < min_pts:
        return []
    U = np.stack([P @ e1, P @ e2, P @ up], axis=1)
    key = np.floor(U / voxel).astype(np.int64)
    buckets = {}
    for i, kx in enumerate(map(tuple, key)):
        buckets.setdefault(kx, []).append(i)
    used_vox = set()
    boxes = []
    for kx, idxs in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
        if kx in used_vox or len(boxes) >= max_boxes:
            continue
        comp_idx, frontier = [], [kx]
        used_vox.add(kx)
        while frontier:
            c = frontier.pop()
            comp_idx.extend(buckets.get(c, []))
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for dz in (-1, 0, 1):
                        nb = (c[0] + dx, c[1] + dy, c[2] + dz)
                        if nb in used_vox or nb not in buckets:
                            continue
                        used_vox.add(nb)
                        frontier.append(nb)
        if len(comp_idx) < min_pts:
            continue
        ci = np.array(comp_idx)
        q = P[ci]
        u1, u2, u3 = q @ e1, q @ e2, q @ up
        size = (float(u1.max() - u1.min()), float(u2.max() - u2.min()), float(u3.max() - u3.min()))
        if size[2] < 0.15:
            continue
        center = np.array([u1.mean(), u2.mean(), u3.mean()])
        boxes.append({
            "n_points": int(len(ci)),
            "size_long_short_height": [round(s, 3) for s in sorted(size[:2], reverse=True) + [size[2]]],
            "size_e1_e2_up": [round(s, 3) for s in size],
            "center_e1_e2_up": [round(float(v), 3) for v in center],
            "top_height": round(float(np.percentile(h[ci], 95)), 3),
        })
    boxes.sort(key=lambda b: -b["n_points"])
    return boxes


def box_corners_world(b, e1, e2, up):
    """(e1,e2,up) 局部坐标下的盒 -> 相机坐标系下的 8 个角.

    注意: center_e1_e2_up 是"投影坐标"(u = P·e1 等), 不是相机坐标;
    因为 (e1,e2,up) 是相机系里的标准正交基, 所以 P = u1*e1 + u2*e2 + u3*up ✓
    """
    c = np.asarray(b["center_e1_e2_up"], dtype=np.float64)
    s = np.asarray(b["size_e1_e2_up"], dtype=np.float64)
    c_world = c[0] * e1 + c[1] * e2 + c[2] * up
    pts = []
    for a in (-0.5, 0.5):
        for bb in (-0.5, 0.5):
            for cc in (-0.5, 0.5):
                pts.append(c_world + a * s[0] * e1 + bb * s[1] * e2 + cc * s[2] * up)
    return np.asarray(pts)


def project(pts_world, K_px):
    p = np.asarray(pts_world)
    z = p[:, 2]
    ok = z > 1e-6
    uv = np.full((len(p), 2), np.nan)
    uv[ok, 0] = K_px[0, 0] * p[ok, 0] / z[ok] + K_px[0, 2]
    uv[ok, 1] = K_px[1, 1] * p[ok, 1] / z[ok] + K_px[1, 2]
    return uv


def draw_boxes(img, boxes, K_px, e1, e2, up, ribbons=None):
    vis = img.copy()
    edges = [(i, i ^ (1 << b)) for i in range(8) for b in (0, 1, 2)]
    groups = [(boxes, (0, 0, 255)), (ribbons or [], (255, 0, 255))]
    for items, col in groups:
        for rank, b in enumerate(items):
            if b["n_points"] < 1500:
                continue
            uv = project(box_corners_world(b, e1, e2, up), K_px)
            if not np.isfinite(uv).any():
                continue
            for i, j in edges:
                if not (np.isfinite(uv[i]).all() and np.isfinite(uv[j]).all()):
                    continue
                cv2.line(vis, tuple(np.round(uv[i]).astype(int)), tuple(np.round(uv[j]).astype(int)),
                         col, 2, cv2.LINE_AA)
            c = np.nanmean(uv, axis=0)
            if np.isfinite(c).all():
                s = b["size_e1_e2_up"]
                txt = "%.2fx%.2fx%.2f" % (s[0], s[1], s[2])
                org = tuple(np.clip(np.round(c).astype(int), (2, 14), (img.shape[1] - 150, img.shape[0] - 6)))
                cv2.putText(vis, txt, org, cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 3)
                cv2.putText(vis, txt, org, cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    return vis


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--ckpt", default=DEFAULT_CKPT)
    ap.add_argument("--tag", default=None)
    ap.add_argument("--out", default=os.path.join("out", "tmp", "ref-scene"))
    ap.add_argument("--max-side", type=int, default=1024)
    ap.add_argument("--num-tokens", type=int, default=2200)
    ap.add_argument("--crop", default=None, help="x0,y0,x1,y1")
    ap.add_argument("--no-viz", action="store_true")
    args = ap.parse_args()

    tag = args.tag or os.path.splitext(os.path.basename(args.image))[0]
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    crop = tuple(int(v) for v in args.crop.split(",")) if args.crop else None

    sys.path.insert(0, MOGE_REPO)
    from moge.model.v2 import MoGeModel

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    log("[ref-scene] ckpt=%s device=%s" % (args.ckpt, device))
    model = MoGeModel.from_pretrained(args.ckpt).to(device).eval()

    img = load_image(args.image, args.max_side, crop)
    H, W = img.shape[:2]
    log("[ref-scene] image %dx%d" % (W, H))
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    tensor = torch.tensor(rgb / 255.0, dtype=torch.float32, device=device).permute(2, 0, 1)

    with torch.no_grad():
        res = model.infer(tensor, num_tokens=args.num_tokens, use_fp16=True)

    pts = res["points"].float().cpu().numpy()
    depth = res["depth"].float().cpu().numpy()
    K = res["intrinsics"].float().cpu().numpy()
    mask = res["mask"].cpu().numpy().astype(bool) if res.get("mask") is not None else np.ones((H, W), bool)
    normal = res["normal"].float().cpu().numpy() if res.get("normal") is not None else None
    mask = mask & np.isfinite(pts).all(-1) & np.isfinite(depth)

    fx = float(K[0, 0]) * W
    fy = float(K[1, 1]) * H
    cx, cy = float(K[0, 2] * W), float(K[1, 2] * H)
    K_px = np.array([[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]])
    fov_x = 2 * math.degrees(math.atan(0.5 * W / fx)) if fx else None
    fov_y = 2 * math.degrees(math.atan(0.5 * H / fy)) if fy else None
    log("[ref-scene] fx=%.1fpx fy=%.1fpx fov_x=%.1fdeg fov_y=%.1fdeg (cx=%.1f cy=%.1f)"
        % (fx, fy, fov_x, fov_y, cx, cy))

    P = pts[mask]
    log("[ref-scene] valid points %d / %d; depth median %.3f m (min %.3f max %.3f)"
        % (len(P), H * W, np.median(depth[mask]), depth[mask].min(), depth[mask].max()))

    up, up_frac = up_from_normals(normal, mask)
    e1 = e2 = None
    base = None
    boxes, ribbons = [], []
    if up is not None:
        e1, e2, axis_pts = horizontal_axes(up, normal, mask)
        log("[ref-scene] up=(%.3f,%.3f,%.3f) 水平面占比 %.1f%%" % (*up, up_frac * 100))
        log("[ref-scene] e1=(%.3f,%.3f,%.3f) e2=(%.3f,%.3f,%.3f) 方位直方图峰 %d px"
            % (*e1, *e2, axis_pts))
        h_all = pts @ up
        nz = np.nan_to_num(normal) if normal is not None else None
        horiz = np.zeros((H, W), bool)
        if nz is not None:
            horiz = mask & (np.abs((nz * up[None, None, :]).sum(-1)) > 0.85)
        base = lowest_level(h_all, horiz)
        log("[ref-scene] 最低显著水平面 h=%.3f m (相机原点为 0, up 为正)" % (base if base is not None else float("nan")))
        if base is not None:
            boxes, ribbons = slabs_from_faces(pts, normal, h_all, up, e1, e2, base)
            if not boxes and not ribbons:
                boxes, ribbons = boxes_from_height_map(P, h_all[mask], up, e1, e2, base=base)
                log("[ref-scene] (分层法无结果, 回退到占据栅格法)")
            log("[ref-scene] 平板候选 %d 块, 细长条(疑似道路) %d 条" % (len(boxes), len(ribbons)))
            for b in boxes[:10]:
                log("    平板 pts %7d  长x宽x高 %.2f x %.2f x %.2f m  top %.2f m (相对最低面 %.2f m)"
                    % (b["n_points"], b["size_e1_e2_up"][0], b["size_e1_e2_up"][1],
                       b["height_m"], b["level_top_m"], b["level_top_rel_m"]))
            for r in ribbons[:6]:
                log("    细条 pts %7d  长x宽x高 %.2f x %.2f m  top %.2f m"
                    % (r["n_points"], r["size_e1_e2_up"][0], r["size_e1_e2_up"][1], r["level_top_m"]))
    else:
        log("[ref-scene] 法线图里找不到水平面主方向 => 主轴未知")

    meta = {
        "image": args.image, "size": [W, H], "tag": tag,
        "intrinsics_px": K_px.tolist(),
        "fov_x_deg": fov_x, "fov_y_deg": fov_y,
        "depth_median_m": float(np.median(depth[mask])),
        "up": None if up is None else [float(v) for v in up],
        "up_horizontal_face_ratio": up_frac,
        "e1": None if e1 is None else [float(v) for v in e1],
        "e2": None if e2 is None else [float(v) for v in e2],
        "base_level_m": base,
        "boxes": boxes,
        "ribbons": ribbons,
    }
    with open(os.path.join(out, "%s.json" % tag), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    if not args.no_viz:
        step = 1
        if int(mask.sum()) > 250000:
            step = max(1, int(math.sqrt(int(mask.sum()) / 250000)))
        idx = np.flatnonzero(mask.reshape(-1))[::step]
        write_ply(os.path.join(out, "%s-points.ply" % tag),
                  pts.reshape(-1, 3)[idx], rgb.reshape(-1, 3)[idx])
        imwrite_u(os.path.join(out, "%s-depth.png" % tag), colormap(depth, mask))
        if normal is not None:
            imwrite_u(os.path.join(out, "%s-normal.png" % tag), normals_to_rgb(normal, mask))
        if up is not None and e1 is not None:
            X = pts @ e1
            Y = pts @ e2
            Z = pts @ up - (base if base is not None else 0.0)
            ok2 = mask & np.isfinite(X) & np.isfinite(Y) & np.isfinite(Z)
            splat(os.path.join(out, "%s-top.png" % tag), X[ok2], Y[ok2], Z[ok2])
            splat(os.path.join(out, "%s-side.png" % tag), X[ok2], Z[ok2], -Y[ok2])
            if boxes or ribbons:
                imwrite_u(os.path.join(out, "%s-boxes.png" % tag),
                          draw_boxes(img, boxes, K_px, e1, e2, up, ribbons))
    log("[ref-scene] out %s" % out)


if __name__ == "__main__":
    main()
