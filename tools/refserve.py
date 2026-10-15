#!/usr/bin/env python
"""常驻批量 MoGe-2 服务: 模型只加载一次, 批量处理帧.

两种用法:
  1) 批量筛选指标 (每帧一行 JSON, 可选小图):
     python tools/refserve.py --jobs out/tmp/screen/jobs.jsonl \
         --metrics out/tmp/screen/metrics.jsonl --tiles out/tmp/screen/tiles
  2) 批量完整重建 (复用 refscene 的几何/可视化):
     python tools/refserve.py --jobs out/tmp/screen/jobs.jsonl --full --out out/tmp/ref-scene

`--jobs` 每行: {"image": "...jpg", "tag": "level-g0150"}
"""
import argparse
import json
import math
import os
import sys
import time

import numpy as np
import cv2
import torch

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import refscene as rs  # noqa: E402

MOGE_REPO = rs.MOGE_REPO
DEFAULT_CKPT = rs.DEFAULT_CKPT


# ------------------------------------------------------------------ 模型
def load_model(ckpt=DEFAULT_CKPT, device=None):
    sys.path.insert(0, MOGE_REPO)
    from moge.model.v2 import MoGeModel

    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    t0 = time.time()
    model = MoGeModel.from_pretrained(ckpt).to(device).eval()
    rs.log("[refserve] model loaded in %.2fs (device=%s)" % (time.time() - t0, device))
    return model, device


def infer_frame(model, device, img, num_tokens=2200):
    """img: BGR uint8 (H,W,3) -> dict(points/depth/K/normal/mask, H, W, K_px, fov)"""
    H, W = img.shape[:2]
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    ten = torch.tensor(rgb / 255.0, dtype=torch.float32, device=device).permute(2, 0, 1)
    with torch.no_grad():
        res = model.infer(ten, num_tokens=num_tokens, use_fp16=True)
    pts = res["points"].float().cpu().numpy()
    depth = res["depth"].float().cpu().numpy()
    K = res["intrinsics"].float().cpu().numpy()
    normal = res["normal"].float().cpu().numpy() if res.get("normal") is not None else None
    if res.get("mask") is not None:
        mask = res["mask"].cpu().numpy().astype(bool)
    else:
        mask = np.ones((H, W), bool)
    mask = mask & np.isfinite(pts).all(-1) & np.isfinite(depth)
    if normal is not None:
        mask = mask & np.isfinite(normal).all(-1)
    fx, fy = float(K[0, 0]) * W, float(K[1, 1]) * H
    K_px = np.array([[fx, 0.0, float(K[0, 2] * W)], [0.0, fy, float(K[1, 2] * H)], [0.0, 0.0, 1.0]])
    return {
        "points": pts, "depth": depth, "normal": normal, "mask": mask,
        "H": H, "W": W, "K_px": K_px, "fx": fx, "fy": fy,
        "fov_x": 2 * math.degrees(math.atan(0.5 * W / fx)) if fx else None,
        "fov_y": 2 * math.degrees(math.atan(0.5 * H / fy)) if fy else None,
    }


# ------------------------------------------------------------------ 筛选指标
def plane_components(normal, mask, area_min=600, n_el=18, n_az=36,
                     max_bins=14, keep_per_bin=3):
    """法线分箱 + 连通域 -> 平面片 mask 列表 (按面积降序)."""
    norm = np.maximum(np.linalg.norm(normal, axis=-1, keepdims=True), 1e-9)
    n = normal / norm
    el = np.arcsin(np.clip(n[..., 1], -1, 1))
    az = np.arctan2(n[..., 0], n[..., 2])
    ie = np.clip(((el + math.pi / 2) / math.pi * n_el).astype(np.int32), 0, n_el - 1)
    ia = np.clip(((az + math.pi) / (2 * math.pi) * n_az).astype(np.int32), 0, n_az - 1)
    bid = np.where(mask, ie * n_az + ia, -1)
    counts = np.bincount(bid[mask].ravel(), minlength=n_el * n_az)
    order = np.argsort(counts)[::-1][:max_bins]
    out = []
    for b in order:
        if counts[b] < area_min:
            continue
        m = ((bid == b) & mask).astype(np.uint8)
        nlab, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        if nlab <= 1:
            continue
        areas = stats[1:, cv2.CC_STAT_AREA]
        for i in np.argsort(areas)[::-1][:keep_per_bin]:
            if areas[i] < area_min:
                continue
            out.append(lab == (i + 1))
    out.sort(key=lambda c: -int(c.sum()))
    return out


