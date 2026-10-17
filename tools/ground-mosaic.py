# -*- coding: utf-8 -*-
"""A 路线核心工具（第一步）：地平面「无缝拼接」——不做 3D 重建，直接把地面摊平成一张大图。

思路（为什么比点云融合靠谱）：
  跟随相机的俯仰/高度/焦距固定、只有偏航在变 ⇒ 地面（一个平面）在两帧之间只差一个
  **单应**（平面诱导 2D 变换）。用 ORB + RANSAC 直接估这个单应，逐帧串起来把每帧贴到同一张
  地面画布上。整个过程没有深度、没有尺度歧义，误差只是 2D 的、可被结构（90°/等宽）约束回来。
  注意：只在下半幅提取特征（游戏背景是"贴在相机上"的背板，会用错误的地面单应污染估计）。

用法:
  python tools/ground-mosaic.py --dir <帧目录> [--start 0] [--end 400] [--step 2]
      [--out 图.png] [--json 变换.json] [--mask-y 0.45] [--min-inl 40] [--scale 1.0]
"""
import os
import sys
import json
import glob
import argparse

import cv2
import numpy as np


def load_files(d):
    fs = sorted(glob.glob(os.path.join(d, "*.jpg")) + glob.glob(os.path.join(d, "*.png")))
    if not fs:
        raise SystemExit("没有帧: %s" % d)
    return fs


def feat(img, mask_y):
    H, W = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    m = np.zeros((H, W), np.uint8)
    m[int(mask_y * H):, :] = 255
    orb = cv2.ORB_create(nfeatures=6000, scaleFactor=1.15, nlevels=10,
                         edgeThreshold=19, fastThreshold=7)
    kp, des = orb.detectAndCompute(g, m)
    return kp, des


