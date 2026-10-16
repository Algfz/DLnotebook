# -*- coding: utf-8 -*-
"""单帧 → 点云 PLY（MoGe / DA3 通用），供 refrender.mjs 同机位回渲对比。

设计要点
--------
* 两个模型都输出**相机系**点云（相机在原点、看向 +z 附近），所以回渲时用
  `refrender.mjs --identity` + 显式 `--fov-y` 就是「同机位回渲」。
* 绝对尺度不可信（MoGe 已知被压缩约 4 倍；DA3 自称 metric 也要验证），
  所以用 `--scales` 一次写多份不同尺度的 PLY，由渲染+图像比对挑最好的那份。
* `--model moge|da3`；`--force-truth-k` 用引擎真值内参（fov_y=55°）替代模型自估内参，
  用来把「fov 估错」和「深度估错」两个误差源分开。
* 颜色取原图（BGR→RGB），按模型 mask 过滤；点数上限 `--max-pts` 用等距抽样。

用法
----
    python tools/mkply.py --img F.jpg --model da3 --out C:\\tmp\\da3 --tag f00001 \
        --scales 0.2,0.3,0.5,1.0,2.0 --process-res 504
"""
import argparse
import importlib.util
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TRUTH_FOV_Y = 55.0     # 引擎 PerspectiveCamera(55) —— three.js 的 fov 是垂直 fov


def load_da3_module():
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "refserve-da3.py")
    spec = importlib.util.spec_from_file_location("refserve_da3", p)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["refserve_da3"] = mod
    spec.loader.exec_module(mod)
    return mod


def truth_K(W, H):
    fy = 0.5 * H / np.tan(np.radians(TRUTH_FOV_Y) / 2.0)
    return np.array([[fy, 0.0, 0.5 * W], [0.0, fy, 0.5 * H], [0.0, 0.0, 1.0]], dtype=np.float64)