def frame_metrics(fr, img, area_frac_min=0.004, min_comp=400):
    """单帧几何/配色指标: 平面覆盖、轴对齐度、方位集中度、边缘与颜色复杂度."""
    H, W = fr["H"], fr["W"]
    mask, normal, depth = fr["mask"], fr["normal"], fr["depth"]
    n_px = int(mask.sum())
    out = {"H": H, "W": W, "mask_frac": round(n_px / float(H * W), 4),
           "fov_x": None if fr["fov_x"] is None else round(fr["fov_x"], 2),
           "depth_med": None if n_px == 0 else round(float(np.median(depth[mask])), 3),
           "plane_cov": 0.0, "n_planes": 0, "axis_score": 0.0, "az_conc": 0.0,
           "plane_area_frac_max": 0.0, "up": None, "planes": []}
    if n_px < 100 or normal is None:
        return out

    area_min = max(min_comp, int(area_frac_min * H * W))
    comps = plane_components(normal, mask, area_min=area_min)
    if not comps:
        return out

    areas = np.array([float(c.sum()) for c in comps])
    norms = np.array([normal[c].mean(0) for c in comps], dtype=np.float64)
    norms /= np.maximum(np.linalg.norm(norms, axis=1, keepdims=True), 1e-9)
    dpth = [float(np.median(depth[c])) for c in comps]
    out["plane_cov"] = round(float(areas.sum() / n_px), 4)
    out["n_planes"] = int(len(comps))
    out["plane_area_frac_max"] = round(float(areas.max() / n_px), 4)

    big = np.argsort(areas)[::-1]
    up = norms[big[0]].copy()
    if up[1] > 0:                      # 相机系 y 朝下 -> 让 up 的 y 分量 <= 0
        up = -up
    ref = np.array([1.0, 0.0, 0.0]) if abs(up[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
    a1 = np.cross(up, ref)
    a1 /= max(np.linalg.norm(a1), 1e-9)
    a2 = np.cross(up, a1)
    horiz = [i for i in big if abs(float(norms[i] @ up)) < 0.45]
    az_conc, A1, A2 = 0.0, a1, a2
    if len(horiz) >= 2:
        v = norms[horiz] - np.outer(norms[horiz] @ up, up)
        ang = np.arctan2(v @ a2, v @ a1)
        w = areas[horiz]
        hist, edges = np.histogram(ang, bins=36, range=(-math.pi, math.pi), weights=w)
        k = int(np.argmax(hist))
        th0 = 0.5 * (edges[k] + edges[k + 1])
        A1 = math.cos(th0) * a1 + math.sin(th0) * a2
        A2 = np.cross(up, A1)
        # ±10° 内的水平片面积占比 = 方位集中度 (到 peak / peak±90° 的最近角)
        d = np.minimum(np.abs(np.angle(np.exp(1j * (ang - th0)))),
                       np.minimum(np.abs(np.angle(np.exp(1j * (ang - th0 - math.pi / 2)))),
                                  np.abs(np.angle(np.exp(1j * (ang - th0 + math.pi / 2))))))
        near = (d < math.radians(10))
        az_conc = float(w[near].sum() / max(w.sum(), 1e-9))
    axes = np.stack([up, A1 / max(np.linalg.norm(A1), 1e-9), A2 / max(np.linalg.norm(A2), 1e-9)])
    align = np.abs(norms @ axes.T).max(1)
    out["up"] = [round(float(v), 3) for v in up]
    out["axis_score"] = round(float((areas * align).sum() / areas.sum()), 4)
    out["az_conc"] = round(az_conc, 4)
    out["planes"] = [
        {"area_frac": round(float(areas[i] / n_px), 4),
         "depth": round(dpth[i], 3),
         "normal": [round(float(v), 3) for v in norms[i]]}
        for i in big[:6]
    ]

    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    out["edge_dens"] = round(float((cv2.Canny(g, 60, 160) > 0).mean()), 4)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hh = cv2.calcHist([hsv], [0], None, [36], [0, 180]).ravel().astype(np.float64)
    hh /= max(hh.sum(), 1e-9)
    nz = hh[hh > 0]
    out["color_ent"] = round(float(-(nz * np.log(nz)).sum() / math.log(36)), 4)
    out["score"] = round(out["plane_cov"] * out["axis_score"] * (0.6 + 0.4 * out["az_conc"]), 4)
    return out


def write_tiles(tiles_dir, tag, fr, img, width=320):
    os.makedirs(tiles_dir, exist_ok=True)
    h, w = img.shape[:2]
    s = width / float(w)
    small = cv2.resize(img, (width, int(round(h * s))), interpolation=cv2.INTER_AREA)
    dep = rs.colormap(fr["depth"], fr["mask"])
    nor = rs.normals_to_rgb(fr["normal"], fr["mask"]) if fr["normal"] is not None else np.zeros_like(img)
    for suffix, im in (("img", small), ("depth", cv2.resize(dep, (width, int(round(h * s))))),
                       ("normal", cv2.resize(nor, (width, int(round(h * s)))))):
        rs.imwrite_u(os.path.join(tiles_dir, "%s_%s.jpg" % (tag, suffix)), im)


# ------------------------------------------------------------------ CLI
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", required=True, help="JSONL, 每行 {image, tag}")
    ap.add_argument("--metrics", default=None, help="指标输出 JSONL")
    ap.add_argument("--tiles", default=None, help="小图输出目录")
    ap.add_argument("--full", action="store_true", help="写完整重建 (refscene 产物)")
    ap.add_argument("--out", default=os.path.join("out", "tmp", "ref-scene"))
    ap.add_argument("--ckpt", default=DEFAULT_CKPT)
    ap.add_argument("--max-side", type=int, default=1024)
    ap.add_argument("--num-tokens", type=int, default=2200)
    args = ap.parse_args()

    jobs = []
    with open(args.jobs, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                jobs.append(json.loads(line))
    rs.log("[refserve] %d jobs" % len(jobs))

    model, device = load_model(args.ckpt)
    fh = open(args.metrics, "a", encoding="utf-8") if args.metrics else None
    t_all = time.time()
    for k, job in enumerate(jobs):
        t0 = time.time()
        img = rs.load_image(job["image"], args.max_side, None)
        fr = infer_frame(model, device, img, args.num_tokens)
        rec = {"tag": job.get("tag") or os.path.splitext(os.path.basename(job["image"]))[0],
               "image": job["image"], "infer_s": round(time.time() - t0, 3)}
        if args.metrics:
            m = frame_metrics(fr, img)
            rec.update(m)
            if fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                fh.flush()
        if args.tiles:
            write_tiles(args.tiles, rec["tag"], fr, img)
        if args.full:
            rs.full_dump(fr, img, rec["tag"], args.out)
        if (k + 1) % 10 == 0 or k == len(jobs) - 1:
            rs.log("[refserve] %d/%d  elapsed %.1fs  this %.2fs  score=%s"
                   % (k + 1, len(jobs), time.time() - t_all, time.time() - t0,
                      rec.get("score")))
    if fh:
        fh.close()
    rs.log("[refserve] done in %.1fs" % (time.time() - t_all))


if __name__ == "__main__":
    main()
