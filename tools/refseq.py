#!/usr/bin/env python
"""多帧重建 (VGGT-1B): 一个窗口的连续帧 -> 相机内外参 + 世界点云.

  python tools/refseq.py --dir "C:\\DLnotebook-media\\tmp\\seq\\desert-a" \
      --tag desert-a --step 3 --chunk 24 --overlap 6

产出 (默认 out/tmp/ref-scene/):
  <tag>-poses.json   每帧: 外参 R|t (world->cam, OpenCV), 相机中心, fx/fy, fov
  <tag>-cloud.ply    世界点云 (带颜色, 按置信度过滤)
  <tag>-top.png      点云顶视投影 (按高度着色)
  <tag>-run.json     运行参数与耗时/显存
"""
import argparse
import glob
import json
import math
import os
import sys
import time

import numpy as np
import torch
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import refscene as rs  # noqa: E402

VGGT_REPO = r"C:\DLnotebook-media\tools\vggt"
DEFAULT_CKPT = r"C:\DLnotebook-media\models\facebook__VGGT-1B\model.pt"
if VGGT_REPO not in sys.path:
    sys.path.insert(0, VGGT_REPO)


def load_model(ckpt=DEFAULT_CKPT, device=None):
    from vggt.models.vggt import VGGT

    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    t0 = time.time()
    model = VGGT()
    sd = torch.load(ckpt, map_location="cpu")
    if isinstance(sd, dict) and "model" in sd and isinstance(sd["model"], dict):
        sd = sd["model"]
    missing, unexpected = model.load_state_dict(sd, strict=False)
    rs.log("[refseq] model loaded %.1fs  missing=%d unexpected=%d  (ckpt=%s)"
           % (time.time() - t0, len(missing), len(unexpected), os.path.basename(ckpt)))
    model.eval().to(device)
    return model, device


def preprocess(paths, mode="crop"):
    from vggt.utils.load_fn import load_and_preprocess_images

    return load_and_preprocess_images(paths, mode=mode)


def run_chunk(model, device, paths, dtype):
    from vggt.utils.pose_enc import pose_encoding_to_extri_intri

    images = preprocess(paths).to(device)
    with torch.no_grad(), torch.cuda.amp.autocast(dtype=dtype):
        preds = model(images)
    extri, intri = pose_encoding_to_extri_intri(preds["pose_enc"], images.shape[-2:])
    out = {
        "images": images,
        "extri": extri[0].float().cpu().numpy(),          # (S,3,4) world->cam
        "intri": intri[0].float().cpu().numpy(),          # (S,3,3) pixels (518x291)
        "world_points": preds["world_points"][0].float().cpu().numpy(),   # (S,H,W,3)
        "world_conf": preds["world_points_conf"][0].float().cpu().numpy(),
        "depth": preds["depth"][0].float().cpu().numpy(),
        "depth_conf": preds["depth_conf"][0].float().cpu().numpy(),
        "HW": tuple(images.shape[-2:]),
    }
    del images, preds
    torch.cuda.empty_cache()
    return out


def cam_centers(extri):
    """world->cam (R|t) -> 相机中心 (S,3)."""
    R = extri[:, :3, :3]
    t = extri[:, :3, 3]
    return -np.einsum("sij,sj->si", np.transpose(R, (0, 2, 1)), t)