def match_homography(kp_a, des_a, kp_b, des_b, ratio=0.78, ransac_thr=3.0):
    if des_a is None or des_b is None or len(kp_a) < 12 or len(kp_b) < 12:
        return None, 0, 0
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    try:
        knn = bf.knnMatch(des_b, des_a, k=2)
    except cv2.error:
        return None, 0, 0
    good = [m for m, n in (p for p in knn if len(p) == 2) if m.distance < ratio * n.distance]
    if len(good) < 12:
        return None, len(good), 0
    src = np.float32([kp_b[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kp_a[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    Hm, mask = cv2.findHomography(src, dst, cv2.RANSAC, ransac_thr, maxIters=5000, confidence=0.999)
    if Hm is None:
        return None, len(good), 0
    return Hm, len(good), int(mask.sum())


def corners(W, H):
    return np.float32([[0, 0], [W, 0], [W, H], [0, H]]).reshape(-1, 1, 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=0, help="0 = 到结尾")
    ap.add_argument("--step", type=int, default=2)
    ap.add_argument("--out", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--mask-y", type=float, default=0.45)
    ap.add_argument("--min-inl", type=int, default=40)
    ap.add_argument("--scale", type=float, default=1.0, help="处理分辨率缩放（<1 更快）")
    ap.add_argument("--blend", choices=["avg", "first"], default="avg")
    a = ap.parse_args()

    fs = load_files(a.dir)
    end = len(fs) if a.end <= 0 else min(a.end, len(fs))
    sel = list(range(a.start, end, max(1, a.step)))
    print("[gm] %s  帧 %d..%d step %d ⇒ %d 帧" % (a.dir, a.start, end, a.step, len(sel)))

    As = []          # 每帧 → 基准帧（第 0 张）的单应
    A = np.eye(3)
    info = []
    prev_img = None
    prev_kp = prev_des = None
    cur = np.eye(3)
    for n, i in enumerate(sel):
        img = cv2.imread(fs[i])
        if img is None:
            continue
        if a.scale != 1.0:
            img = cv2.resize(img, None, fx=a.scale, fy=a.scale, interpolation=cv2.INTER_AREA)
        if prev_img is None:
            A = np.eye(3)
            kp, des = feat(img, a.mask_y)
            ninl = 0
            ngood = 0
        else:
            kp, des = feat(img, a.mask_y)
            Hm, ngood, ninl = match_homography(prev_kp, prev_des, kp, des)
            if Hm is None or ninl < a.min_inl:
                print("  [warn] %s: 匹配失败/内点不足 (good %d, inl %d) ⇒ 跳过这一帧（画面会出现裂缝）"
                      % (os.path.basename(fs[i]), ngood, ninl))
                info.append({"i": i, "file": os.path.basename(fs[i]), "ok": False,
                             "good": ngood, "inl": ninl})
                prev_img, prev_kp, prev_des = img, kp, des     # 仍然前进
                continue
            A = A @ Hm
            info.append({"i": i, "file": os.path.basename(fs[i]), "ok": True,
                         "good": ngood, "inl": ninl,
                         "dxdy": [float(Hm[0, 2]), float(Hm[1, 2])]})
        As.append(A.copy())
        prev_img, prev_kp, prev_des = img, kp, des
    if not As:
        raise SystemExit("没有成功一帧")

    # 画布：所有帧四角变换后的包围盒
    W = int(round(img.shape[1]))
    H = int(round(img.shape[0]))
    allc = []
    for A in As:
        allc.append(cv2.perspectiveTransform(corners(W, H), A).reshape(-1, 2))
    allc = np.concatenate(allc, 0)
    x0, y0 = np.floor(allc.min(0)).astype(int)
    x1, y1 = np.ceil(allc.max(0)).astype(int)
    CW, CH = int(x1 - x0), int(y1 - y0)
    print("[gm] 画布 %dx%d（%d 帧）" % (CW, CH, len(As)))
    if CW * CH > 4.0e8:
        raise SystemExit("画布过大（%dx%d），请减小 --end 或增大 --step" % (CW, CH))

    if a.blend == "avg":
        acc = np.zeros((CH, CW, 3), np.float32)
        wsum = np.zeros((CH, CW, 1), np.float32)
    else:
        acc = np.zeros((CH, CW, 3), np.uint8)
        wsum = None

    for n, (i, A) in enumerate(zip(sel, As)):
        img = cv2.imread(fs[i])
        if img is None:
            continue
        if a.scale != 1.0:
            img = cv2.resize(img, None, fx=a.scale, fy=a.scale, interpolation=cv2.INTER_AREA)
        T = np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1]], np.float64) @ A
        warped = cv2.warpPerspective(img, T, (CW, CH), flags=cv2.INTER_LINEAR,
                                     borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
        m = cv2.warpPerspective(np.full(img.shape[:2], 255, np.uint8), T, (CW, CH),
                                flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        if a.blend == "avg":
            acc += warped.astype(np.float32) * (m[..., None] > 0)
            wsum += (m[..., None] > 0).astype(np.float32)
        else:
            keep = (m > 0) & (acc.sum(2) == 0)
            acc[keep] = warped[keep]
        if (n + 1) % 25 == 0:
            print("  ... %d/%d" % (n + 1, len(As)))

    if a.blend == "avg":
        out = np.where(wsum > 0, acc / np.maximum(wsum, 1), 0).astype(np.uint8)
    else:
        out = acc
    outp = a.out or os.path.join(os.path.dirname(a.dir.rstrip("\\/")),
                                 "mosaic-%s.png" % os.path.basename(os.path.normpath(a.dir)))
    cv2.imwrite(outp, out)
    print("[gm] 写出 %s  %dx%d" % (outp, CW, CH))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump({"dir": a.dir, "step": a.step, "frames": [int(x) for x in sel],
                       "canvas": [CW, CH], "origin": [int(x0), int(y0)],
                       "A": [A.tolist() for A in As], "info": info}, f, ensure_ascii=False)
        print("[gm] 变换写出 %s" % a.json)


if __name__ == "__main__":
    main()
