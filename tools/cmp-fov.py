# -*- coding: utf-8 -*-
"""标定实验：在**已知 fov** 的图上测 MoGe / DA3 的 fov 估计误差。

我们的引擎是 `new THREE.PerspectiveCamera(55, 1, 2, 800)`（three.js 的 fov 是**垂直** fov），
16:9 画布（1280x720）时：
    fov_y = 55.0°
    fov_x = 2*atan(tan(27.5°) * 16/9) = 85.58°
所以「我们关卡自己渲出来的帧」= fov 已知的真值样本，用它就能判断
(a) 官方视频的 fov 是否也等于 85.58°，(b) 各模型在此类画风上的 fov 估计偏差。

用法：
    python tools/cmp-fov.py --img A.jpg --img B.jpg [--no-da3] [--process-res 504]
"""
import argparse
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def fov_from_K(fx, fy, W, H):
    return (2 * math.degrees(math.atan(0.5 * W / fx)),
            2 * math.degrees(math.atan(0.5 * H / fy)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--img", action="append", required=True, help="可重复，支持中文路径")
    ap.add_argument("--truth-fov-x", type=float, default=85.58)
    ap.add_argument("--truth-fov-y", type=float, default=55.0)
    ap.add_argument("--process-res", type=int, default=504)
    ap.add_argument("--num-tokens", type=int, default=2200)
    ap.add_argument("--no-da3", action="store_true")
    ap.add_argument("--no-moge", action="store_true")
    ap.add_argument("--da3-ckpt", default=None, help="默认用 refserve-da3.DA3_DIR")
    ap.add_argument("--da3-dtype", default="fp32")
    args = ap.parse_args()

    import refserve as rs
    import reffuse as rf

    moge = None
    mdev = None
    if not args.no_moge:
        print("[cmp-fov] loading MoGe ...", flush=True)
        moge, mdev = rs.load_model(rs.DEFAULT_CKPT, None)

    da3 = None
    if not args.no_da3:
        print("[cmp-fov] loading DA3 ...", flush=True)
        import importlib.util
        _p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "refserve-da3.py")
        _spec = importlib.util.spec_from_file_location("refserve_da3", _p)
        rd = importlib.util.module_from_spec(_spec)
        sys.modules["refserve_da3"] = rd
        _spec.loader.exec_module(rd)
        da3, ddev = rd.load_model(args.da3_ckpt or rd.DA3_DIR, None, dtype=args.da3_dtype)

    rows = []
    for path in args.img:
        img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            raise SystemExit("读不到图: %s" % path)
        H, W = img.shape[:2]
        name = os.path.basename(path)
        rec = {"file": name, "W": W, "H": H}
        if moge is not None:
            fr = rs.infer_frame(moge, mdev, img, args.num_tokens)
            fx, fy = float(fr["fx"]), float(fr["fy"])
            rec["moge"] = fov_from_K(fx, fy, W, H)
            rec["moge_fx"] = fx
            rec["moge_d"] = float(np.median(fr["depth"][np.isfinite(fr["depth"])])) if "depth" in fr else float("nan")
            rec["moge_valid"] = float(np.mean(fr["mask"]))
        if da3 is not None:
            fr = rd.infer(da3, [img], process_res=args.process_res, conf_pct=40.0)[0]
            fx, fy = float(fr["fx"]), float(fr["fy"])
            rec["da3"] = fov_from_K(fx, fy, W, H)
            rec["da3_fx"] = fx
            rec["da3_raw_fx"] = float(fr["K_raw"][0, 0])
            rec["da3_valid"] = float(np.mean(fr["mask"]))
            rec["da3_metric"] = fr["is_metric"]
        rows.append(rec)

    print("\n=== fov 标定（真值 %.2f° x / %.2f° y，来自引擎 PerspectiveCamera(55) + 16:9）===" %
          (args.truth_fov_x, args.truth_fov_y))
    print("%-28s %-8s %-16s %-16s %-10s" % ("file", "size", "MoGe fov x/y", "DA3 fov x/y", "valid%"))
    for r in rows:
        m = r.get("moge")
        d = r.get("da3")
        ms = ("%.2f / %.2f" % m) if m else "-"
        ds = ("%.2f / %.2f" % d) if d else "-"
        v = r.get("moge_valid", r.get("da3_valid", float("nan")))
        print("%-28s %-8s %-16s %-16s %-10.3f" % (r["file"], "%dx%d" % (r["W"], r["H"]), ms, ds, v))
    print("\n误差（估计 - 真值，度）：")
    for r in rows:
        line = "%-28s" % r["file"]
        if r.get("moge"):
            line += "  MoGe: x%+7.2f y%+7.2f" % (r["moge"][0] - args.truth_fov_x, r["moge"][1] - args.truth_fov_y)
        if r.get("da3"):
            line += "  DA3: x%+7.2f y%+7.2f  (raw fx %.1f)" % (r["da3"][0] - args.truth_fov_x,
                                                              r["da3"][1] - args.truth_fov_y,
                                                              r.get("da3_raw_fx", float("nan")))
        print(line)


if __name__ == "__main__":
    main()
