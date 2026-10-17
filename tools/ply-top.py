"""ply-top.py — 点云俯视图（+ 轨迹），用来一眼看出"连贯 vs 被抹开"

新管线产出的点云是 OpenCV 世界系（x 右 / y 下 / z 前），所以俯视图取 X-Z 平面；
旧管线是 MoGe 地面系（x,y 平面 + h 向上），用 --plane xy。

用法：
  python tools\\ply-top.py --ply a.ply --out a-top.png --traj a-traj2.json --plane xz --px 1400
  python tools\\ply-top.py --ply old.ply --out old-top.png --plane xy --px 1400
"""
import argparse
import importlib.util
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def read_ply(path):
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("refscene", os.path.join(here, "refscene.py"))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m.read_ply(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ply", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--traj", default=None, help="<tag>-traj2.json（X/Y/Z 列表）")
    ap.add_argument("--plane", default="xz", choices=["xz", "xy", "yz"])
    ap.add_argument("--px", type=int, default=1400)
    ap.add_argument("--title", default="")
    args = ap.parse_args()

    P, C = read_ply(args.ply)
    P = np.asarray(P, np.float32)
    C = np.asarray(C, np.uint8)
    ax = {"x": 0, "y": 1, "z": 2}
    a, b = args.plane[0], args.plane[1]
    A, B = P[:, ax[a]], P[:, ax[b]]
    lo = np.array([A.min(), B.min()]); hi = np.array([A.max(), B.max()])
    pad = 0.04 * float(np.max(hi - lo))
    lo -= pad; hi += pad
    scale = (args.px - 40) / float(np.max(hi - lo))
    W = int((hi[0] - lo[0]) * scale) + 40
    H = int((hi[1] - lo[1]) * scale) + 40

    ia = np.clip(((A - lo[0]) * scale).astype(np.int32) + 20, 0, W - 1)
    ib = np.clip(((B - lo[1]) * scale).astype(np.int32) + 20, 0, H - 1)
    img = np.full((H, W, 3), 14, np.uint8)
    # 密度着色（turbo 风格简化）
    cnt = np.zeros((H, W), np.float32)
    np.add.at(cnt, (ib, ia), 1.0)
    nz = cnt > 0
    v = np.log1p(cnt[nz]) / max(1e-6, np.log1p(cnt.max()))
    lut = np.zeros((256, 3), np.uint8)
    for i in range(256):
        t = i / 255.0
        lut[i] = (int(255 * min(1, max(0, 1.5 * t))), int(255 * min(1, max(0, 1.5 * t - 0.4))),
                  int(255 * min(1, max(0, 1.2 - 1.8 * t))))
    px = lut[(v * 255).astype(np.uint8)]
    img[nz] = px
    im = Image.fromarray(img)
    dr = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
    except Exception:
        font = ImageFont.load_default()
    if args.traj and os.path.exists(args.traj):
        t = json.load(open(args.traj, encoding="utf-8"))
        X = np.asarray(t.get("X", []), float); Y = np.asarray(t.get("Y", []), float); Z = np.asarray(t.get("Z", []))
        T = {"x": X, "y": Y, "z": Z}
        if len(X):
            tx = np.clip(((T[a] - lo[0]) * scale).astype(np.int32) + 20, 0, W - 1)
            ty = np.clip(((T[b] - lo[1]) * scale).astype(np.int32) + 20, 0, H - 1)
            pts = list(zip(tx.tolist(), ty.tolist()))
            if len(pts) > 1:
                dr.line(pts, fill=(255, 60, 60), width=3)
            dr.ellipse([tx[0] - 6, ty[0] - 6, tx[0] + 6, ty[0] + 6], fill=(60, 255, 120))
            dr.ellipse([tx[-1] - 6, ty[-1] - 6, tx[-1] + 6, ty[-1] + 6], fill=(255, 200, 60))
    lab = "%s  %s  %d 点  %.3f×%.3f" % (args.title or os.path.basename(args.ply), args.plane.upper(), len(P),
                                        hi[0] - lo[0], hi[1] - lo[1])
    dr.rectangle([0, 0, W, 30], fill=(10, 12, 16))
    dr.text((8, 5), lab, fill=(232, 234, 242), font=font)
    im.save(args.out)
    print("[ply-top] %s  %dx%d" % (args.out, W, H))


if __name__ == "__main__":
    main()
