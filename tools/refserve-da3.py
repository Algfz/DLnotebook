"""refserve-da3.py - Depth Anything 3 (DA3, nested giant) single-view / multi-view reconstruction.

Goal: emit the SAME `fr` dict contract as refserve.infer_frame() and the SAME npz cache as
reffuse.frame_cache(), so the entire reverse-engineering pipeline (props / motion / fusion /
closed-loop re-render) works unchanged for DA3 and stays directly comparable with MoGe-2.

Differences vs MoGe that this file absorbs:
  * DA3 returns depth at the PROCESSED resolution (process_res, default 504 long side).
    We resample depth back to (H, W) and rescale the intrinsics to original pixels, which is
    the contract the rest of the pipeline expects (MoGe returns original-size maps).
  * DA3 has `conf` and `sky`; mask = ~sky & conf >= percentile & finite.
  * DA3 has no normals -> we differentiate the camera-space points to get normals
    (refmotion.ground_frame needs fr["normal"]).
  * With >1 image DA3 solves its own poses: extrinsics are WORLD-TO-CAM (glb.py:136 "w2c"),
    intrinsics are pixels of the processed image. That gives world points + a trajectory
    that can be compared with VGGT-1B directly.

Usage:
  $env:PYTHONPATH="C:\\D\\DLnotebook\\tools"
  python tools\\refserve-da3.py --dir C:\\DLnotebook-media\\tmp\\seq\\desert-full ^
      --tag da3-desert --cache C:\\DLnotebook-media\\tmp\\fuse\\cache-da3 ^
      --frames 0,60,120 --px-step 2 --process-res 504 --dtype bf16
  # multi-view (one shot of N frames -> poses + world cloud)
  python tools\\refserve-da3.py ... --frames 0-23 --multi --out C:\\DLnotebook-media\\tmp\\da3
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refscene as rs          # noqa: E402
import refmotion as rm         # noqa: E402
import reffuse as rf           # noqa: E402

DA3_DIR = r"C:\DLnotebook-media\models\depth-anything__DA3NESTED-GIANT-LARGE"


def log(*a):
    print(*a, flush=True)


def load_bgr(path):
    b = np.fromfile(path, dtype=np.uint8)
    return cv2.imdecode(b, cv2.IMREAD_COLOR)


def load_model(ckpt=DA3_DIR, device=None, dtype="bf16"):
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    from depth_anything_3.api import DepthAnything3

    if device is None:
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    t0 = time.time()
    model = DepthAnything3.from_pretrained(ckpt)
    model = model.to(device).eval()
    if dtype in ("bf16", "bfloat16"):
        model = model.to(torch.bfloat16)
    elif dtype in ("fp16", "float16", "half"):
        model = model.to(torch.float16)
    n = sum(p.numel() for p in model.parameters())
    log("[da3] loaded %s  %.1fs  params %.2fB  dtype=%s  device=%s"
        % (os.path.basename(ckpt), time.time() - t0, n / 1e9, dtype, device))
    return model, device


# ------------------------------------------------------------------ 几何
def normals_from_points(P, mask):
    """相机系点云 (H,W,3) -> 法线 (H,W,3)（有限差分叉积，朝向相机）。"""
    H, W = P.shape[:2]
    n = np.zeros_like(P, dtype=np.float32)
    Pz = np.where(np.isfinite(P), P, np.nan)
    du = np.zeros_like(Pz); dv = np.zeros_like(Pz)
    du[:, 1:-1] = Pz[:, 2:] - Pz[:, :-2]
    dv[1:-1, :] = Pz[2:, :] - Pz[:-2, :]
    nn = np.cross(du, dv)
    ln = np.linalg.norm(nn, axis=-1, keepdims=True)
    ok = np.isfinite(nn).all(-1) & (ln[..., 0] > 1e-12) & mask
    n[ok] = (nn[ok] / ln[ok]).astype(np.float32)
    # 朝向相机（相机在原点，视线方向 = -P）
    dot = (n * (-P)).sum(-1)
    flip = ok & (dot < 0)
    n[flip] = -n[flip]
    return n


def depth_to_points(depth, K):
    """depth (h,w), K (3,3) 像素单位 -> 相机系点 (h,w,3)（OpenCV: x右 y下 z前）。"""
    h, w = depth.shape[:2]
    fx, fy, cx, cy = float(K[0, 0]), float(K[1, 1]), float(K[0, 2]), float(K[1, 2])
    u = np.arange(w, dtype=np.float32)[None, :].repeat(h, 0)
    v = np.arange(h, dtype=np.float32)[:, None].repeat(w, 1)
    x = (u - cx) / max(fx, 1e-9) * depth
    y = (v - cy) / max(fy, 1e-9) * depth
    return np.stack([x, y, depth], -1).astype(np.float32)


def scale_K(K, w_p, h_p, W, H):
    """把处理分辨率下的内参换算到原始分辨率。"""
    K = np.asarray(K, dtype=np.float64).copy()
    K[0, :] *= (W / float(w_p))
    K[1, :] *= (H / float(h_p))
    return K


# ------------------------------------------------------------------ 推理
def infer(model, imgs_bgr, process_res=504, conf_pct=20.0, use_autocast=True):
    """imgs_bgr: list of BGR uint8 (H,W,3) -> list of fr dict (+ w2c extrinsics)."""
    rgbs = [cv2.cvtColor(im, cv2.COLOR_BGR2RGB) for im in imgs_bgr]
    dtype = next(model.parameters()).dtype
    ctx = torch.autocast("cuda", dtype=dtype, enabled=(use_autocast and dtype != torch.float32))
    with torch.no_grad(), ctx:
        pred = model.inference(rgbs, process_res=process_res, infer_gs=False)
    outs = []
    for i, im in enumerate(imgs_bgr):
        H, W = im.shape[:2]
        depth_p = np.asarray(pred.depth[i], dtype=np.float32)
        h_p, w_p = depth_p.shape[:2]
        Kp = np.asarray(pred.intrinsics[i], dtype=np.float64) if pred.intrinsics is not None else None
        if Kp is None:
            raise RuntimeError("DA3 returned no intrinsics")
        if Kp[0, 0] < 5.0:                       # 归一化内参的保险：换算到处理像素
            Kp = Kp.copy(); Kp[0] *= w_p; Kp[1] *= h_p
        K = scale_K(Kp, w_p, h_p, W, H)
        depth = cv2.resize(depth_p, (W, H), interpolation=cv2.INTER_LINEAR)
        pts = depth_to_points(depth, K)
        conf = None
        if getattr(pred, "conf", None) is not None:
            conf = cv2.resize(np.asarray(pred.conf[i], dtype=np.float32), (W, H), interpolation=cv2.INTER_LINEAR)
        sky = None
        if getattr(pred, "sky", None) is not None:
            sky = cv2.resize(np.asarray(pred.sky[i]).astype(np.uint8), (W, H), interpolation=cv2.INTER_NEAREST).astype(bool)
        mask = np.isfinite(pts).all(-1) & np.isfinite(depth) & (depth > 0)
        if conf is not None:
            thr = float(np.percentile(conf[np.isfinite(conf)], conf_pct)) if np.isfinite(conf).any() else -1e9
            mask &= (conf >= thr)
        if sky is not None:
            mask &= ~sky
        normal = normals_from_points(pts, mask)
        ext = np.asarray(pred.extrinsics[i], dtype=np.float64) if pred.extrinsics is not None else None
        fx, fy = float(K[0, 0]), float(K[1, 1])
        fr = {
            "points": pts, "depth": depth, "normal": normal, "mask": mask,
            "H": H, "W": W, "K_px": K, "K_proc": Kp, "K_raw": np.asarray(pred.intrinsics[i], dtype=np.float64),
            "fx": fx, "fy": fy, "cx": float(K[0, 2]), "cy": float(K[1, 2]),
            "ext_w2c": ext, "is_metric": int(getattr(pred, "is_metric", 0) or 0),
            "scale_factor": (None if getattr(pred, "scale_factor", None) is None else float(pred.scale_factor)),
            "fov_x": 2 * math.degrees(math.atan(0.5 * W / fx)) if fx else None,
            "fov_y": 2 * math.degrees(math.atan(0.5 * H / fy)) if fy else None,
            "_img": im, "fname": "",
        }
        outs.append(fr)
    return outs


def world_points(fr):
    """w2c -> 世界系点云 (H,W,3)（相机系点做 c2w 变换）。"""
    P = fr["points"].reshape(-1, 3).astype(np.float64)
    E = np.eye(4); E[:3, :] = fr["ext_w2c"][:3, :]
    c2w = np.linalg.inv(E)
    Wp = (c2w[:3, :3] @ P.T).T + c2w[:3, 3]
    return Wp.reshape(fr["points"].shape).astype(np.float32), c2w


# ------------------------------------------------------------------ CLI
def parse_frames(spec, n):
    spec = (spec or "0").strip().lower()
    out = []
    if spec in ("all", "*"):
        return list(range(n))
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part[1:]:
            a, b = part.split("-", 1)
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return [i for i in out if 0 <= i < n]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--frames", default="0")
    ap.add_argument("--cache", default=None, help="写 reffuse 兼容 npz 的目录")
    ap.add_argument("--out", default=None, help="poses.json / ply 输出目录")
    ap.add_argument("--px-step", type=int, default=2)
    ap.add_argument("--process-res", type=int, default=504)
    ap.add_argument("--dtype", default="bf16", choices=["bf16", "fp16", "fp32"])
    ap.add_argument("--no-autocast", action="store_true", help="关掉 autocast（bf16 权重时 LayerNorm 会被 autocast 拉回 fp32 而报 dtype 不匹配）")
    ap.add_argument("--ckpt", default=DA3_DIR)
    ap.add_argument("--multi", action="store_true", help="一次喂所有帧（DA3 自己解位姿）")
    ap.add_argument("--chunk", type=int, default=1, help="每批帧数（>1 即多视图）")
    ap.add_argument("--conf-pct", type=float, default=20.0)
    ap.add_argument("--ply", action="store_true", help="多视图时导出世界点云 ply")
    args = ap.parse_args()
    from types import SimpleNamespace

    files = sorted(f for f in os.listdir(args.dir) if f.lower().endswith((".jpg", ".png")))
    idx = parse_frames(args.frames, len(files))
    if not idx:
        raise SystemExit("no frames selected")
    # 注意优先级：args.out or (dirname if cache else ".") 必须显式加括号，否则 --out 会被丢弃
    out = args.out or (os.path.dirname(args.cache) if args.cache else ".")
    os.makedirs(out, exist_ok=True)
    cache = args.cache
    if cache:
        os.makedirs(cache, exist_ok=True)

    model, device = load_model(args.ckpt, None, args.dtype)
    ba = SimpleNamespace(px_step=args.px_step)

    batch = args.chunk if args.multi else 1
    batch = max(batch, 1)
    poses, n_written, n_world = [], 0, 0
    for s in range(0, len(idx), batch):
        sel = idx[s:s + batch]
        imgs = [load_bgr(os.path.join(args.dir, files[i])) for i in sel]
        t0 = time.time()
        frs = infer(model, imgs, process_res=args.process_res, conf_pct=args.conf_pct,
                    use_autocast=not args.no_autocast)
        dt = time.time() - t0
        log("[da3] batch %d frames  %.1fs  (%.2fs/帧)  process_res=%d"
            % (len(sel), dt, dt / len(sel), args.process_res))
        for k, fr in enumerate(frs):
            i = sel[k]
            name = files[i]
            fr["fname"] = os.path.basename(name)
            rec = {"file": name, "fov_x": fr["fov_x"], "fov_y": fr["fov_y"],
                   "fx": fr["fx"], "fy": fr["fy"], "cx": fr["cx"], "cy": fr["cy"],
                   "is_metric": fr["is_metric"], "scale_factor": fr["scale_factor"],
                   "mask_frac": round(float(fr["mask"].mean()), 4),
                   "depth_med": round(float(np.median(fr["depth"][fr["mask"]])) if fr["mask"].any() else -1, 4)}
            if fr["ext_w2c"] is not None:
                E = np.eye(4); E[:3, :] = fr["ext_w2c"][:3, :]
                c2w = np.linalg.inv(E)
                rec["cam_c2w"] = c2w.tolist()
                rec["cam_center"] = c2w[:3, 3].tolist()
            gf = rm.ground_frame(fr)
            if gf is not None:
                rec["ground"] = {"n": gf["n"].tolist(), "d": float(gf["d"]),
                                 "W_m": float(gf["W_m"]), "road_px": gf["road_px"], "agree": gf["agree"]}
            poses.append(rec)
            if cache:
                cf = os.path.join(cache, "%s-%s.npz" % (args.tag, name.rsplit(".", 1)[0]))
                if rf.frame_cache(ba, fr, imgs[k], os.path.join(args.dir, name), cf) is not None:
                    n_written += 1
            if args.ply and fr["ext_w2c"] is not None:
                Wp, _ = world_points(fr)
                m = fr["mask"].reshape(-1)
                xyz = Wp.reshape(-1, 3)[m]
                rgb = cv2.cvtColor(imgs[k], cv2.COLOR_BGR2RGB).reshape(-1, 3)[m]
                p = os.path.join(out, "%s-%s.ply" % (args.tag, name.rsplit(".", 1)[0]))
                rs.write_ply(p, xyz.astype(np.float32), rgb.astype(np.uint8))
                n_world += 1
    jf = os.path.join(out, "%s-poses.json" % args.tag)
    with open(jf, "w", encoding="utf-8") as fh:
        json.dump({"tag": args.tag, "dir": args.dir, "ckpt": args.ckpt, "dtype": args.dtype,
                   "process_res": args.process_res, "px_step": args.px_step,
                   "frames": [files[i] for i in idx], "n": len(poses), "poses": poses}, fh, indent=1)
    log("[da3] wrote %d npz -> %s" % (n_written, cache))
    log("[da3] wrote %d ply" % n_world)
    log("[da3] poses -> %s" % jf)


if __name__ == "__main__":
    main()
