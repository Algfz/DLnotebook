# -*- coding: utf-8 -*-
"""MapAnything (facebook/map-anything, v1.1.4) 单/多视图推理 → 与 refserve 同构的 fr。

要点
----
* 权重在 `C:\\DLnotebook-media\\models\\facebook__map-anything`，代码在 `...\\models\\map-anything-src`
  （PyPI 没有 mapanything 包，代码是 codeload tarball 解出来的）。
* API：`MapAnything.from_pretrained(dir_or_repo).to(dev).eval()`；
  `views = load_images([paths...])`；`preds = model.infer(views, memory_efficient_inference=True,
  use_amp=True, amp_dtype="bf16", apply_mask=True, mask_edges=True, confidence_percentile=N)`。
* 每个 view 的 pred 里有 `pts3d`(世界, OpenCV)、`pts3d_cam`(相机系)、`depth_z`、`intrinsics`、
  `camera_poses`(c2w OpenCV)、`conf`、`mask`、`metric_scaling_factor`。
* 点云直接用 `pts3d_cam`（已在输入分辨率上，无需缩放内参）；fov 由**处理分辨率**下的内参算，
  再按原图长边比例换算到原始分辨率。
"""
import argparse
import json
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MA_SRC = r"C:\DLnotebook-media\models\map-anything-src"
MA_DIR = r"C:\DLnotebook-media\models\facebook__map-anything"


def log(*a):
    print(*a, flush=True)


def load_model(ckpt=MA_DIR, device=None):
    import torch
    if MA_SRC not in sys.path:
        sys.path.insert(0, MA_SRC)
    from mapanything.models import MapAnything
    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    import time
    t0 = time.time()
    model = MapAnything.from_pretrained(ckpt).to(device).eval()
    log("[ma] loaded %s  %.1fs  device=%s  params=%.2fB" % (
        os.path.basename(ckpt), time.time() - t0, device,
        sum(p.numel() for p in model.parameters()) / 1e9))
    return model, device


def _sq(a):
    """去掉 batch 维（B=1）。MapAnything 返回的是 **cuda 上的 torch.Tensor**，必须先搬到 CPU。"""
    try:
        import torch
        if isinstance(a, torch.Tensor):
            a = a.detach().to("cpu").float().numpy()
        elif isinstance(a, (list, tuple)) and a and isinstance(a[0], torch.Tensor):
            a = torch.stack([x.detach().to("cpu").float() for x in a]).numpy()
    except Exception:  # noqa: BLE001
        pass
    a = np.asarray(a, dtype=np.float64)
    while a.ndim > 2 and a.shape[0] == 1:
        a = a[0]
    while a.ndim > 2 and a.shape[-1] == 1:      # depth_z / mask 常是 (H,W,1)
        a = a[..., 0]
    return a