def umeyama(src, dst):
    """相似变换 src->dst (最小二乘): 返回 (s, R, t)."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    S, D = src - mu_s, dst - mu_d
    cov = D.T @ S / len(src)
    U, d, Vt = np.linalg.svd(cov)
    S_ = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S_[2, 2] = -1
    R = U @ S_ @ Vt
    var_s = (S ** 2).sum() / len(src)
    s = float(np.trace(np.diag(d) @ S_) / max(var_s, 1e-12))
    t = mu_d - s * (R @ mu_s)
    return s, R, t


def apply_sim(pts, sim):
    s, R, t = sim
    return s * (pts @ R.T) + t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="帧目录 (f*.jpg)")
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", default=os.path.join("out", "tmp", "ref-scene"))
    ap.add_argument("--ckpt", default=DEFAULT_CKPT)
    ap.add_argument("--step", type=int, default=3, help="每隔几帧取一帧")
    ap.add_argument("--limit", type=int, default=0, help="最多用多少帧 (0=不限)")
    ap.add_argument("--chunk", type=int, default=24, help="每批帧数")
    ap.add_argument("--overlap", type=int, default=6, help="批间重叠帧数 (用于对齐)")
    ap.add_argument("--conf-pct", type=float, default=55.0, help="点云置信度分位阈值")
    ap.add_argument("--point-step", type=int, default=3, help="点云像素抽样步长")
    ap.add_argument("--max-points", type=int, default=2500000)
    ap.add_argument("--no-viz", action="store_true")
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(args.dir, "*.jpg")) + glob.glob(os.path.join(args.dir, "*.png")))
    files = files[::args.step]
    if args.limit:
        files = files[:args.limit]
    if not files:
        raise SystemExit("no frames in %s" % args.dir)
    rs.log("[refseq] %d frames  chunk=%d overlap=%d" % (len(files), args.chunk, args.overlap))

    model, device = load_model(args.ckpt)
    dtype = torch.bfloat16 if torch.cuda.get_device_capability()[0] >= 8 else torch.float16
    t_all = time.time()

    poses, pts_all, col_all = [], [], []
    sims = []
    i = 0
    while i < len(files):
        j = min(i + args.chunk, len(files))
        idx = list(range(i, j))
        paths = [files[k] for k in idx]
        t0 = time.time()
        ch = run_chunk(model, device, paths, dtype)
        cen = cam_centers(ch["extri"])
        mem = torch.cuda.max_memory_allocated() / (1024 ** 3)
        rs.log("[refseq] chunk %d-%d  %d frames  %.1fs  peakVRAM=%.2fGB  fov_x=%.1fdeg"
               % (i, j - 1, len(paths), time.time() - t0, mem,
                  math.degrees(2 * math.atan(0.5 * ch["HW"][1] / ch["intri"][0, 0, 0]))))
        sim = (1.0, np.eye(3), np.zeros(3))
        if poses:                              # 用重叠帧的相机中心求相似变换
            ov = min(args.overlap, len(poses), len(idx))
            if ov >= 4:
                dst = np.array([poses[len(poses) - ov + k]["cam_center"] for k in range(ov)])
                src = cen[:ov]
                sim = umeyama(src, dst)
                rs.log("[refseq]   align: scale=%.3f  resid=%.4f m"
                       % (sim[0], float(np.sqrt(((apply_sim(src, sim) - dst) ** 2).sum(1).mean()))))
            else:
                rs.log("[refseq]   align: 重叠不足 (%d) -> 不保证接上" % ov)
        sims.append({"chunk": [i, j - 1], "scale": sim[0], "R": sim[1].tolist(), "t": sim[2].tolist()})

        H, W = ch["HW"]
        conf = ch["world_conf"]
        thr = np.percentile(conf[conf > 0], args.conf_pct) if (conf > 0).any() else 0.0
        for k, gi in enumerate(idx):
            e = ch["extri"][k]
            poses.append({
                "frame": os.path.basename(files[gi]), "index": gi,
                "R": e[:, :3].tolist(), "t": e[:, 3].tolist(),
                "cam_center": (sim[0] * (sim[1] @ cen[k]) + sim[2]).tolist(),
                "fx": float(ch["intri"][k, 0, 0]), "fy": float(ch["intri"][k, 1, 1]),
                "fov_x_deg": math.degrees(2 * math.atan(0.5 * W / ch["intri"][k, 0, 0])),
                "chunk": len(sims) - 1,
            })
            wp = ch["world_points"][k][::args.point_step, ::args.point_step].reshape(-1, 3)
            wc = conf[k][::args.point_step, ::args.point_step].reshape(-1)
            keep = wc > thr
            wp = apply_sim(wp[keep], sim) if keep.any() else np.zeros((0, 3))
            img = Image.open(files[gi]).convert("RGB")
            img = img.resize((W, H), Image.BICUBIC)
            rgb = np.asarray(img)[::args.point_step, ::args.point_step].reshape(-1, 3)[keep]
            if len(wp):
                pts_all.append(wp.astype(np.float32))
                col_all.append(rgb.astype(np.uint8))
        del ch
        i = j if j >= len(files) else j - args.overlap

    P = np.concatenate(pts_all) if pts_all else np.zeros((0, 3), np.float32)
    C = np.concatenate(col_all) if col_all else np.zeros((0, 3), np.uint8)
    if len(P) > args.max_points:
        sel = np.random.RandomState(0).choice(len(P), args.max_points, replace=False)
        P, C = P[sel], C[sel]
    sims_all = np.array([p["cam_center"] for p in poses])
    rs.log("[refseq] cloud %d pts; camera path length %.2f (world units)"
           % (len(P), float(np.linalg.norm(np.diff(sims_all, axis=0), axis=1).sum())))

    with open(os.path.join(out, "%s-poses.json" % args.tag), "w", encoding="utf-8") as f:
        json.dump({"frames": poses, "chunks": sims}, f, ensure_ascii=False, indent=2)
    rs.write_ply(os.path.join(out, "%s-cloud.ply" % args.tag), P, C)
    if not args.no_viz and len(P):
        h = P[:, 1]
        rs.splat(os.path.join(out, "%s-top.png" % args.tag), P[:, 0], P[:, 2], -h)
    with open(os.path.join(out, "%s-run.json" % args.tag), "w", encoding="utf-8") as f:
        json.dump({"dir": args.dir, "frames": len(poses), "points": int(len(P)),
                   "peak_vram_gb": round(torch.cuda.max_memory_allocated() / (1024 ** 3), 2),
                   "seconds": round(time.time() - t_all, 1),
                   "args": {k: v for k, v in vars(args).items()}}, f, ensure_ascii=False, indent=2)
    rs.log("[refseq] done %.1fs -> %s" % (time.time() - t_all, out))


if __name__ == "__main__":
    main()
