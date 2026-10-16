# -*- coding: utf-8 -*-
"""cmp-top.py -- 顶视图对比图（多帧世界点云 + 相机轨迹 + 俯视着色）。

用途：把不同模型（DA3 / VGGT / MoGe 融合）的多视图结果画成同一风格的俯视图，
便于并排比较"轨迹是否连贯、地面是否成片"。

坐标约定
--------
* DA3 的 extrinsics 是 w2c（OpenCV: x 右 / y 下 / z 前），world 系里"上"≈ -y。
* `--up-axis -y`（默认）把 height = -y；`--up-axis z` 用 h = z（MoGe 世界系那样）。
* 俯视平面取剩下两轴。

用法
----
    python tools/cmp-top.py --ply a.ply --ply b.ply --poses run-poses.json \
        --out top.png --size 900
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refscene as rs  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ply", action="append", default=[])
    ap.add_argument("--poses", default=None, help="含 cam_center 的 poses.json（可多个，逗号分隔）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--up-axis", default="-y", choices=["-y", "y", "z", "h"])
    ap.add_argument("--size", type=int, default=900)
    ap.add_argument("--pad", type=int, default=40)
    ap.add_argument("--traj-color", default="255,0,0")
    ap.add_argument("--bg", type=int, default=255)
    args = ap.parse_args()

    if not args.ply:
        raise SystemExit("需要至少一个 --ply")
    P = []
    for p in args.ply:
        xyz, _rgb = rs.read_ply(p)
        xyz = np.asarray(xyz, np.float64)
        xyz = xyz[np.isfinite(xyz).all(1)]
        P.append(xyz)
    P = np.concatenate(P, 0)

    if args.up_axis == "-y":
        a, b, c = P[:, 0], P[:, 2], -P[:, 1]
    elif args.up_axis == "y":
        a, b, c = P[:, 0], P[:, 2], P[:, 1]
    elif args.up_axis == "z":
        a, b, c = P[:, 0], P[:, 1], P[:, 2]
    else:
        a, b, c = P[:, 0], P[:, 2], P[:, 2]

    size, pad = args.size, args.pad
    lo, hi = np.percentile(c, 2), np.percentile(c, 98)
    t = np.clip((c - lo) / max(hi - lo, 1e-6), 0, 1)
    canvas = np.full((size, size, 3), args.bg, np.uint8)

    # 轨迹参与定标，保证轨迹一定在画面内
    trajs = []
    for pf in ([x.strip() for x in args.poses.split(",")] if args.poses else []):
        d = json.load(open(pf, encoding="utf-8"))
        pts = []
        for q in d.get("poses", d.get("frames", [])):
            cc = q.get("cam_center")
            if cc is None and "cam_c2w" in q:
                cc = [q["cam_c2w"][i][3] for i in range(3)]
            if cc is not None:
                pts.append(cc)
        if pts:
            trajs.append(np.asarray(pts, np.float64))

    as_all = [a]
    bs_all = [b]
    for T in trajs:
        if args.up_axis in ("-y", "y"):
            as_all.append(T[:, 0]); bs_all.append(T[:, 2])
        else:
            as_all.append(T[:, 0]); bs_all.append(T[:, 1])
    amin = min(x.min() for x in as_all); amax = max(x.max() for x in as_all)
    bmin = min(x.min() for x in bs_all); bmax = max(x.max() for x in bs_all)
    sc = (size - 2 * pad) / max(amax - amin, bmax - bmin, 1e-6)

    def to_px(x, y):
        return (pad + (x - amin) * sc).astype(np.int32), (size - pad - (y - bmin) * sc).astype(np.int32)

    order = np.argsort(-c)                      # 画家算法：远的先画
    px, py = to_px(a[order], b[order])
    tt = t[order]
    ok = (px >= 0) & (px < size) & (py >= 0) & (py < size)
    colors = cv2.applyColorMap((tt[ok] * 255).astype(np.uint8), cv2.COLORMAP_TURBO)[:, 0, :]
    canvas[py[ok], px[ok]] = colors
    canvas = cv2.morphologyEx(canvas, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))

    col = np.array([int(x) for x in args.traj_color.split(",")], np.uint8)
    for T in trajs:
        if args.up_axis in ("-y", "y"):
            ta, tb = T[:, 0], T[:, 2]
        else:
            ta, tb = T[:, 0], T[:, 1]
        qx, qy = to_px(ta, tb)
        for i in range(len(qx) - 1):
            cv2.line(canvas, (int(qx[i]), int(qy[i])), (int(qx[i + 1]), int(qy[i + 1])),
                     tuple(int(v) for v in col.tolist()), 2, cv2.LINE_AA)
        for i in range(len(qx)):
            cv2.circle(canvas, (int(qx[i]), int(qy[i])), 3, (0, 0, 255), -1)

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    rs.imwrite_u(out, canvas)
    span = [round(float(amax - amin), 4), round(float(bmax - bmin), 4)]
    print("[cmp-top] %d pts  %d traj  span(a,b)=%s  c=[%.3f,%.3f] -> %s"
          % (len(P), len(trajs), span, float(lo), float(hi), out))


if __name__ == "__main__":
    main()