def infer(model, paths, resolution_set=518, conf_pct=10.0, use_amp=True, amp_dtype="bf16",
          memory_efficient=True):
    from mapanything.utils.image import load_images
    views = load_images([str(p) for p in paths], resize_mode="fixed_mapping",
                        resolution_set=resolution_set)
    preds = model.infer(views, memory_efficient_inference=memory_efficient,
                        minibatch_size=None, use_amp=use_amp, amp_dtype=amp_dtype,
                        apply_mask=True, mask_edges=True,
                        apply_confidence_mask=(conf_pct > 0),
                        confidence_percentile=conf_pct,
                        use_multiview_confidence=False)
    outs = []
    for i, pr in enumerate(preds):
        pts_cam = _sq(pr["pts3d_cam"])
        pts_world = _sq(pr["pts3d"]) if pr.get("pts3d") is not None else None
        K = _sq(pr["intrinsics"])
        depth = _sq(pr["depth_z"])
        conf = _sq(pr["conf"]) if pr.get("conf") is not None else None
        mask = _sq(pr["mask"]).astype(bool)
        if mask.ndim == 3:
            mask = mask[..., 0]
        poses = _sq(pr["camera_poses"]) if pr.get("camera_poses") is not None else None
        h_p, w_p = depth.shape[:2]
        if pts_cam.shape[:2] != (h_p, w_p):
            pts_cam = cv2.resize(pts_cam, (w_p, h_p), interpolation=cv2.INTER_LINEAR)
        mask &= np.isfinite(pts_cam).all(-1) & np.isfinite(depth) & (depth > 0)
        if conf is not None and conf.shape[:2] == (h_p, w_p):
            thr = float(np.percentile(conf[np.isfinite(conf)], conf_pct)) if np.isfinite(conf).any() else -1e9
            mask &= (conf >= thr)
        fx, fy = float(K[0, 0]), float(K[1, 1])
        fr = {
            "points": pts_cam, "depth": depth, "normal": None, "mask": mask,
            "H": h_p, "W": w_p, "K_px": K,
            "fx": fx, "fy": fy, "cx": float(K[0, 2]), "cy": float(K[1, 2]),
            "fov_x": 2 * math.degrees(math.atan(0.5 * w_p / fx)),
            "fov_y": 2 * math.degrees(math.atan(0.5 * h_p / fy)),
            "pts_world": pts_world,
            "ext_c2w": poses,
            "metric_scaling_factor": (None if pr.get("metric_scaling_factor") is None
                                      else float(_sq(pr["metric_scaling_factor"]).reshape(-1)[0])),
            "_proc": {"h": h_p, "w": w_p},
        }
        outs.append(fr)
    return outs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--img", action="append", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--tag", default="ma")
    ap.add_argument("--resolution-set", type=int, default=518)
    ap.add_argument("--conf-pct", type=float, default=10.0)
    ap.add_argument("--no-amp", action="store_true")
    ap.add_argument("--ply", action="store_true")
    args = ap.parse_args()

    import refscene as rsc
    model, dev = load_model()
    frs = infer(model, args.img, resolution_set=args.resolution_set, conf_pct=args.conf_pct,
                use_amp=not args.no_amp)
    out = args.out or "."
    os.makedirs(out, exist_ok=True)
    rows = []
    import time
    for path, fr in zip(args.img, frs):
        img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
        H, W = img.shape[:2]
        scale = float(W) / float(fr["W"])
        row = {"file": os.path.basename(path), "H": H, "W": W,
               "proc_hw": [fr["H"], fr["W"]],
               "fov_x_deg": round(fr["fov_x"], 3), "fov_y_deg": round(fr["fov_y"], 3),
               "fov_x_deg_orig": round(math.degrees(2 * math.atan(0.5 * W / (fr["fx"] * scale))), 3),
               "fx_proc": round(fr["fx"], 2), "mask_frac": round(float(fr["mask"].mean()), 4),
               "depth_med": round(float(np.median(fr["depth"][fr["mask"]])) if fr["mask"].any() else -1, 4),
               "metric_scaling_factor": fr["metric_scaling_factor"]}
        if fr["ext_c2w"] is not None:
            row["cam_center"] = [round(float(x), 5) for x in fr["ext_c2w"][:3, 3]]
        rows.append(row)
        if args.ply and fr["points"] is not None:
            h_p, w_p = fr["H"], fr["W"]
            rgb = cv2.cvtColor(cv2.resize(img, (w_p, h_p), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)
            m = fr["mask"].reshape(-1)
            P = fr["points"].reshape(-1, 3)[m]
            C = rgb.reshape(-1, 3)[m]
            p = os.path.join(out, "%s-%s.ply" % (args.tag, os.path.splitext(os.path.basename(path))[0]))
            rsc.write_ply(p, P.astype(np.float32), C.astype(np.uint8))
            row["ply"] = p
        log("[ma] %s fov=%.2f/%.2f (orig-x %.2f) mask=%.3f depth_med=%.3f mscale=%s" % (
            row["file"], row["fov_x_deg"], row["fov_y_deg"], row["fov_x_deg_orig"],
            row["mask_frac"], row["depth_med"], row["metric_scaling_factor"]))
    jp = os.path.join(out, "%s-poses.json" % args.tag)
    with open(jp, "w", encoding="utf-8") as fh:
        json.dump({"tag": args.tag, "ckpt": MA_DIR, "resolution_set": args.resolution_set,
                   "conf_pct": args.conf_pct, "n": len(rows), "views": rows}, fh, ensure_ascii=False, indent=1)
    log("[ma] poses ->", jp)


if __name__ == "__main__":
    main()
