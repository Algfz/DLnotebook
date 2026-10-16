# -*- coding: utf-8 -*-
"""回渲图 vs 真值帧的定量比对（避免"看着像"的主观判断）。

对每对 (render, truth) 输出：
  fg_iou    前景（非背景色）掩膜 IoU —— 点云为背景色 #f0d24b 平面，真值帧背景为天空/黄
  road_iou  "路面"掩膜 IoU（低饱和且中等亮度，含红边像素）—— 最能反映"路走对了没有"
  edge_corr 梯度幅值（Sobel）相关系数 —— 对配色/明暗不敏感，只比结构
  ssim      灰度 SSIM（会因点云稀疏而偏低，只作参考）
  cover     渲染前景像素占比 / 真值前景像素占比

用法：
    python tools/img-score.py --truth T.jpg --render R.png [--render R2.png ...] [--out score.json]
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np


def load_any(path, W=None, H=None):
    im = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if im is None:
        raise SystemExit("读不到图: %s" % path)
    if W and H and (im.shape[1] != W or im.shape[0] != H):
        im = cv2.resize(im, (W, H), interpolation=cv2.INTER_AREA)
    return im


def bg_color(bgr, band=12):
    """取顶部若干行的中位色作为背景色（真值帧是天空、渲染图是纯背景色）。"""
    top = bgr[:band].reshape(-1, 3).astype(np.float32)
    return np.median(top, axis=0)


def fg_mask(bgr, thr=28.0, band=12):
    bg = bg_color(bgr, band)
    d = np.linalg.norm(bgr.astype(np.float32) - bg[None, None, :], axis=2)
    return d > thr


def road_mask(bgr):
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0].astype(np.int32), hsv[..., 1].astype(np.int32), hsv[..., 2].astype(np.int32)
    gray = (s < 60) & (v > 40) & (v < 215)
    red = ((h < 12) | (h > 168)) & (s > 90) & (v > 70)
    return gray | red


def iou(a, b):
    inter = np.count_nonzero(a & b)
    uni = np.count_nonzero(a | b)
    return float(inter) / float(uni) if uni else 0.0


def grad_mag(gray):
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    return np.sqrt(gx * gx + gy * gy)


def ssim_gray(a, b, win=7):
    a = a.astype(np.float64); b = b.astype(np.float64)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    k = cv2.getGaussianKernel(win, 1.5)
    kern = k @ k.T

    def blur(x):
        return cv2.filter2D(x, -1, kern, borderType=cv2.BORDER_REFLECT)

    mu_a, mu_b = blur(a), blur(b)
    va, vb = blur(a * a) - mu_a ** 2, blur(b * b) - mu_b ** 2
    cab = blur(a * b) - mu_a * mu_b
    s = ((2 * mu_a * mu_b + C1) * (2 * cab + C2)) / ((mu_a ** 2 + mu_b ** 2 + C1) * (va + vb + C2))
    return float(np.mean(s))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--truth", required=True)
    ap.add_argument("--render", action="append", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--mask", default=None, help="只用该掩膜区域评估（如路面），可选：road|fg")
    args = ap.parse_args()

    truth0 = load_any(args.truth)
    H, W = truth0.shape[:2]
    truth = truth0.astype(np.float32)
    tg = cv2.cvtColor(truth0, cv2.COLOR_BGR2GRAY)
    t_fg = fg_mask(truth0)
    t_road = road_mask(truth0)
    t_edge = grad_mag(tg)

    rows = []
    for rp in args.render:
        r = load_any(rp, W, H)
        rg = cv2.cvtColor(r, cv2.COLOR_BGR2GRAY)
        m_fg = fg_mask(r)
        m_road = road_mask(r)
        rec = {
            "render": os.path.basename(rp),
            "fg_iou": round(iou(t_fg, m_fg), 4),
            "road_iou": round(iou(t_road, m_road), 4),
            "edge_corr": round(float(np.corrcoef(grad_mag(rg).ravel(), t_edge.ravel())[0, 1]), 4),
            "ssim": round(ssim_gray(rg, tg), 4),
            "cover_render": round(float(m_fg.mean()), 4),
            "cover_truth": round(float(t_fg.mean()), 4),
        }
        # 只在真值路面区域内比结构（排除大片天空/背景）
        sel = t_road | t_fg
        if np.count_nonzero(sel) > 100:
            a = grad_mag(rg)[sel]; b = t_edge[sel]
            rec["edge_corr_fg"] = round(float(np.corrcoef(a, b)[0, 1]), 4)
        rows.append(rec)

    rows.sort(key=lambda x: -(x["edge_corr_fg"] if "edge_corr_fg" in x else x["edge_corr"]))
    hdr = ("%-36s %8s %8s %10s %10s %8s %8s" %
           ("render", "fg_iou", "road_iou", "edge_corr", "edge_fg", "ssim", "cover"))
    print(hdr)
    for x in rows:
        print("%-36s %8.4f %8.4f %10.4f %10s %8.4f %8.4f" % (
            x["render"], x["fg_iou"], x["road_iou"], x["edge_corr"],
            ("%.4f" % x["edge_corr_fg"]) if "edge_corr_fg" in x else "-", x["ssim"], x["cover_render"]))
    print("（真值前景占比 %.4f；排序按 edge_fg 降序）" % float(t_fg.mean()))
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump({"truth": args.truth, "rows": rows}, fh, ensure_ascii=False, indent=1)
        print("[img-score] ->", args.out)


if __name__ == "__main__":
    main()