def downsample(P, C, mask, max_pts, rng):
    idx = np.flatnonzero(mask.reshape(-1))
    if idx.size == 0:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.uint8)
    if idx.size > max_pts:
        idx = rng.choice(idx, size=max_pts, replace=False)
    return P.reshape(-1, 3)[idx].astype(np.float32), C.reshape(-1, 3)[idx].astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--img", required=True, help="原图（真值帧）")
    ap.add_argument("--model", choices=["moge", "da3"], required=True)
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--tag", default=None, help="输出名 tag，默认用图名")
    ap.add_argument("--scales", default="1.0", help="逗号分隔，例如 0.25,0.5,1,2")
    ap.add_argument("--force-truth-k", action="store_true", help="用引擎真值内参替代模型自估内参")
    ap.add_argument("--max-pts", type=int, default=400000)
    ap.add_argument("--process-res", type=int, default=504)
    ap.add_argument("--conf-pct", type=float, default=40.0)
    ap.add_argument("--num-tokens", type=int, default=2200)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    import reffuse as rf            # noqa: E402  (write_ply 在 refscene 里)
    import refscene as rsc
    import refmotion as rm

    img = cv2.imdecode(np.fromfile(args.img, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit("读不到图: %s" % args.img)
    H, W = img.shape[:2]
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    os.makedirs(args.out, exist_ok=True)
    tag = args.tag or os.path.splitext(os.path.basename(args.img))[0]
    scales = [float(s) for s in str(args.scales).split(",") if s.strip()]

    meta = {"img": args.img, "model": args.model, "W": W, "H": H, "scales": scales}

    if args.model == "moge":
        import refserve as rs
        model, dev = rs.load_model(rs.DEFAULT_CKPT, None)
        fr = rs.infer_frame(model, dev, img, args.num_tokens)
        P = np.asarray(fr["points"], np.float64)
        mask = np.asarray(fr["mask"], bool)
        fov_x, fov_y = float(fr["fov_x"] or 0), float(fr["fov_y"] or 0)
        Kown = np.asarray(fr["K_px"], np.float64)
        depth = np.asarray(fr["depth"], np.float64)
    else:
        rd = load_da3_module()
        model, dev = rd.load_model(rd.DA3_DIR, None, dtype="fp32")
        f = rd.infer(model, [img], process_res=args.process_res, conf_pct=args.conf_pct)[0]
        P = np.asarray(f["points"], np.float64)
        mask = np.asarray(f["mask"], bool)
        fov_x, fov_y = float(f["fov_x"] or 0), float(f["fov_y"] or 0)
        Kown = np.asarray(f["K_px"], np.float64)
        depth = np.asarray(f["depth"], np.float64)

    if args.force_truth_k:
        K = truth_K(W, H)
        fy = float(K[1, 1])
        # 用真值内参重新反投影（模型只提供深度）
        u = np.arange(W, dtype=np.float64)[None, :].repeat(H, 0)
        v = np.arange(H, dtype=np.float64)[:, None].repeat(W, 1)
        P = np.stack([(u - K[0, 2]) / K[0, 0] * depth,
                      (v - K[1, 2]) / K[1, 1] * depth,
                      depth], -1)
        meta["note"] = "points rebuilt with engine truth K (fov_y=%.2f)" % TRUTH_FOV_Y
    else:
        K = Kown

    meta.update({"fov_x_deg": round(fov_x, 3), "fov_y_deg": round(fov_y, 3),
                 "truth_fov_x_deg": round(2 * np.degrees(np.arctan(0.5 * W / truth_K(W, H)[0, 0])), 3),
                 "truth_fov_y_deg": TRUTH_FOV_Y,
                 "depth_med": round(float(np.median(depth[np.isfinite(depth)])), 4),
                 "mask_frac": round(float(mask.mean()), 4),
                 "n_valid": int(np.count_nonzero(mask))})

    # 地面/路宽指标（W_m 是「模型单位下的路宽」，可与真值 3 m 比较）
    try:
        frn = {"points": P, "depth": depth, "mask": mask,
               "normal": None, "fx": float(K[0, 0]), "fy": float(K[1, 1]), "H": H, "W": W}
        if args.model == "moge":
            frn["normal"] = np.asarray(fr.get("normal"), np.float64)
        else:
            frn["normal"] = rd.normals_from_points(P, mask)
        gf = rm.ground_frame(frn)
        meta["ground"] = {"n": [round(float(x), 4) for x in gf["n"]],
                          "d": round(float(gf["d"]), 4),
                          "W_m": round(float(gf["W_m"]), 4),
                          "road_px": int(gf["road_px"]),
                          "agree": round(float(gf["agree"]), 4)}
        meta["scale_to_road3m"] = round(3.0 / float(gf["W_m"]), 4) if gf["W_m"] else None
    except Exception as e:  # noqa: BLE001
        meta["ground_error"] = "%s: %s" % (type(e).__name__, e)

    rng = np.random.default_rng(args.seed)
    files = []
    for s in scales:
        Pp = P * float(s)
        pts, cols = downsample(Pp, rgb, mask, args.max_pts, rng)
        if pts.shape[0] == 0:
            continue
        name = "%s-%s-s%g%s.ply" % (args.model, tag, s, "-truthk" if args.force_truth_k else "")
        p = os.path.join(args.out, name)
        rsc.write_ply(p, pts.astype(np.float32), cols.astype(np.uint8))
        files.append({"file": p, "scale": s, "n": int(pts.shape[0]), "bytes": os.path.getsize(p)})
    meta["ply"] = files

    import json
    jp = os.path.join(args.out, "%s-%s%s.json" % (args.model, tag, "-truthk" if args.force_truth_k else ""))
    with open(jp, "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=1)

    print("[mkply] %s %s fov=%.2f/%.2f truth=%.2f/%.2f mask=%.3f depth_med=%.3f W_m=%s" % (
        args.model, tag, meta["fov_x_deg"], meta["fov_y_deg"], meta["truth_fov_x_deg"],
        meta["truth_fov_y_deg"], meta["mask_frac"], meta["depth_med"],
        meta.get("ground", {}).get("W_m", "?")))
    for f in files:
        print("   %-52s %8.1f MB  %d pts" % (os.path.basename(f["file"]), f["bytes"] / 1e6, f["n"]))


if __name__ == "__main__":
    main()
